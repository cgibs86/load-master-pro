/*
 * Job export checks — hermetic, injected fetch.
 * Run: node tests/job-export.test.js
 */
const JE = require("../job-export.js");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}

const CTX = {
  geo: { label: "2100 Westheimer Rd, Houston, TX 77098", city: "Houston", state: "TX", postcode: "77098" },
  climate: { cooling1: 96, heating99: 30, outGrains: 133, elevFt: 50, climateZone: 2, source: "live" },
  effective: { area: 2400, bedrooms: 4, yearBuilt: 1998 },
  jobType: { id: "hp-variable", label: "Heat pump — variable / inverter" },
  jobCustom: "two systems, upstairs first",
  result: {
    heating: { total: 40000 }, cooling: { total: 42000, sensible: 33000, latent: 9000 },
    recommendedTons: 3.5, sizing: { single: 3.5, two: 3.5, variable: 3 },
    equipment: { airflowCfm: 1400, furnaceOutput: 76000 },
    heatpump: { balanceF: 31, auxKw: 4.2 }
  },
  energy: { existing: { tons: 4, year: 2008, energy: { totalCost: 1763 }, rightSize: { pct: 136, verdict: "oversized" } } },
  rebates: { totals: { capped: 3200 }, programs: [
    { name: "25C Credit", administrator: "IRS", typeLabel: "Federal tax credit", amountMax: 2000, amountText: "30% up to $2,000", incomeQualified: false, applyUrl: "https://irs.gov/form", source: "https://irs.gov/c" },
    { name: "Weatherization", administrator: "State", typeLabel: "Income-qualified program", amountMax: 8000, amountText: "full replacement", incomeQualified: true, applyUrl: "https://s.test/w", source: "https://s.test/w" }
  ] },
  rooms: { rooms: [{ name: "Bonus", area: 460, cooling: 12764, heating: 12977, requiredCfm: 430, actualCfm: 100 }] }
};

console.log("\n=== The structured payload an automation maps by hand ===");
{
  const j = JE.toJson(CTX);
  ok("a version is stamped so a consumer can branch on it", j.schema === JE.SCHEMA_VERSION);
  ok("field names are flat and explicit, not nested blobs", j.cooling_btuh === 42000 && j.heating_btuh === 40000);
  ok("the job type travels with the numbers", j.job_type === "Heat pump — variable / inverter" && j.job_type_id === "hp-variable");
  ok("the contractor's own note travels too", j.job_notes === "two systems, upstairs first");
  ok("every tonnage option is carried, not just the headline", j.tons_single_stage === 3.5 && j.tons_variable_capacity === 3);
  ok("airflow and furnace output are carried", j.required_airflow_cfm === 1400 && j.furnace_output_btuh === 76000);
  ok("the balance point and backup are carried", j.heat_pump_balance_point_f === 31 && j.backup_heat_kw === 4.2);
  ok("design conditions are carried", j.design_summer_f === 96 && j.design_winter_f === 30 && j.climate_zone === 2);
  ok("the address is carried", /Westheimer/.test(j.address) && j.state === "TX");
  ok("the existing system is carried", j.existing_tons === 4 && j.existing_pct_of_load === 136);
  ok("incentives are carried with their apply links", j.incentive_programs.length === 2 && /irs.gov\/form/.test(j.incentive_programs[0].apply_url));
  ok("the incentive total is carried", j.incentive_total_usd === 3200);
  ok("room airflow is carried", j.rooms[0].required_cfm === 430);
  ok("a disclaimer rides along so the number is never quoted bare", /licensed professional/.test(j.disclaimer));
  ok("it is JSON-serialisable", typeof JSON.stringify(j) === "string");

  const bare = JE.toJson({ result: { heating: { total: 1 }, cooling: { total: 2 }, sizing: {}, equipment: {}, heatpump: {} } });
  ok("a minimal context still produces a payload", bare && bare.heating_btuh === 1);
  ok("missing optional sections are simply absent", bare.incentive_programs === undefined && bare.rooms === undefined);
  ok("no result returns null rather than an empty shell", JE.toJson({}) === null && JE.toJson(null) === null);
}

console.log("\n=== The pasteable version ===");
{
  const t = JE.toText(CTX);
  ok("it is plain text, not markdown or HTML", !/[<>]|\*\*/.test(t));
  ok("the address leads", t.indexOf("2100 Westheimer") < 120);
  ok("the job type is stated", /Job: Heat pump/.test(t));
  ok("the loads are there", /Heating:\s+40,000 BTU\/h/.test(t) && /Cooling:\s+42,000 BTU\/h/.test(t));
  ok("numbers are thousands-separated for reading aloud", /40,000/.test(t));
  ok("every tonnage option is listed", /Single-stage:\s+3\.5 ton/.test(t) && /Variable:\s+3 ton/.test(t));
  ok("the existing system is summarised", /136% of calculated load \(oversized\)/.test(t));
  ok("incentives include their apply URLs", /apply: https:\/\/irs\.gov\/form/.test(t));
  ok("income-qualified money is marked as such", /\[income-qualified\]/.test(t));
  ok("room airflow is listed", /Bonus: 430 CFM needed, 100 now/.test(t));
  ok("it ends with the disclaimer", /licensed professional/.test(t.split("\n").pop()));
  ok("no result yields an empty string, not a broken note", JE.toText({}) === "");
}

console.log("\n=== Webhook: the shop's own automation, never ServiceTitan credentials ===");
{
  let seen = null;
  const okFetch = (url, init) => { seen = { url, init }; return Promise.resolve({ ok: true, status: 200 }); };

  JE.sendWebhook("https://hooks.zapier.test/x", CTX, okFetch).then(res => {
    ok("a good webhook resolves ok", res.ok === true);
    ok("it POSTs", seen.init.method === "POST");
    ok("it sends JSON", seen.init.headers["Content-Type"] === "application/json");
    ok("the body is the structured payload", JSON.parse(seen.init.body).cooling_btuh === 42000);

    return JE.sendWebhook("http://insecure.test/x", CTX, okFetch)
      .then(() => ok("a plain-http URL is refused", false, "it resolved"),
            e => ok("a plain-http URL is refused", /https:\/\//.test(e.message)));
  }).then(() => {
    return JE.sendWebhook("not a url", CTX, okFetch)
      .then(() => ok("junk is refused", false), e => ok("junk is refused", /https/.test(e.message)));
  }).then(() => {
    return JE.sendWebhook("https://x.test", {}, okFetch)
      .then(() => ok("sending with no calculation is refused", false), e => ok("sending with no calculation is refused", /load calculation/.test(e.message)));
  }).then(() => {
    const bad = () => Promise.resolve({ ok: false, status: 404 });
    return JE.sendWebhook("https://x.test", CTX, bad)
      .then(() => ok("a 404 is surfaced", false), e => ok("a non-OK reply is surfaced with its status", /404/.test(e.message)));
  }).then(() => {
    const dead = () => Promise.reject(new Error("network"));
    return JE.sendWebhook("https://x.test", CTX, dead)
      .then(() => ok("an unreachable webhook is surfaced", false),
            e => ok("an unreachable webhook explains CORS rather than failing blankly", /CORS/.test(e.message), e.message));
  }).then(() => {
    // The module must never ask for or carry ServiceTitan credentials, which
    // would be the prohibited tunneling pattern.
    const src = require("fs").readFileSync(__dirname + "/../job-export.js", "utf8");
    ok("no ServiceTitan client secret, app key or tenant field exists anywhere",
      !/clientSecret|client_secret|appKey|app_key|tenantId|tenant_id/i.test(src));
    ok("the file records why credentials are refused", /tunneling/i.test(src) && /prohibit/i.test(src));

    const fn = JE.fileName(CTX);
    ok("the download filename is safe and dated", /^loadmaster-[a-z0-9-]*-\d{4}-\d{2}-\d{2}\.json$/.test(fn), fn);
    ok("a missing address still yields a valid filename", /^loadmaster-/.test(JE.fileName({})));

    console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
    process.exit(failed ? 1 : 0);
  });
}
