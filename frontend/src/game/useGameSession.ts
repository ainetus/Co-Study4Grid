// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { gameBridge, type GameStudySnapshot } from './gameBridge';
import { buildSessionLog } from './gameLog';
import { buildSolutionLogRequest, toStudyFeedback } from './solutionLog';
import type {
  GamePhase,
  GameSessionConfig,
  GameSessionLog,
  GameStudyResult,
  StudySolutionFeedback,
} from './types';

/** How long the in-play novelty banner stays up. */
const NOVELTY_TOAST_MS = 8000;

export interface GameSessionState {
  phase: GamePhase;
  config: GameSessionConfig | null;
  currentIndex: number;
  secondsLeft: number;
  snapshot: GameStudySnapshot;
  results: GameStudyResult[];
  sessionLog: GameSessionLog | null;
  loadError: string | null;
  /**
   * Solution-capitalisation feedback of the most recently committed study,
   * shown as a transient banner while the next study loads/plays. Only set
   * when the proposition is new (a bonus was earned).
   */
  noveltyToast: StudySolutionFeedback | null;

  startSession: (config: GameSessionConfig) => void;
  /** Commit the current study (player clicked "Next") and advance. */
  advance: () => void;
  /** Abandon the session and return to the config screen. */
  quit: () => void;
  dismissNoveltyToast: () => void;
  /** Retry loading the current study after a `loadError` (QW24). */
  retryStudy: () => void;
  /**
   * End the session NOW with whatever studies are already committed and jump
   * to the results screen — so a mid-session backend failure doesn't destroy
   * the completed results (QW24).
   */
  finishEarly: () => void;
}

/** Best (lowest) resulting loading among the player's chosen actions. */
function bestFinalRho(snapshot: GameStudySnapshot): number | null {
  const rhos = snapshot.chosenActions
    .map((a) => a.maxRho)
    .filter((r): r is number => typeof r === 'number');
  return rhos.length ? Math.min(...rhos) : null;
}

export function useGameSession(): GameSessionState {
  const [phase, setPhase] = useState<GamePhase>('config');
  const [config, setConfig] = useState<GameSessionConfig | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [snapshot, setSnapshot] = useState<GameStudySnapshot>(gameBridge.getSnapshot());
  const [results, setResults] = useState<GameStudyResult[]>([]);
  const [startedAt, setStartedAt] = useState<string>('');
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noveltyToast, setNoveltyToast] = useState<StudySolutionFeedback | null>(null);

  // Refs mirror state for use inside timer callbacks / async loads, where
  // the captured closure would otherwise read stale values.
  const snapshotRef = useRef(snapshot);
  const configRef = useRef(config);
  const indexRef = useRef(currentIndex);
  const studyStartRef = useRef<number>(0);
  const resultsRef = useRef(results);
  const advancingRef = useRef(false);
  // Bumped on start/quit so a late log-solution response from a previous
  // session cannot write feedback into the next one.
  const sessionSeqRef = useRef(0);

  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { indexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { resultsRef.current = results; }, [results]);

  // Mirror App's published physical snapshot into local state.
  useEffect(() => gameBridge.subscribe(setSnapshot), []);

  // The session log is DERIVED from (config, results, endedAt) so the async
  // solution feedback of the last study still lands in the export.
  const sessionLog = useMemo(
    () => (phase === 'results' && config && endedAt
      ? buildSessionLog(config, results, startedAt, endedAt)
      : null),
    [phase, config, results, startedAt, endedAt],
  );

  const dismissNoveltyToast = useCallback(() => setNoveltyToast(null), []);

  // Auto-dismiss counts down only while the player can actually SEE the
  // banner (phase 'playing') — a multi-second study load must not eat the
  // toast behind the loading overlay.
  useEffect(() => {
    if (!noveltyToast || phase !== 'playing') return;
    const id = window.setTimeout(() => setNoveltyToast(null), NOVELTY_TOAST_MS);
    return () => window.clearTimeout(id);
  }, [noveltyToast, phase]);

  /** Merge the async solution feedback into the committed study's record. */
  const attachFeedback = useCallback((feedback: StudySolutionFeedback) => {
    const next = resultsRef.current.map((r) =>
      r.studyId === feedback.studyId ? { ...r, solutionFeedback: feedback } : r);
    resultsRef.current = next;
    setResults(next);
  }, []);

  // Load a study by index and (re)start its timer. Index out of range ends
  // the session.
  const loadStudyAt = useCallback(async (index: number) => {
    const cfg = configRef.current;
    if (!cfg) return;
    if (index >= cfg.studies.length) {
      // Session complete — the results screen derives the final log.
      setEndedAt(new Date().toISOString());
      setPhase('results');
      return;
    }

    setPhase('loading');
    setLoadError(null);
    gameBridge.reset();
    setSnapshot(gameBridge.getSnapshot());
    try {
      await gameBridge.loadStudy(cfg.studies[index]);
      studyStartRef.current = Date.now();
      setSecondsLeft(cfg.timerSeconds);
      setPhase('playing');
    } catch (err) {
      const e = err as { message?: string };
      setLoadError(e.message || 'Failed to load study');
      // Stay on the loading screen so the operator can retry / quit.
    }
  }, []);

  /**
   * Capitalise the committed study's retained proposition into the shared
   * solution base. Fire-and-forget: the game never blocks (or breaks) on
   * the log — feedback is merged in whenever the response lands.
   */
  const logSolution = useCallback((cfg: GameSessionConfig, result: GameStudyResult) => {
    if (!result.actionsChosen.length) return;
    const study = cfg.studies.find((s) => s.id === result.studyId);
    if (!study || !study.contingencyElementId) return;
    const seq = sessionSeqRef.current;
    api.logGameSolution(buildSolutionLogRequest(cfg, study, result))
      .then((response) => {
        if (sessionSeqRef.current !== seq) return; // session changed meanwhile
        const feedback = toStudyFeedback(result.studyId, response);
        attachFeedback(feedback);
        // Toast only when points were actually earned (a novel-but-
        // ineffective proposition gets no in-play celebration).
        if (feedback.novelty.newProposition && feedback.novelty.bonusPoints > 0) {
          setNoveltyToast(feedback);
        }
      })
      .catch(() => {
        // Logging is best-effort (e.g. standalone build without a backend):
        // the study simply carries no solutionFeedback.
      });
  }, [attachFeedback]);

  // Snapshot the current study into a result, then move on.
  const commitAndAdvance = useCallback((timedOut: boolean) => {
    if (advancingRef.current) return; // guard double-fire (timer + click)
    advancingRef.current = true;

    const cfg = configRef.current;
    const idx = indexRef.current;
    if (!cfg) { advancingRef.current = false; return; }
    const study = cfg.studies[idx];
    const snap = snapshotRef.current;
    const finalMaxRho = bestFinalRho(snap);
    const solved = finalMaxRho != null && finalMaxRho < 1.0;

    const result: GameStudyResult = {
      studyId: study.id,
      label: study.label,
      contingencyElementId: study.contingencyElementId,
      contingencyLabel: study.contingencyLabel,
      startedAt: new Date(studyStartRef.current).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - studyStartRef.current,
      timedOut,
      timeLimitSeconds: cfg.timerSeconds,
      maxActions: cfg.maxActions,
      actionsChosen: snap.chosenActions.slice(0, cfg.maxActions),
      numActions: Math.min(snap.chosenActions.length, cfg.maxActions),
      baselineMaxRho: snap.baselineMaxRho,
      finalMaxRho,
      solved,
    };

    // Update resultsRef SYNCHRONOUSLY here, not inside the setResults updater:
    // when this commit ends the session, loadStudyAt(nextIndex) flips to the
    // results phase on the very next synchronous line, and the derived
    // session log reads results state — a ref assigned inside the updater
    // would still be stale and the last study would be dropped from the
    // results screen and the exported session log.
    const next = [...resultsRef.current, result];
    resultsRef.current = next;
    setResults(next);

    logSolution(cfg, result);

    const nextIndex = idx + 1;
    setCurrentIndex(nextIndex);
    indexRef.current = nextIndex;
    void loadStudyAt(nextIndex).finally(() => {
      advancingRef.current = false;
    });
  }, [loadStudyAt, logSolution]);

  // Per-second countdown while playing. Reaching zero auto-commits.
  useEffect(() => {
    if (phase !== 'playing') return;
    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          commitAndAdvance(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, currentIndex, commitAndAdvance]);

  const startSession = useCallback((cfg: GameSessionConfig) => {
    gameBridge.setMaxActions(cfg.maxActions);
    sessionSeqRef.current += 1;
    setConfig(cfg);
    configRef.current = cfg;
    setResults([]);
    resultsRef.current = [];
    setEndedAt(null);
    setNoveltyToast(null);
    setCurrentIndex(0);
    indexRef.current = 0;
    setStartedAt(new Date().toISOString());
    advancingRef.current = false;
    void loadStudyAt(0);
  }, [loadStudyAt]);

  const advance = useCallback(() => {
    if (phase !== 'playing') return;
    commitAndAdvance(false);
  }, [phase, commitAndAdvance]);

  const quit = useCallback(() => {
    sessionSeqRef.current += 1;
    setPhase('config');
    setConfig(null);
    configRef.current = null;
    setResults([]);
    resultsRef.current = [];
    setEndedAt(null);
    setNoveltyToast(null);
    setCurrentIndex(0);
    gameBridge.reset();
  }, []);

  // Retry the current study after a load failure — reuses loadStudyAt's own
  // try/catch, so a transient failure clears loadError and reaches 'playing'.
  const retryStudy = useCallback(() => {
    void loadStudyAt(indexRef.current);
  }, [loadStudyAt]);

  // Finish the session with whatever is already committed. Mirrors the
  // session-complete branch of loadStudyAt but does NOT discard results — so a
  // study that can't load no longer nukes the completed ones. The log itself
  // is DERIVED from (config, results, endedAt), so late solution feedback
  // still reaches it; flipping endedAt + phase is all that's needed.
  const finishEarly = useCallback(() => {
    if (!configRef.current) return;
    setEndedAt(new Date().toISOString());
    setPhase('results');
  }, []);

  return {
    phase,
    config,
    currentIndex,
    secondsLeft,
    snapshot,
    results,
    sessionLog,
    loadError,
    noveltyToast,
    startSession,
    advance,
    quit,
    dismissNoveltyToast,
    retryStudy,
    finishEarly,
  };
}
