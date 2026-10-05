# LoadMaster Pro AI

HVAC load calculator — an address-based residential heating & cooling load
estimator, built as an installable Progressive Web App (PWA).

Enter a street address and get an instant ACCA *Manual J*–style block-load
estimate (heating BTU/h, cooling BTU/h, and recommended A/C tonnage), with a
transparent breakdown. Works offline once installed.

The estimate also accounts for attic insulation R-value and duct
type/location/sealing condition, and includes an optional return-air sizing
check against the ~144 sq in/ton field rule — all entered when known and
falling back to sensible defaults when not.

**EnvelopeIQ** sharpens what "sensible default" means. Given a year built and
the IECC climate zone (derived on the fly from heating/cooling degree days in
the same year of hourly weather the design temperatures come from), the
calculator uses the attic R-value, window U-factor/SHGC and air-tightness the
energy code of that era actually required in that zone, instead of a single
broad good/average/poor bucket. Every one of those four numbers is labeled in
the UI and the printed report as **entered** (measured), **code-era typical**
(inferred from vintage), or **tier default** (the coarse fallback), so an
assumption is never presented as a measurement. Precedence, strongest first:
a number you type > a construction tier you pick or PhotoScan reads > the
vintage x zone table > the tier default.

**JobIQ** — the job type — is chosen before the calculation, by tapping a chip
or typing it ("mini split", "96% furnace", "duct sealing"). `job-types.js`
carries 30 types in six categories, and each one declares what it implies, so
nothing downstream has to parse a string. It changes three things. The *load*:
a ductless mini-split has no distribution losses at all, and applying the usual
10–20% duct factor to one overstates the equipment by a whole size step on a
small job. The *sizing*: the job's stage family picks which Manual S selection
applies, and the recommendation table marks that row as the answer instead of
handing the rep four equally-weighted options. And the *incentives*, most of
all — the rebate world is organised by measure, not by house, so a duct-sealing
job and a mini-split job share almost no programs. Job hints rank below any
number the user typed, never above. Anything typed that the catalogue doesn't
recognise is kept verbatim and sent to the incentive search, where "swamp
cooler swap" may be exactly the phrase that finds the program.

**EnergyIQ** (Pro) is the engineering case a quote attaches to — and
deliberately not the quote. An OpCost bin-method engine (`energy-engine.js`)
runs the calculated load through a 5°F histogram of the same year of on-site
hourly weather TrueClimate already fetched, evaluating each unit's efficiency
and capacity at the outdoor temperature it actually runs at: A/C EER slides
with temperature from its SEER2 anchor, heat-pump COP and capacity fall with
cold, backup strips or a dual-fuel furnace cover the shortfall. It estimates
what the customer's current unit costs to run (nameplate efficiency inferred
from install year when unknown, with an age derate), checks whether that unit
was ever the right size against Manual S bands, and lays out three efficiency
levels at the tonnage Manual S picks for each stage type, each with its annual
running cost and its saving against the current system. The fuel family and the
efficiency metric shown both come from the job type, so a furnace-only job is
rated on AFUE rather than on a SEER2 number the rep has to explain away.
Utility rates start from typical state averages and are meant to be overwritten
from the customer's bill.

There are no prices, no financing, no payback and no proposal here, by design.
Shops already run ServiceTitan or equivalent for that, and a second place to
keep prices is a second place for them to go stale. What this app owns is the
engineering; what the quoting software owns is the money.

**RoomIQ** (Pro) answers the question the customer actually called about.
Enter the rooms and how many supply registers each has, and `room-loads.js`
splits the whole-house load by each room's own glass area, orientation,
exterior exposure, roof or floor contact and use, then apportions supply air
by sensible load and compares it to what those registers can deliver. Room
loads are scaled so they sum exactly to the whole-house figures on the same
report, so the room breakdown can never contradict the tonnage; what the room
math decides is each room's share, not the size of the total. It flags rooms
that are starved of air, rooms that are over-supplied and could give air back,
west-facing glass, and rooms sandwiched between unconditioned spaces, then
writes the diagnosis in sentences a rep can read out loud.

**ServiceTitan hand-off.** `job-export.js` gets the finished job out of this
app and onto the work order three ways: a formatted plain-text summary on the
clipboard (paste into a ServiceTitan job note, estimate description or task — no
setup, works for everyone), an https POST of a flat JSON payload to a webhook
the shop owns (Zapier, Make, n8n, or their own endpoint), and a JSON download
for an importer or a developer.

It does not ask for ServiceTitan credentials, and it never will. Their API uses
OAuth 2.0 client credentials — Client ID, Client Secret, App Key, Tenant ID —
which a static browser app cannot hold, and ServiceTitan explicitly prohibits
*tunneling*: granting a third-party application you do not own access to your
App Key. Asking a contractor to paste theirs in here would be asking them to
break their own ServiceTitan agreement. The credentials belong server-side
under the shop's own app registration, which is exactly where the webhook route
puts them. A test asserts no credential field exists anywhere in that module.
The payload is deliberately flat and explicitly named (`cooling_btuh`, not a
nested blob) because the thing on the far end is usually a no-code automation
step where someone maps fields by hand. `no-cors` is not used: a silent opaque
success would be worse than an honest CORS failure, because the rep would
believe the job was sent.

**RebateIQ** (Pro) searches the live web for the grants, tax credits, utility
rebates and income-qualified programs that apply to one address and the system
being quoted, and returns each with a source, an apply link, the efficiency it
requires, and a plain summary the rep reads to the homeowner. It reads the web
at quote time rather than shipping a table because incentive data is the most
perishable in the industry: utility rebates change seasonally, state IRA
programs launched on staggered dates, and budgets run dry mid-year. Money shown
to a homeowner has to be defensible, so `rebate-iq.js` drops any program
without a retrievable source URL, refuses non-http links before they reach an
anchor, and reports two totals — one excluding income-tested programs (what a
typical household actually gets) and one including them. Results are
session-only and never saved with the job, so a quote reopened months later
cannot re-state a rebate that has since closed. It runs client-side on the
user's own AI key, like PhotoScan; `ai-providers.js` carries the per-provider
web-search transport.

**Plans.** The Free plan is one complete load calculation, then an upgrade
prompt; guests are held to the same ceiling so signing up is never worse than
not signing up, and an expired trial falls back to Free rather than to a paid
tier. The counter is per-device `localStorage`, which makes it a product
boundary rather than a security control — server-enforced entitlements come
with the Supabase work in SETUP.md. Paid plans are Solo $199/mo, Pro $499/mo,
and Fleet by quote.

**Caching.** The service worker is network-first for code (documents, JS, CSS,
the manifest) with a 3.5s timeout and a cache fallback, and cache-first only
for images. It was cache-first for everything, which meant a deploy was always
one visit behind: the old copy was served immediately and the new one landed
in the cache for next time. `sw-register.js` fetches the worker script past the
HTTP cache, re-checks on tab focus, and reloads once when a new worker takes
over, so an open tab picks up a deploy instead of sitting on a stale page.

**Keeping the inputs.** The results page is rebuilt from state whenever
anything else finishes — a photo analysis, an incentive search, a job-type
change — and the fine-tune and current-system fields used to be read only when
their button was pressed. A rep could measure the attic, type R-19, have a
background job land, and get a load computed from the code-era guess on a page
that still looked finished. The current-system fields now write to state on
every edit; the fine-tune panel keeps a per-field draft that is written back
after each render, along with the panel's open state, and dropped when a new
calculation starts. Separately, every calculation now carries a token, so a
straggling result from a superseded run can no longer wipe the overrides out
from under a page the rep is already working in.

> **Estimating tool only.** Results are a Manual J–style approximation for quick
> sizing guidance — not a stamped engineering report. Confirm final equipment
> sizing with a licensed HVAC professional.

## The app

The app lives at the repo root (`index.html` landing page, `app.html`
calculator). It's plain static files (HTML/CSS/vanilla JS + a service worker
and web manifest) with **no build step and no runtime dependencies**.

### Run it (one command)

Requires Node 18+. The calculator itself needs **no `npm install`**:

```bash
npm start
# → open http://localhost:8099
```

`npm start` launches a tiny static server (`serve.cjs`). To use a different port:
`PORT=3000 npm start`.

> Prefer Python? `python3 -m http.server 8099` from the repo root works too —
> but the Pro permit search (below) needs the Node server.

### Tests

```bash
npm test                # 439 hermetic unit checks: load engine, climate engine, energy engine, AI providers, permit search, PhotoScan, room loads, job types, job export, RebateIQ
npm run audit:browser   # live-browser regression: app flow, EnvelopeIQ, nameplate -> EnergyIQ, layout/print, RoomIQ, thinking overlay + free tier, cache freshness, RebateIQ, job types + ServiceTitan hand-off (needs network + Playwright's Chromium)
```

## Pro: permit & code search

After a calculation, a **Pro** panel can deep-search the searched home's city/county
for HVAC outdoor-unit install code requirements — property-line setback, minimum
SEER/SEER2, sound (dBA) limits, electrical disconnect, screening, and more — plus
the building/zoning department's website, permit portal, email, and phone. It then
lets you open a **pre-filled professional email** to the city with a summary of the
load report, ready to attach the generated PDF and submit.

This is powered by your choice of AI provider's web search, so it runs
**server-side** (the API key never reaches the browser). It's optional — the
calculator works without it.

```bash
npm install                          # installs @anthropic-ai/sdk (Anthropic provider only)
export LMP_PERMIT_PROVIDER=anthropic # anthropic (default) | openai | gemini | perplexity
export ANTHROPIC_API_KEY=sk-ant-...  # matching key for whichever provider you picked
npm start                            # the /api/permit-search endpoint is now live
```

Then run a calculation and click **Enable Pro (preview)** → **Search permit & code
requirements**. Without a key (or the install, for the Anthropic provider), the
calculator still runs and the panel reports that the feature isn't configured.

- Endpoint: `POST /api/permit-search` (`api/permit-search.cjs`) — also usable as a
  generic serverless handler via its exported `handler(body)`.
- `LMP_PERMIT_PROVIDER`: `anthropic` (default) | `openai` | `gemini` | `perplexity`.
  Matching API key env var: `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GEMINI_API_KEY` |
  `PERPLEXITY_API_KEY`.
- Optional env: `LMP_PERMIT_MODEL` (default per provider: `claude-opus-5` / `gpt-5.6` /
  `gemini-3.5-flash` / `sonar-pro`), `LMP_PERMIT_EFFORT` (`low`|`medium`|`high`|`max`,
  default `medium` — Anthropic only, the other providers' web-search tools have no
  equivalent knob).

> Permit results are **best-effort AI research** — municipal codes are
> inconsistent and change. Always verify with the authority having jurisdiction
> (AHJ) before submitting. The "Enable Pro" toggle is a local placeholder for
> testing; real billing/auth is a later step.

## Deploy

The app is a static site — the repo root deploys to GitHub Pages automatically
on every push to `main` (`.github/workflows/pages.yml`), or host it on any
HTTPS static host (Netlify, Vercel, Cloudflare Pages) and **Add to Home
Screen** on your phone. HTTPS is required for PWA install and geolocation.

The **Pro permit search** needs a server. Run the Node server (`npm start`) on a
host that holds the active provider's API key, or deploy `api/permit-search.cjs`
as a serverless function and point the app at it by setting `window.LMP_API_BASE`
to its URL.
