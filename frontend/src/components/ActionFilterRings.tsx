// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useCallback, useEffect, useRef } from 'react';
import type { ActionOverviewFilters, ActionSeverityCategory } from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import { colors, pinColorVars, space } from '../styles/tokens';
import { ACTION_TYPE_LABELS, type ActionTypeKind } from '../utils/actionTypes';
import { SeverityIcon, type SeverityKind } from './SeverityIcon';
import { ActionTypeIcon } from './ActionTypeIcon';

/**
 * Two compact icon "rings" for the sidebar's persistent strip:
 *
 *  - the SEVERITY ring — colour-coded pictograms (one per outcome
 *    bucket: solved / low-margin / still-overloaded / divergent).
 *    Single-click "solos" the bucket (enables only that outcome) and
 *    single-clicking the soloed bucket again restores the full set;
 *    double-click toggles one bucket on/off without touching the others.
 *  - the ACTION-TYPE ring — uncoloured pictograms (disco / reco /
 *    open / close / ls / rc / pst). Single-select; re-clicking the
 *    active one clears back to `all`.
 *
 * Both drive the SAME shared `ActionOverviewFilters` object the
 * Remedial-Action overview header already owns, so the sidebar feed
 * and the overview diagram stay in lock-step. The pictogram-only
 * styling keeps the whole control to one short row that tucks in
 * beside the Notices pill.
 */

const SEVERITY_RING: ReadonlyArray<{ cat: ActionSeverityCategory; kind: SeverityKind; label: string }> = [
    { cat: 'green', kind: 'solves', label: 'Solves overload' },
    { cat: 'orange', kind: 'lowMargin', label: 'Low margin' },
    { cat: 'red', kind: 'unsolved', label: 'Still overloaded' },
    { cat: 'grey', kind: 'divergent', label: 'Divergent / islanded' },
];

const ALL_CATEGORIES: ReadonlyArray<ActionSeverityCategory> = ['green', 'orange', 'red', 'grey'];

const TYPE_RING: ReadonlyArray<ActionTypeKind> = ['disco', 'reco', 'open', 'close', 'ls', 'rc', 'pst'];

const TOGGLE_SIZE = 22;

// Window within which a second click on the SAME severity toggle is
// read as a double-click ("solo") rather than two independent toggles.
const DOUBLE_CLICK_MS = 220;

const toggleBase: React.CSSProperties = {
    width: TOGGLE_SIZE,
    height: TOGGLE_SIZE,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: '50%',
    cursor: 'pointer',
    flexShrink: 0,
    lineHeight: 0,
    userSelect: 'none',
    transition: 'all 0.15s ease',
};

const allCategoriesOn = (): Record<ActionSeverityCategory, boolean> =>
    ({ green: true, orange: true, red: true, grey: true });

const isSoloOn = (
    categories: Record<ActionSeverityCategory, boolean>,
    cat: ActionSeverityCategory,
): boolean => categories[cat] && ALL_CATEGORIES.every(c => (c === cat ? categories[c] : !categories[c]));

interface ActionFilterRingsProps {
    filters: ActionOverviewFilters;
    onFiltersChange: (next: ActionOverviewFilters) => void;
}

const ActionFilterRings: React.FC<ActionFilterRingsProps> = ({ filters, onFiltersChange }) => {
    // Keep the freshest filters reachable from the deferred single-click
    // timer callback so back-to-back toggles on different categories
    // compose instead of clobbering each other. The ref is synced in an
    // effect (not during render) — the timer fires ~one frame later, so
    // the committed value is always available by then.
    const filtersRef = useRef(filters);
    useEffect(() => { filtersRef.current = filters; }, [filters]);

    const clickTimers = useRef<Map<ActionSeverityCategory, ReturnType<typeof setTimeout>>>(new Map());
    useEffect(() => {
        const timers = clickTimers.current;
        return () => {
            timers.forEach(t => clearTimeout(t));
            timers.clear();
        };
    }, []);

    const toggleCategory = useCallback((cat: ActionSeverityCategory) => {
        const f = filtersRef.current;
        const enabled = !f.categories[cat];
        interactionLogger.record('overview_filter_changed', { kind: 'category', category: cat, enabled });
        onFiltersChange({ ...f, categories: { ...f.categories, [cat]: enabled } });
    }, [onFiltersChange]);

    const soloCategory = useCallback((cat: ActionSeverityCategory) => {
        const f = filtersRef.current;
        // Double-click flips between "only this outcome" and "all
        // outcomes": when the category is already the sole enabled
        // one, restore the full set, otherwise isolate it.
        const restore = isSoloOn(f.categories, cat);
        const categories = restore
            ? allCategoriesOn()
            : { green: cat === 'green', orange: cat === 'orange', red: cat === 'red', grey: cat === 'grey' };
        // No `solo` flag in the payload — isolate-vs-restore is derived
        // from the current category state, so the double-clicked
        // `category` is the only replay input the contract needs.
        interactionLogger.record('overview_filter_changed', { kind: 'category_solo', category: cat });
        onFiltersChange({ ...f, categories });
    }, [onFiltersChange]);

    // Single-click solos one bucket (or restores all if it is already
    // the lone enabled one); double-click toggles the bucket on/off
    // without touching the others. The single-click action is deferred
    // by one double-click window so a double-click does not also fire
    // a stray solo first.
    const handleCategoryClick = useCallback((cat: ActionSeverityCategory) => {
        const timers = clickTimers.current;
        const pending = timers.get(cat);
        if (pending !== undefined) {
            clearTimeout(pending);
            timers.delete(cat);
            toggleCategory(cat);
            return;
        }
        const timer = setTimeout(() => {
            timers.delete(cat);
            soloCategory(cat);
        }, DOUBLE_CLICK_MS);
        timers.set(cat, timer);
    }, [soloCategory, toggleCategory]);

    const selectType = useCallback((token: ActionTypeKind) => {
        // Single-select with toggle-off: re-clicking the active type
        // clears back to `all` so the operator always has an obvious
        // "show everything" gesture without a dedicated ALL chip.
        const next = filters.actionType === token ? 'all' : token;
        interactionLogger.record('overview_filter_changed', { kind: 'action_type', action_type: next });
        onFiltersChange({ ...filters, actionType: next });
    }, [filters, onFiltersChange]);

    const setThreshold = useCallback((thresholdPct: number) => {
        const clamped = Math.max(0, Math.min(300, thresholdPct));
        const next = clamped / 100;
        interactionLogger.record('overview_filter_changed', { kind: 'threshold', threshold: next });
        onFiltersChange({ ...filters, threshold: next });
    }, [filters, onFiltersChange]);

    return (
        <div
            data-testid="sidebar-action-filters"
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space[1] }}
        >
            {/* Pin glyph + dash separator — replaces the textual
                "Actions:" label so the whole filter bar fits a
                single sidebar row. The "Actions filters" wording
                moved into the title tooltip so the meaning is still
                one hover away. */}
            <span
                title="Actions filters"
                aria-label="Actions filters"
                style={{
                    color: colors.textSecondary,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    flexShrink: 0,
                }}
            >
                <span aria-hidden>{'📍'}</span>
                <span aria-hidden style={{ color: colors.textTertiary }}>–</span>
            </span>
            <div role="group" aria-label="Filter actions by outcome" style={{ display: 'flex', gap: space.half }}>
                {SEVERITY_RING.map(({ cat, kind, label }) => {
                    const enabled = filters.categories[cat];
                    const tint = pinColorVars[cat];
                    return (
                        <button
                            key={cat}
                            type="button"
                            data-testid={`sidebar-filter-category-${cat}`}
                            aria-pressed={enabled}
                            title={`${label} — click to isolate, double-click to ${enabled ? 'hide' : 'show'}`}
                            onClick={() => handleCategoryClick(cat)}
                            style={{
                                ...toggleBase,
                                border: `1.5px solid ${enabled ? tint : colors.border}`,
                                background: enabled ? colors.surface : colors.surfaceMuted,
                                color: enabled ? tint : colors.textTertiary,
                                opacity: enabled ? 1 : 0.55,
                            }}
                        >
                            <SeverityIcon kind={kind} size={13} />
                        </button>
                    );
                })}
            </div>
            <span aria-hidden style={{ width: 1, height: 16, background: colors.border, flexShrink: 0 }} />
            <div role="group" aria-label="Filter actions by type" style={{ display: 'flex', gap: space.half }}>
                {TYPE_RING.map((token) => {
                    const active = filters.actionType === token;
                    const label = ACTION_TYPE_LABELS[token];
                    return (
                        <button
                            key={token}
                            type="button"
                            data-testid={`sidebar-filter-type-${token}`}
                            aria-pressed={active}
                            title={active ? `${label} (click to clear)` : `Show only: ${label}`}
                            onClick={() => selectType(token)}
                            style={{
                                ...toggleBase,
                                border: `1.5px solid ${active ? colors.brand : colors.border}`,
                                background: active ? colors.brandSoft : colors.surface,
                                color: active ? colors.brand : colors.textTertiary,
                            }}
                        >
                            <ActionTypeIcon kind={token} size={13} />
                        </button>
                    );
                })}
            </div>
            <span aria-hidden style={{ width: 1, height: 16, background: colors.border, flexShrink: 0 }} />
            {/* Max-loading threshold — compact spinner so the whole
                filter bar stays on one sidebar row. No leading
                glyph (the lightning ⚡ now belongs to Contingency);
                the input is narrowed to exactly fit three digits
                (real-world max loading sits ≤ 200 %, never 1000 %)
                and native spinner arrows are hidden via inline
                ``appearance: textfield`` + the
                ``::-webkit-inner-spin-button`` CSS rule in
                ``App.css`` so the column doesn't reserve space for
                arrows. */}
            <label
                data-testid="sidebar-filter-threshold"
                title="Hide actions whose max loading rate (%) exceeds this threshold"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                    flexShrink: 0,
                    fontSize: 12,
                    color: colors.textSecondary,
                }}
            >
                <input
                    data-testid="sidebar-filter-threshold-input"
                    type="number"
                    min={0}
                    max={300}
                    step={1}
                    value={Math.round(filters.threshold * 100)}
                    onChange={(e) => {
                        const raw = parseInt(e.target.value, 10);
                        if (!Number.isFinite(raw)) return;
                        setThreshold(raw);
                    }}
                    style={{
                        width: 26,
                        padding: '1px 2px',
                        fontSize: 11,
                        fontVariantNumeric: 'tabular-nums',
                        border: `1px solid ${colors.border}`,
                        borderRadius: 3,
                        textAlign: 'right',
                        appearance: 'textfield',
                        WebkitAppearance: 'textfield',
                        MozAppearance: 'textfield',
                    }}
                />
                <span aria-hidden>%</span>
            </label>
        </div>
    );
};

export default React.memo(ActionFilterRings);
