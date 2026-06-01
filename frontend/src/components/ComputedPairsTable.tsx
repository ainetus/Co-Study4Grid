// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { ActionDetail } from '../types';
import { colors } from '../styles/tokens';

interface SimulationFeedback {
    max_rho: number | null;
    max_rho_line: string;
    is_rho_reduction: boolean;
    is_islanded?: boolean;
    disconnected_mw?: number;
    non_convergence?: string | null;
}

export interface ComputedPairEntry {
    id: string;
    action1: string;
    action2: string;
    betas?: number[];
    estimated_max_rho?: number | null;
    estimated_max_rho_line?: string;
    target_max_rho?: number | null;
    target_max_rho_line?: string;
    is_suspect: boolean;
    isSimulated: boolean;
    simulated_max_rho: number | null;
    simulated_max_rho_line: string | null;
    simData: ActionDetail | SimulationFeedback | null;
}

interface ComputedPairsTableProps {
    computedPairsList: ComputedPairEntry[];
    monitoringFactor: number;
    simulating: boolean;
    onSimulate: (actionId: string) => void;
    displayName?: (id: string) => string;
}

const ComputedPairsTable: React.FC<ComputedPairsTableProps> = ({
    computedPairsList,
    monitoringFactor,
    simulating,
    onSimulate,
    displayName = (id: string) => id,
}) => {
    return (
        <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
            <table className="action-table">
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                        <th>Action 1</th>
                        <th>Action 2</th>
                        <th>Betas</th>
                        <th>Max Loading (Est.)</th>
                        <th>Line (Est.)</th>
                        <th>Simulated Max Rho</th>
                        <th>Simulated Line</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {computedPairsList.length === 0 ? (
                        <tr>
                            <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: colors.textTertiary, fontStyle: 'italic' }}>
                                No computed combinations found.<br />Go to <strong>Explore Pairs</strong> to create new ones.
                            </td>
                        </tr>
                    ) : computedPairsList.map(p => {
                        const estMaxRho = p.estimated_max_rho;
                        const isSimulated = p.isSimulated;
                        const simMaxRho = p.simulated_max_rho;

                        return (
                            <tr key={p.id}>
                                <td style={{ fontWeight: 'bold', fontSize: '12px' }}>{p.action1}</td>
                                <td style={{ fontWeight: 'bold', fontSize: '12px' }}>{p.action2}</td>
                                <td style={{ fontSize: '11px', fontFamily: 'monospace', color: colors.textTertiary }}>
                                    {p.betas ? p.betas.map(b => b.toFixed(2)).join(', ') : '-'}
                                </td>
                                <td>
                                    {estMaxRho != null && !isNaN(estMaxRho) ? (
                                        <span className="metric-badge metric-rho" style={{
                                            background: estMaxRho > monitoringFactor ? colors.dangerSoft : estMaxRho > (monitoringFactor - 0.05) ? colors.warningSoft : colors.successSoft,
                                            color: estMaxRho > monitoringFactor ? colors.dangerText : estMaxRho > (monitoringFactor - 0.05) ? colors.warningText : colors.successStrong,
                                            border: estMaxRho > monitoringFactor ? `1px solid ${colors.dangerText}` : estMaxRho > (monitoringFactor - 0.05) ? `1px solid ${colors.warningText}` : `1px dashed ${colors.successStrong}`
                                        }}>
                                            {(estMaxRho * 100).toFixed(1)}%
                                            {p.is_suspect && (
                                                <span style={{ marginLeft: '4px' }} title="Estimation suspect due to islanding">⚠️</span>
                                            )}
                                        </span>
                                    ) : '—'}
                                </td>
                                <td style={{ fontSize: '11px', color: colors.textTertiary, fontStyle: 'italic' }}>
                                    {p.estimated_max_rho_line ? displayName(p.estimated_max_rho_line) : 'N/A'}
                                    {p.target_max_rho != null && p.target_max_rho_line && p.target_max_rho_line !== 'N/A' && p.target_max_rho_line !== p.estimated_max_rho_line && (
                                        <div style={{ fontSize: '10px', color: colors.textTertiary, marginTop: '2px', fontStyle: 'normal' }} title="Max on the lines this pair was selected to resolve">
                                            target: {(p.target_max_rho * 100).toFixed(1)}% on {displayName(p.target_max_rho_line)}
                                        </div>
                                    )}
                                </td>

                                <td style={{ textAlign: 'center' }}>
                                    {isSimulated && simMaxRho != null ? (
                                        <span className="metric-badge metric-rho" style={{
                                            background: simMaxRho > monitoringFactor ? colors.dangerSoft : simMaxRho > (monitoringFactor - 0.05) ? colors.warningSoft : colors.successSoft,
                                            color: simMaxRho > monitoringFactor ? colors.dangerText : simMaxRho > (monitoringFactor - 0.05) ? colors.warningText : colors.successStrong
                                        }}>
                                            {(simMaxRho * 100).toFixed(1)}%
                                            {(p.simData as ActionDetail | SimulationFeedback)?.is_islanded && (
                                                <span style={{ fontSize: '10px', marginLeft: '4px' }} title="Islanding detected">🏝️</span>
                                            )}
                                        </span>
                                    ) : (
                                        <span style={{ color: colors.textTertiary, fontSize: '11px' }}>Not simulated</span>
                                    )}
                                </td>
                                <td style={{ fontSize: '11px', color: colors.textPrimary, fontWeight: isSimulated ? 'bold' : 'normal' }}>
                                    {isSimulated && p.simulated_max_rho_line ? displayName(p.simulated_max_rho_line) : '-'}
                                </td>

                                <td>
                                    <button
                                        onClick={() => onSimulate(p.id)}
                                        disabled={simulating}
                                        style={{
                                            padding: '6px 14px',
                                            background: isSimulated ? colors.brand : colors.success,
                                            color: colors.textOnBrand,
                                            border: 'none',
                                            borderRadius: '4px',
                                            cursor: simulating ? 'not-allowed' : 'pointer',
                                            fontSize: '11px',
                                            fontWeight: 'bold',
                                            opacity: simulating ? 0.6 : 1,
                                            minWidth: '100px'
                                        }}
                                    >
                                        {simulating ? '⌛' : (isSimulated ? 'Re-Simulate' : 'Simulate')}
                                    </button>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

export default ComputedPairsTable;
