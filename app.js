/* LoadMaster Pro AI — app controller */
(function () {
  "use strict";

  var SETTINGS_KEY = "lmp_settings_v1";
  var $ = function (sel) { return document.querySelector(sel); };

  // Current working state for the active calculation.
  var state = {
    geo: null,        // { lat, lon, label, city, state, postcode }
    climate: null,    // design conditions (live or station)
    property: null,   // { area, bedrooms, yearBuilt, source }
    overrides: {},    // user manual overrides
    photos: [],       // site photos for the report/permit package (this session)
    photoAI: null,    // AI photo analysis: { summary, findings, applied, before, after }
    photoBusy: false, // analysis request in flight
    // What kind of job this is. Set before the calculation, remembered across
    // jobs, and the strongest single input to the incentive search.
    jobType: null,
    jobCustom: "",
    // Incentive research is session-only, never stored with the job: a saved
    // quote reopened months later must not re-state a rebate that has closed.
    rebates: null,
    rebateBusy: false,
    rebateError: null,
    result: null
  };

  // ---------- Settings (stored on-device only) ----------
  // One-time migration: the AI key used to be Anthropic-only (s.anthropicApiKey).
  // Fold it into the new provider-agnostic shape so nobody's saved key vanishes.
  function migrateAiSettings(s) {
    if (s.anthropicApiKey && !s.aiApiKey) {
      s.aiProvider = "anthropic";
      s.aiApiKey = s.anthropicApiKey;
      delete s.anthropicApiKey;
    }
    return s;
  }
  function loadSettings() {
    try {
      var raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      var hadOldKey = !!raw.anthropicApiKey;
      var s = migrateAiSettings(raw);
      if (hadOldKey) saveSettings(s); // persist the migration immediately, not just in-memory
      return s;
    } catch (e) { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  // ---------- Geocoding (OpenStreetMap Nominatim — CORS-friendly, no key) ----------
  function geocodeHttpErrorMessage(status) {
    if (status === 429 || status === 503) return "Address lookup is busy — please try again in a moment.";
    return "Address lookup failed — please try again.";
  }
  function geocode(address) {
    var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=us&q=" +
              encodeURIComponent(address);
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error(geocodeHttpErrorMessage(r.status)); return r.json(); })
      .then(function (data) {
        if (!data || !data.length) throw new Error("We couldn't find that address. Try adding the city and state.");
        var m = data[0];
        var a = m.address || {};
        return {
          lat: parseFloat(m.lat),
          lon: parseFloat(m.lon),
          label: m.display_name,
          city: a.city || a.town || a.village || a.municipality || a.county || null,
          state: a.state || null,
          postcode: a.postcode || null
        };
      });
  }

  function reverseGeocode(lat, lon) {
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&countrycodes=us&lat=" + lat + "&lon=" + lon;
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("reverse geocode http " + r.status); return r.json(); })
      .then(function (m) {
        var a = (m && m.address) || {};
        return {
          lat: lat, lon: lon,
          label: (m && m.display_name) || (lat.toFixed(4) + ", " + lon.toFixed(4)),
          city: a.city || a.town || a.village || a.municipality || a.county || null,
          state: a.state || null,
          postcode: a.postcode || null
        };
      });
  }

  // ---------- Climate: nearest record by great-circle distance ----------
  function nearestClimate(lat, lon) {
    var data = window.CLIMATE_DATA || [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < data.length; i++) {
      var d = haversine(lat, lon, data[i].lat, data[i].lon);
      if (d < bestD) { bestD = d; best = data[i]; }
    }
    return best ? Object.assign({ distance: Math.round(bestD) }, best) : null;
  }
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 3958.8, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------- Property data (optional RentCast auto-fetch) ----------
  function fetchProperty(address) {
    var s = loadSettings();
    if (!s.propertyApiKey) {
      return Promise.resolve(null); // no key -> caller falls back to estimate
    }
    var url = "https://api.rentcast.io/v1/properties?address=" + encodeURIComponent(address);
    return fetch(url, { headers: { "X-Api-Key": s.propertyApiKey, "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("property http " + r.status); return r.json(); })
      .then(function (data) {
        var rec = Array.isArray(data) ? data[0] : data;
        if (!rec) return null;
        var area = rec.squareFootage || rec.squareFeet || null;
        if (!area) return null;
        return {
          area: Math.round(area),
          bedrooms: rec.bedrooms || null,
          yearBuilt: rec.yearBuilt || null,
          source: "fetched"
        };
      })
      .catch(function (e) {
        // CORS / 4xx / network — fail soft, we'll estimate instead.
        console.warn("Property lookup failed:", e.message);
        return { error: e.message };
      });
  }

  /*
   * Free-plan ceiling. Shown in place of starting a new calculation, never
   * over one already on screen — a rep mid-job keeps their result, they just
   * can't start another. Reopening a saved job stays allowed for the same
   * reason: the work is already done and paid for in allowance terms.
   */
  function blockIfFreeLimitReached() {
    if (!freeLimitReached()) return false;
    if (window.Thinking) window.Thinking.hide(true);
    setLoading(false);
    var signedIn = !!currentUser();
    var cta = signedIn
      ? '<a class="action-btn primary" href="index.html#pricing">See plans</a>'
      : '<a class="action-btn primary" href="auth.html#signup">Create an account</a><a class="action-btn" href="index.html#pricing">See plans</a>';
    $("#errorBox").innerHTML =
      '<div class="limit-card">' +
        '<div class="limit-head"><span class="ico">' + lockIcon() + '</span>You\'ve used your free load calculation</div>' +
        '<p>The Free plan covers one complete calculation so you can see the real thing on a real house. ' +
          (signedIn ? 'Pick a plan to keep going — your saved job stays where it is.' : 'Create an account to pick a plan — your saved job stays on this device.') + '</p>' +
        '<div class="limit-actions">' + cta + '</div>' +
      '</div>';
    $("#errorBox").scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  // ---------- Orchestration ----------
  /*
   * Only the newest run may finish.
   *
   * Three things can start a calculation — the Calculate button, a tap on an
   * address suggestion, and a saved job — and more than one can be in flight
   * at a time (a slow suggestion click followed by Calculate, or an impatient
   * double tap). finishRun wipes the overrides, so a straggler landing after
   * the rep had already filled in the current system or the fine-tune fields
   * silently erased their work and left the page looking finished. Every
   * starter takes a token; a result whose token is stale is dropped.
   */
  var runSeq = 0;
  function newRunToken() { return ++runSeq; }
  function isCurrentRun(token) { return token === runSeq; }

  function run(address) {
    if (blockIfFreeLimitReached()) return;
    var token = newRunToken();
    activeHistoryId = null;
    setLoading(true, "Locating address…");
    clearError();
    hideSuggest();
    geocode(address)
      .then(function (geo) {
        state.geo = geo;
        setLoading(true, "Analyzing 8,760 hrs of climate…");
        return resolveClimateAndProperty(geo, address);
      })
      .then(function (prop) { finishRun(prop, token); })
      .catch(function (err) {
        if (!isCurrentRun(token)) return;
        setLoading(false);
        showError(err.message || "Something went wrong. Please try again.");
      });
  }

  function runFromCoords(geo) {
    if (blockIfFreeLimitReached()) return;
    var token = newRunToken();
    activeHistoryId = null;
    setLoading(true, "Analyzing 8,760 hrs of climate…");
    clearError();
    state.geo = geo;
    resolveClimateAndProperty(geo, geo.label)
      .then(function (prop) { finishRun(prop, token); })
      .catch(function () { finishRun(null, token); });
  }

  // TrueClimate: live per-address design conditions (Open-Meteo year of hourly
  // data) merged over the nearest-station fallback; property lookup runs in
  // parallel. Never rejects on climate failure — the station table covers it.
  function resolveClimateAndProperty(geo, address) {
    var station = nearestClimate(geo.lat, geo.lon);
    return Promise.all([
      window.ClimateEngine.fetchLive(geo.lat, geo.lon),
      fetchProperty(address)
    ]).then(function (res) {
      var live = res[0];
      if (live) {
        state.climate = {
          city: station.city, source: "live", hours: live.hours,
          heating99: live.heating99, cooling1: live.cooling1,
          outGrains: live.outGrains != null ? live.outGrains : station.outGrains,
          elevFt: live.elevFt,
          // Degree days and the IECC zone they imply come only from the live
          // hourly series — the embedded station table carries design
          // conditions, not a year of temperatures, so the fallback path
          // leaves these null and EnvelopeIQ quietly reverts to the 3-tier
          // quality bucket rather than guessing a zone.
          hdd65: live.hdd65, cdd50: live.cdd50, climateZone: live.climateZone,
          tempBins: live.tempBins || null
        };
      } else {
        state.climate = {
          city: station.city, source: "station", hours: 0,
          heating99: station.heating99, cooling1: station.cooling1,
          outGrains: station.outGrains, elevFt: station.elevFt || 0,
          distance: station.distance
        };
      }
      return res[1];
    });
  }

  function finishRun(prop, token) {
    if (token != null && !isCurrentRun(token)) return;
    clearInputDraft();
    state.overrides = {};
    state.photos = [];
    state.photoAI = null;
    state.photoBusy = false;
    state.rebates = null;
    state.rebateBusy = false;
    state.rebateError = null;
    if (prop && !prop.error && prop.area) {
      state.property = prop;
    } else {
      state.property = {
        area: 2000, bedrooms: 3, yearBuilt: null,
        source: "estimate",
        note: prop && prop.error ? "lookup-failed" : null
      };
    }
    compute();
    noteFreeCalcUsed();
    setLoading(false);
    render();
  }

  // Input precedence: user manual override > AI photo finding (high/medium
  // confidence only, filtered in applyPhotoInsights) > property data > default.
  function compute() {
    var p = state.property, c = state.climate, o = state.overrides;
    var pa = (state.photoAI && state.photoAI.applied) || {};
    var area = o.area != null ? o.area : (pa.area != null ? pa.area : p.area);
    var bedrooms = o.bedrooms != null ? o.bedrooms : (p.bedrooms != null ? p.bedrooms : 3);
    var quality = o.quality || pa.quality || window.LoadCalc.qualityFromYear(p.yearBuilt) || "average";
    var foundation = o.foundation || pa.foundation || "slab";
    var sun = o.sun || pa.sun || "average";
    /*
     * The job type says what is being installed, so it supplies the stage
     * family and the duct assumption — but only as a default. Anything the
     * rep typed in Fine-tune inputs still wins, which is the same precedence
     * every other input in this app follows.
     */
    var jobHints = window.JobTypes ? window.JobTypes.calcHints(jobTypeId()) : {};
    var systemType = o.systemType || jobHints.systemType || "single";
    var ceiling = o.ceiling != null ? o.ceiling : (pa.ceiling != null ? pa.ceiling : 9);
    var rangePct = p.source === "fetched" ? 0.10 : 0.15;
    // Photo evidence tightens the confidence band a notch on estimated homes.
    if (p.source !== "fetched" && Object.keys(pa).length) rangePct = 0.12;
    // Optional fine-tune inputs: attic insulation, duct type/condition, return-air sizing.
    // Unset (undefined) means "use legacy/default behavior" in the calc engine.
    var atticR = o.atticR != null ? o.atticR : undefined;
    var windowU = o.windowU != null ? o.windowU : undefined;
    var windowSHGC = o.windowSHGC != null ? o.windowSHGC : undefined;
    var ach = o.ach != null ? o.ach : undefined;
    var ductType = o.ductType || jobHints.ductType || undefined;
    var ductCondition = o.ductCondition || undefined;
    var retAirMode = o.retAirMode || undefined;
    var retAirDuctIn = o.retAirDuctIn != null ? o.retAirDuctIn : undefined;
    var retAirGrilleW = o.retAirGrilleW != null ? o.retAirGrilleW : undefined;
    var retAirGrilleH = o.retAirGrilleH != null ? o.retAirGrilleH : undefined;
    // Window amount and story count: an explicit user entry beats a PhotoScan
    // AI read, which beats the calc engine's own default/heuristic. Left
    // undefined (both omitted) keeps exact legacy behavior in loadcalc.js.
    var windowFrac = o.windowFrac != null ? o.windowFrac : (pa.windowFrac != null ? pa.windowFrac : undefined);
    var stories = o.stories != null ? o.stories : (pa.stories != null ? pa.stories : undefined);
    // EnvelopeIQ: year built × IECC climate zone selects era-typical attic R,
    // window U/SHGC and air-tightness defaults in place of the flat 3-tier
    // quality bucket. It is deliberately the WEAKEST source of those numbers:
    // it feeds the engine only when nobody asserted a construction-quality
    // tier directly, because a user's dropdown pick or a PhotoScan read of the
    // actual house is real evidence about THIS home, while the table only
    // knows what code required the year it was built. Anything typed into the
    // fine-tune fields still wins over both (loadcalc.js resolves that order).
    var qualityAsserted = !!(o.qualityPicked || pa.quality);
    // A year typed into Fine-tune inputs beats the property record — it's the
    // person standing at the house correcting the data vendor.
    var yearKnown = o.yearBuilt != null ? o.yearBuilt : p.yearBuilt;
    var yearBuilt = (!qualityAsserted && yearKnown) ? yearKnown : undefined;
    var climateZone = (yearBuilt != null && c.climateZone) ? c.climateZone : undefined;
    // atticR only actually affects the engine when >= 5 (loadcalc.js's own
    // guard) — echo back the *effective* value so the UI/report never show an
    // override that had zero effect on the numbers.
    var atticREffective = (atticR != null && atticR >= 5) ? atticR : undefined;
    state.effective = {
      area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, systemType: systemType, ceiling: ceiling, rangePct: rangePct,
      atticR: atticREffective, windowU: windowU, windowSHGC: windowSHGC, ach: ach, ductType: ductType, ductCondition: ductCondition,
      retAirMode: retAirMode, retAirDuctIn: retAirDuctIn, retAirGrilleW: retAirGrilleW, retAirGrilleH: retAirGrilleH,
      windowFrac: windowFrac, stories: stories, yearBuilt: yearKnown || undefined
    };
    var opts = {
      area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, systemType: systemType, ceiling: ceiling,
      heating99: c.heating99, cooling1: c.cooling1, outGrains: c.outGrains,
      elevFt: c.elevFt || 0, rangePct: rangePct
    };
    // Only set when actually specified — an explicit value signals the calc
    // engine to use it in place of its own default/heuristic; omitted keeps
    // legacy behavior. (retAir* fields are for the separate return-air adequacy
    // check being wired up in a sibling change — not consumed by compute() —
    // so they're captured into state above but intentionally left off opts here.)
    if (atticR != null) opts.atticR = atticR;
    if (windowU != null) opts.windowU = windowU;
    if (windowSHGC != null) opts.windowSHGC = windowSHGC;
    if (ach != null) opts.ach = ach;
    if (ductType != null) opts.ductType = ductType;
    if (ductCondition != null) opts.ductCondition = ductCondition;
    if (windowFrac != null) opts.windowFrac = windowFrac;
    if (stories != null) opts.stories = stories;
    // Both or neither: envelopeFromVintage() needs the pair to resolve a row,
    // and passing one alone would just be ignored downstream.
    if (yearBuilt != null && climateZone != null) {
      opts.yearBuilt = yearBuilt;
      opts.climateZone = climateZone;
    }
    state.result = window.LoadCalc.compute(opts);
    // Return-air adequacy is validation-only (doesn't feed back into the load),
    // so it's computed once here off the just-computed result and stored on
    // state.result.returnAir — the single source both the on-screen card and
    // the printed report read from.
    state.result.returnAir = retAirMode ? window.LoadCalc.returnAirCheck({
      mode: retAirMode,
      ductDiameterIn: retAirDuctIn,
      grilleW: retAirGrilleW,
      grilleH: retAirGrilleH,
      requiredCfm: state.result.equipment.airflowCfm,
      tons: state.result.recommendedTons
    }) : null;
    computeEnergy();
    computeRooms();
  }

  // Subscription tier: 0 guest · 1 solo · 2 trial/pro · 3 fleet.
  // PermitIQ + site photos unlock at tier 2 (free trial included, so
  // prospects experience the flagship feature before paying).
  var TRIAL_DAYS = 14;
  // A "trial" account is time-boxed: once `created` (set at signup) is more
  // than TRIAL_DAYS old, it no longer counts as an active trial. Accounts
  // signed up before this field existed in the session record (u.created
  // missing) are left alone rather than force-expired on unknown data.
  function trialDaysLeft(u) {
    if (!u || u.plan !== "trial" || !u.created) return null;
    var elapsedDays = (Date.now() - u.created) / 86400000;
    return Math.ceil(TRIAL_DAYS - elapsedDays);
  }
  function trialExpired(u) {
    var left = trialDaysLeft(u);
    return left != null && left <= 0;
  }
  function planTier() {
    var u = currentUser();
    if (!u) return 0;
    // An expired trial lands on the Free plan, not a paid one. Falling back to
    // a paid tier would hand every lapsed trial unlimited calculations for
    // good, which is exactly what the Free plan's single calculation exists
    // to prevent.
    var plan = trialExpired(u) ? "free" : u.plan;
    var known = { free: 0, solo: 1, trial: 2, pro: 2, fleet: 3 }[plan];
    // Fail closed (guest-level access) on an unrecognized/missing plan value
    // rather than silently granting Pro-equivalent feature access.
    return known != null ? known : 0;
  }

  /*
   * Free-plan allowance.
   *
   * The Free plan is one complete load calculation, then an upgrade prompt.
   * Guests who never signed up sit under the same ceiling — otherwise the
   * Free plan would be strictly worse than not having an account, and nobody
   * would ever create one.
   *
   * The counter is per-device localStorage, like everything else in this
   * build. That is honest about what it is: a product boundary, not a
   * security control. Server-enforced entitlements arrive with the Supabase
   * work sketched in SETUP.md, and this is the shape that will hand over to.
   */
  var FREE_CALC_LIMIT = 1;
  var CALC_COUNT_KEY = "lmp_free_calcs_v1";

  function freeCalcsUsed() {
    try { return Math.max(0, parseInt(localStorage.getItem(CALC_COUNT_KEY), 10) || 0); } catch (e) { return 0; }
  }
  function noteFreeCalcUsed() {
    if (!onFreePlan()) return;
    try { localStorage.setItem(CALC_COUNT_KEY, String(freeCalcsUsed() + 1)); } catch (e) {}
  }
  // Tier 0 is a guest or a Free/expired-trial account; every paid plan is 1+.
  function onFreePlan() { return planTier() < 1; }
  function freeCalcsLeft() { return Math.max(0, FREE_CALC_LIMIT - freeCalcsUsed()); }
  function freeLimitReached() { return onFreePlan() && freeCalcsLeft() <= 0; }

  // ---------- Rendering ----------
  function fmt(n) { return n.toLocaleString("en-US"); }

  function render() {
    var r = state.result, c = state.climate, p = state.property, e = state.effective;
    var qualityLabel = { good: "Well insulated", average: "Average construction", poor: "Older / leaky" }[e.quality];

    var propChip = p.source === "fetched"
      ? '<div class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Auto-fetched&nbsp;<b>' + fmt(e.area) + ' ft²</b></div>'
      : '<div class="chip warn tap" id="adjustChip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Estimated&nbsp;<b>' + fmt(e.area) + ' ft²</b> · tap to adjust</div>';

    var climateChip = c.source === "live"
      ? '<div class="chip live"><span class="pulse"></span>TrueClimate&nbsp;·&nbsp;<b>' + fmt(c.hours) + ' hrs</b> analyzed here</div>'
      : '<div class="chip' + ((c.distance || 0) > 75 ? ' warn' : '') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><b>' + escapeHtml(c.city) + '</b> station data' + (c.distance ? ' · ' + fmt(c.distance) + ' mi away' : '') + '</div>';
    var elevChip = (c.elevFt || 0) > 1500
      ? '<div class="chip">⛰ ' + fmt(c.elevFt) + ' ft&nbsp;·&nbsp;air ×' + r.inputs.acf + '</div>' : '';

    var html =
      '<div class="chips">' +
        climateChip +
        '<div class="chip">❄ ' + c.cooling1 + '°F design&nbsp;·&nbsp;🔥 ' + c.heating99 + '°F</div>' +
        elevChip +
        propChip +
      '</div>' +
      '<div class="address-line">' + escapeHtml(shortAddr(state.geo.label)) + '</div>' +

      '<div class="load-grid">' +
        loadCard("heat", "Heating", r.heating, "Design low", c.heating99 + "°F", heatIcon()) +
        loadCard("cool", "Cooling", r.cooling, "A/C size", r.recommendedTons + " tons", coolIcon()) +
      '</div>' +

      '<div class="equip-card">' +
        '<div class="badge">' + r.recommendedTons + '<small>TON A/C</small></div>' +
        '<div class="equip-text"><b>Equipment plan</b>' +
          '<div class="equip-rows">' +
            equipRow("Cooling", r.recommendedTons + "-ton " + systemTypeLabel(e.systemType) + " (" + r.equipment.oversizePct + "% of load)") +
            equipRow("Heating", fmt(r.equipment.furnaceOutput) + " BTU/h output furnace, or heat pump + backup") +
            equipRow("Airflow", "≈ " + fmt(r.equipment.airflowCfm) + " CFM") +
            equipRow("Density", fmt(r.sqftPerTon) + " ft²/ton") +
          '</div>' +
          '<div class="eq-alts">By system type: single-stage <b>' + r.sizing.single + 't</b> · two-stage <b>' + r.sizing.two + 't</b> · variable-capacity <b>' + r.sizing.variable + 't</b><span class="eq-alt-note">Variable systems modulate down to ~30–40%, so a nominal size above the load still runs efficiently. Fixed-capacity selection targets ACCA Manual S limits (90–115%) using the nearest half-ton step; for very small loads the closest available step can fall outside that band, which Manual S also allows.</span></div>' +
          '<p>' + r.equipment.suggestion + '</p>' +
          '<p class="eq-oversize-note">Larger than this? That\'s common: published Manual J case studies and real contractor-quote comparisons repeatedly show field-installed equipment sized 20–75% above the calculated load, usually from rule-of-thumb sizing (e.g. a flat 400–600 ft²/ton) rather than a load calc. The smaller, calculated number is typically the more accurate one — oversized equipment short-cycles, dehumidifies worse, and costs more up front and to run.</p>' +
          '</div>' +
      '</div>' +

      jobTypeCard() +
      hpCard(r, c) +
      envelopeCard(r) +
      photosCard() +
      photoInsightsCard() +
      permitCard() +
      rebateCard() +

      '<div class="actions">' +
        '<button class="action-btn primary" id="reportBtn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3a1 1 0 0 1 1-1h7l4 4v3"/><path d="M6 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/><rect x="6" y="13" width="12" height="8" rx="1"/></svg>Generate report</button>' +
        '<button class="action-btn" id="shareBtn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>Share</button>' +
      '</div>' +

      detailsBlock(r, c, e, qualityLabel) +
      adjustBlock(e, p) +

      finalRecommendationCard(r, e, c) +
      exportCard() +
      roomCard() +
      energyCard();

    var el = $("#results");
    el.innerHTML = html;
    el.classList.remove("hidden");
    $("#introNote").classList.add("hidden");
    updateFreeNote();
    document.body.classList.add("has-results");

    animateCounts();
    wireAdjust();
    restoreInputDraft();
    var ac = $("#adjustChip");
    if (ac) ac.addEventListener("click", function () { var d = $("#adjustDetails"); if (d) { d.open = true; draftPanelOpen = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); } });
    $("#reportBtn").addEventListener("click", function () { thinkThen("Building your report…", function () { generateReport({}); }); });
    $("#shareBtn").addEventListener("click", shareResult);
    wirePhotos();
    wirePermit();
    wireFinalRec();
    wireEnergy();
    wireRooms();
    wireExport();
    var jobChange = $("#jobChangeBtn");
    if (jobChange) jobChange.addEventListener("click", openJobSheet);
    wireRebates();

    saveActiveToHistory();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function loadCard(kind, title, load, subLabel, subValue, icon) {
    return '' +
      '<div class="load-card ' + kind + '"><div class="glow"></div>' +
        '<div class="load-head"><span class="ico">' + icon + '</span>' + title + '</div>' +
        '<div class="load-btu"><span class="count" data-to="' + load.total + '">0</span><small>BTU/h</small></div>' +
        '<div class="load-sub">' + fmt(load.range.low) + ' – ' + fmt(load.range.high) + ' expected</div>' +
        '<div class="load-tons"><span>' + subLabel + '</span><b>' + subValue + '</b></div>' +
      '</div>';
  }

  function equipRow(k, v) { return '<div class="eq-row"><span>' + k + '</span><b>' + v + '</b></div>'; }
  function systemTypeLabel(t) { return { single: "single-stage A/C or HP", two: "two-stage A/C or HP", variable: "variable-capacity system" }[t] || "system"; }

  // ---------- Site photos (Pro feature: attach to report / permit package,
  // and optionally feed the AI photo analysis) ----------
  function photosCard() {
    if (planTier() < 2) return ""; // upsell handled by the PermitIQ card below
    var thumbs = state.photos.map(function (p, i) {
      return '<div class="photo-th"><img src="' + p.src + '" alt="site photo ' + (i + 1) + '"/><button class="photo-x" data-x="' + i + '" aria-label="Remove">×</button></div>';
    }).join("");
    var aiBlock = "";
    if (state.photos.length) {
      aiBlock = state.photoBusy
        ? '<button class="action-btn primary ai-btn" disabled><span class="spin"></span>Reading photos…</button>'
        : '<button class="action-btn primary ai-btn" id="aiAnalyzeBtn">' + sparkIcon() + (state.photoAI ? 'Re-analyze photos with AI' : 'Analyze photos with AI') + '</button>' +
          '<p class="ai-note">Optional. AI reads sun exposure, windows, insulation and size from your shots and tunes the load numbers — and if you snap the old unit\'s data plate, it pre-fills the current-system fields in EnergyIQ. Uses your AI provider key (Settings).</p>';
    }
    return '' +
      '<div class="photos-card">' +
        '<div class="hp-head"><span class="ico">' + cameraIcon() + '</span>Site photos<span class="ph-count">' + state.photos.length + '/6</span></div>' +
        '<p class="hp-text">Snap the home\'s outside (each side you can reach — shows sun, shade, windows, siding) and inside (main rooms, ceilings, attic or crawl space if accessible). Photos attach to the report and permit package — and AI can read them to make the load numbers more accurate. Totally optional: skip photos and the estimate still works.</p>' +
        '<div class="photo-grid">' + thumbs +
          (state.photos.length < 6 ? '<label class="photo-add" for="photoIn">+<span>Add</span></label>' : '') +
        '</div>' +
        '<input type="file" id="photoIn" accept="image/*" capture="environment" multiple hidden />' +
        aiBlock +
      '</div>';
  }
  function wirePhotos() {
    var inp = $("#photoIn");
    if (inp) inp.addEventListener("change", function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []).slice(0, 6 - state.photos.length);
      if (!files.length) return;
      var pending = files.length;
      files.forEach(function (f) {
        var reader = new FileReader();
        reader.onload = function () {
          downscaleImage(reader.result, 1100, function (dataUrl) {
            state.photos.push({ src: dataUrl });
            if (--pending === 0) render();
          }, "image/jpeg");
        };
        reader.onerror = function () { if (--pending === 0) render(); };
        reader.readAsDataURL(f);
      });
    });
    document.querySelectorAll(".photo-x").forEach(function (b) {
      b.addEventListener("click", function () {
        state.photos.splice(parseInt(b.getAttribute("data-x"), 10), 1);
        render();
      });
    });
    var ai = $("#aiAnalyzeBtn");
    if (ai) ai.addEventListener("click", runPhotoAnalysis);
    var clearAi = $("#aiClearBtn");
    if (clearAi) clearAi.addEventListener("click", function () {
      state.photoAI = null;
      compute();
      render();
      toast("Photo adjustments removed");
    });
  }

  // ---------- AI photo analysis (PhotoScan) ----------
  var PHOTO_FIELD_LABELS = {
    sun: "Sun exposure",
    quality: "Construction / insulation",
    foundation: "Foundation",
    ceiling: "Ceiling height",
    existingTons: "Existing unit size",
    existingYear: "Existing unit year",
    existingSeer: "Existing unit SEER",
    existingHeat: "Existing heating type",
    windowFrac: "Window amount",
    area: "Conditioned area",
    stories: "Stories",
    other: "Observation"
  };
  function photoFindingValue(f) {
    if (f.value == null) return "";
    switch (f.field) {
      case "sun": return { low: "Shaded", average: "Average", high: "Sunny" }[f.value] || String(f.value);
      case "quality": return { good: "Well insulated", average: "Average", poor: "Older / leaky" }[f.value] || String(f.value);
      case "foundation": return { slab: "Slab", crawl: "Crawl space", basement: "Basement" }[f.value] || String(f.value);
      case "ceiling": return f.value + " ft";
      case "windowFrac": return Math.round(f.value * 100) + "% of floor area";
      case "area": return fmt(f.value) + " ft²";
      case "stories": return f.value + (f.value === 1 ? " story" : " stories");
      case "existingTons": return f.value + " ton";
      case "existingYear": return String(f.value);
      case "existingSeer": return f.value + " SEER";
      case "existingHeat": return EXISTING_HEAT_LABEL[f.value] || String(f.value);
      default: return String(f.value);
    }
  }

  function runPhotoAnalysis() {
    var s = loadSettings();
    if (!s.aiApiKey) {
      toast("Add an AI provider API key in Settings to enable photo analysis");
      openSettings();
      return;
    }
    if (!state.photos.length || state.photoBusy) return;
    state.photoBusy = true;
    render();
    var e = state.effective, p = state.property, c = state.climate, g = state.geo;
    var ctx = {
      address: shortAddr(g.label),
      climateCity: c.city,
      area: e.area,
      areaSource: p.source,
      quality: e.quality,
      sun: e.sun,
      foundation: e.foundation,
      ceiling: e.ceiling,
      bedrooms: e.bedrooms,
      yearBuilt: p.yearBuilt
    };
    var photoWork = window.PhotoAI.analyze(state.photos.map(function (ph) { return ph.src; }), ctx, s);
    if (window.Thinking) {
      photoWork = window.Thinking.during([
        "Uploading " + state.photos.length + " photo" + (state.photos.length === 1 ? "" : "s") + "…",
        "Reading the building…",
        "Checking windows, insulation and exposure…",
        "Refining the load…"
      ], photoWork, 1600);
    }
    photoWork
      .then(applyPhotoInsights)
      .catch(function (err) {
        state.photoBusy = false;
        render();
        toast("Photo analysis failed: " + (err.message || "unknown error"));
      });
  }

  // Fold the AI findings into the calculation. Only high/medium-confidence
  // findings are applied; user overrides always win; a photo-guessed square
  // footage never replaces real property-record data.
  function applyPhotoInsights(res) {
    var before = {
      heating: state.result.heating.total,
      cooling: state.result.cooling.total,
      tons: state.result.recommendedTons
    };
    var applied = {};
    var o = state.overrides, p = state.property;
    // If the model returns more than one finding for the same field, only the
    // highest-confidence one (last one wins on a tie) should actually apply —
    // otherwise every duplicate would show status "applied" while only the
    // last one processed actually reaches compute().
    var winners = {};
    res.findings.forEach(function (f) {
      if (!f || f.field === "other" || f.confidence === "low" || f.value == null) return;
      var w = winners[f.field];
      if (!w || w.confidence !== "high" || f.confidence === "high") winners[f.field] = f;
    });
    // Data-plate reads (existingTons/Year/Seer/Heat) don't touch the load —
    // they pre-fill EnergyIQ's "customer's current system", where a value the
    // rep already typed wins the same way a manual override wins below.
    var EXISTING_FIELD_KEY = { existingTons: "tons", existingYear: "year", existingSeer: "seer", existingHeat: "heatType" };
    var ex = energyState().existing;
    var exTouched = ex.tons != null || ex.year != null || ex.seer != null;
    res.findings.forEach(function (f) {
      f.status = "info";
      if (f.field === "other") return; // informational only
      if (f.confidence === "low" || f.value == null) { f.status = "low"; return; }
      if (EXISTING_FIELD_KEY[f.field]) {
        var key = EXISTING_FIELD_KEY[f.field];
        // heatType always has a default, so treat it as "entered" only once the rep has described the unit at all
        var already = key === "heatType" ? exTouched : ex[key] != null;
        if (already) { f.status = "kept"; return; }
        if (winners[f.field] !== f) { f.status = "duplicate"; return; }
        ex[key] = f.value;
        applied[f.field] = f.value;
        f.status = "applied";
        return;
      }
      var overridden = (f.field === "area" || f.field === "ceiling") ? o[f.field] != null : !!o[f.field];
      if (overridden) { f.status = "kept"; return; }               // user's manual setting wins
      if (f.field === "area" && p.source === "fetched") { f.status = "kept"; f.keptWhy = "property records"; return; }
      if (winners[f.field] !== f) { f.status = "duplicate"; return; } // superseded by another finding for the same field
      applied[f.field] = f.value;
      f.status = "applied";
    });
    state.photoAI = { summary: res.summary, findings: res.findings, applied: applied, before: before };
    state.photoBusy = false;
    compute();
    state.photoAI.after = {
      heating: state.result.heating.total,
      cooling: state.result.cooling.total,
      tons: state.result.recommendedTons
    };
    render();
    var n = Object.keys(applied).length;
    toast(n ? "Photos analyzed — " + n + " adjustment" + (n > 1 ? "s" : "") + " applied" : "Photos analyzed — inputs already match what the photos show");
  }

  function photoInsightsCard() {
    var pa = state.photoAI;
    if (!pa) return "";
    var rows = pa.findings.map(function (f) {
      var badge = {
        applied: '<span class="ai-badge on">applied</span>',
        kept: '<span class="ai-badge kept">kept ' + (f.keptWhy || "your setting") + '</span>',
        low: '<span class="ai-badge low">low confidence — not applied</span>',
        duplicate: '<span class="ai-badge low">duplicate — not applied</span>',
        info: '<span class="ai-badge">noted</span>'
      }[f.status];
      var val = photoFindingValue(f);
      return '<div class="ai-row">' +
          '<div class="ai-row-top"><span>' + (PHOTO_FIELD_LABELS[f.field] || f.field) + (val ? ':&nbsp;<b>' + escapeHtml(val) + '</b>' : '') + '</span>' + badge + '</div>' +
          (f.note ? '<div class="ai-row-note">' + escapeHtml(f.note) + '</div>' : '') +
        '</div>';
    }).join("");
    var delta = "";
    if (pa.after) {
      var dc = pa.after.cooling - pa.before.cooling;
      var dh = pa.after.heating - pa.before.heating;
      delta = (dc === 0 && dh === 0)
        ? '<div class="ai-delta">Load totals unchanged — the photos confirmed the existing assumptions.</div>'
        : '<div class="ai-delta">Adjusted result: cooling <b>' + (dc > 0 ? "+" : "") + fmt(dc) + '</b> BTU/h, heating <b>' + (dh > 0 ? "+" : "") + fmt(dh) + '</b> BTU/h' +
          (pa.after.tons !== pa.before.tons ? ' · A/C size ' + pa.before.tons + 't → <b>' + pa.after.tons + 't</b>' : '') + '</div>';
    }
    return '' +
      '<div class="ai-card">' +
        '<div class="hp-head"><span class="ico ai">' + sparkIcon() + '</span>What the photos told us<span class="ai-model">AI · vision</span></div>' +
        '<p class="hp-text">' + escapeHtml(pa.summary) + '</p>' +
        '<div class="ai-rows">' + rows + '</div>' +
        delta +
        '<button class="ai-clear" id="aiClearBtn">Remove photo adjustments</button>' +
        '<p class="pq-disc">AI reads visible evidence only and can misjudge — findings marked “applied” changed the inputs above; your manual fine-tune settings always take priority. Verify on site.</p>' +
      '</div>';
  }
  function sparkIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6z"/><path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z"/></svg>'; }
  function cameraIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'; }
  function shieldIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>'; }
  function lockIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'; }

  // ---------- PermitIQ (Pro/Fleet + trial) ----------
  function permitCard() {
    var g = state.geo || {};
    var cityLabel = g.city ? escapeHtml(g.city) : "this city";
    if (planTier() < 2) {
      var cta = planTier() === 0
        ? '<a class="permit-cta" href="auth.html#signup">Start free trial — unlock PermitIQ</a>'
        : '<a class="permit-cta" href="index.html#pricing">Upgrade to Pro — unlock PermitIQ</a>';
      return '' +
        '<div class="permit-card locked">' +
          '<div class="hp-head"><span class="ico gold">' + lockIcon() + '</span>PermitIQ™ — permit requirements<span class="permit-badge">PRO</span></div>' +
          '<p class="hp-text">See ' + cityLabel + '\'s efficiency minimums (SEER2/HSPF2), setback and clearance rules, electrical &amp; condensate requirements, and a submission-ready permit package with your photos attached — before you quote.</p>' +
          '<div class="permit-teaser"><div class="tz-row"></div><div class="tz-row w70"></div><div class="tz-row w85"></div><div class="tz-row w60"></div></div>' +
          cta +
        '</div>';
    }
    var pd = window.PermitData;
    var code = pd.stateCode(g.state);
    var eff = pd.efficiency(code || "");
    var effRows = eff.rows.map(function (rr) { return '<div class="eq-row"><span>' + rr.k + '</span><b>' + rr.v + '</b></div>'; }).join("");
    var groups = {};
    pd.CHECKLIST.forEach(function (item) { (groups[item.cat] = groups[item.cat] || []).push(item); });
    var checks = Object.keys(groups).map(function (cat) {
      return '<div class="pq-cat">' + cat + '</div>' + groups[cat].map(function (item) {
        return '<div class="pq-item">' + (item.verify ? '<span class="pq-verify">verify locally</span>' : '') + item.text + '</div>';
      }).join("");
    }).join("");
    return '' +
      '<div class="permit-card">' +
        '<div class="hp-head"><span class="ico gold">' + shieldIcon() + '</span>PermitIQ™ — ' + cityLabel + '<span class="permit-badge on">PRO</span></div>' +
        (!code ? '<p class="pq-note">⚠ Couldn\'t resolve this address\'s state, so the efficiency floor below is unconfirmed — it defaults to the ' + eff.regionLabel + ' minimums, which may not apply here. Confirm the correct DOE region locally.</p>' : '') +
        '<p class="hp-text">Requirements compiled for <b>' + (code || "this state") + '</b> (' + eff.regionLabel + ') from federal standards and the model codes most cities adopt. Items tagged <i>verify locally</i> are set by city amendment — confirm before install.</p>' +
        '<div class="pq-sec">Minimum equipment efficiency (federal floor)</div>' +
        '<div class="equip-rows">' + effRows + '</div>' +
        (eff.note ? '<div class="pq-note">' + eff.note + '</div>' : '') +
        '<details class="pq-details"><summary>Installation &amp; code checklist<svg class="caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></summary><div class="pq-body">' + checks + '</div></details>' +
        '<details class="pq-details"><summary>Permit application — what to submit<svg class="caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></summary><div class="pq-body">' +
          pd.SUBMITTAL.map(function (s) { return '<div class="pq-item ok">' + s + '</div>'; }).join("") + '</div></details>' +
        '<div class="permit-actions">' +
          '<a class="action-btn" target="_blank" rel="noopener" href="' + pd.permitOfficeUrl(g.city, g.state) + '">' + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>Find ' + cityLabel + '\'s permit office</a>' +
          '<button class="action-btn primary" id="permitPkgBtn">' + shieldIcon() + 'Permit package (PDF)</button>' +
          '<button class="action-btn" id="permitMailBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>Email to permit dept.</button>' +
        '</div>' +
        '<p class="pq-disc">PermitIQ compiles federal minimums and model-code provisions; local amendments control. Always confirm with the authority having jurisdiction before contract or install. Load figures are estimates — final permit submittals may require a full ACCA Manual&nbsp;J/S/D by a licensed professional.</p>' +
      '</div>';
  }
  function wirePermit() {
    var pkg = $("#permitPkgBtn");
    if (pkg) pkg.addEventListener("click", function () { thinkThen("Assembling the permit package…", function () { generateReport({ permit: true }); }); });
    var mail = $("#permitMailBtn");
    if (mail) mail.addEventListener("click", emailPermitDept);
  }
  function emailPermitDept() {
    var g = state.geo, r = state.result, e = state.effective;
    var s = loadSettings();
    var subject = "Residential mechanical permit application — " + shortAddr(g.label);
    var body =
      "To the Building / Permit Department" + (g.city ? " of " + g.city : "") + ",%0D%0A%0D%0A" +
      "We are applying for a residential mechanical permit (HVAC change-out / installation) at:%0D%0A" +
      encodeURIComponent(shortAddr(g.label)) + "%0D%0A%0D%0A" +
      "Proposed equipment: " + r.recommendedTons + "-ton cooling (" + fmt(r.equipment.acBtu) + " BTU/h), heating " + fmt(r.equipment.furnaceOutput) + " BTU/h output.%0D%0A" +
      "Calculated design loads: heating " + fmt(r.heating.total) + " BTU/h, cooling " + fmt(r.cooling.total) + " BTU/h (Manual J-style block load, " + fmt(e.area) + " sq ft).%0D%0A%0D%0A" +
      "The load calculation report and site photos are attached as PDF (generated by LoadMaster Pro AI).%0D%0A" +
      "Please advise on fees, forms, and inspection scheduling.%0D%0A%0D%0A" +
      "Thank you,%0D%0A" + encodeURIComponent((s.company || "") + (s.license ? " · License " + s.license : "") + (s.phone ? " · " + s.phone : ""));
    location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + body;
    toast("Draft opened — add the permit dept.'s email and attach the saved PDF before sending");
  }

  // Heat-pump balance point card with a mini load-vs-capacity chart.
  function hpCard(r, c) {
    var hp = r.heatpump;
    // Both lines are linear: draw them edge-to-edge across the temp range.
    function loadAt(T) { return Math.max(0, hp.ua * (65 - T)); }
    function capAt(T) { return Math.max(0, hp.c17 + hp.k * (T - 17)); }
    var x0 = Math.min(c.heating99, hp.balanceF) - 6, x1 = 65;
    var yMax = Math.max(loadAt(x0), capAt(x1)) * 1.12 || 1;
    var W = 300, H = 110, PAD = 8;
    function X(t) { return PAD + (t - x0) / (x1 - x0) * (W - 2 * PAD); }
    function Y(v) { return H - PAD - (Math.min(v, yMax) / yMax) * (H - 2 * PAD); }
    function line(fn) { return X(x0).toFixed(1) + "," + Y(fn(x0)).toFixed(1) + " " + X(x1).toFixed(1) + "," + Y(fn(x1)).toFixed(1); }
    var bpLoad = loadAt(hp.balanceF);
    var chart =
      '<svg class="hp-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<polyline points="' + line(loadAt) + '" fill="none" stroke="#ff8a5c" stroke-width="2.5" stroke-linecap="round"/>' +
        '<polyline points="' + line(capAt) + '" fill="none" stroke="#3ad7e6" stroke-width="2.5" stroke-linecap="round"/>' +
        '<line x1="' + X(hp.balanceF).toFixed(1) + '" y1="' + Y(bpLoad).toFixed(1) + '" x2="' + X(hp.balanceF).toFixed(1) + '" y2="' + (H - 2) + '" stroke="rgba(255,255,255,0.35)" stroke-dasharray="3 4"/>' +
        '<circle cx="' + X(hp.balanceF).toFixed(1) + '" cy="' + Y(bpLoad).toFixed(1) + '" r="4.5" fill="#fff"/>' +
      '</svg>';
    var auxText = hp.auxBtu > 500
      ? 'Below <b>' + hp.balanceF + '°F</b> a ' + r.recommendedTons + '-ton heat pump needs help; plan ≈ <b>' + hp.auxKw + ' kW</b> (' + fmt(hp.auxBtu) + ' BTU/h) of backup at ' + c.heating99 + '°F.'
      : 'A ' + r.recommendedTons + '-ton heat pump carries this home alone all the way to the ' + c.heating99 + '°F design low. No backup required.';
    return '' +
      '<div class="hp-card">' +
        '<div class="hp-head"><span class="ico">' + hpIcon() + '</span>Heat pump balance point<span class="hp-bp">' + hp.balanceF + '°F</span></div>' +
        chart +
        '<div class="hp-legend"><span class="lg heat">Home load</span><span class="lg cool">Heat pump output</span></div>' +
        '<p class="hp-text">' + auxText + '</p>' +
      '</div>';
  }

  // ---------- Return air adequacy check ----------
  // Not plan-gated: validates the return side of the duct system against the
  // equipment's required airflow. Renders nothing until the user has entered
  // a return-air mode in the final recommendation section below.
  function returnAirCard(e) {
    var check = state.result && state.result.returnAir;
    if (!check) {
      // A mode is selected but the dimension field(s) were left blank/invalid
      // (returnAirCheck() returned null) — say so instead of doing nothing.
      if (e && e.retAirMode === "ducted") return '<p class="note" style="text-align:left;margin:8px 2px 0" role="alert">Enter a duct diameter to check return air.</p>';
      if (e && e.retAirMode === "grille") return '<p class="note" style="text-align:left;margin:8px 2px 0" role="alert">Enter grille width and height to check return air.</p>';
      return "";
    }
    var badge = check.ok == null ? "" : check.ok
      ? '<span class="chip ok">Adequate</span>'
      : '<span class="chip warn">Likely undersized</span>';
    return '' +
      '<div class="retair-card">' +
        '<div class="hp-head"><span class="ico">' + returnAirIcon() + '</span>Return air check<span class="ph-count">' + check.mode + '</span></div>' +
        '<p class="hp-text">' + escapeHtml(check.message) + '</p>' +
        '<div class="retair-status">' + badge + '</div>' +
        '<p class="pq-disc">' + escapeHtml(check.disclosure) + '</p>' +
      '</div>';
  }

  // Return-air input widget: mode select + duct-diameter or grille-W/H fields,
  // plus its own "Check" button. Deliberately separate from the main
  // Recalculate flow in adjustBlock() — returnAirCheck() is validation-only
  // (see loadcalc.js) and never changes the load numbers, so checking it
  // shouldn't require re-running the whole calculation.
  function returnAirInputHtml(e) {
    return '' +
      '<div class="retair-input adjust">' +
        '<label>Return duct or return grille size</label>' +
        '<select id="inRetAirMode">' +
          '<option value=""' + (!e.retAirMode ? " selected" : "") + '>Not specified</option>' +
          opt("ducted", "Ducted return (has a return trunk)", e.retAirMode) +
          opt("grille", "Direct return grille (no trunk)", e.retAirMode) +
        '</select>' +
        '<div id="retAirFields">' + retAirFieldsHtml(e.retAirMode, e) + '</div>' +
        '<button class="recalc" id="checkRetAirBtn">Check return air</button>' +
        '<p class="note" style="text-align:left;margin:8px 2px 0">Proper airflow needs about <b>144 sq in of return opening per ton</b> (a standard field rule) — too little and the system starves for air, runs inefficiently, and wears out early, no matter how correctly the equipment itself is sized.</p>' +
      '</div>';
  }

  // ---------- Final recommendation (bottom of the results page) ----------
  // The headline answer, in one place, sized for whatever equipment the
  // homeowner ends up installing: fixed-capacity systems (single/two-stage)
  // are sized differently than a heat pump's backup-heat tradeoff, and a
  // variable-capacity system can legitimately come in smaller since it
  // modulates instead of needing Manual S's fixed-capacity oversize cushion.
  function finalRecommendationCard(r, e, c) {
    var hp = r.heatpump;
    var hpNote = hp.auxBtu > 500
      ? 'covers this home down to about <b>' + hp.balanceF + '°F</b>; below that, plan on ≈<b>' + hp.auxKw + ' kW</b> (' + fmt(hp.auxBtu) + ' BTU/h) of backup heat at the ' + c.heating99 + '°F design low.'
      : 'covers this home alone all the way to the ' + c.heating99 + '°F design low — no backup heat needed.';
    /*
     * The four rows below are four different right answers, and which one is
     * THE answer depends entirely on what is being installed. Now that the job
     * type is known, say so: mark the matching row and lead the sentence with
     * it, instead of handing the rep a table and leaving the choice to them.
     */
    var job = jobType();
    // Exactly one row is the answer, and it is the most specific one: a
    // variable-capacity heat pump belongs on the variable row, not on both it
    // and the generic heat-pump row — two marks make the rep choose again.
    var jobRow = job ? (job.systemType || (job.fuel === "heat-pump" || job.fuel === "geothermal" ? "hp" : null)) : null;
    function recRow(key, label, tons, extraCls) {
      var mine = jobRow === key;
      return '<div class="final-rec-row' + (extraCls ? " " + extraCls : "") + (mine ? " picked" : "") + '">' +
        '<span>' + label + (mine ? '<em class="rec-this">this job</em>' : "") + '</span>' +
        '<b>' + tons + ' tons' + (key === "hp" ? "*" : "") + '</b></div>';
    }
    var leadIn = job && job.needsLoad === false
      ? 'for this home\'s ' + fmt(r.cooling.total) + ' BTU/h design cooling load. ' +
        'This job installs no equipment, so the sizes below are the yardstick for whatever is already in the house:'
      : jobRow
        ? 'for this home\'s ' + fmt(r.cooling.total) + ' BTU/h design cooling load, sized for the ' +
          escapeHtml(job.label) + ' being quoted. The other families are listed so a change of plan does not need a new calculation:'
        : 'for this home\'s ' + fmt(r.cooling.total) + ' BTU/h design cooling load. The right number below depends on which kind of system actually goes in the house:';
    return '' +
      '<div class="final-rec">' +
        '<div class="final-rec-head">LoadMaster Pro AI recommends a</div>' +
        '<div class="final-rec-tons">' + r.recommendedTons + '<span>-ton system</span></div>' +
        '<p class="final-rec-sub">' + leadIn + '</p>' +
        '<div class="final-rec-grid">' +
          recRow("single", "Single-stage A/C or gas furnace split system", r.sizing.single) +
          recRow("two", "Two-stage system", r.sizing.two) +
          recRow("variable", "Variable-capacity (inverter) system", r.sizing.variable) +
          recRow("hp", "Heat pump (any stage)", r.recommendedTons, "hp") +
        '</div>' +
        manualSFitNote(r) +
        shrNote(r) +
        '<p class="final-rec-foot">Variable-capacity systems modulate continuously, and their maximum output typically exceeds their nominal rating, so they don\'t need the fixed-capacity oversize cushion — they\'re selected to the nearest half-ton step, which is often a half-ton smaller than single/two-stage equipment for the same load and never larger. Every size above stays at or above Manual S\'s 90%-of-load floor. *A heat pump uses the same cooling-capacity sizing rule as an A/C — size it for the stage type above, then check the heating side: this ' + r.recommendedTons + '-ton heat pump ' + hpNote + '</p>' +
        returnAirInputHtml(e) +
        returnAirCard(e) +
      '</div>';
  }

  /*
   * EnvelopeIQ — where the four envelope numbers that most move the answer
   * actually came from. Each is tagged "entered" (a real number from the
   * fine-tune fields), "vintage" (the year-built × climate-zone code table),
   * or "tier" (the fallback construction-quality bucket). Surfacing this is
   * the point of the feature: a contractor who can see that R-38 was assumed
   * from a 2009 build year, not measured, knows exactly which assumption to
   * go check in the attic.
   */
  function envelopeIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10l9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></svg>'; }

  var ENV_SRC_LABEL = { entered: "you entered", vintage: "code-era typical", tier: "tier default" };

  function envelopeCard(r) {
    var env = r.envelope;
    if (!env) return "";
    function row(label, value, src, hint) {
      return '<div class="env-row">' +
        '<span class="env-label">' + label + '</span>' +
        '<b class="env-val">' + value + '</b>' +
        '<span class="env-src ' + src + '">' + ENV_SRC_LABEL[src] + '</span>' +
        (hint ? '<span class="env-hint">' + hint + '</span>' : '') +
        '</div>';
    }
    // Three distinct reasons the table can be idle, and they call for three
    // different things from the user — so say which one this is rather than
    // showing one vague "using the tier" line for all of them.
    var e = state.effective || {};
    var head, sub;
    if (env.basis === "vintage-zone") {
      head = 'Built ' + env.yearBuilt + ' &middot; IECC climate zone ' + env.zone;
      sub = 'Defaults come from what ' + escapeHtml(env.eraLabel) + ' required in zone ' + env.zone + ', not from a generic average.';
    } else if (e.yearBuilt && !state.climate.climateZone) {
      head = 'Built ' + e.yearBuilt + ' &middot; no climate zone available';
      sub = 'The climate zone comes from a year of on-site hourly weather; this run fell back to the nearest station table, so the construction tier sets the envelope instead.';
    } else if (e.yearBuilt) {
      head = 'Built ' + e.yearBuilt + ' &middot; construction tier overrides';
      sub = 'You picked a construction tier, so it outranks what the ' + e.yearBuilt + ' energy code would have required. Clear the tier pick to fall back to code-era defaults for this build year.';
    } else {
      head = 'No build year — using the construction tier';
      sub = 'Add the year built under Fine-tune inputs to swap these broad tier defaults for what the energy code actually required for this home.';
    }
    var anyAssumed = ["atticR", "windowU", "windowSHGC", "ach"].some(function (k) { return env.source[k] !== "entered"; });
    return '' +
      '<div class="env-card">' +
        '<div class="env-head"><span class="ico">' + envelopeIcon() + '</span>EnvelopeIQ<span class="env-basis">' + head + '</span></div>' +
        '<p class="env-sub">' + sub + '</p>' +
        '<div class="env-grid">' +
          row("Attic insulation", "R-" + env.atticR, env.source.atticR) +
          row("Window U-factor", env.windowU.toFixed(2), env.source.windowU) +
          row("Window SHGC", env.windowSHGC.toFixed(2), env.source.windowSHGC) +
          row("Air leakage", env.ach.toFixed(2) + " ACH", env.source.ach) +
        '</div>' +
        (anyAssumed
          ? '<p class="env-foot">Anything still marked <i>' + ENV_SRC_LABEL.vintage + '</i> or <i>' + ENV_SRC_LABEL.tier + '</i> is an assumption, not a measurement. A tape measure in the attic, the NFRC sticker on a window, or a blower-door number entered under Fine-tune inputs replaces it and tightens the load.</p>'
          : '<p class="env-foot">Every envelope value here is a number you entered — this load rests on measurements, not era assumptions.</p>') +
      '</div>';
  }

  // Manual S fit: only shown when the closest available equipment size can't
  // land inside the allowed percent-of-load band, since that's the case where
  // the headline tonnage needs a caveat to be honest.
  function manualSFitNote(r) {
    var fit = r.equipment && r.equipment.manualSFit;
    if (!fit || fit.inBand) return "";
    return '<p class="fit-note">⚠ <b>Closest size, not an exact fit.</b> ' + escapeHtml(fit.message) + '</p>';
  }

  // Sensible/latent balance (Manual S SHR check) — always shown, because
  // "which coil" is as much a part of the answer as "how many tons".
  function shrNote(r) {
    var s = r.shr;
    if (!s) return "";
    var cls = s.level === "typical" ? "shr-note" : "shr-note flag";
    var head = { "high-latent": "Moisture-heavy load", "high-sensible": "Dry, sensible-heavy load", typical: "Balanced load" }[s.level] || "Load balance";
    return '<p class="' + cls + '"><b>' + head + ' — ' + s.sensiblePct + '% sensible / ' + s.latentPct + '% latent (SHR ' + s.shr.toFixed(2) + ').</b> ' +
      escapeHtml(s.message) + '</p>';
  }

  function wireFinalRec() {
    // Swap the return-air field(s) (duct diameter vs. grille width/height)
    // the instant the mode changes, without requiring a check click.
    var retModeSel = $("#inRetAirMode");
    if (retModeSel) {
      retModeSel.addEventListener("change", function () {
        var wrap = $("#retAirFields");
        if (wrap) wrap.innerHTML = retAirFieldsHtml(retModeSel.value, state.effective);
      });
    }
    var checkBtn = $("#checkRetAirBtn");
    if (checkBtn) checkBtn.addEventListener("click", function () {
      var retModeEl = $("#inRetAirMode");
      state.overrides.retAirMode = retModeEl && retModeEl.value ? retModeEl.value : undefined;
      var retDuctEl = $("#inRetAirDuctIn"); var retDuctVal = retDuctEl ? parseFloat(retDuctEl.value) : NaN;
      state.overrides.retAirDuctIn = isFinite(retDuctVal) && retDuctVal > 0 ? retDuctVal : undefined;
      var retGWEl = $("#inRetAirGrilleW"); var retGWVal = retGWEl ? parseFloat(retGWEl.value) : NaN;
      state.overrides.retAirGrilleW = isFinite(retGWVal) && retGWVal > 0 ? retGWVal : undefined;
      var retGHEl = $("#inRetAirGrilleH"); var retGHVal = retGHEl ? parseFloat(retGHEl.value) : NaN;
      state.overrides.retAirGrilleH = isFinite(retGHVal) && retGHVal > 0 ? retGHVal : undefined;
      thinkThen("Checking return air…", function () {
        compute();   // validation-only field: recomputes returnAir, load numbers are unchanged
        render();
        var card = $(".retair-card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }
  function returnAirIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h13"/><path d="M12 7l5 5-5 5"/><path d="M21 5v14"/></svg>'; }

  function detailsBlock(r, c, e, qualityLabel) {
    var cb = r.cooling.breakdown;
    var max = Math.max(cb.conduction, cb.solar, cb.people, cb.internal, cb.infiltration, 1);
    function bar(label, val) {
      return '<div class="bar-row"><div class="bar-top"><span>' + label + '</span><b>' + fmt(val) + ' BTU/h</b></div>' +
        '<div class="bar-track"><div class="bar-fill" data-w="' + Math.round(val / max * 100) + '"></div></div></div>';
    }
    return '' +
      '<details class="details"><summary>Cooling load breakdown<svg class="caret" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></summary>' +
        '<div class="details-body">' +
          bar("Walls, roof &amp; windows", cb.conduction) +
          bar("Solar through glass", cb.solar) +
          bar("People", cb.people) +
          bar("Appliances &amp; lighting", cb.internal) +
          bar("Air leakage (sensible + latent)", cb.infiltration) +
          '<div class="assumptions"><h4>Assumptions used</h4>' +
            kv("Conditioned area", fmt(e.area) + " ft²") +
            kv("Bedrooms", String(e.bedrooms)) +
            kv("Construction", qualityLabel) +
            kv("Stories (est.)", String(r.inputs.stories)) +
            kv("Glazing area (est.)", fmt(r.inputs.windowArea) + " ft²") +
            kv("Infiltration (est.)", fmt(r.inputs.cfm) + " CFM") +
            kv("Summer / winter design", c.cooling1 + "°F / " + c.heating99 + "°F") +
            kv("Design data", c.source === "live" ? "TrueClimate — " + fmt(c.hours) + " hrs on-site" : "Nearest station (" + escapeHtml(c.city) + ")") +
            kv("Elevation / air density", fmt(c.elevFt || 0) + " ft · ×" + r.inputs.acf) +
            kv("Confidence band", "±" + Math.round(e.rangePct * 100) + "%") +
            kv("Indoor setpoints", "75°F cool · 70°F heat") +
            kv("Sensible cooling", fmt(r.cooling.sensible) + " BTU/h") +
            kv("Latent cooling", fmt(r.cooling.latent) + " BTU/h") +
            (e.atticR != null ? kv("Attic insulation", "R-" + e.atticR) : "") +
            (e.ductType ? kv("Duct location", ductTypeLabel(e.ductType)) : "") +
            (e.ductType !== "ductless" && e.ductCondition ? kv("Duct condition", e.ductCondition === "sealed" ? "Sealed &amp; insulated" : "Unsealed / uninsulated") : "") +
          '</div>' +
        '</div>' +
      '</details>';
  }

  function adjustBlock(e, p) {
    var q = e.quality;
    /*
     * Placeholders name the value the engine is ACTUALLY using when it came
     * from the vintage x zone table, so the blank field reads as "we assumed
     * R-38 because this is a 2009 house" rather than the vaguer "blank = tier
     * above". Seeing the specific number is what prompts someone to go verify
     * it, which is the whole reason EnvelopeIQ exists.
     */
    var env = state.result && state.result.envelope;
    function ph(key, shown, fallback) {
      if (env && env.source[key] === "vintage") {
        return "blank = " + shown + " assumed for a " + env.yearBuilt + " home in zone " + env.zone;
      }
      return fallback;
    }
    return '' +
      '<details class="details" id="adjustDetails"><summary>Fine-tune inputs<svg class="caret" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></summary>' +
        '<div class="details-body adjust">' +
          (p.source === "estimate" ? '<p class="note" style="text-align:left;margin:2px 2px 4px">We couldn\'t auto-pull this home\'s data, so these start from typical values. Adjust for an accurate result.</p>' : '') +
          '<label>Conditioned floor area (ft²)</label>' +
          '<input type="number" id="inArea" min="200" max="20000" step="50" value="' + e.area + '" />' +
          '<label>Bedrooms</label>' +
          '<input type="number" id="inBeds" min="0" max="12" step="1" value="' + e.bedrooms + '" />' +
          '<label>Year built (optional — unlocks EnvelopeIQ)</label>' +
          '<input type="number" id="inYearBuilt" min="1800" max="2100" step="1" placeholder="' + (env && env.basis === "vintage-zone" ? escapeHtml(String(env.yearBuilt) + " (from property records)") : "e.g. 1994 — sets code-era insulation, windows and air sealing") + '" value="' + (e.yearBuilt != null ? e.yearBuilt : "") + '" />' +
          '<label>Construction / insulation</label>' +
          '<div class="seg" id="segQuality">' +
            segBtn("good", "Well sealed", q) +
            segBtn("average", "Average", q) +
            segBtn("poor", "Older / leaky", q) +
          '</div>' +
          '<div class="adjust-row">' +
            '<div><label>Foundation</label>' +
              '<select id="inFoundation">' +
                opt("slab", "Slab", e.foundation) + opt("crawl", "Crawl space", e.foundation) + opt("basement", "Basement", e.foundation) +
              '</select></div>' +
            '<div><label>Sun exposure</label>' +
              '<select id="inSun">' +
                opt("low", "Shaded", e.sun) + opt("average", "Average", e.sun) + opt("high", "Sunny", e.sun) +
              '</select></div>' +
          '</div>' +
          '<div class="adjust-row">' +
            '<div><label>System type</label>' +
              '<select id="inSystem">' +
                opt("single", "Single-stage", e.systemType) + opt("two", "Two-stage", e.systemType) + opt("variable", "Variable-capacity", e.systemType) +
              '</select></div>' +
            '<div><label>Ceiling height (ft)</label>' +
            '<input type="number" id="inCeiling" min="7" max="20" step="0.5" value="' + e.ceiling + '" /></div>' +
          '</div>' +
          '<div class="adjust-row">' +
            '<div><label>Stories</label>' +
              '<select id="inStories">' +
                '<option value=""' + (e.stories == null ? " selected" : "") + '>Auto (estimated from floor area)</option>' +
                opt("1", "1", e.stories != null ? String(e.stories) : "") +
                opt("1.5", "1.5", e.stories != null ? String(e.stories) : "") +
                opt("2", "2", e.stories != null ? String(e.stories) : "") +
                opt("3", "3", e.stories != null ? String(e.stories) : "") +
                opt("4", "4", e.stories != null ? String(e.stories) : "") +
              '</select></div>' +
            '<div><label>Window amount (% of floor area, optional)</label>' +
              '<input type="number" id="inWindowFrac" min="5" max="40" step="1" placeholder="leave blank for 15% default" value="' + (e.windowFrac != null ? Math.round(e.windowFrac * 100) : "") + '" /></div>' +
          '</div>' +
          '<label>Attic insulation (R-value, optional)</label>' +
          '<input type="number" id="inAtticR" min="5" max="100" step="1" placeholder="' + escapeHtml(ph('atticR', 'R-' + (env ? env.atticR : ''), 'leave blank to use construction tier above (R-5 minimum)')) + '" value="' + (e.atticR != null ? e.atticR : "") + '" />' +
          '<div class="adjust-row">' +
            '<div><label>Window U-factor (optional, NFRC label)</label>' +
              '<input type="number" id="inWindowU" min="0.05" max="3" step="0.01" placeholder="' + escapeHtml(ph('windowU', 'U-' + (env ? env.windowU.toFixed(2) : ''), 'blank = tier above')) + '" value="' + (e.windowU != null ? e.windowU : "") + '" /></div>' +
            '<div><label>Window SHGC (optional, NFRC label)</label>' +
              '<input type="number" id="inWindowSHGC" min="0.05" max="1" step="0.01" placeholder="' + escapeHtml(ph('windowSHGC', 'SHGC ' + (env ? env.windowSHGC.toFixed(2) : ''), 'blank = tier above')) + '" value="' + (e.windowSHGC != null ? e.windowSHGC : "") + '" /></div>' +
          '</div>' +
          '<label>Air sealing — ACH natural (optional, from a blower-door/energy audit)</label>' +
          '<input type="number" id="inAch" min="0.05" max="3" step="0.01" placeholder="' + escapeHtml(ph('ach', (env ? env.ach.toFixed(2) : '') + ' ACH', 'leave blank to use construction tier above')) + '" value="' + (e.ach != null ? e.ach : "") + '" />' +
          '<div class="adjust-row">' +
            '<div><label>Duct location</label>' +
              '<select id="inDuctType">' +
                '<option value=""' + (!e.ductType ? " selected" : "") + '>Not specified</option>' +
                opt("attic", "Ducted — in unconditioned attic", e.ductType) +
                opt("conditioned-space", "Ducted — in conditioned space", e.ductType) +
                opt("crawlspace", "Ducted — in crawlspace", e.ductType) +
                opt("ductless", "Ductless / mini-split", e.ductType) +
              '</select></div>' +
            '<div id="ductCondWrap"' + (e.ductType === "ductless" ? ' style="display:none"' : '') + '>' +
              '<label>Duct condition</label>' +
              '<select id="inDuctCondition">' +
                '<option value=""' + (!e.ductCondition ? " selected" : "") + '>Not specified</option>' +
                opt("sealed", "Sealed &amp; insulated", e.ductCondition) + opt("unsealed", "Unsealed / uninsulated", e.ductCondition) +
              '</select></div>' +
          '</div>' +
          '<p class="note" style="text-align:left;margin:10px 2px 0">Return duct/grille sizing has its own check at the bottom of the page — it\'s a separate, instant check that doesn\'t need a full recalculate.</p>' +
          '<button class="recalc" id="recalcBtn">Recalculate</button>' +
        '</div>' +
      '</details>';
  }
  function segBtn(val, label, cur) { return '<button data-q="' + val + '" class="' + (cur === val ? "on" : "") + '">' + label + '</button>'; }
  function opt(val, label, cur) { return '<option value="' + val + '"' + (cur === val ? " selected" : "") + '>' + label + '</option>'; }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }
  function ductTypeLabel(t) { return { attic: "Ducted — unconditioned attic", "conditioned-space": "Ducted — conditioned space", crawlspace: "Ducted — crawlspace", ductless: "Ductless / mini-split" }[t] || t; }
  // Return-air fields swap between a single duct-diameter input (ducted trunk)
  // and a width/height pair (direct grille) depending on the selected mode.
  // Used both for the initial render and for the instant swap on mode change
  // (see wireAdjust), so the two stay in sync without a full recalculate.
  function retAirFieldsHtml(mode, e) {
    e = e || {};
    if (mode === "ducted") {
      return '<input type="number" id="inRetAirDuctIn" min="4" max="30" step="1" placeholder="Return duct diameter, inches" value="' + (e.retAirDuctIn != null ? e.retAirDuctIn : "") + '" />';
    }
    if (mode === "grille") {
      return '<div class="adjust-row">' +
        '<div><label>Grille width (in)</label><input type="number" id="inRetAirGrilleW" min="1" max="60" step="1" value="' + (e.retAirGrilleW != null ? e.retAirGrilleW : "") + '" /></div>' +
        '<div><label>Grille height (in)</label><input type="number" id="inRetAirGrilleH" min="1" max="60" step="1" value="' + (e.retAirGrilleH != null ? e.retAirGrilleH : "") + '" /></div>' +
      '</div>';
    }
    return "";
  }

  /*
   * Keeping what the rep typed across a re-render.
   *
   * The whole results page is rebuilt from state whenever anything finishes —
   * a photo analysis, an incentive search, a job-type change — and the
   * fine-tune fields are read only when Recalculate is pressed. So a rep could
   * measure the attic, type R-19, have a background job land, and silently get
   * a load computed from R-38 instead. Worse than losing the number is keeping
   * the result: the page still looks finished.
   *
   * Every edit inside the fine-tune panel is therefore stashed by element id
   * and written back after each render, along with the panel's open state and
   * the lit construction-tier button. The stash is dropped when a new
   * calculation starts, because it belongs to the old house.
   */
  var inputDraft = {};
  var draftPanelOpen = false;

  function draftScope(el) {
    return el && el.id && el.closest && el.closest("#adjustDetails") ? el : null;
  }
  function rememberDraft(ev) {
    var el = draftScope(ev.target);
    if (el) inputDraft[el.id] = el.value;
  }
  function clearInputDraft() { inputDraft = {}; draftPanelOpen = false; }
  function restoreInputDraft() {
    var panel = $("#adjustDetails");
    if (panel && draftPanelOpen) panel.open = true;
    Object.keys(inputDraft).forEach(function (id) {
      var el = $("#" + id);
      // Only inside the panel: an id reused elsewhere must not be written to.
      if (el && el.closest("#adjustDetails") && el.value !== inputDraft[id]) el.value = inputDraft[id];
    });
    if (inputDraft.__quality) {
      var seg = $("#segQuality");
      if (seg) seg.querySelectorAll("button[data-q]").forEach(function (b) {
        b.classList.toggle("on", b.getAttribute("data-q") === inputDraft.__quality);
      });
    }
  }
  // Attached once to the container, which survives every re-render of its
  // contents, so there is nothing to re-wire.
  function wireInputDraft() {
    var root = $("#results");
    if (!root) return;
    root.addEventListener("input", rememberDraft);
    root.addEventListener("change", rememberDraft);
    root.addEventListener("click", function (ev) {
      var q = ev.target.closest && ev.target.closest("#segQuality button[data-q]");
      if (q) inputDraft.__quality = q.getAttribute("data-q");
      // <details> toggles after the click event, so read the real state next tick
      // rather than guessing the inverse of the current one.
      var sum = ev.target.closest && ev.target.closest("#adjustDetails > summary");
      if (sum) setTimeout(function () { var d = $("#adjustDetails"); draftPanelOpen = !!(d && d.open); }, 0);
    });
  }

  function wireAdjust() {
    var seg = $("#segQuality");
    if (seg) {
      seg.addEventListener("click", function (ev) {
        var b = ev.target.closest("button[data-q]");
        if (!b) return;
        seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        // Recalculate always writes back whichever tier button is lit, even
        // the one the app pre-selected — so the override value alone can't
        // tell a deliberate pick apart from an echo. This flag records the
        // actual click, and it's what lets a deliberate tier choice outrank
        // the vintage table without every Recalculate silently doing so.
        state.overrides.qualityPicked = true;
      });
    }
    // Duct condition doesn't matter for ductless systems — hide it instantly
    // on selection change rather than waiting for Recalculate.
    var ductTypeSel = $("#inDuctType");
    if (ductTypeSel) {
      ductTypeSel.addEventListener("change", function () {
        var wrap = $("#ductCondWrap");
        var isDuctless = ductTypeSel.value === "ductless";
        if (wrap) wrap.style.display = isDuctless ? "none" : "";
        var condEl = $("#inDuctCondition");
        if (isDuctless && condEl) condEl.value = "";
      });
    }
    var rb = $("#recalcBtn");
    if (rb) rb.addEventListener("click", function () {
      var area = parseFloat($("#inArea").value);
      var beds = parseInt($("#inBeds").value, 10);
      var ceiling = parseFloat($("#inCeiling").value);
      var qOn = $("#segQuality .on");
      state.overrides.area = isFinite(area) ? area : undefined;
      state.overrides.bedrooms = isFinite(beds) ? beds : undefined;
      state.overrides.quality = qOn ? qOn.getAttribute("data-q") : undefined;
      var yearEl = $("#inYearBuilt"); var yearVal = yearEl ? parseInt(yearEl.value, 10) : NaN;
      state.overrides.yearBuilt = (isFinite(yearVal) && yearVal >= 1800 && yearVal <= 2100) ? yearVal : undefined;
      state.overrides.foundation = $("#inFoundation").value;
      state.overrides.sun = $("#inSun").value;
      state.overrides.systemType = $("#inSystem").value;
      state.overrides.ceiling = isFinite(ceiling) ? ceiling : undefined;

      var storiesEl = $("#inStories"); var storiesVal = storiesEl ? parseFloat(storiesEl.value) : NaN;
      state.overrides.stories = isFinite(storiesVal) && storiesVal > 0 ? storiesVal : undefined;
      var winFracEl = $("#inWindowFrac"); var winFracVal = winFracEl ? parseFloat(winFracEl.value) : NaN;
      state.overrides.windowFrac = isFinite(winFracVal) && winFracVal > 0 ? winFracVal / 100 : undefined;

      var atticR = parseFloat($("#inAtticR") ? $("#inAtticR").value : "");
      state.overrides.atticR = isFinite(atticR) && atticR > 0 ? atticR : undefined;
      var windowUEl = $("#inWindowU"); var windowUVal = windowUEl ? parseFloat(windowUEl.value) : NaN;
      state.overrides.windowU = isFinite(windowUVal) && windowUVal > 0 ? windowUVal : undefined;
      var windowSHGCEl = $("#inWindowSHGC"); var windowSHGCVal = windowSHGCEl ? parseFloat(windowSHGCEl.value) : NaN;
      state.overrides.windowSHGC = isFinite(windowSHGCVal) && windowSHGCVal > 0 ? windowSHGCVal : undefined;
      var achEl = $("#inAch"); var achVal = achEl ? parseFloat(achEl.value) : NaN;
      state.overrides.ach = isFinite(achVal) && achVal > 0 ? achVal : undefined;
      var ductTypeEl = $("#inDuctType");
      state.overrides.ductType = ductTypeEl && ductTypeEl.value ? ductTypeEl.value : undefined;
      var ductCondEl = $("#inDuctCondition");
      state.overrides.ductCondition = ductCondEl && ductCondEl.value ? ductCondEl.value : undefined;
      // Return-air fields are NOT read here — they live in the final
      // recommendation section's own instant check (wireFinalRec), which
      // writes the same state.overrides.retAir* keys without requiring a
      // full Recalculate (the return-air check is validation-only and
      // never feeds back into the load numbers, so it doesn't need one).

      // Only demote a real fetched property record to "estimate" when the
      // contractor actually changed the area/bedrooms away from the fetched
      // values — an unrelated fine-tune (duct type, ACH, etc.) shouldn't
      // mislabel the data source or reopen it to a photo-AI override.
      if (state.property.source === "fetched") {
        var areaChanged = state.overrides.area != null && state.overrides.area !== state.property.area;
        var bedsChanged = state.overrides.bedrooms != null && state.overrides.bedrooms !== state.property.bedrooms;
        if (areaChanged || bedsChanged) state.property.source = "estimate";
      }
      thinkThen("Recalculating the load…", function () {
        compute();
        render();
      });
    });
  }

  /*
   * A quiet line above the results saying how much of the free allowance is
   * left. Someone should meet the ceiling before they hit it, not after they
   * have typed a customer's address.
   */
  function updateFreeNote() {
    var host = $("#freeNote");
    if (!host) return;
    if (!onFreePlan()) { host.innerHTML = ""; host.classList.add("hidden"); return; }
    var left = freeCalcsLeft();
    host.classList.remove("hidden");
    host.innerHTML = left > 0
      ? 'Free plan · <b>' + left + '</b> load calculation' + (left === 1 ? "" : "s") + ' left. <a href="index.html#pricing">See plans</a>'
      : 'Free plan · no calculations left. <a href="index.html#pricing">See plans</a>';
  }

  // ---------- Count-up + bar animations ----------
  function animateCounts() {
    document.querySelectorAll(".count").forEach(function (el) {
      var to = parseInt(el.getAttribute("data-to"), 10) || 0;
      var start = performance.now(), dur = 850;
      function step(now) {
        var t = Math.min(1, Math.max(0, (now - start) / dur));
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(Math.round(to * eased));
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
    requestAnimationFrame(function () {
      document.querySelectorAll(".bar-fill, .rq-bar-fill").forEach(function (el) { el.style.width = (el.getAttribute("data-w") || 0) + "%"; });
    });
  }

  // ---------- RebateIQ (Pro/Fleet + trial): live incentive research ----------
  //
  // Unlike every other card, this one talks to the live web at the moment the
  // rep taps it, because incentive programs are the most perishable data in
  // this business: utility rebates change seasonally, state IRA programs
  // opened on staggered dates, and budgets run dry mid-year. A table shipped
  // with the app would be wrong within a quarter and wrong silently.
  //
  // Results live in state.rebates (session-only, NOT in state.overrides): a
  // saved job reopened in March must not quote a rebate that closed in
  // January. Re-running is one tap.

  function rebateIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>'; }

  function rebateContext() {
    var g = state.geo || {}, r = state.result, er = state.energyResult;
    var ctx = {
      address: g.label ? shortAddr(g.label) : "",
      city: g.city || "", county: g.county || "", state: g.state || "", postcode: g.postcode || ""
    };
    /*
     * The job type is the single most important thing to send. Incentive
     * programs are organised by MEASURE, not by house: duct sealing, a
     * ductless mini-split, attic insulation and a heat-pump water heater are
     * four separate programs with separate money and separate forms. Asking
     * for "HVAC rebates" on a duct job returns the wrong programs entirely.
     */
    var jq = window.JobTypes ? window.JobTypes.rebateQuery(jobTypeId(), jobTypeCustom()) : null;
    if (jq) {
      ctx.jobType = jq.label;
      ctx.jobTerms = jq.terms;
      ctx.jobCustom = jq.custom;
      ctx.systemType = jq.label;
      ctx.fuel = jq.fuel;
    }
    if (r) {
      ctx.tons = r.recommendedTons;
      // Most programs set an efficiency floor, so send the level being
      // considered rather than leaving the search to guess.
      if (er && er.options && er.options.length) {
        var best = er.options[er.options.length - 1];
        ctx.seer2 = best.seer2;
        if (er.fuel !== "furnace" && er.fuel !== "resistance") ctx.hspf2 = best.hspf2;
      }
      if (er && er.existing && er.existing.age) ctx.existingAge = er.existing.age;
    }
    return ctx;
  }

  function runRebateSearch() {
    var s = loadSettings();
    if (!s.aiApiKey) {
      toast("Add an AI provider API key in Settings to use RebateIQ");
      openSettings();
      return;
    }
    if (state.rebateBusy) return;
    state.rebateBusy = true;
    state.rebateError = null;
    render();

    var work = window.RebateIQ.search(rebateContext(), s, {
      onStep: function () { if (window.Thinking) window.Thinking.setMessage("Still searching — checking more programs…"); }
    });
    if (window.Thinking) {
      work = window.Thinking.during([
        "Finding which utilities serve this address…",
        "Searching federal and state programs…",
        "Checking utility rebates…",
        "Checking local and income-qualified programs…",
        "Reading the fine print…"
      ], work, 2600);
    }
    work.then(function (res) {
      // Stamp the job the search was actually run for. If the rep changes the
      // job type afterwards, the programs on screen are still the old job's,
      // and the card has to say so rather than silently relabelling itself.
      var jt = jobType();
      res.jobLabel = jt ? jt.label : "";
      res.jobId = jobTypeId();
      res.jobCustom = jobTypeCustom();
      state.rebates = res;
      state.rebateBusy = false;
      render();
      var card = $("#rebateCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      toast(res.programs.length
        ? res.programs.length + " program" + (res.programs.length === 1 ? "" : "s") + " found"
        : "No programs confirmed for this address");
    }).catch(function (err) {
      state.rebateBusy = false;
      state.rebateError = err && err.message ? err.message : "Rebate research failed.";
      render();
    });
  }

  function rebateCard() {
    var g = state.geo || {};
    var cityLabel = g.city ? escapeHtml(g.city) : "this address";
    if (planTier() < 2) {
      var cta = planTier() === 0
        ? '<a class="permit-cta" href="auth.html#signup">Start free trial — unlock RebateIQ</a>'
        : '<a class="permit-cta" href="index.html#pricing">Upgrade to Pro — unlock RebateIQ</a>';
      return '' +
        '<div class="permit-card locked">' +
          '<div class="hp-head"><span class="ico gold">' + lockIcon() + '</span>RebateIQ™ — grants &amp; rebates<span class="permit-badge">PRO</span></div>' +
          '<p class="hp-text">Search the live web for every grant, tax credit and utility rebate that applies to ' + cityLabel + ' and the exact system you\'re quoting — with an apply link on every one, and a summary written for the homeowner.</p>' +
          '<div class="permit-teaser"><div class="tz-row"></div><div class="tz-row w70"></div><div class="tz-row w85"></div><div class="tz-row w60"></div></div>' +
          cta +
        '</div>';
    }

    var rb = state.rebates;
    var busy = state.rebateBusy;
    var head =
      '<div class="hp-head"><span class="ico gold">' + rebateIcon() + '</span>RebateIQ™ — grants &amp; rebates<span class="permit-badge on">PRO</span></div>';

    if (!rb) {
      return '' +
        '<div class="permit-card rb-card" id="rebateCard">' + head +
          '<p class="hp-text">Searches the live web for grants, federal and state tax credits, and the rebates offered by the utilities that actually serve ' + cityLabel + ' — matched to the system you\'re quoting. Every result carries a source and an apply link.</p>' +
          (state.rebateError ? '<p class="rb-error">' + escapeHtml(state.rebateError) + '</p>' : "") +
          '<button class="recalc" id="rebateBtn"' + (busy ? " disabled" : "") + '>' +
            (busy ? '<span class="spin"></span>Searching…' : 'Find grants &amp; rebates') + '</button>' +
          '<p class="rb-foot">Uses your AI provider key (Settings) and takes 20-60 seconds. Programs change constantly, so this reads the web live rather than a built-in list.</p>' +
        '</div>';
    }

    var t = rb.totals;
    var rows = rb.programs.map(function (p) {
      var amount = p.amountMax != null ? money(p.amountMax) : (p.amountText ? "" : "Amount varies");
      return '<div class="rb-prog' + (p.incomeQualified ? " income" : "") + '">' +
        '<div class="rb-prog-top">' +
          '<span class="rb-type">' + escapeHtml(p.typeLabel) + '</span>' +
          (amount ? '<b class="rb-amt">' + amount + '</b>' : "") +
        '</div>' +
        '<div class="rb-name">' + escapeHtml(p.name) + '</div>' +
        (p.administrator ? '<div class="rb-admin">' + escapeHtml(p.administrator) + '</div>' : "") +
        (p.amountText ? '<div class="rb-line"><span>Worth</span>' + escapeHtml(p.amountText) + '</div>' : "") +
        (p.requirements ? '<div class="rb-line"><span>Equipment must meet</span>' + escapeHtml(p.requirements) + '</div>' : "") +
        (p.eligibility ? '<div class="rb-line"><span>Who qualifies</span>' + escapeHtml(p.eligibility) + '</div>' : "") +
        (p.howToApply ? '<div class="rb-line"><span>How to apply</span>' + escapeHtml(p.howToApply) + '</div>' : "") +
        (p.deadline ? '<div class="rb-line"><span>Deadline</span>' + escapeHtml(p.deadline) + '</div>' : "") +
        '<div class="rb-actions">' +
          '<a class="rb-apply" href="' + escapeAttr(p.applyUrl) + '" target="_blank" rel="noopener noreferrer">Apply' + extLinkIcon() + '</a>' +
          (p.source !== p.applyUrl ? '<a class="rb-src" href="' + escapeAttr(p.source) + '" target="_blank" rel="noopener noreferrer">Source</a>' : "") +
        '</div>' +
      '</div>';
    }).join("");

    // Which measure this list belongs to, and whether it still matches the job
    // now selected. Programs are measure-specific, so a list searched for duct
    // sealing must not sit silently under a heat-pump job.
    var stale = rb.jobId && rb.jobId !== jobTypeId();
    var jobLine = rb.jobLabel
      ? '<p class="rb-job' + (stale ? " stale" : "") + '">' +
          (stale
            ? 'These programs were found for <b>' + escapeHtml(rb.jobLabel) + '</b> — the job is now <b>' +
              escapeHtml(jobType() ? jobType().label : "") + '</b>. Search again for the right programs.'
            : 'Programs for <b>' + escapeHtml(rb.jobLabel) + '</b>' + (rb.jobCustom ? ' — ' + escapeHtml(rb.jobCustom) : "")) +
        '</p>'
      : "";

    var util = [];
    if (rb.utilities.electric) util.push("Electric: <b>" + escapeHtml(rb.utilities.electric) + "</b>");
    if (rb.utilities.gas) util.push("Gas: <b>" + escapeHtml(rb.utilities.gas) + "</b>");

    return '' +
      '<div class="permit-card rb-card" id="rebateCard">' + head +
        (rb.programs.length
          ? '<div class="rb-total">' +
              '<div class="rb-total-num">' + money(t.capped) + '</div>' +
              '<div class="rb-total-sub">' + t.countedPrograms + ' program' + (t.countedPrograms === 1 ? "" : "s") + ' with a stated cap, before any income-qualified help' +
                (t.unknownAmountPrograms ? ' · ' + t.unknownAmountPrograms + ' more with no fixed amount' : "") + '</div>' +
            '</div>'
          : '<p class="rb-error">No programs could be confirmed for this address right now. That is a real answer, not a failure — try again after switching providers, or check the utility directly.</p>') +
        jobLine +
        (util.length ? '<p class="rb-util">' + util.join(" &nbsp;·&nbsp; ") + '</p>' : "") +
        (rb.homeownerSummary ? '<div class="sq-talk rb-talk"><b>Read this to the homeowner</b><p>' + escapeHtml(rb.homeownerSummary) + '</p></div>' : "") +
        (rb.programs.length ? '<div class="rb-progs">' + rows + '</div>' : "") +
        (t.withIncome > t.capped
          ? '<p class="rb-income-note">A further ' + money(t.withIncome - t.capped) + ' is available through income-qualified programs, which are listed above but excluded from the headline figure because most households will not meet the income test.</p>'
          : "") +
        '<div class="rb-btns">' +
          '<button class="rb-again" id="rebateBtn"' + (busy ? " disabled" : "") + '>' + (busy ? "Searching…" : "Search again") + '</button>' +

        '</div>' +
        '<p class="rb-foot">Researched live from ' + rb.sources.length + ' source' + (rb.sources.length === 1 ? "" : "s") + '. <b>Verify every program before it goes in a contract</b> — amounts, deadlines and funding change without notice, and a rebate quoted then denied is your problem, not the utility\'s.</p>' +
      '</div>';
  }

  function extLinkIcon() { return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>'; }

  function wireRebates() {
    var btn = $("#rebateBtn");
    if (btn) btn.addEventListener("click", runRebateSearch);
    // There is deliberately no "apply to the proposal" action any more: this
    // app no longer builds proposals, and an unverified researched figure
    // should reach a customer's price through the shop's quoting software,
    // where someone checks it, rather than through a one-tap shortcut here.
  }

  // Printed appendix: the page the homeowner keeps.
  function reportRebates() {
    var rb = state.rebates;
    if (!rb || planTier() < 2 || !rb.programs.length) return "";
    var rows = rb.programs.map(function (p) {
      return '<tr>' +
        '<td>' + escapeHtml(p.name) + (p.administrator ? '<br/><small>' + escapeHtml(p.administrator) + '</small>' : "") + '</td>' +
        '<td>' + escapeHtml(p.typeLabel) + (p.incomeQualified ? '<br/><small>income-qualified</small>' : "") + '</td>' +
        '<td>' + (p.amountMax != null ? money(p.amountMax) : escapeHtml(p.amountText || "varies")) + '</td>' +
        '<td class="rp-rb-apply">' + escapeHtml(p.applyUrl) + '</td>' +
      '</tr>';
    }).join("");
    // Incentive programs are organised by measure, so the printed table has to
    // say which measure it was searched for — a duct-sealing rebate on a page
    // headed only by an address reads as if it applied to the whole job.
    var rbJob = rb.jobLabel || (jobType() ? jobType().label : "");
    return '<div class="rp-block rp-rebates"><h2>Grants, credits &amp; rebates for this address</h2>' +
      (rbJob ? '<p class="rp-permit-note">Searched for: <b>' + escapeHtml(rbJob) + '</b>' +
        (rb.jobCustom ? ' — ' + escapeHtml(rb.jobCustom) : "") + '</p>' : "") +
      (rb.homeownerSummary ? '<p class="rp-rb-summary">' + escapeHtml(rb.homeownerSummary) + '</p>' : "") +
      '<table class="rp-rb-table">' +
        '<tr><th>Program</th><th>Type</th><th>Up to</th><th>Where to apply</th></tr>' + rows +
      '</table>' +
      '<p class="rp-permit-note"><b>Estimated total before income-qualified programs: ' + money(rb.totals.capped) + '</b>' +
        (rb.totals.withIncome > rb.totals.capped ? ' — plus up to ' + money(rb.totals.withIncome - rb.totals.capped) + ' more if the household meets the income limits.' : '') + '</p>' +
      '<p class="rp-disc" style="margin-top:6px">Researched from public sources on ' + new Date(rb.searchedAt).toLocaleDateString("en-US") + '. Incentive programs change amounts, requirements and deadlines without notice, and funding can be exhausted mid-year. Confirm each program directly with its administrator before relying on it. This is not tax advice.</p>' +
    '</div>';
  }

  // ---------- RoomIQ (Pro/Fleet + trial): room-by-room comfort diagnosis ----------
  //
  // The whole-house load says how many tons. RoomIQ says which room is the
  // problem and whether the fix is air or equipment — which is the question
  // the homeowner actually asked when they called. Rooms live in
  // state.overrides.rooms so they ride along in saved jobs like every other
  // input, and a fresh address starts fresh.

  var ROOM_ORIENT_OPTS = [["unknown", "Not sure"], ["n", "North"], ["ne", "Northeast"], ["e", "East"], ["se", "Southeast"], ["s", "South"], ["sw", "Southwest"], ["w", "West"], ["nw", "Northwest"]];

  function roomsState() {
    if (!Array.isArray(state.overrides.rooms)) state.overrides.rooms = [];
    return state.overrides.rooms;
  }

  function computeRooms() {
    var r = state.result, c = state.climate, e = state.effective;
    if (!r || !c || !window.RoomLoads) { state.roomResult = null; return; }
    var rooms = roomsState();
    if (!rooms.length) { state.roomResult = null; return; }
    state.roomResult = window.RoomLoads.distribute({
      rooms: rooms,
      house: r,
      area: e.area,
      ceiling: e.ceiling,
      windowFrac: r.inputs.windowFrac,
      cooling1: c.cooling1,
      heating99: c.heating99,
      indoorCool: 75,
      indoorHeat: 70,
      quality: window.LoadCalc.QUALITY[e.quality] || window.LoadCalc.QUALITY.average
    });
  }

  function roomIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 11h18M11 3v18"/></svg>'; }

  function roomCard() {
    if (planTier() < 2) {
      var cta = planTier() === 0
        ? '<a class="permit-cta" href="auth.html#signup">Start free trial — unlock RoomIQ</a>'
        : '<a class="permit-cta" href="index.html#pricing">Upgrade to Pro — unlock RoomIQ</a>';
      return '' +
        '<div class="permit-card locked">' +
          '<div class="hp-head"><span class="ico gold">' + lockIcon() + '</span>RoomIQ™ — room-by-room diagnosis<span class="permit-badge">PRO</span></div>' +
          '<p class="hp-text">Answer the question the customer actually called about. Enter the rooms and their registers, and RoomIQ shows which room is starved of air, how much it is short by, and whether the fix is ductwork or equipment — from this home\'s own load.</p>' +
          '<div class="permit-teaser"><div class="tz-row"></div><div class="tz-row w70"></div><div class="tz-row w85"></div><div class="tz-row w60"></div></div>' +
          cta +
        '</div>';
    }
    var rooms = roomsState(), rr = state.roomResult;
    var types = window.RoomLoads.ROOM_TYPES;
    var typeOpts = Object.keys(types).map(function (k) { return [k, types[k].label]; });

    var rowsHtml = rooms.map(function (rm, i) {
      return '<div class="rq-row" data-i="' + i + '">' +
        '<div class="rq-row-head">' +
          '<input type="text" class="rq-name" id="rqName' + i + '" value="' + escapeAttr(rm.name || "") + '" placeholder="Room name" />' +
          '<button class="rq-del" id="rqDel' + i + '" title="Remove room" aria-label="Remove room">×</button>' +
        '</div>' +
        '<div class="rq-grid">' +
          '<div><label>Area ft²</label><input type="number" id="rqArea' + i + '" min="10" max="4000" step="10" value="' + (rm.area != null ? rm.area : "") + '" /></div>' +
          '<div><label>Type</label>' + selectHtml("rqType" + i, rm.type || "bedroom", typeOpts) + '</div>' +
          '<div><label>Outside walls</label>' + selectHtml("rqWalls" + i, rm.exteriorWalls != null ? rm.exteriorWalls : 1, [[0, "0 (interior)"], [1, "1"], [2, "2 (corner)"], [3, "3"], [4, "4"]]) + '</div>' +
          '<div><label>Faces</label>' + selectHtml("rqOrient" + i, rm.orientation || "unknown", ROOM_ORIENT_OPTS) + '</div>' +
          '<div><label>Supplies</label><input type="number" id="rqSup' + i + '" min="0" max="12" step="1" value="' + (rm.supplies != null ? rm.supplies : "") + '" placeholder="#" /></div>' +
          '<div><label>Measured CFM</label><input type="number" id="rqCfm' + i + '" min="0" max="2000" step="5" value="' + (rm.supplyCfm != null ? rm.supplyCfm : "") + '" placeholder="optional" /></div>' +
        '</div>' +
        '<div class="rq-checks">' +
          '<label class="rq-check"><input type="checkbox" id="rqTop' + i + '"' + (rm.topFloor ? " checked" : "") + ' /> Attic above</label>' +
          '<label class="rq-check"><input type="checkbox" id="rqUnder' + i + '"' + (rm.overUnconditioned ? " checked" : "") + ' /> Over garage / crawl</label>' +
        '</div>' +
      '</div>';
    }).join("");

    var resultsHtml = "";
    if (rr) {
      var maxCool = Math.max.apply(null, rr.rooms.map(function (x) { return x.cooling; }).concat([1]));
      var resRows = rr.rooms.map(function (x) {
        var cls = x.worst === "severe" ? " severe" : x.worst === "warn" ? " warn" : "";
        var air = x.actualCfm != null
          ? '<b class="' + (x.actualCfm < x.requiredCfm * 0.8 ? "bad" : x.actualCfm > x.requiredCfm * 1.6 ? "over" : "good") + '">' + fmt(x.actualCfm) + ' of ' + fmt(x.requiredCfm) + ' CFM</b>'
          : '<b>' + fmt(x.requiredCfm) + ' CFM needed</b>';
        return '<div class="rq-res' + cls + '">' +
          '<div class="rq-res-top"><span class="rq-res-name">' + escapeHtml(x.name) + '</span>' + air + '</div>' +
          '<div class="rq-bar"><div class="rq-bar-fill" data-w="' + Math.round(x.cooling / maxCool * 100) + '"></div></div>' +
          '<div class="rq-res-meta">' + fmt(x.cooling) + ' BTU/h · ' + x.btuPerSqFt + ' BTU/h per ft² · ' + x.area + ' ft² · ' + escapeHtml(x.orientationLabel) +
            (x.actualCfm != null && x.suppliesSuggested > (x.supplies || 0) ? ' · needs ' + x.suppliesSuggested + ' supplies' : "") + '</div>' +
          (x.flags.length ? '<div class="rq-flags">' + x.flags.map(function (f) {
            return '<div class="rq-flag ' + f.level + '">' + escapeHtml(f.text) + '</div>';
          }).join("") + '</div>' : "") +
        '</div>';
      }).join("");
      resultsHtml =
        '<div class="rq-results">' +
          '<div class="rq-summary">' + rr.totals.rooms + ' rooms · ' + fmt(rr.totals.area) + ' of ' + fmt(rr.totals.houseArea) + ' ft² (' + rr.totals.coveragePct + '% of the house) · ' + fmt(rr.totals.requiredCfm) + ' CFM apportioned</div>' +
          resRows +
          (rr.diagnosis.length ? '<div class="sq-talk rq-talk"><b>What to tell the customer</b>' + rr.diagnosis.map(function (l) { return '<p>' + escapeHtml(l) + '</p>'; }).join("") + '</div>' : "") +
          '<p class="sq-foot">' + escapeHtml(rr.disclosure) + '</p>' +
        '</div>';
    }

    return '' +
      '<div class="permit-card rq-card" id="roomCard">' +
        '<div class="hp-head"><span class="ico gold">' + roomIcon() + '</span>RoomIQ™ — room-by-room diagnosis<span class="permit-badge on">PRO</span></div>' +
        '<p class="hp-text">Enter the rooms and how many supply registers each one has. RoomIQ splits this home\'s load by each room\'s own glass, orientation and exposure, then shows which rooms are short of air. Rooms do not change the tonnage above; they explain it.</p>' +
        '<div class="adjust rq-form">' + rowsHtml +
          '<div class="rq-actions">' +
            '<button class="rq-add" id="rqAddBtn">+ Add room</button>' +
            (rooms.length ? '<button class="recalc rq-run" id="rqRunBtn">Diagnose rooms</button>' : "") +
          '</div>' +
          (rooms.length ? "" : '<p class="sq-foot">Start with the room the customer complains about, then add the rest. Four or five rooms is usually enough to find the problem.</p>') +
        '</div>' +
        resultsHtml +
      '</div>';
  }

  function selectHtml(id, val, opts) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      return '<option value="' + escapeAttr(String(o[0])) + '"' + (String(o[0]) === String(val) ? " selected" : "") + '>' + escapeHtml(o[1]) + '</option>';
    }).join("") + '</select>';
  }

  function wireRooms() {
    var add = $("#rqAddBtn");
    if (!add) return;
    function readRooms() {
      var rooms = roomsState();
      rooms.forEach(function (rm, i) {
        function v(id) { var el = $("#" + id + i); return el ? el.value : null; }
        function n(id) { var x = parseFloat(v(id)); return isFinite(x) ? x : null; }
        function chk(id) { var el = $("#" + id + i); return !!(el && el.checked); }
        var name = v("rqName");
        if (name != null) rm.name = String(name).slice(0, 40);
        rm.area = n("rqArea");
        rm.type = v("rqType") || rm.type;
        var walls = n("rqWalls"); rm.exteriorWalls = walls != null ? walls : rm.exteriorWalls;
        rm.orientation = v("rqOrient") || rm.orientation;
        rm.supplies = n("rqSup");
        rm.supplyCfm = n("rqCfm");
        rm.topFloor = chk("rqTop");
        rm.overUnconditioned = chk("rqUnder");
      });
    }
    add.addEventListener("click", function () {
      readRooms();   // never lose what's typed when another row is added
      var rooms = roomsState();
      // Second storey rooms are the ones with attic above, so default that on
      // once the house is known to have more than one floor and the obvious
      // ground-floor rooms are already entered.
      rooms.push({ name: "", area: null, type: rooms.length === 0 ? "living" : "bedroom", exteriorWalls: 1, orientation: "unknown", supplies: null, supplyCfm: null, topFloor: false, overUnconditioned: false });
      computeRooms();
      render();
      var el = $("#rqName" + (rooms.length - 1));
      if (el) { el.focus(); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
    var run = $("#rqRunBtn");
    if (run) run.addEventListener("click", function () {
      readRooms();
      thinkThen("Splitting the load room by room…", function () {
        computeRooms();
        render();
        var res = $(".rq-results");
        if (res) res.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    roomsState().forEach(function (rm, i) {
      var del = $("#rqDel" + i);
      if (del) del.addEventListener("click", function () {
        readRooms();
        roomsState().splice(i, 1);
        computeRooms();
        render();
      });
    });
  }

  // Printed room-by-room appendix — only once a diagnosis exists.
  function reportRooms() {
    var rr = state.roomResult;
    if (!rr || planTier() < 2) return "";
    var head = '<tr><th>Room</th><th>Area</th><th>Cooling</th><th>Heating</th><th>Air needed</th><th>Air now</th></tr>';
    var rows = rr.rooms.map(function (x) {
      return '<tr><td>' + escapeHtml(x.name) + '</td><td>' + fmt(x.area) + ' ft²</td><td>' + fmt(x.cooling) + '</td><td>' + fmt(x.heating) + '</td><td>' + fmt(x.requiredCfm) + ' CFM</td><td>' +
        (x.actualCfm != null ? fmt(x.actualCfm) + " CFM" : "—") + '</td></tr>';
    }).join("");
    var problems = rr.rooms.filter(function (x) { return x.worst === "severe" || x.worst === "warn"; });
    return '<div class="rp-block rp-rooms"><h2>Room-by-room diagnosis</h2>' +
      '<table class="rp-room-table">' + head + rows + '</table>' +
      (problems.length ? '<p class="rp-permit-note"><b>Rooms needing attention:</b> ' + problems.map(function (x) {
        return escapeHtml(x.name) + " (" + escapeHtml(x.flags[0].text) + ")";
      }).join(" ") + '</p>' : "") +
      '<p class="rp-disc" style="margin-top:6px">' + escapeHtml(rr.disclosure) + '</p>' +
    '</div>';
  }

  // ---------- Export / ServiceTitan hand-off ----------
  //
  // See job-export.js for why there is no "connect your ServiceTitan account"
  // button here: their API needs machine-to-machine secrets that cannot live
  // in a browser, and handing a third-party app your App Key is the tunneling
  // pattern ServiceTitan prohibits outright. These three routes are the ones
  // a contractor can actually use without breaking their own agreement.

  function exportCtx() {
    return {
      geo: state.geo, climate: state.climate, effective: state.effective,
      result: state.result, energy: state.energyResult, rebates: state.rebates,
      rooms: state.roomResult, jobType: jobType(), jobCustom: jobTypeCustom()
    };
  }

  function exportCard() {
    if (!state.result) return "";
    var s = loadSettings();
    var hook = s.webhookUrl || "";
    return '' +
      '<div class="permit-card ex-card" id="exportCard">' +
        '<div class="hp-head"><span class="ico">' + exportIcon() + '</span>Send this job to your system</div>' +
        '<p class="hp-text">Pricing and proposals stay in your quoting software. This sends the engineering — loads, tonnage, airflow, design conditions and any incentives found — so it lands on the job instead of being retyped.</p>' +
        '<div class="ex-btns">' +
          '<button class="ex-btn primary" id="exCopyText">Copy for ServiceTitan</button>' +
          '<button class="ex-btn" id="exCopyJson">Copy JSON</button>' +
          '<button class="ex-btn" id="exDownload">Download .json</button>' +
          (hook ? '<button class="ex-btn" id="exWebhook">Send to webhook</button>' : "") +
        '</div>' +
        '<p class="ex-foot">' + (hook
          ? 'Webhook configured in Settings. It posts the structured job to your own automation, which is where your ServiceTitan credentials belong.'
          : 'Paste the first one straight into a ServiceTitan job note, estimate description or task. For a hands-off hand-off, add an automation webhook (Zapier, Make, n8n) under Settings — ServiceTitan\'s API needs server-side credentials, and pasting an App Key into any third-party app is prohibited by their own integration rules.') + '</p>' +
      '</div>';
  }

  function exportIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>'; }

  function copyText(text, okMsg) {
    function fallback() {
      // Older iOS Safari and any non-secure context land here.
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var done = false;
      try { done = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      toast(done ? okMsg : "Couldn't copy — select the text manually");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }

  function wireExport() {
    var JX = window.JobExport;
    if (!JX || !$("#exportCard")) return;
    var copyBtn = $("#exCopyText");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      copyText(JX.toText(exportCtx()), "Job summary copied — paste it into ServiceTitan");
    });
    var jsonBtn = $("#exCopyJson");
    if (jsonBtn) jsonBtn.addEventListener("click", function () {
      copyText(JSON.stringify(JX.toJson(exportCtx()), null, 2), "JSON copied");
    });
    var dl = $("#exDownload");
    if (dl) dl.addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(JX.toJson(exportCtx()), null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = JX.fileName(exportCtx());
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Downloaded");
    });
    var hook = $("#exWebhook");
    if (hook) hook.addEventListener("click", function () {
      var s = loadSettings();
      var work = JX.sendWebhook(s.webhookUrl, exportCtx());
      if (window.Thinking) work = window.Thinking.during("Sending to your automation…", work);
      work.then(function () { toast("Sent to your webhook"); })
          .catch(function (e) { toast(e && e.message ? e.message : "Send failed"); });
    });
  }

  // ---------- Job type: what the homeowner actually wants installed ----------
  //
  // Chosen before the calculation and carried with it, because it changes
  // three things: whether duct losses apply at all, which Manual S stage
  // family the sizing uses, and — most of all — which incentive programs
  // exist for this work. Incentives are organised by measure, so a duct-only
  // job and a mini-split job share almost no programs.
  //
  // Both ways in are supported: tap a chip, or type it. Typing matters on a
  // phone in a driveway, where scrolling thirty options is slower than typing
  // "mini split".

  var JOB_KEY = "lmp_job_v1";

  function jobTypeId() {
    var id = state.jobType;
    if (id && window.JobTypes && window.JobTypes.get(id)) return id;
    return window.JobTypes ? window.JobTypes.DEFAULT_ID : "ac-furnace-96";
  }
  function jobTypeCustom() { return state.jobCustom || ""; }
  function jobType() { return window.JobTypes ? window.JobTypes.get(jobTypeId()) : null; }

  // The last job type is remembered on the device: a shop that installs mainly
  // heat pumps should not re-pick "heat pump" on every single call.
  function loadLastJobType() {
    try {
      var raw = JSON.parse(localStorage.getItem(JOB_KEY));
      if (raw && raw.id && window.JobTypes && window.JobTypes.get(raw.id)) {
        state.jobType = raw.id;
        state.jobCustom = typeof raw.custom === "string" ? raw.custom : "";
      }
    } catch (e) {}
  }
  function saveLastJobType() {
    try { localStorage.setItem(JOB_KEY, JSON.stringify({ id: jobTypeId(), custom: jobTypeCustom() })); } catch (e) {}
  }

  // A short, common set shown as chips. The rest are reachable by typing, so
  // the driveway case stays one tap without hiding the long tail.
  var JOB_QUICK = ["ac-furnace-96", "hp-variable", "minisplit-single", "ac-furnace-80", "hp-standard", "duct-replace", "duct-seal", "furnace-only-96", "ac-only"];

  function renderJobPicker() {
    var JT = window.JobTypes;
    if (!JT || !$("#jobChips")) return;
    var cur = jobTypeId();
    $("#jobChips").innerHTML = JOB_QUICK.map(function (id) {
      var t = JT.get(id);
      return t ? '<button type="button" class="job-chip' + (id === cur ? " on" : "") + '" data-job="' + id + '">' + escapeHtml(t.short) + '</button>' : "";
    }).join("") + '<button type="button" class="job-chip more" id="jobMoreBtn">All job types…</button>';

    var t = JT.get(cur);
    $("#jobChosen").innerHTML = t
      ? '<div class="job-chosen"><b>' + escapeHtml(t.label) + '</b><span>' + escapeHtml(t.blurb) + '</span>' +
        (t.note ? '<span class="job-note">' + escapeHtml(t.note) + '</span>' : "") +
        (jobTypeCustom() ? '<span class="job-custom">Your note: ' + escapeHtml(jobTypeCustom()) + '</span>' : "") + '</div>'
      : "";
  }

  function renderJobSuggest(q) {
    var JT = window.JobTypes, box = $("#jobSuggest");
    if (!JT || !box) return;
    var hits = JT.search(q);
    if (!hits.length) { box.innerHTML = ""; box.classList.remove("open"); return; }
    box.innerHTML = hits.map(function (t) {
      return '<button type="button" class="job-sg" data-job="' + t.id + '"><b>' + escapeHtml(t.label) + '</b><span>' + escapeHtml(t.blurb) + '</span></button>';
    }).join("");
    box.classList.add("open");
  }

  function chooseJob(id, opts) {
    var JT = window.JobTypes;
    if (!JT || !JT.get(id)) return;
    state.jobType = id;
    // Anything typed that did not resolve to a type is still worth keeping —
    // it goes to the incentive search verbatim, where "swamp cooler swap" may
    // be exactly the phrase that finds the program.
    if (opts && typeof opts.custom === "string") state.jobCustom = opts.custom;
    saveLastJobType();
    var box = $("#jobSuggest");
    if (box) { box.innerHTML = ""; box.classList.remove("open"); }
    var inp = $("#jobSearch");
    if (inp) inp.value = "";
    renderJobPicker();
    // A job type picked after a calculation changes the answer, so redo it.
    if (state.result) {
      thinkThen("Applying the job type…", function () {
        compute();
        render();
      });
    }
  }

  function openJobSheet() {
    var JT = window.JobTypes;
    if (!JT) return;
    var cur = jobTypeId();
    var groups = JT.byCategory().map(function (c) {
      return '<div class="job-cat">' + escapeHtml(c.label) + '</div>' +
        c.types.map(function (t) {
          return '<button type="button" class="job-row' + (t.id === cur ? " on" : "") + '" data-job="' + t.id + '">' +
            '<b>' + escapeHtml(t.label) + '</b><span>' + escapeHtml(t.blurb) + '</span></button>';
        }).join("");
    }).join("");
    $("#settingsRoot").innerHTML =
      '<div class="overlay" id="overlay"><div class="sheet job-sheet">' +
        '<div class="grab"></div>' +
        '<h3>What is this job?</h3>' +
        '<p class="sub">This sets the duct assumption, the sizing family, and — most of all — which rebate and grant programs are searched for.</p>' +
        '<div class="job-list">' + groups + '</div>' +
        '<label>Anything unusual about it?</label>' +
        '<input type="text" id="jobCustomIn" value="' + escapeAttr(jobTypeCustom()) + '" placeholder="e.g. replacing a swamp cooler, two systems, crawlspace only" />' +
        '<p class="sub">Sent word-for-word to the rebate search, which sometimes finds a program the categories miss.</p>' +
        '<button class="close" id="jobSheetClose">Done</button>' +
      '</div></div>';
    var overlay = $("#overlay");
    function close() {
      var cin = $("#jobCustomIn");
      if (cin) { state.jobCustom = cin.value.trim().slice(0, 200); saveLastJobType(); }
      $("#settingsRoot").innerHTML = "";
      renderJobPicker();
    }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    $("#jobSheetClose").addEventListener("click", close);
    overlay.querySelectorAll("[data-job]").forEach(function (b) {
      b.addEventListener("click", function () {
        var cin = $("#jobCustomIn");
        var custom = cin ? cin.value.trim().slice(0, 200) : jobTypeCustom();
        $("#settingsRoot").innerHTML = "";
        chooseJob(b.getAttribute("data-job"), { custom: custom });
      });
    });
  }

  function wireJobPicker() {
    var inp = $("#jobSearch");
    if (inp) {
      inp.addEventListener("input", function () { renderJobSuggest(inp.value); });
      inp.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        var JT = window.JobTypes;
        var hits = JT ? JT.search(inp.value) : [];
        // Typed something the catalogue doesn't know? Keep the words rather
        // than discarding them — they still steer the incentive search.
        if (hits.length) chooseJob(hits[0].id);
        else if (inp.value.trim()) { chooseJob("other", { custom: inp.value.trim() }); }
      });
      inp.addEventListener("blur", function () {
        setTimeout(function () {
          var box = $("#jobSuggest");
          if (box) { box.innerHTML = ""; box.classList.remove("open"); }
        }, 200);
      });
    }
    var pick = $("#jobPick");
    if (pick) pick.addEventListener("click", function (e) {
      var more = e.target.closest("#jobMoreBtn");
      if (more) { openJobSheet(); return; }
      var b = e.target.closest("[data-job]");
      if (b) chooseJob(b.getAttribute("data-job"));
    });
    renderJobPicker();
  }

  // The chosen job, shown with the results so the number on screen is never
  // read without the job it was calculated for.
  function jobTypeCard() {
    var t = jobType();
    if (!t) return "";
    return '<div class="job-banner">' +
      '<span class="job-banner-k">Job</span>' +
      '<b>' + escapeHtml(t.label) + '</b>' +
      (t.ducted === false ? '<span class="job-tag">no duct losses</span>' : "") +
      (t.needsLoad === false ? '<span class="job-tag warn">sized per room, not whole-house</span>' : "") +
      '<button type="button" class="job-change" id="jobChangeBtn">Change</button>' +
      '</div>';
  }

  // Marks the one sizing family the chosen job actually belongs to, so the
  // printed table reads as an answer with alternates rather than four
  // equally-weighted options a homeowner has to arbitrate.
  function recMark(key) {
    var job = jobType();
    if (!job) return "";
    var row = job.systemType || (job.fuel === "heat-pump" || job.fuel === "geothermal" ? "hp" : null);
    return row === key ? ' <b class="rp-rec-this">&larr; this job</b>' : "";
  }

  // The job on the printed report. The loads on page one were calculated for a
  // specific installation, and a report that omits which one invites the sizes
  // being carried onto a different job entirely.
  function reportJobLine() {
    var t = jobType();
    if (!t) return "";
    var note = jobTypeCustom();
    return '<div class="rp-job"><b>Job:</b> ' + escapeHtml(t.label) +
      (t.ducted === false ? ' · ductless — no duct losses applied' : "") +
      (note ? ' · ' + escapeHtml(note) : "") + '</div>';
  }

  // ---------- EnergyIQ (Pro/Fleet + trial): operating cost & right-size check ----------
  //
  // This deliberately stops short of being a quoting tool. It carries no
  // prices, no financing and no proposal: shops already run ServiceTitan or
  // similar for that, and a second place to type prices is a second place for
  // them to be wrong. What it does is the part a pricing tool cannot do —
  // establish, from this home's own load and its own year of weather, what the
  // existing system costs to run, whether it was ever the right size, and what
  // each efficiency level would cost instead. That is the engineering case the
  // quote gets attached to.

  var ENERGY_TIERS = [
    { key: "good", label: "Standard", sub: "Single-stage", systemType: "single", seer2: 14.3, afue: 0.80, hspf2: 7.5 },
    { key: "better", label: "High-efficiency", sub: "Two-stage", systemType: "two", seer2: 16.0, afue: 0.96, hspf2: 8.5 },
    { key: "best", label: "Premium", sub: "Variable-capacity", systemType: "variable", seer2: 18.0, afue: 0.96, hspf2: 9.5 }
  ];
  var EXISTING_HEAT_LABEL = { furnace: "Gas furnace", hp: "Heat pump", resistance: "Electric strips / baseboard", none: "No central heat" };

  // The job type already says what is being installed, so there is no separate
  // fuel picker to get out of step with it.
  function energyFuel() {
    var jt = window.JobTypes && window.JobTypes.get(jobTypeId());
    if (!jt) return "furnace";
    if (jt.fuel === "heat-pump" || jt.fuel === "geothermal") return "hp";
    if (jt.fuel === "dual-fuel") return "dualfuel";
    if (jt.fuel === "electric-resistance") return "resistance";
    return "furnace";
  }

  function energyDefaults() {
    var g = state.geo || {};
    var rates = window.EnergyEngine.ratesForState(g.state);
    return {
      existing: { tons: null, year: null, heatType: "furnace", seer: null, afue: null, hspf: null },
      rates: { kwh: rates.kwh, therm: rates.therm, source: rates.national ? "national" : rates.state }
    };
  }
  function energyState() {
    if (!state.overrides.energy) state.overrides.energy = energyDefaults();
    return state.overrides.energy;
  }

  function computeEnergy() {
    var r = state.result, c = state.climate;
    var EE = window.EnergyEngine;
    if (!r || !c || !EE) { state.energyResult = null; return; }
    var s = energyState();
    var fuel = energyFuel();
    var bins = c.tempBins || EE.syntheticBins(c.heating99, c.cooling1);
    var binsLive = !!c.tempBins;
    var base = {
      bins: bins, coolingBtu: r.cooling.total, cooling1: c.cooling1,
      heatingBtu: r.heating.total, heating99: c.heating99, indoorHeat: 70,
      rates: { kwh: s.rates.kwh, therm: s.rates.therm }
    };
    var nowYear = new Date().getFullYear();

    // --- the customer's current system ---
    var ex = s.existing, existing = null;
    if (ex.tons > 0) {
      var seer = ex.seer > 0 ? ex.seer : EE.seerFromYear(ex.year);
      var derate = EE.ageDerate(ex.year, nowYear);
      var sys = {
        coolType: ex.heatType === "hp" ? "hp" : "ac",
        seer2: EE.seerToSeer2(seer) * derate, tons: ex.tons, systemType: "single",
        heatType: ex.heatType || "furnace",
        afue: ex.afue > 0 ? ex.afue : EE.afueFromYear(ex.year),
        hspf2: EE.hspfToHspf2(ex.hspf > 0 ? ex.hspf : EE.hspfFromYear(ex.year)) * derate
      };
      var energy = EE.annualEnergy(Object.assign({}, base, { system: sys }));
      var age = ex.year > 1900 ? nowYear - ex.year : null;
      var life = EE.TYPICAL_LIFE_YEARS[ex.heatType === "hp" ? "hp" : "ac"];
      existing = {
        tons: ex.tons, year: ex.year, age: age, seer: Math.round(seer * 10) / 10, seerAssumed: !(ex.seer > 0),
        derate: derate, heatType: sys.heatType, afue: sys.afue, energy: energy,
        // Compared against the calculated LOAD (not the size the app would
        // select), with the Manual J SHR passed through so a dry climate's
        // additive allowance applies here exactly as it does in the sizing
        // engine — otherwise the report could select a size it also calls
        // oversized.
        rightSize: EE.rightSize(ex.tons, r.cooling.total / 12000, "single", r.shr && r.shr.shr),
        lifeNote: age == null ? null : age >= life
          ? "At " + age + " years this unit is past the ~" + life + "-year typical service life; a failure in peak season is the realistic risk."
          : "At " + age + " years this unit has roughly " + (life - age) + " years of typical service life left."
      };
    }

    var options = ENERGY_TIERS.map(function (d) {
      var tons = r.sizing[d.systemType];
      var sys = {
        coolType: fuel === "furnace" || fuel === "resistance" ? "ac" : "hp",
        seer2: d.seer2, tons: tons, systemType: d.systemType,
        heatType: fuel, afue: d.afue, hspf2: d.hspf2,
        furnaceOutputBtu: r.equipment.furnaceOutput
      };
      var energy = EE.annualEnergy(Object.assign({}, base, { system: sys }));
      return {
        key: d.key, label: d.label, sub: d.sub, systemType: d.systemType, tons: tons,
        seer2: d.seer2, afue: d.afue, hspf2: d.hspf2, energy: energy,
        savingsPerYear: existing ? existing.energy.totalCost - energy.totalCost : null
      };
    });

    /*
     * Which sides of the system this job actually installs. A furnace-only job
     * should not have its tiers labelled by SEER2. And a job that installs no
     * heating or cooling equipment at all — ducts, insulation, a thermostat —
     * still gets the tiers, because they are the yardstick that justifies the
     * work, but they must not read as options being quoted.
     */
    var jt = jobType();
    var doesCooling = !jt || jt.cooling !== false;
    var doesHeating = !jt || jt.heating !== false;
    state.energyResult = {
      existing: existing, options: options, fuel: fuel, binsLive: binsLive, rates: s.rates,
      doesCooling: doesCooling, doesHeating: doesHeating,
      installsEquipment: doesCooling || doesHeating,
      jobLabel: jt ? jt.label : ""
    };
  }

  function money(n) {
    var v = Math.round(n || 0);
    return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US");
  }
  function energyIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h8l-1 8 10-12h-8z"/></svg>'; }

  /*
   * The efficiency figure a tier is actually bought on. A furnace-only job is
   * sold on AFUE, a heat pump on HSPF2, a cooling change-out on SEER2 — a
   * SEER2 number on a furnace-only quote is noise the rep has to explain away.
   */
  function effLabel(er, o) {
    // A job installing neither side is being measured against a whole system,
    // so it gets both metrics rather than an arbitrary one.
    var both = !er.doesCooling && !er.doesHeating;
    var parts = [];
    if (er.doesCooling || both) parts.push(o.seer2 + " SEER2");
    if (er.doesHeating || both) {
      if (er.fuel === "hp" || er.fuel === "dualfuel") parts.push(o.hspf2 + " HSPF2");
      if (er.fuel === "furnace" || er.fuel === "dualfuel") parts.push(Math.round(o.afue * 100) + "% AFUE");
    }
    return parts.length ? parts.join(" · ") : o.seer2 + " SEER2";
  }

  function energyCard() {
    if (planTier() < 2) {
      var cta = planTier() === 0
        ? '<a class="permit-cta" href="auth.html#signup">Start free trial — unlock EnergyIQ</a>'
        : '<a class="permit-cta" href="index.html#pricing">Upgrade to Pro — unlock EnergyIQ</a>';
      return '' +
        '<div class="permit-card locked">' +
          '<div class="hp-head"><span class="ico gold">' + lockIcon() + '</span>EnergyIQ™ — running cost &amp; right-size<span class="permit-badge">PRO</span></div>' +
          '<p class="hp-text">Show what the customer\'s current unit costs to run, whether it was ever the right size for this house, and what each efficiency level would cost instead — from this home\'s own load and its own year of weather.</p>' +
          '<div class="permit-teaser"><div class="tz-row"></div><div class="tz-row w70"></div><div class="tz-row w85"></div><div class="tz-row w60"></div></div>' +
          cta +
        '</div>';
    }
    var s = energyState(), er = state.energyResult, r = state.result;
    if (!er) return "";
    var ex = s.existing;
    function num(id, val, attrs, ph) {
      return '<input type="number" id="' + id + '" ' + (attrs || "") + ' value="' + (val != null ? val : "") + '"' + (ph ? ' placeholder="' + escapeAttr(ph) + '"' : "") + ' />';
    }
    function sel(id, val, opts) {
      return '<select id="' + id + '">' + opts.map(function (o) { return '<option value="' + escapeAttr(String(o[0])) + '"' + (String(o[0]) === String(val) ? " selected" : "") + '>' + escapeHtml(o[1]) + '</option>'; }).join("") + '</select>';
    }
    var tonsOpts = [["", "Not sure"]].concat([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6].map(function (t) { return [t, t + " ton"]; }));

    var exHtml = "";
    if (er.existing) {
      var e2 = er.existing, rs = e2.rightSize;
      var verdictCls = rs ? (rs.verdict === "right-sized" ? "ok" : rs.verdict === "undersized" ? "warn" : "bad") : "";
      exHtml =
        '<div class="sq-existing">' +
          '<div class="sq-ex-head">Customer\'s current system<span class="sq-ex-cost">' + money(e2.energy.totalCost) + '<em>/yr to run</em></span></div>' +
          (rs ? '<div class="sq-verdict ' + verdictCls + '"><b>' + rs.pct + '% of the calculated load — ' + rs.verdict + '.</b> ' + escapeHtml(rs.message) + '</div>' : "") +
          '<div class="sq-ex-meta">' + e2.tons + '-ton ' + (e2.heatType === "hp" ? "heat pump" : "A/C") + (e2.year ? ' installed ' + e2.year : "") +
            ' · ~' + e2.seer + ' SEER' + (e2.seerAssumed ? ' (typical for its age)' : "") +
            (e2.derate < 1 ? ', running ~' + Math.round((1 - e2.derate) * 100) + '% below nameplate from age' : "") +
            ' · ' + EXISTING_HEAT_LABEL[e2.heatType] + (e2.heatType === "furnace" ? ' ' + Math.round(e2.afue * 100) + '% AFUE' : "") +
            ' · cooling ' + money(e2.energy.cooling.cost) + ' + heating ' + money(e2.energy.heating.cost) + ' per year' +
            (e2.lifeNote ? '<br/>' + escapeHtml(e2.lifeNote) : "") +
          '</div>' +
        '</div>';
    }

    var haveExisting = !!er.existing;
    var resultCols = er.options.map(function (o) {
      return '<div class="sq-res-col ' + o.key + '">' +
        '<div class="sq-res-name">' + o.label + '<span>' + o.sub + ' · ' + o.tons + ' ton</span></div>' +
        '<div class="sq-res-headline">' + money(o.energy.totalCost) + '<em>/yr</em></div>' +
        '<div class="eq-row"><span>Efficiency</span><b>' + effLabel(er, o) + '</b></div>' +
        (haveExisting ? '<div class="eq-row"><span>vs. current</span><b class="' + (o.savingsPerYear > 0 ? "good" : "bad") + '">' + (o.savingsPerYear >= 0 ? "saves " : "costs ") + money(Math.abs(o.savingsPerYear)) + '/yr</b></div>' : "") +
        '<div class="eq-row"><span>Cooling</span><b>' + money(o.energy.cooling.cost) + '/yr</b></div>' +
        '<div class="eq-row"><span>Heating</span><b>' + money(o.energy.heating.cost) + '/yr</b></div>' +
        (o.energy.heating.switchoverF != null ? '<div class="eq-row"><span>Furnace takes over</span><b>below ' + o.energy.heating.switchoverF + '°F</b></div>' : "") +
        (er.fuel === "hp" && o.energy.heating.auxKwh > 0 ? '<div class="eq-row"><span>Backup strips</span><b>' + fmt(o.energy.heating.auxKwh) + ' kWh/yr</b></div>' : "") +
      '</div>';
    }).join("");

    var noEquipNote = er.installsEquipment === false
      ? '<p class="sq-hint sq-yardstick">' + escapeHtml(er.jobLabel) + ' installs no equipment, so the three levels below are a yardstick for this house, not options you are quoting. The number that matters here is the current system\'s running cost above.</p>'
      : "";

    var talk = energyTalkTrack(er);
    var ratesNote = er.rates.source === "national"
      ? "Rates are a national average — enter the customer's actual bill rates."
      : "Rates start from a typical " + er.rates.source + " average — enter the customer's actual bill rates for a tighter number.";

    return '' +
      '<div class="permit-card sq-card" id="energyCard">' +
        '<div class="hp-head"><span class="ico gold">' + energyIcon() + '</span>EnergyIQ™ — running cost &amp; right-size<span class="permit-badge on">PRO</span></div>' +
        '<p class="hp-text">Running costs come from this home\'s calculated load run through ' + (er.binsLive ? 'a full year of on-site hourly weather' : 'a temperature profile estimated from the design conditions') + ' (bin method), with each unit\'s efficiency evaluated at the outdoor temperature it actually runs at. No prices here by design — this is the engineering case your quote attaches to.</p>' +

        '<div class="adjust sq-form">' +
          '<div class="sq-section">Customer\'s current system</div>' +
          '<div class="adjust-row">' +
            '<div><label>Cooling size</label>' + sel("eqExTons", ex.tons, tonsOpts) + '</div>' +
            '<div><label>Year installed</label>' + num("eqExYear", ex.year, 'min="1970" max="2030" step="1"', "e.g. 2008") + '</div>' +
          '</div>' +
          '<div class="adjust-row">' +
            '<div><label>Heating</label>' + sel("eqExHeat", ex.heatType, Object.keys(EXISTING_HEAT_LABEL).map(function (k) { return [k, EXISTING_HEAT_LABEL[k]]; })) + '</div>' +
            '<div><label>SEER (nameplate, optional)</label>' + num("eqExSeer", ex.seer, 'min="6" max="30" step="0.5"', "blank = typical for its age") + '</div>' +
          '</div>' +
          '<div class="adjust-row">' +
            '<div><label>Furnace AFUE (optional)</label>' + num("eqExAfue", ex.afue, 'min="0.5" max="0.99" step="0.01"', "blank = 80%") + '</div>' +
            '<div><label>Heat pump HSPF (optional)</label>' + num("eqExHspf", ex.hspf, 'min="5" max="14" step="0.1"', "blank = typical") + '</div>' +
          '</div>' +

          '<div class="sq-section">Utility rates <span class="sq-hint">' + escapeHtml(ratesNote) + '</span></div>' +
          '<div class="adjust-row">' +
            '<div><label>Electricity ($/kWh)</label>' + num("eqKwh", Math.round(s.rates.kwh * 1000) / 1000, 'min="0.03" max="1" step="0.001"') + '</div>' +
            '<div><label>Natural gas ($/therm)</label>' + num("eqTherm", Math.round(s.rates.therm * 100) / 100, 'min="0.3" max="10" step="0.01"') + '</div>' +
          '</div>' +
          '<button class="recalc" id="energyRunBtn">Update running costs</button>' +
        '</div>' +

        '<div class="sq-results" id="energyResults">' +
          exHtml +
          noEquipNote +
          '<div class="sq-res-grid">' + resultCols + '</div>' +
          (talk ? '<div class="sq-talk"><b>Talk track</b>' + talk + '</div>' : "") +
          '<p class="sq-foot">' + (haveExisting ? "" : "Add the customer's current unit above to see what they're paying now and whether it's the right size. ") +
            'Running costs are an engineering estimate for comparing options on this house at the rates above — not a bill guarantee. Pricing, financing and the proposal itself belong in your quoting software; this page is the load and energy case behind it.</p>' +
        '</div>' +
      '</div>';
  }

  // Plain-English sentences, each emitted only when the numbers back it —
  // including the ones that cut against an upsell, because a rep caught
  // overstating loses the job.
  function energyTalkTrack(er) {
    var lines = [];
    var ex = er.existing, opts = er.options;
    if (ex) {
      var rs = ex.rightSize;
      if (rs && rs.verdict !== "right-sized") {
        lines.push(rs.verdict === "undersized"
          ? "Your current " + ex.tons + "-ton unit is undersized for this house — that isn't a maintenance problem, it's a capacity problem, and a bigger unit of the same efficiency would fix comfort but not the bill."
          : "Your current " + ex.tons + "-ton unit is " + rs.pct + "% of what this house actually needs. Oversized systems cool the thermostat fast and shut off before they dry the air, which is why the house can feel cold and sticky at the same time — and short-cycling like that is hard on compressors.");
      }
      var best = opts.reduce(function (a, b) { return b.energy.totalCost < a.energy.totalCost ? b : a; });
      if (best.savingsPerYear > 100) {
        lines.push("You're spending about " + money(ex.energy.totalCost) + " a year to heat and cool this house now. The " + best.label.toLowerCase() + " option runs it for about " + money(best.energy.totalCost) + " — roughly " + money(best.savingsPerYear) + " a year back in your pocket, at today's rates.");
      }
      if (ex.lifeNote && ex.age != null && ex.age >= 12) lines.push(ex.lifeNote + " Replacing on your schedule instead of the unit's means you choose the price and the week.");
    }
    if (er.fuel === "hp") {
      var strips = opts.filter(function (o) { return o.energy.heating.auxKwh > 0.25 * o.energy.heating.kwh; });
      if (strips.length === opts.length) lines.push("In this climate an all-electric heat pump sized for cooling leans heavily on backup strips in winter — worth pricing the dual-fuel version alongside it.");
    }
    return lines.length ? lines.map(function (l) { return '<p>' + escapeHtml(l) + '</p>'; }).join("") : "";
  }

  /*
   * Reads the current-system and rate fields into state.
   *
   * This runs on every edit, not only when the button is pressed, and that
   * matters: the whole results page re-renders whenever anything else
   * finishes — a photo analysis, a rebate search, a job-type change — and
   * these fields are rebuilt from state each time. Reading them only on the
   * button press meant a rep could type the customer's unit in, have a
   * background job land, and watch the entries silently disappear.
   */
  function readEnergyInputs() {
    var s = energyState();
    function numVal(id) { var el = $("#" + id); if (!el) return null; var v = parseFloat(el.value); return isFinite(v) ? v : null; }
    var tonsEl = $("#eqExTons");
    if (tonsEl) s.existing.tons = tonsEl.value ? parseFloat(tonsEl.value) : null;
    if ($("#eqExYear")) { var y = numVal("eqExYear"); s.existing.year = (y >= 1900 && y <= 2100) ? Math.round(y) : null; }
    var heatEl = $("#eqExHeat");
    if (heatEl) s.existing.heatType = heatEl.value;
    if ($("#eqExSeer")) s.existing.seer = numVal("eqExSeer");
    if ($("#eqExAfue")) s.existing.afue = numVal("eqExAfue");
    if ($("#eqExHspf")) s.existing.hspf = numVal("eqExHspf");
    var kwh = numVal("eqKwh"), therm = numVal("eqTherm");
    if (kwh > 0) s.rates.kwh = kwh;
    if (therm > 0) s.rates.therm = therm;
    return s;
  }

  function wireEnergy() {
    var btn = $("#energyRunBtn");
    if (!btn) return;
    var form = btn.closest(".sq-form");
    if (form) {
      // change covers the selects and a committed number; input covers typing,
      // so a re-render mid-keystroke keeps what is already there.
      form.addEventListener("change", readEnergyInputs);
      form.addEventListener("input", readEnergyInputs);
    }
    btn.addEventListener("click", function () {
      readEnergyInputs();
      thinkThen("Working out running costs…", function () {
        computeEnergy();
        render();
        var card = $("#energyResults");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  // Printed running-cost block. Still no prices — the quote travels separately.
  function reportEnergy() {
    var er = state.energyResult;
    if (!er || planTier() < 2) return "";
    if (!er.existing) return "";
    var head = '<tr><th></th>' + er.options.map(function (o) { return '<th>' + o.label + '<br/><small>' + o.sub + ' · ' + o.tons + ' ton</small></th>'; }).join("") + '</tr>';
    function row(label, fn) { return '<tr><td>' + label + '</td>' + er.options.map(function (o) { return '<td>' + fn(o) + '</td>'; }).join("") + '</tr>'; }
    return '<div class="rp-block rp-proposal"><h2>Running cost by efficiency level</h2>' +
      (er.installsEquipment === false
        ? '<p class="rp-permit-note">This job installs no equipment, so the levels below are a yardstick for what the house would cost to heat and cool with each — not options being quoted.</p>'
        : "") +
      '<p class="rp-permit-note"><b>Current system:</b> ' + er.existing.tons + '-ton ' + (er.existing.heatType === "hp" ? "heat pump" : "A/C") + (er.existing.year ? " installed " + er.existing.year : "") +
        ', ~' + er.existing.seer + ' SEER · estimated ' + money(er.existing.energy.totalCost) + '/yr to run' +
        (er.existing.rightSize ? ' · ' + er.existing.rightSize.pct + '% of calculated load (' + er.existing.rightSize.verdict + ')' : "") + '</p>' +
      '<table class="rp-prop-table">' + head +
        row("Efficiency", function (o) { return effLabel(er, o); }) +
        row("Estimated annual running cost", function (o) { return money(o.energy.totalCost); }) +
        row("Saving vs. current system", function (o) { return (o.savingsPerYear >= 0 ? "" : "−") + money(Math.abs(o.savingsPerYear)) + "/yr"; }) +
      '</table>' +
      '<p class="rp-disc" style="margin-top:6px">Running costs are an engineering estimate from this home\'s calculated load and ' + (er.binsLive ? 'a year of on-site hourly weather' : 'a temperature profile estimated from local design conditions') + ' at $' + er.rates.kwh.toFixed(3) + '/kWh and $' + er.rates.therm.toFixed(2) + '/therm, for comparing options against each other. Actual bills depend on thermostat settings, occupancy, duct condition and future utility rates. Equipment pricing is quoted separately.</p>' +
    '</div>';
  }

  // ---------- History (saved jobs, on-device) ----------
  var HISTORY_KEY = "lmp_history_v1";
  var activeHistoryId = null;
  function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { return []; } }
  function saveActiveToHistory() {
    var r = state.result, c = state.climate, e = state.effective, g = state.geo;
    var list = loadHistory();
    var entry = {
      id: activeHistoryId || ("j" + Date.now()),
      ts: Date.now(),
      address: shortAddr(g.label),
      city: c.city,
      area: e.area,
      heating: r.heating.total,
      cooling: r.cooling.total,
      tons: r.recommendedTons,
      snap: { geo: g, climate: c, property: state.property, overrides: state.overrides }
    };
    if (activeHistoryId) list = list.filter(function (x) { return x.id !== activeHistoryId; });
    activeHistoryId = entry.id;
    list.unshift(entry);
    if (list.length > 24) list = list.slice(0, 24);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    renderHistory();
  }
  function deleteHistory(id, ev) {
    if (ev) ev.stopPropagation();
    var list = loadHistory().filter(function (x) { return x.id !== id; });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    renderHistory();
  }
  function renderHistory() {
    var host = $("#history");
    if (!host) return;
    var list = loadHistory();
    var onHome = $("#results").classList.contains("hidden");
    if (!list.length || !onHome) { host.innerHTML = ""; return; }
    var rows = list.slice(0, 8).map(function (j) {
      return '<button class="hist-item" data-id="' + j.id + '">' +
          '<div class="hist-pin"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div>' +
          '<div class="hist-main"><b>' + escapeHtml(j.address.split(",")[0]) + '</b>' +
          '<span>' + escapeHtml(j.city) + ' · ' + fmt(j.area) + ' ft²</span></div>' +
          '<div class="hist-tons">' + j.tons + '<small>tons</small></div>' +
          '<span class="hist-del" data-del="' + j.id + '" aria-label="Delete">×</span>' +
        '</button>';
    }).join("");
    host.innerHTML = '<div class="hist-head"><h3>Recent jobs</h3><button class="hist-clear" id="histClear">Clear</button></div>' +
                     '<div class="hist-list">' + rows + '</div>';
    host.querySelectorAll(".hist-item").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        var del = ev.target.closest("[data-del]");
        if (del) { deleteHistory(del.getAttribute("data-del"), ev); return; }
        reopenJob(b.getAttribute("data-id"));
      });
    });
    var hc = $("#histClear");
    if (hc) hc.addEventListener("click", function () { localStorage.removeItem(HISTORY_KEY); renderHistory(); });
  }
  function reopenJob(id) {
    var j = loadHistory().filter(function (x) { return x.id === id; })[0];
    if (!j || !j.snap) { if (j) { $("#address").value = j.address; run(j.address); } return; }
    activeHistoryId = j.id;
    state.geo = j.snap.geo; state.climate = j.snap.climate;
    state.property = j.snap.property; state.overrides = j.snap.overrides || {};
    // Photos and AI photo adjustments are session-only and belong to one
    // property — never carry them into a reopened job.
    state.photos = []; state.photoAI = null; state.photoBusy = false;
    $("#address").value = j.address;
    clearError();
    thinkThen("Reopening this job…", function () {
      compute();
      render();
    });
  }

  // ---------- Share ----------
  function shareResult() {
    var r = state.result, c = state.climate, g = state.geo, e = state.effective;
    var text = "HVAC Load Estimate — " + shortAddr(g.label) + "\n" +
      "• Heating: " + fmt(r.heating.total) + " BTU/h\n" +
      "• Cooling: " + fmt(r.cooling.total) + " BTU/h (" + r.recommendedTons + " tons)\n" +
      "• Climate: " + c.city + " (" + c.cooling1 + "°F / " + c.heating99 + "°F design)\n" +
      "• Conditioned area: " + fmt(e.area) + " ft²\n" +
      "Prepared with LoadMaster Pro AI";
    if (navigator.share) {
      navigator.share({ title: "HVAC Load Estimate", text: text }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Summary copied to clipboard"); });
    } else { toast("Sharing isn't supported on this device"); }
  }

  // ---------- Branded report (print / save as PDF) ----------
  // opts.permit=true appends the PermitIQ requirements + submission checklist,
  // turning the report into a permit-application package.
  function generateReport(opts) {
    opts = opts || {};
    var r = state.result, c = state.climate, e = state.effective, g = state.geo, p = state.property;
    var s = loadSettings();
    var qualityLabel = { good: "Well insulated", average: "Average construction", poor: "Older / leaky" }[e.quality];
    var foundationLabel = { slab: "Slab", crawl: "Crawl space", basement: "Basement" }[e.foundation] || e.foundation;
    var sunLabel = { low: "Shaded", average: "Average", high: "Sunny" }[e.sun] || e.sun;
    var ductTypeLabel = { attic: "Ducted — in attic", "conditioned-space": "Ducted — in conditioned space", crawlspace: "Ducted — in crawlspace", ductless: "Ductless / mini-split" }[e.ductType] || e.ductType;
    var ductConditionLabel = { sealed: "Sealed & insulated", unsealed: "Unsealed / uninsulated" }[e.ductCondition] || e.ductCondition;
    var date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    var company = s.company || "LoadMaster Pro AI";
    var contact = [s.phone, s.email].filter(Boolean).join("  •  ");
    var license = s.license ? "License " + s.license : "";
    var logo = s.logo
      ? '<img class="rp-logo" src="' + s.logo + '" alt="logo"/>'
      : '<div class="rp-logo rp-logo-fallback">' + escapeHtml(initials(company)) + '</div>';

    var cb = r.cooling.breakdown;
    var html =
      '<div class="rp-toolbar">' +
        '<button id="rpCloseBtn">Close</button>' +
        '<button class="primary" id="rpPrintBtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>Print / Save PDF</button>' +
      '</div>' +
      '<div class="rp">' +
        '<header class="rp-head">' +
          '<div class="rp-brand">' + logo + '<div class="rp-co"><b>' + escapeHtml(company) + '</b>' +
            (contact ? '<span>' + escapeHtml(contact) + '</span>' : '') +
            (license ? '<span>' + escapeHtml(license) + '</span>' : '') + '</div></div>' +
          '<div class="rp-meta"><b>HVAC Load Report</b><span>' + date + '</span></div>' +
        '</header>' +
        '<h1 class="rp-title">Residential Load Calculation</h1>' +
        '<div class="rp-addr">' + escapeHtml(g.label) + '</div>' +
        reportJobLine() +
        '<div class="rp-results">' +
          '<div class="rp-res heat"><span>Heating load</span><b>' + fmt(r.heating.total) + '</b><em>BTU/h · expected ' + fmt(r.heating.range.low) + '–' + fmt(r.heating.range.high) + '</em></div>' +
          '<div class="rp-res cool"><span>Cooling load</span><b>' + fmt(r.cooling.total) + '</b><em>BTU/h · ' + r.recommendedTons + ' tons · expected ' + fmt(r.cooling.range.low) + '–' + fmt(r.cooling.range.high) + '</em></div>' +
        '</div>' +
        '<div class="rp-equip"><b>Equipment plan:</b> ' + r.recommendedTons + '-ton cooling (' + fmt(r.equipment.acBtu) + ' BTU/h) at ≈' + fmt(r.equipment.airflowCfm) + ' CFM; heating via ' + fmt(r.equipment.furnaceOutput) + ' BTU/h-output furnace or heat pump. Heat-pump balance point ≈ <b>' + r.heatpump.balanceF + '°F</b>' + (r.heatpump.auxBtu > 500 ? ' with ≈' + r.heatpump.auxKw + ' kW backup at design' : ' — no backup needed at design') + '. ' + r.equipment.suggestion + '</div>' +
        '<div class="rp-block rp-final-rec"><h2>Final recommendation — by system type</h2><table>' +
          rrow("Single-stage A/C or gas furnace split system" + recMark("single"), r.sizing.single + " tons") +
          rrow("Two-stage system" + recMark("two"), r.sizing.two + " tons") +
          rrow("Variable-capacity (inverter) system" + recMark("variable"), r.sizing.variable + " tons") +
          rrow("Heat pump (any stage)" + recMark("hp"), r.recommendedTons + " tons") +
          rrow("Sensible / latent split", r.shr ? r.shr.sensiblePct + "% / " + r.shr.latentPct + "% (SHR " + r.shr.shr.toFixed(2) + ")" : "—") +
          rrow("Selected size vs. calculated load", r.equipment.manualSFit ? r.equipment.manualSFit.pctOfLoad + "% (" + (r.equipment.manualSFit.inBand ? "within Manual S band" : "closest available size — outside band") + ")" : "—") +
        '</table>' +
        (r.shr ? '<p class="rp-permit-note">' + escapeHtml(r.shr.message) + '</p>' : "") +
        (r.equipment.manualSFit && !r.equipment.manualSFit.inBand ? '<p class="rp-permit-note">' + escapeHtml(r.equipment.manualSFit.message) + '</p>' : "") +
        '<p class="rp-disc" style="margin-top:6px">Variable-capacity systems modulate continuously, and their maximum output typically exceeds their nominal rating, so they don\'t need the fixed-capacity oversize cushion — they\'re selected to the nearest half-ton step, which is often a half-ton smaller than single/two-stage equipment for the same load and never larger. Every size listed stays at or above Manual S\'s 90%-of-load floor. A heat pump follows the same cooling-capacity rule as an A/C for the stage type chosen — see the balance point above for its heating-side backup requirement.</p></div>' +
        '<div class="rp-cols">' +
          '<div class="rp-block"><h2>Design conditions</h2><table>' +
            rrow("Climate source", c.source === "live" ? "Site analysis — " + fmt(c.hours) + " hrs of hourly weather" : "Nearest station: " + escapeHtml(c.city)) +
            rrow("Summer design (1%)", c.cooling1 + "°F") +
            rrow("Winter design (99%)", c.heating99 + "°F") +
            rrow("Design humidity", (c.outGrains || 0) + " grains/lb") +
            rrow("Elevation / air density", fmt(c.elevFt || 0) + " ft · factor " + r.inputs.acf) +
            (c.climateZone ? rrow("IECC climate zone", "Zone " + c.climateZone + (c.hdd65 != null ? " · " + fmt(c.hdd65) + " HDD65 / " + fmt(c.cdd50) + " CDD50" : "")) : "") +
            rrow("Indoor setpoints", "75°F cooling / 70°F heating") +
            rrow("Confidence band", "±" + Math.round(e.rangePct * 100) + "%") +
          '</table></div>' +
          '<div class="rp-block"><h2>Building inputs</h2><table>' +
            rrow("Conditioned area", fmt(e.area) + " ft²") +
            rrow("Bedrooms", String(e.bedrooms)) +
            rrow("Construction", qualityLabel) +
            rrow("Foundation", foundationLabel) +
            rrow("Sun exposure", sunLabel) +
            rrow("Ceiling height", e.ceiling + " ft") +
            rrow("Stories (est.)", String(r.inputs.stories)) +
            (e.atticR != null ? rrow("Attic insulation", "R-" + e.atticR) : "") +
            (e.ductType ? rrow("Duct type / location", ductTypeLabel) : "") +
            (e.ductType && e.ductType !== "ductless" && e.ductCondition ? rrow("Duct condition", ductConditionLabel) : "") +
          '</table></div>' +
        '</div>' +
        reportEnvelope(r) +
        '<div class="rp-block"><h2>Cooling load breakdown</h2><table>' +
          rrow("Walls, roof &amp; windows", fmt(cb.conduction) + " BTU/h") +
          rrow("Solar through glass", fmt(cb.solar) + " BTU/h") +
          rrow("People", fmt(cb.people) + " BTU/h") +
          rrow("Appliances &amp; lighting", fmt(cb.internal) + " BTU/h") +
          rrow("Air leakage (sensible + latent)", fmt(cb.infiltration) + " BTU/h") +
          rrow("Sensible / latent split", fmt(r.cooling.sensible) + " / " + fmt(r.cooling.latent) + " BTU/h") +
        '</table></div>' +
        reportReturnAir() +
        reportRooms() +
        reportRebates() +
        reportEnergy() +
        reportPhotos() +
        reportPhotoInsights() +
        (opts.permit ? reportPermitSection() : "") +
        '<p class="rp-disc"><b>Disclaimer:</b> this report is an ACCA Manual&nbsp;J–style block-load <b>estimate</b> generated by LoadMaster Pro AI for ' +
          'sizing guidance and permit preparation. It is not a substitute for a full room-by-room Manual&nbsp;J with Manual&nbsp;S equipment ' +
          'selection and Manual&nbsp;D duct design, which should be performed by a licensed professional for exact sizing and, where required, ' +
          'final permit submittal. Property characteristics may be estimated where data was unavailable. Permit information reflects federal ' +
          'standards and model codes; local amendments control — verify all requirements with the authority having jurisdiction.</p>' +
        '<footer class="rp-foot">Prepared by ' + escapeHtml(company) + (contact ? "  •  " + escapeHtml(contact) : "") + '  •  ' + date + '</footer>' +
      '</div>';

    $("#reportRoot").innerHTML = html;
    $("#reportRoot").scrollTop = 0;
    $("#rpCloseBtn").addEventListener("click", closeReport);
    $("#rpPrintBtn").addEventListener("click", function () { window.print(); });
  }

  function closeReport() {
    $("#reportRoot").innerHTML = "";
  }

  // AI photo-analysis appendix: what the photos showed and which inputs
  // were adjusted as a result.
  function reportPhotoInsights() {
    var pa = state.photoAI;
    if (!pa) return "";
    var rows = pa.findings.map(function (f) {
      var status = { applied: "Applied to calculation", kept: "Not applied — " + (f.keptWhy ? "kept " + f.keptWhy : "manual setting kept"), low: "Observed (low confidence — not applied)", duplicate: "Not applied — duplicate finding for this field", info: "Noted" }[f.status] || "Noted";
      var val = photoFindingValue(f);
      return rrow(escapeHtml(PHOTO_FIELD_LABELS[f.field] || f.field) + (val ? ": " + escapeHtml(val) : ""),
                  escapeHtml(f.note || "") + ' <i>(' + status + ')</i>');
    }).join("");
    var delta = "";
    if (pa.after && (pa.after.cooling !== pa.before.cooling || pa.after.heating !== pa.before.heating)) {
      var dc = pa.after.cooling - pa.before.cooling, dh = pa.after.heating - pa.before.heating;
      delta = '<p class="rp-permit-note">Applying the photo evidence adjusted the calculated loads by ' +
        (dc > 0 ? "+" : "") + fmt(dc) + ' BTU/h cooling and ' + (dh > 0 ? "+" : "") + fmt(dh) + ' BTU/h heating' +
        (pa.after.tons !== pa.before.tons ? ', changing the recommended A/C size from ' + pa.before.tons + ' to ' + pa.after.tons + ' tons' : '') +
        '. The load figures on page 1 already include these adjustments.</p>';
    }
    return '<div class="rp-block"><h2>AI photo analysis</h2>' +
      '<p class="rp-permit-sub">' + escapeHtml(pa.summary) + '</p>' +
      '<table>' + rows + '</table>' + delta +
      '<p class="rp-permit-note">Findings were extracted from the site photos by AI vision analysis and verified against the inputs above; low-confidence observations are listed for reference but did not change the calculation.</p>' +
    '</div>';
  }

  /*
   * Envelope-assumption appendix. The printed report is what a homeowner or a
   * plans examiner reads without the app in front of them, so it has to say
   * plainly which envelope numbers were measured and which were inferred —
   * an inferred R-value presented as fact is how an "engineering report"
   * quietly becomes wrong.
   */
  function reportEnvelope(r) {
    var env = r.envelope;
    if (!env) return "";
    function erow(label, value, src) {
      return rrow(label, value + " — " + ENV_SRC_LABEL[src]);
    }
    var basis = env.basis === "vintage-zone"
      ? "Year built " + env.yearBuilt + " (" + escapeHtml(env.eraLabel) + ") in IECC climate zone " + env.zone
      : "Construction-quality tier (no build year and climate zone available)";
    return '<div class="rp-block"><h2>Envelope assumptions</h2><table>' +
      rrow("Basis", basis) +
      erow("Attic insulation", "R-" + env.atticR, env.source.atticR) +
      erow("Window U-factor", env.windowU.toFixed(2), env.source.windowU) +
      erow("Window SHGC", env.windowSHGC.toFixed(2), env.source.windowSHGC) +
      erow("Air leakage", env.ach.toFixed(2) + " ACH", env.source.ach) +
      '</table>' +
      '<p class="rp-disc" style="margin-top:6px">Values marked &ldquo;' + ENV_SRC_LABEL.vintage + '&rdquo; are what the energy code in force required for that build year and climate zone — a defensible starting point for the era, not a measurement of this house. Values marked &ldquo;' + ENV_SRC_LABEL.tier + '&rdquo; come from a broad construction-quality bucket and are the loosest assumption in this report. Measured values (attic depth, an NFRC window label, a blower-door test) should replace them before this load is used for a stamped design.</p>' +
    '</div>';
  }

  // Return-air adequacy appendix: only renders when a return-air check result
  // exists on state.result (populated by the sibling return-air check unit).
  function reportReturnAir() {
    var ra = state.result && state.result.returnAir;
    if (!ra) return "";
    var sizeLabel = ra.mode === "ducted" ? "Return duct capacity (est.)" : "Return grille free area (est.)";
    var sizeValue = ra.mode === "ducted" ? fmt(ra.providedValue) + " CFM" : fmt(ra.providedValue) + " sq in" + (ra.sqInPerTon ? " (" + ra.sqInPerTon + " sq in/ton)" : "");
    return '<div class="rp-block"><h2>Return air sizing</h2><table>' +
      rrow(sizeLabel, sizeValue) +
      (ra.requiredValue != null ? rrow(ra.mode === "ducted" ? "Required airflow" : "Required free area", fmt(ra.requiredValue) + (ra.mode === "ducted" ? " CFM" : " sq in")) : "") +
      rrow("Assessment", ra.ok === true ? "Adequate" : ra.ok === false ? "Likely undersized" : "Estimated (not enough info to confirm)") +
      '</table>' +
      '<p class="rp-disc" style="margin-top:6px">' + escapeHtml(ra.disclosure || "") + '</p>' +
    '</div>';
  }

  // Site photos grid for the printed report.
  function reportPhotos() {
    if (!state.photos.length) return "";
    var cells = state.photos.map(function (p, i) {
      return '<div class="rp-photo"><img src="' + p.src + '" alt="site photo"/><span>Photo ' + (i + 1) + '</span></div>';
    }).join("");
    return '<div class="rp-block"><h2>Site photos</h2><div class="rp-photos">' + cells + '</div></div>';
  }

  // PermitIQ appendix: efficiency floors + code checklist + submission list.
  // Pro/Fleet only — self-gated here (not just by the caller) so a future
  // entry point to generateReport({permit:true}) can't leak this appendix.
  function reportPermitSection() {
    if (planTier() < 2) return "";
    var pd = window.PermitData, g = state.geo || {};
    var code = pd.stateCode(g.state);
    var eff = pd.efficiency(code || "");
    var effRows = eff.rows.map(function (rr) { return rrow(rr.k, rr.v); }).join("");
    var checks = pd.CHECKLIST.map(function (item) {
      return '<li>' + (item.verify ? '<b>[verify locally]</b> ' : '') + item.text + '</li>';
    }).join("");
    var submit = pd.SUBMITTAL.map(function (s) { return '<li>' + s + '</li>'; }).join("");
    return '' +
      '<div class="rp-block rp-permit"><h2>Permit requirements — ' + escapeHtml(g.city || "local jurisdiction") + (code ? ", " + code : "") + '</h2>' +
        '<p class="rp-permit-sub">Compiled by PermitIQ from federal efficiency standards (' + eff.regionLabel + ') and model building codes (IRC/IMC/NEC/IECC). Items marked [verify locally] are commonly amended by cities — confirm with the building department.</p>' +
        (!code ? '<p class="rp-permit-note">⚠ This address\'s state could not be resolved, so the region below (' + eff.regionLabel + ') is a default, not a confirmed match — verify the correct DOE region before relying on these minimums.</p>' : '') +
        '<table>' + effRows + '</table>' +
        (eff.note ? '<p class="rp-permit-note">' + eff.note + '</p>' : '') +
        '<h2 style="margin-top:14px">Installation &amp; code checklist</h2><ul class="rp-list">' + checks + '</ul>' +
        '<h2 style="margin-top:14px">Application submission checklist</h2><ul class="rp-list">' + submit + '</ul>' +
      '</div>';
  }
  function rrow(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }
  function initials(name) {
    var parts = String(name).trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p[0]; }).join("").toUpperCase() || "LM";
  }

  // ---------- Account (session created on auth.html) ----------
  function currentUser() {
    try { return JSON.parse(localStorage.getItem("lmp_user")); } catch (e) { return null; }
  }
  function renderAcct() {
    var btn = $("#acctBtn");
    if (!btn) return;
    var u = currentUser();
    if (u && u.name) {
      var initials = u.name.trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0]; }).join("").toUpperCase();
      btn.textContent = initials;
      btn.classList.add("in");
    } else {
      btn.textContent = "Sign in";
      btn.classList.remove("in");
    }
  }
  function openAccount() {
    var u = currentUser();
    if (!u) { location.href = "auth.html"; return; }
    var expired = trialExpired(u);
    var daysLeft = trialDaysLeft(u);
    var planLabel = { free: "Free", trial: "Free trial", solo: "Solo", pro: "Pro", fleet: "Fleet" }[u.plan] || "Free";
    var trialNote = "";
    if (u.plan === "trial") {
      trialNote = expired
        ? '<div class="status warn">Your 14-day free trial has ended — you\'re on the Free plan now. <a class="link" href="index.html#pricing">Pick a plan</a> to keep calculating.</div>'
        : daysLeft != null
          ? '<div class="status">' + daysLeft + ' day' + (daysLeft === 1 ? "" : "s") + ' left in your free trial.</div>'
          : "";
    }
    $("#settingsRoot").innerHTML =
      '<div class="overlay" id="overlay"><div class="sheet">' +
        '<div class="grab"></div>' +
        '<h3>' + escapeHtml(u.name) + '</h3>' +
        '<p class="sub">' + escapeHtml(u.email) + (u.company ? " · " + escapeHtml(u.company) : "") + '</p>' +
        '<div class="status">Plan: <b>' + planLabel + '</b>. Billing &amp; team seats activate when your workspace goes live.</div>' +
        trialNote +
        (onFreePlan() ? '<div class="status">Free plan: <b>' + freeCalcsLeft() + ' of ' + FREE_CALC_LIMIT + '</b> load calculation' + (FREE_CALC_LIMIT === 1 ? "" : "s") + ' remaining on this device.</div>' : "") +
        '<button class="save" id="acctUpgrade">See plans</button>' +
        '<button class="close" id="acctLogout">Log out</button>' +
      '</div></div>';
    var overlay = $("#overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) $("#settingsRoot").innerHTML = ""; });
    $("#acctUpgrade").addEventListener("click", function () { location.href = "index.html#pricing"; });
    $("#acctLogout").addEventListener("click", function () {
      localStorage.removeItem("lmp_user");
      $("#settingsRoot").innerHTML = "";
      renderAcct();
      toast("Logged out");
    });
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  // ---------- UI helpers ----------
  function setLoading(on, label) {
    var btn = $("#calcBtn");
    btn.disabled = on;
    btn.innerHTML = on
      ? '<span class="spin"></span><span class="cta-label">' + (label || "Calculating…") + '</span>'
      : '<span class="cta-label">Calculate load</span>';
    // The overlay carries the same label the button does, so the two never
    // disagree about what the app is doing.
    if (!window.Thinking) return;
    if (on) {
      if ($(".thinking.on")) window.Thinking.setMessage(label || "Calculating…");
      else window.Thinking.show(label || "Calculating…");
    } else {
      window.Thinking.hide();
    }
  }

  // Short bursts of work (a recalculate, a room diagnosis, a proposal) finish
  // in well under a second, so they get the overlay only long enough to
  // acknowledge the tap — run() drives its own longer sequence via setLoading.
  function thinkThen(label, fn) {
    if (!window.Thinking) { fn(); return; }
    window.Thinking.show(label);
    // Two frames: one to paint the overlay, one before the synchronous work
    // blocks the main thread — otherwise the overlay never appears at all.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try { fn(); } finally { window.Thinking.hide(); }
      });
    });
  }

  // ---------- Address autocomplete (debounced Nominatim) ----------
  var suggestTimer = null;
  function onAddressInput() {
    var q = $("#address").value.trim();
    clearTimeout(suggestTimer);
    if (q.length < 5) { hideSuggest(); return; }
    suggestTimer = setTimeout(function () {
      fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=4&countrycodes=us&q=" + encodeURIComponent(q),
            { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (list) {
          if ($("#address").value.trim() !== q) return; // stale response
          showSuggest(list || []);
        })
        .catch(function () { hideSuggest(); });
    }, 380);
  }
  function showSuggest(list) {
    var box = $("#suggest");
    if (!list.length) { hideSuggest(); return; }
    box.innerHTML = list.map(function (m, i) {
      return '<button class="sg-item" data-i="' + i + '">' + escapeHtml(shortAddr(m.display_name)) + '</button>';
    }).join("");
    box.classList.add("open");
    box.querySelectorAll(".sg-item").forEach(function (b) {
      b.addEventListener("click", function () {
        var m = list[parseInt(b.getAttribute("data-i"), 10)];
        $("#address").value = shortAddr(m.display_name);
        hideSuggest();
        activeHistoryId = null;
        /* token taken below, after the geo is set */
        setLoading(true, "Analyzing 8,760 hrs of climate…");
        clearError();
        var ma = m.address || {};
        state.geo = { lat: parseFloat(m.lat), lon: parseFloat(m.lon), label: m.display_name,
          city: ma.city || ma.town || ma.village || ma.municipality || ma.county || null,
          state: ma.state || null, postcode: ma.postcode || null };
        var token = newRunToken();
        resolveClimateAndProperty(state.geo, m.display_name)
          .then(function (prop) { finishRun(prop, token); })
          .catch(function () { finishRun(null, token); });
      });
    });
  }
  function hideSuggest() {
    var box = $("#suggest");
    if (box) { box.innerHTML = ""; box.classList.remove("open"); }
  }
  function showError(msg) { $("#errorBox").innerHTML = '<div class="error-banner">' + escapeHtml(msg) + '</div>'; }
  function clearError() { $("#errorBox").innerHTML = ""; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }
  function shortAddr(label) { return label.split(",").slice(0, 4).join(", "); }
  function roundTo(n, step) { return Math.round(n / step) * step; }

  function heatIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s0 2 1.5 2S12 6 12 2z"/></svg>'; }
  function hpIcon() { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>'; }
  function coolIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/></svg>'; }

  // ---------- Settings sheet ----------
  var pendingLogo = null;
  // ---------- AI provider Settings helpers ----------
  function aiProviderOptions(selected) {
    return window.AIProviders.listProviders().map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === selected ? " selected" : "") + '>' + escapeAttr(p.label) + '</option>';
    }).join("");
  }
  function aiProviderCopy(id) {
    var p = window.AIProviders.getProvider(id);
    var link = p.signupUrl ? '<a class="link" href="' + p.signupUrl + '" target="_blank" rel="noopener">' + escapeAttr(p.label) + '</a>' : escapeAttr(p.label);
    if (id === "custom") {
      return 'Point the app at any OpenAI-compatible endpoint (a local model server, a proxy, another vendor) — the app can still read your site photos and tune the load calculation. Photos are sent to your endpoint only when you tap "Analyze".';
    }
    return 'Add a ' + link + ' key and the app can read your site photos — sun exposure, windows, insulation, ceiling height, home size — and tune the load calculation automatically. Photos are sent to ' + escapeAttr(p.label) + ' only when you tap "Analyze".';
  }
  function aiKeyLabel(id) { return window.AIProviders.getProvider(id).keyLabel; }
  function aiKeyPlaceholder(id) { return window.AIProviders.getProvider(id).keyPlaceholder; }
  function currentProviderDefaultModel(id) { return window.AIProviders.getProvider(id).defaultModel; }
  function providerRequiresBaseUrl(id) { return !!window.AIProviders.getProvider(id).requiresBaseUrl; }

  function openSettings() {
    var s = loadSettings();
    var hasKey = !!s.propertyApiKey;
    var hasAiKey = !!s.aiApiKey;
    var aiProvider = s.aiProvider || "anthropic";
    pendingLogo = null;
    $("#settingsRoot").innerHTML =
      '<div class="overlay" id="overlay"><div class="sheet">' +
        '<div class="grab"></div>' +
        '<h3>Settings</h3>' +

        '<div class="set-group"><div class="set-title">Your business (for reports)</div>' +
        '<p class="sub">Branding shown on the PDF/print reports you generate. Stored only on this device.</p>' +
        '<div class="logo-row">' +
          '<div class="logo-prev" id="logoPrev">' + (s.logo ? '<img src="' + s.logo + '"/>' : '<span>Logo</span>') + '</div>' +
          '<div class="logo-actions"><label class="file-btn" for="logoFile">Upload logo</label>' +
            '<input type="file" id="logoFile" accept="image/*" hidden />' +
            (s.logo ? '<button class="logo-remove" id="logoRemove">Remove</button>' : '') +
          '</div>' +
        '</div>' +
        '<label>Company name</label><input type="text" id="setCompany" value="' + escapeAttr(s.company || "") + '" placeholder="e.g. Summit Heating & Air" />' +
        '<div class="set-two"><div><label>Phone</label><input type="text" id="setPhone" value="' + escapeAttr(s.phone || "") + '" placeholder="(555) 123-4567" /></div>' +
        '<div><label>License #</label><input type="text" id="setLicense" value="' + escapeAttr(s.license || "") + '" placeholder="optional" /></div></div>' +
        '<label>Email</label><input type="text" id="setEmail" value="' + escapeAttr(s.email || "") + '" placeholder="you@company.com" />' +
        '</div>' +

        '<div class="set-group"><div class="set-title">Automatic property lookup</div>' +
        '<p class="sub">Add a free <a class="link" href="https://www.rentcast.io/api" target="_blank" rel="noopener">RentCast API</a> key for automatic square-footage from just the address. Without it, the app estimates the size and lets you adjust.</p>' +
        '<label>Property data API key (RentCast)</label>' +
        '<input type="password" id="apiKey" placeholder="' + (hasKey ? "•••••• saved" : "paste key (optional)") + '" />' +
        '<div class="status">' + (hasKey ? "✓ A key is saved on this device." : "No key set — using smart estimates.") +
          ' Browser calls to property APIs can be blocked by CORS; if a lookup fails, the app falls back to an editable estimate.</div>' +
        '</div>' +

        '<div class="set-group"><div class="set-title">AI photo analysis' + (planTier() < 2 ? ' <span class="permit-badge">PRO</span>' : '') + '</div>' +
        (planTier() < 2 ? '<p class="sub"><span class="ico gold">' + lockIcon() + '</span> Photo analysis is a Pro/Fleet feature — you can save a key here now, but it won\'t be used until you upgrade.</p>' : '') +
        '<p class="sub" id="aiProviderSub">' + aiProviderCopy(aiProvider) + '</p>' +
        '<label>AI provider</label>' +
        '<select id="aiProvider">' + aiProviderOptions(aiProvider) + '</select>' +
        '<label id="aiKeyLabel">' + aiKeyLabel(aiProvider) + '</label>' +
        '<input type="password" id="aiKey" placeholder="' + (hasAiKey ? "•••••• saved" : aiKeyPlaceholder(aiProvider) + " (optional)") + '" />' +
        '<div class="set-two">' +
          '<div><label>Model override</label><input type="text" id="aiModel" value="' + escapeAttr(s.aiModel || "") + '" placeholder="' + escapeAttr(currentProviderDefaultModel(aiProvider) || "required") + '" /></div>' +
          '<div id="aiBaseUrlWrap" style="' + (providerRequiresBaseUrl(aiProvider) ? "" : "display:none") + '"><label>Base URL</label><input type="text" id="aiBaseUrl" value="' + escapeAttr(s.aiBaseUrl || "") + '" placeholder="https://your-endpoint/v1/chat/completions" /></div>' +
        '</div>' +
        '<div class="status">' + (hasAiKey ? "✓ A key is saved on this device — it never leaves it except to call the provider's API directly." : "No key set — photo analysis stays off; everything else works normally.") + '</div>' +
        '</div>' +

        '<div class="set-group"><div class="set-title">Send jobs to your system</div>' +
        '<p class="sub">Paste a completed job straight into a ServiceTitan note, or post it to an automation you own (Zapier, Make, n8n) that holds your ServiceTitan credentials server-side. This app deliberately does not ask for a ServiceTitan App Key — giving one to a third-party app is prohibited by ServiceTitan\'s own integration rules, and a browser cannot keep a secret anyway.</p>' +
        '<label>Automation webhook URL (optional)</label>' +
        '<input type="text" id="setWebhook" value="' + escapeAttr(s.webhookUrl || "") + '" placeholder="https://hooks.zapier.com/hooks/catch/..." />' +
        '<div class="status">Receives the structured job as JSON when you tap Send to webhook.</div>' +
        '</div>' +

        '<button class="save" id="saveSettings">Save settings</button>' +
        '<button class="close" id="closeSettings">Close</button>' +
      '</div></div>';

    var overlay = $("#overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    $("#closeSettings").addEventListener("click", close);

    $("#logoFile").addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        downscaleImage(reader.result, 320, function (dataUrl) {
          pendingLogo = dataUrl;
          $("#logoPrev").innerHTML = '<img src="' + dataUrl + '"/>';
        });
      };
      reader.readAsDataURL(f);
    });
    var lr = $("#logoRemove");
    if (lr) lr.addEventListener("click", function () { pendingLogo = "REMOVE"; $("#logoPrev").innerHTML = '<span>Logo</span>'; });

    $("#aiProvider").addEventListener("change", function () {
      var id = $("#aiProvider").value;
      $("#aiProviderSub").innerHTML = aiProviderCopy(id);
      $("#aiKeyLabel").textContent = aiKeyLabel(id);
      $("#aiKey").placeholder = aiKeyPlaceholder(id) + " (optional)";
      $("#aiModel").placeholder = currentProviderDefaultModel(id) || "required";
      $("#aiBaseUrlWrap").style.display = providerRequiresBaseUrl(id) ? "" : "none";
      // Switching providers must not silently carry over the previous
      // provider's saved key/model to the newly-selected one's endpoint.
      if (id !== aiProvider) {
        $("#aiKey").value = "";
        $("#aiModel").value = "";
      }
    });

    $("#saveSettings").addEventListener("click", function () {
      var cur = loadSettings();
      cur.company = $("#setCompany").value.trim();
      cur.phone = $("#setPhone").value.trim();
      cur.license = $("#setLicense").value.trim();
      cur.email = $("#setEmail").value.trim();
      var hookEl = $("#setWebhook");
      if (hookEl) {
        var hook = hookEl.value.trim();
        // Stored only when it is a usable https endpoint, so a half-typed URL
        // never sits in Settings looking configured.
        cur.webhookUrl = /^https:\/\/[^\s]+$/i.test(hook) ? hook : "";
      }
      var v = $("#apiKey").value.trim();
      if (v) cur.propertyApiKey = v; // empty keeps existing key
      var newAiProvider = $("#aiProvider").value;
      var aiProviderChanged = newAiProvider !== cur.aiProvider;
      cur.aiProvider = newAiProvider;
      var ak = $("#aiKey").value.trim();
      if (ak) cur.aiApiKey = ak; // empty keeps existing key
      else if (aiProviderChanged) delete cur.aiApiKey; // don't leak the old provider's key to the new one
      var am = $("#aiModel").value.trim();
      if (am) cur.aiModel = am; else delete cur.aiModel; // blank = fall back to the provider's current default
      if (providerRequiresBaseUrl(cur.aiProvider)) {
        var abu = $("#aiBaseUrl").value.trim();
        if (abu) cur.aiBaseUrl = abu;
      } else {
        delete cur.aiBaseUrl; // a stale custom URL shouldn't linger once switched away
      }
      if (pendingLogo === "REMOVE") delete cur.logo;
      else if (pendingLogo) cur.logo = pendingLogo;
      saveSettings(cur);
      toast("Settings saved");
      close();
    });
    function close() { $("#settingsRoot").innerHTML = ""; }
  }

  // Downscale an uploaded image. PNG (default) for logos with transparency;
  // site photos use JPEG so uploads to the vision API stay small.
  function downscaleImage(dataUrl, maxDim, cb, mime) {
    try {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        cb(mime === "image/jpeg" ? cv.toDataURL("image/jpeg", 0.85) : cv.toDataURL("image/png"));
      };
      img.onerror = function () { cb(dataUrl); };
      img.src = dataUrl;
    } catch (e) { cb(dataUrl); }
  }

  // ---------- Geolocation ----------
  function useMyLocation() {
    if (!navigator.geolocation) { showError("Location isn't available on this device."); return; }
    var gb = $("#geoBtn");
    gb.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(function (pos) {
      reverseGeocode(pos.coords.latitude, pos.coords.longitude).then(function (geo) {
        $("#address").value = shortAddr(geo.label);
        resetGeoBtn();
        runFromCoords(geo);
      }).catch(function () {
        resetGeoBtn();
        showError("Couldn't determine your address from that location. Enter an address instead.");
      });
    }, function () {
      resetGeoBtn();
      showError("Couldn't get your location. Enter an address instead.");
    }, { enableHighAccuracy: true, timeout: 10000 });
  }
  function resetGeoBtn() {
    $("#geoBtn").innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg> Use my current location';
  }

  // ---------- Wire up ----------
  function init() {
    loadLastJobType();
    wireJobPicker();
    wireInputDraft();
    updateFreeNote();
    $("#calcBtn").addEventListener("click", function () {
      var a = $("#address").value.trim();
      if (a.length < 4) { showError("Please enter a street address (with city/state)."); return; }
      run(a);
    });
    $("#address").addEventListener("keydown", function (e) { if (e.key === "Enter") { hideSuggest(); $("#calcBtn").click(); } });
    $("#address").addEventListener("input", onAddressInput);
    $("#address").addEventListener("blur", function () { setTimeout(hideSuggest, 250); });
    $("#geoBtn").addEventListener("click", useMyLocation);
    $("#openSettings").addEventListener("click", openSettings);
    var ab = $("#acctBtn");
    if (ab) ab.addEventListener("click", openAccount);
    renderAcct();

    renderHistory();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () { navigator.serviceWorker.register("service-worker.js").catch(function () {}); });
    }
  }

  init();
})();
