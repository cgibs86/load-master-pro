/*
 * TrueClimate engine tests — psychrometrics, design-condition extraction, and
 * the elevation cross-check. Fully hermetic: every case uses synthetic hourly
 * series or an injected fetch, so the suite never touches the network.
 *
 * Run with: node tests/climate-engine.test.js
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CE = require(path.join(ROOT, "climate-engine.js"));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? " (" + detail + ")" : ""}`);
}
function near(label, actual, expected, tol) {
  const good = Math.abs(actual - expected) <= tol;
  good ? pass++ : fail++;
  console.log(`   ${good ? "✅" : "❌"} ${label}: ${actual} (expected ${expected} ±${tol})`);
}

console.log("=== Psychrometrics: grainsFromDewpoint ===");
// Reference humidity ratios at sea level, standard psychrometric chart values.
near("50°F dew point ≈ 53 gr/lb", CE.grainsFromDewpoint(50, 0), 53, 2);
near("70°F dew point ≈ 110 gr/lb", CE.grainsFromDewpoint(70, 0), 110, 3);
near("75°F dew point ≈ 132 gr/lb", CE.grainsFromDewpoint(75, 0), 132, 3);
ok(
  "grains rise monotonically with dew point",
  [40, 50, 60, 70, 80].every((dp, i, a) => i === 0 || CE.grainsFromDewpoint(dp, 0) > CE.grainsFromDewpoint(a[i - 1], 0)),
  "40→80°F strictly increasing"
);
// Thinner air at altitude holds more moisture per pound of dry air at the same
// dew point, so the humidity ratio must rise with elevation.
ok(
  "same dew point yields more grains/lb at altitude (air-density correction)",
  CE.grainsFromDewpoint(70, 5280) > CE.grainsFromDewpoint(70, 0),
  `sea level ${CE.grainsFromDewpoint(70, 0)} → 5,280 ft ${CE.grainsFromDewpoint(70, 5280)}`
);

console.log("\n=== percentile() ===");
const series = Array.from({ length: 101 }, (_, i) => i); // 0..100
near("P1 of 0..100", CE.percentile(series, 0.01), 1, 1);
near("P50 of 0..100", CE.percentile(series, 0.5), 50, 1);
near("P99 of 0..100", CE.percentile(series, 0.99), 99, 1);
ok("percentile does not mutate its input", (() => {
  const a = [5, 3, 1, 4, 2];
  CE.percentile(a, 0.5);
  return a.join(",") === "5,3,1,4,2";
})(), "original order preserved");

console.log("\n=== analyze(): design-condition extraction ===");
// Build a deterministic year: temperature ramps 30°F → 100°F across 8,760 hours.
function syntheticYear(dewForTemp) {
  const temps = [], dews = [];
  for (let i = 0; i < 8760; i++) {
    const t = 30 + (70 * i) / 8759;
    temps.push(t);
    dews.push(dewForTemp(t));
  }
  return { temps, dews };
}
{
  const { temps, dews } = syntheticYear(() => 55);
  const r = CE.analyze(temps, dews, 0);
  ok("returns a result for a full year of valid data", !!r, r ? `${r.hours} hours` : "null");
  near("heating99 tracks the 1st-percentile temperature", r.heating99, 31, 2);
  near("cooling1 tracks the 99th-percentile temperature", r.cooling1, 99, 2);
  near("outGrains matches a constant 55°F dew point", r.outGrains, CE.grainsFromDewpoint(55, 0), 2);
}
{
  const short = { temps: new Array(1000).fill(70), dews: new Array(1000).fill(50) };
  ok("rejects a series with too few hours", CE.analyze(short.temps, short.dews, 0) === null, "1,000 hours < 4,000 minimum");
}
{
  // Physically impossible temperatures must be refused rather than silently
  // used to size equipment.
  const { temps, dews } = syntheticYear(() => 55);
  const insane = temps.map((t) => t + 60); // pushes cooling1 well past 120°F
  ok("rejects implausible design temperatures", CE.analyze(insane, dews, 0) === null, "cooling1 > 120°F clamp");
}

console.log("\n=== REGRESSION: design humidity must not be sampled at the temperature peak ===");
/*
 * The defect this guards: outGrains was taken as the median dew point during
 * the hottest 1% of hours. Real hot-humid climates are DRIER at peak dry-bulb
 * than during the broader warm season, so that method understated moisture
 * badly (Houston read 98 gr/lb against a published 130).
 *
 * This synthetic climate reproduces that structure deliberately: the very
 * hottest hours are dry (dew point 50°F) while the rest of the warm season is
 * muggy (dew point 76°F). A method that samples only the temperature peak
 * reports ~53 gr/lb; one that characterizes the warm season reports ~135.
 */
{
  const temps = [], dews = [];
  for (let i = 0; i < 8760; i++) {
    const t = 30 + (70 * i) / 8759;
    temps.push(t);
    dews.push(t >= 97 ? 50 : 76);   // hottest ~3% of hours are dry, warm season is humid
  }
  const r = CE.analyze(temps, dews, 0);
  const peakOnly = CE.grainsFromDewpoint(50, 0);   // what the old method would report
  const warmSeason = CE.grainsFromDewpoint(76, 0); // the physically correct answer
  ok(
    "design humidity reflects the humid warm season, not the dry temperature peak",
    Math.abs(r.outGrains - warmSeason) <= 3,
    `got ${r.outGrains} gr/lb; warm-season truth ${warmSeason}, peak-only (old, wrong) ${peakOnly}`
  );
  ok(
    "and is therefore far above what peak-hour sampling would return",
    r.outGrains > peakOnly + 50,
    `${r.outGrains} vs ${peakOnly}`
  );
}

console.log("\n=== fetchLive(): USGS elevation cross-check (injected fetch, no network) ===");
function fakeArchive(elevationMeters) {
  const temps = [], dews = [];
  for (let i = 0; i < 8760; i++) { temps.push(30 + (70 * i) / 8759); dews.push(55); }
  return { elevation: elevationMeters, hourly: { temperature_2m: temps, dew_point_2m: dews } };
}
async function runFetch(usgsResponder) {
  return CE.fetchLive(34, -118, function (url) {
    if (String(url).indexOf("archive-api.open-meteo.com") !== -1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fakeArchive(100)) });
    }
    return usgsResponder();
  });
}
(async () => {
  const withUsgs = await runFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ value: 1234.5 }) }));
  near("USGS elevation overrides the coarser Open-Meteo DEM", withUsgs.elevFt, 1235, 1);

  const usgsDown = await runFetch(() => Promise.resolve({ ok: false, status: 500 }));
  near("falls back to Open-Meteo elevation when USGS errors", usgsDown.elevFt, 328, 2);

  const outOfCoverage = await runFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ value: -1000000 }) }));
  near("ignores the USGS out-of-coverage sentinel (non-US points)", outOfCoverage.elevFt, 328, 2);

  const usgsThrew = await runFetch(() => Promise.reject(new Error("network down")));
  near("a thrown USGS request never breaks the climate fetch", usgsThrew.elevFt, 328, 2);

  const archiveDown = await CE.fetchLive(34, -118, () => Promise.resolve({ ok: false, status: 503 }));
  ok("returns null when the climate archive itself fails", archiveDown === null, "caller falls back to the station table");

  console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + fail + " CHECK(S) FAILED"} (${pass} passed)`);
  process.exit(fail ? 1 : 0);
})();
