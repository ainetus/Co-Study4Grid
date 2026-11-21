// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { ActionDetail } from '../types';

/**
 * Compute the list of overloaded line IDs that should receive an
 * orange halo on the N-1 tab — the N-1 NAD, the N-1 SLD and the
 * Context tab all read it, so the three views agree.
 *
 * Source priority:
 *   1. `analysisOverloads` — populated once an action analysis has run
 *      (`result.lines_overloaded`). When non-empty, this list wins.
 *   2. `n1DiagramOverloads` — what the backend reports along with the
 *      N-1 diagram fetch (`n1Diagram.lines_overloaded`). This is the
 *      EARLY source: it is available as soon as the user picks a
 *      contingency, so the orange halos must show up immediately on
 *      the N-1 view — without waiting for the user to run "Analyze &
 *      Suggest". The previous implementation forgot this fallback,
 *      which made the N-1 overload halos disappear until after a
 *      remedial-action simulation had populated `result`.
 *
 * In both cases the user's `selectedOverloads` set (from the Overloads
 * panel) further filters the list down — when the set is empty the
 * filter is a no-op (empty selection means "no explicit selection
 * yet", not "highlight nothing").
 */
export function computeN1OverloadHighlights(
  analysisOverloads: string[] | undefined | null,
  n1DiagramOverloads: string[] | undefined | null,
  selectedOverloads: Set<string>,
): string[] {
  const source = (analysisOverloads && analysisOverloads.length > 0)
    ? analysisOverloads
    : (n1DiagramOverloads || []);
  if (selectedOverloads.size === 0) return [...source];
  return source.filter(name => selectedOverloads.has(name));
}

/**
 * Compute the list of line IDs still overloaded after an action — the
 * orange halos of the action NAD and of the action SLD, so both agree.
 *
 * ActionCard severity classification (`components/ActionCard.tsx`):
 *   - red:    `max_rho > monitoringFactor`         ("Still overloaded")
 *   - orange: `max_rho > monitoringFactor - 0.05`  ("Solved — low margin")
 *   - green:  else                                 ("Solves overload")
 * When the card says "Solved" (orange or green) no line in the
 * post-action state exceeds the operator's tolerance threshold, so an
 * overload halo would contradict the card's label: the list is empty.
 * The backend's manual-simulation path flags `lines_overloaded_after`
 * on raw rho >= monitoring_factor (0.95) whereas the analysis path uses
 * raw rho >= 1.0 (`analysis_mixin.py` vs `simulation_mixin.py`). In the
 * low-margin band — raw rho in `[mf, 1.0)` — the two paths disagree:
 * manual ships a non-empty list, analysis ships an empty one. Without
 * this gate, halos appeared on manual low-margin actions but not on
 * suggested ones with the same displayed max_rho.
 *
 * Otherwise `lines_overloaded_after` wins; legacy results or actions
 * without full enrichment fall back to the N-1 overloads whose
 * `rho_after` (index-aligned with `n1Overloads`, the analysis result's
 * `lines_overloaded`) still exceeds the threshold, plus `max_rho_line`.
 */
export function computeActionOverloadHighlights(
  actionDetail: ActionDetail | null | undefined,
  n1Overloads: string[] | undefined | null,
  monitoringFactor: number,
): string[] {
  if (!actionDetail) return [];
  const isSolved = actionDetail.max_rho != null && actionDetail.max_rho <= monitoringFactor;
  if (isSolved) return [];
  if (actionDetail.lines_overloaded_after && actionDetail.lines_overloaded_after.length > 0) {
    return [...actionDetail.lines_overloaded_after];
  }
  const overloads: string[] = [];
  if (n1Overloads && n1Overloads.length > 0 && actionDetail.rho_after) {
    n1Overloads.forEach((name, i) => {
      const rho = actionDetail.rho_after![i];
      if (rho != null && rho > monitoringFactor) overloads.push(name);
    });
  }
  if (actionDetail.max_rho != null && actionDetail.max_rho > monitoringFactor && actionDetail.max_rho_line) {
    if (!overloads.includes(actionDetail.max_rho_line)) overloads.push(actionDetail.max_rho_line);
  }
  return overloads;
}
