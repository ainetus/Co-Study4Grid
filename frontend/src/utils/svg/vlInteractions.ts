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
 *   2. Click  — single-click selects the VL (drives the Inspect field /
 *               auto-zoom, exactly like typing it in the Inspect box).
 *   3. Dbl-clk — double-click opens the VL's Single Line Diagram.
 *
 * Performance contract (the whole point of the delegation design):
 *   - A FIXED handful of listeners on the container, never one-per-node,
 *     so a 5000-VL grid costs the same as a 5-VL grid to wire up.
 *   - NO `mousemove` / per-frame work: the tooltip is positioned once on
 *     `mouseover` and the cursor affordance is a static CSS rule
 *     (`.svg-container .nad-vl-nodes { cursor: pointer }` in App.css).
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
    const { onSelect, onOpenSld, displayName } = handlers;

    // Climb from the event target to the enclosing VL node group (the
    // element whose id is a known node svgId), if any.
    const resolveVl = (target: EventTarget | null): NodeMeta | null => {
        let el = target as Element | null;
        while (el && el !== container) {
            const id = el.id;
            if (id) {
                const node = nodesBySvgId.get(id);
                if (node) return node;
            }
            el = el.parentElement;
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
        const node = resolveVl(evt.target);
        if (!node) return;
        hoveredSvgId = node.svgId;
        // The name is already drawn when labels are visible — only
        // surface the tooltip when the static labels are hidden.
        if (container.classList.contains(HIDE_VL_LABELS_CLASS)) {
            showTooltip(node, evt.clientX, evt.clientY);
        }
    };

    const onOut = (evt: MouseEvent) => {
        // Ignore transitions that stay inside the same VL group.
        const to = resolveVl(evt.relatedTarget);
        if (to && to.svgId === hoveredSvgId) return;
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
    let clickTimer: ReturnType<typeof setTimeout> | null = null;

    const onDown = (evt: MouseEvent) => {
        downX = evt.clientX;
        downY = evt.clientY;
        downVl = resolveVl(evt.target);
    };

    const onClick = (evt: MouseEvent) => {
        // A pan (pointer travelled) is not a selection.
        if (Math.hypot(evt.clientX - downX, evt.clientY - downY) > DRAG_THRESHOLD_PX) return;
        // Second click of a double-click — let `dblclick` take over.
        if (clickTimer !== null) return;
        const node = downVl;
        if (!node) return;
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
