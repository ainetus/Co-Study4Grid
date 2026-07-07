# Pluggable Recommendation Models

Co-Study4Grid ships with a small registry of recommendation models and
binds them through the FastAPI backend and the React frontend. The
library-side contract (`RecommenderModel` ABC, `RecommenderInputs` /
`RecommenderOutput` DTOs, reusable reassessment phase) lives in
[`marota/expert_op4grid_recommender`](https://github.com/marota/expert_op4grid_recommender/blob/main/docs/recommender_models.md).

This document is the **app-side reference**: registry, built-in random
examples, the three-layer filter chain, backend / frontend wiring, and
the step-by-step guide for shipping a new model. See also the broader
[backend overview](README.md).

---

## 1. The registry

Lives in `expert_backend/recommenders/registry.py`. Tiny by design:

```python
from expert_backend.recommenders.registry import (
    DEFAULT_MODEL,        # "expert"
    register,             # decorator / function: add a model class
    unregister,           # remove a model by name
    build_recommender,    # instantiate by name (falls back to DEFAULT_MODEL on empty / None)
    get_model_class,      # lookup; returns None on miss
    list_models,          # JSON-ready descriptors for the UI
)
```

Three models are registered at startup (`expert_backend/recommenders/__init__.py`):

| name             | label                              | requires_overflow_graph | params_spec                                                              |
|------------------|------------------------------------|-------------------------|--------------------------------------------------------------------------|
| `expert`         | Expert system                      | `True`                  | Every legacy knob (`n_prioritized_actions`, `min_line_*`, the per-action-type minima `min_load_shedding` / `min_renewable_curtailment_actions` / `min_redispatch` / `min_pst`, `ignore_reconnections`, ...). |
| `random`         | Random                             | `False`                 | Just `n_prioritized_actions`.                                            |
| `random_overflow`| Random (post overflow analysis)    | `True`                  | Just `n_prioritized_actions`.                                            |

Third-party packages can extend the registry by decorating their
`RecommenderModel` subclass with `@register` at import time. The
library (`expert_op4grid_recommender`) only owns the contract; the
registry sits here so this app stays in control of which models are
offered to operators.

---

## 2. Built-in random models

Intended as **canonical examples** of how to plug a model in, plus
baselines against the expert system.

### `RandomRecommender` (`requires_overflow_graph=False`)

File: `expert_backend/recommenders/random_basic.py`.

Samples uniformly from the operator's action dictionary, augmented at
runtime with simple reconnection / load-shedding / curtailment actions
derived from the post-fault observation (see `synthetic_actions.py`).
Skips the expensive step-2 overflow-graph build by default.

### `RandomOverflowRecommender` (`requires_overflow_graph=True`)

File: `expert_backend/recommenders/random_overflow.py`.

Samples uniformly from actions inside the **reduced action space the
expert sees**: actions retained by the expert rule filter AND touching
the overflow-graph paths AND existing on the loaded network. Three
filter layers stacked before sampling — see next section.

Returns `{}` (not a fallback to the full dict) when any layer empties
the pool: that's the correct semantic for "no overflow-relevant
actions for this contingency".

---

## 3. The three-layer filter chain

Applied by `RandomOverflowRecommender` before sampling. The expert
pipeline gets layers 1 and 2 implicitly via `ActionDiscoverer`'s
per-type mixins.

### Layer 1 — Expert rule filter

- **Where**: `_run_expert_action_filter(context)` in the library, invoked
  by `run_analysis_step2_discovery` whenever the overflow graph is
  available in the context (= the chosen model required it OR the
  operator opted in via `compute_overflow_graph=True`).
- **What**: runs path analysis + `ActionRuleValidator.categorize_actions`,
  which removes broadly invalid actions (wrong shape, lines already
  open, missing devices, ...).
- **Output**: writes `context["filtered_candidate_actions"]`, forwarded
  to the recommender via `inputs.filtered_candidate_actions`.
- **Idempotent** — free no-op when already populated. The expert model
  invokes it internally too.
- **Note**: this filter does NOT restrict to overflow-relevant actions
  — that targeting is layer 2.

### Layer 2 — Overflow-graph path filter

- **Where**: `expert_backend/recommenders/overflow_path_filter.py`
  (`restrict_to_overflow_paths`).
- **What**: extracts the same path lists the expert orchestrator uses
  from `g_distribution_graph`:
  - dispatch path lines + constrained path lines → `relevant_lines`,
  - dispatch loop nodes + blue path nodes + hub substations → `relevant_subs`.
  Keeps an action when ANY of these references matches:
  1. `entry["VoltageLevelId"]` (or `voltage_level_id`) in `relevant_subs`,
  2. `content.set_bus.lines_or_id` / `lines_ex_id` / `pst_tap` keys
     in `relevant_lines`,
  3. action-id suffix for `disco_<LINE>` / `reco_<LINE>` entries,
  4. any `_`-split segment in `relevant_subs` (UUID-prefixed coupling
     shape `<uuid>_<VL>_..._coupling`).
- **Robustness**: `_resolve_node_to_name` handles both shapes the
  distribution graph returns — integer indices into `obs.name_sub`
  (legacy build) and substation-name strings (current build, including
  `numpy.str_`). Conservative on extraction failure (returns the input
  list unchanged so a buggy graph never silently empties the pool).

### Layer 3 — Network existence filter

- **Where**: `expert_backend/recommenders/network_existence.py`
  (`filter_to_existing_network_elements`).
- **What**: drops actions whose `VoltageLevelId` or `set_bus.lines_*_id`
  references an element that doesn't exist on the loaded pypowsybl
  network. Catches the case where a dict shipped for a larger grid is
  used against a smaller subset (the original AUBE P4 / small_grid bug).
- **Robustness**: returns the input list unchanged when the network
  introspection itself fails — never silently empties the pool.

### Layer ordering rationale

```
  dict_action (potentially 24k entries)
     |
     v
  Layer 1: ActionRuleValidator       → ~few hundred candidates
     |
     v
  Layer 2: overflow_path_filter      → ~few dozen candidates on paths
     |
     v
  Layer 3: network_existence_filter  → candidates known to the grid
     |
     v
  env.action_space(content)          → final pool, drop on materialise error
     |
     v
  random.sample(pool, min(n, len(pool)))
```

Each layer is **conservative on internal failure** (returns input
unchanged) so a bug in any single filter cannot silently empty the
pool. Layers can be independently disabled by mocking the inputs they
read.

---

## 4. Backend wiring

### `ConfigRequest` extension

`expert_backend/main.py` adds two fields to the existing config:

```python
class ConfigRequest(BaseModel):
    # ... existing fields ...
    model: str = "expert"
    compute_overflow_graph: bool = True
```

Defaults match the legacy expert behaviour, so existing clients keep
working.

### Restricting the proposed action families (`allowed_action_types`)

`POST /api/config` also accepts an `allowed_action_types` list, driven
by the **"Restrict to action types"** control in Settings →
Recommender. It is plumbed through to `config.ALLOWED_ACTION_TYPES`:

- **Empty / unset** — the recommender proposes every action family
  (the previous, unrestricted behaviour).
- **A non-empty subset** (any of `reco` / `close` / `open` / `disco` /
  `pst` / `ls` / `rc` / `redispatch`) — the recommender proposes
  **only** actions of those families.

This narrows the candidate pool the active model sees, independently of
the per-family `min_*` minima above.

### `GET /api/models`

Lists every registered model with its `label`,
`requires_overflow_graph`, `is_default` flag, and `params` (the
`params_spec` descriptors). The frontend reads this once on mount to
populate the dropdown and render only the parameter inputs the active
model actually consumes.

### `POST /api/recommender-model`

Lightweight model swap on the **running** `RecommenderService`. Body:
`{ model: str, compute_overflow_graph?: bool }`. Calls
`_apply_model_settings(req)` and echoes back
`{ status, active_model, compute_overflow_graph }`.

Unlike `POST /api/config`, this does **not** reload the network or
rebuild the action dictionary — it only updates the two
`ModelSelectionMixin` attributes. The frontend fires it from
`useSettings` whenever `recommenderModel` / `computeOverflowGraph`
change, so a model picked in **either** the Settings → Recommender
tab **or** the dropdown above the Analyze & Suggest button takes
effect on the very next `POST /api/run-analysis-step2` — without an
expensive study reload. The Step-2 graph cache (see below) is
deliberately left intact across a model swap: the overflow graph
doesn't depend on the model, so a swap re-runs only the discovery
step.

### `RecommenderService` integration

Explicit composition (2026-07 D1 revision — the former
`_service_integration.py` module that grafted all of this onto the
class at import time was removed):

1. **State + getters** via `ModelSelectionMixin`, a regular base class
   of `RecommenderService` — `_recommender_model_name` and
   `_compute_overflow_graph` (with defaults `"expert"` and `True`).
   Public getters `get_active_model_name()` and
   `get_compute_overflow_graph()` are echoed back by `/api/config`.
2. **`update_config` / `reset`** call `_apply_model_settings(settings)`
   / `_reset_model_settings()` explicitly, so the two ConfigRequest
   fields are captured every time the operator applies settings and
   cleared on every study reload.
3. **`AnalysisMixin.run_analysis_step2`** is the single, model-aware
   generator (no shadowed legacy copy). It:
   - builds the recommender from the registry (lazy import, so the
     mock-layer test sandbox can still import `analysis_mixin`),
   - conditionally skips the overflow-graph step
     (`needs_graph = requires_overflow_graph OR get_compute_overflow_graph()`
     — a model that requires the graph can never be skipped, even via
     direct API call),
   - threads the recommender all the way through to
     `run_analysis_step2_discovery`,
   - echoes `active_model` and `compute_overflow_graph` on the
     `result` event so the frontend can persist them in the saved
     session (`analysis.active_model`).

The patches are applied as a side-effect of importing
`expert_backend.recommenders`. `expert_backend/main.py` only needs
that single import to enable everything.

### Step-2 overflow-graph cache (model-swap fast path)

`run_analysis_step2` keys the overflow graph on a **signature** of its
inputs: `(disconnected_elements, selected_overloads, all_overloads,
monitor_deselected, additional_lines_to_cut)`. The signature + the
enriched context are stored on `_last_step2_signature` /
`_last_step2_context`, and the produced HTML viewer path on
`_overflow_layout_cache["hierarchical"]`.

When a re-run posts an **identical** signature, the orchestrator skips
`_narrow_context_to_selected_overloads` + `run_analysis_step2_graph` +
the PDF mtime poll, yields the cached `pdf` event with `cached: true`,
and jumps straight to `run_analysis_step2_discovery`. Because the
overflow graph depends only on topology — never on the recommender —
this makes the common "swap model and re-run" loop near-instant: only
the discovery step actually re-executes. Any change to the
contingency or the additional-lines hypothesis changes the signature
and forces a full rebuild.

`_last_step2_signature` and `_last_step2_context` are per-study caches
— both are cleared by `RecommenderService.reset()` so a freshly
loaded study never reuses the previous study's graph.

---

## 5. Frontend wiring

### `useSettings` hook

`frontend/src/hooks/useSettings.ts`:

- New state: `recommenderModel: string` (default `"expert"`),
  `computeOverflowGraph: boolean` (default `true`).
- `availableModels: ModelDescriptor[]` fetched on mount via
  `api.getModels()`.
- `useEffect` forces `computeOverflowGraph = true` whenever the active
  model declares `requires_overflow_graph = true`. Keeps persisted
  user config in sync with what the backend will actually run.
- A second `useEffect` pushes the model to the running backend via
  `api.setRecommenderModel()` (→ `POST /api/recommender-model`)
  whenever `recommenderModel` / `computeOverflowGraph` change. A
  `lastPushedModelRef` guard skips redundant pushes. This is what
  makes a mid-session model swap (from either dropdown) actually
  reach the backend without an Apply Settings round-trip.
- `buildConfigRequest()` carries `model` and `compute_overflow_graph`
  through every `/api/config` call.

### `ActionFeed` — model selector + active-model reminder + Clear

`frontend/src/components/ActionFeed.tsx`:

- **Model dropdown above "Analyze & Suggest"** — a mirror of the
  Settings → Recommender selector, populated from `availableModels`.
  Lets the operator swap model and re-run without opening Settings.
  Every change emits a `recommender_model_changed` interaction event
  with `source: 'action_feed'`.
- **Active-model reminder** — once a run has produced suggestions, an
  italic *"Suggestions produced by &lt;model label&gt;"* line sits
  just below the Suggested Actions tab header. The label is resolved
  from `result.active_model` against `availableModels`.
- **Clear button** — a danger-coloured button on that reminder line.
  It opens the shared `<ConfirmationDialog/>` (`type:
  'clearSuggested'`); on confirm, `App.performClearSuggested` wipes
  the recommender suggestions the operator has NOT triaged (un-starred,
  un-rejected, not manually added) and emits `suggested_actions_cleared`.
  It does **not** re-run the analysis — the operator clears, optionally
  swaps the model, then presses Analyze & Suggest. The analysis-trigger
  slot is gated on `prioritizedEntries.length === 0`, so it reappears
  the moment the Suggested feed empties out.

### `ActionCard` — origin / "Source" row

`frontend/src/components/ActionCard.tsx`:

Every action carries an `origin` field (`ActionDetail.origin`)
recording its provenance — set once at creation, never changed by
starring or re-simulating:

- `"user"` — the operator simulated it themselves (manual search
  dropdown / "Make a first guess"). Set by
  `useActions.handleManualActionAdded` (default).
- `<model id>` — produced by a recommender. Set by the step-2 result
  loop in `useAnalysis` from the `active_model` echoed on the stream's
  `result` event. The unsimulated-pin path
  (`App.handleSimulateUnsimulatedAction`) also stamps the model id,
  not `"user"`, because that pin was *scored* by the model — the
  operator only triggered its materialisation.

`origin` is distinct from the `is_manual` flag, which is overloaded
UI state (also `true` when the operator merely *stars* a recommender
suggestion). The unfolded action card renders an `origin`-derived
"Source" row — `ActionCard` resolves a model id to its label via
`availableModels`, falling back to the raw id. The field is persisted
in `session.json` (`SavedActionEntry.origin`) and restored verbatim;
legacy dumps get a derived `origin` on reload. See
[`docs/features/save-results.md`](../features/save-results.md).

### `SettingsModal` — Recommender tab

`frontend/src/components/modals/SettingsModal.tsx`:

- Top of the tab: a model dropdown populated from `availableModels`.
- Below the dropdown: the `Compute Overflow Graph (step 1)` checkbox
  with three states:
  - **Locked + checked** with the suffix "required by this model"
    when `activeModel.requires_overflow_graph` is true.
  - **Editable** with the suffix "optional for this model" when
    the model doesn't require the graph (useful when the operator
    still wants to inspect the overflow analysis tab alongside a
    graph-agnostic recommender).
  - Hidden entirely while `availableModels` is loading (then falls
    back to showing all the legacy expert fields).
- Below the toggle: the recommender parameters. Each expert-specific
  input is rendered only when the active model declares it in
  `params_spec`. So `Random` only shows `N Prioritized Actions`;
  `Expert` shows the full legacy list.

### `ActionCard` — VL chip

`frontend/src/components/ActionCard.tsx`:

`renderBadges()` reads `details.action_topology.voltage_level_id` as
the **highest-priority signal** for nodal / coupling / switch-based
actions (pypowsybl UUID-prefixed `..._VL_..._coupling`). The chip is
clickable (zoom to VL) and double-clickable (open SLD) — matching the
behaviour of the existing load-shedding / curtailment VL chips. The
backend surfaces this field from `dict_action[id]["VoltageLevelId"]`
via `extract_action_topology`.

---

## 6. How to add a new recommendation model

Three files; nothing else needs to change in the app.

### Step 1 — Write the model class

Anywhere in your package (or a new file under
`expert_backend/recommenders/`). The class follows the library
contract:

```python
from expert_op4grid_recommender.models.base import (
    RecommenderModel, RecommenderInputs, RecommenderOutput, ParamSpec,
)

class MyMLPolicy(RecommenderModel):
    name = "ml_policy"
    label = "ML policy v3"
    requires_overflow_graph = True   # we want the overflow analysis features

    @classmethod
    def params_spec(cls):
        return [
            ParamSpec("n_prioritized_actions", "N Actions", "int",
                     default=5, min=1, max=20),
            ParamSpec("temperature", "Sampling temperature", "float",
                     default=0.7, min=0.0, max=2.0),
        ]

    def recommend(self, inputs: RecommenderInputs, params: dict) -> RecommenderOutput:
        # Use any combination of:
        #   inputs.obs / inputs.network                (N state)
        #   inputs.obs_defaut / inputs.network_defaut  (N-K state)
        #   inputs.lines_overloaded_names / _ids / _rho
        #   inputs.dict_action
        #   inputs.filtered_candidate_actions  (your model gets the same reduced
        #                                       action space the expert sees)
        #   inputs.distribution_graph / hubs   (overflow path info)
        #   inputs.env  (to materialise actions via env.action_space(content))
        my_picks = pick_actions_with_ml(...)
        return RecommenderOutput(prioritized_actions=my_picks)
```

### Step 2 — Register it

Decorate with `@register` (or call it as a function) at import time:

```python
from expert_backend.recommenders.registry import register

@register
class MyMLPolicy(RecommenderModel):
    ...
```

For models shipped as a third-party package: import the registry from
that package, decorate your class. The registration runs on import,
so your package needs to be imported by the backend before
`/api/models` is queried (typical pattern: import it from
`expert_backend/recommenders/__init__.py` or from your own startup
hook).

### Step 3 — No further wiring needed

The frontend picks up the new model automatically:

- `GET /api/models` includes it,
- the Settings → Recommender dropdown lists it,
- the parameter inputs are rendered dynamically from `params_spec()`,
- the `Compute Overflow Graph` toggle is locked/checked or editable
  based on `requires_overflow_graph`,
- the analysis pipeline calls your `recommend()` via
  `run_analysis_step2_discovery`,
- saved sessions persist the active model under
  `analysis.active_model` (see
  [`docs/features/save-results.md`](../features/save-results.md)).

If your model needs the same reduced action space as the expert
(`filtered_candidate_actions`), declare `requires_overflow_graph=True`
and the pipeline runs the expert rule filter for you. For models
that need the path-relevant subset, additionally apply
`restrict_to_overflow_paths` (and optionally
`filter_to_existing_network_elements`) inside `recommend()` — see
`RandomOverflowRecommender` for the canonical pattern.

---

## 7. Testing

App-side tests live in `tests/`. Mock-based; no live pypowsybl /
grid2op needed.

- `test_recommenders_registry.py` — register / unregister, build
  with empty / None, fallback to default, `list_models()` shape and
  per-model flags, canonical three models.
- `test_random_recommenders.py` — metadata, sampling cardinality, the
  three-layer filter chain for RandomOverflow, None-vs-`[]` fallback
  semantics for `filtered_candidate_actions`, drop-on-unknown-VL
  regression (AUBE P4 case).
- `test_overflow_path_filter.py` — `_resolve_node_to_name` covering
  int / numpy.int64 / str / numpy.str_ / bytes, the `numpy.str_`
  regression for the legacy `idx < n_subs` crash, end-to-end with
  numpy nodes.
- `test_network_existence.py` — `filter_to_existing_network_elements`,
  short-circuit on first unknown line, conservative fallback on
  introspection failure, transformer ids accepted as branches.
- `test_action_enrichment.py` — `extract_action_topology` covering
  numpy-array attribute tolerance, four-way set_bus backfill,
  `voltage_level_id` surfacing (upper- and lower-case), switches
  fallback, combined pypowsybl switch-based shape.
- `test_model_selection_mixin.py` — default state, `_apply_model_settings`
  with explicit / empty / whitespace / non-string values, missing
  attrs use defaults.
- `test_model_composition.py` — the explicit composition: mixin
  inherited, `update_config` / `reset` delegate to it, single
  model-aware `run_analysis_step2`, unknown model emits an error
  event, overflow-graph cache fast path, `antenna_meta` pass-through.
- `test_models_api.py` — `ConfigRequest` defaults / accepts custom
  model / round-trips through JSON; `GET /api/models` shape and
  canonical content.

Run the suite: `pytest expert_backend/tests` (or plain `pytest`) from the repo root — the files above live in the canonical suite and run in CI.

---

## 8. Troubleshooting

### "RandomOverflowRecommender: filtered_candidate_actions is None"

The expert rule filter is supposed to populate it. If the warning
fires, either:
- the step-2 graph wasn't built (check the `Compute Overflow Graph`
  toggle in the Settings → Recommender tab — should be locked-on
  for `random_overflow`), or
- `g_distribution_graph` isn't in the context (look for an earlier
  warning from `run_analysis_step2_graph`).

### Pins clustered on the overload, all showing the same %

Diagnosis: the `resolveActionAnchor` in
`frontend/src/utils/svg/actionPinData.ts` is falling back to
`max_rho_line`. Root causes (in priority order):
1. `action_topology.voltage_level_id` is missing from the backend
   payload → check `extract_action_topology` is surfacing the
   `VoltageLevelId` key from `dict_action`.
2. Action targets reference elements outside the SVG metadata index
   (NAD doesn't cover them) → expected for filtered topologies; the
   action should still be filtered out by
   `filter_to_existing_network_elements`.

### Suggestions spread across the whole grid for `random_overflow`

Check the backend logs for `overflow-path-filter: could not extract
path targets` — a `numpy.str_` regression used to disable the filter
silently. Fixed in `overflow_path_filter._resolve_node_to_name`.
If the message still appears, file a bug with the exception details.

### "Compute Overflow Graph" toggle does nothing for the active model

Intended behaviour for models with `requires_overflow_graph=True` —
the checkbox is locked-on with the "required by this model" suffix.
The backend enforces the same guarantee
(`needs_graph = requires_overflow_graph OR get_compute_overflow_graph()`)
so direct API calls cannot bypass it.

---

## Execution-time breakdown

Every two-step analysis run now reports a per-stage execution-time
breakdown. The values travel on the streaming NDJSON events from
`POST /api/run-analysis-step2` and are persisted in `analysis.*` on
session save (see [Save Results § analysis](../features/save-results.md#analysis)).

### What each stage measures

| Stage | Where it's measured | Covers |
|---|---|---|
| `step1_time` | `expert_backend/services/analysis_mixin.py` (wrapper) | Contingency simulation + overload detection (`run_analysis_step1`). Near-zero when the obs is pre-warmed (see below). |
| `overflow_graph_time` | `expert_backend/services/analysis_mixin.py` | `_narrow_context_to_selected_overloads` + `run_analysis_step2_graph` + the PDF mtime poll. **`null`** when the active model doesn't consume the overflow graph; **`0.0`** on a cached re-run. |
| `action_prediction_time` | `analysis_mixin.py` (upstream-reported) | `recommender.recommend(inputs, params)` — the model's intrinsic selection step. For Expert-style models, includes the internal candidate simulation used to score topology actions. |
| `assessment_time` | `analysis_mixin.py` (upstream-reported) | `reassess_prioritized_actions` + `propagate_non_convergence_to_scores` + `compute_combined_pairs`. Each prioritized action is re-simulated to compute its final `rho_before` / `rho_after`. **Scales linearly with the number of prioritized actions.** |
| `enrichment_time` | `analysis_mixin.py` | Co-Study4Grid post-processing: `_enrich_actions` + `_augment_combined_actions_with_target_max_rho` + `_compute_mw_start_for_scores`. UI-facing decoration only. |
| `wall_clock_time` | `frontend/src/hooks/useAnalysis.ts` | `performance.now()` from the "Analyze & Suggest" click until the `result` NDJSON event arrives. Includes every backend stage + network round-trip + NDJSON streaming overhead. |

The headline number in the ActionFeed reminder (`Suggestions produced
by <model> in <X>s ⓘ`) is `wall_clock_time`. The native `<title>`
tooltip lists each stage plus the residual `Other (network /
streaming) = wall_clock_time − Σ(stage_times)`. See
[`frontend/src/components/ActionFeed.tsx`](../../frontend/src/components/ActionFeed.tsx)
for the rendering and
[`docs/features/save-results.md`](../features/save-results.md#analysis)
for the saved-JSON schema.

### How the breakdown is wired

Backend NDJSON events:

* The `pdf` event (sent before the `result` event so the iframe can
  render the overflow graph early) carries `overflow_graph_time` so the
  iframe's `<h1>` subtitle (`Total execution time: <X>s`) can appear
  as soon as the file is ready.
* The `result` event carries all six fields. The Co-Study4Grid
  frontend stamps `wall_clock_time` itself; the other five come from
  the backend.

Frontend persistence:

* `frontend/src/utils/sessionUtils.ts` (`buildSessionResult`) writes
  each field into `analysis.*`, defaulting to `null` when the live
  `result` doesn't have it. The JSON shape stays stable across runs.
* `frontend/src/hooks/useSession.ts` (`handleRestoreSession`)
  re-attaches each field onto the restored `AnalysisResult`. Saved
  sessions from before the breakdown landed simply restore with these
  fields `undefined`, and the ActionFeed reminder's `showBreakdown`
  short-circuit hides the headline entirely.

### Pre-warming the post-contingency observation

Selecting a contingency triggers `/api/n1-diagram` (or
`/api/n1-diagram-patch`), which creates a pypowsybl variant, runs the
AC load flow, and returns the diagram. Before this optimisation,
`run_analysis_step1` blindly re-ran the same load flow when the
operator clicked "Analyze & Suggest" — the LF on the French grid is
~1-3 s.

`DiagramMixin._cache_obs_for_variant` (a thin wrapper around
`services/diagram/obs_prewarm.py:build_prewarmed_obs`) now builds a
`PypowsyblObservation` off the already-converged variant and stores it
on `_cached_obs_n1` / `_cached_obs_n1_id` / `_cached_obs_n1_elements`.
The stateless helper lives in `services/diagram/` so the mixin stays
under the function-LoC ceiling guarded by the code-quality gate.
`AnalysisMixin.run_analysis_step1` validates the cache against the
contingency variant ID + element list and, on a hit, forwards the
observation to the upstream library through the new
`prebuilt_obs_simu_defaut` kwarg. The upstream then skips
`simulate_contingency_pypowsybl` entirely.

**Safety gate.** The diagram path applies the contingency only — *not*
any maintenance reconnections. When the operator opts into them via
`DO_RECO_MAINTENANCE=True`, the cached obs would be physically wrong,
so `run_analysis_step1` disables the reuse path regardless of variant
match. The default config (`DO_RECO_MAINTENANCE=False`) keeps the
fast path enabled.

**Backward compatibility.** Older `expert_op4grid_recommender`
releases don't accept the `prebuilt_obs_simu_defaut` kwarg.
`AnalysisMixin._upstream_step1_supports_prebuilt_obs()` introspects
the upstream signature with `inspect.signature` and only forwards the
kwarg when the parameter exists. On older libraries the wrapper logs
a one-line notice and falls back to the slow path — no crash, no
synced-pull requirement for operators.

### Action-discovery seam (`run_analysis_step2_discovery`)

The model-aware step-2 generator (`AnalysisMixin.run_analysis_step2`
in `expert_backend/services/analysis_mixin.py`) drives action
discovery **through** the upstream `run_analysis_step2_discovery`
wrapper rather than calling its sub-primitives
(`build_recommender_inputs`, `reassess_prioritized_actions`,
`compute_combined_pairs`) directly. This keeps the long-standing test
seam at
`@patch('expert_backend.services.analysis_mixin.run_analysis_step2_discovery')`
intact — `test_overload_filtering.py`, `test_superposition_service.py`
and friends short-circuit the discovery step at that boundary.

Per-stage timings (`prediction_time`, `assessment_time`) are read out
of the upstream return dict when present (≥ `0.2.2.post1`). Against
older releases the wrapper falls back to a single total surfaced as
`action_prediction_time` (and `assessment_time = 0.0`) so the React UI
shows something useful instead of a misleading split.

### `get_maintenance_timestep_pypowsybl` fast-exit

The upstream `expert_op4grid_recommender.utils.helpers_pypowsybl.get_maintenance_timestep_pypowsybl`
function fast-exits when `do_reco_maintenance=False`. Previously, it
unconditionally scanned every disconnected line in the network and
formatted a multi-line `print` listing them — informational only, since
the returned `lines_in_maintenance` is never consumed downstream when
the flag is off. The scan + print add ~150-300 ms per analysis run on
large grids with many pre-disconnected lines.

### Cache lifecycle

| Event | Effect on `_cached_obs_n1*` |
|---|---|
| `/api/n1-diagram` or `/api/n1-diagram-patch` for a converged contingency | Cache (re)populated for the new contingency. |
| Operator picks a different contingency | The diagram refetch overwrites the cache with the new contingency's observation. |
| `RecommenderService.reset()` (Apply Settings / Load Study) | All three fields cleared to `None`. |
| `simulate_manual_action` / `compute_superposition` | The action variants clone from the contingency variant; the cache is not modified. |
| LF did not converge | Prewarm is skipped; analysis falls back to the full path. |

### Test coverage

| File | What it asserts |
|---|---|
| `expert_backend/tests/test_obs_prewarm_for_step1.py` | `_cache_obs_for_variant` uses the right env; reset clears the cache; cache hit forwards the obs; variant mismatch / maintenance-flag-on disables reuse; signature-introspection fallback. |
| `expert_backend/tests/test_action_patch_module.py` | Covers the action-patch extraction (`services/diagram/action_patch.py`): public-import surface, `_extract_convergence_status` shapes, `_capture_action_snapshots` isolation + copy discipline, `_unpatchable_response` payload, `extract_vl_subtrees_with_edges` with the injected `generate_diagram` callable, `build_action_patch_payload` early-return contract. |
| `Expert_op4grid_recommender/tests/test_helpers_pypowsybl_maintenance.py` | Fast-exit returns an empty action without scanning when `do_reco_maintenance=False`; the print is suppressed; the full path runs unchanged when the flag is on. |
| `Expert_op4grid_recommender/tests/test_run_analysis_step1_prebuilt_obs.py` | `run_analysis_step1` accepts the `prebuilt_obs_simu_defaut` kwarg with `default=None` (signature contract for Co-Study4Grid's introspection). |
| `frontend/src/utils/sessionUtils.test.ts` | All six timing fields are persisted; missing fields written as `null` (stable JSON shape); `null` overflow_graph_time round-trips. |
| `frontend/src/hooks/useSession.test.ts` | All six fields are restored onto the live `AnalysisResult`; legacy sessions without timings restore as `undefined`; `null` overflow_graph_time round-trips. |
| `frontend/src/components/ActionFeed.test.tsx` | The "in `<X>s` ⓘ" line shows the wall-clock total; tooltip lists every reported stage; hides when no timings; the overflow line is omitted when `overflowGraphTime` is `null`. |
| `frontend/src/hooks/useOverflowIframe.test.tsx` | `cs4g:overflow-meta` is broadcast to the iframe whenever `overflowGraphTime` changes (after the handshake). |
| `expert_backend/tests/test_overflow_overlay.py` | The injected iframe overlay exposes `renderOverflowMeta` + the `cs4g:overflow-meta` listener and the `#cs4g-overflow-meta` DOM hook with its "Total execution time:" label. |

---

## Related docs

- [Backend overview](README.md) (this folder).
- [Save Results](../features/save-results.md) — session JSON shape
  including `analysis.active_model` and `configuration.model`.
- [Interaction Logging](../features/interaction-logging.md) —
  `config_loaded` / `settings_applied` details include the recommender
  selection.
- Library-side contract:
  [`marota/expert_op4grid_recommender` — docs/recommender_models.md](https://github.com/marota/expert_op4grid_recommender/blob/main/docs/recommender_models.md).
- Performance history (overflow-graph caching, NAD prefetch, SVG DOM
  recycling): `docs/performance/history/`.
