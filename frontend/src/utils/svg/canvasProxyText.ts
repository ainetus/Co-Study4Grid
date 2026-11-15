// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * Text for the canvas gesture proxy (canvasProxy.ts): the flow values (SVG
 * `<text>`) and the voltage-level labels (HTML boxes in a `foreignObject`),
 * read from the live diagram, and drawn on the proxy once they are readable.
 * Positions and sizes come from the live layout, fonts from its computed
 * styles, so the swap back to the live SVG at the settle does not move them.
 */

import { apply, isIdentity, num, outside, scaleOf, type BBox, type Geometry, type Mat, type Style } from './canvasProxyShapes';

/** A text style, resolved once per style key like the shapes'. */
export interface TextStyle {
    /** Canvas font; its size (`size`) is in the element's local units. */
    font: string;
    size: number;
    fill: string | null;
    fillAlpha: number;
    stroke: string | null;
    strokeAlpha: number;
    /** Local units. */
    strokeWidth: number;
    /** `paint-order: stroke` — the white halo pypowsybl draws under each flow value. */
    strokeFirst: boolean;
    lineJoin: CanvasLineJoin;
    miterLimit: number;
    align: CanvasTextAlign;
    baseline: CanvasTextBaseline;
    /** Added to y, in local units: `dominant-baseline: middle` sits half an x-height above the baseline. */
    shift: number;
}

export interface TextRun {
    /** Local → root transform; null for a run already in root user space. */
    m: Mat | null;
    x: number;
    y: number;
    text: string;
    /** Root user space, for culling. */
    bbox: BBox;
}

export interface TextGroup extends TextStyle {
    kind: 'text';
    runs: TextRun[];
    bbox: BBox;
    /** Root user units per local unit: the font is `size × unitScale` root units tall. */
    unitScale: number;
    /** Rank of the first zoom tier that shows it. */
    minTier: number;
}

export interface FontMetrics {
    xHeight: number;
    ascent: number;
    descent: number;
}

/** Canvas alignment for a CSS `text-align` / SVG `text-anchor` (start / end follow the direction). */
export const cssAlign = (align: string, rtl: boolean): CanvasTextAlign => {
    if (align === 'center' || align === 'left' || align === 'right') return align;
    return (align === 'end') !== rtl ? 'right' : 'left';
};

const fontOf = (cs: CSSStyleDeclaration, size: number) =>
    `${cs.fontStyle || 'normal'} ${cs.fontWeight || '400'} ${size}px ${cs.fontFamily || 'serif'}`;

const opaque = (c: string | undefined) => !!c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);

// SVG and HTML both collapse white space in these texts.
const SPACES = /\s{2,}|[\t\n\r]/;
const clean = (s: string | null) => {
    const t = (s ?? '').trim();
    return SPACES.test(t) ? t.replace(/\s+/g, ' ') : t;
};

// A label box's inline `left` / `top`, exactly as pypowsybl wrote them
// (CSSOM re-serialises them with 6 significant digits: ±5 units at 1.5e6).
const LEFT_RE = /(?:^|;)\s*left\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)px/i;
const TOP_RE = /(?:^|;)\s*top\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)px/i;

/** What the collector needs from the proxy being built. */
export interface TextSink {
    view: Window;
    matrixOf: (el: Element) => Mat;
    inlineHidden: (el: Element) => boolean;
    metricsOf: (font: string) => FontMetrics | null;
    measure: (font: string, text: string) => number;
    /** A shape (a label's background); `lodSize`, in root units, is the size LOD_MIN_PX applies to. */
    shape: (li: number, minTier: number, key: string, style: Style, geom: Geometry, lodSize: number) => void;
    text: (li: number, minTier: number, key: string, style: TextStyle, unitScale: number, run: TextRun) => void;
}

/** Where the label boxes of one `foreignObject` sit in root user space. */
export interface LabelFrame {
    m: Mat;
    unit: number;
    x: number;
    y: number;
    local: boolean;
}

interface BoxStyle { fill: string | null; fillAlpha: number; radius: number; borderL: number; borderT: number }
interface LineStyle { text: TextStyle; insetL: number; insetT: number; padH: number; padV: number }

export const createTextCollector = (sink: TextSink) => {
    const { view } = sink;
    const textStyles = new Map<string, TextStyle | null>();
    const boxStyles = new Map<string, BoxStyle>();
    const lineStyles = new Map<string, LineStyle | null>();

    const textStyleOf = (el: Element, parent: Element | null): TextStyle | null => {
        const cs = view.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
        const size = parseFloat(cs.fontSize);
        if (!(size > 0)) return null;
        const groupOpacity = parent ? parseFloat(view.getComputedStyle(parent).opacity || '1') : 1;
        const opacity = parseFloat(cs.opacity || '1') * (Number.isFinite(groupOpacity) ? groupOpacity : 1);
        const w = parseFloat(cs.strokeWidth);
        const stroke = cs.stroke && cs.stroke !== 'none' && w > 0 ? cs.stroke : null;
        const fill = cs.fill && cs.fill !== 'none' ? cs.fill : null;
        if (!stroke && !fill) return null;
        const font = fontOf(cs, size);
        const anchor = cs.getPropertyValue('text-anchor').trim();
        let baseline: CanvasTextBaseline = 'alphabetic';
        let shift = 0;
        switch (cs.getPropertyValue('dominant-baseline').trim()) {
            // Blink puts the `middle` baseline half an x-height above the alphabetic one.
            case 'middle': shift = (sink.metricsOf(font)?.xHeight ?? 0) / 2; break;
            case 'central': baseline = 'middle'; break;
            case 'hanging': baseline = 'hanging'; break;
            case 'text-before-edge': case 'text-top': baseline = 'top'; break;
            case 'text-after-edge': case 'text-bottom': baseline = 'bottom'; break;
            case 'ideographic': baseline = 'ideographic'; break;
            default: break;
        }
        const join = cs.getPropertyValue('stroke-linejoin').trim();
        return {
            font, size, fill,
            fillAlpha: opacity * parseFloat(cs.fillOpacity || '1'),
            stroke,
            strokeAlpha: opacity * parseFloat(cs.strokeOpacity || '1'),
            strokeWidth: stroke ? w : 0,
            strokeFirst: /^\s*stroke/.test(cs.getPropertyValue('paint-order')),
            lineJoin: join === 'round' || join === 'bevel' ? join : 'miter',
            miterLimit: parseFloat(cs.getPropertyValue('stroke-miterlimit')) || 4,
            align: anchor === 'middle' ? 'center' : cssAlign(anchor === 'end' ? 'end' : 'start', cs.direction === 'rtl'),
            baseline,
            shift,
        };
    };

    const boxStyleOf = (box: HTMLElement): BoxStyle => {
        const cs = view.getComputedStyle(box);
        return {
            fill: opaque(cs.backgroundColor) ? cs.backgroundColor : null,
            fillAlpha: parseFloat(cs.opacity || '1'),
            radius: parseFloat(cs.borderTopLeftRadius) || 0,
            borderL: parseFloat(cs.borderLeftWidth) || 0,
            borderT: parseFloat(cs.borderTopWidth) || 0,
        };
    };

    const lineStyleOf = (line: HTMLElement, box: HTMLElement): LineStyle | null => {
        const cs = view.getComputedStyle(line);
        const size = parseFloat(cs.fontSize);
        if (!(size > 0) || !opaque(cs.color)) return null;
        const px = (v: string) => parseFloat(v) || 0;
        const boxOpacity = line === box ? 1 : parseFloat(view.getComputedStyle(box).opacity || '1');
        return {
            text: {
                font: fontOf(cs, size), size, fill: cs.color, fillAlpha: parseFloat(cs.opacity || '1') * boxOpacity,
                stroke: null, strokeAlpha: 1, strokeWidth: 0, strokeFirst: false, lineJoin: 'miter', miterLimit: 4,
                align: cssAlign(cs.textAlign, cs.direction === 'rtl'), baseline: 'alphabetic', shift: 0,
            },
            insetL: px(cs.borderLeftWidth) + px(cs.paddingLeft),
            insetT: px(cs.borderTopWidth) + px(cs.paddingTop),
            padH: px(cs.paddingLeft) + px(cs.paddingRight),
            padV: px(cs.paddingTop) + px(cs.paddingBottom),
        };
    };

    // Greedy word wrap at `width` — only for a box holding more than one line
    // (pypowsybl sizes its label boxes to a single line).
    const wrap = (text: string, font: string, width: number): string[] => {
        const rows: string[] = [];
        let row = '';
        for (const word of text.split(' ')) {
            const next = row ? `${row} ${word}` : word;
            if (row && sink.measure(font, next) > width + 0.5) {
                rows.push(row);
                row = word;
            } else {
                row = next;
            }
        }
        if (row) rows.push(row);
        return rows;
    };

    /**
     * An SVG `<text>`: the flow values sit in a `translate · scale` group,
     * with their own `rotate`, `dominant-baseline: middle` and a stroke halo
     * painted first. Positioned `<tspan>`s are drawn one by one (a flowing
     * tspan would need shaping: only the first is).
     */
    const svgText = (el: Element, li: number, minTier: number) => {
        if (sink.inlineHidden(el)) return;
        const parent = el.parentElement;
        const m = sink.matrixOf(el);
        const unit = scaleOf(m);
        const styleKey = [
            li, 'text', el.getAttribute('class'), el.getAttribute('style'),
            parent?.getAttribute('class'), parent?.getAttribute('style'), unit.toPrecision(3),
        ].join('|');
        let style = textStyles.get(styleKey);
        if (style === undefined) {
            style = textStyleOf(el, parent);
            textStyles.set(styleKey, style);
        }
        if (!style) return;
        const s = style;
        let x = num(el, 'x') + num(el, 'dx');
        let y = num(el, 'y') + num(el, 'dy');
        const spans = el.childElementCount ? Array.from(el.children).filter(c => c.localName === 'tspan') : [];
        const parts = spans.length ? spans : [el];
        parts.forEach((part, k) => {
            if (part !== el) {
                if (k > 0 && !part.hasAttribute('x') && !part.hasAttribute('y')) return;
                if (part.hasAttribute('x')) x = num(part, 'x');
                if (part.hasAttribute('y')) y = num(part, 'y');
                x += num(part, 'dx');
                y += num(part, 'dy');
            }
            const text = clean(part.textContent);
            if (!text) return;
            const [px, py] = apply(m, x, y);
            const r = s.size * unit * (0.6 * text.length + 1);
            sink.text(li, minTier, styleKey, s, unit, { m, x, y, text, bbox: [px - r, py - r, px + r, py + r] });
        });
    };

    const labelFrame = (fo: Element): LabelFrame => {
        const m = sink.matrixOf(fo);
        return { m, unit: scaleOf(m), x: num(fo, 'x'), y: num(fo, 'y'), local: isIdentity(m) };
    };

    /**
     * An HTML label box (`.nad-label-box`): its rounded background, then its
     * lines. The position is the exact inline `left` / `top`; the size and
     * the line boxes come from the live layout (a box that is not laid out is
     * skipped); `line-height: normal` splits its leading evenly around the
     * glyphs.
     */
    const labelBox = (box: HTMLElement, frame: LabelFrame, li: number, minTier: number) => {
        if (sink.inlineHidden(box)) return;
        const w = box.offsetWidth, h = box.offsetHeight;
        if (!(w > 0 && h > 0)) return;
        const raw = box.getAttribute('style') ?? '';
        const left = frame.x + (parseFloat(LEFT_RE.exec(raw)?.[1] ?? '') || parseFloat(box.style.left) || 0);
        const top = frame.y + (parseFloat(TOP_RE.exec(raw)?.[1] ?? '') || parseFloat(box.style.top) || 0);
        const { m, unit, local } = frame;
        const boxKey = `${li}|label|${box.className}`;
        let bs = boxStyles.get(boxKey);
        if (!bs) {
            bs = boxStyleOf(box);
            boxStyles.set(boxKey, bs);
        }
        const corners = [apply(m, left, top), apply(m, left + w, top), apply(m, left + w, top + h), apply(m, left, top + h)];
        const bbox: BBox = [
            Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]),
            Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]),
            Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]),
            Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]),
        ];
        const lines = box.childElementCount ? (Array.from(box.children) as HTMLElement[]) : [box];
        const styleOf = (line: HTMLElement): [string, LineStyle | null] => {
            const lineKey = `${boxKey}|${line === box ? '' : line.className}`;
            let ls = lineStyles.get(lineKey);
            if (ls === undefined) {
                ls = lineStyleOf(line, box);
                lineStyles.set(lineKey, ls);
            }
            return [lineKey, ls];
        };
        if (bs.fill) {
            const radius = Math.min(bs.radius, w / 2, h / 2);
            // Sized by its font, the background shows with its text: thousands
            // of unreadable labels' fills cost the frames at detail zoom.
            const font = styleOf(lines[0])[1]?.text.size;
            sink.shape(li, minTier, boxKey, {
                fill: bs.fill, fillAlpha: bs.fillAlpha, stroke: null, strokeAlpha: 1,
                width: 0, nonScaling: false, zoomWidth: 0, dash: [],
            }, {
                bbox,
                build: (p) => {
                    if (local && radius > 0 && typeof p.roundRect === 'function') {
                        p.roundRect(left, top, w, h, radius);
                        return;
                    }
                    p.moveTo(corners[0][0], corners[0][1]);
                    for (let k = 1; k < 4; k++) p.lineTo(corners[k][0], corners[k][1]);
                }, // a fill closes the sub-path
            }, (font ?? Math.min(w, h)) * unit);
        }
        for (const line of lines) {
            const text = clean(line.textContent);
            if (!text) continue;
            const [lineKey, ls] = styleOf(line);
            const mt = ls && sink.metricsOf(ls.text.font);
            if (!ls || !mt) continue;
            // The line's content box, in the label's local CSS px.
            const x0 = left + (line === box ? 0 : bs.borderL + line.offsetLeft) + ls.insetL;
            const y0 = top + (line === box ? 0 : bs.borderT + line.offsetTop) + ls.insetT;
            const cw = line.clientWidth - ls.padH;
            const ch = line.clientHeight - ls.padV;
            const fontH = mt.ascent + mt.descent;
            const rows = ch > 1.5 * fontH ? wrap(text, ls.text.font, cw) : [text];
            const lineH = ch / rows.length;
            const x = ls.text.align === 'center' ? x0 + cw / 2 : ls.text.align === 'right' ? x0 + cw : x0;
            rows.forEach((row, k) => {
                const y = y0 + k * lineH + (lineH - fontH) / 2 + mt.ascent;
                sink.text(li, minTier, lineKey, (ls as LineStyle).text, unit, { m: local ? null : m, x, y, text: row, bbox });
            });
        }
    };

    return { svgText, labelFrame, labelBox };
};

/**
 * Draw one text group: its font and paints once, then each run in view under
 * its own transform (or the root one, `scale`/`ox`/`oy`), restored after.
 */
export const renderTextGroup = (
    c: CanvasRenderingContext2D, g: TextGroup, scale: number, ox: number, oy: number, cull: BBox | null,
): void => {
    c.font = g.font;
    c.textAlign = g.align;
    c.textBaseline = g.baseline;
    if (g.fill) c.fillStyle = g.fill;
    if (g.stroke) {
        c.strokeStyle = g.stroke;
        c.lineWidth = g.strokeWidth;
        c.lineJoin = g.lineJoin;
        c.miterLimit = g.miterLimit;
        c.setLineDash([]);
    }
    for (const r of g.runs) {
        if (cull && outside(r.bbox, cull)) continue;
        const m = r.m;
        if (m) c.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4] + ox, scale * m[5] + oy);
        const y = r.y + g.shift;
        if (g.stroke && g.strokeFirst) {
            c.globalAlpha = g.strokeAlpha;
            c.strokeText(r.text, r.x, y);
        }
        if (g.fill) {
            c.globalAlpha = g.fillAlpha;
            c.fillText(r.text, r.x, y);
        }
        if (g.stroke && !g.strokeFirst) {
            c.globalAlpha = g.strokeAlpha;
            c.strokeText(r.text, r.x, y);
        }
    }
    c.setTransform(scale, 0, 0, scale, ox, oy);
    c.lineJoin = 'miter';
    c.miterLimit = 4;
};
