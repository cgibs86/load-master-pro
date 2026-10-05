/*
 * Job type picker, its effect on the calculation and on RebateIQ, and the
 * ServiceTitan hand-off.
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
const PAID = { email: "t@t.com", name: "T", company: "Test HVAC", plan: "pro", created: Date.now() };

async function runCalc(page) {
  await page.fill("#address", "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  // Only start a run if the suggestion click did not: clicking Calculate as
  // well starts a SECOND calculation, whose finish re-renders the results and
  // throws away anything typed into them in between.
  if (!sug) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);
}

(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });

  // ---------- Picking the job, by chip and by typing ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 2200 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => localStorage.setItem("lmp_user", JSON.stringify(p)), PAID);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });

    ok("the job picker is on the search screen, before any calculation", await page.$("#jobPick") !== null);
    ok("quick chips are offered", (await page.$$(".job-chip[data-job]")).length >= 6);
    ok("a default job is pre-selected so nothing blocks the calc", await page.$(".job-chip.on") !== null);
    ok("the full catalogue is reachable", await page.$("#jobMoreBtn") !== null);

    // Typing
    await page.fill("#jobSearch", "mini split");
    await page.waitForTimeout(250);
    ok("typing offers matches", (await page.$$(".job-sg")).length > 0);
    await page.click(".job-sg");
    await page.waitForTimeout(300);
    const chosen = await page.evaluate(() => document.querySelector("#jobChosen")?.innerText || "");
    ok("picking a typed match sets the job", /mini-split/i.test(chosen), chosen.split("\n")[0]);
    ok("the search box clears after choosing", (await page.$eval("#jobSearch", el => el.value)) === "");

    // The trap: a longer phrase must not land on the shorter one.
    await page.fill("#jobSearch", "heat pump water heater");
    await page.waitForTimeout(250);
    const top = await page.evaluate(() => document.querySelector(".job-sg b")?.textContent || "");
    ok('"heat pump water heater" offers the water heater first, not the heat pump', /water heater/i.test(top), top);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ok("Enter picks the top match", /water heater/i.test(await page.evaluate(() => document.querySelector("#jobChosen")?.innerText || "")));

    // Free text that matches nothing is still kept, because it steers the search.
    await page.fill("#jobSearch", "swamp cooler conversion");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ok("unmatched free text is kept rather than discarded",
      /swamp cooler conversion/i.test(await page.evaluate(() => document.querySelector("#jobChosen")?.innerText || "")));

    // The sheet
    await page.click("#jobMoreBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    const rows = await page.$$(".job-row");
    ok("the full catalogue lists every job type", rows.length >= 25, `${rows.length} rows`);
    const cats = await page.$$(".job-cat");
    ok("it is grouped into categories", cats.length >= 5, `${cats.length} categories`);
    const labels = await page.$$eval(".job-row b", e => e.map(x => x.textContent));
    for (const want of ["Mini-split — single zone", "A/C + 96% gas furnace", "Duct replacement", "Duct sealing / repair", "Insulation / air sealing", "Geothermal / ground-source heat pump"]) {
      ok(`the catalogue offers "${want}"`, labels.includes(want));
    }
    await page.click('.job-row[data-job="duct-seal"]');
    await page.waitForTimeout(400);
    ok("picking from the sheet sets the job", /Duct sealing/i.test(await page.evaluate(() => document.querySelector("#jobChosen")?.innerText || "")));

    // It survives a reload — a shop that mostly fits heat pumps shouldn't re-pick every call.
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(400);
    ok("the last job type is remembered on this device", /Duct sealing/i.test(await page.evaluate(() => document.querySelector("#jobChosen")?.innerText || "")));

    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- The job type changes the calculation ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 2200 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => localStorage.setItem("lmp_user", JSON.stringify(p)), PAID);
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });

    // Ducted job first.
    await page.click('.job-chip[data-job="ac-furnace-96"]');
    await page.waitForTimeout(200);
    await runCalc(page);
    const ducted = await page.evaluate(() => ({
      cool: document.querySelector(".load-card.cool .count")?.textContent,
      banner: document.querySelector(".job-banner")?.innerText || ""
    }));
    ok("the chosen job is shown with the results", /96% gas furnace/i.test(ducted.banner), ducted.banner.split("\n").slice(0, 2).join(" "));

    // Switch to ductless: duct losses must come off the load.
    await page.click("#jobChangeBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.click('.job-row[data-job="minisplit-single"]');
    await page.waitForTimeout(1200);
    const ductless = await page.evaluate(() => ({
      cool: document.querySelector(".load-card.cool .count")?.textContent,
      banner: document.querySelector(".job-banner")?.innerText || ""
    }));
    const num = t => parseInt((t || "0").replace(/[^0-9]/g, ""), 10);
    ok("a ductless job recalculates immediately", num(ductless.cool) > 0 && num(ductless.cool) !== num(ducted.cool), `${ducted.cool} -> ${ductless.cool}`);
    ok("...and the load drops, because a mini-split has no duct losses", num(ductless.cool) < num(ducted.cool), `${ducted.cool} -> ${ductless.cool}`);
    ok("the results say duct losses were removed", /no duct losses/i.test(ductless.banner), ductless.banner);

    // The sizing table has four right answers; the job decides which is THE
    // answer, so the matching row must be marked rather than left to the rep.
    const marked = await page.evaluate(() => {
      const row = document.querySelector(".final-rec-row.picked");
      return { text: row ? row.innerText.replace(/\n/g, " ") : "", count: document.querySelectorAll(".final-rec-row.picked").length };
    });
    ok("the sizing family this job belongs to is marked", /variable/i.test(marked.text), marked.text);
    ok("...and only one row is marked", marked.count === 1, String(marked.count));
    ok("the lead-in names the job it was sized for",
      /Mini-split/i.test(await page.evaluate(() => document.querySelector(".final-rec-sub")?.innerText || "")));

    // A mini-split is a heat pump, so the running-cost tiers must be labelled
    // on HSPF2, not on a furnace's AFUE.
    await page.click("#energyRunBtn");
    await page.waitForTimeout(1500);
    const eff = await page.evaluate(() => Array.from(document.querySelectorAll("#energyResults .eq-row"))
      .filter(r => /Efficiency/.test(r.innerText)).map(r => r.innerText.replace(/\n/g, " ")).join(" | "));
    ok("a heat-pump job is rated on SEER2 and HSPF2, not AFUE", /HSPF2/.test(eff) && !/AFUE/.test(eff), eff);

    // And the printed report has to carry the job, or the sizes travel alone.
    await page.click("#reportBtn");
    await page.waitForTimeout(900);
    const rpt = await page.evaluate(() => document.querySelector("#reportRoot")?.innerText || "");
    ok("the printed report states the job", /Job:\s*Mini-split/i.test(rpt), (rpt.match(/Job:.*/) || [""])[0]);
    ok("...and says duct losses were not applied", /ductless — no duct losses applied/i.test(rpt));
    ok("...and marks the sizing family on the printed table", /this job/i.test(rpt));
    await page.click("#rpCloseBtn");
    await page.waitForTimeout(300);

    /*
     * The results page re-renders whenever anything else finishes, and the
     * current-system fields are rebuilt from state each time. They used to be
     * read only when the button was pressed, so a rep could type the
     * customer's unit in, have a background job land, and watch the entries
     * vanish. Changing the job type forces exactly that re-render.
     */
    await page.selectOption("#eqExTons", "4");
    await page.fill("#eqExYear", "2008");
    await page.fill("#eqExSeer", "11");
    await page.click("#jobChangeBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.click('.job-row[data-job="hp-variable"]');
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(() => ({
      tons: document.querySelector("#eqExTons")?.value,
      year: document.querySelector("#eqExYear")?.value,
      seer: document.querySelector("#eqExSeer")?.value
    }));
    ok("what the rep typed about the current system survives a re-render",
      kept.tons === "4" && kept.year === "2008" && kept.seer === "11", JSON.stringify(kept));

    // Same bug, worse consequence: a measured attic R-value typed but not yet
    // applied used to vanish, leaving a load computed from the code-era guess
    // on a page that looked finished.
    await page.click("#adjustDetails summary");
    await page.waitForTimeout(200);
    await page.fill("#inArea", "2750");
    await page.fill("#inAtticR", "19");
    await page.click("#jobChangeBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.click('.job-row[data-job="ac-furnace-96"]');
    await page.waitForTimeout(1500);
    const tuned = await page.evaluate(() => ({
      open: !!document.querySelector("#adjustDetails")?.open,
      area: document.querySelector("#inArea")?.value,
      atticR: document.querySelector("#inAtticR")?.value
    }));
    ok("fine-tune values typed but not yet applied survive a re-render",
      tuned.area === "2750" && tuned.atticR === "19", JSON.stringify(tuned));
    ok("...and the panel stays open rather than collapsing on them", tuned.open === true);
    await ctx.close();
  }

  // ---------- The job type steers the incentive search ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 2200 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => {
      localStorage.setItem("lmp_user", JSON.stringify(p));
      localStorage.setItem("lmp_settings_v1", JSON.stringify({ aiProvider: "anthropic", aiApiKey: "sk-ant-test" }));
    }, PAID);
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    let sent = null;
    await page.route("**api.anthropic.com/**", async route => {
      sent = route.request().postData() || "";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ programs: [], homeownerSummary: "none", confidence: "low" }) }]
      }) });
    });
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await page.click("#jobMoreBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.fill("#jobCustomIn", "aeroseal the whole house");
    await page.click('.job-row[data-job="duct-seal"]');
    await page.waitForTimeout(400);
    await runCalc(page);
    await page.click("#rebateBtn");
    await page.waitForTimeout(2500);

    ok("the incentive search is told the exact job", /Duct sealing/i.test(sent || ""), (sent || "").slice(0, 0) + "sent");
    ok("...and the program phrases that job actually uses", /duct sealing rebate/i.test(sent || ""));
    ok("...including niche ones a generic query would miss", /Aeroseal/i.test(sent || ""));
    ok("the contractor's own words are passed through", /aeroseal the whole house/i.test(sent || ""));
    ok("it is told to return programs for THIS measure", /Only return programs that cover the job above/i.test(sent || ""));
    ok("a duct job does not ask for generic HVAC rebates alone", !/Program names and phrases to search for: HVAC rebate$/im.test(sent || ""));

    // Programs are measure-specific, so the card must name the measure they
    // were found for — and say so loudly if the job has changed since.
    const rbText = await page.evaluate(() => document.querySelector("#rebateCard")?.innerText || "");
    ok("the results name the measure the programs were found for", /Programs for\s*Duct sealing/i.test(rbText), rbText.slice(0, 120));
    ok("...including the contractor's own note", /aeroseal the whole house/i.test(rbText));

    await page.click("#jobChangeBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.click('.job-row[data-job="hp-variable"]');
    await page.waitForTimeout(1500);
    const staleText = await page.evaluate(() => document.querySelector(".rb-job.stale")?.innerText || "");
    ok("changing the job warns that the programs on screen are the old job's",
      /Duct sealing/i.test(staleText) && /Search again/i.test(staleText), staleText);

    // A duct-only job installs nothing, so the efficiency tiers are a
    // yardstick and must not read as options being quoted.
    await page.click("#jobChangeBtn");
    await page.waitForSelector(".job-sheet", { timeout: 5000 });
    await page.click('.job-row[data-job="duct-replace"]');
    await page.waitForTimeout(1500);
    await page.click("#energyRunBtn");
    await page.waitForTimeout(1500);
    ok("a job that installs no equipment says the tiers are a yardstick",
      /yardstick/i.test(await page.evaluate(() => document.querySelector("#energyResults")?.innerText || "")));
    await ctx.close();
  }

  // ---------- No quoting tool, and the ServiceTitan hand-off ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 2400 }, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    await ctx.addInitScript(p => localStorage.setItem("lmp_user", JSON.stringify(p)), PAID);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);

    const body = await page.evaluate(() => document.body.innerText);
    ok("the proposal builder is gone", !/net monthly|10-yr cost to own|Installed price|Build proposal/i.test(body));
    ok("no financing inputs remain", await page.$("#sqApr") === null && await page.$("#sqMonths") === null);
    ok("no installed-price inputs remain", await page.$("#sqPrice0") === null);
    ok("the price book is gone from Settings", await (async () => {
      await page.click("#openSettings");
      await page.waitForSelector("#aiProvider", { timeout: 5000 });
      const gone = await page.$("#pbAddBtn") === null;
      const hook = await page.$("#setWebhook") !== null;
      await page.click("#closeSettings");
      return gone && hook;
    })());

    ok("the running-cost and right-size analysis is kept", /running cost|right-size/i.test(body));
    ok("it says pricing belongs in the quoting software", /quoting software/i.test(body));

    // Export
    ok("an export card is offered", await page.$("#exportCard") !== null);
    ok("there is a ServiceTitan paste button", await page.$("#exCopyText") !== null);
    ok("there is a JSON copy and a download", await page.$("#exCopyJson") !== null && await page.$("#exDownload") !== null);
    await page.click("#exCopyText");
    await page.waitForTimeout(500);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    ok("the copied summary carries the loads", /Heating:/.test(clip) && /Cooling:/.test(clip), clip.split("\n")[0]);
    ok("...the job type", /Job: /.test(clip));
    ok("...the tonnage options", /Single-stage:/.test(clip));
    ok("...and a disclaimer", /licensed professional/.test(clip));

    // The prose is expected to NAME the App Key — that is how the rep learns
    // why no native integration is offered. What must not exist anywhere is a
    // FIELD that asks for one, which is the tunneling pattern ServiceTitan
    // prohibits. So check the inputs, not the words.
    await page.click("#openSettings");           // Settings is where such a field would plausibly live
    await page.waitForSelector("#aiProvider", { timeout: 5000 });
    const credFields = await page.evaluate(() => {
      const bad = /app\s*key|client\s*secret|client\s*id|tenant\s*id/i;
      return Array.from(document.querySelectorAll("input, textarea, select")).filter(el =>
        bad.test(el.placeholder || "") || bad.test(el.name || "") || bad.test(el.id || "") ||
        bad.test((el.labels && el.labels[0] && el.labels[0].innerText) || "") ||
        bad.test(el.getAttribute("aria-label") || "")
      ).map(el => el.id || el.name || el.placeholder);
    });
    await page.click("#closeSettings");
    ok("no field anywhere asks for a ServiceTitan credential", credFields.length === 0, credFields.join(", "));
    ok("the reason is explained rather than silently omitted",
      /prohibited/i.test(body) && /App Key/i.test(await page.evaluate(() => document.querySelector("#exportCard")?.innerText || "")));
    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ job type + export checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
