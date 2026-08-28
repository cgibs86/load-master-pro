/*
 * Unit tests for api/permit-search.cjs — every provider's request/response
 * handling, exercised with injected fake fetch/Anthropic-client fixtures so
 * no live network calls or real API keys are needed.
 */
const path = require("path");
const permitSearch = require(path.join(__dirname, "..", "api", "permit-search.cjs"));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? " (" + detail + ")" : ""}`);
}

function fakeFetch(status, body) {
  return function () { return Promise.resolve({ status: status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) }); };
}

async function run() {
  console.log("=== extractJson fallback parsing ===");
  check("direct JSON.parse", JSON.stringify(permitSearch.extractJson('{"a":1}')) === '{"a":1}');
  check("fenced ```json block", JSON.stringify(permitSearch.extractJson('here you go:\n```json\n{"a":1}\n```')) === '{"a":1}');
  check("brace-substring extraction from prose", JSON.stringify(permitSearch.extractJson('Sure! {"a":1} — hope that helps.')) === '{"a":1}');
  check("unparseable text returns null, not a throw", permitSearch.extractJson("no json here") === null);

  console.log("\n=== backfillSources dedup ===");
  const merged = permitSearch.backfillSources([{ title: "A", url: "https://a" }], [{ title: "A dup", url: "https://a" }, { title: "B", url: "https://b" }]);
  check("keeps the original entry for a duplicate URL, adds the new one", merged.length === 2 && merged[0].url === "https://a" && merged[1].url === "https://b");

  console.log("\n=== runAnthropicPermitSearch (pause_turn continuation loop) ===");
  {
    var calls = 0;
    var fakeClient = {
      messages: {
        create: function () {
          calls++;
          if (calls === 1) return Promise.resolve({ stop_reason: "pause_turn", content: [{ type: "text", text: "still looking" }] });
          return Promise.resolve({ stop_reason: "end_turn", model: "claude-opus-5", content: [{ type: "text", text: '{"sources":[],"confidence":"low"}' }] });
        }
      }
    };
    var res = await permitSearch.runAnthropicPermitSearch("Location: Austin, TX", "claude-opus-5", { client: fakeClient });
    check("resumes after pause_turn and returns ok:true", res.ok === true, JSON.stringify(res));
    check("issued exactly 2 requests (initial + one resume)", calls === 2);
  }
  {
    var errClient = { messages: { create: function () { var e = new Error("bad key"); e.status = 401; return Promise.reject(e); } } };
    var res = await permitSearch.runAnthropicPermitSearch("Location: X", "claude-opus-5", { client: errClient });
    check("401 surfaces a 'rejected' message", res.ok === false && /rejected/i.test(res.message));
  }

  console.log("\n=== runOpenAiPermitSearch (Responses API) ===");
  process.env.OPENAI_API_KEY = "test-openai-key";
  {
    var body = {
      model: "gpt-5.6",
      output: [{ type: "message", content: [{ text: '{"sources":[],"confidence":"low"}', annotations: [{ type: "url_citation", url: "https://city.gov/code", title: "City Code" }] }] }]
    };
    var res = await permitSearch.runOpenAiPermitSearch("Location: Austin, TX", "gpt-5.6", { fetch: fakeFetch(200, body) });
    check("parses output[].content[].text and returns ok:true", res.ok === true, JSON.stringify(res));
    check("extracts url_citation annotations as searchedSources", res.searchedSources.length === 1 && res.searchedSources[0].url === "https://city.gov/code");
  }
  {
    var res = await permitSearch.runOpenAiPermitSearch("Location: X", "gpt-5.6", { fetch: fakeFetch(401, {}) });
    check("401 surfaces a 'rejected' message", res.ok === false && /rejected/i.test(res.message));
  }

  console.log("\n=== runGeminiPermitSearch (google_search grounding, no schema) ===");
  process.env.GEMINI_API_KEY = "test-gemini-key";
  {
    var body = {
      candidates: [{
        content: { parts: [{ text: '{"sources":[],"confidence":"low"}' }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://city.gov/code", title: "City Code" } }] }
      }]
    };
    var res = await permitSearch.runGeminiPermitSearch("Location: Austin, TX", "gemini-3.5-flash", { fetch: fakeFetch(200, body) });
    check("parses candidates[].content.parts[].text and returns ok:true", res.ok === true, JSON.stringify(res));
    check("extracts groundingChunks as searchedSources", res.searchedSources.length === 1 && res.searchedSources[0].url === "https://city.gov/code");
  }

  console.log("\n=== runPerplexityPermitSearch (always-on search, top-level citations) ===");
  process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
  {
    var body = {
      model: "sonar-pro",
      choices: [{ message: { content: '{"sources":[],"confidence":"low"}' } }],
      citations: ["https://city.gov/code"]
    };
    var res = await permitSearch.runPerplexityPermitSearch("Location: Austin, TX", "sonar-pro", { fetch: fakeFetch(200, body) });
    check("parses choices[0].message.content and returns ok:true", res.ok === true, JSON.stringify(res));
    check("extracts top-level citations array as searchedSources", res.searchedSources.length === 1 && res.searchedSources[0].url === "https://city.gov/code");
  }

  console.log("\n=== permitSearch() top-level dispatch ===");
  {
    var res = await permitSearch.permitSearch({}); // no city/state/address
    check("rejects missing location input before touching any provider", res.ok === false && res.error === "bad_input");
  }
  {
    var oldProvider = process.env.LMP_PERMIT_PROVIDER;
    process.env.LMP_PERMIT_PROVIDER = "not-a-real-provider";
    var res = await permitSearch.permitSearch({ city: "Austin", state: "TX" });
    check("unknown LMP_PERMIT_PROVIDER returns a bad_config error, not a crash", res.ok === false && res.error === "bad_config");
    if (oldProvider === undefined) delete process.env.LMP_PERMIT_PROVIDER; else process.env.LMP_PERMIT_PROVIDER = oldProvider;
  }

  console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + fail + " CHECK(S) FAILED"} (${pass} passed)`);
  process.exit(fail ? 1 : 0);
}

run();
