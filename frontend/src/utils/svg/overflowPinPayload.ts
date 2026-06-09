// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/*
 * Pin descriptors posted from the parent React app to the overflow-graph
 * iframe.  The injected overlay (`expert_backend/services/overflow_overlay.py`)
 * renders one teardrop pin per descriptor anchored on the matching
 * substation node group (`<g class="node" data-name="<substation>">`).
 *
 * Pure module — no DOM access, no React — so it can be unit-tested
 * without jsdom and re-used from a worker if we later move pin
 * computation off the main thread.
 */

import type {
    ActionDetail,
    ActionOverviewFilters,
    MetadataIndex,
    UnsimulatedActionScoreInfo,
} from '../../types';
import {
    actionPassesOverviewFilter,
    buildUnsimulatedPinTitle,
    computeActionSeverity,
    formatPinLabel,
    type ActionPinInfo,
} from './actionPinData';
import {
    getActionTargetLines,
    getActionTargetVoltageLevels,
} from './highlights';
import { matchesActionTypeFilter } from '../actionTypes';

export interface OverflowPin {
    actionId: string;
    /**
     * Marks combined-action pins (action ids containing ``+``). The
     * overlay places one such pin at the midpoint of a curved Bézier
     * connector drawn between the two unitary constituent pins —
     * mirroring the Action Overview NAD's ``CombinedPinInfo`` layer
     * (see ``actionPinData.buildCombinedActionPins`` /
     * ``actionPinRender.renderCombinedPin``). When set, ``action1Id``
     * + ``action2Id`` MUST also be populated; ``substation`` /
     * ``lineNames`` / ``nodeCandidates`` are ignored — the combined
     * pin's position is derived from the constituent positions
     * client-side.
     */
    isCombined?: boolean;
    action1Id?: string;
    action2Id?: string;
    /**
     * When true the unitary pin failed the active overview filter
     * (severity / threshold / action-type) but is kept on the graph
     * because a passing combined-action pin references it as one
     * of its constituents. Mirrors the
     * ``ActionPinInfo.dimmedByFilter`` flag in
     * ``actionPinData.ts:39``. The overlay renders dimmedByFilter
     * pins with a reduced opacity so they read as context for the
     * combined glyph rather than as first-class actions.
     */
    dimmedByFilter?: boolean;
    /**
     * Primary anchor — substation id when the overflow graph nodes are
     * substations, otherwise the first matching voltage-level id. The
     * overlay JS tries this name first against ``data-name`` and falls
     * back to ``nodeCandidates``.
     */
    substation: string;
    /**
     * Additional anchor candidates the overlay tries in order if
     * ``substation`` doesn't match a graph node. Populated with the
     * action's target voltage-level ids, because some recommender
     * configurations emit VL-keyed nodes (e.g. small French grid)
     * while others emit substation-keyed nodes.
     */
    nodeCandidates?: string[];
    /**
     * Line names the overlay should try as edge anchors BEFORE
     * falling back to a single-node anchor. For branch actions
     * (disco / reco / max_rho_line) the pin should land at the
     * midpoint of the connecting edge — same anchoring rule the
     * Action Overview NAD pins use (see ``resolveActionAnchor`` in
     * ``actionPinData.ts``). The overlay matches each name against
     * the ``data-attr-name`` attribute of every ``<g class="edge">``
     * in the SVG and uses the midpoint of the edge's source/target
     * node centres.
     */
    lineNames?: string[];
    /** Loading-percentage label rendered inside the pin body. */
    label: string;
    severity: ActionPinInfo['severity'];
    isSelected: boolean;
    isRejected: boolean;
    /**
     * Marks scored-but-not-yet-simulated pins. The overlay renders
     * them with a dashed outline + dimmed fill and re-routes the
     * double-click message so the parent kicks off a manual
     * simulation instead of opening the SLD overlay. Mirrors the
     * Action Overview's unsimulated-pin contract.
     */
    unsimulated?: boolean;
    /**
     * Multi-line tooltip text rendered inside the pin's native
     * ``<title>`` element. Populated for un-simulated pins by
     * ``buildUnsimulatedPinTitle`` so hovering an overflow pin
     * surfaces the same score / rank / MW-start summary the Action
     * Overview pin tooltip shows. Falls back to ``actionId`` when
     * absent, preserving the legacy hover for simulated pins.
     */
    title?: string;
}

/**
 * Resolve an action to its first matching SUBSTATION on the overflow
 * graph.  We look for a target VL via the same heuristics used by the
 * NAD pin layer, then map VL → substation through the network's
 * `voltage-level-substations` table.
 *
 * Returns null when no substation can be resolved (action has no
 * known VL target, or the network's VLs are not mapped to a
 * substation — e.g. a pure-VL test fixture). The pin is then silently
 * dropped, matching the NAD overview behaviour.
 */
interface ResolvedAnchor {
    /** Best-guess substation id (overflow graph node ``data-name``). */
    substation: string;
    /**
     * Voltage-level ids the action targets, ordered so the most
     * specific match comes first. These act as fallback anchors when
     * the overflow graph nodes are voltage levels rather than
     * substations.
     */
    vlIds: string[];
    /**
     * Line names the action targets, in priority order. The overlay
     * tries each as an edge anchor (midpoint of source/target nodes)
     * before falling back to single-node candidates. Empty when the
     * action does not target a line (load shedding / curtailment /
     * pure topology actions).
     */
    lineNames: string[];
}

const resolveActionSubstation = (
    actionId: string,
    details: ActionDetail,
    metaIndex: MetadataIndex,
    vlToSubstation: Readonly<Record<string, string>>,
    overflowSubstationSet: ReadonlySet<string>,
): ResolvedAnchor | null => {
    const candidateVls: string[] = [];
    const candidateLines: string[] = [];
    const pushVl = (vlId: string | null | undefined) => {
        if (vlId && !candidateVls.includes(vlId)) candidateVls.push(vlId);
    };
    const pushLine = (lineName: string | null | undefined) => {
        if (lineName && !candidateLines.includes(lineName)) {
            candidateLines.push(lineName);
        }
    };

    // Load-shedding / curtailment actions land on a single VL —
    // they do NOT target a branch even though their description /
    // id may incidentally contain a line name (e.g. ``max_rho_line``
    // is set on EVERY action). EARLY RETURN with only the VL anchor
    // here, exactly like ``resolveActionAnchor`` in actionPinData,
    // so the overlay's edge-midpoint path is skipped and the pin
    // lands on the substation node.
    if (details.load_shedding_details?.length) {
        const vlId = details.load_shedding_details[0].voltage_level_id;
        if (vlId) {
            const sub = vlToSubstation[vlId];
            const substation = (sub && overflowSubstationSet.has(sub))
                ? sub
                : (sub || vlId);
            return { substation, vlIds: [vlId], lineNames: [] };
        }
    }
    if (details.curtailment_details?.length) {
        const vlId = details.curtailment_details[0].voltage_level_id;
        if (vlId) {
            const sub = vlToSubstation[vlId];
            const substation = (sub && overflowSubstationSet.has(sub))
                ? sub
                : (sub || vlId);
            return { substation, vlIds: [vlId], lineNames: [] };
        }
    }
    if (details.redispatch_details?.length) {
        const vlId = details.redispatch_details[0].voltage_level_id;
        if (vlId) {
            const sub = vlToSubstation[vlId];
            const substation = (sub && overflowSubstationSet.has(sub))
                ? sub
                : (sub || vlId);
            return { substation, vlIds: [vlId], lineNames: [] };
        }
    }

    // Track the action's PRIMARY branch targets vs a max_rho_line
    // fallback separately so we can apply the same priority order
    // ``resolveActionAnchor`` uses on the Action Overview NAD:
    //   1. primary line targets → edge midpoint
    //   2. voltage-level targets → VL node
    //   3. max_rho_line → edge midpoint (LAST resort only)
    // Without this split, coupler / node-merging / generic VL
    // actions would land on the action's incidental max_rho_line
    // instead of their actual target VL.
    const primaryLines: string[] = [];
    const lineTargets = getActionTargetLines(
        details, actionId, metaIndex.edgesByEquipmentId,
    );
    for (const lineName of lineTargets) {
        primaryLines.push(lineName);
        const edge = metaIndex.edgesByEquipmentId.get(lineName);
        if (!edge) continue;
        for (const ref of [edge.node1, edge.node2]) {
            if (typeof ref !== 'string') continue;
            const node = metaIndex.nodesBySvgId.get(ref)
                ?? metaIndex.nodesByEquipmentId.get(ref);
            if (node?.equipmentId) pushVl(node.equipmentId);
        }
    }

    // Voltage-level targets parsed from the action description / id.
    const vlTargetIds = getActionTargetVoltageLevels(
        details, actionId, metaIndex.nodesByEquipmentId,
    );
    for (const vlId of vlTargetIds) {
        pushVl(vlId);
    }

    // max_rho_line — used as a LAST-resort line anchor (after VLs)
    // AND its endpoints feed candidateVls so pins still resolve when
    // neither primary lines nor explicit VL targets are present.
    let fallbackLine: string | null = null;
    if (details.max_rho_line) {
        fallbackLine = details.max_rho_line;
        const edge = metaIndex.edgesByEquipmentId.get(details.max_rho_line);
        if (edge) {
            for (const ref of [edge.node1, edge.node2]) {
                if (typeof ref !== 'string') continue;
                const node = metaIndex.nodesBySvgId.get(ref)
                    ?? metaIndex.nodesByEquipmentId.get(ref);
                pushVl(node?.equipmentId);
            }
        }
    }

    // Pick the line-anchor strategy in priority order. When the
    // action has VL targets (couplers, node-merging, …) we leave
    // ``candidateLines`` empty so the overlay goes straight to the
    // VL node anchor — the max_rho_line is only an anchor of last
    // resort.
    if (primaryLines.length > 0) {
        for (const ln of primaryLines) pushLine(ln);
    } else if (vlTargetIds.length === 0 && fallbackLine) {
        pushLine(fallbackLine);
    }

    if (candidateVls.length === 0 && candidateLines.length === 0) {
        return null;
    }

    // Pick the first VL whose substation is present in the overflow
    // graph (best UX when the graph is substation-keyed). Otherwise
    // fall back to the first candidate's substation — the overlay JS
    // will still try the VL ids themselves as anchor candidates.
    let substation: string | null = null;
    for (const vlId of candidateVls) {
        const sub = vlToSubstation[vlId];
        if (sub && overflowSubstationSet.has(sub)) {
            substation = sub;
            break;
        }
    }
    if (!substation) {
        // No substation matched the overflow set; pick the first
        // mapped substation (or the first VL itself when no mapping
        // exists — e.g. test fixtures).
        for (const vlId of candidateVls) {
            const sub = vlToSubstation[vlId];
            if (sub) { substation = sub; break; }
        }
    }
    if (!substation) substation = candidateVls[0] ?? "";
    return { substation, vlIds: candidateVls, lineNames: candidateLines };
};

/**
 * Build the descriptor list to post to the overflow-graph iframe.
 *
 * @param overflowSubstations  Optional set of substation ids known to
 *                              be present in the overflow graph. When
 *                              provided, pins for substations outside
 *                              the set are dropped (avoids pinning on
 *                              a substation hidden by the
 *                              `keep_overloads_components` filter).
 *                              When omitted, every resolvable pin is
 *                              kept — useful for tests.
 */
export const buildOverflowPinPayload = (
    actions: Record<string, ActionDetail> | null | undefined,
    metaIndex: MetadataIndex | null | undefined,
    vlToSubstation: Readonly<Record<string, string>>,
    monitoringFactor: number,
    selectedActionIds: ReadonlySet<string>,
    rejectedActionIds: ReadonlySet<string>,
    overflowSubstations?: ReadonlySet<string>,
    /**
     * Optional Action-Overview-style filters. When passed, pins are
     * dropped according to the SAME rules ``ActionOverviewDiagram``
     * applies to its NAD pins (severity category, max-loading
     * threshold, action-type chip). Without it every resolvable pin
     * is emitted (legacy behaviour preserved for tests / standalone).
     */
    overviewFilters?: ActionOverviewFilters,
): OverflowPin[] => {
    if (!actions || !metaIndex) return [];
    // When no substation set is provided, accept every resolved one.
    const knownSet = overflowSubstations ?? new Set<string>();
    const acceptAny = !overflowSubstations;

    // Three-pass pipeline mirroring ``ActionOverviewDiagram`` (the
    // ``pins``/``combinedPins`` memos at component.tsx:314-380):
    //
    //   1. Build every unitary anchor UNFILTERED so combined pins
    //      have endpoints to anchor on even when one half would
    //      fail the active severity / threshold / action-type chip.
    //   2. Determine which combined actions pass the filter; their
    //      two unitary ids form the ``protectedIds`` set.
    //   3. Re-filter the unitary list:
    //        - passes filter            → emit at full strength,
    //        - fails but in protectedIds → emit with dimmedByFilter,
    //        - fails and unprotected     → drop entirely.
    //   4. Emit combined-pin descriptors for the passing combined
    //      actions. The overlay JS computes their midpoint client-
    //      side from the constituent positions.

    interface UnitaryDraft {
        actionId: string;
        details: ActionDetail;
        anchor: ResolvedAnchor;
    }
    const unitaryDrafts: UnitaryDraft[] = [];
    const unitaryDraftIds = new Set<string>();
    for (const [actionId, details] of Object.entries(actions)) {
        if (actionId.includes('+')) continue;
        const anchor = resolveActionSubstation(
            actionId, details, metaIndex, vlToSubstation,
            acceptAny ? new Set(Object.values(vlToSubstation)) : knownSet,
        );
        if (!anchor) continue;
        unitaryDrafts.push({ actionId, details, anchor });
        unitaryDraftIds.add(actionId);
    }

    // ``passesAll`` mirrors the same name in ActionOverviewDiagram —
    // category + threshold AND the single-select action-type chip.
    const passesAll = (id: string, det: ActionDetail): boolean => {
        if (!overviewFilters) return true;
        if (!actionPassesOverviewFilter(
            det, monitoringFactor,
            overviewFilters.categories, overviewFilters.threshold,
        )) return false;
        return matchesActionTypeFilter(
            overviewFilters.actionType,
            id, det.description_unitaire, null,
        );
    };

    // A combined pin passes the type chip if EITHER constituent
    // matches — combined actions are inherently multi-type and
    // hiding a pair because one side doesn't match would surprise
    // the operator. (Identical rule to ``combinedPassesTypeFilter``
    // in ActionOverviewDiagram.)
    const combinedPassesTypeFilter = (id1: string, id2: string): boolean => {
        if (!overviewFilters || overviewFilters.actionType === 'all') return true;
        const d1 = actions[id1];
        const d2 = actions[id2];
        return (
            (d1 ? matchesActionTypeFilter(
                overviewFilters.actionType, id1, d1.description_unitaire, null,
            ) : false)
            || (d2 ? matchesActionTypeFilter(
                overviewFilters.actionType, id2, d2.description_unitaire, null,
            ) : false)
        );
    };

    // Pass 2 — find combined actions that pass the filter and
    // build the protected-id set.
    interface CombinedDraft {
        actionId: string;
        details: ActionDetail;
        action1Id: string;
        action2Id: string;
    }
    const combinedDrafts: CombinedDraft[] = [];
    const protectedIds = new Set<string>();
    for (const [actionId, details] of Object.entries(actions)) {
        if (!actionId.includes('+')) continue;
        const parts = actionId.split('+');
        if (parts.length !== 2) continue;
        const [id1, id2] = parts;
        if (!unitaryDraftIds.has(id1) || !unitaryDraftIds.has(id2)) continue;
        if (overviewFilters) {
            if (!actionPassesOverviewFilter(
                details, monitoringFactor,
                overviewFilters.categories, overviewFilters.threshold,
            )) continue;
            if (!combinedPassesTypeFilter(id1, id2)) continue;
        }
        combinedDrafts.push({ actionId, details, action1Id: id1, action2Id: id2 });
        protectedIds.add(id1);
        protectedIds.add(id2);
    }

    // Pass 3 — emit the unitary pins, dimming the protected fails.
    // When the "combined only" toggle is active, drop every unitary
    // pin that is NOT a constituent of a passing combined pin and
    // mark the survivors as dimmed-by-filter — same contract as the
    // ``ActionOverviewDiagram`` ``pins`` memo, so the two surfaces
    // stay in lock-step.
    const combinedOnly = !!overviewFilters?.showCombinedOnly;
    const out: OverflowPin[] = [];
    for (const u of unitaryDrafts) {
        const passes = passesAll(u.actionId, u.details);
        if (combinedOnly) {
            if (!protectedIds.has(u.actionId)) continue;
        } else if (!passes && !protectedIds.has(u.actionId)) {
            continue;
        }
        const dimmedByFilter = combinedOnly || !passes;
        out.push({
            actionId: u.actionId,
            substation: u.anchor.substation,
            nodeCandidates: u.anchor.vlIds.filter(v => v !== u.anchor.substation),
            lineNames: u.anchor.lineNames,
            label: formatPinLabel(u.details),
            severity: computeActionSeverity(u.details, monitoringFactor),
            isSelected: selectedActionIds.has(u.actionId),
            isRejected: rejectedActionIds.has(u.actionId),
            ...(dimmedByFilter ? { dimmedByFilter: true } : {}),
        });
    }

    // Pass 4 — emit the combined-pin descriptors.
    for (const cp of combinedDrafts) {
        out.push({
            actionId: cp.actionId,
            isCombined: true,
            action1Id: cp.action1Id,
            action2Id: cp.action2Id,
            substation: '',
            label: formatPinLabel(cp.details),
            severity: computeActionSeverity(cp.details, monitoringFactor),
            isSelected: selectedActionIds.has(cp.actionId),
            isRejected: rejectedActionIds.has(cp.actionId),
        });
    }
    return out;
};

/**
 * Build the descriptor list of un-simulated action pins for the
 * overflow-graph iframe. Mirrors ``buildUnsimulatedActionPins`` in
 * ``actionPinData.ts``: every scored-but-not-simulated id resolves
 * via the same anchor logic with a stub ``ActionDetail``, lands as
 * a dimmed pin with ``severity='grey'`` / ``label='?'`` and the
 * ``unsimulated: true`` flag the overlay reads to switch shape /
 * dblclick semantics.
 *
 * Items already in ``simulatedIds`` are skipped (they're rendered
 * by ``buildOverflowPinPayload`` instead).
 *
 * When ``overviewFilters.actionType`` is provided and not ``'all'``,
 * ids that don't match the active type chip (DISCO / RECO / LS /
 * OPEN / CLOSE / PST / RC) are dropped — mirroring the Action
 * Overview's ``unsimulatedPins`` memo so the chip filter behaves
 * consistently across both tabs. Like the Overview, we prefer the
 * score-info ``type`` field when available and fall back to
 * id-based heuristics in ``classifyActionType``.
 */
export const buildOverflowUnsimulatedPinPayload = (
    scoredActionIds: readonly string[],
    simulatedIds: ReadonlySet<string>,
    metaIndex: MetadataIndex | null | undefined,
    vlToSubstation: Readonly<Record<string, string>>,
    scoreInfo?: Readonly<Record<string, UnsimulatedActionScoreInfo>>,
    overflowSubstations?: ReadonlySet<string>,
    overviewFilters?: ActionOverviewFilters,
): OverflowPin[] => {
    if (!metaIndex || scoredActionIds.length === 0) return [];
    // Un-simulated actions can never participate in a computed pair —
    // when the operator restricts the overview to combined-only pins
    // there is nothing for this layer to emit.
    if (overviewFilters?.showCombinedOnly) return [];
    const knownSet = overflowSubstations ?? new Set<string>();
    const acceptAny = !overflowSubstations;
    // Stub ActionDetail used for anchor resolution — un-simulated
    // actions have no rho yet, so we feed empty strings / nulls and
    // rely on the action id's structure (line / VL / coupler tokens)
    // to drive ``getActionTargetLines`` / ``getActionTargetVoltageLevels``.
    const stub: ActionDetail = {
        description_unitaire: '',
        rho_before: null,
        rho_after: null,
        max_rho: null,
        max_rho_line: '',
        is_rho_reduction: false,
    };
    const activeType = overviewFilters?.actionType ?? 'all';
    const out: OverflowPin[] = [];
    const seen = new Set<string>();
    for (const rawId of scoredActionIds) {
        const id = rawId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (simulatedIds.has(id)) continue;
        // Action-type chip filter — same rule as the Action Overview
        // (`ActionOverviewDiagram.tsx` `unsimulatedPins` memo).
        if (activeType !== 'all') {
            const scoreType = scoreInfo?.[id]?.type ?? null;
            if (!matchesActionTypeFilter(activeType, id, null, scoreType)) continue;
        }
        const anchor = resolveActionSubstation(
            id, stub, metaIndex, vlToSubstation,
            acceptAny ? new Set(Object.values(vlToSubstation)) : knownSet,
        );
        if (!anchor) continue;
        out.push({
            actionId: id,
            substation: anchor.substation,
            nodeCandidates: anchor.vlIds.filter(v => v !== anchor.substation),
            lineNames: anchor.lineNames,
            label: '?',
            severity: 'grey',
            isSelected: false,
            isRejected: false,
            unsimulated: true,
            // Multi-line hover tooltip mirrors the Action Overview's
            // un-simulated pin: id + score + rank + MW-start.
            title: buildUnsimulatedPinTitle(id, scoreInfo?.[id]),
        });
    }
    return out;
};
