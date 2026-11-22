// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
    computeActionSeverity,
    curveMidpoint,
    formatPinLabel,
    formatPinTitle,
    severityFill,
    severityFillDimmed,
    severityFillHighlighted,
} from './actionPinData';
import type { ActionDetail } from '../../types';

const baseDetail = (over: Partial<ActionDetail> = {}): ActionDetail => ({
    description_unitaire: 'desc',
    max_rho: 0.5,
    max_rho_line: 'LINE_X',
    is_rho_reduction: false,
    is_islanded: false,
    non_convergence: null,
    action_topology: null,
    load_shedding_details: null,
    curtailment_details: null,
    ...over,
} as unknown as ActionDetail);

describe('computeActionSeverity', () => {
    it('returns grey for divergent actions', () => {
        expect(computeActionSeverity(baseDetail({ non_convergence: 'LF diverged' }), 0.95)).toBe('grey');
    });

    it('returns grey for islanding actions', () => {
        expect(computeActionSeverity(baseDetail({ is_islanded: true }), 0.95)).toBe('grey');
    });

    it('returns red when max_rho is missing and no reduction', () => {
        expect(computeActionSeverity(baseDetail({ max_rho: null, is_rho_reduction: false }), 0.95)).toBe('red');
    });

    it('returns green when max_rho is missing but rho is reduced', () => {
        expect(computeActionSeverity(baseDetail({ max_rho: null, is_rho_reduction: true }), 0.95)).toBe('green');
    });

    it('returns red when max_rho exceeds monitoringFactor', () => {
        expect(computeActionSeverity(baseDetail({ max_rho: 1.05 }), 0.95)).toBe('red');
    });

    it('returns orange inside the 5%-below-threshold band', () => {
        expect(computeActionSeverity(baseDetail({ max_rho: 0.92 }), 0.95)).toBe('orange');
    });

    it('returns green comfortably below the threshold', () => {
        expect(computeActionSeverity(baseDetail({ max_rho: 0.5 }), 0.95)).toBe('green');
    });
});

describe('severity palettes', () => {
    it('covers all four severities with three palettes', () => {
        (['green', 'orange', 'red', 'grey'] as const).forEach(sev => {
            expect(severityFill[sev]).toMatch(/^#[0-9a-f]{6}$/i);
            expect(severityFillDimmed[sev]).toMatch(/^#[0-9a-f]{6}$/i);
            expect(severityFillHighlighted[sev]).toMatch(/^#[0-9a-f]{6}$/i);
        });
    });
});

describe('formatPinLabel', () => {
    it('formats max_rho as an integer percentage', () => {
        expect(formatPinLabel(baseDetail({ max_rho: 0.876 }))).toBe('88%');
    });

    it('returns DIV on non-convergence', () => {
        expect(formatPinLabel(baseDetail({ max_rho: null, non_convergence: 'x' }))).toBe('DIV');
    });

    it('returns ISL on islanding', () => {
        expect(formatPinLabel(baseDetail({ max_rho: null, is_islanded: true }))).toBe('ISL');
    });

    it('returns em-dash when nothing is known', () => {
        expect(formatPinLabel(baseDetail({ max_rho: null }))).toBe('\u2014');
    });
});

describe('formatPinTitle', () => {
    it('joins id + description + loading line', () => {
        const t = formatPinTitle('act_X', baseDetail({ max_rho: 0.876, max_rho_line: 'LINE_Z' }));
        expect(t).toBe('act_X \u2014 desc \u2014 max loading 87.6% on LINE_Z');
    });

    it('omits empty max_rho fragment when missing', () => {
        const t = formatPinTitle('act_X', baseDetail({ max_rho: null, non_convergence: null, is_islanded: false }));
        expect(t).toBe('act_X \u2014 desc');
    });

    it('reports non-convergence explicitly', () => {
        const t = formatPinTitle('act_X', baseDetail({ max_rho: null, non_convergence: 'AC diverged' }));
        expect(t).toContain('load-flow divergent');
    });

    it('reports islanding explicitly', () => {
        const t = formatPinTitle('act_X', baseDetail({ max_rho: null, is_islanded: true }));
        expect(t).toContain('islanding');
    });
});

describe('curveMidpoint', () => {
    it('puts the midpoint on the perpendicular bisector between p1 and p2', () => {
        const p1 = { x: 0, y: 0 };
        const p2 = { x: 100, y: 0 };
        const { midX, midY } = curveMidpoint(p1, p2, 0.3);
        expect(midX).toBe(50);
        // offsetFraction * dist * perp direction = 0.3 * 100 in Y direction.
        // At t=0.5: midY = 2*0.5*0.5 * ctrlY + 0.25*p1.y + 0.25*p2.y = 0.5 * ctrlY.
        // ctrlY = (-dy/dist)*dist*0.3 + midpointY = 0 + (100)*0.3 = 30 → midY = 0.5 * 30 = 15.
        expect(midY).toBeCloseTo(15, 5);
    });

    it('returns valid midpoint for coincident p1 and p2 (degenerate)', () => {
        const p = { x: 42, y: 7 };
        const result = curveMidpoint(p, p);
        expect(Number.isFinite(result.midX)).toBe(true);
        expect(Number.isFinite(result.midY)).toBe(true);
    });
});
