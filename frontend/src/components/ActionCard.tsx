// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { ActionDetail, NodeMeta, EdgeMeta } from '../types';
import type { ModelDescriptor } from '../api';
import { getActionTargetVoltageLevels, getActionTargetLines, isCouplingAction } from '../utils/svgUtils';
import { colors } from '../styles/tokens';
import { SeverityIcon, type SeverityKind } from './SeverityIcon';

interface ActionCardProps {
    id: string;
    details: ActionDetail;
    index: number;
    isViewing: boolean;
    isSelected: boolean;
    isRejected: boolean;
    linesOverloaded: string[];
    monitoringFactor: number;
    nodesByEquipmentId: Map<string, NodeMeta> | null;
    edgesByEquipmentId: Map<string, EdgeMeta> | null;
    cardEditMw: Record<string, string>;
    cardEditTap: Record<string, string>;
    resimulating: string | null;
    onActionSelect: (actionId: string | null) => void;
    onActionFavorite: (actionId: string) => void;
    onActionReject: (actionId: string) => void;
    onAssetClick: (actionId: string, assetName: string, tab?: 'action' | 'contingency') => void;
    onVlDoubleClick?: (actionId: string, vlName: string) => void;
    onCardEditMwChange: (actionId: string, value: string) => void;
    onCardEditTapChange: (actionId: string, value: string) => void;
    onResimulate: (actionId: string, newMw: number) => void;
    onResimulateTap: (actionId: string, newTap: number) => void;
    /** Resolve an element ID to its human-readable display name. Falls back to the ID. */
    displayName?: (id: string) => string;
    /**
     * Registered recommender models — used to resolve `details.origin`
     * (a model id) to a human-readable label in the unfolded card's
     * "Source" row. Absent / no-match falls back to the raw id.
     */
    availableModels?: ModelDescriptor[];
}

const clickableLinkStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    fontSize: 'inherit',
    color: colors.brand,
    fontWeight: 600,
    textDecoration: 'underline dotted',
};

const ActionCard: React.FC<ActionCardProps> = ({
    id,
    details,
    index,
    isViewing,
    isSelected,
    isRejected,
    linesOverloaded,
    monitoringFactor,
    nodesByEquipmentId,
    edgesByEquipmentId,
    cardEditMw,
    cardEditTap,
    resimulating,
    onActionSelect,
    onActionFavorite,
    onActionReject,
    onAssetClick,
    onVlDoubleClick,
    onCardEditMwChange,
    onCardEditTapChange,
    onResimulate,
    onResimulateTap,
    displayName = (id: string) => id,
    availableModels,
}) => {
    const maxRhoPct = details.max_rho != null ? (details.max_rho * 100).toFixed(1) : null;

    // Provenance label for the unfolded card's "Source" row. `origin`
    // is either the literal `"user"` (manual simulation) or a
    // recommender model id — resolved here to the model's label.
    const originLabel = details.origin == null
        ? null
        : details.origin === 'user'
            ? 'Manual simulation (user)'
            : (availableModels?.find(m => m.name === details.origin)?.label ?? details.origin);
    const severity = details.max_rho != null
        ? (details.max_rho > monitoringFactor ? 'red' as const : details.max_rho > (monitoringFactor - 0.05) ? 'orange' as const : 'green' as const)
        : (details.is_rho_reduction ? 'green' as const : 'red' as const);
    const severityColors = {
        green: { border: colors.success, badgeBg: colors.successSoft, badgeText: colors.successText, label: 'Solves overload', kind: 'solves' as SeverityKind },
        orange: { border: colors.warningStrong, badgeBg: colors.warningSoft, badgeText: colors.warningText, label: 'Solved — low margin', kind: 'lowMargin' as SeverityKind },
        red: { border: colors.danger, badgeBg: colors.dangerSoft, badgeText: colors.dangerText, label: details.is_rho_reduction ? 'Still overloaded' : 'No reduction', kind: 'unsolved' as SeverityKind },
    };
    const sc = details.non_convergence
        ? { border: colors.danger, badgeBg: colors.danger, badgeText: colors.textOnBrand, label: 'divergent', kind: 'divergent' as SeverityKind }
        : details.is_islanded
            ? { border: colors.danger, badgeBg: colors.danger, badgeText: colors.textOnBrand, label: 'islanded', kind: 'islanded' as SeverityKind }
            : severityColors[severity];

    const renderRho = (arr: number[] | null, actionId: string, tab: 'action' | 'contingency' = 'action'): React.ReactNode => {
        if (!arr || arr.length === 0) return '—';
        const halfOpen = details.half_open_overloads;
        return arr.map((v, i) => {
            const lineName = linesOverloaded[i] || `line ${i}`;
            // A line the action left open at one end shows a non-zero loading
            // that is pure capacitive charging current (the diagrams show p = 0).
            // Annotate it with the live-end reactive power so the operator reads
            // it as charging current, not a residual overload.
            const reactiveMvar = halfOpen ? halfOpen[lineName] : undefined;
            return (
                <React.Fragment key={i}>
                    {i > 0 && ', '}
                    <button
                        style={clickableLinkStyle}
                        title={`Zoom to ${lineName}`}
                        onClick={(e) => { e.stopPropagation(); onAssetClick(actionId, lineName, tab); }}
                    >{displayName(lineName)}</button>
                    {`: ${(v * 100).toFixed(1)}%`}
                    {reactiveMvar != null && (
                        <span
                            style={{ color: colors.textTertiary, fontStyle: 'italic' }}
                            title="Line open at one end — this loading is the line's capacitive charging current (reactive power), not real power flow. The line carries no active power (the diagrams show 0)."
                        >
                            {` — open one end · ${reactiveMvar.toFixed(1)} MVAr capacitive`}
                        </span>
                    )}
                </React.Fragment>
            );
        });
    };

    const renderBadges = () => {
        const badges: React.ReactNode[] = [];
        const badgeBtn = (name: string, bg: string, color: string, title: string, onDoubleClick?: (e: React.MouseEvent) => void) => (
            <button key={name}
                style={{ padding: '2px 7px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 600, textDecoration: 'underline dotted', flexShrink: 0, backgroundColor: bg, color }}
                title={title}
                onClick={(e) => { e.stopPropagation(); onAssetClick(id, name, 'action'); }}
                onDoubleClick={onDoubleClick}>
                {displayName(name)}
            </button>
        );

        // Collect badges from every source that applies. A combined
        // action like ``load_shedding_X+reco_Y`` owes a badge to BOTH
        // sub-actions — using an if/else-if/else here used to drop the
        // topology-based sub-action (reco / disco / coupling) whenever
        // the pair also contained a load-shedding or curtailment leg.
        const vlSet = new Set<string>();

        // Highest-priority signal: backend-supplied VL hint on the
        // topology blob. The recommender pipeline writes this for
        // pypowsybl switch-based / coupling actions (the dict_action
        // entry's ``VoltageLevelId``) so the operator gets a
        // clickable, double-clickable VL chip even when the action ID
        // is opaque (e.g. UUID-prefixed ``..._VLNAME_..._coupling``).
        const explicitVlHint = (details.action_topology as { voltage_level_id?: string } | undefined)?.voltage_level_id;
        if (explicitVlHint && !vlSet.has(explicitVlHint)) {
            vlSet.add(explicitVlHint);
            badges.push(badgeBtn(explicitVlHint, colors.successSoft, colors.successText, `Click: zoom to ${explicitVlHint} | Double-click: open SLD`, (e) => {
                e.stopPropagation();
                onVlDoubleClick?.(id, explicitVlHint);
            }));
        }

        details.load_shedding_details?.forEach(ls => {
            if (ls.voltage_level_id && !vlSet.has(ls.voltage_level_id)) {
                vlSet.add(ls.voltage_level_id);
                badges.push(badgeBtn(ls.voltage_level_id, colors.successSoft, colors.successText, `Click: zoom to ${ls.voltage_level_id} | Double-click: open SLD`, (e) => {
                    e.stopPropagation();
                    onVlDoubleClick?.(id, ls.voltage_level_id!);
                }));
            }
        });

        details.curtailment_details?.forEach(rc => {
            if (rc.voltage_level_id && !vlSet.has(rc.voltage_level_id)) {
                vlSet.add(rc.voltage_level_id);
                badges.push(badgeBtn(rc.voltage_level_id, colors.successSoft, colors.successText, `Click: zoom to ${rc.voltage_level_id} | Double-click: open SLD`, (e) => {
                    e.stopPropagation();
                    onVlDoubleClick?.(id, rc.voltage_level_id!);
                }));
            }
        });

        details.redispatch_details?.forEach(rd => {
            if (rd.voltage_level_id && !vlSet.has(rd.voltage_level_id)) {
                vlSet.add(rd.voltage_level_id);
                badges.push(badgeBtn(rd.voltage_level_id, colors.successSoft, colors.successText, `Click: zoom to ${rd.voltage_level_id} | Double-click: open SLD`, (e) => {
                    e.stopPropagation();
                    onVlDoubleClick?.(id, rd.voltage_level_id!);
                }));
            }
        });

        if (nodesByEquipmentId) {
            const vlNames = getActionTargetVoltageLevels(details, id, nodesByEquipmentId);
            vlNames.forEach(vlName => {
                if (vlSet.has(vlName)) return;
                vlSet.add(vlName);
                badges.push(badgeBtn(vlName, colors.successSoft, colors.successText, `Click: zoom to ${vlName} | Double-click: open SLD`, (e) => {
                    e.stopPropagation();
                    onVlDoubleClick?.(id, vlName);
                }));
            });
        }

        const isCoupling = isCouplingAction(id, details.description_unitaire);
        const lineNames = edgesByEquipmentId
            ? getActionTargetLines(details, id, edgesByEquipmentId)
            : Array.from(new Set([
                ...(isCoupling ? [] : Object.keys(details.action_topology?.lines_ex_bus || {})),
                ...(isCoupling ? [] : Object.keys(details.action_topology?.lines_or_bus || {})),
                ...Object.keys(details.action_topology?.pst_tap || {}),
            ]));

        lineNames.forEach(name => {
            if (badges.some(b => React.isValidElement(b) && b.key === name)) return;
            badges.push(badgeBtn(name, colors.brandSoft, colors.brand, `Zoom to ${name}`));
        });

        if (badges.length === 0) {
            const topo = details.action_topology;
            const equipNames = Array.from(new Set([
                ...Object.keys(topo?.gens_bus || {}),
                ...Object.keys(topo?.loads_bus || {}),
                ...Object.keys(topo?.loads_p || {}),
                ...Object.keys(topo?.gens_p || {}),
            ]));
            equipNames.forEach(name => {
                badges.push(badgeBtn(name, colors.brandSoft, colors.brand, `Zoom to ${name}`));
            });
        }

        return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', flexShrink: 0, justifyContent: 'flex-end' }}>
                {badges}
            </div>
        );
    };

    const isFault = !!(details.non_convergence || details.is_islanded);
    // Higher-saturation accent stripe for the viewing card — replaces
    // the old vertical "VIEWING" ribbon with a quieter signal that
    // doesn't steal a column of horizontal space inside the card.
    const accentColor = isViewing ? colors.brandStrong : sc.border;

    const editorRowStyle: React.CSSProperties = {
        fontSize: '12px',
        padding: '6px 10px',
        marginTop: '5px',
        borderRadius: '4px',
        fontWeight: 500,
    };

    return (
        <div
            data-testid={`action-card-${id}`}
            data-viewing={isViewing ? 'true' : 'false'}
            className={`action-card${isViewing ? ' is-viewing' : ''}`}
            style={{
                background: isFault ? colors.dangerSoft : (isViewing ? colors.brandSoft : colors.surface),
                border: isFault ? `1px solid ${colors.danger}` : `1px solid ${colors.border}`,
                borderRadius: '8px',
                marginBottom: '10px',
                boxShadow: isViewing ? '0 2px 8px rgba(0,0,0,0.15)' : '0 2px 4px rgba(0,0,0,0.1)',
                borderLeft: `5px solid ${accentColor}`,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                overflow: 'hidden',
                padding: '10px',
                position: 'relative',
            }} onClick={() => onActionSelect(id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flex: 1, minWidth: 0 }}>
                    {/* Severity pictogram — placed before the title so the
                        operator immediately reads the outcome colour. */}
                    <span
                        data-testid={`action-card-${id}-severity`}
                        title={sc.label}
                        aria-label={sc.label}
                        role="img"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '3px',
                            borderRadius: '50%',
                            background: sc.badgeBg,
                            color: sc.badgeText,
                            flexShrink: 0,
                            lineHeight: 0,
                        }}
                    >
                        <SeverityIcon kind={sc.kind} />
                    </span>
                    <h4 style={{
                        margin: 0,
                        fontSize: '12px',
                        color: isViewing ? colors.brandStrong : undefined,
                        flex: 1,
                        minWidth: 0,
                        overflowWrap: 'anywhere',
                        fontWeight: 700,
                        lineHeight: 1.35,
                    }}>
                        #{index + 1} {'—'} {id}
                    </h4>
                </div>
                {/* Star / reject rail — top-right, revealed on hover via
                    CSS (.action-card-rail opacity transition). */}
                <div className="action-card-rail" style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                    {!isSelected && (
                        <button
                            data-testid={`favorite-${id}`}
                            onClick={(e) => { e.stopPropagation(); onActionFavorite(id); }}
                            style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '4px', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            title="Select this action"
                        ><span style={{ fontSize: '15px', lineHeight: 1 }}>⭐</span></button>
                    )}
                    {!isRejected && (
                        <button
                            data-testid={`reject-${id}`}
                            onClick={(e) => { e.stopPropagation(); onActionReject(id); }}
                            style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '4px', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            title={isSelected ? "Remove from selected" : "Reject this action"}
                        ><span style={{ fontSize: '15px', lineHeight: 1 }}>❌</span></button>
                    )}
                </div>
            </div>

            {/* Compact at-rest body: max loading + target badges. The
                row wraps so multi-VL badge stacks flow to a second
                line when the title is long or the badges don't fit
                alongside the loading metric. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', rowGap: '6px', gap: '8px', marginTop: '6px' }}>
                <div style={{ flex: '1 1 160px', fontSize: '12px', minWidth: 'min-content' }}>
                    {maxRhoPct != null ? (
                        <div>
                            Max loading: <strong style={{ color: sc.border }}>{maxRhoPct}%</strong>
                            {details.max_rho_line && (
                                <span style={{ color: colors.textTertiary }}> on <button
                                    style={{ ...clickableLinkStyle, color: colors.textTertiary }}
                                    title={`Zoom to ${details.max_rho_line}`}
                                    onClick={(e) => { e.stopPropagation(); onAssetClick(id, details.max_rho_line, 'action'); }}
                                >{displayName(details.max_rho_line)}</button></span>
                            )}
                        </div>
                    ) : (
                        <div style={{ color: colors.textTertiary }}>No loading metric</div>
                    )}
                </div>
                {renderBadges()}
            </div>

            {/* Fault states (divergent / islanded) are primary signals
                and stay visible regardless of the viewing-state — they
                replace the missing max-loading indicator. */}
            {details.non_convergence && (
                <div style={{ fontSize: '11px', color: colors.warningText, backgroundColor: colors.warningSoft, padding: '2px 6px', borderRadius: '4px', marginTop: '6px', border: `1px solid ${colors.warningBorder}`, display: 'inline-block' }}>
                    ⚠️ LoadFlow failure: {details.non_convergence}
                </div>
            )}
            {details.is_islanded && (
                <div style={{ fontSize: '12px', background: colors.dangerSoft, color: colors.danger, padding: '6px 10px', marginTop: '6px', borderRadius: '4px', border: `1px solid ${colors.danger}`, fontWeight: 500 }}>
                    🏝️ Islanding detected ({details.disconnected_mw?.toFixed(1)} MW disconnected)
                </div>
            )}
            {details.persistent_n_overloads && details.persistent_n_overloads.length > 0 && (
                <div
                    data-testid={`action-card-${id}-persistent-n`}
                    title={`These lines are already overloaded in the base (N) state — before any contingency — so this remedial action can't clear them: ${details.persistent_n_overloads.join(', ')}. They are not counted against solving this study.`}
                    style={{ fontSize: '11px', background: colors.warningSoft, color: colors.warningText, padding: '4px 8px', marginTop: '6px', borderRadius: '4px', border: `1px solid ${colors.warningBorder}`, cursor: 'help', display: 'inline-block' }}
                >
                    ℹ️ {details.persistent_n_overloads.length} pre-existing N overload{details.persistent_n_overloads.length > 1 ? 's' : ''} persist (not caused by this contingency)
                </div>
            )}

            {/* Progressive disclosure: description, parameter editors,
                and per-line "Loading after" only render on the viewing
                card. Keeps non-viewing cards to five fields each. */}
            {isViewing && (
                <div
                    data-testid={`action-card-${id}-disclosure`}
                    style={{ marginTop: '8px', borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: '8px' }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <p style={{ fontSize: '12px', margin: 0, color: colors.textPrimary }}>{details.description_unitaire}</p>

                    {details.load_shedding_details && details.load_shedding_details.length > 0 && (
                        <div style={{ ...editorRowStyle, background: colors.warningSoft, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}>
                            {details.load_shedding_details.map((ls, i) => (
                                <div key={ls.load_name} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: i > 0 ? '4px' : 0 }}>
                                    <span>Shedding on <strong>{ls.load_name}</strong> in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        value={cardEditMw[id] ?? ls.shedded_mw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: '11px', fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.warningStrong}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const mwVal = parseFloat(cardEditMw[id] ?? String(ls.shedded_mw));
                                            if (!isNaN(mwVal) && mwVal >= 0) onResimulate(id, mwVal);
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.warningStrong}`, background: colors.warning, color: colors.textOnBright, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {details.curtailment_details && details.curtailment_details.length > 0 && (
                        <div style={{ ...editorRowStyle, background: colors.infoSoft, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }}>
                            {details.curtailment_details.map((rc, i) => (
                                <div key={rc.gen_name} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: i > 0 ? '4px' : 0 }}>
                                    <span>Curtailment on <strong>{rc.gen_name}</strong> in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        value={cardEditMw[id] ?? rc.curtailed_mw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: '11px', fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.info}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const mwVal = parseFloat(cardEditMw[id] ?? String(rc.curtailed_mw));
                                            if (!isNaN(mwVal) && mwVal >= 0) onResimulate(id, mwVal);
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.info}`, background: colors.infoBorder, color: colors.infoText, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {details.redispatch_details && details.redispatch_details.length > 0 && (
                        <div style={{ ...editorRowStyle, background: colors.infoSoft, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }}>
                            {details.redispatch_details.map((rd, i) => {
                                // Signed-delta bounds from the generator's [min_p, max_p]:
                                // a raise can go up to +max_raise_mw, a lower down to -max_lower_mw.
                                const headroom = rd.direction === 'up' ? rd.max_raise_mw : rd.max_lower_mw;
                                const minDelta = rd.direction === 'up' ? 0 : (rd.max_lower_mw != null ? -rd.max_lower_mw : undefined);
                                const maxDelta = rd.direction === 'up' ? (rd.max_raise_mw ?? undefined) : 0;
                                const clamp = (v: number) => {
                                    if (minDelta != null) v = Math.max(minDelta, v);
                                    if (maxDelta != null) v = Math.min(maxDelta, v);
                                    return v;
                                };
                                return (
                                <div key={rd.gen_name} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: i > 0 ? '4px' : 0 }}>
                                    <span>Redispatch on <strong>{rd.gen_name}</strong> ({rd.direction === 'up' ? 'raise' : 'lower'}) in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        step={0.1}
                                        min={minDelta}
                                        max={maxDelta}
                                        value={cardEditMw[id] ?? rd.delta_mw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: '11px', fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.info}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    {headroom != null && (
                                        <span style={{ fontSize: '10px', color: colors.info }}>
                                            max {rd.direction === 'up' ? 'raise' : 'lower'}: {headroom.toFixed(0)} MW
                                        </span>
                                    )}
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const raw = parseFloat(cardEditMw[id] ?? String(rd.delta_mw));
                                            if (!isNaN(raw)) onResimulate(id, clamp(raw));
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.info}`, background: colors.infoBorder, color: colors.infoText, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                                );
                            })}
                        </div>
                    )}

                    {details.pst_details && details.pst_details.length > 0 && (
                        <div style={{ ...editorRowStyle, background: colors.accentSoft, color: colors.accentText, border: `1px solid ${colors.accentBorder}` }}>
                            {details.pst_details.map((pst, i) => (
                                <div key={pst.pst_name} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: i > 0 ? '4px' : 0 }}>
                                    <span>PST <strong>{pst.pst_name}</strong> tap:</span>
                                    <input
                                        data-testid={`edit-tap-${id}`}
                                        type="number"
                                        min={pst.low_tap ?? undefined}
                                        max={pst.high_tap ?? undefined}
                                        step={1}
                                        value={cardEditTap[id] ?? pst.tap_position}
                                        onChange={(e) => onCardEditTapChange(id, e.target.value)}
                                        style={{ width: '55px', fontSize: '11px', fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.accent}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    {pst.low_tap != null && pst.high_tap != null && (
                                        <span style={{ fontSize: '10px', color: colors.accent }}>
                                            [{pst.low_tap}..{pst.high_tap}]
                                        </span>
                                    )}
                                    <button
                                        data-testid={`resimulate-tap-${id}`}
                                        onClick={() => {
                                            const tapVal = parseInt(cardEditTap[id] ?? String(pst.tap_position), 10);
                                            if (!isNaN(tapVal)) onResimulateTap(id, tapVal);
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.accent}`, background: colors.accentBorder, color: colors.accentText, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* "Loading before" stays in the sticky Overloads N-1
                        section of the left feed — no need to duplicate
                        it per card (see git blame for the original
                        rationale). */}
                    <div style={{ fontSize: '12px', background: colors.brandSoft, padding: '5px', marginTop: '8px', borderRadius: '4px' }}>
                        Overload loading after: {renderRho(details.rho_after, id, 'action')}
                    </div>

                    {/* Source / provenance sits at the very bottom of
                        the unfolded card — it's a low-information
                        attribution row that shouldn't compete with the
                        operational fields above. */}
                    {originLabel && (
                        <div
                            data-testid={`action-card-${id}-origin`}
                            style={{ fontSize: '11px', marginTop: '8px', color: colors.textTertiary }}
                        >
                            Source: <strong style={{ color: colors.textSecondary }}>{originLabel}</strong>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default React.memo(ActionCard);
