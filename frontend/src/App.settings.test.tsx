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
        <button disabled style={{ background: '#fff3cd', color: '#856404' }}>⚙️ Analyzing…</button>
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
  attachVlInteractions: vi.fn(() => () => {}),
}));


// Mock API — use vi.hoisted to define mock before vi.mock hoists
const mockApi = vi.hoisted(() => ({
  getUserConfig: vi.fn().mockResolvedValue({
    network_path: '/home/user/data/grid.xiidm',
    action_file_path: '/home/user/data/actions.json',
    layout_path: '',
    output_folder_path: '',
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
  getConfigFilePath: vi.fn().mockResolvedValue('/mock/config.json'),
  setConfigFilePath: vi.fn().mockResolvedValue({ config_file_path: '/mock/config.json', config: {} }),
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

describe('Save Results button', () => {
  beforeEach(() => {
    vi.restoreAllMocks();  // restores spied-on originals before each test
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { });
  });

  it('is present in the header after study load', async () => {
    await renderAndLoadStudy();
    expect(screen.getByTitle('Save session results to JSON')).toBeInTheDocument();
  });

  it('is disabled when no branch has been selected', async () => {
    await renderAndLoadStudy();
    const saveBtn = screen.getByTitle('Save session results to JSON');
    expect(saveBtn).toBeDisabled();
  });

  it('is enabled after selecting a valid branch', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    const saveBtn = screen.getByTitle('Save session results to JSON');
    expect(saveBtn).not.toBeDisabled();
  });

  it('triggers a JSON download when clicked after branch selection', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    // Spy on anchor click to capture download without browser navigation
    const originalCreateElement = document.createElement.bind(document);
    const anchorClicks: HTMLAnchorElement[] = [];
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = originalCreateElement(tag as keyof HTMLElementTagNameMap);
      if (tag === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => {
          anchorClicks.push(el as HTMLAnchorElement);
        });
      }
      return el;
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    const saveBtn = screen.getByTitle('Save session results to JSON');
    await act(async () => {
      await userEvent.click(saveBtn);
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchorClicks).toHaveLength(1);
    const anchor = anchorClicks[0];
    expect(anchor.download).toMatch(/^costudy4grid_session_BRANCH_A_/);
    expect(anchor.download).toMatch(/\.json$/);
  });

  it('JSON download contains configuration, contingency, and overloads sections', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      capturedBlob = blob as Blob;
      return 'blob:mock-url';
    });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag as keyof HTMLElementTagNameMap);
      if (tag === 'a') vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => { });
      return el;
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    const saveBtn = screen.getByTitle('Save session results to JSON');
    await act(async () => {
      await userEvent.click(saveBtn);
    });

    expect(capturedBlob).toBeDefined();
    const text = await capturedBlob!.text();
    const sessionItems = JSON.parse(text);

    expect(sessionItems).toHaveProperty('saved_at');
    expect(sessionItems).toHaveProperty('configuration');
    expect(sessionItems.configuration).toHaveProperty('network_path');
    expect(sessionItems.configuration).toHaveProperty('layout_path');
    expect(sessionItems.configuration).toHaveProperty('monitoring_factor');
    expect(sessionItems).toHaveProperty('contingency');
    // New session schema: ordered list. ``disconnected_element`` is
    // still emitted as a backwards-compat alias for single-element
    // contingencies.
    expect(sessionItems.contingency.disconnected_elements).toEqual(['BRANCH_A']);
    expect(sessionItems.contingency.disconnected_element).toBe('BRANCH_A');
    expect(sessionItems).toHaveProperty('overloads');
    expect(sessionItems).toHaveProperty('analysis');
  });

  it('JSON analysis is null when no analysis has been run', async () => {
    let capturedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      capturedBlob = blob as Blob;
      return 'blob:mock-url';
    });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag as keyof HTMLElementTagNameMap);
      if (tag === 'a') vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => { });
      return el;
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    const saveBtn = screen.getByTitle('Save session results to JSON');
    await act(async () => {
      await userEvent.click(saveBtn);
    });

    const sessionItems = JSON.parse(await capturedBlob!.text());
    expect(sessionItems.analysis).toBeNull();
  });
});

describe('Settings Modal Enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function openSettings() {
    render(<App />);
    const settingsBtn = screen.getByTitle('Settings');
    await act(async () => {
      await userEvent.click(settingsBtn);
    });
    await waitFor(() => {
      expect(screen.getByText('Apply')).toBeInTheDocument();
    });
  }

  it('defaults to the Paths tab when opened', async () => {
    await openSettings();
    // The Paths tab should be active. We can check for a path-specific input.
    expect(screen.getByLabelText(/Network File Path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Layout File Path/i)).toBeInTheDocument();
  });

  it('auto-closes and fetches study data on Apply', async () => {
    await openSettings();

    mockApi.updateConfig.mockClear();
    mockApi.getBranches.mockClear();
    mockApi.getVoltageLevels.mockClear();

    const applyBtn = screen.getByText('Apply');
    await act(async () => {
      await userEvent.click(applyBtn);
    });

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalled();
    });

    // Verification of auto-close
    await waitFor(() => {
      expect(screen.queryByText('Apply')).not.toBeInTheDocument();
    });

    // Verification of study data fetching
    await waitFor(() => {
      expect(mockApi.getBranches).toHaveBeenCalled();
      expect(mockApi.getVoltageLevels).toHaveBeenCalled();
      expect(mockApi.getNominalVoltages).toHaveBeenCalled();
      expect(mockApi.getNetworkDiagram).toHaveBeenCalled();
    });
  });

  it('switches config file before applying if path changed', async () => {
    await openSettings();

    const configPathInput = screen.getByLabelText(/Config File Path/i);
    await userEvent.clear(configPathInput);
    await userEvent.type(configPathInput, '/new/config.json');

    mockApi.setConfigFilePath.mockClear();
    mockApi.updateConfig.mockClear();

    const applyBtn = screen.getByText('Apply');
    await act(async () => {
      await userEvent.click(applyBtn);
    });

    await waitFor(() => {
      expect(mockApi.setConfigFilePath).toHaveBeenCalledWith('/new/config.json');
    });

    expect(mockApi.updateConfig).toHaveBeenCalled();
    // Ensure setConfigFilePath was called BEFORE updateConfig
    const setConfigCallOrder = mockApi.setConfigFilePath.mock.invocationCallOrder[0];
    const updateConfigCallOrder = mockApi.updateConfig.mock.invocationCallOrder[0];
    expect(setConfigCallOrder).toBeLessThan(updateConfigCallOrder);
  });

  it('updates configuration with new network and layout paths', async () => {
    await openSettings();

    const networkInput = screen.getByLabelText(/Network File Path/i);
    const layoutInput = screen.getByLabelText(/Layout File Path/i);

    await userEvent.clear(networkInput);
    await userEvent.type(networkInput, '/path/to/network.xiidm');
    await userEvent.clear(layoutInput);
    await userEvent.type(layoutInput, '/path/to/layout.json');

    mockApi.updateConfig.mockResolvedValue({
      monitored_lines_count: 5,
      total_lines_count: 5
    });

    const applyBtn = screen.getByText('Apply');
    await act(async () => {
      await userEvent.click(applyBtn);
    });

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        network_path: '/path/to/network.xiidm',
        layout_path: '/path/to/layout.json'
      }));
    });
  });

  it('updates configuration with new monitoring factor', async () => {
    await openSettings();

    // Switch to Configurations tab
    const configTab = screen.getByText('Configurations');
    await userEvent.click(configTab);

    const monitoringInput = screen.getByLabelText(/Monitoring Factor Thermal Limits/i);
    await userEvent.clear(monitoringInput);
    await userEvent.type(monitoringInput, '0.85');

    const applyBtn = screen.getByText('Apply');
    await act(async () => {
      await userEvent.click(applyBtn);
    });

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        monitoring_factor: 0.85
      }));
    });
  });

  it('shows path warning when no network is loaded and allows dismissal', async () => {
    // Initial render should show the warning since no diagram is loaded
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Configuration Paths/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Layout Path:/i)).toBeInTheDocument();
    expect(screen.getByText(/Output Folder:/i)).toBeInTheDocument();

    // Dismiss the warning
    const closeBtn = screen.getByText('✕');
    await userEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText(/Configuration Paths/i)).not.toBeInTheDocument();
    });
  });

  it('hides path warning when a network diagram is loaded', async () => {
    render(<App />);

    // Warning should be present initially
    await waitFor(() => {
      expect(screen.getByText(/Configuration Paths/i)).toBeInTheDocument();
    });

    // Simulate loading a study which will set nDiagram
    const settingsBtn = screen.getByTitle('Settings');
    await userEvent.click(settingsBtn);

    const applyBtn = screen.getByText('Apply');
    await userEvent.click(applyBtn);

    // After apply, the warning should disappear because a diagram (nDiagram) will be "loaded" 
    // (mocked in our tests)
    await waitFor(() => {
      expect(screen.queryByText(/Configuration Paths/i)).not.toBeInTheDocument();
    });
  });

  it('opens settings on Paths tab when "Change in settings" is clicked in warning banner', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Configuration Paths/i)).toBeInTheDocument();
    });

    const changeLink = screen.getByText(/Change in settings/i);
    await userEvent.click(changeLink);

    // Should open settings modal
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Should be on Paths tab (default for settings modal anyway, but let's be sure)
    expect(screen.getByLabelText(/Network File Path/i)).toBeInTheDocument();
  });

  it('correctly derives and displays output folder from network path in warning banner', async () => {
    localStorage.setItem('networkPath', '/home/user/data/grid.xiidm');
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Configuration Paths/i)).toBeInTheDocument();
    });

    // The output folder should be /home/user/data
    expect(screen.getByText(/Output Folder:/i)).toHaveTextContent('/home/user/data');
  });

  it('displays correct icons and placeholders in settings modal', async () => {
    await openSettings();

    const networkInput = screen.getByLabelText(/Network File Path/i);
    expect(networkInput).toHaveAttribute('placeholder', 'load your grid xiidm file path');

    // Check icons (they are emojis in buttons)
    // Network button icon
    const networkBtn = networkInput.parentElement?.querySelector('button');
    expect(networkBtn?.textContent).toBe('📄');

    // Layout button icon
    const layoutInput = screen.getByLabelText(/Layout File Path/i);
    const layoutBtn = layoutInput.parentElement?.querySelector('button');
    expect(layoutBtn?.textContent).toBe('📄');

    // Action button icon (was already 📄 but good to check)
    const actionInput = screen.getByLabelText(/Action Dictionary File Path/i);
    const actionBtn = actionInput.parentElement?.querySelector('button');
    expect(actionBtn?.textContent).toBe('📄');

    // Output folder icon (should be 📂)
    const outputInput = screen.getByPlaceholderText('e.g. /home/user/sessions');
    const outputBtn = outputInput.parentElement?.querySelector('button');
    expect(outputBtn?.textContent).toBe('📂');
  });

  it('displays file icon for network path in main banner', async () => {
    render(<App />);
    // Anchor on the header's network-path input (unique test id) — the
    // file-opener button shares its row. Robust to the label / Notices
    // pill layout around it.
    const bannerInput = screen.getByTestId('header-network-path-input');
    expect(bannerInput).toHaveAttribute('placeholder', 'load your grid xiidm file path');
    const inputRow = bannerInput.closest('div')!;
    const bannerBtn = Array.from(inputRow.querySelectorAll('button'))
      .find(b => b.textContent === '📄');
    expect(bannerBtn?.textContent).toBe('📄');
  });

  describe('Processing State UI', () => {
    it('shows yellow "Running..." button during analysis', async () => {
      render(<App />);

      const loadBtn = screen.getByText('🔄 Load Study');
      await userEvent.click(loadBtn);
      await waitFor(() => {
        expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
      });

      // Pick a branch from the multi-select then click Trigger.
      await selectBranch('BRANCH_A');

      // Setup streaming mock for step2 (keep stream open to simulate "Running" state)
      const mockStream = new ReadableStream({
        start() {
          // Keep it open to simulate "Running" state
        },
      });
      mockApi.runAnalysisStep2Stream.mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const runBtn = screen.getByText('🔍 Analyze & Suggest');
      await userEvent.click(runBtn);

      // Button should change to "⚙️ Analyzing…"
      const runningBtn = await screen.findByText('⚙️ Analyzing…');
      expect(runningBtn).toBeInTheDocument();
    });
  });
});
