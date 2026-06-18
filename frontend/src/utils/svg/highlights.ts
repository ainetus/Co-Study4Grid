// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { ActionDetail, EdgeMeta, MetadataIndex, NodeMeta } from '../../types';
import { getIdMap } from './idMap';

/**
 * Create or find the background layer at the root of the SVG. Highlight
 * clones live here so they render BEHIND the NAD content — matching the
 * visual stack of contingency / overload halos.
 */
export const getBackgroundLayer = (container: HTMLElement): Element | null => {
    let backgroundLayer = container.querySelector('#nad-background-layer');
    if (!backgroundLayer) {
        const svg = container.querySelector('svg');
        if (svg) {
            backgroundLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            backgroundLayer.setAttribute('id', 'nad-background-layer');
            if (svg.firstChild) {
                svg.insertBefore(backgroundLayer, svg.firstChild);
            } else {
                svg.appendChild(backgroundLayer);
            }
        }
    }
    return backgroundLayer;
};

/**
 * Apply orange highlights to overloaded line edges on a given SVG container.
 */
export const applyOverloadedHighlights = (
    container: HTMLElement,
    metaIndex: MetadataIndex,
    overloadedLines: string[],
) => {
    if (!container || !metaIndex) return;

    // Remove existing highlights from both originals and clones
    container.querySelectorAll('.nad-overloaded').forEach(el => {
        if (el.classList.contains('nad-highlight-clone')) {
            el.remove();
        } else {
            el.classList.remove('nad-overloaded');
        }
    });

    if (!overloadedLines || overloadedLines.length === 0) return;

    const backgroundLayer = getBackgroundLayer(container);
    const { edgesByEquipmentId } = metaIndex;
    const idMap = getIdMap(container);

    let cachedBgCTM: DOMMatrix | null = null;

    overloadedLines.forEach(lineName => {
        const edge = edgesByEquipmentId.get(lineName);
        if (edge && edge.svgId) {
            const el = idMap.get(edge.svgId);
            if (el) {
                if (backgroundLayer) {
                    const clone = el.cloneNode(true) as SVGGraphicsElement;
                    clone.classList.add('nad-overloaded');
                    clone.classList.add('nad-highlight-clone');
                    clone.classList.remove('nad-delta-positive', 'nad-delta-negative', 'nad-delta-grey');
                    clone.removeAttribute('id');
                    clone.style.display = 'block';
                    clone.style.visibility = 'visible';

                    try {
                        const elCTM = (el as SVGGraphicsElement).getScreenCTM();
                        if (!cachedBgCTM) cachedBgCTM = (backgroundLayer as SVGGraphicsElement).getScreenCTM();
                        if (elCTM && cachedBgCTM) {
                            const relativeCTM = cachedBgCTM.inverse().multiply(elCTM);
                            const matrixStr = `matrix(${relativeCTM.a}, ${relativeCTM.b}, ${relativeCTM.c}, ${relativeCTM.d}, ${relativeCTM.e}, ${relativeCTM.f})`;
                            clone.setAttribute('transform', matrixStr);
                        }
                    } catch (e) {
                        console.warn('Failed to get CTM for overloaded highlight:', e);
                    }

                    backgroundLayer.appendChild(clone);
                } else {
                    el.classList.add('nad-overloaded');
                }
            }
        }
    });
};

/**
 * Robust detection of coupling/nodal actions.
 */
export const isCouplingAction = (actionId: string | null, description?: string): boolean => {
    const q = ((actionId || '') + ' ' + (description || '')).toLowerCase();
    return q.includes('coupling') || q.includes('busbar') || q.includes('coupl') || q.includes('noeud') || q.includes('node');
};

/**
 * Determine which lines an action acts upon (for line disconnection /
 * reconnection / PST actions).
 *
 * IMPORTANT for combined actions (e.g. `disco_X+coupling_Y`): the
 * coupling flag must be evaluated PER `+`-split part, not on the
 * full combined ID. Otherwise the presence of "coupling" in the
 * combined string incorrectly suppresses line-target extraction for
 * the non-coupling sub-action (the disco line loses its pink halo
 * and its action-card badge). Combined disco+coupling regression
 * fixed on the svgPatch rollout (2026-04-24).
 */
export const getActionTargetLines = (
    actionDetail: ActionDetail | null,
    actionId: string | null,
    edgesByEquipmentId: Map<string, EdgeMeta>,
): string[] => {
    const targets = new Set<string>();
    const topo = actionDetail?.action_topology;
    const parts = actionId ? actionId.split('+') : [];
    const isCombined = parts.length > 1;

    // PST tap lines are explicit in the topology and unambiguous even
    // in combined actions — always include them.
    if (topo) {
        Object.keys(topo.pst_tap || {}).forEach(l => targets.add(l));
    }

    // Topology-based bus/line extraction — only for PURE (non-combined)
    // actions. A combined action merges bus changes from multiple
    // sub-actions into one topology blob, so we can't cleanly attribute
    // them to specific lines. Combined-action line targets are picked up
    // by the per-part action-ID parser below instead.
    if (topo && !isCombined) {
        const isCoupling = isCouplingAction(actionId, actionDetail?.description_unitaire);
        if (!isCoupling) {
            const lineKeys = new Set([
                ...Object.keys(topo.lines_ex_bus || {}),
                ...Object.keys(topo.lines_or_bus || {}),
            ]);
            const genKeys = Object.keys(topo.gens_bus || {});
            const loadKeys = Object.keys(topo.loads_bus || {});
            const loadsPKeys = Object.keys(topo.loads_p || {});
            const gensPKeys = Object.keys(topo.gens_p || {});

            if (lineKeys.size > 0 && genKeys.length === 0 && loadKeys.length === 0
                && loadsPKeys.length === 0 && gensPKeys.length === 0) {
                lineKeys.forEach(l => targets.add(l));
            } else {
                const allValues = [
                    ...Object.values(topo.lines_ex_bus || {}),
                    ...Object.values(topo.lines_or_bus || {}),
                    ...Object.values(topo.gens_bus || {}),
                    ...Object.values(topo.loads_bus || {}),
                ];
                if (allValues.length > 0 && allValues.every(v => v === -1)) {
                    lineKeys.forEach(l => targets.add(l));
                }
            }
        }
    }

    // From action ID — per-part, applying the coupling test PER PART
    // so combined disco+coupling actions correctly extract the disco
    // line even though the combined string contains "coupling".
    parts.forEach(part => {
        if (isCouplingAction(part)) return;

        const cleanPart = part.replace(/_(inc|dec)\d+$/, '');

        if (edgesByEquipmentId.has(cleanPart)) {
            targets.add(cleanPart);
            return;
        }
        if (edgesByEquipmentId.has(part)) {
            targets.add(part);
            return;
        }

        const subParts = cleanPart.split('_');
        for (let i = 1; i < subParts.length; i++) {
            const candidate = subParts.slice(i).join('_');
            if (edgesByEquipmentId.has(candidate)) {
                targets.add(candidate);
                return;
            }
        }
        // Fallback: last segment
        const last = subParts[subParts.length - 1];
        if (edgesByEquipmentId.has(last)) {
            targets.add(last);
        }
    });

    return [...targets];
};

/**
 * Extract the voltage level name for nodal actions.
 */
export const getActionTargetVoltageLevels = (
    actionDetail: ActionDetail | null,
    actionId: string | null,
    nodesByEquipmentId: Map<string, NodeMeta>,
): string[] => {
    const targets = new Set<string>();
    const desc = actionDetail?.description_unitaire;
    const topo = actionDetail?.action_topology as (Record<string, unknown> & { voltage_level_id?: string }) | undefined;

    // Backend-supplied VL hint (e.g. pypowsybl switch-based actions
    // expose ``VoltageLevelId`` on the dict_action entry). Highest-
    // priority signal because it doesn't rely on string heuristics.
    if (topo?.voltage_level_id && nodesByEquipmentId.has(topo.voltage_level_id)) {
        targets.add(topo.voltage_level_id);
    }
    // Per-generator / per-load detail arrays carry an explicit
    // ``voltage_level_id`` — the authoritative target for load-shedding,
    // curtailment and redispatch actions (no string heuristics needed).
    const addVl = (vlId: string | null | undefined) => {
        if (vlId && nodesByEquipmentId.has(vlId)) targets.add(vlId);
    };
    actionDetail?.load_shedding_details?.forEach(d => addVl(d.voltage_level_id));
    actionDetail?.curtailment_details?.forEach(d => addVl(d.voltage_level_id));
    actionDetail?.redispatch_details?.forEach(d => addVl(d.voltage_level_id));
    if (desc && desc !== 'No description available') {
        // Try all quoted strings — any might be the VL name
        const quotedMatches = desc.match(/'([^']+)'/g);
        if (quotedMatches) {
            quotedMatches.forEach(match => {
                const vl = match.replace(/'/g, '');
                if (nodesByEquipmentId.has(vl)) targets.add(vl);
            });
        }
        // Match "dans le poste", "du poste", "au poste", etc.
        const posteMatches = desc.matchAll(/(?:dans le |du |au )?poste\s+'?([^',]+?)'?(?=\s*(?:['",]|$))/gi);
        for (const match of posteMatches) {
            const vl = match[1].trim();
            if (nodesByEquipmentId.has(vl)) {
                targets.add(vl);
            } else {
                // Try to find the longest prefix that matches a known node (handles "MICQ P7 is open")
                const parts = vl.split(/\s+/);
                for (let i = parts.length; i >= 1; i--) {
                    const candidate = parts.slice(0, i).join(' ');
                    if (nodesByEquipmentId.has(candidate)) {
                        targets.add(candidate);
                        break;
                    }
                }
            }
        }
    }

    // Fallback: action ID suffix — skip for pure line reconnection actions
    const isCoupling = isCouplingAction(actionId, actionDetail?.description_unitaire);
    const isLineReconnection = !isCoupling && !!topo
        && (Object.keys((topo.gens_bus as Record<string, unknown>) || {}).length === 0
            && Object.keys((topo.loads_bus as Record<string, unknown>) || {}).length === 0
            && Object.keys((topo.loads_p as Record<string, unknown>) || {}).length === 0
            && Object.keys((topo.gens_p as Record<string, unknown>) || {}).length === 0)
        && ([...Object.values((topo.lines_ex_bus as Record<string, number>) || {}),
             ...Object.values((topo.lines_or_bus as Record<string, number>) || {})] as number[]).some(v => v >= 0);

    if (actionId && !isLineReconnection) {
        actionId.split('+').forEach(part => {
            const cleanPart = part.replace(/_(inc|dec)\d+$/, '');

            if (nodesByEquipmentId.has(cleanPart)) {
                targets.add(cleanPart);
                return;
            }
            if (nodesByEquipmentId.has(part)) {
                targets.add(part);
                return;
            }

            const subParts = cleanPart.split('_');
            // Check each sub-part individually (e.g. for MQIS P7 in UUID_MQIS P7_coupling)
            subParts.forEach(sp => {
                if (nodesByEquipmentId.has(sp)) targets.add(sp);
            });

            for (let i = 1; i < subParts.length; i++) {
                const candidate = subParts.slice(i).join('_');
                if (nodesByEquipmentId.has(candidate)) {
                    targets.add(candidate);
                    return;
                }
            }
            // Fallback: last segment
            const last = subParts[subParts.length - 1];
            if (!targets.has(last) && nodesByEquipmentId.has(last)) {
                targets.add(last);
            }
        });
    }
    return [...targets];
};

/**
 * Apply yellow fluo halo to action targets: edges (line actions) or nodes (nodal actions).
 */
export const applyActionTargetHighlights = (
    container: HTMLElement | null,
    metaIndex: MetadataIndex | null,
    actionDetail: ActionDetail | null,
    actionId: string | null,
) => {
    if (!container) return;
    container
        .querySelectorAll('.nad-highlight-clone.nad-action-target')
        .forEach(el => el.remove());
    container.querySelectorAll('.nad-action-target, .nad-action-target-original').forEach(el => {
        el.classList.remove('nad-action-target', 'nad-action-target-original');
    });
    if (!metaIndex || !actionDetail) return;

    const { edgesByEquipmentId, nodesByEquipmentId } = metaIndex;

    const backgroundLayer = getBackgroundLayer(container);

    let cachedBgCTM: DOMMatrix | null = null;

    const applyHighlight = (el: Element) => {
        if (!el) return;

        if (backgroundLayer) {
            const clone = el.cloneNode(true) as SVGGraphicsElement;
            clone.removeAttribute('id');
            clone.classList.add('nad-action-target');
            clone.classList.add('nad-highlight-clone');
            clone.classList.remove('nad-delta-positive', 'nad-delta-negative', 'nad-delta-grey');

            try {
                const elCTM = (el as SVGGraphicsElement).getScreenCTM();
                if (!cachedBgCTM) cachedBgCTM = (backgroundLayer as SVGGraphicsElement).getScreenCTM();
                if (elCTM && cachedBgCTM) {
                    const relativeCTM = cachedBgCTM.inverse().multiply(elCTM);
                    const matrixStr = `matrix(${relativeCTM.a}, ${relativeCTM.b}, ${relativeCTM.c}, ${relativeCTM.d}, ${relativeCTM.e}, ${relativeCTM.f})`;
                    clone.setAttribute('transform', matrixStr);
                }
            } catch (e) {
                console.warn('Failed to get CTM for highlight:', e);
            }
            backgroundLayer.appendChild(clone);
            el.classList.add('nad-action-target-original');
        } else {
            el.classList.add('nad-action-target');
        }
    };

    const idMap = getIdMap(container);

    const vlNames = getActionTargetVoltageLevels(actionDetail, actionId, nodesByEquipmentId);
    vlNames.forEach(vlName => {
        const node = nodesByEquipmentId.get(vlName);
        if (node && node.svgId) {
            const el = idMap.get(node.svgId);
            if (el) applyHighlight(el);
        }
    });

    const targetLines = getActionTargetLines(actionDetail, actionId, edgesByEquipmentId);
    targetLines.forEach(lineName => {
        const edge = edgesByEquipmentId.get(lineName);
        if (edge && edge.svgId) {
            const el = idMap.get(edge.svgId);
            if (el) applyHighlight(el);
        }
    });
};

/**
 * Apply orange halo to every disconnected branch in the contingency
 * state.  Accepts a single element ID (legacy N-1 case) or a list of
 * element IDs (N-K contingency).
 */
export const applyContingencyHighlight = (
    container: HTMLElement,
    metaIndex: MetadataIndex | null,
    disconnectedElements: string | string[] | null,
) => {
    if (!container) return;
    container.querySelectorAll('.nad-contingency-highlight').forEach(el => {
        if (el.classList.contains('nad-highlight-clone')) {
            el.remove();
        } else {
            el.classList.remove('nad-contingency-highlight');
        }
    });

    if (!disconnectedElements || !metaIndex) return;
    const elements = typeof disconnectedElements === 'string'
        ? (disconnectedElements ? [disconnectedElements] : [])
        : disconnectedElements;
    if (elements.length === 0) return;

    const { edgesByEquipmentId } = metaIndex;
    const idMap = getIdMap(container);
    const backgroundLayer = getBackgroundLayer(container);

    for (const elementId of elements) {
        const edge = edgesByEquipmentId.get(elementId);
        if (!edge || !edge.svgId) continue;

        const el = idMap.get(edge.svgId);
        if (!el) continue;

        if (backgroundLayer) {
            const clone = el.cloneNode(true) as SVGGraphicsElement;
            clone.classList.add('nad-contingency-highlight');
            clone.classList.add('nad-highlight-clone');
            clone.classList.remove('nad-delta-positive', 'nad-delta-negative', 'nad-delta-grey');
            clone.removeAttribute('id');

            clone.style.display = 'block';
            clone.style.visibility = 'visible';

            try {
                const elCTM = (el as SVGGraphicsElement).getScreenCTM();
                const bgCTM = (backgroundLayer as SVGGraphicsElement).getScreenCTM();
                if (elCTM && bgCTM) {
                    const relativeCTM = bgCTM.inverse().multiply(elCTM);
                    const matrixStr = `matrix(${relativeCTM.a}, ${relativeCTM.b}, ${relativeCTM.c}, ${relativeCTM.d}, ${relativeCTM.e}, ${relativeCTM.f})`;
                    clone.setAttribute('transform', matrixStr);
                }
            } catch (e) {
                console.warn('Failed to get CTM for contingency highlight:', e);
            }

            backgroundLayer.appendChild(clone);
        } else {
            el.classList.add('nad-contingency-highlight');
        }
    }
};
