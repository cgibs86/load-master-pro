# Future Feature Ideas

This is a working backlog of accuracy and feature ideas surfaced while adding
attic insulation R-value, duct type/condition, and the return-air sizing
check to the load calculator. It is not a committed roadmap — just notes for
whoever picks up this app next.

1. **Infiltration blower-door override** (recommended near-term fast-follow,
   most concrete idea here). Infiltration is currently a fixed
   per-quality-tier guess (`ach: 0.30/0.55/0.90` in the `QUALITY` table in
   `loadcalc.js`) — one of the two largest load drivers in the engine, and
   currently the most crudely modeled of them. Many homes now have an actual
   ACH50 blower-door test number on file (often code-required at
   construction/renovation). Proposal: when an ACH50 value is supplied, use
   `ach_nat = ach50 / 17` (17 as a defensible single-constant approximation
   of the ASHRAE/LBNL "n-factor," which in the literature actually varies
   roughly 14–30 depending on climate, number of stories, and shielding);
   otherwise fall back to today's quality-tier default exactly as before —
   the same neutral-default, backward-compatible override pattern used for
   the attic-R-value input added in this same batch of work.

2. **Duct & insulation code-minimums lookup (Pro tier).** Same static
   lookup-module shape as `permits-data.js` (PermitIQ), which is keyed by US
   state via its `stateCode()` helper and buckets states into DOE efficiency
   regions. A duct/insulation-minimums feature should key off **IECC climate
   zone** instead — insulation and duct R-value code minimums track climate
   zone, not DOE SEER/HSPF region — which would need a state→zone or
   address→zone mapping. A natural Pro-tier extension mirroring an
   already-proven pattern in this codebase.

3. **PhotoScan AI: detect attic insulation depth / duct condition from
   photos.** Confirmed technically straightforward: `photo-ai.js`'s findings
   schema is a closed `field` enum plus a `VALIDATORS` map, so adding one or
   two new finding types (e.g. `atticInsulation`, `ductCondition`) is purely
   additive — a new enum entry, a new prompt bullet describing the visual
   cue, and a new validator entry, with no core rewrite needed. Real-world
   caveat: accuracy depends on the user actually photographing the attic
   and duct interior specifically (unlike exterior cues that are visible in
   any shot), so this would need explicit prompting in the photo-capture UI
   to be effective in practice.

4. **Measured duct-leakage/blower-door override (Fleet-tier
   differentiator).** Today's Fleet pricing tier (see the `#pricing` section
   in `index.html`) offers only ops perks over Pro — more seats, team
   onboarding, a dedicated account manager — with no unique data or
   capability feature. A measured-duct-leakage override (bridging
   "estimate" to "verified" using an actual diagnostic test result instead
   of the type/condition estimate) would give Fleet a genuine capability
   differentiator, not just more seats.

5. **ASHRAE 62.2 whole-house ventilation CFM requirement calculator.**
   Complements the load calculation, is increasingly code-required, and is
   a natural Pro/Fleet add given the "knows the rules" positioning the app
   already established with PermitIQ.

6. **Multi-zone / multi-system support for larger homes.** Another genuine
   Fleet-tier differentiator — today Fleet has no unique capability beyond
   seats and ops perks, the same gap noted in item 4.
