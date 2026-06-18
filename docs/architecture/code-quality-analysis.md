# Code Quality & Maintainability Analysis

**Date:** 2026-04-11
**Last updated:** 2026-05-05
**Scope:** Full repository diagnostic — backend, frontend, repo structure, security, testing

> **Continuous reporting (new 2026-04-20):**
> - `python scripts/code_quality_report.py` — metrics dump (JSON + Markdown)
> - `python scripts/check_code_quality.py` — CI gate (non-zero exit on regression)
> - Unit-tested in `scripts/test_code_quality_report.py` (7 tests, part of the pytest suite)
> - Runs in CI: `.github/workflows/code-quality.yml` + `.circleci/config.yml`
>   (jobs `gate` / `code-quality`). Also uploads a report artifact.
> - See [CONTRIBUTING.md](../../CONTRIBUTING.md#code-quality-checks)
>   for local usage and thresholds.

---

## Executive Summary

| Dimension | Grade | Status | Notes |
|-----------|-------|--------|-------|
| **TypeScript correctness** | **A** | — | Zero compiler errors, zero lint warnings, strict mode |
| **Test suite** | **A+** | **Improved** | 560+ frontend tests, 42 backend test files, 7 quality-reporter tests |
| **Documentation** | **A** | — | CLAUDE.md refreshed, `CONTRIBUTING.md` added, 17 docs/ |
| **Frontend architecture** | **B+** | **Improved** | Oversized components split into focused subcomponents |
| **Backend architecture** | **B+** | **Fixed** | Split into 5 focused modules (was one 3,151-line monolith) |
| **Security posture** | **B+** | **Fixed** | Path traversal patched; CORS now honours `CORS_ALLOWED_ORIGINS` env var |
| **Type safety (Python)** | **C** | **Improving** | Core utilities typed; route handlers still missing return annotations |
| **Error handling (Python)** | **A-** | **Fixed** | `logger.exception()` replaces all `traceback.print_exc()` in backend sources |
| **Continuous quality reporting** | **A** | **New** | Gate script + unit tests + CI job + ruff (F/E9 rules) |

---

## 1. What's Working Well

### Frontend Tooling

- `tsc --noEmit` passes with **zero errors** under `strict: true`
- ESLint passes with **zero warnings**
- All **560 unit tests pass** across 35 test files (Vitest + React Testing Library)
- No `any` types in source code, no `@ts-ignore`
- Well-structured custom hooks: `useSettings`, `useAnalysis`, `useDiagrams`, `useSldOverlay`, `useSession`, `usePanZoom`

### Documentation

- CLAUDE.md (250+ lines) provides comprehensive project context
- 17 architecture/design docs in `docs/`
- Consistent copyright headers (MPL-2.0)

### Git Hygiene

- Conventional commit prefixes (`feat:`, `fix:`, `debug:`, `test:`)
- PR-based workflow with descriptive merge commits
- Dual CI: CircleCI + GitHub Actions running pytest, Vitest, and ESLint

### Backend Test Coverage

- 39 test files in `expert_backend/tests/`
- Covers sanitization, overload filtering, combined actions, PST tap actions, regression scenarios

---

## 2. Critical Issues — All Resolved

### 2.1 ~~Security: Path Traversal Vulnerabilities~~ ✅ FIXED

Added `_validate_path_within()` helper to `main.py` that resolves paths and ensures they don't escape the allowed directory. Applied to `save_session` and `load_session` endpoints. PDF copy source restricted to `Overflow_Graph/` directory.

### 2.2 ~~Security: Wildcard CORS~~ ✅ FIXED

CORS origins now configurable via `CORS_ALLOWED_ORIGINS` environment variable (comma-separated). `allow_credentials` disabled when using wildcard. Removed dead `GZipMiddleware` import.

### 2.3 ~~Backend God Object: `recommender_service.py` (3,151 lines)~~ ✅ FIXED

Split into focused mixin modules:

| File | Lines | Responsibility |
|------|-------|----------------|
| `recommender_service.py` | **410** | Core orchestrator, config, network lifecycle |
| `diagram_mixin.py` | **833** | NAD/SLD generation, flow deltas, overload detection |
| `analysis_mixin.py` | **1,030** | Contingency analysis, action enrichment, MW computation |
| `simulation_mixin.py` | **984** | Manual action simulation, superposition |
| `sanitize.py` | **40** | JSON serialization utility |

All imports re-exported for backward compatibility. `RecommenderService` inherits from `DiagramMixin`, `AnalysisMixin`, `SimulationMixin`.

### 2.4 ~~Silent Exception Swallowing~~ ✅ FIXED

Replaced **15 bare `except Exception: pass`** patterns with `except Exception as e: logger.debug("Suppressed exception: %s", e)`.

### 2.5 ~~Debug Prints Instead of Logging~~ ✅ FIXED

Replaced **80+ bare `print()` calls** with Python `logging` module calls at appropriate levels (`logger.info`, `logger.warning`, `logger.debug`). Added `import logging` and `logger = logging.getLogger(__name__)` to all service modules.

---

## 3. High-Priority Issues

### 3.1 ~~Frontend: Oversized Components~~ ✅ FIXED

Split the four worst offenders into focused subcomponents:

| Original File | Before | After | Extracted Components |
|------|-------|-------|-------|
| `ActionFeed.tsx` | **1,406** | **796** | `ActionCard.tsx` (370), `ActionSearchDropdown.tsx` (486) |
| `VisualizationPanel.tsx` | **1,285** | **554** | `SldOverlay.tsx` (705), `MemoizedSvgContainer.tsx` (48) |
| `CombinedActionsModal.tsx` | **777** | **397** | `ComputedPairsTable.tsx` (145), `ExplorePairsTab.tsx` (380) |
| `useDiagrams.ts` | **767** | **693** | `useSldOverlay.ts` (107) |
| `App.tsx` | **758** | **758** | Orchestration hub — acceptable at boundary |

**ActionFeed.tsx** (−43%): `renderActionList` (280 lines of per-card rendering) extracted to `ActionCard`. The search dropdown with its score table, type filters, and search results (350+ lines) extracted to `ActionSearchDropdown`.

**VisualizationPanel.tsx** (−57%): The 680-line inline `SldOverlay` component (SLD delta coloring, highlight clones, pan/zoom) moved to its own file. `MemoizedSvgContainer` (SVG DOM injection wrapper) also extracted.

**CombinedActionsModal.tsx** (−49%): Computed pairs table and explore pairs tab (with selection chips, filter buttons, grouped table, and comparison card) each extracted to dedicated components.

**useDiagrams.ts** (−10%): SLD overlay state management (`fetchSldVariant`, `handleVlDoubleClick`, `handleOverlaySldTabChange`, `handleOverlayClose`) extracted to `useSldOverlay` hook.

**Test coverage for all extracted components:** 7 new test files added (106 tests), covering every extracted component and hook:

| Test File | Tests | Coverage |
|-----------|-------|---------|
| `ActionCard.test.tsx` | 25 | Severity badges, VIEWING state, star/reject, LS/RC/PST re-simulation, MW/tap inputs |
| `ActionSearchDropdown.test.tsx` | 14 | Type filters, search input, scored actions table, manual ID, loading/error states |
| `ComputedPairsTable.test.tsx` | 13 | Pair rendering, simulate/re-simulate, empty state, islanding, color coding |
| `ExplorePairsTab.test.tsx` | 21 | Selection chips, filter buttons, estimate/simulate workflow, comparison card, errors |
| `MemoizedSvgContainer.test.tsx` | 6 | String + SVGSVGElement injection, tab-specific IDs, display prop, perf logging |
| `SldOverlay.test.tsx` | 14 | Header, close/tab callbacks, mode indicator, loading/error, conditional tabs |
| `useSldOverlay.test.ts` | 13 | Hook init, vlOverlay state, fetchSldVariant success/error, interaction logging |

### 3.2 ~~Missing React Error Boundary~~ ✅ FIXED

Added `ErrorBoundary` class component at `frontend/src/components/ErrorBoundary.tsx` and wired it into `main.tsx` wrapping `<App />` inside `<StrictMode>`. The boundary:

- Catches render/lifecycle errors via `getDerivedStateFromError` + `componentDidCatch`
- Logs the error and React component stack to `console.error`
- Renders a styled fallback UI (`role="alert"`) with the error name/message, a collapsible `<details>` block containing the full stack trace, and two recovery actions:
  - **Try again** — resets boundary state (re-mounts the child tree)
  - **Reload page** — calls `window.location.reload()`
- Accepts an optional `fallback` prop to override the default UI

Covered by 7 new unit tests in `ErrorBoundary.test.tsx` (happy path, default fallback, custom fallback, console logging, reset, reload, details block). Total frontend test count is now 578 (was 571).

### 3.3 Python Type Hint Coverage — **Partially Fixed**

- `sanitize.py:sanitize_for_json` — typed as `Any → Any` (2026-04-20).
- FastAPI route handlers still return implicit `dict` — the return annotations
  are a good candidate for the next pass (would improve the auto-generated OpenAPI).

**Recommendation:** Add return type annotations to all FastAPI route handlers (also enables better auto-generated OpenAPI docs).

### 3.4 Weak TypeScript Typing Patterns

65 occurrences of `Record<string, unknown>` and `as unknown as` double-casts across the frontend, indicating the API response types aren't fully modeled:

- `ActionFeed.tsx`: 7 occurrences
- `api.ts`, `useDiagrams.ts`, `useSession.ts`: scattered throughout

These bypass TypeScript's type checking at integration boundaries.

**Recommendation:** Define typed API response interfaces in `types.ts` to replace `Record<string, unknown>` casts.

### 3.5 Accessibility Gaps

- No `aria-label` on icon/emoji buttons (ActionFeed, Header, OverloadPanel)
- No `aria-selected`/`aria-controls` on tab buttons (SettingsModal)
- No focus trapping in modals
- No semantic list markup (`<ul>`/`<li>`) for action lists
- No screen reader announcements for async operations

**Recommendation:** Audit against WCAG 2.1 AA; add aria attributes, semantic HTML, and focus management to modals.

---

## 4. Medium-Priority Issues

### 4.1 Standalone HTML Maintenance Burden

`standalone_interface.html` is **7,178 lines** — a complete duplicate of the React frontend in a single file. Every UI change must be manually mirrored. This is a significant ongoing maintenance cost and drift risk.

**Recommendation:** Consider deprecating or auto-generating from the React build.

### 4.2 Inconsistent API Response Formats

- Some endpoints: `{"status": "success", ...}`
- Others: direct data `{"branches": [...]}`
- Streaming endpoints: custom NDJSON error format
- Error responses: `HTTPException(detail=str(e))` leaks internal stack details

**Recommendation:** Standardize on a response envelope format and error schema across all endpoints.

### 4.3 ~~Hardcoded Configuration~~ Partially Fixed

CORS origins now configurable via `CORS_ALLOWED_ORIGINS` env var
(implemented at `main.py:174-184`; `.env.example` added 2026-04-20 as
a template). Remaining:

| Value | Location | Should Be |
|-------|----------|-----------|
| Port 8000, host 0.0.0.0 | `main.py` | Environment variable |
| `"Overflow_Graph"` directory | 5 locations in main.py | Config constant |
| Worsening thresholds | `recommender_service.py` | Config parameter |

**Recommendation:** Parameterize remaining values via environment variables or a central config object.

### 4.4 ~~Unused Dependencies~~ ✅ FIXED

`framer-motion` and `lucide-react` were removed from
`frontend/package.json` on 2026-04-20 — neither was imported in any
source file. The stale `GZipMiddleware` import in `main.py` was also
removed in the same pass.

### 4.5 ~~Incomplete Function~~ ✅ FIXED

`network_service.py:get_load_voltage_levels_bulk()` fell through to the
next function without a loop body. Implemented on 2026-04-20 to populate
`result` from `loads.loc[lid]['voltage_level_id']` — matching the sister
`get_generator_types_bulk()` pattern.

### 4.6 Code Duplication in Backend

- Voltage-level resolution logic repeated 4 times across `network_service.py`
- Action detail computation (`_compute_load_shedding_details`, `_compute_curtailment_details`, `_compute_pst_details`) share near-identical structure
- Try/except blocks for element voltage-level access repeated 5+ times

**Recommendation:** Extract shared patterns into helper functions.

### 4.7 ~~Frontend: Swallowed Errors in Async Code~~ ✅ FIXED

- `SettingsModal.tsx` — empty `.catch(() => { })` replaced with
  `.catch(err => console.error(...))` on the two config-file-path
  handlers (2026-04-20).
- `useSettings.ts:174,220` — already logs a warning via `console.warn`;
  the 2026-04-13 audit predated that change.
- `lines.pop()!` in NDJSON stream readers is safe: `String.split('\n')`
  always returns at least one element, so the non-null assertion does
  not mask a bug. No change needed.

---

## 5. Low-Priority / Housekeeping

| Item | Status |
|------|--------|
| Empty doc file `docs/proposals/rendering-lod-strategies.md` | ✅ Filled in (9.2 KB of consolidated LoD history) |
| Stale lockfile `.~lock.Cases_Defauts_10032026.odt#` | ✅ No longer present |
| Redundant CI (CircleCI + GitHub Actions) | Both kept for belt-and-braces; the new `code-quality` job runs in each |
| No `.env.example` | ✅ Added 2026-04-20 (CORS_ALLOWED_ORIGINS, PYPOWSYBL_FAST_MODE, LOG_LEVEL) |
| No Dockerfile | Still open |
| CLAUDE.md drift (missing root `test_*.py`) | ✅ Refreshed 2026-04-20 — now documents `scripts/` and the code-quality gate |
| Missing `.editorconfig` | ✅ Added 2026-04-20 |
| Missing `CONTRIBUTING.md` | ✅ Added 2026-04-20 (setup, tests, quality gate, commit conventions) |

---

## 6. Metrics Summary

Numbers below are produced by `scripts/code_quality_report.py` against
the current HEAD. Re-generate via
`python scripts/code_quality_report.py --markdown reports/code-quality.md`.

```
Backend (expert_backend/)
  Source files (non-test):     9 (added simulation_helpers.py)
  Total lines:                 5,491
  Largest module:              analysis_mixin.py (1,116 lines)
  Top 3 longest functions:
    run_analysis               169 lines
    update_config              166 lines
    simulate_manual_action     146 lines  (was 599 — split via helpers)
                               compute_superposition → 108 lines (was 285)
  print() calls in source:     0  (was 80+)
  traceback.print_exc() calls: 0  (was distributed across mixins)
  Silent except: pass:         0  (was 80+)
  Test files:                  41 (+ test_simulation_helpers.py with 66 tests)

Frontend (frontend/src/)
  Source files (non-test):     37
  Total lines:                 14,872
  Largest component:           utils/svgUtils.ts (1,807 lines — util, exempt)
  Test files:                  43
  Tests passing:               ≥ 578 (unchanged — still 7 new ErrorBoundary tests)
  TypeScript errors:           0
  Lint warnings:               0
  `any` types in source:       0
  `@ts-ignore` directives:     0
  `as unknown as` casts:       15
  `Record<string, unknown>`:   37 occurrences

Repository
  Standalone HTML (legacy):    ~7,100 lines (frozen snapshot only)
  Standalone HTML (built):     auto-generated from frontend/src/
  Documentation files:         17 in docs/
  CI pipelines:                3 jobs on each (test-backend, test-frontend,
                               code-quality) across CircleCI + GH Actions
```

## 6b. Continuous-Quality Tooling (new 2026-04-20)

Three shipped surfaces keep the metrics above honest over time:

1. **`scripts/code_quality_report.py`** — AST-walks the backend and
   globs the frontend source tree to emit a JSON + Markdown report.
   Uses `ast.parse` for backend counts so strings / docstrings with
   `print(` inside them are not flagged (exactly the case of the
   tkinter subprocess script in `main.py`).

2. **`scripts/check_code_quality.py`** — the PR gate. Encodes the
   current reductions as hard ceilings:

   | Metric | Ceiling |
   |--------|---------|
   | `print(` calls in backend sources | 0 |
   | `traceback.print_exc()` calls in backend | 0 |
   | `except Exception: pass` (silent) | 0 |
   | Backend module LoC | 1,200 |
   | Frontend component LoC (non-App, non-util) | 1,500 |
   | Frontend util LoC (`frontend/src/utils/*`) | 2,000 |
   | `any` in frontend source | 0 |
   | `@ts-ignore` in frontend source | 0 |

   Ceilings are intentionally tight — lowering them is how we lock in
   future improvements; raising them requires a documented reason.

3. **Ruff** — light pyflakes + syntax ruleset (`E9`, `F`) configured
   in `pyproject.toml`. Catches undefined names (found a latent
   `RecommenderService` self-reference in `simulation_mixin.py` on
   the first run — now fixed) and unused imports. Stylistic rules
   (`W`, `B`, `UP`) are deliberately off today; they can be opted in
   per-file as we clean up.

**CI wiring:**
- `.github/workflows/code-quality.yml` — runs `ruff`, the gate, the
  reporter unit tests, and uploads `reports/` as an artifact.
- `.circleci/config.yml` — mirrors the above under a `code-quality`
  job added to the `test-workflow` workflow.
- `pytest.ini` — includes `scripts/test_code_quality_report.py` so
  the gate logic has its own unit-test coverage (7 tests).

---

## 7. Prioritized Recommendations

### ~~Immediate (High Risk)~~ ✅ ALL DONE

1. ~~**Fix path traversal**~~ ✅ `_validate_path_within()` added to session save/load; PDF copy restricted
2. ~~**Refactor `recommender_service.py`**~~ ✅ Split into 5 modules via mixin architecture
3. ~~**Replace silent exceptions**~~ ✅ 80+ print→logger, 15 bare except→logged
4. ~~**Add a React Error Boundary**~~ ✅ `ErrorBoundary` wraps `<App />` in `main.tsx` with styled fallback + recovery buttons

### Short-Term (High Value)

5. ~~**Split `ActionFeed.tsx`** into subcomponents~~ ✅ Extracted `ActionCard`, `ActionSearchDropdown`; also split `VisualizationPanel` (→ `SldOverlay`, `MemoizedSvgContainer`), `CombinedActionsModal` (→ `ComputedPairsTable`, `ExplorePairsTab`), and `useDiagrams` (→ `useSldOverlay`)
6. **Add return type annotations** to all FastAPI route handlers
7. **Define typed API response interfaces** in `types.ts` to eliminate `Record<string, unknown>` casts (37 remaining; down from 65)
8. ~~**Remove unused deps**~~ ✅ Completed 2026-04-20: `framer-motion` and `lucide-react` dropped; `GZipMiddleware` import cleaned.

### Medium-Term (Improvement)

9. ~~**Parameterize hardcoded values**~~ Partially done: CORS origins configurable; port/host still hardcoded; `.env.example` template added 2026-04-20
10. **Standardize API response formats** across all endpoints
11. **Add accessibility attributes** (aria-labels, semantic HTML, focus trapping)
12. ~~**Consolidate CI** to a single pipeline~~ Decision reversed: both pipelines kept intentionally (cross-platform coverage). Each runs the new `code-quality` job.

### Long-Term (Strategic)

13. ~~**Deprecate or auto-generate `standalone_interface.html`**~~ ✅ Shipped as the 0.6.0 release (see `build:standalone` and the `dist-standalone` bundle). Legacy file frozen as `standalone_interface_legacy.html`.
14. **Add Python dependency lockfile** (Poetry or uv) for reproducible builds
15. **Add accessibility testing** (jest-axe or similar)

---

## 8. Bugs Found & Fixed During This Audit

Beyond the planned quality improvements, the audit uncovered and fixed several production bugs:

### 8.1 Second Contingency Crash (`content=None`) ✅ FIXED

Auto-generated `disco_` actions had no `content` field. The library's rule validator crashed on `content.get("set_bus", {})` during the second contingency analysis. Also fixed: `simulate_manual_action` merge logic used truthiness check (`if content:`) instead of `is not None`, preventing empty dicts from replacing stale `None`.

### 8.2 N-1 Auto-Zoom Lost on Second Contingency ✅ FIXED

`clearContingencyState()` reset `activeTab` to `'n'`, causing the auto-zoom guard (`branchChanged && activeTab === 'n'`) to skip zoom. Fixed in both `standalone_interface.html` and `App.tsx` — tab reset now only in `resetAllState` (full network reload).

### 8.3 `min_renewable_curtailment_actions` Not Saved ✅ FIXED

The standalone's user-config persist effect was missing `min_renewable_curtailment_actions` from the POST body. Also added the field to `config.default.json`. Added 17 regression tests verifying config save parity.

### 8.4 `PYPOWSYBL_FAST_MODE` Silently Overridden in Tests ✅ FIXED

The `conftest.py` `reset_config` fixture unconditionally re-applied `PYPOWSYBL_FAST_MODE=True`, overriding test modules' intentional `False` setting. This caused AC load flow to produce wrong reactive power values for PST combined actions (~110% instead of ~94%).

### 8.5 `RecommenderService._build_action_entry_from_topology` NameError ✅ FIXED

`simulation_mixin.py` called `RecommenderService._build_action_entry_from_topology(...)` without importing `RecommenderService`. The best-effort topology-reconstruction branch would have raised `NameError` at runtime if ever taken. Surfaced by the new ruff `F821` rule on 2026-04-20; fixed by switching to `self._build_action_entry_from_topology(...)` (the staticmethod lives on `SimulationMixin`, which `self` already is).

### 8.6 `get_load_voltage_levels_bulk` Incomplete ✅ FIXED

`network_service.py:get_load_voltage_levels_bulk()` fell through to the next function definition with an unclosed loop body. Implemented 2026-04-20 by mirroring the pattern of `get_generator_types_bulk()`.

---

## 9. Delta — 2026-04-20

One-pass sweep to land continuous reporting and close remaining
housekeeping issues. Scope:

- **Added**: `scripts/code_quality_report.py` (AST-based metrics
  dump, JSON + Markdown output) and `scripts/check_code_quality.py`
  (CI gate with per-metric thresholds).
- **Added**: `scripts/test_code_quality_report.py` — 7 unit tests
  covering the AST smell-walker (print in string literals not
  flagged, logged except not silent, etc.). Collected by
  `pytest.ini`.
- **Added**: ruff configuration in `pyproject.toml` (F, E9) +
  per-file ignores for tests/scripts; optional `[quality]` extra
  that pulls `ruff` + `radon`.
- **Added**: `.github/workflows/code-quality.yml` +
  `code-quality` CircleCI job — runs ruff, the gate, the reporter
  unit tests, and uploads `reports/` as a CI artifact.
- **Added**: `CONTRIBUTING.md`, `.editorconfig`, `.env.example` —
  all referenced from `CLAUDE.md`.
- **Fixed bugs surfaced by the new tooling**:
  - `RecommenderService._build_action_entry_from_topology(...)`
    self-reference (F821) in `simulation_mixin.py`.
  - `get_load_voltage_levels_bulk()` empty-body bug.
  - Redundant shadowed imports (`io`, `threading`, `time`, and
    `run_analysis_step2`) in `analysis_mixin.py` / `diagram_mixin.py`.
  - 9 auto-fixed `F541` (f-strings without placeholders).
  - Stray `.catch(() => {})` in `SettingsModal.tsx` replaced with
    `console.error` logging.
  - `traceback.print_exc()` in `analysis_mixin.py` converted to
    `logger.exception(...)`; stray `except Exception: pass` swapped
    for a logged suppression.
- **Removed**: unused frontend dependencies (`framer-motion`,
  `lucide-react`) and the unused `GZipMiddleware` import.
- **Refreshed**: root `CLAUDE.md` — removed references to
  root-level `test_*.py` scripts that no longer exist, added the
  `code-quality` workflow to the Notes section, and pointed at
  `CONTRIBUTING.md`.

Expected CI behaviour after the sweep: the new `code-quality` job is
green at current HEAD, and any regression (new `print(`, new module
crossing the ceiling, new `any` in frontend source, &c.) fails the
job with a prescriptive message.

---

## 10. Delta — 2026-04-20 (follow-up: function decomposition)

Second pass targeted at the two longest functions flagged in §6 by the
continuous reporter:

| Function | Before | After | Lever |
|----------|--------|-------|-------|
| `simulate_manual_action` | 599 | **146** | 12 private helpers + 11 helpers in new `simulation_helpers.py` |
| `compute_superposition` | 285 | **108** | 5 private helpers (pair-simulate / identify-with-PST-fallback / care-mask / metrics / diagnostics) |

The new stateless module `expert_backend/services/simulation_helpers.py`
(403 LoC) owns the pieces that don't need `self`:
`canonicalize_action_id`, `compute_reduction_setpoint`,
`parse_pst_tap_id` + `clamp_tap`, `classify_action_content`,
`is_pst_action` + `pst_fallback_line_idxs`, `build_care_mask`,
`resolve_lines_overloaded`, `compute_action_metrics`,
`extract_action_topology`, `serialize_action_result`,
`normalise_non_convergence`, `build_combined_description`, and
`compute_combined_rho`.

Coverage: 66 focused unit tests in
`expert_backend/tests/test_simulation_helpers.py` — one test class per
helper, exercising edge cases that previously lived as implicit
branches inside the god-method (islanding, PST-tap-only topologies,
heuristic power-reduction fallback, pre-existing overload exclusion,
combined-pair description building, sign-preserving rho superposition).

Test surface: the 130 existing simulation + superposition tests
continue to pass (same mocks, same call order). The extraction is
behaviour-preserving — helpers were pulled from the method body
verbatim wherever possible.

Next candidates (see §6 metrics): `run_analysis` (169 lines),
`update_config` (166 lines), `_enrich_actions` (125 lines).

---

## 11. Delta — 2026-04-20 (follow-up: frontend svgUtils decomposition)

Third pass targeted at the largest frontend file flagged in §6 — the
1807-line `frontend/src/utils/svgUtils.ts` omnibus. Split into
focused modules under `frontend/src/utils/svg/`:

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `idMap.ts` | 29 | Cached DOM-id map for an SVG container |
| `svgBoost.ts` | 122 | Dynamic font/node scaling for large grids; `processSvg` |
| `metadataIndex.ts` | 40 | Build the `MetadataIndex` from pypowsybl metadata |
| `highlights.ts` | 422 | Overloaded / action-target / contingency halos; line & VL resolution |
| `deltaVisuals.ts` | 137 | Delta flow coloring + text replacement |
| `actionPinData.ts` | 344 | Pin descriptors, severity palette, anchor resolution — pure / no DOM |
| `actionPinRender.ts` | 537 | DOM injection for pins, highlights, click semantics, scale math |
| `fitRect.ts` | 125 | Padded viewBox computation for action overview + focused zoom |

`svgUtils.ts` itself is now a **60-line barrel** that re-exports every
symbol — no caller had to change. Largest frontend file is now
`App.tsx` at 1370 lines (the state orchestration hub, which is exempt
from the component size ceiling by design).

### New helpers promoted to the public API

Five pieces that used to be inline / closure-scoped are now exported
as standalone pure functions — making them unit-testable and reusable:

- `formatPinLabel(details)` — percentage / DIV / ISL / em-dash
- `formatPinTitle(idLabel, details)` — hover tooltip
- `fanOutColocatedPins(pins)` — circular distribution for colocated pins
- `curveMidpoint(p1, p2)` — quadratic Bezier midpoint + control point
- `computePinScale(baseR, pxPerSvgUnit, viewBoxMax)` — pin scale math

### Coverage

Five new co-located test files (61 new tests) covering each module in
isolation:

| Test file | Tests |
|-----------|-------|
| `idMap.test.ts` | 5 |
| `svgBoost.test.ts` | 7 |
| `metadataIndex.test.ts` | 6 |
| `actionPinData.test.ts` | 19 |
| `actionPinRender.test.ts` | 12 |
| `fitRect.test.ts` | 12 |

The pre-existing `svgUtils.test.ts` (144 tests) continues to pass
unchanged — the refactor is behaviour-preserving. Full frontend
suite: **1000 tests, all green**.

---

## 12. Delta — 2026-04-21 (follow-up: analysis_mixin decomposition)

Fourth pass targeted at the 1,116-line `analysis_mixin.py` — the
largest backend file. Split into four focused modules under a new
`expert_backend/services/analysis/` package:

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `pdf_watcher.py` | 43 | Glob + mtime search for overflow PDFs |
| `action_enrichment.py` | 389 | Load-shedding / curtailment / PST details, renewable detection, rho scaling, topology extraction, non-convergence normalisation — pure |
| `mw_start_scoring.py` | 341 | MW-at-start dispatcher + per-type math (load shedding, curtailment, line disco, PST, open coupling) — pure |
| `analysis_runner.py` | 193 | Legacy AC→DC fallback worker + PDF-polling generator + `derive_analysis_message` |

`analysis_mixin.py` shrank **1,116 → 509 lines**. The three public
entry points (`run_analysis_step1`, `run_analysis_step2`, `run_analysis`)
are now thin orchestrators plus `_enrich_actions` /
`_compute_mw_start_for_scores` iterators that delegate to the
stateless helpers.

### Dependency injection instead of monkey patching

Two call sites rely on module-level library references that tests
traditionally `@patch`:

- `expert_backend.services.analysis_mixin.get_virtual_line_flow`
  (used by `mw_start_open_coupling`)
- `expert_backend.services.analysis_mixin.run_analysis` (used by
  the legacy worker)

Both helpers now accept the callable as an optional keyword argument.
The mixin reads the module-level name at call time and threads it in,
so existing `@patch('expert_backend.services.analysis_mixin.*')`
tests keep working without modification.

### Coverage

- **68 new unit tests** in `expert_backend/tests/test_analysis_helpers.py`
  covering every new helper in isolation (pdf_watcher, non-convergence
  normalisation, lines-overloaded reconstruction, load-shedding /
  curtailment / PST details, MW-start dispatcher, analysis-message
  derivation, …).
- **All 410 pre-existing analysis / simulation tests** continue to
  pass — baseline diffed against post-refactor and showed zero new
  regressions (same 19 pre-existing test-pollution failures on both
  sides).
- Quality gate green; ruff (E9/F) clean.

### Top-5 longest functions after the pass

```
update_config             166
simulate_manual_action    146
compute_superposition     112
get_action_variant_sld     97
_compute_deltas            92
```

`run_analysis` (was 169 lines) and `_enrich_actions` (was 125 lines)
both fell out of the top-5. Next candidates: `update_config`,
`get_action_variant_sld`, `_compute_deltas`.

---

## 13. Delta — 2026-04-21 (follow-up: diagram_mixin decomposition)

Fifth pass targeted at `diagram_mixin.py` — the second-largest
backend file after the analysis sweep. Split into seven focused
modules under a new `expert_backend/services/diagram/` package:

| Module | Lines | Responsibility |
|--------|------:|----------------|
| `__init__.py` | 22 | Package docstring + module index |
| `layout_cache.py` | 63 | `(path, mtime)`-keyed ``grid_layout.json`` loader |
| `nad_params.py` | 41 | Default ``NadParameters`` factory (perf-tuned) |
| `nad_render.py` | 89 | ``generate_diagram`` + NaN element stripping |
| `sld_render.py` | 36 | SLD SVG + metadata extraction with fallbacks |
| `overloads.py` | 131 | Overload filtering + per-element current scans |
| `flows.py` | 67 | Branch + asset flow extractors (vectorised) |
| `deltas.py` | 241 | Terminal-aware flow-delta math (pure) |

`diagram_mixin.py` shrank **974 → 469 lines**. Every public method
(`get_network_diagram`, `get_n1_diagram`, `get_action_variant_diagram`,
`get_n_sld`, `get_n1_sld`, `get_action_variant_sld`) is now a short
orchestrator that switches the right variant, calls the stateless
helpers, and stashes results. Five new private helpers isolate the
variant-switching patterns that previously repeated across methods:

- `_require_action(action_id)` — validate + fetch the action entry
- `_lf_status_for_variant(...)` — load-flow status with variant cache
- `_snapshot_n1_state(...)` — N-1 branch + asset flows with variant restore
- `_attach_flow_deltas_vs_base(...)` — populate `flow_deltas` / `asset_deltas` on a diagram
- `_attach_convergence_from_obs(...)` — copy `lf_converged` / `non_convergence` from an observation
- `_diff_switches(...)` — `{switch_id: {from_open, to_open}}` diff between variants

### Coverage

- **39 new unit tests** in `expert_backend/tests/test_diagram_helpers.py`
  covering every helper in isolation (layout cache eviction, NaN
  stripping, overload filtering with N-state exclusion, terminal-aware
  delta math with direction-flip, vectorised equivalent against scalar
  reference, asset-delta categorisation, …).
- **1,000+ diagram-side test assertions** across the existing suite
  continue to pass. One edge case (`test_sld_highlight.py::
  TestChangedSwitchesInSld`) uncovered a subtle ordering dependency
  — `changed_switches` must be captured BEFORE attempting flow
  extraction so a mock network with missing flows still returns the
  switch diff. Fixed in the orchestrator and regression-pinned.
- Full-suite diff against pre-refactor baseline: **identical 19
  pre-existing test-pollution failures on both sides, zero new
  regressions.**
- Quality gate green, ruff (E9/F) clean.

### Top-5 longest functions after the pass

```
update_config                 166
simulate_manual_action        146
compute_superposition         112
compute_action_metrics         87
_augment_superposition_result  81
```

Every diagram-related function fell out of the top-5. Next natural
candidates: `update_config` (orchestrator in
`recommender_service.py`), then the simulation helpers.

---

## 14. Delta — 2026-05-05 (post-0.7.0 review)

Quality review covering the **104 commits across 16 PRs (#105–#131)**
landed on top of 0.6.5, headlined by the 0.7.0 release: interactive
overflow analysis (PRs #116, #122–#127), PyPSA-EUR European-wide grid
(PRs #112, #117), design-token migration (PR #120), tiered notice
system (PR #122), progressive-disclosure ActionCard (PR #121), VL-names
toggle (PR #118), and the overflow-pin layer pipeline (PRs #128–#131).

### 14.1 Quality gate — still green

`python scripts/check_code_quality.py` exits 0 at HEAD. Every
hard ceiling holds:

| Metric | Ceiling | HEAD |
|--------|---------|------|
| `print(` calls in backend sources | 0 | **0** |
| `traceback.print_exc()` | 0 | **0** |
| Silent `except Exception: pass` | 0 | **0** |
| Backend module LoC | 1200 | **1115** (`diagram_mixin.py`) |
| Frontend component LoC | 1500 | **1342** (`VisualizationPanel.tsx`) |
| Frontend util LoC | 2000 | **1807** (`utils/svgUtils.ts` — exempt barrel) |
| `any` in frontend source | 0 | **0** |
| `@ts-ignore` directives | 0 | **0** |
| Hex literals outside `tokens.{css,ts}` | 0 | **0** ← **NEW gate** (PR #120) |

The hex-literal ceiling (`FRONTEND_HEX_LITERAL_MAX = 0`) is the most
significant gate addition since the last review. Every colour in the
React source now flows through `frontend/src/styles/tokens.{css,ts}`.

### 14.2 Metrics summary (HEAD vs 2026-04-21 baseline)

```
Backend (expert_backend/)
  Source files (non-test):     24    (was 9   — +5 services + 11 helpers in subpackages)
  Total lines:                 8,931 (was 5,491 — +63 %)
  Largest module:              diagram_mixin.py (1,115 lines, ~7 % under ceiling)
  Test files:                  48    (was 41)

Frontend (frontend/src/)
  Source files (non-test):     62    (was 37)
  Total lines:                 19,180 (was 14,872 — +29 %)
  Largest component:           App.tsx (1,399 lines, exempt) ; VisualizationPanel
                               1,342 (active under 1,500 ceiling, ex-1,654 pre-extraction)
  Test files:                  59    (was 43)
  any types / @ts-ignore:      0 / 0
  `as unknown as` casts:       18    (was 15)  ← +3 regression
  `Record<string, unknown>`:   39    (was 37)  ← +2 regression
  Hex literals (non-token):    0     (was uncounted; PR #120 zeroed it)
```

Backend and frontend each grew ~30–60 % in raw LoC, driven entirely
by net-new feature surface (overflow viewer overlay, design-token
migration, NoticesPanel, DiagramLegend, action-pin pipeline). No
existing module crossed its ceiling; the few that came close
(`VisualizationPanel.tsx`) were proactively decomposed to stay
under the gate.

### 14.3 Top-5 longest functions

```
expert_backend/services/overflow_overlay.py
  _build_overlay_block                          832    (template f-string — see §14.4)
expert_backend/services/analysis/overflow_geo_transform.py
  transform_html                                290
expert_backend/services/diagram_mixin.py
  get_action_variant_diagram_patch              259
expert_backend/services/simulation_mixin.py
  simulate_manual_action                        186    (was 146 — +40 from inlined reco_)
expert_backend/services/recommender_service.py
  update_config                                 184    (was 166 — +18; new overflow config)
```

`simulate_manual_action` and `update_config` both grew between
deltas (vs. §6 baseline of 146 / 166). Both still well below the
function-level threshold the gate enforces today (the gate is on
*module* size, not function size), but they're trending up. Worth a
defensive pass before the next release if either crosses 200 lines.

### 14.4 New large module: `services/overflow_overlay.py` (950 LoC)

PR #116 added the iframe overlay injector that grafts the
Co-Study4Grid pin layer + filter chips onto the upstream
`alphaDeesp/core/interactive_html.py` viewer. The module is 950 lines
total but the body is **one 832-line f-string** producing the
`<style>…</style><script>…</script>` block injected before the iframe
`</body>`. AST sees it as a single function (`_build_overlay_block`);
in practice it is template content, not control flow.

**Trade-off accepted:** the alternative would be a separate `.css` +
`.js` asset served alongside the iframe, but the f-string keeps the
overlay self-contained and matches how the upstream HTML is shipped
(everything inlined). Code-quality gate passes (the module is below
the 1,200-line backend ceiling; the function-size threshold isn't
gated). **Action item:** if the overlay grows further, consider
extracting the static CSS / JS to sibling files and `Path.read_text()`
them in. Coverage is provided indirectly by
`utils/svg/overflowOverlayRender.test.ts` and the iframe smoke tests
in `expert_backend/tests/test_overflow_html_dim_logic.py`.

### 14.5 Architecture additions since 2026-04-21

#### Backend
- `services/overflow_overlay.py` — pin / filter overlay injector
  for the interactive HTML viewer.
- `services/analysis/overflow_geo_transform.py` — pure lxml
  transform repositioning hierarchical-layout SVG to geo coords for
  the `/api/regenerate-overflow-graph` toggle.
- New endpoint `/api/regenerate-overflow-graph` and
  `/api/voltage-level-substations`.

#### Frontend
- `src/styles/tokens.{css,ts}` — design-token palette (colours,
  spacing, typography, radius) consumed everywhere; gate enforces
  no hex literals outside these two files.
- New components: `NoticesPanel`, `DiagramLegend`,
  `InspectSearchField`, `DetachedPlaceholder`, `ActionCardPopover`,
  `ActionTypeFilterChips`, `AppSidebar`, `SidebarSummary`,
  `StatusToasts`.
- New hook: `useOverflowIframe.ts` — owns the iframe lifecycle,
  layer-toggle state, layout-mode toggle, postMessage bridge, and
  pin overlay payload computation; extracted from
  `VisualizationPanel.tsx` to bring it back under the 1,500-line
  ceiling (1,654 → 1,342).
- New SVG utils: `utils/svg/vlTitles.ts`,
  `utils/svg/overflowPinPayload.ts`,
  `utils/svg/overflowOverlayRender.ts`, `utils/svg/pinGlyph.{js,ts}`.

### 14.6 Documentation freshness

- `CHANGELOG.md` — current. 0.7.0 entry comprehensive (PR-by-PR
  attribution).
- `README.md` — current. Already references 0.7.0, design tokens,
  interactive overflow, PyPSA-EUR, ~1000 specs.
- Root `CLAUDE.md` — **drift fixed in this pass**: bumped the
  changelog reference from 0.6.5 to 0.7.0; added
  `overflow_overlay.py` and `overflow_geo_transform.py` to the
  backend tree; added `styles/tokens.{css,ts}`,
  `components/NoticesPanel`, `DiagramLegend`, `InspectSearchField`,
  `DetachedPlaceholder`, `ActionCardPopover`, `useOverflowIframe`,
  and the new svg utils to the frontend tree; added
  `/api/regenerate-overflow-graph` and
  `/api/voltage-level-substations` to the API table.
- `expert_backend/CLAUDE.md` — listed `overflow_overlay.py` in this
  pass; the rest was already current (overflow_geo_transform was
  already documented in §"Analysis").
- `frontend/CLAUDE.md` — already documents the design-token rule
  (§"Code style"). No drift.

### 14.7 Concerns and recommendations

#### Open

1. **Function-level size drift**: `simulate_manual_action` (146 →
   186) and `update_config` (166 → 184) both grew. Add a
   function-line ceiling (e.g. 250) to the gate to lock in the
   April decompositions; this prevents inline-feature bloat from
   eroding them. Low effort, high value.

2. **`as unknown as` and `Record<string, unknown>` regressions**:
   +3 and +2 occurrences respectively since April. Origin: new
   overflow-iframe payload glue (postMessage bridge, layer-toggle
   payload). These are at integration boundaries (iframe
   ↔ React) so they're *defensible*, but the trend is unhealthy.
   Define typed message-payload interfaces in `types.ts` for the
   `cs4g:overflow-*` postMessage envelope.

3. **`_build_overlay_block` (832 lines)**: see §14.4. Acceptable
   today, ratchet trigger for the next release if it grows.

4. **Function return-type annotations on FastAPI handlers** —
   carried over from §3.3. The OpenAPI schema would benefit; this
   is still the highest-leverage Python typing pass available.

#### Closed since last delta

- ~~Frontend hex-literal sprawl~~ ✅ design-token migration (PR #120)
  lands a zero-hex ceiling.
- ~~`VisualizationPanel.tsx` size pressure~~ ✅ extracted
  `InspectSearchField`, `DetachedPlaceholder`, and
  `useOverflowIframe` (1,654 → 1,342).
- ~~Manual graphviz install required for overflow viewer~~ ✅ PR #126
  auto-installs the `dot` binary cross-platform on package install.
- ~~Build extras vanished after PEP 621 migration~~ ✅ PR #127
  restored `[quality]` extras under `optional-dependencies`.

### 14.8 Suggested follow-ups for the next pass

1. ~~Add `FUNCTION_LOC_MAX = 250` to `check_code_quality.py`~~ ✅
   Landed in this pass — see §15.1.
2. ~~Type the `cs4g:overflow-*` postMessage envelope in `types.ts`~~
   ✅ Landed in this pass — see §15.2.
3. ~~Add return type annotations to all `@app.{get,post}` handlers
   in `main.py`~~ ✅ Landed in this pass — see §15.3.
4. If the overflow overlay grows again, split
   `_build_overlay_block` into sibling `overlay.css` / `overlay.js`
   files and inline at runtime via `Path.read_text()`. **Deferred
   until the overlay needs to grow** — exempt from the new
   function-LoC ceiling per §15.1.

---

## 15. Delta — 2026-05-05 (follow-up: §14.8 recommendations)

Three of the four §14.8 follow-ups landed in the same pass that
opened §14. The fourth (overlay split) is deferred per its own
trigger condition.

### 15.1 Function-LoC ceiling — backend gate

`scripts/check_code_quality.py` now enforces
``BACKEND_FUNCTION_MAX = 250``. Implementation details:

- ``code_quality_report.py`` was extended with
  ``extract_all_functions(path)`` returning every backend function
  with its LoC; the gate iterates the full list (was: top-5 only).
- The new ``BackendReport.all_functions`` field is populated for
  every scan and a focused unit test
  (``test_all_functions_populated``) guards the wiring.
- ``BACKEND_FUNCTION_EXEMPTIONS`` allows three pre-existing
  overruns through the gate:
  - ``services/overflow_overlay.py::_build_overlay_block`` (832
    lines — template f-string, not control flow; see §14.4).
  - ``services/analysis/overflow_geo_transform.py::transform_html``
    (290 lines — single-pass lxml transform).
  - ``services/diagram_mixin.py::get_action_variant_diagram_patch``
    (259 lines).

Trend-watch §14.7's list of drifting functions
(``simulate_manual_action`` 186, ``update_config`` 184) now have
a hard ceiling at 250: any growth past that fails the gate.

### 15.2 Typed postMessage envelope (frontend)

`frontend/src/types.ts` gained a discriminated-union envelope for
the iframe ↔ parent postMessage bridge between the React shell and
the interactive overflow viewer:

- ``IframeToParentMessage`` — covers
  ``cs4g:overlay-ready``, ``cs4g:pin-clicked``,
  ``cs4g:pin-double-clicked``,
  ``cs4g:overflow-unsimulated-pin-double-clicked``,
  ``cs4g:overflow-filter-changed``,
  ``cs4g:overflow-layer-toggled``,
  ``cs4g:overflow-select-all-layers``,
  ``cs4g:overflow-node-double-clicked``.
- ``ParentToIframeMessage`` — covers ``cs4g:pins`` and
  ``cs4g:filters``.
- ``OverflowIframeScreenRect`` — pin bounding rect in iframe
  coordinates.

`useOverflowIframe.ts` was migrated to:
- Validate inbound messages with a single ``isIframeMessage``
  guard, then narrow per-branch via ``switch (msg.type)``. Each
  case now accesses payload fields with full type safety (no
  ``typeof msg.x === 'string'`` runtime guards inline; the
  envelope union enforces them at compile time).
- Type the parent → iframe ``postMessage`` call sites against
  ``ParentToIframeMessage``, so an envelope-shape regression in
  ``services/overflow_overlay.py`` would surface as a TypeScript
  error here.

Side benefit: caught one unnecessary ``as unknown as ActionDetail``
in ``utils/svg/overflowPinPayload.ts:490`` (the stub object already
satisfied the required-fields contract). Dropped it in the same
pass; ``as unknown as`` count goes 18 → 17.

Future: when the overlay grows new message types, add a branch to
``IframeToParentMessage`` first; TypeScript's exhaustiveness check
then forces the consumer to handle it.

### 15.3 FastAPI handler return annotations

Every ``@app.{get,post,put}`` handler in ``expert_backend/main.py``
now carries a return-type annotation. Three categories:

- **JSON-returning handlers (19)** — ``-> dict``. Covers
  ``user-config``, ``config-file-path``, ``config``, ``branches``,
  ``voltage-levels``, ``nominal-voltages``,
  ``voltage-level-substations``, ``pick-path``, ``save-session``,
  ``list-sessions``, ``load-session``, ``restore-analysis-context``,
  ``run-analysis-step1``, ``regenerate-overflow-graph``,
  ``element-voltage-levels``, ``actions``,
  ``simulate-manual-action``, ``compute-superposition``,
  ``update_config``.
- **Per-endpoint-gzip handlers (10)** — ``-> Response``. Covers
  every diagram / SLD endpoint plus ``actions``: they all wrap
  ``_maybe_gzip_json`` / ``_maybe_gzip_svg_text`` which return
  ``Response``.
- **NDJSON streaming handlers (3)** — ``-> StreamingResponse``.
  Covers ``run-analysis``, ``run-analysis-step2``,
  ``simulate-and-variant-diagram``.

The pre-existing ``serve_overflow_artifact`` already had the
correct ``-> Response`` annotation.

OpenAPI consequence: ``GET /openapi.json`` now reflects the
return shapes for every handler. Useful for downstream
client-generation tooling.

### 15.4 Verification

- ``ruff check expert_backend`` — clean.
- ``python scripts/check_code_quality.py`` — green (modules,
  functions, hex literals, smells all under ceiling).
- ``python -m pytest scripts/test_code_quality_report.py`` —
  8 / 8 pass (one new test guards the function-list wiring).
- ``npx tsc --noEmit`` — no errors.
- ``npx vitest run`` — 1,260 / 1,260 pass.
- ``python -m pytest expert_backend/tests`` — 674 / 674 pass when
  the documented test-pollution failures are isolated (same 19
  pre-existing failures as the §13 baseline; no new regressions).

---

## 16. Delta — 2026-06-17 (0.8.0)

The 0.8.0 cycle broadened the feature surface (redispatch action
type, GST-estimable injection pairs, interactive SLD topology edit,
light/dark theme, Game Mode, the HuggingFace Docker deployment)
while keeping every ceiling green. The structural changes that
matter for this audit:

### 16.1 Diagram-mixin decomposition — landed

The §14.8 / §15.1 watch item on the diagram patch pipeline is
**resolved by extraction**, not by an exemption. ``diagram_mixin.py``
shed two helper packages:

- ``services/diagram/action_patch.py`` (new) — the entire
  ``/api/action-variant-diagram-patch`` pipeline (~510 LoC): the
  280-line ``get_action_variant_diagram_patch`` orchestrator, its
  three patch helpers (``compute_vl_topology_diff``,
  ``extract_vl_subtrees_with_edges``,
  ``get_disconnected_branches_from_snapshot``) and three private
  helpers. ``_compute_vl_topology_diff`` /
  ``_get_disconnected_branches_from_snapshot`` stay re-exported as
  static methods on ``DiagramMixin`` so ``test_diagram_patch_helpers.py``
  passes unchanged.
- ``services/diagram/obs_prewarm.py`` (new) — the post-contingency
  observation pre-warm helper (``build_prewarmed_obs``) that drives
  ``_cached_obs_n1`` so ``run_analysis_step1`` can skip the redundant
  load flow.

Result: ``diagram_mixin.py`` **1220 → 769 lines** (-451, 37 %), a
431-line buffer below the ``BACKEND_MODULE_MAX`` 1200 ceiling. The
``get_action_variant_diagram_patch`` ``BACKEND_FUNCTION_EXEMPTIONS``
entry from §15.1 moves with the function to the new module. New
coverage: ``test_obs_prewarm_for_step1.py`` (9 tests),
``test_action_patch_module.py`` (16 tests).

### 16.2 New frontend module — ``src/game/``

Game Mode (a timed, scored session wrapper) lands as a **self-
contained ``frontend/src/game/`` package** rather than as additions
to ``App.tsx``. It is **additive and inert unless ``?game=1``**: the
App integration is three ``gameBridge.isGameMode()``-guarded touch
points, so the orchestration hub stays at its existing altitude and
the analysis engine is untouched. The decoupling singleton
(``gameBridge``) mirrors the established ``interactionLogger`` pattern,
keeping the dependency direction one-way (game → App via a registered
loader, never App → game).

### 16.3 Surface growth held to the established patterns

The new capabilities reuse existing extension seams instead of
widening hot files:

- **Redispatch action type** threads through the same per-type
  dispatchers the other action families use
  (``mw_start_scoring.classify_action_type`` +
  ``mw_start_redispatch``, ``action_enrichment.compute_redispatch_details``,
  ``simulation_helpers.compute_redispatch_setpoint``) — no new
  god-function, each helper stays well under the 250-line ceiling.
- **Light / dark theme** is a **token swap, not per-component
  overrides**: it re-points the ``styles/tokens.{css,ts}`` custom
  properties, so the ``FRONTEND_HEX_LITERAL_MAX = 0`` rule (§14) keeps
  holding — no theme-specific hex literals leaked into components.
- **Recommender action-type restriction** is plumbed end-to-end
  (``useSettings`` → ``SettingsModal`` → ``POST /api/config`` →
  ``config.ALLOWED_ACTION_TYPES``) through the existing settings /
  save / reload / replay paths.

### 16.4 CI / supply-chain note

From 0.8.0 the backend test installs **track the latest published
``expert_op4grid_recommender``** (``>=0.2.4`` floor + ``--no-cache-dir``)
rather than a pinned version, so a fresh index resolves to the newest
release on every run (``.github/workflows/test.yml`` /
``.circleci/config.yml``); the ``Dockerfile`` pins the same floor to
keep the deployed recommender consistent with CI. The new HuggingFace
Docker deployment adds an **optional** same-origin SPA mount in
``main.py`` (``COSTUDY4GRID_FRONTEND_DIST``, mounted last, inert when
absent — local dev / the test suite are unaffected) and Git LFS
tracking for ``*.zip`` / ``*.png`` / ``*.jpg`` binaries (the Space git
endpoint rejects non-LFS binaries; the France 225/400 kV
``network.xiidm`` now ships compressed).

### 16.5 Verdict

No ceiling regressed; the one outstanding backend-module watch item
(the diagram patch pipeline) was retired by extraction. The feature
breadth of 0.8.0 was absorbed through existing decomposition,
token, and bridge patterns rather than by growing the hot files.



