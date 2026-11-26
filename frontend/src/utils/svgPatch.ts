// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

//
// SVG DOM recycling — apply an N-1 or action patch to a clone of the
// N-state SVG instead of fetching and parsing a fresh ~20 MB NAD.
//
// The pypowsybl NAD always renders with identical layout, node
// positions, and element IDs when called with `fixed_positions` from
// `grid_layout.json`. That invariant lets us clone the already-loaded
// N SVGSVGElement and patch only what actually differs between states:
//   - N → N-1:  the contingency edge becomes dashed; flow-label
//               values change on remaining edges; overload set changes.
//   - N-1 → Action (non-topology-changing):  flow labels change; asset
//               deltas change; action-target halos are added later by
//               `applyActionTargetHighlights`.
//
// Topology-changing actions (switch toggles, line reconnections, VL
// splits/merges) are caught server-side and returned as
// `{patchable: false}`; the caller must fall back to the full NAD.
//
// This module exposes two primitives that should be composed by
// `useDiagrams` and never coupled to React state directly:
//   - `cloneBaseSvg(base)` — deep-clone without touching the original.
//   - `applyPatchToClone(clone, metaIndex, patch)` — in-place mutation.
//
// Backup attributes:
//   `data-patched-flow` — set on [foreignObject|text] nodes whose text
//                         we overwrite with the target-state flow label.
//                         Distinct from `data-original-text` (owned by
//                         `applyDeltaVisuals`) so delta-mode and patch
//                         mutations can coexist without clobbering
//                         each other's restore paths.
//   `.nad-disconnected` — class applied to the edge shapes of
//                         `patch.disconnected_edges`; the CSS rule in
//                         App.css renders them dashed to match
//                         pypowsybl's native disconnected-branch look.
//
// See docs/performance/history/svg-dom-recycling.md for the full
// rationale and benchmark results.

import type { DiagramPatch, MetadataIndex } from '../types';
import { invalidateIdMapCache } from './svgUtils';
import { resetFlowVisuals } from './svg/loadingVisuals';

/**
 * Deep-clone the N-state SVGSVGElement. The N tab keeps the original;
 * the returned clone is the one that gets patched and then injected
 * into the N-1 or Action containers. The N tab may be decorated (Loading
 * view), so the clone is reset to pypowsybl's own labels first.
 */
export const cloneBaseSvg = (baseSvg: SVGSVGElement): SVGSVGElement => {
    const clone = baseSvg.cloneNode(true) as SVGSVGElement;
    resetFlowVisuals(clone);
    return clone;
};

/**
 * Reverse any patch mutations previously applied to `container`.
 *
 * Called once at the top of `applyPatchToClone` so re-applying a
 * different patch on the same clone is idempotent.
 */
const resetPriorPatch = (container: Element) => {
    // Restore text nodes patched with an absolute flow label.
    container.querySelectorAll('[data-patched-flow]').forEach(el => {
        const original = el.getAttribute('data-patched-flow');
        if (original !== null) {
            el.textContent = original;
        }
        el.removeAttribute('data-patched-flow');
    });

    // Drop the dashed-disconnected marker.
    container.querySelectorAll('.nad-disconnected').forEach(el => {
        el.classList.remove('nad-disconnected');
    });
};

/**
 * Format a flow value (MW or MVar) the same way pypowsybl does for NAD
 * edge-info labels: rounded to whole numbers.
 */
const formatFlowValue = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    return Math.round(value).toString();
};

/**
 * Overwrite the active-power label at a single edge terminal. Backs up
 * the original text in `data-patched-flow` so the patch is reversible.
 *
 * `edgeInfoSvgId` is typically a `<g>` node that wraps a
 * `<foreignObject>` or `<text>` with the numeric label; we descend into
 * it and rewrite every leaf text/foreignObject we find (same DOM
 * traversal as `applyDeltaVisuals`).
 */
const patchEdgeInfoText = (
    infoEl: Element,
    label: string,
) => {
    infoEl.querySelectorAll('foreignObject, text').forEach(t => {
        if (!t.hasAttribute('data-patched-flow')) {
            t.setAttribute('data-patched-flow', t.textContent ?? '');
        }
        t.textContent = label;
    });
};

/**
 * Parse a single SVG fragment (e.g. `<g id="nad-vl-X">...</g>`) into
 * an `Element` ready to splice into a live SVGSVGElement. Wraps the
 * fragment in an `<svg>` with the SVG namespace so the inner element
 * inherits the right namespace URI (required for subsequent
 * `querySelector` calls and CSS matching).
 */
const parseSvgFragment = (fragment: string): Element | null => {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(
            `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`,
            'image/svg+xml',
        );
        const first = doc.documentElement.firstElementChild;
        return first ?? null;
    } catch {
        return null;
    }
};

/**
 * Splice each VL-node subtree from the patch payload into the cloned
 * base diagram. For every `(vlId, { node_svg })` entry we locate the
 * existing `<g id="nad-vl-{vlId}">` in the clone (via the base metadata
 * index), parse the fragment, and swap the element in place. The
 * fragment's `transform` attribute matches the main diagram's
 * position (pypowsybl uses the same `fixed_positions`), so the splice
 * is geometrically identical to a native full-NAD render for that VL.
 *
 * Run BEFORE the disconnected-edges and flow-label passes so those
 * subsequent passes operate on the freshly-spliced DOM (their
 * lookups go through the rebuilt `idMap`).
 *
 * Any per-VL parse / lookup failure is logged and skipped; the rest
 * of the patch still applies. Global failures are caught in the
 * caller, which falls back to the full-NAD endpoint.
 */
type VlSubtreeEntry = {
    node_svg: string;
    node_sub_svg_id: string;
    edge_fragments?: Record<string, { svg: string; sub_svg_id: string }>;
};

/**
 * Import a parsed fragment into the clone's document and replace
 * `oldEl` with it. Rewrites the fragment's root `id` attribute to
 * `targetSvgId` before insertion: pypowsybl assigns positional
 * svgIds per diagram (`nad-vl-0`, `nad-l-3`, ...), so the
 * sub-diagram's ids differ from the main diagram's. Without the
 * rewrite, subsequent `idMap` lookups (halo clone, contingency
 * halo, delta visuals) would fail to find the spliced element and
 * silently skip decorating it.
 */
const spliceAndRewriteId = (
    clonedSvg: SVGSVGElement,
    oldEl: Element,
    fragment: string,
    targetSvgId: string,
    idMap: Map<string, Element>,
): Element | null => {
    const newEl = parseSvgFragment(fragment);
    if (!newEl) return null;
    try {
        const imported = clonedSvg.ownerDocument!.importNode(newEl, true) as Element;
        imported.setAttribute('id', targetSvgId);
        oldEl.replaceWith(imported);
        idMap.set(targetSvgId, imported);
        return imported;
    } catch (e) {
        console.warn('[svgPatch] splice failed for', targetSvgId, e);
        return null;
    }
};

const spliceVlSubtrees = (
    clonedSvg: SVGSVGElement,
    baseMetaIndex: MetadataIndex,
    vlSubtrees: Record<string, VlSubtreeEntry>,
    idMap: Map<string, Element>,
) => {
    for (const [vlId, entry] of Object.entries(vlSubtrees)) {
        const nodeMeta = baseMetaIndex.nodesByEquipmentId.get(vlId);
        const targetSvgId = nodeMeta?.svgId ?? `nad-vl-${vlId}`;
        const oldNodeEl = idMap.get(targetSvgId);
        if (!oldNodeEl) {
            console.warn('[svgPatch] VL subtree splice — no live node for', vlId, targetSvgId);
            continue;
        }
        const spliced = spliceAndRewriteId(
            clonedSvg, oldNodeEl, entry.node_svg, targetSvgId, idMap,
        );
        if (!spliced) {
            console.warn('[svgPatch] VL subtree splice — fragment parse failed for', vlId);
            continue;
        }

        // Splice every edge fragment that pypowsybl rendered for this
        // focused sub-diagram. Each one replaces the corresponding
        // edge in the cloned base so the branch's piercing geometry
        // at the target VL matches the new bus count.
        const edgeFragments = entry.edge_fragments;
        if (!edgeFragments) continue;
        for (const [edgeEqId, edgeEntry] of Object.entries(edgeFragments)) {
            const edgeMeta = baseMetaIndex.edgesByEquipmentId.get(edgeEqId);
            if (!edgeMeta || !edgeMeta.svgId) continue;
            const oldEdgeEl = idMap.get(edgeMeta.svgId);
            if (!oldEdgeEl) continue;
            spliceAndRewriteId(
                clonedSvg, oldEdgeEl, edgeEntry.svg, edgeMeta.svgId, idMap,
            );
        }
    }
};

/**
 * Build a `Map<id, Element>` over the entire cloned SVG subtree.
 *
 * CRITICAL for performance: the flow-label loop touches ~2 × N edges
 * (p1 + p2 terminals) on large grids — N ≈ 11 k branches on
 * `bare_env_20240828T0100Z`. Doing
 * `clonedSvg.querySelector('[id=...]')` inside that loop is
 * O(n_dom_nodes) per call — with ~200 k DOM nodes, that's billions of
 * operations and locks the browser tab (observed as "Page not
 * responding" before this cache was added).
 *
 * One `querySelectorAll('[id]')` is O(n_dom_nodes) total; subsequent
 * `Map.get` lookups are O(1) each. Overall cost drops from O(E·D) to
 * O(D + E).
 */
const buildSvgIdMap = (svg: SVGSVGElement): Map<string, Element> => {
    const map = new Map<string, Element>();
    svg.querySelectorAll('[id]').forEach(el => map.set(el.id, el));
    return map;
};

/**
 * Apply `patch` to the cloned SVG in place. Returns the element and the
 * metadata index the caller should associate with it in `DiagramsState`.
 *
 * The base-state metadata index (layout + IDs are identical across N,
 * N-1, action variants) is reused verbatim — we don't rebuild it here.
 *
 * No-op when `patch.patchable` is false; the caller must fall back to
 * the full-NAD endpoint in that case.
 */
export const applyPatchToClone = (
    clonedSvg: SVGSVGElement,
    baseMetaIndex: MetadataIndex,
    patch: DiagramPatch,
): { svgElement: SVGSVGElement; metaIndex: MetadataIndex } => {
    if (!patch.patchable) {
        return { svgElement: clonedSvg, metaIndex: baseMetaIndex };
    }

    resetPriorPatch(clonedSvg);

    const { edgesByEquipmentId } = baseMetaIndex;
    const idMap = buildSvgIdMap(clonedSvg);

    // 0. Splice per-VL node subtrees before anything else. When a
    //    node-merging / node-splitting / coupling action changed
    //    bus counts at one or more VLs, the backend shipped
    //    pypowsybl-native `<g id="nad-vl-*">` fragments; we swap
    //    them into the clone so the concentric multi-circle
    //    rendering matches the action state. No-op when the
    //    `vl_subtrees` field is absent or empty.
    if (patch.vl_subtrees && Object.keys(patch.vl_subtrees).length > 0) {
        spliceVlSubtrees(clonedSvg, baseMetaIndex, patch.vl_subtrees, idMap);
    }

    // 1. Mark disconnected edges (N-1 contingency line, or any extra
    //    edges flagged by the action patch) as dashed. The CSS rule in
    //    App.css renders `.nad-disconnected` with `stroke-dasharray`,
    //    matching pypowsybl's native disconnected-branch look.
    const disconnected = patch.disconnected_edges ?? [];
    for (const equipmentId of disconnected) {
        const edge = edgesByEquipmentId.get(equipmentId);
        if (!edge || !edge.svgId) continue;
        const el = idMap.get(edge.svgId);
        if (el) el.classList.add('nad-disconnected');
    }

    // 2. Overwrite absolute flow labels. The N SVG embeds N-state flow
    //    values inside each edge's edgeInfo1/edgeInfo2; the patch
    //    carries the target-state absolute values we must render.
    const absFlows = patch.absolute_flows;
    if (absFlows && absFlows.p1) {
        const p1 = absFlows.p1;
        const p2 = absFlows.p2 ?? {};
        for (const edgeId in p1) {
            const edge = edgesByEquipmentId.get(edgeId);
            if (!edge) continue;

            const info1Id = edge.edgeInfo1?.svgId;
            if (info1Id) {
                const infoEl = idMap.get(info1Id);
                if (infoEl) patchEdgeInfoText(infoEl, formatFlowValue(p1[edgeId]));
            }

            const info2Id = edge.edgeInfo2?.svgId;
            const p2Val = p2[edgeId];
            if (info2Id && p2Val !== undefined) {
                const infoEl = idMap.get(info2Id);
                if (infoEl) patchEdgeInfoText(infoEl, formatFlowValue(p2Val));
            }
        }
    }

    // 3. Invalidate the cached idMap for any container the clone is
    //    about to be injected into. We don't know the container yet
    //    (MemoizedSvgContainer does the `replaceChildren` call), but
    //    the call is safe no-op until the clone is mounted. Callers
    //    should also `invalidateIdMapCache(container)` after mount so
    //    highlight passes rebuild their WeakMap against the new DOM.
    const parent = clonedSvg.parentElement;
    if (parent) invalidateIdMapCache(parent);

    return { svgElement: clonedSvg, metaIndex: baseMetaIndex };
};
