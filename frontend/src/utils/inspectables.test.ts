// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { filterInspectables } from './inspectables';

const ITEMS = ['way_109818602-225', 'VL_BIANCON', 'relation_6028666_c-225'];
const NAMES: Record<string, string> = {
    'way_109818602-225': 'LESQUIVE 400kV',
    VL_BIANCON: 'BIANCON 400kV',
};
const displayName = (id: string) => NAMES[id] ?? id;

describe('filterInspectables', () => {
    it('matches on the raw id', () => {
        expect(filterInspectables(ITEMS, 'relation_6028')).toEqual(['relation_6028666_c-225']);
    });

    it('matches on the displayed name (case-insensitive)', () => {
        expect(filterInspectables(ITEMS, 'lesq', displayName)).toEqual(['way_109818602-225']);
    });

    it('does NOT match a name when no displayName is provided', () => {
        expect(filterInspectables(ITEMS, 'LESQUIVE')).toEqual([]);
    });

    it('returns the unfiltered head (capped) for an empty query', () => {
        expect(filterInspectables(ITEMS, '', displayName, 2)).toEqual(ITEMS.slice(0, 2));
    });

    it('respects the limit', () => {
        expect(filterInspectables(['a1', 'a2', 'a3'], 'a', undefined, 2)).toHaveLength(2);
    });
});
