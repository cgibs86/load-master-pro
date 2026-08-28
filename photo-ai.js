/*
 * LoadMaster Pro AI — AI photo analysis (PhotoScan).
 *
 * Sends the job-site photos to the user's chosen AI provider's vision API and
 * returns structured observations about the home (sun exposure, insulation
 * quality, windows, foundation, ceiling height, size) that the calculator can
 * fold into the load numbers. Entirely optional: no photos or no API key
 * means the calculator behaves exactly as before.
 *
 * Transport (which provider, which HTTP shape) lives in ai-providers.js — this
 * file only owns the prompt, the output schema, and validating/sanitizing
 * whatever comes back, so none of that has to be duplicated per provider.
 * The user's own API key is stored on-device in Settings, same as the
 * property-data key.
 */
(function (root) {
  "use strict";

  // Structured-output schema: every provider is asked to return JSON matching
  // this shape, so no free-text parsing is needed.
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
   * analyze(dataUrls, ctx, settings) -> Promise<{summary, findings[]}>
   * dataUrls: array of base64 image data URLs (already downscaled by the app).
   * ctx: current calculation context (address, area, areaSource, quality, …).
   * settings: the app's Settings object — aiProvider/aiApiKey/aiModel/aiBaseUrl.
   */
  function analyze(dataUrls, ctx, settings) {
    var images = (dataUrls || []).slice(0, 6);
    if (!images.length) return Promise.reject(new Error("No readable photos to analyze."));
    settings = settings || {};
    var providerId = settings.aiProvider || "anthropic";
    var provider = root.AIProviders.getProvider(providerId);
    return root.AIProviders.analyzeImages({
      providerId: providerId,
      apiKey: settings.aiApiKey,
      model: settings.aiModel || provider.defaultModel,
      baseUrl: settings.aiBaseUrl,
      images: images,
      schema: SCHEMA,
      promptText: buildPrompt(ctx || {}),
      maxTokens: 4096
    }).then(sanitize);
  }

  root.PhotoAI = { analyze: analyze };
})(typeof window !== "undefined" ? window : globalThis);
