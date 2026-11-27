// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import { patchDiagramFields, cloneBaseSvg, applyPatchToClone } from './svgPatch';
import type { DiagramPatch, MetadataIndex, EdgeMeta } from '../types';

//
// Synthetic SVG fixture — mirrors the structure pypowsybl emits for a
// small NAD with two lines (A, B) and one set of edge-info labels per
// terminal. Just enough structure to exercise the patch module:
//   - element IDs on edges and edge-info wrappers
//   - <text> children inside the edge-info so we can assert the label
//     swap happened.
//
const buildBaseSvg = (): SVGSVGElement => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <g id="nad-l-LINE_A"><path d="M0 0 L10 10" stroke="#000"/></g>
            <g id="nad-l-LINE_B"><path d="M0 10 L10 20" stroke="#000"/></g>
            <g id="nad-ei-LINE_A-1"><text>111</text></g>
            <g id="nad-ei-LINE_A-2"><text>-111</text></g>
            <g id="nad-ei-LINE_B-1"><text>222</text></g>
            <g id="nad-ei-LINE_B-2"><text>-222</text></g>
        </svg>`,
        'image/svg+xml',
    );
    return doc.documentElement as unknown as SVGSVGElement;
};

const buildMetaIndex = (): MetadataIndex => {
    const edgeA: EdgeMeta = {
        equipmentId: 'LINE_A',
        svgId: 'nad-l-LINE_A',
        node1: 'VL_1',
        node2: 'VL_2',
        edgeInfo1: { svgId: 'nad-ei-LINE_A-1' },
        edgeInfo2: { svgId: 'nad-ei-LINE_A-2' },
    };
    const edgeB: EdgeMeta = {
        equipmentId: 'LINE_B',
        svgId: 'nad-l-LINE_B',
        node1: 'VL_2',
        node2: 'VL_3',
        edgeInfo1: { svgId: 'nad-ei-LINE_B-1' },
        edgeInfo2: { svgId: 'nad-ei-LINE_B-2' },
    };
    return {
        nodesByEquipmentId: new Map(),
        nodesBySvgId: new Map(),
        edgesByEquipmentId: new Map([
            ['LINE_A', edgeA],
            ['LINE_B', edgeB],
        ]),
        edgesByNode: new Map(),
    };
};

const emptyAbsoluteFlows = (overrides: Record<string, number> = {}) => ({
    p1: { ...overrides },
    p2: {},
    q1: {},
    q2: {},
    vl1: {},
    vl2: {},
});

describe('cloneBaseSvg', () => {
    it('returns an independent copy — mutating the clone does not touch the source', () => {
        const base = buildBaseSvg();
        const baseAEl = base.querySelector('#nad-l-LINE_A')!;
        expect(baseAEl.classList.contains('nad-disconnected')).toBe(false);

        const clone = cloneBaseSvg(base);
        clone.querySelector('#nad-l-LINE_A')!.classList.add('nad-disconnected');

        expect(baseAEl.classList.contains('nad-disconnected')).toBe(false);
    });

    it('drops the Loading / Impacts decoration of the N tab so the patch starts from MW labels', () => {
        const base = buildBaseSvg();
        base.querySelector('#nad-l-LINE_A')!.classList.add('nad-loading-over');
        const label = base.querySelector('#nad-ei-LINE_A-1 text')!;
        label.setAttribute('data-original-text', '111');
        label.textContent = '97%';

        const clone = cloneBaseSvg(base);

        expect(clone.querySelector('#nad-l-LINE_A')!.classList.contains('nad-loading-over')).toBe(false);
        expect(clone.querySelector('#nad-ei-LINE_A-1 text')!.textContent).toBe('111');
        expect(clone.querySelector('[data-original-text]')).toBeNull();
        expect(label.textContent).toBe('97%');
    });
});

describe('patchDiagramFields', () => {
    it("carries every data field of the patch onto the patched diagram, the Loading view's included", () => {
        const patch: DiagramPatch = {
            patchable: true,
            lf_converged: true,
            lf_status: 'CONVERGED',
            lines_overloaded: ['L1'],
            lines_overloaded_rho: [1.09],
            lines_overloaded_rho_before: [0.7],
            flow_deltas: { L1: { delta: 270, category: 'positive' } },
            reactive_flow_deltas: {},
            asset_deltas: {},
            branch_loading: { L1: [null, 109.1] },
            loading_deltas: { L1: { delta: 40.2, category: 'positive' } },
        };
        expect(patchDiagramFields(patch)).toEqual({
            lines_overloaded: ['L1'],
            lines_overloaded_rho: [1.09],
            lines_overloaded_rho_before: [0.7],
            flow_deltas: { L1: { delta: 270, category: 'positive' } },
            reactive_flow_deltas: {},
            asset_deltas: {},
            branch_loading: { L1: [null, 109.1] },
            loading_deltas: { L1: { delta: 40.2, category: 'positive' } },
            lf_converged: true,
            lf_status: 'CONVERGED',
        });
    });
});

describe('applyPatchToClone', () => {
    it('marks disconnected edges with .nad-disconnected', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const patch: DiagramPatch = {
            patchable: true,
            contingency_id: 'LINE_A',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: ['LINE_A'],
            absolute_flows: emptyAbsoluteFlows(),
        };

        const clone = cloneBaseSvg(base);
        const { svgElement } = applyPatchToClone(clone, meta, patch);

        expect(svgElement.querySelector('#nad-l-LINE_A')!.classList.contains('nad-disconnected')).toBe(true);
        expect(svgElement.querySelector('#nad-l-LINE_B')!.classList.contains('nad-disconnected')).toBe(false);
    });

    it('overwrites absolute flow labels on both terminals and backs up originals', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const patch: DiagramPatch = {
            patchable: true,
            contingency_id: 'LINE_A',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: {
                p1: { LINE_B: 350 },
                p2: { LINE_B: -348 },
                q1: {},
                q2: {},
                vl1: {},
                vl2: {},
            },
        };

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, patch);

        const t1 = clone.querySelector('#nad-ei-LINE_B-1 text')!;
        const t2 = clone.querySelector('#nad-ei-LINE_B-2 text')!;
        expect(t1.textContent).toBe('350');
        expect(t2.textContent).toBe('-348');
        expect(t1.getAttribute('data-patched-flow')).toBe('222');
        expect(t2.getAttribute('data-patched-flow')).toBe('-222');

        // LINE_A text should be untouched by the patch.
        expect(clone.querySelector('#nad-ei-LINE_A-1 text')!.textContent).toBe('111');
    });

    it('is idempotent: re-applying a different patch restores then re-writes', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const first: DiagramPatch = {
            patchable: true,
            contingency_id: 'LINE_A',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: ['LINE_A'],
            absolute_flows: {
                p1: { LINE_B: 350 },
                p2: {}, q1: {}, q2: {}, vl1: {}, vl2: {},
            },
        };
        const second: DiagramPatch = {
            patchable: true,
            contingency_id: 'LINE_B',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: ['LINE_B'],
            absolute_flows: {
                p1: { LINE_A: 50 },
                p2: {}, q1: {}, q2: {}, vl1: {}, vl2: {},
            },
        };

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, first);
        applyPatchToClone(clone, meta, second);

        // Only LINE_B is marked disconnected after the second patch.
        expect(clone.querySelector('#nad-l-LINE_A')!.classList.contains('nad-disconnected')).toBe(false);
        expect(clone.querySelector('#nad-l-LINE_B')!.classList.contains('nad-disconnected')).toBe(true);

        // LINE_B edge-info label restored to its original before the
        // second patch; LINE_A edge-info label now overwritten.
        expect(clone.querySelector('#nad-ei-LINE_B-1 text')!.textContent).toBe('222');
        expect(clone.querySelector('#nad-ei-LINE_A-1 text')!.textContent).toBe('50');
    });

    it('is a no-op when patchable is false (caller is expected to fall back)', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const patch: DiagramPatch = {
            patchable: false,
            reason: 'switch_state_changed',
            action_id: 'ACT_X',
            lf_converged: true,
            lf_status: 'CONVERGED',
        };

        const clone = cloneBaseSvg(base);
        const before = clone.outerHTML;
        applyPatchToClone(clone, meta, patch);
        expect(clone.outerHTML).toBe(before);
    });

    it('splices a VL node subtree and rewrites the sub-diagram id to the main svgId', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        // Main diagram has this VL under svgId `nad-vl-VL_1`.
        const vlNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        vlNode.setAttribute('id', 'nad-vl-VL_1');
        vlNode.innerHTML = '<circle r="5" data-version="base"/>';
        base.appendChild(vlNode);
        meta.nodesByEquipmentId.set('VL_1', {
            equipmentId: 'VL_1',
            svgId: 'nad-vl-VL_1',
            x: 0,
            y: 0,
        });

        // Backend emits the fragment with the SUB-diagram's svgId
        // (`nad-vl-0`). The splice must rewrite it to the main
        // svgId so later idMap lookups (halo clone, delta visuals)
        // keep working.
        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'node_merging_VL_1',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                VL_1: {
                    node_svg: '<g id="nad-vl-0"><circle r="10" data-version="patched"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                },
            },
        };

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, patch);

        // Patched element is now under the MAIN svgId, not the sub svgId.
        const patched = clone.querySelector('#nad-vl-VL_1 circle');
        expect(patched).not.toBeNull();
        expect(patched!.getAttribute('data-version')).toBe('patched');
        expect(patched!.getAttribute('r')).toBe('10');

        // The sub-diagram svgId MUST NOT leak into the final DOM.
        expect(clone.querySelector('#nad-vl-0')).toBeNull();

        // Base stays pristine — clone happens before splice.
        const baseCircle = base.querySelector('#nad-vl-VL_1 circle')!;
        expect(baseCircle.getAttribute('data-version')).toBe('base');
    });

    it('splices edge fragments with their sub-diagram ids rewritten to main edge svgIds', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        // Base has LINE_A at nad-l-LINE_A (from buildMetaIndex fixture).
        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'coupling_VL_1',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                VL_1: {
                    node_svg: '<g id="nad-vl-0"><circle r="7"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                    edge_fragments: {
                        LINE_A: {
                            svg: '<g id="nad-l-sub-0"><path d="M0 0 L100 100" data-source="patched"/></g>',
                            sub_svg_id: 'nad-l-sub-0',
                        },
                    },
                },
            },
        };
        // Register the VL so the splice finds it.
        meta.nodesByEquipmentId.set('VL_1', {
            equipmentId: 'VL_1',
            svgId: 'nad-vl-0-base',
            x: 0,
            y: 0,
        });
        // And add a node with that main svgId to the base so the splice
        // has something to replace.
        const vlNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        vlNode.setAttribute('id', 'nad-vl-0-base');
        base.appendChild(vlNode);

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, patch);

        // LINE_A's edge is now under the MAIN edge svgId (nad-l-LINE_A),
        // not the sub-diagram id.
        const patchedEdge = clone.querySelector('#nad-l-LINE_A path');
        expect(patchedEdge).not.toBeNull();
        expect(patchedEdge!.getAttribute('data-source')).toBe('patched');
        expect(clone.querySelector('#nad-l-sub-0')).toBeNull();
    });

    it('is a no-op for vl_subtrees entries whose target svgId is missing from the clone', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'ghost_vl_action',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                GHOST_VL: {
                    node_svg: '<g id="nad-vl-0"><circle r="1"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                },
            },
        };

        const clone = cloneBaseSvg(base);
        expect(() => applyPatchToClone(clone, meta, patch)).not.toThrow();
    });

    it('splices multiple VLs in a single patch call', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        // Two VLs with distinct main svgIds.
        for (const [vl, svgId, ver] of [
            ['VL_A', 'nad-vl-10', 'A'],
            ['VL_B', 'nad-vl-11', 'B'],
        ] as const) {
            const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            el.setAttribute('id', svgId);
            el.innerHTML = `<circle r="1" data-version="base-${ver}"/>`;
            base.appendChild(el);
            meta.nodesByEquipmentId.set(vl, { equipmentId: vl, svgId, x: 0, y: 0 });
        }

        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'multi_vl_coupling',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                VL_A: {
                    node_svg: '<g id="nad-vl-0"><circle r="3" data-version="patched-A"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                },
                VL_B: {
                    node_svg: '<g id="nad-vl-0"><circle r="4" data-version="patched-B"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                },
            },
        };

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, patch);

        // Each VL lands under its OWN main svgId despite the two
        // fragments sharing `nad-vl-0` in their sub-diagrams.
        expect(clone.querySelector('#nad-vl-10 circle')!.getAttribute('data-version')).toBe('patched-A');
        expect(clone.querySelector('#nad-vl-11 circle')!.getAttribute('data-version')).toBe('patched-B');
    });

    it('skips edge_fragments whose equipmentId is missing from the base metadata', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const vlNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        vlNode.setAttribute('id', 'nad-vl-42');
        base.appendChild(vlNode);
        meta.nodesByEquipmentId.set('VL_X', { equipmentId: 'VL_X', svgId: 'nad-vl-42', x: 0, y: 0 });

        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'coupling_VL_X',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                VL_X: {
                    node_svg: '<g id="nad-vl-0"/>',
                    node_sub_svg_id: 'nad-vl-0',
                    edge_fragments: {
                        GHOST_EDGE: { svg: '<g id="nad-l-99"/>', sub_svg_id: 'nad-l-99' },
                    },
                },
            },
        };
        const clone = cloneBaseSvg(base);
        // Must not throw and must not insert the ghost edge under
        // any id — the base had no matching edge.
        expect(() => applyPatchToClone(clone, meta, patch)).not.toThrow();
        expect(clone.querySelector('#nad-l-99')).toBeNull();
    });

    it('idempotency: re-applying the same vl_subtrees patch twice leaves the DOM identical', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const vlNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        vlNode.setAttribute('id', 'nad-vl-77');
        vlNode.innerHTML = '<circle r="1"/>';
        base.appendChild(vlNode);
        meta.nodesByEquipmentId.set('VL_IDEM', { equipmentId: 'VL_IDEM', svgId: 'nad-vl-77', x: 0, y: 0 });

        const patch: DiagramPatch = {
            patchable: true,
            action_id: 'act',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: [],
            absolute_flows: emptyAbsoluteFlows(),
            vl_subtrees: {
                VL_IDEM: {
                    node_svg: '<g id="nad-vl-0"><circle r="5" data-v="x"/></g>',
                    node_sub_svg_id: 'nad-vl-0',
                },
            },
        };

        const clone = cloneBaseSvg(base);
        applyPatchToClone(clone, meta, patch);
        const html1 = clone.querySelector('#nad-vl-77')!.outerHTML;
        applyPatchToClone(clone, meta, patch);
        const html2 = clone.querySelector('#nad-vl-77')!.outerHTML;
        expect(html2).toBe(html1);
    });

    it('ignores unknown equipment ids in disconnected_edges without throwing', () => {
        const base = buildBaseSvg();
        const meta = buildMetaIndex();
        const patch: DiagramPatch = {
            patchable: true,
            contingency_id: 'GHOST_LINE',
            lf_converged: true,
            lf_status: 'CONVERGED',
            disconnected_edges: ['GHOST_LINE'],
            absolute_flows: emptyAbsoluteFlows(),
        };

        const clone = cloneBaseSvg(base);
        expect(() => applyPatchToClone(clone, meta, patch)).not.toThrow();
    });
});
