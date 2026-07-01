// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildFriendlyToEquip, overloadCandidates, applyFeederRelabels, wrapFeederLabel } from './feederLabels';
import type { FeederLabel } from '../../types';

const fl = (over: Partial<Record<string, FeederLabel>> = {}): Record<string, FeederLabel> => ({
    'relation_8423569-225': { name: 'MARSIL61PRAGN', other_vl: 'VL_MARSIL', label: 'MARSILLON 225kV' },
    ...over,
});

describe('buildFriendlyToEquip', () => {
    it('maps friendly name → equipment id', () => {
        const map = buildFriendlyToEquip(fl());
        expect(map.get('MARSIL61PRAGN')).toEqual(['relation_8423569-225']);
    });

    it('groups multiple ids under a shared friendly name', () => {
        const map = buildFriendlyToEquip({
            a: { name: 'DOUBLE', other_vl: 'X', label: 'X 1' },
            b: { name: 'DOUBLE', other_vl: 'X', label: 'X 2' },
        });
        expect(map.get('DOUBLE')?.sort()).toEqual(['a', 'b']);
    });

    it('returns an empty map for undefined input', () => {
        expect(buildFriendlyToEquip(undefined).size).toBe(0);
    });
});

describe('overloadCandidates', () => {
    it('prepends the raw value then the mapped ids', () => {
        const map = buildFriendlyToEquip(fl());
        expect(overloadCandidates('MARSIL61PRAGN', map)).toEqual([
            'MARSIL61PRAGN', 'relation_8423569-225',
        ]);
    });

    it('falls back to the raw value when unmapped (already id-keyed)', () => {
        const map = buildFriendlyToEquip(fl());
        expect(overloadCandidates('relation_8423569-225', map)).toEqual(['relation_8423569-225']);
    });
});

describe('wrapFeederLabel', () => {
    it('keeps a short label on a single line', () => {
        expect(wrapFeederLabel('MARSILLON 225kV')).toEqual(['MARSILLON 225kV']);
    });

    it('never wraps a single word (no spaces)', () => {
        expect(wrapFeederLabel('virtual_relation_8423568_a_0-225'))
            .toEqual(['virtual_relation_8423568_a_0-225']);
    });

    it('wraps a long label on spaces and preserves every token', () => {
        const lines = wrapFeederLabel('LANNEMEZAN 225kV 2');
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join(' ')).toBe('LANNEMEZAN 225kV 2');
    });

    it('caps at three lines, folding the overflow into the last one', () => {
        const lines = wrapFeederLabel('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT');
        expect(lines.length).toBeLessThanOrEqual(3);
        expect(lines.join(' ')).toBe('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT');
    });
});

describe('applyFeederRelabels', () => {
    const mount = (svg: string): HTMLElement => {
        const div = document.createElement('div');
        div.innerHTML = svg;
        return div;
    };

    it('swaps a matching feeder text to the far-end VL label', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, fl(), '<svg/>');
        const t = container.querySelector('#t')!;
        expect(t.textContent).toBe('MARSILLON 225kV');
        expect(t.getAttribute('data-feeder-orig')).toBe('relation_8423569-225');
    });

    it('restores the original on a second call with no labels', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, fl(), '<svg/>');
        applyFeederRelabels(container, {}, '<svg/>');
        expect(container.querySelector('#t')!.textContent).toBe('relation_8423569-225');
    });

    it('skips highlight clones when matching', () => {
        const container = mount(
            '<svg>'
            + '<g class="sld-highlight-clone"><text>relation_8423569-225</text></g>'
            + '<text id="orig">relation_8423569-225</text>'
            + '</svg>',
        );
        applyFeederRelabels(container, fl(), '<svg/>');
        // The original (non-clone) text is relabelled; the clone's copy is left alone.
        expect(container.querySelector('#orig')!.textContent).toBe('MARSILLON 225kV');
        expect(container.querySelector('.sld-highlight-clone text')!.textContent)
            .toBe('relation_8423569-225');
    });

    it('does nothing when there is no active svg', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, fl(), null);
        expect(container.querySelector('#t')!.textContent).toBe('relation_8423569-225');
    });

    it('tags the relabelled feeder with the far-end VL id for navigation', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, fl(), '<svg/>');
        const t = container.querySelector('#t')!;
        expect(t.getAttribute('data-feeder-nav')).toBe('VL_MARSIL');
        expect(t.classList.contains('sld-feeder-navigable')).toBe(true);
    });

    it('drops the navigation tag on restore', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, fl(), '<svg/>');
        applyFeederRelabels(container, {}, '<svg/>');
        const t = container.querySelector('#t')!;
        expect(t.getAttribute('data-feeder-nav')).toBeNull();
        expect(t.classList.contains('sld-feeder-navigable')).toBe(false);
    });

    it('does not tag navigation when the far-end VL is unknown', () => {
        const container = mount('<svg><text id="t">relation_8423569-225</text></svg>');
        applyFeederRelabels(container, {
            'relation_8423569-225': { name: 'X', other_vl: null, label: 'X' },
        }, '<svg/>');
        expect(container.querySelector('#t')!.getAttribute('data-feeder-nav')).toBeNull();
    });
});
