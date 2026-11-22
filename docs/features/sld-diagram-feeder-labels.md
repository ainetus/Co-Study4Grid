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

Each branch feeder with a known far-end VL is tagged with `data-feeder-nav` =
the far-end VL id (the `other_vl` field) and the `sld-feeder-navigable` class
(dotted underline + pointer cursor) — **whether or not it is relabelled**. On
grids whose VLs carry no friendly name (the RTE Matpower grids: `label` is
`null`) the feeder keeps pypowsybl's own label, which is not the branch id
either (`CHOLE1` for `CHOLEL41HERBI`), so the label `<text>` is located through
the feeder group's escaped SVG id (`id<eid>_95_<ONE|TWO|THREE>`, pypowsybl's
`IdUtil.escapeId`) when the text-content match fails. `hooks/useSldFeederNav.ts` installs one delegated
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
bridge before `findCellForEquipment`. Which lines get a halo, and when
(the N-1 diagram's overloads before any analysis, the lines still
overloaded after an action), is in [`sld-halos.md`](sld-halos.md).

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

## 4. Every element by its name — injections, busbars, switches, the title

Branch feeders were relabelled; the rest of the SLD still showed raw ids: the
title (`VL_way_1271288345-400`), the generators (`G_way_1271288345-400`,
`…_WST`), the loads (`L_way_1271288345-400`), the busbars
(`VL_way_1271288345-400_BBS1`) and, in the maneuver list, the switches
(`VL_way_1271288345-400_BK_relation_5674501-400_s1`). They now read by name,
every id kept one hover (tooltip) or one click (copy) away.

**Naming rules** (`expert_backend/services/element_names.py`, one rule for
every view):

- *Generator / load* — `injection_display_name`: its own name when real
  (`MANDARINS 400kV Solar`, `Blayais 1`, `Exchange with GB`), else the plant
  matched onto the generator in the bundle's `power_plants.json`
  (`context_map/plants.load_plant_names` — the largest named plant, a
  nuclear site or a plant with ENTSO-E codes, when it is most of the
  capacity matched there: `Gravelines`, `Landivisiau`), else what it is and
  where: `Generator — MANDARINS 400kV`, `Load — MANDARINS 400kV`. Unnamed
  injections of one kind sharing a voltage level are numbered
  (`Load 1 — X`, `Load 2 — X`).
- *Switch* — `switch_display_name`, from the feeder its bay serves, found by
  walking the voltage level's node-breaker graph from the switch without
  crossing a busbar (`equipment_names.switch_names`): `disjoncteur
  MANDAL71WARAN`; a busbar-selection disconnector names its busbar too
  (`sectionneur MANDAL71WARAN (MANDARINS JdB1)`); a bay serving no feeder is
  the coupling (`disjoncteur de couplage`). French, the language of the
  manoeuvre descriptions; a bus-breaker voltage level keeps its ids.
- *Busbar* — its own name when real (`MANDARINS JdB1`).
- *Voltage level with no name of its own* — `nameless_bus_name`, from the
  real substations it ties (`equipment_names.VoltageLevelNames`). PyPSA-EUR
  puts *virtual buses* on its lines — T-taps and line junctions, ids
  `VL_virtual_relation_…` / `VL_virtual_way_…`, 191 in fr225_400. They are
  points on a line, never substations, so they never keep the name the
  pipeline gave them: their line's RTE code (`COQUAL61TOURB 225kV`, 88), its
  OSM name (`Liaison 225 kV n°2 Échalas - Le Soleil 225kV`, 37) — a line's
  name in a voltage-level label — or their raw id
  (`virtual_relation_10012409_a_1-225 225kV`, 66). The 11 substations OSM
  never named read the same way, and `RAW_OSM_NAME` now flags the
  `virtual_` ids too. Walking the lines through the other virtual / nameless
  buses, such a bus reads by its nearest real substations — every one a hop
  away (at most three), completed with the next nearest up to two:
  `Piquage EMALES(LES) / RANVILLE 225kV` for a virtual bus ("piquage", the
  RTE term for a tap), `Poste près de BEAUTOR / CAPELLE (LA) 225kV` for an
  unnamed substation; two that would read alike are numbered
  (`Piquage CHANCEAUX (2) 225kV`). Seen from a line (`seen_from`), it leaves
  out the substation at the line's other end: in RANVILLE's SLD the feeder
  to that tap reads `Piquage EMALES(LES) 225kV`, and the raw-named line
  reads `RANVILLE — Piquage EMALES(LES)`. Names the pipeline built from the
  bus's name follow (`rewrite`, `injection_names`): the generators `Piquage
  EMALES(LES) / RANVILLE 225kV Solar`, a transformer's `G.SOL - Piquage G.SOL
  (2)`; a line keeps its own name. One namer
  serves the voltage-level name map (`/api/voltage-levels`), the line names
  (`/api/branches`, the Context tab), the SLD far ends and the injection
  fallbacks — cached per study by `network_service.voltage_level_namer`.

**Where they show**:

| Place | How |
|---|---|
| SLD title | `displayName(vlOverlay.vlName)` (`MANDARINS 400kV`), the id in the tooltip and a copy button (`CopyIdButton`) |
| NAD voltage-level labels | only substations are labelled: `applyVlNameBoxes` (run by `attachVlInteractions` on the N / N-1 / action tabs and by the action overview) hides a virtual bus's name box and connector — a point on a line, its `Piquage …` name shows on hover — and gives an unnamed substation's box its display name, once per diagram |
| Generator / load / busbar labels | `build_feeder_labels(network, vl, injections, display_names)` adds them to `feeder_labels` (`kind` = `generator` / `load` / `busbar`); `applyFeederRelabels` swaps them like a branch — a busbar label is never wrapped |
| Hover on any relabelled feeder | a `<title>` on its feeder group: the raw id (`MANDAL71WARAN · relation_5674501-400` for a branch) — never inside the `<text>`, whose content the label passes match on |
| Injection name buttons (edit mode) | found by `data-feeder-equip` (the equipment id every relabelled text carries) once their text reads a name |
| Maneuver list / injection editor | the SLD payloads carry `switch_labels` (`switch_names`); `SldEditPanel` and `SldInjectionPopover` read them and the injection feeder labels |
| The manual action card | the backend describes the simulated manoeuvre in the same names — see [`action-card.md`](action-card.md) |

The topology preview renders with `use_name=True`, so its labels are names,
not ids: `findFeederText` then finds an injection or a busbar by its group id
(`id<escaped id>`, no side suffix) as it does a branch.

The generator / load names of the whole network are computed once per study
(`network_service.get_display_names`, cached and cleared on load) and ride
the `/api/branches` name map, so the action cards name injections too.

## Tests

- Backend: `test_feeder_labels.py`, `test_half_open_overload.py`, the
  `build_half_open_reactive` cases in `test_simulation_helpers.py`,
  `test_element_names.py` (the naming rules) and `test_equipment_names.py`
  (injection / busbar / switch names on a node-breaker layout, plant names,
  the manual description, `name_switches_in`, the SLD payload's
  `switch_labels` + injection labels, the nameless buses: taps, chains,
  numbering, `seen_from`, `rewrite`, the line names and the SLD far end),
  plus the virtual-bus case of `test_context_map.py`.
- Frontend: `utils/svg/feederLabels.test.ts` (relabel + `wrapFeederLabel` +
  `data-feeder-nav` tagging, injections / busbars / tooltips / preview
  group-id lookup), the "feeder relabelling" / "overload halo via friendly
  name" / feeder-name navigation / readable title / relabelled name-button
  suites in `components/SldOverlay.test.tsx`, the named maneuver list in
  `SldEditPanel.test.tsx`, the NAD name boxes in
  `utils/svg/vlInteractions.test.ts`, and the "half-open overload
  annotation" suite in `components/ActionCard.test.tsx`.
