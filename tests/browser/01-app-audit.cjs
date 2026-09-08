/*
 * Full-app regression sweep: every page, every major flow, watching for any
 * runtime error, failed request, or broken assertion.
 */
// Playwright: use the project's install if present, else the system one this
// environment ships (PLAYWRIGHT_BROWSERS_PATH is respected by both).
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { return require("/opt/node22/lib/node_modules/playwright"); }
}
const { chromium } = loadPlaywright();
const BASE = process.env.LMP_BASE || "http://localhost:8099";
const SHOTS = process.env.LMP_SHOTS || require("os").tmpdir();

let checks = 0, failures = 0;
function ok(label, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
}

async function relay(route) {
  try {
    const req = route.request();
    const real = await fetch(req.url(), { method: req.method(), headers: req.headers() });
    await route.fulfill({ status: real.status, contentType: real.headers.get("content-type") || "application/json", body: await real.text() });
  } catch (e) { await route.fulfill({ status: 599, body: "{}" }); }
}

async function openPanel(page) {
  // The results re-render (and the <details> collapses) after every
  // Recalculate, so only click the summary when it's actually closed.
  const open = await page.evaluate(() => !!document.querySelector("#adjustDetails")?.open);
  if (!open) await page.click("#adjustDetails summary");
  await page.waitForSelector("#inArea", { state: "visible" });
}
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const allErrors = [];

  function watch(page, tag) {
    page.on("pageerror", (e) => allErrors.push(`[${tag}] pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") allErrors.push(`[${tag}] console: ${m.text()}`); });
    page.on("requestfailed", (r) => {
      const u = r.url();
      if (u.startsWith(BASE)) allErrors.push(`[${tag}] requestfailed: ${u} ${r.failure()?.errorText}`);
    });
  }

  // ---------- 1. Static pages load clean ----------
  console.log("\n=== Static pages ===");
  for (const [file, tag] of [["index.html", "landing"], ["auth.html", "auth"], ["app.html", "app"]]) {
    const p = await (await browser.newContext()).newPage();
    watch(p, tag);
    const resp = await p.goto(`${BASE}/${file}`, { waitUntil: "networkidle" });
    ok(`${file} responds 200`, resp.status() === 200, `status ${resp.status()}`);
    const title = await p.title();
    ok(`${file} has a title`, title.length > 0, title);
    await p.close();
  }

  // PWA wiring on both entry points
  for (const file of ["index.html", "app.html"]) {
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${BASE}/${file}`, { waitUntil: "networkidle" });
    const hasManifest = await p.evaluate(() => !!document.querySelector('link[rel="manifest"]'));
    ok(`${file} links the PWA manifest`, hasManifest);
    await p.close();
  }

  // ---------- 2. Full calculation flow ----------
  console.log("\n=== Calculation flow (live geocode + live climate) ===");
  const ctx = await browser.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  watch(page, "calc");
  await page.route("**nominatim.openstreetmap.org/**", relay);
  await page.route("**archive-api.open-meteo.com/**", relay);
  await page.route("**epqs.nationalmap.gov/**", relay);

  await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await page.waitForSelector("#address");
  await page.fill("#address", "11 Belaire, Laguna Niguel, CA 92677");
  await page.waitForTimeout(1500);
  const sug = await page.$("#suggest > *");
  ok("address autocomplete returns suggestions", !!sug);
  if (sug) await sug.click();
  await page.waitForTimeout(300);
  await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 30000 });
  await page.waitForTimeout(600);

  const core = await page.evaluate(() => ({
    heat: document.querySelector(".load-card.heat .count")?.textContent,
    cool: document.querySelector(".load-card.cool .count")?.textContent,
    tons: document.querySelector(".equip-card .badge")?.textContent,
    climateChip: document.querySelector(".chips .chip")?.textContent,
    shr: document.querySelector(".shr-note")?.textContent?.slice(0, 60),
    finalTons: document.querySelector(".final-rec-tons")?.textContent,
  }));
  ok("heating load rendered", /\d/.test(core.heat || ""), core.heat);
  ok("cooling load rendered", /\d/.test(core.cool || ""), core.cool);
  ok("tonnage badge rendered", /\d/.test(core.tons || ""), core.tons);
  ok("live TrueClimate used (not station fallback)", /hrs/.test(core.climateChip || ""), core.climateChip?.trim());
  ok("SHR guidance present", !!core.shr, core.shr);
  ok("final recommendation headline present", /\d/.test(core.finalTons || ""), core.finalTons);

  // Sizing invariant in the live DOM
  const rows = await page.evaluate(() => {
    const o = {};
    document.querySelectorAll(".final-rec-row").forEach((r) => {
      o[r.querySelector("span").textContent.trim()] = parseFloat(r.querySelector("b").textContent);
    });
    return o;
  });
  const single = rows["Single-stage A/C or gas furnace split system"];
  const variable = rows["Variable-capacity (inverter) system"];
  ok("variable-capacity is not larger than single-stage in the live UI", variable <= single, `single ${single}t vs variable ${variable}t`);

  // ---------- 3. Fine-tune inputs ----------
  console.log("\n=== Fine-tune inputs ===");
  await openPanel(page);
  await page.waitForSelector("#inArea");
  for (const id of ["inArea", "inBeds", "inCeiling", "inStories", "inWindowFrac", "inAtticR", "inWindowU", "inWindowSHGC", "inAch", "inDuctType", "inDuctCondition", "inFoundation", "inSun", "inSystem"]) {
    const present = await page.$(`#${id}`);
    ok(`fine-tune field #${id} exists`, !!present);
  }
  await page.fill("#inArea", "3200");
  await page.fill("#inAtticR", "38");
  await page.fill("#inWindowSHGC", "0.25");
  await page.fill("#inAch", "0.35");
  await page.selectOption("#inStories", "2");
  await page.selectOption("#inDuctType", "attic");
  await page.selectOption("#inDuctCondition", "unsealed");
  await page.click("#recalcBtn");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    cool: document.querySelector(".load-card.cool .count")?.textContent,
    atticRow: Array.from(document.querySelectorAll(".kv")).map((k) => k.textContent).find((t) => t.includes("Attic")),
  }));
  ok("recalculate applies overrides", /\d/.test(after.cool || ""), `cooling ${after.cool}`);

  // ductless must clear the stale duct-condition value
  await openPanel(page);
  await page.waitForTimeout(150);
  await page.selectOption("#inDuctType", "ductless");
  await page.waitForTimeout(150);
  const condVal = await page.$eval("#inDuctCondition", (el) => el.value);
  ok("switching to ductless clears the duct-condition value", condVal === "", `value="${condVal}"`);

  // ---------- 4. Return-air check ----------
  console.log("\n=== Return-air check ===");
  await page.selectOption("#inRetAirMode", "grille");
  await page.waitForTimeout(150);
  await page.fill("#inRetAirGrilleW", "20");
  await page.fill("#inRetAirGrilleH", "20");
  await page.click("#checkRetAirBtn");
  await page.waitForTimeout(400);
  const ra = await page.evaluate(() => document.querySelector(".retair-card")?.textContent || "");
  ok("return-air check renders a verdict", /Adequate|undersized/.test(ra), ra.slice(0, 70));

  // ---------- 5. Report ----------
  console.log("\n=== Report generation ===");
  await page.click("#reportBtn");
  await page.waitForTimeout(700);
  const rep = await page.evaluate(() => {
    const t = document.querySelector("#reportRoot")?.textContent || "";
    return {
      len: t.length,
      hasFinalRec: t.includes("Final recommendation"),
      hasSHR: t.includes("Sensible / latent split"),
      hasReturnAir: t.includes("Return air sizing"),
      hasDesign: t.includes("Design conditions"),
      hasDisclaimer: t.includes("Disclaimer"),
    };
  });
  ok("report renders with content", rep.len > 1500, `${rep.len} chars`);
  ok("report has final recommendation table", rep.hasFinalRec);
  ok("report has SHR row", rep.hasSHR);
  ok("report has return-air section", rep.hasReturnAir);
  ok("report has design conditions", rep.hasDesign);
  ok("report has disclaimer", rep.hasDisclaimer);
  await page.screenshot({ path: SHOTS + "/audit-report.png", fullPage: false });
  await page.click("#rpCloseBtn");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => (document.querySelector("#reportRoot")?.innerHTML || "").length === 0);
  ok("report closes cleanly", closed);

  // ---------- 6. Settings ----------
  console.log("\n=== Settings ===");
  await page.click("#openSettings");
  await page.waitForSelector("#aiProvider");
  const providers = await page.$$eval("#aiProvider option", (os) => os.map((o) => o.value));
  ok("all AI providers listed", providers.length >= 5, providers.join(","));
  await page.fill("#aiKey", "sk-leak-canary");
  await page.selectOption("#aiProvider", "gemini");
  await page.waitForTimeout(120);
  const keyAfter = await page.$eval("#aiKey", (el) => el.value);
  ok("switching provider clears the previous key", keyAfter === "", `value="${keyAfter}"`);
  const baseUrlHidden = await page.$eval("#aiBaseUrlWrap", (el) => el.style.display);
  ok("base-URL field hidden for non-custom provider", baseUrlHidden === "none", `display=${baseUrlHidden}`);
  await page.selectOption("#aiProvider", "custom");
  await page.waitForTimeout(120);
  const baseUrlShown = await page.$eval("#aiBaseUrlWrap", (el) => el.style.display);
  ok("base-URL field shown for custom provider", baseUrlShown !== "none", `display=${baseUrlShown}`);

  console.log("\n=== Runtime errors ===");
  ok("no page errors, console errors, or failed same-origin requests", allErrors.length === 0, allErrors.slice(0, 6).join(" | ") || "clean");

  console.log(`\n${failures === 0 ? "✅ AUDIT PASSED" : "❌ " + failures + " CHECK(S) FAILED"} (${checks} checks)`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(1); });
