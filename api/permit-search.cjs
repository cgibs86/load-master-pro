/*
 * LoadMaster Pro — Permit & code research endpoint (Pro feature).
 *
 * Given a US city/state (and optional full address), uses Claude with the
 * web_search server tool to find residential HVAC (outdoor condenser unit)
 * installation permit requirements and the local building/zoning department's
 * contact info, returning strict structured JSON with source citations.
 *
 * This runs SERVER-SIDE so the ANTHROPIC_API_KEY never reaches the browser.
 * It works both as a route inside the dev server (serve.cjs) and as a generic
 * serverless handler (export `handler(body)`).
 *
 * Required env:
 *   ANTHROPIC_API_KEY   — your Anthropic API key
 * Optional env:
 *   LMP_PERMIT_MODEL    — model id (default: claude-opus-4-8)
 *   LMP_PERMIT_EFFORT   — low | medium | high | max (default: medium)
 *
 * Results are best-effort AI research and MUST be verified with the authority
 * having jurisdiction (AHJ) — municipal codes are inconsistent and change.
 */

const MODEL = process.env.LMP_PERMIT_MODEL || "claude-opus-4-8";
const EFFORT = process.env.LMP_PERMIT_EFFORT || "medium";

// Stable across every request -> good prompt-cache prefix. (Caching only kicks
// in once the prefix exceeds the model's minimum cacheable size; harmless below.)
const SYSTEM_PROMPT = [
  "You are an HVAC permitting research assistant for licensed contractors.",
  "Given a US location, research the local code requirements for installing a",
  "RESIDENTIAL split-system air conditioner / heat pump — focused on the OUTDOOR",
  "condenser unit — and the building/zoning department that issues the permit.",
  "",
  "Use the web_search tool. Prioritize authoritative primary sources in this order:",
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
  "   you took it from. Only cite pages you actually retrieved via web_search.",
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

/** Collect plain text and any web-search source URLs from a Messages response. */
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

/**
 * Run the permit search.
 * @param {{city?:string,state?:string,county?:string,address?:string}} input
 * @returns {Promise<object>} { ok, data?, searchedSources?, error?, message? }
 */
async function permitSearch(input) {
  input = input || {};
  var city = (input.city || "").trim();
  var state = (input.state || "").trim();
  var county = (input.county || "").trim();
  var address = (input.address || "").trim();

  if (!city && !state && !address) {
    return { ok: false, error: "bad_input", message: "A city and state (or full address) is required." };
  }

  // Lazy-load the SDK so the static app + dev server still run with no install.
  var Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk");
  } catch (e) {
    return {
      ok: false,
      error: "sdk_missing",
      message: "Permit search needs the Anthropic SDK. Run `npm install` in the project root."
    };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "no_api_key",
      message: "Permit search isn't configured: set the ANTHROPIC_API_KEY environment variable on the server."
    };
  }

  var client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  var locationLine =
    "Location to research: " +
    [city, county ? county + " County" : "", state].filter(Boolean).join(", ") +
    (address ? "\nFull street address (for jurisdiction matching only): " + address : "") +
    "\n\nResearch the residential HVAC outdoor-unit installation permit requirements and the" +
    " permitting department for this location, then return ONLY the JSON object.";

  var tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];
  var messages = [{ role: "user", content: locationLine }];

  var final = null;
  try {
    // Server tools run a multi-step loop; it may return stop_reason "pause_turn"
    // when it hits the per-response iteration cap — re-send to resume.
    for (var i = 0; i < 6; i++) {
      var resp = await client.messages.create({
        model: MODEL,
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
    return {
      ok: false,
      error: "parse_failed",
      message: "Couldn't parse a structured result from the research.",
      raw: h.text.slice(0, 4000),
      searchedSources: h.searched
    };
  }

  // Backfill the sources list with the URLs actually retrieved, deduped.
  var sources = Array.isArray(data.sources) ? data.sources.filter(function (s) { return s && s.url; }) : [];
  var have = {};
  sources.forEach(function (s) { have[s.url] = 1; });
  h.searched.forEach(function (s) { if (!have[s.url]) { have[s.url] = 1; sources.push(s); } });
  data.sources = sources;

  return { ok: true, data: data, searchedSources: h.searched, model: final.model };
}

/** Serverless-style entry: takes a parsed body object, returns the JSON payload. */
async function handler(body) {
  return permitSearch(body || {});
}

module.exports = { permitSearch: permitSearch, handler: handler, extractJson: extractJson, harvest: harvest };
