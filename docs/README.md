# Co-Study4Grid — Documentation

This folder holds design docs, feature specs, performance retrospectives,
architectural proposals, and data-pipeline references for the project.
The root `CLAUDE.md` is the canonical project overview; everything here
drills into specific subsystems.

## Layout

```
docs/
├── features/        Active feature / behavior reference docs
├── performance/     Current perf reference + history/ of shipped & rejected PR writeups
├── backend/         Backend-scoped reference (recommender models, etc.)
├── architecture/    Refactoring plans, code-quality audits
├── proposals/       Not-yet-implemented ideas, brainstorm decks, rejected designs
└── data/            External data pipelines (OSM → XIIDM conversion, etc.)
```

## When to look where

| I want to… | Go to |
|------------|-------|
| Understand how a shipped feature is supposed to behave | `features/` |
| Diagnose a perf regression or see what's been tuned | `performance/` (and `performance/history/` for retrospectives) |
| Find an ongoing refactoring plan or quality audit | `architecture/` |
| Evaluate or revive a rejected / proposed design | `proposals/` |
| Regenerate a grid dataset | `data/` |

## Active feature docs (`features/`)

| File | Topic |
|------|-------|
| [`save-results.md`](features/save-results.md) | Session save/reload contract + regression-guard matrix. |
| [`interaction-logging.md`](features/interaction-logging.md) | Replay-ready event log contract. |
| [`action-overview-diagram.md`](features/action-overview-diagram.md) | Map-pin overlay on N-1 NAD + the interactive overflow viewer; filter chips + un-simulated pin pipeline. |
| [`interactive-overflow-analysis.md`](features/interactive-overflow-analysis.md) | Iframe overflow viewer (0.7.0): layer toggles, hierarchical ↔ geo layout, pin overlay injection, postMessage envelope. |
| [`detachable-viz-tabs.md`](features/detachable-viz-tabs.md) | Pop viz tabs into standalone windows; tied/detached sync. |
| [`combined-actions.md`](features/combined-actions.md) | Dual-action simulation via superposition (fast) + full sim (exact). |
| [`state-reset-and-confirmation-dialogs.md`](features/state-reset-and-confirmation-dialogs.md) | State-reset guards when switching contingencies / reloading. |
| [`actions-topology.md`](features/actions-topology.md) | Action formats + topology algorithms (switch → set_bus, Union-Find cache). |
| [`sld-topology-edit.md`](features/sld-topology-edit.md) | Interactive SLD topology edit → manual action card: target-topology preview (`/api/sld-topology-preview`), maneuver list, combined-card canonicalisation, six interaction events. |
| [`vl-disk-interactions.md`](features/vl-disk-interactions.md) | Interactive VL disks on the NAD: hover name (labels hidden), single-click → Inspect/zoom, double-click → SLD. Delegation-based performance contract + the pointer-events click-retarget fix. |
| [`curtailment-loadshedding-pst-actions.md`](features/curtailment-loadshedding-pst-actions.md) | Renewable curtailment, load shedding, PST tap actions. |
| [`adding-action-type.md`](features/adding-action-type.md) | Cross-cutting checklist to integrate / upgrade a remedial-action type (lib → backend → frontend → save/log/reload triad → regression specs). Read before adding a family or touching session persistence. |
| [`frontend-ui-improvements.md`](features/frontend-ui-improvements.md) | Voltage filter, run-button placement, color codes, always-visible tabs. |
| [`game-mode-codabench.md`](features/game-mode-codabench.md) | Timed, scored Game Mode wrapper (`?game=1`) + Codabench benchmark bundle: session config, timer, ≤3-action cap, JSON/CSV log export, shared scoring, local E2E. |
| [`dark-mode.md`](features/dark-mode.md) | Light/dark theme: design-token source of truth, `useTheme` hook + pre-mount script, the "soft-background" trap, NAD/SLD diagram + overflow-viewer theming, tests. |

## Performance (`performance/`)

Top-level performance reference docs (the ones that still describe
current behavior, not historical retrospectives):

| File | Topic |
|------|-------|
| [`rendering-optimization-plan.md`](performance/rendering-optimization-plan.md) | Critical CSS + SVG rendering tricks (`vector-effect: non-scaling-stroke`, etc.) with regression risks. |
| [`performance-profiling.md`](performance/performance-profiling.md) | Benchmark table + methodology. |
| [`nad-profile-bare-env.md`](performance/nad-profile-bare-env.md) | Baseline measurements for N-state NAD generation. |
| [`walkthrough-network-rendering-profiling.md`](performance/walkthrough-network-rendering-profiling.md) | End-to-end profiling trace (14 MB SVG, 26 s cold path). |

Historical PR writeups — one file per shipped / rejected change —
live under [`performance/history/`](performance/history/). See that
folder's index for the full list.

## Backend reference (`backend/`)

| File | Topic |
|------|-------|
| [`README.md`](backend/README.md) | Backend overview — singletons, mixin composition, NDJSON streaming. |
| [`recommender_models.md`](backend/recommender_models.md) | Pluggable recommendation models: registry, built-in random examples, three-layer filter chain, **execution-time breakdown** (step 1 / overflow / prediction / assessment / enrichment + wall-clock), post-contingency obs pre-warm + `prebuilt_obs_simu_defaut` fast path. |

## Architecture (`architecture/`)

| File | Topic |
|------|-------|
| [`2026-07-full-repo-review.md`](architecture/2026-07-full-repo-review.md) | Full-repository review (2026-07): 12-dimension audit (architecture, API contract, UX, perf, docs, delivery, security + data pipeline / Game Mode / deployment gaps) with adversarially verified findings, a sequenced deep-revision roadmap (D1–D9), and 25 quick wins. Progress tracked inline in Part V. |
| [`api-contract-machine-check.md`](architecture/api-contract-machine-check.md) | Deep revision **D2**: the unified `{detail, code}` error envelope, the `openapi.snapshot.json` machine-check + CI diff, the single frontend error extractor, and the tracked follow-ups (response models on the gzipped endpoints, `types.ts` generation, blanket-handler removal). |
| [`shared-network-concurrency.md`](architecture/shared-network-concurrency.md) | Deep revision **D3**: concurrency ownership for the shared pypowsybl `Network` — the service-level re-entrant lock over the ~13 variant-switching entry points, the HTTP-409 study-mutation busy gate, the bounded contingency-variant LRU, and the lock-ordering fix vs the NAD-prefetch drain. |
| [`notifications-and-streaming.md`](architecture/notifications-and-streaming.md) | Deep revision **D5**: one NDJSON reader (`utils/ndjsonStream.ts`) replacing five drifted parser copies, the typed notification store (`utils/notifications.ts` + `NotificationHost` — severity/sticky/dismiss/aria-live) replacing the dual toast channels + `'SUCCESS'` protocol, and cancellable analysis (AbortController + visible Cancel). |
| [`deployment-trust.md`](architecture/deployment-trust.md) | Deep revision **D7**: the lockdown profile (`COSTUDY4GRID_LOCKDOWN` disables the desktop-era filesystem RPCs with a `403 LOCKED_DOWN` on the hosted Space), the test-gated deploy + per-deploy rollback tag, and the tracked reproducible-Python-closure follow-up. |
| [`app-refactoring-plan.md`](architecture/app-refactoring-plan.md) | Historical: Phase 1 + Phase 2 hook extraction from `App.tsx` (shipped). |
| [`phase2-state-management-optimization.md`](architecture/phase2-state-management-optimization.md) | Memoize wrapper functions with `useCallback` (shipped 0.5.0). |
| [`code-quality-analysis.md`](architecture/code-quality-analysis.md) | Continuous audit; latest deltas (§14–15) cover the 0.7.0 release + the function-LoC ceiling, postMessage envelope, FastAPI return-type follow-ups. |
| [`development-cycle.md`](architecture/development-cycle.md) | Chronological retrospective covering the four development phases through 0.7.0 (minimal end-to-end → features → consolidation → PyPSA-EUR + interactive overflow). |
| [`simulation-pipeline.md`](architecture/simulation-pipeline.md) | End-to-end backend simulation pipeline: state lifecycle, two-step analysis, manual-action flow, superposition, available modes, hypotheses, UI → config mapping. Companion to the lib's `docs/architecture/simulation-pipeline.md` (physical / numerical layer). |
| [`ronci-beon-reproducibility.md`](architecture/ronci-beon-reproducibility.md) | Calibration case `P.SAOL31RONCI` → `BEON L31CPVAN` overload: reference values per grid (reduced 98.75 % / full 96.1 %), the Hades2 SecurityAnalysis recipe, fast/slow modes, the full-grid slow-mode divergence (20→100 outer-iter fix) and the `CHALOY631` remedial action. Reproduced by `scripts/reproduce_ronci_overload.py`. |

## Proposals (`proposals/`)

Unimplemented ideas and rejected designs kept for reference.

| File | Topic |
|------|-------|
| [`rendering-lod-strategies.md`](proposals/rendering-lod-strategies.md) | **Consolidated** LoD rendering history + current plan. Supersedes `nad_optimization.md`, `network_rendering_profiling_recommendations.md`, and `spatial_lod_architecture_proposal.md`. |
| [`new-features-brainstorm-mars26.md`](proposals/new-features-brainstorm-mars26.md) | Brainstorm of 12 candidate features (batch N-1, heatmap, Cmd+K, shortcuts, …). French text. |
| [`ui-design-critique.md`](proposals/ui-design-critique.md) | UI critique (2026-05-01, code + screenshot review): consistency, hierarchy, NAD halo sizing, a11y, ActionCard density. Prioritizes design tokens + ActionCard redesign + halo cap + warning-tier + diagram legend. |
| [`decompose-ceiling-riders.md`](proposals/decompose-ceiling-riders.md) | **Tracked for next release** (deferred code-quality target #4). Files riding their tightened size/complexity ceilings (`simulation_mixin.py` 1110/1150, `VisualizationPanel.tsx` 1407/1450, …) with current margins + a concrete extraction candidate per target. |

## Data (`data/`)

| File | Topic |
|------|-------|
| [`pypsa-eur-osm-to-xiidm.md`](data/pypsa-eur-osm-to-xiidm.md) | PyPSA-Eur OSM → XIIDM 3-script conversion pipeline. |
| [`grid-layout-coordinate-scale.md`](data/grid-layout-coordinate-scale.md) | Why `grid_layout.json` MUST be raw Mercator metres (~1.4–1.6 M span) and not the legacy 8 000-unit rescale. Operator-vs-PyPSA comparison + the 2026-05-08 fix. |
| [`voltage-level-separation.md`](data/voltage-level-separation.md) | Why co-located 225/400 kV VL disks overlapped (node boost + collocated OSM buses) and the two-part fix: `svgBoost` `60×` ceiling + `separate_voltage_levels.py` layout post-processing. |

---

## Editing conventions

- Prefer editing an existing doc over creating a new one.
- If you write a new perf retrospective, drop it under
  `performance/history/` using a short kebab-case filename (no
  `perf-` prefix — the folder already conveys it).
- If you write a new active feature doc, put it in `features/` and
  add a row to the table above.
- Keep proposals small and self-contained; once implemented, either
  (a) rewrite into a `features/` doc and delete the proposal, or
  (b) move to `performance/history/` if it was a perf change.
