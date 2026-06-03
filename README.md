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

The application lives in [`loadmaster-pro/`](./loadmaster-pro/). It's plain
static files (HTML/CSS/vanilla JS + a service worker and web manifest) with **no
build step and no runtime dependencies** — see
[`loadmaster-pro/README.md`](./loadmaster-pro/README.md) for full feature,
hosting, and model documentation.

### Quick local test

```bash
cd loadmaster-pro
python3 -m http.server 8099
# open http://localhost:8099
```

### Optional helper scripts (Node, zero-dependency)

```bash
cd loadmaster-pro
node build-singlefile.cjs     # bundle into a single self-contained HTML preview
node icons/generate-icons.cjs # regenerate the app icon PNGs
```

## Deploy

It's a static site — host the `loadmaster-pro/` folder on any HTTPS static host
(GitHub Pages, Netlify, Vercel, Cloudflare Pages) and **Add to Home Screen** on
your phone. HTTPS is required for PWA install and geolocation.

## Pro: Permit & code search

After a load calculation, the **Pro** panel deep-searches the home's city/county
for HVAC outdoor-unit install code requirements:

- Setback from property line
- Minimum SEER / SEER2
- Max sound (dBA) at property line
- Electrical disconnect requirement
- Screening / placement rules
- Building & zoning department contacts + permit portal link

Powered by Claude with web search. Results include source citations; always
verify with the authority having jurisdiction (AHJ).

### One-tap submission email

Click **"Email load report to city"** to open a pre-filled professional email
addressed to the building department, with the load summary already written.
Attach the generated PDF and send.

### Running with the permit search

The permit search requires a server (it keeps the Anthropic API key off the
client). A zero-dependency Node dev server is included:

```bash
npm install                      # installs @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-… npm start # starts on http://localhost:8099
```

Without `npm install` or without an API key, the base calculator works fine —
the Pro panel shows a clear error message and degrades gracefully.

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | For Pro | Claude API key for permit search |
| `PORT` | No | Dev server port (default 8099) |
