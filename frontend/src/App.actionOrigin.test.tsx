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

// End-to-end coverage for action-card provenance ("origin"). Unlike the
// other App.*.test.tsx files, this one does NOT mock ActionFeed — it
// renders the real ActionFeed + ActionCard so the "Source" row in the
// unfolded card can be asserted. The whole wiring chain is exercised:
// useAnalysis / useActions stamp `origin` → App's `result` → ActionFeed
// `actions` + `availableModels` props → ActionCard "Source" row.

// ===== Mocks (everything EXCEPT ActionFeed) =====

vi.mock('./components/VisualizationPanel', () => ({
  default: (props: { activeTab: string }) => (
    <div data-testid="visualization-panel" data-active-tab={props.activeTab} />
  ),
}));

vi.mock('./components/OverloadPanel', () => ({
  default: () => <div data-testid="overload-panel" />,
}));

vi.mock('./hooks/usePanZoom', () => ({
  usePanZoom: () => ({ viewBox: null, setViewBox: vi.fn() }),
}));

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
  // ActionFeed filters its card list through this — always pass so the
  // origin assertions aren't masked by the severity/threshold gate.
  actionPassesOverviewFilter: vi.fn(() => true),
  getActionTargetVoltageLevels: vi.fn(() => []),
  getActionTargetLines: vi.fn(() => []),
}));

const mockApi = vi.hoisted(() => ({
  updateConfig: vi.fn().mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 }),
  getBranches: vi.fn().mockResolvedValue({ branches: ['BRANCH_A', 'BRANCH_B'], name_map: {} }),
  getVoltageLevels: vi.fn().mockResolvedValue({ voltage_levels: ['VL1', 'VL2'], name_map: {} }),
  getNominalVoltages: vi.fn().mockResolvedValue({ mapping: {}, unique_kv: [63, 225] }),
  getVoltageLevelSubstations: vi.fn().mockResolvedValue({ mapping: {} }),
  getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  getContingencyDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null, lines_overloaded: [] }),
  getActionVariantDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  runAnalysisStep1: vi.fn().mockResolvedValue({ can_proceed: true, lines_overloaded: ['LINE_OL1'] }),
  runAnalysisStep2Stream: vi.fn(),
  simulateAndVariantDiagramStream: vi.fn(),
  getAvailableActions: vi.fn().mockResolvedValue([]),
  getModels: vi.fn().mockResolvedValue({
    models: [
      { name: 'expert', label: 'Expert system', requires_overflow_graph: true, is_default: true, params: [] },
    ],
  }),
  setRecommenderModel: vi.fn().mockResolvedValue({ status: 'success', active_model: 'expert', compute_overflow_graph: true }),
  pickPath: vi.fn(),
  getUserConfig: vi.fn().mockResolvedValue({
    network_path: '/home/user/data/grid.xiidm',
    action_file_path: '/home/user/data/actions.json',
  }),
  getConfigFilePath: vi.fn().mockResolvedValue('/home/user/data/config.json'),
  saveUserConfig: vi.fn().mockResolvedValue({}),
  setConfigFilePath: vi.fn().mockResolvedValue({ config_file_path: '/home/user/data/config.json', config: {} }),
}));

vi.mock('./api', () => ({ api: mockApi }));

// ===== Helpers =====

/** Build a one-shot ReadableStream from a list of NDJSON event objects. */
function ndjsonStream(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      controller.close();
    },
  });
}

async function renderAndLoadStudy() {
  render(<App />);
  await userEvent.click(screen.getByText('🔄 Load Study'));
  await waitFor(() => {
    expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
  }, { timeout: 5000 });
}

async function selectBranch(branchName: string) {
  // Two comboboxes exist now that the real ActionFeed renders: the
  // contingency react-select (an <input role="combobox">) and the
  // recommendation-model <select> above Analyze & Suggest. Target the
  // react-select input.
  const comboboxes = screen.getAllByRole('combobox');
  const combobox = comboboxes.find(el => el.tagName === 'INPUT') ?? comboboxes[0];
  await act(async () => {
    await userEvent.click(combobox);
    await userEvent.type(combobox, branchName);
    await userEvent.keyboard('{Enter}');
  });
  const trigger = await screen.findByRole('button', { name: /Trigger/ });
  await act(async () => { await userEvent.click(trigger); });
  await waitFor(() => {
    expect(mockApi.getContingencyDiagram).toHaveBeenCalledWith([branchName]);
  });
}

describe('App — action-card origin (provenance) end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.unstubAllGlobals();
    // Restore default resolved values cleared by clearAllMocks.
    mockApi.updateConfig.mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 });
    mockApi.getBranches.mockResolvedValue({ branches: ['BRANCH_A', 'BRANCH_B'], name_map: {} });
    mockApi.getVoltageLevels.mockResolvedValue({ voltage_levels: ['VL1', 'VL2'], name_map: {} });
    mockApi.getNominalVoltages.mockResolvedValue({ mapping: {}, unique_kv: [63, 225] });
    mockApi.getVoltageLevelSubstations.mockResolvedValue({ mapping: {} });
    mockApi.getNetworkDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null });
    mockApi.getContingencyDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null, lines_overloaded: [] });
    mockApi.getActionVariantDiagram.mockResolvedValue({ svg: '<svg></svg>', metadata: null });
    mockApi.runAnalysisStep1.mockResolvedValue({ can_proceed: true, lines_overloaded: ['LINE_OL1'] });
    mockApi.getAvailableActions.mockResolvedValue([]);
    mockApi.getModels.mockResolvedValue({
      models: [
        { name: 'expert', label: 'Expert system', requires_overflow_graph: true, is_default: true, params: [] },
      ],
    });
    mockApi.getUserConfig.mockResolvedValue({
      network_path: '/home/user/data/grid.xiidm',
      action_file_path: '/home/user/data/actions.json',
    });
    mockApi.getConfigFilePath.mockResolvedValue('/home/user/data/config.json');
    mockApi.setConfigFilePath.mockResolvedValue({ config_file_path: '/home/user/data/config.json', config: {} });
  });
  afterEach(() => cleanup());

  it('stamps a recommender-produced action with the model origin and shows it in the unfolded card', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // Step-2 stream: a single recommender action + the active_model echo.
    mockApi.runAnalysisStep2Stream.mockResolvedValue({
      ok: true,
      body: ndjsonStream([
        {
          type: 'result',
          actions: {
            ACT_RECO: {
              description_unitaire: 'Disconnect LINE_X',
              rho_before: [1.05], rho_after: [0.85],
              max_rho: 0.85, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
            },
          },
          active_model: 'expert',
          lines_overloaded: ['LINE_OL1'],
          message: 'done', dc_fallback: false,
        },
      ]),
    });

    await act(async () => { await userEvent.click(screen.getByText('🔍 Analyze & Suggest')); });
    const displayBtn = await screen.findByText(/Display.*prioritized actions/, {}, { timeout: 3000 });
    await act(async () => { await userEvent.click(displayBtn); });

    // The recommender action card is now in the Suggested feed. Click it
    // to unfold the progressive-disclosure section.
    const card = await screen.findByTestId('action-card-ACT_RECO');
    await act(async () => { await userEvent.click(card); });

    // The "Source" row resolves the `active_model` id ("expert") to its
    // human label via availableModels (GET /api/models).
    const originRow = await screen.findByTestId('action-card-ACT_RECO-origin');
    expect(originRow).toHaveTextContent('Source: Expert system');
  });

  it('stamps a manually-simulated action with origin "user" and shows it in the unfolded card', async () => {
    await renderAndLoadStudy();
    await selectBranch('BRANCH_A');

    // The manual-simulation flow at the App level goes through the
    // streaming primer (onActionDiagramPrimed is wired), so mock
    // simulateAndVariantDiagramStream with a metrics + diagram event.
    mockApi.simulateAndVariantDiagramStream.mockResolvedValue({
      body: ndjsonStream([
        {
          type: 'metrics',
          description_unitaire: 'Manually chosen action',
          rho_before: [1.1], rho_after: [0.9],
          max_rho: 0.9, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
          is_islanded: false, n_components: 1, disconnected_mw: 0,
          non_convergence: null, lines_overloaded: ['LINE_OL1'],
          lines_overloaded_after: [], load_shedding_details: [],
          curtailment_details: [], pst_details: [],
          action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} },
          is_estimated: false,
        },
        { type: 'diagram', svg: '<svg></svg>', metadata: null },
      ]),
    });

    // Open the manual-selection search and simulate a free-text action id.
    await act(async () => { await userEvent.click(screen.getByText('+ Manual Selection')); });
    const search = await screen.findByPlaceholderText(/Search action/);
    await act(async () => { await userEvent.type(search, 'my_manual_action'); });
    await act(async () => { await userEvent.click(screen.getByText(/Simulate manual ID/)); });

    // handleManualActionAdded auto-selects the new action, so its card
    // is already unfolded — the "Source" row reads the literal "user".
    const originRow = await screen.findByTestId('action-card-my_manual_action-origin', {}, { timeout: 3000 });
    expect(originRow).toHaveTextContent('Source: Manual simulation (user)');
  });
});
