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
│                             # react-zoom-pan-pinch, vite-plugin-singlefile
├── vite.config.ts            # Vite + Vitest plugin (jsdom env)
├── eslint.config.js          # Flat config (v9+) — typescript-eslint,
│                             # react-hooks, react-refresh
├── tsconfig.json             # Root project refs
├── tsconfig.app.json         # App config (strict TS, noUnusedLocals/Params,
│                             # noFallthroughCasesInSwitch)
├── tsconfig.node.json        # Vite/config TypeScript config
├── public/
└── src/
    ├── main.tsx              # React entry (StrictMode)
    ├── App.tsx               # State orchestration hub (~1400 lines)
    ├── App.*.test.tsx        # App-level integration tests by domain
    ├── App.css / index.css   # Global + app styles
    ├── api.ts                # Axios HTTP client (single object literal)
    ├── api.test.ts
    ├── types.ts              # All TypeScript interfaces (one file)
    ├── test/setup.ts         # Vitest global setup (jest-dom matchers)
    ├── hooks/                # Custom hooks owning a slice of state
    │   ├── useSettings.ts          # All settings + setters → SettingsState
    │   ├── useActions.ts           # Action selection / favorite / reject
    │   ├── useAnalysis.ts          # Two-step analysis flow (step1/step2)
    │   ├── useDiagrams.ts          # NAD fetching + tab management
    │   ├── usePanZoom.ts           # ViewBox state, zoom-to-element
    │   ├── useSldOverlay.ts        # Single-Line-Diagram overlay
    │   ├── useSession.ts           # Session save / restore
    │   ├── useDetachedTabs.ts      # Detached visualization windows
    │   ├── useTiedTabsSync.ts      # Mirror viewBox between detached + main
    │   ├── useContingencyFetch.ts           # N-1 diagram fetch (svgPatch fast-path
    │   │                           # + full /api/contingency-diagram fallback)
    │   └── useDiagramHighlights.ts # Per-tab SVG highlight pipeline
    │                               # (overload halos, contingency highlight,
    │                               # action targets, delta visuals) + the
    │                               # per-tab Flow/Impacts view-mode state
    ├── components/           # Presentational components (no API calls)
    │   ├── Header.tsx, ActionFeed.tsx, OverloadPanel.tsx,
    │   ├── VisualizationPanel.tsx, ActionCard.tsx, ActionCardPopover.tsx,
    │   ├── ActionOverviewDiagram.tsx, ActionSearchDropdown.tsx,
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
    │   ├── DetachableTabHost.tsx, ErrorBoundary.tsx, ExplorePairsTab.tsx,
    │   ├── MemoizedSvgContainer.tsx, SldOverlay.tsx,
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
    │   ├── StatusToasts.tsx        # Fixed-position error/info banners
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
        │   └── highlights.ts          # - highlights: contingency / overload halos
        ├── svgPatch.ts                # SVG DOM recycling: clone N-state SVG
        │                              # and patch per-branch deltas on N-1 / action
        │                              # tab switches (PR #108). Used by useContingencyFetch.
        ├── actionTypes.ts             # classifyActionType + matchesActionTypeFilter
        │                              # + DEFAULT_ACTION_OVERVIEW_FILTERS — shared
        │                              # by every filter UI surface (PR #109)
        ├── overloadHighlights.ts      # N-1 overload classification
        ├── popoverPlacement.ts        # Pin-popover positioning
        ├── sessionUtils.ts            # buildSessionResult snapshot
        ├── interactionLogger.ts       # Singleton replay-ready event log
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
`useContingencyFetch`, `useDiagramHighlights`), wires them together, and
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
 - **VL-names toggle** (`useDiagrams.showVoltageLevelNames`, default
  on): a `🏷 VL` button next to the bottom-left Inspect field flips
  the `nad-hide-vl-labels` class on each `MemoizedSvgContainer`. The
  CSS rule (`App.css`) hides every shape pypowsybl uses for VL
  labels — `foreignObject.nad-text-nodes`, inline `<text>` under
  `.nad-vl-nodes` / `.nad-label-nodes`, and root-level
  `.nad-label-box` divs — with `!important` to beat the inline
  `<style>` block pypowsybl appends after App.css. When labels are
  hidden the VL name is still reachable via a native `<title>`
  tooltip on each bus circle: `applyVlTitles` (`utils/svg/vlTitles.ts`)
  walks the metadata index after every diagram refresh and injects /
  updates one `<title data-vl-title>` per node group, idempotently.
  The toggle emits a `vl_names_toggled { show }` interaction event
  (declared in both `spec
- **SVG DOM recycling** (`utils/svgPatch.ts`, PR #108): on N-1 /
  action tab switches the N-state `SVGSVGElement` is cloned and
  patched with per-branch deltas from the new
  `/api/contingency-diagram-patch` and `/api/action-variant-diagram-patch`
  endpoints instead of being re-fetched and re-parsed. ~80 % faster
  on the ~12 MB French NAD. Falls back to the full NAD on any
  unsupported edge case.

The visualization is rendered inside `react-zoom-pan-pinch`. Zoom
state is owned by `usePanZoom` per tab (`nPZ`, `n1PZ`, `actionPZ`,
plus `overviewPz` for the Action overview map). The
`useTiedTabsSync` hook mirrors viewBox changes from the active tab
to any "tied" detached tab.

## Detached tabs

`useDetachedTabs` opens diagram tabs in popup windows
(`window.open`). When popups are blocked, the error surfaces via
`onPopupBlocked` callback. The detached tab gets its own
`react-zoom-pan-pinch` instance; `useTiedTabsSync` keeps the
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
2. Add response types to `types.ts` if they're new.
3. Call from the right hook (settings → `useSettings`, analysis →
   `useAnalysis`, diagrams → `useDiagrams`, session → `useSession`).
4. Wire any new state through to presentational components via
   typed props.
5. ~~Mirror the call in `standalone_interface.html`~~ — no longer
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
- **`handleSimulateUnsimulatedAction` NDJSON parser (~90 lines).**
  The inlined stream-consumer duplicates the parse loop from
  `useAnalysis`. Candidate for extraction into a shared
  `utils/ndjsonStream.ts` helper once a third caller exists.

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
