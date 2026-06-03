// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import React from 'react';
import { colors, space, text, radius } from '../styles/tokens';
import type { SwitchToggleEntry } from '../hooks/useSldTopologyEdit';

export interface SldEditPanelProps {
    pendingChanges: SwitchToggleEntry[];
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
}

const SldEditPanel: React.FC<SldEditPanelProps> = ({
    pendingChanges, onReset, onSimulate, onClose, busy = false, combinedWithActionId = null,
}) => {
    const hasChanges = pendingChanges.length > 0;
    return (
        <div
            data-testid="sld-edit-panel"
            style={{
                display: 'flex', flexDirection: 'column',
                gap: space[1],
                padding: space[2],
                borderTop: `1px solid ${colors.border}`,
                background: colors.surfaceMuted,
                maxHeight: '40%', minHeight: 0, overflowY: 'auto', flexShrink: 0,
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

            {hasChanges ? (
                <ul style={{
                    listStyle: 'none', padding: 0, margin: 0,
                    display: 'flex', flexDirection: 'column', gap: space.half,
                    fontSize: text.xs, color: colors.textSecondary,
                }}>
                    {pendingChanges.map(({ switchId, baselineOpen, targetOpen }) => (
                        <li key={switchId} data-testid={`sld-edit-change-${switchId}`} style={{ fontFamily: 'monospace' }}>
                            <strong style={{ color: colors.textPrimary }}>{switchId}</strong>
                            : {baselineOpen ? 'ouvert' : 'fermé'} → {targetOpen ? 'ouvert' : 'fermé'}
                        </li>
                    ))}
                </ul>
            ) : (
                <span style={{ fontSize: text.xs, color: colors.textTertiary }}>
                    Click any switch in the diagram to stage a change.
                </span>
            )}

            <div style={{ display: 'flex', gap: space[1], justifyContent: 'flex-end', marginTop: space[1] }}>
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
