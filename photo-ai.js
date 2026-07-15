/*
 * LoadMaster Pro — AI photo analysis (PhotoScan).
 *
 * Sends the job-site photos to the Claude vision API and returns structured
 * observations about the home (sun exposure, insulation quality, windows,
 * foundation, ceiling height, size) that the calculator can fold into the
 * load numbers. Entirely optional: no photos or no API key means the
 * calculator behaves exactly as before.
 *
 * The app is a buildless static site, so this calls the Messages API with
 * fetch() directly (CORS is enabled via the
 * anthropic-dangerous-direct-browser-access header). The user's own API key
 * is stored on-device in Settings, same as the property-data key.
 */
(function (root) {
  "use strict";

  var API_URL = "https://api.anthropic.com/v1/messages";
  var MODEL = "claude-opus-4-8";

  // Structured-output schema: the API guarantees the response is valid JSON
  // matching this shape, so no free-text parsing is needed.
  var SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings"],
    properties: {
      summary: {
        type: "string",
        description: "2-3 plain-English sentences for the contractor: what the photos show about this home and how it affects heating/cooling sizing."
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["field", "value", "confidence", "note"],
          properties: {
            field: {
              type: "string",
              enum: ["sun", "quality", "foundation", "ceiling", "windowFrac", "area", "stories", "other"]
            },
            value: { type: ["string", "number", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            note: { type: "string", description: "One short sentence naming the visible evidence." }
          }
        }
      }
    }
  };

  function imageBlock(dataUrl) {
    var m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl);
    if (!m) return null;
    return { type: "image", source: { type: "base64", media_type: m[1].toLowerCase(), data: m[2] } };
  }

  function buildPrompt(ctx) {
    var areaSource = ctx.areaSource === "fetched"
      ? "pulled from property records (treat as reliable — only report a different area if the photos clearly contradict it)"
      : "a rough estimate (photo evidence about size is very welcome)";
    return [
      "You are assisting an HVAC contractor's ACCA Manual J-style residential load calculator.",
      "The attached photos are of one home — a mix of outside and inside shots taken by the user. Analyze them and report ONLY characteristics you can see actual evidence for.",
      "",
      "Property context:",
      "- Location: " + (ctx.address || "unknown") + (ctx.climateCity ? " (climate: " + ctx.climateCity + ")" : ""),
      "- Current calculator inputs: " + ctx.area + " ft² conditioned area (" + areaSource + "), construction quality \"" + ctx.quality + "\", sun exposure \"" + ctx.sun + "\", foundation \"" + ctx.foundation + "\", ceiling height " + ctx.ceiling + " ft, " + ctx.bedrooms + " bedrooms" + (ctx.yearBuilt ? ", built " + ctx.yearBuilt : "") + ".",
      "",
      "Report one finding per characteristic you can assess:",
      "- field \"sun\" (value: \"low\" | \"average\" | \"high\"): overall solar exposure. \"low\" = heavy tree/building shading, \"high\" = little shade and/or large sun-facing glass. Exterior shots only.",
      "- field \"quality\" (value: \"good\" | \"average\" | \"poor\"): construction & insulation quality. \"good\" = newer/tight construction, double- or triple-pane windows, visible quality insulation; \"poor\" = older/leaky, single-pane windows, visible gaps or bare framing, minimal attic insulation.",
      "- field \"foundation\" (value: \"slab\" | \"crawl\" | \"basement\"): only if visible (exposed slab edge, crawl-space vents/skirting, basement windows or interior basement shots).",
      "- field \"ceiling\" (value: number, feet): typical ceiling height from interior shots (8, 9, 10…; use 12+ only for clearly vaulted or open two-story spaces).",
      "- field \"windowFrac\" (value: number): glazing as a fraction of floor area — 0.10 = few/small windows, 0.15 = typical, 0.20-0.25 = lots of large windows or glass walls.",
      "- field \"area\" (value: number, ft²): estimated conditioned floor area, only when the current area is an estimate and the photos suggest a clearly different size class.",
      "- field \"stories\" (value: number): visible stories (informational).",
      "- field \"other\" (value: null): any other load-relevant observation — big west-facing glass, window AC units, radiant barrier, new attic insulation, leaky ductwork, etc. Put the observation in the note.",
      "",
      "Rules: be conservative. Use confidence \"low\" whenever unsure — low-confidence findings are shown to the user but NOT applied to the calculation. Never invent characteristics that are not visible in the photos. Skip any field the photos give no evidence for."
    ].join("\n");
  }

  // Per-field validation of what the model reports before anything is applied.
  var VALIDATORS = {
    sun: function (v) { return v === "low" || v === "average" || v === "high" ? v : null; },
    quality: function (v) { return v === "good" || v === "average" || v === "poor" ? v : null; },
    foundation: function (v) { return v === "slab" || v === "crawl" || v === "basement" ? v : null; },
    ceiling: function (v) { v = Number(v); return v >= 7 && v <= 20 ? Math.round(v * 2) / 2 : null; },
    windowFrac: function (v) { v = Number(v); return v >= 0.06 && v <= 0.35 ? Math.round(v * 100) / 100 : null; },
    area: function (v) { v = Number(v); return v >= 300 && v <= 15000 ? Math.round(v / 50) * 50 : null; },
    stories: function (v) { v = Number(v); return v >= 1 && v <= 4 ? Math.round(v) : null; }
  };

  function sanitize(raw) {
    var findings = [];
    (raw.findings || []).forEach(function (f) {
      if (!f || typeof f.field !== "string") return;
      var out = {
        field: f.field,
        value: f.value,
        confidence: f.confidence === "high" || f.confidence === "medium" ? f.confidence : "low",
        note: String(f.note || "").slice(0, 300)
      };
      if (VALIDATORS[f.field]) {
        out.value = VALIDATORS[f.field](f.value);
        if (out.value == null) out.confidence = "low"; // out-of-range → show, never apply
      } else if (f.field !== "other") {
        return; // unknown field name — drop
      }
      findings.push(out);
    });
    return { summary: String(raw.summary || "").slice(0, 900), findings: findings };
  }

  /*
   * analyze(dataUrls, ctx, apiKey) -> Promise<{summary, findings[]}>
   * dataUrls: array of base64 image data URLs (already downscaled by the app).
   * ctx: current calculation context (address, area, areaSource, quality, …).
   */
  function analyze(dataUrls, ctx, apiKey) {
    var content = [];
    (dataUrls || []).slice(0, 6).forEach(function (u) {
      var b = imageBlock(u);
      if (b) content.push(b);
    });
    if (!content.length) return Promise.reject(new Error("No readable photos to analyze."));
    content.push({ type: "text", text: buildPrompt(ctx || {}) });

    return fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: content }]
      })
    }).then(function (r) {
      if (r.status === 401) throw new Error("That API key was rejected — check it in Settings.");
      if (r.status === 429) throw new Error("Rate limited — wait a minute and try again.");
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          throw new Error((body.error && body.error.message) || ("API error " + r.status));
        });
      }
      return r.json();
    }).then(function (msg) {
      if (msg.stop_reason === "refusal") throw new Error("The AI declined to analyze these photos.");
      if (msg.stop_reason === "max_tokens") throw new Error("Analysis was cut short — try fewer photos.");
      var text = null;
      (msg.content || []).forEach(function (block) { if (block.type === "text" && text == null) text = block.text; });
      if (!text) throw new Error("The AI returned no analysis.");
      return sanitize(JSON.parse(text));
    });
  }

  root.PhotoAI = { analyze: analyze, MODEL: MODEL };
})(typeof window !== "undefined" ? window : globalThis);
