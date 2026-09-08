/*
 * PhotoScan schema / sanitize checks — hermetic, no network.
 * Run: node tests/photo-ai.test.js
 */
require("../ai-providers.js");
require("../photo-ai.js");
const PA = globalThis.PhotoAI;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}

console.log("\n=== sanitize(): existing-equipment nameplate fields ===");
{
  const out = PA._sanitize({
    summary: "x",
    findings: [
      { field: "existingTons", value: "3", confidence: "high", note: "model 24ABB336 -> 036" },
      { field: "existingTons", value: 9, confidence: "high", note: "out of range" },
      { field: "existingYear", value: 2008, confidence: "medium", note: "serial 3308E12345" },
      { field: "existingYear", value: 1950, confidence: "high", note: "too old" },
      { field: "existingSeer", value: 13, confidence: "high", note: "EnergyGuide label" },
      { field: "existingHeat", value: "hp", confidence: "high", note: "reversing valve visible" },
      { field: "existingHeat", value: "boiler", confidence: "high", note: "not in enum" },
      { field: "bogusField", value: 1, confidence: "high", note: "dropped" },
      { field: "other", value: null, confidence: "low", note: "window AC in bedroom" }
    ]
  });
  const f = (name, i) => out.findings.filter(x => x.field === name)[i || 0];
  ok("a numeric string tonnage coerces to a number (Gemini returns strings)", f("existingTons").value === 3);
  ok("out-of-range tonnage is kept for display but demoted to low confidence", f("existingTons", 1).value === null && f("existingTons", 1).confidence === "low");
  ok("tonnage snaps to the half-ton", PA._sanitize({ findings: [{ field: "existingTons", value: 3.3, confidence: "high", note: "" }] }).findings[0].value === 3.5);
  ok("valid year passes through", f("existingYear").value === 2008 && f("existingYear").confidence === "medium");
  ok("implausible year is demoted", f("existingYear", 1).value === null && f("existingYear", 1).confidence === "low");
  ok("SEER passes through", f("existingSeer").value === 13);
  ok("heating type enum enforced", f("existingHeat").value === "hp" && f("existingHeat", 1).value === null);
  ok("unknown field names are dropped", !out.findings.some(x => x.field === "bogusField"));
  ok("'other' findings survive with null value", f("other") && f("other").value === null);
}

console.log("\n=== schema + prompt mention the new fields ===");
{
  ok("schema enum lists the four nameplate fields", ["existingTons", "existingYear", "existingSeer", "existingHeat"].every(k => PA._SCHEMA.properties.findings.items.properties.field.enum.includes(k)));
  const prompt = PA._buildPrompt({ area: 2000, quality: "average", sun: "average", foundation: "slab", ceiling: 9, bedrooms: 3 });
  ok("prompt explains the model-number capacity code", /018\/024\/030\/036/.test(prompt));
  ok("prompt forbids guessing SEER from brand or age", /Never estimate it from the brand or age/.test(prompt));
}

console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
process.exit(failed ? 1 : 0);
