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

  /*
   * ---- Vintage × climate-zone envelope defaults ("EnvelopeIQ") ------------
   *
   * The 3-tier quality bucket above is climate-blind: with it alone, a 2015
   * home in Phoenix and a 2015 home in Minneapolis are handed the SAME attic
   * R-value, window U-factor and air leakage, when the energy code that built
   * them required very different assemblies. That single blind spot moves
   * tonnage, and for the address-only user (who overrides nothing) it is the
   * largest remaining source of error in the estimate.
   *
   * So when the year built AND the site's climate zone are both known, the
   * envelope defaults come from this table instead: nominal attic insulation
   * R-value, window U-factor and SHGC, and natural air changes per hour, by
   * construction era and IECC climate zone (1-8, index 0 unused).
   *
   * Basis, and what these numbers are NOT:
   *   - Post-1980 rows track the prescriptive envelope minimums of the energy
   *     code in force for that era (MEC 1983/1992/1995, IECC 1998-2003,
   *     2006/2009, 2012/2015/2018, 2021) at each zone. Code minimum is what
   *     production builders build to, which is why it predicts the stock well.
   *   - Pre-1980 rows are TYPICAL PRESENT-DAY condition, not as-built: most
   *     surviving pre-code homes have had attic insulation added and many have
   *     had windows replaced, so as-built values (often R-0 ceilings) would
   *     badly overstate load — the direction that oversizes equipment.
   *   - Air leakage is natural ACH, not ACH50. Post-2012 rows reflect the
   *     3 ACH50 (zones 3-8) / 5 ACH50 (zones 1-2) code targets divided by a
   *     typical LBL n-factor of ~20.
   *   - Every value is a DEFAULT that any real measurement replaces: an
   *     NFRC window label, a blower-door number, or a tape measure in the
   *     attic all win over this table (see the override plumbing below).
   *
   * Validation: the two published NREL/IBACOS Building America reference
   * houses this engine is benchmarked against (see tests) are both 2009-IECC
   * homes, so they fall in the "2006-2011" row — which independently predicts
   * Orlando (zone 2) R-30/U-0.60/SHGC-0.30 against the houses' actual
   * R-31/U-0.65/SHGC-0.30, and Chicago (zone 5) R-38/U-0.35/SHGC-0.45
   * against an actual R-38/U-0.35/SHGC-0.50. Air sealing is the one term the
   * table can't predict from vintage: both reference houses were sealed far
   * tighter (0.10 and 0.19 ACHn) than era-typical stock, which is exactly why
   * the ach override exists and why a blower-door number should always be
   * entered when there is one.
   */
  const VINTAGE_ENVELOPE = [
    {
      maxYear: 1959, era: "pre-1960",
      label: "pre-1960, built before any energy code",
      //         zone:  -    1     2     3     4     5     6     7     8
      atticR:        [null,  11,   11,   11,   13,   19,   19,   19,   19],
      windowU:       [null, 1.05, 1.00, 0.90, 0.75, 0.70, 0.65, 0.62, 0.62],
      windowSHGC:    [null, 0.65, 0.65, 0.65, 0.62, 0.60, 0.60, 0.60, 0.60],
      ach:           [null, 0.90, 0.90, 0.88, 0.85, 0.85, 0.82, 0.80, 0.80]
    },
    {
      maxYear: 1979, era: "1960-1979",
      label: "1960-1979, pre-code to first voluntary standards",
      atticR:        [null,  11,   11,   13,   19,   19,   26,   26,   26],
      windowU:       [null, 1.00, 0.95, 0.85, 0.70, 0.65, 0.60, 0.58, 0.58],
      windowSHGC:    [null, 0.62, 0.62, 0.62, 0.60, 0.58, 0.58, 0.58, 0.58],
      ach:           [null, 0.75, 0.75, 0.72, 0.70, 0.68, 0.66, 0.65, 0.65]
    },
    {
      maxYear: 1993, era: "1980-1993",
      label: "1980-1993, first-generation energy codes (MEC)",
      atticR:        [null,  19,   19,   26,   30,   30,   38,   38,   38],
      windowU:       [null, 0.90, 0.85, 0.70, 0.60, 0.55, 0.50, 0.50, 0.50],
      windowSHGC:    [null, 0.58, 0.58, 0.58, 0.56, 0.55, 0.55, 0.55, 0.55],
      ach:           [null, 0.60, 0.60, 0.58, 0.55, 0.52, 0.50, 0.50, 0.50]
    },
    {
      maxYear: 2005, era: "1994-2005",
      label: "1994-2005, MEC 1995 / IECC 1998-2003",
      atticR:        [null,  26,   26,   30,   38,   38,   38,   38,   49],
      windowU:       [null, 0.75, 0.70, 0.55, 0.45, 0.42, 0.40, 0.38, 0.38],
      windowSHGC:    [null, 0.45, 0.45, 0.48, 0.55, 0.55, 0.55, 0.55, 0.55],
      ach:           [null, 0.50, 0.50, 0.48, 0.45, 0.42, 0.40, 0.40, 0.40]
    },
    {
      maxYear: 2011, era: "2006-2011",
      label: "2006-2011, 2006/2009 IECC",
      atticR:        [null,  30,   30,   30,   38,   38,   49,   49,   49],
      windowU:       [null, 0.65, 0.60, 0.50, 0.35, 0.35, 0.35, 0.35, 0.35],
      windowSHGC:    [null, 0.30, 0.30, 0.30, 0.40, 0.45, 0.45, 0.45, 0.45],
      ach:           [null, 0.35, 0.35, 0.32, 0.30, 0.28, 0.28, 0.28, 0.28]
    },
    {
      maxYear: 2020, era: "2012-2020",
      label: "2012-2020, 2012/2015/2018 IECC (blower-door testing required)",
      // Zone 1 ceilings stayed at R-30 from 2012 through 2021 — the code
      // raised zones 2-8 and left the hottest zone alone.
      atticR:        [null,  30,   38,   38,   49,   49,   49,   49,   49],
      windowU:       [null, 0.50, 0.40, 0.35, 0.32, 0.30, 0.30, 0.30, 0.30],
      windowSHGC:    [null, 0.25, 0.25, 0.25, 0.40, 0.40, 0.40, 0.40, 0.40],
      ach:           [null, 0.25, 0.25, 0.16, 0.16, 0.15, 0.15, 0.15, 0.15]
    },
    {
      maxYear: 9999, era: "2021+",
      label: "2021 IECC or newer",
      atticR:        [null,  30,   49,   49,   60,   60,   60,   60,   60],
      windowU:       [null, 0.50, 0.40, 0.30, 0.30, 0.30, 0.30, 0.30, 0.30],
      windowSHGC:    [null, 0.25, 0.25, 0.25, 0.40, 0.40, 0.40, 0.40, 0.40],
      ach:           [null, 0.25, 0.25, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15]
    }
  ];

  /*
   * Envelope defaults for a (year built, climate zone) pair, or null when
   * either is missing/out of range — in which case every caller falls back to
   * the 3-tier quality bucket, exactly as before this table existed.
   */
  function envelopeFromVintage(year, zone) {
    var y = Number(year), z = Number(zone);
    if (!isFinite(y) || y < 1800 || y > 2100) return null;
    if (!isFinite(z) || z < 1 || z > 8) return null;
    z = Math.round(z);
    for (var i = 0; i < VINTAGE_ENVELOPE.length; i++) {
      var row = VINTAGE_ENVELOPE[i];
      if (y <= row.maxYear) {
        return {
          era: row.era, label: row.label, zone: z, yearBuilt: y,
          atticR: row.atticR[z], windowU: row.windowU[z],
          windowSHGC: row.windowSHGC[z], ach: row.ach[z]
        };
      }
    }
    return null;
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
   *
   * Fixed capacity (single/two-stage): equipment comes in half-ton steps and
   * cannot modulate, so the pick is the smallest step at or above the load,
   * stepped back down when that lands beyond ~115% of load and the smaller
   * step still covers Manual S's 90% floor.
   *
   * Variable capacity (inverter): the compressor modulates continuously
   * (typically down to ~25-40% of nominal) AND its maximum output generally
   * exceeds its nominal rating, so it does NOT need the fixed-capacity
   * "round up to be safe" cushion — it is selected to the NEAREST half-ton
   * step, which is often a half-ton smaller than the fixed-capacity pick and
   * must never be larger than it. The 90%-of-load floor still applies so a
   * round-down can't grossly undersize.
   *
   * (Before this was fixed, `variable` always rounded up and never stepped
   * down, so at loads like 1.55 / 2.05 / 2.55 tons it returned a size a half
   * ton LARGER than single-stage — the exact inverse of the intended
   * behavior, and visible to users on the results page.)
   */
  var MANUAL_S_MIN_FRACTION = 0.90;   // total-cooling size factor floor, all types

  /*
   * Normative Manual S total-cooling size-factor ceilings (capacity ÷ load),
   * from the ANSI/ACCA Manual S size-limit tables. These are LIMITS, not
   * targets: the selection below still aims at the load and only consults a
   * ceiling to decide whether the rounded-up step is too big.
   *
   *   Standard (humid/normal) sizing condition:
   *     single-speed  ≤ 1.20 for loads ≤ 24,000 BTU/h, ≤ 1.15 above that
   *     two-speed     ≤ 1.25
   *     variable      ≤ 1.30
   *   Dry sizing condition (gated on Manual J SHR ≥ 0.95):
   *     single-speed  capacity ≤ load + 6,000 BTU/h — an ADDITIVE allowance,
   *                   not a flat percentage (≈125% on a 2-ton load, only
   *                   ≈112% on a 4-ton one), so it is modeled as +0.5 tons
   *                   rather than a multiplier.
   *
   * Variable capacity gets the widest ceiling because it modulates, but a
   * wider *limit* is not a reason to select a bigger unit — oversizing an
   * inverter raises its minimum output until it can no longer turn down far
   * enough, which is what Manual S's separate minimum-compressor rules
   * guard against. So variable is still selected to the nearest step.
   */
  var MANUAL_S_SMALL_LOAD_TONS = 2;   // 24,000 BTU/h breakpoint for single-speed
  var DRY_JSHR_THRESHOLD = 0.95;      // Manual J SHR at/above which the dry band applies
  var DRY_ADDITIVE_TONS = 0.5;        // the +6,000 BTU/h dry allowance, in tons

  // Upper size-factor limit for a given load/type/climate. jshr is the Manual J
  // sensible heat ratio; omit it and the standard (humid) band is used, which
  // is the conservative choice.
  function manualSCeiling(loadTons, type, jshr) {
    var isDry = typeof jshr === "number" && isFinite(jshr) && jshr >= DRY_JSHR_THRESHOLD;
    if (type === "variable") return 1.30;
    // Two-speed's dry-condition rule constrains the MINIMUM-compressor size
    // factor (≤1.15), which needs manufacturer performance data this engine
    // doesn't have; its total-capacity ceiling is 1.25 either way.
    if (type === "two") return 1.25;
    // single-speed
    if (isDry) return (loadTons + DRY_ADDITIVE_TONS) / loadTons;   // additive, not a flat %
    return loadTons <= MANUAL_S_SMALL_LOAD_TONS ? 1.20 : 1.15;
  }

  function sizeFor(loadTons, type, jshr) {
    var t = Math.max(0.75, loadTons);
    var up = Math.ceil(t * 2 - 1e-9) / 2;            // smallest half-ton ≥ load

    if (type === "variable") {
      var near = Math.max(1, Math.round(t * 2) / 2);  // nearest half-ton step
      // A round-down must still clear the 90% floor; if it doesn't, take the
      // step above (which is `up` by construction, since near = up - 0.5 there).
      if (near < MANUAL_S_MIN_FRACTION * t) near = Math.max(1, up);
      return near;
    }

    var ceiling = manualSCeiling(t, type, jshr);
    var n = Math.max(1, up);
    if (n > ceiling * t) {                            // beyond the type's ceiling —
      var dn = n - 0.5;                               // step down if the 90% floor holds
      if (dn >= MANUAL_S_MIN_FRACTION * t && dn >= 1) n = dn;
    }
    return n;
  }

  /*
   * Manual S fit check: does the selected nominal size actually land inside
   * the allowed percent-of-load band, and if not, why?
   *
   * Residential equipment only exists in half-ton steps with a 1-ton floor,
   * so for some small loads NO available size lands in the band (e.g. a
   * 1.2-ton load: 1.0 ton is 83% of load — under the 90% floor — while 1.5
   * tons is 125%, over the fixed-capacity ceiling). Silently printing a
   * number that's 125% of load as though it were a clean Manual S selection
   * overstates the precision available; this reports the real fit so the
   * contractor can see it and judge.
   */
  function manualSFit(selectedTons, loadTons, type, jshr) {
    if (!(loadTons > 0)) return null;
    var pct = selectedTons / loadTons;
    var ceiling = manualSCeiling(loadTons, type, jshr);
    var inBand = pct >= MANUAL_S_MIN_FRACTION - 1e-9 && pct <= ceiling + 1e-9;
    var pctLabel = Math.round(pct * 100);
    var msg;
    if (inBand) {
      msg = "In band — " + pctLabel + "% of the calculated load (Manual S target: " +
            Math.round(MANUAL_S_MIN_FRACTION * 100) + "–" + Math.round(ceiling * 100) + "%).";
    } else if (pct > ceiling) {
      msg = "Closest available size is " + pctLabel + "% of the calculated load, above the " +
            Math.round(ceiling * 100) + "% Manual S target. Equipment only comes in half-ton steps " +
            "(1-ton minimum), so no smaller size clears the 90% floor for this load. Expect shorter " +
            "run cycles; a variable-capacity unit handles this gap better than fixed capacity.";
    } else {
      msg = "Closest available size is " + pctLabel + "% of the calculated load, below the " +
            Math.round(MANUAL_S_MIN_FRACTION * 100) + "% Manual S floor — verify the inputs before sizing this small.";
    }
    return { pctOfLoad: pctLabel, inBand: inBand, message: msg };
  }

  /*
   * Sensible Heat Ratio check — a real Manual S selection criterion this
   * engine had the inputs for but never evaluated.
   *
   * Manual S requires the selected equipment to cover the sensible AND the
   * latent load separately, not just the total. A home whose load is
   * latent-heavy (low required SHR) will feel clammy on a unit that only
   * matches the total, because typical residential equipment removes
   * moisture at roughly SHR 0.75–0.80 at design conditions. Reporting the
   * required SHR lets the contractor pick a coil that actually matches.
   */
  const TYPICAL_EQUIP_SHR_LOW = 0.75;   // standard residential equipment floor
  const TYPICAL_EQUIP_SHR_HIGH = 0.80;  // standard residential equipment ceiling

  function shrCheck(sensibleBtu, latentBtu) {
    var total = sensibleBtu + latentBtu;
    if (!(total > 0)) return null;
    var shr = sensibleBtu / total;
    var rounded = Math.round(shr * 100) / 100;
    var level, message;
    if (shr < TYPICAL_EQUIP_SHR_LOW) {
      level = "high-latent";
      message = "This home's load is moisture-heavy (required SHR " + rounded.toFixed(2) +
        ", below the ~0.75–0.80 that standard equipment delivers). Sizing on total capacity alone " +
        "will leave it cool but clammy. Select a coil rated for enhanced dehumidification, or a " +
        "variable-capacity system with a dehumidification mode — and confirm latent capacity at " +
        "design conditions from the manufacturer's expanded performance data.";
    } else if (shr > TYPICAL_EQUIP_SHR_HIGH) {
      level = "high-sensible";
      message = "This home's load is almost entirely sensible heat (required SHR " + rounded.toFixed(2) +
        ", above the ~0.75–0.80 typical of standard equipment). Favor a high-SHR/dry-climate coil; " +
        "an aggressive dehumidification setup would be wasted capacity here.";
    } else {
      level = "typical";
      message = "Required SHR " + rounded.toFixed(2) + " sits in the ~0.75–0.80 range standard " +
        "residential equipment delivers, so a conventional coil should cover both the sensible and " +
        "latent halves of this load.";
    }
    return {
      shr: rounded,
      sensiblePct: Math.round(shr * 100),
      latentPct: Math.round((1 - shr) * 100),
      level: level,
      message: message
    };
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
      // RETURN_SQIN_PER_TON (144) is a NOMINAL-size field rule (see the
      // constant comment above), so it must be checked against the raw
      // w*h nominal opening, not against the free area after the grille's
      // ~75% open-area factor is applied (that basis is ~115.2 sq in/ton).
      var nominalSqIn = w * h;
      var freeSqIn = nominalSqIn * GRILLE_FREE_AREA_FACTOR;
      var sqInPerTon = tons ? nominalSqIn / tons : null;
      var ok2 = sqInPerTon != null ? sqInPerTon >= RETURN_SQIN_PER_TON : null;
      return {
        mode: "grille",
        providedValue: Math.round(freeSqIn),
        requiredValue: tons ? Math.round(RETURN_SQIN_PER_TON * tons) : null,
        sqInPerTon: sqInPerTon != null ? Math.round(sqInPerTon) : null,
        ok: ok2,
        message: ok2 == null ? "Return grille free area: ~" + Math.round(freeSqIn) + " sq in (estimated)."
          : ok2 ? "Adequate — ~" + Math.round(nominalSqIn) + " sq in nominal size (" + Math.round(sqInPerTon) + " sq in/ton, ~" + Math.round(freeSqIn) + " sq in free area)."
                : "Likely undersized — ~" + Math.round(nominalSqIn) + " sq in nominal size is only " + Math.round(sqInPerTon) + " sq in/ton (target: " + RETURN_SQIN_PER_TON + "). Consider a larger grille or a second return.",
        disclosure: "Assumes a standard louvered return grille (~75% free area). Denser or decorative grille faces pass less air. Screened against the common HVAC field rule of ≥144 nominal sq in of return opening per ton — a rule-of-thumb check, not a Manual D duct design."
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

    /*
     * Vintage × climate-zone envelope defaults. This sits BETWEEN the explicit
     * per-field overrides (which always win) and the 3-tier quality bucket
     * (the floor, and still the only source when either the year built or the
     * climate zone is unknown). Passing neither reproduces pre-EnvelopeIQ
     * numbers bit for bit, which the benchmark suite pins.
     */
    const vin = envelopeFromVintage(o.yearBuilt, o.climateZone);

    const heating99 = o.heating99;   // outdoor winter design temp, °F
    const cooling1 = o.cooling1;     // outdoor summer design temp, °F
    const outGrains = o.outGrains;   // outdoor design humidity, grains/lb

    // --- Geometry estimated from floor area ---
    // Story count drives wall height/roof area independently of floor area
    // (e.g. a 3,200 ft² two-story home has half the footprint/roof of a
    // 3,200 ft² single-story one). An explicit override (manual entry or a
    // PhotoScan AI read of the actual home) beats the area-threshold guess;
    // omitted keeps exact legacy behavior.
    const storiesNum = o.stories != null ? Number(o.stories) : NaN;
    const stories = (!isNaN(storiesNum) && storiesNum > 0) ? storiesNum : (o.area > 2200 ? 2 : 1);
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

    // Air changes per hour: an explicit blower-door/ACH50-derived value (or a
    // known code-target ACHnatural) beats the per-quality-tier guess — air
    // sealing is largely independent of wall/window R-value (validated against
    // a published NREL Manual J case: a 2009-IECC "poor"-walled CMU-block
    // Florida house measured ACHn 0.10, ~9× tighter than the "poor" tier's
    // flat 0.90 default, which alone accounted for most of a >100% cooling
    // overstatement before this override existed). Guarded to a plausible
    // range; omitted -> exact legacy per-tier ach.
    const achNum = o.ach != null ? Number(o.ach) : NaN;
    const achFallback = (vin && vin.ach != null) ? vin.ach : q.ach;
    const achEff = (!isNaN(achNum) && achNum > 0 && achNum <= 3) ? achNum : achFallback;

    // Natural infiltration converted to CFM.
    const cfm = (achEff * volume) / 60;

    // Design temperature differences.
    const dtHeat = Math.max(0, o.indoorHeat - heating99);
    const dtCool = Math.max(0, cooling1 - o.indoorCool);

    // Attic insulation R-value override: when the caller supplies a real R-value
    // (>= 5, to guard against stray low entries being a data-entry mistake rather
    // than a deliberate near-zero-insulation ceiling), derive an effective roof
    // U-value from it instead of the flat per-quality-tier constant. Omitted or
    // below the guard -> exact legacy behavior (q.uRoof), unchanged.
    const atticRNum = o.atticR != null ? Number(o.atticR) : NaN;
    const atticREff = (!isNaN(atticRNum) && atticRNum >= 5) ? atticRNum
      : ((vin && vin.atticR >= 5) ? vin.atticR : null);
    const uRoofEff = atticREff != null ? 1 / (atticREff + ROOF_BASE_R) : q.uRoof;

    // (A wallR override analogous to atticR was tried and rejected during
    // validation against published NREL Manual J case studies: unlike a roof
    // deck, wall assemblies vary too much by type — wood-frame effective R is
    // ~20-30% below cavity-insulation R due to framing thermal bridging, while
    // a CMU block wall's total R includes the block itself plus air films, not
    // just the applied continuous insulation layer. A flat baseline constant
    // (like ROOF_BASE_R) made both a wood-frame and a CMU-block validation
    // case measurably worse, not better, so no override is exposed here — the
    // per-quality-tier q.uWall remains the estimate.)

    // Window U-factor / SHGC overrides: the 3-tier quality bucket ties glazing
    // performance to overall wall/attic quality, which real homes routinely
    // decouple (e.g. impact-rated low-SHGC hurricane glass on an otherwise
    // "poor" CMU-block Florida house — validated against a published NREL
    // Manual J case study where using the "poor" tier's SHGC 0.60 instead of
    // that house's actual 0.30 glass overstated cooling load by >100%).
    // NFRC window labels always list both values, so either can be entered
    // independently. Guarded against nonsensical entries; omitted -> exact
    // legacy per-tier behavior.
    const winUNum = o.windowU != null ? Number(o.windowU) : NaN;
    const uWinFallback = (vin && vin.windowU != null) ? vin.windowU : q.uWin;
    const uWinEff = (!isNaN(winUNum) && winUNum > 0 && winUNum <= 3) ? winUNum : uWinFallback;
    const winSHGCNum = o.windowSHGC != null ? Number(o.windowSHGC) : NaN;
    const shgcFallback = (vin && vin.windowSHGC != null) ? vin.windowSHGC : q.shgc;
    const shgcEff = (!isNaN(winSHGCNum) && winSHGCNum > 0 && winSHGCNum <= 1) ? winSHGCNum : shgcFallback;

    // Conductive UA (BTU/hr·°F). Floor counts for heating, dropped for cooling
    // (ground stays near/below indoor temp in summer).
    const uaHeat = q.uWall * netWall + uWinEff * windowArea + uRoofEff * roofArea + uFloorEff * floorArea;
    const uaCool = q.uWall * netWall + uWinEff * windowArea + uRoofEff * roofArea;

    // ---------- HEATING ----------
    const hConduction = uaHeat * dtHeat;
    const hInfiltration = sensC * cfm * dtHeat;
    const heatingRaw = (hConduction + hInfiltration) * fnd.heatAdd;
    const heating = heatingRaw * ductFactor;

    // ---------- COOLING ----------
    const occupants = (o.bedrooms || 0) + 1;
    const cConduction = uaCool * dtCool;
    const cSolar = windowArea * shgcEff * o.solarFlux * sunMult;
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
    // Manual J sensible heat ratio — drives both the SHR guidance below and
    // which Manual S size band applies (the dry band is gated on JSHR ≥ 0.95).
    const shr = shrCheck(sensible, latent);
    const jshr = shr ? shr.shr : null;
    // Manual S-style selection for the chosen system type, plus the
    // alternatives so the contractor can compare on the spot.
    const recommendedTons = sizeFor(tons, o.systemType, jshr);
    const sizing = {
      single: sizeFor(tons, "single", jshr),
      two: sizeFor(tons, "two", jshr),
      variable: sizeFor(tons, "variable", jshr)
    };

    // ---------- Equipment plan ----------
    const furnaceOut = furnaceOutputFor(heating);
    const equipment = {
      acTons: recommendedTons,
      acBtu: recommendedTons * 12000,
      oversizePct: Math.round(recommendedTons / tons * 100),
      airflowCfm: Math.round(recommendedTons * 400 / 25) * 25,
      furnaceOutput: furnaceOut,
      suggestion: systemSuggestion(heating99),
      manualSFit: manualSFit(recommendedTons, tons, o.systemType, jshr)
    };

    const hp = balancePoint(recommendedTons, heating, o.indoorHeat, heating99, o.systemType);

    /*
     * Envelope provenance. Every one of the four terms that most moves the
     * answer resolves from one of three places — a number the user entered, the
     * vintage × zone table, or the 3-tier quality bucket — and the UI shows
     * which, per term. An assumption a contractor can see is an assumption a
     * contractor can correct, and that is the whole point of surfacing it.
     */
    const atticRExplicit = !isNaN(atticRNum) && atticRNum >= 5;
    const winUExplicit = !isNaN(winUNum) && winUNum > 0 && winUNum <= 3;
    const shgcExplicit = !isNaN(winSHGCNum) && winSHGCNum > 0 && winSHGCNum <= 1;
    const achExplicit = !isNaN(achNum) && achNum > 0 && achNum <= 3;
    function envSrc(explicit, vinVal) {
      return explicit ? "entered" : (vin && vinVal != null ? "vintage" : "tier");
    }
    const envelope = {
      basis: vin ? "vintage-zone" : "quality-tier",
      era: vin ? vin.era : null,
      eraLabel: vin ? vin.label : null,
      zone: vin ? vin.zone : null,
      yearBuilt: vin ? vin.yearBuilt : null,
      // Effective values actually used in the math above.
      atticR: atticREff != null ? atticREff : Math.round(1 / q.uRoof - ROOF_BASE_R),
      windowU: Math.round(uWinEff * 100) / 100,
      windowSHGC: Math.round(shgcEff * 100) / 100,
      ach: Math.round(achEff * 100) / 100,
      source: {
        atticR: envSrc(atticRExplicit, vin && vin.atticR),
        windowU: envSrc(winUExplicit, vin && vin.windowU),
        windowSHGC: envSrc(shgcExplicit, vin && vin.windowSHGC),
        ach: envSrc(achExplicit, vin && vin.ach)
      }
    };

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
      // Sensible/latent balance check — see shrCheck(). Uses the raw (pre-duct)
      // split; the duct factor scales both halves equally so the ratio is
      // identical either way.
      shr: shr,
      sizing: sizing,
      sqftPerTon: Math.round(o.area / recommendedTons),
      equipment: equipment,
      heatpump: hp,
      envelope: envelope
    };
  }

  const api = { compute, qualityFromYear, envelopeFromVintage, airFactor, balancePoint, sizeFor, manualSFit, shrCheck, resolveDuctFactor, returnAirCheck, QUALITY, DEFAULTS, VINTAGE_ENVELOPE };
  root.LoadCalc = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
