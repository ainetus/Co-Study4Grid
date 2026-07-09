// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { gameBridge } from './gameBridge';
import { useGameSession } from './useGameSession';
import type { GameSessionConfig, GameStudy } from './types';

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

describe('useGameSession', () => {
  beforeEach(() => {
    // App is not mounted in this unit test, so no loader is registered with
    // the bridge — stub the load so each study reaches the "playing" phase.
    vi.spyOn(gameBridge, 'loadStudy').mockResolvedValue(undefined);
    gameBridge.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    gameBridge.reset();
  });

  /** Publish the player's chosen actions for the current study, then commit. */
  async function playAndAdvance(
    result: { current: ReturnType<typeof useGameSession> },
    rho: number,
  ) {
    act(() => {
      gameBridge.publishSnapshot({
        contingencyElementIds: [],
        baselineMaxRho: 1.3,
        chosenActions: [{ actionId: 'a', maxRho: rho, solved: rho < 1.0 }],
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
