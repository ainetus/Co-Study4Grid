// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { ActionDetail, NodeMeta, EdgeMeta, AvailableAction, AnalysisResult, CombinedAction, DiagramData, ActionOverviewFilters } from '../types';
import { actionPassesOverviewFilter } from '../utils/svgUtils';
import { DEFAULT_ACTION_OVERVIEW_FILTERS, matchesActionTypeFilter, rowPassesActionFilters } from '../utils/actionTypes';
import { api } from '../api';
import type { ModelDescriptor } from '../api';
import { interactionLogger } from '../utils/interactionLogger';
import CombinedActionsModal from './CombinedActionsModal';
import ActionCard from './ActionCard';
import AdditionalLinesPicker from './AdditionalLinesPicker';
import ActionSearchDropdown from './ActionSearchDropdown';
import { colors } from '../styles/tokens';
import { apiErrorMessage } from '../utils/apiError';

interface ActionFeedProps {
    actions: Record<string, ActionDetail>;
    actionScores?: Record<string, Record<string, unknown>>;
    linesOverloaded: string[];
    selectedActionId: string | null;
    selectedActionIds: Set<string>;
    rejectedActionIds: Set<string>;
    pendingAnalysisResult: AnalysisResult | null;
    /**
     * When set, the feed scrolls to the action card matching the id.
     * The `seq` counter lets the same action trigger a re-scroll
     * (e.g. tapping the same pin twice).  Driven by pin single-click
     * on the action overview diagram.
     */
    scrollTarget?: { id: string; seq: number } | null;
    onDisplayPrioritizedActions: () => void;
    onRunAnalysis: () => void;
    canRunAnalysis: boolean;
    onActionSelect: (actionId: string | null) => void;
    onActionFavorite: (actionId: string) => void;
    onActionReject: (actionId: string) => void;
    onAssetClick: (actionId: string, assetName: string, tab?: 'action' | 'contingency') => void;
    nodesByEquipmentId: Map<string, NodeMeta> | null;
    edgesByEquipmentId: Map<string, EdgeMeta> | null;
    /** Currently APPLIED contingency (list of element IDs disconnected). */
    disconnectedElement: string[];
    onManualActionAdded: (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => void;
    onActionResimulated: (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => void;
    analysisLoading: boolean;
    monitoringFactor: number;
    manuallyAddedIds: Set<string>;
    onVlDoubleClick?: (actionId: string, vlName: string) => void;
    combinedActions: Record<string, CombinedAction> | null;
    onUpdateCombinedEstimation?: (pairId: string, estimation: { estimated_max_rho: number; estimated_max_rho_line: string }) => void;
    /** Resolve an element/VL ID to its human-readable display name. Falls back to the ID. */
    displayName?: (id: string) => string;
    /**
     * Optional pre-fetch hook. When provided, the Add-action / target-MW /
     * target-tap handlers stream both the simulation metrics AND the
     * post-action NAD in a single request, and invoke this callback with
     * the ready-to-render diagram. A subsequent click on the action card
     * reads this cache (see useDiagrams.handleActionSelect) and paints
     * instantly — saving ~5-7 s of pypowsybl NAD regeneration on large
     * grids. When the prop is absent, the legacy `simulateManualAction`
     * single-shot call is used, preserving backward compat for tests and
     * call sites that do not wire the cache through.
     */
    onActionDiagramPrimed?: (actionId: string, diagram: DiagramData & { svg: string }, voltageLevelsLength: number) => void;
    /** Current voltage-levels count, forwarded to the primer callback's
     * `processSvg` pass. Unused when onActionDiagramPrimed is absent. */
    voltageLevelsLength?: number;
    /**
     * Shared category + threshold filters from the Remedial Action
     * overview. When provided, action cards whose severity bucket is
     * disabled OR whose max_rho exceeds the threshold are hidden from
     * the Suggested / Rejected / Selected lists — so the operator
     * sees the same set of actions on the overview and in the feed.
     */
    overviewFilters?: ActionOverviewFilters;
    /** Update the shared filter state (owned by App.tsx). */
    onOverviewFiltersChange?: (next: ActionOverviewFilters) => void;
    /**
     * Catalogue of disconnectable elements feeding the
     * "additional lines to prevent flow increase" picker rendered
     * above the Analyze & Suggest button.
     */
    branches?: string[];
    /** Operator-selected extras (ExpertAgent's `additionalLinesToCut`). */
    additionalLinesToCut?: Set<string>;
    onToggleAdditionalLineToCut?: (line: string) => void;
    /** N-1 detected overloads — excluded from the picker suggestions. */
    n1Overloads?: string[];
    /**
     * Recommendation model selector exposed above "Analyze & Suggest"
     * (mirror of the same control in the Settings modal). Lets the
     * operator pick a different model and re-run without opening
     * Settings.
     */
    recommenderModel?: string;
    setRecommenderModel?: (v: string) => void;
    availableModels?: ModelDescriptor[];
    /**
     * Display label of the model that produced the currently-shown
     * suggestions (echoed by the backend in the step-2 `result` event
     * as ``active_model``). Rendered just below the "Suggested Actions"
     * tab header alongside the Clear button.
     */
    activeModelLabel?: string | null;
    /**
     * Per-stage execution times (seconds) for the current analysis,
     * echoed by the backend in the step-2 ``result`` event. Rendered as
     * a one-line breakdown right under "Suggestions produced by …".
     * ``overflowGraphTime`` is ``null`` when the active model does not
     * consume the overflow graph (its column is hidden in that case).
     * ``step1Time`` is the contingency simulation that runs before
     * step 2; ``enrichmentTime`` is the Co-Study4Grid post-processing
     * after assessment. ``wallClockTime`` is the frontend-measured
     * round-trip from the click to the result event.
     */
    overflowGraphTime?: number | null;
    actionPredictionTime?: number | null;
    assessmentTime?: number | null;
    step1Time?: number | null;
    enrichmentTime?: number | null;
    wallClockTime?: number | null;
    /**
     * Clear the un-touched recommender suggestions — wipes entries
     * still in ``suggestedByRecommenderIds`` that the operator has
     * NOT starred / rejected / manually added. Lets the user relaunch
     * with a different model without losing their decisions.
     */
    onClearSuggested?: () => void;
}

const ActionFeed: React.FC<ActionFeedProps> = ({
    actions,
    actionScores,
    linesOverloaded,
    selectedActionId,
    scrollTarget,
    selectedActionIds,
    rejectedActionIds,
    pendingAnalysisResult,
    onDisplayPrioritizedActions,
    onRunAnalysis,
    canRunAnalysis,
    onActionSelect,
    onActionFavorite,
    onActionReject,
    onAssetClick,
    nodesByEquipmentId,
    edgesByEquipmentId,
    disconnectedElement,
    onManualActionAdded,
    onActionResimulated,
    analysisLoading,
    monitoringFactor,
    manuallyAddedIds,
    onVlDoubleClick,
    combinedActions,
    onUpdateCombinedEstimation,
    displayName = (id: string) => id,
    onActionDiagramPrimed,
    voltageLevelsLength,
    overviewFilters,
    branches,
    additionalLinesToCut,
    onToggleAdditionalLineToCut,
    n1Overloads,
    recommenderModel,
    setRecommenderModel,
    availableModels,
    activeModelLabel,
    overflowGraphTime,
    actionPredictionTime,
    assessmentTime,
    step1Time,
    enrichmentTime,
    wallClockTime,
    onClearSuggested,
}) => {
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [combineModalOpen, setCombineModalOpen] = useState(false);
    const [availableActions, setAvailableActions] = useState<AvailableAction[]>([]);
    const [loadingActions, setLoadingActions] = useState(false);
    const [simulating, setSimulating] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [tooltip, setTooltip] = useState<{ content: React.ReactNode; x: number; y: number } | null>(null);
    const [suggestedTab, setSuggestedTab] = useState<'prioritized' | 'rejected'>('prioritized');
    const [dismissedSelectedWarning, setDismissedSelectedWarning] = useState(false);
    // Per-action editable MW for LS/RC actions. This state is shared between
    // the score table row input (in the manual-selection dropdown) and the
    // action card input, so that editing one reflects immediately in the other.
    const [cardEditMw, setCardEditMw] = useState<Record<string, string>>({});
    // Per-action editable tap position for PST action re-simulation (keyed by actionId)
    const [cardEditTap, setCardEditTap] = useState<Record<string, string>>({});
    const [resimulating, setResimulating] = useState<string | null>(null);
    const [dismissedRejectedWarning, setDismissedRejectedWarning] = useState(false);

    const showTooltip = (e: React.MouseEvent, content: React.ReactNode) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setTooltip({ content, x: rect.left, y: rect.bottom + 5 });
    };
    const hideTooltip = () => setTooltip(null);

    // Shared helper: simulate a manual action and — when the parent hook
    // provided `onActionDiagramPrimed` — also pre-fetch the post-action NAD
    // in the same streamed request. Returns the same `simulate_manual_action`
    // shape used downstream so the three call sites (Add / target_mw /
    // target_tap re-sim) stay structurally identical to the pre-stream code.
    //
    // When `onActionDiagramPrimed` is not wired up (older tests, call sites
    // that don't care about the cache), this transparently falls back to
    // the single-shot `api.simulateManualAction` endpoint.
    // Whether the parent hook wired up the pre-fetch primer. When false we
    // keep firing the legacy single-shot `api.simulateManualAction` directly
    // from each call site (preserving exact call arity for tests that assert
    // on it). When true each call site funnels through
    // `streamSimulateAndPrimeDiagram` instead, which consumes the NDJSON
    // stream, returns the metrics event shape (same as
    // `simulate_manual_action`), and pushes the diagram event into the
    // `useDiagrams` cache so a subsequent click on the action card paints
    // the SVG instantly.
    const canPrimeDiagram = !!onActionDiagramPrimed && voltageLevelsLength != null;
    const streamSimulateAndPrimeDiagram = async (
        actionId: string,
        disconnectedEls: string[],
        actionContent: Record<string, unknown> | null,
        linesOvl: string[] | null,
        targetMw: number | null | undefined,
        targetTap: number | null | undefined,
    ): Promise<Awaited<ReturnType<typeof api.simulateManualAction>>> => {
        const response = await api.simulateAndVariantDiagramStream({
            action_id: actionId,
            disconnected_elements: disconnectedEls,
            action_content: actionContent,
            lines_overloaded: linesOvl,
            target_mw: targetMw ?? null,
            target_tap: targetTap ?? null,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metrics: Awaited<ReturnType<typeof api.simulateManualAction>> | null = null;
        let streamErr: string | null = null;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!;
            for (const line of lines) {
                if (!line.trim()) continue;
                let event: Record<string, unknown>;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type === 'metrics') {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { type: _t, ...rest } = event;
                    metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
                } else if (event.type === 'diagram') {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { type: _t, ...rest } = event;
                    // `canPrimeDiagram` is verified before this helper is called.
                    onActionDiagramPrimed!(actionId, rest as unknown as DiagramData & { svg: string }, voltageLevelsLength!);
                } else if (event.type === 'error') {
                    streamErr = (event.message as string) || 'stream error';
                }
            }
        }
        if (streamErr) throw new Error(streamErr);
        if (!metrics) throw new Error('Stream ended without metrics event');
        return metrics;
    };

    // Fetch available actions when search is opened
    const handleOpenSearch = async () => {
        if (searchOpen) { setSearchOpen(false); return; }
        setSearchOpen(true);
        setSearchQuery('');
        setError(null);
        if (availableActions.length === 0) {
            setLoadingActions(true);
            try {
                const list = await api.getAvailableActions();
                setAvailableActions(list);
            } catch (e) {
                console.error('Failed to fetch actions:', e);
                setError('Failed to load actions list');
            } finally {
                setLoadingActions(false);
            }
        }
        setTimeout(() => searchInputRef.current?.focus(), 50);
    };

    // Shared severity + action-type filter for the manual-selection
    // dropdown — its own `ActionFilterRings` instance, independent of
    // the sidebar's global overviewFilters and the Combine modal's.
    const [dropdownFilters, setDropdownFilters] = useState<ActionOverviewFilters>(DEFAULT_ACTION_OVERVIEW_FILTERS);

    const filteredActions = useMemo(() => {
        const q = searchQuery.toLowerCase();
        const alreadyShown = new Set(Object.keys(actions));
        // Catalogue search rows have no simulated / estimated value, so
        // only the action-type ring applies here — the severity ring
        // would otherwise empty the raw-ID search entirely.
        return availableActions
            .filter(a => !alreadyShown.has(a.id))
            .filter(a => matchesActionTypeFilter(dropdownFilters.actionType, a.id, a.description || null, a.type || null))
            .filter(a => a.id.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q))
            .slice(0, 20);
    }, [searchQuery, availableActions, actions, dropdownFilters.actionType]);

    // Whether the analysis has produced ANY scored action — independent
    // of the current chip-filter selection. Drives the wide-modal
    // layout so the operator stays in the centered overlay even when a
    // type filter narrows ``scoredActionsList`` down to zero rows; the
    // alternative (toggling between the wide modal and the small
    // button-anchored dropdown on every chip click) reads as the modal
    // "closing" mid-interaction.
    const hasAnyScoredAction = useMemo(() => {
        if (!actionScores) return false;
        return Object.values(actionScores).some(d =>
            d && typeof d === 'object'
            && Object.keys((d as { scores?: Record<string, number> }).scores ?? {}).length > 0
        );
    }, [actionScores]);

    // Format scored actions — filtered by the shared rings (type +
    // severity). Severity uses the simulated max-loading once the
    // action has been computed; scored-but-untested rows have no
    // value and drop out as soon as a severity bucket is deselected.
    const scoredActionsList = useMemo(() => {
        if (!actionScores) return [];
        const list: { type: string; actionId: string; score: number; mwStart: number | null }[] = [];
        for (const [type, data] of Object.entries(actionScores)) {
            const scores = data?.scores || {};
            for (const [actionId, score] of Object.entries(scores)) {
                const detail = actions[actionId];
                const passes = rowPassesActionFilters(dropdownFilters, {
                    actionId,
                    description: detail?.description_unitaire ?? null,
                    scoreType: type,
                    simulatedMaxRho: detail?.max_rho ?? null,
                    estimatedMaxRho: detail?.estimated_max_rho ?? null,
                    isFault: !!(detail?.is_islanded || detail?.non_convergence),
                }, monitoringFactor);
                if (!passes) continue;
                const mwStartMap = (data as { mw_start?: Record<string, number | null> })?.mw_start;
                const mwStart = mwStartMap?.[actionId] ?? null;
                list.push({ type, actionId, score: Number(score), mwStart: mwStart != null ? Number(mwStart) : null });
            }
        }
        return list.sort((a, b) => {
            if (a.type !== b.type) {
                if (a.type === 'line_disconnection') return 1;
                if (b.type === 'line_disconnection') return -1;
                return a.type.localeCompare(b.type);
            }
            return b.score - a.score;
        });
    }, [actionScores, dropdownFilters, actions, monitoringFactor]);

    // Close dropdown on outside click
    useEffect(() => {
        if (!searchOpen) return;
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setSearchOpen(false);
                setSearchQuery('');
                setError(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [searchOpen]);

    const handleAddAction = async (actionId: string, targetMw?: number, targetTap?: number) => {
        const trimmedId = actionId.trim();
        if (!disconnectedElement || disconnectedElement.length === 0) {
            setError('Select a contingency first.');
            return;
        }
        setSimulating(trimmedId);
        setError(null);
        try {
            // Build actionContent from topologies if available (especially for combined actions)
            let actionContent: Record<string, unknown> | null = null;
            if (trimmedId.includes('+')) {
                const parts = trimmedId.split('+').map(p => p.trim());
                const perAction: Record<string, unknown> = {};
                for (const part of parts) {
                    const partDetail = actions[part];
                    if (partDetail?.action_topology) {
                        perAction[part] = partDetail.action_topology;
                    }
                }
                if (Object.keys(perAction).length > 0) {
                    actionContent = perAction;
                }
            } else {
                const detail = actions[trimmedId];
                if (detail?.action_topology) {
                    actionContent = detail.action_topology as unknown as Record<string, unknown>;
                }
            }

            const result = canPrimeDiagram
                ? await streamSimulateAndPrimeDiagram(trimmedId, disconnectedElement, actionContent, linesOverloaded, targetMw, targetTap)
                : await api.simulateManualAction(trimmedId, disconnectedElement, actionContent, linesOverloaded, targetMw, targetTap);
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
                redispatch_details: result.redispatch_details,
                pst_details: result.pst_details,

            };
            onManualActionAdded(trimmedId, detail, result.lines_overloaded || []);
            // Keep the wide score-table modal open after a successful
            // simulation so the operator can chain several manual
            // simulations in a row (same UX contract as
            // ``CombinedActionsModal.handleSimulate``). Closing was
            // forcing a re-open + re-scroll for every row the
            // operator wanted to compare. The narrow no-score search
            // dropdown still auto-dismisses since that mode is
            // typically a one-shot "type an ID, hit enter" flow.
            if (!hasAnyScoredAction) {
                setSearchOpen(false);
                setSearchQuery('');
            }
        } catch (e: unknown) {
            console.error('Simulation failed:', e);
            const err = e as { response?: { data?: { detail?: string } } };
            setError(apiErrorMessage(err, 'Simulation failed'));
        } finally {
            setSimulating(null);
        }
    };

    // Refresh combined estimations for all pairs that include the given action
    const refreshCombinedEstimations = async (actionId: string) => {
        console.log('[refreshCombinedEstimations] called for:', actionId,
            'combinedActions:', combinedActions ? Object.keys(combinedActions).length : null,
            'disconnectedElement:', disconnectedElement,
            'hasCallback:', !!onUpdateCombinedEstimation);
        if (!combinedActions || !disconnectedElement || disconnectedElement.length === 0 || !onUpdateCombinedEstimation) return;
        const relatedPairs = Object.entries(combinedActions).filter(([pairId]) => {
            const parts = pairId.split('+').map(p => p.trim());
            return parts.includes(actionId);
        });
        console.log('[refreshCombinedEstimations] found', relatedPairs.length, 'related pairs:',
            relatedPairs.map(([id]) => id));
        for (const [pairId] of relatedPairs) {
            const parts = pairId.split('+').map(p => p.trim());
            const [id1, id2] = parts;
            try {
                const result = await api.computeSuperposition(id1, id2, disconnectedElement);
                console.log('[refreshCombinedEstimations] superposition result for', pairId, ':', {
                    error: result.error,
                    estimated_max_rho: result.estimated_max_rho,
                    max_rho: result.max_rho,
                    max_rho_line: result.max_rho_line,
                });
                if (!result.error) {
                    const estRho = result.estimated_max_rho ?? result.max_rho;
                    const estLine = result.estimated_max_rho_line ?? result.max_rho_line;
                    console.log('[refreshCombinedEstimations] updating pair', pairId, 'with estRho:', estRho, 'estLine:', estLine);
                    onUpdateCombinedEstimation(pairId, { estimated_max_rho: estRho, estimated_max_rho_line: estLine });
                }
            } catch (e) {
                console.error(`Failed to refresh estimation for pair ${pairId}:`, e);
            }
        }
    };

    // Re-simulate an existing action with a new target MW value
    const handleResimulate = async (actionId: string, newTargetMw: number) => {
        if (!disconnectedElement || disconnectedElement.length === 0) return;
        // Log the user-edited target value so a replay agent can type
        // the exact same MW into the card's input before clicking
        // Re-simulate. Distinct from manual_action_simulated because
        // re-simulation keeps the action in its current bucket
        // (suggested vs. manually added).
        interactionLogger.record('action_mw_resimulated', {
            action_id: actionId,
            target_mw: newTargetMw,
        });
        setResimulating(actionId);
        try {
            const detail = actions[actionId];
            const actionContent = detail?.action_topology ? detail.action_topology as unknown as Record<string, unknown> : null;
            const result = canPrimeDiagram
                ? await streamSimulateAndPrimeDiagram(actionId, disconnectedElement, actionContent, linesOverloaded, newTargetMw, undefined)
                : await api.simulateManualAction(actionId, disconnectedElement, actionContent, linesOverloaded, newTargetMw);
            const newDetail: ActionDetail = {
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
                redispatch_details: result.redispatch_details,
                pst_details: result.pst_details,
            };
            onActionResimulated(actionId, newDetail, result.lines_overloaded || []);
            // Clear the edit input so it picks up the new shedded/curtailed MW from results
            setCardEditMw(prev => {
                if (!prev[actionId]) return prev;
                const next = { ...prev };
                delete next[actionId];
                return next;
            });
            // Refresh combined estimations for pairs containing this action
            refreshCombinedEstimations(actionId);
        } catch (e: unknown) {
            console.error('Re-simulation failed:', e);
        } finally {
            setResimulating(null);
        }
    };

    // Re-simulate an existing PST action with a new tap position
    const handleResimulateTap = async (actionId: string, newTap: number) => {
        if (!disconnectedElement || disconnectedElement.length === 0) return;
        // Log the new tap position so a replay agent can enter the
        // same value in the PST detail input before clicking
        // Re-simulate. Backend clamps out-of-range values to
        // [low_tap, high_tap], but the logged value is the raw
        // user-entered integer.
        interactionLogger.record('pst_tap_resimulated', {
            action_id: actionId,
            target_tap: newTap,
        });
        setResimulating(actionId);
        try {
            const detail = actions[actionId];
            const actionContent = detail?.action_topology ? detail.action_topology as unknown as Record<string, unknown> : null;
            const result = canPrimeDiagram
                ? await streamSimulateAndPrimeDiagram(actionId, disconnectedElement, actionContent, linesOverloaded, null, newTap)
                : await api.simulateManualAction(actionId, disconnectedElement, actionContent, linesOverloaded, null, newTap);
            const newDetail: ActionDetail = {
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
                redispatch_details: result.redispatch_details,
                pst_details: result.pst_details,
            };
            onActionResimulated(actionId, newDetail, result.lines_overloaded || []);
            // Clear the edit input so it picks up the new tap from results
            setCardEditTap(prev => {
                if (!prev[actionId]) return prev;
                const next = { ...prev };
                delete next[actionId];
                return next;
            });
            // Refresh combined estimations for pairs containing this action
            refreshCombinedEstimations(actionId);
        } catch (e: unknown) {
            console.error('PST re-simulation failed:', e);
        } finally {
            setResimulating(null);
        }
    };

    // actionId → recommender score-type bucket (`line_reconnection`,
    // `pst_tap_change`, …). The action-type filter feeds this `type`
    // into `classifyActionType` — the SAME signal the Combine-modal
    // Explore-Pairs filter uses (`ExplorePairsTab` passes `item.type`).
    // Without it, `classifyActionType` can't tell reco from disco for
    // ids like ``reco_GEN.PY762`` (its disco/reco heuristics look at
    // the score type + description, never the id), so the whole
    // reco / disco bucket would be filtered out of the feed.
    const scoreTypeByActionId = useMemo(() => {
        const m = new Map<string, string>();
        if (!actionScores) return m;
        for (const [type, data] of Object.entries(actionScores)) {
            const scores = data?.scores || {};
            for (const actionId of Object.keys(scores)) {
                if (!m.has(actionId)) m.set(actionId, type);
            }
        }
        return m;
    }, [actionScores]);

    // Sort actions by max_rho ascending (matching standalone)
    // Filter out combined actions that are only estimations (they will have '+' in ID but no rho_after yet)
    const sortedActionEntries = useMemo(() => {
        return Object.entries(actions)
            .filter(([id, details]) => {
                const isCombined = id.includes('+');
                if (isCombined) {
                    // Only show combined if it has been fully simulated (not just estimated)
                    // Simulated actions will NOT have the is_estimated flag set.
                    if (details.is_estimated) return false;
                    if (!details.rho_after || details.rho_after.length === 0) return false;
                }
                // Shared overview filter: hide cards whose severity or
                // max_rho falls outside the active category/threshold
                // picked from the overview header. We skip the filter
                // when overviewFilters is undefined so isolated tests
                // (which don't wire it) keep their existing behaviour.
                if (overviewFilters && !actionPassesOverviewFilter(
                    details, monitoringFactor,
                    overviewFilters.categories, overviewFilters.threshold,
                )) return false;
                // Shared action-type chip filter. Combined actions
                // (key contains '+') are considered in scope when
                // EITHER constituent matches — they're inherently
                // multi-type, so hiding them because only one side
                // matches would surprise the operator.
                // `actionType ?? 'all'` keeps legacy call sites that
                // don't yet set the field (older session reloads /
                // tests) behaving as "no type filter".
                const typeFilter = overviewFilters?.actionType ?? 'all';
                if (typeFilter !== 'all') {
                    if (id.includes('+')) {
                        const [id1, id2] = id.split('+');
                        const d1 = actions[id1];
                        const d2 = actions[id2];
                        const ok = (d1 && matchesActionTypeFilter(typeFilter, id1, d1.description_unitaire, scoreTypeByActionId.get(id1) ?? null))
                            || (d2 && matchesActionTypeFilter(typeFilter, id2, d2.description_unitaire, scoreTypeByActionId.get(id2) ?? null));
                        if (!ok) return false;
                    } else if (!matchesActionTypeFilter(
                        typeFilter, id, details.description_unitaire, scoreTypeByActionId.get(id) ?? null,
                    )) {
                        return false;
                    }
                }
                return true;
            })
            .sort(([, a], [, b]) => {
                // Sink load-flow faults (divergent / islanded) to the bottom of
                // the stack regardless of their reported max_rho. The backend
                // emits ``max_rho = 0`` (not ``null``) for non-convergent
                // simulations — sorting by max_rho alone would float those
                // cards to the top, ahead of legitimate solving actions.
                const aFault = !!(a.is_islanded || a.non_convergence);
                const bFault = !!(b.is_islanded || b.non_convergence);
                if (aFault !== bFault) return aFault ? 1 : -1;
                return (a.max_rho ?? 999) - (b.max_rho ?? 999);
            });
    }, [actions, overviewFilters, monitoringFactor, scoreTypeByActionId]);

    const analysisActionIds = useMemo(() => {
        const ids = new Set<string>();
        if (!actionScores) return ids;
        for (const data of Object.values(actionScores)) {
            const scores = data?.scores || {};
            for (const actionId of Object.keys(scores)) {
                ids.add(actionId);
            }
        }
        return ids;
    }, [actionScores]);

    const selectedEntries = useMemo(() => {
        return sortedActionEntries.filter(([id]) => selectedActionIds.has(id));
    }, [sortedActionEntries, selectedActionIds]);

    const prioritizedEntries = useMemo(() => {
        if (analysisLoading) return [];
        return sortedActionEntries.filter(([id]) => !selectedActionIds.has(id) && !rejectedActionIds.has(id));
    }, [sortedActionEntries, selectedActionIds, rejectedActionIds, analysisLoading]);

    // Inline contextual hint counter — "N actions hidden by the
    // overview filter" — surfaces when the user has tightened the
    // shared overview filters so action cards disappear from the feed.
    // Implements the second half of recommendation #4 in
    // `docs/proposals/ui-design-critique.md`: tier the warnings, drop
    // the redundant yellow banner stack, and add small grey contextual
    // hints under the relevant control. Only counts non-estimation,
    // non-combined-incomplete entries so the hint matches what the
    // operator would actually see if they cleared the filter.
    const overviewFilteredOutCount = useMemo(() => {
        if (!overviewFilters) return 0;
        const typeFilter = overviewFilters.actionType ?? 'all';
        let hidden = 0;
        for (const [id, details] of Object.entries(actions)) {
            if (id.includes('+')) {
                if (details.is_estimated) continue;
                if (!details.rho_after || details.rho_after.length === 0) continue;
            }
            const passesCategory = actionPassesOverviewFilter(
                details, monitoringFactor,
                overviewFilters.categories, overviewFilters.threshold,
            );
            let passesType = true;
            if (typeFilter !== 'all') {
                if (id.includes('+')) {
                    const [id1, id2] = id.split('+');
                    const d1 = actions[id1];
                    const d2 = actions[id2];
                    passesType = !!((d1 && matchesActionTypeFilter(typeFilter, id1, d1.description_unitaire, scoreTypeByActionId.get(id1) ?? null))
                        || (d2 && matchesActionTypeFilter(typeFilter, id2, d2.description_unitaire, scoreTypeByActionId.get(id2) ?? null)));
                } else {
                    passesType = matchesActionTypeFilter(typeFilter, id, details.description_unitaire, scoreTypeByActionId.get(id) ?? null);
                }
            }
            if (!passesCategory || !passesType) hidden += 1;
        }
        return hidden;
    }, [actions, overviewFilters, monitoringFactor, scoreTypeByActionId]);

    // When an action becomes the currently-viewed one (typically
    // after the user double-clicks a pin in the action overview
    // diagram, or clicks an action card body), scroll the
    // sidebar so the matching card is centred in the viewport.
    // Without this, double-clicking a pin can activate an action
    // that is many cards down the feed and the operator has to
    // hunt for it manually.
    //
    // Implementation note: we look up the card by its existing
    // `data-testid="action-card-${id}"` attribute and call
    // `scrollIntoView({ block: 'center' })`. The browser walks
    // up to the nearest scrollable ancestor (the sidebar's
    // overflow-y: auto wrapper in App.tsx) and scrolls that.
    //
    // Wrapped in a rAF so the scroll runs after the matching
    // card has had a chance to mount/move in response to the
    // selection change in the same render cycle.
    useEffect(() => {
        if (!selectedActionId) return;
        let cancelled = false;
        const rafId = requestAnimationFrame(() => {
            if (cancelled) return;
            const el = document.querySelector(
                `[data-testid="action-card-${CSS.escape(selectedActionId)}"]`,
            );
            if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
                (el as HTMLElement).scrollIntoView({
                    block: 'center',
                    inline: 'nearest',
                    behavior: 'smooth',
                });
            }
        });
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [selectedActionId]);

    // Scroll to a card when a pin on the action overview is
    // single-clicked (preview).  This is separate from the
    // selectedActionId scroll above because pin preview does NOT
    // select the action (no drill-down).  The `seq` counter in the
    // scrollTarget object ensures that clicking the same pin twice
    // still triggers a fresh scroll.
    useEffect(() => {
        if (!scrollTarget) return;
        let cancelled = false;
        const rafId = requestAnimationFrame(() => {
            if (cancelled) return;
            const el = document.querySelector(
                `[data-testid="action-card-${CSS.escape(scrollTarget.id)}"]`,
            );
            if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
                (el as HTMLElement).scrollIntoView({
                    block: 'center',
                    inline: 'nearest',
                    behavior: 'smooth',
                });
            }
        });
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [scrollTarget]);

    const rejectedEntries = useMemo(() => {
        return sortedActionEntries.filter(([id]) => rejectedActionIds.has(id));
    }, [sortedActionEntries, rejectedActionIds]);

    const activeAnalysisResult = useMemo(() => {
        if (pendingAnalysisResult) return pendingAnalysisResult;
        return {
            actions,
            combined_actions: combinedActions || {},
            lines_overloaded: linesOverloaded,
            action_scores: actionScores,
        } as AnalysisResult;
    }, [pendingAnalysisResult, actions, combinedActions, linesOverloaded, actionScores]);

    const renderActionList = (entries: [string, ActionDetail][]) => {
        return entries.map(([id, details], index) => {
            if (!details) return null;
            return (
                <ActionCard
                    key={id}
                    id={id}
                    details={details}
                    index={index}
                    isViewing={selectedActionId === id}
                    isSelected={selectedActionIds.has(id)}
                    isRejected={rejectedActionIds.has(id)}
                    linesOverloaded={linesOverloaded}
                    monitoringFactor={monitoringFactor}
                    nodesByEquipmentId={nodesByEquipmentId}
                    edgesByEquipmentId={edgesByEquipmentId}
                    cardEditMw={cardEditMw}
                    cardEditTap={cardEditTap}
                    resimulating={resimulating}
                    onActionSelect={onActionSelect}
                    onActionFavorite={onActionFavorite}
                    onActionReject={onActionReject}
                    onAssetClick={onAssetClick}
                    onVlDoubleClick={onVlDoubleClick}
                    onCardEditMwChange={(actionId, value) => setCardEditMw(prev => ({ ...prev, [actionId]: value }))}
                    onCardEditTapChange={(actionId, value) => setCardEditTap(prev => ({ ...prev, [actionId]: value }))}
                    onResimulate={handleResimulate}
                    onResimulateTap={handleResimulateTap}
                    displayName={displayName}
                    availableModels={availableModels}
                />
            );
        });
    };

    return (
        <div style={{ padding: '15px' }}>
            {/* Header with search */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', position: 'relative' }}>
                <h3 data-testid="action-feed-header" style={{ margin: 0, flex: 1 }}>Remedial Actions</h3>
                <button
                    onClick={handleOpenSearch}
                    style={{
                        background: searchOpen ? colors.brand : colors.surfaceMuted,
                        color: searchOpen ? colors.textOnBrand : colors.textPrimary,
                        border: 'none',
                        borderRadius: '6px',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: 600,
                        marginRight: '6px'
                    }}
                >
                    + Manual Selection
                </button>
                <button
                    onClick={() => setCombineModalOpen(true)}
                    style={{
                        background: combineModalOpen ? colors.brand : colors.surfaceMuted,
                        color: combineModalOpen ? colors.textOnBrand : colors.textPrimary,
                        border: 'none',
                        borderRadius: '6px',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: 600,
                    }}
                >
                    ++ Combine
                </button>

                {/* Search dropdown — when scored actions are available
                    (analysis has produced suggestions), expand to a wide
                    centered overlay that mirrors the Combine Actions
                    modal layout so the score table has room for its
                    Action ID, MW Start and Score columns. */}
                {searchOpen && (
                    <ActionSearchDropdown
                        dropdownRef={dropdownRef}
                        searchInputRef={searchInputRef}
                        searchQuery={searchQuery}
                        onSearchQueryChange={setSearchQuery}
                        filters={dropdownFilters}
                        onFiltersChange={setDropdownFilters}
                        error={error}
                        loadingActions={loadingActions}
                        scoredActionsList={scoredActionsList}
                        filteredActions={filteredActions}
                        actionScores={actionScores}
                        actions={actions}
                        cardEditMw={cardEditMw}
                        onCardEditMwChange={(actionId, value) => setCardEditMw(prev => ({ ...prev, [actionId]: value }))}
                        cardEditTap={cardEditTap}
                        onCardEditTapChange={(actionId, value) => setCardEditTap(prev => ({ ...prev, [actionId]: value }))}
                        simulating={simulating}
                        resimulating={resimulating}
                        onAddAction={handleAddAction}
                        onResimulate={handleResimulate}
                        onResimulateTap={handleResimulateTap}
                        monitoringFactor={monitoringFactor}
                        displayName={displayName}
                        onClose={() => { setSearchOpen(false); setSearchQuery(''); }}
                        onShowTooltip={showTooltip}
                        onHideTooltip={hideTooltip}
                        wide={hasAnyScoredAction}
                    />
                )}
            </div>
            {/* Action-dictionary info now lives in NoticesPanel
                (tier-warning-system PR — see `docs/proposals/ui-design-critique.md`
                recommendation #4). The inline yellow banner that
                stacked here was retired so the sidebar header carries
                a single dismissable pill instead of up to five
                concurrent banners. */}
            <div style={{ marginBottom: '15px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: colors.textPrimary, borderBottom: `1px solid ${colors.borderSubtle}`, paddingBottom: '4px', display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: '8px' }}>
                    Selected Actions
                    {selectedEntries.length > 0 && <span style={{ background: colors.surfaceMuted, color: colors.textSecondary, fontSize: '11px', padding: '2px 6px', borderRadius: '10px' }}>{selectedEntries.length}</span>}
                </h4>
                {selectedEntries.length > 0 ? (
                    <>
                        {!dismissedSelectedWarning && selectedEntries.some(([id]) => manuallyAddedIds.has(id) && analysisActionIds.has(id)) && (() => {
                            const overlapIds = selectedEntries.filter(([id]) => manuallyAddedIds.has(id) && analysisActionIds.has(id)).map(([id]) => id).join(', ');
                            return (
                                <div
                                    data-testid="selected-overlap-hint"
                                    style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                                        gap: '6px', marginBottom: '8px',
                                        fontSize: '11px', color: colors.textTertiary, fontStyle: 'italic',
                                    }}
                                >
                                    <div>Also recommended by the recent analysis: {overlapIds}</div>
                                    <button onClick={() => setDismissedSelectedWarning(true)} style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontSize: '14px', lineHeight: 1, color: colors.textTertiary }} title="Dismiss">&times;</button>
                                </div>
                            );
                        })()}
                        {renderActionList(selectedEntries)}
                    </>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '5px 0 15px 0' }}>
                        <p style={{ color: colors.textTertiary, fontStyle: 'italic', fontSize: '13px', margin: 0 }}>Select an action manually or from suggested ones.</p>
                        {/* "Make a first guess" is a pre-analysis shortcut.
                            Once the operator has launched "Analyze & Suggest"
                            (or the analysis has completed / is pending
                            display), we stop offering the shortcut so the
                            UI funnels the user through the Manual Selection
                            dropdown (which now carries the score table).
                            The button re-appears only after a full reset
                            (contingency change, study reload) — at which
                            point `actionScores` / `pendingAnalysisResult` /
                            `actions` are all cleared by `resetAllState`. */}
                        {!analysisLoading
                            && !pendingAnalysisResult
                            && (!actionScores || Object.keys(actionScores).length === 0)
                            && Object.keys(actions).length === 0 && (
                            <button
                                onClick={handleOpenSearch}
                                data-testid="make-first-guess-button"
                                style={{
                                    padding: '10px',
                                    backgroundColor: colors.surfaceMuted,
                                    border: `1px dashed ${colors.brand}`,
                                    color: colors.brand,
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    fontSize: '14px',
                                    transition: 'all 0.2s',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px',
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = colors.brandSoft; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = colors.surfaceMuted; }}
                            >
                                <span style={{ fontSize: '16px' }}>💡</span> Make a first guess
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div style={{ marginBottom: '15px' }}>
                {overviewFilteredOutCount > 0 && (
                    <div
                        data-testid="overview-filter-hint"
                        style={{
                            marginBottom: '6px',
                            fontSize: '11px',
                            color: colors.textTertiary,
                            fontStyle: 'italic',
                        }}
                    >
                        {overviewFilteredOutCount} action{overviewFilteredOutCount === 1 ? '' : 's'} hidden by the overview filter.
                    </div>
                )}
                <div style={{ display: 'flex', borderBottom: `1px solid ${colors.borderSubtle}`, marginBottom: '10px' }}>
                    <button
                        onClick={() => setSuggestedTab('prioritized')}
                        style={{ flex: 1, padding: '8px', cursor: 'pointer', border: 'none', background: 'none', borderBottom: suggestedTab === 'prioritized' ? `2px solid ${colors.brand}` : 'none', fontWeight: suggestedTab === 'prioritized' ? 'bold' : 'normal', color: suggestedTab === 'prioritized' ? colors.brand : colors.textTertiary, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}
                    >Suggested Actions {prioritizedEntries.length > 0 && <span style={{ background: suggestedTab === 'prioritized' ? colors.brandSoft : colors.surfaceMuted, color: suggestedTab === 'prioritized' ? colors.brand : colors.textSecondary, fontSize: '11px', padding: '2px 6px', borderRadius: '10px', fontWeight: 'bold' }}>{prioritizedEntries.length}</span>}</button>
                    <button
                        onClick={() => setSuggestedTab('rejected')}
                        style={{ flex: 1, padding: '8px', cursor: 'pointer', border: 'none', background: 'none', borderBottom: suggestedTab === 'rejected' ? `2px solid ${colors.danger}` : 'none', fontWeight: suggestedTab === 'rejected' ? 'bold' : 'normal', color: suggestedTab === 'rejected' ? colors.danger : colors.textTertiary, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}
                    >Rejected Actions {rejectedEntries.length > 0 && <span style={{ background: suggestedTab === 'rejected' ? colors.dangerSoft : colors.surfaceMuted, color: suggestedTab === 'rejected' ? colors.danger : colors.textSecondary, fontSize: '11px', padding: '2px 6px', borderRadius: '10px', fontWeight: 'bold' }}>{rejectedEntries.length}</span>}</button>
                </div>

                {suggestedTab === 'prioritized' && prioritizedEntries.length > 0 && activeModelLabel && (() => {
                    const fmt = (s: number) => s >= 10 ? `${s.toFixed(1)}s` : `${s.toFixed(2)}s`;
                    const hasPrediction = typeof actionPredictionTime === 'number';
                    const hasAssessment = typeof assessmentTime === 'number';
                    const hasOverflow = typeof overflowGraphTime === 'number';
                    const hasStep1 = typeof step1Time === 'number';
                    const hasEnrichment = typeof enrichmentTime === 'number';
                    const hasWallClock = typeof wallClockTime === 'number';
                    const backendSum = (hasStep1 ? step1Time! : 0)
                        + (hasOverflow ? overflowGraphTime! : 0)
                        + (hasPrediction ? actionPredictionTime! : 0)
                        + (hasAssessment ? assessmentTime! : 0)
                        + (hasEnrichment ? enrichmentTime! : 0);
                    // Prefer the wall-clock figure as the headline number —
                    // it matches what the operator perceives between
                    // pressing "Analyze & Suggest" and the "Display N
                    // prioritized actions" button appearing. The per-stage
                    // backend buckets explain how that wall-clock was
                    // spent; the residual is network / NDJSON overhead.
                    const total = hasWallClock ? wallClockTime! : backendSum;
                    const showBreakdown = hasPrediction || hasAssessment || hasOverflow
                        || hasStep1 || hasEnrichment || hasWallClock;
                    // Native <title> tooltip lists the per-stage breakdown
                    // so the operator can see where each chunk of the
                    // total came from on hover, without dedicating
                    // sidebar real-estate to a multi-column row.
                    const breakdownLines: string[] = [];
                    if (hasStep1) breakdownLines.push(`Step 1 (contingency simulation): ${fmt(step1Time!)}`);
                    if (hasOverflow) breakdownLines.push(`Overflow analysis: ${fmt(overflowGraphTime!)}`);
                    if (hasPrediction) breakdownLines.push(`Action prediction: ${fmt(actionPredictionTime!)}`);
                    if (hasAssessment) breakdownLines.push(`Action assessment: ${fmt(assessmentTime!)}`);
                    if (hasEnrichment) breakdownLines.push(`Enrichment / post-process: ${fmt(enrichmentTime!)}`);
                    if (hasWallClock) {
                        const residual = Math.max(0, wallClockTime! - backendSum);
                        breakdownLines.push(`Other (network / streaming): ${fmt(residual)}`);
                        breakdownLines.push(`──`);
                        breakdownLines.push(`Total (wall-clock, click → display): ${fmt(wallClockTime!)}`);
                    }
                    const breakdownTooltip = breakdownLines.length
                        ? `Execution time breakdown\n  ${breakdownLines.join('\n  ')}`
                        : '';
                    return (
                        <div
                            data-testid="active-model-reminder"
                            style={{
                                display: 'flex', flexDirection: 'column',
                                gap: '4px', marginBottom: '8px',
                                fontSize: '11px', color: colors.textTertiary, fontStyle: 'italic',
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                                <span>
                                    Suggestions produced by <strong style={{ fontStyle: 'normal', color: colors.textSecondary }}>{activeModelLabel}</strong>
                                    {showBreakdown && (
                                        <>
                                            {' '}in{' '}
                                            <span
                                                data-testid="execution-time-total"
                                                title={breakdownTooltip}
                                                style={{
                                                    fontStyle: 'normal', cursor: 'help',
                                                    fontVariantNumeric: 'tabular-nums',
                                                    color: colors.textSecondary, fontWeight: 600,
                                                    borderBottom: `1px dotted ${colors.borderStrong}`,
                                                }}
                                            >
                                                {fmt(total)}
                                                <span aria-hidden="true" style={{
                                                    marginLeft: '3px', fontWeight: 700,
                                                    color: colors.textTertiary, fontSize: '10px',
                                                }}>&#9432;</span>
                                            </span>
                                        </>
                                    )}
                                </span>
                                {onClearSuggested && (
                                    <button
                                        type="button"
                                        onClick={onClearSuggested}
                                        title="Clear un-touched suggestions (keeps starred / rejected / manually-added actions) so a new analysis can be launched, optionally with a different model."
                                        style={{
                                            padding: '3px 10px',
                                            background: colors.danger,
                                            color: colors.textOnBrand,
                                            border: 'none',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '11px',
                                            fontStyle: 'normal',
                                            fontWeight: 'bold',
                                            flexShrink: 0,
                                        }}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })()}

                {/* Unified analysis action slot: Analyze & Suggest → Analyzing… → Display N prioritized actions */}
                {/* Show the analysis trigger slot whenever the Suggested
                    feed is empty — not just when result.actions has no
                    recommender-produced entry. After "Clear", the
                    operator's kept rejected actions stay in
                    result.actions with is_manual=false; gating on
                    prioritizedEntries (which already excludes selected +
                    rejected) is what makes the Analyze & Suggest button
                    reappear post-Clear.

                    When the overview filter hides every otherwise-
                    eligible action, suppress the Analyze & Suggest
                    button and surface a "no actions match the filter"
                    notice instead — the operator should clear the
                    filter before re-running an analysis. */}
                {(analysisLoading || pendingAnalysisResult || (prioritizedEntries.length === 0 && overviewFilteredOutCount === 0)) && (
                    <div style={{ marginBottom: '10px' }}>
                        {analysisLoading ? (
                            <button disabled style={{
                                width: '100%', padding: '10px 16px',
                                background: colors.warningSoft, color: colors.warningText,
                                border: `1px solid ${colors.warningBorder}`, borderRadius: '8px',
                                cursor: 'not-allowed', fontSize: '14px', fontWeight: 700,
                                boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
                            }}>
                                ⚙️ Analyzing…
                            </button>
                        ) : pendingAnalysisResult ? (
                            <button
                                data-testid="display-prioritized-actions"
                                onClick={onDisplayPrioritizedActions}
                                style={{
                                    width: '100%', padding: '10px 16px',
                                    background: colors.success,
                                    color: colors.textOnBrand, border: 'none', borderRadius: '8px',
                                    cursor: 'pointer', fontSize: '14px', fontWeight: 700,
                                    boxShadow: '0 2px 8px rgba(39,174,96,0.3)', transition: 'transform 0.1s',
                                }}
                                onMouseEnter={(e) => (e.target as HTMLButtonElement).style.transform = 'scale(1.02)'}
                                onMouseLeave={(e) => (e.target as HTMLButtonElement).style.transform = 'scale(1)'}
                            >
                                📊 Display {Object.keys(pendingAnalysisResult.actions || {}).length} prioritized actions
                            </button>
                        ) : (
                            <>
                                {branches && additionalLinesToCut && onToggleAdditionalLineToCut && (
                                    <AdditionalLinesPicker
                                        branches={branches}
                                        n1Overloads={n1Overloads ?? []}
                                        additionalLinesToCut={additionalLinesToCut}
                                        onToggle={onToggleAdditionalLineToCut}
                                        displayName={displayName}
                                    />
                                )}
                                {recommenderModel != null && setRecommenderModel && (
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        marginBottom: '8px', fontSize: '12px',
                                        color: colors.textSecondary,
                                    }}>
                                        <label
                                            htmlFor="analyzeRecommenderModel"
                                            style={{ flexShrink: 0 }}
                                        >Model:</label>
                                        <select
                                            id="analyzeRecommenderModel"
                                            value={recommenderModel}
                                            onChange={e => {
                                                interactionLogger.record('recommender_model_changed', {
                                                    model: e.target.value, source: 'action_feed',
                                                });
                                                setRecommenderModel(e.target.value);
                                            }}
                                            style={{
                                                flex: 1, padding: '4px 6px',
                                                border: `1px solid ${colors.border}`,
                                                borderRadius: '4px',
                                                background: colors.surface,
                                                color: colors.textPrimary,
                                                fontSize: '12px',
                                            }}
                                        >
                                            {(!availableModels || availableModels.length === 0) && (
                                                <option value="expert">Expert system</option>
                                            )}
                                            {availableModels?.map(m => (
                                                <option key={m.name} value={m.name}>{m.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                <button
                                    data-testid="analyze-suggest"
                                    onClick={onRunAnalysis}
                                    disabled={!canRunAnalysis}
                                    style={{
                                        width: '100%', padding: '10px 16px',
                                        background: canRunAnalysis ? colors.success : colors.disabled,
                                        color: colors.textOnBrand, border: 'none', borderRadius: '8px',
                                        cursor: canRunAnalysis ? 'pointer' : 'not-allowed',
                                        fontSize: '14px', fontWeight: 700,
                                        boxShadow: canRunAnalysis ? '0 2px 8px rgba(39,174,96,0.3)' : 'none',
                                        transition: 'transform 0.1s',
                                    }}
                                    onMouseEnter={(e) => { if (canRunAnalysis) (e.target as HTMLButtonElement).style.transform = 'scale(1.02)'; }}
                                    onMouseLeave={(e) => (e.target as HTMLButtonElement).style.transform = 'scale(1)'}
                                >
                                    🔍 Analyze & Suggest
                                </button>
                            </>
                        )}
                    </div>
                )}

                {suggestedTab === 'prioritized' && (
                    prioritizedEntries.length > 0 ? renderActionList(prioritizedEntries) : (
                        !analysisLoading ? (
                            <div style={{ textAlign: 'center' }}>
                                <p
                                    data-testid={overviewFilteredOutCount > 0 && !pendingAnalysisResult ? 'no-actions-match-filter' : undefined}
                                    style={{ color: colors.textTertiary, fontStyle: 'italic', fontSize: '13px', margin: '5px 0' }}
                                >
                                    {overviewFilteredOutCount > 0 && !pendingAnalysisResult
                                        ? 'No actions match the active filter. Clear the filter to see suggestions.'
                                        : (!pendingAnalysisResult ? 'Click \u201cAnalyze & Suggest\u201d above to get action suggestions.' : 'No suggested actions available.')}
                                </p>
                                {/* Recommender thresholds banner moved into NoticesPanel
                                    (tier-warning-system PR — see `docs/proposals/ui-design-critique.md`
                                    recommendation #4). */}
                            </div>
                        ) : null
                    )
                )}
                {suggestedTab === 'rejected' && (
                    rejectedEntries.length > 0 ? (
                        <>
                            {!dismissedRejectedWarning && rejectedEntries.some(([id]) => analysisActionIds.has(id)) && (() => {
                                const overlapIds = rejectedEntries.filter(([id]) => analysisActionIds.has(id)).map(([id]) => id).join(', ');
                                return (
                                    <div
                                        data-testid="rejected-overlap-hint"
                                        style={{
                                            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                                            gap: '6px', marginBottom: '8px',
                                            fontSize: '11px', color: colors.textTertiary, fontStyle: 'italic',
                                        }}
                                    >
                                        <div>Recommended by the recent analysis: {overlapIds}</div>
                                        <button onClick={() => setDismissedRejectedWarning(true)} style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '0', fontSize: '14px', lineHeight: 1, color: colors.textTertiary }} title="Dismiss">&times;</button>
                                    </div>
                                );
                            })()}
                            {renderActionList(rejectedEntries)}
                        </>
                    ) : (
                        <p style={{ color: colors.textTertiary, fontStyle: 'italic', fontSize: '13px', margin: '5px 0', textAlign: 'center' }}>No rejected actions.</p>
                    )
                )}
            </div>

            {/* Fixed-position tooltip rendered outside any overflow context */}
            {tooltip && (
                <div style={{
                    position: 'fixed',
                    top: tooltip.y,
                    left: tooltip.x,
                    zIndex: 99999,
                    backgroundColor: colors.chrome,
                    color: colors.textOnBrand,
                    textAlign: 'left',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '10px',
                    fontWeight: 'normal',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    lineHeight: 1.4,
                    pointerEvents: 'none',
                    maxWidth: '90vw',
                }}>
                    {tooltip.content}
                </div>
            )}

            {/* Combined Actions Modal */}
            <CombinedActionsModal
                isOpen={combineModalOpen}
                onClose={() => setCombineModalOpen(false)}
                analysisResult={activeAnalysisResult}
                simulatedActions={actions}
                disconnectedElement={disconnectedElement}
                onSimulateCombined={onManualActionAdded}
                onSimulateSingleAction={onActionResimulated}
                monitoringFactor={monitoringFactor}
                linesOverloaded={linesOverloaded}
                displayName={displayName}
            />
        </div>
    );
};

export default React.memo(ActionFeed);
