// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/*
 * Action-overview pin RENDER layer — DOM injection on top of the
 * NAD SVG. Pure-data helpers live in `actionPinData.ts` and are
 * re-used here.
 */

import type { MetadataIndex } from '../../types';
import { pinChrome } from '../../styles/tokens';
import { getIdMap } from './idMap';
import {
    severityFill,
    severityFillDimmed,
    severityFillHighlighted,
    type ActionPinInfo,
    type CombinedPinInfo,
} from './actionPinData';
// Unitary-pin glyph is built by the shared pure-JS module so the
// overflow-graph iframe overlay (`expert_backend/services/
// overflow_overlay.py`) can render visually identical pins by
// reading the same source.
import { createPinGlyph as createSharedPinGlyph } from './pinGlyph';

/**
 * Apply contingency + overload halo highlights to the
 * action-overview diagram, mirroring what the N-1 tab shows.
 */
export const applyActionOverviewHighlights = (
    container: HTMLElement | null,
    metaIndex: MetadataIndex | null,
    contingency: string | null,
    overloadedLines: readonly string[],
) => {
    if (!container) return;
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;

    // Wipe any existing overview highlight layer — keeps repeated
    // calls idempotent.
    svg.querySelectorAll('.nad-overview-highlight-layer').forEach(el => el.remove());

    if (!metaIndex) return;
    const haveContingency = !!contingency;
    const haveOverloads = overloadedLines.length > 0;
    if (!haveContingency && !haveOverloads) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const layer = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    layer.setAttribute('class', 'nad-overview-highlight-layer');
    if (svg.firstChild) {
        svg.insertBefore(layer, svg.firstChild);
    } else {
        svg.appendChild(layer);
    }

    const idMap = getIdMap(container);

    // --- BATCHED READ/WRITE PATTERN ---
    // Phase 1: collect all edge ids to highlight (pure data — no DOM reads).
    const edgesToClone: { svgId: string; klass: string }[] = [];
    if (contingency) {
        const edge = metaIndex.edgesByEquipmentId.get(contingency);
        if (edge?.svgId) edgesToClone.push({ svgId: edge.svgId, klass: 'nad-contingency-highlight' });
    }
    overloadedLines.forEach(name => {
        const edge = metaIndex.edgesByEquipmentId.get(name);
        if (edge?.svgId) edgesToClone.push({ svgId: edge.svgId, klass: 'nad-overloaded' });
    });
    if (edgesToClone.length === 0) return;

    // Phase 2: READ — clone nodes and read all CTMs in a single
    // contiguous pass (no DOM writes in between, avoiding layout thrashing).
    let layerCTM: DOMMatrix | null = null;
    try {
        layerCTM = (layer as SVGGraphicsElement).getScreenCTM?.() ?? null;
    } catch { /* jsdom */ }

    const prepared: { clone: SVGGraphicsElement; transform: string | null }[] = [];
    for (const { svgId, klass } of edgesToClone) {
        const original = idMap.get(svgId);
        if (!original) continue;
        const clone = original.cloneNode(true) as SVGGraphicsElement;
        clone.removeAttribute('id');
        clone.classList.add(klass, 'nad-highlight-clone');
        clone.classList.remove('nad-delta-positive', 'nad-delta-negative', 'nad-delta-grey');

        let transform: string | null = null;
        try {
            const origCTM = (original as SVGGraphicsElement).getScreenCTM?.();
            if (origCTM && layerCTM) {
                const m = layerCTM.inverse().multiply(origCTM);
                transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
            }
        } catch { /* jsdom */ }
        prepared.push({ clone, transform });
    }

    // Phase 3: WRITE — batch all DOM mutations via a DocumentFragment
    // to trigger a single reflow instead of one per clone.
    const frag = document.createDocumentFragment();
    for (const { clone, transform } of prepared) {
        if (transform) clone.setAttribute('transform', transform);
        frag.appendChild(clone);
    }
    layer.appendChild(frag);
};

/**
 * Read a sensible base radius for the pin glyph from the SVG.
 *
 * We want pins to be "similar in size to voltage-level circles when
 * zoomed" (as the operator sees other highlights in the NAD), so we
 * pick up the radius of the first VL circle in the diagram and use
 * it as the pin body radius. Falls back to 30 user units when the
 * SVG has no circles (e.g. a handcrafted test fixture).
 */
export const readPinBaseRadius = (svg: SVGSVGElement): number => {
    const vlCircle =
        svg.querySelector('.nad-vl-nodes circle[r]') ??
        svg.querySelector('circle[r]');
    if (vlCircle) {
        const attr = vlCircle.getAttribute('r');
        const n = attr ? parseFloat(attr) : NaN;
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 30;
};

/**
 * Minimum pin body radius in SCREEN pixels. Enforced by
 * {@link rescaleActionOverviewPins} so pins remain readable when the
 * operator zooms far out.
 */
const PIN_MIN_SCREEN_RADIUS_PX = 22;

/**
 * Minimum pin body radius as a fraction of the current viewBox
 * extent. On large grids the VL circle radius is tiny relative to
 * the diagram; this floor keeps pins prominent at initial auto-fit.
 */
const PIN_VIEWBOX_FRACTION = 50;

/**
 * Cache the base radius per SVG element so `rescaleActionOverviewPins`
 * (called on every rAF during zoom) skips the querySelectorAll lookup.
 */
const pinBaseRadiusCache = new WeakMap<SVGSVGElement, number>();

/**
 * Pure helper for rescale math — exported so tests can pin it down
 * without exercising the DOM mutation side.
 */
export const computePinScale = (
    baseR: number,
    pxPerSvgUnit: number,
    viewBoxMax: number,
): { effectiveR: number; scale: number } => {
    const minSvgR = PIN_MIN_SCREEN_RADIUS_PX / pxPerSvgUnit;
    const viewBoxMinR = viewBoxMax / PIN_VIEWBOX_FRACTION;
    const effectiveR = Math.max(baseR, minSvgR, viewBoxMinR);
    return { effectiveR, scale: effectiveR / baseR };
};

export const rescaleActionOverviewPins = (container: HTMLElement | null) => {
    if (!container) return;
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;
    const layer = svg.querySelector('.nad-action-overview-pins');
    if (!layer) return;

    performance.mark('aod:rescalePins:start');

    // Derive pxPerSvgUnit from the viewBox width and the container's
    // client width — pure math, no forced layout.
    let pxPerSvgUnit = 1;
    let viewBoxMax = 0;
    const vbAttr = svg.getAttribute('viewBox');
    if (vbAttr) {
        const parts = vbAttr.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0) {
            const containerW = container.clientWidth;
            if (containerW > 0) {
                pxPerSvgUnit = containerW / parts[2];
            } else {
                const ctm = (svg as SVGGraphicsElement).getScreenCTM?.();
                if (ctm) pxPerSvgUnit = ctm.a;
            }
            viewBoxMax = Math.max(parts[2], parts[3]);
        }
    }

    let baseR = pinBaseRadiusCache.get(svg);
    if (baseR === undefined) {
        baseR = readPinBaseRadius(svg);
        pinBaseRadiusCache.set(svg, baseR);
    }
    const { scale } = computePinScale(baseR, pxPerSvgUnit, viewBoxMax);

    layer.querySelectorAll('.nad-action-overview-pin-body').forEach(body => {
        body.setAttribute('transform', `scale(${scale})`);
    });

    performance.mark('aod:rescalePins:end');
    const entry = performance.measure('aod:rescalePins', 'aod:rescalePins:start', 'aod:rescalePins:end');
    if (entry.duration > 5) console.log(`[PERF] aod:rescalePins: ${entry.duration.toFixed(2)}ms`);
};

/**
 * Delay (ms) used by {@link applyActionOverviewPins} to distinguish
 * a pin single-click from the first click of a double-click.
 */
export const PIN_SINGLE_CLICK_DELAY_MS = 250;

/**
 * Build a 5-pointed star SVG path string centred at (cx, cy).
 * Exported so unit tests can verify the generator stays stable.
 */
export const starPath = (cx: number, cy: number, outerR: number): string => {
    const innerR = outerR * 0.4;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
        const angle = (Math.PI / 2) + (i * Math.PI / 5);
        const r = i % 2 === 0 ? outerR : innerR;
        pts.push(`${cx + r * Math.cos(angle)},${cy - r * Math.sin(angle)}`);
    }
    return `M ${pts.join(' L ')} Z`;
};

/**
 * Build an X (cross) SVG path string centred at (cx, cy) with the
 * given half-width. Used as the "rejected" status symbol.
 */
export const crossPath = (cx: number, cy: number, halfW: number): string => {
    const t = halfW * 0.25; // arm thickness
    return [
        `M ${cx - halfW} ${cy - halfW + t}`,
        `L ${cx - t} ${cy}`,
        `L ${cx - halfW} ${cy + halfW - t}`,
        `L ${cx - halfW + t} ${cy + halfW}`,
        `L ${cx} ${cy + t}`,
        `L ${cx + halfW - t} ${cy + halfW}`,
        `L ${cx + halfW} ${cy + halfW - t}`,
        `L ${cx + t} ${cy}`,
        `L ${cx + halfW} ${cy - halfW + t}`,
        `L ${cx + halfW - t} ${cy - halfW}`,
        `L ${cx} ${cy - t}`,
        `L ${cx - halfW + t} ${cy - halfW}`,
        'Z',
    ].join(' ');
};

/** Options bag for {@link applyActionOverviewPins}. */
export interface ApplyPinsOptions {
    selectedActionIds?: Set<string>;
    rejectedActionIds?: Set<string>;
    combinedPins?: readonly CombinedPinInfo[];
    /**
     * Dimmed, dashed pins for scored-but-not-yet-simulated actions.
     * Rendered with their own double-click handler
     * ({@link onUnsimulatedPinDoubleClick}) so that a drill-down gesture
     * on one of them kicks off a manual simulation instead of the
     * action-variant view.
     */
    unsimulatedPins?: readonly ActionPinInfo[];
    /** Fires when an unsimulated pin is double-clicked. */
    onUnsimulatedPinDoubleClick?: (actionId: string) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const attachPinClickListeners = (
    g: SVGGElement,
    pinId: string,
    clickCb: (actionId: string, screenPos: { x: number; y: number }) => void,
    dblClickCb: ((actionId: string) => void) | undefined,
) => {
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    g.addEventListener('mousedown', (evt) => { evt.stopPropagation(); });
    g.addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (clickTimer !== null) return;
        const rect = (evt.currentTarget as SVGGElement).getBoundingClientRect();
        const screenPos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        clickTimer = setTimeout(() => {
            clickTimer = null;
            clickCb(pinId, screenPos);
        }, PIN_SINGLE_CLICK_DELAY_MS);
    });
    g.addEventListener('dblclick', (evt) => {
        evt.stopPropagation();
        if (clickTimer !== null) { clearTimeout(clickTimer); clickTimer = null; }
        if (dblClickCb) dblClickCb(pinId);
    });
};

const buildPinGlyph = (
    body: SVGGElement,
    R: number,
    labelFont: number,
    fill: string,
    label: string,
    titleText: string,
    strokeColor?: string,
    strokeWidth?: number,
) => {
    const tail = R * 0.9;
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = titleText;
    body.appendChild(title);

    const path = document.createElementNS(SVG_NS, 'path');
    const d = `M ${-R} ${-R - tail} A ${R} ${R} 0 1 1 ${R} ${-R - tail} L 0 0 Z`;
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    if (strokeColor) {
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', String(strokeWidth ?? R * 0.12));
    } else {
        path.setAttribute('stroke', 'none');
    }
    body.appendChild(path);

    const inner = document.createElementNS(SVG_NS, 'circle');
    inner.setAttribute('cx', '0');
    inner.setAttribute('cy', String(-R - tail));
    inner.setAttribute('r', String(R * 0.72));
    inner.setAttribute('fill', pinChrome.glyphBg);
    inner.setAttribute('fill-opacity', '0.92');
    inner.setAttribute('pointer-events', 'none');
    body.appendChild(inner);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '0');
    text.setAttribute('y', String(-R - tail));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', String(labelFont));
    text.setAttribute('font-weight', '800');
    text.setAttribute('font-family', 'system-ui, -apple-system, Arial, sans-serif');
    text.setAttribute('fill', pinChrome.glyphText);
    text.setAttribute('pointer-events', 'none');
    text.textContent = label;
    body.appendChild(text);
};

const resolvePinFill = (
    severity: ActionPinInfo['severity'],
    isSelected: boolean,
    isRejected: boolean,
    isDimmedByFilter: boolean = false,
): { fill: string; stroke?: string } => {
    if (isSelected) return { fill: severityFillHighlighted[severity], stroke: pinChrome.gold };
    // Filter-dimmed constituents reuse the same washed-out palette as
    // rejected pins so the operator reads them as "context, not a
    // first-class action" at a glance.
    if (isRejected || isDimmedByFilter) return { fill: severityFillDimmed[severity] };
    return { fill: severityFill[severity] };
};

const renderCombinedPin = (
    frag: DocumentFragment,
    cp: CombinedPinInfo,
    r: number,
    labelFont: number,
    edgeStrokeW: number,
    selectedIds: Set<string> | undefined,
    rejectedIds: Set<string> | undefined,
    onPinClick: (actionId: string, screenPos: { x: number; y: number }) => void,
    onPinDoubleClick: ((actionId: string) => void) | undefined,
) => {
    // Curved connection line between the two unitary pins.
    const dx = cp.p2.x - cp.p1.x;
    const dy = cp.p2.y - cp.p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const offsetFraction = 0.3;
    const ctrlX = (cp.p1.x + cp.p2.x) / 2 + (-dy / dist) * dist * offsetFraction;
    const ctrlY = (cp.p1.y + cp.p2.y) / 2 + (dx / dist) * dist * offsetFraction;

    const curvePath = document.createElementNS(SVG_NS, 'path');
    curvePath.setAttribute('d',
        `M ${cp.p1.x} ${cp.p1.y} Q ${ctrlX} ${ctrlY} ${cp.p2.x} ${cp.p2.y}`);
    curvePath.setAttribute('class', 'nad-combined-action-curve');
    curvePath.setAttribute('fill', 'none');
    curvePath.setAttribute('stroke', severityFill[cp.severity]);
    curvePath.setAttribute('stroke-width', String(edgeStrokeW));
    curvePath.setAttribute('stroke-dasharray', `${edgeStrokeW * 2.5} ${edgeStrokeW * 1.5}`);
    curvePath.setAttribute('stroke-linecap', 'round');
    curvePath.setAttribute('pointer-events', 'none');
    frag.appendChild(curvePath);

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'nad-action-overview-pin nad-combined-action-pin');
    g.setAttribute('transform', `translate(${cp.x} ${cp.y})`);
    g.setAttribute('data-action-id', cp.pairId);
    (g as SVGGElement).style.cursor = 'pointer';

    const body = document.createElementNS(SVG_NS, 'g');
    body.setAttribute('class', 'nad-action-overview-pin-body');
    body.setAttribute('transform', 'scale(1)');
    g.appendChild(body);

    const { fill, stroke } = resolvePinFill(cp.severity, selectedIds?.has(cp.pairId) ?? false, rejectedIds?.has(cp.pairId) ?? false);
    buildPinGlyph(body, r, labelFont, fill, cp.label, cp.title, stroke, stroke ? r * 0.12 : undefined);

    // "+" badge on the bubble top to indicate it's a combined pin.
    const tail = r * 0.9;
    const badgeCy = -r - tail - r * 0.95;
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('cx', '0');
    badge.setAttribute('cy', String(badgeCy));
    badge.setAttribute('r', String(r * 0.35));
    badge.setAttribute('fill', severityFill[cp.severity]);
    badge.setAttribute('stroke', 'white');
    badge.setAttribute('stroke-width', String(r * 0.06));
    badge.setAttribute('pointer-events', 'none');
    body.appendChild(badge);

    const plusText = document.createElementNS(SVG_NS, 'text');
    plusText.setAttribute('x', '0');
    plusText.setAttribute('y', String(badgeCy));
    plusText.setAttribute('text-anchor', 'middle');
    plusText.setAttribute('dominant-baseline', 'central');
    plusText.setAttribute('font-size', String(r * 0.5));
    plusText.setAttribute('font-weight', '900');
    plusText.setAttribute('font-family', 'system-ui, -apple-system, Arial, sans-serif');
    plusText.setAttribute('fill', 'white');
    plusText.setAttribute('pointer-events', 'none');
    plusText.textContent = '+';
    body.appendChild(plusText);

    attachPinClickListeners(g, cp.pairId, onPinClick, onPinDoubleClick);
    frag.appendChild(g);
};

const renderUnitaryPin = (
    frag: DocumentFragment,
    pin: ActionPinInfo,
    r: number,
    labelFont: number,
    selectedIds: Set<string> | undefined,
    rejectedIds: Set<string> | undefined,
    onPinClick: (actionId: string, screenPos: { x: number; y: number }) => void,
    onPinDoubleClick: ((actionId: string) => void) | undefined,
) => {
    const isSelected = selectedIds?.has(pin.id) ?? false;
    const isRejected = rejectedIds?.has(pin.id) ?? false;

    // Shared glyph factory used by both the overview tab and the
    // overflow-graph iframe overlay. Returns the inner <g> already
    // populated with body, chrome, label and the selected/rejected
    // status symbol.
    const g = createSharedPinGlyph(document, {
        severity: pin.severity,
        label: pin.label,
        title: pin.title,
        actionId: pin.id,
        isSelected,
        isRejected,
        dimmed: !!pin.dimmedByFilter,
        r,
        labelFont,
        bodyClass: 'nad-action-overview-pin-body',
    }) as SVGGElement;

    // Wrap-up customisation specific to the overview layer.
    g.setAttribute('class', 'nad-action-overview-pin');
    g.setAttribute('transform', `translate(${pin.x} ${pin.y})`);
    if (pin.dimmedByFilter) g.setAttribute('data-dimmed-by-filter', 'true');
    g.style.cursor = 'pointer';

    attachPinClickListeners(g, pin.id, onPinClick, onPinDoubleClick);
    frag.appendChild(g);
};

/**
 * Render a scored-but-not-simulated action pin. Rendered with a dashed
 * stroke + reduced opacity so it reads as a "preview" glyph the
 * operator can promote to a real simulation with a double-click.
 * Uses the 'grey' severity palette since we have no rho_after yet.
 */
const renderUnsimulatedPin = (
    frag: DocumentFragment,
    pin: ActionPinInfo,
    r: number,
    labelFont: number,
    onPinClick: (actionId: string, screenPos: { x: number; y: number }) => void,
    onUnsimulatedPinDoubleClick: ((actionId: string) => void) | undefined,
    onPinDoubleClick: ((actionId: string) => void) | undefined,
) => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'nad-action-overview-pin nad-action-overview-pin-unsimulated');
    g.setAttribute('transform', `translate(${pin.x} ${pin.y})`);
    g.setAttribute('data-action-id', pin.id);
    g.setAttribute('data-unsimulated', 'true');
    g.setAttribute('opacity', '0.5');
    (g as SVGGElement).style.cursor = 'pointer';

    const body = document.createElementNS(SVG_NS, 'g');
    body.setAttribute('class', 'nad-action-overview-pin-body');
    body.setAttribute('transform', 'scale(1)');
    g.appendChild(body);

    const fill = severityFillDimmed[pin.severity];
    buildPinGlyph(body, r, labelFont, fill, pin.label, pin.title, pinChrome.strokeNeutral, r * 0.08);

    // Override the stroke with a dashed pattern to visually
    // distinguish un-simulated pins from the solid-outline simulated
    // ones.
    const pinPath = body.querySelector('path');
    if (pinPath) {
        pinPath.setAttribute('stroke-dasharray', `${r * 0.35} ${r * 0.2}`);
    }

    // Double-click runs a manual simulation; single click still opens
    // the (minimal) preview popover via onPinClick so the operator
    // gets identical affordances to the simulated pins.
    attachPinClickListeners(
        g, pin.id, onPinClick,
        onUnsimulatedPinDoubleClick ?? onPinDoubleClick,
    );
    frag.appendChild(g);
};

/**
 * Inject (or refresh) the action-overview pin layer inside the
 * given container's SVG. Calling this with an empty `pins` array and
 * no combined pins wipes the layer.
 */
export const applyActionOverviewPins = (
    container: HTMLElement | null,
    pins: ActionPinInfo[],
    onPinClick: (actionId: string, screenPos: { x: number; y: number }) => void,
    onPinDoubleClick?: (actionId: string) => void,
    opts?: ApplyPinsOptions,
) => {
    if (!container) return;
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    if (!svg) return;

    // Purge any existing layer so repeated calls stay idempotent.
    svg.querySelectorAll('.nad-action-overview-pins').forEach(el => el.remove());

    const combinedPins = opts?.combinedPins ?? [];
    const unsimulatedPins = opts?.unsimulatedPins ?? [];
    const onUnsimulatedPinDoubleClick = opts?.onUnsimulatedPinDoubleClick;
    if (pins.length === 0 && combinedPins.length === 0 && unsimulatedPins.length === 0) return;

    const selectedIds = opts?.selectedActionIds;
    const rejectedIds = opts?.rejectedActionIds;

    const r = readPinBaseRadius(svg);
    pinBaseRadiusCache.set(svg, r);
    const labelFont = Math.max(9, r * 0.8);

    // Read the actual edge stroke width from the network SVG so
    // combined-action curves match the underlying edge thickness.
    let edgeStrokeW = 3;
    const edgePath = svg.querySelector('.nad-edge-paths path[style*="stroke-width"], .nad-edge-paths path') as SVGElement | null;
    if (edgePath) {
        const sw = edgePath.style?.strokeWidth || edgePath.getAttribute('stroke-width');
        if (sw) {
            const n = parseFloat(sw);
            if (Number.isFinite(n) && n > 0) edgeStrokeW = n;
        }
    }

    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'nad-action-overview-pins');
    const frag = document.createDocumentFragment();

    combinedPins.forEach(cp =>
        renderCombinedPin(frag, cp, r, labelFont, edgeStrokeW, selectedIds, rejectedIds, onPinClick, onPinDoubleClick),
    );
    pins.forEach(pin =>
        renderUnitaryPin(frag, pin, r, labelFont, selectedIds, rejectedIds, onPinClick, onPinDoubleClick),
    );
    unsimulatedPins.forEach(pin =>
        renderUnsimulatedPin(frag, pin, r, labelFont, onPinClick, onUnsimulatedPinDoubleClick, onPinDoubleClick),
    );

    layer.appendChild(frag);
    svg.appendChild(layer);

    // Apply the initial scale compensation so the pins come up at
    // the right size on the very first paint.
    rescaleActionOverviewPins(container);
};
