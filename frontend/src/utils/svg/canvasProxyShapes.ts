// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * Shapes for the canvas gesture proxy (canvasProxy.ts): SVG transforms, the
 * geometry of the elements pypowsybl's NAD is made of in root user space, and
 * their stroke / fill styles resolved from the live diagram's computed styles.
 */

export type Mat = readonly [number, number, number, number, number, number];
export type BBox = [number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `m × n`: apply `n` first, then `m` (SVG nested coordinate systems). */
export const multiply = (m: Mat, n: Mat): Mat => [
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

export const apply = (m: Mat, x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
];

export const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export const isIdentity = (m: Mat): boolean =>
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

export const num = (el: Element, name: string): number => {
    const v = parseFloat(el.getAttribute(name) ?? '');
    return Number.isFinite(v) ? v : 0;
};

export const emptyBox = (): BBox => [Infinity, Infinity, -Infinity, -Infinity];

export const grow = (b: BBox, g: BBox): void => {
    if (g[0] < b[0]) b[0] = g[0];
    if (g[1] < b[1]) b[1] = g[1];
    if (g[2] > b[2]) b[2] = g[2];
    if (g[3] > b[3]) b[3] = g[3];
};

export const outside = (b: BBox, cull: BBox): boolean =>
    b[2] < cull[0] || b[0] > cull[2] || b[3] < cull[1] || b[1] > cull[3];

const parsePoints = (attr: string | null): number[] =>
    (attr ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);

const parseDash = (v: string): number[] =>
    !v || v === 'none'
        ? []
        : v.split(/[\s,]+/).map(s => parseFloat(s)).filter(n => Number.isFinite(n) && n > 0);

export interface Geometry {
    /** Append the shape to `p`; `close` only matters for a stroke (a fill closes its sub-paths). */
    build: (p: Path2D, close: boolean) => void;
    bbox: BBox;
}

export type SubPath = { pts: number[]; closed: boolean };

/**
 * Sub-paths of a path made of straight segments only (M L H V Z, absolute or
 * relative) — pypowsybl's flow arrows — or null for anything else. Built
 * straight into the group's Path2D: far cheaper than an `addPath` per
 * element for the ~16k arrows of the European grid.
 */
export const straightPath = (d: string): SubPath[] | null => {
    const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
    if (!tokens) return null;
    const subs: SubPath[] = [];
    let cur: SubPath | null = null;
    let cmd = '', x = 0, y = 0, sx = 0, sy = 0;
    for (let i = 0; i < tokens.length;) {
        const t = tokens[i];
        if (/[a-zA-Z]/.test(t)) {
            cmd = t;
            i++;
            if (cmd === 'Z' || cmd === 'z') {
                if (cur) cur.closed = true;
                cur = null;
                x = sx;
                y = sy;
            } else if (!'MmLlHhVv'.includes(cmd)) {
                return null;
            }
            continue;
        }
        const rel = cmd === cmd.toLowerCase();
        const n = (k: number) => Number(tokens[i + k]);
        if (cmd === 'M' || cmd === 'm' || cmd === 'L' || cmd === 'l') {
            if (i + 1 >= tokens.length) return null;
            x = (rel ? x : 0) + n(0);
            y = (rel ? y : 0) + n(1);
            i += 2;
            if (cmd === 'M' || cmd === 'm') {
                cur = { pts: [x, y], closed: false };
                subs.push(cur);
                sx = x;
                sy = y;
                cmd = cmd === 'M' ? 'L' : 'l'; // further pairs are line-tos
                continue;
            }
        } else if (cmd === 'H' || cmd === 'h') {
            x = (rel ? x : 0) + n(0);
            i += 1;
        } else if (cmd === 'V' || cmd === 'v') {
            y = (rel ? y : 0) + n(0);
            i += 1;
        } else {
            return null;
        }
        if (!cur) {
            cur = { pts: [sx, sy], closed: false };
            subs.push(cur);
        }
        cur.pts.push(x, y);
    }
    return subs.every(s => s.pts.every(Number.isFinite)) ? subs : null;
};

const boxOf = (pts: number[]): BBox => {
    const b = emptyBox();
    for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
    }
    return b;
};

const polyGeometry = (subs: SubPath[]): Geometry | null => {
    const bbox = emptyBox();
    for (const s of subs) grow(bbox, boxOf(s.pts));
    if (!Number.isFinite(bbox[0])) return null;
    return {
        bbox,
        build: (p, close) => {
            for (const s of subs) {
                p.moveTo(s.pts[0], s.pts[1]);
                for (let i = 2; i < s.pts.length; i += 2) p.lineTo(s.pts[i], s.pts[i + 1]);
                if (s.closed && close) p.closePath();
            }
        },
    };
};

const mapPoints = (m: Mat, raw: number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
        out.push(m[0] * raw[i] + m[2] * raw[i + 1] + m[4], m[1] * raw[i] + m[3] * raw[i + 1] + m[5]);
    }
    return out;
};

/**
 * Element geometry in root user space (`m` = element → root transform).
 * `paths` memoises `straightPath` per `d` (the arrows share a handful).
 */
export const geometryOf = (el: Element, m: Mat, paths?: Map<string, SubPath[] | null>): Geometry | null => {
    const tag = el.localName;
    if (tag === 'polyline' || tag === 'polygon' || tag === 'line') {
        const raw = tag === 'line'
            ? [num(el, 'x1'), num(el, 'y1'), num(el, 'x2'), num(el, 'y2')]
            : parsePoints(el.getAttribute('points'));
        if (raw.length < 4) return null;
        return polyGeometry([{ pts: mapPoints(m, raw), closed: tag === 'polygon' }]);
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
        return polyGeometry([{ pts: mapPoints(m, [x, y, x + w, y, x + w, y + h, x, y + h]), closed: true }]);
    }
    if (tag === 'path') {
        const d = el.getAttribute('d');
        if (!d) return null;
        let straight = paths?.get(d);
        if (straight === undefined) {
            straight = straightPath(d);
            paths?.set(d, straight);
        }
        if (straight) return polyGeometry(straight.map(s => ({ pts: mapPoints(m, s.pts), closed: s.closed })));
        if (typeof DOMMatrix === 'undefined') return null;
        // Bounding box from the coordinate pairs of the path data — exact for
        // the absolute paths pypowsybl emits, a safe culling hint otherwise.
        const raw = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        const bbox = boxOf(mapPoints(m, raw));
        if (!Number.isFinite(bbox[0])) return null;
        const matrix = new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]);
        return { bbox, build: (p) => p.addPath(new Path2D(d), matrix) };
    }
    return null;
};

export interface Style {
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

export const resolveStyle = (el: Element, parent: Element | null, scale: number): Style | null => {
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
    const halo = !!stroke && nonScaling && HALO_SHAPES.has(el.localName) && !!parent?.closest(HALO_GROUPS);
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
