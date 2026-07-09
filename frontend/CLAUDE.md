# CLAUDE.md — `frontend/`

React 19 + TypeScript 5.9 + Vite 7 single-page app for Co-Study4Grid.
Talks to the FastAPI backend at `http://127.0.0.1:8000` (hardcoded in
`src/api.ts`). Renders pypowsybl NAD/SLD diagrams with pan/zoom and
runs the two-step contingency analysis workflow.

For the project-wide overview see the root `CLAUDE.md`. For backend
internals see `expert_backend/CLAUDE.md`. Test conventions for
Vitest are listed in `expert_backend/tests/CLAUDE.md` (the frontend
section).

## Layout

```
frontend/
├── README.md
├── index.html                # Vite HTML entry point
├── package.json              # React 19, Vite 7, vitest, axios, react-select,
│                             # vite-plugin-singlefile
├── vite.config.ts            # Vite + Vitest plugin (jsdom env)
├── eslint.config.js          # Flat config (v9+) — typescript-eslint,
│                             # react-hooks, react-refresh
├── tsconfig.json             # Root project refs
├── tsconfig.app.json         # App config (strict TS, noUnusedLocals/Params,
│                             # noFallthroughCasesInSwitch)
├── tsconfig.node.json        # Vite/config TypeScript config
├── public/
└── src/
    ├── main.tsx              # React entry (StrictMode). Mounts GameShell
    │                         # instead of App when ?game=1 (gameBridge.isGameMode())
    ├── App.tsx               # State orchestration hub (~1400 lines)
    ├── App.*.test.tsx        # App-level integration tests by domain
    ├── App.css / index.css   # Global + app styles
    ├── api.ts                # Axios HTTP client. API_BASE_URL =
    │                         # VITE_API_BASE_URL ?? http://127.0.0.1:8000 — set to
    │                         # "" for same-origin (Docker Space) hosting
    ├── api.test.ts
    ├── types.ts              # All TypeScript interfaces (one file)
    ├── test/setup.ts         # Vitest global setup (jest-dom matchers)
    ├── game/                 # Timed, scored Game Mode (0.8.0; active only with
    │                         # ?game=1). GameShell / useGameSession / gameBridge /
    │                         # GameConfigScreen / GameHud / GameResults / scoring /
    │                         # gameLog / presets / types. See the Game Mode section
    │                         # below + docs/features/game-mode-codabench.md
    ├── hooks/                # Custom hooks owning a slice of state
    │   ├── useSettings.ts          # All settings + setters → SettingsState
    │   ├── useActions.ts           # Action selection / favorite / reject
    │   ├── useAnalysis.ts          # Two-step analysis flow (step1/step2)
    │   ├── useDiagrams.ts          # NAD fetching + tab management (thin-ish
    │   │                           # orchestrator; composes the two D4 sub-
    │   │                           # hooks below behind the DiagramsState facade)
    │   ├── useOverflowLayout.ts    # D4 sub-hook of useDiagrams — overflow-graph
    │   │                           # hierarchical/geo layout toggle
    │   ├── useActionDiagramCache.ts # D4 sub-hook of useDiagrams — prime-then-
    │   │                           # paint action-variant NAD cache (cleared on
    │   │                           # contingency change)
    │   ├── useManualSimulation.ts  # D4 — the two operator "simulate now" flows
    │   │                           # (pin double-click + interactive SLD edit) +
    │   │                           # the shared SLD-edit state, extracted from App
    │   ├── usePanZoom.ts           # ViewBox state, zoom-to-element
    │   ├── useSldOverlay.ts        # Single-Line-Diagram overlay
    │   ├── useSldTopologyEdit.ts    # Interactive SLD edit (switches +
    │   │                            # load/gen active power): editMode
    │   │                            # (implicit while open, read-only on
    │   │                            # close) + pendingStates +
    │   │                            # pendingInjections + toggle /
    │   │                            # removeSwitch(es) / setInjection /
    │   │                            # removeInjection / focusedSwitchId
    │   │                            # (see docs/features/sld-topology-edit.md)
    │   ├── useSession.ts           # Session save / restore
    │   ├── useDetachedTabs.ts      # Detached visualization windows
    │   ├── useTiedTabsSync.ts      # Mirror viewBox between detached + main
    │   ├── useContingencyFetch.ts           # N-1 diagram fetch (svgPatch fast-path
    │   │                           # + full /api/contingency-diagram fallback)
    │   ├── useDiagramHighlights.ts # Per-tab SVG highlight pipeline
    │   │                           # (overload halos, contingency highlight,
    │   │                           # action targets, delta visuals) + the
    │   │                           # per-tab Flow/Impacts view-mode state
    │   ├── useOverflowIframe.ts    # Interactive overflow viewer: iframe
    │   │                           # lifecycle, layer toggles, hierarchical ↔
    │   │                           # geo switch, postMessage bridge, pin overlay
    │   ├── useTheme.ts             # Light/dark theme toggle + persistence
    │   │                           # (0.8.0; see docs/features/dark-mode.md)
    │   ├── useSldFeederRelabel.ts  # Relabel SLD branch feeders with the far-
    │   │                           # end VL name + wrap EVERY long feeder name
    │   │                           # (generators / loads / unmatched branches)
    │   │                           # so extremity names stop overlapping (Issue
    │   │                           # 1; render-every-time self-gate, delegates
    │   │                           # the DOM swap to feederLabels
    │   │                           # .applyFeederRelabels + .applyFeederLabelWrap)
    │   ├── useSldFeederNav.ts       # Click a relabelled feeder name → open the
    │   │                           # far-end VL's SLD (reads data-feeder-nav;
    │   │                           # capture-phase, keeps the current sub-tab so
    │   │                           # the overload stays visible from both ends)
    │   └── useSldInjectionNameButtons.ts # Render editable-injection NAME
    │                               # buttons on the SLD (extracted from
    │                               # SldOverlay to keep it under the LoC ceiling)
    ├── components/           # Presentational components (no API calls)
    │   ├── Header.tsx, ActionFeed.tsx, OverloadPanel.tsx,
    │   ├── VisualizationPanel.tsx, ActionCard.tsx, ActionCardPopover.tsx,
    │   ├── ActionOverviewDiagram.tsx, ActionSearchDropdown.tsx,
    │   ├── ActionTypeIcon.tsx, SeverityIcon.tsx,   # action-type + severity
    │   │                               # pictograms (shared by cards / rings / pins)
    │   ├── DiagramLegend.tsx, AdditionalLinesPicker.tsx,
    │   ├── ActionFilterRings.tsx       # Shared sidebar strip: severity ring
    │   │                               # (4 colour-coded pictogram toggles
    │   │                               # with single-click toggle + double-
    │   │                               # click solo), action-type ring (7
    │   │                               # uncoloured pictogram toggles with
    │   │                               # single-select toggle-off), AND the
    │   │                               # compact Max-loading threshold
    │   │                               # spinner. Drives the shared
    │   │                               # ActionOverviewFilters object the
    │   │                               # Action Feed, Action Overview NAD,
    │   │                               # Manual Selection modal, Combine
    │   │                               # Actions modal and the Overflow
    │   │                               # Analysis iframe all read from.
    │   ├── ActionTypeFilterChips.tsx   # Legacy chip row — kept for the
    │   │                               # Explore Pairs surface (PR #109)
    │   ├── NoticesPanel.tsx,           # Sidebar-header pill that opens an
    │   │                               # inline panel listing every active
    │   │                               # notice (action-dict, monitoring
    │   │                               # coverage, recommender thresholds).
    │   │                               # Manual dismiss only — no auto-
    │   │                               # hide on analysis lifecycle.
    │   ├── CombinedActionsModal.tsx, ComputedPairsTable.tsx,
    │   ├── ExplorePairsTab.tsx        # Explore Pairs tab: editable MW
    │   │                           # setpoint for injection rows (LS,
    │   │                           # curtailment, redispatch) — local
    │   │                           # editMw state, per-row input with
    │   │                           # type-aware bounds, threaded to
    │   │                           # onSimulateSingle as targetMw
    │   ├── DetachableTabHost.tsx, ErrorBoundary.tsx,
    │   ├── MemoizedSvgContainer.tsx, SldOverlay.tsx,
    │   ├── SldEditPanel.tsx        # Interactive maneuver list under
    │   │                           # the SLD overlay — switch toggles +
    │   │                           # injection retunes, focus on row
    │   │                           # click, ✕ per row, checkbox +
    │   │                           # Remove selected (N), Reset,
    │   │                           # Simulate action. Mirrors
    │   │                           # manoeuvre_ihm's seq_delete /
    │   │                           # seq_delete_many. See
    │   │                           # docs/features/sld-topology-edit.md.
    │   ├── SldInjectionPopover.tsx # Floating load/gen active-power
    │   │                           # editor bubble (current P, Pmin/Pmax,
    │   │                           # clamp) opened by clicking an
    │   │                           # injection on the SLD in edit mode.
    │   ├── AppSidebar.tsx          # Sidebar layout shell (summary +
    │   │                           # contingency picker + children).
    │   │                           # Collapsible to a 32-px strip via
    │   │                           # the `collapsed` / `onToggleCollapsed`
    │   │                           # props; hides the picker when
    │   │                           # `hideContingencyPicker` is on
    │   │                           # (readability-feed PR).
    │   ├── SidebarSummary.tsx      # Sticky top strip — contingency
    │   │                           # zoom shortcut + Clear button +
    │   │                           # N-1 overload jumps (double-click
    │   │                           # to toggle monitoring) + overload
    │   │                           # info bubble (popover hosts N-state
    │   │                           # overloads, per-N-1 monitoring
    │   │                           # checkboxes, monitor-deselected
    │   │                           # switch, monitoring-coverage hint).
    │   ├── NotificationHost.tsx    # Renders the typed notification store
    │   │                           # (D5) as dismissible bottom-right toasts
    │   │                           # in an aria-live region (severity =
    │   │                           # error/success/info). Replaced the old
    │   │                           # StatusToasts dual error/info banners.
    │   └── modals/
    │       ├── SettingsModal.tsx          # 3-tab settings dialog
    │       ├── ReloadSessionModal.tsx     # Session reload list
    │       └── ConfirmationDialog.tsx     # Shared confirmation (contingency / reload)
    └── utils/                # Pure helpers (no React, no axios)
        ├── svgUtils.ts                # Barrel re-exporting every utils/svg/* module
        ├── svg/                       # PR #104 decomposition of the original
        │   ├── idMap.ts               # 1807-line svgUtils into 8 focused modules:
        │   ├── metadataIndex.ts       # - idMap: cached WeakMap<container,id→Element>
        │   ├── svgBoost.ts            # - metadataIndex: O(1) equipment-metadata lookup
        │   ├── fitRect.ts             # - svgBoost: dynamic font/radius scale for big grids
        │   ├── deltaVisuals.ts        # - fitRect: bounding-box auto-zoom
        │   ├── actionPinData.ts       # - deltaVisuals: flow-delta colouring
        │   ├── actionPinRender.ts     # - actionPin{Data,Render}: overview pin layer
        │   ├── highlights.ts          # - highlights: contingency / overload halos
        │   ├── edgeInfoDeclutter.ts   # - flow-value de-collision (slide along edge;
        │   │                          #   load-time pass invoked by svgBoost §6)
        │   └── feederLabels.ts        # - SLD feeder relabel + friendly-name↔IIDM-id
        │                              #   overload bridge (see useSldFeederRelabel +
        │                              #   docs/features/sld-diagram-feeder-labels.md)
        ├── svgPatch.ts                # SVG DOM recycling: clone N-state SVG
        │                              # and patch per-branch deltas on N-1 / action
        │                              # tab switches (PR #108). Used by useContingencyFetch.
        ├── actionTypes.ts             # classifyActionType + matchesActionTypeFilter
        │                              # + DEFAULT_ACTION_OVERVIEW_FILTERS — shared
        │                              # by every filter UI surface (PR #109)
        ├── overloadHighlights.ts      # N-1 overload classification
        ├── popoverPlacement.ts        # Pin-popover positioning
        ├── inspectables.ts            # filterInspectables — match an element by its
        │                              # displayed name OR raw id; shared by every
        │                              # inspect surface (N / N-1 / action + overview)
        ├── sessionUtils.ts            # buildSessionResult snapshot
        ├── interactionLogger.ts       # Singleton replay-ready event log
        ├── apiError.ts                # D2 (2026-07) — single reader for the
        │                              # backend's unified {detail, code} error
        │                              # envelope: extractApiError /
        │                              # apiErrorMessage / hasErrorCode. Replaces
        │                              # scattered err?.response?.data?.detail reads;
        │                              # hasErrorCode branches on codes like
        │                              # ACTION_RESULT_UNAVAILABLE / STUDY_BUSY /
        │                              # LOCKED_DOWN (D7 hosted-deploy guard).
        ├── ndjsonStream.ts            # D5 (2026-07) — parseNdjsonStream: the ONE
        │                              # NDJSON reader (buffer carry-over, trailing
        │                              # flush, AbortSignal) replacing five drifted
        │                              # reader-loop copies.
        ├── notifications.ts           # D5 (2026-07) — typed notification store
        │                              # singleton (severity/sticky/dismiss/de-dupe)
        │                              # + useNotifications() + notifyError/Info/
        │                              # Success. Rendered by NotificationHost;
        │                              # replaced the dual error/info toast channels
        │                              # and the 'SUCCESS' string protocol.
        ├── mergeAnalysisResult.ts     # Merge step1 + step2 fields
        ├── fileRegistry.ts            # Structure-regression guard (tracks expected
        │                              # source-tree layout; fails the Vitest suite
        │                              # when a file disappears unexpectedly)
        └── *.test.ts                  # Co-located unit tests
```

## Architecture in one paragraph

`App.tsx` is the **state orchestration hub** — it instantiates the
custom hooks (`useSettings`, `useActions`, `useAnalysis`,
`useDiagrams`, `useSession`, `useDetachedTabs`, `useTiedTabsSync`,
`useContingencyFetch`, `useDiagramHighlights`, `useOverflowIframe`,
`useSldTopologyEdit`, `useTheme`), wires them together, and
routes state into presentational components. It MUST NOT contain
large inline JSX blocks — when adding UI sections, create a new
component under `components/` or `components/modals/` and pass
props down. Hooks own state by domain (e.g. `useActions` owns
`selectedActionIds` / `manuallyAddedIds` / `rejectedActionIds`)
and expose typed setters + handlers. Cross-hook logic
(`handleApplySettings`, `resetAllState`, `wrappedRunAnalysis`) lives
in `App.tsx` because it needs multiple hook instances at once.

## Hook conventions

- Each hook returns a typed `*State` interface — e.g.
  `useSettings(): SettingsState`. The interface includes both values
  AND setters AND derived handlers (e.g. `pickSettingsPath`).
- Pass the entire state object wholesale into deeply-nested modals
  to avoid prop-drilling 30+ individual props (see how
  `<SettingsModal settings={settings} />` consumes the whole
  `SettingsState`).
- Refs intended to survive renders (e.g.
  `committedBranchRef`, `restoringSessionRef`,
  `actionSyncSourceRef`) live on the hook that owns them and are
  re-exported through the `*State` interface — not on `App.tsx`.
- Adding a new setting requires three places:
  1. `hooks/useSettings.ts` — field on `SettingsState` + a `useState`
     pair in `useSettings()`.
  2. `components/modals/SettingsModal.tsx` — input wired to the
     setter.
  3. ~~Manual mirror in `standalone_interface.html`~~ — no longer
     required. The legacy file has been decommissioned; the
     auto-generated `frontend/dist-standalone/standalone.html`
     inherits the field on the next `npm run build:standalone`.

Adding a new **remedial-action type** (a new action family + its
`*_details` payload) is broader than a setting — it threads through the
library, backend, classification, ActionCard rendering, and the
**save / interaction-log / reload triad** (`sessionUtils.ts`,
`App.tsx` `buildConfigInteractionDetails`, `useSession.ts`) plus the
two `scripts/check_*.py` regression specs. Follow the full checklist in
[`docs/features/adding-action-type.md`](../docs/features/adding-action-type.md);
the §3.5 "save/log/reload triad" table is the part that regresses
silently (the `redispatch_details` save-drop bug).

## Data flow (happy path)

1. **Boot**: `App.tsx` first effect calls `api.getUserConfig()` →
   hydrates `useSettings` from `config.json`. The settings modal
   opens automatically if `networkPath` / `actionPath` are missing.
2. **Apply settings / Load study**: `applySettingsImmediate` calls
   `resetAllState()` → `api.updateConfig(buildConfigRequest())` →
   parallel `Promise.all` of `getBranches` + `getVoltageLevels` +
   `getNominalVoltages` + `getNetworkDiagram` (the slow NAD overlaps
   with the fast metadata calls — see
   `docs/performance/history/loading-parallel.md`).
3. **Select contingency**: typing in the contingency input fires the
   N-1 useEffect when the value matches a valid branch. If analysis
   state already exists, a confirmation dialog appears
   (`hasAnalysisState()` / `committedBranchRef.current`). On
   confirm, fetches `/api/contingency-diagram` and stores it on
   `diagrams.n1Diagram`.
4. **Run analysis**: two-step flow. `runAnalysisStep1` returns the
   list of overloads; user selects which to resolve;
   `runAnalysisStep2Stream` streams a `pdf` event then a `result`
   event with prioritized actions.
5. **Action interactions**: star/reject/manually-add/re-simulate.
   Selecting an action triggers `/api/action-variant-diagram` →
   stored as `diagrams.actionDiagram`.
6. **Session save**: `buildSessionResult()` in
   `utils/sessionUtils.ts` serializes EVERYTHING (paths, settings,
   contingency, action statuses, combined pairs, interaction log).
   `api.saveSession()` writes to disk. See `docs/features/save-results.md`.

## State reset & confirmation dialogs

`resetAllState()` (`App.tsx:310-324`) clears every per-study piece of
React state. It is called on Apply Settings AND on Load Study. The
backend mirrors this with `recommender_service.reset()` —
`docs/features/state-reset-and-confirmation-dialogs.md` is the contract for
both sides. Adding a new piece of analysis state? Reset it here
AND make sure the backend mixin clears whatever cache shadows it.

Confirmation dialog flow lives in `App.tsx`:
- `confirmDialog` state: `{ type: 'contingency' | 'loadStudy' |
  'applySettings' | 'changeNetwork' | 'clearSuggested', pendingBranch?:
  string, pendingNetworkPath?: string } | null`.
- `<ConfirmationDialog />` is the shared modal — used for all
  contingency-loss-warning gestures (picker-driven *and* the new
  sticky-banner Clear shortcut, see below).

## Sidebar visibility & banner Clear shortcut

`App.tsx` flips two visibility gates the moment the operator commits
a contingency (`selectedContingency.length > 0`):
- `hideContingencyPicker` is passed to `AppSidebar` so the "Select
  Contingency" card folds away — the sticky banner already echoes
  the contingency label and the `Clear` button (see below) replaces
  the picker's affordance.
- The `ActionFeed` is rendered only inside the same gate. Pre-trigger
  the sidebar shows only the picker; post-trigger it shows the feed.

The sticky banner (`SidebarSummary`) hosts:
- a `Clear` button (`requestClearContingency`) that routes through
  `<ConfirmationDialog type="contingency">` when `hasAnalysisState()`
  would otherwise be lost, and clears in place otherwise;
- a `?` info bubble next to the Overloads label whose popover lists
  N-state pre-existing overloads, hosts the per-N-1 monitoring
  checkboxes (`onToggleOverload`), the `monitorDeselected` switch,
  and the monitoring-coverage hint — i.e. every affordance that
  used to live in the now-retired `OverloadPanel` card.

`AppSidebar` accepts a `collapsed` flag; when set, the shell shrinks
to a 32-px strip with an expand caret. The `VisualizationPanel`
mirrors this by hosting an inline copy of `ActionFilterRings` on the
left of its tab row (testid `viz-panel-overview-filters`) so the
filter remains reachable without re-expanding the sidebar.

Interaction-log events emitted by this flow:
`sidebar_collapsed_toggled { collapsed }`,
`contingency_clear_requested { had_analysis_state }`. Both are
mirrored in `scripts/check_standalone_parity.py`'s `SPEC_DETAILS`.

## SVG handling

The frontend deals with multi-MB pypowsybl SVG payloads. Four
performance levers are applied today:

- **`api.getNetworkDiagram` uses `format=text`** (`api.ts:69-92`):
  fetches a JSON-header + raw-SVG-body response so the browser
  doesn't `JSON.parse` a 25 MB string. Saves ~500 ms on large grids.
- **`getIdMap(container)`** (`utils/svg/idMap.ts`): cached
  `WeakMap<HTMLElement, Map<id, Element>>` so highlight passes don't
  re-scan `[id]` selectors. Invalidate via `invalidateIdMapCache`
  whenever the SVG content changes.
- **`boostSvgForLargeGrid`** (`utils/svg/svgBoost.ts`): dynamic
  font/node-radius scaling for grids ≥ 500 voltage levels so labels
  stay readable at high zoom.
- **Flow-value de-cluttering** (`utils/svg/edgeInfoDeclutter.ts`,
  invoked as `svgBoost` §6): pypowsybl places both branch flow values
  ~22 % from each terminal with NO label de-collision, so values
  fanning out of a busy substation overprint into a blob. This pass
  slides each *overlapping* value further along its OWN edge — oriented
  toward mid-segment (away from its nearest VL node, from the `vlOuter`
  set §2) and capped at ~the distance to mid — so every flow stays
  visible and on its line. It is a **load-time, one-shot** pass (runs
  inside `processSvg`, never per frame) and **zoom-invariant** (the
  values are vector `<text>` that scale with the viewBox, so a single
  user-space solve is correct at every zoom), hence **zero pan/zoom
  gesture cost** — the gesture culls `.nad-edge-infos` anyway. ~16 k
  labels resolve in ~30 ms parse + ~70 ms relax (8 passes) thanks to a
  flat-`Float64Array` + numeric-keyed linked-list spatial hash. The
  ultra-dense urban core (e.g. Paris, ~50 substations in a tiny area)
  stays busy — a physical limit of "show *all* flows" by sliding on
  very short edges.
 - **VL-names toggle** (`useDiagrams.showVoltageLevelNames`, default
  on): a `🏷 VL` button next to the bottom-left Inspect field flips
  the `nad-hide-vl-labels` class on each `MemoizedSvgContainer`. The
  CSS rule (`App.css`) hides every shape pypowsybl uses for VL
  labels — `foreignObject.nad-text-nodes`, inline `<text>` under
  `.nad-vl-nodes` / `.nad-label-nodes`, and root-level
  `.nad-label-box` divs — with `!important` to beat the inline
  `<style>` block pypowsybl appends after App.css. When labels are
  hidden the VL name is still reachable on hover via a lightweight
  floating tooltip injected by `attachVlInteractions`
  (`utils/svg/vlInteractions.ts`) — see the **VL-disk interactions**
  entry below. The toggle emits a `vl_names_toggled { show }`
  interaction event (declared in both `spec
 - **VL-disk interactions** (`utils/svg/vlInteractions.ts`,
  `attachVlInteractions`): the voltage-level disks on every NAD tab are
  interactive — **hover** shows the VL name (only while the static
  labels are hidden), **single-click** selects the VL (drives the
  Inspect field + auto-zoom, same as typing it in the box) and
  **double-click** opens its SLD overlay. Wired from `App.tsx` via one
  delegated effect, re-bound on each diagram / metadata refresh.
  Performance is the design constraint: a fixed handful of delegated
  listeners on the container (never one-per-node), **no `mousemove` /
  per-frame work**, the pointer-cursor affordance is a static
  `.nad-vl-nodes { cursor: pointer }` CSS rule, and during pan/zoom the
  existing `.svg-interacting` rule disables SVG hit-testing so no
  handler resolves a node mid-gesture. A click is told apart from a pan
  by pointer travel; the single-click action is deferred
  `VL_SINGLE_CLICK_DELAY_MS` so a double-click pre-empts it. Full
  write-up: [`docs/features/vl-disk-interactions.md`](../docs/features/vl-disk-interactions.md).
- **SVG DOM recycling** (`utils/svgPatch.ts`, PR #108): on N-1 /
  action tab switches the N-state `SVGSVGElement` is cloned and
  patched with per-branch deltas from the new
  `/api/contingency-diagram-patch` and `/api/action-variant-diagram-patch`
  endpoints instead of being re-fetched and re-parsed. ~80 % faster
  on the ~12 MB French NAD. Falls back to the full NAD on any
  unsupported edge case.

Pan/zoom is implemented directly by `usePanZoom` — it writes the SVG
`viewBox` on the container (rAF-batched, cached CTM), with no pan/zoom
library. Zoom state is owned by `usePanZoom` per tab (`nPZ`, `n1PZ`,
`actionPZ`, plus `overviewPz` for the Action overview map). The
`useTiedTabsSync` hook mirrors viewBox changes from the active tab
to any "tied" detached tab.

**Zoom-adaptive overload/action/contingency halo width.** The line
halos are screen-space (`vector-effect: non-scaling-stroke`), so their
`stroke-width` is rendered px. `usePanZoom.applyViewBox` writes a
**continuous** `--nad-halo-w` CSS var on the container from the zoom
ratio (`computeHaloWidthPx`): thin (~24px — a clean trace of the
branch) across the whole zoomed-in range, growing toward a still-modest
~50px marker only past the overview boundary, with **no `data-zoom-tier`
step** (the old discrete 24px-vs-120px snap looked jarring + coarse at
deep zoom). App.css binds `stroke-width: var(--nad-halo-w, 24px)` on the
three halo classes (thin default if JS hasn't set it). The var is only
written when the rounded px value changes, so it's free during a pan and
re-evaluated on each settle. Guarded by the
`nad_overload_halo_zoom_adaptive` Layer-4 invariant +
`uxConsistency.test.tsx`.

Pan/zoom fluidity on large grids has an always-on lever plus a
3-mode opt-in `utils/smoothPanZoom.ts` singleton (`'off' | 'gpu' |
'bitmap'`, read by `usePanZoom` at gesture start; **Pan/zoom rendering**
selector in Settings → Configurations, default `'off'`). See
`docs/performance/history/interaction-paint-culling.md` and
`benchmarks/interaction_paint/`:
- **`'off'` (default) — interaction paint culling.** While a gesture is
  active (`usePanZoom` adds `.svg-interacting`), `App.css` hides the
  expensive `<foreignObject>` VL labels + `.nad-edge-infos` so each
  viewBox-repaint frame is cheaper. GPU-independent; safe everywhere.
- **`'gpu'`** — replaces the per-frame viewBox rewrite with a
  compositor-only CSS transform on the live `<svg>`, baking back on
  settle. Only ~1.2–1.5× over the default though: Chrome RE-RASTERS the
  ~100k-node vector layer on every transform.
- **`'bitmap'`** (`utils/svg/bitmapSnapshot.ts`) — rasterise the NAD to a
  dpr-scaled `<canvas>` ONCE at gesture start and transform that bitmap
  (compositor-only, no vector re-raster), baking back to the live SVG on
  settle. **~3× the fps of off/gpu** in the real app (50 ms → 16.7 ms/frame
  on the 5247-VL grid) and composites cheaply even in software, at the
  cost of a one-shot raster when the gesture begins. Prerequisites baked
  in: strip `<foreignObject>` (canvas taint), inline the App.css
  halo/delta rules + theme tokens + base non-scaling-stroke into the
  clone (so N-1/Action halos/deltas survive the isolated raster), set the
  current `data-zoom-tier` AND re-declare the live `--nad-halo-w` on the
  snapshot root (the isolated SVG has no JS, so the var-bound halo width would
  otherwise snap to its 24px fallback), and an analytic cursor→user mapping for
  the wheel zoom (the live SVG is `visibility:hidden`, so `getScreenCTM` is
  stale). A generation token discards a slow async raster from a settled
  gesture. OFF by default — it's the experimental "big bet".
  - **Responsive start.** Serialising the 9 MB SVG costs ~250 ms — far too
    much to run in the `mousedown` handler (it froze the pan start). So the
    viewBox-INDEPENDENT serialisation is **cached** (`serializeStrippedSvg`),
    **pre-warmed on idle** (`requestIdleCallback`) and **invalidated by a
    MutationObserver** on the live SVG (highlight/delta class + childList
    changes — viewBox writes are NOT observed, so per-frame pans don't churn
    it). Each gesture only re-composes the cheap `<svg>` header + `<style>`
    (`composeSnapshotMarkup`) and decodes **off the main thread**
    (`createImageBitmap`). If the cache is still cold at gesture start, the
    gesture stays on the responsive viewBox fallback and the bitmap engages
    from the next gesture — the start is never blocked. mousedown→first-frame
    ≈ 128 ms (same as the default path).
  - **No ghost on settle.** The target viewBox is baked onto the still-hidden
    live SVG and the bitmap is kept on top for ~2 frames before the swap, so
    the SVG layer's stale base-zoom paint never flashes during its repaint.

## Detached tabs

`useDetachedTabs` opens diagram tabs in popup windows
(`window.open`). When popups are blocked, the error surfaces via
`onPopupBlocked` callback. The detached tab gets its own
`usePanZoom` viewBox state; `useTiedTabsSync` keeps the
viewBoxes in sync. See `docs/features/detachable-viz-tabs.md`.

## Interaction logging

Every meaningful user gesture is recorded by the
`interactionLogger` singleton in `utils/interactionLogger.ts`.
Entries have a sequence number, ISO timestamp, typed `type` (see
the long `InteractionType` union in `types.ts`), free-form
`details`, optional `correlation_id`, and optional `duration_ms`
for async operations.

The log is replay-ready: each event must carry ALL inputs the
agent would need to redo the gesture (paths, threshold values,
selected branch, …). Saved as `interaction_log.json` alongside
`session.json` on session save. See `docs/features/interaction-logging.md`.

When adding a new gesture:
1. Add a new variant to the `InteractionType` union in
   `types.ts`.
2. Call `interactionLogger.record('your_event_type', { ... })` at
   the gesture site.
3. For async (start/complete) pairs, capture the correlation_id
   from `record()` and pass it to `recordCompletion()`.

## Game Mode (`?game=1`)

`src/game/` is a timed, scored wrapper around the study workspace,
**additive and inert unless `?game=1`** is on the URL (or the build sets
`VITE_GAME_MODE=1`). `main.tsx` mounts `<GameShell>` instead of `<App>` when
`gameBridge.isGameMode()` is true; otherwise the bare workspace renders
exactly as before.

- **`gameBridge.ts`** is the decoupling singleton (mirrors
  `interactionLogger`): `App` registers a study loader and publishes its
  physical snapshot `{ baselineMaxRho, chosenActions }`; `GameShell` /
  `useGameSession` drive study loads, read results, and enforce the
  ≤ 3-action cap — so **`App.tsx` keeps only three `isGameMode()`-guarded
  touch points** (`loadGameStudy`, the publish effect, and the
  star-cap on `wrappedActionFavorite`) and never imports game internals.
- **`scoring.ts`** is the in-browser twin of the Codabench Python scorer
  (`60·R + 25·R·A + 15·R·T`), locked to it by unit tests on both sides —
  edit the two together.
- **`presets.ts`** lists curated **solvable** fr225_400 contingencies; keep
  them winnable (the `scripts/game_mode/e2e_game_session.py` backend replay
  verifies `can_proceed=True`).

When you touch the workspace, do NOT special-case game mode inside
components — route it through `gameBridge` so the bare app stays oblivious.
Full contract: [`docs/features/game-mode-codabench.md`](../docs/features/game-mode-codabench.md).

## Deployment build (same-origin SPA)

`api.ts` reads `API_BASE_URL = import.meta.env.VITE_API_BASE_URL ??
'http://127.0.0.1:8000'`. The `Dockerfile` builds with `VITE_API_BASE_URL=""`
(relative `/api/...`) and `VITE_GAME_MODE=1`, and the FastAPI backend serves
the built `dist/` same-origin (see `expert_backend/CLAUDE.md` → static SPA
mount). Local dev and the Vitest suite leave the env unset, so they keep
hitting the standalone backend at `:8000`. Don't hardcode the origin
anywhere — always go through `API_BASE_URL`.

## Testing (Vitest + React Testing Library)

```bash
cd frontend
npm run test         # one-shot
npm run test:watch   # watch mode
```

- Tests live next to source files as `*.test.ts` / `*.test.tsx`.
- `src/test/setup.ts` registers `@testing-library/jest-dom` matchers.
- jsdom is the test environment (vite.config.ts).
- Heavy mocking: `vi.mock('../api')`, `vi.mock('../utils/svgUtils')`.
  No backend round-trips in component tests.
- App-level integration tests are split by domain:
  `App.contingency.test.tsx`, `App.session.test.tsx`,
  `App.settings.test.tsx`, `App.stateManagement.test.tsx`,
  `App.datalist.test.tsx`, `App.import.test.tsx`.
- Pattern for new component tests: build `defaultProps`, override
  the fields under test, `render(<X {...props} />)`, query the DOM
  via `screen`, assert.

## Adding a new backend endpoint to the frontend

1. Add the axios method to `api.ts` (mirror the URL exactly).
2. Add response types to `types.ts` if they're new. The backend commits
   an `openapi.snapshot.json` that machine-checks the wire contract — keep
   `types.ts` consistent with it (generating `types.ts` from the snapshot
   is a tracked D2 follow-up in `docs/architecture/api-contract-machine-check.md`).
3. Call from the right hook (settings → `useSettings`, analysis →
   `useAnalysis`, diagrams → `useDiagrams`, session → `useSession`).
4. Handle errors through `utils/apiError.ts` — `apiErrorMessage(e, fallback)`
   for the human string, `hasErrorCode(e, 'CODE')` when you must branch on
   the specific failure (e.g. `ACTION_RESULT_UNAVAILABLE`). Do NOT re-read
   `e.response.data.detail` inline.
5. Wire any new state through to presentational components via
   typed props.
6. ~~Mirror the call in `standalone_interface.html`~~ — no longer
   required. The auto-generated `frontend/dist-standalone/standalone.html`
   inherits the new endpoint automatically after `npm run build:standalone`.

## Code style

- **Strict TypeScript**: `strict: true`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`. `any` only
  with a comment explaining why.
- **Functional components + hooks**. No external state
  management library — context only when prop-drilling becomes
  unbearable.
- **Inline `style` objects** are the convention here (no CSS modules
  or utility-class framework). Match the surrounding component.
- **Design tokens** — use `colors` / `space` / `text` / `radius` from
  `src/styles/tokens.ts` for inline styles, and `var(--…)` from
  `src/styles/tokens.css` for stylesheet rules. For raw SVG attribute
  values (`element.setAttribute('fill', …)`), import the hex-valued
  `pinColors` / `pinColorsDimmed` / `pinColorsHighlighted` /
  `pinChrome` constants from `tokens.ts` — browsers don't reliably
  resolve `var(--…)` inside SVG presentation attributes, and a few
  unit tests assert on the resolved hex via `getAttribute('fill')`.
  Do not introduce hex literals anywhere outside the token files; the
  code-quality gate enforces zero. See
  `docs/proposals/ui-design-critique.md` recommendation #1.
- **Memoize at the right level**: `useCallback` for handlers passed
  as props, `useMemo` for derived data passed to large children.
  Don't memoize cheap inline objects on small leaf components.
- **No comments explaining what** — well-named identifiers do that.
  Comment WHY only when the answer is non-obvious (subtle race,
  pypowsybl quirk, performance trade-off, browser bug).
- **Lint**: `npm run lint` is `eslint .` against the flat config in
  `eslint.config.js`. Run before committing.

## Build & dev

```bash
cd frontend
npm install
npm run dev      # Vite dev server with HMR (default port 5173)
npm run build    # tsc -b + vite build → dist/
npm run preview  # Preview the production build
```

`api.ts` hardcodes `http://127.0.0.1:8000` — start
`uvicorn expert_backend.main:app --port 8000` first.

## File-size rule of thumb

If a component crosses ~600 lines, look for an extractable concern:
a sub-component, a hook, or a helper in `utils/`. `App.tsx` is the
single intentional exception — it's a state orchestration hub by
design, but even it should not grow large inline JSX blocks.

## Standalone bundle (auto-generated)

The single-file HTML distribution is now auto-generated from this
React source tree by `npm run build:standalone` in `frontend/` (see
`frontend/vite.config.standalone.ts`). Output:
`frontend/dist-standalone/standalone.html` — a ~1 MB single file
with React + CSS inlined, favicon inlined as a data URI, no
external network dependencies. This artifact replaces the former
hand-maintained `standalone_interface.html` (renamed to
`standalone_interface_legacy.html` at the project root, committed
as a frozen snapshot of its last version — do NOT edit further).

Consequence for day-to-day dev: **no manual mirroring is required**
when you add a component, setting, endpoint, or gesture. Land the
change in `frontend/src/`, run the tests, and the standalone
inherits it on the next build.

## Parity audit

The working record of the standalone-vs-React parity effort —
feature inventory, mirror-status table, Layer 1–4 conformity
findings, gap-priority list, regression-guard matrix and deltas
— lives in [`frontend/PARITY_AUDIT.md`](./PARITY_AUDIT.md) (split
out of the root `CLAUDE.md` on 2026-04-20). Regenerate the
machine-authored tables with:

```bash
python scripts/check_standalone_parity.py --emit-markdown
python scripts/check_session_fidelity.py --json
python scripts/check_gesture_sequence.py --json
python scripts/check_invariants.py --json
```

All four scripts accept `COSTUDY4GRID_STANDALONE_PATH=<path>` to
re-target any artifact, and default to `dist-standalone/standalone.html`
with a fallback to the legacy file when the auto-gen is not built.

## How to make a UI change today

1. Edit the React source in `src/` — components, hooks, styles.
2. Run `npm run test` — the Vitest suite covers session
   save/reload, SLD highlights, action card re-simulation,
   settings logging, datalist clamping, and ~930 other specs.
3. Run `npm run build:standalone` — produces the single-file
   `dist-standalone/standalone.html` artifact. This is what ships
   as the standalone distribution.
4. Optionally run the parity scripts in `scripts/` if the change
   touches an interaction gesture, a settings field, an API
   endpoint, or a session-JSON field — those are the four
   contract surfaces each layer guards.

## App.tsx refactor history

Running record of the App.tsx size-reduction effort. `App.tsx` was
1575 lines after PR #108 (svg-dom-recycling); the list below tracks
what has been extracted and what remains deferred.

### Landed (2026-04-22)

| Extraction | Target | Lines out of App.tsx |
|---|---|---|
| Sticky contingency/N-1 summary strip | `components/SidebarSummary.tsx` | ~90 |
| Sidebar layout shell (summary + contingency selector + children slot) | `components/AppSidebar.tsx` | ~160 |
| Error / info floating toasts | `components/StatusToasts.tsx` | ~25 |
| N-1 diagram fetch effect (svgPatch fast-path + `/api/contingency-diagram` fallback + contingency-change confirm routing) | `hooks/useContingencyFetch.ts` | ~120 |
| `applyHighlightsForTab` + driving effect + per-tab `detachedViewModes` state + `viewModeForTab` / `handleViewModeChangeForTab` | `hooks/useDiagramHighlights.ts` | ~155 |

Net: **1575 → ~1150 lines** at PR #109. App.tsx remains the state
orchestration hub (wires hooks together, routes cross-hook handlers)
— the extractions removed only pure presentational JSX and two
self-contained effect pipelines. Subsequent 0.7.0 work
(`useOverflowIframe`, the `cs4g:overflow-*` postMessage envelope
wiring, design-token migration glue, and the action-pin overflow
handlers) brought App.tsx back up to ~1400 lines; it remains exempt
from the component-size ceiling and is still the state-orchestration
hub.

### Deferred

These were scoped and rejected for the same PR. Land them as
follow-ups when the boundary stabilises — each is a bigger
architectural bet than Option 1+2 was.

- **Option 3 — orchestrator hooks for settings & session.** Absorb
  `confirmDialog`, `applySettingsImmediate`, `handleLoadConfig`,
  `handleApplySettingsClick`, `handleLoadStudyClick`,
  `requestNetworkPathChange`, `handleConfirmDialog` into a
  `useSettingsOrchestration` hook (~220 lines); move `saveParams`,
  `wrappedSaveResults`, `restoreContext`, `wrappedRestoreSession` into
  a `useSaveLoadSession` hook (~80 lines); move
  `clearContingencyState` / `resetForAnalysisRun` / `resetAllState`
  into a `useStateReset` hook (~95 lines). **Saves** another ~400
  lines. **Tradeoff:** each new hook has 8–12 cross-hook dependencies
  (`settings`, `diagrams`, `analysis`, `actionsHook`, `session`), so
  orchestration logic moves but doesn't disappear — watch for the
  parameter-threading cost crossing the readability break-even.
- **Option 4 — AppContext provider.** Convert `App.tsx` into a thin
  `<AppProvider>{…sidebar + panel…}</AppProvider>` shell; children
  consume context directly instead of receiving 20+ props. **Saves**
  the prop-drilling in `<VisualizationPanel>` / `<ActionFeed>` /
  `<Header>`. **Tradeoff:** re-render surface area grows (any
  provider-state change re-renders every consumer unless selectors
  are added); explicitly flagged as "context only when prop-drilling
  becomes unbearable" in the Code-style section. Not recommended as
  the next step.
- ~~**`handleSimulateUnsimulatedAction` NDJSON parser (~90 lines).**~~
  ✅ **Done (D5.1, 2026-07)** — all five reader-loop copies now consume
  the shared `utils/ndjsonStream.ts` generator; see
  [`docs/architecture/notifications-and-streaming.md`](../docs/architecture/notifications-and-streaming.md).

### One-off ESLint exception

`useDiagramHighlights.ts` has one `eslint-disable-next-line
react-hooks/set-state-in-effect` on the reattach-prune effect.
The pre-extraction code in `App.tsx` was not flagged by the same
rule (position-sensitive analyser heuristic), but the behavior —
"re-detach after reattach restarts from the main-window mode rather
than resuming the previous detached mode" — must be preserved
byte-for-byte. The guarded `setDetachedViewModes` call sits behind
a `hasStale` short-circuit, so we accept the suppression rather
than change observable UX to placate the rule.

No manual mirror in any separate HTML file. The React source is
the single source of truth.
