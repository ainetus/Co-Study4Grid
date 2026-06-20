// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { ViewBox } from '../../types';

/**
 * Bitmap snapshot of the live NAD for the opt-in "Bitmap" pan/zoom mode.
 *
 * The diagnostic that motivated this mode: Chrome RE-RASTERS the ~100k-node
 * vector SVG layer on every CSS transform, so even the GPU-transform mode only
 * buys ~1.2–1.5× (a pure ±2px translate still costs ~48ms/frame on the 5247-VL
 * grid). Rasterising the SVG to a <canvas> ONCE at gesture start and
 * transforming THAT bitmap during the gesture hits 120fps / 0 dropped frames
 * (~6× the GPU path) because the compositor just moves a flat texture — no
 * vector re-raster. See benchmarks/interaction_paint/.
 *
 * Two fidelity prerequisites the naive snapshot misses:
 *  1. **foreignObject taint.** pypowsybl's HTML VL labels live in <foreignObject>;
 *     `drawImage()` of an SVG <img> containing one throws SecurityError / taints
 *     the canvas. They are stripped from the clone — and the gesture culls them
 *     anyway (`.svg-interacting`), so the bitmap matches what the user sees.
 *  2. **App.css class-based paint.** Overload halos, the contingency glow and
 *     flow-delta colours come from App.css *stylesheet rules on classed clones*
 *     (see utils/svg/highlights.ts), NOT inline attributes. An SVG rendered in
 *     isolation as an <img> does not see the host page's stylesheet, so on the
 *     N-1 / Action tabs those halos would VANISH. We fix this by copying the
 *     relevant App.css rules + the resolved theme tokens into a <style> inside
 *     the clone, plus the current `data-zoom-tier` so the tier-capped halo
 *     widths render correctly.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Theme tokens referenced by the highlight / delta / edge-info App.css rules. */
const TOKEN_NAMES = [
    '--signal-overload', '--signal-action-target', '--signal-contingency',
    '--signal-delta-positive', '--signal-delta-negative', '--signal-delta-neutral',
    '--color-text-primary', '--color-diagram-surface', '--color-danger',
];

/** Class fragments whose App.css rules paint things absent from inline attrs. */
const SELECTOR_HINTS = [
    'nad-overloaded', 'nad-action-target', 'nad-contingency-highlight',
    'nad-delta-', 'nad-disconnected', 'nad-highlight', 'nad-edge-infos', 'nad-active',
];

/**
 * Collect the App.css rules + resolved theme tokens needed so a detached clone
 * paints its halos / deltas / edge-info exactly as the live diagram does.
 * Returns a CSS string to inline into the clone's own <style>.
 */
export const collectHighlightCss = (doc: Document = document): string => {
    const view = doc.defaultView;
    let tokenCss = '';
    try {
        const cs = view?.getComputedStyle(doc.documentElement);
        if (cs) {
            const decls = TOKEN_NAMES
                .map(n => { const v = cs.getPropertyValue(n).trim(); return v ? `${n}:${v}` : ''; })
                .filter(Boolean)
                .join(';');
            if (decls) tokenCss = `svg{${decls}}`;
        }
    } catch { /* getComputedStyle unavailable */ }

    // The live diagram's strokes are kept at constant SCREEN width by the
    // base `.svg-container svg {path,line,polyline,rect}` non-scaling-stroke
    // rule (App.css). That rule is scoped to `.svg-container` so it does NOT
    // travel into the detached clone — without re-asserting it here, every
    // branch line and flow-delta stroke renders at its USER-space width, which
    // is sub-pixel at the base viewBox (≈ invisible). Re-assert it (low
    // specificity, so the !important halo overrides still win).
    let rulesCss = 'path,line,polyline,rect{vector-effect:non-scaling-stroke}\n';
    try {
        for (const sheet of Array.from(doc.styleSheets)) {
            let rules: CSSRuleList | null = null;
            try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheet
            if (!rules) continue;
            for (const rule of Array.from(rules)) {
                const sel = (rule as CSSStyleRule).selectorText;
                if (sel && SELECTOR_HINTS.some(h => sel.includes(h))) {
                    rulesCss += (rule as CSSStyleRule).cssText + '\n';
                }
            }
        }
    } catch { /* styleSheets unavailable */ }

    return tokenCss ? tokenCss + '\n' + rulesCss : rulesCss;
};

export interface SnapshotOptions {
    /** viewBox baked on the live SVG at gesture start. */
    baseVb: ViewBox;
    /** Element CSS box (untransformed) — the raster surface size. */
    width: number;
    height: number;
    /** Current `data-zoom-tier` so tier-capped halo widths render right. */
    zoomTier?: string | null;
    /** CSS (from collectHighlightCss) to inline so halos/deltas keep painting. */
    css?: string;
}

/**
 * Build a detached, de-tainted, style-inlined clone of the live NAD svg,
 * ready to rasterise. Pure DOM work — unit-testable in jsdom.
 */
export const buildSnapshotSvg = (liveSvg: SVGSVGElement, opts: SnapshotOptions): SVGSVGElement => {
    const clone = liveSvg.cloneNode(true) as SVGSVGElement;
    // Strip HTML <foreignObject> labels (canvas taint / SecurityError on draw).
    clone.querySelectorAll('foreignObject').forEach(n => n.remove());
    // Drop any live interaction transform that may sit on the root.
    if (clone.style) { clone.style.transform = ''; clone.style.willChange = ''; }
    clone.setAttribute('width', String(opts.width));
    clone.setAttribute('height', String(opts.height));
    clone.setAttribute('viewBox', `${opts.baseVb.x} ${opts.baseVb.y} ${opts.baseVb.w} ${opts.baseVb.h}`);
    if (opts.zoomTier) clone.setAttribute('data-zoom-tier', opts.zoomTier);
    if (opts.css) {
        const style = (clone.ownerDocument || document).createElementNS(SVG_NS, 'style');
        style.textContent = opts.css;
        clone.insertBefore(style, clone.firstChild);
    }
    return clone;
};

/**
 * Rasterise a (detached) svg element onto a fresh dpr-scaled <canvas>.
 * Async (the SVG must decode as an Image first). Browser-only — the caller
 * guards the jsdom/test path.
 */
export const rasterizeSvgToCanvas = async (
    svg: SVGSVGElement, width: number, height: number, dpr: number,
): Promise<HTMLCanvasElement> => {
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const img = new Image();
        img.width = width;
        img.height = height;
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('snapshot image decode failed'));
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context for snapshot');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(img, 0, 0, width, height);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
};

/** One-shot: clone + de-taint + style-inline + rasterise → dpr-scaled canvas. */
export const createNadSnapshotCanvas = async (
    liveSvg: SVGSVGElement,
    opts: SnapshotOptions & { dpr: number },
): Promise<HTMLCanvasElement> => {
    const clone = buildSnapshotSvg(liveSvg, opts);
    return rasterizeSvgToCanvas(clone, opts.width, opts.height, opts.dpr);
};
