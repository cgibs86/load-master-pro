/*
 * OpCost energy engine checks — hermetic, no network.
 * Run: node tests/energy-engine.test.js
 */
const E = require("../energy-engine.js");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}
function near(label, actual, expected, tol) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected} ±${tol}`);
}

console.log("\n=== Utility rates ===");
{
  const ca = E.ratesForState("California"), ca2 = E.ratesForState("ca"), xx = E.ratesForState("Narnia"), none = E.ratesForState(null);
  ok("full state name resolves", ca.state === "CA" && ca.kwh > 0.2);
  ok("two-letter code (any case) resolves to the same row", ca2.kwh === ca.kwh && ca2.therm === ca.therm);
  ok("unknown state falls back to the national average and says so", xx.national === true && xx.state === null && xx.kwh > 0);
  ok("null input doesn't throw", none.national === true);
  ok("every state row has a positive kWh and therm price", Object.keys(E.STATE_RATES).every(k => E.STATE_RATES[k][0] > 5 && E.STATE_RATES[k][1] > 0.5));
  ok("all 50 states + DC present", Object.keys(E.STATE_RATES).length === 51, String(Object.keys(E.STATE_RATES).length));
}

console.log("\n=== Synthetic bins (station-table fallback) ===");
{
  const bins = E.syntheticBins(-2, 92);
  const total = Object.values(bins).reduce((a, b) => a + b, 0);
  near("covers a full 8,760-hour year", total, 8760, 1);
  const edges = Object.keys(bins).map(Number);
  ok("coldest bin is near the winter design temp", Math.min(...edges) <= 0 && Math.min(...edges) >= -15, `min edge ${Math.min(...edges)}`);
  ok("hottest bin is near the summer design temp", Math.max(...edges) >= 85 && Math.max(...edges) <= 100, `max edge ${Math.max(...edges)}`);
  const mild = E.syntheticBins(40, 82);
  ok("a mild climate has no sub-20°F hours", Object.keys(mild).map(Number).every(e => e >= 20));
}

console.log("\n=== Equipment performance curves ===");
{
  near("EER at 82°F equals SEER2 by construction", E.eerAt(16, 82), 16, 0.01);
  ok("EER falls as it gets hotter", E.eerAt(16, 95) < E.eerAt(16, 82) && E.eerAt(16, 105) < E.eerAt(16, 95));
  near("14.3 SEER2 lands near its ~12 EER2 rating at 95°F", E.eerAt(14.3, 95), 12.1, 0.5);
  ok("EER is clamped for very hot bins (never negative or absurd)", E.eerAt(16, 130) >= 4 && E.eerAt(16, 130) === E.eerAt(16, 115));

  const std47 = E.hpAt(8.5, 47, "single", 3), std17 = E.hpAt(8.5, 17, "single", 3);
  const cc17 = E.hpAt(8.5, 17, "variable", 3);
  near("standard HP keeps ~60% capacity at 17°F", std17.capBtu / std47.capBtu, 0.60, 0.01);
  near("cold-climate (variable) HP keeps ~82% capacity at 17°F", cc17.capBtu / std47.capBtu, 0.82, 0.01);
  ok("COP falls with temperature", std17.cop < std47.cop);
  ok("cold-climate COP holds up better at 17°F than standard", cc17.cop > std17.cop);
  ok("defrost penalty only in the frost band", E.hpAt(8.5, 35, "single", 3).defrost > 1 && E.hpAt(8.5, 55, "single", 3).defrost === 1 && E.hpAt(8.5, 10, "single", 3).defrost === 1);
  ok("COP never drops below 1 (resistance floor)", E.hpAt(6, -30, "single", 3).cop >= 1);
}

console.log("\n=== Bin-method annual energy ===");
{
  const bins = E.syntheticBins(-2, 92);
  const rates = { kwh: 0.15, therm: 1.20 };
  const base = { bins, coolingBtu: 30000, cooling1: 92, heatingBtu: 60000, heating99: -2, rates };
  const ac10 = E.annualEnergy({ ...base, system: { coolType: "ac", seer2: 10, tons: 2.5, heatType: "furnace", afue: 0.80, systemType: "single" } });
  const ac16 = E.annualEnergy({ ...base, system: { coolType: "ac", seer2: 16, tons: 2.5, heatType: "furnace", afue: 0.80, systemType: "single" } });
  ok("higher SEER2 uses less cooling energy", ac16.cooling.kwh < ac10.cooling.kwh);
  near("cooling kWh scale inversely with SEER2", ac10.cooling.kwh / ac16.cooling.kwh, 1.6, 0.02);
  ok("same furnace -> identical heating result", ac10.heating.therms === ac16.heating.therms);

  const f96 = E.annualEnergy({ ...base, system: { coolType: "ac", seer2: 16, tons: 2.5, heatType: "furnace", afue: 0.96, systemType: "single" } });
  near("96 vs 80 AFUE saves 1/6 of the gas", f96.heating.therms / ac16.heating.therms, 0.80 / 0.96, 0.01);

  const hp = E.annualEnergy({ ...base, system: { coolType: "hp", seer2: 16, tons: 2.5, heatType: "hp", hspf2: 8.5, systemType: "single" } });
  ok("a cooling-sized heat pump in a -2°F climate needs backup strips", hp.heating.auxKwh > 0 && hp.heating.hpShareOfHeat < 100, `aux ${hp.heating.auxKwh} kWh, hp share ${hp.heating.hpShareOfHeat}%`);
  ok("heat pump path burns no gas", hp.heating.therms === 0);

  const df = E.annualEnergy({ ...base, system: { coolType: "hp", seer2: 16, tons: 2.5, heatType: "dualfuel", hspf2: 8.5, afue: 0.96, systemType: "single" } });
  ok("dual fuel never runs strips", df.heating.auxKwh === 0);
  ok("dual fuel reports a switchover temperature", typeof df.heating.switchoverF === "number" && df.heating.switchoverF > -30 && df.heating.switchoverF < 65, String(df.heating.switchoverF));
  ok("dual fuel uses less gas than furnace-only", df.heating.therms < f96.heating.therms);
  ok("dual fuel costs less than strip-backed HP in a cold climate", df.totalCost < hp.totalCost, `${df.totalCost} vs ${hp.totalCost}`);

  const res = E.annualEnergy({ ...base, system: { coolType: "ac", seer2: 16, tons: 2.5, heatType: "resistance", systemType: "single" } });
  near("resistance heat is 3,412 BTU/kWh exactly", res.heating.kwh * 3412 / res.heating.btu, 1, 0.001);

  const none = E.annualEnergy({ ...base, system: { coolType: "none", heatType: "none" } });
  ok("no equipment -> zero energy, no throw", none.totalCost === 0 && none.cooling.kwh === 0);
  const hot = E.annualEnergy({ ...base, bins: E.syntheticBins(37, 108), cooling1: 108, heating99: 37, coolingBtu: 40000, heatingBtu: 28000, system: { coolType: "ac", seer2: 14.3, tons: 3.5, heatType: "furnace", afue: 0.8, systemType: "single" } });
  ok("hot climate: cooling dominates, ~1,900-3,000 kWh/ton is the realistic range", hot.cooling.kwh / 3.5 > 1900 && hot.cooling.kwh / 3.5 < 3000, `${Math.round(hot.cooling.kwh / 3.5)} kWh/ton`);
  ok("rates flow through to cost", ac16.cooling.cost === Math.round(ac16.cooling.kwh * 0.15));
}

console.log("\n=== Existing-system estimation ===");
{
  ok("SEER by install year is monotonic and covers minimums", E.seerFromYear(1985) === 8 && E.seerFromYear(2000) === 10 && E.seerFromYear(2010) === 13 && E.seerFromYear(2020) === 14 && E.seerFromYear(2024) === 15);
  ok("unknown year gets a middle-of-the-road SEER", E.seerFromYear(null) === 10);
  near("SEER -> SEER2 conversion", E.seerToSeer2(16), 15.3, 0.05);
  near("HSPF -> HSPF2 conversion", E.hspfToHspf2(10), 8.5, 0.05);
  ok("age derate is 1 for a new unit and floors at 0.80", E.ageDerate(2026, 2026) === 1 && E.ageDerate(1980, 2026) === 0.80);
  near("age derate 0.6%/yr", E.ageDerate(2016, 2026), 0.94, 0.001);
  const rs = E.rightSize(4, 2.6, "single");
  ok("4-ton on a 2.6-ton load is flagged grossly oversized", rs.verdict === "grossly oversized" && rs.pct === 154);
  ok("3-ton on a 2.6-ton load is right-sized (115% ceiling)", E.rightSize(3, 2.6, "single").verdict === "right-sized");
  ok("3-ton on a 2.3-ton load is oversized under single-stage rules", E.rightSize(3, 2.3, "single").verdict === "oversized");
  ok("...but inside the variable-capacity 130% ceiling", E.rightSize(3, 2.3, "variable").verdict === "right-sized");
  ok("2-ton on a 2.6-ton load is undersized", E.rightSize(2, 2.6, "single").verdict === "undersized");
  ok("missing inputs return null, not a throw", E.rightSize(0, 2.6, "single") === null && E.rightSize(3, null, "single") === null);
}

console.log("\n=== Financing ===");
{
  near("$12,000 at 9.99% over 120 months", E.monthlyPayment(12000, 9.99, 120), 158.51, 0.05);
  near("0% APR is straight division", E.monthlyPayment(12000, 0, 120), 100, 0.001);
  ok("zero principal -> zero payment", E.monthlyPayment(0, 9.99, 120) === 0);
  ok("bad term is clamped rather than dividing by zero", isFinite(E.monthlyPayment(1000, 5, 0)));
}

console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
process.exit(failed ? 1 : 0);
