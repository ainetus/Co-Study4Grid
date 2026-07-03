// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { MetadataIndex, NodeMeta, EdgeMeta } from '../../types';

/** Raw pypowsybl NAD `textNodes` entry — the VL name-box label metadata. */
interface RawTextNode {
    svgId?: string;
    equipmentId?: string;
    vlNode?: string;
    node?: string;
    connectedNode?: string;
}

/**
 * Build Map indices from pypowsybl metadata for O(1) lookups.
 *
 * Accepts either a raw JSON string or a pre-parsed object. Returns
 * null when the input is missing.
 */
export const buildMetadataIndex = (metadata: unknown): MetadataIndex | null => {
    if (!metadata) return null;
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const nodes: NodeMeta[] = (meta as { nodes?: NodeMeta[] }).nodes || [];
    const edges: EdgeMeta[] = (meta as { edges?: EdgeMeta[] }).edges || [];
    const textNodes: RawTextNode[] = (meta as { textNodes?: RawTextNode[] }).textNodes || [];

    const nodesByEquipmentId = new Map<string, NodeMeta>();
    const nodesBySvgId = new Map<string, NodeMeta>();
    const edgesByEquipmentId = new Map<string, EdgeMeta>();
    const edgesByNode = new Map<string, EdgeMeta[]>();
    const textNodesBySvgId = new Map<string, NodeMeta>();

    nodes.forEach(n => {
        nodesByEquipmentId.set(n.equipmentId, n);
        nodesBySvgId.set(n.svgId, n);
    });

    edges.forEach(e => {
        edgesByEquipmentId.set(e.equipmentId, e);
        if (!edgesByNode.has(e.node1)) edgesByNode.set(e.node1, []);
        edgesByNode.get(e.node1)!.push(e);
        if (!edgesByNode.has(e.node2)) edgesByNode.set(e.node2, []);
        edgesByNode.get(e.node2)!.push(e);
    });

    // pypowsybl NAD metadata carries a `textNodes` array for the VL name boxes,
    // each linking back to its VL node (`vlNode` svgId) and equipment id. Map
    // the label svgId → the VL's NodeMeta so a click on the name box resolves
    // to the same VL the disk does.
    textNodes.forEach(t => {
        if (!t.svgId) return;
        const vlNodeId = t.vlNode ?? t.node ?? t.connectedNode;
        const vl =
            (vlNodeId ? nodesBySvgId.get(vlNodeId) : undefined) ??
            (t.equipmentId ? nodesByEquipmentId.get(t.equipmentId) : undefined);
        if (vl) textNodesBySvgId.set(t.svgId, vl);
    });

    return { nodesByEquipmentId, nodesBySvgId, edgesByEquipmentId, edgesByNode, textNodesBySvgId };
};
