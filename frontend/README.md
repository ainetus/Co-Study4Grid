# Co-Study4Grid — Frontend

React 19 + TypeScript 5.9 + Vite 7 single-page app for the
Co-Study4Grid contingency-analysis UI. Talks to the FastAPI backend
at `http://localhost:8000` (hardcoded in `src/api.ts`) and renders
pypowsybl NAD / SLD diagrams with pan / zoom.

This file is a quick orientation. For the full guide — hook split,
data flow, SVG performance levers, detached / tied tabs, interaction
logger contract — see [`CLAUDE.md`](./CLAUDE.md).

## Scripts

```bash
npm install                 # install dependencies
npm run dev                 # Vite dev server with HMR (default port 5173)
npm run build               # tsc -b && vite build → dist/
npm run build:standalone    # tsc -b && vite build --config vite.config.standalone.ts
                            #   → dist-standalone/standalone.html (single-file bundle)
npm run preview             # preview the production build
npm run lint                # eslint . (flat config, v9+)
npm run test                # vitest run (~1000 specs)
npm run test:watch          # vitest in watch mode
npm run quality:report      # run the backend code-quality reporter on the whole repo
npm run quality:check       # gate — exits non-zero on threshold violation
```

The backend must be running on `http://localhost:8000` for the dev
server to serve anything useful. Start it with:

```bash
# from project root
uvicorn expert_backend.main:app --host 0.0.0.0 --port 8000
```

## Source layout

```
src/
├── main.tsx                     # React entry (StrictMode)
├── App.tsx                      # State orchestration hub (~1150 lines)
├── App.*.test.tsx               # App-level integration tests by domain
├── api.ts                       # Axios HTTP client
├── types.ts                     # All TypeScript interfaces
├── hooks/
│   ├── useSettings.ts           # Settings state + SettingsState interface
│   ├── useActions.ts            # Action selection / favorite / reject
│   ├── useAnalysis.ts           # Two-step analysis pipeline (step1 / step2)
│   ├── useDiagrams.ts           # NAD fetching + tab management
│   ├── useContingencyFetch.ts            # svgPatch fast-path + /api/contingency-diagram fallback
│   ├── useDiagramHighlights.ts  # Per-tab SVG highlight pipeline + Flow/Impacts view-mode
│   ├── useSession.ts            # Session save / reload
│   ├── useDetachedTabs.ts       # Detached visualization windows
│   ├── useTiedTabsSync.ts       # Mirror viewBox between detached + main
│   ├── useSldOverlay.ts         # SLD overlay state
│   └── usePanZoom.ts            # Per-tab viewBox, zoom-to-element
├── components/                  # Presentational components (no API calls)
│   ├── Header, ActionFeed, ActionCard, ActionCardPopover,
│   ├── ActionOverviewDiagram, ActionSearchDropdown,
│   ├── ActionTypeFilterChips,                              # Shared chip row
│   ├── AppSidebar, SidebarSummary, StatusToasts,           # Sidebar layout
│   ├── VisualizationPanel, OverloadPanel, CombinedActionsModal,
│   ├── ComputedPairsTable, ExplorePairsTab,
│   ├── DetachableTabHost, MemoizedSvgContainer, SldOverlay,
│   ├── ErrorBoundary
│   └── modals/
│       ├── SettingsModal, ReloadSessionModal, ConfirmationDialog
└── utils/
    ├── svgUtils.ts              # Barrel re-exporting every utils/svg/* module
    ├── svg/                     # PR #104 decomposition of the old svgUtils
    │   ├── idMap, metadataIndex, svgBoost, fitRect,
    │   ├── deltaVisuals, actionPinData, actionPinRender,
    │   └── highlights
    ├── svgPatch.ts              # SVG DOM recycling (PR #108)
    ├── actionTypes.ts           # Action-type classification + filter helpers
    ├── overloadHighlights.ts    # N-1 overload classification
    ├── sessionUtils.ts          # buildSessionResult snapshot
    ├── interactionLogger.ts     # Singleton replay-ready event log
    ├── mergeAnalysisResult.ts   # Step1 + step2 field merge
    ├── popoverPlacement.ts      # Pin-popover positioning
    └── fileRegistry.ts          # Structure regression guard
```

## Standalone bundle

`npm run build:standalone` produces
`frontend/dist-standalone/standalone.html` — a single-file HTML with
React + CSS inlined via `vite-plugin-singlefile`. This is the
canonical distribution artifact; the legacy hand-maintained
`standalone_interface.html` has been decommissioned and frozen as
`standalone_interface_legacy.html` at the project root. UI changes
should land only in `frontend/src/` — the bundle inherits them on
the next build. See [`CLAUDE.md`](./CLAUDE.md) for the parity story.

## Testing

Tests live next to their source file as `*.test.ts` / `*.test.tsx`.
The suite uses Vitest with `jsdom`, `@testing-library/react`, and
`@testing-library/jest-dom`. Heavy mocking is the norm (`vi.mock`
for `../api` and SVG utilities) so component tests never hit the
backend.

Run a single file:

```bash
npx vitest run src/components/ActionFeed.test.tsx
```

Test patterns and the full inventory are documented in
[`../expert_backend/tests/CLAUDE.md`](../expert_backend/tests/CLAUDE.md).

## ESLint

Flat config (v9+) in `eslint.config.js` with `typescript-eslint`,
`react-hooks`, and `react-refresh`. The code-quality gate
(`python scripts/check_code_quality.py`, CI-enforced) rejects `any`
and `@ts-ignore` in source files — see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Recent UX iterations (post-0.6.5)

The following PRs reshaped the look-and-feel of the app without
touching the analysis pipeline. The full retrospective lives in
[`../docs/architecture/development-cycle.md`](../docs/architecture/development-cycle.md)
section 5; design rationale comes from
[`../docs/proposals/ui-design-critique.md`](../docs/proposals/ui-design-critique.md).

- **PR #118 — VL-names toggle.** A `🏷 VL` button next to the
  Inspect field hides / shows the voltage-level labels on NAD
  diagrams. Hidden labels remain reachable via a native `<title>`
  tooltip on each bus circle. New `vl_names_toggled { show }`
  interaction event.
- **PR #120 — Design tokens (Phases A → C).** Palette / space /
  radius / typography moved into `src/styles/tokens.{ts,css}`.
  Components consume `colors.brand`, `space[2]`, `text.xs`…
  Hex literals are forbidden outside the token files; SVG
  presentation attributes use the `pinColors` family for
  Chrome-safe `setAttribute` calls.
- **PR #121 — Progressive-disclosure ActionCard + halo cap.** Action
  cards default to a compact summary and expand on demand. The NAD
  highlight halo radius is now capped relative to the viewBox so it
  cannot swamp the screen at high zoom.
- **PR #122 — Tier warning system + NoticesPanel + diagram legend.**
  Replaces the stack of yellow banners with a single `⚠️ Notices N`
  pill in the sidebar header that opens a consolidated list (one
  entry, one place to dismiss). A unified diagram legend lands at
  the bottom-right of the visualization panel.
  `uxConsistency.test.tsx` enforces the recommendations going
  forward.
- **`fix-notice-panel-overlap` follow-up.** The Notices popover now
  renders via `ReactDOM.createPortal(…, document.body)` with
  `position: fixed` so it escapes the sidebar's `overflow: hidden`
  clip and any ancestor stacking context — the visualization panel
  no longer paints over it on narrow sidebars. Right-aligned to the
  pill so it grows leftward into the sidebar rather than bleeding
  into the diagram. Regression test in `NoticesPanel.test.tsx`
  asserts the popover is NOT a descendant of an `overflow:hidden`
  ancestor.

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — architecture deep dive
- [`../CLAUDE.md`](../CLAUDE.md) — project-wide overview + API table
- [`../docs/README.md`](../docs/README.md) — design, feature and
  performance docs index
- [`../docs/architecture/development-cycle.md`](../docs/architecture/development-cycle.md)
  — chronological retrospective of all five development phases
- [`PARITY_AUDIT.md`](./PARITY_AUDIT.md) — standalone-bundle parity
  audit (Layer 1–4 conformity, regression matrix)
