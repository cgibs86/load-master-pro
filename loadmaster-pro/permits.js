/*
 * LoadMaster Pro — Permit & code search (Pro add-on).
 *
 * After a load calculation, this renders a "Permit pack" panel that:
 *   1. Deep-searches the searched home's city/county for HVAC outdoor-unit
 *      install code requirements (setback, SEER/SEER2, sound dB, disconnect,
 *      screening, etc.) plus the building/zoning department + contacts.
 *      (Backed by the server endpoint /api/permit-search.)
 *   2. Lets the contractor open a pre-filled, professional submission email to
 *      the city with the load report attached (one tap to attach the PDF).
 *
 * Gated behind a "Pro" flag. Real billing/auth is a future step — for now the
 * unlock is a local toggle so the flow can be exercised end to end.
 */
(function () {
  "use strict";

  var PRO_KEY = "lmp_pro_v1";
  var API_URL = window.LMP_API_BASE || "api/permit-search"; // relative to the app base
  var ctx = null;        // last mounted calculation context
  var lastResult = null;  // last permit-search result (per address)
  var lastKey = null;     // address key the result belongs to

  function isPro() { try { return localStorage.getItem(PRO_KEY) === "1"; } catch (e) { return false; } }
  function setPro(on) { try { on ? localStorage.setItem(PRO_KEY, "1") : localStorage.removeItem(PRO_KEY); } catch (e) {} }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function fmt(n) { try { return Number(n).toLocaleString("en-US"); } catch (e) { return String(n); } }

  // The panel lives as a sibling section right after #results.
  function panel() {
    var p = document.getElementById("permitPanel");
    if (!p) {
      p = document.createElement("section");
      p.id = "permitPanel";
      p.className = "permit-panel hidden";
      var results = document.getElementById("results");
      if (results && results.parentNode) results.parentNode.insertBefore(p, results.nextSibling);
      else document.body.appendChild(p);
    }
    return p;
  }

  function keyFor(c) { return (c && c.address ? c.address : "") + "|" + (c && c.geo ? c.geo.lat + "," + c.geo.lon : ""); }

  function mount(c) {
    ctx = c;
    // Drop a stale result if the address changed.
    if (keyFor(c) !== lastKey) { lastResult = null; }
    renderPanel();
  }

  function renderPanel() {
    var p = panel();
    if (!ctx) { p.className = "permit-panel hidden"; return; }
    p.className = "permit-panel";

    if (!isPro()) { p.innerHTML = lockedHtml(); wireLocked(p); return; }

    if (lastResult && lastKey === keyFor(ctx)) { p.innerHTML = resultHtml(lastResult); wireResult(p); return; }

    p.innerHTML = idleHtml();
    wireIdle(p);
  }

  function headerHtml(sub) {
    return '<div class="pp-head">' +
      '<span class="pp-badge">PRO</span>' +
      '<div class="pp-htext"><b>Permit &amp; code pack</b><span>' + esc(sub) + '</span></div>' +
    '</div>';
  }

  function lockedHtml() {
    return headerHtml("City HVAC install codes + ready-to-submit email") +
      '<div class="pp-lock">' +
        '<div class="pp-lock-ico">🔒</div>' +
        '<p>Pull this city’s outdoor-unit setback, minimum SEER/SEER2, sound limits and other ' +
          'install codes — plus the building department’s contacts — and email the load report ' +
          'to the city, ready to submit.</p>' +
        '<button class="pp-btn primary" id="ppUnlock">Enable Pro (preview)</button>' +
        '<div class="pp-fine">Preview unlock for testing. Billing comes later.</div>' +
      '</div>';
  }

  function idleHtml() {
    var loc = locLabel();
    return headerHtml("Deep-search this city’s HVAC install codes") +
      '<div class="pp-idle">' +
        '<p>Search permit &amp; code requirements for installing the outdoor unit at <b>' + esc(loc) + '</b>.</p>' +
        '<button class="pp-btn primary" id="ppRun">Search permit &amp; code requirements</button>' +
        '<div class="pp-fine">Best-effort AI research across city/county sources — always verify with the AHJ.</div>' +
      '</div>';
  }

  function locLabel() {
    var g = ctx && ctx.geo || {};
    return [g.city, g.state].filter(Boolean).join(", ") || (ctx && ctx.address) || "this address";
  }

  function loadingHtml() {
    return headerHtml("Searching city & county sources…") +
      '<div class="pp-loading"><span class="pp-spin"></span>Researching permit &amp; code requirements for ' +
        esc(locLabel()) + '…<small>This can take 20–40 seconds.</small></div>';
  }

  function wireLocked(p) {
    var b = p.querySelector("#ppUnlock");
    if (b) b.addEventListener("click", function () { setPro(true); renderPanel(); });
  }
  function wireIdle(p) {
    var b = p.querySelector("#ppRun");
    if (b) b.addEventListener("click", runSearch);
  }

  function runSearch() {
    var p = panel();
    p.innerHTML = loadingHtml();
    var g = (ctx && ctx.geo) || {};
    var payload = { city: g.city || null, state: g.state || null, county: g.county || null, address: ctx && ctx.address };
    var key = keyFor(ctx);

    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (keyFor(ctx) !== key) return; // address changed mid-flight
        if (res && res.ok) { lastResult = res; lastKey = key; }
        else { lastResult = null; }
        p.innerHTML = res && res.ok ? resultHtml(res) : errorHtml(res);
        res && res.ok ? wireResult(p) : wireError(p);
      })
      .catch(function (e) {
        p.innerHTML = errorHtml({ message: "Network error reaching the permit service. Is the server running?", _detail: String(e) });
        wireError(p);
      });
  }

  function errorHtml(res) {
    var msg = (res && res.message) || "Permit search failed.";
    return headerHtml("Couldn’t complete the search") +
      '<div class="pp-error"><p>' + esc(msg) + '</p>' +
        '<button class="pp-btn" id="ppRetry">Try again</button></div>';
  }
  function wireError(p) {
    var b = p.querySelector("#ppRetry");
    if (b) b.addEventListener("click", runSearch);
  }

  // ---------- Result rendering ----------
  function srcLink(url) {
    if (!url) return "";
    var host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
    return ' <a class="pp-src" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(host) + ' ↗</a>';
  }

  function reqRow(label, r, render) {
    if (!r) return "";
    var has = render(r);
    return '<div class="pp-req">' +
      '<div class="pp-req-k">' + esc(label) + '</div>' +
      '<div class="pp-req-v">' + has + srcLink(r.source) + '</div>' +
    '</div>';
  }

  function valOrText(r, unit) {
    if (r.value != null && r.value !== "") return '<b>' + esc(r.value) + (unit ? " " + unit : "") + '</b>' + (r.text ? ' <span class="pp-note">' + esc(r.text) + '</span>' : '');
    if (r.text) return esc(r.text);
    return '<span class="pp-unk">Not found — verify with city</span>';
  }
  function reqBool(r, yes, no) {
    if (r.required === true) return '<b>' + esc(yes) + '</b>' + (r.text ? ' <span class="pp-note">' + esc(r.text) + '</span>' : '');
    if (r.required === false) return esc(no) + (r.text ? ' <span class="pp-note">' + esc(r.text) + '</span>' : '');
    return r.text ? esc(r.text) : '<span class="pp-unk">Not found — verify with city</span>';
  }

  function resultHtml(res) {
    var d = res.data || {};
    var j = d.jurisdiction || {};
    var req = d.requirements || {};
    var dep = d.department || {};
    var confidence = (d.confidence || "low");

    var who = [j.authorityName || j.city, j.state].filter(Boolean).join(", ") || locLabel();
    var permit = d.permitRequired === true ? "Permit required"
               : d.permitRequired === false ? "No permit required"
               : "Permit status unconfirmed";

    var rows =
      reqRow("Setback from property line", req.outdoorUnitSetbackFt, function (r) { return valOrText(r, "ft"); }) +
      reqRow("Minimum SEER", req.minSeer, function (r) { return valOrText(r, "SEER"); }) +
      reqRow("Minimum SEER2", req.minSeer2, function (r) { return valOrText(r, "SEER2"); }) +
      reqRow("Max sound at property line", req.maxSoundDb, function (r) { return valOrText(r, "dBA"); }) +
      reqRow("Electrical disconnect", req.electricalDisconnect, function (r) { return reqBool(r, "Required", "Not required"); }) +
      reqRow("Screening / placement", req.screening, function (r) { return reqBool(r, "Required", "Not required"); });

    var other = Array.isArray(req.other) ? req.other.filter(function (o) { return o && (o.topic || o.requirement); }) : [];
    var otherHtml = other.length ? '<div class="pp-other"><h4>Other code notes</h4>' + other.map(function (o) {
      return '<div class="pp-other-row"><b>' + esc(o.topic || "Note") + ':</b> ' + esc(o.requirement || "") + srcLink(o.source) + '</div>';
    }).join("") + '</div>' : "";

    var contacts = [];
    if (dep.website) contacts.push('<a class="pp-contact" href="' + esc(dep.website) + '" target="_blank" rel="noopener">🌐 Department website</a>');
    if (dep.permitPortal) contacts.push('<a class="pp-contact" href="' + esc(dep.permitPortal) + '" target="_blank" rel="noopener">📝 Permit portal</a>');
    if (dep.email) contacts.push('<a class="pp-contact" href="mailto:' + esc(dep.email) + '">✉ ' + esc(dep.email) + '</a>');
    if (dep.phone) contacts.push('<a class="pp-contact" href="tel:' + esc(String(dep.phone).replace(/[^0-9+]/g, "")) + '">📞 ' + esc(dep.phone) + '</a>');

    var srcList = Array.isArray(d.sources) ? d.sources.filter(function (s) { return s && s.url; }) : [];
    var srcHtml = srcList.length ? '<details class="pp-sources"><summary>Sources (' + srcList.length + ')</summary><ul>' +
      srcList.map(function (s) { return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a></li>'; }).join("") +
      '</ul></details>' : "";

    return headerHtml(who) +
      '<div class="pp-result">' +
        '<div class="pp-status"><span class="pp-pill ' + esc(confidence) + '">' + esc(permit) + '</span>' +
          '<span class="pp-conf">confidence: ' + esc(confidence) + '</span></div>' +
        '<div class="pp-reqs">' + (rows || '<div class="pp-unk">No specific requirements found.</div>') + '</div>' +
        otherHtml +
        (dep.name || contacts.length ?
          '<div class="pp-dept"><h4>' + esc(dep.name || "Building / zoning department") + '</h4>' +
            (dep.address ? '<div class="pp-dept-addr">' + esc(dep.address) + '</div>' : '') +
            (contacts.length ? '<div class="pp-contacts">' + contacts.join("") + '</div>' : '<div class="pp-note">No contact details found — check the department website.</div>') +
          '</div>' : "") +
        (d.notes ? '<p class="pp-note pp-notes">' + esc(d.notes) + '</p>' : "") +
        srcHtml +
        '<div class="pp-actions">' +
          '<button class="pp-btn primary" id="ppEmail">Email load report to city</button>' +
          '<button class="pp-btn" id="ppRefresh">Re-run search</button>' +
        '</div>' +
        '<p class="pp-disc">Best-effort AI research — municipal codes vary and change. Confirm every requirement with the ' +
          'authority having jurisdiction before submitting.</p>' +
      '</div>';
  }

  function wireResult(p) {
    var e = p.querySelector("#ppEmail");
    if (e) e.addEventListener("click", emailToCity);
    var r = p.querySelector("#ppRefresh");
    if (r) r.addEventListener("click", function () { lastResult = null; runSearch(); });
  }

  // ---------- Submission email (mailto; user attaches the generated PDF) ----------
  function emailToCity() {
    var d = (lastResult && lastResult.data) || {};
    var dep = d.department || {};
    var s = (ctx && ctx.settings) || {};
    var r = (ctx && ctx.result) || {};
    var e = (ctx && ctx.effective) || {};
    var c = (ctx && ctx.climate) || {};
    var address = (ctx && ctx.address) || "the property";

    var company = s.company || "our company";
    var who = s.company ? ("I'm with " + s.company) : "I'm an HVAC contractor";
    var sign = [s.company, s.phone, s.email, s.license ? "License " + s.license : ""].filter(Boolean).join("\n");

    var heating = r.heating ? fmt(r.heating.total) + " BTU/h" : "(see attached)";
    var cooling = r.cooling ? fmt(r.cooling.total) + " BTU/h" : "(see attached)";
    var tons = r.recommendedTons != null ? r.recommendedTons + " tons" : "(see attached)";

    var subject = "HVAC Load Calculation — " + address;
    var bodyLines = [
      "Hello,",
      "",
      who + " and I'm submitting an ACCA Manual J–style residential load calculation for review at:",
      "",
      address,
      "",
      "Summary of the attached report:",
      "• Heating load: " + heating,
      "• Cooling load: " + cooling,
      "• Recommended A/C size: " + tons,
      "• Conditioned area: " + (e.area != null ? fmt(e.area) + " sq ft" : "(see attached)"),
      "• Design conditions: " + (c.cooling1 != null ? c.cooling1 + "°F summer / " + c.heating99 + "°F winter" : "(see attached)"),
      "",
      "The full load report is attached as a PDF. Please let me know if you need any " +
        "additional documentation for the permit, or the correct submission portal.",
      "",
      "Thank you,",
      sign || "(your name)"
    ];

    var to = dep.email || "";
    var href = "mailto:" + encodeURIComponent(to) +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(bodyLines.join("\n"));

    // Remind the user to attach the generated PDF (mailto can't attach files).
    if (window.LMPToast) window.LMPToast("Opening email — generate the PDF report and attach it.");
    window.location.href = href;
  }

  window.LMPPermits = { mount: mount, isPro: isPro, setPro: setPro };
})();
