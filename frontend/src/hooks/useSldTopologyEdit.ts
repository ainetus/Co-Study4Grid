// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { useState, useCallback, useMemo, useEffect } from 'react';
import { interactionLogger } from '../utils/interactionLogger';

export interface SwitchToggleEntry {
    switchId: string;
    baselineOpen: boolean;
    targetOpen: boolean;
}

export interface SldTopologyEditState {
    /**
     * Edit mode is opt-in: when off, the SLD acts as a read-only
     * visualisation (existing behaviour). Toggling it on enables click
     * handlers on switch DOM elements.
     */
    editMode: boolean;
    setEditMode: (next: boolean) => void;
    /**
     * Absolute target states keyed by ``equipmentId``: every entry
     * overrides the displayed baseline. Only switches whose
     * ``equipmentId`` is present in the SLD baseline are accepted —
     * see ``toggleSwitch``.
     */
    pendingStates: Record<string, boolean>;
    /**
     * Toggle a switch: if no override exists, flip the baseline value;
     * if an override exists, flip it again. When the resulting target
     * equals the baseline the override is removed (so it doesn't show
     * up in ``changedSwitches``).
     *
     * Silently ignored when ``editMode`` is off or the id is missing
     * from the baseline — the SLD overlay click handler relies on this
     * to filter taps on non-editable elements.
     */
    toggleSwitch: (equipmentId: string) => void;
    /**
     * Remove a single staged change (the maneuver-list × button) —
     * reverts the switch to its baseline state.
     */
    removeSwitch: (equipmentId: string) => void;
    /**
     * Remove several staged changes at once (the maneuver-list
     * "Remove selected" block action). Mirrors ExpertOp's
     * ``seq_delete_many``.
     */
    removeSwitches: (equipmentIds: string[]) => void;
    /**
     * Drop all pending toggles. Logged as ``sld_edit_reset``.
     */
    reset: () => void;
    /**
     * When set, the SLD highlights ONLY this switch (the maneuver-list
     * focus gesture). Null = highlight every staged change.
     */
    focusedSwitchId: string | null;
    setFocusedSwitch: (equipmentId: string | null) => void;
    /**
     * Subset of ``pendingStates`` that differ from the baseline. This
     * is what the backend receives as ``action_content.switches``.
     */
    changedSwitches: Record<string, boolean>;
    /**
     * Per-switch diff descriptors for the side-panel UI. Stable order
     * (insertion order of `pendingStates` keys) so re-renders don't
     * shuffle the list.
     */
    pendingChanges: SwitchToggleEntry[];
}

/**
 * Owns the pending switch overrides for the interactive SLD-edit
 * gesture. The baseline is the ``switch_states`` map the backend
 * stamped on the current SLD response (N-1 or post-action variant).
 *
 * The hook auto-resets pending overrides whenever the baseline
 * identity changes (new VL opened, tab switched, action variant
 * changed) — keeping stale toggles around would silently apply them
 * to a different network state.
 */
export function useSldTopologyEdit(
    baselineSwitchStates: Record<string, boolean> | undefined,
): SldTopologyEditState {
    const [editMode, setEditModeState] = useState(false);
    const [pendingStates, setPendingStates] = useState<Record<string, boolean>>({});
    const [focusedSwitchId, setFocusedSwitchId] = useState<string | null>(null);

    // Stable identity probe for the baseline — used to drop stale
    // overrides when the operator switches VL or SLD tab. We don't
    // hash deeply: the backend re-issues the entire map every fetch,
    // so the JS object identity already changes on every update.
    // Same pattern as useDiagramHighlights's reattach-prune effect —
    // a guarded reset that must run on baseline change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setPendingStates({}); setFocusedSwitchId(null); }, [baselineSwitchStates]);

    const setEditMode = useCallback((next: boolean) => {
        setEditModeState(prev => {
            if (prev === next) return prev;
            interactionLogger.record('sld_edit_mode_toggled', { enabled: next });
            return next;
        });
        if (!next) {
            setPendingStates({});
            setFocusedSwitchId(null);
        }
    }, []);

    const toggleSwitch = useCallback((equipmentId: string) => {
        if (!editMode) return;
        const baseline = baselineSwitchStates;
        if (!baseline || !(equipmentId in baseline)) return;
        const baselineOpen = baseline[equipmentId];
        setPendingStates(prev => {
            const next = { ...prev };
            const current = equipmentId in next ? next[equipmentId] : baselineOpen;
            const flipped = !current;
            if (flipped === baselineOpen) {
                delete next[equipmentId];
            } else {
                next[equipmentId] = flipped;
            }
            return next;
        });
        interactionLogger.record('sld_switch_toggled', { equipment_id: equipmentId });
    }, [editMode, baselineSwitchStates]);

    const removeSwitch = useCallback((equipmentId: string) => {
        setPendingStates(prev => {
            if (!(equipmentId in prev)) return prev;
            const next = { ...prev };
            delete next[equipmentId];
            return next;
        });
        setFocusedSwitchId(prev => (prev === equipmentId ? null : prev));
        interactionLogger.record('sld_maneuver_removed', { equipment_ids: [equipmentId] });
    }, []);

    const removeSwitches = useCallback((equipmentIds: string[]) => {
        if (equipmentIds.length === 0) return;
        const drop = new Set(equipmentIds);
        setPendingStates(prev => {
            const next: Record<string, boolean> = {};
            let changed = false;
            for (const [k, v] of Object.entries(prev)) {
                if (drop.has(k)) { changed = true; continue; }
                next[k] = v;
            }
            return changed ? next : prev;
        });
        setFocusedSwitchId(prev => (prev && drop.has(prev) ? null : prev));
        interactionLogger.record('sld_maneuver_removed', { equipment_ids: equipmentIds });
    }, []);

    const setFocusedSwitch = useCallback((equipmentId: string | null) => {
        setFocusedSwitchId(equipmentId);
    }, []);

    const reset = useCallback(() => {
        setFocusedSwitchId(null);
        setPendingStates(prev => {
            if (Object.keys(prev).length === 0) return prev;
            interactionLogger.record('sld_edit_reset');
            return {};
        });
    }, []);

    const changedSwitches = useMemo(() => {
        if (!baselineSwitchStates) return {};
        const diff: Record<string, boolean> = {};
        for (const [sid, target] of Object.entries(pendingStates)) {
            if (baselineSwitchStates[sid] !== target) {
                diff[sid] = target;
            }
        }
        return diff;
    }, [pendingStates, baselineSwitchStates]);

    const pendingChanges = useMemo<SwitchToggleEntry[]>(() => {
        if (!baselineSwitchStates) return [];
        return Object.entries(changedSwitches).map(([switchId, targetOpen]) => ({
            switchId,
            baselineOpen: baselineSwitchStates[switchId],
            targetOpen,
        }));
    }, [changedSwitches, baselineSwitchStates]);

    return {
        editMode,
        setEditMode,
        pendingStates,
        toggleSwitch,
        removeSwitch,
        removeSwitches,
        reset,
        focusedSwitchId,
        setFocusedSwitch,
        changedSwitches,
        pendingChanges,
    };
}
