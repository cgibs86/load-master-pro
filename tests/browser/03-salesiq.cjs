// Playwright: use the project's install if present, else the system one this
// environment ships (PLAYWRIGHT_BROWSERS_PATH is respected by both).
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { return require("/opt/node22/lib/node_modules/playwright"); }
}
const { chromium } = loadPlaywright();
const BASE = process.env.LMP_BASE || "http://localhost:8099";
const SHOTS = process.env.LMP_SHOTS || require("os").tmpdir();
let fails = 0;
function ok(l, c, d) { console.log(`   ${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`); if (!c) fails++; }
async function relay(route) {
  try { const req = route.request();
    const real = await fetch(req.url(), { method: req.method(), headers: req.headers() });
    await route.fulfill({ status: real.status, contentType: real.headers.get("content-type") || "application/json", body: await real.text() });
  } catch (e) { await route.fulfill({ status: 599, body: "{}" }); }
}
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 1800 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => { localStorage.setItem("lmp_user", JSON.stringify({ email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() })); });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.route("**nominatim.openstreetmap.org/**", relay);
  await page.route("**archive-api.open-meteo.com/**", relay);
  await page.route("**epqs.nationalmap.gov/**", relay);
  await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await page.fill("#address", "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);   // let any second in-flight run settle before touching inputs

  const card = await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "");
  ok("SalesIQ card renders for a Pro user", card.includes("SalesIQ"), card.slice(0, 40));
  ok("uses live weather bins", /full year of on-site hourly weather/.test(card));
  ok("three option columns with annual cost before any input", (card.match(/Runs for/g) || []).length === 3);
  ok("rates prefilled from Texas", /typical TX average/.test(card));
  const kwh = await page.$eval("#sqKwh", el => el.value);
  ok("Texas kWh rate prefilled", parseFloat(kwh) > 0.1 && parseFloat(kwh) < 0.2, kwh);

  // Describe the current system + prices + build
  await page.selectOption("#sqExTons", "4");
  await page.fill("#sqExYear", "2008");
  await page.fill("#sqPrice0", "9500"); await page.fill("#sqPrice1", "12500"); await page.fill("#sqPrice2", "16500");
  await page.fill("#sqRebate2", "1000");
  await page.click("#salesBuildBtn");
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "");
  ok("existing system block appears", /Customer's current system[\s\S]*\/yr to run/.test(after));
  ok("right-size verdict shown", /% of the calculated load — (oversized|grossly oversized|right-sized|undersized)/.test(after), (after.match(/\d+% of the calculated load — [a-z -]+/) || [""])[0]);
  ok("savings vs current shown", /vs\. current/.test(after));
  ok("monthly payment shown", /Payment\s*\$\d+\/mo/.test(after));
  ok("net monthly after savings shown", /After savings/.test(after));
  ok("10-year cost shown", /10-yr cost to own/.test(after));
  ok("payback vs Good shown", /Pays back vs\. Good/.test(after));
  ok("talk track generated", /Talk track/i.test(after));
  const inputsKept = await page.evaluate(() => ({ tons: document.querySelector("#sqExTons").value, p2: document.querySelector("#sqPrice2").value, reb: document.querySelector("#sqRebate2").value }));
  ok("inputs survive the re-render", inputsKept.tons === "4" && inputsKept.p2 === "16500" && inputsKept.reb === "1000", JSON.stringify(inputsKept));
  await page.screenshot({ path: SHOTS + "/sales-card.png", fullPage: true });

  // Switch to heat pump: HSPF2 fields appear, AFUE gone
  await page.selectOption("#sqFuel", "hp");
  await page.waitForTimeout(600);
  const hpFields = await page.evaluate(() => ({ hspf: !!document.querySelector("#sqHspf0"), afue: !!document.querySelector("#sqAfue0") }));
  ok("heat pump fuel shows HSPF2 and hides AFUE", hpFields.hspf && !hpFields.afue, JSON.stringify(hpFields));
  await page.selectOption("#sqFuel", "dualfuel");
  await page.waitForTimeout(600);
  const df = await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "");
  ok("dual fuel shows switchover temperature", /Furnace takes over/.test(df));

  // Report carries the proposal
  await page.click("#reportBtn"); await page.waitForTimeout(900);
  const rep = await page.evaluate(() => document.querySelector("#reportRoot")?.textContent || "");
  ok("report has the proposal table", rep.includes("Replacement proposal") && rep.includes("Net monthly after energy savings"));
  await page.screenshot({ path: SHOTS + "/sales-report.png", fullPage: false });
  await page.click("#rpCloseBtn"); await page.waitForTimeout(300);

  // Share link round-trips the proposal
  const share = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("lmp_history_v1"))[0]; return s.snap.overrides.sales; });
  ok("saved job carries the proposal inputs", share && share.existing.tons === 4 && share.options[2].price === 16500);

  // Guest sees the locked teaser
  const ctx2 = await b.newContext({ viewport: { width: 420, height: 1200 }, serviceWorkers: "block" });
  const p2 = await ctx2.newPage();
  await p2.route("**nominatim.openstreetmap.org/**", relay); await p2.route("**archive-api.open-meteo.com/**", relay); await p2.route("**epqs.nationalmap.gov/**", relay);
  await p2.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await p2.fill("#address", "2100 Westheimer Rd, Houston, TX"); await p2.waitForTimeout(1500);
  const s2 = await p2.$("#suggest > *"); if (s2) await s2.click();
  await p2.waitForTimeout(400);
  if (!(await p2.$(".loading, #reportBtn"))) await p2.click("#calcBtn");
  await p2.waitForSelector("#reportBtn", { timeout: 40000 }); await p2.waitForTimeout(2500);
  const guest = await p2.evaluate(() => Array.from(document.querySelectorAll(".permit-card.locked")).map(e => e.innerText.slice(0, 40)));
  ok("guest sees locked SalesIQ teaser", guest.some(t => /SalesIQ/.test(t)), guest.join(" | "));

  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ SalesIQ checks passed");
  await b.close(); process.exit(fails ? 1 : 0);
})();
