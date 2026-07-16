// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

// ---------------------------------------------------------------------------
// Game Mode — type contract
//
// "Game Mode" is a thin competitive wrapper around the Co-Study4Grid study
// workspace. A *session* is an ordered list of *studies*. Each study pairs a
// network + action catalogue with a single N-1 contingency the player must
// remediate using at most `maxActions` remedial actions, before a per-study
// timer runs out. The wrapper records what the player did (chosen actions,
// timing, physical result) into a `GameSessionLog`, which is the artifact a
// Codabench scoring program consumes.
// ---------------------------------------------------------------------------

/** A single playable situation: a grid state + the contingency to solve. */
export interface GameStudy {
  /** Stable id (used as React key + log key). */
  id: string;
  /** Human-readable label shown in the HUD ("Study 2 — BIANCON 225 kV"). */
  label: string;
  /** Network file path passed to `POST /api/config` (`network_path`). */
  networkPath: string;
  /** Action catalogue path passed to `POST /api/config` (`action_file_path`). */
  actionFilePath: string;
  /** Optional `grid_layout.json` path (`layout_path`). */
  layoutPath?: string;
  /** Optional monitored-lines csv path (`lines_monitoring_path`). */
  linesMonitoringPath?: string;
  /** Disconnectable element id to trip (the contingency). */
  contingencyElementId: string;
  /** Pretty name of the tripped element, for display only. */
  contingencyLabel?: string;
  /** Free-text briefing shown to the player before/while they solve it. */
  description?: string;
  /**
   * Baseline worst loading (%) the contingency produces with no remedial
   * action. Sourced from the preset (`n1_overload_contingencies.json`) and
   * used by scoring as the "do nothing" reference.
   */
  baselineMaxLoadingPct?: number;
}

/** Everything needed to run one game session. */
export interface GameSessionConfig {
  sessionName: string;
  /**
   * Player handle, stamped into the exported log and signing the retained
   * solutions in the shared base. The config screen requires it; the type
   * stays optional so programmatic starts (tests, replays) still work —
   * their retentions are stored unattributed.
   */
  player?: string;
  /** Per-study time limit, in seconds. */
  timerSeconds: number;
  /** Max remedial actions the player may commit per study (domain cap: 3). */
  maxActions: number;
  /**
   * Beginner assistance: show the community's most-used levers for each
   * study (from the shared solution base) in an in-play hints panel.
   */
  assistance?: boolean;
  /** Ordered situations to play. */
  studies: GameStudy[];
}

/** One remedial action the player committed (starred) for a study. */
export interface ChosenActionRecord {
  actionId: string;
  description?: string;
  /**
   * Action-type bucket (`classifyActionType` token — 'disco', 'redispatch',
   * …) used by the solution-capitalisation log.
   */
  actionType?: string;
  /**
   * Magnitude-free unitary signatures of the levers this action mobilises
   * (`redispatch:<gen>`, `ls:<load>`, `switch:<id>=<state>`, …). Empty for
   * catalogue actions whose id is their stable identity. Computed by
   * `buildActionLevers` (solutionLog.ts); the backend judges novelty on
   * these, so an injection retuned to a different MW is NOT novel — only
   * a new lever is.
   */
  levers?: string[];
  /** Resulting worst loading after the action, in per-unit (1.0 == 100 %). */
  maxRho: number | null;
  /** Lines still overloaded after the action. */
  linesOverloadedAfter?: string[];
  /** True when this single action clears all overloads. */
  solved: boolean;
}

// ---------------------------------------------------------------------------
// Solution capitalisation (shared solution base — POST /api/game/log-solution)
// ---------------------------------------------------------------------------

/** Novelty verdict returned by the backend for one retained proposition. */
export interface SolutionNovelty {
  /** True when this exact combination was never retained before. */
  newProposition: boolean;
  /** Unitary signatures never seen in this context (new levers). */
  newLevers: string[];
  /** Bonus points awarded (10 new lever / 5 new combination / 0). */
  bonusPoints: number;
}

/** Past-usage frequency of one retained action in the shared base. */
export interface ActionUsageFrequency {
  actionId: string;
  description?: string;
  /** Retention events (all players) whose proposition included this action. */
  count: number;
  /** Total retention events stored for this contingency context. */
  total: number;
  /** count / total (0 when the base was empty). */
  share: number;
}

/** Feedback attached to a study once its retained solution is logged. */
export interface StudySolutionFeedback {
  studyId: string;
  novelty: SolutionNovelty;
  frequencies: ActionUsageFrequency[];
}

/** The recorded outcome of one study. */
export interface GameStudyResult {
  studyId: string;
  label: string;
  contingencyElementId: string;
  contingencyLabel?: string;
  startedAt: string; // ISO 8601
  endedAt: string; // ISO 8601
  durationMs: number;
  /** True when the player ran out of time rather than clicking "Next". */
  timedOut: boolean;
  timeLimitSeconds: number;
  maxActions: number;
  actionsChosen: ChosenActionRecord[];
  numActions: number;
  /** Worst loading of the bare N-1 state, per-unit. */
  baselineMaxRho: number | null;
  /** Best (lowest) worst-loading the player achieved with their actions. */
  finalMaxRho: number | null;
  /** True when the player's best chosen action clears the overload. */
  solved: boolean;
  /**
   * Solution-capitalisation feedback (novelty bonus + usage frequencies),
   * merged in once the async POST /api/game/log-solution response lands.
   * Absent when the study had no retained action or logging failed —
   * purely additive, the Codabench scorer ignores it.
   */
  solutionFeedback?: StudySolutionFeedback;
}

/** The exported artifact a Codabench scorer consumes. */
export interface GameSessionLog {
  schemaVersion: string;
  sessionName: string;
  player?: string;
  startedAt: string;
  endedAt: string;
  config: {
    timerSeconds: number;
    maxActions: number;
    nStudies: number;
  };
  studies: GameStudyResult[];
}

/** Phases of the game state machine. */
export type GamePhase = 'config' | 'loading' | 'playing' | 'results';
