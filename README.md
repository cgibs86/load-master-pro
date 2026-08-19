# BTU.ai

HVAC load calculator — an address-based residential heating & cooling load
estimator, built as an installable Progressive Web App (PWA).

Enter a street address and get an instant ACCA *Manual J*–style block-load
estimate (heating BTU/h, cooling BTU/h, and recommended A/C tonnage), with a
transparent breakdown. Works offline once installed.

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

## Pro: permit & code search

After a calculation, a **Pro** panel can deep-search the searched home's city/county
for HVAC outdoor-unit install code requirements — property-line setback, minimum
SEER/SEER2, sound (dBA) limits, electrical disconnect, screening, and more — plus
the building/zoning department's website, permit portal, email, and phone. It then
lets you open a **pre-filled professional email** to the city with a summary of the
load report, ready to attach the generated PDF and submit.

This is powered by Claude with web search, so it runs **server-side** (the API key
never reaches the browser). It's optional — the calculator works without it.

```bash
npm install                      # installs @anthropic-ai/sdk (Pro feature only)
export ANTHROPIC_API_KEY=sk-ant-...
npm start                        # the /api/permit-search endpoint is now live
```

Then run a calculation and click **Enable Pro (preview)** → **Search permit & code
requirements**. Without the key (or the install), the calculator still runs and the
panel reports that the feature isn't configured.

- Endpoint: `POST /api/permit-search` (`api/permit-search.cjs`) — also usable as a
  generic serverless handler via its exported `handler(body)`.
- Optional env: `LMP_PERMIT_MODEL` (default `claude-opus-4-8`),
  `LMP_PERMIT_EFFORT` (`low`|`medium`|`high`|`max`, default `medium`).

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
host that holds `ANTHROPIC_API_KEY`, or deploy `api/permit-search.cjs` as a
serverless function and point the app at it by setting `window.LMP_API_BASE` to
its URL.

## Ops dashboard — full control board

```bash
npm start          # then open http://localhost:8099/dashboard
```

The repo ships with a **self-hosted, zero-dependency observability stack** covering
the whole product, front end to back end:

- **`metrics.js`** (client) — on every page: page views with device/OS/browser/
  network context, Core Web Vitals (LCP, INP, CLS, TTFB, FCP + page weight), JS
  errors & unhandled rejections, offline drops, PWA install events, CTA clicks,
  and product funnel events (calc start/success/fail, durations, TrueClimate vs
  station source, RentCast vs estimated ft², tonnage, city/state, PhotoScan AI,
  reports, shares, signups, logins, settings changes).
- **`api/metrics.cjs`** (server) — logs every HTTP request (method, path, status,
  latency, bytes, UA, referrer), every PermitIQ call (duration, model, sources,
  errors), and live system health (memory, event-loop lag, load, uptime). Stores
  events in an append-only JSONL at `data/metrics.jsonl` (gitignored) plus an
  in-memory ring buffer that survives restarts.
- **`dashboard.html`** — the control board at `/dashboard`:

| Tab | What it shows |
|---|---|
| **Overview** | KPI cards w/ sparklines & period deltas, traffic chart, conversion funnel, system health, smart alerts (5xx, LCP, error rate, missing API key/SDK, permit success…) |
| **Traffic** | Views/visitors over time, top pages, referrers, devices, browsers, OS, networks, screens, languages, new vs returning, hour-of-day heatmap, sessions & bounce |
| **Frontend** | Core Web Vitals gauges (p50/p75/p90 vs Google thresholds), load-time & page-weight distributions, vitals by device/network, JS error log, PWA installs & offline |
| **Product** | Job funnel, calc success/duration, TrueClimate & RentCast adoption, tonnage histogram, top cities/states, PhotoScan AI impact, signups by plan, CTA clicks, manual-adjust frequency |
| **Backend** | Throughput, status codes, latency p50/p95/p99 by route, PermitIQ deep-dive (success, duration, sources, errors), live server resources, slowest requests, 404s |
| **Live feed** | Real-time request stream + product event feed, filterable by text/status |

Controls: time range (15m–All), 5-second live refresh (pausable), **Export**
(raw JSONL), **Reset**, and **Demo data** — 48h of clearly-marked sample data so
you can explore the board before real traffic exists.

**Privacy by design:** metrics never contain street addresses, emails, API keys
or IP addresses. Visitors get random ids; calculations report only city/state.
Everything stays on your server. Client telemetry is fire-and-forget — on static
hosts (GitHub Pages) it silently no-ops and the app runs exactly as before.
