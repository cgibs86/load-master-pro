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
// The results are a dashboard: each tool's card lives in a sheet its tile
// opens, and stays open across the re-render its own buttons cause.
async function openSheet(page, id) {
  if (await page.$(`#ds-${id}.open`)) return;
  if (await page.$(".dsheet.open")) await closeSheet(page);
  await page.click(`[data-open="${id}"]`);
  await page.waitForSelector(`#ds-${id}.open`, { timeout: 5000 });
}
async function closeSheet(page) {
  const x = await page.$(".dsheet.open .dsheet-x");
  if (!x) return;
  await x.click();
  await page.waitForSelector(".dsheet.open", { state: "detached", timeout: 5000 });
}
async function openPanel(page) {
  await openSheet(page, "adjust");
  await page.waitForSelector("#inArea", { state: "visible" });
}
// Read EnvelopeIQ the way the rep sees it: in its open sheet, rendered.
async function envelopeText(page) {
  await openSheet(page, "envelope");
  return page.evaluate(() => document.querySelector(".env-card")?.innerText || "");
}
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await (await b.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" })).newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await page.route("**nominatim.openstreetmap.org/**", relay);
  await page.route("**archive-api.open-meteo.com/**", relay);
  await page.route("**epqs.nationalmap.gov/**", relay);
  await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await page.fill("#address", "233 S Wacker Dr, Chicago, IL");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  // Picking a suggestion already starts a run; only press Calculate if it didn't.
  if (!sug) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);   // let any second in-flight run settle before touching inputs

  const before = {
    cool: await page.evaluate(() => document.querySelector("#kpi-cool .count")?.textContent),
    card: await envelopeText(page)
  };
  ok("EnvelopeIQ card renders", !!before.card, before.card.split("\n")[1]);
  ok("falls back to tier without a year built", /tier default/i.test(before.card));

  // Type a 1965 build year -> the table should engage and loosen the envelope.
  await openPanel(page);
  await page.fill("#inYearBuilt", "1965");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const old = {
    cool: await page.evaluate(() => document.querySelector("#kpi-cool .count")?.textContent),
    ph: await page.evaluate(() => document.querySelector("#inAtticR")?.placeholder),
    card: await envelopeText(page)
  };
  ok("year built engages the vintage x zone table", /code-era typical/i.test(old.card), old.card.split("\n")[1]);
  ok("attic placeholder names the assumed value", /assumed for a 1965 home in zone/.test(old.ph || ""), old.ph);

  await openPanel(page);
  ok("year built survives a recalculate", await page.$eval("#inYearBuilt", el => el.value) === "1965", await page.$eval("#inYearBuilt", el => el.value));
  await page.fill("#inYearBuilt", "2019");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const nw = {
    cool: await page.evaluate(() => document.querySelector("#kpi-cool .count")?.textContent),
    card: await envelopeText(page)
  };
  const n = (t) => parseInt((t || "0").replace(/[^0-9]/g, ""), 10);
  ok("a 2019 home loads lower than the same 1965 home", n(nw.cool) < n(old.cool), `1965 ${old.cool} vs 2019 ${nw.cool}`);
  ok("2019 card shows the newer era", /2021|2012-2020|2012/.test(nw.card), nw.card.split("\n")[1]);

  // Explicit tier pick must outrank the table.
  await openPanel(page);
  await page.click('#segQuality button[data-q="poor"]');
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const tier = await envelopeText(page);
  await openPanel(page);
  console.log("   DEBUG year field after tier recalc:", JSON.stringify(await page.$eval("#inYearBuilt", el => el.value)));
  ok("an explicit construction-tier pick outranks the vintage table", /construction tier overrides/i.test(tier) && !/CODE-ERA TYPICAL\n/i.test(tier), tier.split("\n")[1]);

  // Entered value must outrank everything.
  await openPanel(page);
  await page.fill("#inAtticR", "60");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const entered = await envelopeText(page);
  ok("a typed R-value is tagged as entered", /R-60\s*\n\s*YOU ENTERED/i.test(entered), entered.split("\n").slice(4,8).join(" / "));

  await closeSheet(page);
  await page.click("#reportBtn"); await page.waitForTimeout(800);
  const rep = await page.evaluate(() => document.querySelector("#reportRoot")?.textContent || "");
  ok("report carries the envelope appendix", rep.includes("Envelope assumptions"));
  ok("report carries the IECC zone row", rep.includes("IECC climate zone"));
  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ EnvelopeIQ checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
