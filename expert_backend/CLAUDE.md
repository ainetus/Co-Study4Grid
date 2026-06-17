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
├── requirements.txt           # Pinned core deps (fastapi, uvicorn, multipart)
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
│   │   │                          #   operable-switch baseline used by the
│   │   │                          #   interactive SLD-edit feature, see
│   │   │                          #   docs/features/sld-topology-edit.md)
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
│   └── sanitize.py                # NumPy → native-Python recursive coercion
│                                  # (`sanitize_for_json`)
└── tests/                     # pytest suite — see tests/CLAUDE.md
```

## Architecture in one paragraph

`main.py` is a thin HTTP layer. All domain state lives on **two
module-level singletons**: `network_service` (raw pypowsybl Network +
metadata queries) and `recommender_service` (everything that needs
analysis state — base network, action dictionary, observation cache,
last-result, NAD prefetch, layout cache, …). `RecommenderService`
inherits from three mixins (`DiagramMixin`, `AnalysisMixin`,
`SimulationMixin`) each owning a slice of behaviour but operating on
the same `self`. The composition is intentional: state lifecycle
(`__init__`, `reset`, `update_config`) stays in `recommender_service.py`
and the mixins reach into it through `self`. Treat the mixins as one
class split across files for readability.

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

- `network_service` (`services/network_service.py:352`) — owns the
  `pypowsybl.network.Network` returned by `pn.load()`. Read-only
  consumers (frontend `/api/branches`, `/api/voltage-levels`, …) go
  through it.
- `recommender_service` (`services/recommender_service.py:727`) — owns
  analysis state. `_get_base_network()` MUTUALISES the same Network
  object loaded by `network_service` to avoid re-parsing the .xiidm
  twice (~3-5 s on the PyPSA-EUR France grid). See
  `docs/performance/history/grid2op-shared-network.md`.

The shared Network is safe because:
1. `network_service` only reads (no variant switching).
2. `recommender_service` switches variants inside
   `_get_n_variant` / `_get_n1_variant` but always restores the
   original variant in a `try/finally`.

`pn.load()` is called WITHOUT `allow_variant_multi_thread_access=True`
on purpose — see the long comment at `network_service.py:30-43` for
why enabling that is unsafe for the FastAPI thread pool today.

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
  operable-switch booleans), driving the interactive SLD-edit baseline.
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

OS pickers & static:
- `GET  /api/pick-path?type=file|dir` — spawns a tkinter subprocess.
- Static mount at `/results/pdf/` → `Overflow_Graph/`.
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
`GZipMiddleware` rollback (`main.py:30-42`,
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
tunable at `main.py:43-44`.

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

CORS defaults to wide-open (`allow_origins=["*"]`) because the dev
frontend hits the backend cross-origin. It is configurable via the
`CORS_ALLOWED_ORIGINS` env var (PR #104 — see `.env.example`).
Tighten before any non-local deployment.
