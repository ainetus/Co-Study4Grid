# Interactive SLD topology edit → manual action

This feature lets the operator build a manual remedial action directly
from the Single Line Diagram by clicking switches. It mirrors the
`manoeuvre_ihm` tool in `expert_op4grid_recommender/scripts/` —
target-topology view with topological colouring, an editable maneuver
list, single / block deletion — adapted to the React + FastAPI stack
of Co-Study4Grid.

## TL;DR — the workflow

1. Open the SLD overlay on a voltage level (double-click on the NAD)
   in the **N-1 (contingency)** tab or the **action-variant** tab of
   an already-suggested action.
2. Click the **`✎ Manual action`** button in the SLD header to enter
   edit mode.
3. Click any operable switch on the diagram. The diagram is
   re-rendered as a **target-topology preview** (see below): the
   breaker is drawn in its target open/closed state, the busbar /
   branch connectivity is re-coloured by pypowsybl's topological
   colouring (so a node split / merge is immediately visible), and
   flow values are greyed because no load flow has been run yet. The
   changed switch keeps its dashed highlight (magenta = will open,
   blue = will close) **on top of** the preview, so the operator
   always sees WHERE the topology changed.
4. The side panel under the SVG lists every staged maneuver. From
   there, the operator can:
   - **Click a row** to focus a single switch (only its outline stays
     on the diagram — same affordance as `seq_highlights` in
     `manoeuvre_ihm`).
   - Click **`×`** on a row to remove that maneuver (`seq_delete`).
   - **Check** several rows + click **`Remove selected (N)`** to drop
     a block (`seq_delete_many`).
   - Click **`Reset`** to drop every staged change.
5. Click **`Simulate action`**. The backend simulates the user-built
   topology and emits a manual-action card in the Action Feed; the
   SLD overlay auto-focuses on the new action's `ACTION` tab so the
   post-action state is shown immediately (no manual tab switch).

When the edit was done **on a post-action SLD**, the resulting card
has a combined id `<base_action_id>+user_topo_<vl>_<ts>` so it appears
as a combined action (same visual treatment as `ComputedPairs`
cards).

## Target-topology preview

While toggles are staged, the frontend calls **`POST
/api/sld-topology-preview`** (debounced ~280 ms, with a sequence
guard dropping stale responses).

The backend (`get_topology_preview_sld` in
`expert_backend/services/diagram_mixin.py`) :

1. Resolves the source variant — the **contingency variant** by
   default, or the **post-action variant** when the request carries
   a `base_action_id` (the SLD was opened from an action card).
2. **Clones** a throwaway variant from it.
3. Applies the user's switch overrides via
   `network.update_switches(id=…, open=…)`.
4. Re-renders the VL SLD with
   `SldParameters(use_name=True, topological_coloring=True)`.
   Topological colouring is what makes a node split / merge visible:
   opening a coupling splits the busbar into two connected components
   that pypowsybl paints in distinct colours — the same affordance
   the `manoeuvre_ihm` target-topology view relies on. Falls back to
   default parameters if the installed pypowsybl predates
   `SldParameters`.
5. Returns `{ svg, sld_metadata, voltage_level_id, switch_states,
   stale_flows: true }`. **No load flow** runs — the flow values are
   stale, hence `stale_flows: true`.
6. **Always** removes the throwaway variant and restores the working
   variant in a `finally`, so the shared Network is never left
   mutated even if rendering raises.

The frontend renders the preview SVG in place of the baseline with
the `sld-preview-stale` CSS class greying every flow `<text>` and
arrow glyph until the operator commits the simulation.

## Backend contract

| Endpoint | Change |
|---|---|
| `POST /api/n-sld` | Response gains `switch_states: { switch_id: is_open }` for the requested VL. |
| `POST /api/contingency-sld` | Same. |
| `POST /api/action-variant-sld` | Same. The existing `changed_switches` diff is unchanged. |
| `POST /api/sld-topology-preview` | **NEW.** Body: `{ voltage_level_id, disconnected_elements, switches, base_action_id? }`. Response: `{ svg, sld_metadata, voltage_level_id, switch_states, stale_flows: true }`. |
| `POST /api/simulate-manual-action` | New optional body field `voltage_level_id` used to auto-name switch-only manual actions (`"Manoeuvre manuelle sur <vl>: SW_A ouvert, SW_B fermé"`). |
| `POST /api/simulate-and-variant-diagram` | Same `voltage_level_id` plumbing. The NDJSON stream is unchanged (`{type:"metrics"} → {type:"diagram"}`). |

**Operable switch filtering** — `extract_vl_switch_states`
(`expert_backend/services/diagram/sld_render.py`) reads
`network.get_switches(attributes=["open","voltage_level_id","kind","fictitious","retained"])`,
keeps only switches on the requested VL, and excludes
`fictitious=True` rows so internal-bookkeeping switches are not
editable. The fallback path (`["open","voltage_level_id"]`) handles
legacy pypowsybl builds that don't accept the extended attribute list.

**Combined-action id canonicalisation** —
`simulate_manual_action` registers a combined id under its
**canonical** (`"+"`-parts sorted alphabetically) key. The frontend
mints the raw, unsorted order (`base+user`), so `_require_action`
aliases the raw key onto the canonical entry before raising — every
later `get_action_variant_diagram` / `get_action_variant_sld` /
`get_topology_preview_sld` lookup works regardless of ordering. The
frontend ALSO adopts the canonical id (taken from `metrics.action_id`)
when registering the card so subsequent fetches start from the same
key.

## Frontend contract

| File | Role |
|---|---|
| `hooks/useSldTopologyEdit.ts` | Owns the pending overrides, focus state, and the toggle / removeSwitch / removeSwitches / reset / setFocusedSwitch API. Auto-drops stale overrides on baseline identity change. |
| `components/SldEditPanel.tsx` | Side panel under the SLD body — maneuver list, focus on row click, `×` per row, checkbox + **Remove selected (N)** for blocks, combined-with badge, Reset / Simulate buttons. |
| `components/SldOverlay.tsx` | Header `✎ Manual action` button, switch-click delegation via SLD metadata `equipmentId → SVG id` map (dot/underscore variants handled), toggle outlines + focused-switch filter — applied **also on the preview** so the highlight persists. |
| `App.tsx::handleSimulateSldEdit` | Streams `/api/simulate-and-variant-diagram` with `action_content={switches}` + `voltage_level_id`, primes the action-variant diagram under the **backend-canonical** id (`metrics.action_id`), pushes the card via `wrappedManualActionAdded(_, _, _, 'user')`, then `handleVlDoubleClick(id, vl, 'action')` to auto-focus the new action's tab. |
| `App.tsx::sldPreview` | Debounced fetch of `/api/sld-topology-preview` with sequence guard. |
| `styles/tokens.css` | `--signal-edit-open` / `--signal-edit-closed` token pair for the toggle outline. |
| `App.css` | `.sld-user-toggle-{open,closed}` (dashed outline) + `.sld-preview-stale` (grey flow values). |

### Edit-mode invariants

The hook drops every staged toggle when:
- the operator exits edit mode (`setEditMode(false)`),
- the baseline `switch_states` map identity changes (new SLD tab, new
  VL, or new action variant),
- the simulation succeeds (after the card is pushed).

The hook **silently ignores** taps on switches that aren't in the
baseline — this is the cheapest way to guarantee a user-built
`switches` payload only references operable equipment.

### Single-bucket vs multi-bucket type classification

A manual maneuver can toggle several switches in one go
(comma-joined) and a combined action joins maneuvers with `+`. A
single card therefore may belong to **multiple** action-type
buckets (open coupling **and** line disconnection, for example).
`utils/actionTypes.ts` exposes a multi-bucket
`classifyActionTypes(): Set<ActionTypeKind>` that handles this; the
existing singular `classifyActionType` keeps the fast-path for
non-maneuver cards. `matchesActionTypeFilter` routes through the Set
so a comma-joined `…COUCH6COUPL… ouvert, …COUCH6CPVAN.1… ouvert`
maneuver passes BOTH the **open coupling** and **line
disconnection** filters in the feed / overview / combine modal /
overflow-pin filters at once.

## Interaction-log events

| Event | Required payload | Optional |
|---|---|---|
| `sld_edit_mode_toggled` | `enabled` | |
| `sld_switch_toggled` | `equipment_id` | |
| `sld_maneuver_removed` | `equipment_ids` | |
| `sld_maneuver_focused` | `equipment_id` | |
| `sld_edit_reset` | — | |
| `sld_topology_simulated` | `voltage_level_id`, `switches` | `combined_with` |

Declared in the `InteractionType` union (`frontend/src/types.ts`),
mirrored in the conformance contract
(`frontend/src/utils/specConformance.test.ts` `SPEC` and
`scripts/check_standalone_parity.py` `SPEC_DETAILS`).

## Test coverage

### Backend (`expert_backend/tests/test_sld_topology_edit.py`)

- `TestExtractVlSwitchStates` — happy path, fictitious-row filter,
  pypowsybl-failure resilience, extended-attribute fallback.
- `TestExtractVlSwitchStatesEdgeCases` — corrupt-row skipping, missing
  VL, missing `fictitious` column.
- `TestIsSwitchOnlyContent` / `TestBuildSwitchActionDescription` /
  `TestBuildSwitchActionDescriptionShape` — auto-description contract
  that the frontend filter parser depends on (the action-type
  classifier looks for `coupl` + `ouvert`/`fermé` per clause).
- `TestSimulateManualActionSwitchOnly` — `_inject_action_content_entries`
  builds a switch-only entry with the right description (with or
  without VL).
- `TestTopologyPreviewSld` — clones + applies + removes + restores
  even on render failure.
- `TestTopologyPreviewEmptyAndPostAction` — empty-switches no-op +
  post-action path using the action's network manager.
- `TestRequireActionCanonicalAlias` / `TestCanonicalAliasSymmetry` —
  combined-id ordering symmetry (`A+B` and `B+A` resolve identically,
  canonicalisation is idempotent).
- `TestSldEndpointSwitchStates` — `switch_states` round-trip on the
  N-SLD endpoint.
- `TestSldTopologyPreviewEndpoint` + `TestSimulateManualActionEndpointPlumbsVoltageLevel`
  — HTTP-boundary tests via FastAPI `TestClient` (skipped in sandboxes
  that mock `expert_op4grid_recommender.models`).

### Frontend

- `hooks/useSldTopologyEdit.test.ts` — toggle / reset / remove single /
  remove block / focus / baseline-change pruning / interaction-log
  emissions.
- `components/SldEditPanel.test.tsx` — empty state, per-row direction
  display, focus on row click, `×` removal, block removal, busy
  state, combined-with badge.
- `utils/actionTypes.test.ts` — multi-bucket classifier coverage
  (open/close/disco/reco from manual maneuvers), combined open+close
  card, comma-joined coupling + line, line-only maneuvers, ligature
  spelling, regression that singular classifier still returns one
  bucket for normal cards.
- `utils/specConformance.test.ts` — `SPEC` rows for the six
  `sld_*` interaction types.

## Limitation: which backend

Co-Study4Grid runs the **pypowsybl** backend exclusively
(`recommender_service._get_simulation_env()` always instantiates
`SimulationEnvironment` from
`expert_op4grid_recommender.pypowsybl_backend`). Switch-based actions
are fully supported on that path
(`pypowsybl_backend.action_space.SwitchAction`). The grid2op native
backend in `expert_op4grid_recommender` ignores the `switches` content
key silently — not a concern here, but worth keeping in mind if the
feature is ever ported to a grid2op-only deployment.
