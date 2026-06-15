// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { CombinedAction, AnalysisResult } from '../types';
import { colors } from '../styles/tokens';

interface SimulationFeedback {
    max_rho: number | null;
    max_rho_line: string;
    is_rho_reduction: boolean;
    is_islanded?: boolean;
    disconnected_mw?: number;
    non_convergence?: string | null;
}

export interface ScoredActionEntry {
    actionId: string;
    score: number;
    type: string;
    mwStart: number | null;
}

interface ExplorePairsTabProps {
    scoredActionsList: ScoredActionEntry[];
    selectedIds: Set<string>;
    onToggle: (id: string) => void;
    onClearSelection: () => void;
    preview: CombinedAction | null;
    simulationFeedback: SimulationFeedback | null;
    sessionSimResults: Record<string, SimulationFeedback>;
    analysisResult: AnalysisResult | null;
    loading: boolean;
    error: string | null;
    simulating: boolean;
    hasRestricted: boolean;
    monitoringFactor: number;
    onEstimate: () => void;
    onSimulate: () => void;
    onSimulateSingle: (actionId: string) => void;
    displayName?: (id: string) => string;
}

const ExplorePairsTab: React.FC<ExplorePairsTabProps> = ({
    scoredActionsList,
    selectedIds,
    onToggle,
    onClearSelection,
    preview,
    simulationFeedback,
    sessionSimResults,
    analysisResult,
    loading,
    error,
    simulating,
    hasRestricted,
    monitoringFactor,
    onEstimate,
    onSimulate,
    onSimulateSingle,
    displayName = (id: string) => id,
}) => {
    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Selection Chips Header */}
            <div style={{ background: colors.surfaceMuted, padding: '10px 15px', borderRadius: '6px', marginBottom: '15px', border: `1px solid ${colors.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: colors.textSecondary }}>Selected Actions ({selectedIds.size}/2)</div>
                    <button
                        onClick={onClearSelection}
                        disabled={selectedIds.size === 0}
                        style={{ background: 'none', border: 'none', color: colors.brand, fontSize: '11px', cursor: 'pointer', padding: 0 }}
                    >Clear All</button>
                </div>
                <div style={{ display: 'flex', gap: '8px', minHeight: '30px', flexWrap: 'wrap' }} data-testid="selection-chips">
                    {selectedIds.size === 0 ? (
                        <div style={{ color: colors.textTertiary, fontSize: '12px', fontStyle: 'italic', display: 'flex', alignItems: 'center' }}>Click rows in the table below to select...</div>
                    ) : (
                        Array.from(selectedIds).map(id => (
                            <div key={id} data-testid={`chip-${id}`} style={{ background: colors.brandSoft, color: colors.brand, padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', border: `1px solid ${colors.brand}`, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {id}
                                <span onClick={(e) => { e.stopPropagation(); onToggle(id); }} style={{ cursor: 'pointer', fontSize: '14px', lineHeight: '10px' }}>&times;</span>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Grouped Table — the row set is already filtered by the
                shared ActionFilterRings in the modal header. */}
            <div style={{ flex: 1, maxHeight: '350px', overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: '4px', marginBottom: '15px' }}>
                {(() => {
                    const filteredList = scoredActionsList;

                    const types = Array.from(new Set(filteredList.map(item => item.type)));

                    if (filteredList.length === 0) {
                        return (
                            <div style={{ textAlign: 'center', color: colors.textTertiary, fontStyle: 'italic', padding: '40px 20px' }}>
                                No scored actions available for this filter.
                            </div>
                        );
                    }

                    return types.map(type => (
                        <div key={type} style={{ marginBottom: '1px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: colors.textSecondary, backgroundColor: colors.surfaceMuted, padding: '4px 10px', borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between' }}>
                                <span>{type.replace(/_/g, ' ').toUpperCase()}</span>
                                <span>{filteredList.filter(item => item.type === type).length} actions</span>
                            </div>
                            <table className="action-table" style={{ margin: 0, border: 'none' }}>
                                <tbody>
                                    {filteredList
                                        .filter(item => item.type === type)
                                        .map(({ actionId, score, mwStart }) => {
                                            const isSelected = selectedIds.has(actionId);
                                            const simResult = sessionSimResults[actionId] || (analysisResult?.actions?.[actionId]?.rho_after ? analysisResult.actions[actionId] : null);

                                            return (
                                                <tr
                                                    key={actionId}
                                                    className={isSelected ? 'selected' : ''}
                                                    onClick={() => onToggle(actionId)}
                                                    style={{ cursor: 'pointer', background: isSelected ? colors.warningSoft : colors.surfaceRaised }}
                                                >
                                                    <td style={{ width: '30px', padding: '8px 0 8px 12px' }}>
                                                        <input type="checkbox" checked={isSelected} readOnly style={{ cursor: 'pointer' }} />
                                                    </td>
                                                    <td style={{ fontWeight: 'bold', fontSize: '12px' }}>{actionId}</td>
                                                    <td style={{ width: '65px', textAlign: 'right', fontFamily: 'monospace', fontSize: '11px', color: mwStart == null ? colors.textTertiary : colors.textPrimary }}>
                                                        {mwStart != null ? `${mwStart.toFixed(1)}` : 'N/A'}
                                                    </td>
                                                    <td style={{ width: '60px', textAlign: 'right' }}>
                                                        <span className="metric-badge metric-score" style={{ transform: 'scale(0.9)', display: 'inline-block' }}>
                                                            {score.toFixed(2)}
                                                        </span>
                                                    </td>
                                                    <td style={{ width: '80px', textAlign: 'right' }}>
                                                        {simResult ? (
                                                            <span className="metric-badge metric-rho" style={{
                                                                transform: 'scale(0.9)',
                                                                display: 'inline-block',
                                                                background: (simResult.max_rho ?? 0) > monitoringFactor ? colors.dangerSoft : colors.successSoft,
                                                                color: (simResult.max_rho ?? 0) > monitoringFactor ? colors.dangerText : colors.successStrong,
                                                                border: '1px solid currentColor'
                                                            }}>
                                                                {((simResult.max_rho ?? 0) * 100).toFixed(1)}%
                                                            </span>
                                                        ) : (
                                                            <span style={{ color: colors.textTertiary, fontStyle: 'italic', fontSize: '10px' }}>Untested</span>
                                                        )}
                                                    </td>
                                                    <td onClick={(e) => e.stopPropagation()} style={{ width: '100px', textAlign: 'right', paddingRight: '12px' }}>
                                                        <button
                                                            onClick={() => onSimulateSingle(actionId)}
                                                            disabled={simulating}
                                                            style={{
                                                                padding: '3px 10px',
                                                                background: simResult ? colors.disabled : colors.brandStrong,
                                                                color: colors.textOnBrand,
                                                                border: 'none',
                                                                borderRadius: '4px',
                                                                cursor: simulating ? 'not-allowed' : 'pointer',
                                                                fontSize: '10px',
                                                                fontWeight: 'bold',
                                                                minWidth: '70px'
                                                            }}
                                                        >
                                                            {simulating ? '...' : (simResult ? 'Re-run' : 'Simulate')}
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    }
                                </tbody>
                            </table>
                        </div>
                    ));
                })()}
            </div>

            {/* Action Bar / Comparison Card */}
            <div style={{ marginTop: '5px' }}>
                {!preview && !simulationFeedback && !simulating && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button
                            onClick={onEstimate}
                            disabled={selectedIds.size !== 2 || loading || hasRestricted}
                            data-testid="estimate-button"
                            title={hasRestricted ? 'Estimation is not available when a load shedding or curtailment action is selected — use Simulate Combined instead.' : undefined}
                            style={{
                                width: '100%',
                                padding: '12px',
                                background: (selectedIds.size === 2 && !loading && !hasRestricted) ? colors.brand : colors.surfaceMuted,
                                color: (selectedIds.size === 2 && !loading && !hasRestricted) ? colors.textOnBrand : colors.textTertiary,
                                border: 'none',
                                borderRadius: '6px',
                                cursor: (selectedIds.size !== 2 || loading || hasRestricted) ? 'not-allowed' : 'pointer',
                                fontWeight: 'bold',
                                fontSize: '14px',
                                transition: 'all 0.2s',
                                boxShadow: (selectedIds.size === 2 && !loading && !hasRestricted) ? '0 4px 6px rgba(52, 152, 219, 0.2)' : 'none'
                            }}
                        >
                            {loading ? '⚙️ Estimating Combination...' : (selectedIds.size === 2 ? (hasRestricted ? 'Estimation not available for load shedding / curtailment' : 'Estimate combination effect') : 'Select 2 actions to estimate')}
                        </button>
                        <button
                            onClick={onSimulate}
                            disabled={selectedIds.size !== 2 || simulating}
                            data-testid="simulate-combined-button"
                            style={{
                                width: '100%',
                                padding: '10px',
                                background: (selectedIds.size === 2 && !simulating) ? colors.success : colors.surfaceMuted,
                                color: (selectedIds.size === 2 && !simulating) ? colors.textOnBrand : colors.textTertiary,
                                border: 'none',
                                borderRadius: '6px',
                                cursor: (selectedIds.size !== 2 || simulating) ? 'not-allowed' : 'pointer',
                                fontWeight: 'bold',
                                fontSize: '13px',
                                transition: 'all 0.2s',
                                boxShadow: (selectedIds.size === 2 && !simulating) ? '0 2px 4px rgba(39,174,96,0.2)' : 'none'
                            }}
                        >
                            {simulating ? '⌛ Simulating...' : (selectedIds.size === 2 ? 'Simulate Combined' : 'Select 2 actions to simulate')}
                        </button>
                    </div>
                )}

                {preview && !simulationFeedback && (
                    <button
                        onClick={onSimulate}
                        disabled={simulating}
                        data-testid="simulate-combined-top-button"
                        style={{
                            width: '100%',
                            padding: '10px',
                            marginBottom: '8px',
                            background: simulating ? colors.textSecondary : colors.success,
                            color: colors.textOnBrand,
                            border: 'none',
                            borderRadius: '6px',
                            cursor: simulating ? 'not-allowed' : 'pointer',
                            fontWeight: 'bold',
                            fontSize: '13px',
                            boxShadow: simulating ? 'none' : '0 2px 4px rgba(39,174,96,0.2)',
                            transition: 'all 0.2s'
                        }}
                    >
                        {simulating ? '⌛ Simulating...' : 'Simulate Combined'}
                    </button>
                )}

                {(preview || simulationFeedback || simulating) && (
                    <div style={{
                        padding: '15px',
                        background: error ? colors.warningSoft : colors.infoSoft,
                        borderRadius: '8px',
                        borderLeft: '5px solid ' + (error ? colors.warningText : colors.info),
                        boxShadow: '0 2px 5px rgba(0,0,0,0.05)'
                    }} data-testid="comparison-card">
                        <div style={{ marginBottom: '10px' }}>
                            {preview?.betas && (
                                <div style={{ marginBottom: '8px', fontSize: '11px', color: colors.textTertiary, background: 'rgba(255,255,255,0.6)', padding: '2px 8px', borderRadius: '4px', display: 'inline-block', fontWeight: 600 }}>
                                    Betas: {preview.betas.map(b => b.toFixed(3)).join(', ')}
                                </div>
                            )}
                            <div style={{ fontWeight: 800, color: error ? colors.warningText : colors.infoText, fontSize: '15px' }}>
                                {error ? '⚠️ Estimation Failed' : (preview ? 'Explore Pairs Comparison' : 'Simulation Result')}
                            </div>
                        </div>

                        {!error && (
                            <div style={{ display: 'flex', gap: '30px', borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: '12px' }}>
                                {preview && (
                                    <div style={{ flex: 1, borderRight: '1px solid rgba(0,0,0,0.05)', paddingRight: '15px' }}>
                                        <div style={{ fontSize: '11px', fontWeight: 700, color: colors.textTertiary, textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>Estimated Effect</div>
                                        <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                                            Estimated Max Loading: <strong style={{ color: (preview.estimated_max_rho ?? preview.max_rho ?? 0) <= monitoringFactor ? colors.success : colors.warningStrong, fontSize: '16px' }}>{((preview.estimated_max_rho ?? preview.max_rho ?? 0) * 100).toFixed(1)}%</strong>
                                            {preview.is_islanded && (
                                                <span style={{ marginLeft: '6px' }} title="Estimation suspect due to islanding">⚠️</span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: '12px', color: colors.textTertiary }}>
                                            Line: {displayName(preview.estimated_max_rho_line ?? preview.max_rho_line)}
                                        </div>
                                        {preview.target_max_rho != null && preview.target_max_rho_line && preview.target_max_rho_line !== 'N/A' && preview.target_max_rho_line !== (preview.estimated_max_rho_line ?? preview.max_rho_line) && (
                                            <div style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '6px', padding: '4px 8px', background: 'rgba(255,255,255,0.6)', borderRadius: '4px', display: 'inline-block' }} data-testid="target-max-rho">
                                                Target overload: <strong style={{ color: (preview.target_max_rho ?? 0) <= monitoringFactor ? colors.success : colors.warningStrong }}>{((preview.target_max_rho ?? 0) * 100).toFixed(1)}%</strong> on {displayName(preview.target_max_rho_line)}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: '11px', fontWeight: 700, color: colors.textTertiary, textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>Simulation Result</div>
                                    {simulating && (
                                        <div style={{ color: colors.brandStrong, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span>⌛</span> Simulating combined action...
                                        </div>
                                    )}
                                    {!simulating && simulationFeedback && (
                                        <div data-testid="simulation-feedback">
                                            <div style={{ fontSize: '13px', marginBottom: '4px' }}>
                                                Actual Max Loading: <strong style={{ color: (simulationFeedback.max_rho ?? 1) <= monitoringFactor ? colors.success : colors.warningStrong, fontSize: '16px' }}>{simulationFeedback.max_rho != null ? `${(simulationFeedback.max_rho * 100).toFixed(1)}%` : 'N/A'}</strong>
                                            </div>
                                            <div style={{ fontSize: '12px', color: colors.textTertiary }}>
                                                Line: {displayName(simulationFeedback.max_rho_line)}
                                            </div>
                                            {simulationFeedback.is_islanded && (
                                                <div style={{ fontSize: '11px', color: colors.danger, marginTop: '6px', fontWeight: 600, background: colors.dangerSoft, padding: '2px 8px', borderRadius: '4px', display: 'inline-block' }}>
                                                    Islanding detected ({simulationFeedback.disconnected_mw?.toFixed(1)} MW disconnected)
                                                </div>
                                            )}
                                            {simulationFeedback.non_convergence && (
                                                <div style={{ fontSize: '11px', color: colors.danger, marginTop: '6px', fontWeight: 600, background: colors.dangerSoft, padding: '2px 8px', borderRadius: '4px', display: 'inline-block' }}>
                                                    Non-convergence: {simulationFeedback.non_convergence}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {!simulating && !simulationFeedback && (
                                        <div style={{ color: colors.textTertiary, fontSize: '12px', fontStyle: 'italic', marginTop: '5px' }}>Click "Simulate Combined" above to run</div>
                                    )}
                                </div>
                            </div>
                        )}
                        {error && (
                            <div style={{ fontSize: '13px', color: colors.warningText }}>{error}</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ExplorePairsTab;
