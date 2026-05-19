// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App';

// ===== Mocks =====

// Mock child components to avoid their complexity
vi.mock('./components/VisualizationPanel', () => {
  interface MockProps {
    nDiagram: Record<string, unknown> | null;
    n1Diagram: Record<string, unknown> | null;
    activeTab: string;
    configLoading: boolean;
    layoutPath: string;
    networkPath: string;
    onOpenSettings: (tab: string) => void;
  }
  const MockVisualizationPanel = (props: MockProps) => {
    const { nDiagram, n1Diagram, activeTab, configLoading, layoutPath, networkPath, onOpenSettings } = props;
    const [warningDismissed, setWarningDismissed] = React.useState(false);
    const hasAnyDiagram = !!nDiagram?.svg || !!n1Diagram?.svg;
    const showPathWarning = !warningDismissed && !hasAnyDiagram;

    return (
      <div
        data-testid="visualization-panel"
        data-n1-diagram-present={!!n1Diagram}
        data-active-tab={activeTab}
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
      data-ol-names={(props.linesOverloaded ?? []).join('|')}
      data-pending={!!props.pendingAnalysisResult}
      data-loading={!!props.analysisLoading}
    >
      <div>
        <h3 data-testid="action-feed-header">Remedial Actions</h3>
      </div>
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
  default: (props: { n1Overloads: string[]; selectedOverloads: Set<string>; onToggleOverload?: (overload: string) => void }) => (
    <div
      data-testid="overload-panel"
      data-n1-ol-count={props.n1Overloads?.length || 0}
      data-sel-ol-count={props.selectedOverloads?.size || 0}
    >
      {(props.n1Overloads ?? []).map((name) => (
        <button
          key={name}
          data-testid={`toggle-overload-${name}`}
          onClick={() => props.onToggleOverload?.(name)}
        />
      ))}
    </div>
  ),
}));

// Mock hooks
vi.mock('./hooks/usePanZoom', () => ({
  usePanZoom: () => ({ viewBox: null, setViewBox: vi.fn() }),
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

// Helper: add ``branchName`` to the pending contingency by typing it
// into the react-select multi-select and pressing Enter to confirm
// the highlighted option. After a contingency has already been
// committed the picker card is hidden behind the sticky banner Clear
// shortcut, so transparently click Clear (and confirm the dialog when
// analysis state would be lost) to reveal the picker again.
async function pickBranch(branchName: string) {
  let combobox = screen.queryByRole('combobox');
  if (!combobox) {
    const clearBtn = screen.queryByTestId('sidebar-summary-clear');
    if (clearBtn) {
      await act(async () => { await userEvent.click(clearBtn); });
      const confirmDialog = screen.queryByText('Change Contingency?');
      if (confirmDialog) {
        await act(async () => { await userEvent.click(screen.getByText('Confirm')); });
      }
    }
    combobox = screen.getByRole('combobox');
  }
  await act(async () => {
    await userEvent.click(combobox);
    await userEvent.type(combobox, branchName);
    await userEvent.keyboard('{Enter}');
  });
}

// Helper: click the Trigger button to commit the pending list.
async function triggerContingency() {
  const trigger = await screen.findByRole('button', { name: /Trigger/ });
  await act(async () => {
    await userEvent.click(trigger);
  });
}

// Helper: full pick + trigger + wait for the contingency-diagram fetch.
async function selectBranch(branchName: string) {
  await pickBranch(branchName);
  await triggerContingency();
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
    if (running) throw new Error('Still running...');
  }, { timeout: 5000 });

  // Click Display Actions if present
  const displayBtn = await screen.findByText(/Display.*prioritized actions/, {}, { timeout: 3000 });
  await userEvent.click(displayBtn);
}

describe('Contingency Change Confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Reset fetch stub
    vi.unstubAllGlobals();
  });

  it('does NOT show confirmation dialog when clearing without analysis state', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // Clear from the sticky banner. No analysis state has been built
    // up yet, so the Clear shortcut bypasses the confirmation dialog
    // and the picker reappears immediately.
    mockApi.getContingencyDiagram.mockClear();
    await act(async () => {
      await userEvent.click(screen.getByTestId('sidebar-summary-clear'));
    });
    expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();

    // Pick a fresh contingency through the now-visible picker.
    await pickBranch('BRANCH_B');
    await triggerContingency();
    await waitFor(() => {
      expect(mockApi.getContingencyDiagram).toHaveBeenCalledWith(['BRANCH_B']);
    });
  });

  it('shows confirmation dialog when clearing after running analysis', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    await act(async () => {
      await userEvent.click(screen.getByTestId('sidebar-summary-clear'));
    });
    await waitFor(() => {
      expect(screen.getByText('Change Contingency?')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('proceeds with contingency change after confirmation', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    await act(async () => {
      await userEvent.click(screen.getByTestId('sidebar-summary-clear'));
    });
    await screen.findByText('Change Contingency?');
    await userEvent.click(screen.getByText('Confirm'));

    mockApi.getContingencyDiagram.mockClear();
    await pickBranch('BRANCH_B');
    await triggerContingency();
    await waitFor(() => {
      expect(mockApi.getContingencyDiagram).toHaveBeenCalledWith(['BRANCH_B']);
    });
    expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();
  });

  it('cancels contingency clear on dismissal', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    await runAnalysis();

    await act(async () => {
      await userEvent.click(screen.getByTestId('sidebar-summary-clear'));
    });
    await screen.findByText('Change Contingency?');
    await userEvent.click(screen.getByText('Cancel'));

    // BRANCH_A stays applied; its name still surfaces in the sticky
    // banner. (Use getAllByText since both the banner link and the
    // action-card data attribute may surface the name.)
    expect(screen.getAllByText('BRANCH_A').length).toBeGreaterThan(0);
  });

  it('does not trigger a clear dialog for partial/invalid branch text', async () => {
    await renderAndLoadStudy();
    // The contingency picker stays visible until the operator
    // triggers a contingency, so partial input via the multi-select
    // never affects the banner / Clear flow.
    const combobox = screen.getByRole('combobox');
    await userEvent.click(combobox);
    await userEvent.type(combobox, 'INVALID_NAME');
    expect(screen.queryByText('Change Contingency?')).not.toBeInTheDocument();
  });
});

describe('Overload Clearing Logic', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.values(mockApi).forEach(m => {
      if (vi.isMockFunction(m)) m.mockReset();
    });
    // Restore defaults after reset
    mockApi.updateConfig.mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 });
    mockApi.getBranches.mockResolvedValue({ branches: ['BRANCH_A', 'BRANCH_B', 'BRANCH_C'], name_map: {} });
    mockApi.getVoltageLevels.mockResolvedValue({ voltage_levels: ['VL1', 'VL2'], name_map: {} });
    mockApi.getNominalVoltages.mockResolvedValue({ mapping: {}, unique_kv: [63, 225] });
    mockApi.getVoltageLevelSubstations.mockResolvedValue({ mapping: {} });
    mockApi.getNetworkDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null });
    mockApi.getContingencyDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null, lines_overloaded: [] });
    mockApi.runAnalysisStep1.mockResolvedValue({ can_proceed: true, lines_overloaded: ['LINE_OL1'] });
    mockApi.getActionVariantDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null });

    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('clears overloads from UI components immediately upon contingency change confirmation', async () => {
    await renderAndLoadStudy();

    // 1. Select BRANCH_A with overloads
    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      lines_overloaded: ['OL_1', 'OL_2']
    });
    await pickBranch('BRANCH_A');
    await triggerContingency();

    // The banner echoes both overloads as soon as the N-1 diagram
    // fetch resolves (sticky strip rendered by SidebarSummary).
    await waitFor(() => {
      const banner = screen.getByTestId('sidebar-summary-overloads');
      expect(banner.textContent).toMatch(/OL_1/);
      expect(banner.textContent).toMatch(/OL_2/);
    }, { timeout: 3000 });

    // Run analysis to create state
    await runAnalysis();

    // 2. Click the banner Clear shortcut — the confirmation dialog
    // appears because analysis state would otherwise be lost.
    await act(async () => {
      await userEvent.click(screen.getByTestId('sidebar-summary-clear'));
    });
    await waitFor(() => {
      expect(screen.getByText('Change Contingency?')).toBeInTheDocument();
    }, { timeout: 3000 });

    // 3. Confirm change
    fireEvent.click(screen.getByText('Confirm'));

    // 4. VERIFY IMMEDIATE CLEAR — banner falls back to the empty
    // state (no contingency, no overloads), and the picker reappears.
    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-summary-overloads')).not.toBeInTheDocument();
      expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
    });
  });

  it('clears ActionFeed overloads immediately when starting a new analysis', async () => {
    await renderAndLoadStudy();

    // Ensure analysis finds overloads
    mockApi.runAnalysisStep1.mockResolvedValue({ can_proceed: true, lines_overloaded: ['OL_1'] });

    await selectBranch('BRANCH_A');
    await runAnalysis();

    // Verify initial overloads in feed
    await waitFor(() => {
      expect(screen.getByTestId('action-feed')).toHaveAttribute('data-ol-count', '1');
    }, { timeout: 3000 });

    // Start new analysis. Slow it down to catch the 0 state.
    let resolveStep1: (val: { can_proceed: boolean; lines_overloaded: string[] }) => void;
    const slowStep1 = new Promise<{ can_proceed: boolean; lines_overloaded: string[] }>(resolve => { resolveStep1 = resolve; });
    mockApi.runAnalysisStep1.mockReturnValue(slowStep1 as Promise<{ can_proceed: boolean; lines_overloaded: string[] }>);

    await userEvent.click(screen.getByText('🔍 Analyze & Suggest'));

    // VERIFY IMMEDIATE CLEAR in ActionFeed
    await waitFor(() => {
      expect(screen.getByTestId('action-feed')).toHaveAttribute('data-ol-count', '0');
    }, { timeout: 3000 });

    // Cleanup
    resolveStep1!({ can_proceed: true, lines_overloaded: [] });
  });

  it('preserves N-1 diagram in VisualizationPanel when running analysis (regression test)', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // Initially, N-1 diagram should be present
    await waitFor(() => {
      expect(screen.getByTestId('visualization-panel')).toHaveAttribute('data-n1-diagram-present', 'true');
    });

    // Run analysis (which used to trigger clearContingencyState and wipe the diagram)
    await runAnalysis();

    // VERIFY: N-1 diagram is STILL present in the panel
    expect(screen.getByTestId('visualization-panel')).toHaveAttribute('data-n1-diagram-present', 'true');
  });
  it('pins contingency + overloads while only the action feed scrolls', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // The sidebar itself no longer scrolls — it hosts a non-scrolling
    // sticky header (contingency + overloads) and a scrolling body
    // (the ActionFeed). Scrolling down in actions must leave the
    // contingency and overload information fully visible.
    const sidebar = await screen.findByTestId('sidebar');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveStyle({ overflow: 'hidden' });

    // The ActionFeed is inside a scrolling wrapper that takes the
    // remaining sidebar height. It only mounts after a contingency
    // has been committed, mirroring the new sidebar visibility gate.
    const sidebarActionsHeader = await within(sidebar).findByTestId('action-feed-header');
    const scrollWrapper = sidebarActionsHeader.closest('div[style*="overflow-y: auto"]');
    expect(scrollWrapper).toBeInTheDocument();
    expect(scrollWrapper).toHaveStyle({ overflowY: 'auto' });
  });

  it('switches to overflow tab as soon as PDF event is received (regression test)', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // Mock a streaming response that yields a PDF event first, then delays the result
    let resolveStream: (value: void) => void;
    const streamDelay = new Promise<void>(resolve => { resolveStream = resolve; });

    const mockStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // 1. Send PDF event
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'pdf', pdf_url: '/results/pdf/graph.pdf', pdf_path: '/tmp/graph.pdf' }) + '\n'
        ));
        
        // Wait for a bit to simulate processing delay before the final result
        await streamDelay;

        // 2. Send Result event
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'result', actions: {}, lines_overloaded: ['LINE_OL1'], message: 'done', dc_fallback: false }) + '\n'
        ));
        controller.close();
      },
    });

    mockApi.runAnalysisStep2Stream.mockResolvedValue({
      ok: true,
      body: mockStream,
    });

    // Start analysis
    const runBtn = screen.getByText('🔍 Analyze & Suggest');
    await act(async () => {
      await userEvent.click(runBtn);
    });

    // VERIFY: Tab should have switched to 'overflow' immediately after PDF event, 
    // even though the stream is still pending (resolveStream not called yet).
    await waitFor(() => {
      expect(screen.getByTestId('visualization-panel')).toHaveAttribute('data-active-tab', 'overflow');
    }, { timeout: 3000 });

    // Now complete the stream
    await act(async () => {
      resolveStream();
    });

    // Final result should now be processed
    await waitFor(() => {
      expect(screen.queryByText(/Display.*prioritized actions/)).toBeInTheDocument();
    });
  });
});

// Regression: when the user selects a contingency, the N-1 diagram comes
// back from the backend with `lines_overloaded` already populated. Those
// overloaded lines must be picked up by the app state IMMEDIATELY — and
// fed into the highlight pipeline — without waiting for the user to run
// "Analyze & Suggest". The previous implementation only sourced highlight
// data from `result.lines_overloaded` (set post-analysis), so the orange
// halos never appeared on the freshly-loaded N-1 view. The pure
// computation that selects which lines to highlight is unit-tested in
// `src/utils/overloadHighlights.test.ts`. The integration assertions
// here verify the data flows through App state into the panels that
// drive that computation, even before any analysis has run.
describe('N-1 overload state is populated before action analysis', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.values(mockApi).forEach(m => {
      if (vi.isMockFunction(m)) m.mockReset();
    });
    mockApi.updateConfig.mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 });
    mockApi.getBranches.mockResolvedValue({ branches: ['BRANCH_A', 'BRANCH_B', 'BRANCH_C'], name_map: {} });
    mockApi.getVoltageLevels.mockResolvedValue({ voltage_levels: ['VL1', 'VL2'], name_map: {} });
    mockApi.getNominalVoltages.mockResolvedValue({ mapping: {}, unique_kv: [63, 225] });
    mockApi.getVoltageLevelSubstations.mockResolvedValue({ mapping: {} });
    mockApi.getNetworkDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null });
    mockApi.getContingencyDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null, lines_overloaded: [] });
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('exposes N-1 overloads + a default selection set as soon as the N-1 diagram loads (no analysis yet)', async () => {
    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      metadata: null,
      lines_overloaded: ['LINE_OL_A', 'LINE_OL_B'],
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // The sticky banner reflects the two overloads from the N-1
    // diagram fetch — and they are auto-selected (rendered as blue
    // dotted-underlined links, the SidebarSummary convention) so the
    // computeN1OverloadHighlights helper will return them as the
    // highlight set on the very next render of the N-1 tab.
    await waitFor(() => {
      const banner = screen.getByTestId('sidebar-summary-overloads');
      expect(banner.textContent).toMatch(/LINE_OL_A/);
      expect(banner.textContent).toMatch(/LINE_OL_B/);
    });

    // No analysis was run, so ``result.lines_overloaded`` is empty —
    // but the ActionFeed falls back to the N-1 diagram's authoritative
    // overload list so manual-simulation action cards display the
    // friendly pypowsybl identifiers (e.g. ``BEON L31CPVAN``) instead
    // of grid2op's synthetic ``line_<i>`` strings the backend emits
    // when no ``_analysis_context`` is set yet. See the App.tsx wiring
    // on the ``ActionFeed.linesOverloaded`` prop.
    expect(screen.getByTestId('action-feed')).toHaveAttribute('data-ol-count', '2');
    // The fallback delivers the exact friendly-name list — same
    // identifiers the OverloadPanel above is wired to — so the
    // ``ActionCard.linesOverloaded[i]`` lookup in the "Overload
    // loading after" row resolves through ``displayName`` cleanly.
    expect(screen.getByTestId('action-feed')).toHaveAttribute(
      'data-ol-names',
      'LINE_OL_A|LINE_OL_B',
    );
  });

  // Companion to the test above: once an analysis result is present,
  // ``result.lines_overloaded`` MUST win over the ``n1Diagram``
  // fallback — the step2 stream reports the resolved-and-filtered set
  // (post monitoring deselect / additional-lines etc), and that
  // authority beats the raw N-1 diagram scan. Pins both directions of
  // the App.tsx ternary on the ``ActionFeed.linesOverloaded`` prop.
  it('prefers result.lines_overloaded over the n1Diagram fallback once analysis has populated it', async () => {
    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      metadata: null,
      // Raw n1Diagram overload scan — what the fallback would surface
      // if the analysis result were empty. TWO entries.
      lines_overloaded: ['LINE_OL_A', 'LINE_OL_B'],
    });
    // Step1 filters the set down to a single resolved overload.
    mockApi.runAnalysisStep1.mockResolvedValue({
      can_proceed: true,
      lines_overloaded: ['LINE_OL_A'],
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');
    // Confirm the fallback fires pre-analysis (n1Diagram count = 2).
    await waitFor(() => {
      expect(screen.getByTestId('action-feed')).toHaveAttribute('data-ol-count', '2');
    });

    // Drive the full step1 → step2 stream → display-prioritized
    // path so ``result.lines_overloaded`` becomes non-empty.
    await runAnalysis();

    // The analysis-result list wins — single ``LINE_OL1`` from the
    // stream mock above, not the two-entry n1Diagram fallback.
    await waitFor(() => {
      expect(screen.getByTestId('action-feed')).toHaveAttribute('data-ol-count', '1');
      expect(screen.getByTestId('action-feed')).toHaveAttribute(
        'data-ol-names',
        'LINE_OL1',
      );
    });
  });

  // Regression: a useEffect in App.tsx re-seeds selectedOverloads to the
  // full n1Diagram.lines_overloaded list when the analysis memo refreshes.
  // The original implementation compared against the live selectedOverloads
  // set, so every user toggle retriggered the effect and re-added the
  // overload that was just removed ("blinks but does not switch to
  // unselected"). Lock in the fix: deselecting an overload must persist.
  it('preserves user-deselected overloads across re-renders (info bubble unselect)', async () => {
    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      metadata: null,
      lines_overloaded: ['LINE_OL_A', 'LINE_OL_B'],
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // Open the info bubble next to the Overloads banner label —
    // the popover hosts the per-overload monitoring toggles. Both
    // overloads start checked (auto-selected) so both checkboxes
    // are initially ticked.
    await waitFor(() => screen.getByTestId('sidebar-summary-overloads-bubble'));
    await act(async () => {
      screen.getByTestId('sidebar-summary-overloads-bubble').click();
    });
    const popover = await screen.findByTestId('overload-info-popover');
    const toggleA = within(popover).getByTestId('overload-info-toggle-LINE_OL_A')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    const toggleB = within(popover).getByTestId('overload-info-toggle-LINE_OL_B')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggleA.checked).toBe(true);
    expect(toggleB.checked).toBe(true);

    await act(async () => { toggleA.click(); });
    await waitFor(() => {
      expect((within(screen.getByTestId('overload-info-popover'))
        .getByTestId('overload-info-toggle-LINE_OL_A')
        .querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    });

    // Force an additional render cycle — the buggy effect retriggered on
    // every analysis-memo refresh and re-added the deselected overload.
    await act(async () => {
      (within(screen.getByTestId('overload-info-popover'))
        .getByTestId('overload-info-toggle-LINE_OL_B')
        .querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });

    await waitFor(() => {
      expect((within(screen.getByTestId('overload-info-popover'))
        .getByTestId('overload-info-toggle-LINE_OL_A')
        .querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
      expect((within(screen.getByTestId('overload-info-popover'))
        .getByTestId('overload-info-toggle-LINE_OL_B')
        .querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    });
  });

  it('replaces the overload selection when switching contingencies without running analysis', async () => {
    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      metadata: null,
      lines_overloaded: ['LINE_OL_A', 'LINE_OL_B'],
    });

    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    await waitFor(() => {
      const banner = screen.getByTestId('sidebar-summary-overloads');
      expect(banner.textContent).toMatch(/LINE_OL_A/);
      expect(banner.textContent).toMatch(/LINE_OL_B/);
    });

    mockApi.getContingencyDiagram.mockResolvedValueOnce({
      svg: '<svg></svg>',
      metadata: null,
      lines_overloaded: ['LINE_OL_C'],
    });

    // pickBranch automatically routes through the Clear shortcut
    // (no analysis state → no confirmation), so the new contingency
    // is the lone BRANCH_B rather than the legacy ['A', 'B'] append.
    await pickBranch('BRANCH_B');
    await triggerContingency();

    await waitFor(() => {
      expect(mockApi.getContingencyDiagram).toHaveBeenCalledWith(['BRANCH_B']);
      const banner = screen.getByTestId('sidebar-summary-overloads');
      expect(banner.textContent).toMatch(/LINE_OL_C/);
      expect(banner.textContent).not.toMatch(/LINE_OL_A/);
      expect(banner.textContent).not.toMatch(/LINE_OL_B/);
    });
  });
});
