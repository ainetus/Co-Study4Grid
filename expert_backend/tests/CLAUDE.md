# Tests — Co-Study4Grid

## Overview

Co-Study4Grid has two test suites: **backend** (Python/pytest) and **frontend** (TypeScript/Vitest). Both run without the heavy domain packages (`pypowsybl`, `expert_op4grid_recommender`, `grid2op`) — a mock layer in `conftest.py` stubs them out.

## Running Tests

### Backend (pytest)

```bash
# From project root:
pytest                          # Run all backend tests
pytest expert_backend/tests/test_mw_start.py  # Single file
pytest -k "TestMwStart"         # By class/pattern
pytest -x                       # Stop on first failure
```

Configuration in `pytest.ini`:
- `testpaths = expert_backend/tests`
- `python_files = test_*.py`

### Frontend (Vitest)

```bash
cd frontend
npm run test                    # Run all frontend tests (Vitest)
npx vitest run                  # Non-interactive mode
npx vitest run src/components/ActionFeed.test.tsx  # Single file
```

Configuration in `frontend/vite.config.ts` (Vitest plugin).

## Backend Test Structure

### conftest.py — Shared Setup

- Installs mock modules for `pypowsybl`, `expert_op4grid_recommender`, and submodules into `sys.modules` (only when the real package is unavailable)
- Provides fixtures: `mock_network` (pypowsybl network with lines/transformers/VLs), `mock_network_service`, `recommender_service_instance`
- `reset_config` (autouse) — snapshots and restores `expert_op4grid_recommender.config` after each test

### Test Files by Domain

#### API & Service Layer
| File | Description |
|------|-------------|
| `test_api_endpoints.py` | FastAPI endpoint testing with TestClient and mocked services (covers the patch endpoints `/api/contingency-diagram-patch`, `/api/action-variant-diagram-patch`, `/api/simulate-and-variant-diagram`). |
| `test_recommender_service.py` | RecommenderService config updates and action enrichment |
| `test_network_service.py` | NetworkService initialization, loading, and element lookup |

#### Analysis & Simulation
| File | Description |
|------|-------------|
| `test_recommender_simulation.py` | Real data simulation with small test grid |
| `test_split_analysis.py` | Two-step analysis workflow (step1 overload detect, step2 resolve) |
| `test_combined_actions_integration.py` | Combined action workflow integration (incl. PR #114 LS/curtailment in combined pairs) |
| `test_combined_actions_scenario.py` | Real-world combined action scenarios |
| `test_stream_pdf_integration.py` | Streaming NDJSON + PDF event integration |
| `test_resimulate_regression.py` | Re-simulation correctness after action state changes |
| `test_second_contingency_reset.py` | Guards that switching contingency clears the prior N-1 variant cleanly |
| `test_get_n1_variant_clones_from_n_state.py` | `_get_n1_variant()` clones from the clean N baseline, never from a leftover action variant |

#### Load Shedding, Curtailment, PST
| File | Description |
|------|-------------|
| `test_power_reduction_format.py` | New `loads_p`/`gens_p` power reduction format + legacy `bus=-1` compat |
| `test_renewable_curtailment.py` | Curtailment detail computation and config updates |
| `test_manual_action_enrichment.py` | Manual action enrichment (topology, description, details) |
| `test_dynamic_actions.py` | On-the-fly action creation for `load_shedding_*`, `curtail_*`, `pst_*`, `reco_*` (PR #110) |
| `test_mw_start.py` | MW Start computation for scoring (line disco, PST, load shedding, open coupling) |
| `test_configurable_mw.py` | Configurable MW reduction thresholds |

#### Core Computation
| File | Description |
|------|-------------|
| `test_compute_deltas.py` | Power flow delta calculation with terminal-aware conventions |
| `test_sanitize.py` | JSON serialization of NumPy types |
| `test_overload_filtering.py` | Overload detection and line selection |
| `test_recommender_filtering.py` | Combined action filtering logic |

#### Monitoring & Network Analysis
| File | Description |
|------|-------------|
| `test_monitoring_consistency.py` | Monitoring parameter prioritization |
| `test_vectorized_monitoring.py` | Vectorized monitoring with masking and operational limits |
| `test_environment_detection.py` | Non-reconnectable element detection with analysis_date |

#### Superposition
| File | Description |
|------|-------------|
| `test_superposition_accuracy.py` | Superposition vs simulation discrepancy detection |
| `test_superposition_filtering_regression.py` | Max rho filtering for heavily loaded lines |
| `test_superposition_service.py` | On-demand superposition computation |
| `test_superposition_monitoring_consistency.py` | Monitoring alignment between estimation and simulation |
| `test_pst_combined_actions.py` | PST tap + combined action simulation, topology preservation, fast_mode protection |

#### PR #104 decomposition — extracted helper packages
| File | Description |
|------|-------------|
| `test_simulation_helpers.py` | 66 tests for the stateless helpers extracted from `simulate_manual_action` + `compute_superposition` |
| `test_analysis_helpers.py` | 68 tests for `services/analysis/` (MW-start, action enrichment, PDF watcher, analysis runner) |
| `test_diagram_helpers.py` | 39 tests for `services/diagram/` (layout cache, NAD params, NAD render, SLD render, overloads, flows, deltas) |
| `test_diagram_mixin.py` | Orchestrator-level coverage for `DiagramMixin` after the decomposition |
| `test_diagram_patch_helpers.py` | Patch-endpoint delta math (`/api/n1-diagram-patch`, `/api/action-variant-diagram-patch`) — PR #108. Drives the static-method wrappers on `DiagramMixin` (`_compute_vl_topology_diff`, `_get_disconnected_branches_from_snapshot`) that delegate to `services/diagram/action_patch.py`. |
| `test_action_patch_module.py` | New helpers introduced by the action-patch extraction: `_extract_convergence_status`, `_capture_action_snapshots`, `_unpatchable_response`, `extract_vl_subtrees_with_edges` (with the injected `generate_diagram` callable), plus `build_action_patch_payload` early-return contract (soft-fail when there's no analysis result or the action id is unknown). |
| `test_obs_prewarm_for_step1.py` | Post-contingency obs prewarm + reuse pipeline: `_cache_obs_for_variant` env-resolution + fallback, `RecommenderService.reset()` clears `_cached_obs_n1_elements`, `run_analysis_step1` forwards `prebuilt_obs_simu_defaut` on cache hit, omits it on miss / when `DO_RECO_MAINTENANCE=True`, falls back to slow path when the upstream library doesn't accept the kwarg. |
| `test_n1_diagram_fast_path.py` | Fast-path guards for the N-1 diagram pipeline |

#### Performance & Regression
| File | Description |
|------|-------------|
| `test_performance_budgets.py` | Benchmarks for large observations (2000+ lines) |
| `test_recommender_regressions.py` | MW calculation and curtailment robustness |
| `test_recommender_non_convergence.py` | Power flow convergence failure handling |

#### Infrastructure
| File | Description |
|------|-------------|
| `test_cache_synchronization.py` | Observation caching for N/N-1 calls |
| `test_islanding_mw_recommender.py` | Disconnected MW calculation on islanding |
| `test_early_pdf_reporting.py` | PDF event delivery before result event |
| `test_direct_file_loading.py` | Direct file loading configuration |
| `test_config_persistence.py` | Configuration file persistence |
| `test_sld_highlight.py` | SLD highlight and switch change computation |
| `test_sld_topology_edit.py` | Interactive SLD-edit feature — `extract_vl_switch_states` filters, auto-description for switch-only actions, `get_topology_preview_sld` (clones / applies / removes / restores), `_require_action` canonical-id alias, `/api/sld-topology-preview` HTTP-boundary (skipped when `expert_op4grid_recommender.models` is unavailable). See `docs/features/sld-topology-edit.md`. |

## Frontend Test Structure

Tests live next to their source file as `*.test.ts` / `*.test.tsx`.
Run `cd frontend && npm run test` for the full suite (~1000 specs as
of 0.6.5). Key test groups:

### App-level integration (`frontend/src/App.*.test.tsx`)

Six app-integration files split by domain: `App.contingency` (step1 →
step2 flow), `App.session` (save/reload), `App.settings`,
`App.stateManagement`, `App.datalist`, `App.import` (module-import
sanity).

### Components (`frontend/src/components/**/*.test.tsx`)

Every presentational component has a colocated test file —
`ActionCard`, `ActionCardPopover`, `ActionFeed`, `ActionOverviewDiagram`,
`ActionSearchDropdown`, `ActionTypeFilterChips`, `CombinedActionsModal`,
`ComputedPairsTable`, `DetachableTabHost`, `ErrorBoundary`,
`ExplorePairsTab`, `Header`, `MemoizedSvgContainer`, `OverloadPanel`,
`SldOverlay`, `VisualizationPanel`, plus the three modals
(`SettingsModal`, `ReloadSessionModal`, `ConfirmationDialog`).

### Hooks (`frontend/src/hooks/*.test.ts[x]`)

One test file per hook — `useActions`, `useAnalysis`, `useDetachedTabs`,
`useDiagramHighlights`, `useDiagrams`, `usePanZoom`, `useSession`,
`useSettings`, `useSldOverlay`, `useTiedTabsSync`. `useContingencyFetch` is
covered transitively by `useDiagrams` + the App-integration suite.

### Utilities (`frontend/src/utils/**/*.test.ts`)

| File | Description |
|------|-------------|
| `svgUtils.test.ts` | Barrel-level regression guards (halo layering, composite target detection, highlight ordering) |
| `svg/*.test.ts` | Unit tests for each PR #104 submodule (`idMap`, `metadataIndex`, `svgBoost`, `fitRect`, `actionPinData`, `actionPinRender`) |
| `svgPatch.test.ts` | DOM-recycling patch applier (PR #108): clone, dashed-class toggling, VL-subtree splicing, stale-response guard |
| `actionTypes.test.ts` | `classifyActionType` + `matchesActionTypeFilter` coverage |
| `sessionUtils.test.ts` | Session snapshot building + interaction-log serialization |
| `interactionLogger.test.ts` | Singleton event-log contract (sequence numbers, correlation IDs) |
| `mergeAnalysisResult.test.ts` | Step1+step2 field merging |
| `overloadHighlights.test.ts` | N-1 overload classification |
| `popoverPlacement.test.ts` | Pin-popover positioning |
| `fileRegistry.test.ts` | Structure-regression guard — fails if an expected source file disappears |
| `specConformance.test.ts` | Layer-4 spec contracts for interaction-log events |
| `userObservableInvariants.test.ts` | Runtime Vitest twin of `scripts/check_invariants.py` |

## Common Testing Patterns

### Backend
- **Heavy mocking**: `unittest.mock.MagicMock`, `@patch` decorators
- **Fixtures**: `@pytest.fixture` for service instances, environments, mock observations
- **MockAction class**: Simulates grid2op action objects with `loads_bus`, `gens_bus`, `loads_p`, `gens_p` attributes
- **Observation mocks**: NumPy arrays for `rho`, `load_p`, `gen_p`, `p_or` with `name_line`/`name_load`/`name_gen` lists
- **Pattern**: Create service -> inject mock context -> call method -> assert fields

### Frontend
- **Component testing**: React Testing Library (`render`, `screen`, `fireEvent`, `waitFor`)
- **Mock modules**: `vi.mock('../api')`, `vi.mock('../utils/svgUtils')`
- **Props-based**: Construct `defaultProps` -> override specific fields -> render -> assert DOM
- **Async assertions**: `await screen.findByText()` for dynamic content
- **Pattern**: Build props with test data -> `render(<Component {...props} />)` -> query DOM

## Key Data Structures in Tests

```typescript
// ActionTopology (frontend)
{ lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {},
  loads_p?: { LOAD_1: 0.0 }, gens_p?: { WIND_1: 0.0 } }

// LoadSheddingDetail
{ load_name: 'LOAD_1', voltage_level_id: 'VL_ALPHA', shedded_mw: 42.5 }

// CurtailmentDetail
{ gen_name: 'WIND_1', voltage_level_id: 'VL_WIND', curtailed_mw: 80.0 }
```

```python
# Backend action content — new power reduction format
{"set_load_p": {"LOAD_1": 0.0}}
{"set_gen_p": {"WIND_1": 0.0}}

# Backend action content — legacy bus disconnection format
{"set_bus": {"loads_id": {"LOAD_1": -1}}}
{"set_bus": {"generators_id": {"WIND_1": -1}}}

# Action topology (new format)
{"loads_p": {"LOAD_1": 0.0}, "gens_p": {"WIND_1": 0.0}}

# Action topology (legacy format)
{"loads_bus": {"LOAD_1": -1}, "gens_bus": {"WIND_1": -1}}
```

## Notes

- Backend tests run without `pypowsybl` or `expert_op4grid_recommender` installed — `conftest.py` stubs them
- Some integration tests (e.g., `test_recommender_simulation.py`, `test_stream_pdf_integration.py`) use real test data from the `expert_op4grid_recommender` package when available
- Frontend tests require `npm install` in the `frontend/` directory
- `expert_backend/test_backend.py` is an ad-hoc integration script that requires a running backend — it is NOT part of the pytest suite. Invoke directly with `python expert_backend/test_backend.py`.
- `scripts/pypsa_eur/` carries its own pytest coverage for the
  PyPSA-EUR → XIIDM pipeline (`test_build_pipeline.py`,
  `test_calibrate_thermal_limits.py`, `test_generate_n1_overloads.py`,
  `test_regenerate_grid_layout.py`). Run with `pytest scripts/pypsa_eur`.
- **Removed** (by PR #103 / PR #104): `test_ui_regressions.py` (its
  assertions targeted strings in the decommissioned
  `standalone_interface.html`; equivalent coverage now lives in the
  four parity scripts under `scripts/` and in the Vitest
  `userObservableInvariants.test.ts` + `specConformance.test.ts`
  files), and the frontend `standaloneInterface.test.ts` /
  `cssRegression.test.ts` files.
