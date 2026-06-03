/* LoadMaster Pro — app controller */
(function () {
  "use strict";

  var SETTINGS_KEY = "lmp_settings_v1";
  var $ = function (sel) { return document.querySelector(sel); };

  // Current working state for the active calculation.
  var state = {
    geo: null,        // { lat, lon, label, postcode }
    climate: null,    // nearest climate record
    property: null,   // { area, bedrooms, yearBuilt, source }
    overrides: {},    // user manual overrides
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
          postcode: a.postcode || null
        };
      });
  }

  function reverseGeocode(lat, lon) {
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" + lat + "&lon=" + lon;
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (m) {
        return { lat: lat, lon: lon, label: (m && m.display_name) || (lat.toFixed(4) + ", " + lon.toFixed(4)), postcode: (m && m.address && m.address.postcode) || null };
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
    setLoading(true);
    clearError();
    geocode(address)
      .then(function (geo) {
        state.geo = geo;
        state.climate = nearestClimate(geo.lat, geo.lon);
        return fetchProperty(address);
      })
      .then(function (prop) { finishRun(prop); })
      .catch(function (err) {
        setLoading(false);
        showError(err.message || "Something went wrong. Please try again.");
      });
  }

  function runFromCoords(geo) {
    activeHistoryId = null;
    setLoading(true);
    clearError();
    state.geo = geo;
    state.climate = nearestClimate(geo.lat, geo.lon);
    fetchProperty(geo.label).then(finishRun).catch(function () { finishRun(null); });
  }

  function finishRun(prop) {
    state.overrides = {};
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

  function compute() {
    var p = state.property, c = state.climate, o = state.overrides;
    var area = o.area != null ? o.area : p.area;
    var bedrooms = o.bedrooms != null ? o.bedrooms : (p.bedrooms != null ? p.bedrooms : 3);
    var quality = o.quality || window.LoadCalc.qualityFromYear(p.yearBuilt) || "average";
    var foundation = o.foundation || "slab";
    var sun = o.sun || "average";
    var ceiling = o.ceiling != null ? o.ceiling : 9;
    state.effective = { area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, ceiling: ceiling };
    state.result = window.LoadCalc.compute({
      area: area, bedrooms: bedrooms, quality: quality, foundation: foundation, sun: sun, ceiling: ceiling,
      heating99: c.heating99, cooling1: c.cooling1, outGrains: c.outGrains
    });
  }

  // ---------- Rendering ----------
  function fmt(n) { return n.toLocaleString("en-US"); }

  function render() {
    var r = state.result, c = state.climate, p = state.property, e = state.effective;
    var qualityLabel = { good: "Well insulated", average: "Average construction", poor: "Older / leaky" }[e.quality];

    var propChip = p.source === "fetched"
      ? '<div class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Auto-fetched&nbsp;<b>' + fmt(e.area) + ' ft²</b></div>'
      : '<div class="chip warn tap" id="adjustChip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>Estimated&nbsp;<b>' + fmt(e.area) + ' ft²</b> · tap to adjust</div>';

    var html =
      '<div class="chips">' +
        '<div class="chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><b>' + escapeHtml(c.city) + '</b> climate</div>' +
        '<div class="chip">❄ ' + c.cooling1 + '°F design&nbsp;·&nbsp;🔥 ' + c.heating99 + '°F</div>' +
        propChip +
      '</div>' +
      '<div class="address-line">' + escapeHtml(shortAddr(state.geo.label)) + '</div>' +

      '<div class="load-grid">' +
        loadCard("heat", "Heating", r.heating.total, "Design low", c.heating99 + "°F", heatIcon()) +
        loadCard("cool", "Cooling", r.cooling.total, "A/C size", r.recommendedTons + " tons", coolIcon()) +
      '</div>' +

      '<div class="equip-card">' +
        '<div class="badge">' + r.recommendedTons + '<small>TON A/C</small></div>' +
        '<div class="equip-text"><b>Suggested equipment</b><p>About a <b>' + r.recommendedTons + '-ton</b> cooling system and a <b>' + fmt(roundTo(r.heating.total, 5000)) + ' BTU/h</b> heating system. Sized to design conditions — discuss staging &amp; efficiency with your installer.</p></div>' +
      '</div>' +

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

    animateCounts();
    wireAdjust();
    var ac = $("#adjustChip");
    if (ac) ac.addEventListener("click", function () { var d = $("#adjustDetails"); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); } });
    $("#reportBtn").addEventListener("click", generateReport);
    $("#shareBtn").addEventListener("click", shareResult);

    saveActiveToHistory();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function loadCard(kind, title, btu, subLabel, subValue, icon) {
    return '' +
      '<div class="load-card ' + kind + '"><div class="glow"></div>' +
        '<div class="load-head"><span class="ico">' + icon + '</span>' + title + '</div>' +
        '<div class="load-btu"><span class="count" data-to="' + btu + '">0</span><small>BTU/h</small></div>' +
        '<div class="load-sub">' + (kind === "heat" ? "Design heat loss" : "Design heat gain") + '</div>' +
        '<div class="load-tons"><span>' + subLabel + '</span><b>' + subValue + '</b></div>' +
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
          '<label>Ceiling height (ft)</label>' +
          '<input type="number" id="inCeiling" min="7" max="20" step="0.5" value="' + e.ceiling + '" />' +
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
        var t = Math.min(1, (now - start) / dur);
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
  function generateReport() {
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
          '<div class="rp-res heat"><span>Heating load</span><b>' + fmt(r.heating.total) + '</b><em>BTU/h</em></div>' +
          '<div class="rp-res cool"><span>Cooling load</span><b>' + fmt(r.cooling.total) + '</b><em>BTU/h · ' + r.recommendedTons + ' tons</em></div>' +
        '</div>' +
        '<div class="rp-equip"><b>Recommended equipment:</b> approximately a <b>' + r.recommendedTons + '-ton</b> cooling system and a <b>' + fmt(roundTo(r.heating.total, 5000)) + ' BTU/h</b> heating system, sized to local design conditions.</div>' +
        '<div class="rp-cols">' +
          '<div class="rp-block"><h2>Design conditions</h2><table>' +
            rrow("Location climate", escapeHtml(c.city)) +
            rrow("Summer design (1%)", c.cooling1 + "°F") +
            rrow("Winter design (99%)", c.heating99 + "°F") +
            rrow("Indoor setpoints", "75°F cooling / 70°F heating") +
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
        '<p class="rp-disc">This report is an ACCA Manual J–style estimate generated by LoadMaster Pro for sizing guidance. ' +
          'Property characteristics may be estimated where data was unavailable. Final equipment selection should be confirmed ' +
          'with a full room-by-room load calculation by a licensed HVAC professional.</p>' +
        '<footer class="rp-foot">Prepared by ' + escapeHtml(company) + (contact ? "  •  " + escapeHtml(contact) : "") + '  •  ' + date + '</footer>' +
      '</div>';

    $("#reportRoot").innerHTML = html;
    setTimeout(function () { window.print(); }, 80);
  }
  function rrow(k, v) { return '<tr><td>' + k + '</td><td>' + v + '</td></tr>'; }
  function initials(name) {
    var parts = String(name).trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p[0]; }).join("").toUpperCase() || "LM";
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
  function setLoading(on) {
    var btn = $("#calcBtn");
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spin"></span><span class="cta-label">Calculating…</span>' : '<span class="cta-label">Calculate load</span>';
  }
  function showError(msg) { $("#errorBox").innerHTML = '<div class="error-banner">' + escapeHtml(msg) + '</div>'; }
  function clearError() { $("#errorBox").innerHTML = ""; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }
  function shortAddr(label) { return label.split(",").slice(0, 4).join(", "); }
  function roundTo(n, step) { return Math.round(n / step) * step; }

  function heatIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s0 2 1.5 2S12 6 12 2z"/></svg>'; }
  function coolIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/></svg>'; }

  // ---------- Settings sheet ----------
  var pendingLogo = null;
  function openSettings() {
    var s = loadSettings();
    var hasKey = !!s.propertyApiKey;
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
      if (pendingLogo === "REMOVE") delete cur.logo;
      else if (pendingLogo) cur.logo = pendingLogo;
      saveSettings(cur);
      toast("Settings saved");
      close();
    });
    function close() { $("#settingsRoot").innerHTML = ""; }
  }

  // Downscale an uploaded logo to keep localStorage small.
  function downscaleImage(dataUrl, maxDim, cb) {
    try {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL("image/png"));
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
    $("#address").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#calcBtn").click(); });
    $("#geoBtn").addEventListener("click", useMyLocation);
    $("#openSettings").addEventListener("click", openSettings);

    renderHistory();
    window.addEventListener("afterprint", function () { $("#reportRoot").innerHTML = ""; });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () { navigator.serviceWorker.register("service-worker.js").catch(function () {}); });
    }
  }

  init();
})();
