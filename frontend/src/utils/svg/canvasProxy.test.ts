// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseTransform, buildCanvasProxy, createCanvasProxyController, GESTURE_PROXY_ATTR } from './canvasProxy';

const SVG_NS = 'http://www.w3.org/2000/svg';

// jsdom has neither Path2D nor a 2D canvas context: record what the proxy builds / draws.
class FakePath2D {
    ops: Array<[string, ...number[]]> = [];
    moveTo(x: number, y: number) { this.ops.push(['moveTo', x, y]); }
    lineTo(x: number, y: number) { this.ops.push(['lineTo', x, y]); }
    closePath() { this.ops.push(['closePath']); }
    ellipse(x: number, y: number, rx: number, ry: number) { this.ops.push(['ellipse', x, y, rx, ry]); }
    addPath() { this.ops.push(['addPath']); }
}

interface FakeCtx {
    calls: Array<{ op: string; path?: FakePath2D; lineWidth?: number; style?: string; alpha?: number }>;
    lineWidth: number;
    strokeStyle: string;
    fillStyle: string;
    globalAlpha: number;
    lineCap: string;
    lineJoin: string;
    setTransform: () => void;
    setLineDash: () => void;
    fillRect: () => void;
    clearRect: () => void;
    fill: (p: FakePath2D) => void;
    stroke: (p: FakePath2D) => void;
    drawImage: () => void;
}

const makeCtx = (): FakeCtx => {
    const ctx: FakeCtx = {
        calls: [],
        lineWidth: 1, strokeStyle: '', fillStyle: '', globalAlpha: 1, lineCap: '', lineJoin: '',
        setTransform: () => {},
        setLineDash: () => {},
        fillRect: () => { ctx.calls.push({ op: 'fillRect', style: ctx.fillStyle }); },
        clearRect: () => { ctx.calls.push({ op: 'clearRect' }); },
        fill: (p) => { ctx.calls.push({ op: 'fill', path: p, style: ctx.fillStyle, alpha: ctx.globalAlpha }); },
        stroke: (p) => { ctx.calls.push({ op: 'stroke', path: p, style: ctx.strokeStyle, lineWidth: ctx.lineWidth, alpha: ctx.globalAlpha }); },
        drawImage: () => { ctx.calls.push({ op: 'drawImage' }); },
    };
    return ctx;
};

// Computed styles keyed off the classes the NAD uses (jsdom does not resolve
// pypowsybl's CSS, so the test supplies what Chrome would compute).
const fakeComputedStyle = (el: Element): Partial<CSSStyleDeclaration> => {
    const cls = el.getAttribute('class') ?? '';
    const parentCls = el.parentElement?.getAttribute('class') ?? '';
    const base = {
        display: 'inline', visibility: 'visible', opacity: '1', strokeOpacity: '1', fillOpacity: '1',
        strokeDasharray: 'none', backgroundColor: '', getPropertyValue: () => '',
    };
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
});
