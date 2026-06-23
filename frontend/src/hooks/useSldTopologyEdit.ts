// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { interactionLogger } from '../utils/interactionLogger';
import type { VlInjection } from '../types';

export interface SwitchToggleEntry {
    switchId: string;
    baselineOpen: boolean;
    targetOpen: boolean;
}

export interface InjectionChangeEntry {
    equipmentId: string;
    kind: 'generator' | 'load';
    /** Baseline active-power setpoint (MW); null when unknown. */
    baselineP: number | null;
    /** Staged target active-power setpoint (MW). */
    targetP: number;
    minP?: number | null;
    maxP?: number | null;
    energySource?: string;
}

// Two setpoints are "the same" below this tolerance (MW) — used so a
// retune that lands back on the baseline value drops the override.
const P_EPSILON = 1e-6;

export interface SldTopologyEditState {
    /**
     * Edit mode toggles the click handlers on switch / injection DOM
     * elements. It is opt-out (App auto-enables it when an editable SLD
     * opens) — turning it off returns the SLD to a read-only view.
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
     * Absolute target active-power setpoints (MW) keyed by
     * ``equipmentId`` (load / generator). Only equipment present in the
     * ``injections`` baseline is accepted — see ``setInjection``.
     */
    pendingInjections: Record<string, number>;
    /**
     * Stage an active-power retune for a load / generator. Silently
     * ignored when ``editMode`` is off or the id is missing from the
     * injection baseline. When the target equals the baseline setpoint
     * the override is dropped (so it doesn't show up in
     * ``changedInjections``).
     */
    setInjection: (equipmentId: string, targetP: number) => void;
    /** Remove a single staged injection retune (revert to baseline). */
    removeInjection: (equipmentId: string) => void;
    /**
     * Drop all pending toggles AND injection retunes. Logged as
     * ``sld_edit_reset``.
     */
    reset: () => void;
    /**
     * When set, the SLD highlights ONLY this equipment (the maneuver-list
     * focus gesture — works for both switches and injections). Null =
     * highlight every staged change.
     */
    focusedSwitchId: string | null;
    setFocusedSwitch: (equipmentId: string | null) => void;
    /**
     * Subset of ``pendingStates`` that differ from the baseline. This
     * is what the backend receives as ``action_content.switches``.
     */
    changedSwitches: Record<string, boolean>;
    /**
     * Subset of ``pendingInjections`` that differ from the baseline.
     * Split into ``gens_p`` / ``loads_p`` by App before being sent as
     * ``action_content``.
     */
    changedInjections: Record<string, number>;
    /**
     * Per-switch diff descriptors for the side-panel UI. Stable order
     * (insertion order of `pendingStates` keys) so re-renders don't
     * shuffle the list.
     */
    pendingChanges: SwitchToggleEntry[];
    /** Per-injection diff descriptors for the side-panel UI. */
    injectionChanges: InjectionChangeEntry[];
    /** True when at least one switch OR injection change is staged. */
    hasPendingChanges: boolean;
}

/**
 * Owns the pending switch overrides AND injection (active-power) retunes
 * for the interactive SLD-edit gesture. The baselines are the
 * ``switch_states`` / ``injections`` maps the backend stamped on the
 * current SLD response (N-1 or post-action variant).
 *
 * The hook auto-resets pending edits whenever the baseline identity
 * changes (new VL opened, tab switched, action variant changed) —
 * keeping stale edits around would silently apply them to a different
 * network state.
 */
export function useSldTopologyEdit(
    baselineSwitchStates: Record<string, boolean> | undefined,
    baselineInjections?: Record<string, VlInjection> | undefined,
): SldTopologyEditState {
    const [editMode, setEditModeState] = useState(false);
    const [pendingStates, setPendingStates] = useState<Record<string, boolean>>({});
    const [pendingInjections, setPendingInjections] = useState<Record<string, number>>({});
    const [focusedSwitchId, setFocusedSwitchId] = useState<string | null>(null);

    // Mirror of "is anything staged right now", kept in sync with the
    // committed state so ``reset()`` can decide whether to log
    // ``sld_edit_reset`` synchronously (state updaters run after the
    // current call, so a flag set inside them would read stale).
    const hasPendingRef = useRef(false);
    useEffect(() => {
        hasPendingRef.current =
            Object.keys(pendingStates).length > 0 || Object.keys(pendingInjections).length > 0;
    }, [pendingStates, pendingInjections]);

    // Stable identity probe for the baselines — used to drop stale edits
    // when the operator switches VL or SLD tab. We don't hash deeply: the
    // backend re-issues the entire maps every fetch, so the JS object
    // identity already changes on every update. Same pattern as
    // useDiagramHighlights's reattach-prune effect.
    //
    // CRITICAL: the setter callbacks no-op when there's nothing to clear.
    // Without the bail-out, a caller passing a fresh object literal on
    // every render (which renderHook does naturally in tests, and any
    // non-memoised parent could do in production) would trigger an
    // infinite render loop. The bail-out keeps React's reconciliation
    // short-circuit working (Object.is on prev/next → no re-render).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPendingStates(prev => (Object.keys(prev).length === 0 ? prev : {}));
        setPendingInjections(prev => (Object.keys(prev).length === 0 ? prev : {}));
        setFocusedSwitchId(prev => (prev === null ? prev : null));
    }, [baselineSwitchStates, baselineInjections]);

    const setEditMode = useCallback((next: boolean) => {
        setEditModeState(prev => {
            if (prev === next) return prev;
            interactionLogger.record('sld_edit_mode_toggled', { enabled: next });
            return next;
        });
        if (!next) {
            setPendingStates({});
            setPendingInjections({});
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

    const setInjection = useCallback((equipmentId: string, targetP: number) => {
        if (!editMode) return;
        const baseline = baselineInjections;
        if (!baseline || !(equipmentId in baseline)) return;
        if (!Number.isFinite(targetP)) return;
        const baselineP = baseline[equipmentId].p;
        setPendingInjections(prev => {
            const next = { ...prev };
            // A retune back onto the baseline setpoint clears the override.
            if (baselineP != null && Math.abs(targetP - baselineP) < P_EPSILON) {
                delete next[equipmentId];
            } else {
                next[equipmentId] = targetP;
            }
            return next;
        });
        interactionLogger.record('sld_injection_staged', {
            equipment_id: equipmentId,
            kind: baseline[equipmentId].kind,
            target_mw: targetP,
        });
    }, [editMode, baselineInjections]);

    const removeInjection = useCallback((equipmentId: string) => {
        setPendingInjections(prev => {
            if (!(equipmentId in prev)) return prev;
            const next = { ...prev };
            delete next[equipmentId];
            return next;
        });
        setFocusedSwitchId(prev => (prev === equipmentId ? null : prev));
        interactionLogger.record('sld_injection_removed', { equipment_id: equipmentId });
    }, []);

    const setFocusedSwitch = useCallback((equipmentId: string | null) => {
        setFocusedSwitchId(equipmentId);
    }, []);

    const reset = useCallback(() => {
        setFocusedSwitchId(null);
        setPendingStates(prev => (Object.keys(prev).length === 0 ? prev : {}));
        setPendingInjections(prev => (Object.keys(prev).length === 0 ? prev : {}));
        if (hasPendingRef.current) {
            interactionLogger.record('sld_edit_reset');
            hasPendingRef.current = false;
        }
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

    const changedInjections = useMemo(() => {
        if (!baselineInjections) return {};
        const diff: Record<string, number> = {};
        for (const [eid, target] of Object.entries(pendingInjections)) {
            const baselineP = baselineInjections[eid]?.p;
            if (baselineP == null || Math.abs(target - baselineP) >= P_EPSILON) {
                diff[eid] = target;
            }
        }
        return diff;
    }, [pendingInjections, baselineInjections]);

    const pendingChanges = useMemo<SwitchToggleEntry[]>(() => {
        if (!baselineSwitchStates) return [];
        return Object.entries(changedSwitches).map(([switchId, targetOpen]) => ({
            switchId,
            baselineOpen: baselineSwitchStates[switchId],
            targetOpen,
        }));
    }, [changedSwitches, baselineSwitchStates]);

    const injectionChanges = useMemo<InjectionChangeEntry[]>(() => {
        if (!baselineInjections) return [];
        return Object.entries(changedInjections).map(([equipmentId, targetP]) => {
            const base = baselineInjections[equipmentId];
            return {
                equipmentId,
                kind: base.kind,
                baselineP: base.p,
                targetP,
                minP: base.min_p,
                maxP: base.max_p,
                energySource: base.energy_source,
            };
        });
    }, [changedInjections, baselineInjections]);

    const hasPendingChanges = pendingChanges.length > 0 || injectionChanges.length > 0;

    return {
        editMode,
        setEditMode,
        pendingStates,
        toggleSwitch,
        removeSwitch,
        removeSwitches,
        pendingInjections,
        setInjection,
        removeInjection,
        reset,
        focusedSwitchId,
        setFocusedSwitch,
        changedSwitches,
        changedInjections,
        pendingChanges,
        injectionChanges,
        hasPendingChanges,
    };
}
