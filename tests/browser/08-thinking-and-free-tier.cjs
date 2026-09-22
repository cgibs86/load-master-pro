/*
 * The thinking overlay on every waiting action, and the Free plan's
 * one-calculation ceiling.
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

async function runCalc(page, addr) {
  await page.fill("#address", addr || "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
}

(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });

  // ---------- 1. Overlay during the calculation ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1800 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => localStorage.setItem("lmp_user", JSON.stringify(p)), PAID);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });

    ok("overlay exists but starts hidden", await page.evaluate(() => {
      const t = document.querySelector(".thinking");
      return !t || !t.classList.contains("on");
    }));

    await runCalc(page);
    // Catch it mid-flight: the overlay must be up while the work runs.
    await page.waitForSelector(".thinking.on", { timeout: 15000 });
    const mid = await page.evaluate(() => ({
      msg: document.querySelector("#thinkingMsg")?.textContent || "",
      locked: document.body.classList.contains("thinking-open"),
      live: document.querySelector(".thinking")?.getAttribute("aria-live")
    }));
    ok("overlay shows a real step, not a generic spinner", /address|climate|Calculat/i.test(mid.msg), mid.msg);
    ok("background scroll is locked while it runs", mid.locked);
    ok("it is announced to screen readers", mid.live === "polite");

    await page.waitForSelector("#reportBtn", { timeout: 40000 });
    // Wait on the class, not on visibility: a dismissed overlay is
    // `visibility: hidden`, so waitForSelector's default "visible" state can
    // never be satisfied and only passed before by catching the fade mid-transition.
    await page.waitForFunction(() => !document.querySelector(".thinking.on"), null, { timeout: 8000 });
    ok("overlay comes down when the calculation finishes", true);
    ok("scroll lock is released", !(await page.evaluate(() => document.body.classList.contains("thinking-open"))));
    await page.waitForTimeout(2200);

    // ---------- 2. Overlay on the other actions ----------
    for (const [name, open, label] of [
      ["Recalculate", async () => {
        const isOpen = await page.evaluate(() => !!document.querySelector("#adjustDetails")?.open);
        if (!isOpen) await page.click("#adjustDetails summary");
        await page.waitForSelector("#recalcBtn", { state: "visible" });
        await page.click("#recalcBtn");
      }, /Recalculating/i],
      ["Generate report", async () => { await page.click("#reportBtn"); }, /report/i],
    ]) {
      const seen = { hit: false, msg: "" };
      const poll = setInterval(async () => {
        try {
          const m = await page.evaluate(() => document.querySelector(".thinking.on") ? (document.querySelector("#thinkingMsg")?.textContent || "") : null);
          if (m !== null && !seen.hit) { seen.hit = true; seen.msg = m; }
        } catch (e) {}
      }, 30);
      await open();
      await page.waitForTimeout(700);
      clearInterval(poll);
      ok(`${name} shows the overlay`, seen.hit, seen.msg);
      ok(`${name} labels what it is doing`, label.test(seen.msg), seen.msg);
    }
    const closeRep = await page.$("#rpCloseBtn"); if (closeRep) await closeRep.click();
    await page.waitForTimeout(300);
    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- 3. Landing CTA shows the overlay before navigating ----------
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      // Freeze navigation so the pre-navigation state can be observed.
      document.querySelectorAll('a[href$="app.html"]').forEach(a => a.addEventListener("click", e => e.preventDefault()));
    });
    await page.click('a[href$="app.html"]');
    await page.waitForTimeout(250);
    ok("a landing CTA acknowledges the tap before the next page loads", await page.evaluate(() => !!document.querySelector(".thinking.on")));
    ok("...with a label naming where it is going", /calculator/i.test(await page.evaluate(() => document.querySelector("#thinkingMsg")?.textContent || "")));
    await ctx.close();
  }

  // ---------- 4. Free plan: exactly one calculation ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });

    ok("a guest is told the allowance before they spend it", /1.*load calculation left/i.test(await page.evaluate(() => document.querySelector("#freeNote")?.textContent || "")),
      await page.evaluate(() => document.querySelector("#freeNote")?.textContent || ""));

    await runCalc(page);
    await page.waitForSelector("#reportBtn", { timeout: 40000 });
    await page.waitForTimeout(2200);
    ok("the first calculation completes normally", await page.$("#reportBtn") !== null);
    ok("the counter is spent", await page.evaluate(() => localStorage.getItem("lmp_free_calcs_v1")) === "1");
    ok("the note now reads zero left", /no calculations left/i.test(await page.evaluate(() => document.querySelector("#freeNote")?.textContent || "")));

    // Second attempt is refused.
    await page.fill("#address", "1600 Pennsylvania Ave NW, Washington, DC");
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector("#suggest")?.classList.remove("open"));
    await page.click("#calcBtn");
    await page.waitForTimeout(900);
    const limit = await page.evaluate(() => document.querySelector(".limit-card")?.innerText || "");
    ok("a second calculation is refused with an upgrade prompt", /used your free load calculation/i.test(limit), limit.split("\n")[0]);
    ok("...and offers a way to sign up", await page.$('.limit-card a[href*="auth.html"]') !== null);
    ok("...and a way to see plans", await page.$('.limit-card a[href*="pricing"]') !== null);
    ok("the earlier result is not destroyed", await page.$("#reportBtn") !== null);
    ok("no overlay is left stuck up", !(await page.evaluate(() => !!document.querySelector(".thinking.on"))));
    ok("no runtime errors", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
    await ctx.close();
  }

  // ---------- 5. A paid plan is not limited ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" });
    await ctx.addInitScript(p => {
      localStorage.setItem("lmp_user", JSON.stringify(p));
      localStorage.setItem("lmp_free_calcs_v1", "9");   // as if the device had used free calcs before upgrading
    }, PAID);
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.route("**archive-api.open-meteo.com/**", relay);
    await page.route("**epqs.nationalmap.gov/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    ok("a paid plan shows no allowance note", (await page.evaluate(() => document.querySelector("#freeNote")?.textContent || "")).trim() === "");
    await runCalc(page);
    await page.waitForSelector("#reportBtn", { timeout: 40000 });
    ok("a paid plan calculates even with a spent free counter", await page.$(".limit-card") === null);
    await ctx.close();
  }

  // ---------- 6. Expired trial falls back to Free, not to a paid tier ----------
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 1600 }, serviceWorkers: "block" });
    await ctx.addInitScript(() => {
      localStorage.setItem("lmp_user", JSON.stringify({ email: "x@x.com", name: "X", plan: "trial", created: Date.now() - 30 * 86400000 }));
      localStorage.setItem("lmp_free_calcs_v1", "1");
    });
    const page = await ctx.newPage();
    await page.route("**nominatim.openstreetmap.org/**", relay);
    await page.goto(`${BASE}/app.html`, { waitUntil: "load" });
    await page.fill("#address", "2100 Westheimer Rd, Houston, TX");
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.querySelector("#suggest")?.classList.remove("open"));
    await page.click("#calcBtn");
    await page.waitForTimeout(800);
    ok("an expired trial is held to the Free ceiling", await page.$(".limit-card") !== null);
    await ctx.close();
  }

  // ---------- 7. Pricing page ----------
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
    const prices = await page.$$eval("#pricing .price", els => els.map(e => e.textContent.trim()));
    ok("four tiers are offered", prices.length === 4, prices.join(" | "));
    ok("Free is $0", /^\$0/.test(prices[0]), prices[0]);
    ok("Solo is $199/mo", /\$199/.test(prices[1]), prices[1]);
    ok("Pro is $499/mo", /\$499/.test(prices[2]), prices[2]);
    ok("the top tier is quote-only", /contact/i.test(prices[3]), prices[3]);
    ok("the Free tier links to a free signup", await page.$('#pricing a[href*="plan=free"]') !== null);
    ok("the top tier links to a quote request", await page.$('#pricing a[href^="mailto:"]') !== null);
    ok("pricing does not overflow at desktop width", await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    await ctx.close();
  }

  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ thinking + free tier checks passed");
  await b.close();
  process.exit(fails ? 1 : 0);
})();
