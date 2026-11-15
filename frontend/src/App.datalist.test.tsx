import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import App from './App';

// Reuse the basic mocks
vi.mock('./components/VisualizationPanel', () => ({
  default: () => <div data-testid="visualization-panel"></div>
}));
vi.mock('./components/ActionFeed', () => ({ default: () => <div /> }));
vi.mock('./components/OverloadPanel', () => ({ default: () => <div /> }));
vi.mock('./hooks/usePanZoom', () => ({ usePanZoom: () => ({ viewBox: null, setViewBox: vi.fn() }) }));

const mockApi = vi.hoisted(() => ({
  updateConfig: vi.fn().mockResolvedValue({ monitored_lines_count: 10, total_lines_count: 10 }),
  getBranches: vi.fn().mockResolvedValue({ branches: [], name_map: {} }),
  getVoltageLevels: vi.fn().mockResolvedValue({ voltage_levels: ['VL1'], name_map: {} }),
  getNominalVoltages: vi.fn().mockResolvedValue({ mapping: {}, unique_kv: [63, 225] }),
  getVoltageLevelSubstations: vi.fn().mockResolvedValue({ mapping: {} }),
  // Context tab (useContextMap): no situation map in these tests.
  getContextMap: vi.fn().mockResolvedValue(null),
  getContextMapElements: vi.fn().mockResolvedValue([]),
  getNetworkDiagram: vi.fn().mockResolvedValue({ svg: '<svg></svg>', metadata: null }),
  getUserConfig: vi.fn().mockResolvedValue({ network_path: '/path', action_file_path: '/path' }),
  getConfigFilePath: vi.fn().mockResolvedValue('/config'),
  saveUserConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('./api', () => ({ api: mockApi }));

describe('Datalist performance clamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('exposes all branches through the contingency multi-select dropdown', async () => {
    // The legacy <datalist> input was replaced by a react-select
    // multi-select (PR `claude/add-nk-contingency-support-hnMwD`),
    // which renders an internal <input role="combobox">. The Chromium
    // lockup from 1000+ <option> children no longer applies because
    // react-select filters as the user types. Sanity-check that the
    // combobox is wired up and opens its menu when focused.
    const largeBranches = Array.from({ length: 150 }, (_, i) => `BRANCH_${i}`);
    mockApi.getBranches.mockResolvedValue({ branches: largeBranches, name_map: {} });

    render(<App />);
    const loadBtn = screen.getByText('🔄 Load Study');
    await act(async () => { await userEvent.click(loadBtn); });

    await waitFor(() => {
      expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
    }, { timeout: 5000 });

    const combobox = screen.getByRole('combobox');
    expect(combobox).toBeInTheDocument();
    await act(async () => { await userEvent.click(combobox); });
    // Filtering on a unique substring narrows the menu to a single
    // hit — guards that the option list is fed from ``branches``.
    await act(async () => { await userEvent.type(combobox, 'BRANCH_42'); });
    await waitFor(() => {
      expect(screen.getByText('BRANCH_42')).toBeInTheDocument();
    });
  });
});
