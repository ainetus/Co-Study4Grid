// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import type { AnalysisResult, SessionResult, SavedActionEntry, SavedCombinedAction, InteractionLogEntry } from '../types';

/**
 * All pieces of App state required to build a SavedSessionResult JSON snapshot.
 * Kept as a plain-data interface so the logic is easily unit-testable without
 * mounting the full React component tree.
 */
export interface SessionInput {
    // Configuration / paths
    networkPath: string;
    actionPath: string;
    layoutPath: string;
    minLineReconnections: number;
    minCloseCoupling: number;
    minOpenCoupling: number;
    minLineDisconnections: number;
    minPst: number;
    minLoadShedding: number;
    minRenewableCurtailmentActions: number;
    nPrioritizedActions: number;
    linesMonitoringPath: string;
    monitoringFactor: number;
    preExistingOverloadThreshold: number;
    ignoreReconnections: boolean;
    pypowsyblFastMode: boolean;
    // Pluggable-recommender selection. Captured at save time so a
    // reloaded session shows which model was active. Optional for
    // backwards compatibility with builders that haven't been updated
    // yet.
    recommenderModel?: string;
    computeOverflowGraph?: boolean;

    // Contingency
    selectedContingency?: string[];
    selectedBranch?: string;
    selectedOverloads: Set<string>;
    monitorDeselected: boolean;
    committedAdditionalLinesToCut?: Set<string>;

    // Overload lists from diagrams
    nOverloads: string[];
    n1Overloads: string[];
    nOverloadsRho?: number[];
    n1OverloadsRho?: number[];

    // Analysis result (already merged from pendingAnalysisResult → result)
    result: AnalysisResult | null;

    // Action status tracking
    selectedActionIds: Set<string>;
    rejectedActionIds: Set<string>;
    manuallyAddedIds: Set<string>;
    suggestedByRecommenderIds: Set<string>;

    // Interaction log
    interactionLog: InteractionLogEntry[];
}

/**
 * Builds a serialisable SessionResult snapshot from the current App state.
 */
export function buildSessionResult(input: SessionInput): SessionResult {
    const {
        networkPath, actionPath, layoutPath,
        minLineReconnections, minCloseCoupling, minOpenCoupling, minLineDisconnections, minPst, minLoadShedding, minRenewableCurtailmentActions,
        nPrioritizedActions, linesMonitoringPath, monitoringFactor,
        preExistingOverloadThreshold, ignoreReconnections, pypowsyblFastMode,
        recommenderModel, computeOverflowGraph,
        selectedContingency: contingencyInput,
        selectedBranch: legacyBranch,
        selectedOverloads, monitorDeselected,
        committedAdditionalLinesToCut,
        nOverloads, n1Overloads,
        nOverloadsRho, n1OverloadsRho,
        result,
        selectedActionIds, rejectedActionIds, manuallyAddedIds, suggestedByRecommenderIds,
        interactionLog,
    } = input;

    // Build combined_actions from the analysis result
    const savedCombinedActions: Record<string, SavedCombinedAction> = {};
    if (result?.combined_actions) {
        for (const [id, ca] of Object.entries(result.combined_actions)) {
            const canonicalId = id.includes('+') ? id.split('+').map(p => p.trim()).sort().join('+') : id;
            const simData = result.actions[id] || result.actions[canonicalId];
            const isSimulated = !!simData && !simData.is_estimated && simData.rho_after != null && simData.rho_after.length > 0;

            savedCombinedActions[id] = {
                action1_id: ca.action1_id,
                action2_id: ca.action2_id,
                betas: ca.betas,
                max_rho: ca.max_rho,
                max_rho_line: ca.max_rho_line,
                is_rho_reduction: ca.is_rho_reduction,
                description: ca.description,
                estimated_max_rho: ca.estimated_max_rho ?? ca.max_rho,
                estimated_max_rho_line: ca.estimated_max_rho_line ?? ca.max_rho_line,
                is_islanded: ca.is_islanded,
                disconnected_mw: ca.disconnected_mw,
                simulated_max_rho: isSimulated ? simData.max_rho : null,
                simulated_max_rho_line: isSimulated ? simData.max_rho_line : undefined,
                is_simulated: isSimulated,
            };
        }
    }

    const analysis: SessionResult['analysis'] = result
        ? {
            message: result.message,
            dc_fallback: result.dc_fallback,
            action_scores: result.action_scores,
            lines_we_care_about: result.lines_we_care_about ?? null,
            computed_pairs: result.computed_pairs ?? null,
            // Persist the model the BACKEND actually executed (echoed in
            // the result event). Differs from `configuration.model`
            // (= what was requested) when an unknown name silently fell
            // back to the default — the active_model is the ground truth.
            active_model: result.active_model ?? null,
            // Whether step-2 overflow graph was computed for this run.
            // True for any model that declares requires_overflow_graph,
            // OR when the operator opted in. Persisted so a reload knows
            // whether the Overflow Analysis tab will have content.
            compute_overflow_graph: result.compute_overflow_graph ?? null,
            // Per-stage execution times (seconds). Persisted so a reload
            // shows the same "Suggestions produced by …" breakdown the
            // operator saw at run time.
            overflow_graph_time: result.overflow_graph_time ?? null,
            action_prediction_time: result.action_prediction_time ?? null,
            assessment_time: result.assessment_time ?? null,
            step1_time: result.step1_time ?? null,
            enrichment_time: result.enrichment_time ?? null,
            wall_clock_time: result.wall_clock_time ?? null,
            actions: Object.fromEntries(
                Object.entries(result.actions).map(([id, detail]): [string, SavedActionEntry] => [
                    id,
                    {
                        description_unitaire: detail.description_unitaire,
                        rho_before: detail.rho_before,
                        rho_after: detail.rho_after,
                        max_rho: detail.max_rho,
                        max_rho_line: detail.max_rho_line,
                        is_rho_reduction: detail.is_rho_reduction,
                        is_estimated: detail.is_estimated,
                        non_convergence: detail.non_convergence,
                        action_topology: detail.action_topology,
                        estimated_max_rho: detail.estimated_max_rho,
                        estimated_max_rho_line: detail.estimated_max_rho_line,
                        is_islanded: detail.is_islanded,
                        n_components: detail.n_components,
                        disconnected_mw: detail.disconnected_mw,
                        lines_overloaded_after: detail.lines_overloaded_after,
                        load_shedding_details: detail.load_shedding_details,
                        curtailment_details: detail.curtailment_details,
                        pst_details: detail.pst_details,
                        // Provenance: "user" or a recommender model id.
                        // Restored verbatim on reload (with a derived
                        // fallback for legacy dumps that lack the field).
                        origin: detail.origin,
                        status: {
                            is_selected: selectedActionIds.has(id),
                            is_suggested: suggestedByRecommenderIds.has(id),
                            is_rejected: rejectedActionIds.has(id),
                            is_manually_simulated: manuallyAddedIds.has(id),
                        },
                    },
                ])
            ),
            combined_actions: savedCombinedActions,
        }
        : null;

    return {
        saved_at: new Date().toISOString(),
        configuration: {
            network_path: networkPath,
            action_file_path: actionPath,
            layout_path: layoutPath,
            min_line_reconnections: minLineReconnections,
            min_close_coupling: minCloseCoupling,
            min_open_coupling: minOpenCoupling,
            min_line_disconnections: minLineDisconnections,
            min_pst: minPst,
            min_load_shedding: minLoadShedding,
            min_renewable_curtailment_actions: minRenewableCurtailmentActions,
            n_prioritized_actions: nPrioritizedActions,
            lines_monitoring_path: linesMonitoringPath,
            monitoring_factor: monitoringFactor,
            pre_existing_overload_threshold: preExistingOverloadThreshold,
            ignore_reconnections: ignoreReconnections,
            pypowsybl_fast_mode: pypowsyblFastMode,
            // Pluggable-recommender selection at save time. Optional —
            // older session builders that didn't pass these fields
            // emit `undefined`, which `JSON.stringify` drops from the
            // output (preserves backwards compatibility for the
            // existing session-reader code paths).
            ...(recommenderModel !== undefined ? { model: recommenderModel } : {}),
            ...(computeOverflowGraph !== undefined ? { compute_overflow_graph: computeOverflowGraph } : {}),
        },
        contingency: (() => {
            const elements: string[] = contingencyInput && contingencyInput.length > 0
                ? [...contingencyInput]
                : (legacyBranch ? [legacyBranch] : []);
            return {
                disconnected_elements: elements,
                ...(elements.length === 1
                    ? { disconnected_element: elements[0] }
                    : {}),
                selected_overloads: Array.from(selectedOverloads),
                monitor_deselected: monitorDeselected,
                ...(committedAdditionalLinesToCut && committedAdditionalLinesToCut.size > 0
                    ? { additional_lines_to_cut: Array.from(committedAdditionalLinesToCut) }
                    : {}),
            };
        })(),
        overloads: {
            n_overloads: nOverloads,
            n1_overloads: n1Overloads,
            resolved_overloads: result?.lines_overloaded ?? [],
            ...(nOverloadsRho && nOverloadsRho.length === nOverloads.length ? { n_overloads_rho: nOverloadsRho } : {}),
            ...(n1OverloadsRho && n1OverloadsRho.length === n1Overloads.length ? { n1_overloads_rho: n1OverloadsRho } : {}),
        },
        overflow_graph: result?.pdf_url
            ? { pdf_url: result.pdf_url, pdf_path: result.pdf_path ?? null }
            : null,
        analysis,
        interaction_log: interactionLog,
    };
}
