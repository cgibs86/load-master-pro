/*
 * LoadMaster Pro AI — price book.
 *
 * The shop's own equipment and pricing, saved on the device once and reused
 * on every job. Without it a rep retypes three prices, three efficiency
 * ratings and a rebate on every call; with it, SalesIQ fills itself in the
 * moment the load is known.
 *
 * A price book entry is a piece of equipment the shop actually sells: a name,
 * which tier it belongs to (good / better / best), its stage type, its
 * efficiency ratings, and how it is priced. Pricing supports the two ways
 * shops actually quote:
 *
 *   flat        one installed price, whatever the tonnage
 *   per-ton     a base price plus an amount per ton (the common approach)
 *   by-size     an explicit price for each tonnage the shop stocks
 *
 * Matching is by (tier, fuel, stage) and then tonnage. Tonnage comes from the
 * calculator, so the rep never picks a size — the book answers "what do we
 * charge for the size this house actually needs".
 *
 * Storage is localStorage on the device, same as Settings. Nothing here
 * leaves the device.
 *
 * Exposed as window.PriceBook (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "lmp_pricebook_v1";
  var TIERS = ["good", "better", "best"];
  var TIER_LABEL = { good: "Good", better: "Better", best: "Best" };
  // Stage type must match loadcalc.js's sizing keys so a book entry can be
  // priced at the exact tonnage Manual S selects for that stage type.
  var STAGES = ["single", "two", "variable"];
  var STAGE_LABEL = { single: "Single-stage", two: "Two-stage", variable: "Variable-capacity" };
  var FUELS = ["furnace", "hp", "dualfuel"];
  var FUEL_LABEL = { furnace: "Gas furnace + A/C", hp: "Heat pump", dualfuel: "Dual fuel" };
  var PRICING = ["flat", "perTon", "bySize"];

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  /*
   * Normalize whatever is handed in (hand-edited storage, an older export, a
   * half-filled form) into a valid entry, or null if it cannot be salvaged.
   * Every field is range-checked: a price book drives money on a customer-
   * facing proposal, so a junk value must be refused rather than displayed.
   */
  function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var name = String(raw.name || "").trim().slice(0, 80);
    if (!name) return null;
    var tier = TIERS.indexOf(raw.tier) >= 0 ? raw.tier : "good";
    var stage = STAGES.indexOf(raw.stage) >= 0 ? raw.stage : "single";
    var fuel = FUELS.indexOf(raw.fuel) >= 0 ? raw.fuel : "furnace";
    var pricing = PRICING.indexOf(raw.pricing) >= 0 ? raw.pricing : "flat";

    var seer2 = num(raw.seer2); if (!(seer2 >= 10 && seer2 <= 40)) seer2 = null;
    var afue = num(raw.afue); if (afue > 1 && afue <= 100) afue = afue / 100;  // accept "96" or "0.96"
    if (!(afue >= 0.5 && afue <= 1)) afue = null;
    var hspf2 = num(raw.hspf2); if (!(hspf2 >= 5 && hspf2 <= 16)) hspf2 = null;

    var flatPrice = num(raw.flatPrice); if (!(flatPrice > 0 && flatPrice <= 200000)) flatPrice = null;
    // null here means "not set" and priceAt() treats it as zero; the explicit
    // isNum() keeps the same `null >= 0` trap from turning an out-of-range
    // entry into a silently-kept one.
    var basePrice = num(raw.basePrice); if (!isNum(basePrice) || basePrice < 0 || basePrice > 200000) basePrice = null;
    var perTon = num(raw.perTon); if (!isNum(perTon) || perTon < 0 || perTon > 50000) perTon = null;
    // Written with an explicit isNum() rather than a range guard, because in
    // JavaScript `null >= 0` is TRUE — so `if (!(rebate >= 0 ...)) rebate = 0`
    // silently leaves a missing rebate as null instead of zeroing it. The
    // range guards above are safe from that trap only because their lower
    // bound is greater than zero; this one is not.
    var rebate = num(raw.rebate);
    if (!isNum(rebate) || rebate < 0 || rebate > 100000) rebate = 0;

    // by-size table: { "2.5": 11800, "3": 12600, ... }
    var bySize = {};
    if (raw.bySize && typeof raw.bySize === "object") {
      Object.keys(raw.bySize).forEach(function (k) {
        var tons = Number(k), price = num(raw.bySize[k]);
        if (tons >= 1 && tons <= 6 && price > 0 && price <= 200000) bySize[String(tons)] = price;
      });
    }
    // A pricing mode with nothing behind it can't quote; fall back rather than
    // silently producing "—" on the proposal.
    if (pricing === "flat" && flatPrice == null) pricing = (perTon != null || basePrice != null) ? "perTon" : (Object.keys(bySize).length ? "bySize" : "flat");
    if (pricing === "perTon" && perTon == null && basePrice == null) pricing = flatPrice != null ? "flat" : (Object.keys(bySize).length ? "bySize" : "perTon");
    if (pricing === "bySize" && !Object.keys(bySize).length) pricing = flatPrice != null ? "flat" : (perTon != null || basePrice != null) ? "perTon" : "bySize";

    return {
      id: String(raw.id || ("pb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))),
      name: name, tier: tier, stage: stage, fuel: fuel, pricing: pricing,
      seer2: seer2, afue: afue, hspf2: hspf2,
      flatPrice: flatPrice, basePrice: basePrice, perTon: perTon, bySize: bySize, rebate: rebate,
      notes: String(raw.notes || "").slice(0, 200)
    };
  }

  function load() {
    try {
      var raw = JSON.parse(root.localStorage.getItem(STORAGE_KEY));
      if (!raw || !Array.isArray(raw.entries)) return { entries: [] };
      return { entries: raw.entries.map(normalizeEntry).filter(Boolean) };
    } catch (e) { return { entries: [] }; }
  }

  function save(book) {
    var clean = { entries: (book && book.entries ? book.entries : []).map(normalizeEntry).filter(Boolean) };
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch (e) { /* quota / private mode */ }
    return clean;
  }

  /*
   * Price one entry at a given tonnage.
   *
   * by-size uses the exact tonnage when the shop stocks it, and otherwise the
   * nearest size they DO stock — with `exact:false` so the UI can say the
   * price came from a neighbouring size rather than quietly quoting the wrong
   * one. Rounding a 3.5-ton job to a stocked 3-ton price understates the
   * quote, and a rep should know that before they say the number out loud.
   */
  function priceAt(entry, tons) {
    if (!entry || !(tons > 0)) return null;
    if (entry.pricing === "flat" && entry.flatPrice != null) {
      return { price: entry.flatPrice, exact: true, basis: "flat price" };
    }
    if (entry.pricing === "perTon") {
      var base = entry.basePrice != null ? entry.basePrice : 0;
      var per = entry.perTon != null ? entry.perTon : 0;
      if (base === 0 && per === 0) return null;
      return { price: Math.round(base + per * tons), exact: true, basis: "$" + Math.round(base).toLocaleString("en-US") + " + $" + Math.round(per).toLocaleString("en-US") + "/ton" };
    }
    if (entry.pricing === "bySize") {
      var sizes = Object.keys(entry.bySize).map(Number).sort(function (a, b) { return a - b; });
      if (!sizes.length) return null;
      var key = String(tons);
      if (entry.bySize[key] != null) return { price: entry.bySize[key], exact: true, basis: tons + "-ton price" };
      var nearest = sizes.reduce(function (a, b) { return Math.abs(b - tons) < Math.abs(a - tons) ? b : a; });
      return { price: entry.bySize[String(nearest)], exact: false, nearestTons: nearest, basis: "nearest stocked size (" + nearest + " ton)" };
    }
    return null;
  }

  /*
   * Best entry for a (tier, fuel, stage) request at a tonnage.
   *
   * Fuel and stage are hard filters — a heat pump is not a substitute for a
   * furnace, and pricing a two-stage quote off a single-stage line item would
   * misquote the job. Tier is a soft preference: if the shop has nothing in
   * the "best" tier for this fuel, returning their better/good option with
   * `tierMatch:false` beats returning nothing, and the UI says so.
   */
  function match(book, opts) {
    var entries = (book && book.entries) || [];
    var o = opts || {};
    var pool = entries.filter(function (e) {
      return (!o.fuel || e.fuel === o.fuel) && (!o.stage || e.stage === o.stage);
    });
    if (!pool.length) return null;
    var exactTier = pool.filter(function (e) { return e.tier === o.tier; });
    // When several lines compete for the same slot, the most recently added
    // wins. Entries are stored in insertion order, so this is the last match.
    // A shop that seeds the starter template and then adds their real line
    // expects their line to be the one that quotes — picking the first match
    // would quietly keep quoting the template they were replacing.
    var chosen = exactTier.length ? exactTier[exactTier.length - 1] : null;
    var tierMatch = !!chosen;
    if (!chosen) {
      // Nearest tier by rank, so "best" falls back to "better" before "good",
      // and among equally-near tiers the most recent again wins.
      var want = TIERS.indexOf(o.tier);
      chosen = pool.slice().reverse().sort(function (a, b) {
        return Math.abs(TIERS.indexOf(a.tier) - want) - Math.abs(TIERS.indexOf(b.tier) - want);
      })[0];
    }
    if (!chosen) return null;
    var priced = priceAt(chosen, o.tons);
    return {
      entry: chosen, tierMatch: tierMatch,
      price: priced ? priced.price : null,
      exact: priced ? priced.exact : null,
      basis: priced ? priced.basis : null,
      nearestTons: priced ? priced.nearestTons : null,
      rebate: chosen.rebate || 0,
      seer2: chosen.seer2, afue: chosen.afue, hspf2: chosen.hspf2
    };
  }

  /*
   * Fill a whole SalesIQ proposal from the book: one match per tier at that
   * tier's own Manual S tonnage. Returns null when the book has nothing for
   * this fuel at all, so the caller can leave the rep's manual entries alone.
   */
  function fillProposal(book, opts) {
    var o = opts || {};
    var tonsByTier = o.tonsByTier || {};
    var out = {}, any = false;
    TIERS.forEach(function (tier, i) {
      var stage = (o.stageByTier && o.stageByTier[tier]) || STAGES[i];
      var m = match(book, { tier: tier, fuel: o.fuel, stage: stage, tons: tonsByTier[tier] });
      out[tier] = m;
      if (m && m.price != null) any = true;
    });
    return any ? out : null;
  }

  // Starter book so a shop is not staring at an empty screen. Prices are
  // deliberately round placeholder numbers a shop must replace with their own;
  // efficiency ratings are current federal minimums and common step-ups.
  function starterEntries() {
    return [
      { name: "Builder-grade A/C + 80% furnace", tier: "good", stage: "single", fuel: "furnace", pricing: "perTon", basePrice: 4500, perTon: 1600, seer2: 14.3, afue: 0.80, rebate: 0 },
      { name: "Two-stage A/C + 96% furnace", tier: "better", stage: "two", fuel: "furnace", pricing: "perTon", basePrice: 6000, perTon: 2000, seer2: 16, afue: 0.96, rebate: 0 },
      { name: "Inverter A/C + modulating furnace", tier: "best", stage: "variable", fuel: "furnace", pricing: "perTon", basePrice: 8000, perTon: 2500, seer2: 18, afue: 0.97, rebate: 0 },
      { name: "Single-stage heat pump", tier: "good", stage: "single", fuel: "hp", pricing: "perTon", basePrice: 5000, perTon: 1800, seer2: 14.3, hspf2: 7.5, rebate: 0 },
      { name: "Two-stage heat pump", tier: "better", stage: "two", fuel: "hp", pricing: "perTon", basePrice: 6500, perTon: 2200, seer2: 16, hspf2: 8.5, rebate: 0 },
      { name: "Cold-climate inverter heat pump", tier: "best", stage: "variable", fuel: "hp", pricing: "perTon", basePrice: 9000, perTon: 2700, seer2: 18, hspf2: 9.5, rebate: 0 }
    ].map(normalizeEntry).filter(Boolean);
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY, TIERS: TIERS, TIER_LABEL: TIER_LABEL, STAGES: STAGES,
    STAGE_LABEL: STAGE_LABEL, FUELS: FUELS, FUEL_LABEL: FUEL_LABEL, PRICING: PRICING,
    load: load, save: save, normalizeEntry: normalizeEntry, priceAt: priceAt,
    match: match, fillProposal: fillProposal, starterEntries: starterEntries
  };
  root.PriceBook = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
