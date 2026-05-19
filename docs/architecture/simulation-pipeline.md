# Simulation pipeline — Co-Study4Grid backend

This document explains what happens between the moment an operator
clicks **"Analyze & Suggest"** (or stars a single action) in the React
UI and the moment a result lands back in their browser. It focuses on
the simulation mechanics, the parameters that are exposed, the
hypotheses that are baked in, and the modes the system supports.

> **Start here for the simulation deep-dive.** Anything below that
> mentions `obs.simulate`, `run_load_flow`, a load-flow mode, voltage
> initialisation, variant management, the `DC_VALUES` fallback or
> the `maxOuterLoopIterations` cap is **implemented in the lib** — the
> backend just wires the right knobs. The full mechanism, the four
> orthogonal LF knobs and every retry branch are documented in the
> sister doc:
> **[`Expert_op4grid_recommender/docs/architecture/simulation-pipeline.md`](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/architecture/simulation-pipeline.md)**.
> The present file describes the **backend-side glue** that exposes
> that machinery through the FastAPI endpoints and the React UI.
> Sections 4.4 and 5.2 below also surface the **fast vs slow mode**
> cheat-sheet inline for quick reference — for the rationale and the
> retry tree, keep the lib doc handy.

## 1. High-level flow

```
React UI                FastAPI                  RecommenderService              expert_op4grid_recommender
   │                       │                            │                                      │
   ├─ POST /api/config ───▶│── update_config(settings) ▶│── SimulationEnvironment(network) ───▶│ pn.load(.xiidm)
   │                       │                            │   prefetch base NAD                  │ LF (DC_VALUES seed)
   │                       │                            │                                      │
   ├─ POST /api/run-analysis-step1 ───▶│ run_analysis_step1                                    │
   │  {disconnected_elements}          │  simulate contingency → obs_N1                        │ obs.simulate(disconnect)
   │                       │           │  detect overloads (rho > 1)                           │
   │                       │           │  cache (obs_N, obs_N1) on _analysis_context          │
   │                       │◀──────────│  lines_overloaded_names                              │
   │                       │                            │                                      │
   ├─ POST /api/run-analysis-step2 ───▶│ run_analysis_step2_discovery                          │
   │  {selected_overloads}             │  RecommenderModel.recommend(inputs)                   │
   │                       │           │  reassess_prioritized_actions                         │ ×N obs.simulate(action)
   │                       │           │  compute_combined_pairs (superposition)               │
   │                       │◀── stream {type:"pdf"} ──◀ overflow_graph_path
   │                       │◀── stream {type:"result",                                         │
   │                       │            prioritized_actions, ...} ──◀                          │
   │                       │                            │                                      │
   ├─ POST /api/simulate-manual-action ▶│ simulate_manual_action                               │
   │  {action_id}                       │  resolve action vs _dict_action                      │
   │                       │            │  obs_simu_defaut.simulate(action,                    │
   │                       │            │       keep_variant=True, fast_mode=…)                │ obs.simulate(action)
   │                       │◀───────────│  serialize result (NumPy → JSON)                     │
```

Every UI gesture (`branch select`, `action star`, `pair compute`) ends
up at one of the five endpoints above. The backend is **stateless from
the client's perspective** — every request carries the contingency
and the action ids it needs — but **stateful internally**: a single
`RecommenderService` singleton holds the loaded network, the action
dictionary, observation caches, and analysis context across requests.

## 2. Architectural layout

```
expert_backend/services/
├── network_service.py             # raw pypowsybl Network + metadata
├── recommender_service.py         # state lifecycle, composes the 3 mixins
├── diagram_mixin.py + diagram/    # NAD/SLD rendering (not in this doc)
├── analysis_mixin.py + analysis/  # run_analysis_step1, step2
├── simulation_mixin.py            # simulate_manual_action, compute_superposition
└── simulation_helpers.py          # 14 pure helpers (metrics, setpoints, …)
```

### 2.1 Two module-level singletons

`network_service` owns the `pp.network.Network` object loaded by
`pn.load(...)`. Read-only consumers (`/api/branches`,
`/api/voltage-levels`, …) hit it directly. It does NOT switch
variants.

`recommender_service` owns the analysis state:

| Attribute | Purpose |
|---|---|
| `_base_network` | shared `pp.network.Network` (re-used from `network_service`, no second `pn.load`). |
| `_simulation_env` | `SimulationEnvironment` (lib) wrapping `_base_network`. |
| `_cached_env_context` | bundle of (env, action_space, name_sub, …) reused across step1 calls. |
| `_dict_action` | full action dictionary from `action_file_path` + auto-generated `disco_*`. |
| `_analysis_context` | `{obs, obs_simu_defaut, lines_overloaded_names, …}` captured at step1, reused at step2 / manual / superposition. |
| `_cached_obs_n1` | post-contingency observation built once per (network, contingency). Drives the `prebuilt_obs_simu_defaut` fast path of `run_analysis_step1`. |
| `_last_result` | last `{prioritized_actions, action_scores, …}` payload. Survives reload via the session JSON. |
| `_last_step2_signature` | identity of (network, contingency, lines_overloaded, model). Reused step2 → step2 skips overflow-graph rebuild on a model swap. |

The two singletons share **the same Network** because
`recommender_service._get_base_network()` mutualises
`network_service.network`. Safe because:

- `network_service` only reads.
- `recommender_service` always restores the working variant in a
  `try/finally` (see `_ensure_n_state_ready`, `_ensure_n1_state_ready`,
  `_ensure_contingency_state_ready`).

### 2.2 Mixin composition

`RecommenderService` inherits from `DiagramMixin`, `AnalysisMixin`,
`SimulationMixin`. They all operate on the same `self`. State
lifecycle (`__init__`, `reset`, `update_config`) stays in
`recommender_service.py`. Read the three mixins as one class split
across files for readability.

Pure numerics (no `self` access) live in helper packages
(`diagram/`, `analysis/`, `simulation_helpers.py`) so they can be
unit-tested without booting a FastAPI app.

## 3. State lifecycle

### 3.1 First load (`POST /api/config`)

1. `network_service.load_network(path)` — `pn.load(.xiidm)`.
2. `recommender_service.update_config(settings)`:
   - `expert_op4grid_recommender.config` globals are written from the
     pydantic `ConfigRequest` payload:
     `ENV_PATH`, `LAYOUT_FILE_PATH`,
     `PYPOWSYBL_FAST_MODE`, `MONITORING_FACTOR_THERMAL_LIMITS`,
     `PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD`,
     `MIN_LINE_RECONNECTIONS`, `MIN_CLOSE_COUPLING`,
     `MIN_OPEN_COUPLING`, `MIN_LINE_DISCONNECTIONS`, `MIN_PST`,
     `MIN_LOAD_SHEDDING`, `MIN_RENEWABLE_CURTAILMENT_ACTIONS`,
     `N_PRIORITIZED_ACTIONS`, `IGNORE_RECONNECTIONS`,
     `VISUALIZATION_FORMAT` (= `"html"`).
   - `prefetch_base_nad_async()` spawns a daemon thread that
     pre-computes the base NAD so the next `/api/network-diagram` is
     near-instant.
   - The action dictionary is loaded (`load_actions`) and enriched
     (`enrich_actions_lazy`). Missing `disco_*` entries are auto-built.
   - A `SimulationEnvironment` is constructed and cached on
     `_cached_env_context`. Its constructor runs an **initial LF
     seeded with `DC_VALUES`** (see § 3 of the lib doc) so the working
     variant is in a valid state before the first user action.

### 3.2 Reload (any subsequent `POST /api/config`)

`recommender_service.reset()` is invoked **before** the new network is
loaded. It must clear every per-study cache. The exhaustive list is
documented in
[`docs/features/state-reset-and-confirmation-dialogs.md`](../features/state-reset-and-confirmation-dialogs.md).

Drain order matters: `_drain_pending_base_nad_prefetch()` runs first
so a still-running prefetch thread cannot race-write into the next
study's cache.

### 3.3 Session reload (`POST /api/load-session`)

Restores a previously saved `session.json` (config + contingency +
prioritized actions with status tags + combined pairs). Calls
`restore_analysis_context()` to repopulate `_analysis_context`,
`_last_result`, `_dict_action` injections, `_saved_computed_pairs`.

Hypothesis: session reload **does not re-simulate**. The `rho_after`,
`max_rho`, `non_convergence` values stored in JSON are trusted. Re-
simulation happens only when the operator explicitly clicks an action
again (`/api/simulate-manual-action`).

## 4. The two-step analysis flow

### 4.1 Step 1 — overload detection

`POST /api/run-analysis-step1 {disconnected_elements: [contingency_id]}`

Inside `AnalysisMixin.run_analysis_step1`:

1. `_ensure_contingency_state_ready(contingency)` — joins the NAD
   prefetch (so it can't race) and pins the working variant on the
   contingency variant.
2. **Decision tree** for getting `obs_simu_defaut` (the N-1 obs):
   - If `_cached_obs_n1` exists for this contingency → use it
     directly (`prebuilt_obs_simu_defaut=...`). Saves ~1–3 s.
   - Otherwise call
     `lib.run_analysis_step1(prebuilt_obs_simu_defaut=None)` which
     runs `simulate_contingency_pypowsybl` internally
     (`fast_mode=config.PYPOWSYBL_FAST_MODE`).
3. Library returns `obs_simu_defaut`, `lines_overloaded_names`,
   `lines_overloaded_ids`, `pre_existing_rho`.
4. Backend captures the result in `_analysis_context` for re-use by
   step2 / manual / superposition.
5. Returns `{lines_overloaded_names, lines_overloaded, pre_existing_rho}`.

Hypotheses surfaced in step 1:
- A branch is **overloaded** when `rho > 1` *after* the monitoring
  factor (default 0.95) has been applied to the thermal limits.
- A pre-existing overload (already > 1 in N-state) is **kept in the
  list** but flagged for downstream filtering (`pre_existing_rho`).

### 4.2 Step 2 — action discovery + reassessment

`POST /api/run-analysis-step2 {selected_overloads, all_overloads, monitor_deselected, additional_lines_to_cut}`

NDJSON streaming response. Two events:

1. `{type:"pdf", pdf_url, pdf_path}` emitted as soon as the
   overflow-graph file is written. Field name `pdf` is legacy — the
   actual file is now an `.html` interactive viewer
   (`config.VISUALIZATION_FORMAT="html"`).
2. `{type:"result", prioritized_actions, action_scores, …}` emitted at
   the end.

Inside `analysis_runner`:

1. **Signature check**: `_last_step2_signature` = hash of
   `(network_path, contingency, selected_overloads, monitor_deselected,
   additional_lines_to_cut, active_model)`. If unchanged, the
   overflow-graph is reused from cache; only model recommendation +
   reassessment re-runs (model-swap fast path).
2. Build the overflow graph (graphviz `dot`) via the library's
   `overflow_distribution_graph` + write it to `Overflow_Graph/`
   following the canonical filename pattern. Emit the `pdf` event.
3. Call `lib.run_analysis_step2_discovery(context, recommender, params)`
   which:
   - Filters the candidate action set by the expert-rule chain
     (whenever an overflow graph is available, **regardless** of the
     active model — sampling models inherit the same filter).
   - Calls `recommender.recommend(inputs, params)` to get
     `{action_id: action_object}` (raw scores).
   - Reassesses every action via `reassess_prioritized_actions`:
     each candidate gets its own `obs.simulate(action,
     fast_mode=actual_fast_mode, keep_variant=True)`.
   - Computes combined pairs via `compute_combined_pairs`
     (superposition theorem over the top-K reassessed actions).
4. Backend serialises the result (NumPy → native via
   `sanitize_for_json`) and emits the `result` event.

Hypotheses in step 2:
- The expert rule filter assumes the overflow graph is "trusted"
  (i.e. step 1 converged). When the graph is missing or stale the
  filter is silently bypassed and the model sees the whole action
  dictionary.
- `monitor_deselected=False` (default) means **only the selected
  overloads count toward the model's objective**. When `True`, all
  detected overloads are monitored — typically slower because the
  candidate set is larger.
- The reassessment phase **does not** mutate the candidate ranking —
  it only enriches each action with `max_rho`, `rho_after`,
  `is_rho_reduction`, `is_islanded`, `n_components`, `non_convergence`,
  plus type-specific details for LS / curtail / PST.
- `compute_combined_pairs` uses the **superposition theorem** on the
  per-line rho impacts. It is an estimate, not a full re-simulation
  — see [`docs/features/combined-actions.md`](../features/combined-actions.md)
  for the contract and [`docs/superposition_module.md`](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/superposition_module.md)
  in the lib for the math.

### 4.3 Pre-existing overload threshold

`config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD` (default `0.02`,
UI field `pre_existing_overload_threshold`) controls when a remedial
action's impact on a pre-existing overloaded line is counted as
"worsening". If the line was already at rho=4.34 and the action moves
it to rho=4.345 (+0.005), the action is **not** flagged as
"worsening" because the delta is below 2 %.

### 4.4 Load-flow modes — inline cheat-sheet

Every `obs.simulate(...)` call inside step 1 and step 2 forwards
`fast_mode=actual_fast_mode` down to
`NetworkManager.run_load_flow(fast=…)`. The same applies to manual
simulations (§ 5) and combined-pair re-simulations (§ 6). Resolved at
the top of `lib.run_analysis`:

```python
if fast_mode:                             # explicit override
    actual_fast_mode = True
else:
    actual_fast_mode = (
        config.PYPOWSYBL_FAST_MODE if fast_mode is None else fast_mode
    )
```

Backend default for `config.PYPOWSYBL_FAST_MODE` is **`True`**, set
from the UI Settings checkbox `pypowsybl_fast_mode` and persisted in
`user_config.json`. So every analysis / simulation runs in **fast
AC** unless the user toggles it off.

Reproduced from the lib doc § 9 — keep this open when reading the
flows below:

| Mode | Knobs | When the backend uses it | Trade-off |
|---|---|---|---|
| **AC fast (default)** | `dc=False, fast=True, init=PREVIOUS_VALUES` | every `obs.simulate(...)` triggered by step 1 / step 2 / `simulate-manual-action` / `compute-superposition` while the UI setting `pypowsybl_fast_mode` is on (default). | quickest AC; ignores tap / shunt re-regulation. |
| **AC slow** | `dc=False, fast=False, init=PREVIOUS_VALUES` | (a) UI setting `pypowsybl_fast_mode=false` propagates through `config.PYPOWSYBL_FAST_MODE` to `actual_fast_mode=False`; (b) automatic retry by the lib when fast didn't converge. | full physics; ~2× slower; converges more cases. |
| **AC + DC seed** | `dc=False, init=DC_VALUES` | implicit retry inside the lib's `_run_ac_with_init_fallback` whenever the initial `PREVIOUS_VALUES` attempt raises OR returns a non-`CONVERGED` status (`FAILED` "Unrealistic state", `MAX_ITERATION_REACHED`). Not directly exposed to the UI. | robust to topology perturbations; +1 internal DC LF. |
| **DC LF** | `dc=True` | only used internally by the lib for screening (`use_dc=True` flag of `run_analysis_step2_discovery`) and by the recommender models that declare a DC scoring path. Never the path picked by the regular analysis endpoints. | linear, no reactive, ignores tap ratios; converges almost always; **not** suitable for thermal-overload arbitration close to limits. |
| **Initial LF** | `dc=False, init=DC_VALUES` (forced) | inside `SimulationEnvironment._ensure_valid_state` — called once at network load and again on `reset()`. | avoids the spurious "Voltage magnitude is undefined" warning + retry on cold load. |

What `fast=True` actually disables (mirrors lib doc § 3.3):

| OpenLoadFlow outer loop | `fast=True` |
|---|---|
| `IncrementalTransformerVoltageControl` (tap-changer voltage regulation) | **OFF** |
| `IncrementalShuntVoltageControl` (shunt section switching) | **OFF** |
| Phase-shifter regulation (`phase_shifter_regulation_on`) | unchanged (ON) |
| Reactive limits enforcement (`use_reactive_limits`) | unchanged (ON) |
| Distributed slack (`distributed_slack`) | unchanged (ON) |

Physical meaning: in `fast` mode the network is still a valid AC
solution **assuming taps and shunt sections stay at their input
values**. Voltages and reactive flows are slightly off but the
thermal-overload signal (rho on each branch) is usually within a few
percent of the slow-mode answer — good enough for the recommender's
ranking step. The retry tree (lib doc § 3.7) escalates to slow / DC
automatically when this approximation breaks down.

When to flip the UI checkbox off:

- A specific action keeps coming back with `non_convergence`
  in fast mode on a small or medium grid (slow mode often resolves
  it, at the cost of analysis runtime — count ~1.5–3× longer on the
  French grid).
- The operator wants reference-grade `max_rho` for an action under
  comparison (e.g. exporting to a third-party study). Slow + the
  `DC_VALUES` fallback is the closest you can get to the lib's
  reference `run_load_flow` semantics.

## 5. Manual action simulation

`POST /api/simulate-manual-action {action_id, disconnected_elements, action_content?, lines_overloaded?, target_mw?, target_tap?}`

Used when the operator stars an action that wasn't in the prioritized
list, or applies an LS / curtail / PST action with an explicit
setpoint. Detailed flow in `SimulationMixin.simulate_manual_action`
(orchestrator) + `simulation_helpers.py` (14 pure helpers).

Pipeline:

1. **Normalise** `disconnected_elements` (canonical contingency id
   list).
2. `_ensure_contingency_state_ready(contingency)` — same guard as
   step 1.
3. **Resolve the action**:
   - Split combined ids (`action1+action2+…`).
   - Inject restored topology entries from `action_content` if any
     (session reload path).
   - Build dynamic LS / curtail / PST / reconnect actions if the id
     is not already in `_dict_action` (heuristic action generation).
4. **Pick the obs**: prefers `_analysis_context.obs_simu_defaut` to
   keep numerical alignment with step 1 and the library's
   `compute_superposition`. Falls back to a fresh
   `simulate_contingency_pypowsybl` if the context is empty.
5. **Apply setpoint overrides**: `target_mw` rewrites
   `set_load_p[load_id]` / `set_gen_p[gen_id]`; `target_tap` rewrites
   `pst_tap[transformer_id]`. The promoted action is reinjected into
   `_dict_action` so future simulations see the updated setpoint.
6. **Build the combined action object** (via the lib's
   `ActionSpace`).
7. **Simulate**: `obs_simu_defaut.simulate(action, keep_variant=True,
   fast_mode=config.PYPOWSYBL_FAST_MODE)`. The kept variant is owned
   by the library; the backend does NOT clean it up — see the
   variant-cleanup note in `simulation_mixin.py`.
8. **Compute metrics** (`compute_action_metrics`): `rho_before`,
   `rho_after`, `max_rho`, `max_rho_line`, `is_rho_reduction`,
   `is_islanded`, `disconnected_mw`, `n_components`,
   `lines_overloaded_after`.
9. **Normalise non-convergence**: `info_action["exception"]` is
   inspected by `normalise_non_convergence` — produces a readable
   string like `"Load flow did not converge: ComponentStatus.MAX_ITERATION_REACHED"`
   that the UI surfaces on the action card.
10. **Enrich** with curtailment / load-shedding / PST details, register
    on `_dict_action` (for subsequent superposition computations),
    serialise with `serialize_action_result`.

Same `fast_mode` resolution rule as § 4.4: the simulate call uses
`fast_mode=config.PYPOWSYBL_FAST_MODE` (UI checkbox), which is `True`
by default. The lib's `_run_ac_with_init_fallback` handles the
retry-with-DC_VALUES escalation transparently — the backend just
surfaces the final status (CONVERGED or one of the failure modes
listed in § 9) on the action card.

### 5.1 `_analysis_context` re-use — why

The library's pypowsybl backend caches an N-1 variant on
`obs_simu_defaut._variant_id` when `keep_variant=True`. The backend's
`simulate_manual_action` MUST use the **same** obs, otherwise a fresh
`env.get_obs()` returns an N-state observation (the grid2op ↔ pypowsybl
bridge doesn't re-sync `get_obs()` to the current `working_variant`),
and the subsequent `obs.simulate(...)` would branch from N — not from
N-1. Result: `max_rho` would drift from the library's own simulation,
making session reload / superposition diverge.

The "used_context_obs" branch documents this:

```python
ctx_obs_n1 = self._obs_n1_from_context()
ctx_obs_n  = ctx.get("obs")
used_context_obs = ctx_obs_n1 is not None and ctx_obs_n is not None
if used_context_obs:
    obs, obs_simu_defaut = ctx_obs_n, ctx_obs_n1  # numerically aligned with step1
```

## 6. Superposition (`POST /api/compute-superposition`)

Given two prioritized actions `(action1, action2)`, estimate the
combined `max_rho` without simulating `action1+action2` explicitly.
Uses the per-line rho deltas captured during step 2 reassessment and
the superposition theorem:

```
rho_combined[line] ≈ rho_N1[line]
                   + (rho_action1[line] - rho_N1[line])
                   + (rho_action2[line] - rho_N1[line])
```

Hypotheses:
- Linear superposition holds well in DC, and **approximately** in AC
  for small perturbations.
- The two actions must be reassessed against the **same** N-1
  baseline. The backend's `compute_superposition` re-runs the per-
  action simulation via `simulate_manual_action` if either member is
  missing from `_last_result` — same `_analysis_context` re-use
  semantics as § 5.

The full math + caveats are documented at
[`docs/features/combined-actions.md`](../features/combined-actions.md)
+ the lib's `docs/superposition_module.md`.

## 7. Modes exposed to the UI

The Settings modal surfaces these knobs (mapped to `ConfigRequest`):

| UI field | Backend field | Lib config global | Default | Effect |
|---|---|---|---|---|
| **Network path** | `network_path` | — | — | `.xiidm` file to load. |
| **Action file path** | `action_file_path` | — | — | JSON action dictionary. |
| **Layout path** | `layout_path` | `LAYOUT_FILE_PATH` | — | `grid_layout.json` for NAD `fixed_positions`. |
| **Output folder** | `output_folder_path` | — | `./sessions` | session save target. |
| **Lines monitoring path** | `lines_monitoring_path` | `LINES_TO_MONITOR_PATH` | — | optional whitelist of branches to monitor (empty = all). |
| **Recommender model** | `model` | — | `"expert"` | active `RecommenderModel`. See `/api/models`. |
| **Compute overflow graph** | `compute_overflow_graph` | `DO_CONSOLIDATE_GRAPH` | `True` | toggles the overflow-graph build in step 2. Needed by Expert + every model declaring `requires_overflow_graph=True`. |
| **Use pypowsybl fast mode** | `pypowsybl_fast_mode` | `PYPOWSYBL_FAST_MODE` | `True` | drives `obs.simulate(..., fast_mode=...)` across every analysis / manual / superposition call. See § 4.4 above for the inline cheat-sheet and the lib doc [§ 3.3](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/architecture/simulation-pipeline.md#33-fast-vs-slow--what-gets-disabled) for what `fast=True` actually disables in OpenLoadFlow. |
| **Monitoring factor** | `monitoring_factor` | `MONITORING_FACTOR_THERMAL_LIMITS` | `0.95` | thermal-limit multiplier; 0.95 means "alarm at 95 % of `permanent_limit`". |
| **Pre-existing overload threshold** | `pre_existing_overload_threshold` | `PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD` | `0.02` | min. delta on rho to count as "worsening" a pre-existing overload. |
| **n_prioritized_actions** | `n_prioritized_actions` | `N_PRIORITIZED_ACTIONS` | `10` | cap on the action list returned by the model. |
| **min_line_reconnections** | `min_line_reconnections` | `MIN_LINE_RECONNECTIONS` | `2` | min. number of reconnection actions in the prioritized list. |
| **min_close_coupling** | `min_close_coupling` | `MIN_CLOSE_COUPLING` | `1`–`3` | min. number of node-merging (close-coupler) actions. |
| **min_open_coupling** | `min_open_coupling` | `MIN_OPEN_COUPLING` | `2` | min. number of node-splitting (open-coupler) actions. |
| **min_line_disconnections** | `min_line_disconnections` | `MIN_LINE_DISCONNECTIONS` | `2`–`3` | min. number of disconnection actions. |
| **min_pst** | `min_pst` | `MIN_PST` | `1` | min. number of phase-shifter tap actions. |
| **min_load_shedding** | `min_load_shedding` | `MIN_LOAD_SHEDDING` | `1`–`2` | min. number of load-shedding actions. |
| **min_renewable_curtailment_actions** | `min_renewable_curtailment_actions` | `MIN_RENEWABLE_CURTAILMENT_ACTIONS` | `1` | min. number of renewable curtailment actions. |
| **Ignore reconnections** | `ignore_reconnections` | `IGNORE_RECONNECTIONS` | `False` | when `True`, suppress all reco actions from the candidate set. |

### 7.1 Selecting a recommender model

`POST /api/recommender-model {model: "expert" | "random_overflow" | …}` swaps
the active `RecommenderModel` without reloading the network or the
action dictionary. Preserves `_last_step2_signature` so the overflow
graph cache is reused — a model swap re-runs only the recommendation
+ reassessment phases.

Available models depend on the lib registry: `expert` (default,
rule-based, `requires_overflow_graph=True`), `random_overflow`
(uniform sampling among the candidates surfaced by the overflow
graph), and any third-party model that implements the
`RecommenderModel` ABC.

## 8. Overflow graph modes

Two layouts are available, switchable on the fly via
`POST /api/regenerate-overflow-graph {mode}`:

- **`hierarchical`** (default) — graphviz `dot` layout produced by
  the lib during `run_analysis_step2`. Topological, no geographic
  meaning.
- **`geo`** — pure SVG transform (`services/analysis/overflow_geo_transform.py`)
  that repositions node groups using `grid_layout.json` coordinates
  and redraws edges as straight lines. Computed on first click, then
  cached. Cache is cleared on every fresh `run_analysis_step2` and on
  `reset()`.

The interactive HTML viewer (`services/overflow_overlay.py`) is
injected on top of the upstream `expert_op4grid_recommender` SVG
viewer at serve time: it adds the Co-Study4Grid action-pin overlay,
the layer-toggle bar, and the `cs4g:filters` postMessage bridge.

## 9. Convergence & failure semantics

| Symptom | Where it surfaces | Meaning |
|---|---|---|
| `non_convergence: "Load flow did not converge: ComponentStatus.MAX_ITERATION_REACHED"` | action card `non_convergence` field | OpenLoadFlow ran out of outer-loop iterations (cap raised to 100 in `0.2.2.post2`). Usually means a numerical instability on the post-action topology. |
| `non_convergence: "Load flow did not converge: ComponentStatus.FAILED"` | action card | OpenLoadFlow's voltage-control consistency check tripped on "Unrealistic state". The DC_VALUES fallback in `_run_ac_with_init_fallback` should now catch this. |
| `is_islanded: true` | action card | the action disconnected part of the network from the slack-bus component. `disconnected_mw` reports the dropped active load. |
| `is_rho_reduction: false` | action card | the action did NOT reduce `max_rho` on at least one of the monitored lines. |
| Empty `prioritized_actions` | step 2 result | every candidate either didn't converge or didn't reduce rho. Check the analysis logs for per-candidate `non_convergence` reasons. |

## 10. What the backend does NOT do

- It does not run dynamic simulations — every LF is steady-state.
- It does not enforce voltage-magnitude or reactive-reserve limits as
  failure conditions. Only `rho > 1` triggers the overload flag.
- It does not retry an action with a different `fast_mode` or
  `voltage_init_mode` on its own — the retry is implemented at the
  library's `run_load_flow` level (see lib doc §§ 3.5–3.7).
- It does not parallelise the per-action reassessment (the library
  runs candidates sequentially over the shared `pp.network.Network`).
  Parallelism is bounded by the FastAPI thread pool and the
  `allow_variant_multi_thread_access=False` choice in
  `network_service` (see `network_service.py:30-43`).

## 11. Cross-references

- `expert_backend/services/analysis_mixin.py` — `run_analysis_step1`,
  `run_analysis_step2`.
- `expert_backend/services/simulation_mixin.py` — `simulate_manual_action`,
  `compute_superposition`.
- `expert_backend/services/recommender_service.py` — singleton +
  lifecycle (`__init__`, `reset`, `update_config`).
- `expert_backend/services/simulation_helpers.py` — 14 pure helpers
  used by the simulation mixin.
- [`docs/features/save-results.md`](../features/save-results.md) —
  session save / reload contract.
- [`docs/features/combined-actions.md`](../features/combined-actions.md)
  — combined-action UI + superposition contract.
- [`docs/features/interactive-overflow-analysis.md`](../features/interactive-overflow-analysis.md)
  — overflow viewer + layer toggles.
- [`docs/features/state-reset-and-confirmation-dialogs.md`](../features/state-reset-and-confirmation-dialogs.md)
  — `reset()` cache list + confirmation-dialog policy.
- [`Expert_op4grid_recommender/docs/architecture/simulation-pipeline.md`](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/architecture/simulation-pipeline.md)
  — physical / numerical layer (LF modes, voltage init, variants,
  retry strategy).
- [`Expert_op4grid_recommender/docs/release-notes/v0.2.2.post2.md`](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/release-notes/v0.2.2.post2.md)
  — rationale for the non-converged-status fallback + outer-loop bump.
