// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi } from 'vitest';
import {
    processSvg,
    boostSvgForLargeGrid,
    buildMetadataIndex,
    getActionTargetLines,
    getActionTargetVoltageLevels,
    getIdMap,
    invalidateIdMapCache,
    applyOverloadedHighlights,
    applyDeltaVisuals,
    applyActionTargetHighlights,
    applyContingencyHighlight,
    buildActionOverviewPins,
    buildUnsimulatedActionPins,
    actionPassesOverviewFilter,
    buildCombinedActionPins,
    applyActionOverviewPins,
    applyActionOverviewHighlights,
    rescaleActionOverviewPins,
    computeActionOverviewFitRect,
    computeEquipmentFitRect,
    PIN_SINGLE_CLICK_DELAY_MS,
} from './svgUtils';
import type { ActionDetail, NodeMeta, EdgeMeta, MetadataIndex } from '../types';

const makeEdgeMap = (...ids: string[]) => {
    const map = new Map<string, EdgeMeta>();
    ids.forEach(id => map.set(id, { equipmentId: id, svgId: `svg-${id}`, node1: '', node2: '' }));
    return map;
};

const makeNodeMap = (...ids: string[]) => {
    const map = new Map<string, NodeMeta>();
    ids.forEach(id => map.set(id, { equipmentId: id, svgId: `svg-${id}`, x: 0, y: 0 }));
    return map;
};

describe('processSvg', () => {
    it('extracts viewBox from SVG string', () => {
        const svg = '<svg viewBox="0 10 800 600"><rect/></svg>';
        const result = processSvg(svg, 10);
        expect(result.viewBox).toEqual({ x: 0, y: 10, w: 800, h: 600 });
    });

    it('returns null viewBox when not present', () => {
        const svg = '<svg><rect/></svg>';
        const result = processSvg(svg, 10);
        expect(result.viewBox).toBeNull();
    });

    it('returns svg string', () => {
        const svg = '<svg viewBox="0 0 100 100"><rect/></svg>';
        const result = processSvg(svg, 10);
        expect(result.svg).toContain('<svg');
    });

    it('handles viewBox with commas', () => {
        const svg = '<svg viewBox="0,0,500,400"><rect/></svg>';
        const result = processSvg(svg, 10);
        expect(result.viewBox).toEqual({ x: 0, y: 0, w: 500, h: 400 });
    });
});

describe('boostSvgForLargeGrid', () => {
    it('returns unchanged SVG for small grids (< 500 VLs)', () => {
        const svg = '<svg viewBox="0 0 1000 1000"><text>hello</text></svg>';
        const vb = { x: 0, y: 0, w: 1000, h: 1000 };
        const result = boostSvgForLargeGrid(svg, vb, 100);
        expect(result).toBe(svg);
    });

    it('returns unchanged SVG when viewBox is null', () => {
        const svg = '<svg><text>hello</text></svg>';
        const result = boostSvgForLargeGrid(svg, null, 600);
        expect(result).toBe(svg);
    });

    it('returns unchanged SVG when ratio <= threshold', () => {
        const svg = '<svg viewBox="0 0 1000 1000"><text>hello</text></svg>';
        // ratio = 1000/1250 = 0.8, below threshold of 3
        const vb = { x: 0, y: 0, w: 1000, h: 1000 };
        const result = boostSvgForLargeGrid(svg, vb, 600);
        expect(result).toBe(svg);
    });

    it('preserves foreignObject content and namespaces', () => {
        const svg = `
            <svg viewBox="0 0 10000 10000">
                <g>
                    <circle cx="100" cy="100" r="5"/>
                    <foreignObject x="90" y="90" width="20" height="20">
                        <div xmlns="http://www.w3.org/1999/xhtml" class="label">Test Label</div>
                    </foreignObject>
                </g>
            </svg>
        `.trim();
        const vb = { x: 0, y: 0, w: 10000, h: 10000 };
        const result = boostSvgForLargeGrid(svg, vb, 600);

        expect(result).toContain('foreignObject');
        expect(result).toContain('http://www.w3.org/1999/xhtml');
        expect(result).toContain('Test Label');
        // Ensure it doesn't get double-encoded or corrupted
        expect(result).not.toContain('&lt;div');
    });
});

describe('buildMetadataIndex', () => {
    it('returns null for null metadata', () => {
        expect(buildMetadataIndex(null)).toBeNull();
    });

    it('returns null for undefined metadata', () => {
        expect(buildMetadataIndex(undefined)).toBeNull();
    });

    it('builds index from object metadata', () => {
        const metadata = {
            nodes: [
                { equipmentId: 'VL1', svgId: 'svg-vl1', x: 100, y: 200 },
                { equipmentId: 'VL2', svgId: 'svg-vl2', x: 300, y: 400 },
            ],
            edges: [
                { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'svg-vl1', node2: 'svg-vl2' },
            ],
        };

        const index = buildMetadataIndex(metadata);
        expect(index).not.toBeNull();
        expect(index!.nodesByEquipmentId.get('VL1')?.svgId).toBe('svg-vl1');
        expect(index!.nodesBySvgId.get('svg-vl2')?.equipmentId).toBe('VL2');
        expect(index!.edgesByEquipmentId.get('LINE_A')?.svgId).toBe('svg-line-a');
        expect(index!.edgesByNode.get('svg-vl1')).toHaveLength(1);
        expect(index!.edgesByNode.get('svg-vl2')).toHaveLength(1);
    });

    it('builds index from JSON string metadata', () => {
        const metadata = JSON.stringify({
            nodes: [{ equipmentId: 'VL1', svgId: 'svg-1', x: 0, y: 0 }],
            edges: [],
        });

        const index = buildMetadataIndex(metadata);
        expect(index).not.toBeNull();
        expect(index!.nodesByEquipmentId.get('VL1')).toBeDefined();
    });

    it('handles empty nodes and edges', () => {
        const index = buildMetadataIndex({ nodes: [], edges: [] });
        expect(index).not.toBeNull();
        expect(index!.nodesByEquipmentId.size).toBe(0);
        expect(index!.edgesByEquipmentId.size).toBe(0);
    });

    it('handles missing nodes and edges', () => {
        const index = buildMetadataIndex({});
        expect(index).not.toBeNull();
        expect(index!.nodesByEquipmentId.size).toBe(0);
    });

    it('indexes edges by both nodes', () => {
        const metadata = {
            nodes: [],
            edges: [
                { equipmentId: 'LINE_X', svgId: 'svg-x', node1: 'n1', node2: 'n2' },
                { equipmentId: 'LINE_Y', svgId: 'svg-y', node1: 'n1', node2: 'n3' },
            ],
        };

        const index = buildMetadataIndex(metadata);
        expect(index!.edgesByNode.get('n1')).toHaveLength(2);
        expect(index!.edgesByNode.get('n2')).toHaveLength(1);
        expect(index!.edgesByNode.get('n3')).toHaveLength(1);
    });
});

describe('getActionTargetLines', () => {

    it('returns lines from topology when only lines are affected', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Disconnect LINE_A',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: -1 },
                lines_or_bus: { LINE_A: -1 },
                gens_bus: {},
                loads_bus: {},
            },
        };

        const result = getActionTargetLines(detail, 'disco_LINE_A', makeEdgeMap('LINE_A'));
        expect(result).toEqual(['LINE_A']);
    });

    it('returns lines when all topology values are -1 (disconnection)', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Test',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: -1, LINE_B: -1 },
                lines_or_bus: { LINE_A: -1 },
                gens_bus: { GEN1: -1 },
                loads_bus: { LOAD1: -1 },
            },
        };

        const result = getActionTargetLines(detail, null, makeEdgeMap('LINE_A', 'LINE_B'));
        expect(result).toContain('LINE_A');
        expect(result).toContain('LINE_B');
    });

    it('falls back to action ID suffix (last _ segment) when no topology', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Test',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        // The function splits by '_' and takes the LAST segment
        // 'disco_LINE-X' → ['disco', 'LINE-X'] → candidate = 'LINE-X'
        const result = getActionTargetLines(detail, 'disco_LINE-X', makeEdgeMap('LINE-X'));
        expect(result).toEqual(['LINE-X']);
    });

    it('returns empty when action ID suffix not in edge map', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Test',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetLines(detail, 'disco_UNKNOWN', makeEdgeMap('LINE_A'));
        expect(result).toEqual([]);
    });

    it('returns empty for null action detail and null action id', () => {
        const result = getActionTargetLines(null, null, makeEdgeMap());
        expect(result).toEqual([]);
    });

    it('does not return lines when gens or loads are also affected', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Complex action',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: 1 },
                lines_or_bus: { LINE_A: 1 },
                gens_bus: { GEN_1: 1 },
                loads_bus: {},
            },
        };

        // With gens involved and values != -1, lines aren't pure line actions
        const result = getActionTargetLines(detail, null, makeEdgeMap('LINE_A'));
        expect(result).toEqual([]);
    });

    it('does not return lines when loads_p is present (power reduction action)', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Load shedding via power reduction',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: 1 },
                lines_or_bus: { LINE_A: 1 },
                gens_bus: {},
                loads_bus: {},
                loads_p: { LOAD_1: 0.0 },
            },
        };

        // loads_p present means this isn't a pure line action
        const result = getActionTargetLines(detail, null, makeEdgeMap('LINE_A'));
        expect(result).toEqual([]);
    });

    it('does not return lines when gens_p is present (curtailment power reduction)', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Curtailment via power reduction',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: 1 },
                lines_or_bus: { LINE_A: 1 },
                gens_bus: {},
                loads_bus: {},
                gens_p: { WIND_1: 0.0 },
            },
        };

        const result = getActionTargetLines(detail, null, makeEdgeMap('LINE_A'));
        expect(result).toEqual([]);
    });

    it('handles combined action IDs with + separator', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Multiple lines',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };
        const result = getActionTargetLines(detail, 'disco_LINE_A+disco_LINE_B', makeEdgeMap('LINE_A', 'LINE_B'));
        expect(result).toContain('LINE_A');
        expect(result).toContain('LINE_B');
        expect(result).toHaveLength(2);
    });

    it('extracts the line target of a combined disco+coupling action', () => {
        // Regression: the combined ID contains "coupling" via the
        // second sub-action, which used to trip the global
        // `isCouplingAction` check and suppress ALL line-target
        // extraction — the disco line lost its pink halo AND its
        // action-card badge. After the fix, the coupling flag is
        // evaluated per `+`-split part so the disco sub-action's
        // line target is still returned.
        const detail: ActionDetail = {
            description_unitaire: "Ouverture de la ligne 'BEON L31P.SAO' + Ouverture COUCHP6_COUCH6COUPL DJ_OC dans le poste COUCHP6",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            // Combined topology: merged bus changes from disco + coupling.
            action_topology: {
                lines_ex_bus: { 'BEON L31P.SAO': -1 },
                lines_or_bus: { 'BEON L31P.SAO': -1 },
                gens_bus: {},
                loads_bus: {},
            },
        };
        const result = getActionTargetLines(
            detail,
            'disco_BEON L31P.SAO+f344b395-9908-43c2-bca0-75c5f298465e_COUCHP6_coupling',
            makeEdgeMap('BEON L31P.SAO'),
        );
        expect(result).toContain('BEON L31P.SAO');
    });

    it('returns no line targets for combined coupling+coupling actions', () => {
        // Both sub-actions are VL-level — all targets flow through
        // getActionTargetVoltageLevels instead. This stays empty.
        const detail: ActionDetail = {
            description_unitaire: 'Ouverture COUCHP6 + Ouverture C.REGP6',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };
        const result = getActionTargetLines(
            detail,
            '466f2c03-90ce-401e-a458-fa177ad45abc_C.REGP6_coupling+f344b395-9908-43c2-bca0-75c5f298465e_COUCHP6_coupling',
            makeEdgeMap('LINE_A'),
        );
        expect(result).toEqual([]);
    });

    it('extracts PST targets in a combined PST+coupling action', () => {
        // pst_tap is always explicit in the topology, regardless of
        // whether the combined action also contains a coupling.
        const detail: ActionDetail = {
            description_unitaire: 'PST tap + coupling',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: {},
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
                pst_tap: { PST_LINE_1: 5 },
            },
        };
        const result = getActionTargetLines(
            detail,
            'pst_PST_LINE_1+uuid_VL_X_coupling',
            makeEdgeMap('PST_LINE_1'),
        );
        expect(result).toContain('PST_LINE_1');
    });

    it('extracts lines from pst_tap in topology', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Change PST tap',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                pst_tap: { PST_LINE_1: 5 },
                lines_ex_bus: {},
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
            },
        };

        const result = getActionTargetLines(detail, null, makeEdgeMap('PST_LINE_1'));
        expect(result).toEqual(['PST_LINE_1']);
    });

    it('strips _inc/_dec suffixes from action ID parts', () => {
        const detail: ActionDetail = {
            description_unitaire: 'PST action with suffix',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        // pst_tap_.ARKA TD 661_inc2 -> stripped to pst_tap_.ARKA TD 661
        // then parsed to .ARKA TD 661
        const result = getActionTargetLines(detail, 'pst_tap_LINE_PST_inc2', makeEdgeMap('LINE_PST'));
        expect(result).toEqual(['LINE_PST']);
    });

    it('handles combined PST actions with suffixes', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Combined PST and Line',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetLines(
            detail,
            'pst_tap_PST_A_inc1+disco_LINE_B',
            makeEdgeMap('PST_A', 'LINE_B')
        );
        expect(result).toContain('PST_A');
        expect(result).toContain('LINE_B');
        expect(result).toHaveLength(2);
    });

    it('suppresses topology lines for coupling actions but keeps pst_tap', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Coupling with side effects',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_SIDE_EFFECT: -1 },
                pst_tap: { PST_LINE: 5 },
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
            },
        };

        const result = getActionTargetLines(detail, 'MQIS P7_coupling', makeEdgeMap('LINE_SIDE_EFFECT', 'PST_LINE'));

        // Should NOT contain LINE_SIDE_EFFECT (it's a side effect of coupling)
        expect(result).not.toContain('LINE_SIDE_EFFECT');
        // Should STILL contain PST_LINE
        expect(result).toContain('PST_LINE');
        expect(result).toHaveLength(1);
    });
});

describe('getActionTargetVoltageLevels', () => {

    it('extracts the VL from a redispatch_details entry (gen highlight)', () => {
        const detail: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null, rho_after: null, max_rho: null, max_rho_line: '',
            is_rho_reduction: false,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL_GEN', delta_mw: 10, target_mw: 40, direction: 'up' },
            ],
        };
        const result = getActionTargetVoltageLevels(detail, 'redispatch_THERM_1', makeNodeMap('VL_GEN'));
        expect(result).toEqual(['VL_GEN']);
    });

    it('extracts the VL from load_shedding / curtailment detail arrays too', () => {
        const ls: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null, rho_after: null, max_rho: null, max_rho_line: '',
            is_rho_reduction: false,
            load_shedding_details: [{ load_name: 'L1', voltage_level_id: 'VL_LS', shedded_mw: 5 }],
        };
        expect(getActionTargetVoltageLevels(ls, 'load_shedding_L1', makeNodeMap('VL_LS'))).toEqual(['VL_LS']);
        const rc: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null, rho_after: null, max_rho: null, max_rho_line: '',
            is_rho_reduction: false,
            curtailment_details: [{ gen_name: 'W1', voltage_level_id: 'VL_RC', curtailed_mw: 8 }],
        };
        expect(getActionTargetVoltageLevels(rc, 'curtail_W1', makeNodeMap('VL_RC'))).toEqual(['VL_RC']);
    });

    it('extracts VL from quoted string in description', () => {
        const detail: ActionDetail = {
            description_unitaire: "Ouverture couplage dans le poste 'SUBSTATION_A'",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, null, makeNodeMap('SUBSTATION_A'));
        expect(result).toEqual(['SUBSTATION_A']);
    });

    it('tries last quoted string first', () => {
        const detail: ActionDetail = {
            description_unitaire: "Action on 'IRRELEVANT' at poste 'VL_TARGET'",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, null, makeNodeMap('VL_TARGET'));
        expect(result).toEqual(['VL_TARGET']);
    });

    it('falls back to action ID suffix', () => {
        const detail: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, 'open_coupling_VL1', makeNodeMap('VL1'));
        expect(result).toEqual(['VL1']);
    });

    it('returns empty array when no match found', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Some generic action',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, 'action_UNKNOWN', makeNodeMap('VL1'));
        expect(result).toEqual([]);
    });

    it('returns empty array for null detail', () => {
        const result = getActionTargetVoltageLevels(null, null, makeNodeMap('VL1'));
        expect(result).toEqual([]);
    });

    it('extracts multiple VLs from combined ID', () => {
        const detail: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, 'open_coupling_VL1+open_coupling_VL2', makeNodeMap('VL1', 'VL2'));
        expect(result).toContain('VL1');
        expect(result).toContain('VL2');
        expect(result).toHaveLength(2);
    });

    it('extracts multiple VLs from description using quoted strings and "poste" keyword', () => {
        const detail: ActionDetail = {
            description_unitaire: "Action entre le poste 'VL1' and 'VL2', plus a manual action au poste VL3",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, null, makeNodeMap('VL1', 'VL2', 'VL3'));
        expect(result).toContain('VL1');
        expect(result).toContain('VL2');
        expect(result).toContain('VL3');
        expect(result).toHaveLength(3);
    });

    it('skips action ID fallback for line reconnection actions', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Reconnect line',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: 1 },
                lines_or_bus: { LINE_A: 2 },
                gens_bus: {},
                loads_bus: {},
            },
        };

        // Even though action ID suffix matches a VL, should return empty array
        // because it's a line reconnection (lines with bus >= 0, no gen/load)
        const result = getActionTargetVoltageLevels(detail, 'reco_VL1', makeNodeMap('VL1'));
        expect(result).toEqual([]);
    });

    it('does not skip action ID fallback when loads_p is present (not a reconnection)', () => {
        const detail: ActionDetail = {
            description_unitaire: 'Power reduction on load',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE_A: 1 },
                lines_or_bus: { LINE_A: 2 },
                gens_bus: {},
                loads_bus: {},
                loads_p: { LOAD_1: 0.0 },
            },
        };

        // Even though lines have bus >= 0, loads_p presence means it's NOT a pure reconnection
        const result = getActionTargetVoltageLevels(detail, 'action_VL1', makeNodeMap('VL1'));
        expect(result).toEqual(['VL1']);
    });

    it('strips _inc/_dec suffixes in fallback ID parsing', () => {
        const detail: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, 'open_coupling_VL1_inc2', makeNodeMap('VL1'));
        expect(result).toEqual(['VL1']);
    });

    it('extracts VL with spaces from description without quotes', () => {
        const detail: ActionDetail = {
            description_unitaire: "Ouverture MQIS P7_MQIS 7COUPL DJ_OC dans le poste MQIS P7",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, null, makeNodeMap('MQIS P7'));
        expect(result).toEqual(['MQIS P7']);
    });

    it('extracts VL from mid-ID segment with spaces', () => {
        const detail: ActionDetail = {
            description_unitaire: 'No description available',
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const actionId = 'de829050-177c-4244-ba94-61b22d2684a4_MQIS P7_coupling';
        const result = getActionTargetVoltageLevels(detail, actionId, makeNodeMap('MQIS P7'));
        expect(result).toEqual(['MQIS P7']);
    });

    it('extracts VL using prefix matching (handles "MICQ P7 is open")', () => {
        const detail: ActionDetail = {
            description_unitaire: "Ouverture dans le poste MICQ P7 is open",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
        };

        const result = getActionTargetVoltageLevels(detail, null, makeNodeMap('MICQ P7'));
        expect(result).toEqual(['MICQ P7']);
    });

    it('recognizes "coupl" substring (e.g. in COUCH6COUPL) for coupling detection', () => {
        const detail: ActionDetail = {
            description_unitaire: "Ouverture OC 'COUCH6COUPL DJ_OC' dans le poste 'COUCHP6'",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE1: -1 },
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
            }
        } as unknown as ActionDetail;

        const result = getActionTargetLines(detail, 'f344..._COUCHP6', makeEdgeMap('LINE1'));
        // Should suppress LINE1 because it's a coupling action (detected "COUPL")
        expect(result).not.toContain('LINE1');
    });

    it('recognizes French "noeud" keyword for coupling detection', () => {
        const detail: ActionDetail = {
            description_unitaire: "Reconfiguration au noeud",
            rho_before: null,
            rho_after: null,
            max_rho: null,
            max_rho_line: '',
            is_rho_reduction: false,
            action_topology: {
                lines_ex_bus: { LINE1: -1 },
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
            }
        } as unknown as ActionDetail;

        const result = getActionTargetLines(detail, 'some_uuid', makeEdgeMap('LINE1'));
        expect(result).not.toContain('LINE1');
    });
});

describe('getIdMap', () => {
    const makeContainer = (html: string) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div;
    };

    it('builds a map of id → element from container children', () => {
        const container = makeContainer('<svg><g id="node1"></g><g id="node2"></g></svg>');
        const map = getIdMap(container);
        expect(map.size).toBeGreaterThanOrEqual(2);
        expect(map.get('node1')).toBeDefined();
        expect(map.get('node2')).toBeDefined();
    });

    it('returns the same cached map on repeated calls', () => {
        const container = makeContainer('<svg><g id="a"></g></svg>');
        const map1 = getIdMap(container);
        const map2 = getIdMap(container);
        expect(map1).toBe(map2);
    });

    it('rebuilds the map when the SVG element changes', () => {
        const container = makeContainer('<svg><g id="a"></g></svg>');
        const map1 = getIdMap(container);
        expect(map1.get('a')).toBeDefined();

        // Replace the SVG entirely
        container.innerHTML = '<svg><g id="b"></g></svg>';
        const map2 = getIdMap(container);
        expect(map2).not.toBe(map1);
        expect(map2.get('b')).toBeDefined();
        expect(map2.get('a')).toBeUndefined();
    });

    it('rebuilds after invalidateIdMapCache is called', () => {
        const container = makeContainer('<svg><g id="x"></g></svg>');
        const map1 = getIdMap(container);
        invalidateIdMapCache(container);
        const map2 = getIdMap(container);
        // Different Map instance even though content is the same
        expect(map2).not.toBe(map1);
    });
});

describe('applyOverloadedHighlights', () => {
    const makeMetaIndex = (): MetadataIndex => ({
        nodesByEquipmentId: new Map(),
        nodesBySvgId: new Map(),
        edgesByEquipmentId: new Map([
            ['LINE_A', { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'n1', node2: 'n2' }],
            ['LINE_B', { equipmentId: 'LINE_B', svgId: 'svg-line-b', node1: 'n2', node2: 'n3' }],
        ]),
        edgesByNode: new Map(),
    });

    it('adds nad-overloaded clone for matching edges', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-line-a"><path/></g><g id="svg-line-b"><path/></g></svg>';
        const metaIndex = makeMetaIndex();

        applyOverloadedHighlights(container, metaIndex, ['LINE_A']);

        // Clone with nad-overloaded should exist
        const clones = container.querySelectorAll('.nad-highlight-clone.nad-overloaded');
        expect(clones.length).toBe(1);

        // Original should NOT have the class
        const elB = container.querySelector('#svg-line-b');
        expect(elB?.classList.contains('nad-overloaded')).toBe(false);
    });

    it('clears previous overloaded highlight clones before applying new ones', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-line-a"><path/></g><g id="svg-line-b"><path/></g></svg>';
        const metaIndex = makeMetaIndex();

        // First apply on LINE_A
        applyOverloadedHighlights(container, metaIndex, ['LINE_A']);
        expect(container.querySelectorAll('.nad-highlight-clone.nad-overloaded').length).toBe(1);

        // Now apply on LINE_B — should clear LINE_A clone
        applyOverloadedHighlights(container, metaIndex, ['LINE_B']);
        const clones = container.querySelectorAll('.nad-highlight-clone.nad-overloaded');
        expect(clones.length).toBe(1);
    });

    it('does nothing with empty overloaded lines array', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-line-a"><path/></g></svg>';
        const metaIndex = makeMetaIndex();

        applyOverloadedHighlights(container, metaIndex, []);
        // No clones should be added
        expect(container.querySelectorAll('.nad-highlight-clone.nad-overloaded').length).toBe(0);
    });
});

describe('applyDeltaVisuals', () => {
    const makeMetaIndex = (): MetadataIndex => ({
        nodesByEquipmentId: new Map(),
        nodesBySvgId: new Map(),
        edgesByEquipmentId: new Map([
            ['LINE_A', {
                equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'n1', node2: 'n2',
                edgeInfo1: { svgId: 'info1-a' },
                edgeInfo2: { svgId: 'info2-a' },
            } as EdgeMeta],
        ]),
        edgesByNode: new Map(),
    });

    it('applies delta classes and text in delta mode', () => {
        const container = document.createElement('div');
        container.innerHTML = `<svg>
            <g id="svg-line-a"><path/></g>
            <g id="info1-a"><text>123.4</text></g>
            <g id="info2-a"><text>56.7</text></g>
        </svg>`;
        const metaIndex = makeMetaIndex();
        const diagram = {
            flow_deltas: { LINE_A: { delta: 5.2, category: 'positive' } },
        };

        applyDeltaVisuals(container, diagram, metaIndex, true);

        expect(container.querySelector('#svg-line-a')?.classList.contains('nad-delta-positive')).toBe(true);
        expect(container.querySelector('#info1-a text')?.textContent).toBe('\u0394 +5.2');
        expect(container.querySelector('#info1-a text')?.getAttribute('data-original-text')).toBe('123.4');
    });

    it('restores original text when switching out of delta mode', () => {
        const container = document.createElement('div');
        container.innerHTML = `<svg>
            <g id="svg-line-a"><path/></g>
            <g id="info1-a"><text data-original-text="123.4">Δ +5.2</text></g>
            <g id="info2-a"><text data-original-text="56.7">Δ +5.2</text></g>
        </svg>`;
        const metaIndex = makeMetaIndex();

        applyDeltaVisuals(container, { flow_deltas: {} }, metaIndex, false);

        expect(container.querySelector('#info1-a text')?.textContent).toBe('123.4');
        expect(container.querySelector('#info1-a text')?.hasAttribute('data-original-text')).toBe(false);
    });

    it('does nothing when diagram is null', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-line-a"><path/></g></svg>';
        const metaIndex = makeMetaIndex();

        // Should not throw
        applyDeltaVisuals(container, null, metaIndex, true);
    });

    it('applies negative delta class correctly', () => {
        const container = document.createElement('div');
        container.innerHTML = `<svg>
            <g id="svg-line-a"><path/></g>
            <g id="info1-a"><text>10</text></g>
            <g id="info2-a"><text>20</text></g>
        </svg>`;
        const metaIndex = makeMetaIndex();
        const diagram = {
            flow_deltas: { LINE_A: { delta: -3.7, category: 'negative' } },
        };

        applyDeltaVisuals(container, diagram, metaIndex, true);

        expect(container.querySelector('#svg-line-a')?.classList.contains('nad-delta-negative')).toBe(true);
        expect(container.querySelector('#info1-a text')?.textContent).toBe('\u0394 -3.7');
    });
});

describe('Highlight Layering', () => {
    it('inserts the contingency clone as an immediate previous sibling (better stability)', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="svg-line-a"></g><g id="svg-line-b"></g></svg>';
        const metaIndex = {
            edgesByEquipmentId: new Map([
                ['LINE_A', { equipmentId: 'LINE_A', svgId: 'svg-line-a' } as EdgeMeta],
                ['LINE_B', { equipmentId: 'LINE_B', svgId: 'svg-line-b' } as EdgeMeta],
            ]),
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByNode: new Map(),
        } as unknown as MetadataIndex;

        // Apply contingency highlight to LINE_B
        applyContingencyHighlight(container, metaIndex, 'LINE_B');

        const bgLayer = container.querySelector('#nad-background-layer');
        expect(bgLayer).not.toBeNull();

        const clone = bgLayer!.querySelector('.nad-contingency-highlight') as SVGGraphicsElement;
        expect(clone).not.toBeNull();
        expect(clone.classList.contains('nad-highlight-clone')).toBe(true);
        expect(clone.style.display).toBe('block');
        expect(clone.style.visibility).toBe('visible');
        expect(clone.getAttribute('transform')).toMatch(/matrix/);
    });

    it('verifies that the background layer is the first child of the SVG (z-order)', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <svg><g id="svg-a"></g><g id="grid-layer"></g></svg>
        `;
        const metaIndex = {
            edgesByEquipmentId: new Map([['LINE_A', { svgId: 'svg-a' } as EdgeMeta]]),
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByNode: new Map()
        } as MetadataIndex;

        // Trigger background layer creation by applying a highlight to a valid element
        applyContingencyHighlight(container, metaIndex, 'LINE_A');

        const svg = container.querySelector('svg')!;
        expect(svg.firstElementChild).not.toBeNull();
        expect(svg.firstElementChild!.id).toBe('nad-background-layer');
    });

    it('exhaustive cleanup: removes existing contingency highlights before adding new ones', () => {
        const container = document.createElement('div');
        // Setup multiple clones and one original with the class
        container.innerHTML = `
            <svg>
                <g id="nad-background-layer">
                    <path class="nad-contingency-highlight nad-highlight-clone"></path>
                    <path class="nad-contingency-highlight nad-highlight-clone"></path>
                </g>
                <path id="original" class="nad-contingency-highlight"></path>
            </svg>
        `;
        const metaIndex = {
            edgesByEquipmentId: new Map([['NEW_LINE', { equipmentId: 'NEW', svgId: 'original_new' } as EdgeMeta]]),
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByNode: new Map()
        } as MetadataIndex;

        // Mock getIdMap to return no element for NEW_LINE to avoid creating new ones during cleanup check
        applyContingencyHighlight(container, metaIndex, 'NON_EXISTENT');

        expect(container.querySelectorAll('.nad-highlight-clone').length).toBe(0);
        expect(container.querySelector('#original')?.classList.contains('nad-contingency-highlight')).toBe(false);
    });

    describe('applyActionTargetHighlights', () => {
        it('adds nad-action-target-original class to original elements and creates clones in background layer', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="nad-background-layer"></g>
                    <path id="svg-L1" class="line"></path>
                    <circle id="svg-N1" class="node"></circle>
                </svg>
            `;
            const metaIndex = {
                edgesByEquipmentId: new Map([['L1', { equipmentId: 'L1', svgId: 'svg-L1' } as EdgeMeta]]),
                nodesByEquipmentId: new Map([['N1', { equipmentId: 'N1', svgId: 'svg-N1' } as NodeMeta]]),
                nodesBySvgId: new Map(),
                edgesByNode: new Map()
            } as MetadataIndex;
            const actionDetail = {
                description_unitaire: "Ouvrir 'L1' et 'N1'",
                action_topology: {
                    lines_ex_bus: { 'L1': -1 },
                    gens_bus: { 'N1': -1 }
                }
            } as unknown as ActionDetail;

            applyActionTargetHighlights(container, metaIndex, actionDetail, 'act-N1');

            const originalLine = container.querySelector('#svg-L1');
            const originalNode = container.querySelector('#svg-N1');
            expect(originalLine?.classList.contains('nad-action-target-original')).toBe(true);
            expect(originalNode?.classList.contains('nad-action-target-original')).toBe(true);

            const clones = container.querySelectorAll('.nad-highlight-clone.nad-action-target');
            expect(clones.length).toBe(2);
            expect((clones[0].parentNode as Element)?.id).toBe('nad-background-layer');
        });

        it('cleans up existing highlights and original classes before applying new ones', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="nad-background-layer">
                        <path class="nad-action-target nad-highlight-clone"></path>
                    </g>
                    <path id="svg-L1" class="nad-action-target-original"></path>
                </svg>
            `;
            const metaIndex = {
                edgesByEquipmentId: new Map(),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map()
            } as MetadataIndex;

            applyActionTargetHighlights(container, metaIndex, null, null);

            expect(container.querySelectorAll('.nad-highlight-clone').length).toBe(0);
            expect(container.querySelector('#svg-L1')?.classList.contains('nad-action-target-original')).toBe(false);
        });

        // REGRESSION (Remedial Action tab): applyHighlightsForTab calls
        // applyOverloadedHighlights FIRST (planting .nad-overloaded clones
        // in the background layer) and then applyActionTargetHighlights
        // right after. The latter used to blanket-remove every
        // `.nad-highlight-clone`, which wiped the freshly planted
        // overload clones and left the main Network Action tab with no
        // orange halos for persistent / new overloads. It must now only
        // remove its own `.nad-action-target` clones.
        it('preserves existing .nad-overloaded clones when re-applying action target highlights', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="nad-background-layer">
                        <path class="nad-overloaded nad-highlight-clone" data-test="overload-A"></path>
                        <path class="nad-action-target nad-highlight-clone" data-test="action-stale"></path>
                    </g>
                    <path id="svg-L1" class="line"></path>
                </svg>
            `;
            const metaIndex = {
                edgesByEquipmentId: new Map([['L1', { equipmentId: 'L1', svgId: 'svg-L1' } as EdgeMeta]]),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map(),
            } as MetadataIndex;
            const actionDetail = {
                description_unitaire: "Ouvrir 'L1'",
                action_topology: { lines_ex_bus: { L1: -1 } },
            } as unknown as ActionDetail;

            applyActionTargetHighlights(container, metaIndex, actionDetail, 'act-L1');

            // Overload clone must STILL be in the DOM (this is the
            // regression guard — before the fix it was removed).
            expect(
                container.querySelector('[data-test="overload-A"]'),
            ).toBeTruthy();
            expect(
                container.querySelectorAll('.nad-highlight-clone.nad-overloaded').length,
            ).toBe(1);
            // Stale action-target clone was removed, and a new one was
            // planted for L1.
            expect(
                container.querySelector('[data-test="action-stale"]'),
            ).toBeNull();
            const newActionClones = container.querySelectorAll(
                '.nad-highlight-clone.nad-action-target',
            );
            expect(newActionClones.length).toBe(1);
        });

        // When called with a null actionDetail (i.e. "deselect the
        // action") we still want to scrub out any stale action-target
        // clones, but the overload clones must remain untouched.
        it('preserves overload clones when called with null actionDetail', () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="nad-background-layer">
                        <path class="nad-overloaded nad-highlight-clone"></path>
                        <path class="nad-action-target nad-highlight-clone"></path>
                    </g>
                </svg>
            `;
            const metaIndex = {
                edgesByEquipmentId: new Map(),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map(),
            } as MetadataIndex;

            applyActionTargetHighlights(container, metaIndex, null, null);

            // Action-target clone gone, overload clone preserved.
            expect(
                container.querySelectorAll('.nad-highlight-clone.nad-action-target').length,
            ).toBe(0);
            expect(
                container.querySelectorAll('.nad-highlight-clone.nad-overloaded').length,
            ).toBe(1);
        });
    });

    // REGRESSION (Impacts mode on N-1 / Remedial Action tabs):
    // applyDeltaVisuals tags the ORIGINAL svg elements with
    // `.nad-delta-positive / .nad-delta-negative / .nad-delta-grey`.
    // The clone-based highlight functions then call cloneNode(true)
    // on those tagged originals; without scrubbing the clone, the
    // clone inherits the delta class. Because the .nad-delta-* CSS
    // rules are declared LATER in App.css than the .nad-overloaded /
    // .nad-action-target / .nad-contingency-highlight rules, they win
    // the cascade and turn the halo into a 3px delta-colored line —
    // visually making the highlight disappear in Impacts mode.
    //
    // Each highlight function must therefore strip nad-delta-* classes
    // from its clones immediately after cloneNode.
    describe('Highlight clones strip nad-delta-* classes (Impacts mode regression)', () => {
        const buildNAD = () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="nad-background-layer"></g>
                    <path id="svg-line-a" class="nad-delta-positive"></path>
                    <path id="svg-line-c" class="nad-delta-grey"></path>
                    <path id="svg-line-action" class="nad-delta-negative"></path>
                </svg>
            `;
            return container;
        };

        it('applyOverloadedHighlights clones are free of nad-delta-* classes', () => {
            const container = buildNAD();
            const metaIndex = {
                edgesByEquipmentId: new Map([
                    ['LINE_A', { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'n1', node2: 'n2' }],
                    ['LINE_C', { equipmentId: 'LINE_C', svgId: 'svg-line-c', node1: 'n3', node2: 'n4' }],
                ]),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map(),
            } as MetadataIndex;

            applyOverloadedHighlights(container, metaIndex, ['LINE_A', 'LINE_C']);

            const clones = container.querySelectorAll('.nad-highlight-clone.nad-overloaded');
            expect(clones.length).toBe(2);
            clones.forEach(c => {
                expect(c.classList.contains('nad-delta-positive')).toBe(false);
                expect(c.classList.contains('nad-delta-negative')).toBe(false);
                expect(c.classList.contains('nad-delta-grey')).toBe(false);
            });
        });

        it('applyContingencyHighlight clone is free of nad-delta-* classes', () => {
            const container = buildNAD();
            const metaIndex = {
                edgesByEquipmentId: new Map([
                    ['LINE_A', { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'n1', node2: 'n2' }],
                ]),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map(),
            } as MetadataIndex;

            applyContingencyHighlight(container, metaIndex, 'LINE_A');

            const clone = container.querySelector('.nad-highlight-clone.nad-contingency-highlight');
            expect(clone).toBeTruthy();
            expect(clone!.classList.contains('nad-delta-positive')).toBe(false);
            expect(clone!.classList.contains('nad-delta-negative')).toBe(false);
            expect(clone!.classList.contains('nad-delta-grey')).toBe(false);
        });

        it('applyActionTargetHighlights clones are free of nad-delta-* classes', () => {
            const container = buildNAD();
            const metaIndex = {
                edgesByEquipmentId: new Map([
                    ['LINE_TARGET', { equipmentId: 'LINE_TARGET', svgId: 'svg-line-action' } as EdgeMeta],
                ]),
                nodesByEquipmentId: new Map(),
                nodesBySvgId: new Map(),
                edgesByNode: new Map(),
            } as MetadataIndex;
            const actionDetail = {
                description_unitaire: "Ouvrir 'LINE_TARGET'",
                action_topology: { lines_ex_bus: { LINE_TARGET: -1 } },
            } as unknown as ActionDetail;

            applyActionTargetHighlights(container, metaIndex, actionDetail, 'act-1');

            const clones = container.querySelectorAll('.nad-highlight-clone.nad-action-target');
            expect(clones.length).toBeGreaterThanOrEqual(1);
            clones.forEach(c => {
                expect(c.classList.contains('nad-delta-positive')).toBe(false);
                expect(c.classList.contains('nad-delta-negative')).toBe(false);
                expect(c.classList.contains('nad-delta-grey')).toBe(false);
            });
        });

        // CSS sanity check: the .nad-delta-* declarations come after
        // .nad-contingency-highlight / .nad-overloaded / .nad-action-target
        // in App.css. If anyone reorders them so .nad-delta-* moves
        // BEFORE the highlight rules, the cascade flips and the strip
        // dance above stops being necessary — but right now this is
        // the ordering we depend on.
        it('App.css declares .nad-delta-* AFTER the highlight rules', () => {
            // Lazy require to keep this test independent of the rest.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const path = require('path');
            const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf-8') as string;
            const overloadIdx = css.indexOf('.nad-overloaded path');
            const contingencyIdx = css.indexOf('.nad-contingency-highlight path');
            const actionTargetIdx = css.indexOf('.nad-action-target path');
            const deltaIdx = css.indexOf('.nad-delta-positive path');
            expect(overloadIdx).toBeGreaterThan(-1);
            expect(contingencyIdx).toBeGreaterThan(-1);
            expect(actionTargetIdx).toBeGreaterThan(-1);
            expect(deltaIdx).toBeGreaterThan(Math.max(overloadIdx, contingencyIdx, actionTargetIdx));
        });
    });

    // REGRESSION (Remedial Action tab post–action-variant-diagram-patch):
    // The three NAD halo primitives append clones to
    // `#nad-background-layer` in call-order; the last-appended clone
    // draws on top (SVG paints in document order). The product
    // spec is "action halo > overload halo > contingency halo"
    // (bottom-to-top), so the call order must be contingency →
    // overload → action. Before the fix, useDiagramHighlights invoked
    // them as overload → action → contingency on the Remedial Action
    // tab, which put the yellow contingency halo on top of the pink
    // action halo — reversed.
    describe('Halo layering order (contingency below overload below action)', () => {
        const buildNAD = () => {
            const container = document.createElement('div');
            container.innerHTML = `
                <svg>
                    <g id="svg-cont" data-role="contingency"></g>
                    <g id="svg-ovl" data-role="overload"></g>
                    <g id="svg-act" data-role="action"></g>
                </svg>
            `;
            return container;
        };

        const metaIndex = {
            edgesByEquipmentId: new Map([
                ['CONT_LINE', { equipmentId: 'CONT_LINE', svgId: 'svg-cont' } as EdgeMeta],
                ['OVL_LINE', { equipmentId: 'OVL_LINE', svgId: 'svg-ovl' } as EdgeMeta],
                ['ACT_LINE', { equipmentId: 'ACT_LINE', svgId: 'svg-act' } as EdgeMeta],
            ]),
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByNode: new Map(),
        } as MetadataIndex;

        it('Remedial Action tab call-order (contingency → overload → action) stacks halos bottom → top', () => {
            const container = buildNAD();
            const actionDetail = {
                description_unitaire: "Ouvrir 'ACT_LINE'",
                action_topology: { lines_ex_bus: { ACT_LINE: -1 } },
            } as unknown as ActionDetail;

            // Exact order of useDiagramHighlights.applyHighlightsForTab('action'):
            applyContingencyHighlight(container, metaIndex, 'CONT_LINE');
            applyOverloadedHighlights(container, metaIndex, ['OVL_LINE']);
            applyActionTargetHighlights(container, metaIndex, actionDetail, 'act-1');

            const bgLayer = container.querySelector('#nad-background-layer');
            expect(bgLayer).not.toBeNull();
            const children = Array.from(bgLayer!.children) as Element[];
            // First appended is drawn at the bottom; last appended is on top.
            const classes = children.map(c => {
                if (c.classList.contains('nad-contingency-highlight')) return 'contingency';
                if (c.classList.contains('nad-overloaded')) return 'overload';
                if (c.classList.contains('nad-action-target')) return 'action';
                return 'other';
            });
            const contingencyIdx = classes.indexOf('contingency');
            const overloadIdx = classes.indexOf('overload');
            const actionIdx = classes.indexOf('action');
            expect(contingencyIdx).toBeGreaterThanOrEqual(0);
            expect(overloadIdx).toBeGreaterThanOrEqual(0);
            expect(actionIdx).toBeGreaterThanOrEqual(0);
            // Bottom → top: contingency, then overload, then action.
            expect(contingencyIdx).toBeLessThan(overloadIdx);
            expect(overloadIdx).toBeLessThan(actionIdx);
        });

        it('N-1 tab call-order (contingency → overload) stacks contingency below overload', () => {
            const container = buildNAD();

            // Exact order of useDiagramHighlights.applyHighlightsForTab('contingency'):
            applyContingencyHighlight(container, metaIndex, 'CONT_LINE');
            applyOverloadedHighlights(container, metaIndex, ['OVL_LINE']);

            const bgLayer = container.querySelector('#nad-background-layer');
            expect(bgLayer).not.toBeNull();
            const children = Array.from(bgLayer!.children) as Element[];
            const contingencyIdx = children.findIndex(c =>
                c.classList.contains('nad-contingency-highlight'),
            );
            const overloadIdx = children.findIndex(c =>
                c.classList.contains('nad-overloaded'),
            );
            expect(contingencyIdx).toBeGreaterThanOrEqual(0);
            expect(overloadIdx).toBeGreaterThanOrEqual(0);
            // Bottom → top: contingency, then overload.
            expect(contingencyIdx).toBeLessThan(overloadIdx);
        });
    });
});

// ============================================================
// Action-overview pins + fit-rect helpers
// ============================================================

const makeOverviewMetaIndex = (): MetadataIndex => {
    // Simple 4-node grid laid out as:
    //   N1 (0,0) ──LINE_A── N2 (100,0)
    //   │                    │
    //  LINE_C               LINE_B
    //   │                    │
    //   N3 (0,100) ─LINE_D─ N4 (100,100)
    //
    // Plus an isolated voltage-level "VL_FAR" at (500, 500).
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
    const nodesByEquipmentId = new Map(nodes.map(n => [n.equipmentId, n] as const));
    const nodesBySvgId = new Map(nodes.map(n => [n.svgId, n] as const));
    const edgesByEquipmentId = new Map(edges.map(e => [e.equipmentId, e] as const));
    const edgesByNode = new Map<string, EdgeMeta[]>();
    edges.forEach(e => {
        if (!edgesByNode.has(e.node1 as string)) edgesByNode.set(e.node1 as string, []);
        edgesByNode.get(e.node1 as string)!.push(e);
        if (!edgesByNode.has(e.node2 as string)) edgesByNode.set(e.node2 as string, []);
        edgesByNode.get(e.node2 as string)!.push(e);
    });
    return { nodesByEquipmentId, nodesBySvgId, edgesByEquipmentId, edgesByNode };
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

describe('buildActionOverviewPins', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('resolves a line action to the edge midpoint', () => {
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.88,
                max_rho_line: 'LINE_B',
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        // LINE_A midpoint = midpoint of (0,0) and (100,0) = (50, 0)
        expect(pins[0]).toMatchObject({ id: 'disco_LINE_A', x: 50, y: 0 });
    });

    it('falls back to the voltage-level node for nodal actions', () => {
        const actions: Record<string, ActionDetail> = {
            'coupling_VL_FAR': makeAction({
                description_unitaire: "Ouverture du poste 'VL_FAR'",
                max_rho: 1.1,
                max_rho_line: 'LINE_D',
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        expect(pins[0]).toMatchObject({ id: 'coupling_VL_FAR', x: 500, y: 500 });
    });

    it('falls back to max_rho_line when no topology target resolves', () => {
        const actions: Record<string, ActionDetail> = {
            'mystery_action': makeAction({
                description_unitaire: 'mystery',
                max_rho: 0.9,
                max_rho_line: 'LINE_D',
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        // LINE_D midpoint = ((0+100)/2, (100+100)/2) = (50, 100)
        expect(pins[0]).toMatchObject({ x: 50, y: 100 });
    });

    it('skips actions whose asset cannot be located', () => {
        const actions: Record<string, ActionDetail> = {
            'unknown': makeAction({ description_unitaire: 'floating', max_rho: 0.5, max_rho_line: 'GHOST_LINE' }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(0);
    });

    it('assigns severity based on monitoringFactor', () => {
        const actions: Record<string, ActionDetail> = {
            'solved': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.5,
            }),
            'low_margin': makeAction({
                action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.92,
            }),
            'still_overloaded': makeAction({
                action_topology: { lines_ex_bus: { LINE_C: -1 }, lines_or_bus: { LINE_C: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 1.1,
            }),
            'divergent': makeAction({
                action_topology: { lines_ex_bus: { LINE_D: -1 }, lines_or_bus: { LINE_D: -1 }, gens_bus: {}, loads_bus: {} },
                non_convergence: 'did not converge',
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        const byId = Object.fromEntries(pins.map(p => [p.id, p] as const));
        expect(byId['solved'].severity).toBe('green');
        expect(byId['low_margin'].severity).toBe('orange');
        expect(byId['still_overloaded'].severity).toBe('red');
        expect(byId['divergent'].severity).toBe('grey');
    });

    it('labels pins with the rounded max loading percentage', () => {
        const actions: Record<string, ActionDetail> = {
            'a': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.873,
                max_rho_line: 'LINE_A',
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins[0].label).toBe('87%');
    });

    it('honours the filterIds allowlist', () => {
        const actions: Record<string, ActionDetail> = {
            'a': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.5,
            }),
            'b': makeAction({
                action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.5,
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95, ['a']);
        expect(pins.map(p => p.id)).toEqual(['a']);
    });

    it('hides pins whose severity is disabled via the overview filter', () => {
        const actions: Record<string, ActionDetail> = {
            'green_a': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.5,
            }),
            'red_b': makeAction({
                action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 1.3,
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95, undefined, {
            categories: { green: true, orange: true, red: false, grey: true },
            threshold: 2.0,
        });
        expect(pins.map(p => p.id)).toEqual(['green_a']);
    });

    it('hides pins whose max_rho exceeds the threshold', () => {
        const actions: Record<string, ActionDetail> = {
            'green_a': makeAction({
                action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: { LINE_A: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 0.5,
            }),
            'red_b': makeAction({
                action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: { LINE_B: -1 }, gens_bus: {}, loads_bus: {} },
                max_rho: 1.6,
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95, undefined, {
            categories: { green: true, orange: true, red: true, grey: true },
            threshold: 1.5,
        });
        expect(pins.map(p => p.id)).toEqual(['green_a']);
    });
});

describe('actionPassesOverviewFilter', () => {
    const cats = (overrides: Partial<{ green: boolean; orange: boolean; red: boolean; grey: boolean }> = {}) => ({
        green: true, orange: true, red: true, grey: true, ...overrides,
    });

    it('returns true for a green action when every category is enabled', () => {
        const detail = makeAction({ max_rho: 0.5 });
        expect(actionPassesOverviewFilter(detail, 0.95, cats(), 1.5)).toBe(true);
    });

    it('returns false when the matching category is disabled', () => {
        const detail = makeAction({ max_rho: 1.2 });
        expect(actionPassesOverviewFilter(detail, 0.95, cats({ red: false }), 2.0)).toBe(false);
    });

    it('returns false when max_rho exceeds the threshold', () => {
        const detail = makeAction({ max_rho: 1.8 });
        expect(actionPassesOverviewFilter(detail, 0.95, cats(), 1.5)).toBe(false);
    });

    it('ignores the threshold for divergent/islanded actions (max_rho null)', () => {
        const detail = makeAction({ max_rho: null, non_convergence: 'diverged' });
        expect(actionPassesOverviewFilter(detail, 0.95, cats(), 1.0)).toBe(true);
    });

    it('hides divergent/islanded actions when the grey category is disabled', () => {
        const detail = makeAction({ max_rho: null, is_islanded: true });
        expect(actionPassesOverviewFilter(detail, 0.95, cats({ grey: false }), 2.0)).toBe(false);
    });
});

describe('buildUnsimulatedActionPins', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('creates dimmed pins for line ids resolved via edgesByEquipmentId', () => {
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex);
        expect(pins).toHaveLength(1);
        expect(pins[0].id).toBe('LINE_A');
        expect(pins[0].unsimulated).toBe(true);
        expect(pins[0].severity).toBe('grey');
        // LINE_A midpoint = (50, 0)
        expect(pins[0].x).toBe(50);
        expect(pins[0].y).toBe(0);
    });

    it('creates dimmed pins for VL ids resolved via nodesByEquipmentId', () => {
        const pins = buildUnsimulatedActionPins(['VL_FAR'], new Set(), metaIndex);
        expect(pins).toHaveLength(1);
        expect(pins[0].id).toBe('VL_FAR');
        expect(pins[0].x).toBe(500);
        expect(pins[0].y).toBe(500);
    });

    it('skips ids that cannot be resolved', () => {
        const pins = buildUnsimulatedActionPins(['GHOST_LINE'], new Set(), metaIndex);
        expect(pins).toHaveLength(0);
    });

    it('skips ids that are already simulated', () => {
        const pins = buildUnsimulatedActionPins(['LINE_A', 'LINE_B'], new Set(['LINE_A']), metaIndex);
        expect(pins.map(p => p.id)).toEqual(['LINE_B']);
    });

    it('dedupes repeated ids in the input list', () => {
        const pins = buildUnsimulatedActionPins(['LINE_A', 'LINE_A'], new Set(), metaIndex);
        expect(pins).toHaveLength(1);
    });

    it('uses a generic tooltip when no score info is provided', () => {
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex);
        expect(pins[0].title).toBe('LINE_A — not yet simulated (double-click to run)');
    });

    it('enriches the tooltip with type, score, rank, max-in-category when score info is provided', () => {
        const info = {
            LINE_A: {
                type: 'line_disconnection',
                score: 0.82,
                mwStart: null,
                tapStart: null,
                rankInType: 3,
                countInType: 12,
                maxScoreInType: 0.95,
            },
        };
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex, info);
        expect(pins[0].title).toContain('Type: line_disconnection');
        expect(pins[0].title).toContain('Score: 0.82');
        expect(pins[0].title).toContain('rank 3 of 12');
        expect(pins[0].title).toContain('max 0.95');
    });

    it('adds MW start to the tooltip when provided (load-shedding / curtailment)', () => {
        const info = {
            LINE_A: {
                type: 'load_shedding',
                score: 1.0,
                mwStart: 24.5,
                tapStart: null,
                rankInType: 1,
                countInType: 4,
                maxScoreInType: 1.0,
            },
        };
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex, info);
        expect(pins[0].title).toContain('MW start: 24.5 MW');
        expect(pins[0].title).not.toContain('Tap start');
    });

    it('adds Tap start (with range) to the tooltip for PST actions', () => {
        const info = {
            LINE_A: {
                type: 'pst_tap_change',
                score: 0.7,
                mwStart: null,
                tapStart: { pst_name: 'PST_X', tap: 0, low_tap: -8, high_tap: 8 },
                rankInType: 2,
                countInType: 5,
                maxScoreInType: 0.9,
            },
        };
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex, info);
        expect(pins[0].title).toContain('Tap start: 0');
        expect(pins[0].title).toContain('range -8 … 8');
    });

    it('falls back to the generic tooltip when the id is missing from scoreInfo', () => {
        const info = {
            OTHER_ID: {
                type: 'line_disconnection', score: 0.5, mwStart: null, tapStart: null,
                rankInType: 1, countInType: 1, maxScoreInType: 0.5,
            },
        };
        const pins = buildUnsimulatedActionPins(['LINE_A'], new Set(), metaIndex, info);
        expect(pins[0].title).toBe('LINE_A — not yet simulated (double-click to run)');
    });
});

describe('applyActionOverviewPins', () => {
    it('appends one <g.nad-action-overview-pin> per pin inside the svg', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 20, severity: 'green', label: '50%', title: 'A' },
            { id: 'b', x: 30, y: 40, severity: 'red', label: '120%', title: 'B' },
        ], () => {});
        const pinGroups = container.querySelectorAll('g.nad-action-overview-pin');
        expect(pinGroups.length).toBe(2);
        const layer = container.querySelector('g.nad-action-overview-pins');
        expect(layer).not.toBeNull();
    });

    it('uses the severity palette (green/orange/red/grey)', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'g', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
            { id: 'o', x: 0, y: 0, severity: 'orange', label: '90%', title: '' },
            { id: 'r', x: 0, y: 0, severity: 'red', label: '110%', title: '' },
            { id: 'x', x: 0, y: 0, severity: 'grey', label: 'DIV', title: '' },
        ], () => {});
        // path now lives inside the inner `pin-body` wrapper so the
        // screen-constant rescaler can upscale it on unzoom. Use a
        // descendant selector so the assertion keeps working.
        const fills = Array.from(container.querySelectorAll('g.nad-action-overview-pin path'))
            .map(el => el.getAttribute('fill'));
        expect(fills).toEqual(['#28a745', '#f0ad4e', '#dc3545', '#9ca3af']);
    });

    it('draws pins WITHOUT an outline (stroke=none, no stroke-width)', () => {
        // Regression guard for the "no black outline around pins"
        // requirement — earlier versions drew a dark stroke and it
        // competed visually with the NAD line strokes.
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 10, severity: 'green', label: '50%', title: '' },
        ], () => {});
        const path = container.querySelector('g.nad-action-overview-pin path');
        expect(path).not.toBeNull();
        expect(path!.getAttribute('stroke')).toBe('none');
        expect(path!.hasAttribute('stroke-width')).toBe(false);
    });

    it('uses a high-contrast dark slate fill on the pin label text (not the severity colour)', () => {
        // Regression: earlier the label text was filled with the
        // severity colour, which matched the teardrop and faded
        // into the pin outline when the text slightly overflowed
        // the inner white disc.
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'g', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
            { id: 'o', x: 0, y: 0, severity: 'orange', label: '90%', title: '' },
            { id: 'r', x: 0, y: 0, severity: 'red', label: '110%', title: '' },
            { id: 'x', x: 0, y: 0, severity: 'grey', label: 'DIV', title: '' },
        ], () => {});
        const texts = Array.from(container.querySelectorAll('g.nad-action-overview-pin text'));
        // Every pin label — regardless of severity — uses the
        // same dark fill so it stays readable on the white disc
        // AND on the coloured teardrop if it overflows.
        texts.forEach(t => {
            expect(t.getAttribute('fill')).toBe('#1f2937');
        });
    });

    it('is idempotent — re-applying wipes the previous layer', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
            { id: 'b', x: 10, y: 10, severity: 'red', label: '110%', title: '' },
        ], () => {});
        applyActionOverviewPins(container, [
            { id: 'c', x: 20, y: 20, severity: 'orange', label: '92%', title: '' },
        ], () => {});
        const layers = container.querySelectorAll('g.nad-action-overview-pins');
        expect(layers.length).toBe(1);
        const pinGroups = container.querySelectorAll('g.nad-action-overview-pin');
        expect(pinGroups.length).toBe(1);
        expect(pinGroups[0].getAttribute('data-action-id')).toBe('c');
    });

    it('empty pin list clears the layer entirely', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        applyActionOverviewPins(container, [], () => {});
        expect(container.querySelectorAll('g.nad-action-overview-pin').length).toBe(0);
    });

    it('clicking a pin invokes onPinClick (deferred) with the action id and screen position', () => {
        vi.useFakeTimers();
        try {
            const container = document.createElement('div');
            container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
            const clicks: Array<{ id: string; pos: { x: number; y: number } }> = [];
            applyActionOverviewPins(container, [
                { id: 'action_42', x: 10, y: 10, severity: 'green', label: '50%', title: '' },
            ], (id, pos) => clicks.push({ id, pos }));
            const pinGroup = container.querySelector('g.nad-action-overview-pin') as SVGGElement;
            pinGroup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            // Deferred: the callback has NOT fired yet because the
            // 250 ms single-click delay is still pending.
            expect(clicks).toEqual([]);
            vi.advanceTimersByTime(PIN_SINGLE_CLICK_DELAY_MS + 10);
            expect(clicks.length).toBe(1);
            expect(clicks[0].id).toBe('action_42');
            // Screen position is derived from getBoundingClientRect;
            // jsdom returns zeros but the object shape is preserved.
            expect(clicks[0].pos).toHaveProperty('x');
            expect(clicks[0].pos).toHaveProperty('y');
        } finally {
            vi.useRealTimers();
        }
    });

    it('double-clicking a pin cancels the pending single-click and fires onPinDoubleClick', () => {
        vi.useFakeTimers();
        try {
            const container = document.createElement('div');
            container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
            const singleClicks: string[] = [];
            const doubleClicks: string[] = [];
            applyActionOverviewPins(
                container,
                [{ id: 'action_42', x: 10, y: 10, severity: 'green', label: '50%', title: '' }],
                id => singleClicks.push(id),
                id => doubleClicks.push(id),
            );
            const pinGroup = container.querySelector('g.nad-action-overview-pin') as SVGGElement;
            // A real browser double-click sends two click events followed
            // by dblclick. The first click schedules the timer, the
            // second is ignored (timer already pending), then dblclick
            // clears the timer and fires the double-click callback.
            pinGroup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            pinGroup.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            pinGroup.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            vi.advanceTimersByTime(PIN_SINGLE_CLICK_DELAY_MS + 10);
            expect(singleClicks).toEqual([]);
            expect(doubleClicks).toEqual(['action_42']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does nothing when the container has no <svg>', () => {
        const container = document.createElement('div');
        // Should NOT throw
        expect(() => applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {})).not.toThrow();
    });

    it('stops mousedown propagation so usePanZoom drag does not eat the click', () => {
        // Regression: if mousedown bubbles up to the svg-container,
        // usePanZoom calls setInteracting(true) which sets
        // pointer-events: none on every svg child via App.css. The
        // pin's click never lands. We assert here that mousedown
        // is stopped at the pin (propagation chain truncated).
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 10, severity: 'green', label: '50%', title: '' },
        ], () => {});
        const pin = container.querySelector('g.nad-action-overview-pin') as SVGGElement;
        let bubbled = false;
        // Listen on the svg ancestor — if propagation is properly
        // stopped at the pin, this listener will NOT fire.
        const svg = container.querySelector('svg')!;
        svg.addEventListener('mousedown', () => { bubbled = true; });
        pin.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(bubbled).toBe(false);
    });
});

describe('applyActionOverviewHighlights', () => {
    const buildContainer = (): { container: HTMLElement; meta: MetadataIndex } => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 1000 1000">' +
            '  <g class="nad-edges">' +
            '    <g id="svg-cont"><line x1="0" y1="0" x2="100" y2="0"/></g>' +
            '    <g id="svg-ovl-1"><line x1="0" y1="100" x2="100" y2="100"/></g>' +
            '    <g id="svg-ovl-2"><line x1="0" y1="200" x2="100" y2="200"/></g>' +
            '  </g>' +
            '</svg>';
        const meta: MetadataIndex = {
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByEquipmentId: new Map<string, EdgeMeta>([
                ['CONT_LINE', { equipmentId: 'CONT_LINE', svgId: 'svg-cont', node1: '', node2: '' }],
                ['OVL_1', { equipmentId: 'OVL_1', svgId: 'svg-ovl-1', node1: '', node2: '' }],
                ['OVL_2', { equipmentId: 'OVL_2', svgId: 'svg-ovl-2', node1: '', node2: '' }],
            ]),
            edgesByNode: new Map(),
        };
        return { container, meta };
    };

    it('creates a .nad-overview-highlight-layer with one clone per highlighted edge', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1', 'OVL_2']);
        const layer = container.querySelector('g.nad-overview-highlight-layer');
        expect(layer).not.toBeNull();
        // 1 contingency + 2 overloads = 3 clones
        expect(layer!.children.length).toBe(3);
    });

    it('uses the existing nad-contingency-highlight class on the contingency clone', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', []);
        const clone = container.querySelector('g.nad-overview-highlight-layer .nad-contingency-highlight');
        expect(clone).not.toBeNull();
        expect(clone!.classList.contains('nad-highlight-clone')).toBe(true);
    });

    it('uses the existing nad-overloaded class on overload clones', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, null, ['OVL_1']);
        const clone = container.querySelector('g.nad-overview-highlight-layer .nad-overloaded');
        expect(clone).not.toBeNull();
        expect(clone!.classList.contains('nad-highlight-clone')).toBe(true);
    });

    it('inserts the highlight layer at the START of the SVG (behind NAD content)', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', []);
        const svg = container.querySelector('svg')!;
        const layer = svg.querySelector(':scope > g.nad-overview-highlight-layer');
        expect(layer).not.toBeNull();
        // Highlight layer should be the first child (behind everything).
        expect(svg.firstElementChild).toBe(layer);
    });

    it('inserts highlight layer BEFORE existing dim rect and pin layer', () => {
        const { container, meta } = buildContainer();
        const svg = container.querySelector('svg')!;
        const SVG_NS = 'http://www.w3.org/2000/svg';

        // Simulate dim rect and pin layer already present (as in the real component).
        const dimRect = document.createElementNS(SVG_NS, 'rect');
        dimRect.setAttribute('class', 'nad-overview-dim-rect');
        svg.appendChild(dimRect);

        const pinLayer = document.createElementNS(SVG_NS, 'g');
        pinLayer.setAttribute('class', 'nad-action-overview-pins');
        svg.appendChild(pinLayer);

        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1']);
        const children = Array.from(svg.children);
        const highlightIdx = children.findIndex(c => c.classList.contains('nad-overview-highlight-layer'));
        const dimIdx = children.findIndex(c => c.classList.contains('nad-overview-dim-rect'));
        const pinIdx = children.findIndex(c => c.classList.contains('nad-action-overview-pins'));
        // Highlights behind NAD content (at start), dim rect and pins after
        expect(highlightIdx).toBe(0);
        expect(highlightIdx).toBeLessThan(dimIdx);
        expect(dimIdx).toBeLessThan(pinIdx);
    });

    it('re-inserts highlight layer at SVG start on idempotent re-call', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1']);
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1', 'OVL_2']);
        const svg = container.querySelector('svg')!;
        const layer = svg.querySelector(':scope > g.nad-overview-highlight-layer');
        // Should still be at the start after the second call.
        expect(svg.firstElementChild).toBe(layer);
    });

    it('is idempotent — repeated calls wipe the previous highlight layer', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1', 'OVL_2']);
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1']);
        const layers = container.querySelectorAll('g.nad-overview-highlight-layer');
        expect(layers.length).toBe(1);
        expect(layers[0].children.length).toBe(2); // 1 contingency + 1 overload
    });

    it('clears the highlight layer when called with neither contingency nor overloads', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1']);
        applyActionOverviewHighlights(container, meta, null, []);
        expect(container.querySelector('g.nad-overview-highlight-layer')).toBeNull();
    });

    it('skips equipment ids that are not in the metadata', () => {
        const { container, meta } = buildContainer();
        applyActionOverviewHighlights(container, meta, 'GHOST', ['OVL_1', 'GHOST2']);
        const layer = container.querySelector('g.nad-overview-highlight-layer')!;
        // Only OVL_1 resolved → 1 clone
        expect(layer.children.length).toBe(1);
    });

    it('no-ops gracefully on null container / metaIndex / svg', () => {
        expect(() => applyActionOverviewHighlights(null, null, null, [])).not.toThrow();
        expect(() => applyActionOverviewHighlights(document.createElement('div'), null, 'X', ['Y'])).not.toThrow();
        const empty = document.createElement('div');
        expect(() => applyActionOverviewHighlights(empty, { nodesByEquipmentId: new Map(), nodesBySvgId: new Map(), edgesByEquipmentId: new Map(), edgesByNode: new Map() }, 'X', [])).not.toThrow();
    });

    it('wraps pin glyph inside a .nad-action-overview-pin-body subgroup for rescaling', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 20, severity: 'green', label: '50%', title: 'A' },
        ], () => {});
        const pin = container.querySelector('g.nad-action-overview-pin')!;
        // Outer group: translate only (no scale at this level)
        expect(pin.getAttribute('transform')).toBe('translate(10 20)');
        // Inner body group: carries the rescaling scale() transform
        const body = pin.querySelector(':scope > g.nad-action-overview-pin-body');
        expect(body).not.toBeNull();
        expect(body!.getAttribute('transform')).toMatch(/^scale\(/);
        // The glyph (path, inner disc, text) all live inside the body
        expect(body!.querySelector('path')).not.toBeNull();
        expect(body!.querySelector('circle')).not.toBeNull();
        expect(body!.querySelector('text')).not.toBeNull();
    });

    it('uses the VL circle radius from the SVG as the pin base radius', () => {
        // Large-grid NAD: VL circles have r=80 (after boost).
        // The pin teardrop path must reference R=80 in its `d`
        // attribute so it matches VL circles at 1:1 zoom.
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 200000 200000">' +
            '  <g class="nad-vl-nodes"><circle r="80"/></g>' +
            '</svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        const path = container.querySelector('g.nad-action-overview-pin path')!;
        // Teardrop arc endpoints: A ${R} ${R} … ${R} ${-R-tail}
        // With R=80, the d attribute must reference "80" in the arc.
        expect(path.getAttribute('d')).toContain('A 80 80');
    });

    it('falls back to r=30 when the SVG has no usable VL circles', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        const path = container.querySelector('g.nad-action-overview-pin path')!;
        expect(path.getAttribute('d')).toContain('A 30 30');
    });
});

describe('rescaleActionOverviewPins', () => {
    const renderContainer = (svgInner: string = ''): HTMLElement => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 1000 1000">' +
            '  <g class="nad-vl-nodes"><circle r="30"/></g>' +
            svgInner +
            '</svg>';
        return container;
    };

    it('is a no-op when the container has no pin layer', () => {
        const container = renderContainer();
        // Should NOT throw even though there's no pin layer yet.
        expect(() => rescaleActionOverviewPins(container)).not.toThrow();
    });

    it('is a no-op when the container has no <svg>', () => {
        const container = document.createElement('div');
        expect(() => rescaleActionOverviewPins(container)).not.toThrow();
    });

    it('applies a scale(1) body transform at 1:1 mapping (jsdom fallback)', () => {
        // jsdom does not implement getScreenCTM, so the rescaler
        // falls back to pxPerSvgUnit=1. With baseR=30 (VL circle)
        // and MIN_SCREEN_RADIUS_PX=22, baseR wins as the floor and
        // the body scale stays at 1.
        const container = renderContainer();
        applyActionOverviewPins(container, [
            { id: 'a', x: 50, y: 50, severity: 'green', label: '50%', title: '' },
        ], () => {});
        rescaleActionOverviewPins(container);
        const body = container.querySelector('g.nad-action-overview-pin-body')!;
        expect(body.getAttribute('transform')).toBe('scale(1)');
    });

    it('upscales the pin body when the zoom level puts VL circles below the screen-pixel floor', () => {
        // Simulate a very zoomed-out NAD: viewBox is 1000 wide but the
        // container is only 100 px wide → pxPerSvgUnit = 100 / 1000 = 0.1.
        // At that ratio, baseR=30 → 3 screen px, well below the
        // 22-px floor, so the rescaler must upscale the body.
        const container = renderContainer();
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        // Mock clientWidth on the container (jsdom reports 0 by default).
        // viewBox="0 0 1000 1000", clientWidth=100 → pxPerSvgUnit = 0.1
        Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });

        rescaleActionOverviewPins(container);
        const body = container.querySelector('g.nad-action-overview-pin-body')!;
        const match = body.getAttribute('transform')!.match(/^scale\(([0-9.]+)\)$/);
        expect(match).not.toBeNull();
        const scale = parseFloat(match![1]);
        // Effective SVG radius = 22 px / 0.1 px/unit = 220 units.
        // Scale = 220 / 30 ≈ 7.33.
        expect(scale).toBeCloseTo(220 / 30, 2);
    });

    it('keeps scale=1 when zoom level is detailed enough (VL circles already above floor)', () => {
        const container = renderContainer();
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        // viewBox="0 0 1000 1000", clientWidth=2000 → pxPerSvgUnit = 2
        // → 30 units = 60 screen px, way above the 22 px floor.
        Object.defineProperty(container, 'clientWidth', { value: 2000, configurable: true });

        rescaleActionOverviewPins(container);
        const body = container.querySelector('g.nad-action-overview-pin-body')!;
        expect(body.getAttribute('transform')).toBe('scale(1)');
    });

    it('rescales EVERY pin on the layer, not just the first', () => {
        const container = renderContainer();
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
            { id: 'b', x: 100, y: 0, severity: 'red', label: '110%', title: '' },
            { id: 'c', x: 200, y: 0, severity: 'orange', label: '92%', title: '' },
        ], () => {});
        // viewBox="0 0 1000 1000", clientWidth=100 → pxPerSvgUnit = 0.1
        Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });

        rescaleActionOverviewPins(container);
        const bodies = container.querySelectorAll('g.nad-action-overview-pin-body');
        expect(bodies.length).toBe(3);
        const scales = Array.from(bodies).map(b => b.getAttribute('transform'));
        // All three pins share the same screen-constant scale.
        expect(new Set(scales).size).toBe(1);
        expect(scales[0]).not.toBe('scale(1)');
    });

    it('is automatically invoked by applyActionOverviewPins for initial sizing', () => {
        // If we never called rescaleActionOverviewPins directly,
        // the pin body should still have a transform attribute —
        // applyActionOverviewPins calls the rescaler at the end so
        // the first paint is already compensated.
        const container = renderContainer();
        applyActionOverviewPins(container, [
            { id: 'a', x: 0, y: 0, severity: 'green', label: '50%', title: '' },
        ], () => {});
        const body = container.querySelector('g.nad-action-overview-pin-body')!;
        expect(body.hasAttribute('transform')).toBe(true);
    });
});

describe('computeActionOverviewFitRect', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('returns null when nothing can be located', () => {
        expect(computeActionOverviewFitRect(metaIndex, null, [], [])).toBeNull();
    });

    it('includes the contingency edge endpoints in the rectangle', () => {
        // LINE_A spans (0,0)→(100,0). Both spans are below
        // MIN_SPAN=200 so they're expanded around their centers:
        //   x: span 100 → 200 centered on 50 → [-50, 150]
        //   y: span 0   → 200 centered on 0  → [-100, 100]
        const rect = computeActionOverviewFitRect(metaIndex, 'LINE_A', [], [], 0);
        expect(rect!.x).toBeCloseTo(-50);
        expect(rect!.w).toBeCloseTo(200);
        expect(rect!.y).toBeCloseTo(-100);
        expect(rect!.h).toBeCloseTo(200);
    });

    it('unions contingency + overloads + pins', () => {
        const rect = computeActionOverviewFitRect(
            metaIndex,
            'LINE_A', // (0,0)..(100,0)
            ['LINE_D'], // (0,100)..(100,100)
            [{ x: 500, y: 500 }],
            0,
        );
        expect(rect!.x).toBeCloseTo(0);
        expect(rect!.y).toBeCloseTo(0);
        expect(rect!.w).toBeCloseTo(500);
        expect(rect!.h).toBeCloseTo(500);
    });

    it('applies a 5% margin by default', () => {
        // Regression guard for the "5% margin" requirement.
        const rect = computeActionOverviewFitRect(
            metaIndex,
            null,
            [],
            [{ x: 0, y: 0 }, { x: 1000, y: 1000 }],
        );
        // Raw bbox is 1000x1000. With 5% padding on each side we
        // expect: x = -50, y = -50, w = 1100, h = 1100.
        expect(rect!.x).toBeCloseTo(-50);
        expect(rect!.y).toBeCloseTo(-50);
        expect(rect!.w).toBeCloseTo(1100);
        expect(rect!.h).toBeCloseTo(1100);
    });

    it('expands degenerate spans (single point) to a minimum size', () => {
        const rect = computeActionOverviewFitRect(
            metaIndex,
            null,
            [],
            [{ x: 10, y: 20 }],
            0,
        );
        // Single point: w=h<MIN_SPAN=200 → expanded to 200 around center
        expect(rect!.w).toBeCloseTo(200);
        expect(rect!.h).toBeCloseTo(200);
        expect(rect!.x).toBeCloseTo(10 - 100);
        expect(rect!.y).toBeCloseTo(20 - 100);
    });

    it('returns null when metaIndex is null', () => {
        expect(computeActionOverviewFitRect(null, 'LINE_A', [], [])).toBeNull();
    });
});

describe('computeEquipmentFitRect', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('focuses on an edge using both endpoints', () => {
        const rect = computeEquipmentFitRect(metaIndex, 'LINE_A', 0);
        // LINE_A spans (0,0)→(100,0); both spans below MIN_SPAN=150
        // → expanded around center (50, 0): x ∈ [-25, 125], y ∈ [-75, 75].
        expect(rect!.x).toBeCloseTo(-25);
        expect(rect!.w).toBeCloseTo(150);
        expect(rect!.y).toBeCloseTo(-75);
        expect(rect!.h).toBeCloseTo(150);
    });

    it('focuses on a voltage-level node', () => {
        const rect = computeEquipmentFitRect(metaIndex, 'VL_FAR', 0);
        // Single point at (500,500) → expanded to 150x150 around center
        expect(rect!.x).toBeCloseTo(500 - 75);
        expect(rect!.y).toBeCloseTo(500 - 75);
        expect(rect!.w).toBeCloseTo(150);
        expect(rect!.h).toBeCloseTo(150);
    });

    it('returns null for an unknown equipment id', () => {
        expect(computeEquipmentFitRect(metaIndex, 'UNKNOWN', 0)).toBeNull();
    });

    it('returns null when metaIndex is null', () => {
        expect(computeEquipmentFitRect(null, 'LINE_A', 0)).toBeNull();
    });
});

// ============================================================
// Performance-critical batching & caching tests
// ============================================================

describe('applyActionOverviewHighlights — batched DOM writes', () => {
    const buildContainer = (): { container: HTMLElement; meta: MetadataIndex } => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 1000 1000">' +
            '  <g class="nad-edges">' +
            '    <g id="svg-cont"><line x1="0" y1="0" x2="100" y2="0"/></g>' +
            '    <g id="svg-ovl-1"><line x1="0" y1="100" x2="100" y2="100"/></g>' +
            '    <g id="svg-ovl-2"><line x1="0" y1="200" x2="100" y2="200"/></g>' +
            '  </g>' +
            '</svg>';
        const meta: MetadataIndex = {
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByEquipmentId: new Map<string, EdgeMeta>([
                ['CONT_LINE', { equipmentId: 'CONT_LINE', svgId: 'svg-cont', node1: '', node2: '' }],
                ['OVL_1', { equipmentId: 'OVL_1', svgId: 'svg-ovl-1', node1: '', node2: '' }],
                ['OVL_2', { equipmentId: 'OVL_2', svgId: 'svg-ovl-2', node1: '', node2: '' }],
            ]),
            edgesByNode: new Map(),
        };
        return { container, meta };
    };

    it('inserts all clones in a single DOM mutation (no interleaved appendChild)', () => {
        const { container, meta } = buildContainer();
        const svg = container.querySelector('svg')!;

        // Count how many times the highlight layer's children change.
        // With the batched DocumentFragment approach, the layer gets
        // a single appendChild(frag) at the end.
        let insertCount = 0;
        // The highlight layer is inserted via appendChild (when no
        // pin layer exists) or insertBefore (when pin layer exists).
        // Spy on both paths to catch the layer insertion, then spy
        // on the layer's appendChild to count clone insertions.
        const spyOnLayer = (node: Node) => {
            if (node instanceof Element && node.classList?.contains('nad-overview-highlight-layer')) {
                const origAppend = node.appendChild.bind(node);
                node.appendChild = function <U extends Node>(child: U): U {
                    insertCount++;
                    return origAppend(child);
                };
            }
        };
        const realAppendChild = svg.appendChild.bind(svg);
        svg.appendChild = function <T extends Node>(node: T): T {
            const result = realAppendChild(node);
            spyOnLayer(node);
            return result;
        };
        const realInsertBefore = svg.insertBefore.bind(svg);
        svg.insertBefore = function <T extends Node>(node: T, ref: Node | null): T {
            const result = realInsertBefore(node, ref);
            spyOnLayer(node);
            return result;
        };

        applyActionOverviewHighlights(container, meta, 'CONT_LINE', ['OVL_1', 'OVL_2']);

        // With DocumentFragment batching, there should be exactly 1
        // appendChild call on the layer (the fragment), not 3 (one
        // per clone).
        expect(insertCount).toBe(1);
        // But all 3 clones still appear in the DOM:
        const layer = container.querySelector('g.nad-overview-highlight-layer')!;
        expect(layer.children.length).toBe(3);
    });

    it('strips nad-delta-* classes from cloned highlights', () => {
        const { container, meta } = buildContainer();
        // Tag an original edge with delta classes that should be
        // stripped on the clone.
        const orig = container.querySelector('#svg-ovl-1')!;
        orig.classList.add('nad-delta-positive');

        applyActionOverviewHighlights(container, meta, null, ['OVL_1']);
        const clone = container.querySelector('g.nad-overview-highlight-layer .nad-overloaded')!;
        expect(clone.classList.contains('nad-delta-positive')).toBe(false);
        expect(clone.classList.contains('nad-delta-negative')).toBe(false);
        expect(clone.classList.contains('nad-delta-grey')).toBe(false);
    });
});

describe('applyActionOverviewPins — batched DOM writes', () => {
    it('builds all pins off-DOM before inserting the layer into the SVG', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"></svg>';
        const svg = container.querySelector('svg')!;

        // Track appendChild calls on the SVG itself.
        let svgAppendCount = 0;
        const origAppend = svg.appendChild.bind(svg);
        svg.appendChild = function <T extends Node>(child: T): T {
            svgAppendCount++;
            return origAppend(child);
        };

        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 20, severity: 'green', label: '50%', title: 'A' },
            { id: 'b', x: 30, y: 40, severity: 'red', label: '120%', title: 'B' },
            { id: 'c', x: 50, y: 60, severity: 'orange', label: '90%', title: 'C' },
        ], () => {});

        // Only ONE appendChild on the SVG (the fully-populated layer),
        // not one per pin.
        expect(svgAppendCount).toBe(1);
        // All 3 pins are present in the DOM:
        expect(container.querySelectorAll('g.nad-action-overview-pin').length).toBe(3);
    });
});

describe('rescaleActionOverviewPins — baseRadius caching', () => {
    it('does not re-query circle[r] on subsequent rescale calls', () => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 1000 1000">' +
            '  <g class="nad-vl-nodes"><circle r="30"/></g>' +
            '</svg>';

        applyActionOverviewPins(container, [
            { id: 'a', x: 50, y: 50, severity: 'green', label: '50%', title: '' },
        ], () => {});

        const svg = container.querySelector('svg')!;
        // After applyActionOverviewPins, the cache is populated.
        // Spy on querySelector to verify it's not called for circle[r]
        // during rescale.
        const origQS = svg.querySelector.bind(svg);
        let circleQueryCount = 0;
        svg.querySelector = function (selector: string) {
            if (selector.includes('circle[r]')) circleQueryCount++;
            return origQS(selector);
        } as typeof svg.querySelector;

        rescaleActionOverviewPins(container);
        rescaleActionOverviewPins(container);
        rescaleActionOverviewPins(container);

        // The cached path should skip the circle[r] lookup entirely.
        expect(circleQueryCount).toBe(0);
    });
});

// ============================================================
// Pin selection/rejection symbols, combined-action pins, and
// load-shedding/curtailment VL anchoring
// ============================================================

describe('buildActionOverviewPins — combined pair exclusion', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('skips action IDs containing "+" (combined pairs)', () => {
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5, action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
            'reco_LINE_B': makeAction({ max_rho: 0.6, action_topology: { lines_ex_bus: { LINE_B: 1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 0.4 }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        const ids = pins.map(p => p.id);
        expect(ids).toContain('disco_LINE_A');
        expect(ids).toContain('reco_LINE_B');
        expect(ids).not.toContain('disco_LINE_A+reco_LINE_B');
        expect(pins).toHaveLength(2);
    });
});

describe('buildActionOverviewPins — load shedding / curtailment VL anchoring', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('anchors load shedding actions on the voltage level node', () => {
        const actions: Record<string, ActionDetail> = {
            'load_shedding_X': makeAction({
                max_rho: 0.8,
                load_shedding_details: [{ load_name: 'LOAD_1', voltage_level_id: 'VL_FAR', shedded_mw: 50 }],
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        expect(pins[0].x).toBe(500);
        expect(pins[0].y).toBe(500);
    });

    it('anchors curtailment actions on the voltage level node', () => {
        const actions: Record<string, ActionDetail> = {
            'curtail_GEN': makeAction({
                max_rho: 0.85,
                curtailment_details: [{ gen_name: 'GEN_1', voltage_level_id: 'VL_N3', curtailed_mw: 30 }],
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        expect(pins[0].x).toBe(0);
        expect(pins[0].y).toBe(100);
    });

    it('falls back to generic resolution when voltage_level_id is null', () => {
        const actions: Record<string, ActionDetail> = {
            'load_shedding_X': makeAction({
                max_rho: 0.7,
                max_rho_line: 'LINE_A',
                load_shedding_details: [{ load_name: 'LOAD_1', voltage_level_id: null, shedded_mw: 50 }],
            }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(1);
        // Falls back to max_rho_line (LINE_A midpoint)
        expect(pins[0].x).toBe(50);
        expect(pins[0].y).toBe(0);
    });
});

describe('buildActionOverviewPins — overlapping pin fan-out', () => {
    const metaIndex = makeOverviewMetaIndex();

    it('fans out pins sharing the same anchor position', () => {
        const actions: Record<string, ActionDetail> = {
            'action_1': makeAction({ max_rho: 0.5, max_rho_line: 'LINE_A' }),
            'action_2': makeAction({ max_rho: 0.6, max_rho_line: 'LINE_A' }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(2);
        // Both would have anchored on LINE_A midpoint (50, 0) but should be offset
        const dx = pins[0].x - pins[1].x;
        const dy = pins[0].y - pins[1].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeGreaterThan(0);
    });

    it('does not offset pins at different positions', () => {
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5, action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
            'disco_LINE_B': makeAction({ max_rho: 0.6, action_topology: { lines_ex_bus: { LINE_B: -1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
        };
        const pins = buildActionOverviewPins(actions, metaIndex, 0.95);
        expect(pins).toHaveLength(2);
        // LINE_A midpoint = (50,0), LINE_B midpoint = (100,50) — different, no fan-out
        const pinA = pins.find(p => p.id === 'disco_LINE_A')!;
        const pinB = pins.find(p => p.id === 'disco_LINE_B')!;
        expect(pinA.x).toBe(50);
        expect(pinA.y).toBe(0);
        expect(pinB.x).toBe(100);
        expect(pinB.y).toBe(50);
    });
});

describe('buildCombinedActionPins', () => {
    const metaIndex = makeOverviewMetaIndex();
    const makeUnitaryPins = () => buildActionOverviewPins({
        'disco_LINE_A': makeAction({ max_rho: 0.5, action_topology: { lines_ex_bus: { LINE_A: -1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
        'reco_LINE_B': makeAction({ max_rho: 0.6, action_topology: { lines_ex_bus: { LINE_B: 1 }, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } }),
    }, metaIndex, 0.95);

    it('returns empty array when actions is null', () => {
        expect(buildCombinedActionPins(null, [], 0.95)).toEqual([]);
    });

    it('returns empty array when no action keys contain "+"', () => {
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
        };
        expect(buildCombinedActionPins(actions, makeUnitaryPins(), 0.95)).toEqual([]);
    });

    it('builds a combined pin when a "+" key exists and both constituents have pins', () => {
        const unitaryPins = makeUnitaryPins();
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 0.45, max_rho_line: 'LINE_C', description_unitaire: 'Combined' }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        expect(combined).toHaveLength(1);
        expect(combined[0].pairId).toBe('disco_LINE_A+reco_LINE_B');
        expect(combined[0].action1Id).toBe('disco_LINE_A');
        expect(combined[0].action2Id).toBe('reco_LINE_B');
    });

    it('places the combined pin at the Bezier midpoint, not on either constituent', () => {
        const unitaryPins = makeUnitaryPins();
        const pin1 = unitaryPins.find(p => p.id === 'disco_LINE_A')!;
        const pin2 = unitaryPins.find(p => p.id === 'reco_LINE_B')!;
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 0.45 }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        const cp = combined[0];
        // Must not be at either constituent position
        const atPin1 = cp.x === pin1.x && cp.y === pin1.y;
        const atPin2 = cp.x === pin2.x && cp.y === pin2.y;
        expect(atPin1).toBe(false);
        expect(atPin2).toBe(false);
    });

    it('assigns severity from the combined ActionDetail', () => {
        const unitaryPins = makeUnitaryPins();
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 1.1 }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        expect(combined[0].severity).toBe('red');
    });

    it('formats label as percentage from max_rho', () => {
        const unitaryPins = makeUnitaryPins();
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 0.657 }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        expect(combined[0].label).toBe('66%');
    });

    it('skips pairs where one constituent has no pin', () => {
        const unitaryPins = makeUnitaryPins();
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+unknown_action': makeAction({ max_rho: 0.4 }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        expect(combined).toHaveLength(0);
    });

    it('stores constituent pin positions in p1 and p2', () => {
        const unitaryPins = makeUnitaryPins();
        const pin1 = unitaryPins.find(p => p.id === 'disco_LINE_A')!;
        const pin2 = unitaryPins.find(p => p.id === 'reco_LINE_B')!;
        const actions: Record<string, ActionDetail> = {
            'disco_LINE_A': makeAction({ max_rho: 0.5 }),
            'reco_LINE_B': makeAction({ max_rho: 0.6 }),
            'disco_LINE_A+reco_LINE_B': makeAction({ max_rho: 0.4 }),
        };
        const combined = buildCombinedActionPins(actions, unitaryPins, 0.95);
        expect(combined[0].p1).toEqual({ x: pin1.x, y: pin1.y });
        expect(combined[0].p2).toEqual({ x: pin2.x, y: pin2.y });
    });
});

describe('applyActionOverviewPins — selected/rejected status', () => {
    const makeSvgContainer = () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"><g class="nad-vl-nodes"><circle r="30"/></g></svg>';
        return container;
    };
    const pins = [
        { id: 'sel', x: 10, y: 10, severity: 'green' as const, label: '50%', title: 'Selected' },
        { id: 'rej', x: 50, y: 50, severity: 'red' as const, label: '110%', title: 'Rejected' },
        { id: 'neu', x: 90, y: 90, severity: 'orange' as const, label: '92%', title: 'Neutral' },
    ];

    it('renders a gold star symbol above selected pins', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            selectedActionIds: new Set(['sel']),
        });
        const selPin = container.querySelector('g[data-action-id="sel"]');
        expect(selPin).not.toBeNull();
        // Star is a path inside the pin body (after teardrop path, circle, text)
        const paths = selPin!.querySelectorAll('.nad-action-overview-pin-body path');
        // First path = teardrop, second path = star
        expect(paths.length).toBeGreaterThanOrEqual(2);
        const starPath = paths[1];
        expect(starPath.getAttribute('fill')).toBe('#eab308'); // gold
    });

    it('renders a red cross symbol above rejected pins', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            rejectedActionIds: new Set(['rej']),
        });
        const rejPin = container.querySelector('g[data-action-id="rej"]');
        expect(rejPin).not.toBeNull();
        const paths = rejPin!.querySelectorAll('.nad-action-overview-pin-body path');
        expect(paths.length).toBeGreaterThanOrEqual(2);
        const crossPath = paths[1];
        expect(crossPath.getAttribute('fill')).toBe('#ef4444'); // red
    });

    it('dims rejected pins to 0.55 opacity', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            rejectedActionIds: new Set(['rej']),
        });
        const rejPin = container.querySelector('g[data-action-id="rej"]');
        expect(rejPin!.getAttribute('opacity')).toBe('0.55');
    });

    it('uses highlighted fill for selected pins', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            selectedActionIds: new Set(['sel']),
        });
        const selPin = container.querySelector('g[data-action-id="sel"]');
        const teardrop = selPin!.querySelector('.nad-action-overview-pin-body path');
        // highlighted green = #1e9e3a (not standard #28a745)
        expect(teardrop!.getAttribute('fill')).toBe('#1e9e3a');
    });

    it('uses dimmed fill for rejected pins', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            rejectedActionIds: new Set(['rej']),
        });
        const rejPin = container.querySelector('g[data-action-id="rej"]');
        const teardrop = rejPin!.querySelector('.nad-action-overview-pin-body path');
        // dimmed red = #d4a5ab (not standard #dc3545)
        expect(teardrop!.getAttribute('fill')).toBe('#d4a5ab');
    });

    it('uses gold stroke on selected pin teardrop', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            selectedActionIds: new Set(['sel']),
        });
        const teardrop = container.querySelector('g[data-action-id="sel"] .nad-action-overview-pin-body path');
        expect(teardrop!.getAttribute('stroke')).toBe('#eab308');
    });

    it('does not add symbols or modify fill for neutral pins', () => {
        const container = makeSvgContainer();
        applyActionOverviewPins(container, pins, () => {}, undefined, {
            selectedActionIds: new Set(['sel']),
            rejectedActionIds: new Set(['rej']),
        });
        const neuPin = container.querySelector('g[data-action-id="neu"]');
        const paths = neuPin!.querySelectorAll('.nad-action-overview-pin-body path');
        expect(paths.length).toBe(1); // only teardrop, no symbol
        expect(paths[0].getAttribute('fill')).toBe('#f0ad4e'); // standard orange
        expect(neuPin!.hasAttribute('opacity')).toBe(false);
    });
});

describe('applyActionOverviewPins — combined action rendering', () => {
    const makeSvgContainer = () => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 200 200">' +
            '  <g class="nad-vl-nodes"><circle r="30"/></g>' +
            '  <g class="nad-edge-paths"><path style="stroke-width: 5"/></g>' +
            '</svg>';
        return container;
    };
    const unitaryPins = [
        { id: 'a1', x: 10, y: 10, severity: 'green' as const, label: '50%', title: '' },
        { id: 'a2', x: 100, y: 100, severity: 'red' as const, label: '110%', title: '' },
    ];

    it('renders a curved dashed path between constituent pins', () => {
        const container = makeSvgContainer();
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: 'combined', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const curves = container.querySelectorAll('.nad-combined-action-curve');
        expect(curves.length).toBe(1);
        const d = curves[0].getAttribute('d')!;
        expect(d).toMatch(/^M 10 10 Q/); // starts at p1
        expect(d).toMatch(/100 100$/); // ends at p2
    });

    it('uses edge stroke-width for curve thickness', () => {
        const container = makeSvgContainer();
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const curve = container.querySelector('.nad-combined-action-curve')!;
        expect(curve.getAttribute('stroke-width')).toBe('5'); // matches edge path
    });

    it('renders a combined pin with "+" badge at the midpoint', () => {
        const container = makeSvgContainer();
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const combinedPin = container.querySelector('.nad-combined-action-pin');
        expect(combinedPin).not.toBeNull();
        expect(combinedPin!.getAttribute('data-action-id')).toBe('a1+a2');
        // Check for "+" text badge
        const texts = combinedPin!.querySelectorAll('text');
        const plusText = Array.from(texts).find(t => t.textContent === '+');
        expect(plusText).toBeDefined();
    });

    it('uses severity fill for curve stroke (not blue)', () => {
        const container = makeSvgContainer();
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const curve = container.querySelector('.nad-combined-action-curve')!;
        expect(curve.getAttribute('stroke')).toBe('#28a745'); // green severity
    });

    it('uses severity fill for the combined pin teardrop', () => {
        const container = makeSvgContainer();
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'red' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const teardrop = container.querySelector('.nad-combined-action-pin .nad-action-overview-pin-body path');
        expect(teardrop!.getAttribute('fill')).toBe('#dc3545'); // red severity
    });

    it('falls back to 3 SVG units for edge stroke when no edge path exists', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 200 200"><g class="nad-vl-nodes"><circle r="30"/></g></svg>';
        const combinedPins = [{
            pairId: 'a1+a2', action1Id: 'a1', action2Id: 'a2',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, unitaryPins, () => {}, undefined, { combinedPins });
        const curve = container.querySelector('.nad-combined-action-curve')!;
        expect(curve.getAttribute('stroke-width')).toBe('3'); // fallback
    });
});

describe('rescaleActionOverviewPins — does not rescale curves', () => {
    it('does not modify curve stroke-width during rescale', () => {
        const container = document.createElement('div');
        container.innerHTML =
            '<svg viewBox="0 0 1000 1000">' +
            '  <g class="nad-vl-nodes"><circle r="30"/></g>' +
            '  <g class="nad-edge-paths"><path style="stroke-width: 5"/></g>' +
            '</svg>';
        const combinedPins = [{
            pairId: 'a+b', action1Id: 'a', action2Id: 'b',
            p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 },
            x: 55, y: 55, label: '45%', title: '', severity: 'green' as const,
        }];
        applyActionOverviewPins(container, [
            { id: 'a', x: 10, y: 10, severity: 'green', label: '50%', title: '' },
            { id: 'b', x: 100, y: 100, severity: 'red', label: '110%', title: '' },
        ], () => {}, undefined, { combinedPins });

        const curve = container.querySelector('.nad-combined-action-curve')!;
        const initialStrokeW = curve.getAttribute('stroke-width');

        // Simulate zoom-out by changing viewBox
        const svg = container.querySelector('svg')!;
        svg.setAttribute('viewBox', '0 0 5000 5000');
        Object.defineProperty(container, 'clientWidth', { value: 500, configurable: true });
        rescaleActionOverviewPins(container);

        // Curve stroke-width must remain unchanged
        expect(curve.getAttribute('stroke-width')).toBe(initialStrokeW);
    });
});
