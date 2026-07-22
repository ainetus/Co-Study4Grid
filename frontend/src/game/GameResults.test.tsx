// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GameResults from './GameResults';
import type { GameSessionLog, GameStudyResult } from './types';

function studyResult(over: Partial<GameStudyResult> = {}): GameStudyResult {
  return {
    studyId: 's1',
    label: 'Study 1',
    contingencyElementId: 'ctg_1',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:03:00Z',
    durationMs: 180000,
    timedOut: false,
    timeLimitSeconds: 300,
    maxActions: 3,
    actionsChosen: [
      { actionId: 'disco_A', description: 'Ouverture A', maxRho: 0.9, solved: true },
    ],
    numActions: 1,
    baselineMaxRho: 1.2,
    finalMaxRho: 0.9,
    solved: true,
    ...over,
  };
}

function sessionLog(studies: GameStudyResult[]): GameSessionLog {
  return {
    schemaVersion: '1.0',
    sessionName: 'Test session',
    player: 'alice',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:10:00Z',
    config: { timerSeconds: 300, maxActions: 3, nStudies: studies.length },
    studies,
  };
}

describe('GameResults — solution capitalisation feedback', () => {
  it('shows the novelty bonus, badges and usage frequencies', () => {
    const log = sessionLog([
      studyResult({
        solutionFeedback: {
          studyId: 's1',
          novelty: { newProposition: true, newLevers: ['action:disco_A'], effective: true, bonusPoints: 20 },
          frequencies: [
            { actionId: 'disco_A', description: 'Ouverture A', count: 0, total: 0, share: 0 },
          ],
        },
      }),
      studyResult({
        studyId: 's2',
        label: 'Study 2',
        solutionFeedback: {
          studyId: 's2',
          novelty: { newProposition: false, newLevers: [], effective: true, bonusPoints: 0 },
          frequencies: [
            { actionId: 'reco_B', description: 'Fermeture B', count: 3, total: 4, share: 0.75 },
          ],
        },
      }),
    ]);

    render(<GameResults log={log} onReplay={vi.fn()} />);

    // Headline bonus on top of the Codabench score.
    expect(screen.getByText(/\+20 novelty bonus pts/)).toBeInTheDocument();
    // Per-study novelty badge.
    expect(screen.getByText(/🌟 new \+20/)).toBeInTheDocument();
    // Frequency feedback section with both wordings.
    expect(screen.getByText(/first solution ever retained on this contingency/)).toBeInTheDocument();
    expect(screen.getByText(/retained in 3 \/ 4 prior retentions \(75%\)/)).toBeInTheDocument();
  });

  it('adds the bonus to the scenario that earned it, not just to the global score', () => {
    // Single study: physical=60, actions=25, time=6 -> sc.total=91, +20 bonus -> 111.0.
    const log = sessionLog([
      studyResult({
        solutionFeedback: {
          studyId: 's1',
          novelty: { newProposition: true, newLevers: ['action:disco_A'], effective: true, bonusPoints: 20 },
          frequencies: [],
        },
      }),
    ]);

    render(<GameResults log={log} onReplay={vi.fn()} />);

    // Score column shows the bonus-inclusive total for that scenario, with
    // a breakdown of the base + bonus, not the bare base score.
    expect(screen.getByText('111.0')).toBeInTheDocument();
    expect(screen.getByText('91.0 + 20 bonus')).toBeInTheDocument();
    // The session-level "with bonus" figure matches the same 111.0 (mean
    // of one bonus-inclusive study), not a naive base + total-bonus sum.
    expect(screen.getByText(/session score with bonus: 111\.0/)).toBeInTheDocument();
  });

  it('flags a novel-but-ineffective proposition without paying the bonus', () => {
    const log = sessionLog([
      studyResult({
        solutionFeedback: {
          studyId: 's1',
          novelty: { newProposition: true, newLevers: ['action:disco_A'], effective: false, bonusPoints: 0 },
          frequencies: [
            { actionId: 'disco_A', description: 'Ouverture A', count: 0, total: 0, share: 0 },
          ],
        },
      }),
    ]);
    render(<GameResults log={log} onReplay={vi.fn()} />);
    expect(screen.getByText(/🌟 new \(no bonus\)/)).toBeInTheDocument();
    // No headline bonus line when nothing was earned.
    expect(screen.queryByText(/novelty bonus pts/)).toBeNull();
  });

  it('stays silent when no feedback was collected', () => {
    render(<GameResults log={sessionLog([studyResult()])} onReplay={vi.fn()} />);
    expect(screen.queryByText(/novelty bonus/)).toBeNull();
    expect(screen.queryByText(/shared solution base/)).toBeNull();
  });
});
