// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { ViewBox } from '../../types';

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
 * width by the zoom scale. Flow values and voltage-level labels are left
 * out, exactly as the default path culls them during a gesture.
 */

type Mat = readonly [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `m × n`: apply `n` first, then `m` (SVG nested coordinate systems). */
const multiply = (m: Mat, n: Mat): Mat => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];

const transformFunction = (name: string, a: number[]): Mat => {
    switch (name) {
        case 'matrix':
            return a.length >= 6 ? [a[0], a[1], a[2], a[3], a[4], a[5]] : IDENTITY;
        case 'translate':
            return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        case 'scale':
            return [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        case 'rotate': {
            const r = ((a[0] ?? 0) * Math.PI) / 180;
            const cos = Math.cos(r), sin = Math.sin(r);
            const rot: Mat = [cos, sin, -sin, cos, 0, 0];
            if (a.length >= 3) {
                return multiply(multiply([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
            }
            return rot;
        }
        case 'skewX':
            return [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        case 'skewY':
            return [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        default:
            return IDENTITY;
    }
};

/** Parse an SVG `transform` attribute into a 2-D affine matrix. */
export const parseTransform = (attr: string | null): Mat => {
    if (!attr) return IDENTITY;
    let m: Mat = IDENTITY;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    for (let match = re.exec(attr); match; match = re.exec(attr)) {
        const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
        if (args.some(v => !Number.isFinite(v))) continue;
        m = multiply(m, transformFunction(match[1], args));
    }
    return m;
};

const apply = (m: Mat, x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
];

const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const num = (el: Element, name: string): number => {
    const v = parseFloat(el.getAttribute(name) ?? '');
    return Number.isFinite(v) ? v : 0;
};

const parsePoints = (attr: string | null): number[] =>
    (attr ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);

const parseDash = (v: string): number[] =>
    !v || v === 'none'
        ? []
        : v.split(/[\s,]+/).map(s => parseFloat(s)).filter(n => Number.isFinite(n) && n > 0);

/**
 * Top-level SVG groups drawn by the proxy, in pypowsybl's paint order (the
 * live SVG's DOM order is kept). Highlight halos live in
 * `#nad-background-layer` (utils/svg/highlights.ts).
 */
const DRAWN_LAYERS = new Set(['nad-vl-nodes', 'nad-branch-edges', 'nad-3wt-edges', 'nad-3wt-nodes', 'nad-injections']);
const DRAWN_TAGS = new Set(['polyline', 'polygon', 'line', 'circle', 'ellipse', 'rect', 'path']);
const GRID = 8;

type BBox = [number, number, number, number];

interface Style {
    fill: string | null;
    fillAlpha: number;
    stroke: string | null;
    strokeAlpha: number;
    /** Stroke width: CSS px when `nonScaling`, else root user units. */
    width: number;
    nonScaling: boolean;
    /**
     * A line halo whose width follows the zoom (`--nad-halo-w`, App.css): its
     * width as a multiple of that var — the contingency halo is wider than
     * the others. 0 for every other stroke.
     */
    zoomWidth: number;
    /** Dash pattern, same units as `width`. */
    dash: number[];
}

interface DrawItem extends Style {
    path: Path2D;
    bbox: BBox;
}

interface Geometry {
    build: (p: Path2D) => void;
    bbox: BBox;
}

/** Element geometry in root user space (`m` = element → root transform). */
const geometryOf = (el: Element, m: Mat): Geometry | null => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'polyline' || tag === 'polygon' || tag === 'line') {
        const raw = tag === 'line'
            ? [num(el, 'x1'), num(el, 'y1'), num(el, 'x2'), num(el, 'y2')]
            : parsePoints(el.getAttribute('points'));
        if (raw.length < 4) return null;
        const pts: number[] = [];
        const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i + 1 < raw.length; i += 2) {
            const [x, y] = apply(m, raw[i], raw[i + 1]);
            pts.push(x, y);
            if (x < bbox[0]) bbox[0] = x;
            if (y < bbox[1]) bbox[1] = y;
            if (x > bbox[2]) bbox[2] = x;
            if (y > bbox[3]) bbox[3] = y;
        }
        const closed = tag === 'polygon';
        return {
            bbox,
            build: (p) => {
                p.moveTo(pts[0], pts[1]);
                for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
                if (closed) p.closePath();
            },
        };
    }
    if (tag === 'circle' || tag === 'ellipse') {
        const [x, y] = apply(m, num(el, 'cx'), num(el, 'cy'));
        const s = scaleOf(m);
        const rx = (tag === 'circle' ? num(el, 'r') : num(el, 'rx')) * s;
        const ry = (tag === 'circle' ? num(el, 'r') : num(el, 'ry')) * s;
        if (!(rx > 0 && ry > 0)) return null;
        return {
            bbox: [x - rx, y - ry, x + rx, y + ry],
            build: (p) => {
                p.moveTo(x + rx, y);
                p.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
            },
        };
    }
    if (tag === 'rect') {
        const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
        if (!(w > 0 && h > 0)) return null;
        const c = [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)];
        return {
            bbox: [Math.min(...c.map(q => q[0])), Math.min(...c.map(q => q[1])), Math.max(...c.map(q => q[0])), Math.max(...c.map(q => q[1]))],
            build: (p) => {
                p.moveTo(c[0][0], c[0][1]);
                for (let i = 1; i < 4; i++) p.lineTo(c[i][0], c[i][1]);
                p.closePath();
            },
        };
    }
    if (tag === 'path') {
        const d = el.getAttribute('d');
        if (!d || typeof DOMMatrix === 'undefined') return null;
        // Bounding box from the coordinate pairs of the path data — exact for
        // the absolute paths pypowsybl emits, a safe culling hint otherwise.
        const raw = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i + 1 < raw.length; i += 2) {
            const [x, y] = apply(m, raw[i], raw[i + 1]);
            if (x < bbox[0]) bbox[0] = x;
            if (y < bbox[1]) bbox[1] = y;
            if (x > bbox[2]) bbox[2] = x;
            if (y > bbox[3]) bbox[3] = y;
        }
        if (!Number.isFinite(bbox[0])) return null;
        const matrix = new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
        return { bbox, build: (p) => p.addPath(new Path2D(d), matrix) };
    }
    return null;
};

// The overload / action / contingency halos: App.css binds their stroke
// width to `--nad-halo-w`, which usePanZoom recomputes from the zoom.
const HALO_GROUPS = '.nad-overloaded, .nad-action-target, .nad-contingency-highlight';
const HALO_SHAPES = new Set(['path', 'line', 'polyline', 'rect', 'polygon']);
/** App.css's fallback for `--nad-halo-w` while usePanZoom has not set it. */
const HALO_DEFAULT_PX = 24;

const haloVarPx = (cs: CSSStyleDeclaration): number => {
    const v = parseFloat(cs.getPropertyValue('--nad-halo-w'));
    return Number.isFinite(v) && v > 0 ? v : HALO_DEFAULT_PX;
};

const resolveStyle = (el: Element, parent: Element | null, scale: number): Style | null => {
    const view = el.ownerDocument.defaultView;
    if (!view) return null;
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
    const groupOpacity = parent ? parseFloat(view.getComputedStyle(parent).opacity || '1') : 1;
    const opacity = parseFloat(cs.opacity || '1') * (Number.isFinite(groupOpacity) ? groupOpacity : 1);
    const nonScaling = cs.getPropertyValue('vector-effect').trim() === 'non-scaling-stroke';
    const w = parseFloat(cs.strokeWidth);
    const stroke = cs.stroke && cs.stroke !== 'none' && w > 0 ? cs.stroke : null;
    const fill = cs.fill && cs.fill !== 'none' ? cs.fill : null;
    if (!stroke && !fill) return null;
    const k = nonScaling ? 1 : scale;
    const halo = !!stroke && nonScaling && HALO_SHAPES.has(el.tagName.toLowerCase()) && !!parent?.closest(HALO_GROUPS);
    return {
        fill,
        fillAlpha: opacity * parseFloat(cs.fillOpacity || '1'),
        stroke,
        strokeAlpha: opacity * parseFloat(cs.strokeOpacity || '1'),
        width: stroke ? w * k : 0,
        nonScaling,
        zoomWidth: halo ? w / haloVarPx(cs) : 0,
        dash: stroke ? parseDash(cs.strokeDasharray).map(v => v * k) : [],
    };
};

export interface CanvasProxy {
    readonly canvas: HTMLCanvasElement;
    /** False when the browser gave no 2D context: the proxy cannot draw. */
    readonly drawable: boolean;
    /** Draw the stand-in for `vb` (opaque), with the live SVG's `xMidYMid meet` mapping. */
    draw: (vb: ViewBox) => void;
    /** Clear to transparent: the live SVG shows through. */
    clear: () => void;
    /** Size the canvas to the panel and bake the overview cache for it (no-op when both match). */
    prepare: () => void;
    /** Number of grouped draw items (diagnostics and tests). */
    readonly itemCount: number;
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
}

/** Overview-cache pixel budget (2× a typical panel at dpr 1 is ~5 MP). */
const CACHE_MAX_PIXELS = 8e6;
/** Blit the cache while it is at least this much denser than the screen. */
const CACHE_MAX_MAGNIFICATION = 0.65;

/**
 * Build the proxy for a live NAD. `extent` is the diagram's full-extent
 * viewBox (the grid of culling cells covers it); falls back to the live
 * viewBox. Reads the live SVG only — it is never modified.
 */
export const buildCanvasProxy = (
    live: SVGSVGElement,
    container: HTMLElement,
    extent: ViewBox | null,
    options: CanvasProxyOptions = {},
): CanvasProxy => {
    const doc = container.ownerDocument;
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

    // Element → root transform and inline-visibility, memoised per ancestor.
    const matrices = new Map<Element, Mat>();
    const matrixOf = (el: Element): Mat => {
        if (el === live) return IDENTITY;
        const hit = matrices.get(el);
        if (hit) return hit;
        const parent = el.parentElement;
        const m = multiply(parent ? matrixOf(parent) : IDENTITY, parseTransform(el.getAttribute('transform')));
        matrices.set(el, m);
        return m;
    };
    // The voltage filter (useDiagrams) hides elements with inline styles;
    // highlight clones re-assert `visibility: visible` inline.
    const displayNone = new Map<Element, boolean>();
    const isDisplayNone = (el: Element | null): boolean => {
        if (!el || el === live) return false;
        let v = displayNone.get(el);
        if (v === undefined) {
            v = (el as SVGElement).style?.display === 'none' || isDisplayNone(el.parentElement);
            displayNone.set(el, v);
        }
        return v;
    };
    const visibilityHidden = new Map<Element, boolean>();
    const isVisibilityHidden = (el: Element | null): boolean => {
        if (!el || el === live) return false;
        let v = visibilityHidden.get(el);
        if (v === undefined) {
            const own = (el as SVGElement).style?.visibility;
            v = own === 'hidden' || own === 'collapse' ? true
                : own === 'visible' ? false
                    : isVisibilityHidden(el.parentElement);
            visibilityHidden.set(el, v);
        }
        return v;
    };
    const inlineHidden = (el: Element): boolean => isDisplayNone(el) || isVisibilityHidden(el);

    const styles = new Map<string, Style | null>();
    const groups = new Map<string, DrawItem>();
    const layers: Element[] = [];
    for (const child of Array.from(live.children)) {
        if (child.id === 'nad-background-layer') { layers.push(child); continue; }
        const cls = child.getAttribute('class') ?? '';
        if (cls.split(/\s+/).some(c => DRAWN_LAYERS.has(c))) layers.push(child);
    }
    layers.forEach((layer, li) => {
        for (const el of Array.from(layer.querySelectorAll('*'))) {
            const tag = el.tagName.toLowerCase();
            if (!DRAWN_TAGS.has(tag) || inlineHidden(el)) continue;
            const parent = el.parentElement;
            const m = matrixOf(el);
            const scale = scaleOf(m);
            const styleKey = [
                li, tag, el.getAttribute('class'), el.getAttribute('style'),
                parent?.getAttribute('class'), parent?.getAttribute('style'), scale.toPrecision(3),
            ].join('|');
            let style = styles.get(styleKey);
            if (style === undefined) {
                style = resolveStyle(el, parent, scale);
                styles.set(styleKey, style);
            }
            if (!style) continue;
            const geom = geometryOf(el, m);
            if (!geom) continue;
            const key = `${styleKey}#${cellOf(geom.bbox)}`;
            let item = groups.get(key);
            if (!item) {
                item = { ...style, path: new Path2D(), bbox: [Infinity, Infinity, -Infinity, -Infinity] };
                groups.set(key, item);
            }
            geom.build(item.path);
            const b = item.bbox;
            if (geom.bbox[0] < b[0]) b[0] = geom.bbox[0];
            if (geom.bbox[1] < b[1]) b[1] = geom.bbox[1];
            if (geom.bbox[2] > b[2]) b[2] = geom.bbox[2];
            if (geom.bbox[3] > b[3]) b[3] = geom.bbox[3];
        }
    });
    const items = [...groups.values()];

    const view = doc.defaultView ?? window;
    const opaque = (c: string | undefined) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
    const containerBg = view.getComputedStyle(container).backgroundColor;
    const bodyBg = doc.body ? view.getComputedStyle(doc.body).backgroundColor : undefined;
    // Frames paint this first so they fully cover the live SVG; between
    // gestures the canvas is cleared to transparent instead.
    const background = opaque(containerBg) ? containerBg : opaque(bodyBg) ? (bodyBg as string) : 'white';
    const canvas = doc.createElement('canvas');
    canvas.className = 'nad-canvas-proxy';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');

    // `scale` maps root user units to device pixels. A non-scaling stroke of
    // `w` CSS px is `w * widthMul / scale` user units: `widthMul` is the dpr
    // for on-screen frames, and the cache-to-screen ratio for the cache.
    const renderItems = (c: CanvasRenderingContext2D, scale: number, ox: number, oy: number, cull: BBox | null, widthMul: number, haloPx: number | null) => {
        c.setTransform(scale, 0, 0, scale, ox, oy);
        // SVG defaults: pypowsybl sets no caps / joins on the edges.
        c.lineCap = 'butt';
        c.lineJoin = 'miter';
        for (const it of items) {
            const b = it.bbox;
            if (cull && (b[2] < cull[0] || b[0] > cull[2] || b[3] < cull[1] || b[1] > cull[3])) continue;
            if (it.fill) {
                c.globalAlpha = it.fillAlpha;
                c.fillStyle = it.fill;
                c.fill(it.path);
            }
            if (it.stroke) {
                const k = it.nonScaling ? widthMul / scale : 1;
                c.globalAlpha = it.strokeAlpha;
                c.strokeStyle = it.stroke;
                c.lineWidth = (it.zoomWidth && haloPx != null ? haloPx * it.zoomWidth : it.width) * k;
                c.setLineDash(it.dash.length ? it.dash.map(d => d * k) : []);
                c.stroke(it.path);
            }
        }
        c.globalAlpha = 1;
    };

    let cache: HTMLCanvasElement | null = null;
    // Panel size the cache was baked for: its stroke widths are exact only there.
    let cacheFor = '';
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
        // bake non-scaling strokes at their full-extent on-screen width.
        const fullScale = dpr * Math.min(W / ext.w, H / ext.h);
        renderItems(cc, cacheScale, cacheOx, cacheOy, null, (dpr * cacheScale) / fullScale, options.haloWidth?.(ext) ?? null);
        cache = c;
        cacheFor = sizeKey(W, H, dpr);
    };

    // Resizing the canvas restyles it (a relayout + re-layerization of the
    // page): done by prepare() on idle, so a gesture normally finds it sized.
    const fit = (W: number, H: number, dpr: number) => {
        const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
        if (canvas.width === pw && canvas.height === ph) return;
        canvas.width = pw;
        canvas.height = ph;
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
    };

    const prepare = () => {
        const W = container.clientWidth, H = container.clientHeight;
        const dpr = view.devicePixelRatio || 1;
        if (!(W > 0 && H > 0)) return;
        fit(W, H, dpr);
        if (options.overviewCache === false || cacheFor === sizeKey(W, H, dpr)) return;
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
        const W = container.clientWidth, H = container.clientHeight;
        if (!(W > 0 && H > 0 && vb.w > 0 && vb.h > 0)) return;
        fit(W, H, dpr);
        const pw = canvas.width, ph = canvas.height;
        // preserveAspectRatio="xMidYMid meet", exactly as the live SVG maps it.
        const a = Math.min(W / vb.w, H / vb.h);
        const cx = (W - a * vb.w) / 2 - a * vb.x;
        const cy = (H - a * vb.h) / 2 - a * vb.y;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, pw, ph);
        // A cache baked for another panel size waits for the next idle
        // prepare() (never re-baked mid-gesture); vectors are exact meanwhile.
        if (cache && cacheFor === sizeKey(W, H, dpr) && (dpr * a) / cacheScale <= CACHE_MAX_MAGNIFICATION) {
            const k = (dpr * a) / cacheScale;
            ctx.setTransform(k, 0, 0, k, dpr * cx - k * cacheOx, dpr * cy - k * cacheOy);
            ctx.drawImage(cache, 0, 0);
            return;
        }
        renderItems(ctx, dpr * a, dpr * cx, dpr * cy, [-cx / a, -cy / a, (W - cx) / a, (H - cy) / a], dpr, options.haloWidth?.(vb) ?? null);
    };

    return { canvas, drawable: !!ctx, draw, clear, prepare, itemCount: items.length };
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
}

export const createCanvasProxyController = ({ getLiveSvg, getContainer, getExtent, haloWidth }: ControllerDeps): CanvasProxyController => {
    let proxy: CanvasProxy | null = null;
    let builtFor: SVGSVGElement | null = null;
    let stale = true;
    let showing = false;
    let token = 0;
    let idleScheduled = false;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    // A build that threw is not retried for the same diagram until it changes.
    let failedFor: SVGSVGElement | null = null;
    // Bumped by dispose() so an idle build scheduled before it is dropped.
    let generation = 0;

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
        let next: CanvasProxy;
        try {
            next = buildCanvasProxy(live, container, getExtent(), { haloWidth });
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
        return proxy;
    };

    const prewarm = () => {
        if (idleScheduled) return;
        const container = getContainer();
        const view = container?.ownerDocument.defaultView ?? window;
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
            const view = getContainer()?.ownerDocument.defaultView ?? window;
            view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
                if (t !== token) return;
                hideCanvas();
                if (stale) prewarm();
            }));
        },
        hide: () => {
            token++;
            hideCanvas();
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
