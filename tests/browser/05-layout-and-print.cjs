/*
 * Layout + print audit: no horizontal overflow on any page at phone or
 * desktop width, every id the JS reaches for exists, no 404s, and the
 * printed report (including the EnvelopeIQ and SalesIQ blocks) renders in
 * print emulation.
 */
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { return require("/opt/node22/lib/node_modules/playwright"); }
}
const { chromium } = loadPlaywright();
const BASE = process.env.LMP_BASE || "http://localhost:8099";
let fails = 0;
function ok(l, c, d) { console.log(`   ${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`); if (!c) fails++; }
async function relay(route) {
  try { const req = route.request();
    const real = await fetch(req.url(), { method: req.method(), headers: req.headers() });
    await route.fulfill({ status: real.status, contentType: real.headers.get("content-type") || "application/json", body: await real.text() });
  } catch (e) { await route.fulfill({ status: 599, body: "{}" }); }
}
const SIZES = [{ w: 390, h: 844, name: "phone" }, { w: 1280, h: 800, name: "desktop" }];

(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });

  // ---- static pages, both widths ----
  for (const page_ of ["index.html", "auth.html", "app.html"]) {
    for (const s of SIZES) {
      const ctx = await b.newContext({ viewport: { width: s.w, height: s.h } });
      const p = await ctx.newPage();
      const bad = [];
      p.on("console", m => { if (m.type() === "error") bad.push("console: " + m.text()); });
      p.on("pageerror", e => bad.push("pageerror: " + e.message));
      p.on("response", r => { if (r.status() >= 400 && r.url().startsWith(BASE)) bad.push("HTTP " + r.status() + " " + r.url()); });
      await p.goto(`${BASE}/${page_}`, { waitUntil: "networkidle" });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(`${page_} @${s.name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
      ok(`${page_} @${s.name}: no errors or 404s`, bad.length === 0, bad.slice(0, 3).join(" | "));
      await ctx.close();
    }
  }

  // ---- landing CTAs resolve ----
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    const hrefs = await p.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    const internal = [...new Set(hrefs.filter(h => h && !/^(https?:|mailto:|tel:|#)/.test(h)))];
    for (const h of internal) {
      const r = await fetch(`${BASE}/${h.split("#")[0]}`);
      ok(`landing link resolves: ${h}`, r.ok, "HTTP " + r.status);
    }
    const anchors = [...new Set(hrefs.filter(h => h && h.startsWith("#")).map(h => h.slice(1)))].filter(Boolean);
    for (const a of anchors) {
      ok(`landing anchor exists: #${a}`, await p.evaluate(id => !!document.getElementById(id), a));
    }
    await ctx.close();
  }

  // ---- full results page: overflow at phone width, then print emulation ----
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await ctx.addInitScript(() => localStorage.setItem("lmp_user", JSON.stringify({ email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() })));
    const p = await ctx.newPage();
    const bad = [];
    p.on("pageerror", e => bad.push("pageerror: " + e.message));
    await p.route("**nominatim.openstreetmap.org/**", relay);
    await p.route("**archive-api.open-meteo.com/**", relay);
    await p.route("**epqs.nationalmap.gov/**", relay);
    await p.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await p.fill("#address", "2100 Westheimer Rd, Houston, TX");
    await p.waitForTimeout(1800);
    const sug = await p.$("#suggest > *"); if (sug) await sug.click();
    await p.waitForTimeout(400);
    if (!(await p.$(".loading, #reportBtn"))) await p.click("#calcBtn");
    await p.waitForSelector("#reportBtn", { timeout: 40000 });
    await p.waitForTimeout(2500);

    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("results page @phone: no horizontal overflow", overflow <= 1, `${overflow}px`);
    const wide = await p.evaluate(() => Array.from(document.querySelectorAll("#results *"))
      .filter(el => el.getBoundingClientRect().width > window.innerWidth + 1)
      .map(el => el.className || el.tagName).slice(0, 5));
    ok("no element in the results wider than the viewport", wide.length === 0, wide.join(", "));

    // build a proposal so the printed report carries every block
    await p.selectOption("#sqExTons", "4"); await p.fill("#sqExYear", "2008");
    await p.fill("#sqPrice0", "9500"); await p.fill("#sqPrice1", "12500"); await p.fill("#sqPrice2", "16500");
    await p.click("#salesBuildBtn"); await p.waitForTimeout(700);
    await p.click("#reportBtn"); await p.waitForTimeout(900);
    await p.emulateMedia({ media: "print" });
    await p.waitForTimeout(300);
    const rep = await p.evaluate(() => {
      const root = document.querySelector("#reportRoot");
      const t = root?.textContent || "";
      const prop = root?.querySelector(".rp-prop-table");
      const cols = prop ? prop.querySelectorAll("tr")[0].children.length : 0;
      const rpW = root?.querySelector(".rp")?.getBoundingClientRect().width || 0;
      return { hasProposal: t.includes("Replacement proposal"), hasEnvelope: t.includes("Envelope assumptions"),
               cols, rpW, propW: prop ? prop.getBoundingClientRect().width : 0 };
    });
    ok("print: proposal block present", rep.hasProposal);
    ok("print: envelope block present", rep.hasEnvelope);
    ok("print: proposal table has a label column + 3 options", rep.cols === 4, `${rep.cols} columns`);
    ok("print: proposal table fits inside the report page", rep.propW <= rep.rpW + 1, `${Math.round(rep.propW)} vs ${Math.round(rep.rpW)}`);
    ok("no runtime errors", bad.length === 0, bad.slice(0, 3).join(" | "));
    await ctx.close();
  }

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ layout + print checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
