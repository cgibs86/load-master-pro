/*
 * LoadMaster Pro — simplified residential block load model.
 *
 * This is an engineering ESTIMATE in the spirit of ACCA Manual J. It computes a
 * whole-house ("block") heating and cooling load from a handful of inputs and
 * the location's design temperatures. It is intended for quick sizing guidance,
 * not as a substitute for a full room-by-room Manual J performed by a
 * licensed professional.
 *
 * Exposed as window.LoadCalc.compute(opts) so it can be unit-tested in Node too.
 */
(function (root) {
  // Envelope assumptions by construction/insulation quality.
  // U = overall heat-transfer coefficient (BTU / hr·ft²·°F); lower = better insulated.
  const QUALITY = {
    good:    { uWall: 0.055, uWin: 0.30, shgc: 0.30, uRoof: 0.030, uFloor: 0.040, ach: 0.30 },
    average: { uWall: 0.080, uWin: 0.50, shgc: 0.45, uRoof: 0.045, uFloor: 0.060, ach: 0.55 },
    poor:    { uWall: 0.130, uWin: 0.80, shgc: 0.60, uRoof: 0.070, uFloor: 0.100, ach: 0.90 }
  };

  const DEFAULTS = {
    area: 2000,          // conditioned floor area, ft²
    bedrooms: 3,
    quality: "average",
    foundation: "slab",  // slab | crawl | basement
    sun: "average",      // low | average | high (overall solar exposure)
    indoorHeat: 70,      // °F winter setpoint
    indoorCool: 75,      // °F summer setpoint
    indoorGrains: 65,    // grains/lb at 75°F / 50% RH
    windowFrac: 0.15,    // glazing as a fraction of floor area
    ceiling: 9,          // ft (incl. structure) per story
    ductFactor: 1.10,    // 10% distribution/duct loss adder
    solarPerGlazing: 28  // avg BTU/hr per ft² of glass (orientation-averaged, lightly shaded)
  };

  // Foundation type -> floor U multiplier and heating-only adder factor.
  const FOUNDATION = {
    slab:     { uMult: 0.85, heatAdd: 1.00 },
    crawl:    { uMult: 1.30, heatAdd: 1.00 },
    basement: { uMult: 0.70, heatAdd: 1.08 }  // below-grade walls add some winter loss
  };
  // Overall sun/shading exposure -> solar gain multiplier.
  const SUN = { low: 0.72, average: 1.0, high: 1.35 };

  // Map "year built" to a default construction quality when property data is available.
  function qualityFromYear(year) {
    if (!year) return null;
    if (year >= 2006) return "good";
    if (year >= 1980) return "average";
    return "poor";
  }

  function compute(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const q = QUALITY[o.quality] || QUALITY.average;

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

    // Natural infiltration converted to CFM.
    const cfm = (q.ach * volume) / 60;

    // Design temperature differences.
    const dtHeat = Math.max(0, o.indoorHeat - heating99);
    const dtCool = Math.max(0, cooling1 - o.indoorCool);

    // Conductive UA (BTU/hr·°F). Floor is included for heating, dropped for
    // cooling (ground stays near/below indoor temp in summer).
    const uaHeat = q.uWall * netWall + q.uWin * windowArea + q.uRoof * roofArea + uFloorEff * floorArea;
    const uaCool = q.uWall * netWall + q.uWin * windowArea + q.uRoof * roofArea;

    // ---------- HEATING ----------
    const hConduction = uaHeat * dtHeat;
    const hInfiltration = 1.08 * cfm * dtHeat;        // sensible air-change loss
    const heatingRaw = (hConduction + hInfiltration) * fnd.heatAdd;
    const heating = heatingRaw * o.ductFactor;

    // ---------- COOLING ----------
    const occupants = (o.bedrooms || 0) + 1;
    const cConduction = uaCool * dtCool;
    const cSolar = windowArea * q.shgc * o.solarPerGlazing * sunMult;
    const cPeopleSens = occupants * 230;
    const cInternal = 1200 + o.area * 0.6;            // appliances + lighting/plug loads
    const cInfilSens = 1.08 * cfm * dtCool;
    const sensible = cConduction + cSolar + cPeopleSens + cInternal + cInfilSens;

    const grainsDiff = Math.max(0, outGrains - o.indoorGrains);
    const cInfilLat = 0.68 * cfm * grainsDiff;
    const cPeopleLat = occupants * 200;
    const latent = cInfilLat + cPeopleLat;

    const coolingRaw = sensible + latent;
    const cooling = coolingRaw * o.ductFactor;

    const tons = cooling / 12000;
    // Recommend nominal equipment rounded to the nearest half-ton.
    const recommendedTons = Math.max(1, Math.round(tons * 2) / 2);

    return {
      inputs: { ...o, stories, occupants, windowArea: Math.round(windowArea), cfm: Math.round(cfm) },
      heating: {
        total: Math.round(heating),
        conduction: Math.round(hConduction * fnd.heatAdd * o.ductFactor),
        infiltration: Math.round(hInfiltration * fnd.heatAdd * o.ductFactor)
      },
      cooling: {
        total: Math.round(cooling),
        sensible: Math.round(sensible * o.ductFactor),
        latent: Math.round(latent * o.ductFactor),
        breakdown: {
          conduction: Math.round(cConduction * o.ductFactor),
          solar: Math.round(cSolar * o.ductFactor),
          people: Math.round((cPeopleSens + cPeopleLat) * o.ductFactor),
          internal: Math.round(cInternal * o.ductFactor),
          infiltration: Math.round((cInfilSens + cInfilLat) * o.ductFactor)
        }
      },
      tons: Math.round(tons * 100) / 100,
      recommendedTons
    };
  }

  const api = { compute, qualityFromYear, QUALITY, DEFAULTS };
  root.LoadCalc = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
