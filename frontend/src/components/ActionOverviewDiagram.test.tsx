// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ActionOverviewDiagram from './ActionOverviewDiagram';
import { interactionLogger } from '../utils/interactionLogger';
import type { ActionDetail, DiagramData, EdgeMeta, MetadataIndex, NodeMeta } from '../types';

// ------------------------------------------------------------
// Test fixtures
//
// A 4-node square with an extra isolated VL, mirrored from the
// svgUtils action-overview test fixture so the expected pin
// anchors and fit rectangles stay consistent between the two
// test suites.
// ------------------------------------------------------------
const makeMetaIndex = (): MetadataIndex => {
    const nodes: NodeMeta[] = [
        { equipmentId: 'VL_N1', svgId: 'svg-n1', x: 0, y: 0 },
        { equipmentId: 'VL_N2', svgId: 'svg-n2', x: 100, y: 0 },
        { equipmentId: 'VL_N3', svgId: 'svg-n3', x: 0, y: 100 },
        { equipmentId: 'VL_N4', svgId: 'svg-n4', x: 100, y: 100 },
        { equipmentId: 'VL_FAR', svgId: 'svg-far', x: 500, y: 500 },
    ];
    const edges: EdgeMeta[] = [
        { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'svg-n1', node2: 'svg-n2' },
        { equipmentId: 'LINE_B', svgId: 'svg-line-b', node1: 'svg-n2', node2: 'svg-n4' },
        { equipmentId: 'LINE_C', svgId: 'svg-line-c', node1: 'svg-n1', node2: 'svg-n3' },
        { equipmentId: 'LINE_D', svgId: 'svg-line-d', node1: 'svg-n3', node2: 'svg-n4' },
    ];
    return {
        nodesByEquipmentId: new Map(nodes.map(n => [n.equipmentId, n] as const)),
        nodesBySvgId: new Map(nodes.map(n => [n.svgId, n] as const)),
        edgesByEquipmentId: new Map(edges.map(e => [e.equipmentId, e] as const)),
        edgesByNode: new Map(),
    };
};

const makeAction = (overrides: Partial<ActionDetail> = {}): ActionDetail => ({
    description_unitaire: 'test action',
    rho_before: null,
    rho_after: null,
    max_rho: null,
    max_rho_line: '',
    is_rho_reduction: false,
    ...overrides,
});

// A minimal NAD-like SVG background — the test component
// parses this via innerHTML and queries for the injected pin
// layer. Includes:
//  - `.nad-vl-nodes circle[r="40"]` so the pin sizing logic
//    (which reads the VL circle radius) has something realistic
//    to latch on
//  - `<g id="svg-line-X">` stubs for every line referenced by
//    the metadata index so `applyActionOverviewHighlights` can
//    locate and clone the contingency / overload edges.
const makeN1Diagram = (): DiagramData => ({
    svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 700 700">' +
        '  <g class="nad-vl-nodes"><circle r="40"/></g>' +
        '  <g class="nad-edges">' +
        '    <g id="svg-line-a"><line x1="0" y1="0" x2="100" y2="0"/></g>' +
        '    <g id="svg-line-b"><line x1="100" y1="0" x2="100" y2="100"/></g>' +
        '    <g id="svg-line-c"><line x1="0" y1="0" x2="0" y2="100"/></g>' +
        '    <g id="svg-line-d"><line x1="0" y1="100" x2="100" y2="100"/></g>' +
        '  </g>' +
        '</svg>',
    metadata: null,
    lines_overloaded: ['LINE_B'],
    lines_overloaded_rho: [1.03],
});

const makeActions = (): Record<string, ActionDetail> => ({
    'disco_LINE_A': makeAction({
        action_topology: {
            lines_ex_bus: { LINE_A: -1 },
            lines_or_bus: { LINE_A: -1 },
            gens_bus: {},
            loads_bus: {},
        },
        max_rho: 0.5, // green
        max_rho_line: 'LINE_D',
    }),
    'coupling_VL_FAR': makeAction({
        description_unitaire: "Ouverture du poste 'VL_FAR'",
        max_rho: 1.1, // red
        max_rho_line: 'LINE_B',
    }),
});

const defaultProps = () => ({
    n1Diagram: makeN1Diagram(),
    n1MetaIndex: makeMetaIndex(),
    actions: makeActions(),
    monitoringFactor: 0.95,
    onActionSelect: vi.fn(),
    contingency: 'LINE_C' as string | null,
    overloadedLines: ['LINE_B'] as readonly string[],
    inspectableItems: ['LINE_A', 'LINE_B', 'LINE_C', 'LINE_D', 'VL_N1', 'VL_FAR'],
    visible: true,
});

describe('ActionOverviewDiagram', () => {
    afterEach(() => {
        cleanup();
    });

    it('injects the N-1 SVG as background into its own container', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        // The overview SVG (from innerHTML injection) should live
        // inside the nad-action-overview-container div.
        const host = container.querySelector('.nad-action-overview-container');
        expect(host).not.toBeNull();
        const svg = host!.querySelector('svg');
        expect(svg).not.toBeNull();
        // width/height are normalised to fill the container
        expect(svg!.getAttribute('width')).toBe('100%');
        expect(svg!.getAttribute('height')).toBe('100%');
        expect(svg!.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    });

    it('marks the SVG with nad-overview-dimmed class and inserts a dim rect overlay', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        const host = container.querySelector('.nad-action-overview-container');
        const svg = host!.querySelector('svg');
        expect(svg!.classList.contains('nad-overview-dimmed')).toBe(true);
        expect(svg!.querySelector('rect.nad-overview-dim-rect')).not.toBeNull();
        // Original SVG content stays at the SVG root (no wrapper group).
        expect(svg!.querySelector('.nad-edges')).not.toBeNull();
        expect(svg!.querySelector('.nad-vl-nodes')).not.toBeNull();
    });

    it('clears the container when n1Diagram becomes null', () => {
        const props = defaultProps();
        const { container, rerender } = render(<ActionOverviewDiagram {...props} />);
        const host = container.querySelector('.nad-action-overview-container')!;
        expect(host.querySelector('svg')).not.toBeNull();

        rerender(<ActionOverviewDiagram {...props} n1Diagram={null as unknown as DiagramData} />);
        expect(host.querySelector('svg')).toBeNull();
    });

    it('renders one pin per simulated action using the severity palette', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        const pins = container.querySelectorAll('g.nad-action-overview-pin');
        expect(pins.length).toBe(2);
        const fills = Array.from(pins).map(p => p.querySelector('path')?.getAttribute('fill'));
        // disco_LINE_A: rho=0.5 → green; coupling_VL_FAR: rho=1.1 → red
        expect(fills).toEqual(expect.arrayContaining(['#28a745', '#dc3545']));
    });

    it('draws pins WITHOUT a stroke outline', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        // path lives inside the inner .nad-action-overview-pin-body
        // wrapper so the rescaler can upscale it on unzoom.
        const paths = container.querySelectorAll('g.nad-action-overview-pin path');
        expect(paths.length).toBeGreaterThan(0);
        paths.forEach(p => {
            expect(p.getAttribute('stroke')).toBe('none');
            expect(p.hasAttribute('stroke-width')).toBe(false);
        });
    });

    it('each pin displays the rounded max loading as its label', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        const texts = Array.from(container.querySelectorAll('g.nad-action-overview-pin text'))
            .map(t => t.textContent);
        // 0.5 → "50%", 1.1 → "110%"
        expect(texts).toEqual(expect.arrayContaining(['50%', '110%']));
    });

    it('pin anchors on the asset highlighted by the corresponding card', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        const groups = Array.from(container.querySelectorAll('g.nad-action-overview-pin'));
        const byId = Object.fromEntries(groups.map(g => [
            g.getAttribute('data-action-id'),
            g.getAttribute('transform'),
        ]));
        // disco_LINE_A anchors on LINE_A midpoint (50, 0)
        expect(byId['disco_LINE_A']).toBe('translate(50 0)');
        // coupling_VL_FAR anchors on the VL node (500, 500)
        expect(byId['coupling_VL_FAR']).toBe('translate(500 500)');
    });

    it('double-clicking a pin invokes onActionSelect with its id (drill-down path)', () => {
        // Semantics changed in the click-vs-dblclick split:
        //  - single-click → opens the popover (separate test below)
        //  - double-click → selects the action (this test)
        const onActionSelect = vi.fn();
        const { container } = render(
            <ActionOverviewDiagram {...defaultProps()} onActionSelect={onActionSelect} />,
        );
        const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
        expect(pin).not.toBeNull();
        fireEvent.doubleClick(pin!);
        expect(onActionSelect).toHaveBeenCalledWith('disco_LINE_A');
    });

    it('auto-zooms to the fit rectangle on mount', () => {
        const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        // Fit rect unions:
        //   contingency LINE_C:  (0,0)..(0,100)
        //   overload   LINE_B:   (100,0)..(100,100)
        //   pins:                (50, 0), (500, 500)
        // Raw bbox = [0..500, 0..500] → 5% pad → [-25..525, -25..525]
        // So w=550, h=550, x=-25, y=-25.
        const svg = container.querySelector('.nad-action-overview-container svg');
        const vb = svg!.getAttribute('viewBox')!;
        const parts = vb.split(/\s+/).map(parseFloat);
        expect(parts[0]).toBeCloseTo(-25, 0);
        expect(parts[1]).toBeCloseTo(-25, 0);
        expect(parts[2]).toBeCloseTo(550, 0);
        expect(parts[3]).toBeCloseTo(550, 0);
    });

    it('no longer renders the severity / action-type filter controls (driven by the sidebar rings)', () => {
        const { queryByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
        // Severity (action-card colour) toggles + bulk buttons removed —
        // they are redundant with the sidebar's ActionFilterRings.
        for (const c of ['green', 'orange', 'red', 'grey']) {
            expect(queryByTestId(`filter-category-${c}`)).not.toBeInTheDocument();
        }
        expect(queryByTestId('filter-select-all')).not.toBeInTheDocument();
        expect(queryByTestId('filter-select-none')).not.toBeInTheDocument();
        // Action-type chip row removed.
        expect(queryByTestId('overview-action-type-filter')).not.toBeInTheDocument();
        // Threshold moved to the sidebar's ActionFilterRings (compact
        // single-row layout). The non-redundant remaining filters stay
        // in the overview header.
        expect(queryByTestId('filter-threshold')).not.toBeInTheDocument();
        expect(queryByTestId('filter-threshold-input')).not.toBeInTheDocument();
        expect(queryByTestId('filter-show-unsimulated')).toBeInTheDocument();
        expect(queryByTestId('filter-combined-only')).toBeInTheDocument();
    });

    it('shows the pin count in the header', () => {
        const { getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
        // The counter is now a compact 📍<n> chip — the full
        // "on the N-1 network" phrasing moved to the title tooltip.
        const counter = getByTestId('overview-pin-counter');
        expect(counter.textContent).toContain('2');
        expect(counter.getAttribute('title')).toContain('2 pins on the N-1 network');
    });

    it('badges the pins whose card the action feed lists, fades the hidden ones, counts the listed', () => {
        const { container, getByTestId } = render(
            <ActionOverviewDiagram
                {...defaultProps()}
                feedReveal={{ displayedIds: new Set(['disco_LINE_A']), hiddenIds: new Set(['coupling_VL_FAR']) }}
            />,
        );
        const pin = (id: string) => container.querySelector(`.nad-action-overview-pin[data-action-id="${id}"]`);
        expect(pin('disco_LINE_A')?.getAttribute('data-feed')).toBe('shown');
        expect(pin('disco_LINE_A')?.querySelector('.cs4g-pin-feed-badge')).not.toBeNull();
        // Hidden suggestion: still pinned, translucent, without the badge.
        expect(pin('coupling_VL_FAR')?.getAttribute('data-feed')).toBe('hidden');
        expect(Number(pin('coupling_VL_FAR')?.getAttribute('opacity'))).toBeLessThan(1);
        expect(pin('coupling_VL_FAR')?.querySelector('.cs4g-pin-feed-badge')).toBeNull();
        expect(getByTestId('overview-feed-legend').textContent).toContain('1 in feed');
    });

    it('omits the feed legend when the feed ids are not wired', () => {
        const { queryByTestId, container } = render(<ActionOverviewDiagram {...defaultProps()} />);
        expect(queryByTestId('overview-feed-legend')).not.toBeInTheDocument();
        expect(container.querySelector('.cs4g-pin-feed-badge')).toBeNull();
    });

    it('omits the feed legend while no pin carries the badge', () => {
        const { queryByTestId } = render(
            <ActionOverviewDiagram
                {...defaultProps()}
                feedReveal={{ displayedIds: new Set(['not_on_the_map']), hiddenIds: new Set(['disco_LINE_A']) }}
            />,
        );
        expect(queryByTestId('overview-feed-legend')).not.toBeInTheDocument();
    });

    it('hides itself when visible=false', () => {
        const { container } = render(
            <ActionOverviewDiagram {...defaultProps()} visible={false} />,
        );
        const root = container.querySelector('[data-testid="action-overview-diagram"]') as HTMLElement;
        expect(root.style.display).toBe('none');
    });

    it('shows the "no analysis yet" empty state when there are no actions', () => {
        const { getByText } = render(
            <ActionOverviewDiagram {...defaultProps()} actions={{}} />,
        );
        expect(getByText(/Run.*Analyze.*Suggest/)).toBeInTheDocument();
    });

    it('shows the "no background" empty state when no N-1 diagram is loaded', () => {
        const { getByText } = render(
            <ActionOverviewDiagram {...defaultProps()} n1Diagram={null} />,
        );
        expect(getByText(/Load a contingency first/)).toBeInTheDocument();
    });

    describe('local zoom controls', () => {
        it('clicking "+" shrinks the viewBox around its centre', () => {
            const { container, getByTitle } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const before = svg.getAttribute('viewBox')!.split(/\s+/).map(parseFloat);
            fireEvent.click(getByTitle('Zoom In'));
            const after = svg.getAttribute('viewBox')!.split(/\s+/).map(parseFloat);
            // Width shrinks by 0.8×
            expect(after[2]).toBeCloseTo(before[2] * 0.8, 1);
            expect(after[3]).toBeCloseTo(before[3] * 0.8, 1);
        });

        it('clicking "-" grows the viewBox around its centre', () => {
            const { container, getByTitle } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const before = svg.getAttribute('viewBox')!.split(/\s+/).map(parseFloat);
            fireEvent.click(getByTitle('Zoom Out'));
            const after = svg.getAttribute('viewBox')!.split(/\s+/).map(parseFloat);
            expect(after[2]).toBeCloseTo(before[2] * 1.25, 1);
            expect(after[3]).toBeCloseTo(before[3] * 1.25, 1);
        });

        it('Fit button restores the auto-fit rectangle after panning', () => {
            const { container, getByTitle } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const fit = svg.getAttribute('viewBox')!;
            fireEvent.click(getByTitle('Zoom In'));
            expect(svg.getAttribute('viewBox')).not.toBe(fit);
            fireEvent.click(getByTitle(/Reset view/i));
            expect(svg.getAttribute('viewBox')).toBe(fit);
        });
    });

    describe('asset-focus inspect search', () => {
        beforeEach(() => {
            // `usePanZoom` debounces the React commit through setTimeout;
            // use fake timers so the tests can deterministically flush
            // any pending commits.
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('typing an exact equipment id zooms onto it', () => {
            const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const fitVb = svg.getAttribute('viewBox')!;

            const input = getByTestId('overview-inspect-input') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'VL_FAR' } });

            const focused = svg.getAttribute('viewBox')!;
            expect(focused).not.toBe(fitVb);
            // VL_FAR is a single-point → expanded to 150x150 around (500, 500)
            const parts = focused.split(/\s+/).map(parseFloat);
            expect(parts[0]).toBeCloseTo(500 - 75 - 150 * 0.35, 0);
            expect(parts[1]).toBeCloseTo(500 - 75 - 150 * 0.35, 0);
        });

        it('does NOT re-focus on the same asset after the user zooms out (regression)', () => {
            // This is the "sticking" bug: after focusing on an asset,
            // unzooming used to re-run the effect and snap back onto
            // the asset. The fix is `lastFocusedRef` — here we assert
            // that a subsequent zoom-out is preserved.
            const { container, getByTitle, getByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} />,
            );
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const input = getByTestId('overview-inspect-input') as HTMLInputElement;

            // Focus on VL_FAR
            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            const focusedVb = svg.getAttribute('viewBox')!;

            // Zoom out — this changes pz.viewBox and therefore the
            // memoised pz object identity, which previously caused
            // the inspect effect to re-fire and snap back onto VL_FAR.
            fireEvent.click(getByTitle('Zoom Out'));
            // Flush any pending rAF / setTimeout commits
            act(() => { vi.runAllTimers(); });

            const afterZoomOut = svg.getAttribute('viewBox')!;
            expect(afterZoomOut).not.toBe(focusedVb);

            // One more zoom-out: the view should continue to widen,
            // NOT snap back onto the asset.
            const afterPrevZoom = svg.getAttribute('viewBox')!;
            fireEvent.click(getByTitle('Zoom Out'));
            act(() => { vi.runAllTimers(); });
            const afterZoomOut2 = svg.getAttribute('viewBox')!;
            expect(afterZoomOut2).not.toBe(afterPrevZoom);
            expect(afterZoomOut2).not.toBe(focusedVb);
        });

        it('clearing the inspect query returns the view to the auto-fit rectangle', () => {
            const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const fitVb = svg.getAttribute('viewBox')!;

            const input = getByTestId('overview-inspect-input') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            expect(svg.getAttribute('viewBox')).not.toBe(fitVb);

            fireEvent.change(input, { target: { value: '' } });
            expect(svg.getAttribute('viewBox')).toBe(fitVb);
        });

        it('Fit button re-enables focusing on the same asset again', () => {
            // After a Fit reset, typing the same asset id should
            // focus again — the reset clears `lastFocusedRef` so the
            // consume-once guard no longer swallows the re-entry.
            const { container, getByTitle, getByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} />,
            );
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const input = getByTestId('overview-inspect-input') as HTMLInputElement;

            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            const focusedVb1 = svg.getAttribute('viewBox')!;

            // Back to fit
            fireEvent.click(getByTitle(/Reset view/i));
            fireEvent.change(input, { target: { value: '' } });

            // Re-type the same asset id — should focus again, NOT
            // silently skip because the ref remembered it.
            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            const focusedVb2 = svg.getAttribute('viewBox')!;
            expect(focusedVb2).toBe(focusedVb1);
        });
    });

    describe('pin sizing and screen-constant rescaling', () => {
        it('sizes pins from the VL circle radius (40 in the fixture)', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            // The teardrop path uses the VL circle radius R=40
            // from makeN1Diagram(), so the arc command must
            // reference "A 40 40" in its `d` attribute.
            const path = container.querySelector('g.nad-action-overview-pin path');
            expect(path).not.toBeNull();
            expect(path!.getAttribute('d')).toContain('A 40 40');
        });

        it('wraps every pin glyph in a rescalable .nad-action-overview-pin-body', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const bodies = container.querySelectorAll('g.nad-action-overview-pin-body');
            expect(bodies.length).toBe(2);
            // Outer translate stays clean, body carries the scale.
            bodies.forEach(b => {
                expect(b.getAttribute('transform')).toMatch(/^scale\(/);
            });
        });

        it('rescales pins when the svg viewBox attribute changes', () => {
            // MutationObserver on the svg's viewBox attribute is
            // what keeps pins screen-constant during wheel/drag.
            // Directly mutating viewBox here simulates usePanZoom's
            // fast-path DOM writes and verifies the rescaler reacts.
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg') as unknown as SVGGraphicsElement;
            const svgContainer = container.querySelector('.nad-action-overview-container')!;

            // Mock clientWidth so the viewBox-based pxPerSvgUnit
            // calculation yields 0.1 (clientWidth / viewBoxWidth).
            // viewBox will be "0 0 99999 99999", so clientWidth = 9999.9
            Object.defineProperty(svgContainer, 'clientWidth', { value: 9999.9, configurable: true });

            // Mutate the viewBox — the MutationObserver schedules
            // a rAF, so we wait one animation frame to read the
            // committed scale.
            (svg as unknown as SVGSVGElement).setAttribute('viewBox', '0 0 99999 99999');

            return new Promise<void>(resolve => {
                // First a microtask flush to let MO deliver its records,
                // then a rAF to let the throttled rescaler run.
                queueMicrotask(() => {
                    requestAnimationFrame(() => {
                        const body = container.querySelector('g.nad-action-overview-pin-body')!;
                        const match = body.getAttribute('transform')!.match(/^scale\(([0-9.]+)\)$/);
                        expect(match).not.toBeNull();
                        const scale = parseFloat(match![1]);
                        // pxPerSvgUnit=0.1, MIN_SCREEN_RADIUS_PX=22,
                        // baseR=40, viewBoxMinR=99999/50≈2000
                        // effectiveR=max(40, 220, 2000)=2000 → scale≈50
                        expect(scale).toBeCloseTo(99999 / 50 / 40, 1);
                        resolve();
                    });
                });
            });
        });

        it('does not upscale pins when VL circles are already big enough on screen', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svgContainer = container.querySelector('.nad-action-overview-container')!;
            const svg = svgContainer.querySelector('svg') as unknown as SVGGraphicsElement;
            // viewBox "0 0 100 100", clientWidth=200 → pxPerSvgUnit=2
            // → VL circle with r=40 = 80 screen px, well above the 22-px floor.
            Object.defineProperty(svgContainer, 'clientWidth', { value: 200, configurable: true });
            (svg as unknown as SVGSVGElement).setAttribute('viewBox', '0 0 100 100');

            return new Promise<void>(resolve => {
                queueMicrotask(() => {
                    requestAnimationFrame(() => {
                        const body = container.querySelector('g.nad-action-overview-pin-body')!;
                        expect(body.getAttribute('transform')).toBe('scale(1)');
                        resolve();
                    });
                });
            });
        });

        it('rAF-throttles rescale: many viewBox mutations in a row trigger AT MOST one rescale per animation frame', () => {
            // Regression guard for the "Page ne répondant pas" lag:
            // the wheel-zoom path in usePanZoom mutates the viewBox
            // many times per frame; without rAF batching that would
            // call getScreenCTM (a forced layout) on every mutation
            // and freeze the page on large grids.
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg') as unknown as SVGGraphicsElement;
            let ctmCalls = 0;
            svg.getScreenCTM = (() => {
                ctmCalls += 1;
                return { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 };
            }) as unknown as SVGGraphicsElement['getScreenCTM'];

            // Reset the counter — initial pin mount + dim wrap may
            // have invoked getScreenCTM already; we only care about
            // the burst that follows the rapid viewBox writes.
            ctmCalls = 0;

            // Simulate a wheel-zoom burst: 20 viewBox writes in a row.
            for (let i = 1; i <= 20; i++) {
                (svg as unknown as SVGSVGElement).setAttribute('viewBox', `0 0 ${1000 + i} ${1000 + i}`);
            }

            return new Promise<void>(resolve => {
                queueMicrotask(() => {
                    requestAnimationFrame(() => {
                        // Even though we wrote viewBox 20 times, the
                        // throttled rescaler should have run AT MOST
                        // once for that frame (and called getScreenCTM
                        // exactly once inside that single rescale).
                        expect(ctmCalls).toBeLessThanOrEqual(1);
                        resolve();
                    });
                });
            });
        });
    });

    describe('contingency + overload highlights', () => {
        it('renders contingency + overload highlight clones via applyActionOverviewHighlights', () => {
            // The fixture sets contingency='LINE_C' and overloadedLines=['LINE_B'].
            // Both must produce a clone inside the .nad-overview-highlight-layer.
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const layer = container.querySelector('.nad-overview-highlight-layer');
            expect(layer).not.toBeNull();
            expect(layer!.querySelector('.nad-contingency-highlight')).not.toBeNull();
            expect(layer!.querySelector('.nad-overloaded')).not.toBeNull();
        });

        it('highlight and pin layers are direct children of the SVG', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const highlightLayer = svg.querySelector(':scope > g.nad-overview-highlight-layer');
            const pinLayer = svg.querySelector(':scope > g.nad-action-overview-pins');
            expect(highlightLayer).not.toBeNull();
            expect(pinLayer).not.toBeNull();
        });

        it('places highlight layer BEFORE NAD content (at SVG start) and BEFORE dim rect and pins', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const children = Array.from(svg.children);
            const highlightIdx = children.findIndex(c => c.classList.contains('nad-overview-highlight-layer'));
            const dimIdx = children.findIndex(c => c.classList.contains('nad-overview-dim-rect'));
            const pinIdx = children.findIndex(c => c.classList.contains('nad-action-overview-pins'));
            expect(highlightIdx).toBeGreaterThan(-1);
            expect(dimIdx).toBeGreaterThan(-1);
            expect(pinIdx).toBeGreaterThan(-1);
            // Highlights at start, before everything else
            expect(highlightIdx).toBeLessThan(dimIdx);
            expect(highlightIdx).toBeLessThan(pinIdx);
        });

        it('refreshes highlights when contingency changes', () => {
            const { container, rerender } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const layer1 = container.querySelector('.nad-overview-highlight-layer');
            expect(layer1).not.toBeNull();
            // Change contingency to a non-resolvable id — the
            // highlight layer should be wiped (1 contingency lost),
            // leaving only the overload clone.
            rerender(<ActionOverviewDiagram {...defaultProps()} contingency={null} />);
            const layer2 = container.querySelector('.nad-overview-highlight-layer');
            expect(layer2).not.toBeNull();
            expect(layer2!.querySelector('.nad-contingency-highlight')).toBeNull();
            expect(layer2!.querySelector('.nad-overloaded')).not.toBeNull();
        });
    });

    describe('dim background (rect overlay, no opacity group or per-child opacity)', () => {
        it('inserts a white dim rect overlay instead of wrapping in an opacity group or using CSS per-child opacity', () => {
            // The old <g opacity="0.35"> wrapper created an SVG
            // transparency group (Layerize: 31s). CSS per-child
            // opacity still created stacking contexts (25s). Now we
            // use a single white <rect> overlay — zero stacking contexts.
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const dimRect = svg.querySelector('rect.nad-overview-dim-rect');
            expect(dimRect).not.toBeNull();
            expect(dimRect!.getAttribute('fill')).toBe('white');
            expect(dimRect!.getAttribute('opacity')).toBe('0.65');
            expect(dimRect!.getAttribute('pointer-events')).toBe('none');
            // No <g> opacity wrapper should exist.
            expect(svg.querySelector('g.nad-overview-dim-layer')).toBeNull();
        });

        it('dim rect covers the viewBox with margin', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const dimRect = svg.querySelector('rect.nad-overview-dim-rect')!;
            // viewBox="-50 -50 700 700", margin = 700 * 0.1 = 70
            const x = parseFloat(dimRect.getAttribute('x')!);
            const y = parseFloat(dimRect.getAttribute('y')!);
            const w = parseFloat(dimRect.getAttribute('width')!);
            const h = parseFloat(dimRect.getAttribute('height')!);
            expect(x).toBeCloseTo(-50 - 70, 0);
            expect(y).toBeCloseTo(-50 - 70, 0);
            expect(w).toBeCloseTo(700 + 140, 0);
            expect(h).toBeCloseTo(700 + 140, 0);
        });

        it('pin layer is a direct child of the SVG (not nested)', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const pinLayer = svg.querySelector(':scope > g.nad-action-overview-pins');
            expect(pinLayer).not.toBeNull();
        });

        it('visual stack order: highlights → NAD content → dim rect → pins', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const svg = container.querySelector('.nad-action-overview-container svg')!;
            const children = Array.from(svg.children);
            const highlightIdx = children.findIndex(c => c.classList.contains('nad-overview-highlight-layer'));
            const dimIdx = children.findIndex(c => c.classList.contains('nad-overview-dim-rect'));
            const pinIdx = children.findIndex(c => c.classList.contains('nad-action-overview-pins'));
            expect(highlightIdx).toBeGreaterThan(-1);
            expect(dimIdx).toBeGreaterThan(-1);
            expect(pinIdx).toBeGreaterThan(-1);
            // Highlights first (behind NAD), dim rect after NAD, pins last
            expect(highlightIdx).toBeLessThan(dimIdx);
            expect(dimIdx).toBeLessThan(pinIdx);
        });
    });

    describe('click popover (single-click on pin)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('opens an ActionCard popover on single-click (after the single-click delay)', async () => {
            const { container, queryByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            // Before clicking, no popover is mounted.
            expect(queryByTestId('action-overview-popover')).toBeNull();

            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            // The click action is deferred — popover is NOT up yet.
            expect(queryByTestId('action-overview-popover')).toBeNull();

            // Advance the single-click delay + flush React batching.
            act(() => { vi.advanceTimersByTime(300); });

            const popover = queryByTestId('action-overview-popover');
            expect(popover).not.toBeNull();
            expect(popover!.getAttribute('data-action-id')).toBe('disco_LINE_A');
            // The popover embeds the real ActionCard for this id.
            expect(popover!.querySelector('[data-testid="action-card-disco_LINE_A"]')).not.toBeNull();
        });

        it('does NOT open the popover when the user double-clicks the same pin', async () => {
            const onActionSelect = vi.fn();
            const { container, queryByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} onActionSelect={onActionSelect} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            // Simulate the real browser sequence: click, click, dblclick.
            fireEvent.click(pin!);
            fireEvent.click(pin!);
            fireEvent.doubleClick(pin!);
            act(() => { vi.advanceTimersByTime(500); });

            expect(queryByTestId('action-overview-popover')).toBeNull();
            expect(onActionSelect).toHaveBeenCalledWith('disco_LINE_A');
        });

        it('closes the popover when the ✕ button is clicked', async () => {
            const { container, getByTestId, queryByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });

            expect(queryByTestId('action-overview-popover')).not.toBeNull();
            fireEvent.click(getByTestId('action-overview-popover-close'));
            expect(queryByTestId('action-overview-popover')).toBeNull();
        });

        it('closes the popover when Escape is pressed', async () => {
            const { container, queryByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });

            expect(queryByTestId('action-overview-popover')).not.toBeNull();
            act(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            });
            expect(queryByTestId('action-overview-popover')).toBeNull();
        });

        it('clicking inside the popover does NOT dismiss it (stopPropagation)', async () => {
            const { container, getByTestId, queryByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });

            const popover = getByTestId('action-overview-popover');
            fireEvent.mouseDown(popover);
            expect(queryByTestId('action-overview-popover')).not.toBeNull();
        });

        it('clicking the ActionCard body inside the popover activates the drill-down and closes the popover', async () => {
            const onActionSelect = vi.fn();
            const { container, getByTestId, queryByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} onActionSelect={onActionSelect} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });

            const card = getByTestId('action-card-disco_LINE_A');
            fireEvent.click(card);
            expect(onActionSelect).toHaveBeenCalledWith('disco_LINE_A');
            // Popover should have been cleared as part of the activation flow.
            expect(queryByTestId('action-overview-popover')).toBeNull();
        });

        it('does not render the popover when the overview is hidden', async () => {
            const { container, rerender, queryByTestId } = render(
                <ActionOverviewDiagram {...defaultProps()} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            expect(queryByTestId('action-overview-popover')).not.toBeNull();

            rerender(<ActionOverviewDiagram {...defaultProps()} visible={false} />);
            expect(queryByTestId('action-overview-popover')).toBeNull();
        });

        it('records data-place-above and data-horizontal-align attributes from the placement helper', async () => {
            // Stub getBoundingClientRect on the pin so the click
            // handler captures a known screen position.  We pin
            // it to the bottom-right corner of the viewport
            // (1024x768 in jsdom by default) so the placement
            // helper picks above + end.
            const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]') as SVGGElement;
            pin.getBoundingClientRect = (() => ({
                left: 900, right: 920,
                top: 700, bottom: 720,
                width: 20, height: 20,
                x: 900, y: 700,
                toJSON: () => ({}),
            })) as unknown as SVGGElement['getBoundingClientRect'];

            fireEvent.click(pin);
            act(() => { vi.advanceTimersByTime(300); });

            const popover = getByTestId('action-overview-popover');
            expect(popover.getAttribute('data-place-above')).toBe('true');
            expect(popover.getAttribute('data-horizontal-align')).toBe('end');
            // Above placement → uses CSS `bottom`, not `top`.
            expect(popover.style.bottom).not.toBe('');
            expect(popover.style.top).toBe('');
        });

        it('renders the popover BELOW the pin when the pin is in the top of the viewport', async () => {
            const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]') as SVGGElement;
            pin.getBoundingClientRect = (() => ({
                left: 100, right: 120,
                top: 50, bottom: 70,
                width: 20, height: 20,
                x: 100, y: 50,
                toJSON: () => ({}),
            })) as unknown as SVGGElement['getBoundingClientRect'];

            fireEvent.click(pin);
            act(() => { vi.advanceTimersByTime(300); });

            const popover = getByTestId('action-overview-popover');
            expect(popover.getAttribute('data-place-above')).toBe('false');
            expect(popover.getAttribute('data-horizontal-align')).toBe('start');
            expect(popover.style.top).not.toBe('');
            expect(popover.style.bottom).toBe('');
        });

        it('calls onPinPreview with the action id on single-click', () => {
            const onPinPreview = vi.fn();
            const { container } = render(
                <ActionOverviewDiagram {...defaultProps()} onPinPreview={onPinPreview} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            expect(onPinPreview).toHaveBeenCalledWith('disco_LINE_A');
        });

        it('does NOT call onPinPreview on double-click (drill-down)', () => {
            const onPinPreview = vi.fn();
            const { container } = render(
                <ActionOverviewDiagram {...defaultProps()} onPinPreview={onPinPreview} />,
            );
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            fireEvent.click(pin!);
            fireEvent.doubleClick(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            // Double-click cancels the single-click timer, so onPinPreview
            // should NOT have been called.
            expect(onPinPreview).not.toHaveBeenCalled();
        });
    });

    describe('interaction logging', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            interactionLogger.clear();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        const lastLog = (type: string) =>
            interactionLogger.getLog().filter(e => e.type === type).pop();

        it('logs overview_shown when the component becomes visible', () => {
            render(<ActionOverviewDiagram {...defaultProps()} />);
            expect(lastLog('overview_shown')).toBeDefined();
            expect(lastLog('overview_shown')!.details).toHaveProperty('pin_count');
        });

        it('logs overview_hidden when visible flips false', () => {
            const { rerender } = render(<ActionOverviewDiagram {...defaultProps()} />);
            rerender(<ActionOverviewDiagram {...defaultProps()} visible={false} />);
            expect(lastLog('overview_hidden')).toBeDefined();
        });

        it('logs overview_pin_clicked on single-click (after the delay)', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            const entry = lastLog('overview_pin_clicked');
            expect(entry).toBeDefined();
            expect(entry!.details.action_id).toBe('disco_LINE_A');
        });

        it('logs overview_pin_double_clicked on double-click', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            fireEvent.click(pin!);
            fireEvent.doubleClick(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            const entry = lastLog('overview_pin_double_clicked');
            expect(entry).toBeDefined();
            expect(entry!.details.action_id).toBe('disco_LINE_A');
            // The single-click should NOT have been logged (cancelled by dblclick)
            expect(lastLog('overview_pin_clicked')).toBeUndefined();
        });

        it('logs overview_popover_closed with reason on close button', () => {
            const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            fireEvent.click(getByTestId('action-overview-popover-close'));
            const entry = lastLog('overview_popover_closed');
            expect(entry).toBeDefined();
            expect(entry!.details.reason).toBe('close_button');
        });

        it('logs overview_popover_closed with reason "escape" on Escape key', () => {
            const { container } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const pin = container.querySelector('g.nad-action-overview-pin[data-action-id="disco_LINE_A"]');
            fireEvent.click(pin!);
            act(() => { vi.advanceTimersByTime(300); });
            act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
            expect(lastLog('overview_popover_closed')!.details.reason).toBe('escape');
        });

        it('logs overview_zoom_in / overview_zoom_out / overview_zoom_fit on button clicks', () => {
            const { getByTitle } = render(<ActionOverviewDiagram {...defaultProps()} />);
            fireEvent.click(getByTitle('Zoom In'));
            expect(lastLog('overview_zoom_in')).toBeDefined();
            fireEvent.click(getByTitle('Zoom Out'));
            expect(lastLog('overview_zoom_out')).toBeDefined();
            fireEvent.click(getByTitle(/Reset view/i));
            expect(lastLog('overview_zoom_fit')).toBeDefined();
        });

        it('logs overview_inspect_changed when an exact equipment match is typed', () => {
            const { getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const input = getByTestId('overview-inspect-input') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            const entry = lastLog('overview_inspect_changed');
            expect(entry).toBeDefined();
            expect(entry!.details).toEqual({ query: 'VL_FAR', action: 'focus' });
        });

        it('logs overview_inspect_changed with action "cleared" when query is cleared', () => {
            const { getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
            const input = getByTestId('overview-inspect-input') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'VL_FAR' } });
            fireEvent.change(input, { target: { value: '' } });
            const entry = lastLog('overview_inspect_changed');
            expect(entry!.details.action).toBe('cleared');
        });
    });

    describe('filters', () => {
        const allCategories = { green: true, orange: true, red: true, grey: true };

        it('drops the threshold + category toggles + bulk buttons (severity / threshold rings now live in the sidebar)', () => {
            const { getByTestId, queryByTestId } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: false }}
                />,
            );
            expect(queryByTestId('filter-category-green')).not.toBeInTheDocument();
            expect(queryByTestId('filter-category-grey')).not.toBeInTheDocument();
            expect(queryByTestId('filter-select-all')).not.toBeInTheDocument();
            expect(queryByTestId('filter-select-none')).not.toBeInTheDocument();
            // Threshold moved into ActionFilterRings — the overview
            // header keeps only the non-redundant controls.
            expect(queryByTestId('filter-threshold')).not.toBeInTheDocument();
            expect(queryByTestId('filter-threshold-input')).not.toBeInTheDocument();
            expect(getByTestId('filter-show-unsimulated')).toBeInTheDocument();
        });

        it('header lays out the remaining filters on a single horizontal row (nowrap)', () => {
            const { getByTestId } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: false }}
                />,
            );
            const header = getByTestId('action-overview-header');
            expect(header.style.flexWrap).toBe('nowrap');
            // Remaining filters (unsimulated, combined-only) sit as
            // direct descendants of the single row.
            expect(header.querySelector('[data-testid="filter-show-unsimulated"]')).toBeTruthy();
            expect(header.querySelector('[data-testid="filter-combined-only"]')).toBeTruthy();
        });

        it('disabling the red category hides red-severity pins from the overview', () => {
            // defaultProps has one red pin (coupling_VL_FAR max_rho=1.1) and
            // one green pin (disco_LINE_A max_rho=0.5).
            const { container, rerender } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 2.0, showUnsimulated: false }}
                />,
            );
            const pinsBefore = container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)');
            expect(pinsBefore.length).toBe(2);

            rerender(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{
                        categories: { ...allCategories, red: false },
                        threshold: 2.0,
                        showUnsimulated: false,
                    }}
                />,
            );
            const pinsAfter = container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)');
            expect(pinsAfter.length).toBe(1);
            expect(pinsAfter[0].getAttribute('data-action-id')).toBe('disco_LINE_A');
        });

        it('threshold cap hides actions whose max_rho exceeds it', () => {
            // Threshold 1.0 keeps the green 0.5 pin; the red 1.1 pin is above cap.
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.0, showUnsimulated: false }}
                />,
            );
            const pins = container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)');
            expect(pins.length).toBe(1);
            expect(pins[0].getAttribute('data-action-id')).toBe('disco_LINE_A');
        });
    });

    describe('unsimulated pins', () => {
        const allCategories = { green: true, orange: true, red: true, grey: true };

        it('does NOT render unsimulated pins when showUnsimulated is false', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: false }}
                    unsimulatedActionIds={['LINE_D']}
                />,
            );
            const dimmed = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            expect(dimmed.length).toBe(0);
        });

        it('renders dimmed, dashed pins when showUnsimulated is true', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: true }}
                    unsimulatedActionIds={['LINE_D']}
                />,
            );
            const dimmed = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            expect(dimmed.length).toBe(1);
            expect(dimmed[0].getAttribute('data-unsimulated')).toBe('true');
            expect(dimmed[0].getAttribute('opacity')).toBe('0.5');
        });

        it('skips unsimulated ids that are already simulated (no duplicate pin)', () => {
            // LINE_A is already the target of `disco_LINE_A` in defaultProps;
            // the unsimulated builder should drop it.
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: true }}
                    unsimulatedActionIds={['disco_LINE_A', 'LINE_D']}
                />,
            );
            const dimmed = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            expect(dimmed.length).toBe(1);
            expect(dimmed[0].getAttribute('data-action-id')).toBe('LINE_D');
        });

        it('renders score metadata inside the unsimulated pin <title> when info is provided', () => {
            // App.tsx computes `unsimulatedActionInfo` from
            // action_scores and forwards it so the dimmed pin's
            // hover tooltip carries the same data the Manual
            // Selection dropdown exposes — operator can triage
            // without leaving the overview.
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: true }}
                    unsimulatedActionIds={['LINE_D']}
                    unsimulatedActionInfo={{
                        LINE_D: {
                            type: 'load_shedding',
                            score: 0.82,
                            mwStart: 24.5,
                            tapStart: null,
                            rankInType: 3,
                            countInType: 12,
                            maxScoreInType: 0.95,
                        },
                    }}
                />,
            );
            const pin = container.querySelector('.nad-action-overview-pin-unsimulated') as SVGGElement;
            const title = pin.querySelector('title')?.textContent ?? '';
            expect(title).toContain('LINE_D');
            expect(title).toContain('Type: load_shedding');
            expect(title).toContain('Score: 0.82');
            expect(title).toContain('rank 3 of 12');
            expect(title).toContain('max 0.95');
            expect(title).toContain('MW start: 24.5 MW');
        });

        it('double-clicking an unsimulated pin fires onSimulateUnsimulatedAction', () => {
            const onSimulateUnsimulatedAction = vi.fn();
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: true }}
                    unsimulatedActionIds={['LINE_D']}
                    onSimulateUnsimulatedAction={onSimulateUnsimulatedAction}
                />,
            );
            const pin = container.querySelector('.nad-action-overview-pin-unsimulated') as SVGGElement;
            expect(pin).not.toBeNull();
            act(() => { fireEvent.dblClick(pin); });
            expect(onSimulateUnsimulatedAction).toHaveBeenCalledTimes(1);
            expect(onSimulateUnsimulatedAction.mock.calls[0][0]).toBe('LINE_D');
        });

        it('logs overview_unsimulated_toggled when the checkbox is flipped', () => {
            const onFiltersChange = vi.fn();
            const { getByTestId } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 1.5, showUnsimulated: false }}
                    onFiltersChange={onFiltersChange}
                />,
            );
            const label = getByTestId('filter-show-unsimulated');
            const checkbox = label.querySelector('input[type="checkbox"]') as HTMLInputElement;
            fireEvent.click(checkbox);
            expect(onFiltersChange).toHaveBeenCalledTimes(1);
            expect(onFiltersChange.mock.calls[0][0].showUnsimulated).toBe(true);
        });

        // Regression: after the parent (App.tsx) resolves the
        // simulation triggered by a double-click and adds the action
        // to `result.actions`, the ActionOverviewDiagram must (a)
        // drop the dimmed dashed pin from the un-simulated layer AND
        // (b) render a fully-coloured pin for the id instead — same
        // treatment as any action simulated via the Manual Selection
        // dropdown.
        it('recolours the pin when the action moves from scored-only to simulated', () => {
            const baseProps = {
                ...defaultProps(),
                filters: { categories: allCategories, threshold: 1.5, showUnsimulated: true },
                unsimulatedActionIds: ['LINE_D'] as readonly string[],
            };
            const { container, rerender } = render(<ActionOverviewDiagram {...baseProps} />);
            // Before: a single dimmed un-simulated pin for LINE_D.
            const beforeUnsimulated = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            expect(beforeUnsimulated.length).toBe(1);
            expect(beforeUnsimulated[0].getAttribute('data-action-id')).toBe('LINE_D');

            // App.tsx streams the simulation result and calls
            // `wrappedManualActionAdded` → `handleManualActionAdded`
            // which inserts the new entry into `result.actions`. The
            // App then clears the id from `unsimulatedActionIds`
            // because it now exists in `result.actions`. We mimic
            // that two-prop update here.
            const actionsAfter: Record<string, ActionDetail> = {
                ...baseProps.actions,
                LINE_D: makeAction({
                    action_topology: { lines_ex_bus: { LINE_D: -1 }, lines_or_bus: { LINE_D: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.6,  // green severity
                    max_rho_line: 'LINE_D',
                    is_manual: true,
                }),
            };
            rerender(
                <ActionOverviewDiagram
                    {...baseProps}
                    actions={actionsAfter}
                    unsimulatedActionIds={[]}
                />,
            );
            // After: no more dashed un-simulated pin for LINE_D.
            const afterUnsimulated = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            expect(afterUnsimulated.length).toBe(0);

            // And LINE_D is now a regular, fully-coloured pin (not
            // dashed, not dimmed, not marked unsimulated).
            const linePin = container.querySelector('[data-action-id="LINE_D"]');
            expect(linePin).not.toBeNull();
            expect(linePin!.classList.contains('nad-action-overview-pin-unsimulated')).toBe(false);
            expect(linePin!.getAttribute('data-dimmed-by-filter')).toBeNull();
            expect(linePin!.getAttribute('data-unsimulated')).toBeNull();
            expect(linePin!.getAttribute('opacity')).toBeNull();
        });

        it('recolours the pin even when the "Show unsimulated" toggle is OFF', () => {
            // Before simulation with the toggle off, the pin isn't
            // drawn at all (no dashed preview). After simulation it
            // must still appear as a regular coloured pin — the
            // toggle only gates the un-simulated preview layer.
            const baseProps = {
                ...defaultProps(),
                filters: { categories: allCategories, threshold: 1.5, showUnsimulated: false },
                unsimulatedActionIds: ['LINE_D'] as readonly string[],
            };
            const { container, rerender } = render(<ActionOverviewDiagram {...baseProps} />);
            expect(container.querySelector('[data-action-id="LINE_D"]')).toBeNull();

            const actionsAfter: Record<string, ActionDetail> = {
                ...baseProps.actions,
                LINE_D: makeAction({
                    action_topology: { lines_ex_bus: { LINE_D: -1 }, lines_or_bus: { LINE_D: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.6,
                    max_rho_line: 'LINE_D',
                    is_manual: true,
                }),
            };
            rerender(
                <ActionOverviewDiagram
                    {...baseProps}
                    actions={actionsAfter}
                    unsimulatedActionIds={[]}
                />,
            );
            const linePin = container.querySelector('[data-action-id="LINE_D"]');
            expect(linePin).not.toBeNull();
            expect(linePin!.classList.contains('nad-action-overview-pin-unsimulated')).toBe(false);
        });

        it('shows the now-selected status on the recoloured pin (gold star) when the parent starred it', () => {
            // Manual-selection flow (the one unsimulated double-click
            // mirrors) adds the id to selectedActionIds too. The
            // coloured pin should then pick up the selected styling
            // (the gold star above the teardrop).
            const baseProps = {
                ...defaultProps(),
                filters: { categories: allCategories, threshold: 1.5, showUnsimulated: true },
                unsimulatedActionIds: ['LINE_D'] as readonly string[],
            };
            const { container, rerender } = render(<ActionOverviewDiagram {...baseProps} />);
            const actionsAfter: Record<string, ActionDetail> = {
                ...baseProps.actions,
                LINE_D: makeAction({
                    action_topology: { lines_ex_bus: { LINE_D: -1 }, lines_or_bus: { LINE_D: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.6,
                    max_rho_line: 'LINE_D',
                    is_manual: true,
                }),
            };
            rerender(
                <ActionOverviewDiagram
                    {...baseProps}
                    actions={actionsAfter}
                    unsimulatedActionIds={[]}
                    selectedActionIds={new Set(['LINE_D'])}
                />,
            );
            const linePin = container.querySelector('[data-action-id="LINE_D"]');
            expect(linePin).not.toBeNull();
            // Selected pins get a gold star path — see
            // applyActionOverviewPins. The star element is the only
            // <path> carrying a #eab308 fill.
            const goldFills = Array.from(linePin!.querySelectorAll('path'))
                .filter(p => p.getAttribute('fill') === '#eab308');
            expect(goldFills.length).toBeGreaterThan(0);
        });
    });

    describe('action-type chip filter', () => {
        const allCategories = { green: true, orange: true, red: true, grey: true };

        const propsWithMixedTypes = () => {
            const actions: Record<string, ActionDetail> = {
                'disco_LINE_A': makeAction({
                    action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                    description_unitaire: "Ouverture de la ligne 'LINE_A'",
                }),
                'coupling_VL_FAR': makeAction({
                    description_unitaire: "Ouverture du poste 'VL_FAR'",
                    max_rho: 0.8,
                    max_rho_line: 'LINE_B',
                }),
            };
            return { ...defaultProps(), actions };
        };

        it('hides pins whose classified type does not match the active chip', () => {
            // DISCO-only filter → disco_LINE_A stays, coupling_VL_FAR drops.
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithMixedTypes()}
                    filters={{ categories: allCategories, threshold: 2.0, showUnsimulated: false, actionType: 'disco' }}
                />,
            );
            const pins = container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)');
            const ids = Array.from(pins).map(p => p.getAttribute('data-action-id'));
            expect(ids).toEqual(['disco_LINE_A']);
        });

        it('ALL restores every pin', () => {
            const { container, rerender } = render(
                <ActionOverviewDiagram
                    {...propsWithMixedTypes()}
                    filters={{ categories: allCategories, threshold: 2.0, showUnsimulated: false, actionType: 'open' }}
                />,
            );
            // With 'open' we keep the coupling pin only
            expect(container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)').length).toBe(1);

            rerender(
                <ActionOverviewDiagram
                    {...propsWithMixedTypes()}
                    filters={{ categories: allCategories, threshold: 2.0, showUnsimulated: false, actionType: 'all' }}
                />,
            );
            expect(container.querySelectorAll('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)').length).toBe(2);
        });

        it('filters un-simulated pins by matching the score-info type', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{ categories: allCategories, threshold: 2.0, showUnsimulated: true, actionType: 'pst' }}
                    unsimulatedActionIds={['LINE_D', 'LINE_A']}
                    unsimulatedActionInfo={{
                        LINE_D: { type: 'pst_tap_change', score: 0.5, mwStart: null, tapStart: null, rankInType: 1, countInType: 1, maxScoreInType: 0.5 },
                        LINE_A: { type: 'line_disconnection', score: 0.8, mwStart: null, tapStart: null, rankInType: 1, countInType: 1, maxScoreInType: 0.8 },
                    }}
                />,
            );
            const dimmed = container.querySelectorAll('.nad-action-overview-pin-unsimulated');
            const dimmedIds = Array.from(dimmed).map(p => p.getAttribute('data-action-id'));
            // Only the PST-scored un-simulated pin survives.
            expect(dimmedIds).toEqual(['LINE_D']);
        });
    });

    describe('detached-window popover placement', () => {
        // Regression: the popover placement heuristic used to call
        // `window.innerWidth/innerHeight` unconditionally, so when the
        // overview was portal'd into a detached popup the above/below
        // decision was based on the MAIN window's dimensions — leading
        // to popovers that covered the pin. The fix reads
        // `ownerDocument.defaultView` so the popup's own viewport
        // drives the placement.
        //
        // In jsdom the default window height is 768; we stub it per
        // test to exercise both branches.
        const withViewport = (height: number, fn: () => void) => {
            const originalInner = window.innerHeight;
            Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
            try { fn(); } finally {
                Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInner });
            }
        };

        const clickFirstPin = (container: HTMLElement, screenY: number) => {
            const pin = container.querySelector('.nad-action-overview-pin:not(.nad-action-overview-pin-unsimulated)') as SVGGElement;
            // getBoundingClientRect is not implemented for SVG in
            // jsdom — stub it so handlePinClick's click handler can
            // read the pin's on-screen position deterministically.
            Object.defineProperty(pin, 'getBoundingClientRect', {
                configurable: true,
                value: () => ({ left: 400, top: screenY, width: 20, height: 20, right: 420, bottom: screenY + 20, x: 400, y: screenY, toJSON: () => ({}) }),
            });
            act(() => {
                fireEvent.click(pin);
                // applyActionOverviewPins debounces single-click by
                // PIN_SINGLE_CLICK_DELAY_MS; advance timers so the
                // popover commits.
                vi.advanceTimersByTime(300);
            });
        };

        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        it('places popover BELOW when the pin sits high in a tall viewport', () => {
            withViewport(1400, () => {
                const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
                clickFirstPin(container, 200);
                const pop = getByTestId('action-overview-popover');
                expect(pop.getAttribute('data-place-above')).toBe('false');
            });
        });

        it('places popover ABOVE when the pin sits low in a short viewport', () => {
            withViewport(500, () => {
                const { container, getByTestId } = render(<ActionOverviewDiagram {...defaultProps()} />);
                clickFirstPin(container, 400);
                const pop = getByTestId('action-overview-popover');
                expect(pop.getAttribute('data-place-above')).toBe('true');
            });
        });
    });

    describe('combined-action pin protection', () => {
        // Regression: when a combined-action pin passes the overview
        // filter, its two constituent unitary pins must stay visible
        // (even if the individual filter would hide them), otherwise
        // the combined-pin curve would dangle. Filtered-but-kept
        // constituents are dimmed to read as context rather than
        // first-class actions.
        const allCategories = { green: true, orange: true, red: true, grey: true };

        const propsWithCombined = () => {
            const actions: Record<string, ActionDetail> = {
                'disco_LINE_A': makeAction({
                    action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                }),
                'disco_LINE_B': makeAction({
                    // Red severity — would be filtered out if 'red' is off.
                    action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 1.3,
                    max_rho_line: 'LINE_B',
                }),
                // Combined pair — GREEN severity so it passes even
                // when red is filtered out. Must keep both unitary
                // constituents visible.
                'disco_LINE_A+disco_LINE_B': makeAction({
                    description_unitaire: 'A + B combined',
                    rho_after: [0.6, 0.7],
                    rho_before: [0.8, 0.9],
                    max_rho: 0.7,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                }),
            };
            return {
                ...defaultProps(),
                actions,
                overloadedLines: [] as readonly string[],
                contingency: null as string | null,
            };
        };

        it('keeps constituent pins visible but DIMMED when only the combined pin passes the filter', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithCombined()}
                    filters={{
                        // Hide the red bucket — disco_LINE_B would
                        // normally disappear. But the combined pair
                        // (green) passes, so both unitary pins must
                        // survive, with disco_LINE_B dimmed.
                        categories: { ...allCategories, red: false },
                        threshold: 2.0,
                        showUnsimulated: false,
                    }}
                />,
            );
            const pinA = container.querySelector('[data-action-id="disco_LINE_A"]');
            const pinB = container.querySelector('[data-action-id="disco_LINE_B"]');
            expect(pinA).not.toBeNull();
            expect(pinB).not.toBeNull();
            // disco_LINE_A passes the filter itself → not dimmed.
            expect(pinA!.getAttribute('data-dimmed-by-filter')).toBeNull();
            // disco_LINE_B fails the filter but is protected by the
            // passing combined pin → kept with a dim flag.
            expect(pinB!.getAttribute('data-dimmed-by-filter')).toBe('true');
            expect(pinB!.getAttribute('opacity')).toBe('0.4');
            // The combined pin itself is present.
            const combined = container.querySelector('[data-action-id="disco_LINE_A+disco_LINE_B"]');
            expect(combined).not.toBeNull();
        });

        it('DROPS constituent pins when neither the combined pin nor the unitary passes the filter', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithCombined()}
                    filters={{
                        // Hide red AND green — both the combined
                        // (green) and disco_LINE_B (red) fail; only
                        // the combined-protection branch could save
                        // disco_LINE_B, and it no longer passes.
                        categories: { green: false, orange: true, red: false, grey: true },
                        threshold: 2.0,
                        showUnsimulated: false,
                    }}
                />,
            );
            expect(container.querySelector('[data-action-id="disco_LINE_A"]')).toBeNull();
            expect(container.querySelector('[data-action-id="disco_LINE_B"]')).toBeNull();
            expect(container.querySelector('[data-action-id="disco_LINE_A+disco_LINE_B"]')).toBeNull();
        });

        it('does NOT dim constituents when the combined pin is filtered out and the unitaries would be filtered too', () => {
            // Combined pin is green — disable green → combined is
            // out. disco_LINE_B (red) is also out → it should simply
            // disappear, NOT appear dimmed.
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithCombined()}
                    filters={{
                        categories: { ...allCategories, green: false, red: false },
                        threshold: 2.0,
                        showUnsimulated: false,
                    }}
                />,
            );
            expect(container.querySelector('[data-action-id="disco_LINE_B"]')).toBeNull();
        });
    });

    // ----------------------------------------------------------------
    // "Combined only" toggle. Adds a new pin-scoped filter that
    // hides every unitary / un-simulated pin that is NOT a
    // constituent of a passing combined pair, so the operator can
    // focus on the recommender's multi-action remediations.
    // ----------------------------------------------------------------
    describe('combined-only filter', () => {
        const allCategoriesCO = { green: true, orange: true, red: true, grey: true };

        const propsWithMix = () => {
            const actions: Record<string, ActionDetail> = {
                'disco_LINE_A': makeAction({
                    action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                }),
                'disco_LINE_B': makeAction({
                    action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.5,
                    max_rho_line: 'LINE_B',
                }),
                // Solo pin — no combined pair references it. Must be
                // hidden in combined-only mode.
                'disco_LINE_C': makeAction({
                    action_topology: { lines_ex_bus: { LINE_C: -1 }, lines_or_bus: { LINE_C: -1 }, gens_bus: {}, loads_bus: {} },
                    max_rho: 0.5,
                    max_rho_line: 'LINE_C',
                }),
                'disco_LINE_A+disco_LINE_B': makeAction({
                    description_unitaire: 'A + B combined',
                    rho_after: [0.6, 0.7],
                    rho_before: [0.8, 0.9],
                    max_rho: 0.7,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                }),
            };
            return {
                ...defaultProps(),
                actions,
                overloadedLines: [] as readonly string[],
                contingency: null as string | null,
            };
        };

        it('renders the "Combined only" checkbox in the filter row', () => {
            const { getByTestId } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{
                        categories: allCategoriesCO,
                        threshold: 1.5,
                        showUnsimulated: false,
                        actionType: 'all',
                        showCombinedOnly: false,
                    }}
                />,
            );
            const label = getByTestId('filter-combined-only');
            expect(label).toBeInTheDocument();
            const checkbox = label.querySelector('input[type="checkbox"]') as HTMLInputElement;
            expect(checkbox).not.toBeNull();
            expect(checkbox.checked).toBe(false);
        });

        it('clicking the checkbox fires onFiltersChange with showCombinedOnly: true', () => {
            const onFiltersChange = vi.fn();
            const { getByTestId } = render(
                <ActionOverviewDiagram
                    {...defaultProps()}
                    filters={{
                        categories: allCategoriesCO,
                        threshold: 1.5,
                        showUnsimulated: false,
                        actionType: 'all',
                        showCombinedOnly: false,
                    }}
                    onFiltersChange={onFiltersChange}
                />,
            );
            const label = getByTestId('filter-combined-only');
            const checkbox = label.querySelector('input[type="checkbox"]') as HTMLInputElement;
            fireEvent.click(checkbox);
            expect(onFiltersChange).toHaveBeenCalledTimes(1);
            expect(onFiltersChange.mock.calls[0][0].showCombinedOnly).toBe(true);
        });

        it('hides the solo pin and dims the combined-pair constituents when toggled on', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithMix()}
                    filters={{
                        categories: allCategoriesCO,
                        threshold: 2.0,
                        showUnsimulated: false,
                        actionType: 'all',
                        showCombinedOnly: true,
                    }}
                />,
            );
            // Solo pin disappears.
            expect(container.querySelector('[data-action-id="disco_LINE_C"]')).toBeNull();
            // Pair constituents stay, dimmed.
            const pinA = container.querySelector('[data-action-id="disco_LINE_A"]');
            const pinB = container.querySelector('[data-action-id="disco_LINE_B"]');
            expect(pinA).not.toBeNull();
            expect(pinB).not.toBeNull();
            expect(pinA!.getAttribute('data-dimmed-by-filter')).toBe('true');
            expect(pinB!.getAttribute('data-dimmed-by-filter')).toBe('true');
            // Combined pin itself is rendered.
            expect(container.querySelector('[data-action-id="disco_LINE_A+disco_LINE_B"]')).not.toBeNull();
        });

        it('keeps every pin at full strength when toggled off', () => {
            const { container } = render(
                <ActionOverviewDiagram
                    {...propsWithMix()}
                    filters={{
                        categories: allCategoriesCO,
                        threshold: 2.0,
                        showUnsimulated: false,
                        actionType: 'all',
                        showCombinedOnly: false,
                    }}
                />,
            );
            // Solo pin survives.
            expect(container.querySelector('[data-action-id="disco_LINE_C"]')).not.toBeNull();
            // Constituents are NOT dimmed when the combined pin
            // doesn't need them as protected context.
            const pinA = container.querySelector('[data-action-id="disco_LINE_A"]');
            expect(pinA!.getAttribute('data-dimmed-by-filter')).toBeNull();
        });

        it('drops every un-simulated pin when toggled on (un-simulated never combined)', () => {
            const props = propsWithMix();
            const { container } = render(
                <ActionOverviewDiagram
                    {...props}
                    unsimulatedActionIds={['LINE_D']}
                    filters={{
                        categories: allCategoriesCO,
                        threshold: 2.0,
                        showUnsimulated: true,
                        actionType: 'all',
                        showCombinedOnly: true,
                    }}
                />,
            );
            // Even with showUnsimulated=true, no un-simulated pin is
            // rendered when the operator restricts to combined-only.
            const unsimulated = container.querySelectorAll(
                '.nad-action-overview-pin-unsimulated',
            );
            expect(unsimulated.length).toBe(0);
        });
    });
});
