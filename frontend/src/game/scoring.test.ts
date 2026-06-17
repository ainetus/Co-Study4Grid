// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { scoreStudy, scoreSession } from './scoring';
import { buildSessionLog, buildSessionCsv } from './gameLog';
import type { GameSessionConfig, GameStudyResult } from './types';

function study(over: Partial<GameStudyResult> = {}): GameStudyResult {
  return {
    studyId: 's', label: 'S', contingencyElementId: 'c',
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 0, timedOut: false, timeLimitSeconds: 180, maxActions: 3,
    actionsChosen: [], numActions: 1, baselineMaxRho: 1.3, finalMaxRho: 0.9,
    solved: true, ...over,
  };
}

describe('scoreStudy — mirrors scoring_program/score.py', () => {
  it('perfect study scores 100', () => {
    expect(scoreStudy(study({ finalMaxRho: 0.9, solved: true, numActions: 1, durationMs: 0 })).total)
      .toBeCloseTo(100, 5);
  });

  it('no action scores 0', () => {
    expect(scoreStudy(study({ numActions: 0, finalMaxRho: null, solved: false })).total)
      .toBeCloseTo(0, 5);
  });

  it('partial relief gets physical credit only (unsolved, timed out)', () => {
    const sc = scoreStudy(study({
      solved: false, finalMaxRho: 1.18, numActions: 1,
      durationMs: 180000, timeLimitSeconds: 180,
    }));
    expect(sc.remediationFraction).toBeCloseTo(0.4, 5);
    expect(sc.total).toBeCloseTo(34, 5); // 60*.4 + 25*.4 + 0
  });

  it('action economy penalizes more actions', () => {
    const one = scoreStudy(study({ numActions: 1, durationMs: 0 }));
    const three = scoreStudy(study({ numActions: 3, durationMs: 0 }));
    expect(one.actions).toBeCloseTo(25, 5);
    expect(three.actions).toBeCloseTo(25 * (1 - 2 / 3), 5);
    expect(one.total).toBeGreaterThan(three.total);
  });

  it('time efficiency penalizes slow solves', () => {
    expect(scoreStudy(study({ durationMs: 0 })).time).toBeCloseTo(15, 5);
    expect(scoreStudy(study({ durationMs: 180000, timeLimitSeconds: 180 })).time).toBeCloseTo(0, 5);
  });
});

describe('scoreSession + log/csv', () => {
  const cfg: GameSessionConfig = {
    sessionName: 'T', timerSeconds: 180, maxActions: 3, studies: [],
  };

  it('session score is the mean of per-study scores', () => {
    const log = buildSessionLog(cfg, [
      study({ studyId: 'a', finalMaxRho: 0.9, durationMs: 0, numActions: 1 }), // 100
      study({ studyId: 'b', numActions: 0, finalMaxRho: null, solved: false }), // 0
    ], 'start', 'end');
    expect(scoreSession(log).finalScore).toBeCloseTo(50, 5);
    expect(scoreSession(log).solvedCount).toBe(1);
  });

  it('CSV has a header + one row per study', () => {
    const log = buildSessionLog(cfg, [study({ studyId: 'a' })], 'start', 'end');
    const lines = buildSessionCsv(log).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('final_max_rho');
    expect(lines[1]).toContain('a');
  });
});
