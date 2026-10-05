/*
 * Job type checks — hermetic.
 * Run: node tests/job-types.test.js
 */
const JT = require("../job-types.js");

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}

console.log("\n=== The catalogue covers the jobs a shop actually sells ===");
{
  const ids = JT.all().map(t => t.id);
  ok("every id is unique", new Set(ids).size === ids.length);
  ok("every type has a label, a short label and a blurb", JT.all().every(t => t.label && t.short && t.blurb));
  ok("every type names at least one real rebate term", JT.all().every(t => Array.isArray(t.rebateTerms) && t.rebateTerms.length >= 1));
  ok("every type belongs to a declared category", JT.all().every(t => JT.CATEGORIES.some(c => c.id === t.category)));
  ok("every category has at least one type", JT.byCategory().every(c => c.types.length > 0));
  ok("the default type exists", !!JT.get(JT.DEFAULT_ID));

  // The specific jobs the request named, by name.
  const want = {
    "mini split": "minisplit-single",
    "split system with a gas furnace": "ac-furnace-80",
    "96% efficient gas furnace": "ac-furnace-96",
    "standard furnace": "furnace-only-80",
    "heat pump": "hp-standard",
    "duct replacement only": "duct-replace"
  };
  Object.keys(want).forEach(k => ok(`"${k}" exists as a type`, !!JT.get(want[k]), want[k]));

  ok("heat pumps are broken out by kind, not lumped together",
    ["hp-standard", "hp-two-stage", "hp-variable", "hp-cold-climate", "dual-fuel", "geothermal"].every(id => JT.get(id)));
  ok("ductwork is its own category with several jobs", JT.byCategory().find(c => c.id === "ducts").types.length >= 3);
  ok("measures with their own rebate programs are present",
    ["hpwh", "thermostat", "insulation", "windows", "electrical"].every(id => JT.get(id)));
  ok("unknown ids return null rather than throwing", JT.get("nope") === null && JT.get(null) === null);
}

console.log("\n=== A job type changes the load calculation, not just the label ===");
{
  const ductless = JT.calcHints("minisplit-single");
  ok("a ductless job turns off duct losses", ductless.ductType === "ductless");
  ok("...and selects the variable-capacity sizing family", ductless.systemType === "variable");

  const ducted = JT.calcHints("ac-furnace-96");
  ok("a ducted job does not force ductless", ducted.ductType === undefined);
  // A furnace's AFUE says nothing about how the condenser stages, so these
  // jobs must claim no stage family rather than silently moving the Manual S
  // ceiling on what is also the default job.
  ok("a 96% furnace job claims no stage family, because it implies none", ducted.systemType === undefined);
  ok("neither does a furnace-only job", JT.calcHints("furnace-only-96").systemType === undefined);
  ok("nor dual fuel, which is sold in every stage family", JT.calcHints("dual-fuel").systemType === undefined);
  ok("nor new construction, where the spec decides", JT.calcHints("new-construction").systemType === undefined);
  ok("the default job therefore does not move the sizing on its own",
    JT.calcHints(JT.DEFAULT_ID).systemType === undefined);
  ok("a standard split maps to single-stage sizing", JT.calcHints("ac-furnace-80").systemType === "single");
  ok("an inverter heat pump maps to variable sizing", JT.calcHints("hp-variable").systemType === "variable");
  ok("a two-stage heat pump maps to two-stage sizing", JT.calcHints("hp-two-stage").systemType === "two");

  // A ducted mini-split really does have ducts; the flag must not follow the category.
  ok("a ducted mini-split keeps its duct losses", JT.calcHints("minisplit-ducted").ductType === undefined);

  ok("a duct-only job implies no equipment stage", JT.calcHints("duct-replace").systemType === undefined);
  ok("an unknown id yields no hints rather than throwing", JSON.stringify(JT.calcHints("nope")) === "{}");
}

console.log("\n=== Which jobs size equipment, and which just need the load ===");
{
  ok("a system replacement sizes both sides", JT.get("hp-standard").cooling && JT.get("hp-standard").heating);
  ok("a furnace-only job has no cooling side to size", JT.get("furnace-only-96").cooling === false);
  ok("an A/C-only job has no heating side to size", JT.get("ac-only").heating === false);
  ok("duct work sizes neither, but still needs the load", JT.get("duct-seal").cooling === false && JT.get("duct-seal").heating === false && JT.get("duct-seal").needsLoad === true);
  ok("a thermostat needs no load at all", JT.get("thermostat").needsLoad === false);
  ok("a water heater needs no load at all", JT.get("hpwh").needsLoad === false);
  ok("a one-room mini-split is flagged as not a whole-house load", JT.get("minisplit-addon").needsLoad === false);
  ok("...and says to size it from the room instead", /RoomIQ/.test(JT.get("minisplit-addon").note || ""));
}

console.log("\n=== Typing finds the right job ===");
{
  const first = q => (JT.search(q)[0] || {}).id;
  ok('"mini split" finds a mini-split', /^minisplit/.test(first("mini split")), first("mini split"));
  ok('"ductless" finds a ductless system', /^minisplit/.test(first("ductless")), first("ductless"));
  ok('"96" finds the 96% furnace', /96/.test(first("96")), first("96"));
  ok('"duct sealing" finds duct sealing', first("duct sealing") === "duct-seal", first("duct sealing"));
  ok('"geothermal" finds geothermal', first("geothermal") === "geothermal", first("geothermal"));
  ok('"dual fuel" finds dual fuel', first("dual fuel") === "dual-fuel", first("dual fuel"));
  ok('"insulation" finds insulation', first("insulation") === "insulation", first("insulation"));
  ok('"thermostat" finds the thermostat', first("thermostat") === "thermostat", first("thermostat"));
  ok('"cold climate" finds the cold-climate heat pump', first("cold climate") === "hp-cold-climate", first("cold climate"));
  // The trap: a longer phrase containing "heat pump" must not land on "heat pump".
  ok('"heat pump water heater" finds the water heater, not the heat pump', first("heat pump water heater") === "hpwh", first("heat pump water heater"));
  ok('"panel upgrade" finds the electrical measure', first("panel upgrade") === "electrical", first("panel upgrade"));
  ok("an empty query returns nothing", JT.search("").length === 0 && JT.search(null).length === 0);
  ok("nonsense returns few or no matches", JT.search("zzzqqq").length === 0, String(JT.search("zzzqqq").length));
  ok("results are capped so the list stays usable", JT.search("heat").length <= 6, String(JT.search("heat").length));
}

console.log("\n=== What gets sent to the incentive search ===");
{
  const duct = JT.rebateQuery("duct-seal");
  ok("a duct job sends duct terms, not generic HVAC terms",
    duct.terms.some(t => /duct sealing/i.test(t)) && !duct.terms.some(t => /^HVAC rebate$/i.test(t)), duct.terms.join(" | "));
  const hp = JT.rebateQuery("hp-cold-climate");
  ok("a cold-climate heat pump sends its own program names",
    hp.terms.some(t => /cold climate/i.test(t)) && hp.terms.some(t => /25C/i.test(t)), hp.terms.join(" | "));
  const mini = JT.rebateQuery("minisplit-single");
  ok("a mini-split sends ductless program names", mini.terms.some(t => /ductless/i.test(t)));
  ok("a water heater sends water-heater programs, not HVAC ones", JT.rebateQuery("hpwh").terms.some(t => /water heater/i.test(t)));
  ok("insulation sends weatherization programs", JT.rebateQuery("insulation").terms.some(t => /weatherization|insulation/i.test(t)));
  ok("a panel upgrade sends electrification programs", JT.rebateQuery("electrical").terms.some(t => /panel/i.test(t)));
  ok("geothermal sends its larger federal credit", JT.rebateQuery("geothermal").terms.some(t => /25D/i.test(t)));

  const custom = JT.rebateQuery("other", "swamp cooler swap with a mini split");
  ok("free text is carried through verbatim", custom.custom === "swamp cooler swap with a mini split");
  ok("an unknown id still produces a usable query", JT.rebateQuery("nope", "whatever").terms.length > 0);
  ok("free text is length-capped", JT.rebateQuery("other", "x".repeat(900)).custom.length === 200);
  ok("the query carries the fuel so the search knows what is being installed", JT.rebateQuery("hp-standard").fuel === "heat-pump");
}

console.log("\n=== Honest notes where money is unlikely ===");
{
  ok("an 80% furnace warns that it misses most thresholds", /below most/i.test(JT.get("furnace-only-80").note || ""));
  ok("electric strip heat is told it unlocks little", /qualifies for almost nothing/i.test(JT.get("ac-airhandler").note || ""));
}

console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
process.exit(failed ? 1 : 0);
