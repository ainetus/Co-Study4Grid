# CLAUDE.md — `expert_backend/`

FastAPI backend for Co-Study4Grid. Wraps `pypowsybl` (network +
diagrams) and `expert_op4grid_recommender` (analysis + remedial-action
recommendation) behind a stateless HTTP interface consumed by the
React frontend at `http://localhost:8000`.

For the project-wide overview see the root `CLAUDE.md`. For test
conventions and the mock layer that lets the suite run without
`pypowsybl` / `expert_op4grid_recommender` installed see
`expert_backend/tests/CLAUDE.md`.

## Layout

```
expert_backend/
├── __init__.py
├── main.py                    # FastAPI app: endpoints, CORS, gzip helpers,
│                              # config-file persistence, NDJSON streaming
├── game_api.py                # Game Mode routes (log-solution / lever-stats),
│                              # registered via install_game_routes(app) —
│                              # split out of main.py for the size ceiling
├── test_backend.py            # Ad-hoc integration script (not part of pytest)
├── services/
│   ├── __init__.py
│   ├── network_service.py         # NetworkService singleton — pypowsybl Network
│   │                              # loading (transparently decompresses a zipped
│   │                              # network via _resolve_network_file /
│   │                              # _extract_network_zip), branch / VL / nominal-
│   │                              # voltage queries
│   ├── recommender_service.py     # RecommenderService singleton — orchestrates
│   │                              # analysis. Composes the three mixins below.
│   ├── diagram_mixin.py           # NAD/SLD orchestrator — delegates pure
│   │                              # numerics to services/diagram/ helpers
│   ├── diagram/                   # PR #104 decomposition (ex-diagram_mixin):
│   │   ├── layout_cache.py        # - (path, mtime)-keyed grid_layout.json loader
│   │   ├── nad_params.py          # - default NadParameters factory
│   │   ├── nad_render.py          # - NAD generation + NaN-element stripping
│   │   ├── sld_render.py          # - SLD SVG + metadata with fallbacks
│   │   │                          #   + extract_vl_switch_states (per-VL
│   │   │                          #   operable-switch baseline) AND
│   │   │                          #   extract_vl_injections (per-VL load/
│   │   │                          #   generator active-power baseline) used
│   │   │                          #   by the interactive SLD-edit feature,
│   │   │                          #   see docs/features/sld-topology-edit.md)
│   │   ├── overloads.py           # - overload filtering, element-currents
│   │   ├── flows.py               # - branch + asset flow extractors (vectorised)
│   │   ├── deltas.py              # - terminal-aware flow-delta math (pure)
│   │   ├── obs_prewarm.py         # - post-contingency obs prewarm helper
│   │   │                          #   (build_prewarmed_obs) — drives the
│   │   │                          #   _cached_obs_n1 cache that lets
│   │   │                          #   run_analysis_step1 skip the LF
│   │   └── action_patch.py        # - /api/action-variant-diagram-patch
│   │                              #   pipeline (PR #108): snapshot capture,
│   │                              #   VL topology diff, focused-NAD subtree
│   │                              #   extraction, payload orchestrator.
│   │                              #   compute_vl_topology_diff +
│   │                              #   get_disconnected_branches_from_snapshot
│   │                              #   stay re-exported as static methods on
│   │                              #   DiagramMixin for test backwards-compat.
│   ├── analysis_mixin.py          # Two-step orchestrator — delegates pure
│   │                              # numerics to services/analysis/ helpers
│   ├── analysis/                  # PR #104 decomposition (ex-analysis_mixin):
│   │   ├── action_enrichment.py   # - LS / curtail / redispatch / PST / topology
│   │   │                          #   details (compute_redispatch_details, 0.8.0)
│   │   ├── mw_start_scoring.py    # - MW-at-start dispatcher + per-type math
│   │   │                          #   (incl. the `redispatch` classify tag, 0.8.0)
│   │   ├── analysis_runner.py     # - AC→DC fallback worker, PDF-polling stream
│   │   ├── pdf_watcher.py         # - overflow PDF glob + mtime filter
│   │   └── overflow_geo_transform.py  # - hierarchical → geo SVG transform for
│   │                              #   /api/regenerate-overflow-graph (0.7.0)
│   ├── simulation_mixin.py        # Manual-action + superposition orchestrator
│   ├── simulation_helpers.py      # PR #104 decomposition — stateless helpers
│   │                              # (setpoint math incl. redispatch, PST parsing,
│   │                              # care mask, metrics, result serialisation,
│   │                              # is_injection_action for the GST path, …)
│   ├── model_selection_mixin.py   # Active recommender model + overflow-graph
│   │                              # toggle. A regular base class of
│   │                              # RecommenderService (explicit composition);
│   │                              # update_config / reset call
│   │                              # _apply_model_settings / _reset_model_settings
│   ├── service_lock.py            # D3 (2026-07) — concurrency ownership for
│   │                              # the shared Network: @with_network_lock /
│   │                              # @with_network_lock_stream decorators over
│   │                              # the variant-switching entry points. See the
│   │                              # "Concurrency ownership" section below.
│   ├── api_errors.py              # D2 (2026-07) — unified {detail, code} error
│   │                              # envelope: AppHTTPException + the three
│   │                              # FastAPI exception handlers installed by
│   │                              # install_error_handlers(app). Uncaught
│   │                              # exceptions → generic logged 500 (no str(e)
│   │                              # path leak). See "API error contract" below.
│   ├── overflow_overlay.py        # PR #116 (0.7.0) — pin / filter overlay
│   │                              # injector for the interactive HTML overflow
│   │                              # viewer. `inject_overlay(html)` grafts the
│   │                              # cs4g `<style>` + `<script>` block (and
│   │                              # pinGlyph.js) before `</body>` of the
│   │                              # upstream alphaDeesp viewer. The injected
│   │                              # "Action pins filters" sidebar section
│   │                              # is always visible and hosts the canonical
│   │                              # pins on/off toggle + Show-unsimulated /
│   │                              # Combined-only checkboxes only; severity
│   │                              # / action-type / Max-loading widgets were
│   │                              # moved to the React-side ActionFilterRings
│   │                              # strip and travel via `cs4g:filters`.
│   │                              # React Action Overview tab.
│   ├── game_solutions.py          # Game Mode solution capitalisation store —
│   │                              # shared per-(network, contingency) JSON base
│   │                              # (novelty/bonus + usage frequencies) behind
│   │                              # POST /api/game/log-solution + player-session
│   │                              # count (player_session_count). Pure file IO,
│   │                              # no pypowsybl; root resolved per call:
│   │                              # COSTUDY4GRID_GAME_SOLUTIONS_DIR →
│   │                              # COSTUDY4GRID_DATA_DIR/game_solutions →
│   │                              # repo-local game_solutions/ (gitignored).
│   │                              # _effective_base_dir probes writability and
│   │                              # falls back to repo-local when the configured
│   │                              # mount (e.g. an HF bucket) isn't writable, so
│   │                              # a bad mount never 500s a retention.
│   │                              # See docs/features/game-mode-codabench.md.
│   ├── game_solution_models.py    # Pydantic wire models of the two game
│   │                              # endpoints — kept out of main.py so it
│   │                              # stays under the module-size ceiling
│   └── sanitize.py                # NumPy → native-Python recursive coercion
│                                  # (`sanitize_for_json`)
├── recommenders/               # Pluggable recommendation-model subsystem:
│   ├── __init__.py                # registers the built-in models (expert /
│   │                              # random / random_overflow) at import —
│   │                              # pure registration, NO service patching
│   ├── registry.py                # register / unregister / build_recommender /
│   │                              # list_models (drives GET /api/models)
│   ├── random_basic.py            # RandomRecommender (canonical example)
│   ├── random_overflow.py         # RandomOverflowRecommender (3-layer chain)
│   ├── overflow_path_filter.py    # Path-based candidate narrowing (layer 2)
│   ├── network_existence.py       # Drop actions targeting unknown elements (layer 3)
│   └── synthetic_actions.py       # Synthetic reco / shed / curtail builders
├── openapi.snapshot.json       # D2 (2026-07) — committed app.openapi() dump.
│                              # scripts/check_openapi_contract.py diffs the
│                              # live spec against it; test_openapi_contract.py
│                              # gates it in CI. Regenerate on a deliberate
│                              # endpoint / model / status change:
│                              #   python scripts/check_openapi_contract.py --write
└── tests/                     # pytest suite — see tests/CLAUDE.md
```

## Architecture in one paragraph

`main.py` is a thin HTTP layer. All domain state lives on **two
module-level singletons**: `network_service` (raw pypowsybl Network +
metadata queries) and `recommender_service` (everything that needs
analysis state — base network, action dictionary, observation cache,
last-result, NAD prefetch, layout cache, …). `RecommenderService`
inherits from four mixins (`DiagramMixin`, `AnalysisMixin`,
`SimulationMixin`, `ModelSelectionMixin`) each owning a slice of
behaviour but operating on the same `self`. The composition is
intentional: state lifecycle (`__init__`, `reset`, `update_config`)
stays in `recommender_service.py` and the mixins reach into it through
`self`. Treat the mixins as one class split across files for
readability. The pluggable-recommender subsystem in `recommenders/`
plugs in through that same composition: `ModelSelectionMixin` holds
the active model + overflow-graph toggle, and
`AnalysisMixin.run_analysis_step2` builds the recommender from
`recommenders/registry.py` at dispatch time (full reference:
`docs/backend/recommender_models.md`). There is deliberately NO
import-time monkey-patching anywhere in this integration — the former
`recommenders/_service_integration.py` module that rewrote the service
class at import was removed in the 2026-07 D1 revision after it
shipped two mirror-drift bugs.

**Mixin → helper-package decomposition (PR #104 / #106).** Each
mixin is now a **thin orchestrator** that delegates stateless pure
numerics to sibling packages: `services/diagram/` (7 modules),
`services/analysis/` (4 modules), and `services/simulation_helpers.py`
(14 free functions). The split keeps the mixins manageable while
preserving `@patch` compatibility — helpers that need service
collaborators (`get_virtual_line_flow`, `run_analysis`, …) accept
them as optional callables and the mixin reads those from its own
module namespace at call time, so legacy
`@patch('expert_backend.services.analysis_mixin.*')` tests keep
working unchanged.

## Singletons & shared state

- `network_service` (the module-level `NetworkService()` singleton in
  `services/network_service.py`) — owns the
  `pypowsybl.network.Network` returned by `pn.load()`. Read-only
  consumers (frontend `/api/branches`, `/api/voltage-levels`, …) go
  through it.
- `recommender_service` (the module-level `RecommenderService()` singleton in
  `services/recommender_service.py`) — owns
  analysis state. `_get_base_network()` MUTUALISES the same Network
  object loaded by `network_service` to avoid re-parsing the .xiidm
  twice (~3-5 s on the PyPSA-EUR France grid). See
  `docs/performance/history/grid2op-shared-network.md`.

The shared Network is safe because:
1. `network_service` only reads (no variant switching).
2. `recommender_service` switches variants inside
   `_get_n_variant` / `_get_n1_variant` but always restores the
   original variant in a `try/finally`.
3. **Concurrent** callers are serialized by a service-level re-entrant
   lock — see "Concurrency ownership" below.

`pn.load()` is called WITHOUT `allow_variant_multi_thread_access=True`
on purpose — see the long `allow_variant_multi_thread_access` comment in `network_service.py` for
why enabling that is unsafe for the FastAPI thread pool today.

## Concurrency ownership (D3, 2026-07)

The single-user, single-flight assumption above no longer holds
(FastAPI threadpool + frontend `Promise.all` batches + one-process
multi-visitor HuggingFace Space). Three primitives in
`services/service_lock.py` restore ownership — full rationale in
[`docs/architecture/shared-network-concurrency.md`](../docs/architecture/shared-network-concurrency.md):

1. **`self._network_lock`** (a re-entrant `RLock`) serializes every
   entry point that variant-switches the shared Network. Decorate a
   sync entry point with `@with_network_lock`; a streaming one with
   `@with_network_lock_stream` (holds the lock per resumption, not
   across `yield`s — and acquires/releases inside one `__next__` so
   Starlette's per-`next()` threadpool hopping is safe). **Any new
   method that switches variants MUST wear one of these.**
   `/api/config` additionally wraps its `reset → load → update`
   sequence in `recommender_service.network_lock()`.
2. **Study-mutation busy gate** (`try_begin_study_mutation` /
   `end_study_mutation`, a plain `Lock`): `/api/config` + the three
   analysis entry points claim it non-blocking and return **HTTP 409**
   on conflict instead of queueing a second multi-second mutation.
   Streaming endpoints release it in the generator's `finally`.
3. **Contingency-variant LRU** (`_touch_contingency_variant`, cap
   `MAX_CONTINGENCY_VARIANTS`): bounds the variant set the shared
   Network accumulates within a session; eviction calls
   `remove_variant` + drops the `_lf_status_by_variant` entry.

**Lock-ordering caveat**: the NAD-prefetch worker takes the same
`_network_lock`, so `reset()` must NOT join it (deadlock). Staleness is
handled by the `_prefetch_generation` counter instead; the drain is a
no-op when the lock is present.

## API error contract (D2, 2026-07)

Every error the API returns has ONE shape: `{"detail": <human string>,
"code": <STABLE_SLUG>}`, produced in ONE place (`services/api_errors.py`,
installed once via `install_error_handlers(app)`). Full rationale +
follow-ups in
[`docs/architecture/api-contract-machine-check.md`](../docs/architecture/api-contract-machine-check.md).

- Raise a plain `HTTPException` for the common case — the handler derives
  a `code` from the status (`400→BAD_REQUEST`, `404→NOT_FOUND`,
  `409→STUDY_BUSY`, `422→VALIDATION`, `500→INTERNAL`). `detail` is
  unchanged, so `code` is purely additive.
- Raise `AppHTTPException(status, detail, code)` when a client **branches
  on the specific failure** — today that's the post-reload
  `action-variant-diagram` 400 (`code=ACTION_RESULT_UNAVAILABLE`, which
  the frontend uses to fall back to a live simulation), the 409
  study-busy gate (`code=STUDY_BUSY`), and the 403
  `code=LOCKED_DOWN` raised by `_reject_when_locked_down()` on a
  locked-down deployment (see "Deployment lockdown" below).
- **Never** put `str(exception)` in a client-visible detail for an
  UNEXPECTED error — it leaks absolute server paths. Uncaught exceptions
  are turned into a generic `500` (`"Internal server error."`,
  `code=INTERNAL`) with the real traceback only `logger.exception`-logged.
  The frontend reads all of this through one extractor,
  `frontend/src/utils/apiError.ts`.
- **Machine-check**: the OpenAPI contract is snapshotted to
  `openapi.snapshot.json` and diffed in CI (`test_openapi_contract.py` /
  `scripts/check_openapi_contract.py`). Any endpoint / request-model /
  response-model / status change fails the check until you regenerate the
  snapshot (`--write`). When you add or change an endpoint, run the
  regenerate command and review the diff — it mirrors what `types.ts`
  must track.

## State lifecycle: load → reset → reload

- **First load** (`/api/config` POST): sets `network_service.network`
  via `network_service.load_network()`, then calls
  `recommender_service.update_config(settings)` which:
  1. Updates `expert_op4grid_recommender.config` globals
     (`ENV_PATH`, `LAYOUT_FILE_PATH`, `MIN_*`, monitoring config, …).
  2. Calls `prefetch_base_nad_async()` — kicks a background thread
     that pre-computes the base NAD so the subsequent
     `/api/network-diagram` XHR is a near-instant cache hit. See
     `docs/performance/history/nad-prefetch.md` and
     `docs/performance/history/nad-prefetch-earlier-spawn.md`.
  3. Loads the action dictionary (`load_actions` +
     `enrich_actions_lazy`). Auto-generates `disco_*` actions for
     every line if the file lacks them.
  4. Pre-builds a `SimulationEnvironment` cached on
     `_cached_env_context` — saves ~4-8 s per
     `/api/run-analysis-step1` call.

- **Re-load** (any subsequent `/api/config`): `recommender_service.reset()`
  is called BEFORE the new network is loaded. `reset()` MUST clear
  every per-study cache on the service. The full list (also
  documented at `docs/features/state-reset-and-confirmation-dialogs.md`):
  `_last_result`, `_is_running`, `_generator`, `_base_network`,
  `_simulation_env`, `_last_disconnected_element`, `_dict_action`,
  `_analysis_context`, `_saved_computed_pairs`, `_cached_obs_n*`,
  `_cached_env_context`, `_initial_pst_taps`,
  `_lf_status_by_variant`, `_layout_cache`,
  `_prefetched_base_nad*`, `_overflow_layout_mode` (back to
  `"hierarchical"`), `_overflow_layout_cache` (empty dict),
  `_last_step2_context`, `_last_step2_signature`. Adding a new instance-level cache?
  Add it here too — otherwise it WILL leak across studies (see the
  `_layout_cache` regression fixed on
  `claude/fix-grid-layout-reset-8TYEV`).

- **Drain order matters**: `reset()` calls
  `_drain_pending_base_nad_prefetch()` FIRST so a still-running
  prefetch thread cannot finish after reset and write into the next
  study's cache.

## API surface (one-liners; root `CLAUDE.md` has the full table)

Diagram & topology:
- `GET  /api/branches` / `/api/voltage-levels` / `/api/nominal-voltages`
  — read-only metadata.
- `GET  /api/network-diagram` — base-state NAD. Serves the
  prefetched diagram when available (saves ~5-6 s on large grids).
  Supports `?format=text` to return a JSON header + raw SVG body
  (saves ~500 ms of `JSON.parse` on 25 MB SVG strings — see
  `docs/performance/history/loading-parallel.md`).
- `POST /api/contingency-diagram` / `/api/action-variant-diagram` /
  `/api/focused-diagram` / `/api/action-variant-focused-diagram`
- `POST /api/contingency-diagram-patch` / `/api/action-variant-diagram-patch`
  — **SVG-less per-branch deltas** for the frontend DOM-recycling
  fast path (PR #108). Return the same flow / contingency / topology
  metadata as the full endpoints but omit the multi-MB SVG body. The
  frontend's `utils/svgPatch.ts` clones the already-mounted N-state
  SVG and patches it with this delta — ~80 % faster tab switches on
  the ~12 MB French NAD. See
  `docs/performance/history/svg-dom-recycling.md`.
- `POST /api/n-sld` / `/api/contingency-sld` / `/api/action-variant-sld`
  — each response now carries a `switch_states` map (per-VL
  operable-switch booleans) AND an `injections` map (per-VL load /
  generator active-power baseline: `kind`, `p`, gen `min_p` / `max_p` /
  `energy_source`), driving the interactive SLD-edit baseline, AND a
  `feeder_labels` map (`build_feeder_labels` — per-branch
  `{name, other_vl, label}`: `label` = far-end VL name + parallel index
  for feeder relabelling, `name` = friendly/operator name bridging
  friendly-named overloads to the IIDM-id-keyed SLD cell). See
  `docs/features/sld-diagram-feeder-labels.md`.
- `POST /api/sld-topology-preview` — re-renders the VL SLD with the
  user's staged switch overrides applied on a throwaway variant
  (topological-colouring, NO load flow). Response carries
  `stale_flows: true`. See `docs/features/sld-topology-edit.md`.

Analysis:
- `POST /api/run-analysis-step1` — detect overloads (returns once).
- `POST /api/run-analysis-step2` — resolve, **streaming** NDJSON.
  Caches the overflow graph by an input signature
  (`_last_step2_signature`); a re-run with an identical signature
  skips the graph rebuild and re-executes only action discovery — the
  model-swap fast path.
- `POST /api/run-analysis` — single-step legacy NDJSON stream.
- `GET  /api/models` — list registered recommender models.
- `POST /api/recommender-model` — lightweight swap of the active
  recommender model (`_apply_model_settings`); no network reload, no
  action-dictionary rebuild. Leaves `_last_step2_signature` intact so
  the overflow-graph cache is reused across a model swap.
- `POST /api/regenerate-overflow-graph` — toggle overflow-graph
  layout between hierarchical (graphviz `dot`, produced by
  `run_analysis_step2`) and geo (pure SVG transform that
  repositions node groups using `grid_layout.json` coordinates
  and redraws edges as straight lines). Non-streaming. Cache-
  backed: the hierarchical path is seeded by `run_analysis_step2`
  and the geo path is generated on first click, then cached.
  Subsequent toggles in either direction return the cached file
  instantly. Cache is cleared at the start of every fresh
  `run_analysis_step2` and on `reset()`. The transform lives in
  `services/analysis/overflow_geo_transform.py` (pure function,
  lxml-based, fully unit-tested).
- `POST /api/simulate-manual-action` — one-off simulation. Optional
  `voltage_level_id` field used to auto-name switch-only manual actions
  (`"Manoeuvre manuelle sur <vl>: SW_A ouvert, SW_B fermé"`).
- `POST /api/simulate-and-variant-diagram` — combined NDJSON stream
  emitting `{type:"metrics"}` then `{type:"diagram"}` so the
  sidebar can update ahead of the SVG.
- `POST /api/compute-superposition` — combined-pair effect.

Session & user config:
- `POST /api/save-session`, `GET /api/list-sessions`,
  `POST /api/load-session`, `POST /api/restore-analysis-context`.
- `GET/POST /api/user-config`, `GET/POST /api/config-file-path`.

Game Mode:
- `POST /api/game/log-solution` — capitalise a retained proposition into
  the shared solution base (`services/game_solutions.py`); returns the
  novelty verdict (+bonus points) and per-action usage frequencies. Pure
  file IO — no network lock / busy gate; the store serializes its own
  read-modify-write with a module-level lock and writes records
  atomically (temp file + `os.replace`).
- `GET /api/game/lever-stats` — top-N most-used unitary levers of a
  (network, contingency) context, tagged by equipment family
  (`voltage_level` / `branch` / `generation` / `load` / `other`).
  Read-only store scan; feeds the Game Mode beginner-assistance panel.
- `GET /api/game/player-sessions` — distinct sessions a player already
  recorded in the shared base (`player_session_count`): `session_count` +
  the concrete `session_names` (sorted, case-insensitive). Seeds the default
  session name (first FREE `<player> — session <n>` index) AND lets the config
  screen block a colliding name before Start — a count-plus-one heuristic
  re-suggests a taken name when the recorded indices have gaps. Read-only.

OS pickers & static:
- `GET  /api/pick-path?type=file|dir` — spawns a tkinter subprocess.
- Static mount at `/results/pdf/` → `Overflow_Graph/`.
- **Deployment lockdown (D7, 2026-07)**: the desktop-era filesystem RPCs
  (`POST /api/config-file-path`, `POST /api/save-session`,
  `GET /api/list-sessions`, `POST /api/load-session`, `GET /api/pick-path`)
  each call `_reject_when_locked_down()` first, which raises
  `403 {code: LOCKED_DOWN}` when `COSTUDY4GRID_LOCKDOWN` is truthy
  (`main._LOCKDOWN`, set in the `Dockerfile` for the public Space). The
  read-only app config (`GET /api/user-config`, `GET /api/config-file-path`)
  stays open so the SPA boots. Unset locally → unchanged. Any NEW
  filesystem-touching RPC MUST wear the guard. See
  [`docs/architecture/deployment-trust.md`](../docs/architecture/deployment-trust.md).
- **Optional same-origin SPA mount (0.8.0)**: when `COSTUDY4GRID_FRONTEND_DIST`
  (default `frontend/dist/`) holds an `index.html`, the built React app is
  mounted at `/` via `StaticFiles(html=True)`. Mounted **last** so every
  `/api/*` and `/results/*` route declared above keeps priority over the
  catch-all; inert when the dist is absent, so local dev is unaffected. This
  lets the HuggingFace Docker Space serve UI + API from one uvicorn process
  (port 7860). See `deploy/huggingface/` + the root `Dockerfile`.

## Streaming responses (NDJSON)

`/api/run-analysis`, `/api/run-analysis-step2`, and
`/api/simulate-and-variant-diagram` use FastAPI `StreamingResponse`
with `application/x-ndjson`. Events are JSON lines:
- `{"type":"pdf", "pdf_url":..., "pdf_path":...}` — overflow graph
  file ready (delivered EARLY so the UI can show it before results).
  Event / field names kept for session-schema backward compatibility;
  the referenced file is now an interactive `.html` viewer by default
  (`config.VISUALIZATION_FORMAT="html"` set in
  `recommender_service.update_config`) and `.pdf` on legacy installs.
- `{"type":"result", ...}` or `{"type":"metrics", ...}` /
  `{"type":"diagram", ...}` — final payloads.
- `{"type":"error", "message":...}` — failure event; stream closes.

Do NOT route streaming endpoints through `_maybe_gzip_*`. The
per-endpoint gzip helper is for non-streaming responses only —
wrapping NDJSON in gzip buffers events until a flush, breaking the
early-PDF guarantee. This was the root cause behind the global
`GZipMiddleware` rollback (see the rollback note atop `main.py`,
`docs/performance/history/per-endpoint-gzip.md`).

## Per-endpoint gzip

Two helpers in `main.py`:
- `_maybe_gzip_json(payload, request)` — wraps any JSON-serialisable
  payload, gzips when ≥ 10 KB and the client signals
  `Accept-Encoding: gzip`.
- `_maybe_gzip_svg_text(diagram, request)` — JSON header + raw SVG
  body (for `/api/network-diagram?format=text`). Skips the
  client-side `JSON.parse` on the multi-MB SVG string.

Both set `Vary: Accept-Encoding`. Threshold and compression level are
tunable via the `_GZIP_MIN_BYTES` / `_GZIP_LEVEL` constants in `main.py`.

## NumPy → JSON sanitization

pypowsybl returns NumPy scalars / arrays inside dicts that FastAPI's
default JSON encoder rejects. `services/sanitize.py:sanitize_for_json`
recursively coerces them to native Python types and is called in every
endpoint payload. Don't return raw NumPy from a service method —
either call `sanitize_for_json` at the boundary or convert inside the
service itself.

## Variants & load flow

`_get_n_variant()` and `_get_n1_variant(contingency)` clone from a
clean N-state baseline (NEVER from the current working variant — that
could inherit modifications from a prior action simulation). They run
the AC load flow with `_run_ac_with_fallback`, which retries in slow
mode if `PYPOWSYBL_FAST_MODE` is on and AC fails. Variant cache is on
`self._lf_status_by_variant` so `get_n1_diagram` reuses the LF status
without re-running.

`_ensure_n_state_ready()` and `_ensure_n1_state_ready()` are guards
called at the entry of analysis / simulation endpoints. They join any
in-flight NAD prefetch thread (so it can't race on variant changes)
and pin the working variant. Add them to any new entry point that
operates on the shared network.

## Layout cache (`_layout_cache`)

`DiagramMixin._load_layout()` parses `grid_layout.json` into a pandas
DataFrame and caches it on the service keyed by `(path, mtime)`. Used
as `fixed_positions` for NAD generation. Two invariants:
1. `reset()` MUST clear `_layout_cache` (see "State lifecycle"
   above) — otherwise the previous study's layout leaks into the new
   grid's NAD.
2. The `(path, mtime)` key auto-invalidates when the file changes,
   so warm-process workflow stays fast.

## NAD prefetch

`prefetch_base_nad_async()` is called from `update_config()` right
after `LAYOUT_FILE_PATH` is set. It:
1. Pre-warms `self._base_network` in the main thread (so the worker
   sees an O(1) attribute access — no lazy-init race).
2. Spawns a daemon thread named `NADPrefetch` that calls
   `self.get_network_diagram()`.
3. Stores the result on `_prefetched_base_nad`, errors on
   `_prefetched_base_nad_error`, completion on
   `_prefetched_base_nad_event`.

`/api/network-diagram` calls `get_prefetched_base_nad(timeout=60)`
which blocks on the event then either returns the cached diagram or
re-raises the worker exception. Falls through to a fresh compute if
no prefetch was ever started (e.g. tests bypassing `update_config`).

## Adding endpoints

1. Add the Pydantic request model at the top of `main.py` near the
   existing models.
2. Add the route. Import any service method via the singleton
   (`network_service` / `recommender_service`).
3. Wrap non-streaming JSON responses in `_maybe_gzip_json(payload,
   http_request)` if the payload can grow large (≥ 10 KB).
4. Mirror the path in `frontend/src/api.ts` (axios method) and the
   master table in the root `CLAUDE.md` (and add a row to the API
   table there).
5. Add a test under `expert_backend/tests/` — see
   `tests/CLAUDE.md` for the mock layer that lets it run without
   `pypowsybl` installed.
6. **Regenerate the OpenAPI contract snapshot** — the new route (and any
   request/response model) changes `app.openapi()`, so
   `test_openapi_contract.py` will fail until you run
   `python scripts/check_openapi_contract.py --write` and commit the
   updated `openapi.snapshot.json`. Review that diff — it's the record of
   the contract change. If the response is a small, stable, NumPy-free
   dict, prefer declaring a `response_model` (see the D2 seed models) so
   the response shape is machine-checked too; large gzipped payloads keep
   returning a bespoke `Response` and are covered structurally by the
   snapshot only.
7. Errors: raise a plain `HTTPException` (the handler adds the `code`), or
   `AppHTTPException(status, detail, code)` when the frontend must branch
   on the failure — see "API error contract" above. Never `str(e)` an
   unexpected error into the client detail.

## Adding a new per-study cache

1. Initialise the field in `RecommenderService.__init__` — keep
   them grouped by purpose with a short comment.
2. **Clear it in `reset()`** — same group / order as `__init__`.
3. Document it in the "What `reset()` clears" list in
   `docs/features/state-reset-and-confirmation-dialogs.md`.
4. If the field holds a thread / future / event, drain or cancel it
   inside `_drain_pending_*` helpers BEFORE clearing the field —
   look at `_drain_pending_base_nad_prefetch` for the pattern.

## Conventions

- **Logging**: `logger = logging.getLogger(__name__)`. Use it
  (no `print`, no `traceback.print_exc()`) for new code — the
  code-quality gate enforces this (PR #104).
- **Ruff** is configured in `pyproject.toml` with a narrow
  `E9` + `F` ruleset (real bugs only — no stylistic rules). Run
  `ruff check expert_backend` before committing.
- **Error handling at the API boundary**: services raise standard
  exceptions; `main.py` translates them to `HTTPException` with a
  meaningful detail message. Internal validation that "can't fail"
  shouldn't be there — trust the caller.
- **No backwards-compatibility shims**: when a feature changes,
  update the consumers in the same commit (frontend, tests).
- **Auto-generated standalone**: no manual mirroring is required.
  `npm run build:standalone` regenerates
  `frontend/dist-standalone/standalone.html` from the React source
  tree; the legacy hand-maintained `standalone_interface.html` has
  been decommissioned (PR #101).

## Running

```bash
# From project root
python -m expert_backend.main
# Or
uvicorn expert_backend.main:app --host 0.0.0.0 --port 8000
```

CORS defaults to the local Vite dev/preview origins on loopback
(`localhost` / `127.0.0.1` on `:5173` and `:4173`) so the dev frontend
can hit the backend cross-origin without opening it to every web page.
A wildcard (`allow_origins=["*"]`) is now explicit opt-in via
`CORS_ALLOWED_ORIGINS="*"`; a comma-separated list overrides the default
for a specific deployment (see `.env.example`). The same-origin
HuggingFace Space needs no entry (same-origin requests don't trigger
CORS).
