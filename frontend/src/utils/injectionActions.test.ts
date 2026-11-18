// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import type { ActionDetail, RedispatchDetail } from '../types';
import {
    antennaAggregateContent,
    clampRedispatchDelta,
    redispatchTotal,
    totalReductionMw,
} from './injectionActions';

const base: ActionDetail = {
    description_unitaire: '',
    rho_before: null,
    rho_after: null,
    max_rho: null,
    max_rho_line: '',
    is_rho_reduction: false,
};

const rd = (over: Partial<RedispatchDetail>): RedispatchDetail => ({
    gen_name: 'G', voltage_level_id: null, delta_mw: 0, target_mw: 0, direction: 'up', ...over,
});

describe('totalReductionMw', () => {
    it('sums the curtailed generators', () => {
        expect(totalReductionMw({
            ...base,
            curtailment_details: [
                { gen_name: 'WIND_A', voltage_level_id: null, curtailed_mw: 9 },
                { gen_name: 'WIND_B', voltage_level_id: null, curtailed_mw: 3 },
            ],
        })).toBe(12);
    });

    it('prefers load shedding, like the single-element readers did', () => {
        expect(totalReductionMw({
            ...base,
            load_shedding_details: [{ load_name: 'L', voltage_level_id: null, shedded_mw: 4 }],
            curtailment_details: [{ gen_name: 'G', voltage_level_id: null, curtailed_mw: 9 }],
        })).toBe(4);
    });

    it('is null without details', () => {
        expect(totalReductionMw(undefined)).toBeNull();
        expect(totalReductionMw({ ...base, curtailment_details: [] })).toBeNull();
    });
});

describe('redispatchTotal', () => {
    it('sums the delta and the raise headroom of an upward aggregate', () => {
        const total = redispatchTotal([
            rd({ delta_mw: 5, max_raise_mw: 15, max_lower_mw: 100 }),
            rd({ delta_mw: 15, max_raise_mw: 45, max_lower_mw: 50 }),
        ]);
        expect(total).toMatchObject({
            deltaMw: 20, direction: 'up', headroomMw: 60, minDeltaMw: 0, maxDeltaMw: 60,
        });
    });

    it('bounds a lowering by the summed lower headroom', () => {
        const total = redispatchTotal([
            rd({ delta_mw: -6, direction: 'down', max_raise_mw: 1, max_lower_mw: 30 }),
            rd({ delta_mw: -2, direction: 'down', max_raise_mw: 1, max_lower_mw: 10 }),
        ]);
        expect(total).toMatchObject({ deltaMw: -8, direction: 'down', headroomMw: 40, minDeltaMw: -40, maxDeltaMw: 0 });
        expect(clampRedispatchDelta(total!, -100)).toBe(-40);
        expect(clampRedispatchDelta(total!, 5)).toBe(0);
    });

    it('leaves the bound open when a generator has no limits', () => {
        const total = redispatchTotal([rd({ delta_mw: 5, max_raise_mw: 15 }), rd({ delta_mw: 5 })]);
        expect(total?.headroomMw).toBeNull();
        expect(total?.maxDeltaMw).toBeUndefined();
        expect(clampRedispatchDelta(total!, 999)).toBe(999);
    });

    it('is null without rows', () => {
        expect(redispatchTotal(undefined)).toBeNull();
        expect(redispatchTotal([])).toBeNull();
    });
});

describe('antennaAggregateContent', () => {
    const scores = {
        renewable_curtailment: {
            scores: { curtail_EVAC_A_1: 0.8, curtail_WIND_A: 0.9 },
            params: {
                curtail_EVAC_A_1: { gen_names: ['WIND_A', 'WIND_B'], target_p_MW: { WIND_A: 81, WIND_B: 27 } },
                curtail_WIND_A: { gen_name: 'WIND_A', target_p_MW: 0 },
            },
        },
        line_reconnection: { scores: { reco_L1: 0.3 }, params: { max_dispatch_flow: 50 } },
    };

    it('rebuilds the generators of an antenna aggregate from its score params', () => {
        expect(antennaAggregateContent(scores, 'curtail_EVAC_A_1')).toEqual({ gens_p: { WIND_A: 81, WIND_B: 27 } });
    });

    it('is null for per-generator candidates and other actions', () => {
        expect(antennaAggregateContent(scores, 'curtail_WIND_A')).toBeNull();
        expect(antennaAggregateContent(scores, 'reco_L1')).toBeNull();
        expect(antennaAggregateContent(undefined, 'curtail_EVAC_A_1')).toBeNull();
        expect(antennaAggregateContent({ x: { scores: {} } }, 'curtail_EVAC_A_1')).toBeNull();
    });
});
