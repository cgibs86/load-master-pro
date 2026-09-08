/*
 * Price book: building it in Settings, and SalesIQ filling itself from it.
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
async function runCalc(page) {
  await page.fill("#address", "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);
}
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 2000 }, serviceWorkers: "block" });
  await ctx.addInitScript(() => localStorage.setItem("lmp_user", JSON.stringify({ email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() })));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.route("**nominatim.openstreetmap.org/**", relay);
  await page.route("**archive-api.open-meteo.com/**", relay);
  await page.route("**epqs.nationalmap.gov/**", relay);
  await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await runCalc(page);

  // With an empty book, SalesIQ should say so rather than sit silently blank.
  ok("an empty book prompts the rep to build one", /Save your equipment once under Settings/.test(await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "")));

  // ---- build the book in Settings ----
  await page.click("#openSettings");
  await page.waitForSelector("#pbAddBtn", { state: "visible" });
  ok("price book section renders in Settings", await page.$("#pbList") !== null);
  ok("it starts empty", /No equipment saved yet/.test(await page.evaluate(() => document.querySelector("#pbList")?.innerText || "")));

  await page.click("#pbSeedBtn");
  await page.waitForTimeout(600);
  await page.waitForSelector("#pbList", { state: "visible" });
  const seeded = await page.evaluate(() => JSON.parse(localStorage.getItem("lmp_pricebook_v1")).entries.length);
  ok("the template seeds a usable book", seeded === 6, String(seeded));
  ok("the saved rows are listed", (await page.$$(".pb-row")).length === 6);

  // Add one of the shop's own lines.
  await page.fill("#pbName", "Shop premium inverter");
  await page.selectOption("#pbTier", "best");
  await page.selectOption("#pbStage", "variable");
  await page.selectOption("#pbFuel", "furnace");
  await page.selectOption("#pbPricing", "flat");
  await page.waitForTimeout(150);
  ok("choosing flat pricing swaps the price fields", await page.$eval("#pbFlatWrap", el => el.style.display) !== "none" && await page.$eval("#pbPerTonWrap", el => el.style.display) === "none");
  await page.fill("#pbFlat", "19500");
  await page.fill("#pbSeer", "20");
  await page.fill("#pbEff2", "97");
  await page.fill("#pbRebate", "1200");
  await page.click("#pbAddBtn");
  await page.waitForTimeout(600);
  const book = await page.evaluate(() => JSON.parse(localStorage.getItem("lmp_pricebook_v1")).entries);
  const mine = book.find(e => e.name === "Shop premium inverter");
  ok("the new line is saved", !!mine);
  ok("AFUE entered as 97 is stored as 0.97", mine && mine.afue === 0.97, mine && String(mine.afue));
  ok("its flat price and rebate are stored", mine && mine.flatPrice === 19500 && mine.rebate === 1200);

  // The form resets after an add, so the next item starts clean.
  ok("the form clears after adding", await page.$eval("#pbName", el => el.value) === "");
  // A nameless entry must be refused, not silently saved.
  await page.fill("#pbBase", "5000");
  await page.click("#pbAddBtn");
  await page.waitForTimeout(400);
  const count = await page.evaluate(() => JSON.parse(localStorage.getItem("lmp_pricebook_v1")).entries.length);
  ok("a nameless entry is refused", count === 7, String(count));

  const closeBtn = await page.$("#closeSettings");
  if (closeBtn) await closeBtn.click();
  await page.waitForTimeout(400);

  // ---- SalesIQ should now fill itself ----
  await page.reload({ waitUntil: "load" });
  await runCalc(page);
  const card = await page.evaluate(() => document.querySelector("#salesCard")?.innerText || "");
  ok("SalesIQ says the prices came from the book", /Filled from your price book/i.test(card), card.split("\n").find(l => /price book/i.test(l)));
  ok("it names the line it used", /Shop premium inverter/.test(card));
  const prices = await page.evaluate(() => [0, 1, 2].map(i => document.querySelector("#sqPrice" + i)?.value));
  ok("every tier is priced without the rep typing anything", prices.every(v => v && Number(v) > 0), prices.join(" / "));
  ok("the premium line's flat price is used for Best", prices[2] === "19500", prices[2]);
  const results = await page.evaluate(() => document.querySelector("#salesResults")?.innerText || "");
  ok("monthly payments appear straight away", /\/mo/.test(results));

  // A price the rep types must win over the book.
  await page.fill("#sqPrice2", "22000");
  await page.click("#salesBuildBtn");
  await page.waitForTimeout(700);
  ok("a typed price overrides the book", await page.$eval("#sqPrice2", el => el.value) === "22000");

  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ price book checks passed");
  await b.close(); process.exit(fails ? 1 : 0);
})();
