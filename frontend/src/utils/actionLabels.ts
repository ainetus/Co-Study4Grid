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
import { classifyActionTypes } from './actionTypes';
import { getActionTargetLines, getActionTargetVoltageLevels, isCouplingAction } from './svgUtils';

/** What an element a card names is — the type word its title starts with. */
export type TargetRole = 'coupling' | 'substation' | 'branch' | 'phaseShifter' | 'load' | 'generator';

/** One element a card names: a voltage level (double-click opens its SLD),
 *  a line, or another piece of equipment (generator / load). */
export interface ActionTarget {
    id: string;
    kind: 'vl' | 'line' | 'equipment';
    role: TargetRole;
}

/** A voltage level the card offers as an SLD chip. */
export interface ActionLocation {
    id: string;
    kind: 'vl';
}

export interface ActionTargets {
    /** What the action acts on — the card title. */
    title: ActionTarget[];
    /** The voltage levels the card offers as SLD chips, on its viewing
     *  (unfolded) form, at the end of its description: where its injections
     *  sit (shed loads, curtailed / redispatched generators), the voltage
     *  levels the title names (coupling, manoeuvre) and the two ends of each
     *  branch (line, transformer, phase shifter) the action opens, closes or
     *  tap-changes. */
    locations: ActionLocation[];
}

/** An element as a title reads it: ``<type> - <name>``. */
export interface TargetLabel {
    type: string;
    name: string;
}

/** The carriers the PyPSA-EUR pipeline names its generators after
 *  (``<voltage level> <carrier>`` — ``MANDARINS 400kV Solar``). */
const CARRIER_SUFFIX = new RegExp(
    '^(.+?)\\s+(Nuclear|Lignite|Hard Coal|Natural Gas|Oil|Run-Of-River|Reservoir|Pumped Storage|'
    + 'Wind Onshore|Wind Offshore|Solar|Biomass|Waste|Storage|Other)$',
);
/** The fallback names the backend gives a generator / load that has none
 *  (``Load — MANDARINS 400kV``, see ``element_names.injection_display_name``). */
const INJECTION_NOUN_PREFIX = /^(?:Load|Generator)\s+[—-]\s+/;
const EXCHANGE_NAME = /^Exchange\s+(with\s+.+)$/;

const TYPE_WORDS: Record<Exclude<TargetRole, 'load' | 'generator'>, string> = {
    coupling: 'Coupling',
    substation: 'Substation',
    branch: 'Branch',
    phaseShifter: 'Phase shifter',
};

/**
 * One convention for every card title — the kind of element first, then the
 * name or location after a dash: ``Coupling - MANDARINS 400kV``,
 * ``Branch - MANDAL71PEUP5``, ``Load - MANDARINS 400kV``, ``Solar -
 * WARANDE 400kV``, ``Exchange - with GB``, ``Production - Blayais 1``.
 * A generator is typed by the carrier its name ends with, ``Production``
 * when it names none; a load / generator name that only restates the type
 * (``Load — …``) drops it.
 */
export const describeTarget = (t: ActionTarget, displayName: (id: string) => string): TargetLabel => {
    const name = displayName(t.id);
    if (t.role === 'load') {
        const exchange = EXCHANGE_NAME.exec(name);
        if (exchange) return { type: 'Exchange', name: exchange[1] };
        return { type: 'Load', name: name.replace(INJECTION_NOUN_PREFIX, '') || name };
    }
    if (t.role === 'generator') {
        const bare = name.replace(INJECTION_NOUN_PREFIX, '') || name;
        const carrier = CARRIER_SUFFIX.exec(bare);
        return carrier ? { type: carrier[2], name: carrier[1] } : { type: 'Production', name: bare };
    }
    return { type: TYPE_WORDS[t.role], name };
};

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

const uniquePush = (list: ActionTarget[], seen: Set<string>, id: string | null | undefined, kind: ActionTarget['kind'], role: TargetRole) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({ id, kind, role });
};

// svgId → voltage-level node, built once per metadata index (an edge names
// its two ends by svgId, the index is keyed by voltage-level id).
const nodesBySvgIdCache = new WeakMap<Map<string, NodeMeta>, Map<string, NodeMeta>>();
const nodesBySvgId = (nodes: Map<string, NodeMeta>): Map<string, NodeMeta> => {
    let index = nodesBySvgIdCache.get(nodes);
    if (!index) {
        index = new Map();
        nodes.forEach(n => index!.set(n.svgId, n));
        nodesBySvgIdCache.set(nodes, index);
    }
    return index;
};

/** The voltage levels at the two ends of a branch (line / transformer / PST):
 *  the SLDs the operator opens next. */
const branchVoltageLevels = (edge: EdgeMeta | undefined, nodes: Map<string, NodeMeta>): string[] => {
    if (!edge) return [];
    const bySvgId = nodesBySvgId(nodes);
    return [edge.node1, edge.node2]
        .map(ref => (bySvgId.get(ref) ?? nodes.get(ref))?.equipmentId)
        .filter((vl): vl is string => !!vl);
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
    const locations: ActionLocation[] = [];
    const seen = new Set<string>();

    const injectionVls = new Set<string>();
    const injections: { name: string; role: TargetRole }[] = [];
    details.load_shedding_details?.forEach(d => { injections.push({ name: d.load_name, role: 'load' }); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    details.curtailment_details?.forEach(d => { injections.push({ name: d.gen_name, role: 'generator' }); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    details.redispatch_details?.forEach(d => { injections.push({ name: d.gen_name, role: 'generator' }); if (d.voltage_level_id) injectionVls.add(d.voltage_level_id); });
    injections.forEach(({ name, role }) => uniquePush(title, seen, name, 'equipment', role));

    const isCoupling = isCouplingAction(id, details.description_unitaire);
    const topo = details.action_topology;
    const lines = edgesByEquipmentId
        ? getActionTargetLines(details, id, edgesByEquipmentId)
        : Array.from(new Set([
            ...(isCoupling ? [] : Object.keys(topo?.lines_ex_bus || {})),
            ...(isCoupling ? [] : Object.keys(topo?.lines_or_bus || {})),
            ...Object.keys(topo?.pst_tap || {}),
        ]));
    const pstLines = new Set(Object.keys(topo?.pst_tap || {}));
    lines.forEach(line => uniquePush(title, seen, line, 'line', pstLines.has(line) ? 'phaseShifter' : 'branch'));

    // Backend VL hint (switch-based dictionary actions), the voltage level a
    // manual manoeuvre was built on, then whatever the metadata resolves.
    const vls: string[] = [];
    const hint = (topo as { voltage_level_id?: string } | undefined)?.voltage_level_id;
    if (hint) vls.push(hint);
    id.split('+').forEach(part => { const vl = manualActionVoltageLevel(part); if (vl) vls.push(vl); });
    if (nodesByEquipmentId) vls.push(...getActionTargetVoltageLevels(details, id, nodesByEquipmentId));
    // A voltage level the title names is a coupling when the action opens /
    // closes one, else a substation the operator manoeuvred.
    const kinds = classifyActionTypes(id, details.description_unitaire, null);
    const vlRole: TargetRole = isCoupling || kinds.has('open') || kinds.has('close') ? 'coupling' : 'substation';
    vls.filter(vl => !injectionVls.has(vl)).forEach(vl => uniquePush(title, seen, vl, 'vl', vlRole));

    // The SLD chips: the injections' voltage levels, then the ones the title
    // names (the title link only underlines on hover — the chip is the
    // visible way into the SLD), then the two ends of every branch the title
    // names — line, transformer or PST.
    const seenLocation = new Set<string>();
    const addLocation = (vl: string) => {
        if (seenLocation.has(vl)) return;
        seenLocation.add(vl);
        locations.push({ id: vl, kind: 'vl' });
    };
    injectionVls.forEach(addLocation);
    title.filter(t => t.kind === 'vl').forEach(t => addLocation(t.id));
    if (nodesByEquipmentId && edgesByEquipmentId) {
        title.filter(t => t.kind === 'line').forEach(t =>
            branchVoltageLevels(edgesByEquipmentId.get(t.id), nodesByEquipmentId).forEach(addLocation));
    }

    if (title.length === 0) {
        [...Object.keys(topo?.gens_bus || {}), ...Object.keys(topo?.gens_p || {})]
            .forEach(eq => uniquePush(title, seen, eq, 'equipment', 'generator'));
        [...Object.keys(topo?.loads_bus || {}), ...Object.keys(topo?.loads_p || {})]
            .forEach(eq => uniquePush(title, seen, eq, 'equipment', 'load'));
    }
    return { title, locations };
};
