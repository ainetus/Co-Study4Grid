// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App';

// ===== Mocks =====

// Mock child components to avoid their complexity
vi.mock('./components/VisualizationPanel', () => {
  interface MockProps {
    nDiagram: Record<string, unknown> | null;
    n1Diagram: Record<string, unknown> | null;
    configLoading: boolean;
    layoutPath: string;
    networkPath: string;
    onOpenSettings: (tab: string) => void;
  }
  const MockVisualizationPanel = (props: MockProps) => {
    const { nDiagram, n1Diagram, configLoading, layoutPath, networkPath, onOpenSettings } = props;
    const [warningDismissed, setWarningDismissed] = React.useState(false);
    const hasAnyDiagram = !!nDiagram?.svg || !!n1Diagram?.svg;
    const showPathWarning = !warningDismissed && !hasAnyDiagram;

    return (
      <div
        data-testid="visualization-panel"
        data-n1-diagram-present={!!n1Diagram}
      >
        {!hasAnyDiagram && !configLoading && showPathWarning && (
          <div>
            <div>Configuration Paths</div>
            <button onClick={() => setWarningDismissed(true)}>✕</button>
            <div>Layout Path: {layoutPath}</div>
            <div>Output Folder: {networkPath ? (networkPath.includes('/') ? networkPath.substring(0, networkPath.lastIndexOf('/')) : networkPath) : 'Not set'}</div>
            <button onClick={() => onOpenSettings('paths')}>Change in settings</button>
          </div>
        )}
      </div>
    );
  };
  return { default: MockVisualizationPanel };
});
vi.mock('./components/ActionFeed', () => ({
  default: (props: { linesOverloaded: string[]; pendingAnalysisResult: object | null; analysisLoading: boolean; onDisplayPrioritizedActions: () => void; onRunAnalysis: () => void; canRunAnalysis: boolean }) => (
    <div
      data-testid="action-feed"
      data-ol-count={props.linesOverloaded?.length || 0}
      data-pending={!!props.pendingAnalysisResult}
      data-loading={!!props.analysisLoading}
    >
      {props.analysisLoading ? (
        <button disabled>⚙️ Analyzing…</button>
      ) : props.pendingAnalysisResult ? (
        <button onClick={props.onDisplayPrioritizedActions}>Display prioritized actions</button>
      ) : (
        <button onClick={props.onRunAnalysis} disabled={!props.canRunAnalysis}>🔍 Analyze & Suggest</button>
      )}
    </div>
  ),
}));
vi.mock('./components/OverloadPanel', () => ({
  default: (props: { n1Overloads: string[]; selectedOverloads: Set<string> }) => (
    <div
      data-testid="overload-panel"
      data-n1-ol-count={props.n1Overloads?.length || 0}
      data-sel-ol-count={props.selectedOverloads?.size || 0}
    />
  ),
}));

// Mock hooks
vi.mock('./hooks/usePanZoom', () => ({
  usePanZoom: () => ({ viewBox: null, setViewBox: vi.fn() }),
}));

// Mock SVG utilities
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
  applyVlTitles: vi.fn(),
}));


// Mock API — use vi.hoisted to define mock before vi.mock hoists
const mockApi = vi.hoisted(() => ({
  updateConfig: vi.fn().mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 }),
  getBranches: vi.fn().mockResolvedValue({ branches: ['BRANCH_A', 'BRANCH_B', 'BRANCH_C'], name_map: {} }),
  getVoltageLevels: vi.fn().mockResolvedValue({ voltage_levels: ['VL1', 'VL2'], name_map: {} }),
  getNominalVoltages: vi.fn().mockResolvedValue({ mapping: {}, unique_kv: [63, 225] }),
  getVoltageLevelSubstations: vi.fn().mockResolvedValue({ mapping: {} }),
  getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  getContingencyDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null, lines_overloaded: [] }),
  pickPath: vi.fn(),
  runAnalysisStep1: vi.fn().mockResolvedValue({ can_proceed: true, lines_overloaded: ['LINE_OL1'] }),
  runAnalysisStep2Stream: vi.fn(),
  getActionVariantDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  getUserConfig: vi.fn().mockResolvedValue({
    network_path: '/home/user/data/grid.xiidm',
    action_file_path: '/home/user/data/actions.json'
  }),
  getConfigFilePath: vi.fn().mockResolvedValue('/home/user/data/config.json'),
  saveUserConfig: vi.fn().mockResolvedValue({}),
  setConfigFilePath: vi.fn().mockResolvedValue({ config_file_path: '/home/user/data/config.json', config: {} }),
  getNSld: vi.fn(),
  getContingencySld: vi.fn(),
  getActionVariantSld: vi.fn(),
}));

vi.mock('./api', () => ({
  api: mockApi,
}));

afterEach(() => {
  cleanup();
});

// Helper: render App, load config, wait for branches to appear
async function renderAndLoadStudy() {
  render(<App />);

  // Click Load Study
  const loadBtn = screen.getByText('🔄 Load Study');
  await userEvent.click(loadBtn);

  // Wait for branches to be loaded (which means handleLoadConfig is done)
  await waitFor(() => {
    expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
  }, { timeout: 5000 });
}

// Helper: pick ``branchName`` from the react-select multi-select
// then click the Trigger button to commit the contingency.
async function selectBranch(branchName: string) {
  const combobox = screen.getByRole('combobox');
  await act(async () => {
    await userEvent.click(combobox);
    await userEvent.type(combobox, branchName);
    await userEvent.keyboard('{Enter}');
  });
  const trigger = await screen.findByRole('button', { name: /Trigger/ });
  await act(async () => {
    await userEvent.click(trigger);
  });
  await waitFor(() => {
    expect(mockApi.getContingencyDiagram).toHaveBeenCalledWith([branchName]);
  });
}

// Helper: run analysis to create analysis state
async function runAnalysis() {
  // Mock runAnalysisStep2Stream to return a streaming Response
  const mockStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        JSON.stringify({ type: 'result', actions: { ACT1: { is_manual: false, rho_before: [1.02], rho_after: [0.95] } }, lines_overloaded: ['LINE_OL1'], message: 'done', dc_fallback: false }) + '\n'
      ));
      controller.close();
    },
  });
  mockApi.runAnalysisStep2Stream.mockResolvedValue({
    ok: true,
    body: mockStream,
  });

  const runBtn = screen.getByText('🔍 Analyze & Suggest');
  await act(async () => {
    await userEvent.click(runBtn);
  });

  await waitFor(() => {
    const running = screen.queryByText('⚙️ Analyzing…');
    if (running) throw new Error('Still analyzing...');
  }, { timeout: 5000 });

  // Click Display Actions if present
  const displayBtn = await screen.findByText(/Display.*prioritized actions/, {}, { timeout: 3000 });
  await userEvent.click(displayBtn);
}

describe('Load Study Confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('loads study directly when no analysis state exists', async () => {
    render(<App />);

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    // No dialog, just loads
    expect(screen.queryByText('Reload Study?')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
  });

  it('shows confirmation dialog when clicking Load Study after running analysis', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();

    // Click Load Study again
    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    // Dialog should appear
    await waitFor(() => {
      expect(screen.getByText('Reload Study?')).toBeInTheDocument();
    });
    expect(screen.getByText(/The network will be reloaded from scratch/)).toBeInTheDocument();

    // Config should NOT have been called yet
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });

  it('reloads study when user confirms Load Study dialog', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Reload Study?')).toBeInTheDocument();
    });

    // Click Confirm
    await act(async () => {
      await userEvent.click(screen.getByText('Confirm'));
    });

    // Dialog should close and config should be called
    expect(screen.queryByText('Reload Study?')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
  });

  it('keeps state when user cancels Load Study dialog', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Reload Study?')).toBeInTheDocument();
    });

    // Click Cancel
    await act(async () => {
      await userEvent.click(screen.getByText('Cancel'));
    });

    // Dialog should close, config should NOT be called
    expect(screen.queryByText('Reload Study?')).not.toBeInTheDocument();
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });
});

describe('Full State Reset on Load Study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('clears branch selection after Load Study with no prior analysis state', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');

    mockApi.updateConfig.mockClear();
    mockApi.getBranches.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    // No dialog — no analysis state
    expect(screen.queryByText('Reload Study?')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockApi.getBranches).toHaveBeenCalled();
    });

    // Branch input should be cleared
    expect(screen.queryByTestId('sidebar-summary-contingency')).toBeNull();
  });

  it('clears branch selection after confirming Load Study with analysis state', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');

    mockApi.updateConfig.mockClear();
    mockApi.getBranches.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    await waitFor(() => {
      expect(screen.getByText('Reload Study?')).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Confirm'));
    });

    expect(screen.queryByText('Reload Study?')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockApi.getBranches).toHaveBeenCalled();
    });

    // Branch input must be cleared after reset
    expect(screen.queryByTestId('sidebar-summary-contingency')).toBeNull();
  });

  it('re-fetches branches after Load Study reset', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    mockApi.getBranches.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    await waitFor(() => {
      expect(mockApi.getBranches).toHaveBeenCalled();
    });
  });

  it('preserves configuration paths across Load Study reset', async () => {
    await renderAndLoadStudy();

    const firstCallArgs = mockApi.updateConfig.mock.calls[0][0];
    expect(firstCallArgs.network_path).toBeTruthy();
    expect(firstCallArgs.action_file_path).toBeTruthy();

    mockApi.updateConfig.mockClear();

    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => {
      await userEvent.click(loadBtn);
    });

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    const secondCallArgs = mockApi.updateConfig.mock.calls[0][0];
    expect(secondCallArgs.network_path).toBe(firstCallArgs.network_path);
    expect(secondCallArgs.action_file_path).toBe(firstCallArgs.action_file_path);
  });
});

describe('Full State Reset on Apply Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function openSettings() {
    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => {
      await userEvent.click(settingsBtn);
    });
    await waitFor(() => {
      expect(screen.getByText('Apply')).toBeInTheDocument();
    });
  }

  // Convenience: click Apply and confirm the resulting "Apply New
  // Settings?" dialog. With a study already loaded, every Apply now
  // routes through the confirmation pipeline (Bug "user warning when
  // changing config path while a network is loaded").
  async function applyAndConfirm() {
    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });
    await waitFor(() => {
      expect(screen.getByText('Apply New Settings?')).toBeInTheDocument();
    });
    await act(async () => {
      await userEvent.click(screen.getByText('Confirm'));
    });
  }

  it('clears branch selection after Apply Settings', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');

    mockApi.updateConfig.mockClear();

    await openSettings();
    await applyAndConfirm();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('sidebar-summary-contingency')).toBeNull();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('clears branch and analysis state after Apply Settings with analysis state', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');

    mockApi.updateConfig.mockClear();

    await openSettings();
    await applyAndConfirm();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('sidebar-summary-contingency')).toBeNull();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('closes settings modal after Apply Settings', async () => {
    await renderAndLoadStudy();
    await openSettings();

    expect(screen.getByText('Apply')).toBeInTheDocument();

    await applyAndConfirm();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('calls updateConfig with current settings values after Apply Settings', async () => {
    await renderAndLoadStudy();

    mockApi.updateConfig.mockClear();

    await openSettings();
    await applyAndConfirm();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    const callArgs = mockApi.updateConfig.mock.calls[0][0];
    expect(callArgs).toHaveProperty('min_line_reconnections');
    expect(callArgs).toHaveProperty('monitoring_factor');
    expect(callArgs).toHaveProperty('n_prioritized_actions');
  });

  it('re-fetches branches after Apply Settings', async () => {
    await renderAndLoadStudy();

    mockApi.getBranches.mockClear();
    mockApi.updateConfig.mockClear();

    await openSettings();
    await applyAndConfirm();

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    // Apply Settings DOES now re-fetch branches (matching Load Study behavior)
    expect(mockApi.getBranches).toHaveBeenCalled();
  });
});

describe('Apply Settings Confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function openSettings() {
    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => {
      await userEvent.click(settingsBtn);
    });
    await waitFor(() => {
      expect(screen.getByText('Apply')).toBeInTheDocument();
    });
  }

  it('applies settings directly when no study has been loaded yet', async () => {
    // Brand-new app, no Load Study clicked. There's nothing to
    // discard, so Apply must not show the dialog.
    render(<App />);

    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => {
      await userEvent.click(settingsBtn);
    });
    await waitFor(() => {
      expect(screen.getByText('Apply')).toBeInTheDocument();
    });

    mockApi.updateConfig.mockClear();
    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });

    // No confirmation dialog, settings apply immediately.
    expect(screen.queryByText('Apply New Settings?')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
  });

  // Regression: changing a config-relevant setting (e.g. the config
  // file path) and clicking Apply while a network is loaded BUT no
  // analysis has been run must still warn the user, because Apply
  // unconditionally reloads the network and would silently drop the
  // currently-loaded grid.
  it('shows confirmation dialog when applying settings with a loaded network but no analysis', async () => {
    await renderAndLoadStudy();
    // Deliberately no selectBranch / no runAnalysis — only the base
    // network is loaded.

    mockApi.updateConfig.mockClear();
    await openSettings();

    // Type a new config file path (the typical user action this
    // request is about) before clicking Apply.
    const configPathInput = screen.getByLabelText(/Config File Path/i);
    await userEvent.clear(configPathInput);
    await userEvent.type(configPathInput, '/new/config.json');

    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });

    await waitFor(() => {
      expect(screen.getByText('Apply New Settings?')).toBeInTheDocument();
    });
    // Backend must NOT have been called yet — the user has to
    // confirm first.
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });

  it('shows confirmation dialog when applying settings after running analysis', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();
    await openSettings();

    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });

    // Dialog appears, with the apply-settings-specific copy.
    await waitFor(() => {
      expect(screen.getByText('Apply New Settings?')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/The network will be reloaded with the new configuration/),
    ).toBeInTheDocument();

    // Backend must NOT have been called yet — applying is gated on
    // the user's confirmation.
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });

  it('proceeds with apply settings after confirmation', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();
    await openSettings();

    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });
    await waitFor(() => {
      expect(screen.getByText('Apply New Settings?')).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Confirm'));
    });

    // Dialog dismissed, settings applied, modal closed.
    expect(screen.queryByText('Apply New Settings?')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('keeps state and modal open when user cancels apply settings dialog', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    mockApi.updateConfig.mockClear();
    await openSettings();

    await act(async () => {
      await userEvent.click(screen.getByText('Apply'));
    });
    await waitFor(() => {
      expect(screen.getByText('Apply New Settings?')).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Cancel'));
    });

    // Dialog dismissed, no backend call, settings modal still open
    // (so the user can adjust their inputs without losing them).
    expect(screen.queryByText('Apply New Settings?')).not.toBeInTheDocument();
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
    expect(screen.getByText('Apply')).toBeInTheDocument();
    // The contingency selection must also still be intact.
    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');
  });
});

describe('Change Network Path Confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('does not prompt when no study has been loaded yet', async () => {
    // Fresh app, no Load Study click. Typing a new network path and
    // blurring must NOT show the dialog — there's nothing to discard.
    render(<App />);

    const input = await screen.findByTestId('header-network-path-input');
    await act(async () => {
      await userEvent.clear(input);
      await userEvent.type(input, '/tmp/freshly-chosen.xiidm');
      input.blur();
    });

    expect(screen.queryByText('Change Network?')).not.toBeInTheDocument();
  });

  it('shows confirmation dialog when typing a different path after a study is loaded', async () => {
    await renderAndLoadStudy();

    mockApi.updateConfig.mockClear();

    const input = screen.getByTestId('header-network-path-input');
    await act(async () => {
      await userEvent.clear(input);
      await userEvent.type(input, '/tmp/new-network.xiidm');
      input.blur();
    });

    await waitFor(() => {
      expect(screen.getByText('Change Network?')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/The current study will be reloaded from the new network file/),
    ).toBeInTheDocument();
    // The backend must NOT have been called yet — confirmation is
    // what triggers the reload.
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });

  it('reloads the study with the new path on Confirm', async () => {
    await renderAndLoadStudy();

    mockApi.updateConfig.mockClear();
    mockApi.getBranches.mockClear();

    const input = screen.getByTestId('header-network-path-input');
    await act(async () => {
      await userEvent.clear(input);
      await userEvent.type(input, '/tmp/new-network.xiidm');
      input.blur();
    });

    await waitFor(() => {
      expect(screen.getByText('Change Network?')).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Confirm'));
    });

    // Dialog dismissed and a fresh load kicks in with the new path.
    expect(screen.queryByText('Change Network?')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });
    const lastCall = mockApi.updateConfig.mock.calls.at(-1)![0];
    expect(lastCall.network_path).toBe('/tmp/new-network.xiidm');
    expect(mockApi.getBranches).toHaveBeenCalled();
  });

  it('reverts the network path input on Cancel and keeps the current study', async () => {
    await renderAndLoadStudy();
    const initialPath = (screen.getByTestId('header-network-path-input') as HTMLInputElement).value;

    mockApi.updateConfig.mockClear();

    const input = screen.getByTestId('header-network-path-input');
    await act(async () => {
      await userEvent.clear(input);
      await userEvent.type(input, '/tmp/rejected.xiidm');
      input.blur();
    });

    await waitFor(() => {
      expect(screen.getByText('Change Network?')).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Cancel'));
    });

    // Dialog gone, no reload, and the Header field is back to the
    // path the currently-loaded study was loaded from.
    expect(screen.queryByText('Change Network?')).not.toBeInTheDocument();
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId('header-network-path-input') as HTMLInputElement).value,
    ).toBe(initialPath);
  });

  it('does not prompt when blurring the input without actually changing the path', async () => {
    await renderAndLoadStudy();

    mockApi.updateConfig.mockClear();

    const input = screen.getByTestId('header-network-path-input');
    // Just focus and blur — same value committed.
    await act(async () => {
      input.focus();
      input.blur();
    });

    expect(screen.queryByText('Change Network?')).not.toBeInTheDocument();
    expect(mockApi.updateConfig).not.toHaveBeenCalled();
  });
});

// Regression: reloading an archived session whose contingency differs
// from the currently-loaded one must NOT trigger the "Change
// Contingency?" warning dialog. The dialog is only meant for the user-
// initiated contingency-swap gesture; a session restore is supposed to
// replace state wholesale, so the confirmation step would (a) be
// useless friction and (b) — worse — if the user confirms, the
// post-confirmation handler wipes the just-restored analysis result
// via `clearContingencyState()`, dropping every restored suggestion.
describe('Session reload — different contingency than current', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
    // The Reload Session flow needs an output folder to look in.
    mockApi.getUserConfig.mockResolvedValue({
      network_path: '/home/user/data/grid.xiidm',
      action_file_path: '/home/user/data/actions.json',
      output_folder_path: '/tmp/sessions',
    });
  });

  it('does NOT show "Change Contingency?" when restoring a session for a different contingency than currently loaded', async () => {
    // Mocks for the session reload API
    interface ApiWithSessionMocks {
      listSessions: ReturnType<typeof vi.fn>;
      loadSession: ReturnType<typeof vi.fn>;
      restoreAnalysisContext: ReturnType<typeof vi.fn>;
    }
    const apiAny = mockApi as unknown as ApiWithSessionMocks;
    apiAny.listSessions = vi.fn().mockResolvedValue({
      sessions: ['costudy4grid_session_BRANCH_B_2026-05-18T14-46-53'],
    });
    apiAny.restoreAnalysisContext = vi.fn().mockResolvedValue({
      status: 'success',
      lines_we_care_about_count: 0,
      computed_pairs_count: 0,
    });
    apiAny.loadSession = vi.fn().mockResolvedValue({
      saved_at: '2026-05-18T14:46:53.000Z',
      configuration: {
        network_path: '/home/user/data/grid.xiidm',
        action_file_path: '/home/user/data/actions.json',
        layout_path: '',
        min_line_reconnections: 2,
        min_close_coupling: 3,
        min_open_coupling: 2,
        min_line_disconnections: 3,
        min_pst: 1,
        min_load_shedding: 0,
        min_renewable_curtailment_actions: 0,
        n_prioritized_actions: 10,
        lines_monitoring_path: '',
        monitoring_factor: 0.95,
        pre_existing_overload_threshold: 0.02,
        ignore_reconnections: false,
        pypowsybl_fast_mode: true,
      },
      contingency: {
        disconnected_elements: ['BRANCH_B'],
        selected_overloads: [],
        monitor_deselected: false,
      },
      overloads: {
        n_overloads: [],
        n1_overloads: ['LINE_OL_RESTORED'],
        resolved_overloads: ['LINE_OL_RESTORED'],
      },
      overflow_graph: null,
      analysis: {
        message: 'restored',
        dc_fallback: false,
        action_scores: {},
        actions: {
          RESTORED_ACT_1: {
            description_unitaire: 'Restored action',
            rho_before: [1.05],
            rho_after: [0.92],
            max_rho: 0.92,
            max_rho_line: 'LINE_OL_RESTORED',
            is_rho_reduction: true,
            status: { is_selected: false, is_rejected: false, is_manually_simulated: false, is_suggested: true },
          },
        },
        combined_actions: {},
        lines_we_care_about: null,
        computed_pairs: null,
      },
    });

    // 1. Load study + commit BRANCH_A + run analysis so we have a
    //    populated result + non-empty selectedContingency + non-empty
    //    committedBranchRef.
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    // Verify pre-state: BRANCH_A committed and analysis result present.
    expect(screen.getByTestId('sidebar-summary-contingency').textContent).toContain('BRANCH_A');

    // 2. Open the Reload Session modal and pick the BRANCH_B session.
    const reloadBtn = screen.getByText('Reload Session');
    await act(async () => {
      await userEvent.click(reloadBtn);
    });
    const sessionEntry = await screen.findByText(/costudy4grid_session_BRANCH_B/);
    await act(async () => {
      await userEvent.click(sessionEntry);
    });

    // 3. Wait for the restore to settle.
    await waitFor(() => {
      expect(apiAny.loadSession).toHaveBeenCalled();
    });

    // 4. The "Change Contingency?" dialog MUST NOT appear. Before the
    //    fix this assertion failed because the useContingencyFetch
    //    effect saw the new selectedContingency=[BRANCH_B] alongside
    //    the just-restored result and fired the contingency-warning
    //    dialog — which on confirm wipes the restored suggestions via
    //    clearContingencyState.
    await waitFor(() => {
      expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();
    });
  });

  // Second-reload regression: clicking Reload Session a SECOND time —
  // when the previous reload has already populated `result`,
  // `committedBranchRef` and `selectedContingency` — must still
  // suppress the contingency-change dialog. The defensive guard added
  // to resetAllState (which wipes per-study state at the START of
  // every restore + dismisses any stale confirmDialog) closes this
  // race window.
  it('does NOT show "Change Contingency?" on a SECOND consecutive reload of a different session', async () => {
    interface ApiWithSessionMocks {
      listSessions: ReturnType<typeof vi.fn>;
      loadSession: ReturnType<typeof vi.fn>;
      restoreAnalysisContext: ReturnType<typeof vi.fn>;
    }
    const apiAny = mockApi as unknown as ApiWithSessionMocks;
    apiAny.listSessions = vi.fn().mockResolvedValue({
      sessions: [
        'costudy4grid_session_BRANCH_B_2026-05-18T14-46-53',
        'costudy4grid_session_BRANCH_A_2026-05-18T15-12-04',
      ],
    });
    apiAny.restoreAnalysisContext = vi.fn().mockResolvedValue({
      status: 'success',
      lines_we_care_about_count: 0,
      computed_pairs_count: 0,
    });
    const sessionPayload = (branch: string) => ({
      saved_at: '2026-05-18T14:46:53.000Z',
      configuration: {
        network_path: '/home/user/data/grid.xiidm',
        action_file_path: '/home/user/data/actions.json',
        layout_path: '',
        min_line_reconnections: 2,
        min_close_coupling: 3,
        min_open_coupling: 2,
        min_line_disconnections: 3,
        min_pst: 1,
        min_load_shedding: 0,
        min_renewable_curtailment_actions: 0,
        n_prioritized_actions: 10,
        lines_monitoring_path: '',
        monitoring_factor: 0.95,
        pre_existing_overload_threshold: 0.02,
        ignore_reconnections: false,
        pypowsybl_fast_mode: true,
      },
      contingency: {
        disconnected_elements: [branch],
        selected_overloads: [],
        monitor_deselected: false,
      },
      overloads: {
        n_overloads: [],
        n1_overloads: ['LINE_OL_RESTORED'],
        resolved_overloads: ['LINE_OL_RESTORED'],
      },
      overflow_graph: null,
      analysis: {
        message: 'restored',
        dc_fallback: false,
        action_scores: {},
        actions: {
          [`RESTORED_ACT_${branch}`]: {
            description_unitaire: `Restored action for ${branch}`,
            rho_before: [1.05],
            rho_after: [0.92],
            max_rho: 0.92,
            max_rho_line: 'LINE_OL_RESTORED',
            is_rho_reduction: true,
            status: { is_selected: false, is_rejected: false, is_manually_simulated: false, is_suggested: true },
          },
        },
        combined_actions: {},
        lines_we_care_about: null,
        computed_pairs: null,
      },
    });
    apiAny.loadSession = vi.fn().mockImplementation(async (_folder: string, name: string) => {
      const branch = name.includes('BRANCH_B') ? 'BRANCH_B' : 'BRANCH_A';
      return sessionPayload(branch);
    });

    await renderAndLoadStudy();

    // First reload — BRANCH_B.
    const reloadBtn = screen.getByText('Reload Session');
    await act(async () => {
      await userEvent.click(reloadBtn);
    });
    const firstEntry = await screen.findByText(/costudy4grid_session_BRANCH_B/);
    await act(async () => {
      await userEvent.click(firstEntry);
    });
    await waitFor(() => {
      expect(apiAny.loadSession).toHaveBeenCalledTimes(1);
    });
    // First reload must not have left a stale dialog.
    expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();

    // Second reload — BRANCH_A. The pre-existing refs from the first
    // reload (committedBranchRef=BRANCH_B, result=non-null) are the
    // exact race conditions that re-fired the dialog before the
    // resetAllState-at-top-of-restore fix.
    await act(async () => {
      await userEvent.click(screen.getByText('Reload Session'));
    });
    const secondEntry = await screen.findByText(/costudy4grid_session_BRANCH_A/);
    await act(async () => {
      await userEvent.click(secondEntry);
    });
    await waitFor(() => {
      expect(apiAny.loadSession).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();
    });
  });
});
