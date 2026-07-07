# Co-Study4Grid Backend

FastAPI service that orchestrates contingency analysis on top of
[`expert_op4grid_recommender`](https://github.com/marota/Expert_op4grid_recommender)
and serves the React frontend.

This document is the **backend overview** — architecture, data flow,
service patterns, key conventions. For deeper dives, see the linked
specialised docs.

---

## At a glance

```
expert_backend/
├── main.py                          # FastAPI app + endpoints
├── services/                        # Domain services
│   ├── network_service.py             # pypowsybl network loading & queries
│   ├── recommender_service.py         # Analysis orchestration (singleton)
│   ├── diagram_mixin.py + diagram/    # NAD / SLD rendering (mixin + 7 helpers)
│   ├── analysis_mixin.py + analysis/  # Two-step analysis (mixin + 5 helpers)
│   ├── simulation_mixin.py            # Manual + combined actions
│   ├── model_selection_mixin.py       # Pluggable recommender state + getters
│   ├── overflow_overlay.py            # Action-pin overlay for interactive overflow viewer
│   └── sanitize.py                    # NumPy → native-Python JSON coercion
└── recommenders/                    # Pluggable recommendation models
    ├── registry.py                    # register / build / list_models
    ├── random_basic.py                # RandomRecommender (canonical example)
    ├── random_overflow.py             # RandomOverflowRecommender (3-layer chain)
    ├── overflow_path_filter.py        # Layer 2 of the sampling filter chain
    ├── network_existence.py           # Layer 3 of the sampling filter chain
    └── synthetic_actions.py           # Synthetic reco / shed / curtail builders
                                       # (model dispatch is explicit composition on
                                       #  RecommenderService — no patching module)
```

---

## Architecture

### Singletons

Two top-level singletons drive every request:

- **`network_service`** — owns the pypowsybl `Network` instance. Reset
  on every `POST /api/config`. Exposes high-level read queries
  (`get_disconnectable_elements`, `get_voltage_levels`,
  `get_element_voltage_levels`, `get_generator_type`, ...).
  On load it transparently resolves and decompresses a **zipped
  network** (`_resolve_network_file` / `_extract_network_zip`): an
  explicit `*.zip` path, a missing `foo.xiidm` whose sibling
  `foo.xiidm.zip` exists, or a directory holding only a `.zip` all
  Just Work (the large France 225/400 kV grid ships as
  `network.xiidm.zip`). Consumers point the network path at the
  `.xiidm` (or the `.zip`) regardless.
- **`recommender_service`** — owns analysis state (the `_analysis_context`
  dict built by step-1, the `_dict_action` enriched action dictionary,
  the `_last_result`, layout caches). Composed of mixins so each
  concern lives in a focused file:
  - `DiagramMixin` → NAD / SLD generation + patch endpoints
  - `AnalysisMixin` → `run_analysis`, `run_analysis_step1`,
    `run_analysis_step2`, action enrichment
  - `SimulationMixin` → `simulate_manual_action`, `compute_superposition`
  - `ModelSelectionMixin` → recommender name + `compute_overflow_graph`
    toggle, inherited directly by `RecommenderService` (explicit
    composition — the former import-time patching module
    `_service_integration.py` was removed in the 2026-07 D1 revision)

The mixin pattern keeps each concern ≤ 500 lines and unit-testable in
isolation (see `expert_backend/tests/`).

### Pluggable recommenders

The analysis pipeline does NOT hardcode the expert system. It
dispatches to any class implementing the `RecommenderModel` ABC from
[`expert_op4grid_recommender.models.base`](https://github.com/marota/Expert_op4grid_recommender/blob/main/expert_op4grid_recommender/models/base.py).

Three models ship out of the box: `expert` (default), `random`,
`random_overflow`. Third-party packages can register additional models
via `@register` at import time. The **full reference** — contract,
three-layer filter chain, backend / frontend wiring, step-by-step
guide for plugging in a new model, troubleshooting — is in
[**`docs/backend/recommender_models.md`**](recommender_models.md).

### Data flow

```
   /api/config  →  network_service.load_network()         loads pypowsybl Network
        │                                                 builds dict_action
        │                                                 stores recommender model name
        v
   /api/run-analysis-step1
        │     run_analysis_step1(context, ...)            simulates N-K contingency
        │                                                 detects overloads
        │                                                 picks subset that keeps
        │                                                 the graph connected
        v
   /api/run-analysis-step2 (NDJSON stream)
        │     run_analysis_step2_graph(context)            (skipped when the chosen model
        │                                                  doesn't require the overflow
        │                                                  graph AND the operator did
        │                                                  not opt in)
        │                                                 builds alphaDeesp graph
        │                                                 + visualisation HTML
        │     run_analysis_step2_discovery(context, recommender, params)
        │                                                 runs expert rule filter
        │                                                 (whenever graph is available)
        │                                                 calls recommender.recommend(inputs, params)
        │                                                 reassesses every action
        │                                                 (simulation → rho-before / rho-after
        │                                                  / non-convergence /
        │                                                  combined-pair superposition)
        │
        ├→  yield { type: "pdf",     pdf_path }          first event so the UI can
        │                                                 paint the overflow tab early
        └→  yield { type: "result",  actions,
                                          action_scores,
                                          lines_overloaded,
                                          combined_actions,
                                          active_model,        ← echoed for the saved session
                                          compute_overflow_graph,
                                          ... }
```

The two-step flow exists so the operator can pick **which** overloads
to resolve before step-2 runs (the expensive part). The legacy
single-shot `POST /api/run-analysis` is kept for backward
compatibility.

---

## Conventions

### Per-endpoint gzip (no global middleware)

Large SVG diagrams compress ~10× with gzip, but the streaming
`run-analysis-step2` endpoint MUST NOT be wrapped in `GZipMiddleware`
— it buffers NDJSON events and delays the early-`pdf` event the UI
relies on. Instead, `main.py` exposes `_maybe_gzip_json` and
`_maybe_gzip_svg_text` and the relevant non-streaming endpoints opt
in per-call. See the comment at the top of `expert_backend/main.py`
for the full rationale.

### NumPy → JSON coercion

Everything yielded by `run_analysis_step2` and returned by
`simulate_manual_action` goes through
`expert_backend/services/sanitize.py::sanitize_for_json` to coerce
numpy scalars / arrays into native Python types. Without this the
FastAPI JSON encoder either crashes (`numpy.int64` is not JSON
serialisable) or emits `NaN` / `Infinity` literals the React parser
rejects.

### Mixin-based service composition

`recommender_service.py` doesn't put every method in one class — it
composes specialised mixins:

```python
class RecommenderService(
    DiagramMixin,
    AnalysisMixin,
    SimulationMixin,
    ...
):
    def __init__(self): ...
```

Each mixin owns a few attributes (`_dict_action`, `_analysis_context`,
`_last_result`, ...) and a small surface area. `ModelSelectionMixin`
is a regular base class of `RecommenderService`; `update_config` /
`reset` call `_apply_model_settings` / `_reset_model_settings`
explicitly and the model-aware `run_analysis_step2` lives on
`AnalysisMixin` — see [`recommender_models.md`](recommender_models.md) §4.

### Pre-extraction + idempotent helpers

Where possible, step-1 outputs are propagated to downstream phases
through the `context` dict instead of being recomputed. Examples:

- `lines_overloaded_ids_kept` — island-prevention-guard result
- `pre_existing_rho` — N-state rho of pre-existing overloads
- `filtered_candidate_actions` — expert rule-filter result; available
  to every model on `inputs.filtered_candidate_actions` whenever the
  overflow graph is in context (so non-expert models that opt in via
  `compute_overflow_graph=True` also see it). Idempotent helper
  `_run_expert_action_filter(context)` returns immediately when the
  field is already populated.

### Defensive filters

The random-recommender sampling chain (layers 1–3 in
[`recommender_models.md`](recommender_models.md) §3) is **conservative
on internal failure**: every layer returns the input list unchanged
when its internal logic raises. A bug in one filter cannot silently
empty the pool. The two non-trivial layers also handle both shapes
the distribution graph may return (integer indices into `obs.name_sub`
legacy build, plus `numpy.str_` / `str` names current build) — see
`_resolve_node_to_name` in `overflow_path_filter.py`.

---

## Endpoints

Full table lives in the top-level [`README.md`](../../README.md#api-reference).
The groups, by responsibility:

- **Configuration & session**: `/api/config`, `/api/user-config`,
  `/api/config-file-path`, `/api/models`, `/api/pick-path`,
  `/api/save-session`, `/api/list-sessions`, `/api/load-session`,
  `/api/restore-analysis-context`.
- **Network introspection**: `/api/branches`, `/api/voltage-levels`,
  `/api/nominal-voltages`, `/api/element-voltage-levels`,
  `/api/voltage-level-substations`, `/api/actions`.
- **Analysis**: `/api/run-analysis`, `/api/run-analysis-step1`,
  `/api/run-analysis-step2` (NDJSON stream),
  `/api/simulate-manual-action`, `/api/compute-superposition`.
- **Diagrams**: `/api/network-diagram`, `/api/contingency-diagram`,
  `/api/contingency-diagram-patch`, `/api/action-variant-diagram`,
  `/api/action-variant-diagram-patch`, `/api/focused-diagram`,
  `/api/action-variant-focused-diagram`, `/api/n-sld`,
  `/api/contingency-sld`, `/api/action-variant-sld`,
  `/api/simulate-and-variant-diagram`, `/api/regenerate-overflow-graph`,
  `/results/pdf/{filename}`.

### Optional same-origin SPA hosting (0.8.0)

When `COSTUDY4GRID_FRONTEND_DIST` (default `frontend/dist/`) holds an
`index.html`, the built React app is mounted at `/` via
`StaticFiles(html=True)`. The mount is added **last**, after every
`/api/*` and `/results/*` route, so those keep priority over the
catch-all; it is inert when the dist is absent, so local dev and the
test suite are unaffected. This is what lets the HuggingFace Docker
Space serve UI + API from a single uvicorn process on port 7860 — see
[`deploy/huggingface/`](../../deploy/huggingface/) and the root
`Dockerfile`.

---

## Session persistence

`POST /api/save-session` writes a `session.json` snapshot of the
entire analysis state to disk, plus an `interaction_log.json` and a
copy of the overflow viewer HTML. The shape captures both **what was
configured** (`configuration.model`, `configuration.compute_overflow_graph`)
and **what was actually executed** (`analysis.active_model`,
`analysis.compute_overflow_graph`), so reloaded sessions show which
recommender produced the suggestions — useful when an unknown model
name silently fell back to the default.

Full reference:
[`docs/features/save-results.md`](../features/save-results.md).

The interaction log is replay-ready (every chip toggle, click,
simulation, save, reload carries enough data to reproduce the gesture).
Full reference:
[`docs/features/interaction-logging.md`](../features/interaction-logging.md).

---

## Testing

The recommender-subsystem tests live in the canonical
`expert_backend/tests/` suite (they were rescued from an orphaned root
`tests/` package — which no pytest config collected — in the 2026-07
D1 revision) and run in CI with the rest of the backend suite. They
need the real `expert_op4grid_recommender` package (the registry
imports the concrete model classes) and skip under the conftest mock
layer:

- `test_recommenders_registry.py` — register / unregister / build /
  list_models / canonical-three + `params_spec()` failure resilience.
- `test_random_recommenders.py` — Random + RandomOverflow metadata,
  sampling cardinality, three-layer filter chain, None-vs-`[]`
  fallback semantics, drop-on-unknown-VL regression.
- `test_overflow_path_filter.py` — `_resolve_node_to_name` covering
  every shape the distribution graph may return, including the
  `numpy.str_` regression and the underscore-in-substation-name
  segment-scan fix.
- `test_network_existence.py` — `filter_to_existing_network_elements`,
  conservative fallback on introspection failure.
- `test_action_enrichment.py` — `extract_action_topology` with
  numpy-array attribute tolerance + 4-way `set_bus` backfill +
  `voltage_level_id` surfacing.
- `test_model_selection_mixin.py` — state defaults, settings parsing.
- `test_model_composition.py` — explicit composition wiring (mixin
  inherited, `update_config` / `reset` delegate to the mixin, single
  model-aware `run_analysis_step2`, overflow-graph cache fast path,
  `antenna_meta` pass-through regression).
- `test_models_api.py` — `ConfigRequest` schema + `GET /api/models`.

Run: `pytest expert_backend/tests` (or plain `pytest`).

---

## Related docs

- [Pluggable Recommendation Models](recommender_models.md) — the
  full plug-in reference (this folder).
- [Save Results](../features/save-results.md) — session JSON shape,
  reload behaviour, model persistence.
- [Interaction Logging](../features/interaction-logging.md) — every
  user event captured for replay (settings tab includes model selection).
- [Interactive Overflow Analysis](../features/interactive-overflow-analysis.md)
  — the HTML viewer that replaced the static PDF.
- [Combined Actions](../features/combined-actions.md) — superposition
  estimation + full pair simulation modal.
- Top-level [README](../../README.md) — stack, getting started, full
  API reference, performance highlights.
- Library-side contract:
  [`marota/expert_op4grid_recommender` — docs/recommender_models.md](https://github.com/marota/expert_op4grid_recommender/blob/main/docs/recommender_models.md).
