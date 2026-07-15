/* LoadMaster Pro — app controller */
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
    result: null
  };

  // ---------- Settings (stored on-device only) ----------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  // ---------- Geocoding (OpenStreetMap Nominatim — CORS-friendly, no key) ----------
  function geocode(address) {
    var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=" +
              encodeURIComponent(address);
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("geocode http " + r.status); return r.json(); })
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
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=" + lat + "&lon=" + lon;
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
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

  // ---------- Orchestration ----------
  function run(address) {
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
      .then(function (prop) { finishRun(prop); })
      .catch(function (err) {
        setLoading(false);
        showError(err.message || "Something went wrong. Please try again.");
      });
  }

  function runFromCoords(geo) {
    activeHistoryId = null;
    setLoading(true, "Analyzing 8,760 hrs of climate…");
    clearError();
    state.geo = geo;
    resolveClimateAndProperty(geo, geo.label)
      .then(finishRun)
      .catch(function () { finishRun(null); });
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
          elevFt: live.elevFt
        };
      } else {
        state.climate = {
          city: station.city, source: "station", hours: 0,
          heating99: station.heating99, cooling1: station.cooling1,
          outGrains: station.outGrains, elevFt: 0
        };
      }
      return res[1];
    });
  }

  function finishRun(prop) {
    state.overrides = {};
    state.photos = [];
    state.photoAI = null;
    state.photoBusy = false;
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
    var systemType = o.systemType || "single";
    var ceiling = o.ceiling != null ? o.ceiling : (pa.ceiling != null ? pa.ceiling : 9);
    var rangePct = p.source === "fetched" ? 0.10 : 0.15;
    // Photo evidence tightens the confidence band a notch on estimated homes.
    if (p.source !== "fetched" && Object.keys(pa).length) rangePct = 0.12;
    state.effective = { area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, systemType: systemType, ceiling: ceiling, rangePct: rangePct };
    var opts = {
      area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, systemType: systemType, ceiling: ceiling,
      heating99: c.heating99, cooling1: c.cooling1, outGrains: c.outGrains,
      elevFt: c.elevFt || 0, rangePct: rangePct
    };
    if (pa.windowFrac != null) opts.windowFrac = pa.windowFrac;
    state.result = window.LoadCalc.compute(opts);
  }

  // Subscription tier: 0 guest · 1 solo · 2 trial/pro · 3 fleet.
  // PermitIQ + site photos unlock at tier 2 (free trial included, so
  // prospects experience the flagship feature before paying).
  function planTier() {
    var u = currentUser();
    if (!u) return 0;
    return { solo: 1, trial: 2, pro: 2, fleet: 3 }[u.plan] != null
      ? { solo: 1, trial: 2, pro: 2, fleet: 3 }[u.plan] : 2;
  }

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
      : '<div class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><b>' + escapeHtml(c.city) + '</b> station data</div>';
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
          '<div class="eq-alts">By system type: single-stage <b>' + r.sizing.single + 't</b> · two-stage <b>' + r.sizing.two + 't</b> · variable-capacity <b>' + r.sizing.variable + 't</b><span class="eq-alt-note">Variable systems modulate down to ~30–40%, so a nominal size above the load still runs efficiently. Selection follows ACCA Manual S limits (90–115%).</span></div>' +
          '<p>' + r.equipment.suggestion + '</p></div>' +
      '</div>' +

      hpCard(r, c) +
      photosCard() +
      photoInsightsCard() +
      permitCard() +

      '<div class="actions">' +
        '<button class="action-btn primary" id="reportBtn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V3a1 1 0 0 1 1-1h7l4 4v3"/><path d="M6 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/><rect x="6" y="13" width="12" height="8" rx="1"/></svg>Generate report</button>' +
        '<button class="action-btn" id="shareBtn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>Share</button>' +
      '</div>' +

      detailsBlock(r, c, e, qualityLabel) +
      adjustBlock(e, p);

    var el = $("#results");
    el.innerHTML = html;
    el.classList.remove("hidden");
    $("#introNote").classList.add("hidden");
    document.body.classList.add("has-results");

    animateCounts();
    wireAdjust();
    var ac = $("#adjustChip");
    if (ac) ac.addEventListener("click", function () { var d = $("#adjustDetails"); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); } });
    $("#reportBtn").addEventListener("click", function () { generateReport({}); });
    $("#shareBtn").addEventListener("click", shareResult);
    wirePhotos();
    wirePermit();

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
          '<p class="ai-note">Optional. AI reads sun exposure, windows, insulation and size from your shots and tunes the load numbers. Uses your Anthropic API key (Settings).</p>';
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
      default: return String(f.value);
    }
  }

  function runPhotoAnalysis() {
    var s = loadSettings();
    if (!s.anthropicApiKey) {
      toast("Add your Anthropic API key in Settings to enable photo analysis");
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
    window.PhotoAI.analyze(state.photos.map(function (ph) { return ph.src; }), ctx, s.anthropicApiKey)
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
    res.findings.forEach(function (f) {
      f.status = "info";
      if (f.field === "other" || f.field === "stories") return; // informational only
      if (f.confidence === "low" || f.value == null) { f.status = "low"; return; }
      var overridden = (f.field === "area" || f.field === "ceiling") ? o[f.field] != null : !!o[f.field];
      if (overridden) { f.status = "kept"; return; }               // user's manual setting wins
      if (f.field === "area" && p.source === "fetched") { f.status = "kept"; f.keptWhy = "property records"; return; }
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
    if (pkg) pkg.addEventListener("click", function () { generateReport({ permit: true }); });
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
      "The load calculation report and site photos are attached as PDF (generated by LoadMaster Pro).%0D%0A" +
      "Please advise on fees, forms, and inspection scheduling.%0D%0A%0D%0A" +
      "Thank you,%0D%0A" + encodeURIComponent((s.company || "") + (s.license ? " · License " + s.license : "") + (s.phone ? " · " + s.phone : ""));
    location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + body;
    toast("Draft opened — attach the saved permit-package PDF before sending");
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
          '</div>' +
        '</div>' +
      '</details>';
  }

  function adjustBlock(e, p) {
    var q = e.quality;
    return '' +
      '<details class="details" id="adjustDetails"><summary>Fine-tune inputs<svg class="caret" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></summary>' +
        '<div class="details-body adjust">' +
          (p.source === "estimate" ? '<p class="note" style="text-align:left;margin:2px 2px 4px">We couldn\'t auto-pull this home\'s data, so these start from typical values. Adjust for an accurate result.</p>' : '') +
          '<label>Conditioned floor area (ft²)</label>' +
          '<input type="number" id="inArea" min="200" max="20000" step="50" value="' + e.area + '" />' +
          '<label>Bedrooms</label>' +
          '<input type="number" id="inBeds" min="0" max="12" step="1" value="' + e.bedrooms + '" />' +
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
          '<button class="recalc" id="recalcBtn">Recalculate</button>' +
        '</div>' +
      '</details>';
  }
  function segBtn(val, label, cur) { return '<button data-q="' + val + '" class="' + (cur === val ? "on" : "") + '">' + label + '</button>'; }
  function opt(val, label, cur) { return '<option value="' + val + '"' + (cur === val ? " selected" : "") + '>' + label + '</option>'; }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }

  function wireAdjust() {
    var seg = $("#segQuality");
    if (seg) {
      seg.addEventListener("click", function (ev) {
        var b = ev.target.closest("button[data-q]");
        if (!b) return;
        seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
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
      state.overrides.foundation = $("#inFoundation").value;
      state.overrides.sun = $("#inSun").value;
      state.overrides.systemType = $("#inSystem").value;
      state.overrides.ceiling = isFinite(ceiling) ? ceiling : undefined;
      // Keep displaying as a user-adjusted estimate.
      state.property.source = "estimate";
      compute();
      render();
    });
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
      document.querySelectorAll(".bar-fill").forEach(function (el) { el.style.width = (el.getAttribute("data-w") || 0) + "%"; });
    });
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
    compute();
    render();
  }

  // ---------- Share ----------
  function shareResult() {
    var r = state.result, c = state.climate, g = state.geo, e = state.effective;
    var text = "HVAC Load Estimate — " + shortAddr(g.label) + "\n" +
      "• Heating: " + fmt(r.heating.total) + " BTU/h\n" +
      "• Cooling: " + fmt(r.cooling.total) + " BTU/h (" + r.recommendedTons + " tons)\n" +
      "• Climate: " + c.city + " (" + c.cooling1 + "°F / " + c.heating99 + "°F design)\n" +
      "• Conditioned area: " + fmt(e.area) + " ft²\n" +
      "Prepared with LoadMaster Pro";
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
    var date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    var company = s.company || "LoadMaster Pro";
    var contact = [s.phone, s.email].filter(Boolean).join("  •  ");
    var license = s.license ? "License " + s.license : "";
    var logo = s.logo
      ? '<img class="rp-logo" src="' + s.logo + '" alt="logo"/>'
      : '<div class="rp-logo rp-logo-fallback">' + escapeHtml(initials(company)) + '</div>';

    var cb = r.cooling.breakdown;
    var html =
      '<div class="rp">' +
        '<header class="rp-head">' +
          '<div class="rp-brand">' + logo + '<div class="rp-co"><b>' + escapeHtml(company) + '</b>' +
            (contact ? '<span>' + escapeHtml(contact) + '</span>' : '') +
            (license ? '<span>' + escapeHtml(license) + '</span>' : '') + '</div></div>' +
          '<div class="rp-meta"><b>HVAC Load Report</b><span>' + date + '</span></div>' +
        '</header>' +
        '<h1 class="rp-title">Residential Load Calculation</h1>' +
        '<div class="rp-addr">' + escapeHtml(g.label) + '</div>' +
        '<div class="rp-results">' +
          '<div class="rp-res heat"><span>Heating load</span><b>' + fmt(r.heating.total) + '</b><em>BTU/h · expected ' + fmt(r.heating.range.low) + '–' + fmt(r.heating.range.high) + '</em></div>' +
          '<div class="rp-res cool"><span>Cooling load</span><b>' + fmt(r.cooling.total) + '</b><em>BTU/h · ' + r.recommendedTons + ' tons · expected ' + fmt(r.cooling.range.low) + '–' + fmt(r.cooling.range.high) + '</em></div>' +
        '</div>' +
        '<div class="rp-equip"><b>Equipment plan:</b> ' + r.recommendedTons + '-ton cooling (' + fmt(r.equipment.acBtu) + ' BTU/h) at ≈' + fmt(r.equipment.airflowCfm) + ' CFM; heating via ' + fmt(r.equipment.furnaceOutput) + ' BTU/h-output furnace or heat pump. Heat-pump balance point ≈ <b>' + r.heatpump.balanceF + '°F</b>' + (r.heatpump.auxBtu > 500 ? ' with ≈' + r.heatpump.auxKw + ' kW backup at design' : ' — no backup needed at design') + '. ' + r.equipment.suggestion + '</div>' +
        '<div class="rp-cols">' +
          '<div class="rp-block"><h2>Design conditions</h2><table>' +
            rrow("Climate source", c.source === "live" ? "Site analysis — " + fmt(c.hours) + " hrs of hourly weather" : "Nearest station: " + escapeHtml(c.city)) +
            rrow("Summer design (1%)", c.cooling1 + "°F") +
            rrow("Winter design (99%)", c.heating99 + "°F") +
            rrow("Design humidity", (c.outGrains || 0) + " grains/lb") +
            rrow("Elevation / air density", fmt(c.elevFt || 0) + " ft · factor " + r.inputs.acf) +
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
          '</table></div>' +
        '</div>' +
        '<div class="rp-block"><h2>Cooling load breakdown</h2><table>' +
          rrow("Walls, roof &amp; windows", fmt(cb.conduction) + " BTU/h") +
          rrow("Solar through glass", fmt(cb.solar) + " BTU/h") +
          rrow("People", fmt(cb.people) + " BTU/h") +
          rrow("Appliances &amp; lighting", fmt(cb.internal) + " BTU/h") +
          rrow("Air leakage (sensible + latent)", fmt(cb.infiltration) + " BTU/h") +
          rrow("Sensible / latent split", fmt(r.cooling.sensible) + " / " + fmt(r.cooling.latent) + " BTU/h") +
        '</table></div>' +
        reportPhotos() +
        reportPhotoInsights() +
        (opts.permit ? reportPermitSection() : "") +
        '<p class="rp-disc"><b>Disclaimer:</b> this report is an ACCA Manual&nbsp;J–style block-load <b>estimate</b> generated by LoadMaster Pro for ' +
          'sizing guidance and permit preparation. It is not a substitute for a full room-by-room Manual&nbsp;J with Manual&nbsp;S equipment ' +
          'selection and Manual&nbsp;D duct design, which should be performed by a licensed professional for exact sizing and, where required, ' +
          'final permit submittal. Property characteristics may be estimated where data was unavailable. Permit information reflects federal ' +
          'standards and model codes; local amendments control — verify all requirements with the authority having jurisdiction.</p>' +
        '<footer class="rp-foot">Prepared by ' + escapeHtml(company) + (contact ? "  •  " + escapeHtml(contact) : "") + '  •  ' + date + '</footer>' +
      '</div>';

    $("#reportRoot").innerHTML = html;
    setTimeout(function () { window.print(); }, 80);
  }

  // AI photo-analysis appendix: what the photos showed and which inputs
  // were adjusted as a result.
  function reportPhotoInsights() {
    var pa = state.photoAI;
    if (!pa) return "";
    var rows = pa.findings.map(function (f) {
      var status = { applied: "Applied to calculation", kept: "Not applied — " + (f.keptWhy ? "kept " + f.keptWhy : "manual setting kept"), low: "Observed (low confidence — not applied)", info: "Noted" }[f.status] || "Noted";
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

  // Site photos grid for the printed report.
  function reportPhotos() {
    if (!state.photos.length) return "";
    var cells = state.photos.map(function (p, i) {
      return '<div class="rp-photo"><img src="' + p.src + '" alt="site photo"/><span>Photo ' + (i + 1) + '</span></div>';
    }).join("");
    return '<div class="rp-block"><h2>Site photos</h2><div class="rp-photos">' + cells + '</div></div>';
  }

  // PermitIQ appendix: efficiency floors + code checklist + submission list.
  function reportPermitSection() {
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
    var planLabel = { trial: "Free trial", solo: "Solo", pro: "Pro", fleet: "Fleet" }[u.plan] || "Free trial";
    $("#settingsRoot").innerHTML =
      '<div class="overlay" id="overlay"><div class="sheet">' +
        '<div class="grab"></div>' +
        '<h3>' + escapeHtml(u.name) + '</h3>' +
        '<p class="sub">' + escapeHtml(u.email) + (u.company ? " · " + escapeHtml(u.company) : "") + '</p>' +
        '<div class="status">Plan: <b>' + planLabel + '</b>. Billing &amp; team seats activate when your workspace goes live.</div>' +
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
        setLoading(true, "Analyzing 8,760 hrs of climate…");
        clearError();
        var ma = m.address || {};
        state.geo = { lat: parseFloat(m.lat), lon: parseFloat(m.lon), label: m.display_name,
          city: ma.city || ma.town || ma.village || ma.municipality || ma.county || null,
          state: ma.state || null, postcode: ma.postcode || null };
        resolveClimateAndProperty(state.geo, m.display_name).then(finishRun).catch(function () { finishRun(null); });
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
  function openSettings() {
    var s = loadSettings();
    var hasKey = !!s.propertyApiKey;
    var hasAiKey = !!s.anthropicApiKey;
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

        '<div class="set-group"><div class="set-title">AI photo analysis</div>' +
        '<p class="sub">Add an <a class="link" href="https://platform.claude.com/" target="_blank" rel="noopener">Anthropic API</a> key and the app can read your site photos — sun exposure, windows, insulation, ceiling height, home size — and tune the load calculation automatically. Photos are sent to Anthropic only when you tap “Analyze”.</p>' +
        '<label>Anthropic API key</label>' +
        '<input type="password" id="aiKey" placeholder="' + (hasAiKey ? "•••••• saved" : "sk-ant-… (optional)") + '" />' +
        '<div class="status">' + (hasAiKey ? "✓ A key is saved on this device — it never leaves it except to call the API directly." : "No key set — photo analysis stays off; everything else works normally.") + '</div>' +
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

    $("#saveSettings").addEventListener("click", function () {
      var cur = loadSettings();
      cur.company = $("#setCompany").value.trim();
      cur.phone = $("#setPhone").value.trim();
      cur.license = $("#setLicense").value.trim();
      cur.email = $("#setEmail").value.trim();
      var v = $("#apiKey").value.trim();
      if (v) cur.propertyApiKey = v; // empty keeps existing key
      var ak = $("#aiKey").value.trim();
      if (ak) cur.anthropicApiKey = ak; // empty keeps existing key
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
    window.addEventListener("afterprint", function () { $("#reportRoot").innerHTML = ""; });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () { navigator.serviceWorker.register("service-worker.js").catch(function () {}); });
    }
  }

  init();
})();
