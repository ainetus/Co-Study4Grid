// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import type { GameLeverStatsResponse } from '../types';
import { gameBridge } from './gameBridge';
import GameHintsPanel from './GameHintsPanel';
import type { GameStudy } from './types';

vi.mock('../api', () => ({
  api: { getGameLeverStats: vi.fn() },
}));

const getGameLeverStats = vi.mocked(api.getGameLeverStats);

/** A promise whose resolution the test controls (to hold a simulation open). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Publish an App-side snapshot with the given materialised action ids. */
function publishSimulated(simulatedActionIds: string[]): void {
  gameBridge.publishSnapshot({
    contingencyElementIds: ['ctg_1'],
    baselineMaxRho: 1.2,
    chosenActions: [],
    simulatedActionIds,
  });
}

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
    gameBridge.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gameBridge.reset();
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

  it('requests an inspect interaction after the single-click delay', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);

    // Single-click is deferred so a double-click can pre-empt it.
    fireEvent.click(screen.getByText(/disco_LINE_A/));
    expect(lever).not.toHaveBeenCalled();
    await waitFor(() => expect(lever).toHaveBeenCalledWith(
      expect.objectContaining({ inspectQuery: 'LINE_A', simulate: { actionId: 'disco_LINE_A' } }),
      'inspect',
    ));
  });

  it('requests a simulate interaction on double-click and cancels the pending inspect', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/VL1_COUPL/);

    const target = screen.getByText(/VL1_COUPL/);
    fireEvent.click(target);       // schedules the deferred inspect
    fireEvent.doubleClick(target); // pre-empts it and fires the simulate now

    expect(lever).toHaveBeenCalledTimes(1);
    expect(lever).toHaveBeenCalledWith(
      expect.objectContaining({ inspectQuery: 'VL1_COUPL', simulate: { switches: { VL1_COUPL: true } } }),
      'simulate',
    );
    // Wait past the single-click delay — the pending inspect stays cancelled
    // (also lets the async simulate settle its status state inside act).
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(lever).toHaveBeenCalledTimes(1);
  });

  it('single-clicks an injection lever to inspect (even though it can simulate)', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/G1/);

    fireEvent.click(screen.getByText(/G1/));
    await waitFor(() => expect(lever).toHaveBeenCalled());
    const [interaction, mode] = lever.mock.calls.at(-1)!;
    // A redispatch lever now carries a simulate spec (default incremental
    // delta), but a single-click still only locates & inspects it.
    expect(interaction).toMatchObject({
      inspectQuery: 'G1', category: 'generation', simulate: { actionId: 'redispatch_G1' },
    });
    expect(mode).toBe('inspect');
  });

  it('double-clicks a catalogue branch lever to a simulate-by-action-id', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);

    const target = screen.getByText(/disco_LINE_A/);
    fireEvent.click(target);
    fireEvent.doubleClick(target);

    expect(lever).toHaveBeenCalledTimes(1);
    expect(lever).toHaveBeenCalledWith(
      expect.objectContaining({ inspectQuery: 'LINE_A', simulate: { actionId: 'disco_LINE_A' } }),
      'simulate',
    );
    await act(async () => { await Promise.resolve(); }); // settle the async status update
  });

  it('double-clicks a redispatch lever to simulate it (default incremental delta)', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/G1/);

    const target = screen.getByText(/G1/);
    fireEvent.click(target);
    fireEvent.doubleClick(target);

    // The lever maps to the backend dynamic-action id; simulated with no MW so
    // the backend applies its default incremental injection delta.
    expect(lever).toHaveBeenCalledWith(
      expect.objectContaining({ inspectQuery: 'G1', simulate: { actionId: 'redispatch_G1' } }),
      'simulate',
    );
    await waitFor(() => expect(lever).toHaveBeenCalled());
  });

  it('shows a simulating → simulated transition on a lever double-click', async () => {
    const d = deferred();
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction').mockReturnValue(d.promise);
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);

    fireEvent.doubleClick(screen.getByText(/disco_LINE_A/));
    expect(lever).toHaveBeenCalledWith(
      expect.objectContaining({ simulate: { actionId: 'disco_LINE_A' } }), 'simulate');
    const status = await screen.findByTestId('game-lever-status-action:disco_LINE_A');
    expect(status).toHaveTextContent(/simulating/);

    // Resolve the run and let App publish the materialised action id.
    await act(async () => { d.resolve(); await d.promise; publishSimulated(['disco_LINE_A']); });
    await waitFor(() => expect(
      screen.getByTestId('game-lever-status-action:disco_LINE_A')).toHaveTextContent(/simulated/));
  });

  it('marks a lever simulated when its action arrives through the suggestions', async () => {
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);
    // No double-click here — the recommender simulated it and App published it.
    act(() => publishSimulated(['disco_LINE_A']));
    await waitFor(() => expect(
      screen.getByTestId('game-lever-status-action:disco_LINE_A')).toHaveTextContent(/simulated/));
  });

  it('blocks a second simulation once a lever is already simulated', async () => {
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction');
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);
    act(() => publishSimulated(['disco_LINE_A']));
    await waitFor(() => expect(
      screen.getByTestId('game-lever-status-action:disco_LINE_A')).toHaveTextContent(/simulated/));

    fireEvent.doubleClick(screen.getByText(/disco_LINE_A/));
    expect(lever).not.toHaveBeenCalled();
  });

  it('ignores a second double-click while a simulation is still in flight', async () => {
    const d = deferred();
    const lever = vi.spyOn(gameBridge, 'requestLeverInteraction').mockReturnValue(d.promise);
    getGameLeverStats.mockResolvedValue(stats());
    render(<GameHintsPanel study={STUDY} />);
    await screen.findByText(/disco_LINE_A/);

    const target = screen.getByText(/disco_LINE_A/);
    fireEvent.doubleClick(target);
    await screen.findByTestId('game-lever-status-action:disco_LINE_A');
    fireEvent.doubleClick(target); // still simulating → ignored
    expect(lever).toHaveBeenCalledTimes(1);

    await act(async () => { d.resolve(); await d.promise; });
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
