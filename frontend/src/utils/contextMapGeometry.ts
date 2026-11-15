// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * Geometry of the Context tab — Carte-Front's matplotlib grammar, in SVG.
 *
 * Carte-Front draws on a 9.2 × 9.6 in figure whose map axes are ~649 pt
 * wide; every symbol is sized in POINTS on that figure. Here the map is an
 * SVG in its own (projected-degree) user space, so one point is
 * `ptUnit(bounds)` user units: symbols then keep Carte-Front's proportions
 * to the map, and scale with it when the operator zooms.
 *
 * Pure functions, no React — unit-tested in `contextMapGeometry.test.ts`.
 */

import type { ContextFiliere, ContextMapData, ContextMapHighlight } from '../types';

/** Side of the drawing, in render units: fonts stay well above 1 unit. */
export const RENDER_SIZE = 1000;

/** Render units per payload unit (the payload frame is in degrees). */
export const renderScale = (bounds: readonly number[]): number =>
    RENDER_SIZE / Math.max(bounds[2], bounds[3]);

/** Width of Carte-Front's map axes, in points. */
export const FIGURE_WIDTH_PT = 649;

/** Pie sizing (Carte-Front `_PROD_REF_MW`, `_PIE_DMAX_IN`, `_PIE_DMIN_IN`). */
export const PROD_REF_MW = 19000;
const PIE_DMAX_IN = 1.5;
const PIE_DMIN_IN = 0.5;
/** Gap between a pie edge and the arrow that stops at it (pt). */
export const PIE_GAP_PT = 6;
/** Symbol scale of a dense map (many zones): their pies would overlap. */
export const DENSE_SCALE = 0.6;
export const DENSE_ZONE_COUNT = 12;

/** Arrow widths (Carte-Front `_WIDTH_MIN`, `_WIDTH_MAX`, pt). */
const WIDTH_MIN_PT = 1.4;
const WIDTH_MAX_PT = 8.5;

export type Point = [number, number];

/** User-space units per Carte-Front point, for a view `[x, y, w, h]`. */
export const ptUnit = (bounds: readonly number[]): number =>
    Math.max(bounds[2], bounds[3]) / FIGURE_WIDTH_PT;

/** Pie radius (pt), area ∝ MW, clipped (Carte-Front `_volume_radius_points`). */
export const volumeRadiusPt = (mw: number, refMw = PROD_REF_MW, scale = 1): number => {
    const frac = Math.min(Math.max(mw, 0) / refMw, 1);
    const diameterIn = Math.min(Math.max(PIE_DMAX_IN * Math.sqrt(frac), PIE_DMIN_IN), PIE_DMAX_IN);
    return (diameterIn / 2) * 72 * scale;
};

/** Arrow width (pt) ∝ √(|value| / vmax) (Carte-Front `_scaled_width`). */
export const arrowWidthPt = (value: number, vmax: number): number => {
    if (vmax <= 0) return WIDTH_MIN_PT;
    const frac = Math.min(Math.abs(value) / vmax, 1);
    return WIDTH_MIN_PT + (WIDTH_MAX_PT - WIDTH_MIN_PT) * Math.sqrt(frac);
};

/**
 * Control point of matplotlib's `arc3,rad=…` connection, in SVG space
 * (y downward — the formula is matplotlib's with the y axis flipped, so a
 * positive rad bends the arrow to the same visual side).
 */
export const arcControl = (p0: Point, p1: Point, rad: number): Point => {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    return [(p0[0] + p1[0]) / 2 - rad * dy, (p0[1] + p1[1]) / 2 + rad * dx];
};

const quad = (p0: Point, c: Point, p1: Point, t: number): Point => {
    const u = 1 - t;
    return [
        u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
        u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
    ];
};

const ARC_SAMPLES = 48;

/**
 * An `arc3` curve from `p0` to `p1`, trimmed by `shrinkStart` / `shrinkEnd`
 * (user units, along the curve) — how matplotlib's `shrinkA` / `shrinkB`
 * stop an arrow at the edge of a pie. Returns the polyline, or null when
 * the trims eat the whole curve.
 */
export const trimmedArc = (
    p0: Point, p1: Point, rad: number, shrinkStart: number, shrinkEnd: number,
): Point[] | null => {
    const c = arcControl(p0, p1, rad);
    const pts: Point[] = [];
    const cum: number[] = [0];
    for (let i = 0; i <= ARC_SAMPLES; i++) {
        pts.push(quad(p0, c, p1, i / ARC_SAMPLES));
        if (i > 0) {
            const [ax, ay] = pts[i - 1];
            const [bx, by] = pts[i];
            cum.push(cum[i - 1] + Math.hypot(bx - ax, by - ay));
        }
    }
    const total = cum[ARC_SAMPLES];
    if (total <= shrinkStart + shrinkEnd) return null;
    const at = (len: number): Point => {
        let i = 1;
        while (i < ARC_SAMPLES && cum[i] < len) i++;
        const span = cum[i] - cum[i - 1] || 1;
        const t = (len - cum[i - 1]) / span;
        return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
    };
    const start = shrinkStart;
    const end = total - shrinkEnd;
    const out: Point[] = [at(start)];
    for (let i = 1; i < ARC_SAMPLES; i++) {
        if (cum[i] > start && cum[i] < end) out.push(pts[i]);
    }
    out.push(at(end));
    return out;
};

/**
 * Split a polyline into its shaft and a `-|>` arrow head of the given
 * length / half-width: the shaft stops at the head's base, as matplotlib
 * draws it. Returns the head triangle's three points.
 */
export const arrowHead = (
    line: Point[], headLength: number, headHalfWidth: number,
): { shaft: Point[]; head: [Point, Point, Point] } => {
    const tip = line[line.length - 1];
    // Walk back along the line to the head's base.
    let remaining = headLength;
    let i = line.length - 1;
    let base: Point = line[0];
    while (i > 0) {
        const [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        const seg = Math.hypot(bx - ax, by - ay);
        if (seg >= remaining) {
            const t = seg > 0 ? remaining / seg : 0;
            base = [bx - t * (bx - ax), by - t * (by - ay)];
            break;
        }
        remaining -= seg;
        i--;
    }
    const dx = tip[0] - base[0];
    const dy = tip[1] - base[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const shaft = [...line.slice(0, Math.max(i, 1)), base];
    return {
        shaft,
        head: [tip, [base[0] + nx * headHalfWidth, base[1] + ny * headHalfWidth],
            [base[0] - nx * headHalfWidth, base[1] - ny * headHalfWidth]],
    };
};

/** The point halfway along a polyline (by length). */
export const polylineMidpoint = (pts: Point[]): Point => {
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    let remaining = lengths.reduce((s, l) => s + l, 0) / 2;
    for (let i = 0; i < lengths.length; i++) {
        if (remaining <= lengths[i]) {
            const t = lengths[i] > 0 ? remaining / lengths[i] : 0;
            return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
        }
        remaining -= lengths[i];
    }
    return pts[pts.length - 1];
};

/** SVG path `d` of a polyline. */
export const polylinePath = (pts: Point[]): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('');

/** SVG path `d` of a closed ring. */
export const ringPath = (ring: readonly (readonly number[])[]): string =>
    `${ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join('')}Z`;

/**
 * Pie slices, Carte-Front style: from the top (startangle=90), clockwise
 * (counterclock=False). Values ≤ 0 are skipped. A single slice is a full
 * circle (returned with `full: true`, drawn as a <circle>).
 */
export const pieSlices = <K extends string>(
    cx: number, cy: number, r: number, parts: readonly (readonly [K, number])[],
): { key: K; d: string; full: boolean }[] => {
    const positive = parts.filter(([, v]) => v > 0);
    const total = positive.reduce((s, [, v]) => s + v, 0);
    if (total <= 0) return [];
    if (positive.length === 1) return [{ key: positive[0][0], d: '', full: true }];
    const pointAt = (angle: number): Point => [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
    let angle = 0;
    return positive.map(([key, v]) => {
        const sweep = (v / total) * 2 * Math.PI;
        const [x0, y0] = pointAt(angle);
        const [x1, y1] = pointAt(angle + sweep);
        angle += sweep;
        const large = sweep > Math.PI ? 1 : 0;
        return { key, d: `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}Z`, full: false };
    });
};

/** Render-unit points of a highlight: its voltage levels, else its zones. */
export const highlightPoints = (h: ContextMapHighlight, k: number): Point[] => {
    const pts = h.element.points ?? h.element.zone_points.filter((p): p is [number, number] => !!p);
    return pts.map(([x, y]) => [x * k, y * k] as Point);
};

/**
 * Box (render units) around every highlighted element, or null — what the
 * view zooms to, and what the attention ring circles at national scale
 * (a 30 km line is a few pixels wide on the France frame).
 */
export const highlightBox = (data: ContextMapData, highlights: readonly ContextMapHighlight[]) => {
    const k = renderScale(data.bounds);
    const pts = highlights.flatMap(h => highlightPoints(h, k));
    if (pts.length === 0) return null;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

/** A line pulled apart from the ones drawn over it. */
export interface SeparatedLine {
    points: Point[];
    /** Unit normal towards the side the line moved to; null when it kept the
     *  shared axis (or had nothing to share it with). */
    side: Point | null;
}

/** Slots across a corridor, the middle one first, then alternately outwards. */
const centreOut = (n: number, gap: number): number[] =>
    Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * gap)
        .map((o, k) => ({ o, k }))
        .sort((a, b) => Math.abs(a.o) - Math.abs(b.o) || a.k - b.k)
        .map(({ o }) => o);

/**
 * Segments drawn over each other — a contingency and the overload it causes
 * on a twin circuit, or parallel overloaded circuits — pulled apart into a
 * lens: each leaves the shared ends, runs `gap` from its neighbours and comes
 * back, so every one stays visible. Two segments coincide when both their
 * ends lie within `tolerance` of each other (either way round). In a group the
 * first-listed segment takes the middle slot, so list what must stay central
 * first. Shapes other than two-point segments pass through unchanged.
 */
export const separateCoincident = (
    lines: readonly (Point[] | null)[], tolerance: number, gap: number,
): (SeparatedLine | null)[] => {
    const near = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
    const groups: { ends: [Point, Point]; members: number[] }[] = [];
    lines.forEach((pts, i) => {
        if (!pts || pts.length !== 2) return;
        const [a, b] = pts;
        const group = groups.find(({ ends: [p, q] }) => (near(a, p) && near(b, q)) || (near(a, q) && near(b, p)));
        if (group) group.members.push(i);
        else groups.push({ ends: [a, b], members: [i] });
    });
    const out: (SeparatedLine | null)[] = lines.map(pts => (pts && pts.length >= 2 ? { points: pts, side: null } : null));
    for (const { ends: [p, q], members } of groups) {
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (members.length < 2 || len === 0) continue;
        const u: Point = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
        const n: Point = [-u[1], u[0]];
        const taper = Math.min(len * 0.3, gap * 2);
        const slots = centreOut(members.length, gap);
        members.forEach((i, slot) => {
            const [a, b] = lines[i]!;
            const reversed = !(near(a, p) && near(b, q));
            const [start, end] = reversed ? [b, a] : [a, b];
            const o = slots[slot];
            const lens: Point[] = [
                start,
                [start[0] + u[0] * taper + n[0] * o, start[1] + u[1] * taper + n[1] * o],
                [end[0] - u[0] * taper + n[0] * o, end[1] - u[1] * taper + n[1] * o],
                end,
            ];
            out[i] = {
                points: reversed ? lens.reverse() : lens,
                side: o === 0 ? null : [n[0] * Math.sign(o), n[1] * Math.sign(o)],
            };
        });
    }
    return out;
};

/**
 * Production by type summed over the zones drawn as pies — the regions
 * (or countries), not the neighbour badges — largest first: the national
 * mix of the situation card.
 */
export const productionMix = (data: ContextMapData): { filiere: ContextFiliere; mw: number }[] => {
    const totals = new Map<ContextFiliere, number>();
    for (const zone of data.zones) {
        if (zone.kind === 'neighbor') continue;
        for (const f of Object.keys(zone.production) as ContextFiliere[]) {
            totals.set(f, (totals.get(f) ?? 0) + (zone.production[f] ?? 0));
        }
    }
    return [...totals].filter(([, mw]) => mw > 0)
        .map(([filiere, mw]) => ({ filiere, mw }))
        .sort((a, b) => b.mw - a.mw);
};

const hexRgb = (hex: string): [number, number, number] =>
    [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/**
 * Colour of a nuclear unit at `level` (P / Pmax, 0–1) on Carte-Front's
 * three-stop ramp (`NUCLEAR_CMAP`), as an `rgb()` string.
 */
export const rampColor = (stops: readonly [string, string, string], level: number): string => {
    const t = Math.min(Math.max(level, 0), 1) * 2;
    const [a, b] = t <= 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
    const f = t <= 1 ? t : t - 1;
    const [ra, ga, ba] = hexRgb(a);
    const [rb, gb, bb] = hexRgb(b);
    return `rgb(${Math.round(ra + (rb - ra) * f)}, ${Math.round(ga + (gb - ga) * f)}, ${Math.round(ba + (bb - ba) * f)})`;
};

/** "12 345 MW" with a thin no-break space (Carte-Front `milliers`). */
export const formatMw = (mw: number): string =>
    `${Math.round(Math.abs(mw)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} MW`;
