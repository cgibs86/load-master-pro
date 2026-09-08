/*
 * RoomIQ room-by-room distribution checks — hermetic, no network.
 * Run: node tests/room-loads.test.js
 */
const LC = require("../loadcalc.js");
const RL = require("../room-loads.js");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}
function near(label, actual, expected, tol) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected} ±${tol}`);
}

const HOUSE_OPTS = { area: 2400, bedrooms: 4, stories: 2, ceiling: 9, heating99: 20, cooling1: 95, outGrains: 120, elevFt: 200, systemType: "single" };
const house = LC.compute(HOUSE_OPTS);
const CTX = { house, area: 2400, ceiling: 9, windowFrac: 0.15, cooling1: 95, heating99: 20, indoorCool: 75, indoorHeat: 70, quality: LC.QUALITY.average };

// A full-coverage room list (sums to the house area) so reconciliation can be
// checked exactly, without the partial-coverage scaling in the way.
const FULL = [
  { name: "Living", area: 500, type: "living", exteriorWalls: 2, orientation: "s", supplies: 3 },
  { name: "Kitchen", area: 300, type: "kitchen", exteriorWalls: 1, orientation: "e", supplies: 2 },
  { name: "Primary", area: 340, type: "primary", exteriorWalls: 2, orientation: "n", topFloor: true, supplies: 2 },
  { name: "Bed 2", area: 200, type: "bedroom", exteriorWalls: 1, orientation: "e", topFloor: true, supplies: 1 },
  { name: "Bed 3", area: 200, type: "bedroom", exteriorWalls: 2, orientation: "w", topFloor: true, supplies: 1 },
  { name: "Bonus", area: 460, type: "bonus", exteriorWalls: 3, orientation: "w", topFloor: true, overUnconditioned: true, supplies: 1 },
  { name: "Bath", area: 100, type: "bath", exteriorWalls: 1, orientation: "n", topFloor: true, supplies: 1 },
  { name: "Office", area: 200, type: "office", exteriorWalls: 1, orientation: "s", supplies: 1 },
  { name: "Halls", area: 100, type: "other", exteriorWalls: 0, orientation: "unknown", supplies: 0 }
];

console.log("\n=== Reconciliation to the whole-house load ===");
{
  const r = RL.distribute({ ...CTX, rooms: FULL });
  near("room cooling sums to the house cooling load", r.totals.cooling, house.cooling.total, 12);
  near("room heating sums to the house heating load", r.totals.heating, house.heating.total, 12);
  const latent = r.rooms.reduce((a, x) => a + x.latent, 0);
  ok("room latent never exceeds the house latent", latent <= house.cooling.latent + 12, `${latent} vs ${house.cooling.latent}`);
  ok("every room's sensible + latent equals its total", r.rooms.every(x => Math.abs(x.sensible + x.latent - x.cooling) <= 1));
  ok("no room has a negative or zero cooling load", r.rooms.every(x => x.cooling > 0));
  ok("no room has a negative heating load", r.rooms.every(x => x.heating >= 0));
  // An interior room has no envelope, so zero envelope heat loss is correct,
  // not a broken number — but it must be labelled so it doesn't read as one.
  const hall = r.rooms.find(x => x.name === "Halls");
  ok("a fully interior room reports no envelope heat loss", hall.heating === 0 && hall.exteriorWalls === 0);
  ok("...and explains why, so the zero doesn't look like a bug", hall.flags.some(f => f.code === "interior"));
  ok("...but still carries a cooling load from people and appliances", hall.cooling > 0);
  near("required airflow sums to the equipment airflow at full coverage", r.totals.requiredCfm, house.equipment.airflowCfm, 40);
  ok("coverage reports 100% when the rooms fill the house", r.totals.coveragePct === 100, `${r.totals.coveragePct}%`);
}

console.log("\n=== Room physics drive the share ===");
{
  function one(extra) {
    const rooms = [{ name: "A", area: 200, type: "bedroom", exteriorWalls: 1, orientation: "n", ...extra }, { name: "B", area: 200, type: "bedroom", exteriorWalls: 1, orientation: "n" }];
    return RL.distribute({ ...CTX, rooms }).rooms[0];
  }
  const baseline = one({});
  ok("a west room outgains an identical north room", one({ orientation: "w" }).cooling > baseline.cooling);
  ok("a corner room outgains an identical single-exposure room", one({ exteriorWalls: 2 }).cooling > baseline.cooling);
  ok("a top-floor room outgains the same room with conditioned space above", one({ topFloor: true }).cooling > baseline.cooling);
  ok("a room over unconditioned space loses more heat in winter", one({ overUnconditioned: true }).heating > baseline.heating);
  ok("more glass means more load", one({ windowArea: 80 }).cooling > one({ windowArea: 10 }).cooling);
  const interior = RL.distribute({ ...CTX, rooms: [{ name: "Interior", area: 200, type: "other", exteriorWalls: 0 }, { name: "Exterior", area: 200, type: "other", exteriorWalls: 2 }] });
  ok("an interior room with no exposed wall is assigned no glass", interior.rooms[0].windowArea === 0);
  ok("an interior room still carries load from people and appliances", interior.rooms[0].cooling > 0);
  ok("an exterior room carries more than an interior one", interior.rooms[1].cooling > interior.rooms[0].cooling);
  const kitchen = RL.distribute({ ...CTX, rooms: [{ name: "K", area: 200, type: "kitchen", exteriorWalls: 1 }, { name: "B", area: 200, type: "bedroom", exteriorWalls: 1 }] });
  ok("a kitchen outgains a same-sized bedroom", kitchen.rooms[0].cooling > kitchen.rooms[1].cooling);
}

console.log("\n=== Airflow and diagnosis ===");
{
  const r = RL.distribute({ ...CTX, rooms: FULL });
  const bonus = r.rooms.find(x => x.name === "Bonus");
  ok("the hard room (west, top floor, over garage, one register) is flagged starved", bonus.flags.some(f => f.code === "starved"), bonus.flags.map(f => f.code).join(","));
  ok("it is told how many supplies it actually needs", bonus.suppliesSuggested > bonus.supplies, `${bonus.suppliesSuggested} vs ${bonus.supplies}`);
  ok("it carries the sandwich flag (unconditioned above and below)", bonus.flags.some(f => f.code === "sandwich"));
  ok("west glass is called out", bonus.flags.some(f => f.code === "westglass"));
  ok("the diagnosis names the worst room first", r.diagnosis[0].startsWith("Bonus"), r.diagnosis[0].slice(0, 40));
  ok("the diagnosis says airflow, not tonnage, is the fix", /no amount of extra tonnage/.test(r.diagnosis[0]));

  const bath = r.rooms.find(x => x.name === "Bath");
  ok("a small wet room is not called a comfort hotspot", !bath.flags.some(f => f.code === "hotspot"), bath.flags.map(f => f.code).join(","));

  // With no register counts entered, there is nothing to diagnose but the app must say so.
  const noReg = RL.distribute({ ...CTX, rooms: FULL.map(({ supplies, ...rest }) => rest) });
  ok("with no register counts, every room reports required airflow", noReg.rooms.every(x => x.requiredCfm > 0));
  ok("...and none is falsely flagged starved", !noReg.rooms.some(x => x.flags.some(f => f.code === "starved" || f.code === "short")));
  ok("...and the diagnosis asks for the register counts", /supply register count/.test(noReg.diagnosis[0]));

  // An explicit measured CFM beats the register-count estimate.
  const measured = RL.distribute({ ...CTX, rooms: [{ name: "M", area: 300, type: "bedroom", exteriorWalls: 2, supplies: 2, supplyCfm: 45 }, { name: "N", area: 300, type: "bedroom", exteriorWalls: 1 }] });
  ok("a measured CFM reading overrides the register-count estimate", measured.rooms[0].actualCfm === 45);
  ok("a measured shortfall is flagged", measured.rooms[0].flags.some(f => f.code === "starved" || f.code === "short"));
}

console.log("\n=== Partial coverage and edge cases ===");
{
  const half = RL.distribute({ ...CTX, rooms: [{ name: "Only room", area: 1200, type: "living", exteriorWalls: 2, supplies: 4 }] });
  ok("partial coverage is reported", half.totals.coveragePct === 50, `${half.totals.coveragePct}%`);
  ok("airflow is scaled to the entered portion, not the whole house", half.totals.requiredCfm < house.equipment.airflowCfm, `${half.totals.requiredCfm} vs ${house.equipment.airflowCfm}`);
  ok("partial coverage is disclosed in the diagnosis", half.diagnosis.some(l => /cover about 50%/.test(l)));

  ok("no rooms returns null rather than throwing", RL.distribute({ ...CTX, rooms: [] }) === null);
  ok("no house result returns null", RL.distribute({ ...CTX, rooms: FULL, house: null }) === null);
  ok("rooms with no area are dropped", RL.distribute({ ...CTX, rooms: [{ name: "X", area: 0 }, { name: "Y", area: 200, type: "bedroom" }] }).rooms.length === 1);
  ok("a non-numeric area is dropped, not turned into NaN", RL.distribute({ ...CTX, rooms: [{ name: "X", area: "abc" }, { name: "Y", area: 200 }] }).rooms.length === 1);
  const junk = RL.distribute({ ...CTX, rooms: [{ name: "J", area: 200, type: "nonsense", orientation: "sideways", exteriorWalls: 99 }] });
  ok("an unknown room type falls back to a sane default", junk.rooms[0].typeLabel === "Other");
  ok("an unknown orientation falls back", junk.rooms[0].orientationLabel === "Not specified");
  ok("exterior walls are clamped to four", junk.rooms[0].exteriorWalls === 4);
  ok("no NaN reaches any output field", junk.rooms.every(x => [x.cooling, x.heating, x.sensible, x.latent, x.requiredCfm, x.btuPerSqFt].every(v => typeof v === "number" && isFinite(v))));

  // A huge single room and a tiny one must both stay finite and ordered.
  const extremes = RL.distribute({ ...CTX, rooms: [{ name: "Great room", area: 2000, type: "living", exteriorWalls: 3, orientation: "w" }, { name: "Closet", area: 20, type: "other", exteriorWalls: 0 }] });
  ok("a 2,000 ft² great room outloads a 20 ft² closet", extremes.rooms[0].cooling > extremes.rooms[1].cooling * 10);
  ok("every room gets at least one suggested supply", extremes.rooms.every(x => x.suppliesSuggested >= 1));
}

console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
process.exit(failed ? 1 : 0);
