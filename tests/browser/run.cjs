/*
 * Live-browser regression audit. Starts the static server, runs every probe
 * in this directory in order, and fails if any probe fails.
 *
 *   npm run audit:browser
 *
 * Needs network access: the probes geocode real addresses (Nominatim) and
 * fetch a year of hourly weather (Open-Meteo) exactly as the app does.
 * Chromium comes from Playwright (PLAYWRIGHT_BROWSERS_PATH honoured).
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || "8099";
const root = path.join(__dirname, "..", "..");
const server = spawn(process.execPath, [path.join(root, "serve.cjs")], { env: Object.assign({}, process.env, { PORT }), stdio: "ignore" });

function waitForServer(tries) {
  return fetch("http://localhost:" + PORT + "/app.html").then(r => { if (!r.ok) throw new Error(); })
    .catch(() => { if (tries <= 0) throw new Error("server did not start"); return new Promise(res => setTimeout(res, 300)).then(() => waitForServer(tries - 1)); });
}

(async () => {
  await waitForServer(30);
  const probes = fs.readdirSync(__dirname).filter(f => /^\d\d-.*\.cjs$/.test(f)).sort();
  let failed = 0;
  for (const p of probes) {
    console.log("\n######## " + p + " ########");
    const r = spawnSync(process.execPath, [path.join(__dirname, p)], { stdio: "inherit", env: Object.assign({}, process.env, { LMP_BASE: "http://localhost:" + PORT }) });
    if (r.status !== 0) failed++;
  }
  server.kill();
  console.log("\n" + (failed ? "❌ " + failed + " probe(s) failed" : "✅ all " + probes.length + " browser probes passed"));
  process.exit(failed ? 1 : 0);
})().catch(e => { server.kill(); console.error(e); process.exit(1); });
