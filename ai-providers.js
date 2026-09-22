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

  /* ---------- Web research (RebateIQ) ----------
   *
   * Kept separate from the PROVIDERS table above rather than folded into each
   * entry, because the split is real: the vision path is "send pixels, get
   * schema-validated JSON", and the research path is "run live web searches,
   * get prose containing JSON". Notably NO provider combines live search with
   * strict JSON-schema enforcement in a single call, so every path here asks
   * for JSON in the prompt and parses it out of whatever comes back. Providers
   * absent from this table simply don't support research, and the UI says so
   * instead of silently returning nothing.
   */
  var RESEARCH = {
    anthropic: {
      // Server-side tool that runs a multi-step loop; it pauses when it hits
      // the per-response cap and the caller re-sends to resume.
      build: function (o) {
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
            max_tokens: o.maxTokens || 8000,
            system: o.systemPrompt,
            tools: [{ type: "web_search_20260209", name: "web_search", max_uses: o.maxSearches || 8 }],
            messages: (o.priorTurns || []).concat([{ role: "user", content: o.userPrompt }])
          }
        };
      },
      extract: function (json) {
        var text = "", sources = [], seen = {};
        (json.content || []).forEach(function (b) {
          if (!b || !b.type) return;
          if (b.type === "text" && typeof b.text === "string") {
            text += b.text;
            (b.citations || []).forEach(function (c) {
              if (c && c.url && !seen[c.url]) { seen[c.url] = 1; sources.push({ title: c.title || c.url, url: c.url }); }
            });
          } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
            b.content.forEach(function (r) {
              if (r && r.type === "web_search_result" && r.url && !seen[r.url]) {
                seen[r.url] = 1; sources.push({ title: r.title || r.url, url: r.url });
              }
            });
          }
        });
        return { text: text, sources: sources, paused: json.stop_reason === "pause_turn", turn: json.content };
      }
    },

    openai: {
      // Web search lives on the Responses API — a different endpoint from the
      // Chat Completions one the vision path uses.
      build: function (o) {
        return {
          url: "https://api.openai.com/v1/responses",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + o.apiKey },
          body: { model: o.model, instructions: o.systemPrompt, input: o.userPrompt, tools: [{ type: "web_search" }] }
        };
      },
      extract: function (json) {
        var text = "", sources = [], seen = {};
        (json.output || []).forEach(function (item) {
          if (item.type !== "message") return;
          (item.content || []).forEach(function (c) {
            if (typeof c.text === "string") text += c.text;
            (c.annotations || []).forEach(function (a) {
              if (a && a.type === "url_citation" && a.url && !seen[a.url]) {
                seen[a.url] = 1; sources.push({ title: a.title || a.url, url: a.url });
              }
            });
          });
        });
        return { text: text, sources: sources };
      }
    },

    gemini: {
      build: function (o) {
        return {
          url: "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(o.model) + ":generateContent",
          headers: { "Content-Type": "application/json", "x-goog-api-key": o.apiKey },
          body: {
            contents: [{ parts: [{ text: o.systemPrompt + "\n\n" + o.userPrompt }] }],
            tools: [{ google_search: {} }]
          }
        };
      },
      extract: function (json) {
        var cand = (json.candidates || [])[0];
        var text = cand ? ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ""; }).join("") : "";
        var chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
        var sources = chunks.filter(function (c) { return c && c.web && c.web.uri; })
          .map(function (c) { return { title: c.web.title || c.web.uri, url: c.web.uri }; });
        return { text: text, sources: sources };
      }
    },

    perplexity: {
      // Sonar models search on every request; there is no tool to enable.
      build: function (o) {
        return {
          url: "https://api.perplexity.ai/chat/completions",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + o.apiKey },
          body: {
            model: o.model,
            messages: [{ role: "system", content: o.systemPrompt }, { role: "user", content: o.userPrompt }]
          }
        };
      },
      extract: function (json) {
        var text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "";
        var sources = (json.citations || []).map(function (u) { return { title: u, url: u }; });
        return { text: text, sources: sources };
      }
    }
  };

  function supportsResearch(id) { return !!RESEARCH[id]; }

  /*
   * Pull a JSON object out of model text that may carry stray prose or a
   * ```json fence around it. Every research path needs this, because none of
   * them can enforce a schema while searching.
   */
  function extractJson(text) {
    if (!text || typeof text !== "string") return null;
    var t = text.trim();
    try { return JSON.parse(t); } catch (e) {}
    var fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch (e) {} }
    var first = t.indexOf("{"), last = t.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try { return JSON.parse(t.slice(first, last + 1)); } catch (e) {}
    }
    return null;
  }

  /*
   * research(opts) -> Promise<{ data, sources, text }>
   * opts: { providerId, apiKey, model, baseUrl, systemPrompt, userPrompt,
   *         maxTokens, maxSearches, onStep }
   *
   * Resolves with the parsed JSON object the model returned plus every source
   * URL the search actually retrieved. Validation stays the caller's job.
   */
  function research(opts) {
    var spec = RESEARCH[opts.providerId];
    if (!spec) {
      return Promise.reject(new Error(
        "Web research isn't available on " + (PROVIDERS[opts.providerId] ? PROVIDERS[opts.providerId].label : opts.providerId) +
        ". Switch to Anthropic, OpenAI, Gemini or Perplexity in Settings."));
    }
    var fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) return Promise.reject(new Error("No fetch available."));

    var allSources = [], seen = {}, allText = "";
    function addSources(list) {
      (list || []).forEach(function (s) { if (s && s.url && !seen[s.url]) { seen[s.url] = 1; allSources.push(s); } });
    }

    // Anthropic's tool loop can pause; everyone else answers in one shot.
    function step(priorTurns, depth) {
      var req = spec.build(Object.assign({}, opts, { priorTurns: priorTurns }));
      return fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) throw new Error("That API key was rejected — check it in Settings.");
          if (r.status === 429) throw new Error("Rate limited — wait a minute and try again.");
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (body) { throw jsonError(r.status, body); });
          }
          return r.json();
        })
        .then(function (json) {
          var out = spec.extract(json);
          allText += out.text || "";
          addSources(out.sources);
          if (out.paused && depth < 5) {
            if (opts.onStep) opts.onStep(depth + 1);
            return step((priorTurns || []).concat([{ role: "assistant", content: out.turn }]), depth + 1);
          }
          return null;
        });
    }

    return step(null, 0).then(function () {
      var data = extractJson(allText);
      if (!data) throw new Error("The research came back unreadable. Try again, or switch providers in Settings.");
      return { data: data, sources: allSources, text: allText };
    });
  }

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

  var api = {
    PROVIDERS: PROVIDERS, listProviders: listProviders, getProvider: getProvider, analyzeImages: analyzeImages,
    research: research, supportsResearch: supportsResearch, extractJson: extractJson, RESEARCH: RESEARCH
  };
  root.AIProviders = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
