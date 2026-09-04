# Future Feature Ideas

This is a working backlog of accuracy and feature ideas surfaced while adding
attic insulation R-value, duct type/condition, and the return-air sizing
check to the load calculator. It is not a committed roadmap — just notes for
whoever picks up this app next.

1. ~~**Infiltration blower-door override.**~~ **Done.** Shipped as the `ach`
   override in `loadcalc.js` (plus sibling `windowU`/`windowSHGC` overrides
   for the same reason — glazing performance is just as decoupled from the
   wall/attic quality tier as infiltration is). Validated against two
   published full-spec Manual J case studies (NREL's paired Chicago/Orlando
   reference houses, `tests/manual-j-benchmarks.js`): using the "poor" tier's
   flat `ach: 0.90` against a real 2009-IECC house's measured 0.10 ACHnatural
   was, by itself, most of a >100% cooling-load overstatement — confirming
   this was a real, large error mode, not a cosmetic gap. Took the ACH50-based
   input shape suggested here as directly-entered ACHnatural instead (an
   `ach50 / 17` conversion was considered but skipped for v1 — simpler to let
   the (less common but existing) user who already has ACHnatural from an
   energy audit enter it directly, and add the ACH50 conversion as a fast-
   follow if blower-door-test users turn out to be the more common case).

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

7. **Shovels API as an optional bring-your-own-key data source (evaluated,
   not integrated).** Shovels (shovels.ai) provides permit, property, and
   contractor records across 2,750+ US jurisdictions. Checked its actual
   schema: property records have `year_built`/`lot_size`/`story_count`/
   `building_area` but no bedroom count (RentCast, already integrated,
   covers that), and permit records prove *that* HVAC work happened and
   roughly *who/when* via an "hvac" contractor-classification tag — but
   **no tonnage, SEER rating, duct specs, or any equipment-level data at
   all**. It would not help auto-fill attic-R/duct-type/return-air inputs;
   photo-based detection (item 3) remains the right path for that. Where it
   *would* help: real permit history for the report/PermitIQ ("last
   permitted HVAC work: 2019, contractor X") — a genuine upgrade over
   PermitIQ's current static code-minimums lookup. Not worth bundling by
   default: pricing is sales-gated, not self-serve, with publicly reported
   entry pricing around $599/month — far outside a bundled-by-default cost
   model for a product priced at $19–129/mo, unlike RentCast's accessible
   self-serve tier. Worth revisiting as an optional user-supplied-key
   integration (same pattern as the RentCast/AI provider keys) for shops
   that already pay for Shovels for their own business-development use.

8. **Real building-footprint geometry (Microsoft Global ML Building
   Footprints / Overture Maps) — the biggest remaining structural
   simplification.** `loadcalc.js` still assumes a perfect square footprint
   (`perimeter = 4 * Math.sqrt(footprint)`), which understates perimeter —
   and therefore wall UA and window-area potential — for any real home with
   an L/U-shaped plan, wings, or a non-square rectangle. Both datasets are
   free (CDLA Permissive 2.0 / ODbL-family licensing) and would let the app
   compute a real perimeter from the address's actual footprint polygon
   instead of guessing. Not implemented this round because both ship as
   cloud-hosted GeoParquet/STAC data, not a REST endpoint — this app has no
   backend beyond the small `api/permit-search.cjs` Node server, so shipping
   this needs either a lightweight self-hosted spatial-lookup service (a
   DuckDB query against a regional extract) or a per-request proxy to a
   third-party service that already indexes this data. Worth real
   engineering investment, not a quick add.

9. **Google Solar API (`buildingInsights`) for real roof orientation/tilt/
   shading — replaces the "sun exposure: low/average/high" dropdown.**
   Pay-as-you-go pricing (~$0.01–0.10/lookup at typical volume; 10,000 free
   calls/mo) fits this app's cost model far better than the sales-gated
   vendors rejected elsewhere in this doc, and it would feed real per-roof-
   face azimuth/tilt/shading-hours into the solar-gain term instead of a
   single low/average/high multiplier. Skip the Data Layers endpoint
   (raster imagery, $75/1,000 calls) — it's priced for solar-panel-layout
   rendering, not a load calc, and Building Insights' segment stats already
   beat the current dropdown on their own. US coverage only; needs a
   fallback to the existing "average" tier where `buildingInsights` 404s.

10. **SHIPPED (as EnvelopeIQ, code-minimum table rather than a ResStock
    ETL).** The vintage x climate-zone envelope default idea below is now
    live in `loadcalc.js` (`VINTAGE_ENVELOPE` / `envelopeFromVintage()`),
    sourced from the energy-code minimums in force per era and IECC zone
    rather than from a ResStock aggregation. Code minimums were chosen for
    the first cut because they are citable in a report, need no ETL job or
    annual refresh, and validated cleanly against the two published NREL
    Building America reference houses this engine is benchmarked on. A
    ResStock pass remains worthwhile later as a *second* column: code
    minimum is what the house was legally required to have, while ResStock
    medians are what comparable houses actually have — the gap between them
    is real, particularly for pre-1980 stock and for post-retrofit homes.
    The original note follows.

    **NREL ResStock-derived static lookup table (free, offline data-prep,
    no runtime API).** ResStock's ~550k-home statistically-representative
    baseline metadata (hosted as CSV/Parquet on the OEDI S3 data lake, not
    a live API) could replace the flat 3-tier good/average/poor construction
    dropdown with real median R-values/ACH/window-to-wall-ratio keyed on
    IECC climate zone × vintage bucket — both of which this app can already
    derive (climate zone from the design temps it already computes; vintage
    from RentCast's year-built or free-text entry). A one-time ETL job
    (download the current release, pre-aggregate by zone × vintage, bake the
    result in as a lookup table), refreshed on ResStock's ~annual release
    cadence — no new runtime dependency or cost.

11. **A wall R-value override was tried and rejected — don't just copy the
    atticR pattern for walls.** Validated against the same NREL Chicago/
    Orlando published case studies as item 1: naively treating a supplied
    wall R-value the way `atticR` treats roof R (`U = 1 / (R + baseline)`)
    made *both* validation cases measurably worse, not better. Roof
    assemblies are uniform enough that one baseline constant (`ROOF_BASE_R`)
    reasonably backs out drywall + air films + deck across construction
    types. Walls aren't: a wood-frame wall's *effective* R runs ~20–30%
    below its cavity-insulation R alone (thermal bridging through studs/
    headers/corners — well documented in ASHRAE/DOE literature), while a
    CMU-block wall's true assembly R is the block's own R (~2) plus air
    films plus whatever continuous insulation was added, not the added
    insulation layer alone. A correct version of this override would need a
    wall-type selector (wood-frame vs. mass/CMU vs. ICF, each with its own
    baseline/derating) before it could beat the current flat per-tier
    `uWall` — worth doing, but a bigger design task than the atticR-style
    one-liner it might look like at first.

12. **Duct-loss modeling has a ceiling this engine's flat multiplier can't
    represent for extreme cases.** ACCA's own official illustrated example
    (the "Vatilo Residence," Houston TX, single-pane windows, uninsulated
    slab) shows unconditioned-attic ducts adding ~32–35% to both heating and
    cooling load — well above this engine's current maximum duct adder
    (`ductType: attic, ductCondition: unsealed` → 1.20, a 20% adder). Real
    Manual J duct-loss methodology scales with the duct location's design
    temperature difference and system CFM, not a flat percentage of the
    envelope load, so it can run higher in hot climates with attic ducts
    than any fixed multiplier can capture. Not fixed this round — the fix is
    a genuinely different (ΔT- and CFM-aware) duct-loss formula, not another
    override — but worth flagging so a future pass doesn't mistake this for
    already-solved territory just because `ductType`/`ductCondition` exist.
