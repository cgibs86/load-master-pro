/*
 * LoadMaster Pro AI — OpCost energy engine (bin method).
 *
 * Turns a design load into an ANNUAL operating-cost estimate for any piece of
 * equipment, using the modified bin method: the year's hourly outdoor
 * temperatures are grouped into 5°F bins (from the same hourly weather the
 * design conditions came from — see climate-engine.js temperatureBins), the
 * building load is evaluated at each bin's midpoint, and the equipment's
 * efficiency and capacity are evaluated at that same temperature. Summing
 * load / efficiency × hours across the bins gives seasonal kWh and therms.
 *
 * This is the method ACCA Manual J's companion documents and ASHRAE's
 * Handbook describe for residential energy estimates; it is far more honest
 * than "SEER × hours" because it charges an air conditioner for the hours it
 * actually runs at 100°F (where it is least efficient) and credits a heat
 * pump only for the capacity it actually has at 10°F.
 *
 * It is an ESTIMATE for comparing options against each other on the same
 * house — not a utility-bill prediction. Occupant behaviour, setbacks, and
 * duct leakage move real bills more than any equipment choice.
 *
 * Exposed as window.EnergyEngine (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  var BIN_WIDTH_F = 5;
  var COOL_BASE_F = 65;   // outdoor temp where cooling load reaches zero (internal gains offset)
  var HEAT_BASE_F = 65;   // outdoor temp where heating load reaches zero (matches balancePoint())
  var BTU_PER_KWH = 3412;
  var BTU_PER_THERM = 100000;

  /*
   * Typical residential utility prices by state — approximate recent
   * annual averages (electricity ¢/kWh, natural gas $/therm), rounded.
   * These are STARTING POINTS: the customer's own bill is always better,
   * which is why every UI that consumes them offers an override. Gas
   * prices vary far more than electricity (delivery charges dominate small
   * residential bills), so the therm figures are the softer of the two.
   */
  var STATE_RATES = {
    AL: [15.5, 2.10], AK: [25.0, 1.50], AZ: [15.0, 1.90], AR: [13.0, 1.60], CA: [31.0, 2.30],
    CO: [15.5, 1.30], CT: [30.0, 2.20], DE: [17.5, 1.70], DC: [19.0, 1.90], FL: [15.5, 2.60],
    GA: [14.5, 2.00], HI: [42.0, 5.50], ID: [11.5, 1.10], IL: [16.5, 1.20], IN: [15.5, 1.20],
    IA: [13.5, 1.30], KS: [14.5, 1.40], KY: [13.0, 1.30], LA: [12.0, 1.50], ME: [24.0, 2.20],
    MD: [18.0, 1.60], MA: [29.0, 2.40], MI: [19.0, 1.20], MN: [15.0, 1.20], MS: [13.5, 1.60],
    MO: [13.0, 1.50], MT: [12.5, 1.20], NE: [12.0, 1.20], NV: [15.5, 1.50], NH: [26.0, 2.10],
    NJ: [19.5, 1.40], NM: [14.5, 1.30], NY: [24.0, 1.80], NC: [13.5, 2.00], ND: [11.5, 1.10],
    OH: [16.0, 1.30], OK: [13.0, 1.60], OR: [13.5, 1.60], PA: [17.5, 1.60], RI: [28.0, 2.30],
    SC: [14.5, 2.10], SD: [13.0, 1.20], TN: [12.5, 1.40], TX: [15.0, 1.60], UT: [11.5, 1.10],
    VT: [22.0, 1.90], VA: [14.5, 1.60], WA: [12.0, 1.50], WV: [14.5, 1.30], WI: [17.0, 1.20],
    WY: [12.5, 1.20]
  };
  var NATIONAL_RATES = [16.5, 1.60];

  var STATE_NAMES = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
    connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
    hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
    kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
    michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
    nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
    washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY"
  };

  // Accepts "California", "CA", "ca", or junk -> { kwh: $/kWh, therm: $/therm, state, national }
  function ratesForState(stateNameOrCode) {
    var key = String(stateNameOrCode || "").trim();
    var code = key.length === 2 ? key.toUpperCase() : STATE_NAMES[key.toLowerCase()];
    var row = code && STATE_RATES[code];
    var r = row || NATIONAL_RATES;
    return { kwh: r[0] / 100, therm: r[1], state: row ? code : null, national: !row };
  }

  /*
   * Synthetic temperature bins for the station-table fallback (no hourly
   * series available). A sinusoidal annual cycle plus a ±8°F daily swing,
   * scaled so the 1% / 99% extremes land on the design temperatures. It is a
   * placeholder that makes OpCost still run offline; the UI discloses it.
   */
  function syntheticBins(heating99, cooling1) {
    var daily = 8;
    var mean = (heating99 + cooling1) / 2;
    var amp = Math.max(4, (cooling1 - heating99) / 2 - daily);
    var counts = {};
    for (var d = 0; d < 365; d++) {
      var dayMean = mean - amp * Math.cos(2 * Math.PI * (d - 20) / 365); // coldest ~Jan 20
      for (var h = 0; h < 24; h++) {
        var t = dayMean - daily * Math.cos(2 * Math.PI * (h - 15) / 24);  // warmest ~3pm
        var edge = Math.floor(t / BIN_WIDTH_F) * BIN_WIDTH_F;
        counts[edge] = (counts[edge] || 0) + 1;
      }
    }
    return counts;
  }

  // ---------- Equipment performance models ----------

  /*
   * Air-conditioner efficiency at outdoor temperature T. SEER2 is by
   * definition a seasonal average dominated by ~82°F operation, so it is
   * anchored there and slid ~1.2%/°F: at 95°F a 14.3 SEER2 unit lands near
   * its ~12 EER2 rating, and at 105°F it is charged ~28% more per BTU than
   * its label suggests — which is exactly the effect a Phoenix customer
   * sees on a July bill and a straight "SEER × hours" estimate hides.
   */
  function eerAt(seer2, T) {
    var t = Math.min(115, Math.max(65, T));
    return Math.max(4, seer2 * (1 + 0.012 * (82 - t)));
  }

  /*
   * Heat-pump COP and capacity at outdoor temperature T.
   *
   * COP at 47°F is inferred from HSPF2 (a seasonal figure that already
   * includes defrost and cycling losses, so the rated 47°F COP runs ~1.5×
   * the seasonal average). Below 47°F COP and capacity both fall linearly;
   * how fast is the difference between a standard and a cold-climate unit:
   *   standard:      capacity at 17°F ≈ 60-62% of 47°F, COP slope 1.1%/°F
   *   cold-climate:  capacity at 17°F ≈ 82% (variable-speed), COP slope 0.7%/°F
   * The capacity retention values are the same ones loadcalc.js uses for
   * the balance-point chart, so the two agree about when backup heat runs.
   * A 5% defrost penalty applies in the 25-45°F frost band.
   */
  var HP_RETENTION = { single: 0.60, two: 0.62, variable: 0.82 };
  function hpAt(hspf2, T, systemType, tons) {
    var coldClimate = systemType === "variable";
    var cop47 = Math.max(1.5, hspf2 * 0.44);
    var cop;
    if (T < 47) cop = cop47 * (1 - (coldClimate ? 0.007 : 0.011) * (47 - T));
    else cop = cop47 * Math.min(1.15, 1 + 0.006 * (T - 47));
    cop = Math.max(1.0, cop);
    var c47 = 1.02 * tons * 12000;
    var c17 = (HP_RETENTION[systemType] || HP_RETENTION.single) * c47;
    var k = (c47 - c17) / 30;
    var cap = Math.max(0, c17 + k * (T - 17));
    var defrost = (T >= 25 && T <= 45) ? 1.05 : 1.0;
    return { cop: cop, capBtu: cap, defrost: defrost };
  }

  // ---------- Bin-method annual energy ----------

  /*
   * opts:
   *   bins        {"<lower edge °F>": hours}  (climate-engine temperatureBins or syntheticBins)
   *   coolingBtu  design cooling load (total, incl. latent) at cooling1
   *   cooling1    outdoor summer design temp
   *   heatingBtu  design heating load at heating99
   *   heating99   outdoor winter design temp
   *   indoorHeat  winter setpoint (default 70)
   *   system {
   *     coolType  "ac" | "hp" | "none"          (hp = the heat pump also cools)
   *     seer2     cooling efficiency (SEER2)
   *     tons      nominal cooling tons
   *     heatType  "furnace" | "hp" | "dualfuel" | "resistance" | "none"
   *     afue      furnace efficiency 0-1 (furnace / dualfuel)
   *     hspf2     heat pump heating efficiency (hp / dualfuel)
   *     systemType "single" | "two" | "variable"  (capacity/COP curve family)
   *     switchoverF dual-fuel: furnace takes over below this (default: balance point)
   *     furnaceOutputBtu optional, for blower runtime
   *   }
   *   rates { kwh: $/kWh, therm: $/therm }
   */
  function annualEnergy(opts) {
    var o = opts || {};
    var bins = o.bins || {};
    var sys = o.system || {};
    var rates = o.rates || { kwh: NATIONAL_RATES[0] / 100, therm: NATIONAL_RATES[1] };
    var indoorHeat = o.indoorHeat != null ? o.indoorHeat : 70;

    var coolSlope = (o.cooling1 > COOL_BASE_F) ? o.coolingBtu / (o.cooling1 - COOL_BASE_F) : 0;
    var heatUa = (indoorHeat > o.heating99) ? o.heatingBtu / (indoorHeat - o.heating99) : 0;
    function coolLoad(T) { return Math.max(0, coolSlope * (T - COOL_BASE_F)); }
    function heatLoad(T) { return Math.max(0, heatUa * (HEAT_BASE_F - T)); }

    var tons = sys.tons || Math.max(1, Math.round(o.coolingBtu / 6000) / 2);
    var blowerKw = sys.systemType === "variable" ? 0.15 : 0.35;   // ECM vs PSC-class blower draw

    var coolKwh = 0, coolHours = 0, coolBtu = 0;
    var heatKwh = 0, heatTherms = 0, auxKwh = 0, hpKwh = 0, heatHours = 0, heatBtu = 0, furnaceBtu = 0, hpBtu = 0;

    var switchover = sys.switchoverF;
    if (sys.heatType === "dualfuel" && switchover == null) {
      // Economic-ish default: hand off to the furnace where the heat pump can no longer carry the load.
      var bp = balancePointF(heatUa, sys.systemType, tons);
      switchover = Math.round(bp);
    }

    Object.keys(bins).forEach(function (edge) {
      var hours = bins[edge];
      if (!(hours > 0)) return;
      var T = Number(edge) + BIN_WIDTH_F / 2;

      // ---- cooling ----
      var cl = coolLoad(T);
      if (cl > 0 && sys.coolType && sys.coolType !== "none" && sys.seer2 > 0) {
        var eer = eerAt(sys.seer2, T);
        coolKwh += cl * hours / (eer * 1000);
        coolHours += hours;
        coolBtu += cl * hours;
      }

      // ---- heating ----
      var hl = heatLoad(T);
      if (hl <= 0 || !sys.heatType || sys.heatType === "none") return;
      heatHours += hours;
      heatBtu += hl * hours;
      var useFurnace = sys.heatType === "furnace" || (sys.heatType === "dualfuel" && T < switchover);
      if (useFurnace) {
        var afue = sys.afue > 0 ? sys.afue : 0.80;
        heatTherms += hl * hours / (afue * BTU_PER_THERM);
        furnaceBtu += hl * hours;
        var out = sys.furnaceOutputBtu > 0 ? sys.furnaceOutputBtu : Math.max(hl, 60000);
        heatKwh += blowerKw * Math.min(1, hl / out) * hours;
      } else if (sys.heatType === "hp" || sys.heatType === "dualfuel") {
        var hp = hpAt(sys.hspf2 > 0 ? sys.hspf2 : 7.5, T, sys.systemType, tons);
        var delivered = Math.min(hl, hp.capBtu);
        var shortfall = hl - delivered;
        var e = delivered * hours / (hp.cop * BTU_PER_KWH) * hp.defrost;
        hpKwh += e;
        hpBtu += delivered * hours;
        // Dual-fuel never runs strips — the furnace handles the shortfall band.
        if (sys.heatType === "hp") auxKwh += shortfall * hours / BTU_PER_KWH;
        else { heatTherms += shortfall * hours / ((sys.afue > 0 ? sys.afue : 0.80) * BTU_PER_THERM); furnaceBtu += shortfall * hours; }
        heatKwh += e + (sys.heatType === "hp" ? shortfall * hours / BTU_PER_KWH : 0);
      } else if (sys.heatType === "resistance") {
        heatKwh += hl * hours / BTU_PER_KWH;
        auxKwh += hl * hours / BTU_PER_KWH;
      }
    });

    var coolCost = coolKwh * rates.kwh;
    var heatCost = heatKwh * rates.kwh + heatTherms * rates.therm;
    return {
      cooling: { kwh: Math.round(coolKwh), cost: Math.round(coolCost), hours: coolHours, btu: Math.round(coolBtu) },
      heating: {
        kwh: Math.round(heatKwh), therms: Math.round(heatTherms), auxKwh: Math.round(auxKwh), hpKwh: Math.round(hpKwh),
        cost: Math.round(heatCost), hours: heatHours, btu: Math.round(heatBtu),
        hpShareOfHeat: heatBtu > 0 ? Math.round(hpBtu / heatBtu * 100) : 0,
        switchoverF: sys.heatType === "dualfuel" ? switchover : null
      },
      totalCost: Math.round(coolCost + heatCost),
      rates: rates
    };
  }

  // Balance point of a heat pump against a building UA line (same math as loadcalc.balancePoint).
  function balancePointF(ua, systemType, tons) {
    var c47 = 1.02 * tons * 12000;
    var c17 = (HP_RETENTION[systemType] || HP_RETENTION.single) * c47;
    var k = (c47 - c17) / 30;
    var bp = (ua * HEAT_BASE_F - c17 + 17 * k) / (ua + k);
    return Math.min(HEAT_BASE_F, Math.max(-30, bp));
  }

  // ---------- Existing-system estimation ----------

  // Nameplate efficiency an installed unit most likely carried, from the year
  // it went in (federal minimums plus what the market actually shipped).
  function seerFromYear(year) {
    if (!(year > 1900)) return 10;
    if (year < 1992) return 8;
    if (year < 2006) return 10;
    if (year < 2015) return 13;
    if (year < 2023) return 14;
    return 15;   // 14.3 SEER2 floor ≈ 15 SEER
  }
  function hspfFromYear(year) {
    if (!(year > 1900)) return 7.0;
    if (year < 2006) return 6.8;
    if (year < 2015) return 7.7;
    if (year < 2023) return 8.2;
    return 8.8;   // 7.5 HSPF2 floor ≈ 8.8 HSPF
  }
  function afueFromYear(year) {
    if (!(year > 1900)) return 0.80;
    if (year < 1992) return 0.65;
    return 0.80;
  }
  // Pre-2023 ratings were SEER/HSPF; the 2023 test procedure (SEER2/HSPF2)
  // reads a few percent lower for the same hardware.
  function seerToSeer2(seer) { return Math.round(seer * 0.955 * 10) / 10; }
  function hspfToHspf2(hspf) { return Math.round(hspf * 0.85 * 10) / 10; }

  /*
   * Field degradation: refrigerant charge drift, coil fouling and airflow
   * loss typically cost an unmaintained system a few tenths of a percent of
   * efficiency per year. 0.6%/yr capped at 20% is a middle-of-the-road
   * figure; a well-maintained unit will beat it.
   */
  function ageDerate(installYear, nowYear) {
    var y = (nowYear || new Date().getFullYear()) - (installYear || nowYear || 0);
    if (!(y > 0)) return 1;
    return Math.max(0.80, 1 - 0.006 * y);
  }

  var TYPICAL_LIFE_YEARS = { ac: 15, hp: 15, furnace: 20 };

  /*
   * Right-size check of an installed unit against the calculated load, using
   * the same Manual S bands the sizing engine uses. Returns the percent of
   * load, a verdict, and plain-English consequences a salesperson can say
   * out loud without overstating them.
   */
  function rightSize(existingTons, loadTons, systemType) {
    if (!(existingTons > 0) || !(loadTons > 0)) return null;
    var pct = Math.round(existingTons / loadTons * 100);
    var ceilingPct = systemType === "variable" ? 130 : systemType === "two" ? 125 : (loadTons <= 2 ? 120 : 115);
    var verdict, message;
    if (pct < 90) {
      verdict = "undersized";
      message = "At " + pct + "% of the calculated load this unit can't hold setpoint on design days — it will run continuously and still lose ground in a heat wave.";
    } else if (pct <= ceilingPct) {
      verdict = "right-sized";
      message = "At " + pct + "% of load this unit is inside Manual S's " + ceilingPct + "% ceiling — size is not the problem here.";
    } else if (pct <= 150) {
      verdict = "oversized";
      message = "At " + pct + "% of load this unit is past Manual S's " + ceilingPct + "% ceiling. Expect short cycles, uneven rooms and poor humidity control — it satisfies the thermostat before it has run long enough to wring moisture out of the air.";
    } else {
      verdict = "grossly oversized";
      message = "At " + pct + "% of load this unit is roughly half again bigger than the house needs. Short-cycling this severe wears compressors early and is the usual cause of a cold-but-clammy house.";
    }
    return { pct: pct, ceilingPct: ceilingPct, verdict: verdict, message: message };
  }

  // ---------- Financing ----------

  // Standard amortized payment. apr in percent (e.g. 9.99), term in months.
  function monthlyPayment(principal, aprPct, months) {
    var p = Math.max(0, principal || 0);
    var n = Math.max(1, Math.round(months || 0));
    if (!(p > 0)) return 0;
    var r = (aprPct || 0) / 100 / 12;
    if (r <= 0) return p / n;
    return p * r / (1 - Math.pow(1 + r, -n));
  }

  var api = {
    annualEnergy: annualEnergy, eerAt: eerAt, hpAt: hpAt, balancePointF: balancePointF,
    syntheticBins: syntheticBins, ratesForState: ratesForState, STATE_RATES: STATE_RATES, NATIONAL_RATES: NATIONAL_RATES,
    seerFromYear: seerFromYear, hspfFromYear: hspfFromYear, afueFromYear: afueFromYear,
    seerToSeer2: seerToSeer2, hspfToHspf2: hspfToHspf2, ageDerate: ageDerate,
    rightSize: rightSize, monthlyPayment: monthlyPayment, TYPICAL_LIFE_YEARS: TYPICAL_LIFE_YEARS,
    BIN_WIDTH_F: BIN_WIDTH_F
  };
  root.EnergyEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
