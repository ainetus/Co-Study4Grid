// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { AssetDelta, FlowDelta, MetadataIndex } from '../../types';
import { getIdMap } from './idMap';

export const DELTA_CLASSES: Record<FlowDelta['category'], string> = {
    positive: 'nad-delta-positive',
    negative: 'nad-delta-negative',
    grey: 'nad-delta-grey',
};

/**
 * Apply delta flow visualizations (coloring + text replacement) on a container.
 * - Branch coloring is based on active power (P) delta only.
 * - edgeInfo1 (active power / black arrow) shows P delta text.
 * - edgeInfo2 (reactive power / blue arrow) shows Q delta text.
 * - Load/generator assets are colored based on P delta.
 * Saves original text in data-original-text attribute for restoration.
 */
export const applyDeltaVisuals = (
    container: HTMLElement | null,
    diagram: {
        flow_deltas?: Record<string, { delta: number; category: string }>;
        reactive_flow_deltas?: Record<string, { delta: number; category: string }>;
        asset_deltas?: Record<string, AssetDelta>;
    } | null,
    metaIndex: MetadataIndex | null,
    isDeltaMode: boolean,
) => {
    if (!container || !diagram || !metaIndex) return;

    // Clear delta classes on edges and nodes
    container.querySelectorAll('.nad-delta-positive').forEach(el => el.classList.remove('nad-delta-positive'));
    container.querySelectorAll('.nad-delta-negative').forEach(el => el.classList.remove('nad-delta-negative'));
    container.querySelectorAll('.nad-delta-grey').forEach(el => el.classList.remove('nad-delta-grey'));

    // Restore original text labels
    container.querySelectorAll('[data-original-text]').forEach(el => {
        el.textContent = el.getAttribute('data-original-text');
        el.removeAttribute('data-original-text');
    });

    if (!isDeltaMode || !diagram.flow_deltas) return;

    const { edgesByEquipmentId } = metaIndex;
    const flowDeltas = diagram.flow_deltas;
    const assetDeltas = diagram.asset_deltas || {};
    const idMap = getIdMap(container);

    const classMap: Record<string, string> = DELTA_CLASSES;

    // --- Branch (edge) deltas ---
    for (const [lineId, deltaInfo] of Object.entries(flowDeltas)) {
        const edge = edgesByEquipmentId.get(lineId);
        if (!edge || !edge.svgId) continue;

        // Color the edge based on active power delta
        const el = idMap.get(edge.svgId);
        if (el) {
            const cls = classMap[deltaInfo.category];
            if (cls) el.classList.add(cls);
        }

        // Apply delta text labels to both Terminal 1 and Terminal 2 (edgeInfo1 and edgeInfo2 represent P flow at terminals in NADs)
        const pDeltaStr = deltaInfo.delta >= 0 ? `+${deltaInfo.delta.toFixed(1)}` : deltaInfo.delta.toFixed(1);

        // edgeInfo1 = Terminal 1 active power (P)
        if (edge.edgeInfo1?.svgId) {
            const infoEl = idMap.get(edge.edgeInfo1.svgId);
            if (infoEl) {
                infoEl.querySelectorAll('foreignObject, text').forEach(t => {
                    if (!t.hasAttribute('data-original-text')) {
                        t.setAttribute('data-original-text', t.textContent || '');
                    }
                    t.textContent = `\u0394 ${pDeltaStr}`;
                });
            }
        }

        // edgeInfo2 = Terminal 2 active power (P) (Note: NOT reactive power in NADs)
        if (edge.edgeInfo2?.svgId) {
            const infoEl = idMap.get(edge.edgeInfo2.svgId);
            if (infoEl) {
                infoEl.querySelectorAll('foreignObject, text').forEach(t => {
                    if (!t.hasAttribute('data-original-text')) {
                        t.setAttribute('data-original-text', t.textContent || '');
                    }
                    t.textContent = `\u0394 ${pDeltaStr}`;
                });
            }
        }
    }

    // --- Asset (load/generator) deltas ---
    for (const [assetId, assetInfo] of Object.entries(assetDeltas)) {
        // Assets appear as legend edges connected to VL nodes.
        // Try to find them as edges first (pypowsybl maps loads/gens as short edges).
        const edge = edgesByEquipmentId.get(assetId);
        if (edge && edge.svgId) {
            const el = idMap.get(edge.svgId);
            if (el) {
                const cls = classMap[assetInfo.category];
                if (cls) el.classList.add(cls);
            }

            // Update P arrow text on edgeInfo1
            const pStr = assetInfo.delta_p >= 0 ? `+${assetInfo.delta_p.toFixed(1)}` : assetInfo.delta_p.toFixed(1);
            if (edge.edgeInfo1?.svgId) {
                const infoEl = idMap.get(edge.edgeInfo1.svgId);
                if (infoEl) {
                    infoEl.querySelectorAll('foreignObject, text').forEach(t => {
                        if (!t.hasAttribute('data-original-text')) {
                            t.setAttribute('data-original-text', t.textContent || '');
                        }
                        t.textContent = `\u0394 ${pStr}`;
                    });
                }
            }

            // Update Q arrow text on edgeInfo2
            const qStr = assetInfo.delta_q >= 0 ? `+${assetInfo.delta_q.toFixed(1)}` : assetInfo.delta_q.toFixed(1);
            if (edge.edgeInfo2?.svgId) {
                const infoEl = idMap.get(edge.edgeInfo2.svgId);
                if (infoEl) {
                    infoEl.querySelectorAll('foreignObject, text').forEach(t => {
                        if (!t.hasAttribute('data-original-text')) {
                            t.setAttribute('data-original-text', t.textContent || '');
                        }
                        t.textContent = `\u0394 ${qStr}`;
                    });
                }
            }
        }
    }
};
