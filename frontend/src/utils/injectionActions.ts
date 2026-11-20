// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * Injection actions acting on several loads / generators at once — notably
 * the evacuation-antenna aggregates of expert_op4grid_recommender 0.3.4+
 * (`curtail_<antenna_id>` / `redispatch_<antenna_id>`), one MW-sized option
 * spread pro rata over an antenna's generators.
 *
 * The UI edits ONE MW value per action — its total — and the backend spreads
 * it over the elements (`split_target_mw`), so every editor reads the totals
 * below rather than the first element's detail.
 */

import type { ActionDetail, RedispatchDetail } from '../types';

/** MW shed / curtailed by the action, summed over its loads (or else its generators). */
export function totalReductionMw(detail: ActionDetail | undefined): number | null {
    const values = detail?.load_shedding_details?.length
        ? detail.load_shedding_details.map(ls => ls.shedded_mw)
        : detail?.curtailment_details?.map(rc => rc.curtailed_mw);
    return values && values.length > 0 ? values.reduce((sum, v) => sum + v, 0) : null;
}

export interface RedispatchTotal {
    deltaMw: number;
    direction: 'up' | 'down';
    maxRaiseMw: number | null;
    maxLowerMw: number | null;
    /** Further raise (up) or lower (down) the generators allow, from their [min_p, max_p]. */
    headroomMw: number | null;
    /** Bounds of the editable signed delta: [0, +max raise] up, [-max lower, 0] down; undefined when unknown. */
    minDeltaMw: number | undefined;
    maxDeltaMw: number | undefined;
}

function sumOrNull(values: (number | null | undefined)[]): number | null {
    let total = 0;
    for (const v of values) {
        if (v == null) return null;
        total += v;
    }
    return total;
}

/** Signed delta and headroom of a redispatch, summed over its generators. */
export function redispatchTotal(rows: RedispatchDetail[] | undefined): RedispatchTotal | null {
    if (!rows || rows.length === 0) return null;
    const deltaMw = rows.reduce((sum, rd) => sum + rd.delta_mw, 0);
    const sameDirection = rows.every(rd => rd.direction === rows[0].direction);
    const direction = sameDirection ? rows[0].direction : (deltaMw >= 0 ? 'up' : 'down');
    const maxRaiseMw = sumOrNull(rows.map(rd => rd.max_raise_mw));
    const maxLowerMw = sumOrNull(rows.map(rd => rd.max_lower_mw));
    return {
        deltaMw,
        direction,
        maxRaiseMw,
        maxLowerMw,
        headroomMw: direction === 'up' ? maxRaiseMw : maxLowerMw,
        minDeltaMw: direction === 'up' ? 0 : (maxLowerMw != null ? -maxLowerMw : undefined),
        maxDeltaMw: direction === 'up' ? (maxRaiseMw ?? undefined) : 0,
    };
}

/** Clamp a signed redispatch delta to the bounds of {@link redispatchTotal}. */
export function clampRedispatchDelta(total: RedispatchTotal, value: number): number {
    let v = value;
    if (total.minDeltaMw != null) v = Math.max(total.minDeltaMw, v);
    if (total.maxDeltaMw != null) v = Math.min(total.maxDeltaMw, v);
    return v;
}

// A type alias (not an interface) so it is assignable to the
// `action_content` payload type, which carries an index signature.
export type AntennaAggregateContent = { gens_p: Record<string, number> };

function isAggregateParams(value: unknown): value is { gen_names: string[]; target_p_MW: Record<string, number> } {
    if (!value || typeof value !== 'object') return false;
    const { gen_names: genNames, target_p_MW: targets } = value as { gen_names?: unknown; target_p_MW?: unknown };
    return Array.isArray(genNames) && genNames.length > 0
        && !!targets && typeof targets === 'object' && !Array.isArray(targets);
}

/**
 * Topology of an evacuation-antenna aggregate, read from the score params
 * (`gen_names`, `target_p_MW`), to send as `action_content` when it is
 * simulated before any card carries its topology. Its id names the antenna,
 * not a generator, so after a session reload — once the backend no longer
 * holds the analysis that proposed it — it could not be rebuilt otherwise.
 * Null for any other action.
 */
export function antennaAggregateContent(
    actionScores: Record<string, object> | null | undefined,
    actionId: string,
): AntennaAggregateContent | null {
    if (!actionId.startsWith('curtail_') && !actionId.startsWith('redispatch_')) return null;
    for (const typeData of Object.values(actionScores ?? {})) {
        if (!('params' in typeData) || !typeData.params || typeof typeData.params !== 'object') continue;
        const params = Object.entries(typeData.params).find(([id]) => id === actionId)?.[1];
        if (isAggregateParams(params)) return { gens_p: { ...params.target_p_MW } };
    }
    return null;
}
