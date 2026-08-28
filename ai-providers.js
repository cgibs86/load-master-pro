/*
 * LoadMaster Pro AI — pluggable LLM provider layer.
 *
 * Every "bring your own API key" AI feature in the app (today: PhotoScan AI)
 * goes through this module instead of talking to one hardcoded vendor. Each
 * provider entry knows how to turn a generic "analyze these images against
 * this JSON schema" request into that vendor's exact HTTP shape, and how to
 * pull the model's raw JSON-text answer back out of that vendor's response
 * shape. Callers never see the differences.
 *
 * Adding a provider = adding one entry to PROVIDERS. Nothing else changes.
 */
(function (root) {
  "use strict";

  // Splits a data: URL into { mimeType, base64 } — shared by every provider,
  // since the app always hands this module base64 data: URLs for photos.
  function splitDataUrl(dataUrl) {
    var m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl || "");
    return m ? { mimeType: m[1].toLowerCase(), data: m[2] } : null;
  }

  function jsonError(status, body) {
    var msg = body && body.error && (body.error.message || body.error);
    return new Error((typeof msg === "string" && msg) || ("API error " + status));
  }

  // ---------- Gemini's schema dialect is a subset of OpenAPI, not raw JSON Schema ----------
  // Strips `additionalProperties` (unsupported) and flattens the one union type
  // this app's schema uses (`value: ["string","number","null"]`) to a plain
  // string — safe because photo-ai.js's VALIDATORS already coerce with Number(v)
  // for the numeric fields, so a stringified "9" round-trips to 9 correctly.
  function toGeminiSchema(node) {
    if (Array.isArray(node)) return node.map(toGeminiSchema);
    if (!node || typeof node !== "object") return node;
    var out = {};
    Object.keys(node).forEach(function (k) {
      if (k === "additionalProperties") return;
      if (k === "type" && Array.isArray(node[k])) { out[k] = "string"; return; }
      out[k] = toGeminiSchema(node[k]);
    });
    return out;
  }

  var PROVIDERS = {
    anthropic: {
      id: "anthropic",
      label: "Anthropic (Claude)",
      defaultModel: "claude-opus-5",
      keyPlaceholder: "sk-ant-…",
      keyLabel: "Anthropic API key",
      signupUrl: "https://platform.claude.com/",
      requiresBaseUrl: false,
      buildVisionRequest: function (o) {
        var content = o.images.map(function (u) {
          var s = splitDataUrl(u);
          return s && { type: "image", source: { type: "base64", media_type: s.mimeType, data: s.data } };
        }).filter(Boolean);
        content.push({ type: "text", text: o.promptText });
        return {
          url: o.baseUrl || "https://api.anthropic.com/v1/messages",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": o.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
          },
          body: {
            model: o.model,
            max_tokens: o.maxTokens,
            output_config: { format: { type: "json_schema", schema: o.schema } },
            messages: [{ role: "user", content: content }]
          }
        };
      },
      extractVisionText: function (json) {
        if (json.stop_reason === "refusal") throw new Error("The AI declined to analyze these photos.");
        if (json.stop_reason === "max_tokens") throw new Error("Analysis was cut short — try fewer photos.");
        var text = null;
        (json.content || []).forEach(function (b) { if (b.type === "text" && text == null) text = b.text; });
        if (!text) throw new Error("The AI returned no analysis.");
        return text;
      }
    },

    openai: {
      id: "openai",
      label: "OpenAI (ChatGPT)",
      defaultModel: "gpt-5.6",
      keyPlaceholder: "sk-…",
      keyLabel: "OpenAI API key",
      signupUrl: "https://platform.openai.com/api-keys",
      requiresBaseUrl: false,
      buildVisionRequest: function (o) {
        var content = o.images.map(function (u) { return { type: "image_url", image_url: { url: u } }; });
        content.push({ type: "text", text: o.promptText });
        return {
          url: o.baseUrl || "https://api.openai.com/v1/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + o.apiKey },
          body: {
            model: o.model,
            max_tokens: o.maxTokens,
            response_format: { type: "json_schema", json_schema: { name: "photo_scan_result", schema: o.schema, strict: true } },
            messages: [{ role: "user", content: content }]
          }
        };
      },
      extractVisionText: function (json) {
        var choice = (json.choices || [])[0];
        if (!choice) throw new Error("The AI returned no analysis.");
        if (choice.finish_reason === "content_filter") throw new Error("The AI declined to analyze these photos.");
        if (choice.finish_reason === "length") throw new Error("Analysis was cut short — try fewer photos.");
        var text = choice.message && choice.message.content;
        if (!text) throw new Error("The AI returned no analysis.");
        return text;
      }
    },

    gemini: {
      id: "gemini",
      label: "Google (Gemini)",
      defaultModel: "gemini-3.5-flash",
      keyPlaceholder: "AIza…",
      keyLabel: "Gemini API key",
      signupUrl: "https://aistudio.google.com/apikey",
      requiresBaseUrl: false,
      buildVisionRequest: function (o) {
        var parts = o.images.map(function (u) {
          var s = splitDataUrl(u);
          return s && { inlineData: { mimeType: s.mimeType, data: s.data } };
        }).filter(Boolean);
        parts.push({ text: o.promptText });
        return {
          url: o.baseUrl || "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(o.model) + ":generateContent",
          headers: { "Content-Type": "application/json", "x-goog-api-key": o.apiKey },
          body: {
            contents: [{ parts: parts }],
            generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(o.schema) }
          }
        };
      },
      extractVisionText: function (json) {
        if (json.promptFeedback && json.promptFeedback.blockReason) throw new Error("The AI declined to analyze these photos.");
        var cand = (json.candidates || [])[0];
        if (!cand) throw new Error("The AI returned no analysis.");
        if (cand.finishReason === "MAX_TOKENS") throw new Error("Analysis was cut short — try fewer photos.");
        var text = ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ""; }).join("");
        if (!text) throw new Error("The AI returned no analysis.");
        return text;
      }
    },

    perplexity: {
      id: "perplexity",
      label: "Perplexity",
      defaultModel: "sonar",
      keyPlaceholder: "pplx-…",
      keyLabel: "Perplexity API key",
      signupUrl: "https://www.perplexity.ai/settings/api",
      requiresBaseUrl: false,
      buildVisionRequest: function (o) {
        var content = o.images.map(function (u) { return { type: "image_url", image_url: { url: u } }; });
        content.push({ type: "text", text: o.promptText });
        return {
          url: o.baseUrl || "https://api.perplexity.ai/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + o.apiKey },
          body: {
            model: o.model,
            max_tokens: o.maxTokens,
            response_format: { type: "json_schema", json_schema: { schema: o.schema } },
            messages: [{ role: "user", content: content }]
          }
        };
      },
      extractVisionText: function (json) {
        var choice = (json.choices || [])[0];
        if (!choice) throw new Error("The AI returned no analysis.");
        if (choice.finish_reason === "length") throw new Error("Analysis was cut short — try fewer photos.");
        var text = choice.message && choice.message.content;
        if (!text) throw new Error("The AI returned no analysis.");
        return text;
      }
    },

    custom: {
      id: "custom",
      label: "Custom (OpenAI-compatible)",
      defaultModel: "",
      keyPlaceholder: "API key (if required)",
      keyLabel: "API key",
      signupUrl: null,
      requiresBaseUrl: true,
      buildVisionRequest: function (o) {
        if (!o.baseUrl) throw new Error("A base URL is required for the custom provider.");
        var content = o.images.map(function (u) { return { type: "image_url", image_url: { url: u } }; });
        content.push({ type: "text", text: o.promptText });
        var headers = { "Content-Type": "application/json" };
        if (o.apiKey) headers.Authorization = "Bearer " + o.apiKey;
        return {
          url: o.baseUrl,
          headers: headers,
          body: {
            model: o.model,
            max_tokens: o.maxTokens,
            response_format: { type: "json_schema", json_schema: { name: "photo_scan_result", schema: o.schema } },
            messages: [{ role: "user", content: content }]
          }
        };
      },
      extractVisionText: function (json) {
        var choice = (json.choices || [])[0];
        if (!choice) throw new Error("The AI returned no analysis.");
        var text = choice.message && choice.message.content;
        if (!text) throw new Error("The AI returned no analysis.");
        return text;
      }
    }
  };

  function listProviders() {
    return Object.keys(PROVIDERS).map(function (id) {
      var p = PROVIDERS[id];
      return {
        id: p.id, label: p.label, defaultModel: p.defaultModel,
        keyPlaceholder: p.keyPlaceholder, keyLabel: p.keyLabel,
        signupUrl: p.signupUrl, requiresBaseUrl: p.requiresBaseUrl
      };
    });
  }

  function getProvider(id) {
    var p = PROVIDERS[id];
    if (!p) throw new Error("Unknown AI provider: " + id);
    return p;
  }

  /*
   * analyzeImages(opts) -> Promise<object>
   * opts: { providerId, apiKey, model, baseUrl, images: [dataUrl...], schema, promptText, maxTokens }
   * Resolves with the parsed JSON object the model returned (NOT yet
   * sanitized/validated — that stays the caller's job, e.g. photo-ai.js).
   */
  function analyzeImages(opts) {
    var provider = getProvider(opts.providerId);
    var req;
    try {
      req = provider.buildVisionRequest(opts);
    } catch (e) {
      return Promise.reject(e);
    }
    return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error("That API key was rejected — check it in Settings.");
        if (r.status === 429) throw new Error("Rate limited — wait a minute and try again.");
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (body) { throw jsonError(r.status, body); });
        }
        return r.json();
      })
      .then(function (json) {
        var text = provider.extractVisionText(json);
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error("The AI returned an unreadable response.");
        }
      });
  }

  var api = { PROVIDERS: PROVIDERS, listProviders: listProviders, getProvider: getProvider, analyzeImages: analyzeImages };
  root.AIProviders = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
