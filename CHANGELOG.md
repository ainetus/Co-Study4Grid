# Changelog

All notable changes to **Co-Study4Grid** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project (informally) follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Direct SLD editing — switches & injections without a mode toggle

The interactive Single Line Diagram editor is now reachable straight
from the opened diagram and covers loads / generators as well as
breakers:

- **No "Manual action" button.** Edit mode is implicit: an open SLD on
  an editable tab (N-1 or post-action) is always editable, and closing
  the overlay is what returns it to read-only. Breakers / disconnectors
  are clickable immediately; editable equipment (breakers AND loads /
  generators) carries a persistent clickable cue — pointer cursor + a
  solid edit-blue outline, like a button — so it's obvious what can be
  manipulated.
- **The overlay auto-sizes to the diagram** on open, so the whole
  voltage level is visible without manual expansion (the operator can
  still shrink it; a manual resize sticks until the next diagram loads).
- **The maneuver panel stays collapsed** until the first switch or
  injection change is staged, then lists the staged switch toggles and
  injection retunes together.
- **Editable load / generator active power.** Clicking a load or
  generator opens a floating bubble showing its current setpoint and —
  for a generator — its **Pmin / Pmax** capability range and energy
  source. The operator types a new MW value (rounded to one decimal;
  generator values are clamped to the capability range) and it is staged
  alongside any switch toggles in the same maneuver panel. **Simulate
  action** runs the
  combined switch + injection edit as one manual action, exactly like a
  topology maneuver.

Implementation: every SLD endpoint now stamps an `injections` baseline
(mirror of `switch_states`) via `extract_vl_injections`; the user-built
`action_content` carries `gens_p` / `loads_p` straight through the
existing `set_gen_p` / `set_load_p` simulation path, with a generalised
`build_manual_action_description` naming the combined action. New
interaction-log events `sld_injection_staged` / `sld_injection_removed`.
See [`docs/features/sld-topology-edit.md`](docs/features/sld-topology-edit.md).

### Interactive voltage-level disks on the network diagram

The voltage-level disks of the NAD (Network, Contingency and Remedial
Action tabs) are now directly interactive:

- **Hover** surfaces the VL name as a lightweight floating tooltip while
  the on-diagram labels are hidden (the `🏷 VL` toggle), so the name is
  recoverable without turning the labels back on.
- **Single-click** selects the VL — it fills the Inspect field and
  auto-zooms / highlights it, exactly as typing the name in the Inspect
  box would.
- **Double-click** opens the VL's Single Line Diagram overlay.

Implemented as a single delegated listener set per diagram container
(`utils/svg/vlInteractions.ts`), deliberately engineered to leave
rendering and pan/zoom fluidity untouched: no per-node or per-frame
work, a static CSS pointer-cursor affordance, and full reliance on the
existing `.svg-interacting` hit-test cull so nothing runs mid-gesture.
A click is distinguished from a pan by pointer travel, and the single-
click action is deferred briefly so a double-click pre-empts it. This
supersedes the former native `<title>` tooltip (`utils/svg/vlTitles.ts`).

### Editable MW setpoint in Manual Selection and Explore Pairs tables

Injection-based remedial actions (redispatch, load shedding, curtailment)
now expose **editable MW columns** in two previously static table surfaces:

- **Manual Selection score table** (`ActionSearchDropdown`): redispatch rows
  render a "Δ MW" column with a signed-delta input (mirroring the ActionCard
  editor), clamped to `[-max_lower_mw, +max_raise_mw]`. Computed rows
  default to the simulated `delta_mw`; non-computed rows start empty. Edits
  sync through the shared `cardEditMw` state so the ActionCard and the
  score-table row stay in lock-step. Row clicks add (with typed delta as
  `target_mw`) or re-simulate (when the delta differs from the stored value).
- **Explore Pairs tab** (`ExplorePairsTab`): all injection rows (LS,
  curtailment, redispatch) now render an editable MW input. LS/curtailment
  inputs are bounded `[0, mwStart]`; redispatch inputs use signed-delta
  bounds. The per-row Simulate button forwards the edited value as
  `targetMw` to `api.simulateManualAction` via `CombinedActionsModal`.

No backend changes required — the existing `target_mw` parameter on
`POST /api/simulate-manual-action` already handles signed deltas for
redispatch and absolute targets for LS/curtailment.

### Internal / maintainability

- **Code-quality gate hardened** — mypy now gates at 0 (via a
  `TYPE_CHECKING` shared-state base for the recommender mixins), plus
  frontend + backend test-coverage floors and backend cyclomatic-
  complexity / nesting / return-annotation ratchets. See
  `docs/architecture/code-quality-analysis.md` §§17–21.
- **Planned — decompose the "ceiling-rider" hot files.** Several modules /
  components now ride their (tightened) size/complexity ceilings with thin
  margins: `simulation_mixin.py` (1110/1150), `VisualizationPanel.tsx`
  (1407/1450), `_run_analysis_step2_with_model` (226/240). Investigated and
  scoped per target in
  [`docs/proposals/decompose-ceiling-riders.md`](docs/proposals/decompose-ceiling-riders.md)
  so the splits land deliberately rather than under gate pressure.

## [0.8.0] — 2026-06-17

Feature-rich release that broadens the **remedial-action vocabulary**
(generation redispatch, GST estimation for injection actions, interactive
SLD topology editing), consolidates the **operator UI** (light / dark theme,
a shared Action-Filter ring strip, a readability-first collapsible sidebar,
a tiered notice pill, a per-stage execution-time breakdown, inspect-by-name),
and ships two **new ways to run the tool**: a timed, scored **Game Mode**
(`?game=1`, Codabench-ready) and a one-container **online deployment**
(HuggingFace Docker Space, same-origin SPA + backend). Paired with
[`expert_op4grid_recommender`](https://github.com/marota/Expert_op4grid_recommender)
**0.2.4** (the GST / superposition tests require it); from this release on, CI
always tracks the latest published recommender release rather than a pinned
version (see `.github/workflows/test.yml` / `.circleci/config.yml`).

### Generalized Superposition Theorem (GST) for combined-pair estimation

The combined-pair **estimation** (`POST /api/compute-superposition`, Explore
Pairs tab) now supports pairs that involve an **injection** action — load
shedding, renewable curtailment, redispatch — not just topology actions. This
plugs the recommender library's GST (`compute_combined_pair_gst`) into Co-Study.

- **Backend** (`services/`):
  - `simulation_helpers.is_injection_action(action_id, dict_action, classifier)`
    — new detector (id prefix + classifier type), kept in sync with the library.
  - `simulation_mixin.compute_superposition` — computes `act1_is_injection` /
    `act2_is_injection`, no longer bails out with "cannot identify elements" for
    an injection action (they carry no topology element), and forwards the flags
    to `compute_combined_pair_superposition` (GST path). The injection action is
    returned with `beta = 1.0`, so `compute_combined_rho` /
    `_augment_superposition_result` work unchanged.
- **Frontend**:
  - `CombinedActionsModal` — `hasRestricted` is now always `false`; LS /
    curtailment / redispatch are estimable.
  - `ExplorePairsTab` — removed the "load shedding / curtailment cannot be
    combined for estimation" caveat banners.
- **Tests**: new GST cases in `expert_backend/tests/test_superposition_service.py`
  (topology+injection, injection-first, injection+injection, `is_injection_action`).
- **Diagnostic**: `scripts/gst_estimation_vs_simulation_small_grid.py` — a
  library-level (no running backend) reproduction of the GST estimate-vs-
  simulation behaviour on the small grid, including a direct-DC exactness proof
  showing the AC est-vs-sim gap is AC-nonlinearity (0 MW error in DC), not a bug.
- **Docs**: `docs/features/combined-actions.md` documents the AC-anchoring of the
  GST estimate and how to read it (trust `target_max_rho`; the off-target global
  max can flip between near-equal low-flow lines; injection+injection is
  lower-confidence, with the measured `BEON` 5.6 % est vs 38.1 % sim example),
  and points to the library's "Known larger-error cases" catalog.

### Redispatching action type

End-to-end support for **redispatching** remedial actions (raise / lower a
dispatchable generator), mirroring the renewable-curtailment pipeline but
with an editable *signed* MW delta (default ±10 MW):

- **Backend**:
  - `services/analysis/mw_start_scoring.py` — new `redispatch` tag in
    `classify_action_type` + `mw_start_redispatch` helper, dispatched from
    `get_action_mw_start`.
  - `services/analysis/action_enrichment.py` — `compute_redispatch_details`
    (per-generator signed `delta_mw`, `target_mw`, `direction`), attached to
    `redispatch_`-prefixed actions in `analysis_mixin._enrich_actions` and in
    `simulation_mixin.simulate_manual_action`.
  - `services/simulation_helpers.py` — `compute_redispatch_setpoint`
    (`current ± signed delta`, floored at 0); `redispatch_details` added to
    `serialize_action_result`.
  - `services/simulation_mixin.py` — `_create_dynamic_redispatch` branch and
    redispatch-aware `_apply_target_mw_updates` (interprets `target_mw` as the
    signed delta for `redispatch_` actions).
  - `main.py` / `recommender_service.py` — `min_redispatch` +
    `redispatch_default_delta_mw` config plumbing.
- **Frontend**:
  - `types.ts` — `RedispatchDetail` interface, `redispatch_details` on
    `ActionDetail`, `'redispatch'` added to `ActionTypeFilterToken`.
  - `utils/actionTypes.ts` — `redispatch` filter token + label +
    `classifyActionType` branch (checked before the renewable bucket).
  - `components/ActionTypeIcon.tsx` — redispatch glyph (up/down arrows);
    `components/ActionFilterRings.tsx` — token in the action-type ring.
  - `components/ActionCard.tsx` — editable signed-delta MW input (allows
    negative values) + Re-simulate, cloned from the curtailment editor.
  - `components/ActionFeed.tsx` / `api.ts` — `redispatch_details` carried
    through the simulate / re-simulate result pipeline.

### Recommender action-type restriction

A new **Restrict to action types** control in the **Settings →
Recommender** tab scopes the recommender to a chosen subset of action
families. None selected = all families (the previous behaviour);
selecting one or more makes the recommender propose **only** those.
This addresses the long-standing confusion that setting `Min = 0` on a
family does **not** exclude it (Min is a floor, not a switch).

- **Frontend**: `allowedActionTypes` threaded through `useSettings`
  (state, hydrate, persist, `buildConfigRequest`), the `SettingsModal`
  Recommender tab, the `SettingsBackup` revert-on-cancel path, the
  session snapshot (`sessionUtils.buildSessionResult`) + restore
  (`useSession` / `restore-analysis-context`), and the config
  interaction-log replay payload — so the restriction stays
  fidelity-complete across Save / Reload and Settings-cancel.
- **Backend**: `POST /api/config` `allowed_action_types` →
  `config.ALLOWED_ACTION_TYPES` on the recommender service.

### Interactive SLD topology edit → manual action card

A new gesture lets the operator build a remedial action by clicking
switches on a Single Line Diagram, mirroring the `manoeuvre_ihm` tool
in `expert_op4grid_recommender`:

- **`✎ Manual action`** button in the SLD overlay header (visible on
  N-1 and post-action SLD tabs). Clicking it enters edit mode.
- **Target-topology preview** — each staged switch toggle triggers a
  debounced `POST /api/sld-topology-preview` call (new endpoint).
  Backend clones a throwaway variant, applies the overrides, and
  re-renders the SLD with `SldParameters(topological_coloring=True)`
  (no load flow). The frontend shows the preview in place of the
  baseline with stale-flow values greyed (`.sld-preview-stale`); the
  changed breaker keeps its dashed outline so the operator always
  sees WHERE the topology changed.
- **Interactive maneuver list** (`SldEditPanel`) — focus a single
  switch by clicking its row, remove one with `×`, remove a block
  via checkbox + `Remove selected (N)`, or `Reset` all.
- **Simulate action** — streams `/api/simulate-and-variant-diagram`
  (new optional `voltage_level_id` field auto-names switch-only
  actions: `"Manoeuvre manuelle sur <vl>: SW_A ouvert, SW_B fermé"`),
  the card lands in the Action Feed and the SLD overlay auto-focuses
  on its `ACTION` tab.
- **Combined-action support** — editing on a post-action SLD produces
  a combined card `<base>+user_topo_<vl>_<ts>`; the backend
  canonicalises combined ids (`"+"`-sorted) and `_require_action`
  aliases the raw ordering onto the canonical entry so the frontend
  fetch keys never desync.
- **Action-type filter** — `classifyActionTypes` (multi-bucket) is
  introduced so a single maneuver that opens a coupling AND a line
  (comma-joined description), or a combined card that opens one
  coupling AND closes another, passes BOTH the corresponding filters
  in the Action Feed / Action Overview / Combine modal / overflow
  pins.
- **Six new interaction events** declared in both `SPEC`
  (`specConformance.test.ts`) and `SPEC_DETAILS`
  (`check_standalone_parity.py`): `sld_edit_mode_toggled`,
  `sld_switch_toggled`, `sld_maneuver_removed`,
  `sld_maneuver_focused`, `sld_edit_reset`, `sld_topology_simulated`.

Full contract + test inventory in
[`docs/features/sld-topology-edit.md`](docs/features/sld-topology-edit.md).

### Sidebar readability refresh — collapsible feed, banner Clear, overload info bubble

- **Sidebar visibility gate** — the "Select Contingency" picker card
  and the "Remedial Actions" feed (renamed from "Simulated Actions")
  now flip together at the moment a contingency is committed. The
  picker folds away and the feed mounts, so the sidebar shows only
  the affordance relevant to the current stage of the workflow.
- **Sticky-banner Clear shortcut** — `SidebarSummary` grows a red
  `Clear` button next to the contingency label that routes through
  the existing "Change Contingency?" confirmation dialog when
  analysis state would otherwise be lost (clears directly otherwise),
  then makes the picker reappear. Emits a new
  `contingency_clear_requested { had_analysis_state }` interaction
  event.
- **Overload info bubble** — a `?` icon next to the Overloads label
  opens a hover popover listing N-state pre-existing overloads,
  hosting the per-N-1 monitoring checkboxes, the
  `monitor deselected` switch, and the monitoring-coverage hint.
  Together with the restored double-click-to-toggle gesture on the
  banner overload links themselves, the popover replaces the
  inline `OverloadPanel` card (the component file is kept on disk
  for unit-test backwards-compat but is no longer rendered).
- **Collapsible sidebar** — `AppSidebar` accepts a `collapsed` prop
  that shrinks the shell to a 32-px strip with an expand caret,
  giving the visualization panel the freed width. When collapsed,
  the `ActionFilterRings` strip rides along in the
  `VisualizationPanel` tab row on the left (testid
  `viz-panel-overview-filters`) so the overview filter remains
  reachable without re-expanding the sidebar. Emits a new
  `sidebar_collapsed_toggled { collapsed }` interaction event.
- **Test coverage** — new `AppSidebar.test.tsx`, extended
  `SidebarSummary.test.tsx` (Clear button, double-click toggle,
  info-bubble popover) and `VisualizationPanel.test.tsx` (inline
  filter strip gating). App-level integration tests in
  `App.contingency.test.tsx` rewired to the Clear-driven flow.

### Execution-time breakdown for the "Suggestions produced by …" line

- **Per-stage timing** for every two-step analysis run. The backend
  measures five stages — `step1_time` (contingency simulation +
  overload detection), `overflow_graph_time` (graph build phase),
  `action_prediction_time` (model `recommend()`),
  `assessment_time` (re-simulation of prioritized actions +
  combined-pair computation), `enrichment_time` (Co-Study4Grid
  post-processing) — and echoes them on the streaming NDJSON
  `result` event. The frontend additionally stamps a
  `wall_clock_time` from the "Analyze & Suggest" click until the
  result arrives. All six fields are persisted in saved sessions
  (`analysis.*`) and restored on reload so a re-opened study shows
  the same breakdown without re-running the analysis.
- **Compact ActionFeed reminder** — replaces the inline four-column
  row with a single "Suggestions produced by **\<model\>** in
  **\<X\>s** ⓘ" line where `X` is the wall-clock total. Hovering the
  underlined number opens a native tooltip listing every stage plus
  the `Other (network / streaming)` residual.
- **Overflow Analysis subtitle** — the iframe overlay
  (`services/overflow_overlay.py`) gains a
  `cs4g:overflow-meta` postMessage handler that injects a
  `Total execution time: <X>s` subtitle right below the sidebar
  `<h1>` filename.
- **Skip the duplicate contingency load flow** — the N-1 diagram
  fetch already runs the AC load flow on a contingency variant.
  `DiagramMixin._cache_obs_for_variant` now builds a
  `PypowsyblObservation` off the converged variant and stores it in
  `_cached_obs_n1` / `_cached_obs_n1_id` / `_cached_obs_n1_elements`.
  `AnalysisMixin.run_analysis_step1` validates the cache against the
  contingency variant ID + element list and forwards the obs to the
  upstream library through the new `prebuilt_obs_simu_defaut` kwarg
  so the LF runs **once** instead of twice (saves ~1-3 s per
  analysis on the French grid). Safety gate disables the reuse path
  when `DO_RECO_MAINTENANCE=True`. `inspect.signature` introspection
  keeps Co-Study4Grid working against pre-kwarg upstream releases.
- **Skip the maintenance-line scan when no reconnections are
  attempted** — upstream
  `expert_op4grid_recommender.utils.helpers_pypowsybl.get_maintenance_timestep_pypowsybl`
  now fast-exits with an empty action when `do_reco_maintenance=False`.
  Saves ~150-300 ms per run on large grids with many pre-disconnected
  lines (the function used to scan every disconnected line and
  `print` the full list, even though the result was informational
  only when the flag was off).
- See [docs/backend/recommender_models.md § Execution-time
  breakdown](docs/backend/recommender_models.md#execution-time-breakdown)
  and [docs/features/save-results.md § analysis](docs/features/save-results.md#analysis).

### Light / dark theme

A full **dark mode** for the whole interface, toggled from a sun / moon
button in the header and persisted across reloads:

- **Single source of truth**: every colour resolves from the
  `src/styles/tokens.{css,ts}` design-token palette, so theming is a
  token-swap rather than per-component overrides. A `useTheme` hook plus
  a tiny pre-mount script (run before React hydrates) avoids the
  first-paint flash; the "soft-background" trap and the full rationale
  are documented in [`docs/features/dark-mode.md`](docs/features/dark-mode.md).
- **Diagram + viewer theming**: a legibility pass across the NAD / SLD
  chrome (flow-value labels, VL-name toggle, inactive tab titles) and
  the interactive overflow viewer (edges, flow-label chips, the
  SELECTION box, the Hierarchical / Geo toggle) so the pypowsybl-rendered
  SVG and the injected overlay stay readable on a dark backdrop.
- **Tests**: `useTheme` hook, header toggle, and overflow-CSS dark-mode
  specs.

### Internal refactor — diagram-mixin decomposition

- **`services/diagram/action_patch.py`** (new): extracted the entire
  `/api/action-variant-diagram-patch` pipeline (~510 LoC) from
  `diagram_mixin.py` — the 280-line `get_action_variant_diagram_patch`
  orchestrator, the three patch helpers (`compute_vl_topology_diff`,
  `extract_vl_subtrees_with_edges`,
  `get_disconnected_branches_from_snapshot`), plus three private
  helpers (`_extract_convergence_status`, `_capture_action_snapshots`,
  `_unpatchable_response`) that keep the orchestrator under the
  function-LoC ceiling.
- **`services/diagram/obs_prewarm.py`** (new): extracted the
  post-contingency observation pre-warm helper
  (`build_prewarmed_obs`) — the seam that drives `_cached_obs_n1`
  so `run_analysis_step1` can skip the redundant LF.
- `diagram_mixin.py`: **1220 → 769 lines** (-451, 37% reduction).
  431-line buffer below the 1200 ceiling guarded by the code-quality
  gate. Test backwards-compat preserved: `_compute_vl_topology_diff`
  and `_get_disconnected_branches_from_snapshot` remain re-exported
  as static methods on `DiagramMixin` so the existing
  `test_diagram_patch_helpers.py` suite passes unchanged.
- New test files: `test_obs_prewarm_for_step1.py` (9 tests),
  `test_action_patch_module.py` (16 tests) cover the extracted
  surfaces.

### UI consolidation — sidebar Action Filter rings

- **Severity + action-type filters → shared `<ActionFilterRings>`
  strip** in the sidebar (replaces the inline category toggles +
  `All` / `None` bulk pills + action-type chip row that used to
  stack on the Action Overview header and inside each modal). The
  rings carry colour-coded severity pictograms (one per outcome
  bucket: solves overload / low margin / still overloaded /
  divergent or islanded) with single-click toggle + double-click
  solo, and uncoloured action-type pictograms (disco / reco /
  open / close / ls / rc / pst) with single-select toggle-off.
  Same rings host the **Max-loading threshold** spinner (compact
  3-digit-tight input, no leading glyph — ⚡ is now the Contingency
  pictogram). The Manual Selection modal, the Combine Actions
  modal, the Action Overview banner and the Overflow Analysis
  iframe all consume the same `ActionOverviewFilters` state so a
  card hidden in one place is hidden everywhere.
- **Bug fix — threshold filter wiring**. The Max-loading spinner
  was a silent no-op inside the Manual Selection score table and
  the Combine Actions Computed Pairs table because
  `rowPassesActionFilters` only checked the type ring and the
  severity bucket. Added the threshold predicate (simulated
  max-ρ → estimated fallback, matching the severity bucket's
  precedence) so the slider applies consistently across every
  surface that consumes the rings.
- **Notices relocation → discrete sidebar pill (`<NoticesPanel>`)**.
  The previous stack of up to five concurrent yellow banners
  overlaying the main window was replaced by a single dismissable
  pill in the sidebar header (`⚠ Notices N`) that opens an inline
  panel listing every active notice (action-dictionary info,
  monitoring coverage, recommender thresholds, additional lines
  to cut). The auto-dismiss-on-analysis-lifecycle rules
  (action-dict cleared on first simulated action, recommender-
  thresholds cleared on Step-2 pending) were dropped — operators
  now own the dismiss gesture via the × button on each card. The
  per-study re-arm (load-study / apply-settings) is preserved.
- **Pictogram refresh**. Lightning ⚡ now stands for **Contingency**
  across the sidebar (status line + "Select Contingency" picker
  card title); the pin 📍 + em-dash separator replaces the textual
  "Actions:" label in the rings strip (the wording lives in the
  hover tooltip on the pin). The Notices warning glyph changed
  from ⚠ → 🔔 to avoid clashing with the overload-pin ⚠ used on
  the Action Overview NAD; the low-margin severity uses a
  circle-exclamation pictogram (replaces the warning-triangle
  that clashed with overloads ⚠).
- **Overflow Analysis iframe pin toggle relocated**. The standalone
  `📍 Pins` toolbar button in `<VisualizationPanel>` was retired;
  the canonical pins on/off toggle now lives inside the iframe's
  **Action pins filters** header (always visible, dims the inputs
  when off). Wire format: new `cs4g:overflow-pins-toggled` envelope
  posts the new state up to the parent, which flips
  `overflowPinsEnabled` and re-broadcasts via `cs4g:pins`. The
  iframe's severity / action-type / Max-loading threshold widgets
  were removed — they live in the shared rings strip and travel to
  the iframe through the existing `cs4g:filters` envelope for
  pin-layer filtering only.
- **Modal layout — fixed-top anchoring**. The Manual Selection
  and Combine Actions modals anchor their card to a fixed
  viewport offset (`alignItems: flex-start; marginTop: 7.5vh;
  maxHeight: 85vh`) instead of centering on 50 %. Switching
  between Computed Pairs ↔ Explore Pairs or toggling a chip filter
  no longer makes the title + filter header hop up and down as
  the body grows / shrinks.
- **Manual Selection — wide layout stickiness**. The Manual
  Selection overlay used to collapse from the wide centered modal
  back to the button-anchored dropdown when a chip filter
  produced zero scored rows, which read as the modal closing
  mid-interaction. The wide layout now sticks for as long as the
  analysis has produced **any** scored action (a chip that filters
  the table to zero rows just surfaces the existing "no relevant
  action detected" warning + raw catalogue list).
- **Action classification fixes**. Extended the `classifyActionType`
  coupling regex from `/du poste\s+['"]/` to
  `/(?:du|dans le)\s+poste\s+['"]/` so TRO-coupler actions phrased
  `Ouverture OC '…' dans le poste '…'` are bucketed as
  open-coupling instead of disco. Added `aid.startsWith('reco_')`
  / `aid.startsWith('disco_')` short-circuits so the Action
  Overview pins always classify identically to the Action Feed
  cards (the previous mismatch caused reconnection / disconnection
  pins to disappear when the corresponding chip filter was
  active).

---

### Game Mode + Codabench benchmark

A timed, scored wrapper around the study workspace, **additive and inert
unless `?game=1`** is set on the frontend URL. A *session* is an ordered
list of *studies* (grid state + N-1 contingency); the player must remediate
each one with **at most 3 actions** before a per-study timer expires, then
advances. Results export a `game_session.json` that a
[Codabench](https://www.codabench.org/) competition scores and ranks.

- **`frontend/src/game/`** — `GameShell` (config → playing → results state
  machine, hosts the unchanged `<App/>` under a fixed HUD), `useGameSession`,
  `gameBridge` (a decoupling singleton mirroring `interactionLogger`: App
  registers a study loader + publishes the physical snapshot, the shell
  drives loads / reads results / enforces the action cap), `GameConfigScreen`,
  `GameHud`, `GameResults`, `scoring` (twin of the Python scorer:
  `60·R + 25·R·A + 15·R·T`), `gameLog`, `presets` (curated **solvable**
  fr225_400 contingencies), `types`.
- **App integration** — three touch points, all guarded by
  `gameBridge.isGameMode()`: `loadGameStudy`, a publish effect pushing
  `{ baselineMaxRho, chosenActions }`, and a cap on `wrappedActionFavorite`.
- **`scripts/game_mode/e2e_game_session.py`** — drives the real backend over
  the preset studies with a greedy operator and scores the session with the
  Codabench scorer (also verifies every preset stays winnable).
- Full contract in
  [`docs/features/game-mode-codabench.md`](docs/features/game-mode-codabench.md).

### Online deployment — HuggingFace Docker Space

A one-container image that serves the **frontend SPA same-origin** with the
FastAPI backend, so the tool runs as a hosted online game with nothing to
install:

- **`Dockerfile`** (+ `.dockerignore`) — multi-stage build: `npm run build`
  with `VITE_API_BASE_URL=""` (relative `/api/...`) and `VITE_GAME_MODE=1`
  (boots into the game shell), then a Python runtime serving API + built SPA +
  bundled sample grids on port 7860.
- **`main.py`** — optional `StaticFiles` mount of the built SPA
  (`COSTUDY4GRID_FRONTEND_DIST`), mounted **last** so every `/api/*` and
  `/results/*` route keeps priority over the catch-all; inert when the dist
  isn't present (local dev unaffected).
- **`api.ts`** — `VITE_API_BASE_URL` now selects same-origin (built) vs the
  standalone `http://127.0.0.1:8000` backend (dev / Vitest).
- **Overflow viewer served same-origin** (`overflow_overlay.py`, `main.py`)
  and `pinGlyph.js` shipped to the image so the iframe overlay never 500s
  when it's missing.
- Space README + step-by-step setup under
  [`deploy/huggingface/`](deploy/huggingface/). One running Space serves one
  player at a time (module-level singletons); duplicate the Space for more.

### Inspect elements by their displayed name

The bottom-of-tab **Inspect** field (and the Remedial-action overview search)
now match the **human-readable name drawn on the diagram** (e.g.
`LESQUIVE 400kV`), not just the raw element id. `utils/inspectables.ts`
(`filterInspectables`) is shared by every inspect surface (N / N-1 / action
tabs + overview) so they stay in lock-step, and the overview and tab inspect
fields were unified onto one component.

### Binary assets via Git LFS + transparent network decompression

- **Git LFS** (`.gitattributes`) tracks `*.zip` / `*.png` / `*.jpg` /
  `*.jpeg` so the repo can be pushed to a HuggingFace Space (whose git
  endpoint rejects non-LFS binaries). The 166 k-line PyPSA-EUR France
  `network.xiidm` is now shipped **compressed** as `network.xiidm.zip`.
- **`network_service`** transparently resolves and decompresses a zipped
  network on load (`_resolve_network_file` / `_extract_network_zip`): an
  explicit `*.zip` path, a missing `foo.xiidm` whose sibling `foo.xiidm.zip`
  exists, or a directory holding only a `.zip` all Just Work — the extracted
  `.xiidm` is cached next to the archive (temp-dir fallback when read-only).

### Shipped config defaults

`config.default.json` is now bundled and seeds first-run settings: the
fr225_400 France grid + action catalogue, per-action-type recommender minima
(incl. `min_redispatch`), `n_prioritized_actions`, monitoring factor, and the
pre-existing-overload threshold — so a fresh checkout (and the deployed Space)
opens on a working study.

### Polish & fixes

- **ActionCard header reshuffle** — the severity icon moves to the left
  of the title and the star / reject controls move to the card header's
  top-right, so a dense feed reads top-down at a glance.
- **Overflow info bubble** is no longer clipped behind the visualization
  panel (sidebar overflow-popover stacking fix).
- **Step-2 perf** — the action-assessment loop caches the equipment
  tables it re-reads per action and skips the curtailment recompute for
  `redispatch_` actions, trimming the per-action cost on large grids.

## [0.7.5] — 2026-05-12

Feature + polish release headlined by the **pluggable recommendation
models** integration (paired with `expert_op4grid_recommender`
0.2.2), plus a couple of operator-reported regressions and the
new **"Combined only"** pin filter that landed on the way.

### Highlights

- **Pluggable recommendation models** (PR #145 — paired with
  `expert_op4grid_recommender` PR #90 / 0.2.2). The analysis
  pipeline no longer hardcodes the expert system: it dispatches to
  any class implementing the `RecommenderModel` ABC. Three models
  ship out of the box — `expert` (default, identical to the legacy
  behaviour), `random` (sanity-check baseline that does NOT require
  the overflow analysis graph), `random_overflow` (samples within
  the expert-reduced action space). Selecting a model is a
  one-dropdown gesture in **Settings → Recommender**; the
  parameter inputs render dynamically from each model's
  `params_spec()`, and the **Compute Overflow Graph (step 1)**
  toggle is locked-on for models that require it and editable for
  the others. See [Plug Your Own Recommendation Model](README.md#plug-your-own-recommendation-model)
  for the third-party plug-in guide.
- **"Combined only" pin filter** on the Action Overview tab and the
  Overflow Analysis iframe. Pin-scoped filter that renders combined
  pairs plus their two constituents (dimmed for context) and drops
  every other unitary / un-simulated pin; the Action Feed cards
  remain unfiltered. Round-tripped through the existing
  `cs4g:filters` postMessage envelope so both surfaces stay in
  lock-step. See `docs/features/action-overview-diagram.md`
  §Filtering and `docs/features/interactive-overflow-analysis.md`
  §7.
- **Config-modal stale-write fix**. Switching the config-file path
  + clicking Apply now sends the freshly loaded config to
  `/api/config` (was sending the previous render's closure values,
  which the auto-save effect then persisted back into the new file,
  silently undoing the operator's selection).
- **PyPSA-EUR grid layouts** now use raw Mercator metres by default;
  the previous 8 000-unit rescaling forced pypowsybl VL circles to
  overlap in dense regions like Paris.

### Added

- **Recommender model registry** (`expert_backend/recommenders/`):
  - `registry.py` — `register` decorator + `build_recommender` /
    `list_models` / `get_model_class` API.
  - `random_basic.py` — `RandomRecommender` (canonical example,
    `requires_overflow_graph=False`); augments the action dictionary
    with on-the-fly synthetic reconnection / load-shedding /
    curtailment actions.
  - `random_overflow.py` — `RandomOverflowRecommender` (canonical
    example, `requires_overflow_graph=True`); samples uniformly
    inside the three-layer reduced pool.
  - `synthetic_actions.py` — shared helper used by both random
    recommenders to surface the same `reco_*` / `load_shedding_*`
    / `curtail_*` / `pst_*` synthetic actions the operator can
    type into the manual selection box.
  - `overflow_path_filter.py` — Layer 2 of the sampling filter
    chain (`restrict_to_overflow_paths`): narrows the candidate
    set to actions touching the dispatch / constrained / loop /
    hub paths. Conservative on failure (returns input unchanged).
    Includes `_resolve_node_to_name` polymorphic helper to handle
    `int`, `numpy.integer`, `str`, `numpy.str_`, `bytes`, and
    `None` distribution-graph node IDs across legacy and current
    builds.
  - `network_existence.py` — Layer 3 (`filter_to_existing_network_elements`):
    drops actions whose `VoltageLevelId` /
    `set_bus.lines_*_id` references an element that doesn't exist
    on the loaded pypowsybl Network. Fixes the "AUBE P4 case" where
    actions for the larger grid leaked through for a smaller grid.
  - `_service_integration.py` — side-effect module that attaches
    `ModelSelectionMixin` to `RecommenderService`, wraps
    `update_config` / `reset` to remember the operator's selection,
    and replaces `run_analysis_step2` with a model-aware generator
    that computes `needs_graph = requires_overflow_graph OR get_compute_overflow_graph()`.
- **`GET /api/models` endpoint** — returns the full list of
  registered recommenders with their `params_spec()`, label and
  capability flags. Frontend `api.getModels()` powers the
  **Settings → Recommender** dropdown.
- **`ConfigRequest` fields** — `model` (string id of the selected
  recommender) and `compute_overflow_graph` (boolean, operator-
  level toggle for step 1). The final `result` event of the
  step-2 NDJSON stream echoes both as `active_model` and
  `compute_overflow_graph` so the UI / replay logger see the
  recommender that actually ran (may differ from the requested
  `model` if the backend fell back to `expert` on an unknown id).
- **Saved session model echo** — `session.analysis.active_model`
  (backend ground truth, echoed in the step-2 result event) and
  `session.configuration.model` (operator intent at save time);
  same split for `compute_overflow_graph`. Legacy-default fallbacks
  (`"expert"` / `true`) on reload of older session dumps.
- **Frontend**: `ModelDescriptor` / `ModelParamSpec` types in
  `api.ts`, `recommenderModel` / `computeOverflowGraph` /
  `availableModels` state in `useSettings` (fetched once via
  `api.getModels()`), dynamic dropdown + locked-vs-optional toggle
  states in `SettingsModal`, action-card VL chip now reads
  `action_topology.voltage_level_id` for non-disconnection
  actions (so OPEN / CLOSE coupling cards land their double-click
  zoom on the correct voltage level).
- **"Combined only" pin filter** (Action Overview + Overflow
  Analysis iframe).
- **`docs/backend/`** subfolder — new `README.md` covering
  the backend at large (mixin architecture, data flow,
  conventions, endpoints, tests) and `recommender_models.md`
  (relocated from `docs/recommender_models.md`) covering the
  app-side integration + filter chain + step-by-step guide.
- **Plug Your Own Recommendation Model** section in the root
  `README.md` — built-in model table, three-layer filter chain
  walkthrough, three-step plug-in guide, cross-links to the
  library-side contract.
- **Backend tests**:
  `tests/test_recommenders_registry.py`,
  `tests/test_random_recommenders.py`,
  `tests/test_model_selection_mixin.py`,
  `tests/test_service_integration.py`,
  `tests/test_models_api.py`,
  `tests/test_network_existence.py`,
  `tests/test_overflow_path_filter.py`,
  `tests/test_action_enrichment.py`.

### Changed

- **`extract_action_topology` robustness**
  (`expert_backend/services/analysis/action_enrichment.py`):
  backfills empty `lines_or_bus` / `lines_ex_bus` / `gens_bus` /
  `loads_bus` from `dict_action[id].content.set_bus`, surfaces
  the action's `voltage_level_id` from upstream `VoltageLevelId`,
  and tolerates numpy arrays via a new `_is_meaningful_dict`
  truthy-check. Fixes the "pins all stack on `max_rho_line`"
  rendering observed when running the Random model on the small
  grid.
- **`build_recommender_inputs` propagation**: the expert-rule
  filter result (`context["filtered_candidate_actions"]`) is now
  forwarded to the DTO so sampling models actually see the
  filtered pool. Caught a silent bypass where
  `RandomOverflowRecommender` ran against the full action
  dictionary while the filter was running upstream.
- **`overview_filter_changed` interaction-log event** now carries
  a `combined_only` discriminator (pin-scoped Combined-only
  checkbox toggle).
- **README architecture tree** now shows the
  `docs/backend/ (README.md, recommender_models.md)` subfolder.

### Fixed

- **Settings modal stale-write on config-file switch** (config
  modal Apply / `handleLoadConfig` flow): `changeConfigFilePath`
  now returns the resolved `UserConfig`, and a new
  `configRequestFromUserConfig` helper derives the request shape
  directly from it. Both call sites in `App.tsx` use the fresh
  value when a config switch just happened. Regression test in
  `frontend/src/App.configUpload.test.tsx`.
- **PyPSA-EUR grid-layout rescaling**
  (`scripts/pypsa_eur/regenerate_grid_layout.py`). Default
  behaviour is now raw Mercator metres (span ≈ 1.4 M for the
  French grid); pass `--target-width N` to reproduce the legacy
  rescaled output with a warning below 500 000.
  `data/pypsa_eur_fr225_400/grid_layout.json` and
  `data/pypsa_eur_fr400/grid_layout.json` regenerated. Old files
  saved as `.bak.8000width` siblings.
- **Action overview pin localisation** for non-disconnection
  actions (Random / Random Overflow runs): pins are now anchored
  on the action's voltage level rather than the contingency
  `max_rho_line`.
- **`numpy.str_` comparison crash** in `_resolve_node_to_name`
  on legacy distribution graphs.

### Documentation

- **`docs/features/save-results.md`** — UPDATED: `model`,
  `active_model`, `compute_overflow_graph` fields in the JSON
  example, full field reference tables, new "Recommender model
  persistence" section covering the
  `session.configuration.{model,compute_overflow_graph}` /
  `session.analysis.{active_model,compute_overflow_graph}`
  split, Implementation Details + Testing updates.
- **`docs/features/interaction-logging.md`** — UPDATED:
  `model` and `compute_overflow_graph` added to `config_loaded` /
  `settings_applied` event details; `active_model` +
  `compute_overflow_graph` added to `analysis_step2_completed`;
  example `interaction_log.json` reflects the new fields; new
  "Pluggable recommender model" section cross-referencing
  `docs/backend/recommender_models.md`.
- **`docs/backend/README.md`** — NEW: backend overview covering
  architecture, mixins, data flow, conventions, endpoints, tests.
- **`docs/backend/recommender_models.md`** — NEW (relocated from
  `docs/recommender_models.md`): app-side integration + filter
  chain + step-by-step guide for plugging a third-party model.
- **`README.md`** — NEW "Plug Your Own Recommendation Model"
  section; corrected stale `docs/recommender_models.md` link to
  the new `docs/backend/` subfolder.

### Compatibility

- **`model` and `compute_overflow_graph` fields default to
  `"expert"` and `true`** at every entry point that lacks them
  (older session dumps, missing form values, third-party callers
  that didn't update their request shape) — byte-for-byte the
  same behaviour as 0.7.0.
- **Frontend dynamic UI from `params_spec()`** — adding a model
  requires zero UI code; the dropdown and the parameter inputs
  refresh automatically.
- **Step-2 NDJSON contract unchanged** — `active_model` and
  `compute_overflow_graph` are additive fields on the existing
  `result` event.
- **Requires `expert_op4grid_recommender>=0.2.2`** (for the
  `RecommenderModel` ABC, the `RecommenderInputs` /
  `RecommenderOutput` DTOs, the reusable reassessment phase and
  the idempotent `_run_expert_action_filter` helper). Older
  versions raise an `ImportError` from
  `expert_op4grid_recommender.models.base` on backend startup.

---

## [0.7.0] — 2026-05-05

Major feature release headlined by the **interactive overflow
analysis tab**, the **PyPSA-EUR European-wide grid pipeline**, and a
full **design-token migration** of the frontend. Sixteen merged PRs
since 0.6.5 plus the inline polish landed on the
``claude/interactive-overflow-analysis`` branch.

### Highlights

- **Interactive overflow analysis tab** (PRs #116, #122–#127). The
  static overflow PDF is replaced by a same-origin HTML viewer
  produced by upstream ``alphaDeesp/core/interactive_html.py``. The
  viewer carries:
  - Layer-toggle sidebar grouped into three sections — *Structural
    Paths* (Constrained path, Red-loop), *Individual entities
    properties* (Overloads, Low-margin lines, Hubs, Reconnectable,
    Non-reconnectable, Swapped flow, **Production nodes**,
    **Consumption nodes**) and *Flow redispatch values* (Positive /
    Negative / Null).
  - Hierarchical ↔ geographic layout toggle backed by a per-study
    cache.
  - Pin overlay synced with the Action Overview filters; single-click
    pins open the same `ActionCardPopover`, double-click drills into
    the SLD overlay.
  - Double-click on a graph node opens the substation SLD overlay
    via the existing `cs4g:overflow-node-double-clicked`
    postMessage.
  - Auto-installer for the graphviz `dot` binary on package install
    (PR #126), so a fresh checkout works without a manual
    ``apt install``.
- **PyPSA-EUR European-wide grid** (PRs #112, #117). Full pipeline
  in ``scripts/pypsa_eur/`` for generating XIIDM grids from PyPSA-EUR
  data, with calibrated thermal limits, an fr225_400 dataset, and
  pytest coverage (``test_build_pipeline.py``,
  ``test_calibrate_thermal_limits.py``,
  ``test_generate_n1_overloads.py``,
  ``test_regenerate_grid_layout.py``).
- **Design-token migration** (PR #120, three phases). New
  ``frontend/src/styles/tokens.{css,ts}`` is the single source of
  truth for colour, spacing, typography and radius. Code-quality
  gate now enforces ``FRONTEND_HEX_LITERAL_MAX = 0`` outside the
  token files.
- **Tiered warning system + diagram legend** (PR #122). Structured
  notice tiers (info / warning / critical) and an in-place legend on
  the Visualization panel; satisfies UI-critique recommendations
  #4–5.
- **Progressive-disclosure ActionCard** (PR #121). Severity icons
  drive a glanceable summary; details collapse / expand on demand.
- **Voltage-level names toggle** (PR #118). New ``🏷 VL`` chip flips
  visibility of pypowsybl's VL labels with `!important` CSS rules,
  with a native `<title>` tooltip fallback so the names stay
  reachable.

### Added

- **Interactive HTML overflow viewer** (PR #116):
  ``services/overflow_overlay.py`` injects the Co-Study4Grid pin /
  popover overlay into the upstream HTML; the React panel hosts the
  iframe via ``hooks/useOverflowIframe.ts`` (extracted from
  ``VisualizationPanel.tsx`` in this release).
- **Production / Consumption node filters** (this branch +
  ExpertOp4Grid 0.3.2.post1). Two new layers ``node:prod`` /
  ``node:load`` driven by the upstream ``prod_or_load`` + ``value``
  attributes ``build_nodes`` writes on every node, with a 1 MW
  absolute-value floor so passive substations (which carry
  ``prod_or_load="load"`` + ``value="0.0"`` by convention) don't
  flood the Consumption layer. Coral / lightblue circle swatches
  match the upstream node fillcolors.
- **Layer interaction logs** (PR #125). Six new event types
  surfaced by the overflow tab — ``overflow_layer_toggled``,
  ``overflow_select_all_layers``, ``overflow_node_double_clicked``,
  ``overflow_pin_clicked``, ``overflow_pin_double_clicked``,
  ``overflow_pins_toggled``, ``overflow_layout_mode_toggled`` — all
  emitted in the canonical replay log.
- **Voltage-level names toggle** (PR #118): per-tab `showVoltageLevelNames`
  state with a native `<title>` tooltip injected by
  ``utils/svg/vlTitles.ts`` so the operator can still read the VL name
  by hovering when labels are off.
- **Tiered notice system + diagram legend** (PR #122): the sidebar
  Notices pill ranks issues by severity; the new ``DiagramLegend``
  component sits inside the visualization panel and is reused by the
  overflow tab.
- **Progressive-disclosure ActionCard** (PR #121): redesigned card
  with severity icon, glanceable summary, on-demand expand for
  topology / load-shed / curtailment details.
- **PyPSA-EUR pipeline** (PR #117): one-command pipeline driving
  ``build_pypsa_eur`` → ``calibrate_thermal_limits`` →
  ``generate_n1_overloads`` → ``regenerate_grid_layout`` for any
  European country / voltage subset.
- **Reconnect actions on the fly** (PR #110): backend auto-creates
  ``reco_*`` actions for every disconnectable line so the operator
  can compose mixed disconnect + reconnect studies without editing
  the action JSON.

### Changed

- **Frontend design tokens** (PRs #120 phases A/B/C). Components,
  modals, hooks and SVG presentation attributes now consume the
  centralised palette. Token files are exempt from the hex-literal
  ceiling; everything else is gated.
- **VisualizationPanel decomposition** (this branch). 1654 → 1342
  lines after extracting ``InspectSearchField``,
  ``DetachedPlaceholder``, and the new ``useOverflowIframe`` hook —
  satisfies the ``FRONTEND_COMPONENT_MAX = 1500`` ceiling.
- **NoticesPanel popover** (PR #123): renders via React portal and
  wraps long unbreakable strings, fixing the sidebar overflow clip.
- **ExpertOp4Grid pin** bumped to ``0.3.2.post1`` (carries the
  Production / Consumption node layers).

### Fixed

- **Halo stacking on the Remedial Action tab** (PR #111). Flow
  delta freshness + halo z-order regressions surfaced after the
  PR #109 hook extraction.
- **f-string cleanup** (PR #113). Removed unnecessary f-string
  prefixes from static strings caught by ruff F541.
- **Target max rho on user-selected overloads** (PR #114). Estimation
  pair filter now matches the simulation contract.
- **Build extras** (PR #127). Restored ``[quality]`` extra under
  ``optional-dependencies`` after the migration to PEP 621.

### CI / tests

- **Parity layers build the standalone first** (this branch). All
  four parity layers (1 + 2 + 3a + 4) now run ``npm run
  build:standalone`` before the audit so they target the freshly
  generated bundle instead of the frozen
  ``standalone_interface_legacy.html``.
- **Gesture-sequence parser recognises ``reactExports.useCallback``**
  (this branch). The vite/rollup-bundled wrapper form is now matched
  the same as the bare ``useCallback`` source form, lifting gesture
  parity to 30/30.
- **Backend tests split** (this branch). The backend job is now two
  lanes: a fast lane (~720 tests, ~15 s, no graphviz) and a
  ``test-backend-graphviz`` lane gated behind both fast jobs.
  ``awalsh128/cache-apt-pkgs-action`` caches the graphviz install,
  saving ~8 minutes of ``apt-get update`` on every run.
- **Test fixture path generalisation** (this branch). The
  ``test_overflow_html_dim_logic.py`` fixture now derives its
  reference HTML path from ``Path(__file__).resolve().parents[2]``
  so the test runs on any checkout, with a ``pytest.skip`` guard
  for fresh checkouts where the graph hasn't been generated yet.

### Documentation

- **docs/features/interactive-overflow-analysis.md**: full
  architecture, attribute-tagging contract, layer-toggle UI, and
  the Production / Consumption filter machinery.
- **docs/features/interaction-logging.md** (PR #125): six new
  overflow-tab event types with replay-contract details.
- **Development-cycle retrospective** (PR #119, three commits):
  consolidated ExpertAssist-era retrospective covering PRs #1–#65,
  reconciliation of 0.5.0 features, and six mermaid diagrams of
  the four-phase development cycle.
- **CLAUDE.md / READMEs refresh** (PR #115).

---

## [0.6.5] — 2026-04-22

Follow-up release to **0.6.0** consolidating the SVG-DOM-recycling
perf work on the N-1 / Action tabs, the Action Overview filtering &
unsimulated-pin layer, the continuous code-quality gate with five
decomposition passes, and the second round of App.tsx hook
extractions (N-1 fetch + highlight pipeline).

### Highlights

- **SVG DOM recycling** (`/api/n1-diagram-patch`,
  `/api/action-variant-diagram-patch`): ~80 % faster N-1 / action
  tab switches on large grids by cloning the already-mounted
  N-state `SVGSVGElement` and patching only the per-branch delta
  instead of re-fetching & re-parsing the full 12–28 MB NAD SVG.
  See `docs/performance/history/svg-dom-recycling.md`.
- **Action Overview filters & unsimulated pins**: severity
  category toggles (green / orange / red / grey), threshold
  slider, action-type chip filter, and a new dimmed/dashed pin
  layer for scored-but-not-yet-simulated actions — double-click
  to simulate. Filter state is shared between the overview and
  the sidebar feed so both views stay in lock-step.
- **Code-quality gate + decomposition sweep**: new continuous
  reporter (`scripts/code_quality_report.py`) and CI gate
  (`scripts/check_code_quality.py`) driving five behaviour-preserving
  decomposition passes — `simulate_manual_action` (599 → 146 LoC),
  `compute_superposition` (285 → 108), `svgUtils.ts` (1807 → 60 +
  8 focused modules), `analysis_mixin.py` (1116 → 509 + 4 modules),
  `diagram_mixin.py` (974 → 469 + 7 modules).

### Added

- **Patch endpoints for diagram recycling** (PR #108):
  `/api/n1-diagram-patch` and `/api/action-variant-diagram-patch`
  return SVG-less per-branch deltas (+ VL-subtree splices for
  topology-changing actions). Frontend `utils/svgPatch.ts` clones
  the N SVG in-place, patches dashed contingency lines, absolute
  flow labels, and concentric rings for coupling / node-merging /
  node-splitting actions. Graceful fallback to the full NAD for
  every unsupported edge case.
- **Action Overview filters** (PR #105, #107): new
  `ActionOverviewFilters` type with category toggles, threshold
  cap, unsimulated visibility flag and action-type chip. New
  `actionPassesOverviewFilter()` predicate + `classifyActionType()` /
  `matchesActionTypeFilter()` module so the overview, the feed and
  the Explore Pairs table share identical filtering logic.
- **Unsimulated action pins** (PR #105): dimmed/dashed pin layer on
  the Action Overview diagram for scored-but-not-yet-simulated
  actions, with hover tooltips showing score + ranking and
  double-click to trigger `simulate_manual_action`.
- **Shared `ActionTypeFilterChips` component** (PR #109): single
  reusable chip row driving the Manual Selection dropdown, the
  Explore Pairs tab, the Action Overview and the Action Feed.
- **Protected constituent pins**: when a combined action passes the
  filter, its constituent unitary pins remain visible (dimmed)
  even if they individually fail the filter — preserving context.
- **Dynamic `reco_` reconnection actions**: `simulate_manual_action`
  now auto-builds reconnection topology (both ends to bus 1) for
  `reco_*` action IDs that aren't in the loaded action dictionary,
  matching the existing `curtail_ / load_shedding_ / pst_` dynamic
  creation path.
- **Continuous code-quality tooling** (PR #104):
  `scripts/code_quality_report.py` (AST scan → JSON + Markdown
  metrics), `scripts/check_code_quality.py` (CI gate on LoC
  ceilings, 0 `print()` / `@ts-ignore` / `any`),
  `.github/workflows/code-quality.yml` + CircleCI job publishing
  the Markdown report to `$GITHUB_STEP_SUMMARY`.
- **Layer-4 invariants** now point at the extracted svgUtils
  modules (`pin_severity_uses_monitoringFactor`,
  `combined_pairs_filter_estimated`,
  `pin_resolver_is_topology_first`).
- **`CONTRIBUTING.md`**, **`.editorconfig`**, **`.env.example`**,
  **`pyproject.toml [tool.ruff]`** (narrow E9 / F ruleset) and
  `quality` extras group.
- **66 + 61 + 68 + 39 new unit tests** across
  `test_simulation_helpers.py`, `utils/svg/*.test.ts`,
  `test_analysis_helpers.py`, `test_diagram_helpers.py`;
  22 + 12 specs for the new svgPatch helpers and 8 new endpoint
  tests for the patch routes.

### Changed

- **App.tsx hook extraction, Phase 2** (PR #109): new
  `hooks/useN1Fetch.ts` (svgPatch fast-path + `/api/n1-diagram`
  fallback + contingency-change confirm routing) and
  `hooks/useDiagramHighlights.ts` (per-tab Flow/Impacts view-mode
  state + `applyHighlightsForTab` DOM-mutation pass). Sidebar
  extracted into `components/AppSidebar.tsx`,
  `components/SidebarSummary.tsx`, `components/StatusToasts.tsx`.
  `App.tsx`: 1575 → ~1150 lines.
- **Backend decomposition** (PR #104, #106):
  - `expert_backend/services/simulation_helpers.py` — 14
    stateless helpers extracted from `simulate_manual_action` +
    `compute_superposition`.
  - `expert_backend/services/analysis/` — `action_enrichment.py`,
    `mw_start_scoring.py`, `analysis_runner.py`, `pdf_watcher.py`.
  - `expert_backend/services/diagram/` — `layout_cache.py`,
    `nad_params.py`, `nad_render.py`, `sld_render.py`,
    `overloads.py`, `flows.py`, `deltas.py`.
  - Public API / method signatures unchanged; `@patch`
    compatibility preserved via dependency injection.
- **Frontend decomposition** (PR #104): `svgUtils.ts` 1807-line
  omnibus split into 8 focused modules under `frontend/src/utils/svg/`
  (`idMap.ts`, `metadataIndex.ts`, `svgBoost.ts`, `fitRect.ts`,
  `deltaVisuals.ts`, `actionPinData.ts`, `highlights.ts`,
  `actionPinRender.ts`) + a 60-line barrel that re-exports
  everything so no caller changed. `App.tsx` (1370 LoC) remains
  the largest non-exempt file by design.
- **Docs reorganised** (PR #103) into
  `docs/{features,performance/{,history/},architecture,proposals,data}/`
  with per-folder README indexes. Three overlapping rendering-LoD
  proposals consolidated into
  `docs/proposals/rendering-lod-strategies.md`. Obsolete
  `test_ui_regressions.py` references cleaned up across the
  backend tests, benchmarks and scripts.
- **CORS origins** now configurable via `CORS_ALLOWED_ORIGINS` env
  var (PR #104); unused `GZipMiddleware` import removed; legacy
  `print()` / `traceback.print_exc()` calls in `main.py` replaced
  with structured logging (`logger.warning` / `logger.exception`);
  one bare `except: pass` now logs the suppressed exception.
- **Frontend deps**: unused `framer-motion` and `lucide-react`
  removed from `package.json`.
- **Action-type filter unification** across Manual Selection,
  Explore Pairs, Action Feed and Action Overview (PR #109 +
  follow-up commits `025f4a0` / `e107057` / `1e53db3`): each
  surface owns its own local chip state, but all consume the
  shared `DEFAULT_ACTION_OVERVIEW_FILTERS` constant and the
  shared `classifyActionType` / `matchesActionTypeFilter`
  helpers.

### Performance

- **Patch-based N-1 diagram switching** (PR #108, benched on
  `bare_env_20240828T0100Z`, ~10 k branches, ~12 MB SVG,
  contingency `ARGIAL71CANTE`, warm median of 3):

  | Endpoint | Cold | Warm | Payload |
  |---|---|---|---|
  | `/api/n1-diagram` (full)      | 3.01 s | 2.39 s | 27.1 MB |
  | `/api/n1-diagram-patch` (new) | 0.49 s | 0.50 s |  5.5 MB |
  | **Δ** | **−83.8 %** | **−79.1 %** | 20.3 % of full |

- **Action tab switching** mirrored on
  `/api/action-variant-diagram-patch` with the same recycled-DOM
  pattern, dashed-class toggling for `disco_*` / `reco_*`, and
  VL-subtree splicing for coupling / node-merging / node-splitting.
- **Quick wins from the decomposition sweep**:
  `network_service.py::get_load_voltage_levels_bulk` was returning
  `{}` without populating the dict (now mirrors
  `get_generator_types_bulk`); 9 f-string placeholders
  auto-fixed via `ruff --fix`.

### Fixed

- **Dynamic reconnection action simulation**: reconnection actions
  generated by `expert_op4grid_recommender` but not in the loaded
  action dictionary (e.g. `reco_CAZARL72MARSI` from the Explore
  Pairs tab) no longer raise `ValueError: Action … not found in
  the loaded action dictionary or recent analysis`. The fix mirrors
  the dynamic-creation path already in place for load-shedding,
  curtailment and PST actions.
- **Line halo on combined `disco + coupling` actions** (PR #108,
  commit `b84732a`): split-on-`+` + per-part coupling check so the
  disco line in `disco_X+coupling_Y` gets its pink halo on both the
  diagram and the action card badge.
- **Blank flash + stale-response guard on svgPatch** (PR #108,
  commit `c48a0da`): the previous cloned DOM stays mounted during
  the patch-fetch window, and late patch responses arriving after
  a newer click are discarded.
- **Node-merging classifier** — "Ouverture … dans le poste" is now
  correctly classified as DISCO, not OPEN coupling (PR #105,
  commit `f356c2e`).
- **Popover viewport detection & combined-action pin protection**
  (PR #105, commit `d277597`): improved popover placement when
  near viewport edges; combined-action pins now protect their
  constituent pins from being hidden by the severity / threshold
  filters.
- **Standalone parity**: versioned snapshot bumped to v0.7 with
  patch-endpoint references (PR #107, commit `adae7ac`);
  `scripts/check_standalone_parity.py` now resolves the standalone
  path intelligently with fallback to versioned snapshots.
- **`ActionFeed` unused-prop lint error**: `onOverviewFiltersChange`
  is no longer destructured when it isn't consumed, removing the
  `@typescript-eslint/no-unused-vars` error.
- **Hidden ordering bug in `get_action_variant_sld`** (PR #104):
  `changed_switches` now captured before flow extraction so mock
  networks with missing flows still return the switch diff; switch
  diff + delta math split into independent `try/except` blocks.
- **Halo layering on N-1 / Remedial Action NADs** (commit `f7a3834`):
  contingency clone is now appended FIRST (bottom), overload halos
  SECOND, action-target halo LAST (top) on the shared
  `#nad-background-layer`. Reverses the post-`action-variant-diagram-patch`
  regression where the yellow contingency halo painted over the
  pink action halo. Code-level guard in
  `frontend/src/utils/svgUtils.test.ts::Halo layering order` +
  hook-level guard in `frontend/src/hooks/useDiagramHighlights.test.ts`.
- **Action Overview filter banner compaction** (commit `f7a3834`):
  filters laid out on a single horizontal row
  (`flex-wrap: nowrap`); the max-loading slider is replaced with a
  compact integer-percent number input (0–300 %, step 1) so the
  whole banner fits on one line.
- **No-relevant-action warning in Manual Selection** (commit `f7a3834`):
  when "Analyze & Suggest" produced action scores but the chosen
  type filter yields zero scored actions, the dropdown now surfaces
  a yellow `Warning: no relevant action detected with regards to
  overflow analysis` banner above the fallback full-action list
  instead of silently misleading the operator.
- **"Make a first guess" gating after analysis** (commit `f7a3834`):
  the pre-analysis shortcut is hidden once "Analyze & Suggest" is
  running, has produced action scores, or any action sits in the
  feed. The button only re-appears after a state reset
  (contingency change, study reload).
- **SLD Impacts persistence on pan / zoom** (commit `f7a3834`,
  follow-up `ec17587`): the SLD delta painter is now a
  `useLayoutEffect` running every render, self-gated via signature
  + DOM-presence probe. Catches the
  `dangerouslySetInnerHTML`-reconciliation wipe that used to strand
  the overlay on Flows rendering until a tab switch, AND eliminates
  the impact/flow blink during continuous drags by running between
  React's commit and the browser paint instead of after.
- **SLD action-variant flow snapshot ordering** (commits `f679646`
  + `e5c89fb`): `get_action_variant_sld` now captures
  `action_flows` / `action_assets` BEFORE switching the shared base
  network to the N-1 variant, then delegates to `_snapshot_n1_state`
  for the N-1 reference — byte-for-byte the same cadence the
  (already-correct) NAD sibling endpoint uses. The previous
  ordering read both snapshots from the N-1 variant after the
  variant flip, producing all-zero deltas with no colouring on
  every cell of the Remedial Action SLD Impacts view (operator-
  reported on `node_merging_PYMONP3` / contingency
  `P.SAOL31RONCI`). Diagnostic logging added so a future stale-flow
  regression in upstream `expert_op4grid_recommender` shows up as
  `max|Δp1|=0.00` in the backend log line.
- **Spurious f-string prefixes** (commit `46b12a4`): two assertion
  messages tagged `f""` without `{…}` placeholders tripped
  `ruff F541` on CI; cascaded into the
  "Publish report to workflow summary" step which expected
  `reports/code-quality.md` to exist.

### Documentation

- New: `docs/performance/history/svg-dom-recycling.md` — full
  retrospective with benchmarks, fallback matrix and 6 Do's/Don'ts.
- Updated: `docs/performance/rendering-optimization-plan.md` with a
  new "SVG DOM Recycling" section.
- New consolidated proposal:
  `docs/proposals/rendering-lod-strategies.md`.
- New indexes: `docs/README.md`, `docs/performance/history/README.md`.
- Refreshed: `CLAUDE.md` (root, frontend, expert_backend),
  `README.md`, `CONTRIBUTING.md`, `benchmarks/README.md`,
  `scripts/PARITY_README.md`, `frontend/PARITY_AUDIT.md`, the CI
  workflow (`parity.yml`, new `code-quality.yml`) and the CircleCI
  config.
- Updated: `docs/architecture/code-quality-analysis.md` with five
  new delta sections covering each decomposition pass and the new
  continuous-reporting tooling.
- Updated: `docs/features/action-overview-diagram.md` with the new
  filter UI and unsimulated-pin layer.

### Removed

- Obsolete rendering-LoD docs (`nad_optimization.md`,
  `spatial_lod_architecture_proposal.md`,
  `network_rendering_profiling_recommendations.md`) merged into
  the consolidated `docs/proposals/rendering-lod-strategies.md`.
- `framer-motion` and `lucide-react` from `frontend/package.json`
  (unused).

---

## [0.6.0] — 2026-04-20

Follow-up release to **0.5.0** consolidating the standalone-parity
effort, the Action Overview diagram, perf work on the inactive-tab
SVG tree, and the docs reorganisation.

### Highlights

- **Auto-generated single-file standalone** (`npm run build:standalone`)
  replaces the hand-maintained `standalone_interface.html`. The React
  source in `frontend/src/` is now the single source of truth; no
  manual mirroring required when adding a component, setting, API
  call, or gesture.
- **Layer-4 user-observable invariants** — runtime Vitest twin
  (`userObservableInvariants.test.ts`) paired with the existing
  `scripts/check_invariants.py` static check, guarding the six
  classes of regression that had previously shipped past layers 1–3.
- **Action Overview diagram** — map-pin overlay on the N-1 NAD
  showing every prioritised action with severity colouring, with
  pan/zoom-aware pin rescaling.

### Added

- **Auto-generated standalone bundle** (PR #101): React + CSS
  inlined into `frontend/dist-standalone/standalone.html` via
  `vite-plugin-singlefile`. Canonical distribution artifact. See
  `frontend/CLAUDE.md § Standalone bundle`.
- **Layer-4 parity guard** (commit `45c143e`): `scripts/check_invariants.py`
  for the standalone and a runtime Vitest twin
  (`frontend/src/utils/userObservableInvariants.test.ts`) for the
  React side.
- **Layer-3 Playwright E2E suite** (`scripts/parity_e2e/e2e_parity.spec.ts`)
  and a gesture-sequence static proxy (`scripts/check_gesture_sequence.py`).
- **Action Overview diagram** (commits `106f87a`, `4157a3e`,
  `967766a`, `3c7863b`, `d3c3b59`, `5030b6c`, `56643a8`): pin overlay
  on N-1 NAD; severity threshold parameterised by
  `monitoringFactor`; topology-first pin anchoring; combined-pair
  dashed curves; Overview backdrop dim; auto-switch to Action tab on
  "Display Prioritized". See `docs/features/action-overview-diagram.md`.
- **Detached + tied visualization tabs** brought to full Layer-1
  parity (commit `00f078f`): save-only rho arrays, tied viewBox
  sync, detach-in-Overview-mode support.
- **`/api/simulate-and-variant-diagram` streaming endpoint** — NDJSON
  `{type:"metrics"}` then `{type:"diagram"}` so the sidebar updates
  ahead of the SVG.
- **`frontend/PARITY_AUDIT.md`** — working record of the parity
  effort (feature inventory, mirror-status table, Layer 1–4
  conformity, gap list, regression-guard matrix), split out of the
  root `CLAUDE.md`.

### Changed

- **Docs reorganised** into `docs/{features,performance/{,history},
  architecture,proposals,data}/` with per-folder README indexes.
  Three overlapping rendering-LoD proposals
  (`nad_optimization.md`, `network_rendering_profiling_recommendations.md`,
  `spatial_lod_architecture_proposal.md`) merged into
  `docs/proposals/rendering-lod-strategies.md`. All in-repo
  references updated across `CLAUDE.md`s, `README.md`, benchmarks,
  scripts, tests and source comments.
- **Parity audit split** out of the root `CLAUDE.md` into
  `frontend/PARITY_AUDIT.md`.
- **`expert_backend/CLAUDE.md` / `frontend/CLAUDE.md`** refreshed
  with the post-decommission wording (single source of truth in
  `frontend/src/`).

### Performance

- **`display:none` on inactive SVG tabs** (PRs #99, #102): the
  off-screen N / N-1 / Action SVGs drop from the browser paint tree,
  cutting live DOM nodes from ~600 k to ~200 k on the French grid.
  See `docs/performance/history/svg-tab-unmount.md`.

### Fixed

- **SLD highlight** for LS / curtailment / PST targets on the
  Action tab (commit `5d2b9d1`), including a text-search fallback
  when the metadata index misses an equipment ID (commit `065e99c`).
- **Overload halo suppression** on "Solved — low margin" actions in
  both NAD and SLD (commit `894ec8c`).
- **Session reload** now refreshes the N-1 diagram and preserves
  action-bucket / combined-pair state without re-simulation
  (commit `d729725`), with `/api/restore-analysis-context` wired in
  (commit `5c9d92c`).
- **Manual re-simulate** refreshes the SLD overlay; modal content
  word-wraps correctly (commit `657af8a`).
- **Pin severity** uses `monitoringFactor − 0.05` instead of a
  hardcoded 0.9 / 1.0 cutoff, fixing the MF = 0.85 misclassification
  (commit `56643a8`).
- **Pin anchor** uses the topology target (action's disconnected
  line) rather than `max_rho_line` (commit `5030b6c`).
- **Pin coverage / Overview perf / popup pins / popover content**
  (commits `967766a`, `dbc05f8`, `d3c3b59`, `3c7863b`, `4157a3e`).
- **Rendering fidelity** for Overview, detached tabs, overflow tab,
  and action auto-zoom (commit `4157a3e`).
- **Obsolete `test_ui_regressions.py`** removed — it guarded strings
  in the now-decommissioned `standalone_interface.html`.
- **ESLint errors** in `userObservableInvariants.test.ts`
  (`@typescript-eslint/no-explicit-any`, `no-unused-vars`).

### Documentation

- New consolidated doc: `docs/proposals/rendering-lod-strategies.md`.
- New index files: `docs/README.md`,
  `docs/performance/history/README.md`.
- `docs/features/action-overview-diagram.md` added for the Action
  Overview diagram feature.
- `CLAUDE.md` (root, frontend, expert_backend) reflect the
  auto-generated standalone workflow and the new docs tree.

### Removed

- **`expert_backend/tests/test_ui_regressions.py`** — its assertions
  targeted strings in the decommissioned
  `standalone_interface.html`; equivalent coverage now lives in the
  four parity scripts (`scripts/check_*.py`) and in the Vitest
  suite.

---

## [0.5.0] — 2026-04-14

First tagged release under the **Co-Study4Grid** name. This release consolidates the
performance, workflow and UI work from PRs #57 → #91 and ships a stable, production-ready
contingency-analysis assistant for large grids.

### Highlights

- **4× faster manual-action simulation** and **~1,100× faster overload detection** on
  the full French grid (~10k branches), thanks to NumPy vectorization and observation
  caching. See `docs/performance/history/pr-perf-optimization-summary.md` and `docs/performance/performance-profiling.md`.
- **Two-step N-1 workflow** (detect → select → resolve) replaces the legacy one-shot
  analysis as the primary user path.
- **Full remedial-action catalog**: topology, PST tap adjustment, renewable curtailment,
  load shedding — individually, manually, or as superposition pairs.
- **Detachable visualization tabs** for dual-monitor workflows.
- **Replay-ready interaction logging** and **session save/reload** that exactly restore
  a study without re-simulating.

### Added

- **Rebrand**: ExpertAssist → Co-Study4Grid (PR #65), MPL-2.0 license banners on all
  code files (PR #67), `AUTHORS.txt`.
- **PST (Phase-Shifting Transformer) actions** (PR #78): tap start / target columns,
  re-simulation from the score table, target-tap sync, superposition fallback for PST
  pairs, robust key lookup for tap parameters.
- **Renewable curtailment** actions integrated end-to-end (PR #72) with the
  `set_gen_p` power-reduction format.
- **Load shedding** actions (PR #61) with configurable MW reduction (PR #73), the new
  `set_load_p` format, SLD highlighting, and score-table re-simulation.
- **Combined actions**: *Computed Pairs* and *Explore Pairs* modal, superposition
  estimation, full-simulation fallback, and UI restrictions on LS/RC combinations
  (PR #72). Pair estimations refresh on re-simulation.
- **Detachable visualization tabs** (PR #84, #86, #87, #90): pop Network N / N-1 /
  Action / Overflow tabs into a second browser window, with tie/untie, per-window
  pan/zoom preservation, bidirectional controls, and stable-portal DOM move to avoid
  unmount/remount cascades. See `docs/features/detachable-viz-tabs.md`.
- **SLD impacted-asset highlights** (PR #63): clone-behind halos for switches and
  coupling breakers, robust across pan/zoom and N-1/action state changes.
- **MW Start column** in action score tables (PR #62), with `get_virtual_line_flow`
  for open-coupling and load-shedding rows.
- **Focused sub-diagrams** (`/api/focused-diagram`, `/api/action-variant-focused-diagram`)
  with configurable depth for inspecting specific VL neighborhoods on large grids.
- **Zoom-tier level-of-detail** (PR #76): dynamic proportional boosting of labels, nodes
  and flow arrows based on `sqrt(diagramSize / referenceSize)` — mirrored in the
  standalone interface.
- **Contingency / overload auto-zoom and sticky feed** (PR #88): pinned compact summary,
  overload-click jumps to N-1 tab, VIEWING ribbon on action cards, max-rho-line zoom
  fallback when the newly overloaded line isn't a branch.
- **Save Results / Reload Session** (PR #62 family): timestamped session folders with
  `session.json`, `interaction_log.json`, and a copy of the overflow PDF. Restores
  actions, combined pairs, per-action enrichments, and sidebar loading ratios with no
  re-simulation. Documented in `docs/features/save-results.md`.
- **Replay-ready interaction logging** (PR #64): self-contained timestamped events with
  correlation IDs for async completions, suitable for deterministic browser-automation
  replay. See `docs/features/interaction-logging.md`.
- **Persistent user configuration** (PR #59) stored outside the repository, with a
  configurable config-file path.
- **Confirmation dialogs** (PR #83) before destructive state resets (switching network
  while a study is loaded; applying settings on an active study).
- **React ErrorBoundary** wrapping the app root (PR #82).
- **"Make a first guess" shortcut** in the empty Selected Actions section (PR #87),
  preserving manual actions through Analyze & Suggest.
- **Monitoring Factor Thermal Limits** parameter in Settings (PR #59).
- **User-facing documentation** under `docs/` covering performance, save/reload,
  interaction logging, combined actions, detachable tabs, curtailment/load-shedding/PST,
  and code-quality analysis.

### Changed

- **App.tsx refactor — Phase 1** (PR #74): reduced from ~2100 → ~650 lines; `App.tsx`
  is now a state-orchestration hub only. UI extracted into presentational components
  under `components/` and `components/modals/`; `useSettings` hook exposes a single
  `SettingsState` object passed wholesale to `SettingsModal` to avoid prop drilling.
- **State management — Phase 2** (PR #75): memoized cross-hook wrappers with
  `useCallback`, centralized state-reset logic, and `React.memo` on the three heaviest
  components (`VisualizationPanel`, `ActionFeed`, `OverloadPanel`).
- **Oversized components split** (PR #81): large frontend components decomposed into
  focused subcomponents with dedicated test suites.
- **Two-step analysis flow** is now the primary user path; legacy `/api/run-analysis`
  kept for compatibility.
- **Backend diagram helpers** (`_load_network`, `_load_layout`, `_default_nad_parameters`,
  `_generate_diagram`) deduplicate diagram-generation logic across endpoints.
- **CORS / network hosts**: API base URL aligned to `127.0.0.1:8000` in tests.
- **CLAUDE.md / standalone interface** kept in lock-step with the React app on every
  UI change.

### Performance

- **Vectorized `care_mask` & overload detection** (PR #66): 12.17 s → 0.01 s
  (**~1,100×** speed-up).
- **Vectorized branch flow extraction**: 0.82 s → 0.06 s (**~13×**).
- **Vectorized flow delta computation**: 0.47 s → 0.01 s (**~47×**).
- **Observation caching** in manual-action loop: 0.65 s → 0.01 s (**~65×**).
- **Total manual-action simulation latency**: ~16.5 s → ~4.0 s (**~4×**).
- **Base diagram rendering**: ~7.2 s → ~3.5 s.
- **Backend NaN stripping via `lxml`** and **gzip compression** for large SVG payloads
  (PR #70).
- **Pre-built `SimulationEnvironment` and `dict_action`** passed into
  `run-analysis-step1` to avoid rebuilding on every step (PR #70).
- **Frontend throttling**: datalist rendering throttled, zoom guard on exact matches,
  NaN fix in SVG boost (PR #70).
- **Overflow-graph display timing** fixed and covered by regression tests (PR #70).
- **Performance-budget test suite** (PR #66, #68) covering vectorized logic, cache
  invalidation and a small-grid simulation budget, with warm-up to absorb cold-start
  noise.
- **Eliminated contingency-search freeze** and restored automatic zoom on N-1
  diagrams (PR #77).

### Fixed

- **Second-contingency crash**, auto-zoom loss on contingency switch, and overload
  persistence across successive studies (PR #80).
- **`min_renewable_curtailment_actions`** missing from saved config (PR #80).
- **Auto-zoom double injection** on contingency switch — `MemoizedSvgContainer` kept
  always mounted (PR #81).
- **N-1 variant clone** now made from the clean N state, not the working variant (PR #81).
- **Action target asset dimming** in the standalone interface: force full opacity on
  originals (PR #71).
- **Contingency highlight z-ordering**: sibling insertion with solid yellow halo,
  surviving pan/zoom and SLD overlay (PR #71).
- **Overload highlight thresholds** and loading display values (PR #71).
- **Monitoring-factor scaling** restored for suggested actions (PR #71).
- **Superposition monitoring** aligned with `simulate_manual_action`, with
  overloaded lines force-included in the `eligible_mask` (PR #79).
- **PST re-simulation** preserves `_dict_action` structure; additive superposition
  fallback for PST no-op; proper element identification in `compute_superposition`
  (PR #78, #79).
- **Combined-action estimation filtering**: heavily loaded N-state lines are no longer
  incorrectly filtered out (PR #72).
- **`gen_p` / observation-sequence / legacy keys / islanding reporting** regressions in
  the backend after manual-action enrichment refactor (PR #72, #73).
- **Re-simulate double-click bug** on action cards (PR #73).
- **SLD rendering regressions**: blank screen, missing N-1 highlight,
  `ReferenceError` crash in the overlay (PR #76).
- **Grid layout functionality** restored with regression tests (PR #69).
- **Settings pickers**, action-table sync, blank diagram after pair simulation, and
  action-bucket preservation on re-simulation (PR #82 family).

### Documentation

- New docs: `PR_PERF_OPTIMIZATION.md`, `performance_profiling.md`, `nad_optimization.md`,
  `phase2-state-management-optimization.md`, `app-refactoring-plan.md`,
  `spatial_lod_architecture_proposal.md`, `network_rendering_profiling_recommendations.md`,
  `walkthrough_network_rendering_profiling.md`, `rendering-optimization-plan.md`,
  `detachable-viz-tabs.md`, `save-results.md`, `interaction-logging.md`,
  `combined-actions.md`, `curtailment-loadshedding-pst-actions.md`,
  `state-reset-and-confirmation-dialogs.md`, `frontend-ui-improvements.md`,
  `description_actions_topology.md`, `code-quality-analysis.md`.
- `CLAUDE.md` updated to reflect the Phase 1 / Phase 2 architecture, two-step flow,
  session save/load, SLD highlights, and combined actions.

---

## Earlier Development (pre-0.5.0)

Prior to the Co-Study4Grid rebrand (PR #65), the project was developed as **ExpertAssist**
with an iterative series of merged PRs (#57–#65) that built up:

- The initial FastAPI backend and React + TypeScript frontend scaffolding.
- Network loading, branch listing, N-1 contingency diagrams and the first
  single-step analysis flow.
- Progressive alignment between the React app and the `standalone_interface.html`
  single-file UI.
- Early interaction-logging, config-persistence and network-diagram fixes that paved
  the way for the 0.5.0 consolidation.

These are not enumerated here — the git history (`git log`) and GitHub PR list remain
the authoritative reference for pre-0.5.0 work.

---

[Unreleased]: https://github.com/marota/Co-Study4Grid/compare/0.8.0...HEAD
[0.8.0]: https://github.com/marota/Co-Study4Grid/releases/tag/0.8.0
[0.7.5]: https://github.com/marota/Co-Study4Grid/releases/tag/0.7.5
[0.7.0]: https://github.com/marota/Co-Study4Grid/releases/tag/0.7.0
[0.6.5]: https://github.com/marota/Co-Study4Grid/releases/tag/0.6.5
[0.6.0]: https://github.com/marota/Co-Study4Grid/releases/tag/0.6.0
[0.5.0]: https://github.com/marota/Co-Study4Grid/releases/tag/0.5.0
