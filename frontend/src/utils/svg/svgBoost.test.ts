// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { boostSvgForLargeGrid, processSvg } from './svgBoost';

describe('boostSvgForLargeGrid', () => {
    const stableSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><circle cx="10" cy="10" r="5"/></svg>';

    it('returns the input unchanged when viewBox is null', () => {
        expect(boostSvgForLargeGrid(stableSvg, null, 1000)).toBe(stableSvg);
    });

    it('returns the input unchanged for small grids (<500 VLs)', () => {
        const vb = { x: 0, y: 0, w: 20000, h: 20000 };
        expect(boostSvgForLargeGrid(stableSvg, vb, 100)).toBe(stableSvg);
    });

    it('returns the input unchanged when diagram size ratio is under threshold', () => {
        // ratio = 1000/1250 ≈ 0.8, below BOOST_THRESHOLD=3.
        const vb = { x: 0, y: 0, w: 1000, h: 1000 };
        expect(boostSvgForLargeGrid(stableSvg, vb, 1000)).toBe(stableSvg);
    });

    it('applies the same scale factor to circle parents and edge-info groups', () => {
        // Invariant: pypowsybl nodes (geometric r) and flow indicator
        // groups (translate + scale) must rescale by the SAME factor so
        // a node's label sits proportionally next to its circle. fr225_400-
        // sized fixture so the formula runs in a real-shape regime.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400000 1390000">'
            + '<g><circle cx="10" cy="10" r="5"/></g>'
            + '<g class="nad-edge-infos"><g transform="translate(50,50)"/></g></svg>';
        const vb = { x: 0, y: 0, w: 1_400_000, h: 1_390_000 };
        const out = boostSvgForLargeGrid(svg, vb, 1196);
        expect(out).not.toBe(svg);
        expect(out).toMatch(/translate\(10,10\) scale\(59\.68\) translate\(-10,-10\)/);
        expect(out).toMatch(/translate\(50,50\) scale\(59\.68\)/);
    });

    it('de-clutters overlapping flow values by sliding them apart along the edge', () => {
        // Two flow-value groups overprint near one substation node (to their
        // left). Section 6 should slide them apart along their edge tangent
        // (oriented away from the node) so both stay visible. European-scale
        // viewBox so the boost (and thus the de-clutter) actually engages.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4400000 3470000">'
            + '<g class="nad-vl-nodes"><g transform="translate(0,1000)"><circle cx="0" cy="0" r="27.5"/></g></g>'
            + '<g class="nad-edge-infos">'
            + '<g transform="translate(1000,1000)"><path transform="rotate(0)" class="nad-arrow-in" d="M0,0"/><text class="nad-active">5</text></g>'
            + '<g transform="translate(1300,1000)"><path transform="rotate(0)" class="nad-arrow-in" d="M0,0"/><text class="nad-active">5</text></g>'
            + '</g></svg>';
        const vb = { x: 0, y: 0, w: 4_400_000, h: 3_470_000 };
        const out = boostSvgForLargeGrid(svg, vb, 5247);
        // Pull the edge-info group x-translations from the output (the node
        // group's outer translate is at x=0, so > 10 filters to the two values).
        const xs: number[] = [];
        for (const m of out.matchAll(/translate\(\s*([0-9.eE+-]+)\s*,\s*1000(?:\.0+)?\s*\)/g)) {
            const x = parseFloat(m[1]);
            if (isFinite(x) && x > 10) xs.push(x);
        }
        expect(xs.length).toBe(2);
        const [a, b] = xs.sort((p, q) => p - q);
        // They started 300 apart and must end up well separated, away from the node.
        expect(b - a).toBeGreaterThan(1500);
        expect(a).toBeGreaterThan(0); // never slid back past the node at x=0
    });

    it('preserves the PyPSA-EUR fr225_400 calibration (low density, viewBox ~1.4 M)', () => {
        // 1196 VLs on a 1.4 M × 1.39 M layout matches the operator-
        // confirmed nodeBoost ≈ 60 from iteration 2 (density penalty
        // ≈ 1 because density ≈ reference). Regression guard on the
        // density formula: anyone who lowers VL_DENSITY_REFERENCE would
        // trip this.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400000 1390000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 1_400_000, h: 1_390_000 };
        const out = boostSvgForLargeGrid(svg, vb, 1196);
        expect(out).toMatch(/scale\(59\.68\)/);
    });

    it('clamps the continent-scale European layout to the 60× ceiling (viewBox ~4.4 M)', () => {
        // 5247 VLs on a 4.4 M × 3.47 M layout: density penalty clamped
        // at 1, so the raw viewBox-driven boost is (boost − 1.5) × 10/3
        // + 1 ≈ 110. That blew the r=27.5 circles up to a ~6 040-unit
        // diameter — wider than the median substation spacing, merging
        // adjacent stations and the two voltage levels of one station.
        // The 60× ceiling (= the largest boost confirmed legible, on
        // fr225_400) halves them to a ~3 280-unit diameter.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4400000 3470000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 4_400_000, h: 3_470_000 };
        const out = boostSvgForLargeGrid(svg, vb, 5247);
        expect(out).toMatch(/scale\(60\.00\)/);
    });

    it('shrinks nodes on the dense bare_env operator-reference layout (same span as fr225_400 but ~15× more VLs)', () => {
        // 18141 VLs on a 1.64 M × 1.39 M layout — same scale as
        // fr225_400 but the density-suppression kicks in (~13× denser →
        // sqrt(13) ≈ 3.6× shrink). nodeBoost ≈ 18. Without this
        // density compensation the operator's bare_env layout would
        // render as a blob (r/median-NN > 100 %).
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1640000 1390000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 1_640_000, h: 1_390_000 };
        const out = boostSvgForLargeGrid(svg, vb, 18141);
        expect(out).toMatch(/scale\(18\.04\)/);
    });

    it('falls back to native rendering (nodeBoost = 1) on a small grid just past the threshold', () => {
        // viewBox 5000 + vlCount 1000: viewBox is just past the boost
        // threshold but density is wildly high (~67 K × reference), so
        // both the OFFSET and the density penalty drag nodeBoost below
        // the FLOOR. Result: native pypowsybl rendering.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 5000, h: 5000 };
        const out = boostSvgForLargeGrid(svg, vb, 1000);
        expect(out).toMatch(/scale\(1\.00\)/);
    });

    it('falls back to native rendering on a dense small viewBox (operator-reported "bare_env blob" regression guard)', () => {
        // viewBox 20000 + vlCount 1000: pre-density formula gave
        // nodeBoost = 3.70 (1.7 % of viewBox per circle — blob). The
        // density penalty drops it back to the floor.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 20000, h: 20000 };
        const out = boostSvgForLargeGrid(svg, vb, 1000);
        expect(out).toMatch(/scale\(1\.00\)/);
    });

    it('caps the node boost at the 60× ceiling on enormous sparse grids', () => {
        // viewBox 100M + vlCount 1000: density = 1e-7 → way below REF
        // → no density penalty → boost growth uncapped → ceiling kicks
        // in at 60.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000000 100000000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 100_000_000, h: 100_000_000 };
        const out = boostSvgForLargeGrid(svg, vb, 1000);
        expect(out).toMatch(/scale\(60\.00\)/);
    });

    it('density-suppress only kicks in above the reference (sparser grids pass through)', () => {
        // Companion to the European test: an extremely sparse layout
        // (1196 VLs spread over 4 M × 4 M ≈ 1/13 × fr225_400 density)
        // produces densitySuppress = 1 (clamped to ≥ 1) so the formula
        // reduces to the OFFSET-shape alone. Guards against a
        // future refactor that accidentally inverts the max(1, …).
        // Kept below the 60× ceiling (viewBox 1.2 M, 600 VLs) so the
        // density-suppress passthrough is observable rather than masked
        // by the clamp.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200000 1200000">'
            + '<g><circle cx="0" cy="0" r="27.5"/></g></svg>';
        const vb = { x: 0, y: 0, w: 1_200_000, h: 1_200_000 };
        const out = boostSvgForLargeGrid(svg, vb, 600);
        // boost = sqrt(960/3) ≈ 17.89; rawBoost = (17.89 − 1.5) × 10/3 + 1 ≈ 55.63;
        // density 4.17e-10 < REF → suppress = 1 → passes through (< 60 ceiling).
        expect(out).toMatch(/scale\(55\.63\)/);
    });

    it('does NOT touch branch polylines in boost mode (line-extend / kink-drop / indicator-projection are shrink-only)', () => {
        // viewBox 5000 + vlCount 1000 → small viewBox AND high density,
        // both pressure the formula toward the FLOOR = 1 (native
        // pypowsybl rendering). With FLOOR = 1 the SHRINK_BAND_AID
        // gate is never tripped — line-extension, kink-drop, and
        // indicator-projection passes (designed for the old shrink
        // regime, nodeBoost < 1) stay off, and the pypowsybl-emitted
        // geometry is preserved verbatim.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000">'
            + '<g class="nad-vl-nodes">'
            + '  <g transform="translate(0,0)" id="0">'
            + '    <circle r="27.5" class="nad-busnode"/>'
            + '  </g>'
            + '</g>'
            + '<g class="nad-branch-edges">'
            + '  <g id="b1">'
            + '    <polyline class="nad-edge-path" points="27.50,0.00 60.00,30.00 200.00,100.00"/>'
            + '  </g>'
            + '</g>'
            + '<g class="nad-edge-infos">'
            + '  <g id="info1" transform="translate(60,30)"><text>42</text></g>'
            + '</g></svg>';
        const vb = { x: 0, y: 0, w: 5000, h: 5000 };
        const out = boostSvgForLargeGrid(svg, vb, 1000);
        // Polyline points unchanged — all three vertices survive verbatim.
        expect(out).toMatch(/points="27\.50,0\.00 60\.00,30\.00 200\.00,100\.00"/);
        // Flow-indicator translate also unchanged (still 60,30) — but the
        // group now carries the gained boost scale appended by section 3.
        // viewBox 5000 → nodeBoost floored at 1 → scale(1.00).
        expect(out).toMatch(/translate\(60,30\) scale\(1\.00\)/);
    });
});

describe('processSvg', () => {
    it('parses a well-formed viewBox', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 300 400"/>';
        const { viewBox } = processSvg(svg, 100);
        expect(viewBox).toEqual({ x: 10, y: 20, w: 300, h: 400 });
    });

    it('returns a null viewBox when the attribute is missing', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
        const { viewBox, svg: out } = processSvg(svg, 100);
        expect(viewBox).toBeNull();
        expect(out).toBe(svg);
    });

    it('accepts a comma-separated viewBox', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0,0,100,100"/>';
        const { viewBox } = processSvg(svg, 100);
        expect(viewBox).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    });
});
