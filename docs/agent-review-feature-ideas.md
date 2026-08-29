# Proprietary Feature Ideas — Synthesized from the 9-Area Agent Review

Source: nine sub-agents each audited one workflow area of LoadMaster Pro AI
(address/geocode, TrueClimate, core load-calc engine, equipment sizing,
PhotoScan AI, PermitIQ, report generation, settings/accounts, landing/PWA)
and brainstormed proprietary, tier-gated feature ideas. This document merges
their ~40 raw ideas into a de-duplicated, prioritized set, organized by which
tier each belongs on. **Fleet ($129/mo) gets the most attention** because
today it is Pro + seats/ops perks with no capability a solo Pro user can't
already get — closing that gap was the standing brief for every sub-agent.

Architecture reminder for every feasibility note below: LoadMaster Pro AI is
a static PWA (vanilla JS, no build step, no framework) plus **one** small
Node server (`serve.cjs` + `api/permit-search.cjs`) that today does one job —
proxy an AI permit-search call. "Needs a backend" below means extending
*that* server with a small persistence layer (flat file, SQLite, or a hosted
KV store) — not standing up a new platform. Anything not flagged that way is
buildable entirely client-side, the same way `climate-data.js` and
`permits-data.js` already ship curated static data with no server at all.

---

## Top picks overall (across all tiers)

| # | Idea | Tier | Why it wins |
|---|------|------|-------------|
| 1 | **Verified Jurisdiction Ledger** | Fleet | Turns an already-built-but-unwired backend (`api/permit-search.cjs`) into a genuine, usage-compounding data moat — the strongest Fleet-exclusive candidate found. |
| 2 | **Fleet Command Center** (standards, QA flags, shared credentials, crew rollups) | Fleet | Directly answers "what does a 5th seat get you that a 4th didn't" — cross-crew oversight is structurally impossible below Fleet. |
| 3 | **Shared Team Job & Property Ledger + Batch Dispatch** | Fleet | Same logic — team memory and multi-address dispatch only exist once there's a team. |
| 4 | **Verified Report Seal** (tamper-evident + Manual S compliance stamp) | Pro/Fleet | Closes a real liability/trust gap and is cheap to build once report data already exists. |
| 5 | **Second-Opinion Oversizing Check** | Pro | Near-zero engineering cost (reuses `sizeFor`/`oversizePct` already in `loadcalc.js`), directly wins bids. |
| 6 | **PhotoScan Upsell Radar** | Pro | One extra schema field on a vision call the app already makes — turns a load-calc visit into a lead-gen visit at ~zero marginal cost. |
| 7 | **Heat Pump vs. Dual-Fuel Operating-Cost Comparator** | Pro | Reuses the already-computed but underused `balancePoint()` curve for a dollars-and-cents sales argument. |
| 8 | **TrueClimate Extended Analytics** (decade stress test + future-sizing trend) | Pro | Makes the TrueClimate engine's live per-address data do more work it's already fetching. |

---

## Fleet tier — closing the "no unique capability" gap

Fleet's problem isn't a lack of ideas, it's that almost every "team" feature
proposed across the nine reports collapses into one of three real
capabilities: **shared code/permit intelligence**, **cross-crew
standards & oversight**, and **shared job/property memory**. Below they're
merged into three flagship Fleet features rather than presented as a dozen
overlapping cards.

### 1. Verified Jurisdiction Ledger (crowd-verified PermitIQ)
*Merges: "Verified Jurisdiction Ledger", "Code-Change Watchlist", "AHJ
Intelligence Network", "PermitIQ Rejection Ledger" (4 separate reports
proposed close variants of this independently).*

- **What**: `api/permit-search.cjs` already does AI-sourced, per-jurisdiction
  permit research (setbacks, SEER2/HSPF2 minimums, sound limits, department
  contacts, cited sources) — but the client **never calls it** (confirmed by
  grep; this is issue #1 in the PermitIQ audit, listed as `issuesNotFixed`
  below). Wiring that call up is the prerequisite. Once live, cache every
  result (city+state → result + timestamp + sources) in a small store behind
  the existing Node server. Every search silently strengthens the shared
  cache. Let Fleet accounts also log a one-tap real-world outcome ("approved
  as-is" / "kickback: needed X") after a permit is actually submitted, and
  surface a "this jurisdiction's rules recently changed" or "6 of the last
  10 submissions here were kicked back for X" notice.
- **Why Fleet**: accuracy and coverage compound with query volume, which
  only a multi-seat, multi-market account generates at the scale needed. A
  single-seat competitor's AI-search feature can't replicate the freshness
  without the same volume — this is a real, compounding data moat built from
  the install base, not a licensable dataset.
- **Feasibility**: Medium. The AI-search plumbing already exists; the new
  work is (a) actually calling it from the client and (b) a small
  persistent cache/outcome-log in the existing Node server (flat file or
  SQLite is enough at this scale — no new infra vendor).

### 2. Fleet Command Center (standards, QA, shared credentials, crew rollups)
*Merges: "Fleet Standardized Load-Calc Playbook & Cross-Crew QA Flags",
"Fleet Sizing Standards & Crew QA Dashboard", "Fleet PhotoScan Command
Center", "Fleet Command Vault", "Fleet Crew Leaderboard & Close-Rate
Attribution" — five reports converged on variations of the same thing.*

- **What**: an owner-configured layer above individual seats:
  - **Company defaults** every tech's calc starts from (e.g. "always sealed
    ducts," a house sizing-tier mapping) instead of generic per-tier
    defaults.
  - **QA flags** when a tech's overrides deviate far from company defaults
    or from the professional 624–3,325 ft²/ton band already validated in
    `tests/manual-j-benchmarks.js` — surfaced to the office, not just the
    field.
  - **Shared credentials vault**: RentCast/AI provider keys and branding
    pushed once by the owner and pulled by every seat via a join code, so
    offboarding a tech doesn't require rotating a key they could see in
    Settings today (a real problem: Settings currently shows any user's raw
    saved API key in plaintext-adjacent form).
  - **Crew rollup dashboard**: per-tech job counts, oversize-% distribution,
    return-air pass/fail rate, and (if outcomes are tagged) close rate — a
    coaching and audit tool.
- **Why Fleet**: every piece of this is *impossible* to offer a solo user by
  definition — it requires comparing/constraining behavior across seats. It
  turns "load calc app" into "company-wide consistency and QA tool," which
  is the actual pain multi-crew shops have that seats alone don't solve.
- **Feasibility**: Medium. Needs a per-org settings/credentials store and an
  append-only metadata log (tons, oversize%, return-air result, job counts —
  not full customer PII) in the existing Node server. More than a static
  PWA feature, but a bounded, incremental extension of what's there, not a
  platform rebuild.

### 3. Shared Team Job & Property Ledger + Batch Dispatch
*Merges: "Shared Team Property Ledger", "Team Job Roster & Portfolio Report
Export", "Fleet Batch Site Import & Dispatch".*

- **What**: today "recent jobs" is per-browser `localStorage`
  (`loadHistory()`/`HISTORY_KEY`), invisible to teammates. Add an
  account-level job/property store keyed by geo-fingerprint so any seat
  that looks up an address a colleague already surveyed sees the prior
  calc/photos/permit status instantly. Layer on: (a) batch address
  import + throttled geocode + per-seat assignment for subdivision/portfolio
  jobs, and (b) one-click multi-job portfolio report export (a builder's
  whole subdivision, a property manager's unit list) for a single lender/HOA
  submission.
- **Why Fleet**: "a team has memory a solo contractor structurally can't" is
  a clean, honest Fleet-only value prop, and prevents duplicate site visits
  that cost real technician hours.
- **Feasibility**: Medium. The report-batching and geocode-throttling parts
  are straightforward client-side reuse; the shared store across
  seats/devices is genuinely new backend surface (an account-scoped job
  table) on the existing Node server.

### Smaller Fleet-only ideas (lower priority, still real)
- **Territory TrueClimate Offline Bundle** — pre-fetch/cache full live
  TrueClimate profiles for a Fleet account's whole declared service
  territory (not just the ~74-city fallback table) so field crews get
  live-quality design conditions with zero connectivity. High feasibility
  single-device (service worker + IndexedDB); cross-device sync needs the
  same small server extension as above.
- **Pre-Install Weather-Risk Callback Alerts** — compare a job's design
  values against the live short-term forecast near completion and alert
  dispatch ("confirm backup heat kit before leaving site"). Needs Web Push
  (VAPID keys + subscription store) — real but modest new infra; lowest
  priority of the Fleet ideas since it needs the most new plumbing for the
  narrowest payoff.

---

## Pro tier — deepen the flagship features already sold

### Verified Report Seal (tamper-evident + Manual S compliance stamp)
*Merges: "Verified Report Ledger", "Verified Report Seal", "Warranty
Defense Packet", "Manual S Compliance Certificate".*
Stamp every generated report with a signed verification code (HMAC or a
client-side SHA-256 hash via Web Crypto over the report's key figures +
photos + timestamp), rendered as a QR code, plus an explicit "ACCA Manual S
compliant sizing" badge showing where the selection sits in the 90–115%
band. Gives contractors defensible, permit/warranty-ready documentation a
plain PDF competitor can't produce. **Feasibility: high** — fully
client-side if self-verifying (HMAC/hash only, no lookup needed); a
scan-to-verify web page needs a tiny endpoint on the existing server, but
even that's optional for v1.

### Second-Opinion Oversizing Check
Enter a competing bid's tonnage; the app compares it against the calculated
load using `sizeFor`/`oversizePct` logic already in `loadcalc.js` plus the
624–3,325 ft²/ton professional band already validated in the benchmark
suite, producing a plain-language, load-calc-backed rebuttal to "bigger
feels safer" competitor quotes. **Feasibility: very high** — pure UI +
arithmetic reuse, a day or two of work.

### PhotoScan Upsell Radar
Extend the existing vision-analysis schema (same photos, same API call) to
flag revenue conditions: window AC units, single-pane windows, visible duct
leakage, missing attic baffles, undersized returns — rendered as a distinct
"Opportunities spotted" section in-app and on the report. **Feasibility:
very high** — a schema/prompt/render change, zero new infrastructure.

### Heat Pump vs. Dual-Fuel Operating-Cost Comparator
Feed contractor-entered utility rates ($/kWh, $/therm) through the already-
computed `balancePoint()` load-vs-capacity curve to estimate annual heating
cost for heat-pump-only vs. dual-fuel vs. gas-furnace configurations — a
concrete dollars argument for the higher-margin system. **Feasibility:
medium** — a simplified bin-hours model needs representative temperature-
bin data added to the station table; a fully rigorous version can reuse the
same hourly archive fetch TrueClimate already makes.

### TrueClimate Extended Analytics
*Merges: "Decade Stress Test" and "Climate-Adjusted Future Sizing".* Pull
~10 years of the same free, keyless Open-Meteo archive data already used for
live design conditions, and report (a) the single worst hour/day the exact
address actually saw in a decade, and (b) a linear trend projecting 99%/1%
design temps forward 10–20 years, toggleable on the report. Lets a
contractor defend sizing against a real, address-specific worst case instead
of a 30-year-old regional table. **Feasibility: high** — same free API,
same percentile-reduction pattern already in `climate-engine.js`, just a
longer date range / more calls.

### Code-Verified Design Temps (TrueClimate × PermitIQ cross-check)
Cross-reference TrueClimate's live design temps against the jurisdiction's
code-adopted ASHRAE/IECC values (a curated table, same shape as
`permits-data.js`) and flag material discrepancies as an audit-ready note on
the permit-ready report. **Feasibility: medium** — needs a maintained
jurisdiction→code-design-value table; no backend change.

### AHJ & Climate-Zone Auto-Tag at Geocode
Run a point-in-polygon lookup against bundled AHJ boundary + IECC
climate-zone GeoJSON the instant an address resolves, so PermitIQ answers
are jurisdiction-accurate automatically — catching the common case where
Nominatim's city/county field is wrong for unincorporated areas with their
own permitting office. **Feasibility: high** — fully static, same pattern
as `climate-data.js`/`permits-data.js`.

### Pre-Quote Compliance Pre-Flight Check
Cross-reference the load calc's chosen equipment plan and PhotoScan findings
(e.g. pad placement vs. property line) against PermitIQ's minimums/checklist
*before* the contractor quotes, flagging concrete mismatches ("planned
equipment below the 14.3 SEER2 floor"). **Feasibility: high** — all three
inputs (`state.result`, `state.photoAI`, `window.PermitData`) are already in
memory together; this is a new comparison/render function only.

### Auto-Addressed Permit Email + Portal Prefill
Fixes a real broken promise: the "Email to permit dept." button currently
builds a `mailto:` with **no recipient at all** (see `issuesFixed` below for
the copy-level mitigation already applied). Once the permit-search backend
is actually wired in (see Fleet idea #1), its `department.email`/
`permitPortal` fields can auto-fill the recipient and, for known permitting
platforms (Accela, CityView, EnerGov, MyGov), deep-link into the portal with
fields prefilled. **Feasibility: low-effort once the backend call exists**
— the data is already in the (currently unused) API response schema.

### Curated Equipment Cross-Reference Database
Map calculated tonnage + system type + climate zone to real, AHRI-matched
current equipment (make/model/SEER2/HSPF2) so the recommendation names a
buildable system instead of just a number. **Feasibility: high to build**
(static JSON, same shipping pattern as other curated data) but has an
ongoing **content-maintenance cost**, not an engineering one — flag this to
whoever owns the idea before committing.

### License & Insurance Compliance Guard
Add license/E&O-insurance expiration fields to Settings; warn (and soft-gate
PermitIQ package generation) inside 30 days of expiry, and stamp current
license status on every report/permit email. **Feasibility: high** — new
Settings fields + a date comparison, zero backend.

### PhotoScan AI Before/After Proof Reel
Auto-compile the AI's evidence statements + before/after numbers into a
shareable image-sequence proof card the advisor can text the homeowner or
post to their Google Business profile. **Feasibility: high** — canvas/
HTML-to-image composition of data already in memory, no new API calls.

### Cross-Photo Consistency Auditor
Group photos exterior/interior, run findings extraction per group, diff
overlapping fields, and surface a "needs another photo" flag instead of
silently averaging conflicting reads. **Feasibility: medium** — two vision
calls instead of one plus new diff/UI logic, still client-side.

### Photo-Verified Return-Air Auto-Measure
Extend the vision prompt so a photo of the return grille/trunk auto-fills
the return-air check fields instead of manual measurement — pairs the
photo-AI pipeline with the (recently bug-fixed, see below) return-air
adequacy engineering check. **Feasibility: medium** — adds fields to the
existing vision schema and wires them into the existing `retAirMode`/
`retAirDuctIn`/`retAirGrilleW`/`H` overrides.

### PermitIQ Field Verification Score
Surface the app's own `tests/manual-j-benchmarks.js` validation data as an
on-report "Confidence Score" (e.g. "tracks published Manual J results within
±15%, validated against N audited homes"), which increases when the
contractor supplies real overrides (atticR, windowU/SHGC, ach) instead of a
tier guess. **Feasibility: high** — bake benchmark bands into a static
table; the real work is honestly calibrating the bands, not the plumbing.

### Address-Linked Utility & Rebate Finder
Cross-reference the resolved address against a curated utility-territory +
active rebate/incentive table and surface it immediately — "this utility
offers a $500 heat-pump rebate" — as an instant sales aid.
**Feasibility: high** to build (static, client-side); ongoing **content
curation** is the real cost.

---

## All tiers / lower priority

- **Device Handoff QR** — package the current settings/session blob into a
  short-lived encrypted QR or one-time server code for moving accounts
  between devices. Real pain (accounts are strictly per-device today), but
  not proprietary/differentiating — a churn-reduction utility, not a sales
  feature. **Feasibility: high.**
- **Live Install-Day Weather Risk Chip** — surface "this site runs 4°F
  colder than the county default a competitor's static-lookup tool would
  use" as a landing-page proof point. Presentation-only reuse of data
  TrueClimate already computes. **Feasibility: high.**

---

## Issues fixed during this review (context for the ideas above)

A few of the feature ideas above explicitly build on top of bugs the
accompanying code audit found and this pass fixed:

- **`api/permit-search.cjs` is fully built, tested, and routed, but the
  client never calls it** — confirmed by grep; this is the single biggest
  blocker to the #1 Fleet idea above (Verified Jurisdiction Ledger) and is
  left as `issuesNotFixed` (architecturally significant — needs a UI flow
  for triggering/displaying the AI search, loading states, and a decision
  on how results merge with the static `permits-data.js` fallback) for a
  follow-up task.
- **"Email to permit dept." had no recipient address at all** — the mailto
  copy/toast were corrected to stop implying it's pre-addressed; actually
  populating the recipient depends on the permit-search backend being wired
  up (see above).
- **Return-air grille check was ~33% too strict** (compared free area
  against a nominal-size threshold) — fixed in `loadcalc.js`, which directly
  de-risks the "Photo-Verified Return-Air Auto-Measure" idea above (it would
  otherwise have propagated the same bug into an automated flow).
- **Station-elevation fallback was hardcoded to 0 ft**, and the nearest-
  station distance was computed but never shown — both fixed, which
  directly informed the "Territory TrueClimate Offline Bundle" and "Live
  Install-Day Weather Risk Chip" feasibility notes above (the underlying
  station data is now actually trustworthy to build on).

See the accompanying review summary for the full list of issues fixed vs.
left open.
