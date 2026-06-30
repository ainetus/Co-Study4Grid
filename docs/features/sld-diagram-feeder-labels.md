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

## 3. Disconnected-overload loading matches the diagrams

When an action **disconnects the overloaded line itself**, the line
carries no flow — the SLD / NAD correctly draw it dashed with zero flow.
But the action card reported e.g. `33 %` for it, because grid2op's
forecast `obs.rho` can stay non-zero on a line opened by a switch action
(a backend obs-vs-variant desync).

The fix reads connectivity from the **post-action pypowsybl variant** —
the exact state the diagrams read — and zeroes those loadings so the card
agrees with the diagrams:

- `simulation_helpers.build_branch_connectivity(network)` →
  `{branch_id_or_name: is_disconnected}` (a branch is disconnected when
  either terminal is open), keyed by both IIDM id and friendly name.
- `simulation_helpers.disconnected_branch_names_from_obs(obs)` switches to
  `obs._variant_id` on `obs._network_manager` (restoring the working
  variant in a `finally`), reads connectivity, and returns the
  disconnected set.
- `compute_action_metrics(..., disconnected_line_names=…)` forces those
  branches' post-action rho to 0 before computing `rho_after`, `max_rho`
  and `lines_overloaded_after`, so the card, the SLD and the NAD all agree.

## Tests

- Backend: `test_feeder_labels.py`, `test_disconnected_overload_loading.py`,
  and the `compute_action_metrics` / `build_branch_connectivity` cases in
  `test_simulation_helpers.py`.
- Frontend: `utils/svg/feederLabels.test.ts` and the
  "feeder relabelling" / "overload halo via friendly name" suites in
  `components/SldOverlay.test.tsx`.
