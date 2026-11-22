// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * What an action card names, in the names the operator sees: the elements
 * the action acts on (its title), where its injections sit (its location
 * chips), and its description with every known id read by its name.
 *
 * The raw ids stay what the backend, the session file and the interaction
 * log carry — this is display only (see docs/features/action-card.md).
 */

import type { ActionDetail, EdgeMeta, NodeMeta } from '../types';
import { getActionTargetLines, getActionTargetVoltageLevels, isCouplingAction } from './svgUtils';

/** One element a card names: a voltage level (double-click opens its SLD),
 *  a line, or another piece of equipment (generator / load). */
export interface ActionTarget {
    id: string;
    kind: 'vl' | 'line' | 'equipment';
}

export interface ActionTargets {
    /** What the action acts on — the card title. */
    title: ActionTarget[];
    /** Where its injections sit (shed loads, curtailed / redispatched
     *  generators) — the location chips. */
    locations: ActionTarget[];
}

/** An element id token: anything between blanks, quotes, brackets and
 *  separators (ids carry `_`, `-`, `.`, `/`). */
const ID_TOKEN = /[^\s'"(),:;+[\]]+/g;

/**
 * ``text`` with every token that is a known element id replaced by its
 * display name — ``Effacement 'X_GB_way_1271288345-400' ('VL_way_…')`` reads
 * ``Effacement 'Exchange with GB' ('MANDARINS 400kV')``. Unknown tokens
 * (words, switch ids, numbers) stay as they are.
 */
export const humanizeIds = (text: string, displayName: (id: string) => string): string =>
    text.replace(ID_TOKEN, token => displayName(token));

/** The voltage level a user-built SLD manoeuvre acts on, from its minted id
 *  ``user_topo_<vl>_<timestamp>`` (``null`` for any other action). */
export const manualActionVoltageLevel = (actionId: string): string | null => {
    const m = /^user_topo_(.+)_\d+$/.exec(actionId);
    return m ? m[1] : null;
};

const uniquePush = (list: ActionTarget[], seen: Set<string>, id: string | null | undefined, kind: ActionTarget['kind']) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({ id, kind });
};

/**
 * The elements an action card names. The title holds what the action acts
 * on — shed loads, curtailed / redispatched generators, opened / closed /
 * tap-changed lines, coupled or manoeuvred voltage levels — and the
 * location chips the voltage levels its injections sit in. Every name
 * appears once; the metadata indexes (``null`` before the N-1 diagram
 * arrives) only refine the voltage levels and lines found.
 */
export const collectActionTargets = (
    id: string,
    details: ActionDetail,
    nodesByEquipmentId: Map<string, NodeMeta> | null,
    edgesByEquipmentId: Map<string, EdgeMeta> | null,
): ActionTargets => {
    const title: ActionTarget[] = [];
    const locations: ActionTarget[] = [];
    const seen = new Set<string>();

    const injectionVls = new Set<string>();
    const injections: string[] = [];
    details.load_shedding_details?.forEach(d => { injections.push(d.load_name); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    details.curtailment_details?.forEach(d => { injections.push(d.gen_name); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    details.redispatch_details?.forEach(d => { injections.push(d.gen_name); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    injections.forEach(name => uniquePush(title, seen, name, 'equipment'));

    const isCoupling = isCouplingAction(id, details.description_unitaire);
    const topo = details.action_topology;
    const lines = edgesByEquipmentId
        ? getActionTargetLines(details, id, edgesByEquipmentId)
        : Array.from(new Set([
            ...(isCoupling ? [] : Object.keys(topo?.lines_ex_bus || {})),
            ...(isCoupling ? [] : Object.keys(topo?.lines_or_bus || {})),
            ...Object.keys(topo?.pst_tap || {}),
        ]));
    lines.forEach(line => uniquePush(title, seen, line, 'line'));

    // Backend VL hint (switch-based dictionary actions), the voltage level a
    // manual manoeuvre was built on, then whatever the metadata resolves.
    const vls: string[] = [];
    const hint = (topo as { voltage_level_id?: string } | undefined)?.voltage_level_id;
    if (hint) vls.push(hint);
    id.split('+').forEach(part => { const vl = manualActionVoltageLevel(part); if (vl) vls.push(vl); });
    if (nodesByEquipmentId) vls.push(...getActionTargetVoltageLevels(details, id, nodesByEquipmentId));
    vls.filter(vl => !injectionVls.has(vl)).forEach(vl => uniquePush(title, seen, vl, 'vl'));
    injectionVls.forEach(vl => uniquePush(locations, seen, vl, 'vl'));

    if (title.length === 0) {
        [...Object.keys(topo?.gens_bus || {}), ...Object.keys(topo?.loads_bus || {}),
         ...Object.keys(topo?.loads_p || {}), ...Object.keys(topo?.gens_p || {})]
            .forEach(eq => uniquePush(title, seen, eq, 'equipment'));
    }
    return { title, locations };
};
