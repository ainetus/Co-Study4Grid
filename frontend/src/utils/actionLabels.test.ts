// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import { collectActionTargets, humanizeIds, manualActionVoltageLevel } from './actionLabels';
import type { ActionDetail, EdgeMeta, NodeMeta } from '../types';

const names: Record<string, string> = {
    'X_GB_way_1271288345-400': 'Exchange with GB',
    'VL_way_1271288345-400': 'MANDARINS 400kV',
    'relation_5674501-400': 'MANDAL71WARAN',
};
const displayName = (id: string) => names[id] ?? id;

const topo = { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} };
const details = (over: Partial<ActionDetail> = {}): ActionDetail => ({
    description_unitaire: '', rho_before: null, rho_after: null, max_rho: null, max_rho_line: '',
    is_rho_reduction: true, action_topology: topo, ...over,
});

describe('humanizeIds', () => {
    it('reads every known id of a text by its name', () => {
        expect(humanizeIds("Effacement 'X_GB_way_1271288345-400' ('VL_way_1271288345-400')", displayName))
            .toBe("Effacement 'Exchange with GB' ('MANDARINS 400kV')");
    });

    it('leaves words, unknown ids and punctuation alone', () => {
        expect(humanizeIds('Manoeuvre manuelle sur VL_way_1271288345-400: SW_1 ouvert, relation_5674501-400 fermé', displayName))
            .toBe('Manoeuvre manuelle sur MANDARINS 400kV: SW_1 ouvert, MANDAL71WARAN fermé');
    });
});

describe('manualActionVoltageLevel', () => {
    it('reads the voltage level a user-built manoeuvre id was minted on', () => {
        expect(manualActionVoltageLevel('user_topo_VL_way_1271288345-400_1795338763679')).toBe('VL_way_1271288345-400');
    });

    it('is null for any other action', () => {
        expect(manualActionVoltageLevel('disco_relation_5674501-400')).toBeNull();
        expect(manualActionVoltageLevel('user_topo_')).toBeNull();
    });
});

describe('collectActionTargets', () => {
    it('titles a line action with its line', () => {
        const t = collectActionTargets('disco_L1', details({ action_topology: { ...topo, lines_or_bus: { L1: -1 } } }), null, null);
        expect(t.title).toEqual([{ id: 'L1', kind: 'line' }]);
        expect(t.locations).toEqual([]);
    });

    it('titles an injection action with its elements, their voltage levels as locations', () => {
        const t = collectActionTargets('load_shedding_X', details({
            load_shedding_details: [{ load_name: 'X', voltage_level_id: 'VL_M', shedded_mw: 5 }],
        }), null, null);
        expect(t.title).toEqual([{ id: 'X', kind: 'equipment' }]);
        expect(t.locations).toEqual([{ id: 'VL_M', kind: 'vl' }]);
    });

    it('titles a coupling action with its voltage level hint, which is also its SLD chip', () => {
        const t = collectActionTargets('open_coupler_VL_M', details({
            action_topology: { ...topo, voltage_level_id: 'VL_M' } as ActionDetail['action_topology'],
        }), null, null);
        expect(t.title).toEqual([{ id: 'VL_M', kind: 'vl' }]);
        expect(t.locations).toEqual([{ id: 'VL_M', kind: 'vl' }]);
    });

    it('titles a manual manoeuvre — combined or not — with the voltage level it was built on', () => {
        expect(collectActionTargets('user_topo_VL_M_17', details(), null, null).title)
            .toEqual([{ id: 'VL_M', kind: 'vl' }]);
        const combined = collectActionTargets('disco_L1+user_topo_VL_N_18',
            details({ action_topology: { ...topo, lines_or_bus: { L1: -1 } } }), null, null);
        expect(combined.title).toEqual([{ id: 'L1', kind: 'line' }, { id: 'VL_N', kind: 'vl' }]);
    });

    it('names an element once, even when the metadata finds it again', () => {
        const nodes = new Map<string, NodeMeta>([['VL_M', { equipmentId: 'VL_M' } as NodeMeta]]);
        const t = collectActionTargets('user_topo_VL_M_17', details({ description_unitaire: "poste 'VL_M'" }), nodes, null);
        expect(t.title).toEqual([{ id: 'VL_M', kind: 'vl' }]);
    });

    it('falls back to the injections of the topology when nothing else names the action', () => {
        const t = collectActionTargets('act', details({ action_topology: { ...topo, loads_p: { LOAD_1: 0 } } }), null, null);
        expect(t.title).toEqual([{ id: 'LOAD_1', kind: 'equipment' }]);
    });

    describe('SLD chips of a transformer / phase shifter', () => {
        const vl = (equipmentId: string, svgId: string) => [equipmentId, { equipmentId, svgId } as NodeMeta] as const;
        const nodes = new Map<string, NodeMeta>([vl('VL_400', '12'), vl('VL_225', '34'), vl('VL_OTHER', '56')]);
        const edge = (equipmentId: string, node1: string, node2: string) =>
            [equipmentId, { equipmentId, svgId: `e_${equipmentId}`, node1, node2 } as EdgeMeta] as const;
        const edges = new Map<string, EdgeMeta>([edge('T_CRUA5', '12', '34'), edge('PST_1', '34', '56'), edge('L1', '12', '56')]);
        const opening = (line: string, description: string) =>
            details({ description_unitaire: description, action_topology: { ...topo, lines_or_bus: { [line]: -1 } } });

        it('offers both ends of an opened transformer', () => {
            const t = collectActionTargets('disco_T_CRUA5', opening('T_CRUA5', "Ouverture du transformateur 'CRUA5 - Liaisons'"), nodes, edges);
            expect(t.title).toEqual([{ id: 'T_CRUA5', kind: 'line' }]);
            expect(t.locations).toEqual([{ id: 'VL_400', kind: 'vl' }, { id: 'VL_225', kind: 'vl' }]);
        });

        it('offers both ends of a tap-changed phase shifter, whatever its id says', () => {
            const t = collectActionTargets('pst_tap_1', details({ action_topology: { ...topo, pst_tap: { PST_1: 3 } } }), nodes, edges);
            expect(t.locations).toEqual([{ id: 'VL_225', kind: 'vl' }, { id: 'VL_OTHER', kind: 'vl' }]);
        });

        it('leaves a plain line opening without chips — it has no single substation', () => {
            const t = collectActionTargets('disco_L1', opening('L1', "Ouverture de la ligne 'L1'"), nodes, edges);
            expect(t.title).toEqual([{ id: 'L1', kind: 'line' }]);
            expect(t.locations).toEqual([]);
        });

        it('waits for the metadata rather than guessing the ends', () => {
            const t = collectActionTargets('disco_T_CRUA5', opening('T_CRUA5', "Ouverture du transformateur 'CRUA5'"), null, null);
            expect(t.locations).toEqual([]);
        });

        it('names a voltage level once when a combined action reaches it twice', () => {
            const t = collectActionTargets('disco_T_CRUA5+user_topo_VL_400_9',
                opening('T_CRUA5', "Ouverture du transformateur 'CRUA5'"), nodes, edges);
            expect(t.locations).toEqual([{ id: 'VL_400', kind: 'vl' }, { id: 'VL_225', kind: 'vl' }]);
        });
    });
});
