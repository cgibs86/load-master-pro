/*
 * LoadMaster Pro AI — RebateIQ.
 *
 * Searches the live web for the grants, tax credits, utility rebates and
 * income-qualified programs that actually apply to ONE address and ONE
 * proposed system, and turns them into a homeowner-facing summary with a
 * working "apply here" link on every line.
 *
 * Why this is worth a network round trip instead of a lookup table: incentive
 * programs are the most volatile data in this industry. Utility rebates change
 * seasonally, state IRA programs launched on staggered dates, and budgets run
 * out mid-year. A table baked into the app would be wrong within a quarter and
 * would be wrong silently. So this reads the web at the moment of the quote,
 * cites every figure, and refuses to invent the ones it cannot find.
 *
 * Money stated to a homeowner has to be defensible, so the rules are strict:
 *   - No amount without a source URL that was actually retrieved.
 *   - Nothing that cannot be tied to this address's state, utility or city.
 *   - Expired programs are dropped, not reported hopefully.
 *   - Everything is marked as needing verification before it reaches a
 *     contract, because a rebate quoted and then denied is the rep's problem.
 *
 * Transport (which provider, which web-search mechanism) lives in
 * ai-providers.js; this file owns the prompt, the shape, and the validation.
 *
 * Exposed as window.RebateIQ (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  var PROGRAM_TYPES = ["federal-tax-credit", "state-rebate", "utility-rebate", "local-rebate", "grant", "income-qualified", "financing", "manufacturer"];
  var TYPE_LABEL = {
    "federal-tax-credit": "Federal tax credit",
    "state-rebate": "State rebate",
    "utility-rebate": "Utility rebate",
    "local-rebate": "City / county rebate",
    "grant": "Grant",
    "income-qualified": "Income-qualified program",
    "financing": "Low-interest financing",
    "manufacturer": "Manufacturer rebate"
  };

  var SYSTEM_PROMPT = [
    "You are an incentives research assistant for a licensed HVAC contractor who is",
    "standing in a homeowner's kitchen preparing a quote. Your job is to find every",
    "grant, tax credit, rebate, and income-qualified program that could reduce the",
    "cost of THIS heating/cooling installation at THIS address.",
    "",
    "Use web search. Cover all of these levels and say which is which:",
    "1. FEDERAL — the 25C Energy Efficient Home Improvement Credit (heat pumps, central",
    "   AC, furnaces) and 25D, plus any IRA Home Energy Rebate programs (HEAR / HOMES)",
    "   as actually implemented in this state. State launch dates differ; check whether",
    "   this state's program is open to applications right now.",
    "2. STATE — the state energy office / housing authority efficiency programs.",
    "3. UTILITY — first work out which electric utility and which gas utility serve",
    "   this specific address (investor-owned, municipal, or co-op — they differ inside",
    "   one city), then find that utility's residential HVAC rebate program.",
    "4. LOCAL — city or county programs, and municipal utility programs.",
    "5. INCOME-QUALIFIED — Weatherization Assistance Program, LIHEAP-linked HVAC",
    "   replacement, and utility low-income programs, flagged clearly as income-tested.",
    "6. MANUFACTURER / distributor seasonal rebates, only if a current one is found.",
    "",
    "STRICT RULES — a wrong number here costs the contractor the job:",
    "1. NEVER invent a program, an amount, a deadline, or a URL. If you cannot confirm",
    "   it from a page you actually retrieved, leave the field null. Returning few",
    "   programs is correct; returning invented ones is a serious failure.",
    "2. Every program MUST carry a `source` URL you actually retrieved, and an",
    "   `applyUrl` pointing at the page where a homeowner or contractor starts the",
    "   application. If you only have one of the two, repeat it in both fields.",
    "3. Only include programs plausibly available at THIS address. Do not list another",
    "   state's program, or a utility that does not serve this address.",
    "4. EXCLUDE programs whose deadline has passed or whose funding is documented as",
    "   exhausted. If status is uncertain, include it and say so in `status`.",
    "5. Amounts: put the dollar figure in `amountMax` (a number, no symbols or commas)",
    "   when there is a stated cap, and always write the human phrasing in `amountText`",
    "   (for example \"30% of project cost, up to $2,000\"). Use null when unknown.",
    "6. `requirements` must state what the EQUIPMENT has to meet (for example a SEER2",
    "   or HSPF2 minimum, or ENERGY STAR certification), since the contractor has to",
    "   pick equipment that qualifies.",
    "7. Respond with ONLY one JSON object. No prose, no markdown, no code fences."
  ].join("\n");

  var SCHEMA_HINT = JSON.stringify({
    address: { city: null, county: null, state: null, zip: null },
    utilities: { electric: null, gas: null, note: null },
    programs: [{
      name: "",
      administrator: "",
      type: "utility-rebate",
      amountMax: null,
      amountText: "",
      requirements: "",
      eligibility: "",
      incomeQualified: false,
      stackable: null,
      deadline: null,
      status: "",
      howToApply: "",
      applyUrl: "",
      source: ""
    }],
    totalEstimateText: null,
    homeownerSummary: "",
    confidence: "low",
    notes: null
  }, null, 2);

  /*
   * The system being quoted changes which programs apply — most heat-pump
   * money is unavailable to a straight AC swap, and nearly every program sets
   * an efficiency floor. Sending the plan avoids a list the rep has to
   * hand-filter at the table.
   */
  function buildUserPrompt(ctx) {
    var c = ctx || {};
    var lines = [
      "Property address: " + (c.address || "unknown"),
      "City: " + (c.city || "unknown") + " | County: " + (c.county || "unknown") +
        " | State: " + (c.state || "unknown") + " | ZIP: " + (c.postcode || "unknown"),
      ""
    ];
    if (c.systemType || c.tons || c.seer2 || c.hspf2) {
      lines.push("Proposed installation:");
      if (c.systemType) lines.push("- System: " + c.systemType);
      if (c.tons) lines.push("- Size: " + c.tons + " ton");
      if (c.seer2) lines.push("- Cooling efficiency: " + c.seer2 + " SEER2");
      if (c.hspf2) lines.push("- Heating efficiency: " + c.hspf2 + " HSPF2");
      if (c.existingAge) lines.push("- Replacing equipment roughly " + c.existingAge + " years old");
      lines.push("");
    }
    lines.push(
      "Find every currently-open grant, tax credit, rebate and income-qualified program",
      "that could apply to this installation at this address. Work out which electric and",
      "gas utilities actually serve this address before looking for utility rebates.",
      "",
      "Write `homeownerSummary` as 2-4 plain sentences the contractor can read aloud to",
      "the homeowner: what they are likely to qualify for, roughly what it is worth, and",
      "what they have to do next. No jargon, no hedging language beyond what is true.",
      "",
      "Return ONLY this JSON object (null for anything you could not confirm):",
      SCHEMA_HINT
    );
    return lines.join("\n");
  }

  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v !== "string") return null;
    var n = Number(v.replace(/[$,\s]/g, ""));
    return isFinite(n) ? n : null;
  }
  function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max || 400) : ""; }

  // Only http(s). A model-authored link is going straight into an anchor a
  // homeowner clicks, so javascript:, data: and friends must never survive.
  function safeUrl(v) {
    var u = str(v, 600);
    if (!/^https?:\/\/[^\s]+$/i.test(u)) return null;
    return u;
  }

  /*
   * Drop anything that cannot be presented honestly. A program with no
   * source, or with no name, is not evidence of money — it is a liability, so
   * it never reaches the card.
   */
  function sanitize(raw, opts) {
    var o = opts || {};
    var out = {
      address: {
        city: str(raw && raw.address && raw.address.city, 80) || null,
        county: str(raw && raw.address && raw.address.county, 80) || null,
        state: str(raw && raw.address && raw.address.state, 80) || null,
        zip: str(raw && raw.address && raw.address.zip, 20) || null
      },
      utilities: {
        electric: str(raw && raw.utilities && raw.utilities.electric, 120) || null,
        gas: str(raw && raw.utilities && raw.utilities.gas, 120) || null,
        note: str(raw && raw.utilities && raw.utilities.note, 300) || null
      },
      programs: [],
      dropped: 0,
      totalEstimateText: str(raw && raw.totalEstimateText, 200) || null,
      homeownerSummary: str(raw && raw.homeownerSummary, 1200),
      confidence: ["high", "medium", "low"].indexOf(raw && raw.confidence) >= 0 ? raw.confidence : "low",
      notes: str(raw && raw.notes, 600) || null
    };

    var seen = {};
    (raw && Array.isArray(raw.programs) ? raw.programs : []).forEach(function (p) {
      if (!p || typeof p !== "object") { out.dropped++; return; }
      var name = str(p.name, 160);
      var source = safeUrl(p.source);
      var applyUrl = safeUrl(p.applyUrl) || source;
      // No name or no retrievable source means it cannot be verified, and an
      // unverifiable dollar figure must never be shown to a homeowner.
      if (!name || !source) { out.dropped++; return; }
      var key = name.toLowerCase() + "|" + source;
      if (seen[key]) { out.dropped++; return; }
      seen[key] = 1;

      var type = PROGRAM_TYPES.indexOf(p.type) >= 0 ? p.type : "utility-rebate";
      var amountMax = num(p.amountMax);
      if (amountMax != null && (amountMax <= 0 || amountMax > 100000)) amountMax = null;

      out.programs.push({
        name: name,
        administrator: str(p.administrator, 160),
        type: type,
        typeLabel: TYPE_LABEL[type] || "Incentive",
        amountMax: amountMax,
        amountText: str(p.amountText, 200),
        requirements: str(p.requirements, 500),
        eligibility: str(p.eligibility, 500),
        incomeQualified: p.incomeQualified === true,
        stackable: p.stackable === true ? true : (p.stackable === false ? false : null),
        deadline: str(p.deadline, 120) || null,
        status: str(p.status, 160),
        howToApply: str(p.howToApply, 600),
        applyUrl: applyUrl,
        source: source
      });
    });

    // Biggest confirmed money first — that is the order a rep wants to talk in.
    out.programs.sort(function (a, b) {
      if (a.incomeQualified !== b.incomeQualified) return a.incomeQualified ? 1 : -1;
      return (b.amountMax || 0) - (a.amountMax || 0);
    });

    out.sources = (o.sources || []).filter(function (s) { return s && safeUrl(s.url); })
      .map(function (s) { return { title: str(s.title, 200) || s.url, url: safeUrl(s.url) }; });
    out.totals = totals(out.programs);
    out.searchedAt = Date.now();
    return out;
  }

  /*
   * Two totals, deliberately.
   *
   * `capped` sums only programs with a stated cap AND no income test — the
   * number a rep can say out loud to a typical homeowner. `withIncome` adds
   * the income-qualified programs, which are often the largest amounts but
   * only reach a minority of households; quoting them by default would
   * routinely overstate what a given family gets.
   */
  function totals(programs) {
    var capped = 0, withIncome = 0, counted = 0, unknown = 0;
    (programs || []).forEach(function (p) {
      if (p.amountMax == null) { unknown++; return; }
      withIncome += p.amountMax;
      if (!p.incomeQualified) { capped += p.amountMax; counted++; }
    });
    return {
      capped: capped, withIncome: withIncome,
      countedPrograms: counted, unknownAmountPrograms: unknown,
      total: (programs || []).length
    };
  }

  /*
   * search(ctx, settings) -> Promise<sanitized result>
   * ctx: { address, city, county, state, postcode, systemType, tons, seer2, hspf2, existingAge }
   * settings: the app's Settings object (aiProvider / aiApiKey / aiModel / aiBaseUrl)
   */
  function search(ctx, settings, hooks) {
    settings = settings || {};
    hooks = hooks || {};
    var providerId = settings.aiProvider || "anthropic";
    var AP = root.AIProviders;
    if (!AP) return Promise.reject(new Error("AI provider layer unavailable."));
    if (!settings.aiApiKey) return Promise.reject(new Error("Add an AI provider API key in Settings to use RebateIQ."));
    var provider = AP.getProvider(providerId);
    return AP.research({
      providerId: providerId,
      apiKey: settings.aiApiKey,
      model: settings.aiModel || provider.defaultModel,
      baseUrl: settings.aiBaseUrl,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(ctx),
      maxTokens: 8000,
      maxSearches: 10,
      onStep: hooks.onStep,
      fetchImpl: hooks.fetchImpl
    }).then(function (res) {
      return sanitize(res.data, { sources: res.sources });
    });
  }

  root.RebateIQ = {
    search: search,
    PROGRAM_TYPES: PROGRAM_TYPES,
    TYPE_LABEL: TYPE_LABEL,
    _sanitize: sanitize,
    _totals: totals,
    _safeUrl: safeUrl,
    _buildUserPrompt: buildUserPrompt,
    _SYSTEM_PROMPT: SYSTEM_PROMPT
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RebateIQ;
})(typeof window !== "undefined" ? window : globalThis);
