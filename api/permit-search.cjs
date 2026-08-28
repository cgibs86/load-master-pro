/*
 * LoadMaster Pro AI — Permit & code research endpoint (Pro feature).
 *
 * Given a US city/state (and optional full address), asks the configured AI
 * provider to search the web for residential HVAC (outdoor condenser unit)
 * installation permit requirements and the local building/zoning department's
 * contact info, returning strict structured JSON with source citations.
 *
 * This runs SERVER-SIDE so the provider's API key never reaches the browser.
 * It works both as a route inside the dev server (serve.cjs) and as a generic
 * serverless handler (export `handler(body)`).
 *
 * Required env:
 *   One of ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / PERPLEXITY_API_KEY,
 *   matching whichever provider is selected.
 * Optional env:
 *   LMP_PERMIT_PROVIDER — anthropic | openai | gemini | perplexity (default: anthropic)
 *   LMP_PERMIT_MODEL    — model id (default: the selected provider's current default)
 *   LMP_PERMIT_EFFORT   — low | medium | high | max (default: medium; Anthropic only —
 *                         the other providers' web-search tools have no equivalent knob)
 *
 * Every provider's web-search mechanism is genuinely different (Anthropic's
 * server-side tool with a pause/resume loop, OpenAI's separate Responses API,
 * Gemini's search-grounding tool, Perplexity's always-on search) — but none of
 * them combine live search with strict JSON-schema enforcement in one call, so
 * every path here relies on the same technique: ask for JSON via the prompt,
 * then robustly pull it out of whatever text comes back with extractJson().
 *
 * Results are best-effort AI research and MUST be verified with the authority
 * having jurisdiction (AHJ) — municipal codes are inconsistent and change.
 */

const PROVIDER_DEFAULT_MODELS = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6",
  gemini: "gemini-3.5-flash",
  perplexity: "sonar-pro"
};
const EFFORT = process.env.LMP_PERMIT_EFFORT || "medium";

// Stable across every request -> good prompt-cache prefix on providers that
// support it (Anthropic). Harmless as a plain prefix on the others.
const SYSTEM_PROMPT = [
  "You are an HVAC permitting research assistant for licensed contractors.",
  "Given a US location, research the local code requirements for installing a",
  "RESIDENTIAL split-system air conditioner / heat pump — focused on the OUTDOOR",
  "condenser unit — and the building/zoning department that issues the permit.",
  "",
  "Use web search. Prioritize authoritative primary sources in this order:",
  "the city/municipal code (Municode, eCode360, American Legal, Sterling Codifiers),",
  "the city or county building/zoning department's official .gov pages, then the",
  "state amendments to the IRC/IECC/IMC. Resolve the authority having jurisdiction",
  "(AHJ): prefer the incorporated city; fall back to the county, then state.",
  "",
  "Find, where available:",
  "- Required setback of the outdoor unit from the property line / lot line (feet).",
  "- Minimum equipment efficiency: SEER and/or SEER2 (note federal regional minimums",
  "  if no stricter local rule exists).",
  "- Maximum allowable sound level at the property line (dBA) and any nighttime limit.",
  "- Whether a service disconnect / dedicated electrical permit is required.",
  "- Screening / fencing / placement (e.g. not in front yard) requirements.",
  "- Any other notable install-code items (clearances, pad, condensate, HOA notes).",
  "- The department name, website, online permit portal, email, and phone.",
  "",
  "STRICT RULES:",
  "1. NEVER guess or fabricate a number, email, phone, or URL. If you cannot find a",
  "   value from a credible source, use null. It is correct and expected to return null.",
  "2. For every numeric requirement you DO report, set its `source` to the exact URL",
  "   you took it from. Only cite pages you actually retrieved via web search.",
  "3. Requirements vary by jurisdiction and change over time — this is guidance only.",
  "4. Respond with ONLY a single JSON object matching the schema below. No prose,",
  "   no markdown, no code fences before or after the JSON.",
  "",
  "JSON schema (use null for unknown fields; keep keys exactly as shown):",
  JSON.stringify({
    jurisdiction: { city: null, county: null, state: null, authorityName: null, level: null },
    permitRequired: null,
    requirements: {
      outdoorUnitSetbackFt: { value: null, text: null, source: null },
      minSeer: { value: null, text: null, source: null },
      minSeer2: { value: null, text: null, source: null },
      maxSoundDb: { value: null, text: null, source: null },
      electricalDisconnect: { required: null, text: null, source: null },
      screening: { required: null, text: null, source: null },
      other: [{ topic: "", requirement: "", source: null }]
    },
    department: { name: null, website: null, permitPortal: null, email: null, phone: null, address: null },
    sources: [{ title: "", url: "" }],
    confidence: "low",
    notes: null
  }, null, 2)
].join("\n");

/**
 * Robustly pull a JSON object out of model text that may include stray prose
 * or ```json fences. Exported for unit testing.
 */
function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  var t = text.trim();

  // 1. Direct parse.
  try { return JSON.parse(t); } catch (e) {}

  // 2. Strip a ```json ... ``` (or bare ```) fence.
  var fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (e) {}
  }

  // 3. Substring from the first "{" to the last "}".
  var first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch (e) {}
  }
  return null;
}

/** Collect plain text and any web-search source URLs from an Anthropic Messages response. */
function harvest(content) {
  var text = "";
  var searched = [];
  var seen = {};
  (content || []).forEach(function (block) {
    if (!block || !block.type) return;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      // Citations attached to text blocks (web search).
      (block.citations || []).forEach(function (c) {
        if (c && c.url && !seen[c.url]) { seen[c.url] = 1; searched.push({ title: c.title || c.url, url: c.url }); }
      });
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      block.content.forEach(function (r) {
        if (r && r.type === "web_search_result" && r.url && !seen[r.url]) {
          seen[r.url] = 1;
          searched.push({ title: r.title || r.url, url: r.url });
        }
      });
    }
  });
  return { text: text, searched: searched };
}

/** Merge a parsed result's own `sources` list with the URLs actually retrieved, deduped. */
function backfillSources(existing, searched) {
  var sources = Array.isArray(existing) ? existing.filter(function (s) { return s && s.url; }) : [];
  var have = {};
  sources.forEach(function (s) { have[s.url] = 1; });
  (searched || []).forEach(function (s) { if (!have[s.url]) { have[s.url] = 1; sources.push(s); } });
  return sources;
}

function buildLocationLine(city, county, state, address) {
  return "Location to research: " +
    [city, county ? county + " County" : "", state].filter(Boolean).join(", ") +
    (address ? "\nFull street address (for jurisdiction matching only): " + address : "") +
    "\n\nResearch the residential HVAC outdoor-unit installation permit requirements and the" +
    " permitting department for this location, then return ONLY the JSON object.";
}

/** Anthropic: server-side web_search tool with a pause/resume continuation loop. */
async function runAnthropicPermitSearch(locationLine, model, deps) {
  deps = deps || {};
  var client = deps.client;
  if (!client) {
    var Anthropic = deps.AnthropicSdk;
    if (!Anthropic) {
      try { Anthropic = require("@anthropic-ai/sdk"); }
      catch (e) {
        return { ok: false, error: "sdk_missing", message: "Permit search needs the Anthropic SDK. Run `npm install` in the project root." };
      }
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: "no_api_key", message: "Permit search isn't configured: set the ANTHROPIC_API_KEY environment variable on the server." };
    }
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }

  var tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];
  var messages = [{ role: "user", content: locationLine }];

  var final = null;
  try {
    // Server tools run a multi-step loop; it may return stop_reason "pause_turn"
    // when it hits the per-response iteration cap — re-send to resume.
    for (var i = 0; i < 6; i++) {
      var resp = await client.messages.create({
        model: model,
        max_tokens: 8000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        tools: tools,
        messages: messages
      });
      if (resp.stop_reason === "pause_turn") {
        messages = messages.concat([{ role: "assistant", content: resp.content }]);
        continue;
      }
      final = resp;
      break;
    }
  } catch (e) {
    var status = e && e.status;
    return {
      ok: false,
      error: "api_error",
      message: status === 401 ? "The configured ANTHROPIC_API_KEY was rejected."
             : status === 429 ? "Rate limited by the API — try again shortly."
             : "Permit research failed: " + (e && e.message ? e.message : String(e))
    };
  }

  if (!final) {
    return { ok: false, error: "no_response", message: "The model did not finish the research (paused too long)." };
  }

  var h = harvest(final.content);
  var data = extractJson(h.text);
  if (!data) {
    return { ok: false, error: "parse_failed", message: "Couldn't parse a structured result from the research.", raw: h.text.slice(0, 4000), searchedSources: h.searched };
  }
  data.sources = backfillSources(data.sources, h.searched);
  return { ok: true, data: data, searchedSources: h.searched, model: final.model };
}

/** OpenAI: the Responses API's web_search tool. Single-shot — the tool runs fully server-side within one call. */
async function runOpenAiPermitSearch(locationLine, model, deps) {
  deps = deps || {};
  var fetchFn = deps.fetch || fetch;
  var apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", message: "Permit search isn't configured: set the OPENAI_API_KEY environment variable on the server." };

  var resp, json;
  try {
    resp = await fetchFn("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: model, instructions: SYSTEM_PROMPT, input: locationLine, tools: [{ type: "web_search" }] })
    });
    json = await resp.json().catch(function () { return {}; });
  } catch (e) {
    return { ok: false, error: "api_error", message: "Permit research failed: " + (e && e.message ? e.message : String(e)) };
  }
  if (resp.status === 401) return { ok: false, error: "api_error", message: "The configured OPENAI_API_KEY was rejected." };
  if (resp.status === 429) return { ok: false, error: "api_error", message: "Rate limited by the API — try again shortly." };
  if (!resp.ok) return { ok: false, error: "api_error", message: "Permit research failed: " + ((json.error && json.error.message) || ("API error " + resp.status)) };

  var text = "", searched = [], seen = {};
  (json.output || []).forEach(function (item) {
    if (item.type !== "message") return;
    (item.content || []).forEach(function (c) {
      if (typeof c.text === "string") text += c.text;
      (c.annotations || []).forEach(function (a) {
        if (a && a.type === "url_citation" && a.url && !seen[a.url]) { seen[a.url] = 1; searched.push({ title: a.title || a.url, url: a.url }); }
      });
    });
  });
  var data = extractJson(text);
  if (!data) return { ok: false, error: "parse_failed", message: "Couldn't parse a structured result from the research.", raw: text.slice(0, 4000), searchedSources: searched };
  data.sources = backfillSources(data.sources, searched);
  return { ok: true, data: data, searchedSources: searched, model: json.model || model };
}

/** Gemini: the google_search grounding tool. Confirmed incompatible with responseSchema, so this stays prompt-only JSON like the others. */
async function runGeminiPermitSearch(locationLine, model, deps) {
  deps = deps || {};
  var fetchFn = deps.fetch || fetch;
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", message: "Permit search isn't configured: set the GEMINI_API_KEY environment variable on the server." };

  var resp, json;
  try {
    resp = await fetchFn("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + locationLine }] }], tools: [{ google_search: {} }] })
    });
    json = await resp.json().catch(function () { return {}; });
  } catch (e) {
    return { ok: false, error: "api_error", message: "Permit research failed: " + (e && e.message ? e.message : String(e)) };
  }
  if (resp.status === 401 || resp.status === 403) return { ok: false, error: "api_error", message: "The configured GEMINI_API_KEY was rejected." };
  if (resp.status === 429) return { ok: false, error: "api_error", message: "Rate limited by the API — try again shortly." };
  if (!resp.ok) return { ok: false, error: "api_error", message: "Permit research failed: " + ((json.error && json.error.message) || ("API error " + resp.status)) };

  var cand = (json.candidates || [])[0];
  var text = cand ? ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ""; }).join("") : "";
  var chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  var searched = chunks.filter(function (c) { return c && c.web && c.web.uri; })
    .map(function (c) { return { title: c.web.title || c.web.uri, url: c.web.uri }; });

  var data = extractJson(text);
  if (!data) return { ok: false, error: "parse_failed", message: "Couldn't parse a structured result from the research.", raw: text.slice(0, 4000), searchedSources: searched };
  data.sources = backfillSources(data.sources, searched);
  return { ok: true, data: data, searchedSources: searched, model: model };
}

/** Perplexity: sonar models search automatically on every request, no tool needed. */
async function runPerplexityPermitSearch(locationLine, model, deps) {
  deps = deps || {};
  var fetchFn = deps.fetch || fetch;
  var apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key", message: "Permit search isn't configured: set the PERPLEXITY_API_KEY environment variable on the server." };

  var resp, json;
  try {
    resp = await fetchFn("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: locationLine }] })
    });
    json = await resp.json().catch(function () { return {}; });
  } catch (e) {
    return { ok: false, error: "api_error", message: "Permit research failed: " + (e && e.message ? e.message : String(e)) };
  }
  if (resp.status === 401) return { ok: false, error: "api_error", message: "The configured PERPLEXITY_API_KEY was rejected." };
  if (resp.status === 429) return { ok: false, error: "api_error", message: "Rate limited by the API — try again shortly." };
  if (!resp.ok) return { ok: false, error: "api_error", message: "Permit research failed: " + ((json.error && json.error.message) || ("API error " + resp.status)) };

  var text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "";
  var searched = (json.citations || []).map(function (u) { return { title: u, url: u }; });

  var data = extractJson(text);
  if (!data) return { ok: false, error: "parse_failed", message: "Couldn't parse a structured result from the research.", raw: text.slice(0, 4000), searchedSources: searched };
  data.sources = backfillSources(data.sources, searched);
  return { ok: true, data: data, searchedSources: searched, model: json.model || model };
}

/**
 * Run the permit search.
 * @param {{city?:string,state?:string,county?:string,address?:string}} input
 * @param {object} [deps] — injectable dependencies for testing (fetch, AnthropicSdk, client).
 * @returns {Promise<object>} { ok, data?, searchedSources?, error?, message? }
 */
async function permitSearch(input, deps) {
  input = input || {};
  var city = (input.city || "").trim();
  var state = (input.state || "").trim();
  var county = (input.county || "").trim();
  var address = (input.address || "").trim();

  if (!city && !state && !address) {
    return { ok: false, error: "bad_input", message: "A city and state (or full address) is required." };
  }

  var provider = (process.env.LMP_PERMIT_PROVIDER || "anthropic").toLowerCase();
  var model = process.env.LMP_PERMIT_MODEL || PROVIDER_DEFAULT_MODELS[provider];
  if (!model) {
    return { ok: false, error: "bad_config", message: "Unknown LMP_PERMIT_PROVIDER: " + provider };
  }
  var locationLine = buildLocationLine(city, county, state, address);

  switch (provider) {
    case "anthropic": return runAnthropicPermitSearch(locationLine, model, deps);
    case "openai": return runOpenAiPermitSearch(locationLine, model, deps);
    case "gemini": return runGeminiPermitSearch(locationLine, model, deps);
    case "perplexity": return runPerplexityPermitSearch(locationLine, model, deps);
    default: return { ok: false, error: "bad_config", message: "Unknown LMP_PERMIT_PROVIDER: " + provider };
  }
}

/** Serverless-style entry: takes a parsed body object, returns the JSON payload. */
async function handler(body) {
  return permitSearch(body || {});
}

module.exports = {
  permitSearch: permitSearch,
  handler: handler,
  extractJson: extractJson,
  harvest: harvest,
  backfillSources: backfillSources,
  runAnthropicPermitSearch: runAnthropicPermitSearch,
  runOpenAiPermitSearch: runOpenAiPermitSearch,
  runGeminiPermitSearch: runGeminiPermitSearch,
  runPerplexityPermitSearch: runPerplexityPermitSearch
};
