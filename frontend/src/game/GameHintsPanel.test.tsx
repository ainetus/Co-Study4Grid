// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import type { GameLeverStatsResponse } from '../types';
import { gameBridge } from './gameBridge';
import GameHintsPanel from './GameHintsPanel';
import type { GameStudy } from './types';

vi.mock('../api', () => ({
  api: { getGameLeverStats: vi.fn() },
}));

const getGameLeverStats = vi.mocked(api.getGameLeverStats);

const STUDY: GameStudy = {
  id: 's1',
  label: 'Study 1',
  networkPath: 'data/grid/network.xiidm',
  actionFilePath: 'actions.json',
  contingencyElementId: 'ctg_1',
};

function stats(over: Partial<GameLeverStatsResponse> = {}): GameLeverStatsResponse {
  return {
    context_key: 'grid_network__ctg_1__abcd1234',
    total_retentions: 7,
    levers: [
      { signature: 'action:disco_LINE_A', label: 'disco_LINE_A', category: 'branch', count: 5, share: 5 / 7, sample_description: 'Ouverture LINE_A' },
      { signature: 'redispatch:G1', label: 'G1', category: 'generation', count: 3, share: 3 / 7, sample_description: null },
      { signature: 'switch:VL1_COUPL=true', label: 'VL1_COUPL', category: 'voltage_level', count: 2, share: 2 / 7, sample_description: null },
      { signature: 'ls:LOAD_9', label: 'LOAD_9', category: 'load', count: 1, share: 1 / 7, sample_description: null },
    ],
    ...over,
  };
}

describe('GameHintsPanel', () => {
  beforeEach(() => {
    getGameLeverStats.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the most-used levers with their equipment category', async () => {
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);

    await waitFor(() => expect(screen.getByText(/Most-used levers here/)).toBeInTheDocument());
    expect(getGameLeverStats).toHaveBeenCalledWith('data/grid/network.xiidm', 'ctg_1');
    expect(screen.getByText(/disco_LINE_A/)).toBeInTheDocument();
    expect(screen.getByText(/Branch · used 5×/)).toBeInTheDocument();
    expect(screen.getByText(/Generation · used 3×/)).toBeInTheDocument();
    expect(screen.getByText(/Voltage level · used 2×/)).toBeInTheDocument();
    expect(screen.getByText(/Load · used 1×/)).toBeInTheDocument();
    expect(screen.getByText(/From 7 retained solutions by all players/)).toBeInTheDocument();
  });

  it('pre-fills the Inspect field with the lever element on click', async () => {
    const inspect = vi.spyOn(gameBridge, 'requestInspect');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await waitFor(() => expect(screen.getByText(/disco_LINE_A/)).toBeInTheDocument());

    // Catalogue disco lever → the embedded branch id reaches Inspect.
    fireEvent.click(screen.getByText(/disco_LINE_A/));
    expect(inspect).toHaveBeenCalledWith('LINE_A');
    // Injection lever → the generator name itself.
    fireEvent.click(screen.getByText(/G1/));
    expect(inspect).toHaveBeenCalledWith('G1');
  });

  it('collapses to a pill and reopens', async () => {
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await waitFor(() => expect(screen.getByText(/Most-used levers here/)).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Collapse hints'));
    expect(screen.queryByText(/Most-used levers here/)).toBeNull();
    fireEvent.click(screen.getByText(/💡 Hints/));
    expect(screen.getByText(/Most-used levers here/)).toBeInTheDocument();
  });

  it('renders nothing when the base has no data for the contingency', async () => {
    getGameLeverStats.mockResolvedValue(stats({ total_retentions: 0, levers: [] }));
    const { container } = render(<GameHintsPanel study={STUDY} />);
    await waitFor(() => expect(getGameLeverStats).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the stats fetch fails', async () => {
    getGameLeverStats.mockRejectedValue(new Error('backend down'));
    const { container } = render(<GameHintsPanel study={STUDY} />);
    await waitFor(() => expect(getGameLeverStats).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
