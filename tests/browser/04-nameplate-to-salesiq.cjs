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
async function relay(route) { try { const req = route.request(); const real = await fetch(req.url(), { method: req.method(), headers: req.headers() }); await route.fulfill({ status: real.status, contentType: real.headers.get("content-type") || "application/json", body: await real.text() }); } catch (e) { await route.fulfill({ status: 599, body: "{}" }); } }
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 1800 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => {
    localStorage.setItem("lmp_user", JSON.stringify({ email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() }));
    localStorage.setItem("lmp_settings_v1", JSON.stringify({ aiProvider: "anthropic", aiApiKey: "sk-ant-test" }));
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.route("**nominatim.openstreetmap.org/**", relay); await page.route("**archive-api.open-meteo.com/**", relay); await page.route("**epqs.nationalmap.gov/**", relay);
  let aiBody = null;
  await page.route("**api.anthropic.com/**", async (route) => {
    aiBody = JSON.parse(route.request().postData() || "{}");
    const payload = { summary: "Photos show a 2008 Carrier condenser on a slab; the data plate is legible.",
      findings: [
        { field: "existingTons", value: "4", confidence: "high", note: "Model 24ACC648A003 — capacity code 048 = 4 tons" },
        { field: "existingYear", value: 2008, confidence: "medium", note: "Serial 2308E41211 — Carrier week 23 / 2008" },
        { field: "existingHeat", value: "furnace", confidence: "high", note: "Gas furnace with B-vent flue in the garage" },
        { field: "existingSeer", value: 13, confidence: "high", note: "EnergyGuide label reads 13 SEER" },
        { field: "sun", value: "high", confidence: "high", note: "No shade trees, west-facing glass" }
      ] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(payload) }] }) });
  });
  await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await page.fill("#address", "2100 Westheimer Rd, Houston, TX"); await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 }); await page.waitForTimeout(2500);

  await page.setInputFiles("#photoIn", __dirname + "/px.png");
  await page.waitForTimeout(800);
  ok("photo added", await page.evaluate(() => document.querySelectorAll(".photo-x").length) === 1);
  await page.click("#aiAnalyzeBtn");
  await page.waitForTimeout(1500);
  ok("provider was called with the nameplate prompt", aiBody && JSON.stringify(aiBody).includes("018/024/030/036"));
  const card = await page.evaluate(() => document.querySelector(".ai-card, .photo-insights, #results")?.innerText || "");
  ok("nameplate findings shown as applied", /Existing unit size[\s\S]{0,40}4 ton[\s\S]{0,40}applied/i.test(card), (card.match(/Existing unit size[^\n]*\n[^\n]*/) || [""])[0]);
  const vals = await page.evaluate(() => ({ tons: document.querySelector("#sqExTons")?.value, year: document.querySelector("#sqExYear")?.value, seer: document.querySelector("#sqExSeer")?.value, heat: document.querySelector("#sqExHeat")?.value }));
  ok("SalesIQ current-system fields pre-filled from the data plate", vals.tons === "4" && vals.year === "2008" && vals.seer === "13" && vals.heat === "furnace", JSON.stringify(vals));
  const sales = await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "");
  ok("SalesIQ shows the current-system cost without any typing", /Customer's current system[\s\S]*\/yr to run/.test(sales));
  ok("right-size verdict computed from the photo read", /% of the calculated load — /.test(sales), (sales.match(/\d+% of the calculated load — [a-z -]+/) || [""])[0]);
  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ nameplate -> SalesIQ checks passed");
  await b.close(); process.exit(fails ? 1 : 0);
})();
