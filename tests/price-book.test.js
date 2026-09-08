/*
 * Price book checks — hermetic, no network, no browser.
 * Run: node tests/price-book.test.js
 */
// Minimal localStorage stand-in so the module's load/save can be exercised.
const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
const PB = require("../price-book.js");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}

console.log("\n=== Entry normalization (a bad price must never reach a customer) ===");
{
  ok("an entry with no name is refused", PB.normalizeEntry({ tier: "good" }) === null);
  ok("null and junk are refused", PB.normalizeEntry(null) === null && PB.normalizeEntry("x") === null);
  const e = PB.normalizeEntry({ name: "  Test unit  ", tier: "nonsense", stage: "nope", fuel: "coal", pricing: "vibes", flatPrice: 12000 });
  ok("name is trimmed", e.name === "Test unit");
  ok("unknown tier/stage/fuel fall back to safe defaults", e.tier === "good" && e.stage === "single" && e.fuel === "furnace");
  ok("an unknown pricing mode falls back to one that can actually quote", e.pricing === "flat" && e.price !== null);
  ok("an id is generated", typeof e.id === "string" && e.id.length > 3);

  ok("AFUE accepts 96 and 0.96 alike", PB.normalizeEntry({ name: "a", afue: 96 }).afue === 0.96 && PB.normalizeEntry({ name: "a", afue: 0.96 }).afue === 0.96);
  ok("an impossible AFUE is dropped, not stored", PB.normalizeEntry({ name: "a", afue: 250 }).afue === null);
  ok("an impossible SEER2 is dropped", PB.normalizeEntry({ name: "a", seer2: 900 }).seer2 === null && PB.normalizeEntry({ name: "a", seer2: 2 }).seer2 === null);
  ok("a negative price is dropped", PB.normalizeEntry({ name: "a", pricing: "flat", flatPrice: -500 }).flatPrice === null);
  ok("an absurd price is dropped", PB.normalizeEntry({ name: "a", pricing: "flat", flatPrice: 5e9 }).flatPrice === null);
  ok("a non-numeric price is dropped", PB.normalizeEntry({ name: "a", pricing: "flat", flatPrice: "lots" }).flatPrice === null);
  ok("a missing rebate becomes zero, not NaN", PB.normalizeEntry({ name: "a" }).rebate === 0);

  const bad = PB.normalizeEntry({ name: "a", pricing: "bySize", bySize: { "3": 12000, "99": 5000, "2.5": -1, junk: 900 } });
  ok("by-size drops out-of-range tonnages and prices", Object.keys(bad.bySize).join(",") === "3", Object.keys(bad.bySize).join(","));
  const empty = PB.normalizeEntry({ name: "a", pricing: "bySize", bySize: {}, flatPrice: 9000 });
  ok("an empty by-size table falls back to a mode that can quote", empty.pricing === "flat");
}

console.log("\n=== Pricing at a tonnage ===");
{
  const flat = PB.normalizeEntry({ name: "Flat", pricing: "flat", flatPrice: 12000 });
  ok("flat pricing ignores tonnage", PB.priceAt(flat, 2).price === 12000 && PB.priceAt(flat, 5).price === 12000);

  const perTon = PB.normalizeEntry({ name: "PerTon", pricing: "perTon", basePrice: 5000, perTon: 2000 });
  ok("per-ton pricing is base plus rate", PB.priceAt(perTon, 3).price === 11000);
  ok("per-ton scales with size", PB.priceAt(perTon, 4).price === 13000);
  ok("per-ton explains its basis", /\$5,000 \+ \$2,000\/ton/.test(PB.priceAt(perTon, 3).basis), PB.priceAt(perTon, 3).basis);

  const bySize = PB.normalizeEntry({ name: "BySize", pricing: "bySize", bySize: { "2": 9000, "3": 11000, "4": 13000 } });
  ok("a stocked size prices exactly", PB.priceAt(bySize, 3).price === 11000 && PB.priceAt(bySize, 3).exact === true);
  const near = PB.priceAt(bySize, 3.5);
  ok("an unstocked size uses the nearest stocked one", near.price === 11000 || near.price === 13000);
  ok("...and says it is not an exact match, so nobody quotes the wrong size", near.exact === false && near.nearestTons != null, JSON.stringify(near));
  ok("no tonnage returns null rather than a wrong number", PB.priceAt(bySize, 0) === null && PB.priceAt(null, 3) === null);
}

console.log("\n=== Matching a request to the book ===");
{
  const book = { entries: PB.starterEntries() };
  ok("the starter book is valid and covers both fuels", book.entries.length === 6 && book.entries.every(e => e.name && e.seer2));

  const m = PB.match(book, { tier: "better", fuel: "furnace", stage: "two", tons: 3 });
  ok("an exact tier/fuel/stage request matches", m && m.tierMatch === true && /Two-stage/.test(m.entry.name), m && m.entry.name);
  ok("the match carries a price for that tonnage", m.price === 12000, String(m.price));
  ok("the match carries the efficiency ratings", m.seer2 === 16 && m.afue === 0.96);

  const hp = PB.match(book, { tier: "best", fuel: "hp", stage: "variable", tons: 3 });
  ok("a heat pump request matches a heat pump entry", hp.entry.fuel === "hp" && hp.hspf2 === 9.5);
  ok("fuel is a hard filter — a furnace entry never prices a heat pump quote", PB.match({ entries: book.entries.filter(e => e.fuel === "furnace") }, { tier: "good", fuel: "hp", stage: "single", tons: 3 }) === null);
  ok("stage is a hard filter", PB.match({ entries: book.entries.filter(e => e.stage === "single") }, { tier: "best", fuel: "furnace", stage: "variable", tons: 3 }) === null);

  // Tier is soft: a shop with only one furnace line should still get a quote.
  const oneLine = { entries: [PB.normalizeEntry({ name: "Only line", tier: "good", stage: "two", fuel: "furnace", pricing: "flat", flatPrice: 10000 })] };
  const soft = PB.match(oneLine, { tier: "best", fuel: "furnace", stage: "two", tons: 3 });
  ok("a missing tier falls back to the nearest one rather than returning nothing", soft && soft.price === 10000);
  ok("...and flags that it was not the tier asked for", soft.tierMatch === false);

  // Two lines can legitimately compete for the same slot; the one the shop
  // added most recently is the one they mean.
  const dupes = { entries: [
    PB.normalizeEntry({ name: "Old template line", tier: "best", stage: "variable", fuel: "furnace", pricing: "flat", flatPrice: 15500 }),
    PB.normalizeEntry({ name: "Our actual premium line", tier: "best", stage: "variable", fuel: "furnace", pricing: "flat", flatPrice: 19500 })
  ] };
  const dupe = PB.match(dupes, { tier: "best", fuel: "furnace", stage: "variable", tons: 3 });
  ok("the most recently added of two competing lines wins", dupe.entry.name === "Our actual premium line" && dupe.price === 19500, dupe.entry.name);

  ok("an empty book matches nothing", PB.match({ entries: [] }, { tier: "good", fuel: "furnace", stage: "single", tons: 3 }) === null);
  ok("a missing book does not throw", PB.match(null, { tier: "good", fuel: "furnace", stage: "single", tons: 3 }) === null);
}

console.log("\n=== Filling a whole proposal ===");
{
  const book = { entries: PB.starterEntries() };
  const filled = PB.fillProposal(book, { fuel: "furnace", tonsByTier: { good: 3, better: 3, best: 2.5 } });
  ok("all three tiers fill", filled && filled.good && filled.better && filled.best);
  ok("each tier is priced at its own Manual S tonnage", filled.good.price === 9300 && filled.best.price === 14250, `${filled.good.price} / ${filled.best.price}`);
  ok("a variable-capacity tier gets the variable entry", filled.best.entry.stage === "variable");

  const hpFill = PB.fillProposal(book, { fuel: "hp", tonsByTier: { good: 3, better: 3, best: 3 } });
  ok("switching fuel refills from the heat pump lines", hpFill.good.entry.fuel === "hp" && hpFill.best.hspf2 === 9.5);

  ok("a book with nothing for this fuel returns null so manual entries are left alone",
    PB.fillProposal({ entries: book.entries.filter(e => e.fuel === "furnace") }, { fuel: "dualfuel", tonsByTier: { good: 3, better: 3, best: 3 } }) === null);
  ok("an empty book returns null", PB.fillProposal({ entries: [] }, { fuel: "furnace", tonsByTier: { good: 3 } }) === null);
}

console.log("\n=== Persistence ===");
{
  const saved = PB.save({ entries: [{ name: "Keeper", pricing: "flat", flatPrice: 11000 }, { name: "", flatPrice: 1 }] });
  ok("saving drops invalid entries", saved.entries.length === 1 && saved.entries[0].name === "Keeper");
  const loaded = PB.load();
  ok("what was saved loads back", loaded.entries.length === 1 && loaded.entries[0].flatPrice === 11000);

  store[PB.STORAGE_KEY] = "{not json";
  ok("corrupt storage loads as an empty book instead of throwing", PB.load().entries.length === 0);
  store[PB.STORAGE_KEY] = JSON.stringify({ entries: "nope" });
  ok("a wrong-shaped payload loads as an empty book", PB.load().entries.length === 0);
  store[PB.STORAGE_KEY] = JSON.stringify({ entries: [{ name: "Hand edited", pricing: "flat", flatPrice: 99999999999 }] });
  ok("a hand-edited absurd price is scrubbed on load", PB.load().entries[0].flatPrice === null);
}

console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
process.exit(failed ? 1 : 0);
