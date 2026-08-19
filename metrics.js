/* BTU.ai — client telemetry (metrics.js).
 *
 * Lightweight, privacy-safe instrumentation for every page. Collects:
 *   • Page views with device / browser / OS / network / PWA context
 *   • Core Web Vitals: TTFB, FCP, LCP, CLS, INP (+ load time, page weight)
 *   • JS errors & unhandled promise rejections
 *   • Offline/online transitions, install-prompt & PWA install events
 *   • Product funnel events fired by the app via window.MX.event(name, props)
 *
 * Everything is batched and sent to POST /api/metrics/collect on the same
 * origin (sendBeacon on hide). It fails totally silently when there is no
 * Node server (e.g. GitHub Pages hosting) — telemetry never affects the app.
 *
 * Privacy: visitor + session ids are random (no PII), we never send
 * addresses, emails, keys or input values — only booleans and aggregates.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/metrics/collect";
  var QUEUE_MAX = 20;
  var FLUSH_MS = 8000;

  // Hard opt-out hook: set window.LMP_TELEMETRY = false before this script.
  if (window.LMP_TELEMETRY === false) return;

  var queue = [];
  var vid, sid;

  try { vid = localStorage.getItem("lmp_vid"); if (!vid) { vid = "v" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem("lmp_vid", vid); } } catch (e) { vid = "anon"; }
  try { sid = sessionStorage.getItem("lmp_sid"); if (!sid) { sid = "s" + Math.random().toString(36).slice(2, 9); sessionStorage.setItem("lmp_sid", sid); } } catch (e) { sid = "s" + Math.random().toString(36).slice(2, 9); }

  function pageName() {
    var p = location.pathname.split("/").pop() || "index.html";
    if (p === "index.html" || p === "") return "landing";
    if (p === "app.html") return "app";
    if (p === "auth.html") return "auth";
    if (p === "dashboard.html") return "dashboard";
    return p.replace(/\.html$/, "");
  }

  // ---- Tiny UA parser (browser / os / device class) ----
  function uaInfo() {
    var ua = navigator.userAgent || "";
    var os = /Windows/.test(ua) ? "Windows"
      : /Android/.test(ua) ? "Android"
      : /iPhone|iPad|iPod/.test(ua) ? "iOS"
      : /Mac OS X/.test(ua) ? "macOS"
      : /CrOS/.test(ua) ? "ChromeOS"
      : /Linux/.test(ua) ? "Linux" : "Other";
    var browser = /Edg\//.test(ua) ? "Edge"
      : /OPR\//.test(ua) ? "Opera"
      : /SamsungBrowser/.test(ua) ? "Samsung Internet"
      : /Firefox\//.test(ua) ? "Firefox"
      : /Chrome\//.test(ua) ? "Chrome"
      : /Safari\//.test(ua) ? "Safari" : "Other";
    var device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet"
      : /Mobi|iPhone|Android/.test(ua) ? "mobile" : "desktop";
    return { browser: browser, os: os, device: device };
  }

  function baseProps() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    var ua = uaInfo();
    return {
      vid: vid, sid: sid, page: pageName(),
      ref: document.referrer ? document.referrer.slice(0, 250) : "direct",
      device: ua.device, os: ua.os, browser: ua.browser,
      lang: (navigator.language || "").slice(0, 10),
      net: conn.effectiveType || "unknown",
      dpr: Math.round((window.devicePixelRatio || 1) * 10) / 10,
      sw: window.innerWidth + "x" + window.innerHeight,
      standalone: !!(navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches)),
      online: navigator.onLine !== false,
      returning: localStorage.getItem("lmp_returning") === "1"
    };
  }

  // ---- Event API ----
  function event(name, props) {
    try {
      var e = { k: name, t: Date.now() };
      var p = props || {};
      for (var key in p) {
        if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
        var v = p[key];
        if (v == null) continue;
        if (typeof v === "number" && isFinite(v)) e[key] = Math.round(v * 1000) / 1000;
        else if (typeof v === "boolean") e[key] = v;
        else if (typeof v === "string") e[key] = v.slice(0, 250);
      }
      queue.push(e);
      if (queue.length >= QUEUE_MAX) flush();
    } catch (e) { /* never */ }
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    var events = queue.splice(0, queue.length);
    var payload;
    try { payload = JSON.stringify({ events: events }); } catch (e) { return; }
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" }));
        return;
      }
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
        mode: "same-origin"
      }).catch(function () {});
    } catch (e) { /* static hosting / offline — fine */ }
  }

  window.MX = { event: event, flush: flush };

  setInterval(flush, FLUSH_MS);
  window.addEventListener("pagehide", function () { flush(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });

  // ---- Page view ----
  try {
    event("page_view", baseProps());
    localStorage.setItem("lmp_returning", "1");
  } catch (e) {}

  // ---- Core Web Vitals ----
  (function vitals() {
    var ttfb, fcp, lcp, cls, inp, load, bytes, resCount;
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        ttfb = Math.round(nav.responseStart - nav.requestStart);
        load = Math.round(nav.loadEventEnd || nav.domComplete || 0);
      }
      var res = performance.getEntriesByType("resource");
      resCount = res.length;
      bytes = 0;
      for (var i = 0; i < res.length; i++) bytes += res[i].transferSize || 0;
    } catch (e) {}

    function obs(type, cb, opts) {
      try {
        var o = new PerformanceObserver(function (list) { cb(list); });
        o.observe(opts || { type: type, buffered: true });
      } catch (e) {}
    }

    obs("paint", function (list) {
      list.getEntries().forEach(function (en) {
        if (en.name === "first-contentful-paint") fcp = Math.round(en.startTime);
      });
    });
    obs("largest-contentful-paint", function (list) {
      var es = list.getEntries();
      if (es.length) lcp = Math.round(es[es.length - 1].startTime);
    });
    obs("layout-shift", function (list) {
      list.getEntries().forEach(function (en) {
        if (!en.hadRecentInput) cls = (cls || 0) + en.value;
      });
    }, { type: "layout-shift", buffered: true });
    // INP approximation: worst observed interaction duration.
    obs("event", function (list) {
      list.getEntries().forEach(function (en) {
        if (en.interactionId && (!inp || en.duration > inp)) inp = Math.round(en.duration);
      });
    }, { type: "event", durationThreshold: 40, buffered: true });

    function report() {
      if (reported) return; reported = true;
      event("page_load", {
        ttfb: ttfb, fcp: fcp, lcp: lcp,
        cls: cls != null ? Math.round(cls * 1000) / 1000 : null,
        inp: inp, load: load,
        bytes: bytes, res: resCount, page: pageName()
      });
    }
    var reported = false;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") { report(); flush(true); }
    });
    window.addEventListener("pagehide", report);
    setTimeout(report, 12000); // long-lived sessions still report once
  })();

  // ---- Error capture ----
  window.addEventListener("error", function (ev) {
    event("error", {
      msg: (ev.message || "Script error").slice(0, 250),
      line: ev.lineno || 0,
      src: ev.filename ? String(ev.filename).slice(-120) : null,
      page: pageName()
    });
  });
  window.addEventListener("unhandledrejection", function (ev) {
    var r = ev.reason;
    event("error", {
      msg: ("Unhandled rejection: " + (r && r.message ? r.message : typeof r === "string" ? r : "unknown")).slice(0, 250),
      page: pageName()
    });
  });

  // ---- Connectivity ----
  window.addEventListener("offline", function () { event("offline", { page: pageName() }); });
  window.addEventListener("online", function () { event("online", { page: pageName() }); });

  // ---- PWA install ----
  window.addEventListener("beforeinstallprompt", function () { event("install_prompt", { page: pageName() }); });
  window.addEventListener("appinstalled", function () { event("pwa_installed", { page: pageName() }); });

  // ---- CTA click tracking (delegated: signup/pricing buttons) ----
  document.addEventListener("click", function (ev) {
    try {
      var el = ev.target && ev.target.closest ? ev.target.closest("a[href], button.btn, .permit-cta, .action-btn") : null;
      if (!el) return;
      var href = el.getAttribute("href") || "";
      var isCta = /#signup|#pricing|auth\.html|dashboard/.test(href) || (el.className || "").indexOf("btn-primary") !== -1;
      if (!isCta) return;
      event("cta_click", {
        to: href.slice(0, 60),
        label: (el.textContent || "").trim().slice(0, 60),
        page: pageName()
      });
    } catch (e) {}
  }, true);
})();
