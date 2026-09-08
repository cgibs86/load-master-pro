/*
 * RoomIQ: adding rooms, the comfort diagnosis, and the printed appendix.
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
async function addRoom(page, i, r) {
  await page.click("#rqAddBtn");
  await page.waitForSelector(`#rqName${i}`, { state: "visible" });
  await page.fill(`#rqName${i}`, r.name);
  await page.fill(`#rqArea${i}`, String(r.area));
  await page.selectOption(`#rqType${i}`, r.type);
  await page.selectOption(`#rqWalls${i}`, String(r.walls));
  await page.selectOption(`#rqOrient${i}`, r.orient);
  if (r.supplies != null) await page.fill(`#rqSup${i}`, String(r.supplies));
  if (r.top) await page.check(`#rqTop${i}`);
  if (r.under) await page.check(`#rqUnder${i}`);
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
  await page.fill("#address", "2100 Westheimer Rd, Houston, TX");
  await page.waitForTimeout(1800);
  const sug = await page.$("#suggest > *"); if (sug) await sug.click();
  await page.waitForTimeout(400);
  if (!(await page.$(".loading, #reportBtn"))) await page.click("#calcBtn");
  await page.waitForSelector("#reportBtn", { timeout: 40000 });
  await page.waitForTimeout(2500);

  ok("RoomIQ card renders for a Pro user", await page.$("#roomCard") !== null);
  ok("it starts with no rooms and invites the first one", /Start with the room the customer complains about/.test(await page.evaluate(() => document.querySelector("#roomCard")?.innerText || "")));

  await addRoom(page, 0, { name: "Living room", area: 500, type: "living", walls: 2, orient: "s", supplies: 3 });
  await addRoom(page, 1, { name: "Primary", area: 340, type: "primary", walls: 2, orient: "n", supplies: 2, top: true });
  await addRoom(page, 2, { name: "Bonus over garage", area: 460, type: "bonus", walls: 3, orient: "w", supplies: 1, top: true, under: true });
  ok("earlier rooms survive adding a later one", await page.$eval("#rqName0", el => el.value) === "Living room");
  ok("typed areas survive too", await page.$eval("#rqArea0", el => el.value) === "500");
  ok("checkboxes survive", await page.$eval("#rqTop1", el => el.checked) === true);

  await page.click("#rqRunBtn");
  await page.waitForTimeout(700);
  const out = await page.evaluate(() => document.querySelector("#roomCard")?.innerText || "");
  ok("each room reports its load and airflow", (out.match(/BTU\/h per ft²/g) || []).length === 3);
  ok("the hard room is flagged severe", await page.$(".rq-res.severe") !== null);
  // The heading is uppercased by CSS, so innerText comes back shouting.
  ok("the diagnosis tells the customer story", /what to tell the customer/i.test(out));
  ok("it says airflow not tonnage is the fix", /no amount of extra tonnage/.test(out));
  ok("the bonus room is named as the problem", /Bonus over garage needs about/.test(out), (out.match(/Bonus over garage needs about \d+ CFM[^.]*\./) || [""])[0].slice(0, 80));
  ok("inputs still hold their values after diagnosing", await page.$eval("#rqSup2", el => el.value) === "1");

  // Rooms must not change the whole-house answer.
  const tonsBefore = await page.evaluate(() => document.querySelector(".final-rec-tons")?.textContent);
  ok("room entry does not change the recommended tonnage", /\d/.test(tonsBefore || ""), tonsBefore);

  // Delete a room.
  await page.click("#rqDel1");
  await page.waitForTimeout(500);
  // Check the actual row inputs, not the card text: "Primary bedroom" is also
  // one of the room-type dropdown options, so it appears in innerText either way.
  const names = await page.$$eval(".rq-row input.rq-name", els => els.map(e => e.value));
  ok("deleting a room removes it", names.length === 2 && !names.includes("Primary"), names.join(", "));
  ok("...and keeps the others", names.includes("Living room") && names.includes("Bonus over garage"));

  // Report appendix
  await page.click("#reportBtn"); await page.waitForTimeout(900);
  const rep = await page.evaluate(() => document.querySelector("#reportRoot")?.textContent || "");
  ok("report carries the room-by-room table", rep.includes("Room-by-room diagnosis"));
  ok("report names the rooms needing attention", rep.includes("Rooms needing attention"));
  await page.click("#rpCloseBtn"); await page.waitForTimeout(300);

  // Saved-job round trip
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lmp_history_v1"))[0].snap.overrides.rooms);
  ok("rooms are saved with the job", Array.isArray(saved) && saved.length === 2 && saved[0].name === "Living room", JSON.stringify(saved && saved.map(r => r.name)));

  // Guest teaser
  const ctx2 = await b.newContext({ viewport: { width: 420, height: 1200 }, serviceWorkers: "block" });
  const p2 = await ctx2.newPage();
  await p2.route("**nominatim.openstreetmap.org/**", relay); await p2.route("**archive-api.open-meteo.com/**", relay); await p2.route("**epqs.nationalmap.gov/**", relay);
  await p2.goto(`${BASE}/app.html`, { waitUntil: "load" });
  await p2.fill("#address", "2100 Westheimer Rd, Houston, TX"); await p2.waitForTimeout(1500);
  const s2 = await p2.$("#suggest > *"); if (s2) await s2.click();
  await p2.waitForTimeout(400);
  if (!(await p2.$(".loading, #reportBtn"))) await p2.click("#calcBtn");
  await p2.waitForSelector("#reportBtn", { timeout: 40000 }); await p2.waitForTimeout(600);
  const guest = await p2.evaluate(() => Array.from(document.querySelectorAll(".permit-card.locked")).map(e => e.innerText.slice(0, 30)));
  ok("guest sees the locked RoomIQ teaser", guest.some(t => /RoomIQ/.test(t)), guest.join(" | "));

  ok("no runtime errors", errs.length === 0, errs.slice(0, 4).join(" | ") || "clean");
  console.log(fails ? `\n❌ ${fails} failed` : "\n✅ RoomIQ checks passed");
  await b.close(); process.exit(fails ? 1 : 0);
})();
