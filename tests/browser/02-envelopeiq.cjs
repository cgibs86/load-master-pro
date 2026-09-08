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
async function openPanel(page) {
  // The results re-render (and the <details> collapses) after every
  // Recalculate, so only click the summary when it's actually closed.
  const open = await page.evaluate(() => !!document.querySelector("#adjustDetails")?.open);
  if (!open) await page.click("#adjustDetails summary");
  await page.waitForSelector("#inArea", { state: "visible" });
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
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);   // let any second in-flight run settle before touching inputs

  const before = await page.evaluate(() => ({
    cool: document.querySelector(".load-card.cool .count")?.textContent,
    card: document.querySelector(".env-card")?.innerText || ""
  }));
  ok("EnvelopeIQ card renders", !!before.card, before.card.split("\n")[1]);
  ok("falls back to tier without a year built", /tier default/i.test(before.card));

  // Type a 1965 build year -> the table should engage and loosen the envelope.
  await openPanel(page);
  await page.fill("#inYearBuilt", "1965");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const old = await page.evaluate(() => ({
    cool: document.querySelector(".load-card.cool .count")?.textContent,
    card: document.querySelector(".env-card")?.innerText || "",
    ph: document.querySelector("#inAtticR")?.placeholder
  }));
  ok("year built engages the vintage x zone table", /code-era typical/i.test(old.card), old.card.split("\n")[1]);
  ok("attic placeholder names the assumed value", /assumed for a 1965 home in zone/.test(old.ph || ""), old.ph);

  await openPanel(page);
  ok("year built survives a recalculate", await page.$eval("#inYearBuilt", el => el.value) === "1965", await page.$eval("#inYearBuilt", el => el.value));
  await page.fill("#inYearBuilt", "2019");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const nw = await page.evaluate(() => ({
    cool: document.querySelector(".load-card.cool .count")?.textContent,
    card: document.querySelector(".env-card")?.innerText || ""
  }));
  const n = (t) => parseInt((t || "0").replace(/[^0-9]/g, ""), 10);
  ok("a 2019 home loads lower than the same 1965 home", n(nw.cool) < n(old.cool), `1965 ${old.cool} vs 2019 ${nw.cool}`);
  ok("2019 card shows the newer era", /2021|2012-2020|2012/.test(nw.card), nw.card.split("\n")[1]);

  // Explicit tier pick must outrank the table.
  await openPanel(page);
  await page.click('#segQuality button[data-q="poor"]');
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const tier = await page.evaluate(() => document.querySelector(".env-card")?.innerText || "");
  await openPanel(page);
  console.log("   DEBUG year field after tier recalc:", JSON.stringify(await page.$eval("#inYearBuilt", el => el.value)));
  ok("an explicit construction-tier pick outranks the vintage table", /construction tier overrides/i.test(tier) && !/CODE-ERA TYPICAL\n/i.test(tier), tier.split("\n")[1]);

  // Entered value must outrank everything.
  await openPanel(page);
  await page.fill("#inAtticR", "60");
  await page.click("#recalcBtn");
  await page.waitForTimeout(600);
  const entered = await page.evaluate(() => document.querySelector(".env-card")?.innerText || "");
  ok("a typed R-value is tagged as entered", /R-60\s*\n\s*YOU ENTERED/i.test(entered), entered.split("\n").slice(4,8).join(" / "));

  await page.click("#reportBtn"); await page.waitForTimeout(800);
  const rep = await page.evaluate(() => document.querySelector("#reportRoot")?.textContent || "");
  ok("report carries the envelope appendix", rep.includes("Envelope assumptions"));
  ok("report carries the IECC zone row", rep.includes("IECC climate zone"));
  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ EnvelopeIQ checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
