/*
 * LoadMaster Pro AI — TrueClimate engine.
 *
 * Computes site-specific HVAC design conditions by analyzing a full year of
 * historical hourly weather (~8,760 hours) for the exact coordinates, via the
 * free Open-Meteo archive API (no key, CORS-enabled):
 *   heating99 = 1st-percentile hourly temperature  (99% winter design dry bulb)
 *   cooling1  = 99th-percentile hourly temperature (1% summer design dry bulb)
 *   outGrains = humidity ratio (grains/lb) from the median dew point during
 *               the hottest 1% of hours, at site barometric pressure
 *   elevFt    = site elevation (drives air-density correction)
 *   hdd65 / cdd50 / climateZone
 *             = heating and cooling degree days from the same hourly series,
 *               and the IECC/ASHRAE-169 thermal climate zone they imply —
 *               which selects the vintage envelope defaults in loadcalc.js
 *
 * Falls back to the embedded nearest-station table when offline or on error.
 * Exposed as window.ClimateEngine (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  // p in [0,1] on an unsorted numeric array (nearest-rank on a sorted copy).
  function percentile(arr, p) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var idx = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))));
    return a[idx];
  }

  function median(arr) { return percentile(arr, 0.5); }

  /*
   * Heating/cooling degree days from the same hourly temperature series the
   * design conditions come from. Degree days are defined on DAILY MEAN
   * temperature, so the hourly series is chunked into 24-hour days first —
   * summing hourly departures directly would inflate both totals (a day that
   * swings either side of the base would contribute to HDD and CDD at once).
   *
   *   hdd65 = sum of max(0, 65 - dailyMean)   — the IECC/ASHRAE heating index
   *   cdd50 = sum of max(0, dailyMean - 50)   — the IECC/ASHRAE cooling index
   *
   * Days with fewer than 20 valid hourly readings are skipped, and the totals
   * are scaled to a full 365-day year so a short or gap-ridden series doesn't
   * read as a milder climate than it is.
   */
  function degreeDays(temps) {
    var hdd = 0, cdd = 0, days = 0;
    for (var i = 0; i + 1 < temps.length; i += 24) {
      var sum = 0, n = 0;
      for (var h = i; h < i + 24 && h < temps.length; h++) {
        var v = temps[h];
        if (typeof v === "number" && isFinite(v)) { sum += v; n++; }
      }
      if (n < 20) continue;                        // incomplete day
      var mean = sum / n;
      if (mean < 65) hdd += 65 - mean;
      if (mean > 50) cdd += mean - 50;
      days++;
    }
    if (days < 300) return null;                   // not enough of a year to index a climate
    var scale = 365 / days;
    return { hdd65: Math.round(hdd * scale), cdd50: Math.round(cdd * scale), days: days };
  }

  /*
   * IECC / ASHRAE 169 thermal climate zone (1-8) from degree days, using the
   * published numeric criteria (IP units). Only the ZONE NUMBER is derived —
   * the moisture suffix (A moist / B dry / C marine) is defined by
   * precipitation criteria this engine doesn't fetch, and nothing downstream
   * needs it: the code-minimum envelope values that consume this are keyed on
   * the number alone.
   *
   * Caveat worth knowing (and disclosed in the UI): the official county-level
   * zone assignments come from 30-year normals, while this is derived from the
   * last ~12 months, so a location sitting on a zone boundary can land one
   * zone either side of its published assignment. The consequence downstream
   * is one step of nominal insulation R in a *default* the user can override,
   * which is why a live-data zone is still worth far more than no zone at all.
   */
  function iecczone(hdd65, cdd50) {
    if (!(hdd65 >= 0) || !(cdd50 >= 0)) return null;
    if (cdd50 > 9000) return 1;
    if (cdd50 > 6300) return 2;
    if (cdd50 > 4500) return 3;
    // Cooling-poor from here down: the heating index decides.
    if (hdd65 <= 3600) return 3;                   // mild winter, mild summer (marine 3C)
    if (hdd65 <= 5400) return 4;
    if (hdd65 <= 7200) return 5;
    if (hdd65 <= 9000) return 6;
    if (hdd65 <= 12600) return 7;
    return 8;
  }

  // Humidity ratio in grains/lb from dew point (°F) at site elevation (ft).
  function grainsFromDewpoint(dewF, elevFt) {
    var tc = (dewF - 32) / 1.8;
    var e = 6.112 * Math.exp((17.62 * tc) / (243.12 + tc));           // vapor pressure, hPa
    var p = 1013.25 * Math.pow(1 - 6.8754e-6 * Math.max(0, elevFt || 0), 5.2559);
    var w = 0.622 * e / Math.max(1, p - e);                            // lb water / lb dry air
    return Math.round(w * 7000);
  }

  // Reduce hourly series to design conditions. temps/dews in °F, elevM meters.
  function analyze(temps, dews, elevM) {
    var t = temps.filter(function (v) { return typeof v === "number" && isFinite(v); });
    var d = dews.filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (t.length < 4000) return null;                                  // need most of a year
    var heating99 = Math.round(percentile(t, 0.01));
    var cooling1 = Math.round(percentile(t, 0.99));

    /*
     * Design humidity (grains/lb) for the LATENT half of the cooling load.
     *
     * This used to take the median dew point during the hottest 1% of hours.
     * That is wrong, and wrong in a direction that matters: peak dew point
     * does not occur during peak dry-bulb. On the hottest afternoons the air
     * is comparatively drier, so sampling humidity only at the temperature
     * peak systematically understates moisture in humid climates — which
     * understates latent load, which undersizes equipment exactly where
     * dehumidification matters most. It is also why ASHRAE publishes
     * dehumidification design conditions (dew point + mean coincident dry
     * bulb) SEPARATELY from cooling design conditions (dry bulb + mean
     * coincident wet bulb); Manual J's grains tables come from the former.
     *
     * The opposite extreme — a straight high percentile of the whole dew
     * point series — overshoots badly in dry climates (Phoenix's monsoon
     * hours produced 117 gr/lb against a published 70).
     *
     * So: restrict to warm-season hours (top 30% of temperatures), then take
     * the 75th-percentile dew point within that subset. Those two constants
     * were calibrated empirically against this app's own published-design
     * station table (climate-data.js) over a year of real hourly data:
     *
     *            method                     calibration MAE   holdout MAE
     *   old:  >=P99 temp, P50 dew              17.8 gr           16.3 gr
     *   new:  >=P70 temp, P75 dew               4.6 gr            4.7 gr
     *
     * 18 calibration cities and 18 different holdout cities, spanning
     * hot-humid, hot-dry, marine and cold. Worst single-city error dropped
     * from 44 gr/lb (Austin) to 16 (Fresno). Houston, for example, went from
     * 98 gr/lb against a published 130, to 133.
     */
    var WARM_HOUR_PERCENTILE = 0.70;   // "warm season" = top 30% of hours
    var DESIGN_DEW_PERCENTILE = 0.75;  // design moisture within those hours

    var warmCutoff = percentile(t, WARM_HOUR_PERCENTILE);
    var warmDews = [];
    for (var i = 0; i < temps.length; i++) {
      if (typeof temps[i] === "number" && temps[i] >= warmCutoff &&
          typeof dews[i] === "number" && isFinite(dews[i])) warmDews.push(dews[i]);
    }
    var elevFt = Math.round((elevM || 0) * 3.28084);
    var outGrains = warmDews.length
      ? grainsFromDewpoint(percentile(warmDews, DESIGN_DEW_PERCENTILE), elevFt)
      : null;
    // Sanity clamps — reject obviously broken data rather than mis-size equipment.
    if (heating99 < -40 || heating99 > 65 || cooling1 < 65 || cooling1 > 120) return null;
    if (outGrains == null || outGrains < 15 || outGrains > 180) outGrains = null;
    // Degree days + climate zone come from the raw (unfiltered) hourly series
    // so day boundaries stay intact — t has had its gaps compacted out.
    var dd = degreeDays(temps);
    var zone = dd ? iecczone(dd.hdd65, dd.cdd50) : null;
    return {
      heating99: heating99, cooling1: cooling1, outGrains: outGrains, elevFt: elevFt, hours: t.length,
      hdd65: dd ? dd.hdd65 : null, cdd50: dd ? dd.cdd50 : null, climateZone: zone
    };
  }

  // US Geological Survey Elevation Point Query Service: free, no key, no
  // rate limit disclosed, interpolated from 1/3 arc-second (~10m) or better
  // LiDAR-derived DEMs where available -- materially more accurate for US
  // addresses than Open-Meteo's global 90m Copernicus DEM (the elevation
  // feeding air-density correction only needs to be right to within a
  // percent or two of standard pressure ratio, but "more accurate for free"
  // is a plain win). Best-effort only: any failure, timeout, or an
  // out-of-coverage sentinel (non-US points return a large negative value)
  // means the caller keeps Open-Meteo's elevation instead.
  function fetchElevationUSGS(lat, lon, fetchImpl) {
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return Promise.resolve(null);
    var url = "https://epqs.nationalmap.gov/v1/json?x=" + lon + "&y=" + lat + "&units=Feet&wkid=4326&includeDate=false";
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
    return f(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error("usgs http " + r.status); return r.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        var ft = data && typeof data.value === "number" ? data.value : parseFloat(data && data.value);
        if (!isFinite(ft) || ft < -1000 || ft > 20000) return null;      // out-of-coverage sentinel / bad data
        return Math.round(ft);
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }

  // Fetch the last full year of hourly temperature + dew point for a location.
  // Returns a promise of analyze() output, or null on any failure (caller
  // falls back to the station table). fetchImpl is injectable for tests.
  function fetchLive(lat, lon, fetchImpl) {
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return Promise.resolve(null);
    var end = new Date(Date.now() - 6 * 86400000);                     // ERA5 lags ~5 days
    var start = new Date(end.getTime() - 365 * 86400000);
    function iso(dt) { return dt.toISOString().slice(0, 10); }
    var url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + lat +
      "&longitude=" + lon + "&start_date=" + iso(start) + "&end_date=" + iso(end) +
      "&hourly=temperature_2m,dew_point_2m&temperature_unit=fahrenheit&timezone=auto";

    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 9000) : null;

    // Kick off the USGS elevation cross-check in parallel -- it never blocks
    // or fails the climate fetch, it can only refine the elevFt it returns.
    var usgsPromise = fetchElevationUSGS(lat, lon, fetchImpl);

    return f(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error("climate http " + r.status); return r.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        if (!data || !data.hourly) return null;
        var result = analyze(data.hourly.temperature_2m || [], data.hourly.dew_point_2m || [], data.elevation || 0);
        if (!result) return result;
        return usgsPromise.then(function (usgsFt) {
          if (usgsFt != null) result.elevFt = usgsFt;
          return result;
        });
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }

  var api = {
    percentile: percentile, median: median, grainsFromDewpoint: grainsFromDewpoint, analyze: analyze,
    degreeDays: degreeDays, iecczone: iecczone,
    fetchElevationUSGS: fetchElevationUSGS, fetchLive: fetchLive
  };
  root.ClimateEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
