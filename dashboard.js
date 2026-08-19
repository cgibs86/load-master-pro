/* BTU.ai — Ops control board (dashboard.js)
 *
 * Self-hosted, zero-dependency analytics dashboard. Fetches the metrics ring
 * buffer from /api/metrics/events and renders every aspect of the product:
 * traffic, web-vitals, funnel, backend/API health, live request stream.
 * All charts are hand-rolled SVG. Runs entirely in the browser.
 */
"use strict";

/* ================= utilities ================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const fmtPct = (n, d) => (n == null || !isFinite(n) ? "—" : n.toFixed(d == null ? 1 : d) + "%");
const fmtMs = (n) => (n == null ? "—" : n >= 10000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms");
const fmtBytes = (n) => (n == null ? "—" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
function fmtDur(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  return m + "m " + Math.floor(sec % 60) + "s";
}
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const hhmmss = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
const dayTime = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function timeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escAttr = esc;
function percentile(sorted, p) {
  if (!sorted || !sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function groupCount(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it) || "unknown";
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function topN(map, n) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}
function delta(cur, prev) {
  if (prev === 0) return cur === 0 ? 0 : null; // null → "new"
  return ((cur - prev) / prev) * 100;
}

/* ================= state ================= */

const S = {
  events: [],
  system: null,
  range: 21600000, // 6h default
  tab: "overview",
  auto: true,
  serverUp: null,
  lastT: 0,
  paused: false,
  liveFilter: "",
  liveStatus: ""
};

/* ================= data layer ================= */

async function fetchEvents(since) {
  const url = since ? "/api/metrics/events?since=" + since : "/api/metrics/events";
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}

async function refresh(incr) {
  let d;
  try {
    d = await fetchEvents(incr && S.lastT ? S.lastT : 0);
    S.serverUp = true;
  } catch (e) {
    S.serverUp = false;
    updateTopbar();
    return;
  }
  if (!incr || !S.lastT) S.events = d.events || [];
  else if (d.events && d.events.length) S.events = S.events.concat(d.events);
  if (S.events.length > 65000) S.events.splice(0, S.events.length - 60000);
  // Use the newest event time (not server 'now') as the incremental cursor so
  // events written between request and response are never skipped.
  const newest = S.events.length ? S.events[S.events.length - 1].t : 0;
  S.lastT = Math.max(S.lastT, newest, (d.now || 0) - 1500);
  S.system = d.system;
  updateTopbar();
  renderActiveTab();
  updateEmptyState();
}

function updateEmptyState() {
  const empty = S.events.length === 0;
  if (empty && S.serverUp) {
    $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("#tab-empty").classList.remove("hidden");
  } else if (!empty) {
    showTab(S.tab, true);
  }
}

/* ================= range helpers ================= */

function rangeEvents() {
  const now = S.lastT || Date.now();
  if (!S.range) return S.events;
  return S.events.filter((e) => e.t >= now - S.range);
}
function prevEvents() {
  if (!S.range) return [];
  const now = S.lastT || Date.now();
  return S.events.filter((e) => e.t >= now - 2 * S.range && e.t < now - S.range);
}
function inLast(ms, kind) {
  const now = S.lastT || Date.now();
  return S.events.filter((e) => e.t >= now - ms && (!kind || e.k === kind));
}
function bucketMs(rangeMs, spanMs) {
  const span = rangeMs || spanMs || 3600000;
  if (span <= 900000) return 30000;
  if (span <= 3600000) return 120000;
  if (span <= 21600000) return 600000;
  if (span <= 86400000) return 1800000;
  if (span <= 604800000) return 7200000;
  return Math.max(3600000, Math.round(span / 900000 / 3600000) * 3600000);
}

/* ================= chart library (SVG) ================= */

const TT = (() => {
  let el = null;
  function show(x, y, html) {
    if (!el) { el = document.createElement("div"); el.className = "tt"; document.body.appendChild(el); }
    el.innerHTML = html;
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.display = "block";
  }
  function hide() { if (el) el.style.display = "none"; }
  return { show, hide };
})();

/* Multi-series time line/area chart with hover crosshair. */
function timeSeries(host, seriesArr, opts) {
  opts = opts || {};
  const host2 = typeof host === "string" ? $(host) : host;
  if (!host2) return;
  const W = Math.max(320, host2.clientWidth || 600);
  const H = opts.height || 230;
  const PADL = 44, PADR = 12, PADT = 12, PADB = 24;
  const n = seriesArr[0] ? seriesArr[0].values.length : 0;
  if (!n) {
    host2.innerHTML = '<div class="muted" style="padding:40px 0;text-align:center">No data in this range</div>';
    return;
  }
  const maxV = Math.max(1, ...seriesArr.map((s) => Math.max(...s.values)));
  const niceMax = niceCeil(maxV);
  const iw = W - PADL - PADR, ih = H - PADT - PADB;
  const X = (i) => PADL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v) => PADT + ih - (Math.min(v, niceMax) / niceMax) * ih;

  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = PADT + (ih * i) / 4;
    g += '<line class="gridline" x1="' + PADL + '" y1="' + y + '" x2="' + (W - PADR) + '" y2="' + y + '"/>';
    g += '<text class="axis" x="' + (PADL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + fmtAxis(niceMax * (1 - i / 4)) + "</text>";
  }
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(iw / 90))));
  for (let i = 0; i < n; i += labelEvery) {
    g += '<text class="axis" x="' + X(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + (opts.xLabels ? opts.xLabels[i] : hhmm(seriesArr[0].ts[i])) + "</text>";
  }
  let paths = "";
  seriesArr.forEach((s) => {
    let pts = "";
    for (let i = 0; i < n; i++) pts += (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(s.values[i]).toFixed(1);
    if (opts.area !== false) {
      paths += '<path d="' + pts + "L" + X(n - 1).toFixed(1) + "," + (PADT + ih).toFixed(1) + "L" + X(0).toFixed(1) + "," + (PADT + ih).toFixed(1) + 'Z" fill="' + s.color + '" opacity="0.10"/>';
    }
    paths += '<path d="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  });
  host2.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' + g + '<g class="series">' + paths + "</g>" +
    '<line class="cross" x1="0" x2="0" y1="' + PADT + '" y2="' + (PADT + ih) + '" stroke="rgba(255,255,255,.35)" stroke-dasharray="3 4" opacity="0"/>' +
    '<rect class="ov" x="' + PADL + '" y="' + PADT + '" width="' + iw + '" height="' + ih + '" fill="transparent"/></svg>';

  const svg = host2.querySelector("svg");
  const cross = svg.querySelector(".cross");
  const ov = svg.querySelector(".ov");
  ov.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - PADL) / iw) * (n - 1))));
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("opacity", "1");
    const t = seriesArr[0].ts[i];
    let html = '<div class="tt-time">' + dayTime(t) + "</div>";
    seriesArr.forEach((s) => {
      html += '<div class="row"><span class="sw" style="background:' + s.color + '"></span>' + esc(s.label) + " <b>" + fmtInt(s.values[i]) + "</b></div>";
    });
    TT.show(ev.clientX, ev.clientY, html);
  });
  ov.addEventListener("pointerleave", () => { TT.hide(); cross.setAttribute("opacity", "0"); });
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}
function fmtAxis(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k";
  return Math.round(v);
}

/* KPI sparkline */
function sparkline(host, values, color) {
  const host2 = typeof host === "string" ? $(host) : host;
  if (!host2) return;
  if (!values.length) { host2.innerHTML = ""; return; }
  const W = 200, H = 30, max = Math.max(1, ...values);
  let pts = "";
  values.forEach((v, i) => {
    pts += (i ? "L" : "M") + ((i / Math.max(1, values.length - 1)) * W).toFixed(1) + "," + (H - 4 - (v / max) * (H - 8)).toFixed(1);
  });
  host2.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
    '<path d="' + pts + "L" + W + "," + H + "L0," + H + 'Z" fill="' + color + '" opacity="0.12"/>' +
    '<path d="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6"/></svg>';
}

/* Horizontal bar list */
function barList(host, rows, opts) {
  opts = opts || {};
  const host2 = typeof host === "string" ? $(host) : host;
  if (!host2) return;
  if (!rows || !rows.length) { host2.innerHTML = '<div class="muted" style="padding:14px 2px">No data</div>'; return; }
  const max = Math.max(...rows.map((r) => r[1]));
  const colorClass = opts.colorClass ? " " + opts.colorClass : "";
  host2.innerHTML = '<div class="bars">' + rows.map(([label, val]) =>
    '<div class="bar-item' + colorClass + '">' +
    '<div class="bi-top"><span title="' + escAttr(label) + '">' + esc(label) + '</span><b>' + fmtInt(val) + (opts.unit || "") + "</b></div>" +
    '<div class="bi-track"><div class="bi-fill" style="width:' + (val / max) * 100 + '%"></div></div>' +
    "</div>").join("") + "</div>";
}

/* Donut with side legend */
function donut(items, centerLabel, centerSub) {
  const total = sum(items.map((i) => i.value)) || 1;
  const R = 38, C = 2 * Math.PI * R;
  let off = 0, segs = "";
  for (const it of items) {
    if (!it.value) continue;
    const frac = it.value / total;
    segs += '<circle r="' + R + '" cx="50" cy="50" fill="none" stroke="' + it.color + '" stroke-width="11"' +
      ' stroke-dasharray="' + (frac * C).toFixed(2) + " " + C.toFixed(2) + '" stroke-dashoffset="' + (-off * C).toFixed(2) + '"' +
      ' transform="rotate(-90 50 50)"><title>' + esc(it.label) + ": " + fmtInt(it.value) + " (" + (frac * 100).toFixed(0) + "%)</title></circle>";
    off += frac;
  }
  return '<div class="donut"><svg width="104" height="104" viewBox="0 0 100 100">' + segs + '</svg>' +
    '<div class="donut-c"><div style="text-align:center"><div>' + centerLabel + '</div><div style="font-size:9px;color:var(--muted-2);font-weight:600">' + (centerSub || "") + "</div></div></div></div>" +
    '<div class="bars" style="flex:1;min-width:150px">' + items.map((it) =>
      '<div class="bar-item"><div class="bi-top"><span><span class="lg-dot" style="background:' + it.color + '"></span> ' + esc(it.label) + "</span>" +
      "<b>" + fmtInt(it.value) + " · " + (it.value / total * 100).toFixed(0) + "%</b></div></div>").join("") + "</div>";
}

/* Histogram */
function histogram(host, values, opts) {
  opts = opts || {};
  const host2 = typeof host === "string" ? $(host) : host;
  if (!host2) return;
  const vals = values.filter((v) => v != null);
  if (!vals.length) { host2.innerHTML = '<div class="muted" style="padding:30px 0;text-align:center">No data</div>'; return; }
  const r = histBuckets(vals, opts.bins || 14, opts.zeroStart);
  const edges = r.edges, counts = r.counts;
  const max = Math.max(...counts);
  host2.innerHTML = '<div class="hist-bars">' + counts.map((c, i) => {
    const label = opts.fmt ? opts.fmt(edges[i], edges[i + 1]) : Math.round(edges[i]) + (opts.unit || "");
    return '<div class="hist-col" title="' + esc(label) + ": " + c + '"><div class="hc-val">' + (c || "") + "</div>" +
      '<div class="hc-bar" style="height:' + (c / max) * 100 + '%"></div><div class="hc-lab">' + esc(label) + "</div></div>";
  }).join("") + "</div>";
}
function histBuckets(vals, bins, zeroStart) {
  const sorted = vals.slice().sort((a, b) => a - b);
  let min = zeroStart ? 0 : sorted[0];
  let max = sorted[sorted.length - 1];
  if (min === max) max = min + 1;
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of vals) {
    let i = Math.floor((v - min) / width);
    if (i >= bins) i = bins - 1;
    if (i < 0) i = 0;
    counts[i]++;
  }
  const edges = [];
  for (let i = 0; i <= bins; i++) edges.push(min + i * width);
  return { edges, counts };
}

/* Funnel viz */
function funnelViz(stages) {
  if (!stages.length || !stages[0].count) return '<div class="muted" style="padding:14px 2px">No data yet</div>';
  const top = stages[0].count;
  return '<div class="funnel">' + stages.map((st, i) => {
    const prev = i ? stages[i - 1].count : null;
    const pctOfTop = (st.count / top) * 100;
    const conv = prev ? (st.count / prev) * 100 : null;
    return '<div class="f-stage">' +
      '<div class="f-top"><span>' + esc(st.label) + (prev != null && conv != null ? ' <span class="f-drop">· ' + fmtPct(conv, 0) + " from previous</span>" : "") + "</span>" +
      "<span><b>" + fmtInt(st.count) + '</b> <span class="f-pct">' + fmtPct(pctOfTop, 0) + "</span></span></div>" +
      '<div class="f-track"><div class="f-fill" style="width:' + Math.max(2, pctOfTop) + '%">' + (pctOfTop > 18 ? fmtPct(pctOfTop, 0) : "") + "</div></div>" +
      "</div>";
  }).join("") + "</div>";
}

/* Web-vital meter */
function vitalMeter(name, unit, vals, thresholds, fmt) {
  const s = vals.filter((v) => v != null).sort((a, b) => a - b);
  const p50 = percentile(s, 50), p75 = percentile(s, 75), p90 = percentile(s, 90);
  if (p75 == null) {
    return '<div class="vital"><div class="v-name">' + name + '</div><div class="v-val">—</div><div class="v-legend"><span>no data</span></div></div>';
  }
  const good = thresholds[0], poor = thresholds[1];
  const grade = (v) => (v <= good ? "good" : v <= poor ? "warn" : "bad");
  const scaleMax = poor * 1.6;
  const pos = (v) => Math.min(100, (v / scaleMax) * 100);
  const goodW = pos(good), poorW = pos(poor) - pos(good), badW = 100 - pos(poor);
  const n = s.length || 1;
  const g = s.filter((v) => v <= good).length;
  const o = s.filter((v) => v > good && v <= poor).length;
  const dist = { good: Math.round(g / n * 100), ok: Math.round(o / n * 100), bad: Math.round((n - g - o) / n * 100) };
  return '<div class="vital">' +
    '<div class="v-name">' + name + "</div>" +
    '<div class="v-val ' + grade(p75) + '" title="p75">' + fmt(p75) + '<small style="font-size:11px;color:var(--muted-2)"> ' + unit + "</small></div>" +
    '<div class="v-zones"><i style="width:' + goodW + '%;background:rgba(52,211,153,.55)"></i><i style="width:' + poorW + '%;background:rgba(251,191,36,.5)"></i><i style="width:' + badW + '%;background:rgba(248,113,113,.45)"></i>' +
    '<span class="v-mark" style="left:' + pos(p50) + '%" title="p50"></span>' +
    '<span class="v-mark" style="left:' + pos(p75) + '%;background:#fff" title="p75"></span>' +
    '<span class="v-mark" style="left:' + pos(p90) + '%;background:var(--violet)" title="p90"></span></div>' +
    '<div class="v-legend"><span>0</span><span>' + fmt(good) + " · " + fmt(poor) + "</span></div>" +
    '<div class="v-pcts"><span class="g">' + dist.good + '% good</span><span class="n">' + dist.ok + "% ok</span><span class=\"p\">" + dist.bad + "% poor</span></div>" +
    '<div class="v-legend" style="margin-top:5px"><span>p50 ' + fmt(p50) + "</span><span>p90 " + fmt(p90) + "</span></div>" +
    "</div>";
}

/* mini table helper */
function table(host, cols, rows) {
  const host2 = typeof host === "string" ? $(host) : host;
  if (!host2) return;
  if (!rows || !rows.length) { host2.innerHTML = '<div class="muted" style="padding:12px 2px">No data</div>'; return; }
  host2.innerHTML = '<table class="mini-table"><thead><tr>' + cols.map((c) => '<th class="' + (c.num ? "num" : "") + '">' + c.label + "</th>").join("") + "</tr></thead>" +
    "<tbody>" + rows.map((r) => "<tr>" + r.map((cell, i) => '<td class="' + (cols[i].num ? "num" : "") + '">' + cell + "</td>").join("") + "</tr>").join("") + "</tbody></table>";
}

/* ================= topbar ================= */

function updateTopbar() {
  const pill = $("#serverPill");
  if (S.serverUp === true) { pill.classList.add("up"); pill.classList.remove("down"); $("#serverPillText").textContent = "server online"; }
  else if (S.serverUp === false) { pill.classList.add("down"); pill.classList.remove("up"); $("#serverPillText").textContent = "server offline"; }
  $("#offlineBanner").classList.toggle("hidden", S.serverUp !== false);
  $("#chipClock").textContent = hhmmss(Date.now());
  const sys = S.system;
  if (sys) {
    $("#chipUptime").textContent = "up " + fmtDur(sys.processUptimeSec);
    $("#chipUptime").title = "Node " + sys.node + " · " + sys.platform + " · pid " + sys.pid;
  }
  const active = new Set(inLast(300000, "page_view").map((e) => e.vid)).size;
  $("#chipActive").textContent = "● " + active + " active";
  $("#chipActive").title = active + " visitor(s) viewed a page in the last 5 min";
  const rpm = inLast(60000, "req").length;
  $("#chipRpm").textContent = rpm + " req/min";
  const demo = S.events.some((e) => e.demo);
  $("#chipDemo").classList.toggle("hidden", !demo);
  const real = S.events.filter((e) => !e.demo).length;
  $("#footStat").textContent = fmtInt(S.events.length) + " events in memory · " + fmtBytes(sys ? sys.fileBytes : 0) + " on disk" + (demo ? " · " + fmtInt(real) + " real" : "");
  $("#autoBtn").classList.toggle("paused", !S.auto);
  $("#autoBtnText").textContent = S.auto ? "Live" : "Paused";
}

/* ================= KPI card builder ================= */

function kpiCard(o) {
  const d = o.delta;
  let dHtml;
  if (o.showDelta === false) dHtml = "";
  else if (d == null) dHtml = '<span class="k-delta flat">no baseline</span>';
  else if (d === 0) dHtml = '<span class="k-delta flat">no change</span>';
  else dHtml = '<span class="k-delta ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "▲" : "▼") + " " + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0) + "%</span>";
  return '<div class="kpi" data-goto="' + (o.goto || "") + '" title="' + escAttr(o.hint || "") + '">' +
    '<div class="k-label">' + esc(o.label) + "</div>" +
    '<div class="k-value">' + o.value + "</div>" +
    (o.sub ? '<div class="k-sub">' + o.sub + "</div>" : "") +
    dHtml +
    '<div class="k-spark" data-spark="' + (o.sparkId || "") + '"></div>' +
    "</div>";
}

/* ================= TAB: OVERVIEW ================= */

function renderOverview() {
  const ev = rangeEvents(), prev = prevEvents();
  const now = S.lastT || Date.now();
  const span = ev.length ? now - ev[0].t : S.range;

  const views = ev.filter((e) => e.k === "page_view");
  const viewsP = prev.filter((e) => e.k === "page_view");
  const reqs = ev.filter((e) => e.k === "req");
  const reqsP = prev.filter((e) => e.k === "req");
  const visitors = new Set(views.map((e) => e.vid)).size;
  const visitorsP = new Set(viewsP.map((e) => e.vid)).size;
  const calcOk = ev.filter((e) => e.k === "calc_success");
  const calcOkP = prev.filter((e) => e.k === "calc_success");
  const starts = ev.filter((e) => e.k === "calc_start").length;
  const permits = ev.filter((e) => e.k === "permit");
  const permitsP = prev.filter((e) => e.k === "permit");
  const errors = ev.filter((e) => e.k === "error").length;
  const errorsP = prev.filter((e) => e.k === "error").length;
  const reports = ev.filter((e) => e.k === "report_generated").length;
  const reportsP = prev.filter((e) => e.k === "report_generated").length;
  const loads = ev.filter((e) => e.k === "page_load");
  const lcpP75 = percentile(loads.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b), 75);

  $("#kpiRow").innerHTML =
    kpiCard({ label: "Requests", value: fmtInt(reqs.length), delta: delta(reqs.length, reqsP.length), sparkId: "sp1", goto: "backend", hint: "HTTP requests served" }) +
    kpiCard({ label: "Page views", value: fmtInt(views.length), delta: delta(views.length, viewsP.length), sparkId: "sp2", goto: "traffic", hint: "Client page views (all pages)" }) +
    kpiCard({ label: "Unique visitors", value: fmtInt(visitors), delta: delta(visitors, visitorsP), sparkId: "sp3", goto: "traffic" }) +
    kpiCard({ label: "Calculations", value: fmtInt(calcOk.length), delta: delta(calcOk.length, calcOkP.length), sparkId: "sp4", goto: "product", sub: starts ? fmtPct((calcOk.length / starts) * 100, 0) + " success rate" : "" }) +
    kpiCard({ label: "PermitIQ searches", value: fmtInt(permits.length), delta: delta(permits.length, permitsP.length), sparkId: "sp5", goto: "backend", sub: permits.length ? fmtPct((permits.filter((p) => p.ok).length / permits.length) * 100, 0) + " succeeded" : "" }) +
    kpiCard({ label: "Reports generated", value: fmtInt(reports), delta: delta(reports, reportsP), sparkId: "sp6", goto: "product" }) +
    kpiCard({ label: "JS errors", value: fmtInt(errors), delta: delta(errors, errorsP), sparkId: "sp7", goto: "frontend", sub: views.length ? (errors / views.length * 100).toFixed(2) + "% of views" : "" }) +
    kpiCard({ label: "p75 LCP", value: lcpP75 ? fmtMs(lcpP75) : "—", showDelta: false, goto: "frontend", sub: lcpP75 ? (lcpP75 <= 2500 ? "good" : lcpP75 <= 4000 ? "needs work" : "poor") : "Core Web Vitals" });

  const bMs = bucketMs(S.range, span);
  const bCount = Math.min(48, Math.max(6, Math.floor((S.range || span) / bMs)));
  const series = buildSeries(ev, bMs, bCount, now);
  sparkline($('[data-spark="sp1"]'), series.req, "#6ea8ff");
  sparkline($('[data-spark="sp2"]'), series.view, "#3ad7e6");
  sparkline($('[data-spark="sp3"]'), series.visitors, "#a78bfa");
  sparkline($('[data-spark="sp4"]'), series.calc, "#34d399");
  sparkline($('[data-spark="sp5"]'), series.permit, "#ff8a5c");
  sparkline($('[data-spark="sp6"]'), series.report, "#6d7bff");
  sparkline($('[data-spark="sp7"]'), series.err, "#f87171");

  timeSeries($("#trafficChart"), [
    { label: "Requests", color: "#6ea8ff", values: series.req, ts: series.ts },
    { label: "Page views", color: "#3ad7e6", values: series.view, ts: series.ts }
  ], { height: 240 });
  $("#trafficLegend").innerHTML = '<span class="row"><span class="lg-dot" style="background:#6ea8ff"></span>requests</span>' +
    '<span class="row"><span class="lg-dot" style="background:#3ad7e6"></span>page views</span>';

  const appViews = views.filter((e) => e.page === "app").length;
  const landViews = views.filter((e) => e.page === "landing").length;
  $("#funnelViz").innerHTML = funnelViz([
    { label: "Landing views", count: landViews },
    { label: "App opened", count: appViews },
    { label: "Calcs started", count: starts },
    { label: "Calcs succeeded", count: calcOk.length },
    { label: "Reports generated", count: reports }
  ]);
  $("#funnelRange").textContent = rangeLabel();

  renderSystemHealth();
  renderAlerts();
}

function buildSeries(ev, bMs, bCount, now) {
  const rangeMs = S.range || (ev.length ? now - ev[0].t : 3600000);
  const n = bCount;
  const mk = () => new Array(n).fill(0);
  const req = mk(), view = mk(), calc = mk(), permit = mk(), report = mk(), err = mk();
  const visitors = [];
  for (let i = 0; i < n; i++) visitors.push(new Set());
  const start = now - rangeMs;
  for (const e of ev) {
    if (e.t < start) continue;
    const i = Math.min(n - 1, Math.floor((e.t - start) / bMs));
    if (i < 0) continue;
    switch (e.k) {
      case "req": req[i]++; break;
      case "page_view": view[i]++; visitors[i].add(e.vid); break;
      case "calc_success": calc[i]++; break;
      case "permit": permit[i]++; break;
      case "report_generated": report[i]++; break;
      case "error": err[i]++; break;
    }
  }
  const ts = [];
  for (let i = 0; i < n; i++) ts.push(start + i * bMs);
  return { req, view, calc, permit, report, err, ts, visitors: visitors.map((s) => s.size) };
}

function renderSystemHealth() {
  const sys = S.system;
  if (!sys) { $("#systemHealth").innerHTML = '<div class="muted">Waiting for server…</div>'; return; }
  const lag = sys.eventLoopLagMs;
  const lagGrade = lag < 10 ? "ok" : lag < 50 ? "warn" : "bad";
  const memGrade = sys.rss < 300e6 ? "ok" : sys.rss < 600e6 ? "warn" : "bad";
  $("#systemHealth").innerHTML =
    '<div class="sys-grid">' +
    kv("Uptime", fmtDur(sys.processUptimeSec)) +
    kv("Memory (RSS)", '<span class="badge ' + memGrade + '">' + fmtBytes(sys.rss) + "</span>") +
    kv("Heap used", fmtBytes(sys.heapUsed)) +
    kv("Event-loop lag", '<span class="badge ' + lagGrade + '">' + (lag < 1 ? "<1" : lag.toFixed(1)) + " ms</span>") +
    kv("Node", sys.node) +
    kv("Platform", sys.platform + " · " + sys.arch) +
    kv("CPUs / load", sys.cpus + " · " + sys.loadAvg.map((l) => l.toFixed(2)).join(" ")) +
    kv("Server restarts (logged)", fmtInt(S.events.filter((e) => e.k === "boot").length)) +
    "</div>" +
    '<div class="mt8" id="memChart" style="height:90px"></div>';
  const hist = sys.sysHistory || [];
  if (hist.length > 1) {
    const W = 600, H = 90, max = Math.max(...hist.map((h) => h.rss)) * 1.1;
    let path = "";
    hist.forEach((h, i) => {
      path += (i ? "L" : "M") + ((i / (hist.length - 1)) * W).toFixed(1) + "," + (H - (h.rss / max) * H).toFixed(1);
    });
    $("#memChart").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<path d="' + path + "L" + W + "," + H + "L0," + H + 'Z" fill="rgba(110,168,255,.15)"/>' +
      '<path d="' + path + '" fill="none" stroke="#6ea8ff" stroke-width="1.5"/></svg>' +
      '<div class="v-legend"><span>memory · last ~10 min</span><span>peak ' + fmtBytes(max) + "</span></div>";
  }
}
function kv(k, v) { return '<div class="kv"><span>' + esc(k) + "</span><b>" + v + "</b></div>"; }

function renderAlerts() {
  const alerts = [];
  const ev = rangeEvents();
  const sys = S.system;

  if (sys) {
    if (!sys.anthropicKey) alerts.push({ sev: "warn", ico: "🔑", t: "ANTHROPIC_API_KEY not set", d: "PermitIQ research and photo analysis need the key on the server (or in Settings)." });
    if (!sys.anthropicSdk) alerts.push({ sev: "warn", ico: "📦", t: "Anthropic SDK not installed", d: "Run npm install to enable the /api/permit-search endpoint." });
    if (sys.eventLoopLagMs > 100) alerts.push({ sev: "crit", ico: "🥵", t: "Event loop lag " + sys.eventLoopLagMs.toFixed(0) + "ms", d: "Server is struggling — check heavy synchronous work." });
    if (sys.rss > 600e6) alerts.push({ sev: "warn", ico: "🧠", t: "High memory: " + fmtBytes(sys.rss), d: "RSS above 600MB." });
  }
  const stripe = stripeStatus();
  if (stripe === "Stripe not configured") alerts.push({ sev: "info", ico: "💳", t: "Stripe links not configured", d: "Pricing buttons fall back to free signup. See config.js / SETUP.md." });

  const s5 = ev.filter((e) => e.k === "req" && e.s >= 500);
  if (s5.length) alerts.push({ sev: s5.length > 5 ? "crit" : "warn", ico: "🚨", t: s5.length + " server error" + (s5.length > 1 ? "s" : "") + " (5xx)", d: latestList(s5.map((e) => e.p)) });
  const permits = ev.filter((e) => e.k === "permit");
  if (permits.length >= 5) {
    const okRate = permits.filter((p) => p.ok).length / permits.length * 100;
    if (okRate < 80) alerts.push({ sev: "warn", ico: "🛡", t: "PermitIQ success only " + fmtPct(okRate, 0), d: "Check API key validity / rate limits." });
    const pMs = permits.map((p) => p.ms).sort((a, b) => a - b);
    if (percentile(pMs, 50) > 30000) alerts.push({ sev: "info", ico: "🐢", t: "Permit research is slow (p50 " + fmtMs(percentile(pMs, 50)) + ")", d: "Normal range 10–40s; consider lowering LMP_PERMIT_EFFORT." });
  }
  const loads = ev.filter((e) => e.k === "page_load");
  const lcp = loads.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b);
  if (lcp.length >= 5) {
    const p75 = percentile(lcp, 75);
    if (p75 > 2500) alerts.push({ sev: p75 > 4000 ? "crit" : "warn", ico: "🎨", t: "p75 LCP " + fmtMs(p75), d: "Above Google's 2.5s 'good' threshold." });
  }
  const views = ev.filter((e) => e.k === "page_view").length;
  const errs = ev.filter((e) => e.k === "error").length;
  if (views >= 20 && errs / views > 0.02) alerts.push({ sev: "warn", ico: "🐞", t: "JS error rate " + ((errs / views) * 100).toFixed(1) + "%", d: errs + " errors across " + views + " views." });
  const calcStarts = ev.filter((e) => e.k === "calc_start").length;
  const calcFails = ev.filter((e) => e.k === "calc_fail").length;
  if (calcStarts >= 10 && calcFails / calcStarts > 0.15) alerts.push({ sev: "warn", ico: "📍", t: fmtPct((calcFails / calcStarts) * 100, 0) + " of calcs fail", d: "Usually geocoding (Nominatim) errors — see Product tab messages." });

  if (!alerts.length) alerts.push({ sev: "ok", ico: "✅", t: "All systems nominal", d: "No issues detected in the selected range." });
  $("#alertsPanel").innerHTML = alerts.map((a) => '<div class="alert ' + a.sev + '"><span class="a-ico">' + a.ico + "</span><div><b>" + esc(a.t) + "</b><span>" + esc(a.d) + "</span></div></div>").join("");
  $("#alertSub").textContent = alerts.filter((a) => a.sev !== "ok").length + " open · " + rangeLabel();
}
function latestList(paths) {
  const m = groupCount(paths, (p) => p);
  return topN(m, 3).map(([p, c]) => p + " ×" + c).join(", ");
}
function rangeLabel() {
  const b = $$("#rangeGroup button").find((x) => x.classList.contains("on"));
  return (b ? b.textContent.trim() : "6h") + " range";
}

/* ================= TAB: TRAFFIC ================= */

function renderTraffic() {
  const ev = rangeEvents(), prev = prevEvents();
  const now = S.lastT || Date.now();
  const views = ev.filter((e) => e.k === "page_view");
  const viewsP = prev.filter((e) => e.k === "page_view");
  const visitors = new Set(views.map((e) => e.vid));
  const visitorsP = new Set(viewsP.map((e) => e.vid));
  const sessions = groupCount(views, (e) => e.sid);
  const standalone = views.filter((e) => e.standalone).length;

  $("#trafficKpis").innerHTML =
    kpiCard({ label: "Page views", value: fmtInt(views.length), delta: delta(views.length, viewsP.length), sparkId: "tv1", goto: "traffic" }) +
    kpiCard({ label: "Visitors", value: fmtInt(visitors.size), delta: delta(visitors.size, visitorsP.size), sparkId: "tv2", goto: "traffic" }) +
    kpiCard({ label: "Sessions", value: fmtInt(sessions.size), showDelta: false }) +
    kpiCard({ label: "Views / visitor", value: views.length && visitors.size ? (views.length / visitors.size).toFixed(1) : "—", showDelta: false, sub: standalone ? standalone + " from installed PWA" : "" });

  const bMs = bucketMs(S.range, ev.length ? now - ev[0].t : S.range);
  const n = Math.min(90, Math.max(8, Math.floor((S.range || 3600000) / bMs)));
  const counts = new Array(n).fill(0);
  const vsets = [];
  for (let i = 0; i < n; i++) vsets.push(new Set());
  const start = now - (S.range || 3600000);
  for (const e of views) {
    const i = Math.min(n - 1, Math.floor((e.t - start) / bMs));
    if (i < 0) continue;
    counts[i]++;
    vsets[i].add(e.vid);
  }
  const ts = [];
  for (let i = 0; i < n; i++) ts.push(start + i * bMs);
  timeSeries($("#audChart"), [
    { label: "Views", color: "#3ad7e6", values: counts, ts },
    { label: "Visitors", color: "#a78bfa", values: vsets.map((s) => s.size), ts }
  ], { height: 220 });
  $("#audLegend").innerHTML = '<span class="row"><span class="lg-dot" style="background:#3ad7e6"></span>views</span>' +
    '<span class="row"><span class="lg-dot" style="background:#a78bfa"></span>visitors</span>';

  barList($("#topPages"), topN(groupCount(views, (e) => e.page), 6));
  barList($("#topRefs"), topN(groupCount(views, (e) => refDomain(e.ref)), 7));
  const devices = topN(groupCount(views, (e) => e.device), 4);
  const dColors = ["#3ad7e6", "#6ea8ff", "#a78bfa", "#ff8a5c"];
  $("#devicesWrap").innerHTML = donut(devices.map(([l, v], i) => ({ label: l, value: v, color: dColors[i] })), fmtInt(views.length), "views");
  barList($("#topBrowsers"), topN(groupCount(views, (e) => e.browser), 6), { colorClass: "c3" });
  barList($("#topOs"), topN(groupCount(views, (e) => e.os), 6));
  barList($("#topNet"), topN(groupCount(views, (e) => e.net || "unknown"), 5), { colorClass: "c2", unit: " views" });
  barList($("#topScreens"), topN(groupCount(views, (e) => e.sw || "?"), 6), { colorClass: "c3" });
  barList($("#topLangs"), topN(groupCount(views, (e) => e.lang || "?"), 5), { unit: " views" });

  const returning = views.filter((e) => e.returning).length;
  $("#retWrap").innerHTML = donut([
    { label: "New", value: views.length - returning, color: "#3ad7e6" },
    { label: "Returning", value: returning, color: "#ff8a5c" }
  ], fmtPct(views.length ? ((views.length - returning) / views.length) * 100 : null, 0), "new");

  const hourCounts = new Array(24).fill(0);
  views.forEach((e) => hourCounts[new Date(e.t).getHours()]++);
  const maxH = Math.max(1, ...hourCounts);
  $("#hourHeat").innerHTML = hourCounts.map((c, h) => {
    const lvl = c === 0 ? "" : c / maxH > 0.75 ? "l4" : c / maxH > 0.5 ? "l3" : c / maxH > 0.25 ? "l2" : "l1";
    return '<div class="h-cell ' + lvl + '" title="' + h + ":00 — " + c + ' views"></div>';
  }).join("") + '<div class="heat-labs" style="grid-column:1/-1">' + Array.from({ length: 24 }, (_, h) => "<span>" + (h % 3 === 0 ? h : "") + "</span>").join("") + "</div>";

  const seCounts = Array.from(sessions.values());
  const bounce = seCounts.filter((c) => c === 1).length;
  $("#sessionsBox").innerHTML =
    kv("Total sessions", fmtInt(seCounts.length)) +
    kv("Bounce rate", fmtPct(seCounts.length ? (bounce / seCounts.length) * 100 : null, 0)) +
    kv("Avg views/session", seCounts.length ? (views.length / seCounts.length).toFixed(1) : "—") +
    kv("PWA (standalone) views", fmtInt(standalone) + (views.length ? " · " + fmtPct((standalone / views.length) * 100, 0) : "")) +
    kv("Service-worker sessions", fmtInt(new Set(views.filter((e) => e.sw).map((e) => e.sid)).size)) +
    kv("Offline drops", fmtInt(ev.filter((e) => e.k === "offline").length));
}
function refDomain(ref) {
  if (!ref || ref === "direct") return "direct";
  try { return new URL(ref).hostname.replace(/^www\./, ""); } catch (e) { return ref.slice(0, 30); }
}

/* ================= TAB: FRONTEND ================= */

function renderFrontend() {
  const ev = rangeEvents();
  const loads = ev.filter((e) => e.k === "page_load");
  const views = ev.filter((e) => e.k === "page_view");
  $("#vitalsGrid").innerHTML =
    vitalMeter("LCP · largest paint", "s", loads.map((e) => e.lcp), [2500, 4000], fmtMs) +
    vitalMeter("INP · responsiveness", "ms", loads.map((e) => e.inp), [200, 500], fmtMs) +
    vitalMeter("CLS · layout shift", "", loads.map((e) => e.cls), [0.1, 0.25], (v) => v.toFixed(3)) +
    vitalMeter("TTFB · server response", "ms", loads.map((e) => e.ttfb), [800, 1800], fmtMs) +
    vitalMeter("FCP · first paint", "s", loads.map((e) => e.fcp), [1800, 3000], fmtMs);

  histogram($("#loadHist"), loads.map((e) => e.load), {
    bins: 14, zeroStart: true,
    fmt: (a, b) => (a / 1000).toFixed(1) + "-" + (b / 1000).toFixed(1) + "s"
  });
  $("#loadDistSub").textContent = loads.length + " measured loads · p50 " + fmtMs(percentile(loads.map((e) => e.load).filter((v) => v != null).sort((a, b) => a - b), 50));

  const bytes = loads.map((e) => e.bytes).filter((v) => v != null).sort((a, b) => a - b);
  const res = loads.map((e) => e.res).filter((v) => v != null).sort((a, b) => a - b);
  $("#pageWeight").innerHTML =
    kv("Median page weight", fmtBytes(percentile(bytes, 50))) +
    kv("p90 page weight", fmtBytes(percentile(bytes, 90))) +
    kv("Median requests", percentile(res, 50)) +
    kv("p90 requests", percentile(res, 90));

  const perPage = ["landing", "app", "auth"].map((p) => {
    const l = loads.filter((e) => e.page === p);
    return {
      p, n: l.length,
      lcp: percentile(l.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b), 75),
      load: percentile(l.map((e) => e.load).filter((v) => v != null).sort((a, b) => a - b), 75),
      bytes: percentile(l.map((e) => e.bytes).filter((v) => v != null).sort((a, b) => a - b), 75)
    };
  });
  table($("#perPageVitals"), [
    { label: "Page" }, { label: "Loads", num: true }, { label: "p75 LCP", num: true }, { label: "p75 load", num: true }, { label: "p75 weight", num: true }
  ], perPage.map((r) => [r.p, fmtInt(r.n), fmtMs(r.lcp), fmtMs(r.load), fmtBytes(r.bytes)]));

  const byDim = (key) => {
    const groups = {};
    loads.forEach((e) => {
      const k = e[key] || "?";
      (groups[k] = groups[k] || []).push(e);
    });
    return Object.keys(groups).map((k) => {
      const g = groups[k];
      return [k, g.length,
        percentile(g.map((e) => e.lcp).filter((v) => v != null).sort((a, b) => a - b), 75),
        percentile(g.map((e) => e.inp).filter((v) => v != null).sort((a, b) => a - b), 75)];
    }).sort((a, b) => b[1] - a[1]);
  };
  const dimCols = [{ label: "Group" }, { label: "n", num: true }, { label: "p75 LCP", num: true }, { label: "p75 INP", num: true }];
  table($("#vitalsDevice"), dimCols, byDim("device"));
  table($("#vitalsNet"), [{ label: "Network" }, { label: "n", num: true }, { label: "p75 LCP", num: true }, { label: "p75 INP", num: true }], byDim("net"));

  const errs = ev.filter((e) => e.k === "error");
  const eGroups = {};
  errs.forEach((e) => {
    const k = (e.msg || "unknown").slice(0, 90);
    if (!eGroups[k]) eGroups[k] = { count: 0, pages: new Set(), last: 0, msg: e.msg || "unknown" };
    const g = eGroups[k];
    g.count++; g.pages.add(e.page); g.last = Math.max(g.last, e.t);
  });
  const errRows = Object.values(eGroups).sort((a, b) => b.count - a.count).slice(0, 12)
    .map((g) => ['<span title="' + escAttr(g.msg) + '">' + esc(g.msg.slice(0, 58)) + (g.msg.length > 58 ? "…" : "") + "</span>",
      fmtInt(g.count), Array.from(g.pages).join(", "), timeAgo(g.last)]);
  table($("#jsErrors"), [{ label: "Message" }, { label: "Count", num: true }, { label: "Pages" }, { label: "Last seen" }], errRows);
  $("#errSub").textContent = errs.length + " errors · " + (views.length ? (errs.length / views.length * 100).toFixed(2) : "0") + "% of views";

  const installs = ev.filter((e) => e.k === "pwa_installed").length;
  const prompts = ev.filter((e) => e.k === "install_prompt").length;
  const offlineEv = ev.filter((e) => e.k === "offline").length;
  const standaloneViews = views.filter((e) => e.standalone).length;
  const swViews = views.filter((e) => e.sw).length;
  $("#pwaBox").innerHTML =
    kv("PWA installs", fmtInt(installs)) +
    kv("Install prompts shown", fmtInt(prompts)) +
    kv("Standalone sessions", fmtInt(new Set(views.filter((e) => e.standalone).map((e) => e.sid)).size)) +
    kv("Offline drops", fmtInt(offlineEv)) +
    kv("SW-covered views", fmtInt(swViews) + (views.length ? " · " + fmtPct((swViews / views.length) * 100, 0) : ""));
  barList($("#pwaBars"), [["Views in installed PWA", standaloneViews], ["Install prompt → installed", installs]].filter((r) => r[1] > 0));
}

/* ================= TAB: PRODUCT ================= */

function renderProduct() {
  const ev = rangeEvents(), prev = prevEvents();
  const views = ev.filter((e) => e.k === "page_view");
  const starts = ev.filter((e) => e.k === "calc_start");
  const oks = ev.filter((e) => e.k === "calc_success");
  const reports = ev.filter((e) => e.k === "report_generated");
  const shares = ev.filter((e) => e.k === "share_result");
  const permits = ev.filter((e) => e.k === "permit");
  const signups = ev.filter((e) => e.k === "signup");

  const okRate = starts.length ? (oks.length / starts.length) * 100 : null;
  const durs = oks.map((e) => e.ms).filter((v) => v != null).sort((a, b) => a - b);
  const fails = ev.filter((e) => e.k === "calc_fail");

  $("#productKpis").innerHTML =
    kpiCard({ label: "Calc starts", value: fmtInt(starts.length), delta: delta(starts.length, prev.filter((e) => e.k === "calc_start").length), sparkId: "p1" }) +
    kpiCard({ label: "Successful calcs", value: fmtInt(oks.length), sub: okRate != null ? fmtPct(okRate, 0) + " success" : "", delta: delta(oks.length, prev.filter((e) => e.k === "calc_success").length), sparkId: "p2" }) +
    kpiCard({ label: "Median calc time", value: fmtMs(percentile(durs, 50)), showDelta: false, sub: "p95 " + fmtMs(percentile(durs, 95)) }) +
    kpiCard({ label: "Reports / shares", value: fmtInt(reports.length), sub: shares.length + " shares", delta: delta(reports.length, prev.filter((e) => e.k === "report_generated").length) }) +
    kpiCard({ label: "Signups", value: fmtInt(signups.length), delta: delta(signups.length, prev.filter((e) => e.k === "signup").length), sub: signups.length ? "top: " + topN(groupCount(signups, (e) => e.plan), 1)[0][0] : "" }) +
    kpiCard({ label: "Report rate", value: oks.length ? fmtPct((reports.length / oks.length) * 100, 0) : "—", showDelta: false, sub: "reports per successful calc" }) +
    kpiCard({ label: "PhotoScan analyses", value: fmtInt(ev.filter((e) => e.k === "photo_ai_result").length), showDelta: false }) +
    kpiCard({ label: "PermitIQ searches", value: fmtInt(permits.length), showDelta: false, sub: permits.length ? fmtPct(permits.filter((p) => p.ok).length / permits.length * 100, 0) + " ok" : "" });

  $("#jobFunnel").innerHTML = funnelViz([
    { label: "Landing page views", count: views.filter((e) => e.page === "landing").length },
    { label: "App opened", count: views.filter((e) => e.page === "app").length },
    { label: "Calcs started", count: starts.length },
    { label: "Calcs succeeded", count: oks.length },
    { label: "Reports generated", count: reports.length },
    { label: "Shared / permit email", count: shares.length + ev.filter((e) => e.k === "permit_email").length }
  ]);

  histogram($("#calcDurHist"), oks.map((e) => e.ms), {
    bins: 12, zeroStart: true, fmt: (a) => Math.round(a / 1000) + "s"
  });
  $("#calcPerfSub").textContent = durs.length + " calcs · p50 " + fmtMs(percentile(durs, 50)) + " · p95 " + fmtMs(percentile(durs, 95));

  const liveClimate = oks.filter((e) => e.climate === "live").length;
  $("#climateSplit").innerHTML = donut([
    { label: "TrueClimate (live 8,760h)", value: liveClimate, color: "#3ad7e6" },
    { label: "Nearest station", value: oks.length - liveClimate, color: "#6f7c9c" }
  ], fmtPct(oks.length ? (liveClimate / oks.length) * 100 : null, 0), "live");

  const fetched = oks.filter((e) => e.prop === "fetched").length;
  $("#propSplit").innerHTML = donut([
    { label: "RentCast fetched", value: fetched, color: "#34d399" },
    { label: "Estimated", value: oks.length - fetched, color: "#fbbf24" }
  ], fmtPct(oks.length ? (fetched / oks.length) * 100 : null, 0), "fetched");

  histogram($("#tonsHist"), oks.map((e) => e.tons).filter((v) => v != null), { bins: 8, zeroStart: true, fmt: (a) => (Math.round(a * 2) / 2) + "t" });

  barList($("#topCities"), topN(groupCount(oks, (e) => (e.city || "?") + (e.state ? ", " + e.state : "")), 8));
  barList($("#topStates"), topN(groupCount(oks, (e) => e.state || "?"), 8), { colorClass: "c2" });

  const pStarts = ev.filter((e) => e.k === "photo_ai_start").length;
  const pResults = ev.filter((e) => e.k === "photo_ai_result");
  const pFails = ev.filter((e) => e.k === "photo_ai_fail").length;
  const avgFindings = pResults.length ? sum(pResults.map((e) => e.findings || 0)) / pResults.length : null;
  const avgApplied = pResults.length ? sum(pResults.map((e) => e.applied || 0)) / pResults.length : null;
  $("#photoBox").innerHTML =
    kv("Analyses run", fmtInt(pStarts)) +
    kv("Succeeded", fmtInt(pResults.length) + (pStarts ? " · " + fmtPct((pResults.length / pStarts) * 100, 0) : "")) +
    kv("Failed", fmtInt(pFails)) +
    kv("Avg findings", avgFindings != null ? avgFindings.toFixed(1) : "—") +
    kv("Avg applied to load", avgApplied != null ? avgApplied.toFixed(1) : "—") +
    kv("Adoption", oks.length ? fmtPct((pStarts / oks.length) * 100, 0) + " of calcs" : "—");
  barList($("#photoBars"), topN(groupCount(pResults, (e) => (e.applied || 0) + " applied"), 5), { colorClass: "c3" });

  barList($("#signupBars"), topN(groupCount(signups, (e) => e.plan || "?"), 5));
  const logins = ev.filter((e) => e.k === "login").length;
  barList($("#ctaBars"), topN(groupCount(ev.filter((e) => e.k === "cta_click"), (e) => e.to || "?"), 7));
  const adj = {};
  ev.filter((e) => e.k === "manual_adjust").forEach((e) => {
    String(e.fields || "").split(",").filter(Boolean).forEach((f) => { adj[f] = (adj[f] || 0) + 1; });
  });
  barList($("#adjustBars"), topN(new Map(Object.entries(adj)), 7), { colorClass: "c2" });
  const failRows = topN(groupCount(fails, (e) => e.msg || "unknown"), 4);
  if (failRows.length) {
    $("#adjustBars").insertAdjacentHTML("afterend", '<div class="card-head mt16"><h3>Calc failures</h3></div><div id="failBars"></div>');
    barList($("#failBars"), failRows, { colorClass: "c2" });
  }
  const signupCard = $("#signupBars").parentElement;
  signupCard.insertAdjacentHTML("beforeend", '<div class="muted" style="margin-top:8px">' + fmtInt(logins) + " logins · accounts are stored on-device (SETUP.md has the Supabase path)</div>");
}

/* ================= TAB: BACKEND ================= */

function renderBackend() {
  const ev = rangeEvents(), prev = prevEvents();
  const now = S.lastT || Date.now();
  const reqs = ev.filter((e) => e.k === "req");
  const reqsP = prev.filter((e) => e.k === "req");
  const permits = ev.filter((e) => e.k === "permit");
  const lat = reqs.map((e) => e.ms).filter((v) => v != null).sort((a, b) => a - b);
  const bytesServed = sum(reqs.map((e) => e.b || 0));
  const errs5 = reqs.filter((e) => e.s >= 500).length;
  const errs4 = reqs.filter((e) => e.s >= 400 && e.s < 500).length;

  $("#backendKpis").innerHTML =
    kpiCard({ label: "Requests", value: fmtInt(reqs.length), delta: delta(reqs.length, reqsP.length), sub: fmtBytes(bytesServed) + " served", sparkId: "b1" }) +
    kpiCard({ label: "p50 latency", value: fmtMs(percentile(lat, 50)), showDelta: false, sub: "p95 " + fmtMs(percentile(lat, 95)) + " · p99 " + fmtMs(percentile(lat, 99)) }) +
    kpiCard({ label: "Error rate", value: reqs.length ? fmtPct(((errs4 + errs5) / reqs.length) * 100, 2) : "—", showDelta: false, sub: errs4 + "×4xx · " + errs5 + "×5xx" }) +
    kpiCard({ label: "PermitIQ calls", value: fmtInt(permits.length), showDelta: false, sub: permits.length ? fmtPct(permits.filter((p) => p.ok).length / permits.length * 100, 0) + " ok" : "" });

  const bMs = bucketMs(S.range, ev.length ? now - ev[0].t : S.range);
  const n = Math.min(90, Math.max(8, Math.floor((S.range || 3600000) / bMs)));
  const perMin = Math.max(1, 60000 / bMs);
  const start = now - (S.range || 3600000);
  const counts = new Array(n).fill(0);
  const ts = [];
  for (let i = 0; i < n; i++) ts.push(start + i * bMs);
  for (const e of reqs) {
    const i = Math.min(n - 1, Math.floor((e.t - start) / bMs));
    if (i >= 0) counts[i]++;
  }
  timeSeries($("#tpChart"), [{ label: "req/min", color: "#6ea8ff", values: counts.map((c) => Math.round(c * perMin)), ts }], { height: 200 });

  const s2 = reqs.filter((e) => e.s < 300).length, s3 = reqs.filter((e) => e.s >= 300 && e.s < 400).length;
  $("#statusWrap").innerHTML = donut([
    { label: "2xx success", value: s2, color: "#34d399" },
    { label: "3xx redirect", value: s3, color: "#6ea8ff" },
    { label: "4xx client", value: errs4, color: "#fbbf24" },
    { label: "5xx server", value: errs5, color: "#f87171" }
  ], fmtPct(reqs.length ? (s2 / reqs.length) * 100 : null, 0), "2xx");

  const byStatus = topN(groupCount(reqs, (e) => e.s), 8);
  table($("#statusList"), [{ label: "Status" }, { label: "Count", num: true }, { label: "Share", num: true }],
    byStatus.map(([s, c]) => ['<span class="badge ' + (s < 300 ? "ok" : s < 500 ? "warn" : "bad") + '">' + s + "</span>", fmtInt(c), fmtPct((c / (reqs.length || 1)) * 100)]));

  const routes = {};
  reqs.forEach((e) => { (routes[e.p] = routes[e.p] || []).push(e.ms); });
  const routeRows = Object.keys(routes).map((p) => {
    const arr = routes[p].slice().sort((a, b) => a - b);
    return [esc(p), arr.length, percentile(arr, 50), percentile(arr, 95), arr[arr.length - 1]];
  }).sort((a, b) => b[1] - a[1]).slice(0, 12);
  table($("#routeLatency"), [{ label: "Route" }, { label: "n", num: true }, { label: "p50", num: true }, { label: "p95", num: true }, { label: "max", num: true }],
    routeRows.map((r) => [r[0], fmtInt(r[1]), fmtMs(r[2]), fmtMs(r[3]), fmtMs(r[4])]));

  const ok = permits.filter((p) => p.ok);
  const pLat = permits.map((p) => p.ms).filter((v) => v != null).sort((a, b) => a - b);
  const avgSources = ok.length ? sum(ok.map((p) => p.sources || 0)) / ok.length : null;
  $("#permitSub").textContent = permits.length ? "last call " + timeAgo(permits[permits.length - 1].t) : "no calls yet";
  $("#permitKpis").innerHTML =
    kv("Calls", fmtInt(permits.length)) +
    kv("Success rate", fmtPct(permits.length ? (ok.length / permits.length) * 100 : null, 0)) +
    kv("p50 duration", fmtMs(percentile(pLat, 50))) +
    kv("p95 duration", fmtMs(percentile(pLat, 95))) +
    kv("Avg sources cited", avgSources != null ? avgSources.toFixed(1) : "—") +
    kv("Model / effort", S.system ? S.system.permitModel + " · " + S.system.permitEffort : "—");
  histogram($("#permitHist"), permits.map((p) => p.ms), {
    bins: 10, zeroStart: true, fmt: (a) => Math.round(a / 1000) + "s"
  });
  const permitRecent = permits.slice(-8).reverse().map((p) => [
    hhmm(p.t), esc((p.city || "?") + (p.state ? ", " + p.state : "")),
    p.ok ? '<span class="badge ok">ok</span>' : '<span class="badge bad">' + esc(p.error || "fail") + "</span>",
    fmtMs(p.ms), p.ok ? (p.sources || 0) + " src" : "—"
  ]);
  table($("#permitRecent"), [{ label: "Time" }, { label: "City" }, { label: "Result" }, { label: "Duration", num: true }, { label: "Sources", num: true }], permitRecent);

  const sys = S.system;
  const hist = (sys && sys.sysHistory) || [];
  if (hist.length > 1) {
    timeSeries($("#resChart"), [
      { label: "RSS (MB)", color: "#6ea8ff", values: hist.map((h) => Math.round(h.rss / 1e6)), ts: hist.map((h) => h.t) },
      { label: "Heap (MB)", color: "#3ad7e6", values: hist.map((h) => Math.round(h.heap / 1e6)), ts: hist.map((h) => h.t) }
    ], { height: 150 });
  } else $("#resChart").innerHTML = '<div class="muted" style="padding:20px 0;text-align:center">Collecting samples…</div>';
  $("#resKpis").innerHTML =
    kv("Event-loop lag", sys ? (sys.eventLoopLagMs < 1 ? "<1" : sys.eventLoopLagMs.toFixed(1)) + " ms" : "—") +
    kv("RSS", sys ? fmtBytes(sys.rss) : "—") +
    kv("Heap", sys ? fmtBytes(sys.heapUsed) + " / " + fmtBytes(sys.heapTotal) : "—") +
    kv("Load avg", sys ? sys.loadAvg.map((l) => l.toFixed(2)).join(" ") : "—") +
    kv("OS uptime", sys ? fmtDur(sys.osUptimeSec) : "—") +
    kv("Host", sys ? esc(sys.hostname) : "—") +
    kv("Node", sys ? sys.node : "—") +
    kv("Port", sys ? sys.port : "—");

  const slowest = reqs.slice().sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 10)
    .map((e) => [hhmmss(e.t), esc(e.m), esc(e.p), e.s, fmtMs(e.ms)]);
  $("#slowSub").textContent = reqs.length ? "worst " + Math.min(10, reqs.length) + " of " + fmtInt(reqs.length) : "";
  table($("#slowTable"), [{ label: "Time" }, { label: "Method" }, { label: "Path" }, { label: "Status", num: true }, { label: "Took", num: true }], slowest);
  const nf = topN(groupCount(reqs.filter((e) => e.s === 404), (e) => e.p), 8);
  table($("#nfTable"), [{ label: "Missing path" }, { label: "Hits", num: true }], nf.map(([p, c]) => [esc(p), fmtInt(c)]));
}

/* ================= TAB: LIVE ================= */

const EVENT_META = {
  calc_start: ["calc", "▶"], calc_success: ["calc", "✓"], calc_fail: ["calc", "✕"],
  permit: ["permit", "🛡"], photo_ai_start: ["photo", "📷"], photo_ai_result: ["photo", "✨"], photo_ai_fail: ["photo", "✕"],
  signup: ["auth", "＋"], login: ["auth", "→"], report_generated: ["rep", "📄"], share_result: ["rep", "↗"],
  error: ["err", "⚠"], page_view: ["sys", "👁"], offline: ["sys", "☄"], pwa_installed: ["sys", "⤓"],
  manual_adjust: ["sys", "✎"], settings_saved: ["sys", "⚙"], permit_email: ["permit", "✉"], boot: ["sys", "⏻"]
};

function renderLive() {
  renderReqStream();
  renderEventStream();
}
function renderReqStream() {
  const term = S.liveFilter.toLowerCase();
  const rows = [];
  const reqs = S.events.filter((e) => e.k === "req");
  for (let i = reqs.length - 1; i >= 0 && rows.length < 300; i--) {
    const e = reqs[i];
    if (S.liveStatus && String(e.s)[0] !== S.liveStatus) continue;
    if (term && !(String(e.p).toLowerCase().includes(term) || String(e.s).includes(term) || String(e.m).toLowerCase().includes(term))) continue;
    rows.push('<div class="stream-row"><span class="s-time">' + hhmmss(e.t) + '</span><span class="s-method">' + esc(e.m) + "</span>" +
      '<span class="s-path" title="' + escAttr(e.p) + '">' + esc(e.p) + "</span>" +
      '<span class="s-num s-' + String(e.s)[0] + '">' + e.s + '</span><span class="s-num" style="color:var(--muted-2)">' + fmtMs(e.ms) + "</span></div>");
  }
  $("#reqStream").innerHTML = rows.join("") || '<div class="muted" style="padding:16px">No requests match.</div>';
  $("#reqCount").textContent = fmtInt(reqs.length) + " total logged";
}
function renderEventStream() {
  const rows = [];
  for (let i = S.events.length - 1, c = 0; i >= 0 && c < 200; i--) {
    const e = S.events[i];
    if (e.k === "req") continue;
    const meta = EVENT_META[e.k];
    if (!meta) continue;
    rows.push('<div class="ev-row"><span class="s-time">' + hhmmss(e.t) + '</span><span class="ev-kind ev-' + meta[0] + '">' + meta[1] + " " + esc(e.k) + "</span>" +
      '<span class="ev-detail">' + esc(eventDetail(e)) + "</span></div>");
    c++;
  }
  $("#eventStream").innerHTML = rows.join("") || '<div class="muted" style="padding:16px">No product events yet.</div>';
}
function eventDetail(e) {
  switch (e.k) {
    case "calc_success": return (e.city || "?") + (e.state ? ", " + e.state : "") + " · " + e.tons + "t · " + fmtMs(e.ms) + " · " + (e.climate === "live" ? "TrueClimate" : "station") + " · " + (e.prop === "fetched" ? "fetched ft²" : "est ft²");
    case "calc_fail": return e.msg || "failed";
    case "calc_start": return "via " + (e.via || "?");
    case "permit": return (e.city || "?") + (e.state ? ", " + e.state : "") + " · " + (e.ok ? fmtMs(e.ms) + " · " + (e.sources || 0) + " sources" : "failed: " + (e.error || "?"));
    case "permit_email": return "permit email to " + (e.city || "city");
    case "error": return e.msg || "error";
    case "page_view": return e.page + " · " + (e.device || "?") + " · " + (e.ref && e.ref !== "direct" ? refDomain(e.ref) : "direct") + (e.standalone ? " · PWA" : "");
    case "photo_ai_result": return (e.findings || 0) + " findings · " + (e.applied || 0) + " applied";
    case "photo_ai_start": return (e.photos || "?") + " photos";
    case "photo_ai_fail": return e.msg || "failed";
    case "report_generated": return e.permit ? "permit package" : "standard report";
    case "signup": return "plan: " + (e.plan || "trial");
    case "login": return "plan: " + (e.plan || "trial");
    case "manual_adjust": return e.fields || "";
    case "settings_saved": return "company:" + (e.company ? "✓" : "—") + " logo:" + (e.logo ? "✓" : "—") + " propKey:" + (e.propertyKey ? "✓" : "—") + " aiKey:" + (e.aiKey ? "✓" : "—");
    case "share_result": return "how: " + (e.how || "?");
    default: return "";
  }
}

/* ================= tabs & wiring ================= */

function showTab(tab, silent) {
  if (!tab) return;
  S.tab = tab;
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  const panel = $("#tab-" + tab);
  if (panel) panel.classList.remove("hidden");
  $$("#rail button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (!silent) renderActiveTab();
}
function renderActiveTab() {
  if (S.events.length === 0) { updateEmptyState(); return; }
  if (document.visibilityState !== "visible") return;
  const fn = { overview: renderOverview, traffic: renderTraffic, frontend: renderFrontend, product: renderProduct, backend: renderBackend, live: renderLive }[S.tab];
  if (fn) fn();
}

$$("#rail button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$$("#rangeGroup button").forEach((b) => b.addEventListener("click", () => {
  $$("#rangeGroup button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  S.range = Number(b.dataset.range);
  renderActiveTab();
}));
$("#autoBtn").addEventListener("click", () => {
  S.auto = !S.auto;
  updateTopbar();
});
$("#resetBtn").addEventListener("click", async () => {
  if (!confirm("Erase ALL collected metrics (memory + data/metrics.jsonl)?")) return;
  try {
    await fetch("/api/metrics/reset", { method: "POST" });
    S.events = []; S.lastT = 0;
    await refresh(false);
  } catch (e) { alert("Reset failed: " + e.message); }
});
$("#seedBtn").addEventListener("click", seedDemo);
$("#seedBtn2").addEventListener("click", seedDemo);
async function seedDemo() {
  if (S.events.some((e) => !e.demo) && !confirm("Loading demo data REPLACES current metrics with 48h of sample data. Continue?")) return;
  try {
    const r = await fetch("/api/metrics/demo", { method: "POST" });
    const j = await r.json();
    S.events = []; S.lastT = 0;
    await refresh(false);
    if (j.seeded) toast("Loaded " + fmtInt(j.seeded) + " demo events — explore each tab");
  } catch (e) { alert("Could not seed demo data (is the Node server running?): " + e.message); }
}
$("#exportBtn").addEventListener("click", () => { window.location.href = "/api/metrics/export"; });
$("#pauseBtn").addEventListener("click", () => {
  S.paused = !S.paused;
  $("#pauseIcon").textContent = S.paused ? "▶" : "⏸";
  $("#pauseText").textContent = S.paused ? "Resume stream" : "Pause stream";
});
$("#liveFilter").addEventListener("input", (e) => { S.liveFilter = e.target.value; renderReqStream(); });
$$("#statusChips button").forEach((b) => b.addEventListener("click", () => {
  $$("#statusChips button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  S.liveStatus = b.dataset.s;
  renderReqStream();
}));
document.addEventListener("click", (e) => {
  const k = e.target.closest(".kpi[data-goto]");
  if (k && k.dataset.goto) showTab(k.dataset.goto);
});
window.addEventListener("resize", debounce(() => renderActiveTab(), 250));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function toast(msg) {
  let t = $("#dashToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "dashToast";
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(9,14,30,.95);border:1px solid var(--border);padding:10px 18px;border-radius:12px;z-index:200;font-size:13px";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  setTimeout(() => { t.style.transition = "opacity .5s"; t.style.opacity = "0"; }, 2600);
}

/* Stripe config awareness (config.js is included by dashboard.html) */
function stripeStatus() {
  const c = window.LMP_CONFIG || {};
  const links = c.stripeLinks || {};
  const set = ["solo", "pro", "fleet"].filter((k) => links[k]);
  return set.length ? set.length + "/3 Stripe links set" : "Stripe not configured";
}

/* ================= main loop ================= */

(async function main() {
  await refresh(false);
  setInterval(() => {
    if (S.auto && document.visibilityState === "visible") refresh(true);
  }, 5000);
  setInterval(() => { $("#chipClock").textContent = hhmmss(Date.now()); }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.auto) refresh(true);
  });
})();
