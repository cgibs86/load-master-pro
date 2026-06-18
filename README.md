# Load Master Pro

A residential **HVAC heating & cooling load calculator**. It estimates design
heating and cooling loads for a home using a simplified
[ACCA Manual J](https://www.acca.org/standards/manual-j)–style method, and
breaks the result down by contributor (envelope conduction, infiltration, solar,
and internal gains).

> ⚠️ This is an estimating and educational tool. For permit submittals or final
> equipment selection, run a full Manual J calculation.

## Features

- Live heating (BTU/h) and cooling (BTU/h + tons) totals as you type
- Climate presets (hot-humid, hot-dry, mixed, marine, cold, very cold) that set
  design temperatures, moisture difference, and solar gain
- Construction presets (older → high-performance) that set envelope R-values,
  window U-factor/SHGC, and air leakage
- Per-component load breakdown for both heating and cooling, split into sensible
  and latent on the cooling side

## Tech stack

- [Vite](https://vitejs.dev/) + [React 18](https://react.dev/) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/)
- [lucide-react](https://lucide.dev/) icons
- [Vitest](https://vitest.dev/) for the calculation-engine tests

## Getting started

```sh
npm install
npm run dev        # start the dev server (http://localhost:8080)
npm run build      # type-check and build for production
npm run preview    # preview the production build
npm test           # run the engine unit tests
```

## How the calculation works

The engine lives in [`src/lib/hvac.ts`](src/lib/hvac.ts). For each opaque
surface the load is `U × A × ΔT`, where `U = 1 / R`. Glazing uses its U-factor
directly. Infiltration is derived from air changes per hour and building volume:

```
CFM        = ACH × (floorArea × ceilingHeight) / 60
sensible   = 1.08 × CFM × ΔT
latent     = 0.68 × CFM × grainsDifference
```

Cooling additionally includes solar gain through glazing
(`area × SHGC × peakSolar`), occupant gains (230 BTU/h sensible + 200 latent per
person), and appliance/lighting load (`watts × 3.412`). Heating intentionally
takes no solar or internal credit. Default constants and presets live in
[`src/lib/presets.ts`](src/lib/presets.ts).
