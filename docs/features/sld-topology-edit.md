# Interactive SLD topology edit → manual action

## What it does

From the SLD overlay opened on an **N-1 (contingency)** or
**post-action** voltage-level diagram, the operator can:

1. Click `Edit` to enter topology-edit mode.
2. Click any switch on the diagram to stage a toggle. The breaker is
   highlighted with a dashed outline:
   - magenta = will open (`sld-user-toggle-open`)
   - blue    = will close (`sld-user-toggle-closed`)
3. Click `Reset` to drop the staged toggles, or `Simulate action` to
   send the user-built topology to the backend.

The result lands in the Action Feed as a manual action card. When the
edit was done on a **post-action SLD**, the card is created with a
combined id `<base_action_id>+user_topo_<vl>_<ts>` so it appears as a
combined action (same visual treatment as `ComputedPairs` cards).

This mirrors the `manoeuvre_ihm` IHM in
`expert_op4grid_recommender/scripts/manoeuvre_ihm.py` — same boolean
`{switch_id: is_open}` contract — adapted to the React/FastAPI stack.

## Backend contract

`/api/n-sld`, `/api/contingency-sld`, `/api/action-variant-sld` now
include a `switch_states: {switch_id: is_open_bool}` field listing
every **operable** switch on the requested voltage level. Source:
`extract_vl_switch_states` in
`expert_backend/services/diagram/sld_render.py`. Fictitious and
non-existent switches are filtered out, so this map is the source of
truth for what is editable.

`/api/simulate-manual-action` and `/api/simulate-and-variant-diagram`
gained an optional `voltage_level_id` field. When supplied alongside
an `action_content` that only carries a `switches` key, the backend
auto-generates a human-readable description (`"Manoeuvre manuelle sur
<vl>: SW_A ouvert, SW_B fermé"`) instead of falling back to the
synthetic action id.

No new endpoints. Co-Study4Grid runs the pypowsybl backend
exclusively (`recommender_service._get_simulation_env()` always
instantiates `SimulationEnvironment` from
`expert_op4grid_recommender.pypowsybl_backend`), so the switch action
path is always supported.

## Frontend contract

- `hooks/useSldTopologyEdit.ts` owns the pending overrides.
- `components/SldEditPanel.tsx` renders the side-panel.
- `components/SldOverlay.tsx` delegates clicks on switch DOM elements
  via the SLD metadata `equipmentId → SVG id` map (same chain used by
  the delta and highlight passes — dot/underscore variants handled).
- The Simulate handler in `App.tsx` (`handleSimulateSldEdit`)
  streams `/api/simulate-and-variant-diagram`, primes the
  action-variant diagram, and pushes the new card via
  `wrappedManualActionAdded(_, _, _, 'user')`.

## Interaction-log events

| Event | Payload |
|---|---|
| `sld_edit_mode_toggled` | `{ enabled }` |
| `sld_switch_toggled` | `{ equipment_id }` |
| `sld_edit_reset` | `{}` |
| `sld_topology_simulated` | `{ voltage_level_id, switches, combined_with }` |

Declared on the `InteractionType` union in `types.ts`.
