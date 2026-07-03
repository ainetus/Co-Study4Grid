# SLD readability & loading coherence (PyPSA grids)

Three related fixes that make the Single Line Diagram (SLD) overlay
honest and readable on the PyPSA-EUR grids, where equipment carries two
identities: a raw IIDM id from the OSM-based conversion
(`relation_8423569-225`, `VL_way_207479669-225`) and a friendly operator
name (`MARSIL61PRAGN`, `MARSILLON 225kV`).

## 1. Feeders labelled by the far-end voltage level

By default pypowsybl draws each branch feeder with its raw IIDM id, which
is meaningless to an operator. Every SLD endpoint now also returns a
`feeder_labels` map and the frontend swaps the displayed label for the
**name of the voltage level at the OTHER end** of the branch (so the
operator reads *where the line goes*, e.g. `MARSILLON 225kV`).

- Backend `services/diagram/sld_render.py::build_feeder_labels(network,
  vl_id)` returns `{equipment_id: {name, other_vl, label}}` for every
  line / 2-winding transformer touching the VL.
  - `label` = far-end VL friendly name, **disambiguated with a 1-based
    index** when several branches of this VL reach the same far-end VL
    (parallel circuits) → `LANNEMEZAN 225kV 1` / `… 2`.
  - Fall-backs: branch's own friendly name when the far-end VL is unnamed;
    `None` (keep the raw id) when neither is available — so non-PyPSA
    grids with already-readable ids are untouched.
  - `name` carries the branch's friendly/operator name — see fix 2.
- Frontend `hooks/useSldFeederRelabel.ts` + `utils/svg/feederLabels.ts`
  (`applyFeederRelabels`) swap the matching `<text>` content, idempotently
  (original stashed in `data-feeder-orig`, restored on tab/VL switch,
  highlight clones skipped) — the same render-every-time + self-gate
  pattern as the other SLD label passes.
- **Long labels wrap instead of occluding neighbours.** A relabelled name
  wider than ~15 chars (`wrapFeederLabel`) is split onto up to three `<tspan>`
  lines, vertically centred on the original baseline (first line lifted by half
  the block height) so it spreads up AND down rather than overprinting the
  adjacent feeder's label — the fix for the top/bottom label pile-up on dense
  VLs like `VL_way_207479669-225`. Wrapping breaks on whitespace first and, for
  a long single word with no spaces (a raw IIDM id like
  `L_virtual_relation_8423568_a_0-225`), on its `_` / `-` / `.` separators.
- **Every long feeder NAME wraps, not just the relabelled branches.**
  `applyFeederLabelWrap` (in `feederLabels.ts`, run right after
  `applyFeederRelabels` from `useSldFeederRelabel`) wraps the remaining long
  feeder names at a substation's extremities — generators, loads, and branches
  whose far-end VL is unnamed (so they were never relabelled) — which is the
  overlap that survived Issue 1's branch-only relabelling. It targets the
  equipment-name `<text>` inside each feeder cell (`.sld-extern-cell` /
  `.sld-intern-cell` / `.sld-shunt-cell`), skipping the numeric P/Q flow labels,
  the already-relabelled feeders (which wrap themselves), and highlight clones.
  Idempotent via `data-feeder-wrap` / `data-feeder-wrap-orig`. It runs BEFORE
  the injection-name-button pass so those buttons size their box to the wrapped
  multi-line name.

## 1b. Navigate to a branch's other extremity by clicking its feeder name

Each relabelled feeder is tagged with `data-feeder-nav` = the far-end VL id
(the `other_vl` field) and the `sld-feeder-navigable` class (dotted underline
+ pointer cursor). `hooks/useSldFeederNav.ts` installs one delegated
capture-phase click listener on the overlay body: a (non-pan) click on a
feeder name hands `other_vl` to `onNavigateToVl`, which re-opens the SLD for
that VL keeping the current sub-tab (`App.handleSldNavigateToVl` →
`handleVlDoubleClick(actionId, other_vl, tab)`). Because the contingency /
overload halo pass runs against whatever VL is displayed, the overload opened
at one end stays highlighted from the other end after the jump. The listener
uses `stopImmediatePropagation` and is registered before the edit-mode
switch/injection handler (which also early-bails on `[data-feeder-nav]`) so a
name click never doubles as a topology maneuver.

## 2. Overload halo visible on the extremity SLD

The N-1 overload halo never showed on a feeder because the overloads come
from the analysis result as grid2op **friendly names** (`MARSIL61PRAGN`)
while the SLD cells are keyed by **IIDM id** (`relation_8423569-225`) — a
direct lookup missed. (The contingency halo worked because
`selectedContingency` is already IIDM-id-keyed.)

`utils/svg/feederLabels.ts::buildFriendlyToEquip` / `overloadCandidates`
bridge friendly name → IIDM id via the `feeder_labels` map (each entry's
`name`), with the raw value as a fallback (covers id-keyed overload lists).
The overload-highlight pass in `SldOverlay.tsx` now resolves through that
bridge before `findCellForEquipment`.

## 3. Explaining the "after" loading of a line opened at one end

When an action **opens the overloaded line at one end** (a breaker
manoeuvre), the action card reported e.g. `33 %` for it while the SLD / NAD
showed it dashed with **zero flow** — which read as a contradiction.

It is **not** a bug: it is real physics. A line open at one end is out of
service for *active*-power transfer (`p ≈ 0`, which is what the diagrams
draw) but its line capacitance stays energised from the live end, so
pypowsybl reports a genuine **reactive charging current** there. On the
reported case that current is `i1 ≈ 43 A` with `q1 ≈ -16.8 MVAr` and
`p1 = 0`, and the current-based loading `rho = max(|i1|,|i2|)/limit =
43/130 ≈ 33 %`. (Confirmed by reproducing the scenario against
`expert_op4grid_recommender`'s `PypowsyblObservation` on the real grid; the
library is correct and was left unchanged.)

So the value is kept and **explained** rather than suppressed: when a
still-"overloaded" line ends up open at one end with a loading above ~1 %,
the card annotates it with the live-end reactive power.

- `simulation_helpers.build_half_open_reactive(network)` →
  `{branch_id_or_name: live_end_reactive_mvar}` for lines / transformers
  open at EXACTLY one terminal (`abs(q)` at the connected end), keyed by
  both IIDM id and friendly name.
- `simulation_helpers.half_open_branch_reactive_from_obs(obs)` reads it from
  `obs._variant_id` on `obs._network_manager` (restoring the working variant
  in a `finally`).
- `simulation_helpers.half_open_overload_notes(obs, names, rho_after)` keeps
  only the overloaded lines that are half-open with `rho_after > 0.01`, and
  `simulate_manual_action` attaches the result as `half_open_overloads` on
  the action result.
- The frontend `ActionCard.renderRho` appends an italic note — *"open one
  end · 16.8 MVAr capacitive"* — next to the loading, with a tooltip
  explaining it is charging current, not real flow. The field rides the
  save / reload triad (`sessionUtils` + `useSession`) so it survives a
  session reload.

## Tests

- Backend: `test_feeder_labels.py`, `test_half_open_overload.py`, and the
  `build_half_open_reactive` cases in `test_simulation_helpers.py`.
- Frontend: `utils/svg/feederLabels.test.ts` (relabel + `wrapFeederLabel` +
  `data-feeder-nav` tagging), the "feeder relabelling" / "overload halo via
  friendly name" / feeder-name navigation suites in
  `components/SldOverlay.test.tsx`, and the "half-open overload annotation"
  suite in `components/ActionCard.test.tsx`.
