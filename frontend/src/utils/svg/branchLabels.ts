// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/**
 * Screen-space branch labels of the NAD tabs (components/BranchLabelLayer.tsx).
 * pypowsybl writes each flow value in user units beside its arrow, so on a
 * large grid they are specks until the operator zooms far in. This module
 * reads each branch's geometry once per mounted diagram, turns the current
 * view (Flows / Impacts × MW / Loading %) into label texts, and places them
 * in CSS px for the current viewBox: one label at the middle of a branch that
 * is short on screen (its larger end), one per end once it is long enough,
 * the coloured (non-grey) branches first, none over another.
 */

import type { DiagramData, FlowDelta, FlowMetric, MetadataIndex, ViewMode } from '../../types';
import { getIdMap } from './idMap';
import { formatLoading, formatLoadingDelta, loadingClass, maxLoading } from './loadingVisuals';

export type Point = [number, number];

/** A branch as drawn, read once per mounted diagram (root user units). */
export interface BranchGeometry {
    id: string;
    /** The branch polyline, end 1 → end 2. */
    path: Point[];
    mid: Point;
    /** pypowsybl's flow arrows, where it writes each end's value; null where it draws none (an open branch). */
    anchors: [Point | null, Point | null];
    /** Half the size of those arrows, user units. */
    arrow: number;
    /** Active power at each end, MW, as pypowsybl prints it. */
    mw: [number | null, number | null];
    /** The colour pypowsybl draws each half in — its voltage (a transformer's two differ). */
    inks: [string | null, string | null];
    /** The voltage-level nodes (svg ids) at each end. */
    nodes: [string, string];
}

/** What a branch's label says in the current view. */
export interface LabelItem {
    geom: BranchGeometry;
    /** At each end (null: no label there); `mid` once for the branch, its larger end. */
    ends: [string | null, string | null];
    mid: string;
    /** Colour modifier (`branch-label--<tone>` in App.css). */
    tone: string;
    /** A coloured branch (loaded from 50 %, a significant change): labelled first, whatever its length. */
    important: boolean;
    /** Order among the labels of the same importance. */
    weight: number;
    /** Text colour at each end and at the middle (MW Flows: the voltage's), null for the tone's own. */
    inks: [string | null, string | null];
    midInk: string | null;
}

export interface PlacedLabel {
    key: string;
    id: string;
    /** Centre, CSS px from the layer's top-left corner. */
    x: number;
    y: number;
    w: number;
    text: string;
    tone: string;
    important: boolean;
    /** Text and outline colour, null for the tone's own. */
    ink: string | null;
}

export const LABEL_HEIGHT_PX = 16;
/** A branch at least this long on screen carries a label at each end, otherwise one at its middle. */
export const ENDS_MIN_PX = 180;
/** A grey branch (or any, in MW) is labelled once this long on screen: the coloured ones always are. */
export const PLAIN_MIN_PX = 90;
const MAX_LABELS = 1500;
const LABEL_GAP_PX = 3;
const CELL_PX = 48;

const VOLTAGE_CLASS_RE = /^nad-vl\d+to\d+$/;
const TRANSLATE_RE = /translate\(\s*([-0-9.eE+]+)[\s,]+([-0-9.eE+]+)\s*\)/;
const SCALE_RE = /scale\(\s*([-0-9.eE+]+)/;
/** pypowsybl's flow arrow: `M-10 10 H10 L0 -10z`. */
const ARROW_HALF_UNITS = 10;

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const parsePoints = (raw: string | null): Point[] => {
    const pts: Point[] = [];
    for (const tok of (raw ?? '').trim().split(/\s+/)) {
        const [x, y] = tok.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
    return pts;
};

/** The point at `t` (0–1) of a polyline's length. */
const pointAlong = (pts: Point[], t: number): Point => {
    const total = pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);
    let left = total * t;
    for (let i = 1; i < pts.length; i++) {
        const d = dist(pts[i - 1], pts[i]);
        if (left <= d && d > 0) {
            const f = left / d;
            return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
        }
        left -= d;
    }
    return pts[pts.length - 1];
};

/** The value pypowsybl printed in an edge info, whatever a view wrote over it since. */
const printedValue = (info: Element | undefined): number | null => {
    const t = info?.querySelector('text, foreignObject');
    if (!t) return null;
    const v = parseFloat(t.getAttribute('data-original-text') ?? t.textContent ?? '');
    return Number.isFinite(v) ? v : null;
};

/**
 * Every branch of the mounted NAD: its polyline (pypowsybl draws each half
 * from its node to the middle), its middle, its flow arrows and the MW they
 * read. Read once per diagram — positions do not change with the view.
 */
export const readBranchGeometry = (container: HTMLElement, metaIndex: MetadataIndex): BranchGeometry[] => {
    const idMap = getIdMap(container);
    const out: BranchGeometry[] = [];
    // pypowsybl colours each half by its voltage class (`nad-vl300to500`…):
    // one computed-style read per class, not per branch.
    const view = container.ownerDocument.defaultView;
    const inkOfClass = new Map<string, string | null>();
    const inkOf = (half: Element | undefined): string | null => {
        const cls = half ? Array.from(half.classList).find(c => VOLTAGE_CLASS_RE.test(c)) : undefined;
        if (!half || !cls || !view) return null;
        let ink = inkOfClass.get(cls);
        if (ink === undefined) {
            ink = view.getComputedStyle(half).getPropertyValue('--nad-vl-color').trim() || null;
            inkOfClass.set(cls, ink);
        }
        return ink;
    };
    for (const [id, edge] of metaIndex.edgesByEquipmentId) {
        const g = edge.svgId ? idMap.get(edge.svgId) : undefined;
        if (!g) continue;
        let lines = Array.from(g.querySelectorAll('polyline.nad-edge-path'));
        if (!lines.length) lines = Array.from(g.querySelectorAll('polyline'));
        const halves = lines.map(pl => parsePoints(pl.getAttribute('points'))).filter(p => p.length >= 2);
        if (!halves.length) continue;
        const [a, b] = halves;
        let path: Point[];
        let mid: Point;
        if (b) {
            const aMid = a[a.length - 1];
            const bFromMid = dist(aMid, b[0]) < dist(aMid, b[b.length - 1]) ? b : [...b].reverse();
            path = [...a, ...bFromMid];
            // Between the two halves: the transformer's windings sit there.
            mid = [(aMid[0] + bFromMid[0][0]) / 2, (aMid[1] + bFromMid[0][1]) / 2];
        } else {
            path = a;
            mid = pointAlong(a, 0.5);
        }
        const info1 = edge.edgeInfo1?.svgId ? idMap.get(edge.edgeInfo1.svgId) : undefined;
        const info2 = edge.edgeInfo2?.svgId ? idMap.get(edge.edgeInfo2.svgId) : undefined;
        const anchor = (info: Element | undefined): Point | null => {
            const m = TRANSLATE_RE.exec(info?.getAttribute('transform') ?? '');
            return m ? [Number(m[1]), Number(m[2])] : null;
        };
        const scale = Number(SCALE_RE.exec(info1?.getAttribute('transform') ?? '')?.[1] ?? 1);
        out.push({
            id, path, mid,
            anchors: [anchor(info1), anchor(info2)],
            arrow: ARROW_HALF_UNITS * (Number.isFinite(scale) ? scale : 1),
            mw: [printedValue(info1), printedValue(info2)],
            inks: [inkOf(lines[0]), inkOf(lines[1] ?? lines[0])],
            nodes: [edge.node1, edge.node2],
        });
    }
    return out;
};

const formatMw = (v: number | null): string | null => (v === null ? null : `${Math.round(v)}`);
const formatFlowDelta = (delta: number): string => `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;

const deltaItem = (geom: BranchGeometry, d: FlowDelta, format: (v: number) => string): LabelItem => {
    const text = format(d.delta);
    return {
        geom, ends: [text, text], mid: text,
        tone: `delta-${d.category}`, important: d.category !== 'grey', weight: Math.abs(d.delta),
        inks: [null, null], midInk: null,
    };
};

/**
 * The labels of a view. Loading %: each end's loading, the branch's
 * (larger end) at its middle — only the branches coloured (from 50 %).
 * Impacts (MW or Loading %): the change, the same at both ends — only the
 * significant ones (coloured). The grey ones would only crowd the reading;
 * the hover still tells them. MW: each end's power as pypowsybl prints it,
 * the larger magnitude at the middle.
 */
export const buildLabelItems = (
    geoms: readonly BranchGeometry[],
    diagram: Pick<DiagramData, 'branch_loading' | 'loading_deltas' | 'flow_deltas'>,
    mode: ViewMode,
    metric: FlowMetric,
    monitoringFactor: number,
): LabelItem[] => {
    const items: LabelItem[] = [];
    for (const geom of geoms) {
        if (metric === 'loading') {
            if (mode === 'delta' && diagram.loading_deltas) {
                const d = diagram.loading_deltas[geom.id];
                if (d && d.category !== 'grey') items.push(deltaItem(geom, d, formatLoadingDelta));
                continue;
            }
            const ends = diagram.branch_loading?.[geom.id];
            const max = maxLoading(ends);
            if (!ends || max === undefined) continue;
            const tone = loadingClass(max, monitoringFactor).replace(/^nad-/, '');
            if (tone === 'loading-low') continue;
            items.push({
                geom,
                ends: [ends[0] === null ? null : formatLoading(ends[0]), ends[1] === null ? null : formatLoading(ends[1])],
                mid: formatLoading(max), tone, important: tone !== 'loading-low', weight: max,
                inks: [null, null], midInk: null,
            });
        } else if (mode === 'delta' && diagram.flow_deltas) {
            const d = diagram.flow_deltas[geom.id];
            if (d && d.category !== 'grey') items.push(deltaItem(geom, d, formatFlowDelta));
        } else {
            const [m1, m2] = geom.mw;
            if (m1 === null && m2 === null) continue;
            const big = Math.max(Math.abs(m1 ?? 0), Math.abs(m2 ?? 0));
            // Written in the voltage's colour, as the line: the middle in its larger end's.
            items.push({
                geom, ends: [formatMw(m1), formatMw(m2)], mid: `${Math.round(big)}`, tone: 'plain', important: false, weight: big,
                inks: geom.inks, midInk: Math.abs(m2 ?? 0) > Math.abs(m1 ?? 0) ? geom.inks[1] : geom.inks[0],
            });
        }
    }
    return items;
};

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Placed boxes, hashed by screen cell, to refuse a label over another. */
class CollisionGrid {
    private cells = new Map<number, Box[]>();

    private keys(b: Box): number[] {
        const keys: number[] = [];
        for (let cx = Math.floor(b.x0 / CELL_PX); cx <= Math.floor(b.x1 / CELL_PX); cx++) {
            for (let cy = Math.floor(b.y0 / CELL_PX); cy <= Math.floor(b.y1 / CELL_PX); cy++) keys.push(cx * 65536 + cy);
        }
        return keys;
    }

    free(b: Box): boolean {
        return this.keys(b).every(k => !(this.cells.get(k) ?? []).some(o =>
            b.x0 < o.x1 + LABEL_GAP_PX && o.x0 < b.x1 + LABEL_GAP_PX && b.y0 < o.y1 + LABEL_GAP_PX && o.y0 < b.y1 + LABEL_GAP_PX));
    }

    add(b: Box): void {
        for (const k of this.keys(b)) {
            const cell = this.cells.get(k);
            if (cell) cell.push(b);
            else this.cells.set(k, [b]);
        }
    }
}

export interface LayoutOptions {
    width: number;
    height: number;
    /** Root user units → CSS px from the layer's top-left corner. */
    project: (p: Point) => Point;
    /** CSS px per user unit. */
    pxPerUnit: number;
    /** A label's text width, CSS px. */
    measure: (text: string, important: boolean) => number;
}

/**
 * Where the labels go for the current view: every branch in view that is
 * coloured, or long enough on screen; the coloured ones first, by value,
 * then the rest; a label per end on a branch long enough to hold two (beside
 * pypowsybl's arrow, towards the middle), else one at its middle; none over
 * another.
 */
export const layoutLabels = (items: readonly LabelItem[], opts: LayoutOptions): PlacedLabel[] => {
    const { width, height, project, pxPerUnit, measure } = opts;
    const inView = (p: Point) => p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;
    const candidates: { item: LabelItem; len: number; mid: Point }[] = [];
    for (const item of items) {
        const { path } = item.geom;
        const a = project(path[0]);
        const b = project(path[path.length - 1]);
        const mid = project(item.geom.mid);
        if (!inView(mid) && !inView(a) && !inView(b)) continue;
        const len = dist(a, b);
        if (!item.important && len < PLAIN_MIN_PX) continue;
        candidates.push({ item, len, mid });
    }
    candidates.sort((p, q) => Number(q.item.important) - Number(p.item.important) || q.item.weight - p.item.weight || q.len - p.len);

    const grid = new CollisionGrid();
    const placed: PlacedLabel[] = [];
    const label = (item: LabelItem, key: string, centre: Point, text: string, ink: string | null): [PlacedLabel, Box] => {
        const w = measure(text, item.important) + 8;
        const h = LABEL_HEIGHT_PX;
        return [
            { key, id: item.geom.id, x: centre[0], y: centre[1], w, text, tone: item.tone, important: item.important, ink },
            { x0: centre[0] - w / 2, y0: centre[1] - h / 2, x1: centre[0] + w / 2, y1: centre[1] + h / 2 },
        ];
    };
    const tryPlace = (labels: [PlacedLabel, Box][]): boolean => {
        if (!labels.length || !labels.every(([l, box]) => inView([l.x, l.y]) && grid.free(box))) return false;
        for (const [l, box] of labels) {
            grid.add(box);
            placed.push(l);
        }
        return true;
    };
    for (const { item, len, mid } of candidates) {
        if (placed.length >= MAX_LABELS) break;
        const { geom } = item;
        if (len >= ENDS_MIN_PX) {
            const ends: [PlacedLabel, Box][] = [];
            for (const end of [0, 1] as const) {
                const text = item.ends[end];
                const anchor = geom.anchors[end];
                if (!text || !anchor) continue;
                // Beside the arrow, on the branch, towards the middle.
                const at = project(anchor);
                const d = Math.hypot(mid[0] - at[0], mid[1] - at[1]) || 1;
                const [pl] = label(item, '', at, text, null);
                const shift = geom.arrow * pxPerUnit + 2 + pl.w / 2;
                const centre: Point = [at[0] + (mid[0] - at[0]) / d * shift, at[1] + (mid[1] - at[1]) / d * shift];
                ends.push(label(item, `${geom.id}:${end}`, centre, text, item.inks[end]));
            }
            if (tryPlace(ends)) continue;
        }
        tryPlace([label(item, `${geom.id}:mid`, mid, item.mid, item.midInk)]);
    }
    return placed;
};

/** A 2-D affine map `[a, b, c, d, e, f]`, as an SVG CTM: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export const applyAffine = (m: Affine, p: Point): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export const invertAffine = (m: Affine): Affine | null => {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return null;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

const distToSegment = (p: Point, a: Point, b: Point): number => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** The branches' segments hashed on a grid of user space: which branch is under the pointer. */
export class BranchIndex {
    private cells = new Map<number, number[]>();
    private cell: number;
    private readonly geoms: readonly BranchGeometry[];

    constructor(geoms: readonly BranchGeometry[]) {
        this.geoms = geoms;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const g of geoms) {
            for (const [x, y] of g.path) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
        }
        this.cell = Math.max((Math.max(x1 - x0, y1 - y0) || 1) / 256, 1e-9);
        geoms.forEach((g, gi) => {
            for (let i = 1; i < g.path.length; i++) {
                const a = g.path[i - 1], b = g.path[i];
                // Walk the segment cell by cell: a long line's bbox would cover thousands.
                const n = Math.ceil(dist(a, b) / this.cell) + 1;
                let last = NaN;
                for (let k = 0; k <= n; k++) {
                    const key = this.key(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
                    if (key === last) continue;
                    last = key;
                    const cell = this.cells.get(key);
                    if (!cell) this.cells.set(key, [gi]);
                    else if (cell[cell.length - 1] !== gi) cell.push(gi);
                }
            }
        });
    }

    private key(x: number, y: number): number {
        return Math.floor(x / this.cell) * 1048576 + Math.floor(y / this.cell);
    }

    /**
     * The branches under the pointer: the nearest within `tolerance` (user
     * units) and any other drawn as close, within `twin` more — parallel
     * circuits pypowsybl draws over each other — nearest first.
     */
    nearest(p: Point, tolerance: number, twin = 0): BranchGeometry[] {
        const r = Math.ceil((tolerance + twin) / this.cell) + 1;
        const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
        const found: { geom: BranchGeometry; d: number }[] = [];
        const seen = new Set<number>();
        for (let x = cx - r; x <= cx + r; x++) {
            for (let y = cy - r; y <= cy + r; y++) {
                for (const gi of this.cells.get(x * 1048576 + y) ?? []) {
                    if (seen.has(gi)) continue;
                    seen.add(gi);
                    const { path } = this.geoms[gi];
                    let d = Infinity;
                    for (let i = 1; i < path.length; i++) d = Math.min(d, distToSegment(p, path[i - 1], path[i]));
                    if (d <= tolerance + twin) found.push({ geom: this.geoms[gi], d });
                }
            }
        }
        if (!found.length) return [];
        found.sort((a, b) => a.d - b.d);
        if (found[0].d > tolerance) return [];
        return found.filter(f => f.d <= found[0].d + twin).map(f => f.geom);
    }
}
