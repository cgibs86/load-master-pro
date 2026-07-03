/*
 * LoadMaster Pro — TrueClimate engine.
 *
 * Computes site-specific HVAC design conditions by analyzing a full year of
 * historical hourly weather (~8,760 hours) for the exact coordinates, via the
 * free Open-Meteo archive API (no key, CORS-enabled):
 *   heating99 = 1st-percentile hourly temperature  (99% winter design dry bulb)
 *   cooling1  = 99th-percentile hourly temperature (1% summer design dry bulb)
 *   outGrains = humidity ratio (grains/lb) from the median dew point during
 *               the hottest 1% of hours, at site barometric pressure
 *   elevFt    = site elevation (drives air-density correction)
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
    // Coincident humidity: median dew point over the hottest 1% of hours.
    var cutoff = percentile(t, 0.99);
    var hotDews = [];
    for (var i = 0; i < temps.length; i++) {
      if (typeof temps[i] === "number" && temps[i] >= cutoff &&
          typeof dews[i] === "number" && isFinite(dews[i])) hotDews.push(dews[i]);
    }
    var elevFt = Math.round((elevM || 0) * 3.28084);
    var outGrains = hotDews.length ? grainsFromDewpoint(median(hotDews), elevFt) : null;
    // Sanity clamps — reject obviously broken data rather than mis-size equipment.
    if (heating99 < -40 || heating99 > 65 || cooling1 < 65 || cooling1 > 120) return null;
    if (outGrains == null || outGrains < 15 || outGrains > 180) outGrains = null;
    return { heating99: heating99, cooling1: cooling1, outGrains: outGrains, elevFt: elevFt, hours: t.length };
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

    return f(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error("climate http " + r.status); return r.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        if (!data || !data.hourly) return null;
        return analyze(data.hourly.temperature_2m || [], data.hourly.dew_point_2m || [], data.elevation || 0);
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }

  var api = { percentile: percentile, median: median, grainsFromDewpoint: grainsFromDewpoint, analyze: analyze, fetchLive: fetchLive };
  root.ClimateEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
