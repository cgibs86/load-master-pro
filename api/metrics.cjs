/*
 * BTU.ai — metrics engine (server side, zero dependencies).
 *
 * Collects, stores and serves operational metrics for the whole product:
 *   • Every HTTP request the server handles (method, path, status, latency,
 *     bytes, user-agent, referrer).
 *   • PermitIQ (/api/permit-search) outcomes: duration, model, sources, errors.
 *   • Client telemetry beacons from metrics.js (page views, Core Web Vitals,
 *     JS errors, PWA installs, funnel events: calcs, reports, signups, …).
 *   • System health: memory, event-loop lag, uptime, load average.
 *
 * Storage: append-only JSONL at data/metrics.jsonl (auto-created, gitignored)
 * plus an in-memory ring buffer (last 60,000 events) that survives restarts
 * by re-reading the file tail on boot. No external services, no dependencies.
 *
 * Privacy by design: metrics never contain street addresses, emails, API keys
 * or IP addresses — only city/state for calculations and random client ids.
 *
 * Routes (wired in serve.cjs):
 *   POST /api/metrics/collect   — client beacon {events:[…]}
 *   GET  /api/metrics/events    — {now, system, events} (ring buffer tail)
 *   GET  /api/metrics/system    — live system + integration health
 *   GET  /api/metrics/export    — full JSONL download
 *   POST /api/metrics/reset     — wipe memory + file
 *   POST /api/metrics/demo      — seed 48h of realistic demo data (marked)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "metrics.jsonl");
const RING_MAX = 60000;   // events kept in memory / served to the dashboard
const FILE_MAX_BYTES = 32 * 1024 * 1024; // compact the file beyond this
const MAX_EVENT_BYTES = 2048;

const ring = [];          // newest last
const sysHistory = [];    // {t, rss, heap, lag} samples (last ~15 min)
let bootTs = Date.now();
let lagMs = 0;

// ---------------- store ----------------

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function persist(events) {
  if (!events.length) return;
  try {
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(FILE, lines);
  } catch (e) { /* never let metrics take the app down */ }
}

function push(events) {
  for (const e of events) {
    ring.push(e);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  }
  persist(events);
}

function loadExisting() {
  ensureDir();
  let raw;
  try {
    const stat = fs.statSync(FILE);
    if (stat.size > FILE_MAX_BYTES) {
      // Keep only the tail so the file can't grow forever.
      const fh = fs.openSync(FILE, "r");
      const buf = Buffer.alloc(Math.min(stat.size, 8 * 1024 * 1024));
      fs.readSync(fh, buf, 0, buf.length, stat.size - buf.length);
      fs.closeSync(fh);
      raw = buf.toString("utf8");
      const nl = raw.indexOf("\n");
      raw = nl === -1 ? "" : raw.slice(nl + 1);
      fs.writeFileSync(FILE, raw); // compacted in place
    } else {
      raw = fs.statSync(FILE).size ? fs.readFileSync(FILE, "utf8") : "";
    }
  } catch (e) { raw = ""; }
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - RING_MAX);
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try { ring.push(JSON.parse(ln)); } catch (e) { /* skip torn line */ }
  }
}

// ---------------- event cleaning (defense in depth) ----------------

const CLIENT_KINDS = {
  page_view: 1, page_load: 1, error: 1, offline: 1, online: 1,
  install_prompt: 1, pwa_installed: 1, calc_start: 1, calc_success: 1,
  calc_fail: 1, photo_ai_start: 1, photo_ai_result: 1, photo_ai_fail: 1,
  report_generated: 1, share_result: 1, manual_adjust: 1, settings_saved: 1,
  signup: 1, login: 1, cta_click: 1, permit_email: 1
};

function cleanScalar(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 300);
  if (v == null) return null;
  return undefined; // drop
}

function cleanEvent(e) {
  if (!e || typeof e !== "object") return null;
  if (!e.k || !CLIENT_KINDS[e.k]) return null;
  const out = { k: e.k, t: typeof e.t === "number" && isFinite(e.t) ? Math.round(e.t) : Date.now(), src: "web" };
  let size = 64;
  for (const key of Object.keys(e)) {
    if (key === "k" || key === "t" || key === "src") continue;
    const v = cleanScalar(e[key]);
    if (v === undefined) continue;
    out[key] = v;
    size += key.length + String(v).length + 4;
    if (size > MAX_EVENT_BYTES) break;
  }
  return out;
}

// ---------------- system sampling ----------------

setInterval(() => {
  const t0 = process.hrtime.bigint();
  setTimeout(() => {
    lagMs = Number(process.hrtime.bigint() - t0) / 1e6 - 0;
    const m = process.memoryUsage();
    sysHistory.push({
      t: Date.now(), rss: m.rss, heap: m.heapUsed, ext: m.external, lag: Math.max(0, lagMs)
    });
    if (sysHistory.length > 600) sysHistory.splice(0, sysHistory.length - 600); // ~15 min at 1.5s
  }, 0);
}, 1500).unref();

function integrations() {
  let sdk = false;
  try { require.resolve("@anthropic-ai/sdk"); sdk = true; } catch (e) {}
  return {
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    anthropicSdk: sdk,
    permitModel: process.env.LMP_PERMIT_MODEL || "claude-opus-4-8 (default)",
    permitEffort: process.env.LMP_PERMIT_EFFORT || "medium (default)",
    port: process.env.PORT || 8099
  };
}

function systemSnapshot() {
  const m = process.memoryUsage();
  return Object.assign({
    now: Date.now(),
    bootTs: bootTs,
    processUptimeSec: Math.round(process.uptime()),
    osUptimeSec: Math.round(os.uptime()),
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    pid: process.pid,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    loadAvg: os.loadavg(),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    eventLoopLagMs: Math.round(lagMs * 100) / 100,
    eventsInMemory: ring.length,
    eventsTotal: ring.reduce((n, e) => n + (e.demo ? 0 : 1), 0),
    demoEvents: ring.reduce((n, e) => n + (e.demo ? 1 : 0), 0),
    fileBytes: (function () { try { return fs.statSync(FILE).size; } catch (e) { return 0; } })(),
    sysHistory: sysHistory.slice(-360)
  }, integrations());
}

// ---------------- request logging (called from serve.cjs) ----------------

const SKIP_LOG_PREFIXES = ["/api/metrics/"]; // instrumentation traffic

function logRequest(req, res, durationMs, bytes) {
  try {
    const url = req.url.split("?")[0];
    if (SKIP_LOG_PREFIXES.some((p) => url.startsWith(p))) return;
    ring.push({
      k: "req", t: Date.now(), m: req.method, p: url.slice(0, 300),
      s: res.statusCode, ms: Math.round(durationMs), b: bytes || 0,
      ua: String(req.headers["user-agent"] || "").slice(0, 250),
      ref: String(req.headers.referer || "direct").slice(0, 250),
      ip: undefined // deliberately not collected
    });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    // Persist lazily: batch req events so a busy dashboard doesn't thrash disk.
    pendingFlush.push(ring[ring.length - 1]);
    scheduleFlush();
  } catch (e) { /* never */ }
}

let pendingFlush = [];
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = pendingFlush; pendingFlush = [];
    if (batch.length) persist(batch);
  }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}

// ---------------- permit search logging ----------------

function logPermit(result, durationMs, input, model) {
  try {
    ring.push({
      k: "permit", t: Date.now(),
      ok: !!(result && result.ok),
      ms: Math.round(durationMs),
      model: model || (result && result.model) || null,
      sources: result && result.searchedSources ? result.searchedSources.length
              : result && result.data && Array.isArray(result.data.sources) ? result.data.sources.length : 0,
      error: result && result.error ? result.error : null,
      city: input && typeof input.city === "string" ? input.city.slice(0, 80) : null,
      state: input && typeof input.state === "string" ? input.state.slice(0, 20) : null
    });
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    persist([ring[ring.length - 1]]);
  } catch (e) { /* never */ }
}

function logBoot() {
  ring.push({ k: "boot", t: Date.now(), node: process.version, platform: os.platform(), port: process.env.PORT || 8099 });
  persist([ring[ring.length - 1]]);
}

// ---------------- demo data seeding ----------------
/* Generates ~48h of realistic, clearly-marked sample data so the dashboard
 * can be explored before real traffic exists. Uses a seeded PRNG for
 * reproducibility. All `demo:true` events are removable with one click. */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedDemo() {
  reset();
  const rnd = mulberry32(0xb70a);
  const R = () => rnd();
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const between = (a, b) => a + R() * (b - a);
  const gauss = () => (R() + R() + R() + R() + R() + R() - 3) / 3; // ~N(0, .34)

  const now = Date.now();
  const HOURS = 48;
  const ev = [];
  const add = (o) => ev.push(Object.assign({ t: 0, demo: true }, o));

  const visitors = {};
  const newVisitor = () => "v" + Math.random().toString(36).slice(2, 10);
  for (let i = 0; i < 260; i++) visitors[newVisitor()] = 1;
  const vids = Object.keys(visitors);
  const DEVICES = [
    { type: "mobile", os: "Android", browser: "Chrome Mobile", w: 0.42 },
    { type: "mobile", os: "iOS", browser: "Safari", w: 0.2 },
    { type: "desktop", os: "Windows", browser: "Chrome", w: 0.2 },
    { type: "desktop", os: "macOS", browser: "Safari", w: 0.07 },
    { type: "desktop", os: "macOS", browser: "Chrome", w: 0.06 },
    { type: "tablet", os: "iPadOS", browser: "Safari", w: 0.05 }
  ];
  const devicePool = [];
  DEVICES.forEach((d) => { const n = Math.round(d.w * 100); for (let i = 0; i < n; i++) devicePool.push(d); });
  const REFS = ["direct", "direct", "direct", "https://www.google.com/", "https://www.google.com/", "https://bing.com/",
    "https://www.facebook.com/", "https://www.instagram.com/", "https://www.reddit.com/r/HVAC/",
    "https://news.ycombinator.com/", "https://mail.google.com/"];
  const NETS = ["4g", "4g", "4g", "4g", "3g", "wifi-ish (4g)"];
  const CITIES = [
    ["Austin", "TX"], ["Phoenix", "AZ"], ["Dallas", "TX"], ["Denver", "CO"], ["Atlanta", "GA"],
    ["Nashville", "TN"], ["Charlotte", "NC"], ["Kansas City", "MO"], ["Sacramento", "CA"], ["Boise", "ID"],
    ["Orlando", "FL"], ["Columbus", "OH"], ["Indianapolis", "IN"], ["Salt Lake City", "UT"], ["Tucson", "AZ"],
    ["San Antonio", "TX"], ["Raleigh", "NC"], ["Oklahoma City", "OK"], ["Albuquerque", "NM"], ["Louisville", "KY"]
  ];
  const ERRORS = [
    "TypeError: Cannot read properties of undefined (reading 'lat')",
    "Uncaught (in promise) Error: geocode http 503",
    "TypeError: NetworkError when attempting to fetch resource",
    "SyntaxError: Unexpected token < in JSON at position 0",
    "Uncaught (in promise) Error: Permit research failed: rate_limited"
  ];

  // Hour-by-hour traffic curve (busiest 8am–8pm local, ramping growth over 2 days).
  for (let h = HOURS; h >= 0; h--) {
    const hourStart = now - h * 3600e3;
    const hourOfDay = new Date(hourStart).getHours();
    const diurnal = Math.max(0.08, Math.sin(((hourOfDay - 5) / 24) * Math.PI * 2) * 0.5 + 0.55);
    const growth = 1 + (HOURS - h) / HOURS * 0.35;
    const views = Math.round(between(6, 14) * diurnal * growth);
    for (let v = 0; v < views; v++) {
      const t = Math.round(hourStart + R() * 3600e3);
      const vid = pick(vids);
      const dev = pick(devicePool);
      const page = R() < 0.46 ? "landing" : R() < 0.82 ? "app" : "auth";
      const mobile = dev.type !== "desktop";
      add({
        k: "page_view", t, vid, sid: vid.slice(0, 4) + ((t / 36e5) | 0), page, ref: pick(REFS),
        device: dev.type, os: dev.os, browser: dev.browser, lang: "en-US",
        net: pick(NETS), standalone: R() < 0.14, sw: R() < 0.62, online: true,
        dpr: mobile ? pick([2, 2, 3]) : pick([1, 1, 2]), returning: R() < 0.36
      });
      // Web vitals — slower on mobile.
      const slow = mobile ? 1.5 : 1;
      add({
        k: "page_load", t: t + 200, vid, page,
        ttfb: Math.max(40, Math.round((140 + Math.abs(gauss()) * 380) * (mobile ? 1.6 : 1))),
        fcp: Math.max(300, Math.round((800 + Math.abs(gauss()) * 1200) * slow)),
        lcp: Math.max(500, Math.round((1600 + Math.abs(gauss()) * 1900) * slow)),
        cls: Math.round(Math.max(0, Math.abs(gauss()) * 0.14) * 1000) / 1000,
        inp: Math.round(Math.max(30, (90 + Math.abs(gauss()) * 160) * slow)),
        load: Math.round((1500 + Math.abs(gauss()) * 2600) * slow),
        bytes: Math.round(between(90e3, 480e3)), res: Math.round(between(8, 26))
      });
      // Server request log entry for the document hit.
      add({
        k: "req", t, m: "GET", p: page === "landing" ? "/index.html" : "/" + page + ".html",
        s: 200, ms: Math.round(between(2, 34)), b: Math.round(between(6000, 60000)),
        ua: dev.browser + "/" + dev.os, ref: pick(REFS)
      });
      if (R() < 0.55) add({ k: "req", t: t + 30, m: "GET", p: pick(["/styles.css", "/app.js", "/landing.css", "/loadcalc.js", "/climate-data.js", "/icons/icon-192.png"]), s: 200, ms: Math.round(between(1, 14)), b: Math.round(between(2000, 42000)), ua: dev.browser, ref: "same-origin" });
      if (R() < 0.012) add({ k: "req", t, m: "GET", p: pick(["/favicon.ico", "/apple-touch-icon.png", "/old-page.html"]), s: 404, ms: 1, b: 90, ua: dev.browser, ref: "direct" });
      if (R() < 0.003) add({ k: "req", t, m: "GET", p: pick(["/app.html", "/index.html"]), s: 500, ms: Math.round(between(30, 120)), b: 120, ua: dev.browser, ref: "direct" });

      // Errors — ~1.1% of views.
      if (R() < 0.011) add({ k: "error", t: t + 3000, vid, page, msg: pick(ERRORS), line: Math.round(between(80, 1100)) });

      // Funnel: app page views → calcs.
      if (page === "app" && R() < 0.44) {
        const started = t + Math.round(between(4e3, 90e3));
        add({ k: "calc_start", t: started, vid, via: R() < 0.93 ? "address" : "geo" });
        const dur = Math.round(1200 + Math.abs(gauss()) * 3200);
        if (R() < 0.93) {
          const [city, state] = pick(CITIES);
          const tons = pick([1.5, 2, 2, 2.5, 2.5, 3, 3, 3.5, 3.5, 4, 4, 5]);
          add({
            k: "calc_success", t: started + dur, vid, ms: dur, via: "address",
            climate: R() < 0.78 ? "live" : "station", hours: Math.round(between(8500, 8760)),
            prop: R() < 0.36 ? "fetched" : "estimate",
            tons, city, state, area: Math.round(between(900, 4200)),
            heating: Math.round(tons * between(11000, 16000)),
            cooling: Math.round(tons * between(10000, 13500))
          });
          if (R() < 0.56) add({ k: "report_generated", t: started + dur + Math.round(between(2e3, 40e3)), vid, permit: R() < 0.3 });
          if (R() < 0.11) add({ k: "share_result", t: started + dur + Math.round(between(5e3, 30e3)), vid });
          if (R() < 0.22) {
            add({ k: "photo_ai_start", t: started + dur + 8000, vid, photos: Math.round(between(2, 6)) });
            if (R() < 0.88) add({ k: "photo_ai_result", t: started + dur + 8000 + Math.round(between(9e3, 26e3)), vid, findings: Math.round(between(3, 9)), applied: Math.round(between(0, 5)) });
            else add({ k: "photo_ai_fail", t: started + dur + 8000 + 2000, vid, msg: "rate_limited" });
          }
          if (R() < 0.09) {
            const pd = Math.round(between(11000, 48000));
            const ok = R() < 0.9;
            const pc = pick(CITIES);
            add({
              k: "permit", t: started + dur + 20000, ok, ms: pd, model: "claude-opus-4-8",
              sources: ok ? Math.round(between(3, 9)) : 0,
              error: ok ? null : pick(["rate_limited", "parse_failed", "api_error"]),
              city: pc[0], state: pc[1], demo: true
            });
          }
          if (R() < 0.15) add({ k: "manual_adjust", t: started + dur + Math.round(between(3e3, 60e3)), vid, fields: pick(["area", "quality", "foundation,sun", "ceiling", "area,bedrooms"]) });
        } else {
          add({ k: "calc_fail", t: started + 2500, vid, via: "address", msg: pick(["geocode http 503", "We couldn't find that address. Try adding the city and state.", "network"]) });
        }
      }
      // Landing CTAs & signups.
      if (page === "landing" && R() < 0.12) add({ k: "cta_click", t: t + Math.round(between(3e3, 60e3)), vid, to: pick(["auth#signup", "#pricing", "app.html"]) });
      if (page === "auth" && R() < 0.34) {
        add({ k: R() < 0.6 ? "signup" : "login", t: t + Math.round(between(5e3, 90e3)), vid, plan: pick(["trial", "trial", "trial", "solo", "pro", "pro", "fleet"]) });
      }
      if (R() < 0.004) add({ k: "pwa_installed", t: t + 5000, vid });
      if (R() < 0.01) add({ k: "offline", t: t + 20000, vid, page });
    }
  }
  ev.sort((a, b) => a.t - b.t);
  push(ev);
  return { seeded: ev.length };
}

// ---------------- reset / export ----------------

function reset() {
  ring.length = 0;
  try { fs.writeFileSync(FILE, ""); } catch (e) {}
}

// ---------------- HTTP interface ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/** Returns true if the request was a metrics API route (and was answered). */
function handleApi(urlPath, req, res, body) {
  if (urlPath === "/api/metrics/collect" && req.method === "POST") {
    const events = body && Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    const clean = events.map(cleanEvent).filter(Boolean);
    if (clean.length) push(clean);
    return sendJson(res, 200, { ok: true, accepted: clean.length }), true;
  }
  if (urlPath === "/api/metrics/events") {
    const since = Number(req.url.split("since=")[1]) || 0;
    const events = since ? ring.filter((e) => e.t > since) : ring;
    return sendJson(res, 200, { now: Date.now(), system: systemSnapshot(), events }), true;
  }
  if (urlPath === "/api/metrics/system") {
    return sendJson(res, 200, systemSnapshot()), true;
  }
  if (urlPath === "/api/metrics/export") {
    let raw = "";
    try { raw = fs.readFileSync(FILE, "utf8"); } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": "attachment; filename=metrics.jsonl" });
    res.end(raw);
    return true;
  }
  if (urlPath === "/api/metrics/reset" && req.method === "POST") {
    reset();
    return sendJson(res, 200, { ok: true }), true;
  }
  if (urlPath === "/api/metrics/demo" && req.method === "POST") {
    const r = seedDemo();
    return sendJson(res, 200, { ok: true, seeded: r.seeded }), true;
  }
  return false;
}

// ---------------- boot ----------------

loadExisting();
bootTs = (ring.length ? ring[0].t : Date.now());

module.exports = { handleApi, logRequest, logPermit, logBoot, systemSnapshot, seedDemo, reset };
