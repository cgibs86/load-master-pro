/*
 * RebateIQ checks — hermetic, no network (fetch is injected).
 * Run: node tests/rebate-iq.test.js
 */
require("../ai-providers.js");
const RQ = require("../rebate-iq.js");
const AP = globalThis.AIProviders;

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`   ✅ ${label}`); }
  else { failed++; console.log(`   ❌ ${label}${detail ? " — " + detail : ""}`); }
}

const GOOD = {
  name: "Heat Pump Rebate", administrator: "Acme Electric", type: "utility-rebate",
  amountMax: 1500, amountText: "$1,500 for a qualifying heat pump",
  requirements: "16 SEER2 / 8.5 HSPF2 minimum", eligibility: "Residential electric customers",
  incomeQualified: false, stackable: true, deadline: "2026-12-31", status: "open",
  howToApply: "Submit the online form within 90 days of install",
  applyUrl: "https://acme-electric.example.com/apply", source: "https://acme-electric.example.com/rebates"
};

console.log("\n=== A dollar figure a homeowner sees must be verifiable ===");
{
  const r = RQ._sanitize({ programs: [
    GOOD,
    { name: "No source program", amountMax: 5000, applyUrl: "https://x.example.com" },   // unverifiable
    { name: "", amountMax: 900, source: "https://y.example.com" },                        // nameless
    { amountMax: 800, source: "https://z.example.com" },                                  // nameless
    "not an object",
    null
  ] });
  ok("a program with a real source is kept", r.programs.length === 1 && r.programs[0].name === "Heat Pump Rebate");
  ok("a program with no source URL is dropped, however big the number", !r.programs.some(p => p.name === "No source program"));
  ok("nameless programs are dropped", !r.programs.some(p => !p.name));
  ok("junk entries are dropped without throwing", r.dropped === 5, String(r.dropped));
  ok("no raw model object survives into the output", r.programs.every(p => typeof p.name === "string" && typeof p.source === "string"));
}

console.log("\n=== Links are clickable and safe ===");
{
  ok("https passes", RQ._safeUrl("https://a.example.com/x") === "https://a.example.com/x");
  ok("http passes", RQ._safeUrl("http://a.example.com") === "http://a.example.com");
  ok("javascript: is refused", RQ._safeUrl("javascript:alert(1)") === null);
  ok("data: is refused", RQ._safeUrl("data:text/html,<script>") === null);
  ok("a bare word is refused", RQ._safeUrl("apply at the office") === null);
  ok("empty/missing is refused", RQ._safeUrl("") === null && RQ._safeUrl(null) === null);

  const r = RQ._sanitize({ programs: [
    Object.assign({}, GOOD, { applyUrl: "javascript:alert(1)" }),
    Object.assign({}, GOOD, { name: "Only source", applyUrl: null, source: "https://only.example.com/p" })
  ] });
  ok("a poisoned apply link falls back to the source instead of shipping the payload",
    r.programs[0].applyUrl === GOOD.source, r.programs[0].applyUrl);
  ok("a missing apply link falls back to the source, so every row is still actionable",
    r.programs.find(p => p.name === "Only source").applyUrl === "https://only.example.com/p");
  ok("every rendered program has an apply link", r.programs.every(p => /^https?:\/\//.test(p.applyUrl)));
}

console.log("\n=== Amounts ===");
{
  const r = RQ._sanitize({ programs: [
    Object.assign({}, GOOD, { name: "A", amountMax: "$2,000" }),
    Object.assign({}, GOOD, { name: "B", amountMax: -50 }),
    Object.assign({}, GOOD, { name: "C", amountMax: 999999 }),
    Object.assign({}, GOOD, { name: "D", amountMax: "lots" })
  ] });
  const by = n => r.programs.find(p => p.name === n);
  ok("a currency-formatted string becomes a number", by("A").amountMax === 2000);
  ok("a negative amount is dropped, not shown", by("B").amountMax === null);
  ok("an absurd amount is dropped", by("C").amountMax === null);
  ok("a non-numeric amount is dropped", by("D").amountMax === null);
  ok("the program still shows when only its amount was unusable", r.programs.length === 4);
}

console.log("\n=== Two totals, because income-qualified money is not typical money ===");
{
  const r = RQ._sanitize({ programs: [
    Object.assign({}, GOOD, { name: "Fed", amountMax: 2000, incomeQualified: false }),
    Object.assign({}, GOOD, { name: "Utility", amountMax: 1500, incomeQualified: false }),
    Object.assign({}, GOOD, { name: "Weatherization", amountMax: 8000, incomeQualified: true }),
    Object.assign({}, GOOD, { name: "Unknown amount", amountMax: null })
  ] });
  ok("the quotable total excludes income-tested programs", r.totals.capped === 3500, String(r.totals.capped));
  ok("the with-income total includes them", r.totals.withIncome === 11500, String(r.totals.withIncome));
  ok("programs with no stated amount are counted separately, not as zero", r.totals.unknownAmountPrograms === 1);
  ok("the program count is reported", r.totals.total === 4);
  ok("income-qualified programs sort last so the rep leads with typical money",
    r.programs[r.programs.length - 1].name === "Weatherization" || r.programs[r.programs.length - 1].name === "Unknown amount");
  ok("the biggest non-income program leads", r.programs[0].name === "Fed", r.programs[0].name);
}

console.log("\n=== Deduping and typing ===");
{
  const r = RQ._sanitize({ programs: [GOOD, Object.assign({}, GOOD)] });
  ok("the same program found twice is listed once", r.programs.length === 1 && r.dropped === 1);
  const t = RQ._sanitize({ programs: [Object.assign({}, GOOD, { type: "nonsense" })] });
  ok("an unknown program type falls back rather than rendering blank", t.programs[0].type === "utility-rebate" && !!t.programs[0].typeLabel);
  const fed = RQ._sanitize({ programs: [Object.assign({}, GOOD, { type: "federal-tax-credit" })] });
  ok("a known type carries a human label", fed.programs[0].typeLabel === "Federal tax credit");
}

console.log("\n=== The prompt asks for what a quote actually needs ===");
{
  const p = RQ._buildUserPrompt({ address: "1 Main St, Austin, TX", city: "Austin", state: "TX", postcode: "78701", systemType: "heat pump", tons: 3, seer2: 16, hspf2: 8.5 });
  ok("the address is sent", /1 Main St, Austin, TX/.test(p));
  ok("the proposed equipment is sent, since most programs set an efficiency floor", /16 SEER2/.test(p) && /8\.5 HSPF2/.test(p));
  ok("a homeowner-facing summary is requested", /homeownerSummary/.test(p));
  ok("the JSON shape is specified", /applyUrl/.test(p) && /amountMax/.test(p));
  const bare = RQ._buildUserPrompt({ city: "Austin" });
  ok("a context with no system still builds a prompt", bare.length > 200 && !/Proposed installation/.test(bare));

  const sp = RQ._SYSTEM_PROMPT;
  ok("the model is told never to invent a program", /NEVER invent/.test(sp));
  ok("...to find the serving utility first", /which electric utility and which gas utility serve/.test(sp));
  ok("...to exclude expired or exhausted programs", /deadline has passed|funding is documented as/.test(sp));
  ok("...to always return an apply link", /applyUrl/.test(sp));
}

console.log("\n=== End to end with an injected provider response ===");
{
  const payload = {
    address: { city: "Austin", state: "TX", zip: "78701" },
    utilities: { electric: "Austin Energy", gas: "Texas Gas Service" },
    programs: [GOOD, Object.assign({}, GOOD, { name: "25C Credit", type: "federal-tax-credit", administrator: "IRS", amountMax: 2000, source: "https://irs.gov/x", applyUrl: "https://irs.gov/form" })],
    homeownerSummary: "You likely qualify for about $3,500 between the federal credit and your utility.",
    confidence: "medium"
  };
  const fakeFetch = (url, init) => {
    fakeFetch.calls.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        stop_reason: "end_turn",
        content: [
          { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://acme-electric.example.com/rebates", title: "Acme rebates" }] },
          { type: "text", text: "Here you go:\n```json\n" + JSON.stringify(payload) + "\n```" }
        ]
      })
    });
  };
  fakeFetch.calls = [];

  RQ.search(
    { address: "1 Main St, Austin, TX", city: "Austin", state: "TX", systemType: "heat pump", seer2: 16 },
    { aiProvider: "anthropic", aiApiKey: "sk-test", aiModel: "claude-opus-5" },
    { fetchImpl: fakeFetch }
  ).then(res => {
    ok("both programs come through", res.programs.length === 2);
    ok("the JSON survives being wrapped in prose and a code fence", res.homeownerSummary.indexOf("$3,500") > -1);
    ok("the serving utilities are reported", res.utilities.electric === "Austin Energy");
    ok("the quotable total is computed", res.totals.capped === 3500, String(res.totals.capped));
    ok("search sources are captured for citation", res.sources.some(s => /acme-electric/.test(s.url)));
    ok("web search was actually requested of the provider", JSON.stringify(fakeFetch.calls[0].body).indexOf("web_search") > -1);
    ok("the key went in the header, never the URL", !/sk-test/.test(fakeFetch.calls[0].url));

    // A provider with no research support must say so rather than fail obscurely.
    return RQ.search({ city: "Austin" }, { aiProvider: "custom", aiApiKey: "k" }, { fetchImpl: fakeFetch })
      .then(() => ok("a research-incapable provider is rejected", false, "it resolved"),
            e => ok("a research-incapable provider is rejected with a fix", /Switch to Anthropic/.test(e.message), e.message));
  }).then(() => {
    // No key at all.
    return RQ.search({ city: "Austin" }, {}, {})
      .then(() => ok("a missing API key is rejected", false, "it resolved"),
            e => ok("a missing API key is rejected with a fix", /Settings/.test(e.message), e.message));
  }).then(() => {
    // Unreadable answer.
    const junk = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: [{ type: "text", text: "sorry, no idea" }] }) });
    return RQ.search({ city: "Austin" }, { aiProvider: "anthropic", aiApiKey: "k" }, { fetchImpl: junk })
      .then(() => ok("an unparseable answer is rejected", false, "it resolved"),
            e => ok("an unparseable answer is rejected, not rendered as empty", /unreadable/.test(e.message), e.message));
  }).then(() => {
    // Rejected key.
    const denied = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    return RQ.search({ city: "Austin" }, { aiProvider: "anthropic", aiApiKey: "bad" }, { fetchImpl: denied })
      .then(() => ok("a rejected key is surfaced", false, "it resolved"),
            e => ok("a rejected key is surfaced plainly", /rejected/.test(e.message), e.message));
  }).then(() => {
    console.log(`\n${failed === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + failed + " CHECK(S) FAILED"} (${passed} passed)`);
    process.exit(failed ? 1 : 0);
  });
}
