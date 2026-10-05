/*
 * LoadMaster Pro AI — job types.
 *
 * What the homeowner actually wants installed changes almost everything
 * downstream, and until now the app assumed one answer: a ducted split system
 * sized for the whole house.
 *
 * It changes the LOAD CALC: a ductless mini-split has no duct losses at all,
 * so applying a 10-20% duct factor to it overstates the equipment by that much.
 * A duct-only job has no equipment selection to make. A furnace-only job has
 * no cooling side to size.
 *
 * It changes the REBATES more than anything else. The incentive world is
 * organised by measure, not by house: a ducted heat pump, a ductless mini
 * split, duct sealing, insulation and a heat-pump water heater are four or
 * five separate programs with separate money, separate efficiency floors and
 * separate application forms. Searching "HVAC rebates" for a duct-sealing job
 * returns the wrong programs entirely.
 *
 * So the job type is chosen up front, travels with the calculation, and is
 * sent verbatim into the incentive search.
 *
 * Exposed as window.JobTypes (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  /*
   * Each entry declares what it implies, so nothing downstream has to
   * special-case a string:
   *
   *   cooling / heating   does this job size that side of the load?
   *   ducted              false means no duct losses apply (ductFactor 1.0)
   *   systemType          maps to loadcalc's Manual S stage family when known
   *   fuel                how the heating side is produced, for incentives
   *   needsLoad           false = no equipment sizing (duct work, insulation,
   *                       a thermostat); the load calc still runs because the
   *                       house's load is what justifies the work
   *   rebateTerms         the words incentive programs actually use for this
   *                       measure. These are what make the search find the
   *                       right programs instead of generic "HVAC rebate".
   */
  var CATEGORIES = [
    { id: "replace", label: "System replacement" },
    { id: "ductless", label: "Ductless" },
    { id: "partial", label: "Single component" },
    { id: "ducts", label: "Ductwork" },
    { id: "envelope", label: "Envelope & other measures" },
    { id: "new", label: "New construction & additions" }
  ];

  var TYPES = [
    // ---------- Full system replacement ----------
    {
      id: "ac-furnace-80", label: "A/C + 80% gas furnace", short: "A/C + 80% furnace",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "single", fuel: "gas",
      blurb: "Standard-efficiency split system — the common like-for-like change-out.",
      rebateTerms: ["central air conditioner rebate", "SEER2 rebate", "gas furnace rebate", "AFUE rebate"],
      note: "An 80% AFUE furnace is below most efficiency-program thresholds, so expect cooling-side money only."
    },
    {
      id: "ac-furnace-96", label: "A/C + 96% gas furnace", short: "A/C + 96% furnace",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      // A 96% furnace says nothing about how the condenser stages, so this
      // claims no stage family and leaves the app's own default (or the rep's
      // pick) to set it. Asserting "two-stage" here would quietly move the
      // Manual S ceiling on every default calculation.
      systemType: null, fuel: "gas",
      blurb: "High-efficiency condensing furnace with a matched condenser.",
      rebateTerms: ["high efficiency gas furnace rebate", "95 AFUE furnace rebate", "condensing furnace rebate", "central air conditioner SEER2 rebate"]
    },
    {
      id: "ac-airhandler", label: "A/C + electric air handler", short: "A/C + air handler",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "single", fuel: "electric-resistance",
      blurb: "Cooling with electric strip heat — common in the South.",
      rebateTerms: ["central air conditioner rebate", "SEER2 rebate"],
      note: "Strip heat qualifies for almost nothing; a heat pump at the same tonnage usually unlocks far more money."
    },
    {
      id: "hp-standard", label: "Heat pump — standard", short: "Heat pump",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "single", fuel: "heat-pump",
      blurb: "Ducted air-source heat pump with electric backup.",
      rebateTerms: ["air source heat pump rebate", "ducted heat pump rebate", "ENERGY STAR heat pump", "25C heat pump tax credit", "HEAR heat pump rebate"]
    },
    {
      id: "hp-two-stage", label: "Heat pump — two-stage", short: "Two-stage heat pump",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "two", fuel: "heat-pump",
      blurb: "Two-stage compressor — better humidity control and fewer swings.",
      rebateTerms: ["air source heat pump rebate", "two stage heat pump rebate", "ENERGY STAR heat pump", "25C heat pump tax credit", "HEAR heat pump rebate"]
    },
    {
      id: "hp-variable", label: "Heat pump — variable / inverter", short: "Inverter heat pump",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "variable", fuel: "heat-pump",
      blurb: "Fully modulating inverter — the top of most rebate tiers.",
      rebateTerms: ["variable speed heat pump rebate", "inverter heat pump rebate", "ENERGY STAR Most Efficient heat pump", "25C heat pump tax credit", "HEAR heat pump rebate"]
    },
    {
      id: "hp-cold-climate", label: "Cold-climate heat pump", short: "Cold-climate heat pump",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "variable", fuel: "heat-pump",
      blurb: "Rated to hold capacity at low ambient — its own rebate tier in most northern programs.",
      rebateTerms: ["cold climate heat pump rebate", "ccASHP rebate", "NEEP cold climate heat pump", "25C heat pump tax credit", "HEAR heat pump rebate"]
    },
    {
      id: "dual-fuel", label: "Dual fuel (heat pump + gas furnace)", short: "Dual fuel",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: null, fuel: "dual-fuel",   // dual fuel is sold in every stage family
      blurb: "Heat pump above the switchover temperature, gas furnace below it.",
      rebateTerms: ["dual fuel heat pump rebate", "hybrid heat rebate", "air source heat pump rebate", "high efficiency furnace rebate"]
    },
    {
      id: "geothermal", label: "Geothermal / ground-source heat pump", short: "Geothermal",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "variable", fuel: "geothermal",
      blurb: "Ground-loop heat pump — carries the largest federal credit of any HVAC measure.",
      rebateTerms: ["geothermal heat pump rebate", "ground source heat pump incentive", "25D geothermal tax credit", "ENERGY STAR geothermal"]
    },
    {
      id: "packaged", label: "Packaged unit (rooftop / side-yard)", short: "Packaged unit",
      category: "replace", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "single", fuel: "gas",
      blurb: "Single-cabinet gas/electric or heat pump package.",
      rebateTerms: ["packaged unit rebate", "packaged heat pump rebate", "SEER2 rebate"]
    },

    // ---------- Ductless ----------
    {
      id: "minisplit-single", label: "Mini-split — single zone", short: "Mini-split (1 zone)",
      category: "ductless", cooling: true, heating: true, ducted: false, needsLoad: true,
      systemType: "variable", fuel: "heat-pump",
      blurb: "One indoor head, one outdoor unit. No ducts, so no duct losses.",
      rebateTerms: ["ductless mini split rebate", "ductless heat pump rebate", "mini split heat pump incentive", "25C heat pump tax credit"]
    },
    {
      id: "minisplit-multi", label: "Mini-split — multi zone", short: "Mini-split (multi)",
      category: "ductless", cooling: true, heating: true, ducted: false, needsLoad: true,
      systemType: "variable", fuel: "heat-pump",
      blurb: "Several indoor heads on one outdoor unit — room-by-room control.",
      rebateTerms: ["multi zone ductless rebate", "ductless mini split rebate", "ductless heat pump rebate", "25C heat pump tax credit"]
    },
    {
      id: "minisplit-ducted", label: "Ducted mini-split / short-run ducted", short: "Ducted mini-split",
      category: "ductless", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: "variable", fuel: "heat-pump",
      blurb: "Concealed-duct indoor unit — mini-split efficiency through short duct runs.",
      rebateTerms: ["ducted mini split rebate", "ductless heat pump rebate", "variable speed heat pump rebate", "25C heat pump tax credit"]
    },
    {
      id: "minisplit-addon", label: "Mini-split for one room / addition", short: "Mini-split (one room)",
      category: "ductless", cooling: true, heating: true, ducted: false, needsLoad: false,
      systemType: "variable", fuel: "heat-pump",
      blurb: "Spot-conditioning a garage, addition, bonus room or sunroom.",
      rebateTerms: ["ductless mini split rebate", "single zone heat pump rebate", "25C heat pump tax credit"],
      note: "Size this from the room's own load, not the whole house — enter the room under RoomIQ."
    },

    // ---------- Single component ----------
    {
      id: "furnace-only-80", label: "Furnace only — 80%", short: "Furnace only (80%)",
      category: "partial", cooling: false, heating: true, ducted: true, needsLoad: true,
      systemType: "single", fuel: "gas",
      blurb: "Heating-side change-out, existing cooling stays.",
      rebateTerms: ["gas furnace rebate", "AFUE rebate"],
      note: "80% AFUE is below most program thresholds; expect little or no rebate money."
    },
    {
      id: "furnace-only-96", label: "Furnace only — 96% condensing", short: "Furnace only (96%)",
      category: "partial", cooling: false, heating: true, ducted: true, needsLoad: true,
      systemType: null, fuel: "gas",   // no cooling side to stage
      blurb: "High-efficiency heating-side change-out.",
      rebateTerms: ["high efficiency gas furnace rebate", "95 AFUE furnace rebate", "condensing furnace rebate", "ECM furnace rebate"]
    },
    {
      id: "ac-only", label: "A/C only (condenser + coil)", short: "A/C only",
      category: "partial", cooling: true, heating: false, ducted: true, needsLoad: true,
      systemType: "single", fuel: "none",
      blurb: "Cooling-side change-out, existing furnace stays.",
      rebateTerms: ["central air conditioner rebate", "SEER2 rebate", "25C air conditioner tax credit"]
    },
    {
      id: "coil-airhandler", label: "Coil / air handler only", short: "Coil or air handler",
      category: "partial", cooling: true, heating: false, ducted: true, needsLoad: true,
      systemType: "single", fuel: "none",
      blurb: "Indoor section only — usually a matched-coil repair or upgrade.",
      rebateTerms: ["ECM blower motor rebate", "air handler rebate"]
    },
    {
      id: "hpwh", label: "Heat pump water heater", short: "Heat pump water heater",
      category: "partial", cooling: false, heating: false, ducted: false, needsLoad: false,
      systemType: null, fuel: "heat-pump",
      blurb: "Often the single easiest rebate to stack onto an HVAC job.",
      rebateTerms: ["heat pump water heater rebate", "HPWH rebate", "25C water heater tax credit", "ENERGY STAR water heater rebate"]
    },
    {
      id: "thermostat", label: "Smart thermostat", short: "Smart thermostat",
      category: "partial", cooling: false, heating: false, ducted: false, needsLoad: false,
      systemType: null, fuel: "none",
      blurb: "Small money, but nearly every utility offers it and it stacks.",
      rebateTerms: ["smart thermostat rebate", "connected thermostat rebate", "demand response thermostat enrollment"]
    },

    // ---------- Ductwork ----------
    {
      id: "duct-replace", label: "Duct replacement", short: "Duct replacement",
      category: "ducts", cooling: false, heating: false, ducted: true, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "New duct system — sized from the load, not from what was there.",
      rebateTerms: ["duct replacement rebate", "duct insulation rebate", "duct efficiency program"]
    },
    {
      id: "duct-seal", label: "Duct sealing / repair", short: "Duct sealing",
      category: "ducts", cooling: false, heating: false, ducted: true, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "Sealing and repair, usually verified by a duct-leakage test.",
      rebateTerms: ["duct sealing rebate", "Aeroseal rebate", "duct leakage testing incentive", "whole home duct sealing program"]
    },
    {
      id: "duct-addreturn", label: "Add returns / fix airflow", short: "Add returns",
      category: "ducts", cooling: false, heating: false, ducted: true, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "Airflow correction — the fix for the room RoomIQ flags as starved.",
      rebateTerms: ["duct modification rebate", "airflow correction incentive", "quality installation rebate"]
    },
    {
      id: "zoning", label: "Zoning / dampers", short: "Zoning",
      category: "ducts", cooling: false, heating: false, ducted: true, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "Motorised dampers and controls to even out problem rooms.",
      rebateTerms: ["zoning system rebate", "smart zoning incentive"]
    },

    // ---------- Envelope and other measures ----------
    {
      id: "insulation", label: "Insulation / air sealing", short: "Insulation",
      category: "envelope", cooling: false, heating: false, ducted: false, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "Attic, wall or crawl insulation and air sealing.",
      rebateTerms: ["attic insulation rebate", "air sealing rebate", "weatherization rebate", "25C insulation tax credit", "HOMES whole home rebate"]
    },
    {
      id: "windows", label: "Windows / doors", short: "Windows",
      category: "envelope", cooling: false, heating: false, ducted: false, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "Glazing replacement — changes the load as much as equipment does.",
      rebateTerms: ["ENERGY STAR window rebate", "25C window tax credit", "window replacement incentive"]
    },
    {
      id: "iaq", label: "Air quality / ventilation (ERV, filtration)", short: "IAQ / ventilation",
      category: "envelope", cooling: false, heating: false, ducted: true, needsLoad: true,
      systemType: null, fuel: "none",
      blurb: "ERV/HRV, filtration, dehumidification.",
      rebateTerms: ["ERV rebate", "HRV rebate", "ventilation incentive", "whole house dehumidifier rebate"]
    },
    {
      id: "electrical", label: "Panel / electrical upgrade for electrification", short: "Panel upgrade",
      category: "envelope", cooling: false, heating: false, ducted: false, needsLoad: false,
      systemType: null, fuel: "none",
      blurb: "Service upgrade needed to add a heat pump — has its own federal money.",
      rebateTerms: ["electrical panel upgrade rebate", "25C panelboard tax credit", "HEAR electrical panel rebate", "electrification wiring rebate"]
    },

    // ---------- New construction ----------
    {
      id: "new-construction", label: "New construction", short: "New construction",
      category: "new", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: null, fuel: "heat-pump",   // the builder's spec decides, not us
      blurb: "New home — load calc from plans, and new-home program money.",
      rebateTerms: ["new construction rebate", "ENERGY STAR new homes", "45L new energy efficient home credit", "builder efficiency program"]
    },
    {
      id: "addition", label: "Addition / remodel", short: "Addition",
      category: "new", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: null, fuel: "heat-pump",
      blurb: "Extending conditioned space — check whether the existing system can carry it.",
      rebateTerms: ["addition HVAC rebate", "ductless mini split rebate", "heat pump rebate"]
    },
    {
      id: "other", label: "Something else", short: "Other",
      category: "new", cooling: true, heating: true, ducted: true, needsLoad: true,
      systemType: null, fuel: "unknown",
      blurb: "Describe it and the incentive search will use your words.",
      rebateTerms: ["HVAC rebate", "home energy rebate"]
    }
  ];

  var BY_ID = {};
  TYPES.forEach(function (t) { BY_ID[t.id] = t; });

  function get(id) { return BY_ID[id] || null; }
  function all() { return TYPES.slice(); }
  function byCategory() {
    return CATEGORIES.map(function (c) {
      return { id: c.id, label: c.label, types: TYPES.filter(function (t) { return t.category === c.id; }) };
    }).filter(function (c) { return c.types.length; });
  }

  /*
   * Free-text matching, so a rep can type "mini split" or "96 furnace" instead
   * of hunting through thirty chips. Scored rather than first-match: "heat
   * pump water heater" must not land on "heat pump", and it does not, because
   * the water-heater entry scores higher on the longer phrase.
   */
  function search(q) {
    var query = String(q || "").toLowerCase().trim();
    if (!query) return [];
    var words = query.split(/\s+/).filter(Boolean);
    var scored = TYPES.map(function (t) {
      var hay = (t.label + " " + t.short + " " + t.blurb + " " + t.rebateTerms.join(" ")).toLowerCase();
      var score = 0;
      if (t.label.toLowerCase() === query || t.short.toLowerCase() === query) score += 100;
      if (hay.indexOf(query) !== -1) score += 40;
      words.forEach(function (w) {
        if (t.label.toLowerCase().indexOf(w) !== -1) score += 8;
        else if (t.short.toLowerCase().indexOf(w) !== -1) score += 6;
        else if (hay.indexOf(w) !== -1) score += 2;
      });
      // Every query word has to land somewhere, or "mini split water" would
      // match the plain mini-split on one word and mislead.
      var allHit = words.every(function (w) { return hay.indexOf(w) !== -1; });
      return { type: t, score: allHit ? score : score * 0.25 };
    }).filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 6).map(function (x) { return x.type; });
  }

  /*
   * What this job implies for the load calculation. Returned rather than
   * applied so the caller stays in charge of precedence: anything the rep
   * typed by hand still outranks what the job type implies.
   */
  function calcHints(id) {
    var t = get(id);
    if (!t) return {};
    var hints = {};
    if (t.systemType) hints.systemType = t.systemType;
    // A ductless system genuinely has no distribution losses. Applying the
    // usual duct factor to one overstates the equipment by 10-20%, which is a
    // whole size step on a small job.
    if (t.ducted === false) hints.ductType = "ductless";
    return hints;
  }

  /*
   * The phrasing handed to the incentive search. Incentive programs are
   * organised by measure, so sending "duct sealing rebate" instead of a
   * generic "HVAC rebate" is the difference between finding the right program
   * and finding nothing.
   */
  function rebateQuery(id, customText) {
    var t = get(id);
    var custom = String(customText || "").trim().slice(0, 200);
    if (!t) return { label: custom || "HVAC work", terms: ["HVAC rebate"], custom: custom };
    return {
      id: t.id,
      label: t.label,
      terms: t.rebateTerms.slice(),
      fuel: t.fuel,
      ducted: t.ducted,
      custom: custom
    };
  }

  var api = {
    TYPES: TYPES, CATEGORIES: CATEGORIES,
    get: get, all: all, byCategory: byCategory, search: search,
    calcHints: calcHints, rebateQuery: rebateQuery,
    DEFAULT_ID: "ac-furnace-96"
  };
  root.JobTypes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
