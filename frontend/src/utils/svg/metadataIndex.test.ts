// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { buildMetadataIndex } from './metadataIndex';

describe('buildMetadataIndex', () => {
    it('returns null for missing metadata', () => {
        expect(buildMetadataIndex(null)).toBeNull();
        expect(buildMetadataIndex(undefined)).toBeNull();
        expect(buildMetadataIndex('')).toBeNull();
    });

    it('accepts a JSON string input', () => {
        const raw = JSON.stringify({
            nodes: [{ equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 }],
            edges: [],
        });
        const idx = buildMetadataIndex(raw)!;
        expect(idx.nodesByEquipmentId.get('VL_A')?.svgId).toBe('svg-a');
    });

    it('builds both nodes indices (equipmentId and svgId)', () => {
        const idx = buildMetadataIndex({
            nodes: [
                { equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 },
                { equipmentId: 'VL_B', svgId: 'svg-b', x: 10, y: 10 },
            ],
            edges: [],
        })!;
        expect(idx.nodesByEquipmentId.size).toBe(2);
        expect(idx.nodesBySvgId.size).toBe(2);
        expect(idx.nodesBySvgId.get('svg-a')?.equipmentId).toBe('VL_A');
    });

    it('indexes edges by both equipmentId and the two endpoint nodes', () => {
        const idx = buildMetadataIndex({
            nodes: [
                { equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 },
                { equipmentId: 'VL_B', svgId: 'svg-b', x: 0, y: 0 },
            ],
            edges: [
                { equipmentId: 'LINE_AB', svgId: 'svg-ab', node1: 'svg-a', node2: 'svg-b' },
            ],
        })!;
        expect(idx.edgesByEquipmentId.get('LINE_AB')?.svgId).toBe('svg-ab');
        expect(idx.edgesByNode.get('svg-a')?.length).toBe(1);
        expect(idx.edgesByNode.get('svg-b')?.length).toBe(1);
    });

    it('groups multiple edges on the same node into a single array entry', () => {
        const idx = buildMetadataIndex({
            nodes: [{ equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 }],
            edges: [
                { equipmentId: 'L1', svgId: 's1', node1: 'svg-a', node2: 'svg-b' },
                { equipmentId: 'L2', svgId: 's2', node1: 'svg-a', node2: 'svg-c' },
            ],
        })!;
        expect(idx.edgesByNode.get('svg-a')?.map(e => e.equipmentId).sort()).toEqual(['L1', 'L2']);
    });

    it('tolerates missing nodes/edges arrays', () => {
        const idx = buildMetadataIndex({})!;
        expect(idx.nodesByEquipmentId.size).toBe(0);
        expect(idx.edgesByEquipmentId.size).toBe(0);
        expect(idx.textNodesBySvgId?.size).toBe(0);
    });

    it('maps VL text-label nodes to their VL via the vlNode link', () => {
        const idx = buildMetadataIndex({
            nodes: [{ equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 }],
            textNodes: [{ svgId: 'text-a', equipmentId: 'VL_A', vlNode: 'svg-a' }],
            edges: [],
        })!;
        expect(idx.textNodesBySvgId?.get('text-a')?.equipmentId).toBe('VL_A');
    });

    it('falls back to equipmentId when a text node has no vlNode link', () => {
        const idx = buildMetadataIndex({
            nodes: [{ equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 }],
            textNodes: [{ svgId: 'text-a', equipmentId: 'VL_A' }],
        })!;
        expect(idx.textNodesBySvgId?.get('text-a')?.svgId).toBe('svg-a');
    });

    it('skips text nodes that resolve to no known VL', () => {
        const idx = buildMetadataIndex({
            nodes: [{ equipmentId: 'VL_A', svgId: 'svg-a', x: 0, y: 0 }],
            textNodes: [{ svgId: 'text-x', equipmentId: 'VL_MISSING', vlNode: 'svg-missing' }],
        })!;
        expect(idx.textNodesBySvgId?.size).toBe(0);
    });
});
