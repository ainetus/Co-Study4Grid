// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/*
 * Action-feed ordering + the progressive-reveal window of the
 * Suggested Actions list.
 *
 * Pure helpers shared by the sidebar `ActionFeed` (which renders the
 * cards) and `useSuggestionReveal` (which tells the pin layers which
 * suggestions currently have a card in the feed), so both read the
 * SAME ordering: shared overview filter, load-flow faults sunk to the
 * bottom, then max loading ascending.
 */

import type { ActionDetail, ActionOverviewFilters, FeedRevealState } from '../types';
import { actionPassesOverviewFilter } from './svg/actionPinData';
import { matchesActionTypeFilter } from './actionTypes';

export type FeedEntry = [string, ActionDetail];

/** `action_scores` as the recommender emits it: score-type bucket → `{ scores: { actionId: score } }`. */
export type ActionScoresByType = Readonly<Record<string, { scores?: unknown } | undefined>>;

/**
 * actionId → recommender score-type bucket (`line_reconnection`,
 * `pst_tap_change`, …). The action-type filter feeds this `type`
 * into `classifyActionType` — the SAME signal the Combine-modal
 * Explore-Pairs filter uses (`ExplorePairsTab` passes `item.type`).
 * Without it, `classifyActionType` can't tell reco from disco for
 * ids like ``reco_GEN.PY762`` (its disco/reco heuristics look at
 * the score type + description, never the id), so the whole
 * reco / disco bucket would be filtered out of the feed.
 */
export const buildScoreTypeByActionId = (
    actionScores: ActionScoresByType | undefined,
): Map<string, string> => {
    const m = new Map<string, string>();
    if (!actionScores) return m;
    for (const [type, data] of Object.entries(actionScores)) {
        const scores = data?.scores || {};
        for (const actionId of Object.keys(scores)) {
            if (!m.has(actionId)) m.set(actionId, type);
        }
    }
    return m;
};

/**
 * Whether an action gets a card at all. Combined actions (key
 * contains '+') that are only estimations — not yet simulated — are
 * kept out of the feed.
 */
export const isFeedCard = (id: string, details: ActionDetail): boolean => {
    if (!id.includes('+')) return true;
    if (details.is_estimated) return false;
    return !!details.rho_after && details.rho_after.length > 0;
};

/**
 * Whether a card passes the shared overview filters: the severity
 * category + max-loading threshold, AND the action-type chip.
 * Combined actions are in scope for the type chip when EITHER
 * constituent matches — they're inherently multi-type, so hiding
 * them because only one side matches would surprise the operator.
 * `actionType ?? 'all'` keeps legacy call sites that don't set the
 * field (older session reloads / tests) behaving as "no type filter".
 */
export const passesFeedFilters = (
    id: string,
    details: ActionDetail,
    actions: Record<string, ActionDetail>,
    overviewFilters: ActionOverviewFilters,
    monitoringFactor: number,
    scoreTypeByActionId: ReadonlyMap<string, string>,
): boolean => {
    if (!actionPassesOverviewFilter(
        details, monitoringFactor,
        overviewFilters.categories, overviewFilters.threshold,
    )) return false;
    const typeFilter = overviewFilters.actionType ?? 'all';
    if (typeFilter === 'all') return true;
    const matches = (actionId: string, d: ActionDetail | undefined): boolean => !!d
        && matchesActionTypeFilter(typeFilter, actionId, d.description_unitaire, scoreTypeByActionId.get(actionId) ?? null);
    if (!id.includes('+')) return matches(id, details);
    const [id1, id2] = id.split('+');
    return matches(id1, actions[id1]) || matches(id2, actions[id2]);
};

/**
 * Feed entries in display order. The overview filter is skipped when
 * `overviewFilters` is undefined so isolated tests (which don't wire
 * it) keep their unfiltered behaviour. Load-flow faults (divergent /
 * islanded) sink to the bottom regardless of their reported max_rho:
 * the backend emits ``max_rho = 0`` (not ``null``) for non-convergent
 * simulations, so sorting by max_rho alone would float those cards
 * ahead of legitimate solving actions.
 */
export const sortFeedEntries = (
    actions: Record<string, ActionDetail>,
    overviewFilters: ActionOverviewFilters | undefined,
    monitoringFactor: number,
    scoreTypeByActionId: ReadonlyMap<string, string>,
): FeedEntry[] => Object.entries(actions)
    .filter(([id, details]) => isFeedCard(id, details) && (!overviewFilters || passesFeedFilters(
        id, details, actions, overviewFilters, monitoringFactor, scoreTypeByActionId,
    )))
    .sort(([, a], [, b]) => {
        const aFault = !!(a.is_islanded || a.non_convergence);
        const bFault = !!(b.is_islanded || b.non_convergence);
        if (aFault !== bFault) return aFault ? 1 : -1;
        return (a.max_rho ?? 999) - (b.max_rho ?? 999);
    });

// ===== Progressive reveal of the Suggested Actions list =====

/** Default for Settings → "Suggestions shown at first". */
export const DEFAULT_REVEAL_STEP = 3;

/** The reveal step as a positive integer; anything else falls back to the default. */
export const sanitizeRevealStep = (step: number): number =>
    Number.isFinite(step) && step >= 1 ? Math.floor(step) : DEFAULT_REVEAL_STEP;

/**
 * Split the ordered Suggested list into shown and hidden cards: the
 * first `count` entries, plus every entry revealed one by one
 * (`extraIds` — a pin click, a selection). Both sets keep feed order.
 */
export const revealWindow = (
    orderedIds: readonly string[],
    count: number,
    extraIds: ReadonlySet<string>,
): FeedRevealState => {
    const displayedIds = new Set<string>();
    const hiddenIds = new Set<string>();
    orderedIds.forEach((id, i) => {
        if (i < count || extraIds.has(id)) displayedIds.add(id);
        else hiddenIds.add(id);
    });
    return { displayedIds, hiddenIds };
};

/**
 * Window size after a "Show N more": the window grows until it takes
 * in `step` more cards that were hidden — cards already revealed one
 * by one don't count, so the button always reveals `step` new cards
 * (or every remaining one).
 */
export const nextRevealCount = (
    orderedIds: readonly string[],
    count: number,
    extraIds: ReadonlySet<string>,
    step: number,
): number => {
    let next = Math.max(0, count);
    let revealed = 0;
    while (next < orderedIds.length && revealed < step) {
        if (!extraIds.has(orderedIds[next])) revealed += 1;
        next += 1;
    }
    return next;
};
