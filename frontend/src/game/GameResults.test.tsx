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
          novelty: { newProposition: true, newLevers: ['action:disco_A'], bonusPoints: 10 },
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
          novelty: { newProposition: false, newLevers: [], bonusPoints: 0 },
          frequencies: [
            { actionId: 'reco_B', description: 'Fermeture B', count: 3, total: 4, share: 0.75 },
          ],
        },
      }),
    ]);

    render(<GameResults log={log} onReplay={vi.fn()} />);

    // Headline bonus on top of the Codabench score.
    expect(screen.getByText(/\+10 novelty bonus pts/)).toBeInTheDocument();
    // Per-study novelty badge.
    expect(screen.getByText(/🌟 new \+10/)).toBeInTheDocument();
    // Frequency feedback section with both wordings.
    expect(screen.getByText(/first solution ever retained on this contingency/)).toBeInTheDocument();
    expect(screen.getByText(/retained in 3 \/ 4 prior retentions \(75%\)/)).toBeInTheDocument();
  });

  it('stays silent when no feedback was collected', () => {
    render(<GameResults log={sessionLog([studyResult()])} onReplay={vi.fn()} />);
    expect(screen.queryByText(/novelty bonus/)).toBeNull();
    expect(screen.queryByText(/shared solution base/)).toBeNull();
  });
});
