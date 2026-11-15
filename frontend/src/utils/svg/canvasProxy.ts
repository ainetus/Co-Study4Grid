// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { ViewBox } from '../../types';
import {
    emptyBox, geometryOf, grow, IDENTITY, multiply, outside, parseTransform, resolveStyle, scaleOf,
    type BBox, type Geometry, type Mat, type Style, type SubPath,
} from './canvasProxyShapes';
import {
    createTextCollector, renderTextGroup,
    type FontMetrics, type LabelFrame, type TextGroup, type TextRun, type TextStyle,
} from './canvasProxyText';

export { parseTransform } from './canvasProxyShapes';

/**
 * Canvas gesture proxy for the `'canvas'` pan/zoom mode.
 *
 * Rewriting the root viewBox of a large NAD makes Blink restyle, re-lay out
 * and re-layerize the whole ~100k-node tree on every frame, and the
 * `.svg-interacting` culling toggle costs the same again at both ends of a
 * gesture (docs/performance/large-grid-interaction-audit-2026-11.md). This
 * module draws a light stand-in of the network on a `<canvas>` stacked over
 * the live SVG instead: the branch edges, bus / winding circles and highlight
 * halos, grouped into one `Path2D` per CSS style and grid cell (a few hundred
 * items for the full European grid). During a gesture usePanZoom only redraws
 * the canvas; the live SVG is left untouched and gets its viewBox once, on
 * settle, while the canvas still covers it.
 *
 * Colours, widths, dashes and opacities are resolved once, at build time,
 * from the live diagram's computed styles, so pypowsybl's palette, the
 * App.css highlight / delta rules and the theme are honoured.
 * `vector-effect: non-scaling-stroke` is emulated by dividing the stroke
 * width by the zoom scale.
 *
 * The flow values (with their arrows) and the voltage-level labels are drawn
 * too, once they are readable (`TEXT_MIN_PX`, canvasProxyText.ts): they stay
 * on screen through the gesture and the settle instead of coming back ~0.7 s
 * after the operator stops (the pause, then the bake of the live SVG). Those
 * layers — two thirds of the European NAD's nodes — are read in idle slices
 * after the network itself, so no build task blocks input for long.
 */

/** usePanZoom's zoom tiers (`data-zoom-tier`), which App.css hides layers by. */
export type ProxyTier = 'overview' | 'region' | 'detail';
const TIER_RANK: Record<ProxyTier, number> = { overview: 0, region: 1, detail: 2 };

/**
 * Top-level SVG groups drawn by the proxy, in pypowsybl's paint order (the
 * live SVG's DOM order is kept), with the first zoom tier that shows them —
 * App.css hides the flow values and their arrows (`.nad-edge-infos`) at the
 * overview tier — and whether they are read in idle slices after the build.
 * Highlight halos live in `#nad-background-layer` (utils/svg/highlights.ts).
 * The VL labels are HTML boxes in a root-level `foreignObject.nad-text-nodes`;
 * `.nad-text-edges` links each VL to its label.
 */
const DRAWN_LAYERS = new Map<string, { tier: ProxyTier; deferred: boolean }>([
    ['nad-vl-nodes', { tier: 'overview', deferred: false }],
    ['nad-branch-edges', { tier: 'overview', deferred: false }],
    ['nad-3wt-edges', { tier: 'overview', deferred: false }],
    ['nad-3wt-nodes', { tier: 'overview', deferred: false }],
    ['nad-injections', { tier: 'overview', deferred: false }],
    ['nad-edge-infos', { tier: 'region', deferred: true }],
    ['nad-text-edges', { tier: 'overview', deferred: true }],
    ['nad-label-nodes', { tier: 'overview', deferred: true }],
    ['nad-text-nodes', { tier: 'overview', deferred: true }],
]);
/** Layers of the VL labels, which the legend's label toggle hides (`nad-hide-vl-labels`). */
const LABEL_LAYERS = new Set(['nad-text-edges', 'nad-label-nodes', 'nad-text-nodes']);
const HIDE_LABELS_CLASS = 'nad-hide-vl-labels';
const DRAWN_TAGS = new Set(['polyline', 'polygon', 'line', 'circle', 'ellipse', 'rect', 'path']);
const GRID = 8;
/**
 * Text is drawn once it is readable: below this on-screen font size (CSS px)
 * labels and flow values are specks, and the thousands of them in view at
 * region zoom would cost the frames their fluidity.
 */
export const TEXT_MIN_PX = 4;
/**
 * The flow arrows, label backgrounds and label connectors are left out until
 * they are this big on screen (CSS px; the smaller side of a filled shape,
 * the length of a line, a label background's font size): the arrows then
 * come with their flow values, the backgrounds with their text. Drawn
 * smaller, thousands of them at region / detail zoom cost zoom bursts and
 * detail-zoom pans 9–20 % of their frame rate.
 */
const LOD_MIN_PX = TEXT_MIN_PX;
/** Idle slices of the deferred layers (ms): long enough to progress, short enough not to block input. */
const SLICE_MIN_MS = 5;
const SLICE_MAX_MS = 40;

interface DrawItem extends Style {
    kind: 'shapes';
    path: Path2D;
    bbox: BBox;
    /** Rank of the first zoom tier that shows it. */
    minTier: number;
    /** Root units: the group shows once an element's side reaches LOD_MIN_PX on screen; 0 = at any size. */
    lodSize: number;
}

/** One layer's draw items, in paint order: its shapes, then its text. */
interface Bucket {
    shapes: DrawItem[];
    text: TextGroup[];
}

export interface CanvasProxy {
    readonly canvas: HTMLCanvasElement;
    /** False when the browser gave no 2D context: the proxy cannot draw. */
    readonly drawable: boolean;
    /** Draw the stand-in for `vb` (opaque), with the live SVG's `xMidYMid meet` mapping. */
    draw: (vb: ViewBox) => void;
    /** Clear to transparent: the live SVG shows through. */
    clear: () => void;
    /** Size the canvas to the panel and bake the overview cache for it (no-op when both are current). */
    prepare: () => void;
    /** Read more of the deferred layers (flow values, labels) for up to `budgetMs`; true once all are in. */
    step: (budgetMs: number) => boolean;
    /** Deferred layers left to read. */
    readonly pending: boolean;
    /** Number of grouped shape items (diagnostics and tests). */
    readonly itemCount: number;
    /** Number of text runs: flow values and label lines (diagnostics and tests). */
    readonly textRunCount: number;
}

export interface CanvasProxyOptions {
    /**
     * Pre-render the whole network once at 2× the full-extent scale and blit
     * it for frames near full extent (≤ ~1.3× zoom) instead of re-stroking
     * every path. Default true.
     */
    overviewCache?: boolean;
    /**
     * Halo width (CSS px) the live diagram uses at `vb` — usePanZoom's
     * `--nad-halo-w`. Without it, halos keep the width they had at build time.
     */
    haloWidth?: (vb: ViewBox) => number | null;
    /**
     * The zoom tier the live diagram would have at `vb` (usePanZoom's
     * `data-zoom-tier`), so a frame shows the layers App.css shows there.
     * Without it every layer is drawn.
     */
    tierOf?: (vb: ViewBox) => ProxyTier;
}

/** Overview-cache pixel budget (2× a typical panel at dpr 1 is ~5 MP). */
const CACHE_MAX_PIXELS = 8e6;
/** Blit the cache while it is at least this much denser than the screen. */
const CACHE_MAX_MAGNIFICATION = 0.65;

// Inline styles of the voltage filter / highlight clones, read from the
// attribute: `.style` builds a declaration object per element.
const DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none/i;
const VISIBILITY = /(?:^|;)\s*visibility\s*:\s*([a-z]+)/i;

/**
 * Build the proxy for a live NAD. `extent` is the diagram's full-extent
 * viewBox (the grid of culling cells covers it); falls back to the live
 * viewBox. Reads the live SVG only — it is never modified. The network is
 * read at once; the flow values and labels by `step()`.
 */
export const buildCanvasProxy = (
    live: SVGSVGElement,
    container: HTMLElement,
    extent: ViewBox | null,
    options: CanvasProxyOptions = {},
): CanvasProxy => {
    const doc = container.ownerDocument;
    const view = doc.defaultView ?? window;
    const vb0 = live.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
    const ext: ViewBox = extent
        ?? (vb0 && vb0.length === 4 && vb0.every(Number.isFinite) ? { x: vb0[0], y: vb0[1], w: vb0[2], h: vb0[3] } : { x: 0, y: 0, w: 1, h: 1 });
    const cellOf = (b: BBox): number => {
        const fx = ((b[0] + b[2]) / 2 - ext.x) / (ext.w || 1);
        const fy = ((b[1] + b[3]) / 2 - ext.y) / (ext.h || 1);
        const cx = Math.max(0, Math.min(GRID - 1, Math.floor(fx * GRID)));
        const cy = Math.max(0, Math.min(GRID - 1, Math.floor(fy * GRID)));
        return cy * GRID + cx;
    };

    // Element → root transform; memoised for groups only (leaves are read once).
    const matrices = new Map<Element, Mat>();
    const groupMatrix = (el: Element | null): Mat => {
        if (!el || el === live) return IDENTITY;
        let m = matrices.get(el);
        if (!m) {
            const t = el.getAttribute('transform');
            const pm = groupMatrix(el.parentElement);
            m = t ? multiply(pm, parseTransform(t)) : pm;
            matrices.set(el, m);
        }
        return m;
    };
    const matrixOf = (el: Element): Mat => {
        const t = el.getAttribute('transform');
        const pm = groupMatrix(el.parentElement);
        return t ? multiply(pm, parseTransform(t)) : pm;
    };
    // The voltage filter (useDiagrams) hides elements with inline styles;
    // highlight clones re-assert `visibility: visible` inline.
    const ownVisibility = (style: string | null): boolean | null => {
        const v = style ? VISIBILITY.exec(style)?.[1].toLowerCase() : undefined;
        return v === 'hidden' || v === 'collapse' ? true : v === 'visible' ? false : null;
    };
    const groupHidden = new Map<Element, readonly [boolean, boolean]>();
    const hiddenOf = (el: Element | null): readonly [boolean, boolean] => {
        if (!el || el === live) return [false, false];
        let h = groupHidden.get(el);
        if (!h) {
            const p = hiddenOf(el.parentElement);
            const s = el.getAttribute('style');
            h = [p[0] || (!!s && DISPLAY_NONE.test(s)), ownVisibility(s) ?? p[1]];
            groupHidden.set(el, h);
        }
        return h;
    };
    const inlineHidden = (el: Element): boolean => {
        const p = hiddenOf(el.parentElement);
        const s = el.getAttribute('style');
        if (p[0] || (!!s && DISPLAY_NONE.test(s))) return true;
        return ownVisibility(s) ?? p[1];
    };

    const canvas = doc.createElement('canvas');
    canvas.className = 'nad-canvas-proxy';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');

    // Font metrics, measured once per font on the proxy's own context — the
    // engine that lays out the live labels, so the widths match it exactly.
    const metrics = new Map<string, FontMetrics>();
    const metricsOf = (font: string): FontMetrics | null => {
        let mt = metrics.get(font);
        if (!mt && ctx) {
            ctx.font = font;
            const x = ctx.measureText('x');
            mt = { xHeight: x.actualBoundingBoxAscent || 0, ascent: x.fontBoundingBoxAscent || 0, descent: x.fontBoundingBoxDescent || 0 };
            metrics.set(font, mt);
        }
        return mt ?? null;
    };
    const measure = (font: string, text: string) => {
        if (!ctx) return 0;
        ctx.font = font;
        return ctx.measureText(text).width;
    };

    const labelsHidden = container.classList.contains(HIDE_LABELS_CLASS);
    const layers: Array<{ el: Element; tier: number; deferred: boolean }> = [];
    for (const child of Array.from(live.children)) {
        if (child.id === 'nad-background-layer') {
            layers.push({ el: child, tier: 0, deferred: false });
            continue;
        }
        const name = (child.getAttribute('class') ?? '').split(/\s+/).find(c => DRAWN_LAYERS.has(c));
        if (!name || (labelsHidden && LABEL_LAYERS.has(name))) continue;
        const { tier, deferred } = DRAWN_LAYERS.get(name) as { tier: ProxyTier; deferred: boolean };
        // Hidden by CSS for a reason other than the zoom tier (the `display` of
        // a tier-gated layer only reflects the current tier).
        if (tier === 'overview' && view.getComputedStyle(child).display === 'none') continue;
        layers.push({ el: child, tier: TIER_RANK[tier], deferred });
    }

    const buckets: Bucket[] = layers.map(() => ({ shapes: [], text: [] }));
    const shapeGroups = new Map<string, DrawItem>();
    const textGroups = new Map<string, TextGroup>();
    let textRunCount = 0;
    const addShape = (li: number, minTier: number, styleKey: string, style: Style, geom: Geometry, lodSize: number) => {
        const key = `${styleKey}#${cellOf(geom.bbox)}`;
        let item = shapeGroups.get(key);
        if (!item) {
            item = { ...style, kind: 'shapes', path: new Path2D(), bbox: emptyBox(), minTier, lodSize: 0 };
            shapeGroups.set(key, item);
            buckets[li].shapes.push(item);
        }
        geom.build(item.path, !!style.stroke);
        grow(item.bbox, geom.bbox);
        if (lodSize > item.lodSize) item.lodSize = lodSize;
    };
    const addText = (li: number, minTier: number, styleKey: string, style: TextStyle, unitScale: number, run: TextRun) => {
        const key = `${styleKey}#${cellOf(run.bbox)}`;
        let group = textGroups.get(key);
        if (!group) {
            group = { ...style, kind: 'text', runs: [], bbox: emptyBox(), unitScale, minTier };
            textGroups.set(key, group);
            buckets[li].text.push(group);
        }
        group.runs.push(run);
        textRunCount++;
        grow(group.bbox, run.bbox);
    };
    const collector = createTextCollector({ view, matrixOf, inlineHidden, metricsOf, measure, shape: addShape, text: addText });

    const styles = new Map<string, Style | null>();
    const parentKeys = new Map<Element, string>();
    const paths = new Map<string, SubPath[] | null>();
    // One element of an SVG layer. `lod`: the layer's shapes are left out
    // below LOD_MIN_PX on screen (flows and labels).
    const visit = (el: Element, li: number, tier: number, lod: boolean) => {
        const tag = el.localName;
        if (tag === 'text') {
            if (ctx) collector.svgText(el, li, tier);
            return;
        }
        if (tag === 'foreignObject') {
            // App.css shows `.nad-vl-nodes foreignObject` labels at the detail tier only.
            if (!ctx || labelsHidden || inlineHidden(el)) return;
            const frame = collector.labelFrame(el);
            for (const box of Array.from(el.querySelectorAll('.nad-label-box'))) collector.labelBox(box as HTMLElement, frame, li, TIER_RANK.detail);
            return;
        }
        if (!DRAWN_TAGS.has(tag) || inlineHidden(el)) return;
        const parent = el.parentElement;
        const m = matrixOf(el);
        const scale = scaleOf(m);
        let pk = parent ? parentKeys.get(parent) : '';
        if (pk === undefined && parent) {
            pk = `${parent.getAttribute('class')}|${parent.getAttribute('style')}`;
            parentKeys.set(parent, pk);
        }
        const styleKey = `${li}|${tag}|${el.getAttribute('class')}|${el.getAttribute('style')}|${pk}|${scale.toPrecision(3)}`;
        let style = styles.get(styleKey);
        if (style === undefined) {
            style = resolveStyle(el, parent, scale);
            styles.set(styleKey, style);
        }
        if (!style) return;
        const geom = geometryOf(el, m, paths);
        if (!geom) return;
        const b = geom.bbox;
        const w = b[2] - b[0], h = b[3] - b[1];
        addShape(li, tier, styleKey, style, geom, lod ? (style.fill ? Math.min(w, h) : Math.max(w, h)) : 0);
    };

    // The network now; flows and labels as idle slices (`step`).
    layers.forEach((layer, li) => {
        if (layer.deferred) return;
        for (const el of Array.from(layer.el.querySelectorAll('*'))) visit(el, li, layer.tier, false);
    });
    interface Job { li: number; tier: number; layer: Element; items: Element[] | null; frame: LabelFrame | null; i: number }
    const jobs: Job[] = [];
    layers.forEach((layer, li) => {
        if (layer.deferred) jobs.push({ li, tier: layer.tier, layer: layer.el, items: null, frame: null, i: 0 });
    });
    // Bumped as deferred layers land: the overview cache re-bakes with them.
    let version = 0;
    const step = (budgetMs: number): boolean => {
        const end = performance.now() + budgetMs;
        let n = 0;
        while (jobs.length) {
            const job = jobs[0];
            if (!job.items) {
                const labels = job.layer.localName === 'foreignObject';
                if (labels && (!ctx || inlineHidden(job.layer))) {
                    jobs.shift();
                    continue;
                }
                job.items = Array.from(job.layer.querySelectorAll(labels ? '.nad-label-box' : '*'));
                job.frame = labels ? collector.labelFrame(job.layer) : null;
            }
            const { items, frame } = job;
            while (job.i < items.length) {
                const el = items[job.i++];
                if (frame) collector.labelBox(el as HTMLElement, frame, job.li, job.tier);
                else visit(el, job.li, job.tier, true);
                if (++n % 64 === 0 && performance.now() > end) return false;
            }
            jobs.shift();
            version++;
        }
        return true;
    };

    const opaque = (c: string | undefined) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
    const containerBg = view.getComputedStyle(container).backgroundColor;
    const bodyBg = doc.body ? view.getComputedStyle(doc.body).backgroundColor : undefined;
    // Frames paint this first so they fully cover the live SVG; between
    // gestures the canvas is cleared to transparent instead.
    const background = opaque(containerBg) ? containerBg : opaque(bodyBg) ? (bodyBg as string) : 'white';

    // `scale` maps root user units to device pixels, `pxPerUnit` to CSS px
    // (what the size thresholds read). A non-scaling stroke of `w` CSS px is
    // `w * widthMul / scale` user units: `widthMul` is the dpr for on-screen
    // frames, and the cache-to-screen ratio for the cache. `tier` gates the
    // layers App.css hides at that zoom tier.
    const render = (
        c: CanvasRenderingContext2D, scale: number, ox: number, oy: number, cull: BBox | null, widthMul: number,
        haloPx: number | null, tier: number, pxPerUnit: number, shapes: boolean, text: boolean,
    ) => {
        c.setTransform(scale, 0, 0, scale, ox, oy);
        // SVG defaults: pypowsybl sets no caps / joins on the edges.
        c.lineCap = 'butt';
        c.lineJoin = 'miter';
        c.miterLimit = 4;
        for (const bucket of buckets) {
            if (shapes) {
                for (const e of bucket.shapes) {
                    if (e.minTier > tier || (e.lodSize > 0 && e.lodSize * pxPerUnit < LOD_MIN_PX) || (cull && outside(e.bbox, cull))) continue;
                    if (e.fill) {
                        c.globalAlpha = e.fillAlpha;
                        c.fillStyle = e.fill;
                        c.fill(e.path);
                    }
                    if (e.stroke) {
                        const k = e.nonScaling ? widthMul / scale : 1;
                        c.globalAlpha = e.strokeAlpha;
                        c.strokeStyle = e.stroke;
                        c.lineWidth = (e.zoomWidth && haloPx != null ? haloPx * e.zoomWidth : e.width) * k;
                        c.setLineDash(e.dash.length ? e.dash.map(d => d * k) : []);
                        c.stroke(e.path);
                    }
                }
            }
            if (text) {
                for (const g of bucket.text) {
                    if (g.minTier > tier || g.size * g.unitScale * pxPerUnit < TEXT_MIN_PX || (cull && outside(g.bbox, cull))) continue;
                    renderTextGroup(c, g, scale, ox, oy, cull);
                }
            }
        }
        c.globalAlpha = 1;
    };
    const tierAt = (vb: ViewBox) => TIER_RANK[options.tierOf?.(vb) ?? 'detail'];

    let cache: HTMLCanvasElement | null = null;
    // Panel size and content the cache was baked for: its stroke widths are
    // exact only there, and the deferred layers re-bake it.
    let cacheFor = '';
    let cacheVersion = -1;
    let cacheScale = 0, cacheOx = 0, cacheOy = 0;
    const sizeKey = (W: number, H: number, dpr: number) => `${W}x${H}@${dpr}`;
    const renderCache = (W: number, H: number, dpr: number) => {
        let cw = 2 * W * dpr, ch = 2 * H * dpr;
        const shrink = Math.min(1, Math.sqrt(CACHE_MAX_PIXELS / (cw * ch)));
        cw = Math.max(1, Math.round(cw * shrink));
        ch = Math.max(1, Math.round(ch * shrink));
        const c = doc.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const cc = c.getContext('2d', { alpha: false });
        if (!cc) return;
        cacheScale = Math.min(cw / ext.w, ch / ext.h);
        cacheOx = (cw - cacheScale * ext.w) / 2 - cacheScale * ext.x;
        cacheOy = (ch - cacheScale * ext.h) / 2 - cacheScale * ext.y;
        cc.fillStyle = background;
        cc.fillRect(0, 0, cw, ch);
        // At full extent the cache is shown at `fullScale / cacheScale`, so
        // bake non-scaling strokes at their full-extent on-screen width. Text
        // is never baked: its size follows the zoom.
        const fullA = Math.min(W / ext.w, H / ext.h);
        render(cc, cacheScale, cacheOx, cacheOy, null, (dpr * cacheScale) / (dpr * fullA), options.haloWidth?.(ext) ?? null, tierAt(ext), fullA, true, false);
        cache = c;
        cacheFor = sizeKey(W, H, dpr);
        cacheVersion = version;
    };

    // The live SVG's own box: its viewBox maps onto this fractional size (the
    // panel's integer clientHeight put the proxy up to ~0.3 px off the live
    // diagram at the edges). jsdom has no layout: the container's client size.
    const size = () => {
        const r = live.getBoundingClientRect();
        return { W: r.width || container.clientWidth, H: r.height || container.clientHeight };
    };
    // Resizing the canvas restyles it (a relayout + re-layerization of the
    // page): done by prepare() on idle, so a gesture normally finds it sized.
    // Rounded up so it covers the fractional panel; CSS px = backing px / dpr.
    const fit = (W: number, H: number, dpr: number) => {
        const pw = Math.ceil(W * dpr), ph = Math.ceil(H * dpr);
        if (canvas.width === pw && canvas.height === ph) return;
        canvas.width = pw;
        canvas.height = ph;
        canvas.style.width = `${pw / dpr}px`;
        canvas.style.height = `${ph / dpr}px`;
    };

    const prepare = () => {
        const { W, H } = size();
        const dpr = view.devicePixelRatio || 1;
        if (!(W > 0 && H > 0)) return;
        fit(W, H, dpr);
        if (options.overviewCache === false || (cacheFor === sizeKey(W, H, dpr) && cacheVersion === version)) return;
        renderCache(W, H, dpr);
    };

    const clear = () => {
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    const draw = (vb: ViewBox) => {
        if (!ctx) return;
        const dpr = view.devicePixelRatio || 1;
        const { W, H } = size();
        if (!(W > 0 && H > 0 && vb.w > 0 && vb.h > 0)) return;
        fit(W, H, dpr);
        // preserveAspectRatio="xMidYMid meet", exactly as the live SVG maps it.
        const a = Math.min(W / vb.w, H / vb.h);
        const cx = (W - a * vb.w) / 2 - a * vb.x;
        const cy = (H - a * vb.h) / 2 - a * vb.y;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const cull: BBox = [-cx / a, -cy / a, (W - cx) / a, (H - cy) / a];
        const tier = tierAt(vb);
        const haloPx = options.haloWidth?.(vb) ?? null;
        // A cache baked for another panel size waits for the next idle
        // prepare() (never re-baked mid-gesture); vectors are exact meanwhile.
        if (cache && cacheFor === sizeKey(W, H, dpr) && (dpr * a) / cacheScale <= CACHE_MAX_MAGNIFICATION) {
            const k = (dpr * a) / cacheScale;
            ctx.setTransform(k, 0, 0, k, dpr * cx - k * cacheOx, dpr * cy - k * cacheOy);
            ctx.drawImage(cache, 0, 0);
            // Text readable this far out (a small grid) goes over the blit.
            if (textRunCount) render(ctx, dpr * a, dpr * cx, dpr * cy, cull, dpr, haloPx, tier, a, false, true);
            return;
        }
        render(ctx, dpr * a, dpr * cx, dpr * cy, cull, dpr, haloPx, tier, a, true, true);
    };

    return {
        canvas, drawable: !!ctx, draw, clear, prepare, step,
        get pending() { return jobs.length > 0; },
        get itemCount() { return shapeGroups.size; },
        get textRunCount() { return textRunCount; },
    };
};

/**
 * Set on the diagram container while the proxy covers it. The live SVG
 * underneath is then still at the gesture's start viewBox, so what it would
 * hit-test is not what the operator sees: hover / click handlers skip it.
 */
export const GESTURE_PROXY_ATTR = 'data-gesture-proxy';

/**
 * Quiet time before rebuilding after the live diagram changed. Highlight and
 * filter changes come in bursts (Inspect typing, a contingency repainting its
 * deltas) and the rebuild is a ~0.1 s task on the European grid: run right
 * away, it competed with the frames that show the change (an Inspect jump).
 */
const REBUILD_DEBOUNCE_MS = 600;

export interface CanvasProxyController {
    /** Start a gesture (building the proxy first if needed; the next frame() shows it); false when unavailable. */
    begin: () => boolean;
    /** Redraw the visible proxy at `vb`. */
    frame: (vb: ViewBox) => void;
    /** Hide the proxy two frames from now, once the live SVG has painted its new viewBox. */
    settle: () => void;
    /** Hide immediately and cancel a pending settle. */
    hide: () => void;
    /** The live diagram changed (highlights, theme, filter): rebuild once changes pause, when idle. */
    invalidate: () => void;
    /** Build ahead of the next gesture (or re-bake the overview cache for a resized panel), when the browser is idle. */
    prewarm: () => void;
    /** Drop the canvas and its geometry (tab hidden, diagram replaced, unmount). */
    dispose: () => void;
}

interface ControllerDeps {
    getLiveSvg: () => SVGSVGElement | null;
    getContainer: () => HTMLElement | null;
    getExtent: () => ViewBox | null;
    /** See `CanvasProxyOptions.haloWidth`. */
    haloWidth?: (vb: ViewBox) => number | null;
    /** See `CanvasProxyOptions.tierOf`. */
    tierOf?: (vb: ViewBox) => ProxyTier;
}

export const createCanvasProxyController = ({ getLiveSvg, getContainer, getExtent, haloWidth, tierOf }: ControllerDeps): CanvasProxyController => {
    let proxy: CanvasProxy | null = null;
    let builtFor: SVGSVGElement | null = null;
    let stale = true;
    let showing = false;
    let token = 0;
    let idleScheduled = false;
    let stepScheduled = false;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    // A build that threw is not retried for the same diagram until it changes.
    let failedFor: SVGSVGElement | null = null;
    // Bumped by dispose() so an idle build scheduled before it is dropped.
    let generation = 0;

    const viewOf = () => getContainer()?.ownerDocument.defaultView ?? window;

    // The canvas never changes style once mounted: it stays composited
    // (`will-change`) and click-through (`pointer-events: none`) over the live
    // SVG, is shown by drawing an opaque frame and hidden by clearing it. On
    // the European grid any style change on it costs a re-layerization of the
    // whole diagram (50–90 ms at region zoom), and toggling `display`
    // re-rasterised the layer holding the live SVG (~3 s).
    const hideCanvas = () => {
        showing = false;
        proxy?.clear();
        getContainer()?.removeAttribute(GESTURE_PROXY_ATTR);
    };

    // Read the deferred layers in idle slices — never during a gesture (a
    // slice would cost its frames; settle / hide resume it).
    const continueBuild = () => {
        const target = proxy;
        if (stepScheduled || !target?.pending) return;
        stepScheduled = true;
        const view = viewOf();
        const gen = generation;
        const run = (deadline?: IdleDeadline) => {
            stepScheduled = false;
            if (gen !== generation || proxy !== target || showing || !target.pending) return;
            const budget = deadline ? Math.min(SLICE_MAX_MS, Math.max(SLICE_MIN_MS, deadline.timeRemaining())) : 4 * SLICE_MIN_MS;
            if (target.step(budget)) target.prepare();
            else continueBuild();
        };
        if (typeof view.requestIdleCallback === 'function') view.requestIdleCallback(run, { timeout: 1000 });
        else view.setTimeout(() => run(), 50);
    };

    const ensure = (): CanvasProxy | null => {
        const live = getLiveSvg();
        const container = getContainer();
        if (!live || !container) return null;
        const reusable = proxy && builtFor === live && proxy.canvas.parentElement === container;
        // Never swap the canvas in the middle of a gesture: a stale proxy is
        // still a faithful stand-in until the gesture ends.
        if (reusable && (!stale || showing)) return proxy;
        // No Path2D / 2D canvas (jsdom, exotic embeds): no proxy, and the
        // gesture takes the classic path. Same if the build fails.
        if (typeof Path2D !== 'function' || failedFor === live) return null;
        // A hidden panel has no layout to read the labels from: build once it
        // is shown (the resize observer prewarms then).
        if (!(container.clientWidth > 0 && container.clientHeight > 0)) return null;
        let next: CanvasProxy;
        try {
            next = buildCanvasProxy(live, container, getExtent(), { haloWidth, tierOf });
        } catch {
            failedFor = live;
            return null;
        }
        proxy?.canvas.remove();
        const c = next.canvas;
        c.style.position = 'absolute';
        c.style.left = '0';
        c.style.top = '0';
        c.style.pointerEvents = 'none';
        c.style.willChange = 'transform';
        container.appendChild(c);
        next.prepare();
        proxy = next;
        builtFor = live;
        stale = false;
        continueBuild();
        return proxy;
    };

    const prewarm = () => {
        if (idleScheduled) return;
        const view = viewOf();
        idleScheduled = true;
        const gen = generation;
        const run = () => {
            idleScheduled = false;
            if (gen !== generation || showing) return;
            if (stale || !proxy) ensure();
            else proxy.prepare();
        };
        if (typeof view.requestIdleCallback === 'function') view.requestIdleCallback(run, { timeout: 2000 });
        else view.setTimeout(run, 200);
    };

    return {
        begin: () => {
            token++;
            const p = ensure();
            if (!p?.drawable) return false;
            showing = true;
            getContainer()?.setAttribute(GESTURE_PROXY_ATTR, '');
            return true;
        },
        frame: (vb) => {
            if (showing) proxy?.draw(vb);
        },
        settle: () => {
            const t = ++token;
            const view = viewOf();
            view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
                if (t !== token) return;
                hideCanvas();
                if (stale) prewarm();
                else continueBuild();
            }));
        },
        hide: () => {
            token++;
            hideCanvas();
            continueBuild();
        },
        invalidate: () => {
            stale = true;
            failedFor = null;
            if (rebuildTimer !== null) clearTimeout(rebuildTimer);
            rebuildTimer = setTimeout(() => {
                rebuildTimer = null;
                prewarm();
            }, REBUILD_DEBOUNCE_MS);
        },
        prewarm,
        dispose: () => {
            token++;
            generation++;
            idleScheduled = false;
            stepScheduled = false;
            failedFor = null;
            if (rebuildTimer !== null) clearTimeout(rebuildTimer);
            rebuildTimer = null;
            showing = false;
            getContainer()?.removeAttribute(GESTURE_PROXY_ATTR);
            proxy?.canvas.remove();
            proxy = null;
            builtFor = null;
            stale = true;
        },
    };
};
