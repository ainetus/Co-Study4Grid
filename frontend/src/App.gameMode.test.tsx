import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from './App';
import { gameBridge } from './game/gameBridge';
import type { GameStudy } from './game/types';
import type { UserConfig } from './api';

// Keep the App tree light — these presentational pieces are irrelevant to the
// config-propagation path under test (mirrors App.configUpload.test.tsx).
vi.mock('./components/VisualizationPanel', () => ({ default: () => <div data-testid="viz" /> }));
vi.mock('./components/ActionFeed', () => ({ default: () => <div /> }));
vi.mock('./components/OverloadPanel', () => ({ default: () => <div /> }));
vi.mock('./hooks/usePanZoom', () => ({ usePanZoom: () => ({ viewBox: null, setViewBox: vi.fn() }) }));
vi.mock('./utils/svgUtils', () => ({
  processSvg: (svg: string) => ({ svg, viewBox: { x: 0, y: 0, w: 100, h: 100 } }),
  buildMetadataIndex: () => null,
  applyOverloadedHighlights: vi.fn(),
  applyDeltaVisuals: vi.fn(),
  applyActionTargetHighlights: vi.fn(),
  applyContingencyHighlight: vi.fn(),
  getIdMap: () => new Map(),
  invalidateIdMapCache: vi.fn(),
  isCouplingAction: vi.fn(() => false),
  attachVlInteractions: vi.fn(() => () => {}),
}));

// The active persisted environment config (what `config_path.txt` points at —
// e.g. config_pypsa_eur_eur220_225_380_400.json). Crucially it carries
// `min_redispatch: 2` and a NETWORK PATH that differs from the study's, so the
// two assertions below are independent: the recommender minima must come from
// THIS config, while the network path must come from the study override.
const ENV_CONFIG: UserConfig = {
  network_path: 'data/active_env/network.xiidm',
  action_file_path: 'data/active_env/actions.json',
  layout_path: 'data/active_env/grid_layout.json',
  output_folder_path: '',
  lines_monitoring_path: '',
  min_line_reconnections: 2,
  min_close_coupling: 3,
  min_open_coupling: 2,
  min_line_disconnections: 3,
  min_pst: 1,
  min_load_shedding: 2,
  min_renewable_curtailment_actions: 2,
  min_redispatch: 2,
  allowed_action_types: [],
  n_prioritized_actions: 15,
  monitoring_factor: 0.95,
  pre_existing_overload_threshold: 0.02,
  ignore_reconnections: false,
  pypowsybl_fast_mode: true,
  model: 'expert',
  compute_overflow_graph: true,
};

const STUDY: GameStudy = {
  id: 'eu-pyrenees',
  label: 'Pyrenees (France / Spain) 225 kV — LANNEL61PRAGN',
  networkPath: 'data/pypsa_eur_eur220_225_380_400/network.xiidm',
  actionFilePath: 'data/pypsa_eur_eur220_225_380_400/actions.json',
  layoutPath: 'data/pypsa_eur_eur220_225_380_400/grid_layout.json',
  // Empty so loadGameStudy skips arming a contingency (no N-1 fetch needed —
  // this test is only about the /api/config payload).
  contingencyElementId: '',
};

// `getUserConfig` is deferred per-test so we can hold the config fetch open and
// reproduce the real race: GameShell mounts <App/> and fires the study loader
// BEFORE useSettings' async getUserConfig() effect has applied to state.
let resolveUserConfig: (cfg: UserConfig) => void;

const mockApi = vi.hoisted(() => ({
  getUserConfig: vi.fn(),
  getConfigFilePath: vi.fn().mockResolvedValue('/active/config.json'),
  saveUserConfig: vi.fn().mockResolvedValue({}),
  getModels: vi.fn().mockResolvedValue({ models: [] }),
  setRecommenderModel: vi.fn().mockResolvedValue({}),
  updateConfig: vi.fn().mockResolvedValue({ monitored_lines_count: 0, total_lines_count: 0 }),
  getBranches: vi.fn().mockResolvedValue({ branches: [], name_map: {} }),
  getVoltageLevels: vi.fn().mockResolvedValue({ voltage_levels: [], name_map: {} }),
  getNominalVoltages: vi.fn().mockResolvedValue({ mapping: {}, unique_kv: [] }),
  getVoltageLevelSubstations: vi.fn().mockResolvedValue({ mapping: {} }),
  getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
}));
vi.mock('./api', () => ({ api: mockApi }));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('Game Mode config propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Launch in game mode so App registers its study loader on the bridge.
    window.history.replaceState({}, '', '/?game=1');
    // Deferred — left pending until we choose to release it.
    mockApi.getUserConfig.mockReturnValue(
      new Promise<UserConfig>((res) => { resolveUserConfig = res; }),
    );
  });

  it('loadGameStudy sends the persisted env config minima (min_redispatch=2), not stale useSettings defaults, while the study path override still wins', async () => {
    render(<App />);

    // useSettings' mount effect is now blocked on the deferred getUserConfig,
    // so the recommender settings in component state are at their hardcoded
    // defaults (minRedispatch = 0, nPrioritizedActions = 10). App's game-mode
    // effect has synchronously registered the loader on the bridge.

    // Drive the study load WHILE the config fetch is still in flight. The
    // pre-fix code read `buildConfigRequest()` (stale state) here and posted
    // min_redispatch=0; the fix awaits the persisted config instead.
    let loadPromise!: Promise<void>;
    await act(async () => {
      loadPromise = gameBridge.loadStudy(STUDY);
      // let loadGameStudy run up to its `await api.getUserConfig()`
      await Promise.resolve();
    });

    // Suspended on the deferred config — nothing posted yet.
    expect(mockApi.updateConfig).not.toHaveBeenCalled();

    // Release the active environment config (the one carrying min_redispatch=2).
    await act(async () => {
      resolveUserConfig(ENV_CONFIG);
      await loadPromise;
    });

    expect(mockApi.updateConfig).toHaveBeenCalledTimes(1);
    const sent = mockApi.updateConfig.mock.calls[0][0];

    // Recommender settings come from the persisted env config — the regression:
    // these must NOT be the useSettings defaults (0 / [] / 10).
    expect(sent).toMatchObject({
      min_redispatch: 2,
      min_load_shedding: 2,
      min_renewable_curtailment_actions: 2,
      allowed_action_types: [],
      n_prioritized_actions: 15,
      model: 'expert',
    });

    // …but the network / action / layout PATHS are still overridden by the
    // study (they differ from the env config's own paths on purpose).
    expect(sent).toMatchObject({
      network_path: STUDY.networkPath,
      action_file_path: STUDY.actionFilePath,
      layout_path: STUDY.layoutPath,
    });
  });
});
