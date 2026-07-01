// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { MetadataIndex, NodeMeta } from '../../types';
import { colors } from '../../styles/tokens';

/**
 * Interactive voltage-level disk behaviours for the NAD diagram:
 *
 *   1. Hover  — a lightweight floating tooltip with the VL name, shown
 *               only while the on-diagram VL labels are hidden (the
 *               `nad-hide-vl-labels` class, toggled by the `🏷 VL`
 *               button). When the labels are visible the name is already
 *               drawn, so the tooltip stays out of the way.
 *   2. Click  — single-click on the DISK selects the VL (drives the
 *               Inspect field / auto-zoom, exactly like typing it in the
 *               Inspect box); single-click on the VL NAME BOX opens its
 *               Single Line Diagram directly.
 *   3. Dbl-clk — double-click on the disk (or name box) opens the VL's SLD.
 *
 * The disk is interactive across its WHOLE area, even where a branch is
 * drawn on top of it: when the direct hit-test lands on an occluding edge
 * (not the disk), we fall back to `document.elementsFromPoint` and pick the
 * first VL disk / name box in the paint stack under the cursor. This runs
 * only on discrete pointer events (never per frame), so the performance
 * contract below is untouched.
 *
 * Performance contract (the whole point of the delegation design):
 *   - A FIXED handful of listeners on the container, never one-per-node,
 *     so a 5000-VL grid costs the same as a 5-VL grid to wire up.
 *   - NO `mousemove` / per-frame work: the tooltip is positioned once on
 *     `mouseover` and the cursor affordance is a static CSS rule
 *     (`.svg-container .nad-vl-nodes` / `.nad-label-box { cursor: pointer }`
 *     in App.css). The `elementsFromPoint` fallback fires only when the
 *     direct hit-test misses a VL, i.e. on an occluding edge or empty space.
 *   - Pan/zoom gestures add `.svg-interacting`, which sets
 *     `pointer-events: none` on every SVG child, so none of these
 *     handlers resolve a node mid-gesture — fluidity is untouched.
 *
 * The handlers do NOT call `preventDefault`/`stopPropagation` on
 * `mousedown`, so usePanZoom's panning still starts normally on a drag.
 * A click is told apart from a pan by the pointer travel between
 * mousedown and click (`DRAG_THRESHOLD_PX`).
 */

const SVG_TOOLTIP_CLASS = 'cs4g-vl-hover-tooltip';
const HIDE_VL_LABELS_CLASS = 'nad-hide-vl-labels';

/** Single-click is deferred this long so a double-click can pre-empt it.
 *  Mirrors `PIN_SINGLE_CLICK_DELAY_MS` used by the action-overview pins. */
export const VL_SINGLE_CLICK_DELAY_MS = 250;

/** Pointer travel (px) above which a mouseup is treated as a pan, not a click. */
const DRAG_THRESHOLD_PX = 6;

export interface VlInteractionHandlers {
    /** Single-click on a VL disk — receives the VL equipment id. */
    onSelect?: (vlId: string) => void;
    /** Double-click on a VL disk — receives the VL equipment id. */
    onOpenSld?: (vlId: string) => void;
    /** Resolve a VL id to its human-readable name for the hover tooltip. */
    displayName?: (id: string) => string;
}

const NOOP = () => { /* no diagram / no metadata → nothing to wire */ };

/**
 * Wire hover / click / double-click behaviours onto every voltage-level
 * disk of a NAD container via a single set of delegated listeners.
 *
 * Idempotent by construction when driven from a React effect: the
 * returned teardown removes every listener and the tooltip node, so the
 * next render re-binds cleanly against the fresh metadata index.
 *
 * @returns a teardown function (safe to call even on the no-op path).
 */
export const attachVlInteractions = (
    container: HTMLElement | null,
    metaIndex: MetadataIndex | null,
    handlers: VlInteractionHandlers,
): (() => void) => {
    if (!container || !metaIndex || metaIndex.nodesBySvgId.size === 0) return NOOP;

    const { nodesBySvgId } = metaIndex;
    const textNodesBySvgId = metaIndex.textNodesBySvgId ?? new Map<string, NodeMeta>();
    const { onSelect, onOpenSld, displayName } = handlers;

    // What a hit resolved to: the VL, and whether it landed on the name box
    // (`viaText`) rather than the disk — the two get different click actions.
    interface Resolved { node: NodeMeta; viaText: boolean; }

    // Climb from the event target to the enclosing VL node group (disk) or VL
    // name box (`nad-label-box`, keyed by its text-node svgId), if any.
    const resolveDirect = (target: EventTarget | null): Resolved | null => {
        let el = target as Element | null;
        while (el && el !== container) {
            const id = el.id;
            if (id) {
                const node = nodesBySvgId.get(id);
                if (node) return { node, viaText: false };
                const textNode = textNodesBySvgId.get(id);
                if (textNode) return { node: textNode, viaText: true };
            }
            el = el.parentElement;
        }
        return null;
    };

    // Resolve a VL under the pointer even when a branch is drawn ON TOP of its
    // disk: the direct hit-test then lands on the edge, so we walk the whole
    // paint stack at (clientX, clientY) and take the first element that resolves
    // to a VL. Only runs when the direct hit misses — never per frame.
    const resolveDeep = (
        target: EventTarget | null,
        clientX: number,
        clientY: number,
    ): Resolved | null => {
        const direct = resolveDirect(target);
        if (direct) return direct;
        if (typeof document.elementsFromPoint !== 'function') return null;
        for (const el of document.elementsFromPoint(clientX, clientY)) {
            if (el === container || !container.contains(el)) continue;
            const hit = resolveDirect(el);
            if (hit) return hit;
        }
        return null;
    };

    const tooltipText = (node: NodeMeta): string => {
        const id = node.equipmentId;
        const friendly = displayName ? displayName(id) : id;
        return friendly && friendly !== id ? `${friendly} (${id})` : id;
    };

    // --- Hover tooltip (created lazily, only when actually needed) ---
    let tooltip: HTMLDivElement | null = null;
    let hoveredSvgId: string | null = null;

    const showTooltip = (node: NodeMeta, clientX: number, clientY: number) => {
        if (!tooltip) {
            const t = document.createElement('div');
            t.className = SVG_TOOLTIP_CLASS;
            t.style.position = 'absolute';
            t.style.pointerEvents = 'none';
            t.style.zIndex = '120';
            t.style.padding = '2px 7px';
            t.style.borderRadius = '4px';
            t.style.fontSize = '12px';
            t.style.fontWeight = '600';
            t.style.whiteSpace = 'nowrap';
            t.style.background = colors.surface;
            t.style.color = colors.textPrimary;
            t.style.border = `1px solid ${colors.brand}`;
            t.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
            container.appendChild(t);
            tooltip = t;
        }
        tooltip.textContent = tooltipText(node);
        tooltip.style.display = 'block';
        const rect = container.getBoundingClientRect();
        let x = clientX - rect.left + 12;
        let y = clientY - rect.top + 12;
        // Keep the label inside the (overflow-clipped) container.
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        if (x + tw > rect.width) x = Math.max(0, rect.width - tw - 4);
        if (y + th > rect.height) y = Math.max(0, clientY - rect.top - th - 12);
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    };

    const hideTooltip = () => {
        if (tooltip) tooltip.style.display = 'none';
    };

    const onOver = (evt: MouseEvent) => {
        // The name is already drawn when labels are visible — only surface the
        // tooltip when the static labels are hidden. Gating the (slightly more
        // expensive) `elementsFromPoint` fallback on that keeps hover cheap.
        const labelsHidden = container.classList.contains(HIDE_VL_LABELS_CLASS);
        const res = labelsHidden
            ? resolveDeep(evt.target, evt.clientX, evt.clientY)
            : resolveDirect(evt.target);
        if (!res) return;
        hoveredSvgId = res.node.svgId;
        if (labelsHidden) showTooltip(res.node, evt.clientX, evt.clientY);
    };

    const onOut = (evt: MouseEvent) => {
        // Ignore transitions that stay inside the same VL group.
        const to = resolveDirect(evt.relatedTarget);
        if (to && to.node.svgId === hoveredSvgId) return;
        hoveredSvgId = null;
        hideTooltip();
    };

    // --- Click vs. double-click (drag-guarded, single-click deferred) ---
    //
    // The VL node is captured on `mousedown`, NOT on `click`. usePanZoom
    // adds `.svg-interacting` (→ `pointer-events: none` on every SVG child)
    // the instant a drag starts, so by the time `mouseup` fires the disk is
    // transparent and the browser retargets the resulting `click` to the
    // container (the common ancestor of the disk-mousedown and the
    // container-mouseup). Resolving from `click.target` would therefore
    // always miss. The mousedown hit-test still lands on the real disk
    // (the class is only set *by* that handler, after the target is fixed),
    // so that is where we read the node.
    let downX = 0;
    let downY = 0;
    let downVl: NodeMeta | null = null;
    let downViaText = false;
    let clickTimer: ReturnType<typeof setTimeout> | null = null;

    const onDown = (evt: MouseEvent) => {
        downX = evt.clientX;
        downY = evt.clientY;
        const res = resolveDeep(evt.target, evt.clientX, evt.clientY);
        downVl = res ? res.node : null;
        downViaText = res ? res.viaText : false;
    };

    const onClick = (evt: MouseEvent) => {
        // A pan (pointer travelled) is not a selection.
        if (Math.hypot(evt.clientX - downX, evt.clientY - downY) > DRAG_THRESHOLD_PX) return;
        const node = downVl;
        if (!node) return;
        // Clicking the VL NAME BOX opens its SLD directly — no double-click
        // window to guard (the box carries no competing single-click action).
        if (downViaText) {
            onOpenSld?.(node.equipmentId);
            return;
        }
        // Second click of a double-click — let `dblclick` take over.
        if (clickTimer !== null) return;
        const vlId = node.equipmentId;
        clickTimer = setTimeout(() => {
            clickTimer = null;
            onSelect?.(vlId);
        }, VL_SINGLE_CLICK_DELAY_MS);
    };

    const onDblClick = () => {
        if (clickTimer !== null) {
            clearTimeout(clickTimer);
            clickTimer = null;
        }
        const node = downVl;
        if (!node) return;
        onOpenSld?.(node.equipmentId);
    };

    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseout', onOut);
    container.addEventListener('mousedown', onDown);
    container.addEventListener('click', onClick);
    container.addEventListener('dblclick', onDblClick);

    return () => {
        if (clickTimer !== null) clearTimeout(clickTimer);
        container.removeEventListener('mouseover', onOver);
        container.removeEventListener('mouseout', onOut);
        container.removeEventListener('mousedown', onDown);
        container.removeEventListener('click', onClick);
        container.removeEventListener('dblclick', onDblClick);
        if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        tooltip = null;
    };
};
