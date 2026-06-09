// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/*
 * Action-overview pin DATA builders — pure functions, no DOM access.
 *
 * Separated from `actionPinRender.ts` so the severity palette, anchor
 * resolution, and pin descriptor construction can be tested without
 * jsdom.
 */

import type {
    ActionDetail,
    ActionSeverityCategory,
    MetadataIndex,
    NodeMeta,
    UnsimulatedActionScoreInfo,
} from '../../types';
import { pinColors, pinColorsDimmed, pinColorsHighlighted } from '../../styles/tokens';
import { getActionTargetLines, getActionTargetVoltageLevels } from './highlights';

export interface ActionPinInfo {
    id: string;
    x: number;
    y: number;
    severity: 'green' | 'orange' | 'red' | 'grey';
    label: string;
    title: string;
    /**
     * When true this pin represents an action from the scored table
     * that has NOT yet been simulated. Rendered with a dashed outline
     * and reduced opacity, and double-clicking it kicks off a manual
     * simulation (the same code path as the Manual Selection dropdown).
     */
    unsimulated?: boolean;
    /**
     * When true this pin was filtered out by the overview header
     * filter but kept visible because a passing combined action
     * references it. Rendered with reduced opacity so it reads as
     * a context pin rather than a first-class action.
     */
    dimmedByFilter?: boolean;
}

/**
 * Descriptor for a combined-action pin — rendered at the midpoint of
 * a curved connection between the two unitary action pins it combines.
 */
export interface CombinedPinInfo {
    /** Pair key, e.g. "action1+action2". */
    pairId: string;
    /** The two unitary action ids. */
    action1Id: string;
    action2Id: string;
    /** Anchor positions of the two unitary pins (endpoints of the curve). */
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    /** Midpoint of the curve (where the combined pin sits). */
    x: number;
    y: number;
    /** Max loading after combined application. */
    label: string;
    title: string;
    severity: ActionPinInfo['severity'];
}

export const severityFill: Record<ActionPinInfo['severity'], string> = pinColors;

/**
 * Dimmed fill colours for rejected actions — each severity hue is
 * shifted toward grey and lowered in saturation so the pin recedes
 * visually while still being colour-identifiable.
 */
export const severityFillDimmed: Record<ActionPinInfo['severity'], string> = pinColorsDimmed;

/**
 * Highlighted (selected) fill colours — slightly more vivid/brighter
 * versions of the severity palette so the pin stands out.
 */
export const severityFillHighlighted: Record<ActionPinInfo['severity'], string> = pinColorsHighlighted;

export const computeActionSeverity = (
    details: ActionDetail,
    monitoringFactor: number,
): ActionPinInfo['severity'] => {
    if (details.non_convergence || details.is_islanded) return 'grey';
    if (details.max_rho == null) {
        return details.is_rho_reduction ? 'green' : 'red';
    }
    if (details.max_rho > monitoringFactor) return 'red';
    if (details.max_rho > monitoringFactor - 0.05) return 'orange';
    return 'green';
};

/**
 * Predicate used by both the overview (pin visibility) and the sidebar
 * ActionFeed (card visibility) to decide whether an action passes the
 * active category + threshold filters.
 *
 * - `categoryEnabled` controls the four severity buckets (green / orange
 *   / red / grey); if the action's bucket is disabled, it is hidden.
 * - `threshold` is a max-loading cap: actions whose `max_rho` is
 *   **strictly greater** than the threshold are hidden. Actions with a
 *   null `max_rho` (divergent / islanded — all in the 'grey' bucket)
 *   bypass the threshold so the operator keeps seeing non-numeric
 *   outcomes when the grey category is enabled.
 */
export const actionPassesOverviewFilter = (
    details: ActionDetail,
    monitoringFactor: number,
    categoryEnabled: Record<ActionSeverityCategory, boolean>,
    threshold: number,
): boolean => {
    const severity = computeActionSeverity(details, monitoringFactor);
    if (!categoryEnabled[severity]) return false;
    if (details.max_rho != null && details.max_rho > threshold) return false;
    return true;
};

/**
 * Format the loading label shown on the pin body.
 *
 * Exported so tests can pin the exact string contract: percentage,
 * "DIV" on divergence, "ISL" on islanding, or em-dash otherwise.
 */
export const formatPinLabel = (details: ActionDetail): string => {
    if (details.max_rho != null) return `${(details.max_rho * 100).toFixed(0)}%`;
    if (details.non_convergence) return 'DIV';
    if (details.is_islanded) return 'ISL';
    return '\u2014';
};

/**
 * Build the human-readable title (tooltip) shown on hover. The `idLabel`
 * is the pin id as the user thinks of it (e.g. "a+b" for combined).
 */
export const formatPinTitle = (idLabel: string, details: ActionDetail): string => {
    const parts = [
        idLabel,
        details.description_unitaire,
        details.max_rho != null
            ? `max loading ${(details.max_rho * 100).toFixed(1)}%${details.max_rho_line ? ` on ${details.max_rho_line}` : ''}`
            : details.non_convergence
                ? 'load-flow divergent'
                : details.is_islanded
                    ? 'islanding'
                    : '',
    ];
    return parts.filter(Boolean).join(' \u2014 ');
};

/**
 * Resolve an action to a point on the NAD background.
 *
 * For line / PST actions we take the midpoint of the edge; for
 * nodal actions we take the voltage-level node position. Returns
 * null when no impacted asset can be located — the pin is then
 * silently skipped.
 */
export const resolveActionAnchor = (
    actionId: string,
    details: ActionDetail,
    metaIndex: MetadataIndex,
): { x: number; y: number } | null => {
    const { nodesByEquipmentId, nodesBySvgId, edgesByEquipmentId } = metaIndex;

    const lookupNode = (nodeRef: unknown): NodeMeta | undefined => {
        if (typeof nodeRef !== 'string') return undefined;
        return nodesBySvgId.get(nodeRef) ?? nodesByEquipmentId.get(nodeRef);
    };

    // Load shedding / curtailment actions carry an explicit
    // voltage_level_id in their detail objects — use it directly
    // so the pin lands on the VL node, not on an unrelated line.
    if (details.load_shedding_details?.length) {
        const vlId = details.load_shedding_details[0].voltage_level_id;
        if (vlId) {
            const node = nodesByEquipmentId.get(vlId);
            if (node && Number.isFinite(node.x)) return { x: node.x, y: node.y };
        }
    }
    if (details.curtailment_details?.length) {
        const vlId = details.curtailment_details[0].voltage_level_id;
        if (vlId) {
            const node = nodesByEquipmentId.get(vlId);
            if (node && Number.isFinite(node.x)) return { x: node.x, y: node.y };
        }
    }
    if (details.redispatch_details?.length) {
        const vlId = details.redispatch_details[0].voltage_level_id;
        if (vlId) {
            const node = nodesByEquipmentId.get(vlId);
            if (node && Number.isFinite(node.x)) return { x: node.x, y: node.y };
        }
    }

    // Try line targets first
    const lineTargets = getActionTargetLines(details, actionId, edgesByEquipmentId);
    for (const lineName of lineTargets) {
        const edge = edgesByEquipmentId.get(lineName);
        if (!edge) continue;
        const n1 = lookupNode(edge.node1);
        const n2 = lookupNode(edge.node2);
        if (n1 && n2 && Number.isFinite(n1.x) && Number.isFinite(n2.x)) {
            return { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 };
        }
        if (n1 && Number.isFinite(n1.x)) return { x: n1.x, y: n1.y };
        if (n2 && Number.isFinite(n2.x)) return { x: n2.x, y: n2.y };
    }

    // Fallback on voltage-level targets
    const vlTargets = getActionTargetVoltageLevels(details, actionId, nodesByEquipmentId);
    for (const vlName of vlTargets) {
        const node = nodesByEquipmentId.get(vlName);
        if (node && Number.isFinite(node.x)) {
            return { x: node.x, y: node.y };
        }
    }

    // Last resort: max_rho_line (a line the action redistributes onto)
    if (details.max_rho_line) {
        const edge = edgesByEquipmentId.get(details.max_rho_line);
        if (edge) {
            const n1 = lookupNode(edge.node1);
            const n2 = lookupNode(edge.node2);
            if (n1 && n2 && Number.isFinite(n1.x) && Number.isFinite(n2.x)) {
                return { x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 };
            }
        }
    }
    return null;
};

/**
 * Fan out pins that share the same anchor position so they don't
 * stack on top of each other and remain individually clickable.
 *
 * Mutates `pins` in place. Exported so tests can exercise the
 * fan-out independently from the full builder.
 */
export const fanOutColocatedPins = (pins: ActionPinInfo[], offsetRadius = 30 * 1.2): void => {
    const bucketKey = (p: ActionPinInfo) =>
        `${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`;
    const groups = new Map<string, number[]>();
    pins.forEach((p, i) => {
        const k = bucketKey(p);
        const arr = groups.get(k);
        if (arr) arr.push(i);
        else groups.set(k, [i]);
    });
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;
        const angleStep = (2 * Math.PI) / indices.length;
        indices.forEach((idx, i) => {
            const angle = -Math.PI / 2 + i * angleStep;
            pins[idx] = {
                ...pins[idx],
                x: pins[idx].x + offsetRadius * Math.cos(angle),
                y: pins[idx].y + offsetRadius * Math.sin(angle),
            };
        });
    }
};

/**
 * Build the list of pin descriptors for the action-overview view.
 * Pure function — no DOM access — so it can be unit-tested.
 *
 * When `overviewFilter` is provided, pins whose action does not pass
 * the active category + threshold filters are dropped. The same
 * predicate drives the ActionFeed card filtering, keeping the two
 * views in lock-step.
 */
export const buildActionOverviewPins = (
    actions: Record<string, ActionDetail>,
    metaIndex: MetadataIndex,
    monitoringFactor: number,
    filterIds?: Iterable<string>,
    overviewFilter?: {
        categories: Record<ActionSeverityCategory, boolean>;
        threshold: number;
    } | null,
): ActionPinInfo[] => {
    const allowed = filterIds ? new Set(filterIds) : null;
    const pins: ActionPinInfo[] = [];
    for (const [actionId, details] of Object.entries(actions)) {
        if (allowed && !allowed.has(actionId)) continue;
        // Skip combined-action entries (key contains '+') — those are
        // rendered separately by buildCombinedActionPins with a curved
        // connection between their constituent unitary pins.
        if (actionId.includes('+')) continue;
        if (overviewFilter && !actionPassesOverviewFilter(
            details, monitoringFactor, overviewFilter.categories, overviewFilter.threshold,
        )) continue;
        const anchor = resolveActionAnchor(actionId, details, metaIndex);
        if (!anchor) continue;
        const severity = computeActionSeverity(details, monitoringFactor);
        const label = formatPinLabel(details);
        const title = formatPinTitle(actionId, details);
        pins.push({ id: actionId, x: anchor.x, y: anchor.y, severity, label, title });
    }

    fanOutColocatedPins(pins);
    return pins;
};

/**
 * Format the SVG-title tooltip shown on hover for an un-simulated pin.
 * When {@link scoreInfo} is provided the tooltip carries the same
 * score-table data the Manual Selection dropdown exposes (type,
 * score, rank in category, MW/tap start), so the operator can triage
 * without leaving the overview. Falls back to a generic prompt when
 * score info is absent (e.g. older session reloads).
 */
export const buildUnsimulatedPinTitle = (
    id: string,
    info: UnsimulatedActionScoreInfo | undefined,
): string => {
    if (!info) {
        return `${id} — not yet simulated (double-click to run)`;
    }
    const lines: string[] = [
        `${id} — not yet simulated (double-click to run)`,
        `Type: ${info.type}`,
        `Score: ${info.score.toFixed(2)} — rank ${info.rankInType} of ${info.countInType} (max ${info.maxScoreInType.toFixed(2)})`,
    ];
    if (info.mwStart != null) {
        lines.push(`MW start: ${info.mwStart.toFixed(1)} MW`);
    }
    if (info.tapStart) {
        const ts = info.tapStart;
        const range = ts.low_tap != null && ts.high_tap != null
            ? ` (range ${ts.low_tap} … ${ts.high_tap})`
            : '';
        lines.push(`Tap start: ${ts.tap}${range}`);
    }
    return lines.join('\n');
};

/**
 * Build pin descriptors for actions that appear in the score table but
 * have NOT yet been simulated. These are rendered as dimmed, dashed
 * pins the operator can double-click to trigger a manual simulation.
 *
 * An unsimulated action has no `ActionDetail`, so anchoring goes
 * through `resolveActionAnchor` with a minimal stub; the helper
 * internally falls back on edge/VL lookups based on the id alone,
 * which matches what the score table does for line / coupling / PST
 * actions. Items that cannot be resolved are silently skipped.
 *
 * Pins whose id is already present in `simulatedIds` are skipped so
 * we never double-pin an action that is both scored and simulated.
 *
 * Pure function — no DOM access.
 */
export const buildUnsimulatedActionPins = (
    scoredActionIds: readonly string[],
    simulatedIds: ReadonlySet<string>,
    metaIndex: MetadataIndex,
    scoreInfo?: Readonly<Record<string, UnsimulatedActionScoreInfo>>,
): ActionPinInfo[] => {
    const pins: ActionPinInfo[] = [];
    const seen = new Set<string>();
    const stub: ActionDetail = {
        description_unitaire: '',
        rho_before: null,
        rho_after: null,
        max_rho: null,
        max_rho_line: '',
        is_rho_reduction: false,
    };
    for (const rawId of scoredActionIds) {
        const id = rawId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (simulatedIds.has(id)) continue;
        const anchor = resolveActionAnchor(id, stub, metaIndex);
        if (!anchor) continue;
        pins.push({
            id,
            x: anchor.x,
            y: anchor.y,
            severity: 'grey',
            label: '?',
            title: buildUnsimulatedPinTitle(id, scoreInfo?.[id]),
            unsimulated: true,
        });
    }

    fanOutColocatedPins(pins);
    return pins;
};

/**
 * Quadratic Bezier midpoint of (p1, ctrl, p2) at t=0.5.
 * Exported so the renderer can reuse the same control-point math for
 * drawing the connecting curve path.
 */
export const curveMidpoint = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    offsetFraction = 0.3,
): { ctrlX: number; ctrlY: number; midX: number; midY: number } => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ctrlX = (p1.x + p2.x) / 2 + (-dy / dist) * dist * offsetFraction;
    const ctrlY = (p1.y + p2.y) / 2 + (dx / dist) * dist * offsetFraction;
    const t = 0.5;
    const midX = (1 - t) * (1 - t) * p1.x + 2 * t * (1 - t) * ctrlX + t * t * p2.x;
    const midY = (1 - t) * (1 - t) * p1.y + 2 * t * (1 - t) * ctrlY + t * t * p2.y;
    return { ctrlX, ctrlY, midX, midY };
};

/**
 * Build descriptors for combined-action pins. A simulated combined
 * action is identified by an action key containing '+' in the
 * `actions` dict (e.g. "disco_X+reco_Y"). For each such entry the
 * function locates the two constituent unitary pins and produces a
 * `CombinedPinInfo` with a curved connection between them and a
 * dedicated pin at the curve midpoint.
 *
 * NOTE: simulated pairs land in `actions` (not `combined_actions`)
 * — see CombinedActionsModal's handleSimulate. That is why this
 * function scans `actions` for '+' keys rather than iterating over
 * `combined_actions`.
 *
 * Pure function — no DOM access.
 */
export const buildCombinedActionPins = (
    actions: Record<string, ActionDetail> | null | undefined,
    unitaryPins: readonly ActionPinInfo[],
    monitoringFactor: number,
): CombinedPinInfo[] => {
    if (!actions) return [];
    const pinById = new Map(unitaryPins.map(p => [p.id, p]));
    const result: CombinedPinInfo[] = [];

    const combinedKeys = Object.keys(actions).filter(k => k.includes('+'));
    if (combinedKeys.length > 0) {
        console.log('[buildCombinedActionPins] combined keys in actions:', combinedKeys);
        console.log('[buildCombinedActionPins] unitary pin ids:', [...pinById.keys()]);
    }

    for (const [actionId, detail] of Object.entries(actions)) {
        if (!actionId.includes('+')) continue;

        const parts = actionId.split('+');
        if (parts.length !== 2) continue;
        const [id1, id2] = parts;

        const pin1 = pinById.get(id1);
        const pin2 = pinById.get(id2);
        if (!pin1 || !pin2) {
            console.warn(`[buildCombinedActionPins] skipping "${actionId}": pin1(${id1})=${!!pin1}, pin2(${id2})=${!!pin2}`);
            continue;
        }

        const { midX, midY } = curveMidpoint(pin1, pin2);
        const severity = computeActionSeverity(detail, monitoringFactor);
        const label = formatPinLabel(detail);
        const title = formatPinTitle(`${id1} + ${id2}`, detail);

        result.push({
            pairId: actionId,
            action1Id: id1,
            action2Id: id2,
            p1: { x: pin1.x, y: pin1.y },
            p2: { x: pin2.x, y: pin2.y },
            x: midX,
            y: midY,
            label,
            title,
            severity,
        });
    }
    return result;
};
