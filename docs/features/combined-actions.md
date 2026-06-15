# Combined Actions

## Overview

Combined actions allow operators to evaluate the effect of applying **two remedial actions simultaneously** to resolve a contingency. The feature provides two complementary approaches:

- **Superposition estimation** -- a fast linear approximation using beta coefficients, avoiding a full simulation
- **Full simulation** -- an exact grid simulation of both actions applied together

Both approaches are exposed through a two-tab modal ("Computed Pairs" and "Explore Pairs") accessible via the **Combine** button in the ActionFeed panel.

---

## Architecture

### Data flow

```
┌──────────────────────────────────────────────────────────┐
│  Analysis phase (run_analysis)                           │
│                                                          │
│  expert_op4grid_recommender computes promising pairs     │
│  ──► combined_actions dict with is_estimated=True        │
│  ──► Filtered OUT of main actions feed (no '+' in keys)  │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│  CombinedActionsModal                                    │
│                                                          │
│  Computed Pairs tab       │  Explore Pairs tab           │
│  Shows pre-computed       │  User selects any 2 actions  │
│  pairs from analysis      │  ──► POST /compute-          │
│                           │      superposition           │
│  [Simulate] per row       │  ──► Shows estimation +      │
│                           │      [Simulate Combined]     │
└────────────┬──────────────┴──────────────┬───────────────┘
             │                             │
             ▼                             ▼
┌──────────────────────────────────────────────────────────┐
│  POST /api/simulate-manual-action                        │
│  action_id = "act1+act2"                                 │
│                                                          │
│  Backend splits on '+', combines grid2op action like     │
│  objects, runs full AC (or DC fallback) simulation       │
│  ──► Returns is_estimated=False with full rho data       │
└──────────────────────────────────────────────────────────┘
```

### Key files

| File | Role |
|------|------|
| `frontend/src/components/CombinedActionsModal.tsx` | Modal UI: two tabs, estimation preview, simulation feedback |
| `frontend/src/components/ComputedPairsTable.tsx` | Computed-pairs table (PR #103 split) |
| `frontend/src/components/ExplorePairsTab.tsx` | Explore-pairs panel (PR #103 split) |
| `frontend/src/components/ActionFeed.tsx` | Opens modal, passes `onManualActionAdded` as callback |
| `frontend/src/components/ActionCard.tsx` | Renders clickable sub-action badges for every member of a combined pair (PR #114, `7e68ef3`) |
| `frontend/src/api.ts` | `simulateManualAction()`, `computeSuperposition()` |
| `frontend/src/types.ts` | `CombinedAction`, `ActionDetail` interfaces |
| `expert_backend/main.py` | `/api/simulate-manual-action`, `/api/compute-superposition` endpoints |
| `expert_backend/services/simulation_mixin.py` | `simulate_manual_action()`, `compute_superposition()` orchestrators (helpers in `simulation_helpers.py`, PR #104) |

---

## Combined Action ID Format

A combined action is identified by joining two action IDs with `+`:

```
"3617076a-a7f5-4f8a-..._VIELMP6_coupling+3617076a-a7f5-4f8a-..._CPVANP6_coupling"
```

The backend splits on `+` to recover individual IDs:

```python
action_ids = action_id.split("+")  # recommender_service.py:1420
```

Throughout the codebase, `id.includes('+')` (frontend) or `"+" in aid` (backend) is used to detect combined actions.

---

## Estimation vs Simulation

### Superposition estimation

Uses the linear superposition theorem to **approximate** the combined loading without running a full simulation.

**Backend method:** `recommender_service.compute_superposition()` (line 1604)

**Formula** (line 1712-1716):

```
rho_combined = abs(
    (1 - beta1 - beta2) * rho_n1  +  beta1 * rho_act1  +  beta2 * rho_act2
)
```

Where:
- `rho_n1` = line loadings in the N-1 state (contingency only, no action)
- `rho_act1` = line loadings after applying action 1 alone
- `rho_act2` = line loadings after applying action 2 alone
- `beta1, beta2` = superposition coefficients computed by `compute_combined_pair_superposition()` from the recommender library

**API:** `POST /api/compute-superposition` with `{ action1_id, action2_id, disconnected_element }`

**Returns:** `CombinedAction` with `betas`, `max_rho`, `max_rho_line`, `is_rho_reduction`, `rho_after`, `rho_before`

**Flag:** Results always have `is_estimated: true`

#### Generalized Superposition Theorem (GST) — injection actions

The EST formula above combines two **topology** actions. When a pair involves an
**injection** action — load shedding (`set_load_p`), curtailment / redispatch
(`set_gen_p`) — `compute_superposition` detects it via
`simulation_helpers.is_injection_action` and forwards `act1_is_injection` /
`act2_is_injection` to `compute_combined_pair_superposition`, which routes to the
library's **GST** (`compute_combined_pair_gst`).

The integration point is deliberately thin: the GST reports an injection action
with **`beta = 1.0`** and the topology action with its (injection-shifted) beta.
With that convention the EST `rho_combined` formula above is **unchanged** — it
already reproduces the exact GST loading — so `compute_combined_rho` and
`_augment_superposition_result` need no GST-specific branch. The only backend
changes are: (1) detect injection actions, (2) skip the "cannot identify
elements" bail-out for them (they carry no topology element), (3) pass the
injection flags through.

On the frontend the Explore Pairs tab no longer blocks estimation for
LS / curtailment / redispatch (`hasRestricted` is always `false` now, and the
"cannot be combined for estimation" caveats were removed).

### Full simulation

Combines individual grid2op action objects and runs a full load flow.

**Backend method:** `recommender_service.simulate_manual_action()` (line 1412)

**Key logic** (lines 1471-1482):

```python
action = None
for aid in action_ids:
    a_obj = env.action_space(self._dict_action[aid]["content"])
    if action is None:
        action = a_obj
    else:
        action = action + a_obj   # grid2op action combination
```

**API:** `POST /api/simulate-manual-action` with `{ action_id: "act1+act2", disconnected_element }`

**Returns:** Full simulation results with `rho_before`, `rho_after`, `max_rho`, islanding info, convergence status

**Flag:** Results always have `is_estimated: false`

---

## The `is_estimated` Flag

This flag is central to filtering and display logic:

| Value | Meaning | Source |
|-------|---------|--------|
| `true` | Result comes from superposition estimation | `compute_superposition()`, or `run_analysis()` combined_actions |
| `false` | Result comes from full simulation | `simulate_manual_action()` |

**Frontend filtering** (`ActionFeed.tsx:285-296`): combined actions only appear in the main action list when `is_estimated === false` and `rho_after` has data. This prevents estimated-only pairs from cluttering the action feed.

**Computed Pairs tab** (`CombinedActionsModal.tsx:59`): the `isSimulated` flag is derived as:

```typescript
const isSimulated = simulatedData && !simulatedData.is_estimated
    && simulatedData.rho_after && simulatedData.rho_after.length > 0;
```

---

## Frontend: CombinedActionsModal

### Props

```typescript
interface Props {
    isOpen: boolean;
    onClose: () => void;
    analysisResult: AnalysisResult | null;
    disconnectedElement: string | null;
    onSimulateCombined: (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => void;
    monitoringFactor?: number;     // defaults to 1.0
}
```

`onSimulateCombined` is wired to `onManualActionAdded` in `ActionFeed.tsx` (line 938). The modal handles the simulation API call internally and passes results back through this callback.

### Internal state

| State | Type | Purpose |
|-------|------|---------|
| `activeTab` | `'computed' \| 'explore'` | Current tab |
| `selectedIds` | `Set<string>` | Selected actions in explore tab (max 2) |
| `preview` | `CombinedAction \| null` | Superposition estimation result |
| `simulating` | `boolean` | Whether a simulation is in progress |
| `simulationFeedback` | `SimulationFeedback \| null` | Results from full simulation |
| `loading` | `boolean` | Whether estimation is being fetched |
| `error` | `string \| null` | Error message |

### Tab: Computed Pairs

Displays pre-computed pairs from `analysisResult.combined_actions`. Each row shows:
- Action 1 & 2 IDs
- Betas coefficients
- Estimated max loading (from superposition)
- Simulated max rho (if already simulated, from `analysisResult.actions[pairId]`)
- Simulate / Re-Simulate button

The Simulate button calls `handleSimulate(pairId)` which runs the full simulation via `api.simulateManualAction()`.

### Tab: Explore Pairs

Allows manual selection of any two non-combined actions. When exactly 2 are selected, a superposition preview is auto-fetched via `api.computeSuperposition()`.

The preview section shows two columns side by side:

| ESTIMATION | SIMULATION FEEDBACK |
|------------|---------------------|
| Max loading from superposition | Actual max loading from simulation |
| Line name | Line name |

The "Simulate Combined" button (in the modal footer, visible only when a preview exists) triggers `handleSimulate()` which:
1. Calls `api.simulateManualAction()` with the combined ID
2. Stores feedback in `simulationFeedback` state (displayed in the right column)
3. Notifies the parent via `onSimulateCombined()` to add the action to the main list

State cleanup:
- `simulationFeedback` is cleared when `selectedIds` changes (new pair selected)
- All state resets when the modal closes

---

## Standalone distribution

No separate hand-maintained mirror exists any more. The single-file
distribution is `frontend/dist-standalone/standalone.html`,
auto-generated from the same React source via `npm run build:standalone`
(PR #101); it inherits the `CombinedActionsModal` component, its
state, and every handler byte-for-byte. The legacy
`standalone_interface.html` — which used a separate
`isSimulatingCombined` / `combinedSimulationFeedback` state machine
and an explicit "Estimate Combination effect" button — has been
decommissioned and frozen as `standalone_interface_legacy.html`.

---

## Recent updates (PR #114, release 0.6.5)

PR #114 extended the combined-actions workflow in four user-visible
ways:

- **Load-shedding and curtailment are now allowed in combined pairs**
  (commit `a019555`). Previously restricted to topology actions, the
  Explore Pairs tab now accepts LS / curtailment on either side. As of
  the Generalized Superposition Theorem work (see "Generalized
  Superposition Theorem (GST)" below) the **superposition-estimation
  path also handles these injection actions** — they no longer require
  a full simulation just to preview the combined loading.
- **"Simulate Combined" moved out of the action card** (commit
  `e871006`). The trigger now lives in the modal footer. After a
  simulate-only pair lands, the resulting card is shown in the main
  feed with all sub-action badges clickable
  (`ActionCard.tsx`, commit `7e68ef3`) so the operator can inspect
  each constituent in isolation.
- **`target_max_rho` on the user-selected overload set** (commit
  `a5d34da`). Superposition + simulation both now compute the max rho
  restricted to the lines the operator explicitly flagged as
  "resolve" in step-1. It is reported alongside the unrestricted
  `max_rho` so the operator can tell whether a pair actually solves
  their scenario or merely shifts the hot spot elsewhere.
- **Explore-Pairs re-estimation aligned with pre-computed betas**
  (commit `fd34eeb`). When a pair already has a `combined_actions`
  entry from the analysis phase, the Explore tab now reuses those
  betas instead of re-fetching — eliminating a subtle drift where
  the re-estimate could disagree with the Computed Pairs row.

Backend correctness fixes in the same release that the doc must be
read against:

- `simulate_manual_action` now reuses the step-1 observation as the
  simulation baseline (commit `198c0ed`), and `run_analysis_step2`
  restores `enriched_actions` after the streaming pass
  (`a0bc1a3`). The N-1 variant is pinned right before `obs.simulate`
  on the combined-pair code path (`2ef61d5`) so residual state from
  a previous action cannot leak into the combined observation.

---

## Backend Details

### Action combination (grid2op)

Grid2op supports action addition natively. When two actions are combined:

```python
action = action1 + action2
```

This merges their topology changes (bus assignments, line reconnections, etc.) into a single action object that is then applied to the environment.

### On-demand simulation for superposition

`compute_superposition()` requires observations for both actions. If an action hasn't been simulated yet, it auto-triggers `simulate_manual_action()` first (lines 1625-1630):

```python
if action1_id not in all_actions:
    self.simulate_manual_action(action1_id, disconnected_element)
    all_actions = self._last_result["prioritized_actions"]
```

### Pre-existing overload filtering (symmetric impact rule)

The superposition result filters out lines with pre-existing overloads (lines already overloaded in N state) **only when the combined action does not impact them** — i.e. their combined rho stays inside a symmetric ±`worsening_threshold` band around the N-state baseline (default 2%). Lines that the action significantly **worsens OR improves** belong to its sensitive area and remain monitored:

```python
is_pre_existing = base_rho_n >= monitoring_factor
not_impacted = (rho_combined >= base_rho_n * (1 - worsening_threshold)) & \
               (rho_combined <= base_rho_n * (1 + worsening_threshold))
eligible_mask = care_mask & ~(is_pre_existing & not_impacted)
```

The symmetric form replaces the previous one-sided `not_worsened` rule, which silently dropped lines whose pre-existing overload was significantly *reduced* by the action — hiding genuine action impact from the operator. The same rule is applied uniformly across `simulation_helpers.build_care_mask`, `simulation_helpers.resolve_lines_overloaded`, `simulation_mixin._augment_superposition_result`, `simulation_mixin._superposition_lines_overloaded`, and `diagram/overloads.get_overloaded_lines` so the N Overloads UI panel, the simulation `max_rho`, and the superposition estimate all agree.

### Analysis-time combined actions

During `run_analysis()` (line 475-482), the recommender library identifies promising pairs automatically. These are:
- Stored in `combined_actions` dict with `is_estimated: true`
- Filtered **out** of the main `actions` dict (no `+` keys leak into the action feed)
- Displayed in the Computed Pairs tab

---

## Development Checklist

When modifying combined actions logic:

- [ ] Edit `CombinedActionsModal.tsx` / `ComputedPairsTable.tsx` /
      `ExplorePairsTab.tsx` only — the auto-generated standalone
      bundle inherits the change via `npm run build:standalone`.
- [ ] The `is_estimated` flag must be `false` only when results come from `simulate_manual_action`
- [ ] Combined action IDs use `+` as separator -- never sort or reorder the parts
- [ ] `onClick` handlers for functions with default parameters must use arrow wrappers
- [ ] `onSimulateCombined` signature is `(actionId, detail, linesOverloaded)` -- it maps to `onManualActionAdded`
- [ ] `simulationFeedback` state must be cleared when the selected pair changes
- [ ] The modal must stay open during simulation so the user sees feedback
- [ ] Test both tabs: Computed Pairs uses `handleSimulate(pairId)`, Explore uses `handleSimulate()` (no args)
- [ ] Load-shedding / curtailment / redispatch pairs work via BOTH the
      estimation preview (GST) and full simulation. When adding a new
      injection-type action, make sure `is_injection_action`
      (`simulation_helpers.py`) recognises its id prefix / classifier
      type so `compute_superposition` routes the pair to the GST.
