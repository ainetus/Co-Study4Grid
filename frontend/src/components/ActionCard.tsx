// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { ActionDetail, NodeMeta, EdgeMeta } from '../types';
import type { ModelDescriptor } from '../api';
import { colors, radius, text } from '../styles/tokens';
import { clampRedispatchDelta, redispatchTotal } from '../utils/injectionActions';
import { ACTION_TYPE_LABELS, classifyActionTypes, type ActionTypeKind } from '../utils/actionTypes';
import { collectActionTargets, describeTarget, humanizeIds, type ActionLocation, type ActionTarget } from '../utils/actionLabels';
import { SeverityIcon, type SeverityKind } from './SeverityIcon';
import { ActionTypeIcon } from './ActionTypeIcon';
import { Glyph } from './Glyph';
import CopyIdButton from './CopyIdButton';

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
     * source row. Absent / no-match falls back to the raw id.
     */
    availableModels?: ModelDescriptor[];
}

const linkStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
};

/** Words a pictogram stands for — the hover tooltip that recalls its meaning. */
const TIPS = {
    maxLoading: 'Max loading — the highest line loading in the network after this action',
    stillMax: 'The line the contingency overloads is still the most loaded line after this action',
    after: 'Loading after this action of the lines the contingency overloads',
    halfOpen: 'Line open at one end — this loading is the line\'s capacitive charging current (reactive power, the MVAr shown), not real power flow. The line carries no active power (the diagrams show 0).',
    location: 'Where the action acts',
};

/** Kinds the injection details name even when the id / description do not
 *  (``curtail_*`` is only told apart by its details). */
const detailKinds = (d: ActionDetail): ActionTypeKind[] => [
    ...(d.load_shedding_details?.length ? ['ls' as const] : []),
    ...(d.curtailment_details?.length ? ['rc' as const] : []),
    ...(d.redispatch_details?.length ? ['redispatch' as const] : []),
    ...(d.pst_details?.length ? ['pst' as const] : []),
];

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

    // Provenance for the unfolded card's source row: `origin` is either
    // the literal `"user"` (manual simulation) or a recommender model id.
    const originLabel = details.origin == null
        ? null
        : details.origin === 'user'
            ? 'Manual simulation (user)'
            : (availableModels?.find(m => m.name === details.origin)?.label ?? details.origin);
    const severityOf = (rho: number) =>
        rho > monitoringFactor ? 'red' as const : rho > (monitoringFactor - 0.05) ? 'orange' as const : 'green' as const;
    const severity = details.max_rho != null
        ? severityOf(details.max_rho)
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

    // What the card names: its title (what the action acts on), the
    // location chips (where its injections sit), its type pictograms.
    const targets = collectActionTargets(id, details, nodesByEquipmentId, edgesByEquipmentId);
    const typeKinds = Array.from(new Set([
        ...classifyActionTypes(id, details.description_unitaire, null),
        ...detailKinds(details),
    ])).slice(0, 2);
    const rawDescription = details.description_unitaire;
    const description = rawDescription && rawDescription !== 'No description available'
        ? humanizeIds(rawDescription, displayName)
        : null;

    // "MANDAL71WARAN (relation_5674501-400)" — the id only when it differs.
    const named = (eid: string) => (displayName(eid) !== eid ? `${displayName(eid)} (${eid})` : eid);
    // An injection action may act on several loads / generators (an
    // evacuation-antenna aggregate): its editor shows and sends the TOTAL,
    // which the backend spreads pro rata — one input per action, not per element.
    const sheddedMw = details.load_shedding_details?.reduce((sum, ls) => sum + ls.shedded_mw, 0) ?? 0;
    const curtailedMw = details.curtailment_details?.reduce((sum, rc) => sum + rc.curtailed_mw, 0) ?? 0;
    const redispatch = redispatchTotal(details.redispatch_details);
    const renderElements = (rows: { name: string; mw: number }[]): React.ReactNode => (
        <span title={rows.map(r => `${named(r.name)}: ${r.mw.toFixed(1)} MW`).join(', ')}>
            {rows.map((r, i) => (
                <React.Fragment key={r.name}>{i > 0 && ', '}<strong>{displayName(r.name)}</strong></React.Fragment>
            ))}
        </span>
    );

    const nameLink = (t: ActionTarget, label: string) => (
        <button
            key={t.id}
            type="button"
            className="action-card-name"
            style={linkStyle}
            title={`${t.id} — click: zoom${t.kind === 'vl' ? ' · double-click: open SLD' : ''}`}
            onClick={(e) => { e.stopPropagation(); onAssetClick(id, t.id, 'action'); }}
            onDoubleClick={t.kind === 'vl' ? (e) => { e.stopPropagation(); onVlDoubleClick?.(id, t.id); } : undefined}
        >{label}</button>
    );
    // The title reads ``<type> - <name>`` for every action; consecutive
    // elements of one type share its word (``Load - A, B``), a combined
    // action chains its parts (``Branch - A + Coupling - B``).
    const renderTitle = (): React.ReactNode => {
        const shown = targets.title.length > 3 ? targets.title.slice(0, 2) : targets.title;
        if (shown.length === 0) {
            return typeKinds.length > 0 ? ACTION_TYPE_LABELS[typeKinds[0]] : id;
        }
        const sep = id.includes('+') ? ' + ' : ', ';
        const groups: { type: string; items: { t: ActionTarget; name: string }[] }[] = [];
        shown.forEach(t => {
            const { type, name } = describeTarget(t, displayName);
            const last = groups[groups.length - 1];
            if (last && last.type === type) last.items.push({ t, name });
            else groups.push({ type, items: [{ t, name }] });
        });
        return (
            <>
                {groups.map((g, gi) => (
                    <React.Fragment key={`${g.type}-${g.items[0].t.id}`}>
                        {gi > 0 && ' + '}
                        <span data-testid={`action-card-${id}-title-type`}>{g.type}</span>{' - '}
                        {g.items.map(({ t, name }, i) => <React.Fragment key={t.id}>{i > 0 && sep}{nameLink(t, name)}</React.Fragment>)}
                    </React.Fragment>
                ))}
                {targets.title.length > shown.length && (
                    <span style={{ color: colors.textTertiary, fontWeight: 500 }}
                        title={targets.title.slice(shown.length).map(t => displayName(t.id)).join(', ')}>
                        {` +${targets.title.length - shown.length}`}
                    </span>
                )}
            </>
        );
    };

    // One loading figure — the rate, then the line — read the same way in
    // the max-loading row and the overloads-after row. Its parts are flex
    // items of the row, so a narrow card wraps between them, never inside.
    const loadingFigure = (rho: number, line: string, tone: string, halfOpenNote = true): React.ReactNode => {
        // A line the action left open at one end shows a non-zero loading
        // that is pure capacitive charging current (the diagrams show p = 0).
        const reactiveMvar = halfOpenNote ? details.half_open_overloads?.[line] : undefined;
        return (
            <>
                <strong style={{ color: tone, whiteSpace: 'nowrap' }}>{(rho * 100).toFixed(1)}%</strong>
                <button
                    style={{
                        ...linkStyle, color: colors.textSecondary, textDecoration: 'underline dotted',
                        textUnderlineOffset: '2px', overflowWrap: 'anywhere', minWidth: 0,
                    }}
                    title={`Zoom to ${named(line)}`}
                    onClick={(e) => { e.stopPropagation(); onAssetClick(id, line, 'action'); }}
                >{displayName(line)}</button>
                {reactiveMvar != null && (
                    <span
                        title={TIPS.halfOpen}
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '3px', cursor: 'help', whiteSpace: 'nowrap',
                            fontSize: text.xs, color: colors.textSecondary, background: colors.surfaceMuted,
                            border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.lg, padding: '0 6px',
                        }}
                    >
                        <Glyph kind="openEnd" size={11} />
                        {`open one end · ${reactiveMvar.toFixed(1)} MVAr`}
                    </span>
                )}
            </>
        );
    };
    const figureRowStyle: React.CSSProperties = {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 6px', minWidth: 0,
    };

    // The overloads after the action, less the one the max-loading row
    // already gives: when the most loaded line is still the overloaded one,
    // a second row would only repeat it.
    const overloadsAfter = (details.rho_after ?? []).map((rho, i) => ({ rho, line: linesOverloaded[i] || `line ${i}` }));
    const isMaxRow = (o: { rho: number; line: string }) =>
        details.max_rho != null && o.line === details.max_rho_line
        && (o.rho * 100).toFixed(1) === (details.max_rho * 100).toFixed(1);
    const maxIsOverload = overloadsAfter.some(isMaxRow);
    const otherOverloads = overloadsAfter.filter(o => !isMaxRow(o));

    // The SLD chip of a voltage level the action acts on or sits in. Only the
    // viewing (unfolded) card shows them — that is where the operator goes on
    // to open an SLD. They follow the description (see the row below), one
    // name per chip, wrapping when a name is long.
    const locationChip = (t: ActionLocation) => (
        <button key={t.id}
            type="button"
            data-testid={`action-card-${id}-location-${t.id}`}
            style={{
                display: 'inline-block', padding: '1px 7px 1px 5px', maxWidth: '100%', minWidth: 0,
                borderRadius: radius.lg, border: `1px solid ${colors.successSoft}`, cursor: 'pointer',
                fontSize: text.xs, fontWeight: 600, lineHeight: 1.4, textAlign: 'left',
                background: colors.successSoft, color: colors.successText, overflowWrap: 'anywhere',
            }}
            title={`${TIPS.location}: ${named(t.id)} — click: zoom · double-click: open SLD`}
            onClick={(e) => { e.stopPropagation(); onAssetClick(id, t.id, 'action'); }}
            onDoubleClick={(e) => { e.stopPropagation(); onVlDoubleClick?.(id, t.id); }}>
            <span style={{ display: 'inline-flex', verticalAlign: '-2px', marginRight: '3px', lineHeight: 0 }}><Glyph kind="pin" size={11} /></span>
            {displayName(t.id)}
        </button>
    );

    const isFault = !!(details.non_convergence || details.is_islanded);
    // Higher-saturation accent stripe for the viewing card — a quiet
    // signal that doesn't steal a column of space inside the card.
    const accentColor = isViewing ? colors.brandStrong : sc.border;

    const editorRowStyle: React.CSSProperties = {
        fontSize: text.sm,
        padding: '6px 10px',
        marginTop: '6px',
        borderRadius: radius.sm,
        fontWeight: 500,
    };
    const railButtonStyle: React.CSSProperties = {
        background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: radius.sm,
        cursor: 'pointer', padding: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0,
    };
    const pillStyle: React.CSSProperties = {
        display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: text.xs,
        padding: '3px 8px', marginTop: '6px', borderRadius: radius.sm,
    };

    return (
        <div
            data-testid={`action-card-${id}`}
            data-viewing={isViewing ? 'true' : 'false'}
            className={`action-card${isViewing ? ' is-viewing' : ''}`}
            style={{
                background: isFault ? colors.dangerSoft : (isViewing ? colors.brandSoft : colors.surface),
                border: isFault ? `1px solid ${colors.danger}` : `1px solid ${colors.border}`,
                borderRadius: radius.lg,
                marginBottom: '10px',
                boxShadow: isViewing ? '0 2px 8px rgba(0,0,0,0.15)' : '0 1px 3px rgba(0,0,0,0.1)',
                borderLeft: `5px solid ${accentColor}`,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                overflow: 'hidden',
                padding: '8px 10px 9px 8px',
                position: 'relative',
                display: 'flex',
                gap: '7px',
                alignItems: 'flex-start',
            }} onClick={() => onActionSelect(id)}>
            {/* Outcome first — the severity column the eye scans down the feed. */}
            <span
                data-testid={`action-card-${id}-severity`}
                title={sc.label}
                aria-label={sc.label}
                role="img"
                style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '3px', borderRadius: '50%', background: sc.badgeBg, color: sc.badgeText,
                    flexShrink: 0, lineHeight: 0, marginTop: '1px',
                }}
            >
                <SeverityIcon kind={sc.kind} />
            </span>

            <div style={{ flex: 1, minWidth: 0 }}>
                {/* What: rank, type pictogram(s), the elements it acts on. */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                    <h4
                        title={id}
                        style={{
                            margin: 0, flex: 1, minWidth: 0, fontSize: text.sm, fontWeight: 700, lineHeight: 1.4,
                            color: isViewing ? colors.brandStrong : colors.textPrimary, overflowWrap: 'anywhere',
                        }}
                    >
                        <span style={{ color: colors.textTertiary, fontWeight: 600, marginRight: '5px' }}>#{index + 1}</span>
                        {typeKinds.map(kind => (
                            <span
                                key={kind}
                                data-testid={`action-card-${id}-type-${kind}`}
                                title={ACTION_TYPE_LABELS[kind]}
                                aria-label={ACTION_TYPE_LABELS[kind]}
                                role="img"
                                style={{ display: 'inline-flex', verticalAlign: '-2px', marginRight: '5px', color: colors.textSecondary }}
                            >
                                <ActionTypeIcon kind={kind} />
                            </span>
                        ))}
                        {renderTitle()}
                    </h4>
                    {/* Star / reject rail — revealed on hover via CSS
                        (.action-card-rail opacity transition). */}
                    <div className="action-card-rail" style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                        {!isSelected && (
                            <button
                                data-testid={`favorite-${id}`}
                                onClick={(e) => { e.stopPropagation(); onActionFavorite(id); }}
                                style={{ ...railButtonStyle, color: colors.warningStrong }}
                                title="Select this action"
                                aria-label="Select this action"
                            ><Glyph kind="star" size={14} /></button>
                        )}
                        {!isRejected && (
                            <button
                                data-testid={`reject-${id}`}
                                onClick={(e) => { e.stopPropagation(); onActionReject(id); }}
                                style={{ ...railButtonStyle, color: colors.danger }}
                                title={isSelected ? 'Remove from selected' : 'Reject this action'}
                                aria-label={isSelected ? 'Remove from selected' : 'Reject this action'}
                            ><Glyph kind="cross" size={14} /></button>
                        )}
                    </div>
                </div>

                {/* How: the action's description, right under its title —
                    one line at rest, in full on the viewing card — and, on
                    the viewing card only, at its end the SLD chips of the
                    voltage levels it acts on (they drop to the next line
                    when both do not fit). */}
                {(description || (isViewing && targets.locations.length > 0)) && (
                    <div
                        data-testid={`action-card-${id}-how`}
                        style={{ margin: '2px 0 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px', minWidth: 0 }}
                    >
                        {description && (
                            <p
                                data-testid={`action-card-${id}-description`}
                                title={isViewing ? (description !== rawDescription ? rawDescription : undefined) : description}
                                style={{
                                    margin: 0, maxWidth: '100%', minWidth: 0, fontSize: text.xs, lineHeight: 1.45, color: colors.textSecondary,
                                    ...(isViewing ? { overflowWrap: 'anywhere' } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
                                }}
                            >{description}</p>
                        )}
                        {isViewing && targets.locations.map(locationChip)}
                    </div>
                )}

                {/* Outcome: max loading and, on the viewing card, the
                    contingency's overloads after the action — one group. */}
                <div
                    data-testid={`action-card-${id}-loading`}
                    style={{
                        marginTop: '6px', fontSize: text.sm, display: 'flex', flexDirection: 'column', gap: '4px',
                        ...(isViewing ? {
                            background: colors.surface, border: `1px solid ${colors.borderSubtle}`,
                            borderRadius: radius.md, padding: '6px 8px',
                        } : {}),
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px' }}>
                        {details.max_rho != null ? (
                            <span title={TIPS.maxLoading} style={{ ...figureRowStyle, flex: '1 1 auto', color: colors.textSecondary }}>
                                <Glyph kind="gauge" />
                                {details.max_rho_line
                                    ? loadingFigure(details.max_rho, details.max_rho_line, sc.border, maxIsOverload)
                                    : <strong style={{ color: sc.border }}>{maxRhoPct}%</strong>}
                                {isViewing && maxIsOverload && (
                                    <span
                                        data-testid={`action-card-${id}-still-max`}
                                        title={TIPS.stillMax}
                                        style={{ fontSize: text.xs, fontStyle: 'italic', color: colors.textTertiary, whiteSpace: 'nowrap' }}
                                    >still the most loaded</span>
                                )}
                            </span>
                        ) : (
                            <span style={{ color: colors.textTertiary }}>No loading metric</span>
                        )}
                    </div>
                    {isViewing && (overloadsAfter.length === 0 || otherOverloads.length > 0) && (
                        <div data-testid={`action-card-${id}-after`} style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                            <span title={TIPS.after} aria-label={TIPS.after} role="img"
                                style={{ display: 'inline-flex', color: colors.textSecondary, marginTop: '2px' }}>
                                <Glyph kind="after" />
                            </span>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                                {overloadsAfter.length === 0
                                    ? '—'
                                    : otherOverloads.map((o, i) => (
                                        <span key={i} style={figureRowStyle}>
                                            {loadingFigure(o.rho, o.line, severityColors[severityOf(o.rho)].border)}
                                        </span>
                                    ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Fault states (divergent / islanded) are primary signals
                    and stay visible whatever the viewing state. */}
                {details.non_convergence && (
                    <div style={{ ...pillStyle, color: colors.warningText, backgroundColor: colors.warningSoft, border: `1px solid ${colors.warningBorder}` }}>
                        <Glyph kind="warning" size={12} />
                        LoadFlow failure: {details.non_convergence}
                    </div>
                )}
                {details.is_islanded && (
                    <div style={{ ...pillStyle, backgroundColor: colors.dangerSoft, color: colors.danger, border: `1px solid ${colors.danger}`, fontWeight: 600 }}>
                        <Glyph kind="warning" size={12} />
                        Islanding detected ({details.disconnected_mw?.toFixed(1)} MW disconnected)
                    </div>
                )}
                {details.persistent_n_overloads && details.persistent_n_overloads.length > 0 && (
                    <div
                        data-testid={`action-card-${id}-persistent-n`}
                        title={`These lines are already overloaded in the base (N) state — before any contingency — so this remedial action can't clear them: ${details.persistent_n_overloads.map(displayName).join(', ')}. They are not counted against solving this study.`}
                        style={{ ...pillStyle, backgroundColor: colors.warningSoft, color: colors.warningText, border: `1px solid ${colors.warningBorder}`, cursor: 'help' }}
                    >
                        <Glyph kind="info" size={12} />
                        {details.persistent_n_overloads.length} pre-existing N overload{details.persistent_n_overloads.length > 1 ? 's' : ''} persist (not caused by this contingency)
                    </div>
                )}

                {/* Progressive disclosure: parameter editors and provenance
                    only render on the viewing card. */}
                {isViewing && (
                    <div
                        data-testid={`action-card-${id}-disclosure`}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        {details.load_shedding_details && details.load_shedding_details.length > 0 && (
                            <div style={{ ...editorRowStyle, background: colors.warningSoft, color: colors.warningText, border: `1px solid ${colors.warningBorder}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span>Shedding on {renderElements(details.load_shedding_details.map(ls => ({ name: ls.load_name, mw: ls.shedded_mw })))} in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        value={cardEditMw[id] ?? sheddedMw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: text.xs, fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.warningStrong}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const mwVal = parseFloat(cardEditMw[id] ?? String(sheddedMw));
                                            if (!isNaN(mwVal) && mwVal >= 0) onResimulate(id, mwVal);
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.warningStrong}`, background: colors.warning, color: colors.textOnBright, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {details.curtailment_details && details.curtailment_details.length > 0 && (
                            <div style={{ ...editorRowStyle, background: colors.infoSoft, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span>Curtailment on {renderElements(details.curtailment_details.map(rc => ({ name: rc.gen_name, mw: rc.curtailed_mw })))} in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        min={0}
                                        step={0.1}
                                        value={cardEditMw[id] ?? curtailedMw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: text.xs, fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.info}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const mwVal = parseFloat(cardEditMw[id] ?? String(curtailedMw));
                                            if (!isNaN(mwVal) && mwVal >= 0) onResimulate(id, mwVal);
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.info}`, background: colors.infoBorder, color: colors.infoText, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {details.redispatch_details && redispatch && (
                            <div style={{ ...editorRowStyle, background: colors.infoSoft, color: colors.infoText, border: `1px solid ${colors.infoBorder}` }}>
                                {/* Signed-delta bounds from the generators' [min_p, max_p]:
                                    a raise can go up to +max raise, a lower down to -max lower. */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                    <span>Redispatch on {renderElements(details.redispatch_details.map(rd => ({ name: rd.gen_name, mw: rd.delta_mw })))} ({redispatch.direction === 'up' ? 'raise' : 'lower'}) in MW:</span>
                                    <input
                                        data-testid={`edit-mw-${id}`}
                                        type="number"
                                        step={0.1}
                                        min={redispatch.minDeltaMw}
                                        max={redispatch.maxDeltaMw}
                                        value={cardEditMw[id] ?? redispatch.deltaMw.toFixed(1)}
                                        onChange={(e) => onCardEditMwChange(id, e.target.value)}
                                        style={{ width: '65px', fontSize: text.xs, fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.info}`, borderRadius: '3px', textAlign: 'right' }}
                                    />
                                    {redispatch.headroomMw != null && (
                                        <span style={{ fontSize: '10px', color: colors.info }}>
                                            max {redispatch.direction === 'up' ? 'raise' : 'lower'}: {redispatch.headroomMw.toFixed(0)} MW
                                        </span>
                                    )}
                                    <button
                                        data-testid={`resimulate-${id}`}
                                        onClick={() => {
                                            const raw = parseFloat(cardEditMw[id] ?? String(redispatch.deltaMw));
                                            if (!isNaN(raw)) onResimulate(id, clampRedispatchDelta(redispatch, raw));
                                        }}
                                        disabled={resimulating === id}
                                        style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '3px', border: `1px solid ${colors.info}`, background: colors.infoBorder, color: colors.infoText, cursor: resimulating === id ? 'wait' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                    >
                                        {resimulating === id ? 'Simulating...' : 'Re-simulate'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {details.pst_details && details.pst_details.length > 0 && (
                            <div style={{ ...editorRowStyle, background: colors.accentSoft, color: colors.accentText, border: `1px solid ${colors.accentBorder}` }}>
                                {details.pst_details.map((pst, i) => (
                                    <div key={pst.pst_name} style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: i > 0 ? '4px' : 0 }}>
                                        <span>PST <strong title={pst.pst_name}>{displayName(pst.pst_name)}</strong> tap:</span>
                                        <input
                                            data-testid={`edit-tap-${id}`}
                                            type="number"
                                            min={pst.low_tap ?? undefined}
                                            max={pst.high_tap ?? undefined}
                                            step={1}
                                            value={cardEditTap[id] ?? pst.tap_position}
                                            onChange={(e) => onCardEditTapChange(id, e.target.value)}
                                            style={{ width: '55px', fontSize: text.xs, fontFamily: 'monospace', padding: '2px 4px', border: `1px solid ${colors.accent}`, borderRadius: '3px', textAlign: 'right' }}
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

                        {/* Provenance + the raw id, last: low-information
                            attribution that shouldn't compete with the above. */}
                        <div
                            data-testid={`action-card-${id}-origin`}
                            style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '7px', fontSize: text.xs, color: colors.textTertiary, minWidth: 0 }}
                        >
                            {originLabel && (
                                <span title={`Source: ${originLabel}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                                    <Glyph kind={details.origin === 'user' ? 'user' : 'model'} size={12} />
                                    <span style={{ color: colors.textSecondary }}>{originLabel}</span>
                                </span>
                            )}
                            <code
                                title={id}
                                style={{ marginLeft: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10px' }}
                            >{id}</code>
                            <CopyIdButton value={id} label="action id" testId={`action-card-${id}-copy-id`} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default React.memo(ActionCard);
