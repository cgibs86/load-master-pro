# LoadMaster Pro — HVAC Load Calculator (PWA)

Enter an address, get an instant residential heating & cooling load estimate. Built as an
installable Progressive Web App (PWA) so you can run it from your phone's home screen, offline.

> **Estimating tool only.** Results are an ACCA *Manual J*–style approximation for quick sizing
> guidance — not a stamped engineering report. Confirm final equipment sizing with a licensed
> HVAC professional.

## What it does

1. **Geocodes the address** (OpenStreetMap Nominatim — free, no key) to get latitude/longitude.
2. **Looks up the local climate** — picks the nearest location in an embedded US design-temperature
   table (99% winter / 1% summer design temps + design humidity).
3. **Gets the building size** — auto-fetches square footage / bedrooms / year built from a property
   API *if* you add a key (see below); otherwise it estimates and lets you adjust.
4. **Computes the load** — a simplified whole-house (block) model: envelope conduction, solar gain,
   infiltration (sensible + latent), and internal gains → heating BTU/h, cooling BTU/h, and a
   recommended A/C tonnage.

Everything except the live address/property lookups runs on-device, so once installed it works offline.

## Pro / contractor features

- **Branded PDF reports** — tap *Generate report* to produce a clean, professional one-page load
  report (heating/cooling loads, recommended equipment, design conditions, building inputs, and a
  cooling-load breakdown). Use the browser's *Save as PDF* to hand or email it to a homeowner.
- **White-label branding** — add your company name, phone, email, license #, and logo in **Settings**.
  They appear on every report. Stored only on your device.
- **Saved jobs** — every calculation is saved locally as a "Recent job" you can reopen instantly
  (works offline — the full snapshot is stored, no re-lookup needed).
- **Share** — send a quick text summary via the native share sheet (or copy to clipboard).
- **Fine-tune inputs** — beyond size and bedrooms, adjust construction quality, **foundation type**
  (slab / crawl / basement), **sun exposure**, and **ceiling height** for a closer estimate.

## Run it on your phone

It's plain static files — no build step. Host the `loadmaster-pro/` folder anywhere that serves
static files over **HTTPS** (required for PWA install + geolocation):

### Option A — GitHub Pages (free)
1. In the repo settings, enable **Pages** for this branch.
2. Visit `https://<your-user>.github.io/<repo>/loadmaster-pro/` on your phone.
3. Tap the browser share/menu button → **Add to Home Screen**. You now have an app icon.

### Option B — Netlify / Vercel / Cloudflare Pages drag-and-drop
Drop the `loadmaster-pro/` folder into a new static site. Open the URL on your phone and
**Add to Home Screen**.

### Option C — Quick local test
```bash
cd loadmaster-pro
python3 -m http.server 8099
# then open http://localhost:8099 (use your computer's IP to test from a phone on the same Wi-Fi)
```
> Note: geolocation and PWA install need HTTPS in the browser; `localhost` is treated as secure for
> desktop testing, but to install on a phone use one of the hosted options above.

## Fully automatic square-footage lookup (optional)

The "just type the address" auto-fetch of a home's square footage needs a property-data API.
LoadMaster supports [RentCast](https://www.rentcast.io/api) (has a free tier):

1. Get an API key from RentCast.
2. Open **Settings** (gear icon, top-right) and paste the key. It's stored only on your device
   (`localStorage`) — it never leaves the browser except in the call to RentCast.

**Heads-up on CORS:** browsers block many server-oriented APIs from being called directly from a
web page. If the property lookup fails for that reason, LoadMaster falls back to an editable size
estimate (no crash). To make direct lookups reliable you can run a tiny serverless proxy (e.g. a
Cloudflare Worker / Vercel function) that forwards the request and adds CORS headers, then point
the app at it. Without a key (or if the lookup is blocked), the app still works — it just starts
from a typical size you can adjust with the **Fine-tune inputs** panel.

## File layout

| File | Purpose |
|------|---------|
| `index.html` | App shell / markup |
| `styles.css` | All styling (dark, mobile-first) |
| `app.js` | Controller: geocoding, climate match, property fetch, rendering |
| `loadcalc.js` | The load-calculation model (also unit-testable in Node) |
| `climate-data.js` | Embedded US design-condition table |
| `manifest.webmanifest` | PWA metadata (name, icons, theme) |
| `service-worker.js` | Offline caching of the app shell |
| `icons/` | App icons + `generate-icons.cjs` (regenerates the PNGs) |

## The model (transparency)

For a floor area `A` the app estimates geometry (footprint, perimeter, wall/roof/glazing areas,
volume), assigns U-factors and infiltration by construction quality (well-sealed / average /
older-leaky, defaulted from year built when known), then:

- **Heating** = (UA × ΔT) + sensible infiltration, ×1.10 duct factor.
- **Cooling (sensible)** = conduction + solar-through-glass + people + appliances/lighting + sensible infiltration.
- **Cooling (latent)** = latent infiltration (from design humidity) + people latent.
- **Tonnage** = total cooling ÷ 12,000, rounded to the nearest ½ ton.

These are deliberately simple, transparent coefficients meant for ballpark sizing. Tune the inputs
in-app for a closer estimate, and always verify with a pro before buying equipment.
