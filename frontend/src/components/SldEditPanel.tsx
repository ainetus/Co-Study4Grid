// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import React, { useState, useMemo } from 'react';
import { colors, space, text, radius } from '../styles/tokens';
import { interactionLogger } from '../utils/interactionLogger';
import type { SwitchToggleEntry, InjectionChangeEntry } from '../hooks/useSldTopologyEdit';

export interface SldEditPanelProps {
    pendingChanges: SwitchToggleEntry[];
    /** Staged active-power retunes (loads / generators) — listed below the
     *  switch toggles, removable individually. */
    injectionChanges?: InjectionChangeEntry[];
    onInjectionRemove?: (equipmentId: string) => void;
    onReset: () => void;
    onSimulate: () => void;
    onClose: () => void;
    /**
     * When true the Simulate button is busy / disabled. Driven by the
     * `simulateAndVariantDiagramStream` lifecycle in App.tsx.
     */
    busy?: boolean;
    /**
     * If non-null, the simulation will be combined with this action
     * (the SLD was opened from a recommended action's variant). The
     * panel surfaces this explicitly so the operator knows the
     * resulting card will appear as a combined action.
     */
    combinedWithActionId?: string | null;
    /**
     * Maneuver-list interactions (mirrors ExpertOp's manoeuvre IHM):
     * click a row to focus a single switch, × to remove one maneuver,
     * checkbox-select + "Remove selected" to drop a block.
     */
    focusedSwitchId?: string | null;
    onFocus?: (equipmentId: string | null) => void;
    onRemove?: (equipmentId: string) => void;
    onRemoveMany?: (equipmentIds: string[]) => void;
}

const SldEditPanel: React.FC<SldEditPanelProps> = ({
    pendingChanges, injectionChanges = [], onInjectionRemove,
    onReset, onSimulate, onClose, busy = false, combinedWithActionId = null,
    focusedSwitchId = null, onFocus, onRemove, onRemoveMany,
}) => {
    const hasSwitchChanges = pendingChanges.length > 0;
    const hasInjectionChanges = injectionChanges.length > 0;
    const hasChanges = hasSwitchChanges || hasInjectionChanges;
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // Intersect with the live change set so a selection left over from a
    // removed maneuver is ignored (no pruning effect needed — stale ids
    // simply never render and are filtered here before use).
    const validSelected = useMemo(() => {
        const present = new Set(pendingChanges.map(c => c.switchId));
        return [...selected].filter(id => present.has(id));
    }, [selected, pendingChanges]);

    const toggleSelected = (switchId: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(switchId)) next.delete(switchId); else next.add(switchId);
            return next;
        });
    };

    const handleFocus = (switchId: string) => {
        const nextFocus = focusedSwitchId === switchId ? null : switchId;
        onFocus?.(nextFocus);
        if (nextFocus) interactionLogger.record('sld_maneuver_focused', { equipment_id: nextFocus });
    };

    const handleRemoveSelected = () => {
        if (validSelected.length === 0) return;
        onRemoveMany?.(validSelected);
        setSelected(new Set());
    };

    return (
        <div
            data-testid="sld-edit-panel"
            style={{
                display: 'flex', flexDirection: 'column',
                gap: space[1],
                padding: space[2],
                borderTop: `1px solid ${colors.border}`,
                background: colors.surfaceMuted,
                maxHeight: '45%', minHeight: 0, overflowY: 'auto', flexShrink: 0,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[1] }}>
                <span style={{ fontSize: text.sm, fontWeight: 600, color: colors.textPrimary }}>
                    Edit topology
                    {combinedWithActionId
                        ? <span style={{ marginLeft: space[1], fontSize: text.xs, color: colors.brandStrong, fontWeight: 500 }}>
                            (combined with {combinedWithActionId})
                        </span>
                        : null}
                </span>
                <button
                    data-testid="sld-edit-close"
                    onClick={onClose}
                    title="Exit edit mode"
                    style={{
                        border: 'none', background: 'transparent', color: colors.textTertiary,
                        cursor: 'pointer', fontSize: text.sm, padding: 0,
                    }}
                >✕</button>
            </div>

            {!hasChanges && (
                <span style={{ fontSize: text.xs, color: colors.textTertiary }}>
                    Click a breaker / disconnector to switch it, or a load / generator to retune its active power.
                </span>
            )}

            {hasSwitchChanges && (
                <ul style={{
                    listStyle: 'none', padding: 0, margin: 0,
                    display: 'flex', flexDirection: 'column', gap: space.half,
                    fontSize: text.xs,
                }}>
                    {pendingChanges.map(({ switchId, baselineOpen, targetOpen }) => {
                        const isFocused = focusedSwitchId === switchId;
                        return (
                            <li
                                key={switchId}
                                data-testid={`sld-edit-change-${switchId}`}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: space[1],
                                    padding: `${space.half} ${space[1]}`,
                                    borderRadius: radius.sm,
                                    background: isFocused ? colors.brandSoft : 'transparent',
                                    border: `1px solid ${isFocused ? colors.brandMid : 'transparent'}`,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    data-testid={`sld-edit-select-${switchId}`}
                                    checked={selected.has(switchId)}
                                    onChange={() => toggleSelected(switchId)}
                                    title="Select for block removal"
                                    style={{ cursor: 'pointer', flexShrink: 0 }}
                                />
                                <button
                                    data-testid={`sld-edit-focus-${switchId}`}
                                    onClick={() => handleFocus(switchId)}
                                    title="Highlight only this switch"
                                    style={{
                                        flex: 1, textAlign: 'left', cursor: 'pointer',
                                        background: 'transparent', border: 'none', padding: 0,
                                        color: colors.textSecondary, fontFamily: 'monospace', fontSize: text.xs,
                                    }}
                                >
                                    <strong style={{ color: colors.textPrimary }}>{switchId}</strong>
                                    {': '}{baselineOpen ? 'ouvert' : 'fermé'} → {targetOpen ? 'ouvert' : 'fermé'}
                                </button>
                                <button
                                    data-testid={`sld-edit-remove-${switchId}`}
                                    onClick={() => onRemove?.(switchId)}
                                    title="Remove this maneuver"
                                    style={{
                                        border: 'none', background: 'transparent', color: colors.danger,
                                        cursor: 'pointer', fontSize: text.sm, padding: `0 ${space.half}`, flexShrink: 0,
                                    }}
                                >✕</button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {hasInjectionChanges && (
                <ul
                    data-testid="sld-edit-injection-list"
                    style={{
                        listStyle: 'none', padding: 0, margin: 0,
                        display: 'flex', flexDirection: 'column', gap: space.half,
                        fontSize: text.xs,
                    }}
                >
                    {injectionChanges.map(({ equipmentId, kind, baselineP, targetP }) => {
                        const isFocused = focusedSwitchId === equipmentId;
                        const baseStr = baselineP != null ? baselineP.toFixed(1) : '—';
                        return (
                            <li
                                key={equipmentId}
                                data-testid={`sld-edit-injection-${equipmentId}`}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: space[1],
                                    padding: `${space.half} ${space[1]}`,
                                    borderRadius: radius.sm,
                                    background: isFocused ? colors.brandSoft : 'transparent',
                                    border: `1px solid ${isFocused ? colors.brandMid : 'transparent'}`,
                                }}
                            >
                                <span
                                    title={kind === 'generator' ? 'générateur' : 'charge'}
                                    style={{ flexShrink: 0, fontSize: text.xs }}
                                >{kind === 'generator' ? '⚡' : '⌂'}</span>
                                <button
                                    data-testid={`sld-edit-injection-focus-${equipmentId}`}
                                    onClick={() => handleFocus(equipmentId)}
                                    title="Highlight only this element"
                                    style={{
                                        flex: 1, textAlign: 'left', cursor: 'pointer',
                                        background: 'transparent', border: 'none', padding: 0,
                                        color: colors.textSecondary, fontFamily: 'monospace', fontSize: text.xs,
                                    }}
                                >
                                    <strong style={{ color: colors.textPrimary }}>{equipmentId}</strong>
                                    {': '}{baseStr} → {targetP.toFixed(1)} MW
                                </button>
                                <button
                                    data-testid={`sld-edit-injection-remove-${equipmentId}`}
                                    onClick={() => onInjectionRemove?.(equipmentId)}
                                    title="Remove this retune"
                                    style={{
                                        border: 'none', background: 'transparent', color: colors.danger,
                                        cursor: 'pointer', fontSize: text.sm, padding: `0 ${space.half}`, flexShrink: 0,
                                    }}
                                >✕</button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div style={{ display: 'flex', gap: space[1], justifyContent: 'flex-end', marginTop: space[1], flexWrap: 'wrap' }}>
                {validSelected.length > 0 && (
                    <button
                        data-testid="sld-edit-remove-selected"
                        onClick={handleRemoveSelected}
                        disabled={busy}
                        style={{
                            padding: `${space.half} ${space[2]}`, fontSize: text.xs,
                            background: colors.surface, color: colors.danger,
                            border: `1px solid ${colors.danger}`, borderRadius: radius.sm,
                            cursor: busy ? 'not-allowed' : 'pointer',
                        }}
                    >Remove selected ({validSelected.length})</button>
                )}
                <button
                    data-testid="sld-edit-reset"
                    onClick={onReset}
                    disabled={!hasChanges || busy}
                    style={{
                        padding: `${space.half} ${space[2]}`, fontSize: text.xs,
                        background: colors.surface, color: colors.textPrimary,
                        border: `1px solid ${colors.border}`, borderRadius: radius.sm,
                        cursor: (!hasChanges || busy) ? 'not-allowed' : 'pointer',
                        opacity: (!hasChanges || busy) ? 0.6 : 1,
                    }}
                >Reset</button>
                <button
                    data-testid="sld-edit-simulate"
                    onClick={onSimulate}
                    disabled={!hasChanges || busy}
                    style={{
                        padding: `${space.half} ${space[2]}`, fontSize: text.xs, fontWeight: 600,
                        background: (!hasChanges || busy) ? colors.disabled : colors.brand,
                        color: colors.textOnBrand,
                        border: 'none', borderRadius: radius.sm,
                        cursor: (!hasChanges || busy) ? 'not-allowed' : 'pointer',
                    }}
                >{busy ? 'Simulating…' : 'Simulate action'}</button>
            </div>
        </div>
    );
};

export default SldEditPanel;
