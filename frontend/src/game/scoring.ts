// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { GameSessionLog, GameStudyResult } from './types';

// ---------------------------------------------------------------------------
// Shared scoring model.
//
// This is the SINGLE SOURCE OF TRUTH for how a game session is scored, kept
// deliberately simple so it can be reproduced exactly by the Codabench
// `scoring_program/score.py` (see that file's docstring — the two must stay
// numerically identical). The frontend uses it for the live results preview;
// the Codabench scorer uses the Python twin to rank submissions.
//
// Per study (0..100):
//   physical  = 60 * remediationFraction
//   actions   = 25 * remediationFraction * actionEfficiency
//   time      = 15 * remediationFraction * timeEfficiency
// where:
//   remediationFraction = how much of the overload the player removed,
//                         1.0 when the worst line is back under 100 %.
//   actionEfficiency    = rewards using fewer of the allowed actions.
//   timeEfficiency      = rewards finishing well within the time limit.
// Session score = mean of per-study scores.
// ---------------------------------------------------------------------------

export const WEIGHTS = { physical: 60, actions: 25, time: 15 } as const;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Fraction of the overload removed. 1.0 == worst line back under 100 %.
 * 0.0 == no improvement (or no action taken).
 */
export function remediationFraction(s: GameStudyResult): number {
  if (s.finalMaxRho == null) return 0;
  if (s.solved || s.finalMaxRho < 1.0) return 1;
  const baseline = s.baselineMaxRho;
  if (baseline == null || baseline <= 1.0) return s.solved ? 1 : 0;
  // Linear credit for partial relief between baseline and the 100 % target.
  return clamp01((baseline - s.finalMaxRho) / (baseline - 1.0));
}

export function actionEfficiency(s: GameStudyResult): number {
  if (s.numActions < 1) return 0;
  const span = Math.max(1, s.maxActions);
  return clamp01(1 - (s.numActions - 1) / span);
}

export function timeEfficiency(s: GameStudyResult): number {
  const limitMs = s.timeLimitSeconds * 1000;
  if (limitMs <= 0) return 0;
  return clamp01(1 - s.durationMs / limitMs);
}

export interface StudyScore {
  studyId: string;
  label: string;
  physical: number;
  actions: number;
  time: number;
  total: number;
  remediationFraction: number;
  solved: boolean;
}

export function scoreStudy(s: GameStudyResult): StudyScore {
  const frac = remediationFraction(s);
  const physical = WEIGHTS.physical * frac;
  const actions = WEIGHTS.actions * frac * actionEfficiency(s);
  const time = WEIGHTS.time * frac * timeEfficiency(s);
  return {
    studyId: s.studyId,
    label: s.label,
    physical,
    actions,
    time,
    total: physical + actions + time,
    remediationFraction: frac,
    solved: s.solved,
  };
}

export interface SessionScore {
  finalScore: number;
  solvedCount: number;
  nStudies: number;
  perStudy: StudyScore[];
}

export function scoreSession(log: GameSessionLog): SessionScore {
  const perStudy = log.studies.map(scoreStudy);
  const nStudies = perStudy.length;
  const finalScore = nStudies
    ? perStudy.reduce((a, b) => a + b.total, 0) / nStudies
    : 0;
  return {
    finalScore,
    solvedCount: log.studies.filter((s) => s.solved).length,
    nStudies,
    perStudy,
  };
}
