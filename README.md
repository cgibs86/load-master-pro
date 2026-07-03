# LoadMaster Pro — HVAC Load Calculator (PWA)

Enter an address, get an instant residential heating & cooling load estimate. Built as an
installable Progressive Web App (PWA) so you can run it from your phone's home screen, offline.

> **Estimating tool only.** Results are an ACCA *Manual J*–style approximation for quick sizing
> guidance — not a stamped engineering report. Confirm final equipment sizing with a licensed
> HVAC professional.

## What it does

1. **Geocodes the address** (OpenStreetMap Nominatim — free, no key), with live autocomplete.
2. **TrueClimate engine** — pulls ~8,760 hours of historical hourly weather *for the exact
   coordinates* (free Open-Meteo archive, no key) and computes the true 99% winter / 1% summer
   design temperatures, coincident design humidity, and site elevation on-device. Falls back to an
   embedded 75-station US design table when offline.
3. **Elevation-corrected physics** — air-density correction from actual site elevation feeds the
   sensible/latent air constants (a 2-ton load in Denver is not a 2-ton load in Miami).
4. **Gets the building size** — auto-fetches square footage / bedrooms / year built from a property
   API *if* you add a key (see below); otherwise it estimates and lets you adjust.
5. **Computes the load** — whole-house (block) model: envelope conduction, solar gain, infiltration
   (sensible + latent), internal gains → heating & cooling BTU/h **with honest ± confidence ranges**
   (±10% with fetched property data, ±15% estimated).
6. **Heat Pump Balance Point Analyzer** — charts the home's load line against a heat pump's
   capacity curve, reports the balance temperature and backup-heat (kW) needed at design.
7. **Equipment Plan** — A/C tonnage, real furnace output sizes, target airflow CFM, ft²/ton, and a
   climate-based system recommendation (heat pump vs dual-fuel vs furnace+AC).

Everything except the live lookups runs on-device, so once installed it works offline.

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

## PermitIQ™ (Pro/Fleet feature)

When a calculation runs, PermitIQ compiles the permit picture for that address:

- **Federal efficiency floors by state** — DOE 2023 regional SEER2 minimums for central A/C
  (North 13.4 / Southeast 14.3 / Southwest 14.3 + EER2), national heat-pump minimums
  (14.3 SEER2 / 7.5 HSPF2), furnace AFUE — real, legally binding data embedded in the app.
- **Model-code checklist** (IRC/IMC/NEC/IECC as commonly adopted): outdoor-unit clearances and
  property-line setbacks, disconnect + GFCI receptacle rules, condensate protection, duct sealing
  and testing triggers, combustion/CO items, inspections. Values that cities commonly amend are
  tagged **verify locally** — the app never pretends to know a local amendment it can't know.
- **Permit package**: one tap produces a PDF of the load report + site photos + requirements +
  submission checklist, plus a pre-written email draft to send to the permit office (attach the
  saved PDF). A "find the permit office" link searches the city's building department directly.
- **Site photos**: shoot the outdoor-unit location, panel, and existing equipment; photos embed
  in the report and permit package (kept on-device, this session).

Honest scope: there is no national API for city-by-city permit rules or e-filing, so PermitIQ is a
*preparation* engine — federal floors are exact, model-code items are the near-universal baseline,
and anything cities amend is explicitly flagged for verification with the AHJ. All outputs carry a
disclaimer that final submittals may require a full Manual J/S/D by a licensed professional.

## Sizing methodology (v3)

- Loads follow a Manual J-style block model; the solar-gain term uses orientation-averaged incident
  flux × SHGC (glass HTMs ≈ 21–42 BTU/hr·ft², matching Manual J tables).
- Equipment selection follows **ACCA Manual S limits (90–115%)** for single/two-stage systems in
  half-ton steps, and selects variable-capacity systems at-or-above the load since inverters
  modulate down to ~30–40%. The app shows all three selections side by side.
- Heat-pump balance points use capacity-retention curves by system type (standard ~60% at 17°F,
  inverter/cold-climate ~82%).
- ft²/ton is an *output*, not an input: old leaky homes naturally compute near the classic
  400–500 ft²/ton rule of thumb, modern tight homes land at 800–1,200 ft²/ton.

## Landing page, pricing & accounts

`index.html` is a full marketing site aimed at HVAC contractors (close on the first visit, no
sizing mistakes, branded reports) with three subscription tiers — Solo $19/mo, Pro $49/mo,
Fleet $129/mo — and login/signup at `auth.html`. Accounts are currently created and stored
**on-device** (salted SHA-256, localStorage) so the whole flow works end-to-end as a demo;
to charge real money and sync teams you'll want a small backend (e.g. Supabase auth + Stripe
billing) — the UI is already structured for it. The installed PWA opens straight into the
calculator (`app.html`).

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
| `index.html` | Marketing landing page (contractor pitch, pricing tiers, CTAs) |
| `auth.html` | Login / signup page (on-device accounts; wire to a backend for real billing) |
| `landing.css` | Landing + auth styling |
| `app.html` | The calculator app shell (what the installed PWA opens) |
| `styles.css` | App styling (dark, mobile-first) |
| `app.js` | Controller: geocoding, climate match, property fetch, rendering |
| `loadcalc.js` | The load-calculation model incl. balance point & equipment plan (unit-testable in Node) |
| `climate-engine.js` | TrueClimate: live per-address design conditions from a year of hourly weather |
| `climate-data.js` | Embedded US design-condition table (offline fallback) |
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
