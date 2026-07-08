// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useCallback, useMemo, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import type { ActionDetail, AnalysisResult, TabId } from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import { parseNdjsonStream } from '../utils/ndjsonStream';

export interface AnalysisState {
  result: AnalysisResult | null;
  setResult: Dispatch<SetStateAction<AnalysisResult | null>>;
  pendingAnalysisResult: AnalysisResult | null;
  setPendingAnalysisResult: (v: AnalysisResult | null) => void;
  analysisLoading: boolean;
  setAnalysisLoading: (v: boolean) => void;
  infoMessage: string;
  setInfoMessage: (v: string) => void;
  error: string;
  setError: (v: string) => void;

  // Analysis flow
  selectedOverloads: Set<string>;
  setSelectedOverloads: (v: Set<string>) => void;
  monitorDeselected: boolean;
  setMonitorDeselected: (v: boolean) => void;
  /**
   * Extra lines the operator wants the recommender to treat as
   * "lines to cut" beyond the detected overloads (ExpertAgent's
   * `additionalLinesToCut`/`ltc` semantics). Passed verbatim to
   * `/api/run-analysis-step2` and appended to the overflow-graph
   * target set on the backend.
   */
  additionalLinesToCut: Set<string>;
  setAdditionalLinesToCut: Dispatch<SetStateAction<Set<string>>>;
  handleToggleAdditionalLineToCut: (line: string) => void;
  /**
   * Snapshot of ``additionalLinesToCut`` taken at the moment
   * ``handleRunAnalysis`` posted Step 2. Drives the post-run
   * "Additional lines integrated in overflow analysis" notice so
   * the operator always sees the hypothesis BAKED INTO the
   * current ``result`` — even if they later toggle the picker
   * before re-running. Cleared on
   * ``clearContingencyState`` / ``resetAllState``.
   */
  committedAdditionalLinesToCut: Set<string>;
  setCommittedAdditionalLinesToCut: Dispatch<SetStateAction<Set<string>>>;

  // Ref to previous result for merge logic
  prevResultRef: MutableRefObject<AnalysisResult | null>;

  handleRunAnalysis: (
    selectedContingency: string[],
    clearContingencyState: () => void,
    setSuggestedByRecommenderIds: Dispatch<SetStateAction<Set<string>>>,
    setActiveTab?: (tab: TabId) => void
  ) => Promise<void>;
  handleDisplayPrioritizedActions: (selectedActionIds: Set<string>, setActiveTab?: (tab: TabId) => void) => void;
  handleToggleOverload: (overload: string) => void;
}

export function useAnalysis(): AnalysisState {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const prevResultRef = useRef<AnalysisResult | null>(result);
  useEffect(() => { prevResultRef.current = result; }, [result]);

  const [pendingAnalysisResult, setPendingAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [infoMessage, setInfoMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (infoMessage) {
      const timer = setTimeout(() => { setInfoMessage(''); }, 3000);
      return () => clearTimeout(timer);
    }
  }, [infoMessage]);

  // Analysis flow
  const [selectedOverloads, setSelectedOverloads] = useState<Set<string>>(new Set());
  const [monitorDeselected, setMonitorDeselected] = useState(false);
  const [additionalLinesToCut, setAdditionalLinesToCut] = useState<Set<string>>(new Set());
  // Snapshot of ``additionalLinesToCut`` at the moment Step 2 was
  // posted. Drives the post-run "Additional lines integrated…"
  // notice so the operator keeps sight of the hypothesis the
  // current ``result`` was computed against.
  const [committedAdditionalLinesToCut, setCommittedAdditionalLinesToCut] = useState<Set<string>>(new Set());

  const handleRunAnalysis = useCallback(async (
    selectedContingency: string[],
    clearContingencyState: () => void,
    setSuggestedByRecommenderIds: (fn: (prev: Set<string>) => Set<string>) => void,
    setActiveTab?: (tab: TabId) => void
  ) => {
    if (!selectedContingency || selectedContingency.length === 0) return;
    clearContingencyState();
    setAnalysisLoading(true);
    setError('');
    setInfoMessage('');

    const step1CorrId = interactionLogger.record('analysis_step1_started', { element: selectedContingency.join('+') });
    const step1StartTs = new Date().toISOString();
    // Wall-clock from the "Analyze & Suggest" click until the result
    // event arrives (= "Display N prioritized actions" button appears).
    // Captures step1 + step2 backend stages + network round-trip +
    // NDJSON streaming overhead.
    const wallClockStart = performance.now();

    try {
      // Step 1: Detection
      const { api } = await import('../api');
      const res1 = await api.runAnalysisStep1(selectedContingency);
      if (!res1.can_proceed) {
        setError(res1.message || 'Analysis cannot proceed.');
        if (res1.message) setInfoMessage(res1.message);
        setAnalysisLoading(false);
        return;
      }

      interactionLogger.recordCompletion('analysis_step1_completed', step1CorrId, {
        can_proceed: res1.can_proceed,
        overloads_detected: (res1.lines_overloaded || []).length,
      }, step1StartTs);

      const detected = res1.lines_overloaded || [];

      let primaryOverloads: string[] = [];
      if (detected.length > 0) {
        if (selectedOverloads.size > 0) {
          const stillRelevant = detected.filter(name => selectedOverloads.has(name));
          if (stillRelevant.length > 0) {
            primaryOverloads = stillRelevant;
          } else {
            setSelectedOverloads(new Set(detected));
            primaryOverloads = detected;
          }
        } else {
          setSelectedOverloads(new Set(detected));
          primaryOverloads = detected;
        }
      }

      const toResolve = primaryOverloads;

      if (detected.length === 0) {
        setInfoMessage(res1.message || "No overloads detected.");
        setAnalysisLoading(false);
        return;
      }

      // Step 2: Resolution
      // Replay contract (docs/features/interaction-logging.md):
      //   { element, selected_overloads, all_overloads, monitor_deselected,
      //     additional_lines_to_cut }
      const additionalLinesArr = Array.from(additionalLinesToCut);
      // Stamp the committed snapshot BEFORE the network call so the
      // post-run notice reflects exactly what the backend is about to
      // process (even if the user toggles the picker mid-stream).
      setCommittedAdditionalLinesToCut(new Set(additionalLinesArr));
      const step2CorrId = interactionLogger.record('analysis_step2_started', {
        element: selectedContingency.join('+'),
        selected_overloads: toResolve,
        all_overloads: detected,
        monitor_deselected: monitorDeselected,
        additional_lines_to_cut: additionalLinesArr,
      });
      const step2StartTs = new Date().toISOString();
      const response2 = await api.runAnalysisStep2Stream({
        selected_overloads: toResolve,
        all_overloads: detected,
        monitor_deselected: monitorDeselected,
        additional_lines_to_cut: additionalLinesArr,
      });

      let step2ActionsCount = 0;
      for await (const raw of parseNdjsonStream(response2)) {
        const event = raw as Partial<AnalysisResult> & { type?: string };
        if (event.type === 'pdf') {
          setResult((p: AnalysisResult | null) => ({
            ...(p || {}),
            pdf_url: event.pdf_url,
            pdf_path: event.pdf_path,
            // The overflow-graph build time is emitted on the
            // ``pdf`` event (before discovery + assessment finish)
            // so the iframe can display it below its title as soon
            // as the file is ready.
            ...(typeof event.overflow_graph_time === 'number'
                ? { overflow_graph_time: event.overflow_graph_time }
                : (event.overflow_graph_time === null
                    ? { overflow_graph_time: null }
                    : {})),
          } as AnalysisResult));
          if (setActiveTab) {
            setActiveTab('overflow');
          }
        } else if (event.type === 'result') {
          const actionsWithFlags = { ...event.actions };
          // Provenance for recommender-produced actions: the model
          // the backend actually ran (echoed as `active_model` on
          // the result event). Preserve an existing `origin` so a
          // "first guess" the operator added before analysis keeps
          // its `"user"` provenance even when the model re-emits
          // the same id.
          const resultModel: string = event.active_model || 'expert';
          for (const id in actionsWithFlags) {
            const existing = (prevResultRef.current?.actions?.[id] || {}) as Partial<ActionDetail>;
            actionsWithFlags[id] = {
              ...actionsWithFlags[id],
              is_manual: false,
              origin: existing.origin ?? resultModel,
              is_islanded: existing.is_islanded ?? actionsWithFlags[id].is_islanded,
              estimated_max_rho: existing.estimated_max_rho ?? actionsWithFlags[id].max_rho,
              estimated_max_rho_line: existing.estimated_max_rho_line ?? actionsWithFlags[id].max_rho_line,
            };
          }
          setSuggestedByRecommenderIds(prev => new Set([...prev, ...Object.keys(actionsWithFlags)]));
          step2ActionsCount = Object.keys(actionsWithFlags).length;
          const wallClockTime = (performance.now() - wallClockStart) / 1000;
          setPendingAnalysisResult({
            ...(event as AnalysisResult),
            actions: actionsWithFlags,
            wall_clock_time: wallClockTime,
          });
          if (event.message) setInfoMessage(event.message);
        } else if (event.type === 'error') {
          setError('Analysis failed: ' + event.message);
        }
      }
      // Replay contract (docs/features/interaction-logging.md):
      //   { n_actions, action_ids, dc_fallback, message, pdf_url }.
      // The full payload would require threading more state out of
      // the stream loop; for now we emit the most-replayed field
      // (n_actions) under its spec key.
      interactionLogger.recordCompletion('analysis_step2_completed', step2CorrId, {
        n_actions: step2ActionsCount,
      }, step2StartTs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred during analysis.';
      setError(message);
    } finally {
      setAnalysisLoading(false);
    }
  }, [selectedOverloads, monitorDeselected, additionalLinesToCut]);

  const handleToggleAdditionalLineToCut = useCallback((line: string) => {
    if (!line) return;
    let willAdd = false;
    setAdditionalLinesToCut((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(line)) {
        next.delete(line);
        willAdd = false;
      } else {
        next.add(line);
        willAdd = true;
      }
      return next;
    });
    interactionLogger.record('additional_line_to_cut_toggled', { line, selected: willAdd });
  }, []);

  const handleDisplayPrioritizedActions = useCallback((selectedActionIds: Set<string>, setActiveTab?: (tab: TabId) => void) => {
    if (!pendingAnalysisResult) return;
    // Replay contract (docs/features/interaction-logging.md): { n_actions: number }.
    interactionLogger.record('prioritized_actions_displayed', {
      n_actions: Object.keys(pendingAnalysisResult.actions).length,
    });
    // Auto-switch to the Remedial Action tab so the operator sees the
    // action overview with pins right after pressing the button.
    setActiveTab?.('action');
    setResult(prev => {
      // Preserve manually-added ("first guess") actions across the
      // analysis display step. We select them by the `is_manual`
      // flag rather than by `selectedActionIds` so a manual action
      // is kept even if the `selectedActionIds` set has been
      // trimmed by resetForAnalysisRun — mirrors the standalone
      // interface's handleDisplayPrioritizedActions behavior.
      const manualActionsData: Record<string, ActionDetail> = {};
      if (prev?.actions) {
        for (const [id, data] of Object.entries(prev.actions)) {
          if (data.is_manual || selectedActionIds.has(id)) {
            manualActionsData[id] = { ...data, is_manual: true };
          }
        }
      }

      const mergedActions = { ...pendingAnalysisResult.actions };
      for (const [id, data] of Object.entries(mergedActions)) {
        const existing = (prev?.actions?.[id] || {}) as Partial<ActionDetail>;
        mergedActions[id] = {
          ...data,
          is_islanded: existing.is_islanded ?? data.is_islanded,
          estimated_max_rho: existing.estimated_max_rho ?? data.estimated_max_rho,
          estimated_max_rho_line: existing.estimated_max_rho_line ?? data.estimated_max_rho_line,
          // Provenance: prefer the pre-display value (a "first guess"
          // the operator added before analysis stays `"user"`), else
          // the model-stamped origin from the step-2 stream loop.
          origin: existing.origin ?? data.origin,
        };
      }

      return {
        ...prev,
        ...pendingAnalysisResult,
        // Manual entries win over their analysis-suggested twins so
        // the user's "first guess" keeps its is_manual flag and its
        // variant diagram stays pinned to the Selected bucket.
        actions: { ...mergedActions, ...manualActionsData },
      };
    });
    setPendingAnalysisResult(null);
  }, [pendingAnalysisResult]);

  const handleToggleOverload = useCallback((overload: string) => {
    // Replay contract (docs/features/interaction-logging.md):
    //   { overload, selected }. `selected` is the state AFTER the toggle —
    //   true if the checkbox is now checked, false otherwise. Compute the
    //   next value from the current set BEFORE calling setSelectedOverloads
    //   so the logger doesn't double-fire under React StrictMode (the
    //   updater callback may run twice).
    const willSelect = !selectedOverloads.has(overload);
    interactionLogger.record('overload_toggled', { overload, selected: willSelect });
    setSelectedOverloads((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(overload)) next.delete(overload);
      else next.add(overload);
      return next;
    });
  }, [selectedOverloads]);

  return useMemo(() => ({
    result, setResult,
    pendingAnalysisResult, setPendingAnalysisResult,
    analysisLoading, setAnalysisLoading,
    infoMessage, setInfoMessage,
    error, setError,
    selectedOverloads, setSelectedOverloads,
    monitorDeselected, setMonitorDeselected,
    additionalLinesToCut, setAdditionalLinesToCut,
    handleToggleAdditionalLineToCut,
    committedAdditionalLinesToCut, setCommittedAdditionalLinesToCut,
    prevResultRef,
    handleRunAnalysis,
    handleDisplayPrioritizedActions,
    handleToggleOverload,
  }), [
    result, pendingAnalysisResult, analysisLoading, infoMessage, error,
    selectedOverloads, monitorDeselected, additionalLinesToCut,
    committedAdditionalLinesToCut,
    handleRunAnalysis, handleDisplayPrioritizedActions, handleToggleOverload,
    handleToggleAdditionalLineToCut,
  ]);
}
