// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useRef, useState } from 'react';
import { gameBridge, type GameStudySnapshot } from './gameBridge';
import { buildSessionLog } from './gameLog';
import type {
  GamePhase,
  GameSessionConfig,
  GameSessionLog,
  GameStudyResult,
} from './types';

export interface GameSessionState {
  phase: GamePhase;
  config: GameSessionConfig | null;
  currentIndex: number;
  secondsLeft: number;
  snapshot: GameStudySnapshot;
  results: GameStudyResult[];
  sessionLog: GameSessionLog | null;
  loadError: string | null;

  startSession: (config: GameSessionConfig) => void;
  /** Commit the current study (player clicked "Next") and advance. */
  advance: () => void;
  /** Abandon the session and return to the config screen. */
  quit: () => void;
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
  const [sessionLog, setSessionLog] = useState<GameSessionLog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Refs mirror state for use inside timer callbacks / async loads, where
  // the captured closure would otherwise read stale values.
  const snapshotRef = useRef(snapshot);
  const configRef = useRef(config);
  const indexRef = useRef(currentIndex);
  const studyStartRef = useRef<number>(0);
  const sessionStartRef = useRef<string>('');
  const resultsRef = useRef(results);
  const advancingRef = useRef(false);

  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { indexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { resultsRef.current = results; }, [results]);

  // Mirror App's published physical snapshot into local state.
  useEffect(() => gameBridge.subscribe(setSnapshot), []);

  // Load a study by index and (re)start its timer. Index out of range ends
  // the session.
  const loadStudyAt = useCallback(async (index: number) => {
    const cfg = configRef.current;
    if (!cfg) return;
    if (index >= cfg.studies.length) {
      // Session complete — assemble the final log.
      const log = buildSessionLog(
        cfg,
        resultsRef.current,
        sessionStartRef.current,
        new Date().toISOString(),
      );
      setSessionLog(log);
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
    // when this commit ends the session, loadStudyAt(nextIndex) reads
    // resultsRef.current to build the final log on the very next synchronous
    // line, before React has run the functional updater — so a ref assigned
    // inside the updater would still be stale and the last study would be
    // dropped from the results screen and the exported session log.
    const next = [...resultsRef.current, result];
    resultsRef.current = next;
    setResults(next);

    const nextIndex = idx + 1;
    setCurrentIndex(nextIndex);
    indexRef.current = nextIndex;
    void loadStudyAt(nextIndex).finally(() => {
      advancingRef.current = false;
    });
  }, [loadStudyAt]);

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
    setConfig(cfg);
    configRef.current = cfg;
    setResults([]);
    resultsRef.current = [];
    setSessionLog(null);
    setCurrentIndex(0);
    indexRef.current = 0;
    sessionStartRef.current = new Date().toISOString();
    advancingRef.current = false;
    void loadStudyAt(0);
  }, [loadStudyAt]);

  const advance = useCallback(() => {
    if (phase !== 'playing') return;
    commitAndAdvance(false);
  }, [phase, commitAndAdvance]);

  const quit = useCallback(() => {
    setPhase('config');
    setConfig(null);
    configRef.current = null;
    setResults([]);
    resultsRef.current = [];
    setSessionLog(null);
    setCurrentIndex(0);
    gameBridge.reset();
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
    startSession,
    advance,
    quit,
  };
}
