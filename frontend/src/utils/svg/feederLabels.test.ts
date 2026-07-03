// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildFriendlyToEquip, overloadCandidates, applyFeederRelabels, applyFeederLabelWrap, wrapFeederLabel } from './feederLabels';
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

    it('keeps a short single word (no spaces) on one line', () => {
        expect(wrapFeederLabel('relation_842')).toEqual(['relation_842']);
    });

    it('breaks a long single word on its separators and preserves every char', () => {
        const lines = wrapFeederLabel('virtual_relation_8423568_a_0-225');
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.length).toBeLessThanOrEqual(3);
        expect(lines.join('')).toBe('virtual_relation_8423568_a_0-225');
        // Each line stays within the wrap budget (last one may fold overflow).
        expect(lines[0].length).toBeLessThanOrEqual(15);
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

describe('applyFeederLabelWrap', () => {
    const mount = (svg: string): HTMLElement => {
        const div = document.createElement('div');
        div.innerHTML = svg;
        return div;
    };

    it('wraps a long generator / load name inside a feeder cell', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell">'
            + '<text id="g">G_virtual_relation_8423568_a_0-225</text>'
            + '</g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        const t = container.querySelector('#g')!;
        expect(t.getAttribute('data-feeder-wrap')).toBe('1');
        expect(t.querySelectorAll('tspan').length).toBeGreaterThan(1);
        expect(t.getAttribute('data-feeder-wrap-orig')).toBe('G_virtual_relation_8423568_a_0-225');
    });

    it('leaves a short name untouched', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell"><text id="s">IGNERES 225kV</text></g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        const t = container.querySelector('#s')!;
        expect(t.hasAttribute('data-feeder-wrap')).toBe(false);
        expect(t.textContent).toBe('IGNERES 225kV');
    });

    it('skips the numeric P/Q flow labels', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell">'
            + '<g class="sld-active-power"><text id="p">-1234567.89</text></g>'
            + '<text id="q">-16.8 MVAr</text>'
            + '</g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        expect(container.querySelector('#p')!.hasAttribute('data-feeder-wrap')).toBe(false);
        expect(container.querySelector('#q')!.hasAttribute('data-feeder-wrap')).toBe(false);
    });

    it('leaves an already-relabelled feeder alone (relabel wraps its own)', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell">'
            + '<text id="r" data-feeder-relabel="1">LANNEMEZAN 225kV 1</text>'
            + '</g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        expect(container.querySelector('#r')!.hasAttribute('data-feeder-wrap')).toBe(false);
    });

    it('ignores long text outside a feeder cell (e.g. the busbar label)', () => {
        const container = mount(
            '<svg><text id="bb">VL_virtual_relation_8423568_a_0-225_BBS1</text></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        expect(container.querySelector('#bb')!.hasAttribute('data-feeder-wrap')).toBe(false);
    });

    it('restores the original text on a subsequent call with no svg', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell">'
            + '<text id="g">G_virtual_relation_8423568_a_0-225</text>'
            + '</g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        applyFeederLabelWrap(container, null);
        const t = container.querySelector('#g')!;
        expect(t.hasAttribute('data-feeder-wrap')).toBe(false);
        expect(t.textContent).toBe('G_virtual_relation_8423568_a_0-225');
    });

    it('skips highlight clones', () => {
        const container = mount(
            '<svg><g class="sld-extern-cell">'
            + '<g class="sld-highlight-clone"><text>G_virtual_relation_8423568_a_0-225</text></g>'
            + '<text id="orig">G_virtual_relation_8423568_a_0-225</text>'
            + '</g></svg>',
        );
        applyFeederLabelWrap(container, '<svg/>');
        expect(container.querySelector('#orig')!.getAttribute('data-feeder-wrap')).toBe('1');
        expect(container.querySelector('.sld-highlight-clone text')!.hasAttribute('data-feeder-wrap')).toBe(false);
    });
});
