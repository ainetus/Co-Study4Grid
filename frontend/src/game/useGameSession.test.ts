// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api } from '../api';
import type { LogGameSolutionResponse } from '../types';
import { gameBridge } from './gameBridge';
import { useGameSession } from './useGameSession';
import type { ChosenActionRecord, GameSessionConfig, GameStudy } from './types';

vi.mock('../api', () => ({
  api: { logGameSolution: vi.fn() },
}));

const logGameSolution = vi.mocked(api.logGameSolution);

function study(id: string): GameStudy {
  return {
    id,
    label: `Study ${id}`,
    networkPath: 'net.xiidm',
    actionFilePath: 'actions.json',
    contingencyElementId: `ctg_${id}`,
    contingencyLabel: `Contingency ${id}`,
  };
}

const CONFIG: GameSessionConfig = {
  sessionName: 'Test session',
  player: 'tester',
  // Large timer so the per-second countdown never auto-advances mid-test.
  timerSeconds: 600,
  maxActions: 3,
  studies: [study('s1'), study('s2'), study('s3')],
};

function logResponse(over: Partial<LogGameSolutionResponse> = {}): LogGameSolutionResponse {
  return {
    stored: true,
    duplicate: false,
    context_key: 'net__ctg',
    signature: 'action:a',
    novelty: { new_proposition: false, new_levers: [], effective: true, bonus_points: 0 },
    frequencies: [
      { action_id: 'a', description: null, signatures: ['action:a'], count: 2, total: 4, share: 0.5 },
    ],
    context_stats: { distinct_propositions: 3, total_retentions: 5 },
    ...over,
  };
}

describe('useGameSession', () => {
  beforeEach(() => {
    // App is not mounted in this unit test, so no loader is registered with
    // the bridge — stub the load so each study reaches the "playing" phase.
    vi.spyOn(gameBridge, 'loadStudy').mockResolvedValue(undefined);
    gameBridge.reset();
    logGameSolution.mockReset();
    logGameSolution.mockResolvedValue(logResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gameBridge.reset();
  });

  /** Publish the player's chosen actions for the current study, then commit. */
  async function playAndAdvance(
    result: { current: ReturnType<typeof useGameSession> },
    rho: number,
    chosenActions?: ChosenActionRecord[],
  ) {
    act(() => {
      gameBridge.publishSnapshot({
        contingencyElementIds: [],
        baselineMaxRho: 1.3,
        chosenActions: chosenActions
          ?? [{ actionId: 'a', maxRho: rho, solved: rho < 1.0 }],
      });
    });
    await act(async () => {
      result.current.advance();
    });
  }

  it('records EVERY study — including the last one — in the final log', async () => {
    const { result } = renderHook(() => useGameSession());

    await act(async () => {
      result.current.startSession(CONFIG);
    });
    await waitFor(() => expect(result.current.phase).toBe('playing'));
    expect(result.current.currentIndex).toBe(0);

    // Study 1 (solved) → advance to study 2.
    await playAndAdvance(result, 0.9);
    await waitFor(() => expect(result.current.currentIndex).toBe(1));
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    // Study 2 (unsolved) → advance to study 3.
    await playAndAdvance(result, 1.1);
    await waitFor(() => expect(result.current.currentIndex).toBe(2));
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    // Study 3 is the LAST one: committing it ends the session and builds the
    // log on the next synchronous line. This is exactly the case the
    // resultsRef timing bug used to drop.
    await playAndAdvance(result, 0.7);
    await waitFor(() => expect(result.current.phase).toBe('results'));

    const log = result.current.sessionLog!;
    expect(log).not.toBeNull();
    expect(log.studies).toHaveLength(3);
    expect(log.studies.map((s) => s.studyId)).toEqual(['s1', 's2', 's3']);

    // The last study's recorded outcome must be present and correct.
    const last = log.studies[2];
    expect(last.studyId).toBe('s3');
    expect(last.finalMaxRho).toBeCloseTo(0.7);
    expect(last.solved).toBe(true);

    // And the per-study solved flags survive for all three.
    expect(log.studies.map((s) => s.solved)).toEqual([true, false, true]);
    expect(log.config.nStudies).toBe(3);
  });

  it('capitalises the retained proposition at each study commit', async () => {
    const { result } = renderHook(() => useGameSession());
    await act(async () => { result.current.startSession(CONFIG); });
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    await playAndAdvance(result, 0.9);
    await waitFor(() => expect(logGameSolution).toHaveBeenCalledTimes(1));
    expect(logGameSolution).toHaveBeenCalledWith(expect.objectContaining({
      player: 'tester',
      session_name: 'Test session',
      study_id: 's1',
      network_path: 'net.xiidm',
      contingency_id: 'ctg_s1',
      solved: true,
      actions: [expect.objectContaining({ action_id: 'a' })],
    }));
  });

  it('skips the log when the player retained no action', async () => {
    const { result } = renderHook(() => useGameSession());
    await act(async () => { result.current.startSession(CONFIG); });
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    await playAndAdvance(result, 0.9, []);
    await waitFor(() => expect(result.current.currentIndex).toBe(1));
    expect(logGameSolution).not.toHaveBeenCalled();
  });

  it('merges the async feedback into the study result and the final log', async () => {
    logGameSolution.mockResolvedValue(logResponse({
      novelty: { new_proposition: true, new_levers: ['action:a'], effective: true, bonus_points: 20 },
    }));
    const shortConfig = { ...CONFIG, studies: [study('s1')] };
    const { result } = renderHook(() => useGameSession());
    await act(async () => { result.current.startSession(shortConfig); });
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    // Committing the only study ends the session; the feedback response
    // lands AFTER the results phase and must still reach the derived log.
    await playAndAdvance(result, 0.9);
    await waitFor(() => expect(result.current.phase).toBe('results'));
    await waitFor(() =>
      expect(result.current.sessionLog?.studies[0].solutionFeedback).toBeDefined());

    const feedback = result.current.sessionLog!.studies[0].solutionFeedback!;
    expect(feedback.novelty).toEqual({
      newProposition: true, newLevers: ['action:a'], effective: true, bonusPoints: 20,
    });
    expect(feedback.frequencies[0]).toMatchObject({ actionId: 'a', count: 2, total: 4 });

    // A new proposition also raises the in-play novelty toast.
    expect(result.current.noveltyToast?.novelty.bonusPoints).toBe(20);
    act(() => { result.current.dismissNoveltyToast(); });
    expect(result.current.noveltyToast).toBeNull();
  });

  it('does not toast a novel proposition whose actions were not effective', async () => {
    logGameSolution.mockResolvedValue(logResponse({
      novelty: { new_proposition: true, new_levers: ['action:a'], effective: false, bonus_points: 0 },
    }));
    const { result } = renderHook(() => useGameSession());
    await act(async () => { result.current.startSession(CONFIG); });
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    await playAndAdvance(result, 0.9);
    await waitFor(() =>
      expect(result.current.results[0]?.solutionFeedback).toBeDefined());
    expect(result.current.results[0].solutionFeedback!.novelty.bonusPoints).toBe(0);
    expect(result.current.noveltyToast).toBeNull();
  });

  it('keeps the game running when the solution log fails', async () => {
    logGameSolution.mockRejectedValue(new Error('backend down'));
    const { result } = renderHook(() => useGameSession());
    await act(async () => { result.current.startSession(CONFIG); });
    await waitFor(() => expect(result.current.phase).toBe('playing'));

    await playAndAdvance(result, 0.9);
    await waitFor(() => expect(result.current.currentIndex).toBe(1));
    await waitFor(() => expect(result.current.phase).toBe('playing'));
    expect(result.current.results[0].solutionFeedback).toBeUndefined();
    expect(result.current.noveltyToast).toBeNull();
  });

  // QW24: mid-session load failure must be recoverable, and must not destroy
  // the results already committed.
  it('retryStudy re-attempts a study that failed to load', async () => {
    const loadSpy = vi.spyOn(gameBridge, 'loadStudy')
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useGameSession());

    await act(async () => { result.current.startSession(CONFIG); });
    // First load failed → stuck on the loading screen with an error.
    expect(result.current.phase).toBe('loading');
    expect(result.current.loadError).toBe('backend down');

    await act(async () => { result.current.retryStudy(); });
    expect(result.current.phase).toBe('playing');
    expect(result.current.loadError).toBeNull();
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it('finishEarly ends the session with the already-committed results (no data loss)', async () => {
    vi.spyOn(gameBridge, 'loadStudy')
      .mockResolvedValueOnce(undefined)            // study 1 loads
      .mockRejectedValue(new Error('backend down')); // study 2 fails
    const { result } = renderHook(() => useGameSession());

    await act(async () => { result.current.startSession(CONFIG); });
    await playAndAdvance(result, 0.8); // commit study 1, then study 2's load fails
    expect(result.current.phase).toBe('loading');
    expect(result.current.loadError).toBe('backend down');
    expect(result.current.results).toHaveLength(1);

    await act(async () => { result.current.finishEarly(); });
    expect(result.current.phase).toBe('results');
    const log = result.current.sessionLog;
    expect(log).not.toBeNull();
    expect(log!.studies).toHaveLength(1);
    expect(log!.studies[0].studyId).toBe('s1');
  });
});
