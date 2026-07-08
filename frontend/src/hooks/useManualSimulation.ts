// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Manual-simulation orchestration extracted from App.tsx (D4, 2026-07).
// Owns the two operator-driven "simulate this action now" flows plus the
// interactive SLD-edit state they share:
//   - `handleSimulateUnsimulatedAction` — double-click an un-simulated
//     recommender pin on the Action Overview → stream a variant + card;
//   - the `useSldTopologyEdit` state, the implicit edit-mode sync, the
//     debounced target-topology preview, and `handleSimulateSldEdit` —
//     turn staged breaker toggles + injection retunes into one action.
//
// Both consume the shared `parseNdjsonStream` reader (D5) and route
// failures through the notification store via the injected `setError`.
// App keeps ownership of the collaborators (diagrams, the analysis
// result, the manual-action-added wrapper) and passes them in, so this
// stays a thin orchestrator rather than a second state hub.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../api';
import { parseNdjsonStream } from '../utils/ndjsonStream';
import { interactionLogger } from '../utils/interactionLogger';
import { apiErrorMessage } from '../utils/apiError';
import { useSldTopologyEdit, type SldTopologyEditState } from './useSldTopologyEdit';
import type { ActionDetail, AnalysisResult, DiagramData } from '../types';
import type { DiagramsState } from './useDiagrams';

export interface ManualSimulationParams {
    diagrams: DiagramsState;
    selectedContingency: string[];
    result: AnalysisResult | null;
    voltageLevels: string[];
    wrappedManualActionAdded: (
        actionId: string,
        detail: ActionDetail,
        linesOverloaded: string[],
        origin?: string,
    ) => void;
    /** Notification-store error adapter (raise / clear). */
    setError: (message: string) => void;
}

export interface ManualSimulationState {
    /** Interactive SLD-edit state (breaker toggles + injection retunes). */
    sldTopologyEdit: SldTopologyEditState;
    /** True while a staged SLD edit is being simulated. */
    sldEditBusy: boolean;
    /** Canonical id of the action the open SLD is a variant of (`null` on N/N-1). */
    sldEditBaseActionId: string | null;
    /** Debounced target-topology preview SVG (null when nothing is staged). */
    sldPreview: { svg: string; metadata: string | null } | null;
    sldPreviewLoading: boolean;
    /** Double-click an un-simulated overview pin → stream a variant + card. */
    handleSimulateUnsimulatedAction: (actionId: string) => Promise<void>;
    /** Simulate the staged SLD breaker/injection edit as one manual action. */
    handleSimulateSldEdit: () => Promise<void>;
}

export function useManualSimulation(params: ManualSimulationParams): ManualSimulationState {
    const { diagrams, selectedContingency, result, voltageLevels, wrappedManualActionAdded, setError } = params;

    const handleSimulateUnsimulatedAction = useCallback(
        async (actionId: string) => {
            if (selectedContingency.length === 0) {
                setError('Select a contingency first.');
                return;
            }
            try {
                const response = await api.simulateAndVariantDiagramStream({
                    action_id: actionId,
                    disconnected_elements: selectedContingency,
                    action_content: null,
                    lines_overloaded: result?.lines_overloaded ?? null,
                    target_mw: null,
                    target_tap: null,
                });
                let metrics: Awaited<ReturnType<typeof api.simulateManualAction>> | null = null;
                let streamErr: string | null = null;
                for await (const raw of parseNdjsonStream(response)) {
                    const event = raw as Record<string, unknown>;
                    if (event.type === 'metrics') {
                        const { type: _t, ...rest } = event;
                        void _t;
                        metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
                    } else if (event.type === 'diagram') {
                        const { type: _t, ...rest } = event;
                        void _t;
                        diagrams.primeActionDiagram(actionId, rest as unknown as DiagramData & { svg: string }, voltageLevels.length);
                    } else if (event.type === 'error') {
                        streamErr = (event.message as string) || 'stream error';
                    }
                }
                if (streamErr) throw new Error(streamErr);
                if (!metrics) throw new Error('Stream ended without metrics event');
                const detail: ActionDetail = {
                    description_unitaire: metrics.description_unitaire,
                    rho_before: metrics.rho_before,
                    rho_after: metrics.rho_after,
                    max_rho: metrics.max_rho,
                    max_rho_line: metrics.max_rho_line,
                    is_rho_reduction: metrics.is_rho_reduction,
                    is_islanded: metrics.is_islanded,
                    n_components: metrics.n_components,
                    disconnected_mw: metrics.disconnected_mw,
                    non_convergence: metrics.non_convergence,
                    lines_overloaded_after: metrics.lines_overloaded_after,
                    half_open_overloads: metrics.half_open_overloads,
                    action_topology: metrics.action_topology,
                    load_shedding_details: metrics.load_shedding_details,
                    curtailment_details: metrics.curtailment_details,
                    redispatch_details: metrics.redispatch_details,
                    pst_details: metrics.pst_details,
                };
                // An unsimulated pin is a scored-but-not-yet-materialised
                // action from the recommender's score table — the operator
                // only triggered its simulation, so its provenance is the
                // model that scored it, NOT "user".
                wrappedManualActionAdded(
                    actionId, detail, metrics.lines_overloaded || [], result?.active_model || 'expert',
                );
            } catch (e: unknown) {
                console.error('Unsimulated pin simulation failed:', e);
                setError(apiErrorMessage(e, 'Simulation failed'));
            }
        },
        [selectedContingency, result?.lines_overloaded, result?.active_model, diagrams, voltageLevels.length, wrappedManualActionAdded, setError],
    );

    // Interactive SLD topology edit (useSldTopologyEdit). The baseline is
    // the ``switch_states`` map the backend stamps on every SLD response;
    // the hook drops stale toggles when it changes (VL switch, tab switch,
    // action variant change).
    const sldTopologyEdit = useSldTopologyEdit(diagrams.vlOverlay?.switch_states, diagrams.vlOverlay?.injections);
    const [sldEditBusy, setSldEditBusy] = useState(false);
    // Edit mode is implicit: an open SLD on an editable tab (operable
    // switches or editable injections, never the N state) is always
    // editable, and closing the overlay returns it to read-only. There is
    // no user-facing toggle — the operator manipulates breakers / loads /
    // generators straight from the opened diagram.
    useEffect(() => {
        const ov = diagrams.vlOverlay;
        // Don't churn editMode during a re-fetch flash (a tab switch sets
        // `loading` true before the new switch_states / injections arrive).
        if (ov && ov.loading) return;
        const editable = !!ov && ov.tab !== 'n' && (
            (!!ov.switch_states && Object.keys(ov.switch_states).length > 0)
            || (!!ov.injections && Object.keys(ov.injections).length > 0)
        );
        if (editable && !sldTopologyEdit.editMode) sldTopologyEdit.setEditMode(true);
        else if (!editable && sldTopologyEdit.editMode) sldTopologyEdit.setEditMode(false);
        // `setEditMode` is a stable useCallback; `editMode` is read to avoid a
        // redundant set. Depending on the whole `sldTopologyEdit` object
        // (recreated each render) would only add churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [diagrams.vlOverlay, sldTopologyEdit.setEditMode, sldTopologyEdit.editMode]);
    const sldEditBaseActionId = useMemo(() => {
        const overlay = diagrams.vlOverlay;
        if (!overlay) return null;
        if (overlay.tab !== 'action') return null;
        return overlay.actionId && overlay.actionId.length > 0 ? overlay.actionId : null;
    }, [diagrams.vlOverlay]);

    // Target-topology preview: when the operator has staged switch toggles,
    // fetch a re-rendered SLD (target switch states + topological-colouring
    // connectivity, no load flow) and show it in place of the baseline.
    // Debounced so dragging through several toggles fires one request; a
    // sequence guard drops stale responses.
    const [sldPreview, setSldPreview] = useState<{ svg: string; metadata: string | null } | null>(null);
    const [sldPreviewLoading, setSldPreviewLoading] = useState(false);
    const sldPreviewSeqRef = useRef(0);
    const changedSwitchesKey = useMemo(
        () => JSON.stringify(sldTopologyEdit.changedSwitches),
        [sldTopologyEdit.changedSwitches],
    );
    useEffect(() => {
        const overlay = diagrams.vlOverlay;
        const switches = sldTopologyEdit.changedSwitches;
        const vlName = overlay?.vlName;
        if (!overlay || !sldTopologyEdit.editMode || !vlName || Object.keys(switches).length === 0) {
            setSldPreview(null);
            setSldPreviewLoading(false);
            return;
        }
        const seq = ++sldPreviewSeqRef.current;
        setSldPreviewLoading(true);
        const timer = setTimeout(async () => {
            try {
                const res = await api.getSldTopologyPreview({
                    voltageLevelId: vlName,
                    disconnectedElements: selectedContingency,
                    switches,
                    baseActionId: sldEditBaseActionId,
                });
                if (seq !== sldPreviewSeqRef.current) return;
                setSldPreview({ svg: res.svg, metadata: res.sld_metadata ?? null });
            } catch (e) {
                if (seq !== sldPreviewSeqRef.current) return;
                console.error('SLD topology preview failed:', e);
                setSldPreview(null);
                setError(apiErrorMessage(e, 'Topology preview failed'));
            } finally {
                if (seq === sldPreviewSeqRef.current) setSldPreviewLoading(false);
            }
        }, 280);
        return () => clearTimeout(timer);
        // changedSwitchesKey captures the switches dict by value; vlName +
        // editMode + baseAction are the other inputs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [changedSwitchesKey, sldTopologyEdit.editMode, diagrams.vlOverlay?.vlName, sldEditBaseActionId, selectedContingency]);

    const handleSimulateSldEdit = useCallback(async () => {
        const overlay = diagrams.vlOverlay;
        const switches = sldTopologyEdit.changedSwitches;
        const injections = sldTopologyEdit.changedInjections;
        const hasSwitches = Object.keys(switches).length > 0;
        const hasInjections = Object.keys(injections).length > 0;
        if (!overlay || (!hasSwitches && !hasInjections)) return;
        if (selectedContingency.length === 0) {
            setError('Select a contingency first.');
            return;
        }
        const vlName = overlay.vlName;
        const ts = Date.now();
        const userPart = `user_topo_${vlName}_${ts}`;
        const baseActionId = sldEditBaseActionId;
        const actionId = baseActionId ? `${baseActionId}+${userPart}` : userPart;
        // Split the staged injection retunes into the per-kind content keys the
        // backend expects (gens_p / loads_p → set_gen_p / set_load_p).
        const gensP: Record<string, number> = {};
        const loadsP: Record<string, number> = {};
        for (const ic of sldTopologyEdit.injectionChanges) {
            if (ic.kind === 'generator') gensP[ic.equipmentId] = ic.targetP;
            else loadsP[ic.equipmentId] = ic.targetP;
        }
        const actionContent: {
            switches?: Record<string, boolean>;
            gens_p?: Record<string, number>;
            loads_p?: Record<string, number>;
        } = {};
        if (hasSwitches) actionContent.switches = switches;
        if (Object.keys(gensP).length > 0) actionContent.gens_p = gensP;
        if (Object.keys(loadsP).length > 0) actionContent.loads_p = loadsP;
        interactionLogger.record('sld_topology_simulated', {
            voltage_level_id: vlName,
            switches,
            injections,
            combined_with: baseActionId,
        });
        setSldEditBusy(true);
        try {
            const response = await api.simulateAndVariantDiagramStream({
                action_id: actionId,
                disconnected_elements: selectedContingency,
                action_content: actionContent,
                lines_overloaded: result?.lines_overloaded ?? null,
                target_mw: null,
                target_tap: null,
                voltage_level_id: vlName,
            });
            let metrics: Awaited<ReturnType<typeof api.simulateManualAction>> | null = null;
            let streamErr: string | null = null;
            for await (const raw of parseNdjsonStream(response)) {
                const event = raw as Record<string, unknown>;
                if (event.type === 'metrics') {
                    const { type: _t, ...rest } = event;
                    void _t;
                    metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
                } else if (event.type === 'diagram') {
                    const { type: _t, ...rest } = event;
                    void _t;
                    // The backend canonicalises combined ids (sorts the "+"
                    // parts), so register the diagram under the id it actually
                    // stored — taken from the metrics event that always precedes
                    // the diagram event — not the raw request id.
                    const registeredId = metrics?.action_id ?? actionId;
                    diagrams.primeActionDiagram(registeredId, rest as unknown as DiagramData & { svg: string }, voltageLevels.length);
                } else if (event.type === 'error') {
                    streamErr = (event.message as string) || 'stream error';
                }
            }
            if (streamErr) throw new Error(streamErr);
            if (!metrics) throw new Error('Stream ended without metrics event');
            const m = metrics as Awaited<ReturnType<typeof api.simulateManualAction>>;
            // Backend-canonical id (sorted "+" parts) — use it for the card
            // and the action-tab focus so every later lookup matches.
            const registeredId = m.action_id || actionId;
            const detail: ActionDetail = {
                description_unitaire: m.description_unitaire,
                rho_before: m.rho_before,
                rho_after: m.rho_after,
                max_rho: m.max_rho,
                max_rho_line: m.max_rho_line,
                is_rho_reduction: m.is_rho_reduction,
                is_islanded: m.is_islanded,
                n_components: m.n_components,
                disconnected_mw: m.disconnected_mw,
                non_convergence: m.non_convergence,
                lines_overloaded_after: m.lines_overloaded_after,
                half_open_overloads: m.half_open_overloads,
                // Carry the topology so the SLD/NAD highlight marks EVERY affected
                // feeder of a combined manual action (e.g. a generator redispatch
                // AND a load shedding at the same VL get highlighted, not just one).
                action_topology: m.action_topology,
                load_shedding_details: m.load_shedding_details,
                curtailment_details: m.curtailment_details,
                redispatch_details: m.redispatch_details,
                pst_details: m.pst_details,
            };
            wrappedManualActionAdded(registeredId, detail, m.lines_overloaded || [], 'user');
            sldTopologyEdit.reset();
            sldTopologyEdit.setEditMode(false);
            // Switch the SLD overlay straight to the ACTION tab for the
            // freshly-computed action so the operator sees the post-action
            // state instead of staying on N-1.
            diagrams.handleVlDoubleClick(registeredId, vlName, 'action');
        } catch (e: unknown) {
            console.error('SLD topology edit simulation failed:', e);
            setError(apiErrorMessage(e, 'Simulation failed'));
        } finally {
            setSldEditBusy(false);
        }
    }, [
        diagrams, sldTopologyEdit, selectedContingency, sldEditBaseActionId,
        result?.lines_overloaded, voltageLevels.length, wrappedManualActionAdded,
        setError,
    ]);

    return {
        sldTopologyEdit,
        sldEditBusy,
        sldEditBaseActionId,
        sldPreview,
        sldPreviewLoading,
        handleSimulateUnsimulatedAction,
        handleSimulateSldEdit,
    };
}
