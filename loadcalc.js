/*
 * LoadMaster Pro AI — residential block load engine (v2).
 *
 * An engineering ESTIMATE in the spirit of ACCA Manual J: whole-house heating
 * and cooling loads from a compact set of inputs plus location design
 * conditions. v2 adds elevation-corrected air density, heat-pump balance
 * point analysis, an equipment plan, and confidence ranges. It remains a
 * sizing guide, not a substitute for a room-by-room Manual J by a licensed pro.
 *
 * Exposed as window.LoadCalc (and globalThis.LoadCalc for Node tests).
 */
(function (root) {
  // Envelope assumptions by construction/insulation quality.
  // U = overall heat-transfer coefficient (BTU / hr·ft²·°F); lower = better insulated.
  const QUALITY = {
    good:    { uWall: 0.055, uWin: 0.30, shgc: 0.30, uRoof: 0.030, uFloor: 0.040, ach: 0.30 },
    average: { uWall: 0.080, uWin: 0.50, shgc: 0.45, uRoof: 0.045, uFloor: 0.060, ach: 0.55 },
    poor:    { uWall: 0.130, uWin: 0.80, shgc: 0.60, uRoof: 0.070, uFloor: 0.100, ach: 0.90 }
  };

  // Non-insulation R of the ceiling/roof assembly (drywall + air films + deck) —
  // backed out from the existing QUALITY.uRoof constants, which imply clean,
  // standard nominal insulation levels (R-30/R-19/R-11 for good/average/poor)
  // at this base value.
  const ROOF_BASE_R = 3;

  // Duct loss/gain factor by location + sealing/insulation condition.
  // Location matters (conditioned space < crawlspace < unconditioned attic),
  // but condition matters at least as much: a well-sealed attic system (1.10)
  // can beat a leaky crawlspace system (1.15) — that's intentional, not an
  // ordering mistake. attic+sealed is pinned to exactly today's flat 1.10
  // default so omitting these fields entirely reproduces legacy behavior.
  const DUCT_FACTORS = {
    ductless: 1.00,
    "conditioned-space": { sealed: 1.02, unsealed: 1.05 },
    crawlspace: { sealed: 1.08, unsealed: 1.15 },
    attic: { sealed: 1.10, unsealed: 1.20 }
  };

  function resolveDuctFactor(ductType, ductCondition) {
    var v = DUCT_FACTORS[ductType];
    if (v == null) return null;
    if (typeof v === "number") return v; // ductless
    return v[ductCondition] != null ? v[ductCondition] : v.sealed;
  }

  const DEFAULTS = {
    area: 2000,          // conditioned floor area, ft²
    bedrooms: 3,
    quality: "average",
    foundation: "slab",  // slab | crawl | basement
    sun: "average",      // low | average | high (overall solar exposure)
    systemType: "single",// single | two | variable (affects Manual S-style selection)
    elevFt: 0,           // site elevation, feet
    indoorHeat: 70,      // °F winter setpoint
    indoorCool: 75,      // °F summer setpoint
    indoorGrains: 65,    // grains/lb at 75°F / 50% RH
    windowFrac: 0.15,    // glazing as a fraction of floor area
    ceiling: 9,          // ft (incl. structure) per story
    ductFactor: 1.10,    // 10% distribution/duct loss adder
    // Orientation-averaged incident solar flux on glazing, BTU/hr·ft².
    // Multiplied by SHGC this yields Manual J-style glass HTMs of roughly
    // 21 (good low-SHGC glass) to 42 (older clear glass) BTU/hr·ft².
    solarFlux: 70,
    rangePct: 0.15       // ± confidence band applied to totals
  };

  // Foundation type -> floor U multiplier and heating-only adder factor.
  const FOUNDATION = {
    slab:     { uMult: 0.85, heatAdd: 1.00 },
    crawl:    { uMult: 1.30, heatAdd: 1.00 },
    basement: { uMult: 0.70, heatAdd: 1.08 }  // below-grade walls add some winter loss
  };
  // Overall sun/shading exposure -> solar gain multiplier.
  const SUN = { low: 0.72, average: 1.0, high: 1.35 };

  // Standard-atmosphere pressure ratio at elevation (ft). Air-side heat factors
  // (1.08 sensible, 0.68 latent) scale with air density.
  function airFactor(elevFt) {
    var e = Math.max(0, elevFt || 0);
    return Math.pow(1 - 6.8754e-6 * e, 5.2559);
  }

  // Map "year built" to a default construction quality when property data is available.
  function qualityFromYear(year) {
    if (!year) return null;
    if (year >= 2006) return "good";
    if (year >= 1980) return "average";
    return "poor";
  }

  // Common residential furnace OUTPUT capacities (input × ~96% AFUE), BTU/h.
  const FURNACE_OUTPUTS = [38000, 57000, 76000, 96000, 115000];

  function furnaceOutputFor(load) {
    for (var i = 0; i < FURNACE_OUTPUTS.length; i++) {
      if (FURNACE_OUTPUTS[i] >= load) return FURNACE_OUTPUTS[i];
    }
    return Math.ceil(load / 5000) * 5000; // very large homes: round up to 5k
  }

  /*
   * Manual S-style equipment selection from the exact cooling load (tons).
   * Fixed-capacity equipment comes in half-ton steps; ACCA Manual S allows
   * roughly 90%–115% of the calculated total load for single/two-stage
   * cooling. Variable-capacity (inverter) systems modulate (typically down
   * to ~30-40% of nominal), so they're selected at-or-just-above the load
   * without the oversize penalty — often a half-ton smaller than the
   * "round up to be safe" habit.
   */
  function sizeFor(loadTons, type) {
    var t = Math.max(0.75, loadTons);
    var up = Math.ceil(t * 2 - 1e-9) / 2;            // smallest half-ton ≥ load
    if (type === "variable") return Math.max(1, up);
    var n = Math.max(1, up);
    if (n > 1.15 * t) {                               // >115% oversized —
      var dn = n - 0.5;                               // step down if ≥90% holds
      if (dn >= 0.9 * t && dn >= 1) n = dn;
    }
    return n;
  }

  // Heat-pump capacity retention at 17°F vs 47°F rating, by system type.
  // Standard single/two-stage ASHPs hold ~60%; inverter-driven and
  // cold-climate units hold far more.
  const HP_RETENTION = { single: 0.60, two: 0.62, variable: 0.82 };

  function systemSuggestion(heating99) {
    if (heating99 >= 35) return "Mild winters here — a standard heat pump handles both seasons on its own.";
    if (heating99 >= 20) return "A heat pump with a small electric backup strip is an excellent fit for this climate.";
    if (heating99 >= 5)  return "Consider a cold-climate heat pump, or dual-fuel (heat pump + gas furnace) for the coldest snaps.";
    return "Cold design temps: dual-fuel or a high-efficiency furnace + A/C is the safe play; a cold-climate heat pump needs generous backup.";
  }

  /*
   * Heat-pump balance point. Approximates a standard air-source heat pump
   * sized at `tons`: capacity ~102% of nominal at 47°F falling to ~60% of
   * that at 17°F (linear). Building load line uses the conventional 65°F
   * balance-point base (internal gains offset the last ~5°F).
   */
  function balancePoint(tons, heatingTotal, indoorHeat, heating99, systemType) {
    var dt = Math.max(1, indoorHeat - heating99);
    var ua = heatingTotal / dt;                  // effective BTU/hr·°F incl. ducts & infiltration
    var c47 = 1.02 * tons * 12000;
    var c17 = (HP_RETENTION[systemType] || HP_RETENTION.single) * c47;
    var k = (c47 - c17) / 30;                    // capacity slope per °F
    function cap(T) { return Math.max(0, c17 + k * (T - 17)); }
    function load(T) { return Math.max(0, ua * (65 - T)); }
    var bp = (ua * 65 - c17 + 17 * k) / (ua + k);
    bp = Math.min(65, Math.max(-30, bp));
    var auxBtu = Math.max(0, load(heating99) - cap(heating99));
    return {
      balanceF: Math.round(bp),
      capAtDesign: Math.round(cap(heating99)),
      loadAtDesign: Math.round(load(heating99)),
      auxBtu: Math.round(auxBtu),
      auxKw: Math.round(auxBtu / 3412 * 10) / 10,
      // line parameters so callers can chart load/capacity at any temperature
      ua: ua, c17: c17, k: k,
      loadAt: load, capAt: cap
    };
  }

  // Return-air-check constants, cross-validated against each other:
  // 400 CFM/ton / 500 FPM = 115.2 sq in free area/ton; / 0.75 free-area factor
  // ~= 154 nominal sq in/ton -- within 7% of the independently-known 144 rule,
  // so all three numbers agree with each other.
  const RETURN_VELOCITY_FPM = 500;       // design velocity assumption for ducted return sizing
  const GRILLE_FREE_AREA_FACTOR = 0.75;  // typical louvered grille open-area fraction of nominal size
  const RETURN_SQIN_PER_TON = 144;       // standard HVAC field rule of thumb, ~1 sq ft opening per ton

  // Validation-only check: does NOT feed back into heating/cooling/tons.
  // opts: { mode: "ducted"|"grille", ductDiameterIn, grilleW, grilleH, requiredCfm, tons }
  // requiredCfm and tons should come from a prior compute() result's
  // equipment.airflowCfm and recommendedTons.
  function returnAirCheck(opts) {
    if (!opts || !opts.mode) return null;
    var requiredCfm = opts.requiredCfm, tons = opts.tons;
    if (opts.mode === "ducted") {
      var d = opts.ductDiameterIn;
      if (!(d > 0)) return null;
      var areaSqFt = Math.PI * Math.pow(d / 2, 2) / 144;
      var maxCfm = areaSqFt * RETURN_VELOCITY_FPM;
      var ok = requiredCfm != null ? maxCfm >= requiredCfm : null;
      return {
        mode: "ducted",
        providedValue: Math.round(maxCfm),
        requiredValue: requiredCfm != null ? Math.round(requiredCfm) : null,
        ok: ok,
        message: ok == null ? "Return duct capacity: " + Math.round(maxCfm) + " CFM (estimated)."
          : ok ? "Adequate — return duct can move " + Math.round(maxCfm) + " CFM, system needs " + Math.round(requiredCfm) + " CFM."
               : "Likely undersized — return duct estimated at " + Math.round(maxCfm) + " CFM, system needs " + Math.round(requiredCfm) + " CFM. Consider a larger return or a second return.",
        disclosure: "Estimated using a 500 ft/min design velocity for return ductwork — a common, quiet-duct residential target. Actual capacity depends on duct material and installation quality."
      };
    }
    if (opts.mode === "grille") {
      var w = opts.grilleW, h = opts.grilleH;
      if (!(w > 0) || !(h > 0)) return null;
      var freeSqIn = w * h * GRILLE_FREE_AREA_FACTOR;
      var sqInPerTon = tons ? freeSqIn / tons : null;
      var ok2 = sqInPerTon != null ? sqInPerTon >= RETURN_SQIN_PER_TON : null;
      return {
        mode: "grille",
        providedValue: Math.round(freeSqIn),
        requiredValue: tons ? Math.round(RETURN_SQIN_PER_TON * tons) : null,
        sqInPerTon: sqInPerTon != null ? Math.round(sqInPerTon) : null,
        ok: ok2,
        message: ok2 == null ? "Return grille free area: ~" + Math.round(freeSqIn) + " sq in (estimated)."
          : ok2 ? "Adequate — ~" + Math.round(freeSqIn) + " sq in of free area (" + Math.round(sqInPerTon) + " sq in/ton)."
                : "Likely undersized — ~" + Math.round(freeSqIn) + " sq in of free area is only " + Math.round(sqInPerTon) + " sq in/ton (target: " + RETURN_SQIN_PER_TON + "). Consider a larger grille or a second return.",
        disclosure: "Assumes a standard louvered return grille (~75% free area). Denser or decorative grille faces pass less air. Screened against the common HVAC field rule of ≥144 sq in of return opening per ton — a rule-of-thumb check, not a Manual D duct design."
      };
    }
    return null;
  }

  function compute(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const q = QUALITY[o.quality] || QUALITY.average;

    // Resolve duct loss factor against the RAW, pre-merge opts — after the
    // merge above, o.ductFactor is always populated from DEFAULTS, so it's
    // impossible to tell "caller explicitly set ductFactor" apart from
    // "caller omitted it" once merged. Falling back to o.ductFactor here
    // keeps every existing/omitted-field caller bit-for-bit unchanged.
    var rawOpts = opts || {};
    var ductFactor = o.ductFactor;
    if (rawOpts.ductFactor == null && rawOpts.ductType) {
      var resolved = resolveDuctFactor(rawOpts.ductType, rawOpts.ductCondition);
      if (resolved != null) ductFactor = resolved;
    }
    o.ductFactor = ductFactor; // keep echoed inputs.ductFactor in sync with the value actually used

    const heating99 = o.heating99;   // outdoor winter design temp, °F
    const cooling1 = o.cooling1;     // outdoor summer design temp, °F
    const outGrains = o.outGrains;   // outdoor design humidity, grains/lb

    // --- Geometry estimated from floor area ---
    const stories = o.area > 2200 ? 2 : 1;
    const footprint = o.area / stories;
    const wallHeight = o.ceiling * stories;          // total exterior wall height
    const perimeter = 4 * Math.sqrt(footprint);       // assume ~square footprint
    const grossWall = perimeter * wallHeight;
    const windowArea = o.windowFrac * o.area;
    const netWall = Math.max(0, grossWall - windowArea);
    const roofArea = footprint;
    const floorArea = footprint;
    const volume = footprint * wallHeight;            // conditioned air volume, ft³

    const fnd = FOUNDATION[o.foundation] || FOUNDATION.slab;
    const sunMult = SUN[o.sun] != null ? SUN[o.sun] : 1;
    const uFloorEff = q.uFloor * fnd.uMult;
    const acf = airFactor(o.elevFt);                  // air density correction
    const sensC = 1.08 * acf;                         // sensible air constant
    const latC = 0.68 * acf;                          // latent air constant

    // Natural infiltration converted to CFM.
    const cfm = (q.ach * volume) / 60;

    // Design temperature differences.
    const dtHeat = Math.max(0, o.indoorHeat - heating99);
    const dtCool = Math.max(0, cooling1 - o.indoorCool);

    // Attic insulation R-value override: when the caller supplies a real R-value
    // (>= 5, to guard against stray low entries being a data-entry mistake rather
    // than a deliberate near-zero-insulation ceiling), derive an effective roof
    // U-value from it instead of the flat per-quality-tier constant. Omitted or
    // below the guard -> exact legacy behavior (q.uRoof), unchanged.
    const atticRNum = o.atticR != null ? Number(o.atticR) : NaN;
    const uRoofEff = (!isNaN(atticRNum) && atticRNum >= 5) ? 1 / (atticRNum + ROOF_BASE_R) : q.uRoof;

    // Conductive UA (BTU/hr·°F). Floor counts for heating, dropped for cooling
    // (ground stays near/below indoor temp in summer).
    const uaHeat = q.uWall * netWall + q.uWin * windowArea + uRoofEff * roofArea + uFloorEff * floorArea;
    const uaCool = q.uWall * netWall + q.uWin * windowArea + uRoofEff * roofArea;

    // ---------- HEATING ----------
    const hConduction = uaHeat * dtHeat;
    const hInfiltration = sensC * cfm * dtHeat;
    const heatingRaw = (hConduction + hInfiltration) * fnd.heatAdd;
    const heating = heatingRaw * ductFactor;

    // ---------- COOLING ----------
    const occupants = (o.bedrooms || 0) + 1;
    const cConduction = uaCool * dtCool;
    const cSolar = windowArea * q.shgc * o.solarFlux * sunMult;
    const cPeopleSens = occupants * 230;
    const cInternal = 1200 + o.area * 0.6;            // appliances + lighting/plug loads
    const cInfilSens = sensC * cfm * dtCool;
    const sensible = cConduction + cSolar + cPeopleSens + cInternal + cInfilSens;

    const grainsDiff = Math.max(0, outGrains - o.indoorGrains);
    const cInfilLat = latC * cfm * grainsDiff;
    const cPeopleLat = occupants * 200;
    const latent = cInfilLat + cPeopleLat;

    const coolingRaw = sensible + latent;
    const cooling = coolingRaw * ductFactor;

    const tons = cooling / 12000;
    // Manual S-style selection for the chosen system type, plus the
    // alternatives so the contractor can compare on the spot.
    const recommendedTons = sizeFor(tons, o.systemType);
    const sizing = {
      single: sizeFor(tons, "single"),
      two: sizeFor(tons, "two"),
      variable: sizeFor(tons, "variable")
    };

    // ---------- Equipment plan ----------
    const furnaceOut = furnaceOutputFor(heating);
    const equipment = {
      acTons: recommendedTons,
      acBtu: recommendedTons * 12000,
      oversizePct: Math.round(recommendedTons / tons * 100),
      airflowCfm: Math.round(recommendedTons * 400 / 25) * 25,
      furnaceOutput: furnaceOut,
      suggestion: systemSuggestion(heating99)
    };

    const hp = balancePoint(recommendedTons, heating, o.indoorHeat, heating99, o.systemType);

    const pct = o.rangePct;
    function band(v) { return { low: Math.round(v * (1 - pct)), high: Math.round(v * (1 + pct)) }; }

    return {
      inputs: { ...o, stories, occupants, windowArea: Math.round(windowArea), cfm: Math.round(cfm), acf: Math.round(acf * 1000) / 1000 },
      heating: {
        total: Math.round(heating),
        range: band(heating),
        conduction: Math.round(hConduction * fnd.heatAdd * ductFactor),
        infiltration: Math.round(hInfiltration * fnd.heatAdd * ductFactor)
      },
      cooling: {
        total: Math.round(cooling),
        range: band(cooling),
        sensible: Math.round(sensible * ductFactor),
        latent: Math.round(latent * ductFactor),
        breakdown: {
          conduction: Math.round(cConduction * ductFactor),
          solar: Math.round(cSolar * ductFactor),
          people: Math.round((cPeopleSens + cPeopleLat) * ductFactor),
          internal: Math.round(cInternal * ductFactor),
          infiltration: Math.round((cInfilSens + cInfilLat) * ductFactor)
        }
      },
      tons: Math.round(tons * 100) / 100,
      recommendedTons: recommendedTons,
      sizing: sizing,
      sqftPerTon: Math.round(o.area / recommendedTons),
      equipment: equipment,
      heatpump: hp
    };
  }

  const api = { compute, qualityFromYear, airFactor, balancePoint, sizeFor, resolveDuctFactor, returnAirCheck, QUALITY, DEFAULTS };
  root.LoadCalc = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
