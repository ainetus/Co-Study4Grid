// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { GameSessionConfig, GameSessionLog, GameStudyResult } from './types';

export const GAME_LOG_SCHEMA_VERSION = '1.0';

/** Assemble the final, serializable session log from recorded study results. */
export function buildSessionLog(
  config: GameSessionConfig,
  studies: GameStudyResult[],
  startedAt: string,
  endedAt: string,
): GameSessionLog {
  return {
    schemaVersion: GAME_LOG_SCHEMA_VERSION,
    sessionName: config.sessionName,
    player: config.player,
    startedAt,
    endedAt,
    config: {
      timerSeconds: config.timerSeconds,
      maxActions: config.maxActions,
      nStudies: config.studies.length,
    },
    studies,
  };
}

/**
 * Flatten the session log to CSV — one row per study. This is the
 * human-friendly companion to the canonical JSON; the Codabench scorer
 * consumes the JSON, but operators can eyeball the CSV in a spreadsheet.
 */
export function buildSessionCsv(log: GameSessionLog): string {
  const header = [
    'session',
    'player',
    'study_index',
    'study_id',
    'label',
    'contingency',
    'duration_ms',
    'time_limit_s',
    'timed_out',
    'num_actions',
    'max_actions',
    'baseline_max_rho',
    'final_max_rho',
    'solved',
    'chosen_action_ids',
  ];
  const rows = log.studies.map((s, i) =>
    [
      log.sessionName,
      log.player ?? '',
      i + 1,
      s.studyId,
      s.label,
      s.contingencyElementId,
      s.durationMs,
      s.timeLimitSeconds,
      s.timedOut,
      s.numActions,
      s.maxActions,
      fmt(s.baselineMaxRho),
      fmt(s.finalMaxRho),
      s.solved,
      s.actionsChosen.map((a) => a.actionId).join(' | '),
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

function fmt(v: number | null): string {
  return v == null ? '' : String(v);
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Filesystem-safe slug for a session name. */
export function slugifySession(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}
