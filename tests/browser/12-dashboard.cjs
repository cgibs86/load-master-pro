/*
 * The results dashboard: the answer and every tool's headline on about one
 * screen, each tool's full card in a sheet its tile opens.
 *
 * Covers what the dashboard promises (compact, every tile opens its sheet,
 * headlines update) and the ways a rep in a driveway can break it: the phone's
 * Back button, Escape, a refresh with a sheet open, a double-tapped
 * Calculate, an empty address, rapid open/close, a background search landing
 * while they type, locked plans, and a desktop-width drawer.
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
const PRO = { email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() };
const SOLO = { email: "s@t.com", name: "S", company: "Solo HVAC", plan: "solo", created: Date.now() };
const SHEETS = ["sizing", "heating", "airflow", "breakdown", "envelope", "photos", "permit", "rebates", "energy", "rooms", "send", "adjust"];

async function newPage(b, { user, viewport, settings } = {}) {
  const ctx = await b.newContext({ viewport: viewport || { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.addInitScript(([u, s]) => {
    if (u) localStorage.setItem("lmp_user", JSON.stringify(u));
    if (s) localStorage.setItem("lmp_settings_v1", JSON.stringify(s));
  }, [user || null, settings || null]);
  const page = await ctx.newPage();
  page.errs = [];
  page.on("pageerror", e => page.errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") page.errs.push("console: " + m.text()); });
  await page.route("**nominatim.openstreetmap.org/**", relay);
  await page.route("**archive-api.open-meteo.com/**", relay);
  await page.route("**epqs.nationalmap.gov/**", relay);
  return { ctx, page };
}
async function runCalc(page, address) {
  await page.fill("#address", address || "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!sug) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(1500);
}
const openSheets = page => page.$$eval(".dsheet.open", els => els.map(e => e.getAttribute("data-sheet")));

(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });

  // ---------- 1. Phone: the answer on one screen ----------
  console.log("\n=== Phone dashboard ===");
  {
    const { ctx, page } = await newPage(b, { user: PRO });
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });

    // The search screen fits before anyone scrolls.
    const search = await page.evaluate(() => {
      const chips = document.querySelector("#jobChips");
      const calc = document.querySelector("#calcBtn").getBoundingClientRect();
      return { chipRowH: chips.getBoundingClientRect().height, scrolls: chips.scrollWidth > chips.clientWidth, calcBottom: calc.bottom };
    });
    ok("job chips sit in one swipeable row", search.chipRowH < 50 && search.scrolls, `${Math.round(search.chipRowH)}px tall`);
    ok("Calculate is on the first screen, no scrolling", search.calcBottom <= 844, `${Math.round(search.calcBottom)}px`);

    await runCalc(page);
    const m = await page.evaluate(() => {
      const res = document.querySelector("#results");
      const text = res.innerText;   // hidden sheets are left out of innerText
      return {
        h: res.getBoundingClientRect().height,
        words: text.split(/\s+/).filter(Boolean).length,
        tonMentions: (text.match(/\d+(\.\d)?\s*-?ton\b/gi) || []).length,
        tiles: document.querySelectorAll("#results .tile").length,
        kpis: document.querySelectorAll("#results .kpi").length,
        collapsed: getComputedStyle(document.querySelector("#jobPick")).display === "none",
        calcVisible: !!document.querySelector("#calcBtn").offsetParent
      };
    });
    ok("the dashboard is about one and a half phone screens, not nine", m.h <= 1500, `${Math.round(m.h)}px (was 6,563)`);
    ok("it reads in seconds", m.words <= 300, `${m.words} words visible (was 1,305)`);
    ok("the tonnage is stated once on the dashboard", m.tonMentions === 1, `${m.tonMentions} mentions (was 5)`);
    ok("four answer tiles and eight tool tiles", m.kpis === 4 && m.tiles === 8, `${m.kpis} + ${m.tiles}`);
    ok("the search card shrinks to address + Calculate", m.collapsed && m.calcVisible);

    // Every tile and answer tile opens its sheet, with real content, on screen.
    for (const id of SHEETS) {
      await page.click(`[data-open="${id}"]`);
      await page.waitForSelector(`#ds-${id}.open`, { timeout: 5000 });
      // Let the slide-in finish before measuring where the panel sits.
      await page.waitForFunction(sid => document.querySelector(`#ds-${sid} .dsheet-panel`).getAnimations().every(a => a.playState !== "running"), id, { timeout: 3000 });
      const s = await page.evaluate(sid => {
        const el = document.querySelector(`#ds-${sid}`);
        const r = el.querySelector(".dsheet-panel").getBoundingClientRect();
        return { text: el.querySelector(".dsheet-body").innerText.trim().length, onScreen: r.top >= 0 && r.bottom <= innerHeight + 1, locked: document.body.classList.contains("ds-open") };
      }, id);
      ok(`"${id}" opens a sheet with its card`, s.text > 40 && s.onScreen && s.locked, `${s.text} chars`);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".dsheet.open", { state: "detached", timeout: 3000 });
    }
    ok("Escape closes and releases the page", !(await page.evaluate(() => document.body.classList.contains("ds-open"))));

    // Backdrop tap and the close button.
    await page.click("#tile-permit");
    await page.waitForSelector("#ds-permit.open");
    await page.mouse.click(195, 12);   // above the panel: the dimmed backdrop
    await page.waitForTimeout(300);
    ok("tapping the dimmed backdrop closes the sheet", (await openSheets(page)).length === 0);

    // The phone's Back button closes the sheet instead of leaving the app.
    await page.click("#tile-envelope");
    await page.waitForSelector("#ds-envelope.open");
    const urlBefore = page.url();
    await page.goBack();
    await page.waitForTimeout(400);
    ok("Back closes the sheet", (await openSheets(page)).length === 0);
    ok("...without leaving the app or losing the calculation", page.url() === urlBefore && !!(await page.$("#kpi-cool")));

    // Closing with ✕ must not strand an extra Back press in history.
    await page.click("#tile-breakdown");
    await page.waitForSelector("#ds-breakdown.open");
    await page.click("#ds-breakdown .dsheet-x");
    await page.waitForTimeout(400);
    ok("✕ closes the sheet and pops its history entry", (await openSheets(page)).length === 0 && !(await page.evaluate(() => history.state && history.state.lmpSheet)));

    // Rapid open/close: tap-happy thumbs must not leave two sheets open or the page locked.
    for (const id of ["energy", "rooms", "permit", "sizing", "send", "rebates"]) {
      await page.click(`[data-open="${id}"]`);
      await page.keyboard.press("Escape");
    }
    await page.click("#tile-rooms");
    await page.waitForTimeout(400);
    const after = await openSheets(page);
    ok("rapid open/close ends with exactly the last sheet open", after.length === 1 && after[0] === "rooms", after.join(","));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // A sheet survives the re-render its own button causes, at its scroll position.
    await page.click("#adjustBtn");
    await page.waitForSelector("#ds-adjust.open");
    await page.evaluate(() => { document.querySelector("#ds-adjust .dsheet-body").scrollTop = 300; });
    await page.fill("#inArea", "2400");
    await page.click("#recalcBtn");
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(() => ({
      open: !!document.querySelector("#ds-adjust.open"),
      scroll: document.querySelector("#ds-adjust .dsheet-body").scrollTop,
      chip: document.querySelector("#adjustChip")?.innerText || document.querySelector(".dh-meta")?.innerText || ""
    }));
    ok("Recalculate keeps the Fine-tune sheet open", kept.open);
    ok("...where the rep had scrolled to", kept.scroll > 150, `${Math.round(kept.scroll)}px`);
    ok("...and the dashboard behind it took the new area", /2,400/.test(kept.chip), kept.chip.replace(/\n/g, " · "));
    await page.keyboard.press("Escape");

    // Empty address: an error, and the dashboard stays.
    await page.fill("#address", "");
    await page.click("#calcBtn");
    await page.waitForTimeout(300);
    ok("an empty address explains itself and keeps the dashboard", /street address/i.test(await page.evaluate(() => document.querySelector("#errorBox").innerText)) && !!(await page.$("#kpi-cool")));

    // Double-tapped Calculate from the collapsed bar: one calculation, no errors.
    await page.fill("#address", "233 S Wacker Dr, Chicago, IL");
    await page.click("#tile-energy");
    await page.waitForSelector("#ds-energy.open");
    await page.keyboard.press("Escape");
    await page.click("#calcBtn");
    await page.click("#calcBtn", { force: true, noWaitAfter: true }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector("#calcBtn").disabled, null, { timeout: 40000 });
    await page.waitForTimeout(1200);
    const second = await page.evaluate(() => ({ addr: document.querySelector(".dh-addr")?.innerText || "", sheets: document.querySelectorAll(".dsheet.open").length }));
    ok("a second calculation from the collapsed bar works", /Wacker|Chicago/i.test(second.addr), second.addr);
    ok("...and opens on the dashboard, not on a sheet from the last house", second.sheets === 0);

    // Refresh with a sheet open: a clean start, no stale Back entry.
    await page.click("#tile-sizing");
    await page.waitForSelector("#ds-sizing.open");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    ok("refresh with a sheet open comes back clean", !(await page.evaluate(() => history.state && history.state.lmpSheet)) && !!(await page.$("#address")));

    ok("no runtime errors on the phone", page.errs.length === 0, page.errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- 2. A background search lands while the rep is typing ----------
  console.log("\n=== Background re-render ===");
  {
    const { ctx, page } = await newPage(b, { user: PRO, settings: { aiProvider: "anthropic", aiApiKey: "sk-ant-test" } });
    await page.route("**api.anthropic.com/**", async route => {
      await new Promise(r => setTimeout(r, 3500));   // the search takes a while
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        stop_reason: "end_turn",
        content: [
          { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit", title: "IRS 25C" }] },
          { type: "text", text: JSON.stringify({ programs: [{ name: "25C Energy Efficient Home Improvement Credit", administrator: "IRS", type: "federal-tax-credit",
            amountMax: 2000, amountText: "30% up to $2,000", incomeQualified: false,
            applyUrl: "https://www.irs.gov/forms-pubs/about-form-5695", source: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit" }],
            homeownerSummary: "About $2,000.", confidence: "medium" }) }
        ]
      }) });
    });
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);
    await page.click("#tile-rebates");
    await page.waitForSelector("#ds-rebates.open");
    await page.click("#rebateBtn");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    ok("the tile shows the search running", /Searching/.test(await page.evaluate(() => document.querySelector("#tile-rebates").innerText)));

    // Meanwhile the rep measures the attic and starts typing.
    await page.click("#adjustBtn");
    await page.waitForSelector("#ds-adjust.open");
    await page.fill("#inAtticR", "19");
    const landed = await page.waitForFunction(() => /\$2,000/.test(document.querySelector("#tile-rebates")?.innerText || ""), null, { timeout: 20000 })
      .then(() => true, () => false);
    const s = await page.evaluate(() => ({ open: !!document.querySelector("#ds-adjust.open"), attic: document.querySelector("#inAtticR").value,
      tile: document.querySelector("#tile-rebates")?.innerText || "" }));
    ok("the RebateIQ tile updated behind the open sheet", landed, s.tile.replace(/\n/g, " · "));
    ok("the search landing does not close the sheet the rep is typing in", s.open);
    ok("...or wipe what they typed", s.attic === "19", s.attic);
    ok("no runtime errors", page.errs.length === 0, page.errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- 3. Locked plans ----------
  console.log("\n=== Guest and Solo ===");
  for (const [who, user, cta] of [["guest", null, /free trial/i], ["Solo", SOLO, /Upgrade to Pro/i]]) {
    const { ctx, page } = await newPage(b, { user });
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);
    const locked = await page.$$eval("#results .tile.locked", els => els.map(e => e.id.replace("tile-", "")));
    ok(`${who}: the Pro tools show as locked tiles`, ["rooms", "photos", "energy", "rebates", "permit"].every(id => locked.includes(id)), locked.join(","));
    await page.click("#tile-energy");
    await page.waitForSelector("#ds-energy.open");
    const t = await page.evaluate(() => document.querySelector("#ds-energy .dsheet-body").innerText);
    ok(`${who}: a locked tile opens the teaser with the right way in`, cta.test(t), t.slice(0, 50));
    await page.keyboard.press("Escape");
    ok(`${who}: the core answer is all there`, !!(await page.$("#kpi-cool .count")) && !!(await page.$("#tile-sizing:not(.locked)")));
    ok(`${who}: no runtime errors`, page.errs.length === 0, page.errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- 4. Desktop: a real dashboard, detail in a drawer ----------
  console.log("\n=== Desktop ===");
  {
    const { ctx, page } = await newPage(b, { user: PRO, viewport: { width: 1280, height: 820 } });
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);
    const d = await page.evaluate(() => {
      const kpiTops = Array.from(document.querySelectorAll(".kpi")).map(k => Math.round(k.getBoundingClientRect().top));
      const groups = Array.from(document.querySelectorAll(".tile-group")).map(g => Math.round(g.getBoundingClientRect().top));
      const bar = document.querySelector(".dash-bar").getBoundingClientRect();
      return { kpiRow: new Set(kpiTops).size === 1, groupsSide: groups.length === 2 && groups[0] === groups[1],
               barBottom: bar.bottom, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    ok("the four answers sit on one row", d.kpiRow);
    ok("the house and the sale sit side by side", d.groupsSide);
    ok("the whole dashboard, actions included, fits one screen", d.barBottom <= 820, `${Math.round(d.barBottom)}px`);
    ok("no horizontal overflow", d.overflow <= 1, `${d.overflow}px`);
    await page.click("#tile-energy");
    await page.waitForSelector("#ds-energy.open");
    await page.waitForTimeout(400);
    const dr = await page.evaluate(() => {
      const p = document.querySelector("#ds-energy .dsheet-panel").getBoundingClientRect();
      const k = document.querySelector("#kpi-cool").getBoundingClientRect();
      return { right: p.right, left: p.left, kpiClear: k.right < p.left };
    });
    ok("detail opens as a drawer on the right", Math.abs(dr.right - 1280) <= 2 && dr.left > 500, `${Math.round(dr.left)}–${Math.round(dr.right)}`);
    ok("...beside the dashboard rather than over the answer", dr.kpiClear);
    ok("no runtime errors", page.errs.length === 0, page.errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ dashboard checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
