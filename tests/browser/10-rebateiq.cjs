/*
 * RebateIQ: live incentive research, the apply links, the homeowner summary,
 * feeding the proposal, the printed appendix, and the Pro gate.
 *
 * The AI provider is mocked so the probe is deterministic and costs nothing.
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

const PAYLOAD = {
  address: { city: "Houston", county: "Harris", state: "TX", zip: "77098" },
  utilities: { electric: "CenterPoint Energy", gas: "CenterPoint Energy" },
  programs: [
    { name: "25C Energy Efficient Home Improvement Credit", administrator: "IRS", type: "federal-tax-credit",
      amountMax: 2000, amountText: "30% of project cost, up to $2,000",
      requirements: "ENERGY STAR heat pump, 16 SEER2 / 8.5 HSPF2 minimum", eligibility: "Homeowners, primary residence",
      incomeQualified: false, stackable: true, deadline: "2032-12-31", status: "open",
      howToApply: "Claim on IRS Form 5695 with your tax return",
      applyUrl: "https://www.irs.gov/forms-pubs/about-form-5695", source: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit" },
    { name: "Residential Heat Pump Rebate", administrator: "CenterPoint Energy", type: "utility-rebate",
      amountMax: 1200, amountText: "Up to $1,200 based on tonnage and SEER2",
      requirements: "16 SEER2 or better, installed by a participating contractor", eligibility: "Residential electric customers",
      incomeQualified: false, stackable: true, deadline: "2026-11-30", status: "open, funds remaining",
      howToApply: "Contractor submits within 60 days of installation",
      applyUrl: "https://example-utility.test/rebates/apply", source: "https://example-utility.test/rebates" },
    { name: "Weatherization Assistance Program", administrator: "Texas Dept. of Housing", type: "income-qualified",
      amountMax: 8000, amountText: "Full system replacement for qualifying households",
      requirements: "Whole-home assessment required", eligibility: "Household income at or below 200% of federal poverty level",
      incomeQualified: true, stackable: false, deadline: null, status: "waitlist",
      howToApply: "Apply through your local community action agency",
      applyUrl: "https://example-state.test/wap/apply", source: "https://example-state.test/wap" },
    { name: "Fabricated program with no source", administrator: "Nobody", type: "grant", amountMax: 50000,
      amountText: "Free money", applyUrl: "javascript:alert(1)", source: null }
  ],
  totalEstimateText: "About $3,200 before income-qualified programs",
  homeownerSummary: "You most likely qualify for about $3,200 between the federal tax credit and your utility's heat pump rebate. The federal credit comes back at tax time; the utility rebate we file for you after installation.",
  confidence: "medium"
};

function providerBody(payload) {
  return {
    stop_reason: "end_turn",
    content: [
      { type: "web_search_tool_result", content: [
        { type: "web_search_result", url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit", title: "IRS 25C" },
        { type: "web_search_result", url: "https://example-utility.test/rebates", title: "Utility rebates" }
      ] },
      { type: "text", text: "Here is what I found:\n```json\n" + JSON.stringify(payload) + "\n```" }
    ]
  };
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

  // ---------- Pro user: the whole flow ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 2200 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => {
      localStorage.setItem("lmp_user", JSON.stringify(p));
      localStorage.setItem("lmp_settings_v1", JSON.stringify({ aiProvider: "anthropic", aiApiKey: "sk-ant-test" }));
    }, PAID);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);

    let aiCall = null;
    await page.route("**api.anthropic.com/**", async (route) => {
      aiCall = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(providerBody(PAYLOAD)) });
    });

    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);

    ok("RebateIQ card renders for a Pro user", await page.$("#rebateCard") !== null);
    ok("it explains itself before it is run", /Searches the live web/.test(await page.evaluate(() => document.querySelector("#rebateCard")?.innerText || "")));

    await page.click("#rebateBtn");
    await page.waitForSelector(".rb-total", { timeout: 20000 });
    await page.waitForTimeout(500);

    // What was actually asked of the provider
    ok("web search was requested, not a plain completion", JSON.stringify(aiCall).includes("web_search"));
    const sent = JSON.stringify(aiCall);
    ok("the address was sent", sent.includes("Westheimer"));
    ok("the proposed system was sent so the list is relevant", /SEER2/.test(sent));
    ok("the model was told never to invent a program", sent.includes("NEVER invent"));

    const card = await page.evaluate(() => document.querySelector("#rebateCard")?.innerText || "");
    ok("the headline total excludes income-qualified money", /\$3,200/.test(card), (card.match(/\$[\d,]+/) || [])[0]);
    ok("the homeowner summary is shown to read aloud", /Read this to the homeowner/i.test(card));
    ok("the serving utility is named", /CenterPoint/.test(card));
    ok("the federal credit is listed", /25C/.test(card));
    ok("the utility rebate is listed", /Residential Heat Pump Rebate/.test(card));
    ok("the income-qualified program is listed but flagged", /Weatherization/.test(card) && /income-qualified/i.test(card));
    ok("the extra income-qualified money is stated separately", /further \$8,000/.test(card), (card.match(/further \$[\d,]+/) || [])[0]);

    // Links
    const links = await page.$$eval("#rebateCard .rb-apply", as => as.map(a => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel })));
    ok("every listed program has an apply link", links.length === 3, `${links.length} links`);
    ok("apply links are real http(s) URLs", links.every(l => /^https?:\/\//.test(l.href)), links.map(l => l.href).join(" "));
    ok("apply links open in a new tab, safely", links.every(l => l.target === "_blank" && /noopener/.test(l.rel)));
    ok("the sourceless fabricated program never reached the page", !/Fabricated program/.test(card));
    ok("its javascript: link never reached the DOM", !(await page.evaluate(() => document.body.innerHTML.includes("javascript:alert"))));

    // Feed the proposal
    const before = await page.$eval("#sqRebate2", el => el.value).catch(() => null);
    await page.click("#rebateUseBtn");
    await page.waitForTimeout(900);
    const after = await page.$eval("#sqRebate2", el => el.value).catch(() => null);
    ok("the total can be applied to the proposal", after === "3200", `${before} -> ${after}`);
    ok("...to the Best option only, not silently to all three",
      (await page.$eval("#sqRebate0", el => el.value)) === "" && (await page.$eval("#sqRebate1", el => el.value)) === "");

    // Printed appendix
    await page.click("#reportBtn");
    await page.waitForTimeout(1000);
    const rep = await page.evaluate(() => document.querySelector("#reportRoot")?.textContent || "");
    ok("the report carries the rebate appendix", rep.includes("Grants, credits & rebates"));
    ok("the appendix lists apply URLs the homeowner can type in", rep.includes("irs.gov"));
    ok("the appendix states the total", /Estimated total before income-qualified/.test(rep));
    ok("the appendix is dated and disclaimed", /Researched from public sources on/.test(rep) && /not tax advice/i.test(rep));
    await page.click("#rpCloseBtn");
    await page.waitForTimeout(300);

    // Results must not be saved with the job — programs expire.
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lmp_history_v1"))[0]);
    ok("rebate results are not persisted into the saved job", JSON.stringify(saved).indexOf("Weatherization") === -1);

    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- Failure is reported, not swallowed ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1800 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => {
      localStorage.setItem("lmp_user", JSON.stringify(p));
      localStorage.setItem("lmp_settings_v1", JSON.stringify({ aiProvider: "anthropic", aiApiKey: "bad-key" }));
    }, PAID);
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.route("**api.anthropic.com/**", route => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);
    await page.click("#rebateBtn");
    await page.waitForSelector(".rb-error", { timeout: 20000 });
    ok("a rejected key is shown in the card, not swallowed", /rejected/i.test(await page.evaluate(() => document.querySelector(".rb-error")?.textContent || "")));
    ok("the button is usable again after a failure", await page.$eval("#rebateBtn", el => !el.disabled));
    ok("no overlay is left stuck up", !(await page.evaluate(() => !!document.querySelector(".thinking.on"))));
    await ctx.close();
  }

  // ---------- No key, and the Pro gate ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1800 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => localStorage.setItem("lmp_user", JSON.stringify(p)), PAID);
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(page);
    await page.click("#rebateBtn");
    await page.waitForTimeout(700);
    ok("with no API key it opens Settings rather than failing silently", await page.$("#aiProvider") !== null);
    await ctx.close();

    const ctx2 = await b.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" });
    const p2 = await ctx2.newPage();
    await p2.route("**nominatim.openstreetmap.org/**", relay);
    await p2.route("**archive-api.open-meteo.com/**", relay);
    await p2.route("**epqs.nationalmap.gov/**", relay);
    await p2.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await runCalc(p2);
    const locked = await p2.evaluate(() => Array.from(document.querySelectorAll(".permit-card.locked")).map(e => e.innerText.slice(0, 30)));
    ok("a guest sees the locked RebateIQ teaser", locked.some(t => /RebateIQ/.test(t)), locked.join(" | "));
    await ctx2.close();
  }

  // ---------- Advertised on the landing page ----------
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    const text = await page.evaluate(() => document.body.innerText);
    ok("RebateIQ has a feature block on the landing page", /RebateIQ/.test(text));
    ok("it is listed in the Pro plan", await page.evaluate(() => {
      const pro = Array.from(document.querySelectorAll("#pricing .plan")).find(p => /Pro/.test(p.querySelector("h3")?.textContent || ""));
      return !!pro && /RebateIQ/.test(pro.innerText);
    }));
    ok("the landing page still has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    await ctx.close();
  }

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ RebateIQ checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
