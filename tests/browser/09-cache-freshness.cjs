/*
 * Service-worker freshness.
 *
 * The regression this guards: the worker used to be cache-first for
 * everything, so a deployed change (a price, say) was served from the old
 * cache and only appeared on the visitor's NEXT visit. Here the served file
 * is edited on disk between two loads with the worker active, and the second
 * load must show the new content — not the cached old content.
 *
 * Service workers are deliberately NOT blocked in this probe; they are the
 * thing under test.
 */
function loadPlaywright() {
  try { return require("playwright"); } catch (e) { return require("/opt/node22/lib/node_modules/playwright"); }
}
const { chromium } = loadPlaywright();
const fs = require("fs");
const path = require("path");
const BASE = process.env.LMP_BASE || "http://localhost:8099";
const ROOT = path.join(__dirname, "..", "..");
const TARGET = path.join(ROOT, "index.html");

let fails = 0;
function ok(l, c, d) { console.log(`   ${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`); if (!c) fails++; }

(async () => {
  const original = fs.readFileSync(TARGET, "utf8");
  const MARKER_OLD = "$199<small>/mo</small>";
  const MARKER_NEW = "$1234<small>/mo</small>";
  if (original.indexOf(MARKER_OLD) === -1) {
    console.log("   ❌ probe needs the Solo price in index.html to edit; not found");
    process.exit(1);
  }

  const b = await chromium.launch({ args: ["--no-sandbox"] });
  let restored = false;
  const restore = () => { if (!restored) { fs.writeFileSync(TARGET, original); restored = true; } };

  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));

    // 1. First visit: worker installs and precaches the current page.
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 })
      .catch(() => {});
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    ok("service worker takes control of the page", controlled);
    ok("first visit shows the deployed price", (await page.content()).includes(MARKER_OLD));

    // 2. Deploy a change underneath it.
    fs.writeFileSync(TARGET, original.replace(MARKER_OLD, MARKER_NEW));

    // 3. Reload. With the old cache-first worker this served the stale copy.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const html = await page.content();
    ok("a deployed change appears on the very next load, not the one after",
      html.includes(MARKER_NEW) && !html.includes(MARKER_OLD),
      html.includes(MARKER_OLD) ? "still serving the cached old copy" : "fresh");

    // 4. Offline still works: the worker must fall back to its cache.
    fs.writeFileSync(TARGET, original);
    restored = true;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await ctx.setOffline(true);
    let offlineOk = true, offlineDetail = "";
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
      const offlineHtml = await page.content();
      offlineOk = offlineHtml.includes("LoadMaster") && offlineHtml.length > 2000;
      offlineDetail = `${offlineHtml.length} chars`;
    } catch (e) { offlineOk = false; offlineDetail = e.message.split("\n")[0]; }
    ok("the page still loads with no network (cache fallback intact)", offlineOk, offlineDetail);

    const appOffline = await page.goto(`${BASE}/app.html`, { waitUntil: "domcontentloaded" }).then(
      () => page.evaluate(() => !!document.querySelector("#address")), () => false);
    ok("the calculator still opens offline", appOffline);
    await ctx.setOffline(false);

    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  } finally {
    restore();
    await b.close();
  }

  // The edited file must never be left behind, whatever happened above.
  ok("the probe restored index.html", fs.readFileSync(TARGET, "utf8") === original);

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ cache freshness checks passed");
  process.exit(fails ? 1 : 0);
})();
