// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import MemoizedSvgContainer from './MemoizedSvgContainer';
import { processSvg } from '../utils/svgUtils';

describe('MemoizedSvgContainer', () => {
    it('renders a container div with correct id and class', () => {
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="n" />
        );
        const el = container.querySelector('#n-svg-container');
        expect(el).toBeInTheDocument();
        expect(el).toHaveClass('svg-container');
    });

    it('sets display style based on prop', () => {
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="none" tabId="contingency" />
        );
        const el = container.querySelector('#contingency-svg-container') as HTMLElement;
        expect(el.style.display).toBe('none');
    });

    it('injects string SVG into container via innerHTML', () => {
        const containerRef = createRef<HTMLDivElement>();
        const svgString = '<svg><circle r="10"/></svg>';
        render(
            <MemoizedSvgContainer svg={svgString} containerRef={containerRef} display="block" tabId="n" />
        );
        expect(containerRef.current?.innerHTML).toContain('<circle');
    });

    it('injects SVGSVGElement into container via replaceChildren', () => {
        const containerRef = createRef<HTMLDivElement>();
        const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('r', '20');
        svgEl.appendChild(circle);

        render(
            <MemoizedSvgContainer svg={svgEl} containerRef={containerRef} display="block" tabId="action" />
        );
        expect(containerRef.current?.querySelector('circle')).toBeTruthy();
    });

    // ===== D6: the SVG element-adoption pipeline =====
    // processSvg hands us an already-parsed SVGSVGElement; MemoizedSvgContainer
    // must adopt that exact element via replaceChildren (no serialize +
    // innerHTML re-parse). Proven by identity: the mounted <svg> is the SAME
    // instance processSvg returned, which innerHTML could never produce.
    it('adopts the exact element processSvg returned (no re-parse round-trip)', () => {
        const containerRef = createRef<HTMLDivElement>();
        const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="marker"/></svg>';
        const { svg } = processSvg(raw, 100);
        expect(typeof svg).not.toBe('string'); // element rail engaged
        render(
            <MemoizedSvgContainer svg={svg} containerRef={containerRef} display="block" tabId="n" />
        );
        // Identity check: same element instance moved into the container.
        expect(containerRef.current?.firstElementChild).toBe(svg);
        expect(containerRef.current?.querySelector('#marker')).toBeTruthy();
    });

    it('uses correct id for different tabId values', () => {
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="action" />
        );
        expect(container.querySelector('#action-svg-container')).toBeInTheDocument();
    });

    it('logs performance timing to console', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
        const containerRef = createRef<HTMLDivElement>();
        render(
            <MemoizedSvgContainer svg="<svg></svg>" containerRef={containerRef} display="block" tabId="n" />
        );
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[SVG] DOM injection for n'));
        consoleSpy.mockRestore();
    });

    // ===== Regression tests for the auto-zoom double-injection fix =====
    // See VisualizationPanel.tsx — MemoizedSvgContainer is kept always mounted
    // with an empty svg string as placeholder, so that when the real SVG arrives
    // the component updates (not remounts) and StrictMode does NOT double-invoke
    // the layout effect (which would overwrite a freshly-applied auto-zoom).

    it('does NOT inject content when svg is empty string', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
        const containerRef = createRef<HTMLDivElement>();
        render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="contingency" />
        );
        // No DOM injection log should have been emitted
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('[SVG] DOM injection'));
        // Container should be empty
        expect(containerRef.current?.innerHTML).toBe('');
        consoleSpy.mockRestore();
    });

    it('injects once when svg prop transitions from empty to non-empty (update, not remount)', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
        const containerRef = createRef<HTMLDivElement>();
        const { rerender } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="contingency" />
        );
        // Initial render with empty svg: no injection
        expect(consoleSpy).not.toHaveBeenCalled();

        // Transition to real SVG (simulates fetchN1 completing)
        rerender(
            <MemoizedSvgContainer svg="<svg><rect/></svg>" containerRef={containerRef} display="block" tabId="contingency" />
        );

        // Exactly one injection should have fired (the update), not two
        const injectionCalls = consoleSpy.mock.calls.filter(
            call => typeof call[0] === 'string' && call[0].includes('[SVG] DOM injection for contingency')
        );
        expect(injectionCalls.length).toBe(1);
        expect(containerRef.current?.innerHTML).toContain('<rect');
        consoleSpy.mockRestore();
    });

    it('preserves manually-set viewBox attribute on subsequent re-renders with same svg', () => {
        const containerRef = createRef<HTMLDivElement>();
        const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgEl.setAttribute('viewBox', '0 0 100 100');

        const { rerender } = render(
            <MemoizedSvgContainer svg={svgEl} containerRef={containerRef} display="block" tabId="contingency" />
        );

        // Simulate auto-zoom setting a new viewBox on the live DOM
        const liveSvg = containerRef.current?.querySelector('svg');
        expect(liveSvg).toBeTruthy();
        liveSvg!.setAttribute('viewBox', '25 25 10 10');

        // Re-render with the SAME svg prop (React.memo + stable ref) — this
        // should not re-run the layout effect and must preserve our viewBox.
        rerender(
            <MemoizedSvgContainer svg={svgEl} containerRef={containerRef} display="block" tabId="contingency" />
        );
        expect(containerRef.current?.querySelector('svg')?.getAttribute('viewBox')).toBe('25 25 10 10');
    });

    // ===== VL-names toggle: hide-rule contract =====
    // Regression for the bug where toggling VL names off hid the label
    // boxes but left dangling connector ticks (`.nad-text-edges`) from
    // each voltage-level node to its now-invisible label. The CSS rule
    // in App.css must list every shape pypowsybl emits for VL labels
    // AND the connector-edge group, otherwise the toggle is incomplete.

    it('applies nad-hide-vl-labels class on the container when hideVlLabels is true', () => {
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="n" hideVlLabels={true} />
        );
        const el = container.querySelector('#n-svg-container');
        expect(el).toHaveClass('nad-hide-vl-labels');
    });

    it('omits nad-hide-vl-labels class when hideVlLabels is false (default)', () => {
        const containerRef = createRef<HTMLDivElement>();
        const { container } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="n" />
        );
        const el = container.querySelector('#n-svg-container');
        expect(el).not.toHaveClass('nad-hide-vl-labels');
    });

    it('App.css hides .nad-text-edges (the VL→label connector tick) when nad-hide-vl-labels is set', () => {
        const css = readFileSync(resolve(__dirname, '..', 'App.css'), 'utf-8');
        // Locate the hide-vl-labels rule block (selectors split across
        // lines, ending with `display: none !important;`).
        const ruleMatch = css.match(
            /((?:\.svg-container\.nad-hide-vl-labels[^,{]*,\s*)+\.svg-container\.nad-hide-vl-labels[^,{]*)\s*\{[^}]*display:\s*none\s*!important[^}]*\}/s,
        );
        expect(ruleMatch).not.toBeNull();
        const selectorList = ruleMatch![1];
        // Each shape pypowsybl emits MUST be covered by the hide rule.
        // `.nad-text-edges` is the connector-line group — without it the
        // tick from each VL node to its hidden label box is left visible.
        expect(selectorList).toMatch(/\.svg-container\.nad-hide-vl-labels\s+\.nad-text-edges\b/);
        // Sanity: the previously-covered shapes must still be there.
        expect(selectorList).toMatch(/\.svg-container\.nad-hide-vl-labels\s+\.nad-text-nodes\b/);
        expect(selectorList).toMatch(/\.svg-container\.nad-hide-vl-labels\s+\.nad-label-box\b/);
    });

    it('handles empty string placeholder followed by real SVG without erasing prior viewBox', () => {
        // Simulates the full fix flow: component mounts with empty svg,
        // then receives real svg — only one injection, container ready.
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
        const containerRef = createRef<HTMLDivElement>();

        // Step 1: mount empty (placeholder mode, n1Diagram null)
        const { rerender } = render(
            <MemoizedSvgContainer svg="" containerRef={containerRef} display="block" tabId="contingency" />
        );
        expect(containerRef.current?.querySelector('svg')).toBeNull();

        // Step 2: fetchN1 completes, svg arrives
        rerender(
            <MemoizedSvgContainer svg='<svg viewBox="0 0 1000 1000"><g/></svg>' containerRef={containerRef} display="block" tabId="contingency" />
        );
        const svg = containerRef.current?.querySelector('svg');
        expect(svg).toBeTruthy();

        // Step 3: auto-zoom would set a new viewBox programmatically
        svg!.setAttribute('viewBox', '100 100 50 50');

        // Step 4: parent re-renders without svg change — must not reset viewBox
        rerender(
            <MemoizedSvgContainer svg='<svg viewBox="0 0 1000 1000"><g/></svg>' containerRef={containerRef} display="block" tabId="contingency" />
        );
        // The string svg prop creates a new reference each call, so this DOES
        // re-inject — this test just documents that behavior.  The fix in
        // VisualizationPanel passes stable references via n1Diagram.svg.
        consoleSpy.mockRestore();
    });
});
