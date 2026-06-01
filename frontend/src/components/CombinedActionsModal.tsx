// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api';
import type { AnalysisResult, CombinedAction, ActionDetail, ActionOverviewFilters } from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import {
    DEFAULT_ACTION_OVERVIEW_FILTERS,
    matchesActionTypeFilter,
    resolveRowSeverity,
    rowPassesActionFilters,
    rowPassesSeverityFilter,
} from '../utils/actionTypes';
import ComputedPairsTable, { type ComputedPairEntry } from './ComputedPairsTable';
import ExplorePairsTab from './ExplorePairsTab';
import ActionFilterRings from './ActionFilterRings';
import { colors } from '../styles/tokens';

interface SimulationFeedback {
    max_rho: number | null;
    max_rho_line: string;
    is_rho_reduction: boolean;
    is_islanded?: boolean;
    disconnected_mw?: number;
    non_convergence?: string | null;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    analysisResult: AnalysisResult | null;
    simulatedActions?: Record<string, ActionDetail>;
    /** Currently APPLIED contingency (list of element IDs). */
    disconnectedElement: string[];
    // Called when a COMBINED pair is simulated (green "Simulate Combined"
    // button). Promotes the new pair into Selected Actions.
    onSimulateCombined: (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => void;
    // Called when a SINGLE action is (re-)simulated from the Explore Pairs
    // table. Updates the action in place — the action stays in its current
    // bucket (Suggested / Selected) and is not auto-promoted.
    onSimulateSingleAction: (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => void;
    monitoringFactor?: number;
    linesOverloaded?: string[];
    displayName?: (id: string) => string;
}

/** Canonicalize a combined action ID by sorting the parts alphabetically. */
function canonicalizeId(id: string): string {
    if (!id || !id.includes('+')) return id;
    return id.split('+').map(p => p.trim()).sort().join('+');
}

const CombinedActionsModal: React.FC<Props> = ({
    isOpen,
    onClose,
    analysisResult,
    simulatedActions = {},
    disconnectedElement,
    onSimulateCombined,
    onSimulateSingleAction,
    monitoringFactor = 1.0,
    linesOverloaded = [],
    displayName = (id: string) => id,
}) => {
    const [activeTab, setActiveTab] = useState<'computed' | 'explore'>('computed');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [preview, setPreview] = useState<CombinedAction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [simulating, setSimulating] = useState(false);
    const [simulationFeedback, setSimulationFeedback] = useState<SimulationFeedback | null>(null);
    // Per-pair simulation results tracked within this modal session
    const [sessionSimResults, setSessionSimResults] = useState<Record<string, SimulationFeedback>>({});
    const lastSelectionRef = useRef<string>('');
    // Shared severity + action-type filter for BOTH modal tabs. Modal-
    // local (independent of the sidebar's global overviewFilters) — the
    // ActionFilterRings instance lives next to the modal title.
    const [filters, setFilters] = useState<ActionOverviewFilters>(DEFAULT_ACTION_OVERVIEW_FILTERS);

    // actionId → recommender score-type, so pair constituents and
    // scored rows classify by type the same way the sidebar feed does.
    const scoreTypeByActionId = useMemo(() => {
        const m = new Map<string, string>();
        const scores = analysisResult?.action_scores;
        if (!scores) return m;
        for (const [type, data] of Object.entries(scores)) {
            const s = data?.scores || {};
            for (const actionId of Object.keys(s)) {
                if (!m.has(actionId)) m.set(actionId, type);
            }
        }
        return m;
    }, [analysisResult]);

    // Scored actions for exploration, derived from analysisResult.action_scores
    const scoredActionsList = useMemo(() => {
        if (!analysisResult?.action_scores) return [];
        const list: { actionId: string; score: number; type: string; mwStart: number | null }[] = [];
        for (const [type, data] of Object.entries(analysisResult.action_scores)) {
            const scores = data?.scores || {};
            const mwStartMap = data?.mw_start;
            for (const [actionId, score] of Object.entries(scores)) {
                // Filter out estimated-only combined actions from the exploration list
                if (actionId.includes('+')) {
                    const detail = analysisResult.actions?.[actionId];
                    if (detail?.is_estimated || !detail?.rho_after || detail.rho_after.length === 0) continue;
                }
                const mwStart = mwStartMap?.[actionId] ?? null;
                list.push({ actionId, score, type, mwStart: mwStart != null ? Number(mwStart) : null });
            }
        }
        return list.sort((a, b) => {
            if (a.type !== b.type) return a.type.localeCompare(b.type);
            return b.score - a.score;
        });
    }, [analysisResult]);

    // Explore-Pairs rows after the shared filter. Severity classifies
    // off the SIMULATED max-loading (session or analysis result) when
    // available; scored-but-untested rows have no value, so they drop
    // out as soon as a severity bucket is deselected.
    const filteredScoredActionsList = useMemo(() => {
        return scoredActionsList.filter(item => {
            const sessionSim = sessionSimResults[item.actionId];
            const analysisSim = analysisResult?.actions?.[item.actionId];
            const simulatedDetail = sessionSim
                ?? (analysisSim && !analysisSim.is_estimated && analysisSim.rho_after && analysisSim.rho_after.length > 0
                    ? analysisSim
                    : null);
            return rowPassesActionFilters(filters, {
                actionId: item.actionId,
                scoreType: item.type,
                simulatedMaxRho: simulatedDetail?.max_rho ?? null,
                estimatedMaxRho: analysisSim?.estimated_max_rho ?? null,
                isFault: !!(simulatedDetail?.is_islanded || simulatedDetail?.non_convergence),
            }, monitoringFactor);
        });
    }, [scoredActionsList, filters, sessionSimResults, analysisResult, monitoringFactor]);

    // Pre-computed combined pairs from analysis
    const computedPairsList = useMemo(() => {
        const combined_actions = analysisResult?.combined_actions || {};
        const combinedEntries = Object.entries(combined_actions);

        // Build a set of canonical keys present in combined_actions
        const combinedCanonicalKeys = new Set(combinedEntries.map(([id]) => canonicalizeId(id)));

        // Also include any simulated pairs in result.actions not in combined_actions
        const simulatedOnly = Object.entries(analysisResult?.actions || {})
            .filter(([id]) => id.includes('+') && !combined_actions[id] && !combinedCanonicalKeys.has(canonicalizeId(id)));

        const allPairs = [
            ...combinedEntries.map(([id, ca]) => {
                const cId = canonicalizeId(id);
                const sessionResult = sessionSimResults[id] || sessionSimResults[cId];
                const parentSimData = simulatedActions[id] || simulatedActions[cId];
                const analysisSimData = analysisResult?.actions?.[id] || analysisResult?.actions?.[cId];
                const simData = parentSimData || analysisSimData;
                const isRealSim = !!sessionResult || (simData && !simData.is_estimated && simData.rho_after && simData.rho_after.length > 0);
                return { id, data: ca, simData: isRealSim ? (sessionResult || simData) : null };
            }),
            ...simulatedOnly.map(([id, data]) => ({ id, data: {} as CombinedAction, simData: data })),
        ];

        return allPairs
            .sort((a, b) => {
                const valA = (a.data.estimated_max_rho ?? a.data.max_rho) ?? 999;
                const valB = (b.data.estimated_max_rho ?? b.data.max_rho) ?? 999;
                return valA - valB;
            })
            .map(({ id, data, simData }) => {
                const parts = id.split('+');
                const isSimulated = !!simData;
                const simMaxRho = (simData as ActionDetail | SimulationFeedback)?.max_rho ?? null;
                const simMaxRhoLine = (simData as ActionDetail | SimulationFeedback)?.max_rho_line ?? null;
                const estMaxRho = data.estimated_max_rho ?? data.max_rho;
                const estMaxRhoLine = data.estimated_max_rho_line ?? data.max_rho_line;

                return {
                    id,
                    action1: parts[0]?.trim() || 'N/A',
                    action2: parts[1]?.trim() || 'N/A',
                    betas: data.betas,
                    estimated_max_rho: estMaxRho,
                    estimated_max_rho_line: estMaxRhoLine,
                    target_max_rho: data.target_max_rho ?? null,
                    target_max_rho_line: data.target_max_rho_line,
                    is_suspect: !!data.is_islanded,
                    isSimulated,
                    simulated_max_rho: simMaxRho,
                    simulated_max_rho_line: simMaxRhoLine,
                    simData: simData
                };
            });
    }, [analysisResult, simulatedActions, sessionSimResults]);

    // Computed-Pairs rows after the shared filter. A pair matches the
    // type ring when EITHER constituent matches; severity classifies
    // off the pair's simulated max-loading, falling back to the
    // estimated value.
    const filteredComputedPairsList = useMemo(() => {
        return computedPairsList.filter(p => {
            const typeOk = filters.actionType === 'all'
                || matchesActionTypeFilter(filters.actionType, p.action1, null, scoreTypeByActionId.get(p.action1) ?? null)
                || matchesActionTypeFilter(filters.actionType, p.action2, null, scoreTypeByActionId.get(p.action2) ?? null);
            if (!typeOk) return false;
            const simData = p.simData as (ActionDetail | SimulationFeedback) | null;
            const simulatedMaxRho = p.isSimulated ? p.simulated_max_rho : null;
            const estimatedMaxRho = p.estimated_max_rho ?? null;
            const severity = resolveRowSeverity({
                simulatedMaxRho,
                estimatedMaxRho,
                isFault: !!(simData?.is_islanded || simData?.non_convergence) || p.is_suspect,
            }, monitoringFactor);
            if (!rowPassesSeverityFilter(severity, filters.categories)) return false;
            // Max-loading threshold — same precedence as ``rowPassesActionFilters``
            // (simulated first, estimated fallback), so the slider applies
            // consistently to unitary cards and combined pairs.
            const referenceRho = simulatedMaxRho ?? estimatedMaxRho;
            if (referenceRho != null && referenceRho > filters.threshold) return false;
            return true;
        });
    }, [computedPairsList, filters, scoreTypeByActionId, monitoringFactor]);

    // Log modal open/close and cleanup when modal closes
    useEffect(() => {
        if (isOpen) {
            interactionLogger.record('combine_modal_opened');
        } else {
            interactionLogger.record('combine_modal_closed');
            setSelectedIds(new Set());
            setPreview(null);
            setError(null);
            setActiveTab('computed');
            setSimulationFeedback(null);
            setSimulating(false);
            setSessionSimResults({});
        }
    }, [isOpen]);

    // Drive the estimation/comparison card from the current selection
    // and active tab only. We intentionally do NOT depend on
    // analysisResult here: a successful Simulate Combined mutates
    // analysisResult.actions through onSimulateCombined, and we must
    // keep the preview card visible so the user can read the simulation
    // result in place. The card is only reset when the user changes
    // their pair selection or leaves the Explore Pairs tab.
    useEffect(() => {
        const currentSelection = Array.from(selectedIds).sort().join('+');
        lastSelectionRef.current = currentSelection;

        if (activeTab === 'explore' && selectedIds.size === 2 && disconnectedElement && disconnectedElement.length > 0) {
            const [id1, id2] = Array.from(selectedIds);
            const pairKey = [id1, id2].sort().join('+');
            const preComputed = analysisResult?.combined_actions?.[pairKey];

            if (preComputed) {
                interactionLogger.record('combine_pair_estimated', {
                    action1_id: id1, action2_id: id2,
                    estimated_max_rho: preComputed.estimated_max_rho ?? preComputed.max_rho,
                    estimated_max_rho_line: preComputed.estimated_max_rho_line ?? preComputed.max_rho_line,
                });
                setPreview(preComputed);
                setError(null);
            } else {
                setPreview(null);
                setSimulationFeedback(null);
            }
        } else {
            setPreview(null);
            setError(null);
            setSimulationFeedback(null);
        }
        // analysisResult is deliberately omitted — see comment above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIds, disconnectedElement, activeTab]);

    const handleEstimate = async () => {
        if (activeTab !== 'explore' || selectedIds.size !== 2 || !disconnectedElement || disconnectedElement.length === 0) return;
        const [id1, id2] = Array.from(selectedIds);

        setLoading(true);
        setError(null);
        try {
            const result = await api.computeSuperposition(id1, id2, disconnectedElement);
            if (result.error) {
                setError(result.error);
                setPreview(result);
            } else {
                interactionLogger.record('combine_pair_estimated', {
                    action1_id: id1, action2_id: id2,
                    estimated_max_rho: result.estimated_max_rho ?? result.max_rho,
                    estimated_max_rho_line: result.estimated_max_rho_line ?? result.max_rho_line,
                });
                setPreview(result);
                setError(null);
            }
        } catch (e: unknown) {
            const err = e as { response?: { data?: { detail?: string } }, message?: string };
            setError(err?.response?.data?.detail || err.message || 'Failed to compute superposition');
            setPreview(null);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    // Check if any selected action involves load shedding or curtailment (combination not supported)
    const allActions = { ...simulatedActions, ...analysisResult?.actions };
    const selectedActionsDetails = Array.from(selectedIds).map(id => allActions[id]);
    const hasRestricted = selectedActionsDetails.some(detail => 
        (detail?.load_shedding_details && detail.load_shedding_details.length > 0) ||
        (detail?.curtailment_details && detail.curtailment_details.length > 0)
    );

    const handleToggle = (id: string) => {
        setSimulationFeedback(null);
        setError(null);
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) {
            newSet.delete(id);
            interactionLogger.record('combine_pair_toggled', { action_id: id, selected: false });
        } else {
            if (newSet.size >= 2) return; // Only allow 2
            newSet.add(id);
            interactionLogger.record('combine_pair_toggled', { action_id: id, selected: true });
        }
        setSelectedIds(newSet);
    };

    const handleSimulate = async (actionId?: string) => {
        const idToSimulate = actionId ? (actionId.includes('+') ? canonicalizeId(actionId) : actionId) : Array.from(selectedIds).sort().join('+');
        if (!idToSimulate || !disconnectedElement || disconnectedElement.length === 0) return;

        // Try to find estimation data to preserve it
        const estimationData = actionId
            ? (analysisResult?.combined_actions?.[idToSimulate] || analysisResult?.combined_actions?.[actionId])
            : preview;

        // Build action_content from saved topologies
        let actionContent: Record<string, unknown> | null = null;
        const parts = idToSimulate.includes('+') ? idToSimulate.split('+') : [idToSimulate];
        const allActions = { ...simulatedActions, ...analysisResult?.actions };
        const perAction: Record<string, unknown> = {};
        for (const part of parts) {
            const partDetail = allActions[part];
            if (partDetail?.action_topology) perAction[part] = partDetail.action_topology;
        }
        if (Object.keys(perAction).length > 0) actionContent = perAction;

        setSimulating(true);
        if (!actionId || actionId.includes('+')) {
            setSimulationFeedback(null);
        }
        setError(null);
        try {
            const actualLinesOverloaded = (linesOverloaded && linesOverloaded.length > 0) ? linesOverloaded : null;
            const result = await api.simulateManualAction(idToSimulate, disconnectedElement, actionContent, actualLinesOverloaded);
            const feedback: SimulationFeedback = {
                max_rho: result.max_rho,
                max_rho_line: result.max_rho_line,
                is_rho_reduction: result.is_rho_reduction,
                is_islanded: result.is_islanded,
                disconnected_mw: result.disconnected_mw,
                non_convergence: result.non_convergence,
            };
            const simParts = idToSimulate.split('+');
            interactionLogger.record('combine_pair_simulated', {
                combined_id: idToSimulate,
                action1_id: simParts[0],
                action2_id: simParts[1],
                simulated_max_rho: result.max_rho,
            });
            setSimulationFeedback(feedback);
            // Store per-pair result in session map so the computed pairs table
            // correctly reflects each pair's own simulation result
            setSessionSimResults(prev => ({ ...prev, [idToSimulate]: feedback }));
            if (!actionId || actionId.includes('+')) {
                setSimulationFeedback(feedback);
            }
            
            const detail: ActionDetail = {
                description_unitaire: result.description_unitaire,
                rho_before: result.rho_before,
                rho_after: result.rho_after,
                max_rho: result.max_rho,
                max_rho_line: result.max_rho_line,
                is_rho_reduction: result.is_rho_reduction,
                is_islanded: result.is_islanded,
                n_components: result.n_components,
                disconnected_mw: result.disconnected_mw,
                non_convergence: result.non_convergence,
                lines_overloaded_after: result.lines_overloaded_after,
                load_shedding_details: result.load_shedding_details,
                curtailment_details: result.curtailment_details,
                pst_details: result.pst_details,
                estimated_max_rho: estimationData?.estimated_max_rho ?? estimationData?.max_rho,
                estimated_max_rho_line: estimationData?.estimated_max_rho_line ?? estimationData?.max_rho_line,
                is_estimated: false,
                action_topology: result.action_topology
            };
            
            // A "single action" simulation is one triggered from a row in
            // the Explore Pairs table (actionId is passed AND does not
            // contain '+'). In that case the user is just previewing an
            // individual action to compare before combining — it should
            // land in Suggested Actions (not Selected).
            //
            // A combined pair simulation (no actionId, or an id containing
            // '+') is an explicit user action to add the pair as a new
            // candidate and is promoted into Selected Actions.
            //
            // In either case we deliberately DO NOT close the modal: the
            // updated action card and its action-variant diagram are
            // populated in the background so the user can keep interacting
            // with the modal (e.g. simulate more rows, compare another
            // pair) without losing their place.
            const isSingleActionFromExplore = actionId !== undefined && !actionId.includes('+');
            if (isSingleActionFromExplore) {
                onSimulateSingleAction(idToSimulate, detail, result.lines_overloaded || []);
            } else {
                onSimulateCombined(idToSimulate, detail, result.lines_overloaded || []);
            }
        } catch (e: unknown) {
            const err = e as { response?: { data?: { detail?: string } }, message?: string };
            setError(err?.response?.data?.detail || err?.message || 'Simulation failed');
        } finally {
            setSimulating(false);
        }
    };

    return (
        <div style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            zIndex: 10000,
            // Anchor the modal card to a fixed viewport offset
            // (``alignItems: flex-start`` + a top margin set on the
            // card) instead of centering it vertically — otherwise the
            // title + filter header hops up and down every time the
            // Computed / Explore Pairs body changes height (chip
            // filter, tab switch, action-type drilldown).
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center'
        }}>
            <div
                data-testid="combine-modal-card"
                style={{
                    background: colors.surface,
                    borderRadius: '12px',
                    // Use (almost) the full viewport width instead of a
                    // fixed 950px so wide tables in the Computed / Explore
                    // Pairs tabs fit without forcing a horizontal
                    // scrollbar on the modal itself.
                    width: '95vw',
                    maxWidth: '95vw',
                    marginTop: '7.5vh',
                    maxHeight: '85vh',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
                    overflow: 'hidden'
                }}
            >
                <div style={{ padding: '15px 24px', borderBottom: `1px solid ${colors.borderSubtle}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', background: colors.surfaceRaised }}>
                    {/* Shared severity + action-type filter sits next to
                        the title so both tabs (Computed / Explore Pairs)
                        are driven by one control. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Combine Actions</h2>
                        <ActionFilterRings filters={filters} onFiltersChange={setFilters} />
                    </div>
                    <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '24px', cursor: 'pointer', color: colors.textTertiary }}>&times;</button>
                </div>

                <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, background: colors.surfaceRaised, padding: '0 24px' }}>
                    <div className={`modal-tab ${activeTab === 'computed' ? 'active' : ''}`} onClick={() => setActiveTab('computed')} data-testid="tab-computed">Computed Pairs</div>
                    <div className={`modal-tab ${activeTab === 'explore' ? 'active' : ''}`} onClick={() => setActiveTab('explore')} data-testid="tab-explore">Explore Pairs</div>
                </div>

                <div
                    data-testid="combine-modal-body"
                    style={{
                        padding: '20px 24px',
                        overflowY: 'auto',
                        // Tables inside the modal manage their own scroll;
                        // never let horizontal overflow escape to the
                        // modal level.
                        overflowX: 'hidden',
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: 0,
                    }}
                >
                    {activeTab === 'computed' ? (
                        <ComputedPairsTable
                            computedPairsList={filteredComputedPairsList as ComputedPairEntry[]}
                            monitoringFactor={monitoringFactor}
                            simulating={simulating}
                            onSimulate={handleSimulate}
                            displayName={displayName}
                        />
                    ) : (
                        <ExplorePairsTab
                            scoredActionsList={filteredScoredActionsList}
                            selectedIds={selectedIds}
                            onToggle={handleToggle}
                            onClearSelection={() => setSelectedIds(new Set())}
                            preview={preview}
                            simulationFeedback={simulationFeedback}
                            sessionSimResults={sessionSimResults}
                            analysisResult={analysisResult}
                            loading={loading}
                            error={error}
                            simulating={simulating}
                            hasRestricted={hasRestricted}
                            monitoringFactor={monitoringFactor}
                            onEstimate={handleEstimate}
                            onSimulate={() => handleSimulate()}
                            onSimulateSingle={handleSimulate}
                            displayName={displayName}
                        />
                    )}
                </div>

                <div style={{ padding: '16px 24px', borderTop: `1px solid ${colors.borderSubtle}`, display: 'flex', justifyContent: 'flex-end', gap: '12px', background: colors.surfaceRaised }}>
                    <button onClick={onClose} style={{ padding: '10px 20px', background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '6px', cursor: 'pointer', fontWeight: 500, color: colors.textTertiary }}>Close</button>
                </div>

            </div>
        </div>
    );
};

export default CombinedActionsModal;
