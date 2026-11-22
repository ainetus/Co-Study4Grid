// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ActionDetail, ActionOverviewFilters, FeedRevealState } from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import {
  type ActionScoresByType,
  buildScoreTypeByActionId,
  nextRevealCount,
  revealWindow,
  sanitizeRevealStep,
  sortFeedEntries,
} from '../utils/feedEntries';

/**
 * Wiring of the Suggested Actions "Show N more / Show all" bar. As a
 * `FeedRevealState` it also tells the pin layers which suggestions are
 * listed (feed badge) and which are hidden (translucent pins).
 */
export interface SuggestionRevealControls extends FeedRevealState {
  /** Cards revealed by "Show N more" (Settings → Suggestions shown at first). */
  step: number;
  onShowMore: () => void;
  onShowAll: () => void;
}

/**
 * Card the feed scrolls to. The `seq` counter lets the same action
 * trigger a re-scroll (a plain id string would not re-render on a
 * second identical value — e.g. tapping the same pin twice).
 */
export interface FeedScrollTarget {
  id: string;
  seq: number;
}

export interface SuggestionReveal {
  controls: SuggestionRevealControls;
  scrollTarget: FeedScrollTarget | null;
  /**
   * Pin single-click (Remedial Action overview + overflow graph):
   * reveal the action's card when it is hidden, then scroll the feed
   * to it. Stable identity, so the pin layers don't re-render on
   * every reveal.
   */
  previewAction: (actionId: string) => void;
}

export interface SuggestionRevealArgs {
  actions: Record<string, ActionDetail> | undefined;
  actionScores: ActionScoresByType | undefined;
  overviewFilters: ActionOverviewFilters;
  monitoringFactor: number;
  selectedActionIds: ReadonlySet<string>;
  rejectedActionIds: ReadonlySet<string>;
  analysisLoading: boolean;
  /** Settings → "Suggestions shown at first" — also the "Show N more" step. */
  step: number;
  /** Action under review (its variant diagram is open). Its card is never hidden. */
  selectedActionId: string | null;
}

interface RevealState {
  /** Suggestion batch this state belongs to (see `batch` below). */
  batch: unknown;
  /** Window over the ordered suggestions; `null` follows the step. */
  count: number | null;
  /** Suggestions revealed one by one — a pin click, a selection. */
  extraIds: ReadonlySet<string>;
}

const LOADING_BATCH = 'analysis-loading';
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Progressive reveal of the recommender's suggestions in the action
 * feed. The Suggested Actions list shows the first `step` cards; "Show
 * N more" reveals `step` more and "Show all" the rest. The pin layers
 * keep showing every suggestion and read `controls` to badge the pins
 * whose card is in the list and fade the others; clicking the pin of a
 * hidden card reveals it (`previewAction`), and so does selecting the
 * action.
 *
 * The window resets on each new batch of suggestions: an analysis run
 * (while it runs, then on display), a session reload, a cleared study.
 */
export function useSuggestionReveal(args: SuggestionRevealArgs): SuggestionReveal {
  const {
    actions, actionScores, overviewFilters, monitoringFactor,
    selectedActionIds, rejectedActionIds, analysisLoading, selectedActionId,
  } = args;
  const step = sanitizeRevealStep(args.step);

  // `action_scores` is replaced by every analysis display and session
  // reload, and kept across star / reject / re-simulation edits.
  const batch = analysisLoading ? LOADING_BATCH : (actionScores ?? null);
  const [state, setState] = useState<RevealState>({ batch, count: null, extraIds: NO_IDS });
  let current = state;
  if (state.batch !== batch) {
    current = { batch, count: null, extraIds: NO_IDS };
    setState(current);
  }

  // Same ordering as the Suggested Actions list (`ActionFeed`).
  const orderedIds = useMemo(() => {
    if (analysisLoading || !actions) return [];
    const scoreTypes = buildScoreTypeByActionId(actionScores);
    return sortFeedEntries(actions, overviewFilters, monitoringFactor, scoreTypes)
      .map(([id]) => id)
      .filter(id => !selectedActionIds.has(id) && !rejectedActionIds.has(id));
  }, [actions, actionScores, overviewFilters, monitoringFactor, selectedActionIds, rejectedActionIds, analysisLoading]);

  const { count, extraIds } = current;
  const { displayedIds, hiddenIds } = useMemo(
    () => revealWindow(orderedIds, count ?? step, extraIds),
    [orderedIds, count, extraIds, step],
  );

  // Whatever selects a hidden suggestion (a pin double-click, the pin
  // popover) also reveals its card, so the feed can scroll to it.
  if (selectedActionId && hiddenIds.has(selectedActionId)) {
    setState({ ...current, extraIds: new Set(extraIds).add(selectedActionId) });
  }

  const onShowMore = useCallback(() => {
    const next = nextRevealCount(orderedIds, count ?? step, extraIds, step);
    const nShown = revealWindow(orderedIds, next, extraIds).displayedIds.size;
    interactionLogger.record('suggestions_show_more', { step, n_shown: nShown });
    setState(prev => ({ ...prev, count: next }));
  }, [orderedIds, count, extraIds, step]);

  const onShowAll = useCallback(() => {
    interactionLogger.record('suggestions_show_all', { n_shown: orderedIds.length });
    setState(prev => ({ ...prev, count: Number.POSITIVE_INFINITY }));
  }, [orderedIds.length]);

  const [scrollTarget, setScrollTarget] = useState<FeedScrollTarget | null>(null);
  const scrollSeqRef = useRef(0);
  const previewAction = useCallback((actionId: string) => {
    scrollSeqRef.current += 1;
    setState(prev => (prev.extraIds.has(actionId)
      ? prev
      : { ...prev, extraIds: new Set(prev.extraIds).add(actionId) }));
    setScrollTarget({ id: actionId, seq: scrollSeqRef.current });
  }, []);

  const controls = useMemo<SuggestionRevealControls>(() => ({
    displayedIds,
    hiddenIds,
    step,
    onShowMore,
    onShowAll,
  }), [displayedIds, hiddenIds, step, onShowMore, onShowAll]);

  return useMemo(
    () => ({ controls, scrollTarget, previewAction }),
    [controls, scrollTarget, previewAction],
  );
}
