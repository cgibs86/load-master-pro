# PLAN — results screen as a dashboard

**Goal (agreed):** the results screen stops being a ~9-phone-screen scroll of 17
stacked sections and becomes a dashboard: the answer and every tool's headline
on about one screen, with each tool's full detail one tap away in a sheet.
Nothing is removed. The printed PDF stays a full report.

**Baseline (measured at 390 px wide, Houston test address, Pro plan):**
results 6,563 px tall, page 7,401 px, 17 blocks, 1,305 words visible before any
tap, final recommendation ~5 screens down, tonnage stated 5 times.

## Steps — each with how it is proven

1. **Dashboard shell.** Address + job line (with Change) + one compact climate
   line, then 4 KPI tiles (Cooling tons/BTU, Heating BTU, Airflow CFM, Balance
   point), then two tile groups — *The house* (EnvelopeIQ, Load breakdown,
   RoomIQ, PhotoScan) and *The sale* (EnergyIQ, RebateIQ, PermitIQ, System
   options) — then a pinned action bar (Report · Send · Adjust).
   *Proof:* probe measures the dashboard at 390 px: results ≤ 1,500 px tall,
   ≤ 300 words visible, tonnage stated once.

2. **Sheets.** Each module's existing card moves, unchanged, into a hidden
   sheet; its tile opens it (bottom sheet on phones, side drawer ≥ 1000 px).
   Close by ✕, backdrop, Escape, or the phone's Back button. A sheet that is
   open when the page re-renders stays open at the same scroll position.
   *Proof:* probe opens every tile and asserts its content is visible; forces
   a re-render with a sheet open and asserts it is still open; Escape and Back
   close it without leaving the page.

3. **Live tile headlines,** including locked (PRO) states and every RebateIQ
   state (search / searching / $ found / none / job changed).
   *Proof:* probe asserts specific headlines after specific actions (enter the
   current unit → EnergyIQ tile shows $/yr and the verdict, etc.).

4. **Trim repetition.** Equipment card and final recommendation merge into
   one Sizing sheet; the Manual S and oversizing paragraphs go behind "Why
   these sizes?". *Proof:* text checks in the Sizing sheet; the disclosure is
   closed by default.

5. **Search screen.** Job chips in one swipeable row instead of five rows.
   After a calculation the search card collapses to address + Calculate, and
   the job is changed from the dashboard. Recent jobs move below the dashboard.
   *Proof:* probe — chip row is one line tall, collapsed state after a calc, a
   second calculation from the collapsed bar still works.

6. **Wide screens.** ≥ 700 px: KPIs and tiles 4-up. ≥ 1000 px: wider dashboard
   and a right-side drawer. *Proof:* layout probe at 1280 px — no horizontal
   overflow, KPIs on one row, drawer beside the dashboard.

7. **Nothing that works breaks.** Every element ID and handler is kept; the
   probes are updated to open a tile before touching what is inside it.
   RoomIQ inputs are saved on every edit (same re-render bug fixed earlier for
   EnergyIQ, now more exposed because typing happens in a sheet while a
   background search can finish). *Proof:* `npm test` + all browser probes
   green; a room-input survival check.

8. **Try to break it** (AGENTS.md §5): empty address, double submit, refresh
   with a sheet open, rapid open/close, re-render while typing in a sheet,
   guest and Solo plans, phone and desktop. A report-only reviewer subagent
   does an independent pass. *Proof:* its report, and fixes for what it finds.

9. **Ship.** Commit, push to `main`, confirm the deploy matches.

## Status
- [x] 1 — results 6,563 → ~875 px at 390 px; 1,305 → 135 words; tonnage 5 → 1
- [x] 2 — `tests/browser/12-dashboard.cjs`: every tile opens its sheet; Escape,
      backdrop, ✕ and Back close it; a sheet survives a Recalculate at its
      scroll position and a background search landing while typing
- [x] 3 — headline checks in probes 04, 06, 10, 11, 12
- [x] 4 — "Why these sizes?" folds the Manual S / oversizing reasoning
- [x] 5 — chips in one swipeable row; Calculate on the first screen; the
      search card collapses after a calculation; a second calculation from it works
- [x] 6 — 1280 px: KPIs on one row, groups side by side, drawer at the right
- [x] 7 — all 10 browser probes + 439 unit checks green; RoomIQ saves on edit
- [ ] 8 — reviewer subagent pass (in progress)
- [ ] 9 — commit, push, confirm deploy
