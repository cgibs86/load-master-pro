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

**SalesIQ** (Pro) turns the load into a replacement proposal. An OpCost
bin-method engine (`energy-engine.js`) runs the calculated load through a
5°F histogram of the same year of on-site hourly weather TrueClimate already
fetched, evaluating each unit's efficiency and capacity at the outdoor
temperature it actually runs at: A/C EER slides with temperature from its
SEER2 anchor, heat-pump COP and capacity fall with cold, backup strips or a
dual-fuel furnace cover the shortfall. It estimates what the customer's
current unit costs to run (nameplate efficiency inferred from install year
when unknown, with an age derate), checks whether that unit was ever the
right size against Manual S bands, and lays out Good / Better / Best at the
tonnage Manual S picks for each stage type — with the rep's own prices,
rebates and financing terms turned into monthly payment, net monthly cost
after energy savings, payback and 10-year cost of ownership. Utility rates
start from typical state averages and are meant to be overwritten from the
customer's bill.

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

**Price book** (Settings) is the shop's own equipment and pricing, saved once
on the device. `price-book.js` matches a line by tier, fuel and stage, prices
it at the exact tonnage Manual S picked for that stage type (flat, base plus
per-ton, or an explicit price per stocked size), and SalesIQ fills every
proposal from it automatically. A figure the rep types on a job always wins,
so opening a saved job never rewrites what it was quoted at.

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
npm test                # 329 hermetic unit checks: load engine, climate engine, energy engine, AI providers, permit search, PhotoScan
npm run audit:browser   # live-browser regression: full app flow, EnvelopeIQ, SalesIQ, nameplate, layout/print, RoomIQ, price book (needs network + Playwright's Chromium)
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
