// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useCallback, useMemo, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { api } from '../api';
import { buildSessionResult } from '../utils/sessionUtils';
import { interactionLogger } from '../utils/interactionLogger';
import type { AnalysisResult, CombinedAction, ActionDetail, SessionResult, DiagramData } from '../types';

export interface SessionState {
  showReloadModal: boolean;
  setShowReloadModal: (v: boolean) => void;
  sessionList: string[];
  sessionListLoading: boolean;
  sessionRestoring: boolean;

  handleSaveResults: (params: SaveParams) => Promise<void>;
  handleOpenReloadModal: (outputFolderPath: string, setError: (v: string) => void) => Promise<void>;
  handleRestoreSession: (sessionName: string, ctx: RestoreContext) => Promise<void>;
}

export interface SaveParams {
  networkPath: string;
  actionPath: string;
  layoutPath: string;
  outputFolderPath: string;
  minLineReconnections: number;
  minCloseCoupling: number;
  minOpenCoupling: number;
  minLineDisconnections: number;
  minPst: number;
  minLoadShedding: number;
  minRenewableCurtailmentActions: number;
  minRedispatch: number;
  nPrioritizedActions: number;
  linesMonitoringPath: string;
  monitoringFactor: number;
  preExistingOverloadThreshold: number;
  ignoreReconnections: boolean;
  pypowsyblFastMode: boolean;
  /**
   * Legacy single-string contingency (joined by ``+`` for multi-element
   * contingencies, populated by App.tsx for backwards compatibility
   * with older callers and existing tests).
   */
  selectedBranch?: string;
  /** Currently APPLIED contingency (list of element IDs). */
  selectedContingency?: string[];
  selectedOverloads: Set<string>;
  monitorDeselected: boolean;
  /** Snapshot of the "additional lines to prevent flow increase"
   *  picker at the moment Step 2 was posted; persisted so the
   *  post-run sidebar notice survives a session reload. */
  committedAdditionalLinesToCut?: Set<string>;
  nOverloads: string[];
  n1Overloads: string[];
  nOverloadsRho?: number[];
  n1OverloadsRho?: number[];
  result: AnalysisResult | null;
  selectedActionIds: Set<string>;
  rejectedActionIds: Set<string>;
  manuallyAddedIds: Set<string>;
  suggestedByRecommenderIds: Set<string>;
  setInfoMessage: (v: string) => void;
  setError: (v: string) => void;
}

export interface RestoreContext {
  outputFolderPath: string;
  setNetworkPath: (v: string) => void;
  setActionPath: (v: string) => void;
  setLayoutPath: (v: string) => void;
  setMinLineReconnections: (v: number) => void;
  setMinCloseCoupling: (v: number) => void;
  setMinOpenCoupling: (v: number) => void;
  setMinLineDisconnections: (v: number) => void;
  setMinPst: (v: number) => void;
  setMinLoadShedding: (v: number) => void;
  setMinRenewableCurtailmentActions: (v: number) => void;
  setMinRedispatch: (v: number) => void;
  setNPrioritizedActions: (v: number) => void;
  setLinesMonitoringPath: (v: string) => void;
  setMonitoringFactor: (v: number) => void;
  setPreExistingOverloadThreshold: (v: number) => void;
  setIgnoreReconnections: (v: boolean) => void;
  setPypowsyblFastMode: (v: boolean) => void;
  applyConfigResponse: (configRes: Record<string, unknown>) => void;
  setBranches: (v: string[]) => void;
  setVoltageLevels: (v: string[]) => void;
  setNameMap: (v: Record<string, string>) => void;
  setNominalVoltageMap: (v: Record<string, number>) => void;
  setUniqueVoltages: (v: number[]) => void;
  setVoltageRange: (v: [number, number]) => void;
  fetchBaseDiagram: (vlCount: number) => void;
  ingestBaseDiagram: (raw: DiagramData & { svg: string }, vlCount: number) => void;
  setMonitorDeselected: (v: boolean) => void;
  setSelectedOverloads: (v: Set<string>) => void;
  /** Restore the committed "additional lines to prevent flow
   *  increase" snapshot so the post-run sidebar notice surfaces
   *  again after a reload. Optional so test mocks predating the
   *  field don't have to know about it. */
  setCommittedAdditionalLinesToCut?: (v: Set<string>) => void;
  setResult: Dispatch<SetStateAction<AnalysisResult | null>>;
  setSelectedActionIds: Dispatch<SetStateAction<Set<string>>>;
  setRejectedActionIds: Dispatch<SetStateAction<Set<string>>>;
  setManuallyAddedIds: Dispatch<SetStateAction<Set<string>>>;
  setSuggestedByRecommenderIds: Dispatch<SetStateAction<Set<string>>>;
  restoringSessionRef: MutableRefObject<boolean>;
  committedBranchRef: MutableRefObject<string[]>;
  // Tracks the network path of the currently-loaded study so that
  // subsequent edits to the Header path input know whether to prompt
  // the "Change Network?" confirmation dialog. Must be updated on
  // session restore — otherwise the first manual edit to the network
  // path after a reload either silently drops the study (ref empty)
  // or fires a spurious dialog against a stale value. See PR #83.
  committedNetworkPathRef: MutableRefObject<string>;
  setSelectedContingency: (v: string[]) => void;
  /** Re-sync the contingency multi-select's pending list to the
   *  restored value so a subsequent click on the (now disabled)
   *  Trigger button can't replay the pre-restore branch back into
   *  ``selectedContingency`` — which would fire the "Change
   *  Contingency?" dialog and wipe the just-restored analysis state
   *  via ``clearContingencyState``. Optional for compatibility with
   *  test mocks that predate the field. */
  setPendingContingency?: (v: string[]) => void;
  /** Wipe every piece of per-study state at the start of a restore
   *  — same semantics as a fresh Load Study. Required so the dialog
   *  guard in ``useContingencyFetch`` never sees a stale
   *  ``hasAnalysisState() === true`` against the pre-restore
   *  ``committedBranchRef`` while the restore is still in flight.
   *  Optional for test mocks that predate the field. */
  resetAllState?: () => void;
  setInfoMessage: (v: string) => void;
  setError: (v: string) => void;
}

export function useSession(): SessionState {
  const [showReloadModal, setShowReloadModal] = useState(false);
  const [sessionList, setSessionList] = useState<string[]>([]);
  const [sessionListLoading, setSessionListLoading] = useState(false);
  const [sessionRestoring, setSessionRestoring] = useState(false);

  const handleSaveResults = useCallback(async (params: SaveParams) => {
    interactionLogger.record('session_saved', { output_folder: params.outputFolderPath });
    const session = buildSessionResult({
      networkPath: params.networkPath,
      actionPath: params.actionPath,
      layoutPath: params.layoutPath,
      minLineReconnections: params.minLineReconnections,
      minCloseCoupling: params.minCloseCoupling,
      minOpenCoupling: params.minOpenCoupling,
      minLineDisconnections: params.minLineDisconnections,
      minPst: params.minPst,
      minLoadShedding: params.minLoadShedding,
      minRenewableCurtailmentActions: params.minRenewableCurtailmentActions,
      minRedispatch: params.minRedispatch,
      nPrioritizedActions: params.nPrioritizedActions,
      linesMonitoringPath: params.linesMonitoringPath,
      monitoringFactor: params.monitoringFactor,
      preExistingOverloadThreshold: params.preExistingOverloadThreshold,
      ignoreReconnections: params.ignoreReconnections,
      pypowsyblFastMode: params.pypowsyblFastMode,
      selectedContingency: params.selectedContingency,
      selectedBranch: params.selectedBranch,
      selectedOverloads: params.selectedOverloads,
      monitorDeselected: params.monitorDeselected,
      committedAdditionalLinesToCut: params.committedAdditionalLinesToCut,
      nOverloads: params.nOverloads,
      n1Overloads: params.n1Overloads,
      nOverloadsRho: params.nOverloadsRho,
      n1OverloadsRho: params.n1OverloadsRho,
      result: params.result,
      selectedActionIds: params.selectedActionIds,
      rejectedActionIds: params.rejectedActionIds,
      manuallyAddedIds: params.manuallyAddedIds,
      suggestedByRecommenderIds: params.suggestedByRecommenderIds,
      interactionLog: interactionLogger.getLog(),
    });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const contingencyLabelSrc = params.selectedBranch
      ?? (params.selectedContingency && params.selectedContingency.length > 0
            ? params.selectedContingency.join('+')
            : '');
    const contingencyLabel = contingencyLabelSrc ? `_${contingencyLabelSrc.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
    const sessionName = `costudy4grid_session${contingencyLabel}_${ts}`;

    if (params.outputFolderPath) {
      try {
        const res = await api.saveSession({
          session_name: sessionName,
          json_content: JSON.stringify(session, null, 2),
          pdf_path: params.result?.pdf_path ?? null,
          output_folder_path: params.outputFolderPath,
          interaction_log: JSON.stringify(interactionLogger.getLog(), null, 2),
        });
        const pdfMsg = res.pdf_copied ? " (including PDF)" : " (PDF not found)";
        params.setInfoMessage(`SUCCESS: Session saved to: ${res.session_folder}${pdfMsg}`);
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        params.setError('Failed to save session: ' + (e.response?.data?.detail || e.message));
      }
    } else {
      const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sessionName}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, []);

  const handleOpenReloadModal = useCallback(async (outputFolderPath: string, setError: (v: string) => void) => {
    interactionLogger.record('session_reload_modal_opened');
    if (!outputFolderPath) {
      setError('Configure an Output Folder Path in Settings before reloading a session.');
      return;
    }
    setShowReloadModal(true);
    setSessionListLoading(true);
    try {
      const res = await api.listSessions(outputFolderPath);
      setSessionList(res.sessions);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError('Failed to list sessions: ' + (e.response?.data?.detail || e.message));
      setShowReloadModal(false);
    } finally {
      setSessionListLoading(false);
    }
  }, []);

  const handleRestoreSession = useCallback(async (sessionName: string, ctx: RestoreContext) => {
    if (!ctx.outputFolderPath) return;
    // Treat a restore like a fresh Load Study: wipe every piece of
    // per-study state (result, action selections, committed branch,
    // pending branch, diagrams, …) BEFORE any of the restore's own
    // setters fire. Without this, the contingency-change dialog
    // guard in ``useContingencyFetch`` can race the restore — at any
    // intermediate render where the new ``selectedContingency`` has
    // landed but ``committedBranchRef`` still points at the
    // pre-restore branch (or vice versa), ``hasAnalysisState() &&
    // !sameElements`` evaluates true and fires "Change Contingency?",
    // which on Confirm wipes the just-restored suggestions.
    ctx.resetAllState?.();
    setSessionRestoring(true);
    ctx.restoringSessionRef.current = true;
    try {
      const session: SessionResult = await api.loadSession(ctx.outputFolderPath, sessionName);

      // 1. Restore configuration paths
      const cfg = session.configuration;
      ctx.setNetworkPath(cfg.network_path);
      ctx.setActionPath(cfg.action_file_path);
      ctx.setLayoutPath(cfg.layout_path || '');
      ctx.setMinLineReconnections(cfg.min_line_reconnections);
      ctx.setMinCloseCoupling(cfg.min_close_coupling);
      ctx.setMinOpenCoupling(cfg.min_open_coupling);
      ctx.setMinLineDisconnections(cfg.min_line_disconnections);
      ctx.setMinPst(cfg.min_pst ?? 1.0);
      ctx.setMinLoadShedding(cfg.min_load_shedding ?? 0.0);
      ctx.setMinRenewableCurtailmentActions(cfg.min_renewable_curtailment_actions ?? 0.0);
      ctx.setMinRedispatch(cfg.min_redispatch ?? 0.0);
      ctx.setNPrioritizedActions(cfg.n_prioritized_actions);
      ctx.setLinesMonitoringPath(cfg.lines_monitoring_path || '');
      ctx.setMonitoringFactor(cfg.monitoring_factor);
      ctx.setPreExistingOverloadThreshold(cfg.pre_existing_overload_threshold);
      ctx.setIgnoreReconnections(cfg.ignore_reconnections ?? false);
      ctx.setPypowsyblFastMode(cfg.pypowsybl_fast_mode ?? true);

      // 2. Send config to backend and load network
      const configRes = await api.updateConfig({
        network_path: cfg.network_path,
        action_file_path: cfg.action_file_path,
        layout_path: cfg.layout_path,
        min_line_reconnections: cfg.min_line_reconnections,
        min_close_coupling: cfg.min_close_coupling,
        min_open_coupling: cfg.min_open_coupling,
        min_line_disconnections: cfg.min_line_disconnections,
        min_pst: cfg.min_pst ?? 1.0,
        min_load_shedding: cfg.min_load_shedding ?? 0.0,
        min_renewable_curtailment_actions: cfg.min_renewable_curtailment_actions ?? 0.0,
        min_redispatch: cfg.min_redispatch ?? 0.0,
        n_prioritized_actions: cfg.n_prioritized_actions,
        lines_monitoring_path: cfg.lines_monitoring_path,
        monitoring_factor: cfg.monitoring_factor,
        pre_existing_overload_threshold: cfg.pre_existing_overload_threshold,
        ignore_reconnections: cfg.ignore_reconnections,
        pypowsybl_fast_mode: cfg.pypowsybl_fast_mode,
      });

      ctx.applyConfigResponse(configRes as Record<string, unknown>);

      // Record the restored network path as the currently-committed
      // study, so any later manual edit to the Header network input
      // correctly routes through the "Change Network?" confirmation
      // dialog instead of either silently dropping the study (ref
      // empty) or misfiring against a stale previous value.
      ctx.committedNetworkPathRef.current = cfg.network_path;

      // 3. Fetch study data — all 4 XHRs in parallel. The base-diagram
      // call is the slowest (server-side NAD), so overlapping it with
      // branches/voltage-levels/nominal-voltages shaves the branches gap
      // off the critical path. See docs/performance/history/loading-parallel.md.
      const [branchRes, vlRes, nomVRes, diagramRaw] = await Promise.all([
        api.getBranches(),
        api.getVoltageLevels(),
        api.getNominalVoltages(),
        api.getNetworkDiagram(),
      ]);
      ctx.setBranches(branchRes.branches);
      ctx.setVoltageLevels(vlRes.voltage_levels);
      ctx.setNameMap({ ...branchRes.name_map, ...vlRes.name_map });
      ctx.setNominalVoltageMap(nomVRes.mapping);
      ctx.setUniqueVoltages(nomVRes.unique_kv);
      if (nomVRes.unique_kv.length > 0) {
        ctx.setVoltageRange([nomVRes.unique_kv[0], nomVRes.unique_kv[nomVRes.unique_kv.length - 1]]);
      }

      // 4. Consume base diagram
      ctx.ingestBaseDiagram(diagramRaw, vlRes.voltage_levels.length);

      // 4b. Re-push the monitored-line set + computed-pair cache
      // captured at save time into the backend, so any subsequent
      // simulate-action call on this reloaded session uses the SAME
      // `lines_we_care_about` policy as the original study — not the
      // backend's default (all lines / on-disk lines-monitoring file).
      // Parity with the standalone HTML mirror (PR
      // `claude/auto-generate-standalone-interface-Hhogk`). No-ops
      // silently for older session dumps that predate the fields.
      if (session.analysis?.lines_we_care_about) {
        try {
          // Backwards compat: older sessions saved a single
          // ``disconnected_element`` (string); promote to the new
          // ``disconnected_elements`` list shape before sending.
          const restoredElements: string[] = session.contingency.disconnected_elements
            ? session.contingency.disconnected_elements
            : (session.contingency.disconnected_element ? [session.contingency.disconnected_element] : []);
          await api.restoreAnalysisContext({
            lines_we_care_about: session.analysis.lines_we_care_about,
            disconnected_elements: restoredElements,
            lines_overloaded: session.overloads?.resolved_overloads ?? null,
            computed_pairs: session.analysis.computed_pairs ?? null,
          });
        } catch (ctxErr) {
          console.warn('Failed to restore analysis context:', ctxErr);
        }
      }

      // 5. Restore contingency
      const contingency = session.contingency;
      ctx.setMonitorDeselected(contingency.monitor_deselected);
      ctx.setSelectedOverloads(new Set(contingency.selected_overloads));
      // Restore the "additional lines to prevent flow increase"
      // snapshot so the post-run sidebar notice resurfaces. Older
      // session dumps that predate the picker simply set an empty
      // set, which keeps the notice hidden.
      ctx.setCommittedAdditionalLinesToCut?.(
        new Set(contingency.additional_lines_to_cut ?? []),
      );

      // 6. Restore analysis result
      if (session.analysis) {
        const a = session.analysis;
        const restoredActions: Record<string, ActionDetail> = {};
        const restoredSelected = new Set<string>();
        const restoredRejected = new Set<string>();
        const restoredManual = new Set<string>();
        const restoredSuggested = new Set<string>();

        for (const [id, entry] of Object.entries(a.actions)) {
          if (id.includes('+') && entry.is_estimated && !entry.status.is_manually_simulated) continue;

          restoredActions[id] = {
            description_unitaire: entry.description_unitaire,
            rho_before: entry.rho_before,
            rho_after: entry.rho_after,
            max_rho: entry.max_rho,
            max_rho_line: entry.max_rho_line,
            is_rho_reduction: entry.is_rho_reduction,
            is_estimated: entry.is_estimated,
            non_convergence: entry.non_convergence,
            action_topology: entry.action_topology,
            estimated_max_rho: entry.estimated_max_rho,
            estimated_max_rho_line: entry.estimated_max_rho_line,
            is_islanded: entry.is_islanded,
            n_components: entry.n_components,
            disconnected_mw: entry.disconnected_mw,
            // Enrichment fields added by PR #73 (loads_p/gens_p format),
            // PR #78 (PST tap re-simulation) and PR #83 (post-action
            // overload highlighting). These were previously dropped on
            // reload, so the PST / load-shedding / curtailment editors
            // rendered empty and the SLD/NAD tab lost its post-action
            // overload halos until the user re-ran analysis.
            lines_overloaded_after: entry.lines_overloaded_after,
            load_shedding_details: entry.load_shedding_details,
            curtailment_details: entry.curtailment_details,
            redispatch_details: entry.redispatch_details,
            pst_details: entry.pst_details,
            is_manual: entry.status.is_manually_simulated,
            // Provenance. Restored verbatim when present; legacy
            // session dumps that predate the `origin` field get a
            // derived value from the saved status flags + the
            // session's `analysis.active_model` so the unfolded card's
            // "Source" row still resolves on reload.
            origin: entry.origin
              ?? (entry.status.is_manually_simulated
                ? 'user'
                : entry.status.is_suggested
                  ? (a.active_model ?? 'expert')
                  : undefined),
          };

          if (entry.status.is_selected) restoredSelected.add(id);
          if (entry.status.is_rejected) restoredRejected.add(id);
          if (entry.status.is_manually_simulated) restoredManual.add(id);
          if (entry.status.is_suggested) restoredSuggested.add(id);
        }

        const restoredCombinedActions: Record<string, CombinedAction> = {};
        if (a.combined_actions) {
          for (const [id, ca] of Object.entries(a.combined_actions)) {
            restoredCombinedActions[id] = {
              action1_id: ca.action1_id,
              action2_id: ca.action2_id,
              betas: ca.betas,
              p_or_combined: [],
              max_rho: ca.max_rho,
              max_rho_line: ca.max_rho_line,
              is_rho_reduction: ca.is_rho_reduction,
              description: ca.description,
              rho_after: [],
              rho_before: [],
              estimated_max_rho: ca.estimated_max_rho,
              estimated_max_rho_line: ca.estimated_max_rho_line,
              is_islanded: ca.is_islanded,
              disconnected_mw: ca.disconnected_mw,
            };
          }
        }

        const restoredResult: AnalysisResult = {
          pdf_path: session.overflow_graph?.pdf_path ?? null,
          pdf_url: session.overflow_graph?.pdf_url ?? null,
          actions: restoredActions,
          action_scores: a.action_scores as Record<string, { scores: Record<string, number>; mw_start?: Record<string, number | null> }>,
          lines_overloaded: session.overloads.resolved_overloads,
          combined_actions: restoredCombinedActions,
          message: a.message,
          dc_fallback: a.dc_fallback,
          // Restore the recommender model that produced the
          // suggestions so the "Suggestions produced by <model>"
          // reminder below the Suggested Actions tab header (driven by
          // `result.active_model`) survives a reload. Without this the
          // field was saved to `analysis.active_model` but never
          // re-attached to the live `result`, so the reminder vanished.
          active_model: a.active_model ?? undefined,
          compute_overflow_graph: a.compute_overflow_graph ?? undefined,
          // Per-stage timings (seconds). Optional for backward
          // compatibility — saved sessions from before the breakdown
          // was added simply restore with these fields undefined and
          // the ActionFeed reminder hides the breakdown row.
          overflow_graph_time: a.overflow_graph_time ?? undefined,
          action_prediction_time: a.action_prediction_time ?? undefined,
          assessment_time: a.assessment_time ?? undefined,
          step1_time: a.step1_time ?? undefined,
          enrichment_time: a.enrichment_time ?? undefined,
          wall_clock_time: a.wall_clock_time ?? undefined,
        };

        ctx.setResult(restoredResult);
        ctx.setSelectedActionIds(restoredSelected);
        ctx.setRejectedActionIds(restoredRejected);
        ctx.setManuallyAddedIds(restoredManual);
        ctx.setSuggestedByRecommenderIds(restoredSuggested);
      } else {
        ctx.setResult(null);
        ctx.setSelectedActionIds(new Set());
        ctx.setRejectedActionIds(new Set());
        ctx.setManuallyAddedIds(new Set());
        ctx.setSuggestedByRecommenderIds(new Set());
      }

      // 7. Set the selected contingency last (triggers diagram fetch).
      // Backwards-compat with older sessions that only carry
      // ``disconnected_element``: promote to a 1-element list.
      const restoredElements: string[] = contingency.disconnected_elements
        ? contingency.disconnected_elements
        : (contingency.disconnected_element ? [contingency.disconnected_element] : []);
      ctx.committedBranchRef.current = [...restoredElements];
      ctx.setSelectedContingency(restoredElements);
      // Sync the multi-select's pending list with the restored applied
      // value so the Trigger button stays disabled — otherwise an
      // accidental click replays the pre-restore branch back into
      // ``selectedContingency`` and reopens the contingency-change
      // dialog, which on Confirm wipes the just-restored analysis.
      ctx.setPendingContingency?.(restoredElements);

      setShowReloadModal(false);
      interactionLogger.record('session_reloaded', { session_name: sessionName });
      ctx.setInfoMessage(`SUCCESS: Session "${sessionName}" restored`);
    } catch (err: unknown) {
      // If the restore aborts before useContingencyFetch had a chance
      // to consume the flag, clear it here — leaving it sticky would
      // misclassify the next user-driven contingency change as a
      // session restore and skip the confirmation dialog when it IS
      // expected.
      ctx.restoringSessionRef.current = false;
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      ctx.setError('Failed to restore session: ' + (e.response?.data?.detail || e.message));
    } finally {
      setSessionRestoring(false);
    }
  }, []);

  return useMemo(() => ({
    showReloadModal, setShowReloadModal,
    sessionList,
    sessionListLoading,
    sessionRestoring,
    handleSaveResults,
    handleOpenReloadModal,
    handleRestoreSession,
  }), [
    showReloadModal, sessionList, sessionListLoading, sessionRestoring,
    handleSaveResults, handleOpenReloadModal, handleRestoreSession,
  ]);
}
