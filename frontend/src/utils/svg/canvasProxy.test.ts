// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTransform, buildCanvasProxy, createCanvasProxyController, GESTURE_PROXY_ATTR } from './canvasProxy';
import { straightPath } from './canvasProxyShapes';

const SVG_NS = 'http://www.w3.org/2000/svg';

// jsdom has neither Path2D nor a 2D canvas context: record what the proxy builds / draws.
class FakePath2D {
    ops: Array<[string, ...number[]]> = [];
    moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
    lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
    closePath() { this.ops.push(['closePath']); }
    ellipse(x: number, y: number, rx: number, ry: number) { this.ops.push(['ellipse', x, y, rx, ry]); }
    roundRect(x: number, y: number, w: number, h: number, r: number) { this.ops.push(['roundRect', x, y, w, h, r]); }
    addPath() { this.ops.push(['addPath']); }
}

interface FakeCall {
    op: string;
    path?: FakePath2D;
    lineWidth?: number;
    style?: string;
    alpha?: number;
    text?: string;
    x?: number;
    y?: number;
    /** The transform the text was drawn under. */
    t?: number[];
    align?: string;
    baseline?: string;
    font?: string;
}

interface FakeCtx {
    calls: FakeCall[];
    lineWidth: number;
    strokeStyle: string;
    fillStyle: string;
    globalAlpha: number;
    lineCap: string;
    lineJoin: string;
    miterLimit: number;
    font: string;
    textAlign: string;
    textBaseline: string;
    t: number[];
    setTransform: (...m: number[]) => void;
    setLineDash: () => void;
    fillRect: () => void;
    clearRect: () => void;
    fill: (p: FakePath2D) => void;
    stroke: (p: FakePath2D) => void;
    drawImage: () => void;
    measureText: (s: string) => Partial<TextMetrics>;
    fillText: (s: string, x: number, y: number) => void;
    strokeText: (s: string, x: number, y: number) => void;
}

const makeCtx = (): FakeCtx => {
    const ctx: FakeCtx = {
        calls: [],
        lineWidth: 1, strokeStyle: '', fillStyle: '', globalAlpha: 1, lineCap: '', lineJoin: '', miterLimit: 10,
        font: '', textAlign: 'start', textBaseline: 'alphabetic', t: [1, 0, 0, 1, 0, 0],
        setTransform: (...m) => { ctx.t = m; },
        setLineDash: () => {},
        fillRect: () => { ctx.calls.push({ op: 'fillRect', style: ctx.fillStyle }); },
        clearRect: () => { ctx.calls.push({ op: 'clearRect' }); },
        fill: (p) => { ctx.calls.push({ op: 'fill', path: p, style: ctx.fillStyle, alpha: ctx.globalAlpha }); },
        stroke: (p) => { ctx.calls.push({ op: 'stroke', path: p, style: ctx.strokeStyle, lineWidth: ctx.lineWidth, alpha: ctx.globalAlpha }); },
        drawImage: () => { ctx.calls.push({ op: 'drawImage' }); },
        // Every font: x-height 7, ascent 13, descent 3, 7 per character.
        measureText: (s) => ({ width: s.length * 7, actualBoundingBoxAscent: 7, fontBoundingBoxAscent: 13, fontBoundingBoxDescent: 3 }),
        fillText: (s, x, y) => {
            ctx.calls.push({ op: 'fillText', text: s, x, y, t: ctx.t, align: ctx.textAlign, baseline: ctx.textBaseline, font: ctx.font, style: ctx.fillStyle, alpha: ctx.globalAlpha });
        },
        strokeText: (s, x, y) => {
            ctx.calls.push({ op: 'strokeText', text: s, x, y, t: ctx.t, style: ctx.strokeStyle, lineWidth: ctx.lineWidth, alpha: ctx.globalAlpha });
        },
    };
    return ctx;
};

const nonScaling = (p: string) => (p === 'vector-effect' ? 'non-scaling-stroke' : '');

// Computed styles keyed off the classes the NAD uses (jsdom does not resolve
// pypowsybl's CSS, so the test supplies what Chrome would compute).
const fakeComputedStyle = (el: Element): Partial<CSSStyleDeclaration> => {
    const cls = el.getAttribute('class') ?? '';
    const parentCls = el.parentElement?.getAttribute('class') ?? '';
    const base = {
        display: 'inline', visibility: 'visible', opacity: '1', strokeOpacity: '1', fillOpacity: '1',
        strokeDasharray: 'none', backgroundColor: '', getPropertyValue: () => '',
    };
    const font = { fontFamily: 'serif', fontStyle: 'normal', fontWeight: '400', direction: 'ltr' };
    if (el.localName === 'text') {
        // pypowsybl's flow values: a white halo painted first, centred on the x-height.
        const props: Record<string, string> = {
            'text-anchor': /text-anchor:\s*end/.test(el.getAttribute('style') ?? '') ? 'end' : 'start',
            'dominant-baseline': 'middle', 'paint-order': 'stroke', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4',
        };
        return {
            ...base, ...font, fontSize: /tiny/.test(cls) ? '1px' : '20px',
            fill: 'rgb(84, 110, 122)', stroke: 'rgba(255, 255, 255, 0.667)', strokeWidth: '10px',
            getPropertyValue: (p: string) => props[p] ?? '',
        };
    }
    if (/nad-label-box/.test(cls)) {
        return { ...base, backgroundColor: 'rgba(108, 108, 108, 0.125)', borderTopLeftRadius: '6px', borderLeftWidth: '0px', borderTopWidth: '0px' };
    }
    if (/nad-label-box/.test(parentCls)) {
        return {
            ...base, ...font, fontSize: '15px', color: 'rgb(0, 0, 0)', textAlign: 'start',
            paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px', borderLeftWidth: '0px', borderTopWidth: '0px',
        };
    }
    if (el.localName === 'path' && el.closest('.nad-edge-infos')) {
        return { ...base, stroke: 'none', strokeWidth: '0', fill: 'rgb(1, 1, 1)' };
    }
    if (el.localName === 'polyline' && el.closest('.nad-text-edges')) {
        return { ...base, stroke: 'rgb(0, 0, 0)', strokeWidth: '3px', fill: 'none', strokeDasharray: '6, 7', getPropertyValue: nonScaling };
    }
    if (el.localName === 'polyline' && el.closest('.nad-edge-infos')) {
        return { ...base, stroke: 'rgb(9, 9, 9)', strokeWidth: '1px', fill: 'none', getPropertyValue: nonScaling };
    }
    if (el.tagName.toLowerCase() === 'polyline') {
        const contingency = /nad-contingency-highlight/.test(parentCls);
        const halo = contingency || /nad-overloaded/.test(parentCls);
        return {
            ...base,
            stroke: contingency ? 'rgb(255, 255, 0)' : halo ? 'rgb(255, 165, 0)' : /300to500/.test(cls) ? 'rgb(255, 0, 0)' : 'rgb(0, 128, 0)',
            // App.css: the contingency halo is 1.7 × `--nad-halo-w`, the others 1 ×.
            strokeWidth: contingency ? '40.8px' : halo ? '24px' : '5px', fill: 'none',
            getPropertyValue: (p: string) => (p === 'vector-effect' ? 'non-scaling-stroke' : p === '--nad-halo-w' ? '24px' : ''),
        };
    }
    if (el.tagName.toLowerCase() === 'circle') {
        return { ...base, stroke: 'none', strokeWidth: '0', fill: 'rgb(0, 0, 255)' };
    }
    return { ...base, stroke: 'none', strokeWidth: '0', fill: 'none', backgroundColor: 'rgb(250, 250, 250)' };
};

const buildDiagram = () => {
    const container = document.createElement('div');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 800');
    svg.innerHTML = `
        <g id="nad-background-layer">
            <g class="nad-overloaded nad-highlight-clone" transform="matrix(1,0,0,1,10,0)" style="visibility: visible">
                <polyline class="nad-vl300to500 nad-edge-path" points="0,0 100,0"></polyline>
            </g>
        </g>
        <g class="nad-vl-nodes">
            <g class="nad-vl300to500" transform="translate(100,100) scale(2)"><circle r="5" class="nad-bus-0 nad-busnode"></circle></g>
            <g class="nad-vl300to500" transform="translate(900,700) scale(2)"><circle r="5" class="nad-bus-0 nad-busnode"></circle></g>
            <g class="nad-vl300to500" transform="translate(500,400)" style="display: none"><circle r="5" class="nad-bus-0 nad-busnode"></circle></g>
        </g>
        <g class="nad-branch-edges">
            <g><polyline class="nad-vl300to500 nad-edge-path" points="0,0 100,0"></polyline></g>
            <g><polyline class="nad-vl300to500 nad-edge-path" points="0,10 100,10 120,30"></polyline></g>
            <g><polyline class="nad-vl180to300 nad-edge-path" points="900,700 950,750"></polyline></g>
        </g>
        <g class="nad-edge-infos"><g><polyline points="0,0 1,1"></polyline><text>12</text></g></g>`;
    container.appendChild(svg);
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 800 });
    return { container, svg };
};

const opsOf = (calls: FakeCtx['calls'], op: string) => calls.filter(c => c.op === op);

const EXT = { x: 0, y: 0, w: 1000, h: 800 };
/** 10× into the middle: 1 user unit = 10 px. */
const VIEW10 = { x: 450, y: 350, w: 100, h: 80 };

// A branch edge, its flow value (arrow + text in pypowsybl's
// translate · scale group, the text rotated and end-anchored), a tiny flow
// value, a label connector and an HTML label box — with the layout jsdom
// cannot compute supplied by hand.
const buildTextDiagram = (containerClass = 'svg-container') => {
    const container = document.createElement('div');
    container.className = containerClass;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1000 800');
    svg.innerHTML = `
        <g class="nad-branch-edges"><g><polyline class="nad-vl300to500 nad-edge-path" points="400,400 600,400"></polyline></g></g>
        <g class="nad-edge-infos">
            <g transform="translate(500,400) scale(2)">
                <path class="nad-active nad-arrow-in" d="M-10 -10 H10 L0 10z"></path>
                <text transform="rotate(90)" class="nad-active" x="19" style="text-anchor:end">-19</text>
            </g>
            <g transform="translate(480,420) scale(2)"><text class="nad-active tiny" x="19">7</text></g>
        </g>
        <g class="nad-text-edges"><polyline points="500,400 520,390"></polyline></g>
        <foreignObject class="nad-text-nodes" width="1" height="1"><div>
            <div class="nad-label-box nad-vl300to500" style="position: absolute; top: 380px; left: 450px"><div>BUS 400kV</div></div>
        </div></foreignObject>`;
    container.appendChild(svg);
    document.body.appendChild(container);
    const layout = (el: Element, props: Record<string, number>) => {
        for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { configurable: true, value: v });
    };
    layout(container, { clientWidth: 1000, clientHeight: 800 });
    const box = svg.querySelector('.nad-label-box')!;
    layout(box, { offsetWidth: 100, offsetHeight: 30 });
    layout(box.firstElementChild!, { offsetLeft: 6, offsetTop: 6, clientWidth: 88, clientHeight: 18 });
    return { container, svg };
};

describe('straightPath', () => {
    it('reads the flow arrows (M H L Z)', () => {
        expect(straightPath('M-10 -10 H10 L0 10z')).toEqual([{ pts: [-10, -10, 10, -10, 0, 10], closed: true }]);
    });

    it('follows relative commands and implicit line-tos', () => {
        expect(straightPath('m1 1 2 0 v3 h-2z')).toEqual([{ pts: [1, 1, 3, 1, 3, 4, 1, 4], closed: true }]);
    });

    it('gives up on curves (the generic path takes them)', () => {
        expect(straightPath('M0 0 C1 1 2 2 3 3')).toBeNull();
    });
});

describe('parseTransform', () => {
    it('composes a pypowsybl node transform (translate · scale)', () => {
        const m = parseTransform('translate(10,20) translate(0,0) scale(60.00) translate(0,0)');
        expect(m).toEqual([60, 0, 0, 60, 10, 20]);
    });

    it('reads a highlight clone matrix', () => {
        expect(parseTransform('matrix(1, 0, 0, 1, 5, -3)')).toEqual([1, 0, 0, 1, 5, -3]);
    });

    it('rotates about a point', () => {
        const m = parseTransform('rotate(90, 10, 0)');
        // (20, 0) rotated 90° about (10, 0) → (10, 10)
        const x = m[0] * 20 + m[2] * 0 + m[4];
        const y = m[1] * 20 + m[3] * 0 + m[5];
        expect(x).toBeCloseTo(10);
        expect(y).toBeCloseTo(10);
    });

    it('falls back to identity on empty or malformed input', () => {
        expect(parseTransform(null)).toEqual([1, 0, 0, 1, 0, 0]);
        expect(parseTransform('translate(a,b)')).toEqual([1, 0, 0, 1, 0, 0]);
    });
});

describe('buildCanvasProxy', () => {
    let ctx: FakeCtx;

    beforeEach(() => {
        vi.stubGlobal('Path2D', FakePath2D);
        ctx = makeCtx();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
            () => ctx as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            (el: Element) => fakeComputedStyle(el) as CSSStyleDeclaration,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('groups drawables per style and grid cell, skipping hidden elements and non-network layers', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        // halo · 2 bus cells (the display:none node is skipped) · 400 kV edges ·
        // 225 kV edge — the edge-info polyline is not drawn.
        expect(proxy.itemCount).toBe(5);
        expect(proxy.canvas.className).toBe('nad-canvas-proxy');
    });

    it('maps geometry into root user space (node and clone transforms)', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        const fills = opsOf(ctx.calls, 'fill');
        const ellipses = fills.flatMap(c => c.path!.ops.filter(o => o[0] === 'ellipse'));
        // translate(100,100) scale(2) on a r=5 circle → centre (100,100), radius 10.
        expect(ellipses).toContainEqual(['ellipse', 100, 100, 10, 10]);
        expect(ellipses).toContainEqual(['ellipse', 900, 700, 10, 10]);
        const halo = opsOf(ctx.calls, 'stroke').find(c => c.style === 'rgb(255, 165, 0)');
        expect(halo!.path!.ops[0]).toEqual(['moveTo', 10, 0]);
    });

    it('paints the halo layer first, then nodes, then branch edges (pypowsybl order)', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        const order = ctx.calls.filter(c => c.op === 'fill' || c.op === 'stroke').map(c => c.style);
        expect(order[0]).toBe('rgb(255, 165, 0)');
        expect(order.indexOf('rgb(0, 0, 255)')).toBeLessThan(order.indexOf('rgb(255, 0, 0)'));
    });

    it('keeps non-scaling strokes at constant screen width', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 }); // 1 user unit = 1 px
        const wide = opsOf(ctx.calls, 'stroke').find(c => c.style === 'rgb(255, 0, 0)')!.lineWidth!;
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 100, h: 80 }); // zoomed 10×
        const zoomed = opsOf(ctx.calls, 'stroke').find(c => c.style === 'rgb(255, 0, 0)')!.lineWidth!;
        // In user units the stroke shrinks 10× so it stays 5 px on screen.
        expect(wide).toBeCloseTo(5);
        expect(zoomed).toBeCloseTo(0.5);
    });

    it('draws halo widths for the current zoom, as the live --nad-halo-w does', () => {
        const { container, svg } = buildDiagram();
        const haloWidth = (vb: { w: number }) => (vb.w >= 1000 ? 50 : 24);
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false, haloWidth });
        const width = (colour: string) => opsOf(ctx.calls, 'stroke').find(c => c.style === colour)!.lineWidth!;
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 }); // full extent: 1 user unit = 1 px
        expect(width('rgb(255, 165, 0)')).toBeCloseTo(50);
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 100, h: 80 }); // zoomed 10×: 24 px = 2.4 user units
        expect(width('rgb(255, 165, 0)')).toBeCloseTo(2.4);
        // Plain edges keep their own (non-scaling) width.
        expect(width('rgb(255, 0, 0)')).toBeCloseTo(0.5);
    });

    it('keeps the contingency halo wider than an overload on its twin, beneath it, at every zoom', () => {
        const { container, svg } = buildDiagram();
        // applyContingencyHighlight puts its clone first in the background layer.
        svg.querySelector('#nad-background-layer')!.insertAdjacentHTML('afterbegin', `
            <g class="nad-contingency-highlight nad-highlight-clone" style="visibility: visible">
                <polyline class="nad-vl300to500 nad-edge-path" points="0,5 100,5"></polyline>
            </g>`);
        const haloWidth = (vb: { w: number }) => (vb.w >= 1000 ? 50 : 24);
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false, haloWidth });
        const width = (colour: string) => opsOf(ctx.calls, 'stroke').find(c => c.style === colour)!.lineWidth!;
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        expect(opsOf(ctx.calls, 'stroke')[0].style).toBe('rgb(255, 255, 0)');
        expect(width('rgb(255, 255, 0)')).toBeCloseTo(85);
        expect(width('rgb(255, 165, 0)')).toBeCloseTo(50);
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 100, h: 80 }); // zoomed 10×
        expect(width('rgb(255, 255, 0)')).toBeCloseTo(4.08);
        expect(width('rgb(255, 165, 0)')).toBeCloseTo(2.4);
    });

    it('culls cells outside the view', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        proxy.draw({ x: 0, y: 0, w: 200, h: 160 }); // top-left corner only
        const styles = ctx.calls.filter(c => c.op === 'fill' || c.op === 'stroke').map(c => c.style);
        expect(styles).toContain('rgb(255, 0, 0)');
        // The 225 kV edge and the node at (900, 700) are far outside the view.
        expect(styles).not.toContain('rgb(0, 128, 0)');
        const ellipses = opsOf(ctx.calls, 'fill').flatMap(c => c.path!.ops.filter(o => o[0] === 'ellipse'));
        expect(ellipses).not.toContainEqual(['ellipse', 900, 700, 10, 10]);
    });

    it('fills with the container background so the canvas covers the live SVG', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 }, { overviewCache: false });
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        expect(ctx.calls[0]).toEqual({ op: 'fillRect', style: 'rgb(250, 250, 250)' });
    });

    it('blits the overview cache near full extent and strokes vectors when zoomed in', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 });
        proxy.prepare();
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(1);
        expect(opsOf(ctx.calls, 'stroke')).toHaveLength(0);
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 100, h: 80 });
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(0);
        expect(opsOf(ctx.calls, 'stroke').length).toBeGreaterThan(0);
    });

    it('re-bakes the overview cache for a resized panel on prepare, never mid-draw', () => {
        const { container, svg } = buildDiagram();
        const proxy = buildCanvasProxy(svg, container, { x: 0, y: 0, w: 1000, h: 800 });
        proxy.prepare();
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 600 });
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        // Baked for a 1000 px panel: its strokes would be off, so vectors until re-baked.
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(0);
        expect(opsOf(ctx.calls, 'stroke').length).toBeGreaterThan(0);
        proxy.prepare();
        ctx.calls = [];
        proxy.draw({ x: 0, y: 0, w: 1000, h: 800 });
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(1);
    });
});

describe('flow values and labels on the proxy', () => {
    let ctx: FakeCtx;

    beforeEach(() => {
        vi.stubGlobal('Path2D', FakePath2D);
        ctx = makeCtx();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
            () => ctx as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            (el: Element) => fakeComputedStyle(el) as CSSStyleDeclaration,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    const texts = () => opsOf(ctx.calls, 'fillText').map(c => c.text);
    const filled = (style: string) => ctx.calls.filter(c => c.op === 'fill' && c.style === style).length;
    const stroked = (style: string) => ctx.calls.filter(c => c.op === 'stroke' && c.style === style).length;
    const ready = (options: Parameters<typeof buildCanvasProxy>[3] = {}, containerClass?: string) => {
        const { container, svg } = buildTextDiagram(containerClass);
        const proxy = buildCanvasProxy(svg, container, EXT, { overviewCache: false, ...options });
        proxy.step(Infinity);
        return proxy;
    };

    it('reads the network at once, the flow values and labels in steps', () => {
        const { container, svg } = buildTextDiagram();
        const proxy = buildCanvasProxy(svg, container, EXT, { overviewCache: false });
        expect(proxy.itemCount).toBe(1); // the branch edge
        expect(proxy.textRunCount).toBe(0);
        expect(proxy.pending).toBe(true);
        expect(proxy.step(Infinity)).toBe(true);
        expect(proxy.pending).toBe(false);
        expect(proxy.textRunCount).toBe(3); // -19, 7, BUS 400kV
    });

    it('draws a flow value as Blink lays it out: group and own transforms, anchor, middle baseline, halo first', () => {
        ready().draw(VIEW10);
        const halo = ctx.calls.find(c => c.op === 'strokeText' && c.text === '-19')!;
        const fill = ctx.calls.find(c => c.op === 'fillText' && c.text === '-19')!;
        expect(ctx.calls.indexOf(halo)).toBeLessThan(ctx.calls.indexOf(fill)); // paint-order: stroke
        // translate(500,400) scale(2) rotate(90), under the 10× view (offset -4500, -3500).
        [0, 20, -20, 0, 500, 500].forEach((v, i) => expect(fill.t![i]).toBeCloseTo(v));
        expect(fill.x).toBe(19);
        expect(fill.y).toBeCloseTo(3.5); // half the x-height below the anchor
        expect(fill.align).toBe('right'); // text-anchor: end
        expect(fill.baseline).toBe('alphabetic');
        expect(halo.lineWidth).toBe(10); // local units: the transform scales it
        expect(halo.style).toBe('rgba(255, 255, 255, 0.667)');
    });

    it('leaves text out until it is readable on screen (TEXT_MIN_PX)', () => {
        const proxy = ready();
        proxy.draw(EXT); // 1 unit = 1 px: the flow value is 40 px, the tiny one 2 px
        expect(texts()).toContain('-19');
        expect(texts()).not.toContain('7');
        ctx.calls = [];
        proxy.draw(VIEW10); // the tiny one is 20 px now
        expect(texts()).toContain('7');
    });

    it('hides the flow values and their arrows at the overview tier, as App.css does', () => {
        const tierOf = (vb: { w: number }) => (vb.w > 500 ? 'overview' as const : 'detail' as const);
        const proxy = ready({ tierOf });
        proxy.draw(EXT);
        expect(texts()).not.toContain('-19');
        expect(filled('rgb(1, 1, 1)')).toBe(0);
        expect(texts()).toContain('BUS 400kV'); // the labels are not tier-gated
        ctx.calls = [];
        proxy.draw(VIEW10);
        expect(texts()).toContain('-19');
        expect(filled('rgb(1, 1, 1)')).toBe(1);
    });

    it('draws a label box as laid out: its background, then its text on the line box baseline', () => {
        ready().draw(VIEW10);
        const bg = ctx.calls.find(c => c.op === 'fill' && c.style === 'rgba(108, 108, 108, 0.125)')!;
        expect(bg.path!.ops).toContainEqual(['roundRect', 450, 380, 100, 30, 6]);
        const label = ctx.calls.find(c => c.op === 'fillText' && c.text === 'BUS 400kV')!;
        expect(ctx.calls.indexOf(bg)).toBeLessThan(ctx.calls.indexOf(label));
        // Line box at (450 + 6, 380 + 6), 18 tall, glyphs 13 + 3: baseline 386 + 1 + 13.
        expect([label.x, label.y]).toEqual([456, 400]);
        expect(label.t).toEqual([10, 0, 0, 10, -4500, -3500]); // root user space
        expect(label.style).toBe('rgb(0, 0, 0)');
        expect(label.font).toBe('normal 400 15px serif');
    });

    it('paints in pypowsybl order: network, flow arrows and values, label connectors, labels', () => {
        ready().draw(VIEW10);
        const at = (pred: (c: FakeCall) => boolean) => ctx.calls.findIndex(pred);
        const order = [
            at(c => c.op === 'stroke' && c.style === 'rgb(255, 0, 0)'),
            at(c => c.op === 'fill' && c.style === 'rgb(1, 1, 1)'),
            at(c => c.op === 'fillText' && c.text === '-19'),
            at(c => c.op === 'stroke' && c.style === 'rgb(0, 0, 0)'),
            at(c => c.op === 'fillText' && c.text === 'BUS 400kV'),
        ];
        expect(order.every(i => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('leaves out arrows and connectors under LOD_MIN_PX, and a label background until its text shows', () => {
        const proxy = ready();
        proxy.draw({ x: -9500, y: -7600, w: 20000, h: 16000 }); // 1 unit = 0.05 px
        expect(filled('rgb(1, 1, 1)')).toBe(0); // a 40-unit arrow: 2 px across
        expect(stroked('rgb(0, 0, 0)')).toBe(0); // a 20-unit connector: 1 px long
        expect(stroked('rgb(255, 0, 0)')).toBe(1); // the network is always drawn
        ctx.calls = [];
        proxy.draw({ x: -2000, y: -1600, w: 5000, h: 4000 }); // 1 unit = 0.2 px
        expect(filled('rgb(1, 1, 1)')).toBe(1); // 8 px
        expect(stroked('rgb(0, 0, 0)')).toBe(1); // 4 px
        // The 15-unit label font is 3 px: neither the text nor its background.
        expect(texts()).not.toContain('BUS 400kV');
        expect(filled('rgba(108, 108, 108, 0.125)')).toBe(0);
        ctx.calls = [];
        proxy.draw({ x: -750, y: -600, w: 2500, h: 2000 }); // 1 unit = 0.4 px: the font is 6 px
        expect(texts()).toContain('BUS 400kV');
        expect(filled('rgba(108, 108, 108, 0.125)')).toBe(1);
    });

    it('leaves the labels out when the legend hides them', () => {
        ready({}, 'svg-container nad-hide-vl-labels').draw(VIEW10);
        expect(texts()).not.toContain('BUS 400kV');
        expect(filled('rgba(108, 108, 108, 0.125)')).toBe(0);
        expect(stroked('rgb(0, 0, 0)')).toBe(0);
        expect(texts()).toContain('-19');
    });

    it('never bakes text into the overview cache; readable text goes over the blit', () => {
        const { container, svg } = buildTextDiagram();
        const proxy = buildCanvasProxy(svg, container, EXT);
        proxy.step(Infinity);
        proxy.prepare();
        expect(texts()).toHaveLength(0);
        ctx.calls = [];
        proxy.draw(EXT);
        const blit = ctx.calls.findIndex(c => c.op === 'drawImage');
        expect(blit).toBeGreaterThan(-1);
        expect(ctx.calls.findIndex(c => c.op === 'fillText' && c.text === '-19')).toBeGreaterThan(blit);
    });

    it('re-bakes the overview cache once the deferred layers are in', () => {
        const { container, svg } = buildTextDiagram();
        const proxy = buildCanvasProxy(svg, container, EXT);
        proxy.prepare();
        ctx.calls = [];
        proxy.prepare(); // nothing new: no re-bake
        expect(opsOf(ctx.calls, 'fill')).toHaveLength(0);
        proxy.step(Infinity);
        proxy.prepare();
        expect(filled('rgba(108, 108, 108, 0.125)')).toBe(1);
    });
});

describe('createCanvasProxyController', () => {
    let ctx: FakeCtx;

    beforeEach(() => {
        vi.stubGlobal('Path2D', FakePath2D);
        ctx = makeCtx();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
            () => ctx as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            (el: Element) => fakeComputedStyle(el) as CSSStyleDeclaration,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    const lastPaint = () => [...ctx.calls].reverse().find(c => c.op === 'fillRect' || c.op === 'clearRect')?.op;

    it('shows the proxy by drawing and hides it by clearing, two frames after settle', () => {
        const { container, svg } = buildDiagram();
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
        });
        expect(ctl.begin()).toBe(true);
        expect(container.hasAttribute(GESTURE_PROXY_ATTR)).toBe(true);
        ctl.frame({ x: 0, y: 0, w: 1000, h: 800 });
        expect(lastPaint()).toBe('fillRect');
        ctl.settle();
        frames.shift()!(0);
        expect(lastPaint()).toBe('fillRect');
        frames.shift()!(0);
        expect(lastPaint()).toBe('clearRect');
        expect(container.hasAttribute(GESTURE_PROXY_ATTR)).toBe(false);
    });

    it('never restyles the canvas: any style change re-layerizes the whole diagram', () => {
        const { container, svg } = buildDiagram();
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        ctl.begin();
        const canvas = container.querySelector('canvas.nad-canvas-proxy') as HTMLCanvasElement;
        expect(canvas.style.pointerEvents).toBe('none');
        expect(canvas.style.willChange).toBe('transform');
        const style = canvas.getAttribute('style');
        ctl.frame({ x: 0, y: 0, w: 500, h: 400 });
        ctl.hide();
        ctl.begin();
        ctl.frame({ x: 0, y: 0, w: 1000, h: 800 });
        ctl.hide();
        expect(canvas.getAttribute('style')).toBe(style);
        expect(container.querySelectorAll('canvas.nad-canvas-proxy')).toHaveLength(1);
    });

    it('a new gesture cancels a pending settle', () => {
        const { container, svg } = buildDiagram();
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        ctl.begin();
        ctl.frame({ x: 0, y: 0, w: 1000, h: 800 });
        ctl.settle();
        ctl.begin();
        ctl.frame({ x: 0, y: 0, w: 500, h: 400 });
        while (frames.length) frames.shift()!(0);
        expect(lastPaint()).toBe('fillRect');
        expect(container.hasAttribute(GESTURE_PROXY_ATTR)).toBe(true);
    });

    it('rebuilds once changes pause, on idle, but not after dispose', () => {
        vi.useFakeTimers();
        const { container, svg } = buildDiagram();
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        const canvases = () => container.querySelectorAll('canvas.nad-canvas-proxy');
        ctl.invalidate();
        vi.advanceTimersByTime(400);
        ctl.invalidate(); // a burst (Inspect typing): the quiet time restarts
        vi.advanceTimersByTime(500);
        expect(canvases()).toHaveLength(0);
        vi.advanceTimersByTime(400); // 600 ms quiet + the idle fallback
        expect(canvases()).toHaveLength(1);
        ctl.dispose();
        expect(canvases()).toHaveLength(0);
        ctl.invalidate();
        ctl.dispose();
        vi.advanceTimersByTime(2000);
        expect(canvases()).toHaveLength(0);
    });

    it('re-bakes the overview cache on idle after a panel resize', () => {
        vi.useFakeTimers();
        const { container, svg } = buildDiagram();
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
        });
        ctl.prewarm();
        vi.advanceTimersByTime(300);
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 600 });
        ctx.calls = [];
        ctl.begin();
        ctl.frame({ x: 0, y: 0, w: 1000, h: 800 });
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(0);
        ctl.hide();
        ctl.prewarm();
        vi.advanceTimersByTime(300);
        ctx.calls = [];
        ctl.begin();
        ctl.frame({ x: 0, y: 0, w: 1000, h: 800 });
        expect(opsOf(ctx.calls, 'drawImage')).toHaveLength(1);
    });

    it('returns false when there is no live diagram', () => {
        const ctl = createCanvasProxyController({
            getLiveSvg: () => null, getContainer: () => null, getExtent: () => null,
        });
        expect(ctl.begin()).toBe(false);
    });

    it('returns false without Path2D (jsdom), so the gesture takes the classic path', () => {
        vi.stubGlobal('Path2D', undefined);
        const { container, svg } = buildDiagram();
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        expect(ctl.begin()).toBe(false);
        expect(container.querySelector('canvas')).toBeNull();
    });

    it('does not retry a build that threw until the diagram changes', () => {
        const { container, svg } = buildDiagram();
        const cs = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('boom'); });
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        expect(ctl.begin()).toBe(false);
        const calls = cs.mock.calls.length;
        expect(ctl.begin()).toBe(false);
        expect(cs.mock.calls.length).toBe(calls); // no second full build
        cs.mockImplementation((el: Element) => fakeComputedStyle(el) as CSSStyleDeclaration);
        ctl.invalidate();
        expect(ctl.begin()).toBe(true);
    });

    it('returns false when the browser gives no 2D context', () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
        const { container, svg } = buildDiagram();
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        expect(ctl.begin()).toBe(false);
        expect(container.hasAttribute(GESTURE_PROXY_ATTR)).toBe(false);
    });

    it('reads the flow values and labels in idle slices after the build, never during a gesture', () => {
        vi.useFakeTimers();
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
        const { container, svg } = buildTextDiagram();
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => EXT,
        });
        const texts = () => opsOf(ctx.calls, 'fillText').map(c => c.text);
        ctl.begin(); // the network is built now, synchronously
        ctl.frame(VIEW10);
        expect(texts()).toHaveLength(0);
        vi.advanceTimersByTime(1000); // no slice while the proxy covers the diagram
        ctx.calls = [];
        ctl.frame(VIEW10);
        expect(texts()).toHaveLength(0);
        ctl.hide(); // the gesture is over: the slices resume
        vi.advanceTimersByTime(100);
        ctx.calls = [];
        ctl.begin();
        ctl.frame(VIEW10);
        expect(texts()).toEqual(expect.arrayContaining(['-19', '7', 'BUS 400kV']));
    });

    it('waits for the panel to be shown before building: the labels need its layout', () => {
        const { container, svg } = buildDiagram();
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 0 });
        const ctl = createCanvasProxyController({
            getLiveSvg: () => svg, getContainer: () => container, getExtent: () => null,
        });
        expect(ctl.begin()).toBe(false);
        expect(container.querySelector('canvas')).toBeNull();
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1000 });
        expect(ctl.begin()).toBe(true);
    });
});
