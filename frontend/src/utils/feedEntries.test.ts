// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, expect, it } from 'vitest';
import type { ActionDetail, ActionOverviewFilters } from '../types';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from './actionTypes';
import {
    DEFAULT_REVEAL_STEP,
    buildScoreTypeByActionId,
    isFeedCard,
    nextRevealCount,
    passesFeedFilters,
    revealWindow,
    sanitizeRevealStep,
    sortFeedEntries,
} from './feedEntries';

const detail = (maxRho: number | null, extra: Partial<ActionDetail> = {}): ActionDetail => ({
    description_unitaire: 'action',
    rho_before: [1.1],
    rho_after: maxRho == null ? null : [maxRho],
    max_rho: maxRho,
    max_rho_line: 'LINE_A',
    is_rho_reduction: true,
    ...extra,
});

const filters = (over: Partial<ActionOverviewFilters> = {}): ActionOverviewFilters => ({
    ...DEFAULT_ACTION_OVERVIEW_FILTERS,
    ...over,
});

describe('buildScoreTypeByActionId', () => {
    it('maps each scored action to its first score-type bucket', () => {
        const m = buildScoreTypeByActionId({
            line_reconnection: { scores: { reco_A: 3, shared: 1 } },
            pst_tap_change: { scores: { pst_B: 2, shared: 5 } },
        });
        expect(m.get('reco_A')).toBe('line_reconnection');
        expect(m.get('pst_B')).toBe('pst_tap_change');
        expect(m.get('shared')).toBe('line_reconnection');
    });

    it('is empty without scores', () => {
        expect(buildScoreTypeByActionId(undefined).size).toBe(0);
    });
});

describe('isFeedCard', () => {
    it('keeps unitary actions and simulated combined actions', () => {
        expect(isFeedCard('a', detail(0.9))).toBe(true);
        expect(isFeedCard('a+b', detail(0.9))).toBe(true);
    });

    it('drops combined actions that are only estimated or not simulated', () => {
        expect(isFeedCard('a+b', detail(0.9, { is_estimated: true }))).toBe(false);
        expect(isFeedCard('a+b', detail(null))).toBe(false);
    });
});

describe('passesFeedFilters', () => {
    const noTypes = new Map<string, string>();

    it('applies the max-loading threshold', () => {
        const actions = { a: detail(0.9), b: detail(1.4) };
        const f = filters({ threshold: 1.0 });
        expect(passesFeedFilters('a', actions.a, actions, f, 1, noTypes)).toBe(true);
        expect(passesFeedFilters('b', actions.b, actions, f, 1, noTypes)).toBe(false);
    });

    it('keeps a combined action when either constituent matches the type chip', () => {
        const actions = {
            reco_A: detail(0.9),
            disco_B: detail(0.95),
            'reco_A+disco_B': detail(0.8),
        };
        const types = buildScoreTypeByActionId({
            line_reconnection: { scores: { reco_A: 1 } },
            line_disconnection: { scores: { disco_B: 1 } },
        });
        const f = filters({ actionType: 'reco' });
        expect(passesFeedFilters('reco_A', actions.reco_A, actions, f, 1, types)).toBe(true);
        expect(passesFeedFilters('disco_B', actions.disco_B, actions, f, 1, types)).toBe(false);
        expect(passesFeedFilters('reco_A+disco_B', actions['reco_A+disco_B'], actions, f, 1, types)).toBe(true);
    });
});

describe('sortFeedEntries', () => {
    it('sorts by max loading ascending and sinks load-flow faults', () => {
        const actions = {
            worst: detail(1.2),
            best: detail(0.7),
            diverged: detail(0, { non_convergence: 'diverged' }),
            middle: detail(0.9),
        };
        const ids = sortFeedEntries(actions, undefined, 1, new Map()).map(([id]) => id);
        expect(ids).toEqual(['best', 'middle', 'worst', 'diverged']);
    });

    it('applies the overview filter only when one is given', () => {
        const actions = { ok: detail(0.8), over: detail(1.3) };
        expect(sortFeedEntries(actions, undefined, 1, new Map())).toHaveLength(2);
        const ids = sortFeedEntries(actions, filters({ threshold: 1.0 }), 1, new Map()).map(([id]) => id);
        expect(ids).toEqual(['ok']);
    });

    it('drops estimation-only combined actions', () => {
        const actions = { a: detail(0.8), 'a+b': detail(0.7, { is_estimated: true }) };
        expect(sortFeedEntries(actions, undefined, 1, new Map()).map(([id]) => id)).toEqual(['a']);
    });
});

describe('sanitizeRevealStep', () => {
    it('keeps positive integers and floors decimals', () => {
        expect(sanitizeRevealStep(5)).toBe(5);
        expect(sanitizeRevealStep(4.7)).toBe(4);
    });

    it('falls back to the default on zero, negatives and NaN', () => {
        expect(sanitizeRevealStep(0)).toBe(DEFAULT_REVEAL_STEP);
        expect(sanitizeRevealStep(-2)).toBe(DEFAULT_REVEAL_STEP);
        expect(sanitizeRevealStep(Number.NaN)).toBe(DEFAULT_REVEAL_STEP);
        expect(DEFAULT_REVEAL_STEP).toBe(3);
    });
});

describe('revealWindow', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e', 'f'];

    it('shows the first `count` cards and hides the rest in order', () => {
        const w = revealWindow(ordered, 3, new Set());
        expect([...w.displayedIds]).toEqual(['a', 'b', 'c']);
        expect([...w.hiddenIds]).toEqual(['d', 'e', 'f']);
    });

    it('also shows cards revealed one by one', () => {
        const w = revealWindow(ordered, 2, new Set(['e']));
        expect([...w.displayedIds]).toEqual(['a', 'b', 'e']);
        expect([...w.hiddenIds]).toEqual(['c', 'd', 'f']);
    });

    it('shows everything with an infinite window', () => {
        const w = revealWindow(ordered, Number.POSITIVE_INFINITY, new Set());
        expect(w.displayedIds.size).toBe(6);
        expect(w.hiddenIds.size).toBe(0);
    });
});

describe('nextRevealCount', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    it('grows the window by one batch', () => {
        expect(nextRevealCount(ordered, 3, new Set(), 3)).toBe(6);
    });

    it('skips cards already revealed one by one, so a batch reveals `step` new cards', () => {
        const extra = new Set(['e']);
        const next = nextRevealCount(ordered, 3, extra, 3);
        expect(next).toBe(7);
        const before = revealWindow(ordered, 3, extra).displayedIds.size;
        const after = revealWindow(ordered, next, extra).displayedIds.size;
        expect(after - before).toBe(3);
    });

    it('stops at the end of the list', () => {
        expect(nextRevealCount(ordered, 6, new Set(), 5)).toBe(8);
        expect(nextRevealCount(ordered, Number.POSITIVE_INFINITY, new Set(), 3)).toBe(Number.POSITIVE_INFINITY);
    });
});
