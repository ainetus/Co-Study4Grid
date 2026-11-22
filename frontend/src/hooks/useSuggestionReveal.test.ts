// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSuggestionReveal, type SuggestionRevealArgs } from './useSuggestionReveal';
import { interactionLogger } from '../utils/interactionLogger';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../utils/actionTypes';
import type { ActionDetail } from '../types';

const detail = (maxRho: number): ActionDetail => ({
    description_unitaire: 'action',
    rho_before: [1.1],
    rho_after: [maxRho],
    max_rho: maxRho,
    max_rho_line: 'LINE_A',
    is_rho_reduction: true,
});

// Ten suggestions; `aN` has max loading 0.5 + N/100, so the feed
// order is a0, a1, …, a9.
const ACTIONS: Record<string, ActionDetail> = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`a${i}`, detail(0.5 + i / 100)]),
);
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `a${from + i}`);
// One batch of suggestions = one `action_scores` object: App passes the
// result's own reference, stable until the next analysis or reload.
const SCORES = { line_disconnection: { scores: {} } };
const FILTERS = DEFAULT_ACTION_OVERVIEW_FILTERS;
const NONE: ReadonlySet<string> = new Set();

const baseArgs = (over: Partial<SuggestionRevealArgs> = {}): SuggestionRevealArgs => ({
    actions: ACTIONS,
    actionScores: SCORES,
    overviewFilters: FILTERS,
    monitoringFactor: 1,
    selectedActionIds: NONE,
    rejectedActionIds: NONE,
    analysisLoading: false,
    step: 3,
    selectedActionId: null,
    ...over,
});

const shown = (r: { current: ReturnType<typeof useSuggestionReveal> }) =>
    [...r.current.controls.displayedIds].sort();

describe('useSuggestionReveal', () => {
    beforeEach(() => {
        interactionLogger.clear();
    });

    it('shows the first `step` suggestions in feed order', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs()));
        expect(shown(result)).toEqual(ids(3));
        expect([...result.current.controls.hiddenIds]).toEqual(ids(7, 3));
        expect(result.current.controls.step).toBe(3);
    });

    it('"Show N more" reveals the next batch and logs it', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs()));
        act(() => result.current.controls.onShowMore());
        expect(shown(result)).toEqual(ids(6));
        expect([...result.current.controls.hiddenIds]).toEqual(ids(4, 6));
        const log = interactionLogger.getLog();
        expect(log.map(e => e.type)).toEqual(['suggestions_show_more']);
        expect(log[0].details).toEqual({ step: 3, n_shown: 6 });
    });

    it('"Show all" reveals every remaining suggestion and logs it', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs()));
        act(() => result.current.controls.onShowAll());
        expect(shown(result)).toEqual(ids(10));
        expect(result.current.controls.hiddenIds.size).toBe(0);
        expect(interactionLogger.getLog()[0]).toMatchObject({
            type: 'suggestions_show_all', details: { n_shown: 10 },
        });
    });

    it('excludes starred and rejected actions, and refills the window', () => {
        const { result, rerender } = renderHook((args: SuggestionRevealArgs) => useSuggestionReveal(args), {
            initialProps: baseArgs(),
        });
        rerender(baseArgs({ selectedActionIds: new Set(['a0']), rejectedActionIds: new Set(['a1']) }));
        expect(shown(result)).toEqual(['a2', 'a3', 'a4']);
    });

    it('a pin preview reveals a hidden card and targets the feed scroll', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs()));
        act(() => result.current.previewAction('a8'));
        expect(shown(result)).toEqual([...ids(3), 'a8']);
        expect(result.current.scrollTarget).toEqual({ id: 'a8', seq: 1 });
        // "Show 3 more" still reveals three NEW cards (a3, a4, a5).
        act(() => result.current.controls.onShowMore());
        expect(shown(result)).toEqual([...ids(6), 'a8']);
    });

    it('re-targets the scroll on a second click of the same pin', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs()));
        const preview = result.current.previewAction;
        act(() => result.current.previewAction('a1'));
        act(() => result.current.previewAction('a1'));
        expect(result.current.scrollTarget).toEqual({ id: 'a1', seq: 2 });
        // Stable identity: the pin layers don't re-render on reveals.
        expect(result.current.previewAction).toBe(preview);
    });

    it('selecting a hidden suggestion reveals its card for good', () => {
        const { result, rerender } = renderHook((args: SuggestionRevealArgs) => useSuggestionReveal(args), {
            initialProps: baseArgs(),
        });
        rerender(baseArgs({ selectedActionId: 'a7' }));
        expect(shown(result)).toEqual([...ids(3), 'a7']);
        rerender(baseArgs({ selectedActionId: null }));
        expect(shown(result)).toEqual([...ids(3), 'a7']);
    });

    it('starts over on a new batch of suggestions', () => {
        const { result, rerender } = renderHook((args: SuggestionRevealArgs) => useSuggestionReveal(args), {
            initialProps: baseArgs(),
        });
        act(() => result.current.controls.onShowAll());
        act(() => result.current.previewAction('a9'));
        // A new analysis: nothing is listed while it runs …
        rerender(baseArgs({ analysisLoading: true }));
        expect(result.current.controls.displayedIds.size).toBe(0);
        // … then its result comes with new scores: back to the first batch.
        rerender(baseArgs({ actionScores: { line_reconnection: { scores: {} } } }));
        expect(shown(result)).toEqual(ids(3));
    });

    it('starts over after a run even when the model returns no scores', () => {
        const { result, rerender } = renderHook((args: SuggestionRevealArgs) => useSuggestionReveal(args), {
            initialProps: baseArgs({ actionScores: undefined }),
        });
        act(() => result.current.controls.onShowAll());
        rerender(baseArgs({ actionScores: undefined, analysisLoading: true }));
        rerender(baseArgs({ actionScores: undefined }));
        expect(shown(result)).toEqual(ids(3));
    });

    it('keeps the window across star / reject edits of the same batch', () => {
        const args = baseArgs();
        const { result, rerender } = renderHook((a: SuggestionRevealArgs) => useSuggestionReveal(a), {
            initialProps: args,
        });
        act(() => result.current.controls.onShowMore());
        rerender({ ...args, actions: { ...ACTIONS }, selectedActionIds: new Set(['a0']) });
        expect(shown(result)).toEqual(ids(6, 1));
    });

    it('follows the setting until the operator reveals more', () => {
        const { result, rerender } = renderHook((args: SuggestionRevealArgs) => useSuggestionReveal(args), {
            initialProps: baseArgs(),
        });
        rerender(baseArgs({ step: 5 }));
        expect(shown(result)).toEqual(ids(5));
        act(() => result.current.controls.onShowMore());
        expect(shown(result)).toEqual(ids(10));
    });

    it('falls back to 3 on an invalid setting', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs({ step: Number.NaN })));
        expect(result.current.controls.step).toBe(3);
        expect(shown(result)).toEqual(ids(3));
    });

    it('applies the shared overview filter like the feed', () => {
        const { result } = renderHook(() => useSuggestionReveal(baseArgs({
            overviewFilters: { ...DEFAULT_ACTION_OVERVIEW_FILTERS, threshold: 0.535 },
        })));
        expect(shown(result)).toEqual(ids(3));
        expect([...result.current.controls.hiddenIds]).toEqual(['a3']);
    });
});
