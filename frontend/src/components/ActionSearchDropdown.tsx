// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { type RefObject } from 'react';
import type { ActionDetail, ActionOverviewFilters, AvailableAction } from '../types';
import ActionFilterRings from './ActionFilterRings';
import { colors } from '../styles/tokens';

export interface ScoredActionItem {
    type: string;
    actionId: string;
    score: number;
    mwStart: number | null;
}

interface ActionSearchDropdownProps {
    dropdownRef: RefObject<HTMLDivElement | null>;
    searchInputRef: RefObject<HTMLInputElement | null>;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
    /** Shared severity + action-type filter for the manual-selection
     *  dropdown — rendered as an ActionFilterRings instance. */
    filters: ActionOverviewFilters;
    onFiltersChange: (next: ActionOverviewFilters) => void;
    error: string | null;
    loadingActions: boolean;
    scoredActionsList: ScoredActionItem[];
    filteredActions: AvailableAction[];
    actionScores: Record<string, Record<string, unknown>> | undefined;
    actions: Record<string, ActionDetail>;
    cardEditMw: Record<string, string>;
    onCardEditMwChange: (actionId: string, value: string) => void;
    cardEditTap: Record<string, string>;
    onCardEditTapChange: (actionId: string, value: string) => void;
    simulating: string | null;
    resimulating: string | null;
    onAddAction: (actionId: string, targetMw?: number, targetTap?: number) => void;
    onResimulate: (actionId: string, newMw: number) => void;
    onResimulateTap: (actionId: string, newTap: number) => void;
    onShowTooltip: (e: React.MouseEvent, content: React.ReactNode) => void;
    onHideTooltip: () => void;
    /** Same threshold the action cards use to colour their max-ρ
     *  severity (green / orange / red). Plumbed through so the new
     *  "Simulated Max ρ" column matches the rest of the UI. */
    monitoringFactor: number;
    /** Resolve a pypowsybl element ID to its human-readable display
     *  name. Used by the "Simulated Line" column so the operator
     *  sees the friendly substation pair (e.g. ``BEON L31CPVAN``)
     *  instead of the raw element identifier. Falls back to the ID. */
    displayName?: (id: string) => string;
    /** When true, render as a wide centered overlay (mirroring the
     *  Combine Actions modal layout) so the score table has room for
     *  its action ID, MW Start and Score columns. Used when scoring
     *  data is available after running an analysis. */
    wide?: boolean;
    /** Optional dismiss handler. When provided AND ``wide`` is on,
     *  the modal renders a header row with a "Manual Selection"
     *  title + ✕ close button — matching the Combine Actions modal
     *  layout. Required for the multi-simulation flow where the
     *  modal is no longer auto-dismissed on each row click. */
    onClose?: () => void;
}

const ActionSearchDropdown: React.FC<ActionSearchDropdownProps> = ({
    dropdownRef,
    searchInputRef,
    searchQuery,
    onSearchQueryChange,
    filters,
    onFiltersChange,
    error,
    loadingActions,
    scoredActionsList,
    filteredActions,
    actionScores,
    actions,
    cardEditMw,
    onCardEditMwChange,
    cardEditTap,
    onCardEditTapChange,
    simulating,
    resimulating,
    onAddAction,
    onResimulate,
    onResimulateTap,
    onShowTooltip,
    onHideTooltip,
    monitoringFactor,
    displayName = (id: string) => id,
    wide = false,
    onClose,
}) => {
    const dropdownStyle: React.CSSProperties = wide
        ? {
            // Anchor the top to a fixed viewport offset (instead of
            // centering on 50% with translateY(-50%)) so the title +
            // search input + filter row stay at the same screen
            // height as the body grows or shrinks with the chip
            // filter — the previous translate-centered layout made
            // the whole modal hop vertically every time the score
            // table count changed.
            position: 'fixed',
            top: '7.5vh',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '80vw',
            maxWidth: '80vw',
            maxHeight: '85vh',
            zIndex: 10000,
            backgroundColor: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: '12px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
        }
        : {
            position: 'absolute',
            top: '100%',
            right: 0,
            left: 0,
            zIndex: 100,
            backgroundColor: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            marginTop: '4px',
            overflow: 'hidden',
        };
    const listStyle: React.CSSProperties = wide
        ? { flex: 1, overflowY: 'auto', minHeight: 0 }
        : { maxHeight: '250px', overflowY: 'auto' };
    return (
        <>
            {wide && (
                <div
                    data-testid="manual-selection-backdrop"
                    style={{
                        position: 'fixed',
                        top: 0, left: 0, right: 0, bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.5)',
                        zIndex: 9999,
                    }}
                />
            )}
            <div
                ref={dropdownRef}
                data-testid={wide ? 'manual-selection-wide' : 'manual-selection-dropdown'}
                style={dropdownStyle}
            >
            {wide && onClose && (
                <div style={{
                    padding: '15px 24px',
                    borderBottom: `1px solid ${colors.borderSubtle}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: colors.surfaceRaised,
                }}>
                    <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Manual Selection</h2>
                    <button
                        data-testid="manual-selection-close"
                        onClick={onClose}
                        style={{
                            border: 'none',
                            background: 'none',
                            fontSize: '24px',
                            cursor: 'pointer',
                            color: colors.textTertiary,
                        }}
                        aria-label="Close manual selection"
                    >&times;</button>
                </div>
            )}
            <div style={{ padding: '8px' }}>
                <input
                    ref={searchInputRef}
                    type="text"
                    placeholder="Search action by ID or description..."
                    value={searchQuery}
                    onChange={(e) => onSearchQueryChange(e.target.value)}
                    style={{
                        width: '100%',
                        padding: '6px 10px',
                        border: `1px solid ${colors.border}`,
                        borderRadius: '4px',
                        fontSize: '13px',
                        boxSizing: 'border-box',
                    }}
                />
            </div>
            <div style={{ padding: '6px 8px', borderTop: `1px solid ${colors.borderSubtle}` }}>
                <ActionFilterRings filters={filters} onFiltersChange={onFiltersChange} />
            </div>
            {error && (
                <div style={{
                    padding: '6px 8px',
                    fontSize: '12px',
                    color: colors.danger,
                    borderTop: `1px solid ${colors.borderSubtle}`,
                }}>
                    {error}
                </div>
            )}
            <div style={listStyle}>
                {loadingActions ? (
                    <div style={{ padding: '10px', textAlign: 'center', color: colors.textTertiary, fontSize: '13px' }}>
                        Loading actions...
                    </div>
                ) : (
                    <>
                        {/* Action Scores Table */}
                        {scoredActionsList.length > 0 && !searchQuery && (
                            <ScoreTable
                                scoredActionsList={scoredActionsList}
                                actionScores={actionScores}
                                actions={actions}
                                cardEditMw={cardEditMw}
                                onCardEditMwChange={onCardEditMwChange}
                                cardEditTap={cardEditTap}
                                onCardEditTapChange={onCardEditTapChange}
                                simulating={simulating}
                                resimulating={resimulating}
                                onAddAction={onAddAction}
                                onResimulate={onResimulate}
                                onResimulateTap={onResimulateTap}
                                onShowTooltip={onShowTooltip}
                                onHideTooltip={onHideTooltip}
                                monitoringFactor={monitoringFactor}
                                displayName={displayName}
                            />
                        )}

                        {/* No-relevant-action warning: analysis ran
                            (actionScores present) but the selected type
                            filter yields zero scored actions, so we fall
                            back to the full network action list below.
                            The banner tells the operator that nothing from
                            the analysis recommends actions of this type. */}
                        {!searchQuery
                            && scoredActionsList.length === 0
                            && filters.actionType !== 'all'
                            && !!actionScores
                            && Object.values(actionScores).some(d =>
                                d && typeof d === 'object'
                                && Object.keys((d as { scores?: Record<string, number> }).scores ?? {}).length > 0
                            ) && (
                            <div
                                data-testid="no-relevant-action-warning"
                                style={{
                                    margin: '6px 8px',
                                    padding: '6px 8px',
                                    background: colors.warningSoft,
                                    border: `1px solid ${colors.warningBorder}`,
                                    borderRadius: 4,
                                    color: colors.warningText,
                                    fontSize: 12,
                                    lineHeight: 1.35,
                                }}
                            >
                                ⚠️ Warning: no relevant action detected with regards to overflow analysis
                            </div>
                        )}

                        {/* Search Results */}
                        {(!searchQuery && scoredActionsList.length === 0 && filteredActions.length === 0) && (
                            <div style={{ padding: '10px', textAlign: 'center', color: colors.textTertiary, fontSize: '13px' }}>
                                All actions already added
                            </div>
                        )}
                        {searchQuery && !filteredActions.some(a => a.id === searchQuery) && (
                            <div
                                data-testid={`manual-id-option-${searchQuery}`}
                                onClick={() => onAddAction(searchQuery)}
                                style={{
                                    padding: '8px 10px',
                                    cursor: simulating ? 'wait' : 'pointer',
                                    borderTop: `1px solid ${colors.borderSubtle}`,
                                    backgroundColor: colors.surfaceMuted,
                                    color: colors.brand,
                                    fontSize: '12px',
                                    fontWeight: 600,
                                }}
                                onMouseEnter={(e) => (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.brandSoft}
                                onMouseLeave={(e) => (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.surfaceMuted}
                            >
                                ✨ Simulate manual ID: <strong>{searchQuery}</strong>
                            </div>
                        )}
                        {(searchQuery && filteredActions.length === 0 && searchQuery !== (filteredActions[0]?.id)) && (
                            <div style={{ padding: '10px', textAlign: 'center', color: colors.textTertiary, fontSize: '13px' }}>
                                No other matching actions
                            </div>
                        )}
                        {((!searchQuery && scoredActionsList.length === 0) || searchQuery) && filteredActions.map(a => (
                            <div
                                key={a.id}
                                data-testid={`action-card-${a.id}`}
                                onClick={() => onAddAction(a.id)}
                                style={{
                                    padding: '6px 10px',
                                    cursor: simulating ? 'wait' : 'pointer',
                                    borderTop: `1px solid ${colors.borderSubtle}`,
                                    backgroundColor: simulating === a.id ? colors.brandSoft : 'transparent',
                                    opacity: simulating && simulating !== a.id ? 0.5 : 1,
                                }}
                                onMouseEnter={(e) => { if (!simulating) (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.surfaceMuted; }}
                                onMouseLeave={(e) => { if (simulating !== a.id) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
                            >
                                <div style={{ fontWeight: 600, fontSize: '12px', color: colors.textPrimary }}>
                                    {simulating === a.id ? 'Simulating...' : a.id}
                                </div>
                                {a.description && (
                                    <div style={{ fontSize: '11px', color: colors.textTertiary, marginTop: '2px' }}>
                                        {a.description}
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}
            </div>
            </div>
        </>
    );
};

// --- ScoreTable subcomponent ---

interface ScoreTableProps {
    scoredActionsList: ScoredActionItem[];
    actionScores: Record<string, Record<string, unknown>> | undefined;
    actions: Record<string, ActionDetail>;
    cardEditMw: Record<string, string>;
    onCardEditMwChange: (actionId: string, value: string) => void;
    cardEditTap: Record<string, string>;
    onCardEditTapChange: (actionId: string, value: string) => void;
    simulating: string | null;
    resimulating: string | null;
    onAddAction: (actionId: string, targetMw?: number, targetTap?: number) => void;
    onResimulate: (actionId: string, newMw: number) => void;
    onResimulateTap: (actionId: string, newTap: number) => void;
    onShowTooltip: (e: React.MouseEvent, content: React.ReactNode) => void;
    onHideTooltip: () => void;
    monitoringFactor: number;
    displayName: (id: string) => string;
}

const ScoreTable: React.FC<ScoreTableProps> = ({
    scoredActionsList,
    actionScores,
    actions,
    cardEditMw,
    onCardEditMwChange,
    cardEditTap,
    onCardEditTapChange,
    simulating,
    resimulating,
    onAddAction,
    onResimulate,
    onResimulateTap,
    onShowTooltip,
    onHideTooltip,
    monitoringFactor,
    displayName,
}) => {
    return (
        <div style={{ padding: '0 8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '4px' }}>
                Scored Actions
            </div>
            {Array.from(new Set(scoredActionsList.map(item => item.type))).map(type => {
                const typeData = (actionScores?.[type] || {}) as {
                    scores?: Record<string, number>;
                    params?: Record<string, Record<string, unknown>>;
                    non_convergence?: Record<string, string | null>;
                };
                const scoresKeys = Object.keys(typeData.scores || {});
                const paramsKeys = Object.keys(typeData.params || {});
                const isPerActionParams = paramsKeys.length > 0 && paramsKeys.some((k: string) => scoresKeys.includes(k));
                const globalParams = isPerActionParams ? null : (paramsKeys.length > 0 ? typeData.params : null);

                const isLsOrRcType = type === 'load_shedding' || type.includes('load_shedding') || type === 'renewable_curtailment' || type.includes('renewable_curtailment');
                const isPstType = type === 'pst_tap_change' || type.includes('pst');
                // Redispatch edits a SIGNED delta (raise > 0 / lower < 0) rather
                // than an absolute target, so it gets its own editable column
                // distinct from the load-shedding / curtailment "Target MW" one.
                const isRedispatchType = type === 'redispatch' || type.includes('redispatch');
                const hasEditableColumn = isLsOrRcType || isPstType || isRedispatchType;
                const tapStartMap = isPstType ? (typeData as { tap_start?: Record<string, { pst_name: string; tap: number; low_tap: number | null; high_tap: number | null } | null> }).tap_start : undefined;
                return (
                    <div key={type} style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.brandStrong, backgroundColor: colors.surfaceMuted, padding: '2px 6px', borderRadius: '4px 4px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>{type.replace('_', ' ').toUpperCase()}</span>
                            {globalParams && (
                                <span
                                    style={{ color: colors.textSecondary, fontSize: '12px', cursor: 'help', marginLeft: '6px' }}
                                    onMouseEnter={(e) => onShowTooltip(e, (
                                        <>
                                            <div style={{ fontWeight: 700, marginBottom: '2px', borderBottom: `1px solid ${colors.textSecondary}`, paddingBottom: '2px' }}>Scoring Parameters</div>
                                            {Object.entries(globalParams).map(([k, v]) => (
                                                <div key={k}>
                                                    <span style={{ color: colors.textTertiary }}>{k}:</span> {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                                                </div>
                                            ))}
                                        </>
                                    ))}
                                    onMouseLeave={onHideTooltip}
                                >i</span>
                            )}
                        </div>
                        <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', border: `1px solid ${colors.border}`, borderTop: 'none' }}>
                            <thead>
                                <tr style={{ background: colors.surfaceMuted, borderBottom: `1px solid ${colors.border}` }}>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', width: hasEditableColumn ? '24%' : '34%' }}>Action</th>
                                    {/* Score sits in column 2 so the operator's eye reaches the
                                        ranking before any of the per-row inputs / simulation
                                        outputs — mirrors the prioritised-actions card layout. */}
                                    <th style={{ textAlign: 'right', padding: '4px 6px', width: '10%' }}>Score</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', width: '10%' }}>{isPstType ? 'Tap Start' : 'MW Start'}</th>
                                    {isLsOrRcType && <th style={{ textAlign: 'right', padding: '4px 6px', width: '12%' }}>Target MW</th>}
                                    {isRedispatchType && <th style={{ textAlign: 'right', padding: '4px 6px', width: '12%' }} title="Signed redispatch increment (MW): raise > 0, lower < 0.">Δ MW</th>}
                                    {isPstType && <th style={{ textAlign: 'right', padding: '4px 6px', width: '12%' }}>Target Tap</th>}
                                    <th
                                        style={{ textAlign: 'right', padding: '4px 6px', width: '16%' }}
                                        title="Max ρ on the contingency's overloads after this action has been simulated (dash when not yet simulated)."
                                    >Simulated Max ρ</th>
                                    <th
                                        style={{ textAlign: 'left', padding: '4px 6px', width: hasEditableColumn ? '28%' : '30%' }}
                                        title="Branch carrying Max ρ in the post-action state — friendly pypowsybl name when available."
                                    >Simulated Line</th>
                                </tr>
                            </thead>
                            <tbody>
                                {scoredActionsList.filter(item => item.type === type).map(item => {
                                    const isComputed = !!actions[item.actionId];
                                    // Stored MW from an already-simulated LS/RC action (used as default input value).
                                    const storedMw = isLsOrRcType && isComputed
                                        ? (actions[item.actionId]?.load_shedding_details?.[0]?.shedded_mw
                                            ?? actions[item.actionId]?.curtailment_details?.[0]?.curtailed_mw
                                            ?? null)
                                        : null;
                                    // Displayed value: user edit takes precedence, otherwise the stored simulated MW.
                                    const mwEditVal = cardEditMw[item.actionId];
                                    const effectiveMwStr = mwEditVal
                                        ?? (storedMw != null ? storedMw.toFixed(1) : '');
                                    const parsedTarget = effectiveMwStr !== '' ? parseFloat(effectiveMwStr) : null;
                                    const isValidTarget = parsedTarget !== null && !isNaN(parsedTarget) && parsedTarget >= 0 && (item.mwStart == null || parsedTarget <= item.mwStart);
                                    // Only re-simulate if the user has actually edited the value and it differs from the stored one.
                                    const userEditedMw = mwEditVal !== undefined && (storedMw == null || parseFloat(mwEditVal) !== storedMw);
                                    const canResimulate = isLsOrRcType && isComputed && isValidTarget && userEditedMw;
                                    // Redispatch: the editable value is the SIGNED delta (raise > 0 /
                                    // lower < 0), defaulting to the simulated delta_mw and bounded by
                                    // the generator's headroom in its current direction — mirrors the
                                    // action card's redispatch editor.
                                    const rdDetail = isRedispatchType && isComputed ? actions[item.actionId]?.redispatch_details?.[0] : undefined;
                                    const storedDelta = rdDetail?.delta_mw ?? null;
                                    const effectiveDeltaStr = mwEditVal ?? (storedDelta != null ? storedDelta.toFixed(1) : '');
                                    const parsedDelta = effectiveDeltaStr !== '' ? parseFloat(effectiveDeltaStr) : null;
                                    const rdMinDelta = rdDetail ? (rdDetail.direction === 'up' ? 0 : (rdDetail.max_lower_mw != null ? -rdDetail.max_lower_mw : undefined)) : undefined;
                                    const rdMaxDelta = rdDetail ? (rdDetail.direction === 'up' ? (rdDetail.max_raise_mw ?? undefined) : 0) : undefined;
                                    const isValidDelta = parsedDelta !== null && !isNaN(parsedDelta)
                                        && (rdMinDelta == null || parsedDelta >= rdMinDelta)
                                        && (rdMaxDelta == null || parsedDelta <= rdMaxDelta);
                                    const userEditedDelta = mwEditVal !== undefined && (storedDelta == null || parseFloat(mwEditVal) !== storedDelta);
                                    const canResimulateRd = isRedispatchType && isComputed && isValidDelta && userEditedDelta;
                                    const actionParams = isPstType ? typeData.params?.[item.actionId] : undefined;
                                    const previousTap = actionParams
                                        ? (actionParams['previous tap'] ?? actionParams['previous_tap'] ?? actionParams['previousTap'] ??
                                           Object.entries(actionParams).find(([k]) => k.toLowerCase().includes('previous') && k.toLowerCase().includes('tap'))?.[1]
                                          ) as number | undefined
                                        : undefined;
                                    const tapStartEntry = isPstType ? tapStartMap?.[item.actionId] ?? null : undefined;
                                    const computedPst = isPstType ? actions[item.actionId]?.pst_details?.[0] : undefined;
                                    const tapInfo = isPstType
                                        ? (previousTap !== undefined
                                            ? {
                                                pst_name: tapStartEntry?.pst_name ?? computedPst?.pst_name ?? '',
                                                tap: previousTap,
                                                low_tap: tapStartEntry?.low_tap ?? computedPst?.low_tap ?? null,
                                                high_tap: tapStartEntry?.high_tap ?? computedPst?.high_tap ?? null,
                                            }
                                            : tapStartEntry
                                                ? tapStartEntry
                                                : computedPst
                                                    ? { pst_name: computedPst.pst_name, tap: computedPst.tap_position, low_tap: computedPst.low_tap, high_tap: computedPst.high_tap }
                                                    : null)
                                        : undefined;
                                    const tapEditVal = cardEditTap[item.actionId];
                                    const simulatedTap = computedPst ? String(computedPst.tap_position) : undefined;
                                    const defaultTap = simulatedTap ?? (tapInfo ? String(tapInfo.tap) : undefined);
                                    const effectiveTap = tapEditVal ?? defaultTap;
                                    const parsedTap = effectiveTap !== undefined ? parseInt(effectiveTap, 10) : null;
                                    const isValidTap = parsedTap !== null && !isNaN(parsedTap) && (tapInfo?.low_tap == null || parsedTap >= tapInfo.low_tap) && (tapInfo?.high_tap == null || parsedTap <= tapInfo.high_tap);
                                    const canResimTap = isPstType && isComputed && isValidTap;
                                    return (
                                        <tr key={item.actionId}
                                            onClick={() => {
                                                if (simulating || resimulating) return;
                                                if (canResimulate) {
                                                    onResimulate(item.actionId, parsedTarget!);
                                                    return;
                                                }
                                                if (canResimulateRd) {
                                                    onResimulate(item.actionId, parsedDelta!);
                                                    return;
                                                }
                                                if (canResimTap) {
                                                    onResimulateTap(item.actionId, parsedTap!);
                                                    return;
                                                }
                                                if (isComputed) return;
                                                const mw = isLsOrRcType && isValidTarget ? parsedTarget!
                                                    : isRedispatchType && isValidDelta ? parsedDelta!
                                                        : undefined;
                                                const tap = isPstType && isValidTap ? parsedTap! : undefined;
                                                onAddAction(item.actionId, mw, tap);
                                            }}
                                            style={{
                                                borderBottom: `1px solid ${colors.borderSubtle}`,
                                                cursor: (simulating || resimulating) ? 'wait' : (isComputed && !canResimulate && !canResimulateRd && !canResimTap) ? 'not-allowed' : 'pointer',
                                                color: (isComputed && !canResimulate && !canResimulateRd && !canResimTap) ? colors.textTertiary : 'inherit',
                                                opacity: (simulating === item.actionId || resimulating === item.actionId) ? 0.7 : 1,
                                                background: (simulating === item.actionId || resimulating === item.actionId) ? colors.brandSoft : 'transparent',
                                            }}>
                                            <td style={{ padding: '4px 6px', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                                                {item.actionId}
                                                {isComputed && (
                                                    actions[item.actionId]?.non_convergence ? (
                                                        <span data-testid={`badge-divergent-${item.actionId}`} style={{ marginLeft: '4px', background: colors.danger, color: colors.textOnBrand, padding: '2px 4px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold' }} title={actions[item.actionId].non_convergence || undefined}>divergent</span>
                                                    ) : actions[item.actionId]?.is_islanded ? (
                                                        <span data-testid={`badge-islanded-${item.actionId}`} style={{ marginLeft: '4px', background: colors.danger, color: colors.textOnBrand, padding: '2px 4px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold' }} title={`Islanding detected: ${actions[item.actionId].disconnected_mw?.toFixed(1)} MW disconnected`}>islanded</span>
                                                    ) : (
                                                        <span data-testid={`badge-computed-${item.actionId}`} style={{ marginLeft: '4px', background: colors.success, color: colors.textOnBrand, padding: '2px 4px', borderRadius: '4px', fontSize: '9px', opacity: 0.8 }}>computed</span>
                                                    )
                                                )}
                                                {isPerActionParams && typeData.params?.[item.actionId] && (
                                                    <span
                                                        style={{ color: colors.textSecondary, fontSize: '12px', cursor: 'help', marginLeft: '6px' }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onMouseEnter={(e) => onShowTooltip(e, (
                                                            <>
                                                                <div style={{ fontWeight: 700, marginBottom: '2px', borderBottom: `1px solid ${colors.textSecondary}`, paddingBottom: '2px' }}>Parameters</div>
                                                                {typeData.non_convergence?.[item.actionId] && (
                                                                    <div style={{ fontSize: '10px', color: colors.danger }}>
                                                                        Non-convergence: {typeData.non_convergence[item.actionId]}
                                                                    </div>
                                                                )}
                                                                {(actions[item.actionId]?.is_islanded) && (
                                                                    <div style={{ fontSize: '10px', color: colors.warningText }}>
                                                                        Islanding: {actions[item.actionId].n_components} components
                                                                    </div>
                                                                )}
                                                                {Object.entries(typeData.params![item.actionId]).map(([k, v]) => {
                                                                    const isTargetTapKey = isPstType && (k === 'selected_pst_tap' || k.toLowerCase().includes('target') && k.toLowerCase().includes('tap'));
                                                                    const displayVal = isTargetTapKey && effectiveTap !== undefined ? effectiveTap : (typeof v === 'object' ? JSON.stringify(v) : String(v));
                                                                    return (
                                                                        <div key={k}>
                                                                            <span style={{ color: colors.textTertiary }}>{k}:</span> {displayVal}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </>
                                                        ))}
                                                        onMouseLeave={onHideTooltip}
                                                    >i</span>
                                                )}
                                            </td>
                                            <td
                                                data-testid={`score-${item.actionId}`}
                                                style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace' }}
                                            >
                                                {item.score.toFixed(2)}
                                            </td>
                                            <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: (isPstType ? tapInfo == null : item.mwStart == null) ? colors.textTertiary : colors.textPrimary }}>
                                                {isPstType
                                                    ? (tapInfo != null ? `${tapInfo.tap}` : 'N/A')
                                                    : (item.mwStart != null ? item.mwStart.toFixed(1) : 'N/A')
                                                }
                                                {isPstType && tapInfo?.low_tap != null && tapInfo?.high_tap != null && (
                                                    <span style={{ fontSize: '9px', color: colors.accent, marginLeft: '2px' }}>
                                                        [{tapInfo.low_tap}..{tapInfo.high_tap}]
                                                    </span>
                                                )}
                                            </td>
                                            {isLsOrRcType && (
                                                <td style={{ padding: '2px 4px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        data-testid={`target-mw-${item.actionId}`}
                                                        type="number"
                                                        min={0}
                                                        max={item.mwStart ?? undefined}
                                                        step={0.1}
                                                        placeholder={item.mwStart != null ? item.mwStart.toFixed(1) : '0'}
                                                        value={effectiveMwStr}
                                                        onChange={(e) => onCardEditMwChange(item.actionId, e.target.value)}
                                                        style={{
                                                            width: '60px',
                                                            fontSize: '11px',
                                                            fontFamily: 'monospace',
                                                            padding: '2px 4px',
                                                            border: `1px solid ${colors.border}`,
                                                            borderRadius: '3px',
                                                            textAlign: 'right',
                                                        }}
                                                    />
                                                </td>
                                            )}
                                            {isRedispatchType && (
                                                <td style={{ padding: '2px 4px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        data-testid={`delta-mw-${item.actionId}`}
                                                        type="number"
                                                        min={rdMinDelta}
                                                        max={rdMaxDelta}
                                                        step={0.1}
                                                        placeholder="Δ"
                                                        value={effectiveDeltaStr}
                                                        onChange={(e) => onCardEditMwChange(item.actionId, e.target.value)}
                                                        title={rdDetail ? `Max ${rdDetail.direction === 'up' ? 'raise' : 'lower'}: ${(rdDetail.direction === 'up' ? rdDetail.max_raise_mw : rdDetail.max_lower_mw)?.toFixed(0) ?? '—'} MW` : undefined}
                                                        style={{
                                                            width: '60px',
                                                            fontSize: '11px',
                                                            fontFamily: 'monospace',
                                                            padding: '2px 4px',
                                                            border: `1px solid ${colors.info}`,
                                                            borderRadius: '3px',
                                                            textAlign: 'right',
                                                        }}
                                                    />
                                                </td>
                                            )}
                                            {isPstType && (
                                                <td style={{ padding: '2px 4px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        data-testid={`target-tap-${item.actionId}`}
                                                        type="number"
                                                        min={tapInfo?.low_tap ?? undefined}
                                                        max={tapInfo?.high_tap ?? undefined}
                                                        step={1}
                                                        value={cardEditTap[item.actionId] ?? (simulatedTap ?? (tapInfo ? String(tapInfo.tap) : ''))}
                                                        onChange={(e) => onCardEditTapChange(item.actionId, e.target.value)}
                                                        style={{
                                                            width: '50px',
                                                            fontSize: '11px',
                                                            fontFamily: 'monospace',
                                                            padding: '2px 4px',
                                                            border: `1px solid ${colors.accent}`,
                                                            borderRadius: '3px',
                                                            textAlign: 'right',
                                                        }}
                                                    />
                                                </td>
                                            )}
                                            <SimulatedMaxRhoCell
                                                actionId={item.actionId}
                                                detail={isComputed ? actions[item.actionId] : null}
                                                monitoringFactor={monitoringFactor}
                                            />
                                            <SimulatedLineCell
                                                actionId={item.actionId}
                                                detail={isComputed ? actions[item.actionId] : null}
                                                displayName={displayName}
                                            />
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                );
            })}
        </div>
    );
};

// --- SimulatedMaxRhoCell ---
//
// Renders the "Simulated Max ρ" column for a single score-table row.
// Once the action has been simulated (``detail`` non-null), shows the
// max-ρ percentage colour-coded against ``monitoringFactor`` with the
// same green / orange / red severity rule the ActionCard severity
// stripe uses (see ``components/ActionCard.tsx``: > mf → red, > mf
// - 0.05 → orange, otherwise → green). Surfaces ``max_rho_line`` as
// a native title tooltip so the operator can identify which line
// drove the loading without leaving the modal. Non-convergent and
// islanded simulations render the matching warning glyph instead of
// a numeric value.

interface SimulatedMaxRhoCellProps {
    actionId: string;
    detail: ActionDetail | null;
    monitoringFactor: number;
}

const SimulatedMaxRhoCell: React.FC<SimulatedMaxRhoCellProps> = ({ actionId, detail, monitoringFactor }) => {
    if (!detail) {
        return (
            <td
                data-testid={`sim-max-rho-${actionId}`}
                data-state="pending"
                style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.textTertiary }}
            >—</td>
        );
    }
    if (detail.non_convergence) {
        return (
            <td
                data-testid={`sim-max-rho-${actionId}`}
                data-state="divergent"
                title={detail.non_convergence || undefined}
                style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.danger, fontWeight: 600 }}
            >divergent</td>
        );
    }
    if (detail.is_islanded) {
        return (
            <td
                data-testid={`sim-max-rho-${actionId}`}
                data-state="islanded"
                title={detail.disconnected_mw != null ? `Islanded — ${detail.disconnected_mw.toFixed(1)} MW disconnected` : 'Islanded'}
                style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.danger, fontWeight: 600 }}
            >islanded</td>
        );
    }
    const maxRho = detail.max_rho;
    if (maxRho == null) {
        return (
            <td
                data-testid={`sim-max-rho-${actionId}`}
                data-state="pending"
                style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: colors.textTertiary }}
            >—</td>
        );
    }
    const severity =
        maxRho > monitoringFactor ? 'red'
            : maxRho > monitoringFactor - 0.05 ? 'orange'
                : 'green';
    const severityColor = severity === 'red' ? colors.danger
        : severity === 'orange' ? colors.warningStrong
            : colors.success;
    return (
        <td
            data-testid={`sim-max-rho-${actionId}`}
            data-state={severity}
            title={detail.max_rho_line ? `Max ρ on ${detail.max_rho_line}` : undefined}
            style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'monospace', color: severityColor, fontWeight: 600 }}
        >
            {(maxRho * 100).toFixed(1)}%
        </td>
    );
};

// --- SimulatedLineCell ---
//
// Renders the "Simulated Line" column — the branch carrying max ρ on
// the post-action observation. Mirrors the ``ComputedPairsTable``
// column of the same name so the manual-selection modal carries the
// same vocabulary the operator already learned in the Combined
// Actions modal. Resolved through ``displayName`` so the friendly
// pypowsybl substation-pair label appears whenever the ID is keyed
// in the name map. Renders a dash for pending / divergent /
// islanded rows where the post-action max-ρ branch is not
// meaningful (the load-flow either didn't converge or the action
// disconnected part of the grid).

interface SimulatedLineCellProps {
    actionId: string;
    detail: ActionDetail | null;
    displayName: (id: string) => string;
}

const SimulatedLineCell: React.FC<SimulatedLineCellProps> = ({ actionId, detail, displayName }) => {
    const placeholderStyle: React.CSSProperties = {
        padding: '4px 6px',
        textAlign: 'left',
        color: colors.textTertiary,
        fontStyle: 'italic',
    };
    if (!detail) {
        return (
            <td data-testid={`sim-line-${actionId}`} data-state="pending" style={placeholderStyle}>—</td>
        );
    }
    if (detail.non_convergence || detail.is_islanded) {
        return (
            <td data-testid={`sim-line-${actionId}`} data-state="unavailable" style={placeholderStyle}>—</td>
        );
    }
    const line = detail.max_rho_line;
    if (!line || line === 'N/A') {
        return (
            <td data-testid={`sim-line-${actionId}`} data-state="pending" style={placeholderStyle}>—</td>
        );
    }
    return (
        <td
            data-testid={`sim-line-${actionId}`}
            data-state="resolved"
            title={line}
            style={{
                padding: '4px 6px',
                textAlign: 'left',
                fontWeight: 600,
                color: colors.textPrimary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 0,
            }}
        >
            {displayName(line)}
        </td>
    );
};

export default ActionSearchDropdown;
