/*
 * Unit tests for ai-providers.js — the request-building and response-parsing
 * logic for every provider, exercised with mocked fetch/fixtures so no live
 * network calls or real API keys are needed.
 */
const path = require("path");
const AIProviders = require(path.join(__dirname, "..", "ai-providers.js"));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? " (" + detail + ")" : ""}`);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "confidence", "note"],
        properties: {
          field: { type: "string", enum: ["sun", "quality", "other"] },
          value: { type: ["string", "number", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          note: { type: "string" }
        }
      }
    }
  }
};
const IMG = "data:image/jpeg;base64,QQ=="; // trivially small, just needs to parse
const BASE_OPTS = { model: "test-model", images: [IMG], schema: SCHEMA, promptText: "describe this", maxTokens: 4096 };

console.log("=== buildVisionRequest shapes ===");
{
  const req = AIProviders.getProvider("anthropic").buildVisionRequest(Object.assign({ apiKey: "sk-ant-x" }, BASE_OPTS));
  check("anthropic: correct URL", req.url === "https://api.anthropic.com/v1/messages");
  check("anthropic: x-api-key header", req.headers["x-api-key"] === "sk-ant-x");
  check("anthropic: json_schema output_config", req.body.output_config.format.type === "json_schema" && req.body.output_config.format.schema === SCHEMA);
  check("anthropic: image block has base64 payload without data: prefix", req.body.messages[0].content[0].source.data === "QQ==");
}
{
  const req = AIProviders.getProvider("openai").buildVisionRequest(Object.assign({ apiKey: "sk-x" }, BASE_OPTS));
  check("openai: correct URL", req.url === "https://api.openai.com/v1/chat/completions");
  check("openai: Bearer auth header", req.headers.Authorization === "Bearer sk-x");
  check("openai: image_url passed through unmodified (no stripping)", req.body.messages[0].content[0].image_url.url === IMG);
  check("openai: strict json_schema response_format", req.body.response_format.json_schema.strict === true);
}
{
  const req = AIProviders.getProvider("gemini").buildVisionRequest(Object.assign({ apiKey: "AIza-x" }, BASE_OPTS));
  check("gemini: correct URL with model in path", req.url === "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
  check("gemini: key sent as header, not query param", req.headers["x-goog-api-key"] === "AIza-x" && req.url.indexOf("key=") === -1);
  check("gemini: image as inlineData with stripped base64", req.body.contents[0].parts[0].inlineData.data === "QQ==");
  check("gemini: responseSchema strips additionalProperties", JSON.stringify(req.body.generationConfig.responseSchema).indexOf("additionalProperties") === -1);
  check("gemini: union-type 'value' field flattened to plain string", req.body.generationConfig.responseSchema.properties.findings.items.properties.value.type === "string");
}
{
  const req = AIProviders.getProvider("perplexity").buildVisionRequest(Object.assign({ apiKey: "pplx-x" }, BASE_OPTS));
  check("perplexity: correct URL", req.url === "https://api.perplexity.ai/chat/completions");
  check("perplexity: Bearer auth header", req.headers.Authorization === "Bearer pplx-x");
}
{
  const req = AIProviders.getProvider("custom").buildVisionRequest(Object.assign({ apiKey: "k", baseUrl: "https://my-proxy/v1/chat/completions" }, BASE_OPTS));
  check("custom: uses the supplied baseUrl verbatim", req.url === "https://my-proxy/v1/chat/completions");
  let threw = false;
  try { AIProviders.getProvider("custom").buildVisionRequest(Object.assign({ apiKey: "k" }, BASE_OPTS)); } catch (e) { threw = /base URL/i.test(e.message); }
  check("custom: throws a clear error when baseUrl is missing", threw);
}

console.log("\n=== extractVisionText per-provider response parsing ===");
{
  const text = AIProviders.getProvider("anthropic").extractVisionText({ content: [{ type: "text", text: '{"summary":"ok","findings":[]}' }] });
  check("anthropic: extracts text block", text === '{"summary":"ok","findings":[]}');
  let threw = false;
  try { AIProviders.getProvider("anthropic").extractVisionText({ stop_reason: "refusal" }); } catch (e) { threw = /declined/i.test(e.message); }
  check("anthropic: refusal stop_reason throws a readable error", threw);
}
{
  const text = AIProviders.getProvider("openai").extractVisionText({ choices: [{ finish_reason: "stop", message: { content: '{"summary":"ok","findings":[]}' } }] });
  check("openai: extracts choices[0].message.content", text === '{"summary":"ok","findings":[]}');
  let threw = false;
  try { AIProviders.getProvider("openai").extractVisionText({ choices: [{ finish_reason: "length", message: {} }] }); } catch (e) { threw = /cut short/i.test(e.message); }
  check("openai: length finish_reason throws a readable error", threw);
}
{
  // Gemini fixture where the model returned "value":"9" as a STRING (schema forces it to be a string
  // for the union-type field) — proves photo-ai.js's Number() coercion downstream still works.
  const geminiJson = { candidates: [{ content: { parts: [{ text: '{"summary":"ok","findings":[{"field":"ceiling","value":"9","confidence":"high","note":"n"}]}' }] } }] };
  const text = AIProviders.getProvider("gemini").extractVisionText(geminiJson);
  const parsed = JSON.parse(text);
  check("gemini: extracts and concatenates parts[].text", parsed.summary === "ok");
  check("gemini: stringified numeric value round-trips through Number()", Number(parsed.findings[0].value) === 9);
  let threw = false;
  try { AIProviders.getProvider("gemini").extractVisionText({ promptFeedback: { blockReason: "SAFETY" } }); } catch (e) { threw = /declined/i.test(e.message); }
  check("gemini: blockReason throws a readable error", threw);
}
{
  const text = AIProviders.getProvider("perplexity").extractVisionText({ choices: [{ finish_reason: "stop", message: { content: '{"summary":"ok","findings":[]}' } }] });
  check("perplexity: extracts choices[0].message.content (OpenAI-compatible)", text === '{"summary":"ok","findings":[]}');
}

console.log("\n=== analyzeImages() end-to-end with mocked fetch ===");
{
  const savedFetch = global.fetch;
  global.fetch = function (url, opts) {
    return Promise.resolve({
      status: 200, ok: true,
      json: () => Promise.resolve({ content: [{ type: "text", text: '{"summary":"looks good","findings":[]}' }] })
    });
  };
  AIProviders.analyzeImages({ providerId: "anthropic", apiKey: "sk-ant-x", model: "claude-opus-5", images: [IMG], schema: SCHEMA, promptText: "go", maxTokens: 100 })
    .then((obj) => { check("analyzeImages: resolves with parsed object", obj.summary === "looks good"); })
    .catch((e) => { check("analyzeImages: resolves with parsed object", false, e.message); })
    .then(() => {
      global.fetch = function () { return Promise.resolve({ status: 401, ok: false, json: () => Promise.resolve({}) }); };
      return AIProviders.analyzeImages({ providerId: "anthropic", apiKey: "bad", model: "claude-opus-5", images: [IMG], schema: SCHEMA, promptText: "go", maxTokens: 100 });
    })
    .then(() => { check("analyzeImages: 401 should have rejected", false); })
    .catch((e) => { check("analyzeImages: 401 rejects with a 'rejected' message", /rejected/i.test(e.message)); })
    .then(() => {
      global.fetch = savedFetch;
      console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ " + fail + " CHECK(S) FAILED"} (${pass} passed)`);
      process.exit(fail ? 1 : 0);
    });
}
