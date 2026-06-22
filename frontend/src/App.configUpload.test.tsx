import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App';
import { useSettings } from './hooks/useSettings';
import type { UserConfig } from './api';

vi.mock('./components/VisualizationPanel', () => ({
  default: () => <div data-testid="viz" />,
}));
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

const mockApi = vi.hoisted(() => ({
  getUserConfig: vi.fn().mockResolvedValue({
    network_path: '/old/network.xiidm',
    action_file_path: '/old/actions.json',
    layout_path: '/old/layout.json',
    output_folder_path: '/old/sessions',
    lines_monitoring_path: '',
    min_line_reconnections: 2.0,
    min_close_coupling: 3.0,
    min_open_coupling: 2.0,
    min_line_disconnections: 3.0,
    min_pst: 1.0,
    n_prioritized_actions: 10,
    monitoring_factor: 0.95,
    pre_existing_overload_threshold: 0.02,
    ignore_reconnections: false,
    pypowsybl_fast_mode: true,
  }),
  saveUserConfig: vi.fn().mockResolvedValue({}),
  getConfigFilePath: vi.fn().mockResolvedValue('/old/config.json'),
  // KEY: mock returns a NEW config that is different from the initial.
  setConfigFilePath: vi.fn().mockResolvedValue({
    config_file_path: '/picked/new_config.json',
    config: {
      network_path: '/picked/new_network.xiidm',
      action_file_path: '/picked/new_actions.json',
      layout_path: '/picked/new_layout.json',
      output_folder_path: '/picked/new_sessions',
      lines_monitoring_path: '',
      min_line_reconnections: 2.0,
      min_close_coupling: 3.0,
      min_open_coupling: 2.0,
      min_line_disconnections: 3.0,
      min_pst: 1.0,
      n_prioritized_actions: 15,
      monitoring_factor: 0.95,
      pre_existing_overload_threshold: 0.02,
      ignore_reconnections: false,
      pypowsybl_fast_mode: true,
    },
  }),
  pickPath: vi.fn().mockResolvedValue('/picked/new_config.json'),
  updateConfig: vi.fn().mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 }),
  getBranches: vi.fn().mockResolvedValue({ branches: [], name_map: {} }),
  getVoltageLevels: vi.fn().mockResolvedValue({ voltage_levels: [], name_map: {} }),
  getNominalVoltages: vi.fn().mockResolvedValue({ mapping: {}, unique_kv: [] }),
  getVoltageLevelSubstations: vi.fn().mockResolvedValue({ mapping: {} }),
  getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  getN1Diagram: vi.fn(),
  runAnalysisStep1: vi.fn(),
  runAnalysisStep2Stream: vi.fn(),
  getActionVariantDiagram: vi.fn(),
  getNSld: vi.fn(),
  getN1Sld: vi.fn(),
  getActionVariantSld: vi.fn(),
}));
vi.mock('./api', () => ({ api: mockApi }));

afterEach(() => cleanup());

describe('Config upload state propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('updates network/action/layout/output/parameter inputs after picking a new config file', async () => {
    render(<App />);
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => { await userEvent.click(settingsBtn); });
    await waitFor(() => expect(screen.getByText('Apply')).toBeInTheDocument());

    const networkInput = screen.getByLabelText(/Network File Path/i) as HTMLInputElement;
    expect(networkInput.value).toBe('/old/network.xiidm');

    const configInput = screen.getByLabelText(/Config File Path/i) as HTMLInputElement;
    expect(configInput.value).toBe('/old/config.json');
    const configPickerBtn = configInput.parentElement!.querySelectorAll('button')[0] as HTMLButtonElement;
    await act(async () => { await userEvent.click(configPickerBtn); });

    await waitFor(() => expect(configInput.value).toBe('/picked/new_config.json'));

    expect(networkInput.value).toBe('/picked/new_network.xiidm');
    const actionInput = screen.getByLabelText(/Action Dictionary File Path/i) as HTMLInputElement;
    expect(actionInput.value).toBe('/picked/new_actions.json');
    const layoutInput = screen.getByLabelText(/Layout File Path/i) as HTMLInputElement;
    expect(layoutInput.value).toBe('/picked/new_layout.json');
    const outputInput = screen.getByPlaceholderText(/sessions/i) as HTMLInputElement;
    expect(outputInput.value).toBe('/picked/new_sessions');
  });

  it('updates inputs when user TYPES a new config path and blurs the input', async () => {
    render(<App />);
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => { await userEvent.click(settingsBtn); });
    await waitFor(() => expect(screen.getByText('Apply')).toBeInTheDocument());

    const configInput = screen.getByLabelText(/Config File Path/i) as HTMLInputElement;
    await act(async () => {
      await userEvent.clear(configInput);
      await userEvent.type(configInput, '/picked/new_config.json');
      // Trigger onBlur explicitly
      configInput.blur();
    });

    // Wait for the blur-triggered backend roundtrip + state updates
    await waitFor(() => {
      const networkInput = screen.getByLabelText(/Network File Path/i) as HTMLInputElement;
      expect(networkInput.value).toBe('/picked/new_network.xiidm');
    });
  });

  it('Load Study button drives updateConfig from React state when the config path is unchanged (handleLoadConfig parity)', async () => {
    // The stale-closure fix lives in two symmetrical call sites:
    // applySettingsImmediate AND handleLoadConfig. The 'typed but never
    // blurred' test below covers the path-CHANGED branch via Apply
    // Settings (where the bug actually surfaced). This test pins the
    // unchanged-path branch on the Load Study button so the
    // buildConfigRequest fallback in handleLoadConfig is also guarded.
    // Together they cover both arms of the freshlyLoadedCfg ternary.
    render(<App />);
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    mockApi.updateConfig.mockClear();
    mockApi.setConfigFilePath.mockClear();

    // Click Load Study without ever opening Settings → configFilePath
    // never changed, lastActive matches, freshlyLoadedCfg stays null,
    // buildConfigRequest() is what feeds updateConfig.
    await act(async () => { await userEvent.click(screen.getByText('🔄 Load Study')); });

    await waitFor(() => expect(mockApi.updateConfig).toHaveBeenCalled());
    expect(mockApi.setConfigFilePath).not.toHaveBeenCalled();
    expect(mockApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      network_path: '/old/network.xiidm',
      action_file_path: '/old/actions.json',
      layout_path: '/old/layout.json',
    }));
  });

  it('Apply Settings with UNCHANGED config path skips changeConfigFilePath and uses React state directly', async () => {
    // The fix added a `freshlyLoadedCfg` branch but kept buildConfigRequest()
    // as the fallback when the path didn't move. This test guards against
    // an over-eager refactor that always calls setConfigFilePath, which
    // would (a) make a needless backend round-trip on every Apply and
    // (b) re-apply localStorage state that the operator may have just
    // edited in place.
    render(<App />);
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    await act(async () => { await userEvent.click(screen.getByTitle('Settings')); });
    await waitFor(() => expect(screen.getByText('Apply')).toBeInTheDocument());

    // Edit a Recommender field but DO NOT touch the config-file path.
    await act(async () => { await userEvent.click(screen.getByText('Recommender')); });
    const minLineRecInput = screen.getByLabelText(/Min Line Reconnections/i) as HTMLInputElement;
    await act(async () => {
      await userEvent.clear(minLineRecInput);
      await userEvent.type(minLineRecInput, '4');
    });

    mockApi.setConfigFilePath.mockClear();
    mockApi.updateConfig.mockClear();

    await act(async () => { await userEvent.click(screen.getByText('Apply')); });

    await waitFor(() => expect(mockApi.updateConfig).toHaveBeenCalled());
    // Path didn't change → no setConfigFilePath round-trip.
    expect(mockApi.setConfigFilePath).not.toHaveBeenCalled();
    // updateConfig is fed by buildConfigRequest from current React state,
    // including the field the operator just edited.
    expect(mockApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      network_path: '/old/network.xiidm',
      min_line_reconnections: 4,
    }));
  });

  it('configRequestFromUserConfig falls back to safe defaults when the UserConfig is missing optional fields', async () => {
    // Hook-level unit test: drive `configRequestFromUserConfig` directly
    // with a stripped-down UserConfig (older pypowsybl-side configs
    // predate `layout_path` / `lines_monitoring_path`).
    // The helper MUST apply `?? ''` defaults so the
    // backend never receives `undefined` — otherwise FastAPI rejects
    // the body with a validation error and the operator's Apply
    // silently fails. Driving this from the integration test surface
    // is racy because input onBlur and Apply both call
    // `changeConfigFilePath`, and only one of them consumes the
    // mockResolvedValueOnce; a hook-level call is deterministic.
    const { result } = renderHook(() => useSettings());
    // Wait for the initial useEffect (`api.getUserConfig` + `api.getConfigFilePath`)
    // to resolve so the hook is in its post-mount steady state.
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    const partial: UserConfig = {
      network_path: '/picked/legacy_network.xiidm',
      action_file_path: '/picked/legacy_actions.json',
      // layout_path: missing on purpose
      // lines_monitoring_path: missing on purpose
      min_line_reconnections: 2,
      min_close_coupling: 3,
      min_open_coupling: 2,
      min_line_disconnections: 3,
      min_pst: 1,
      min_load_shedding: 0,
      min_renewable_curtailment_actions: 0,
      n_prioritized_actions: 10,
      monitoring_factor: 0.95,
      pre_existing_overload_threshold: 0.02,
      ignore_reconnections: false,
      pypowsybl_fast_mode: true,
    } as UserConfig;
    const req = result.current.configRequestFromUserConfig(partial);
    expect(req.network_path).toBe('/picked/legacy_network.xiidm');
    expect(req.action_file_path).toBe('/picked/legacy_actions.json');
    // Defaults — no `undefined` ever leaks past the helper.
    expect(req.layout_path).toBe('');
    expect(req.lines_monitoring_path).toBe('');
    // Required fields pass through verbatim.
    expect(req.min_line_reconnections).toBe(2);
    expect(req.monitoring_factor).toBe(0.95);
  });

  it('configRequestFromUserConfig preserves the provided values when they ARE present', async () => {
    // Companion to the partial-UserConfig test above. With a full
    // UserConfig the helper must be a faithful pass-through (no
    // defaults clobbering provided values).
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    const full: UserConfig = {
      network_path: '/picked/full_network.xiidm',
      action_file_path: '/picked/full_actions.json',
      layout_path: '/picked/full_layout.json',
      output_folder_path: '/picked/full_sessions',
      lines_monitoring_path: '/picked/full_monitoring.json',
      min_line_reconnections: 5,
      min_close_coupling: 6,
      min_open_coupling: 7,
      min_line_disconnections: 8,
      min_pst: 9,
      min_load_shedding: 10,
      min_renewable_curtailment_actions: 11,
      n_prioritized_actions: 42,
      monitoring_factor: 0.5,
      pre_existing_overload_threshold: 0.01,
      ignore_reconnections: true,
      pypowsybl_fast_mode: false,
    };
    const req = result.current.configRequestFromUserConfig(full);
    expect(req.layout_path).toBe('/picked/full_layout.json');
    expect(req.lines_monitoring_path).toBe('/picked/full_monitoring.json');
    expect(req.ignore_reconnections).toBe(true);
    expect(req.pypowsybl_fast_mode).toBe(false);
    expect(req.n_prioritized_actions).toBe(42);
  });

  it('config-file-input typed but never blurred: Apply still loads the new config and propagates it', async () => {
    render(<App />);
    await waitFor(() => expect(mockApi.getUserConfig).toHaveBeenCalled());

    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => { await userEvent.click(settingsBtn); });
    await waitFor(() => expect(screen.getByText('Apply')).toBeInTheDocument());

    const configInput = screen.getByLabelText(/Config File Path/i) as HTMLInputElement;
    await act(async () => {
      await userEvent.clear(configInput);
      await userEvent.type(configInput, '/picked/new_config.json');
      // DO NOT blur. The user clicks Apply directly, focus moves to button.
    });

    // Click Apply — modal closes, but state should reflect the loaded config.
    const applyBtn = screen.getByText('Apply');
    await act(async () => { await userEvent.click(applyBtn); });

    // Modal closes after Apply, so we re-open to inspect state.
    await waitFor(() => expect(screen.queryByText('Apply')).not.toBeInTheDocument());
    await act(async () => { await userEvent.click(screen.getByTitle('Settings')); });
    await waitFor(() => expect(screen.getByText('Apply')).toBeInTheDocument());

    // After Apply round-trip, the modal should show the new loaded values
    // (matches the operator's symptom: "paths are not updated in the modal").
    const networkInput = screen.getByLabelText(/Network File Path/i) as HTMLInputElement;
    const actionInput = screen.getByLabelText(/Action Dictionary File Path/i) as HTMLInputElement;
    const layoutInput = screen.getByLabelText(/Layout File Path/i) as HTMLInputElement;
    expect(networkInput.value).toBe('/picked/new_network.xiidm');
    expect(actionInput.value).toBe('/picked/new_actions.json');
    expect(layoutInput.value).toBe('/picked/new_layout.json');

    // Critical: backend must have been called with the NEW network path
    // (not the old stale closure value). This asserts the absence of the
    // stale-closure bug between `await changeConfigFilePath()` and the
    // immediately-following `buildConfigRequest()` in `applySettingsImmediate`.
    expect(mockApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      network_path: '/picked/new_network.xiidm',
      action_file_path: '/picked/new_actions.json',
      layout_path: '/picked/new_layout.json',
    }));
  });
});
