/* Headless smoke test for dashboard.js: parses dashboard.html into a tiny DOM
 * shim, stubs fetch/window/document, evaluates dashboard.js against the live
 * metrics API, and runs every tab renderer. Catches ReferenceErrors, bad
 * property access, and template bugs without a browser. */
"use strict";
const fs = require("fs");
const vm = require("vm");

const BASE = "http://localhost:8099";

/* ---------- tiny DOM ---------- */
class El {
  constructor(tag, attrs) {
    this.tagName = (tag || "div").toUpperCase();
    this.attrs = attrs || {};
    this.children = [];
    this.parent = null;
    this._html = "";
    this.style = { cssText: "", setProperty() {} };
    this.listeners = {};
    this.classList = {
      add: (...c) => { c.forEach(x => this._cls().add(x)); },
      remove: (...c) => { c.forEach(x => this._cls().delete(x)); },
      toggle: (c, force) => {
        const s = this._cls();
        const on = force === undefined ? !s.has(c) : !!force;
        on ? s.add(c) : s.delete(c);
        return on;
      },
      contains: (c) => this._cls().has(c)
    };
  }
  _cls() {
    if (!this._clsSet) {
      this._clsSet = new Set(String(this.attrs.class || "").split(/\s+/).filter(Boolean));
    }
    return this._clsSet;
  }
  get id() { return this.attrs.id || ""; }
  get parentElement() { return this.parent; }
  get dataset() {
    const d = {};
    for (const k of Object.keys(this.attrs)) {
      if (k.startsWith("data-")) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    }
    return d;
  }
  get className() { return Array.from(this._cls()).join(" "); }
  set className(v) { this._clsSet = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(h) { this._html = String(h); this.children = parse(h, this); }
  get textContent() { return this._html.replace(/<[^>]*>/g, ""); }
  set textContent(t) { this._html = String(t); this.children = []; }
  appendChild(el) { el.parent = this; this.children.push(el); this._html += el._html; return el; }
  insertAdjacentHTML(pos, html) {
    const nodes = parse(html, this.parent);
    if (!this.parent) { this._html += html; return; }
    const idx = this.parent.children.indexOf(this);
    if (pos === "beforeend") { this._html += html; this.children.push(...nodes); nodes.forEach(n => n.parent = this); }
    else if (pos === "afterbegin") { this.children.unshift(...nodes); this._html = html + this._html; }
    else if (pos === "afterend") this.parent.children.splice(idx + 1, 0, ...nodes);
    else if (pos === "beforebegin") this.parent.children.splice(idx, 0, ...nodes);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 200 }; }
  get clientWidth() { return 600; }
  matches(sel) { return !!query([this], sel, true).length; }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; }
  querySelector(sel) { return query(this.children, sel)[0] || null; }
  querySelectorAll(sel) { return query(this.children, sel); }
}

function parse(html, parent) {
  const roots = [];
  const stack = [{ children: roots }];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  const voids = new Set(["br", "hr", "img", "input", "meta", "link", "circle", "path", "line", "rect", "polyline", "text", "span"]);
  while ((m = re.exec(html))) {
    const isClose = m[0][1] === "/";
    const tag = m[1].toLowerCase();
    const attrStr = m[2] || "";
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.splice(i); break; }
      }
      continue;
    }
    const attrs = {};
    const are = /([a-zA-Z-]+)(?:="([^"]*)"|='([^']*)'|(?=[\s>]))/g;
    let a;
    while ((a = are.exec(attrStr))) attrs[a[1]] = a[2] != null ? a[2] : a[3] != null ? a[3] : "";
    const el = new El(tag, attrs);
    el.parent = stack[stack.length - 1] === stack[0] ? parent : stack[stack.length - 1];
    stack[stack.length - 1].children.push(el);
    if (!voids.has(tag) && !/\/>\s*$/.test(m[0])) stack.push(el);
  }
  return roots;
}

function matchesEl(el, sel) {
  sel = sel.trim();
  // compound simple selectors, e.g. "#rail button", ".kpi[data-goto]"
  const parts = sel.split(/\s+/);
  return matchSimple(el, parts[parts.length - 1]);
}
function matchSimple(el, s) {
  const idm = s.match(/^#([\w-]+)$/);
  if (idm) return el.attrs.id === idm[1];
  const clsm = s.match(/^\.([\w-]+)$/);
  if (clsm) return el._cls().has(clsm[1]);
  const attrm = s.match(/^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/);
  if (attrm) return el.attrs[attrm[1]] != null && (attrm[2] === undefined || el.attrs[attrm[1]] === attrm[2]);
  const tagm = s.match(/^([a-zA-Z]+)$/);
  if (tagm) return el.tagName === tagm[1].toUpperCase();
  // compound: tag.class
  const comp = s.match(/^([a-zA-Z][a-zA-Z0-9]*)\.([\w-]+)$/);
  if (comp) return el.tagName === comp[1].toUpperCase() && el._cls().has(comp[2]);
  // #id.class
  const comp2 = s.match(/^#([\w-]+)\.([\w-]+)$/);
  if (comp2) return el.attrs.id === comp2[1] && el._cls().has(comp2[2]);
  return false;
}
function walk(nodes, fn) {
  for (const n of nodes) { fn(n); if (n.children) walk(n.children, fn); }
}
function query(roots, sel) {
  const out = [];
  walk(roots, (el) => { if (matchSimple(el, sel)) out.push(el); });
  return out;
}

/* ---------- document from real HTML ---------- */
const html = fs.readFileSync("dashboard.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const doc = new El("html", {});
const body = new El("body", {});
doc.children = [body];
body.children = parse(html.replace(/^[\s\S]*?<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, ""), body);

function q(sel) {
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    let found = null;
    walk([doc], (el) => { if (!found && el.attrs.id === id) found = el; });
    return found;
  }
  return query(doc.children, sel)[0] || null;
}
function qa(sel) { return query([doc], sel); }

/* ---------- sandbox ---------- */
const sandbox = {
  console,
  fetch: (url, opts) => fetch(new URL(url, BASE).href, opts),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  Date, Math, JSON, Map, Set, Promise, Array, Object, String, Number, Boolean, RegExp, Error, isFinite, parseInt, parseFloat,
  document: {
    querySelector: q,
    querySelectorAll: qa,
    createElement: (t) => new El(t, {}),
    addEventListener() {},
    body,
    visibilityState: "visible"
  },
  window: null,
  confirm: () => true,
  alert: () => {},
  location: { href: "" },
  Blob: class {}, URL, performance: { now: () => Date.now() }
};
sandbox.window = { addEventListener() {}, location: sandbox.location, LMP_CONFIG: { stripeLinks: { solo: "", pro: "", fleet: "" } } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const code = fs.readFileSync("dashboard.js", "utf8");
vm.runInContext(code, sandbox, { filename: "dashboard.js" });

(async () => {
  // let the async main() initial refresh finish
  await new Promise((r) => setTimeout(r, 800));
  const S = vm.runInContext("S", sandbox);
  const fns = vm.runInContext("({renderOverview,renderTraffic,renderFrontend,renderProduct,renderBackend,renderLive,renderAlerts,updateTopbar})", sandbox);
  console.log("events loaded:", S.events.length, "| serverUp:", S.serverUp, "| system rss:", S.system && S.system.rss);
  if (!S.events.length) throw new Error("no events loaded — is the server + demo data present?");

  const tabs = ["renderOverview", "renderTraffic", "renderFrontend", "renderProduct", "renderBackend", "renderLive"];
  for (const t of tabs) {
    fns[t]();
    console.log("✔", t, "rendered without error");
  }
  // sanity: KPI cards + charts were produced
  const kpiRow = q("#kpiRow");
  if (!kpiRow || kpiRow._html.length < 200) throw new Error("KPI row empty");
  const traffic = q("#trafficChart");
  if (!traffic || !traffic._html.includes("<svg")) throw new Error("traffic chart missing svg");
  const vitals = q("#vitalsGrid");
  if (!vitals || !vitals._html.includes("vital")) throw new Error("vitals empty");
  const reqStream = q("#reqStream");
  if (!reqStream || reqStream._html.length < 100) throw new Error("request stream empty");
  console.log("✔ KPI row:", kpiRow._html.length, "chars · traffic svg ✔ · vitals ✔ · live stream:", reqStream._html.length, "chars");
  // range switch test
  await vm.runInContext('S.range = 604800000; renderActiveTab();', sandbox);
  console.log("✔ range switch (7d) re-render OK");
  console.log("\nALL RENDER TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
