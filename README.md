# LoadMaster Pro

HVAC load calculator — an address-based residential heating & cooling load
estimator, built as an installable Progressive Web App (PWA).

Enter a street address and get an instant ACCA *Manual J*–style block-load
estimate (heating BTU/h, cooling BTU/h, and recommended A/C tonnage), with a
transparent breakdown. Works offline once installed.

> **Estimating tool only.** Results are a Manual J–style approximation for quick
> sizing guidance — not a stamped engineering report. Confirm final equipment
> sizing with a licensed HVAC professional.

## The app

The calculator lives in [`loadmaster-pro/`](./loadmaster-pro/). It's plain static
files (HTML/CSS/vanilla JS + a service worker and web manifest) with **no build
step and no runtime dependencies** — see
[`loadmaster-pro/README.md`](./loadmaster-pro/README.md) for full feature,
hosting, and model documentation.

### Run it (one command)

Requires Node 18+. The calculator itself needs **no `npm install`**:

```bash
npm start
# → open http://localhost:8099
```

`npm start` launches a tiny static server (`serve.cjs`). To use a different port:
`PORT=3000 npm start`.

> Prefer Python? `cd loadmaster-pro && python3 -m http.server 8099` works too —
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

### Helper scripts (Node, zero-dependency)

```bash
npm run build   # bundle the calculator into a single self-contained HTML preview
npm run icons   # regenerate the app icon PNGs
```

## Deploy

The **calculator** is a static site — host the `loadmaster-pro/` folder on any
HTTPS static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages) and **Add to
Home Screen** on your phone. HTTPS is required for PWA install and geolocation.

The **Pro permit search** needs a server. Run the Node server (`npm start`) on a
host that holds `ANTHROPIC_API_KEY`, or deploy `api/permit-search.cjs` as a
serverless function and point the app at it by setting `window.LMP_API_BASE` to
its URL.
