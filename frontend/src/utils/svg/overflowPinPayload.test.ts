// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import type {
    ActionDetail,
    ActionOverviewFilters,
    MetadataIndex,
    NodeMeta,
    EdgeMeta,
} from '../../types';
import {
    buildOverflowPinPayload,
    buildOverflowUnsimulatedPinPayload,
} from './overflowPinPayload';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../actionTypes';

const makeMetaIndex = (
    nodes: Record<string, Partial<NodeMeta> & { equipmentId: string }>,
    edges: Record<string, Partial<EdgeMeta> & { equipmentId: string; node1: string; node2: string }> = {},
): MetadataIndex => {
    const nodesByEquipmentId = new Map<string, NodeMeta>();
    const nodesBySvgId = new Map<string, NodeMeta>();
    for (const [eqId, n] of Object.entries(nodes)) {
        const node: NodeMeta = {
            equipmentId: eqId,
            svgId: n.svgId ?? `svg-${eqId}`,
            x: n.x ?? 0,
            y: n.y ?? 0,
            ...n,
        } as NodeMeta;
        nodesByEquipmentId.set(eqId, node);
        nodesBySvgId.set(node.svgId, node);
    }
    const edgesByEquipmentId = new Map<string, EdgeMeta>();
    for (const [eqId, e] of Object.entries(edges)) {
        const edge: EdgeMeta = {
            equipmentId: eqId,
            svgId: e.svgId ?? `svg-edge-${eqId}`,
            node1: e.node1,
            node2: e.node2,
            ...e,
        } as EdgeMeta;
        edgesByEquipmentId.set(eqId, edge);
    }
    return {
        nodesByEquipmentId,
        nodesBySvgId,
        edgesByEquipmentId,
        // Unused by the payload builder; cast to satisfy the type.
    } as unknown as MetadataIndex;
};

describe('buildOverflowPinPayload', () => {
    it('returns [] when actions or metaIndex are missing', () => {
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        expect(buildOverflowPinPayload(null, meta, {}, 0.95, new Set(), new Set())).toEqual([]);
        expect(buildOverflowPinPayload({}, null, {}, 0.95, new Set(), new Set())).toEqual([]);
    });

    it('anchors a load-shedding action on the substation of its target VL', () => {
        const actions: Record<string, ActionDetail> = {
            ls1: {
                description_unitaire: 'Délestage',
                max_rho: 0.92,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 50 }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        const result = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95, new Set(), new Set(),
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            actionId: 'ls1',
            substation: 'SUB_A',
            severity: 'orange',  // 0.92 > (0.95 - 0.05)
        });
        expect(result[0].label).toBe('92%');
    });

    it('marks selected and rejected pins via the id sets', () => {
        const actions: Record<string, ActionDetail> = {
            a1: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
            a2: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95,
            new Set(['a1']), new Set(['a2']),
        );
        const byId = Object.fromEntries(out.map(p => [p.actionId, p]));
        expect(byId.a1.isSelected).toBe(true);
        expect(byId.a1.isRejected).toBe(false);
        expect(byId.a2.isSelected).toBe(false);
        expect(byId.a2.isRejected).toBe(true);
    });

    it('falls back to a line endpoint when no description match exists', () => {
        const actions: Record<string, ActionDetail> = {
            disco_LINE_AB: {
                description_unitaire: 'Action targets line LINE_AB',
                max_rho: 0.4,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
            { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
        );
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A', V2: 'SUB_B' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        // Either substation is acceptable depending on iteration order.
        expect(['SUB_A', 'SUB_B']).toContain(out[0].substation);
    });

    it('still emits a pin when the substation is not in the overflowSubstations set, carrying the VL ids as fallback anchors', () => {
        // The pin builder used to drop pins whose substation was not
        // listed in the overflow graph, but graphs keyed by voltage
        // level (the recommender's default for small grids) made that
        // heuristic incorrect. The overlay JS now does the real
        // gating: it iterates substation + nodeCandidates and skips
        // any pin whose anchor never resolves to a graph node.
        const actions: Record<string, ActionDetail> = {
            a1: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            new Set(['SUB_B']),  // SUB_A not in overflow graph
        );
        expect(out).toHaveLength(1);
        expect(out[0].substation).toBe('SUB_A');
        // VL id should be carried as a fallback so the overlay JS can
        // anchor on the VL when the graph turns out to be VL-keyed.
        expect(out[0].nodeCandidates).toContain('V1');
    });

    it('populates nodeCandidates with the action target VLs', () => {
        // Graphs keyed by voltage level need to receive VL ids as
        // fallback anchors so the overlay can locate the right node.
        const actions: Record<string, ActionDetail> = {
            ls1: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [{ voltage_level_id: 'V_TARGET', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V_TARGET: { equipmentId: 'V_TARGET' } });
        const out = buildOverflowPinPayload(
            actions, meta, { V_TARGET: 'SUB_A' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        expect(out[0].substation).toBe('SUB_A');
        expect(out[0].nodeCandidates).toContain('V_TARGET');
    });

    it('emits "DIV" / "ISL" labels and grey severity for non-numeric outcomes', () => {
        const actions: Record<string, ActionDetail> = {
            div: {
                description_unitaire: '',
                non_convergence: true,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
            isl: {
                description_unitaire: '',
                is_islanded: true,
                load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
        );
        const byId = Object.fromEntries(out.map(p => [p.actionId, p]));
        expect(byId.div.label).toBe('DIV');
        expect(byId.div.severity).toBe('grey');
        expect(byId.isl.label).toBe('ISL');
        expect(byId.isl.severity).toBe('grey');
    });
});

// ---------------------------------------------------------------------
// Anchor priority — mirrors ``resolveActionAnchor`` in actionPinData.
// Each test below pins down one rung of the priority ladder.
// ---------------------------------------------------------------------

describe('buildOverflowPinPayload — anchor priority', () => {
    it('load-shedding action does NOT carry max_rho_line in lineNames (early return)', () => {
        // Without the early-return, every load-shedding action would
        // inherit max_rho_line as an edge anchor and the pin would
        // land on a random line midpoint instead of its target VL.
        const actions: Record<string, ActionDetail> = {
            ls1: {
                description_unitaire: '',
                max_rho: 0.5,
                max_rho_line: 'LINE_AB',
                load_shedding_details: [{
                    voltage_level_id: 'V_LOAD', load_id: 'L', mw_shed: 1,
                }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { V_LOAD: { equipmentId: 'V_LOAD' }, V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
            { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
        );
        const out = buildOverflowPinPayload(
            actions, meta, { V_LOAD: 'SUB_LOAD' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        expect(out[0].lineNames).toEqual([]);
        expect(out[0].substation).toBe('SUB_LOAD');
    });

    it('curtailment action does NOT carry max_rho_line in lineNames (early return)', () => {
        const actions: Record<string, ActionDetail> = {
            rc1: {
                description_unitaire: '',
                max_rho: 0.5,
                max_rho_line: 'LINE_AB',
                curtailment_details: [{
                    voltage_level_id: 'V_GEN', generator_id: 'G', curtailed_mw: 50,
                }],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { V_GEN: { equipmentId: 'V_GEN' }, V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
            { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
        );
        const out = buildOverflowPinPayload(
            actions, meta, { V_GEN: 'SUB_GEN' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        expect(out[0].lineNames).toEqual([]);
        expect(out[0].substation).toBe('SUB_GEN');
    });

    it('VL-target action (coupler / node-merging) prefers VL anchor over max_rho_line fallback', () => {
        // Coupler-style actions have an explicit VL target via
        // description / id parsing AND ``max_rho_line`` set on the
        // ``ActionDetail``. Without the priority split, lineNames
        // would carry max_rho_line and the pin would jump to a
        // random line midpoint. The contract: when VL targets exist,
        // lineNames stays empty.
        const actions: Record<string, ActionDetail> = {
            VLA_coupling: {
                description_unitaire: 'COUPL fermeture du poste VLA',
                max_rho: 0.5,
                max_rho_line: 'LINE_AB',
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { VLA: { equipmentId: 'VLA' }, V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
            { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
        );
        const out = buildOverflowPinPayload(
            actions, meta, { VLA: 'SUB_A' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        expect(out[0].lineNames).toEqual([]);
        // VLA shows up either as the substation, in nodeCandidates,
        // or both — depends on whether the substation is in the
        // overflow set.
        const allNodeAnchors = [out[0].substation, ...(out[0].nodeCandidates ?? [])];
        expect(allNodeAnchors.includes('VLA') || allNodeAnchors.includes('SUB_A')).toBe(true);
    });

    it('branch action with explicit line target emits primary lineNames', () => {
        // Disco / reco actions that name a line via the description
        // should pin at the edge midpoint — primary lineNames flag.
        const actions: Record<string, ActionDetail> = {
            disco_LINE_AB: {
                description_unitaire: 'Open line LINE_AB',
                max_rho: 0.4,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
            { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
        );
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A', V2: 'SUB_B' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(1);
        expect(out[0].lineNames).toContain('LINE_AB');
    });

    it('combined-action key (id1+id2) emits an isCombined descriptor with both halves', () => {
        // A simulated combined pair has its own ``actions`` entry
        // whose key carries ``+``. The overflow overlay places the
        // combined pin at the midpoint of a curve drawn between the
        // two unitary pins, so the descriptor must carry the ids of
        // both halves and skip the per-edge anchor logic.
        const actions: Record<string, ActionDetail> = {
            ls_a: {
                description_unitaire: 'load shedding A',
                max_rho: 0.4,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            ls_b: {
                description_unitaire: 'load shedding B',
                max_rho: 0.5,
                load_shedding_details: [
                    { load_name: 'L2', voltage_level_id: 'VLB', shedded_mw: 12 },
                ],
            } as unknown as ActionDetail,
            'ls_a+ls_b': {
                description_unitaire: 'combined LS',
                max_rho: 0.7,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { VLA: { equipmentId: 'VLA' }, VLB: { equipmentId: 'VLB' } },
            {},
        );
        const out = buildOverflowPinPayload(
            actions, meta, { VLA: 'SUB_A', VLB: 'SUB_B' }, 0.95,
            new Set(), new Set(),
        );
        const combined = out.filter(p => p.isCombined);
        expect(combined).toHaveLength(1);
        expect(combined[0].action1Id).toBe('ls_a');
        expect(combined[0].action2Id).toBe('ls_b');
        expect(combined[0].actionId).toBe('ls_a+ls_b');
        // Unitary halves must also be in the payload — the overlay
        // draws the connector between THEIR positions.
        expect(out.some(p => p.actionId === 'ls_a' && !p.isCombined)).toBe(true);
        expect(out.some(p => p.actionId === 'ls_b' && !p.isCombined)).toBe(true);
    });

    it('combined-action descriptor is dropped when one half does not resolve', () => {
        const actions: Record<string, ActionDetail> = {
            // Only ls_a resolves — ls_b has no anchor (no metadata for VLB).
            ls_a: {
                description_unitaire: 'load shedding A',
                max_rho: 0.4,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            'ls_a+ls_b': {
                description_unitaire: 'combined LS',
                max_rho: 0.7,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ VLA: { equipmentId: 'VLA' } }, {});
        const out = buildOverflowPinPayload(
            actions, meta, { VLA: 'SUB_A' }, 0.95,
            new Set(), new Set(),
        );
        expect(out.some(p => p.isCombined)).toBe(false);
    });

    it('keeps a passing combined pin even when one constituent fails the threshold (dimmed, not dropped)', () => {
        // Mirrors the user-reported bug: ``ls_b`` is above
        // ``Max loading`` so the unitary chip would normally hide
        // it, but the combined pair ``ls_a+ls_b`` is below the
        // threshold. The Action Overview pipeline (the
        // ``protectedIds`` set in
        // ActionOverviewDiagram.tsx:332) emits the combined pin
        // AND keeps the failing constituent visible with
        // ``dimmedByFilter: true``.
        const actions: Record<string, ActionDetail> = {
            ls_a: {
                description_unitaire: 'load shedding A',
                max_rho: 0.40,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            ls_b: {
                description_unitaire: 'load shedding B',
                max_rho: 1.20,
                load_shedding_details: [
                    { load_name: 'L2', voltage_level_id: 'VLB', shedded_mw: 12 },
                ],
            } as unknown as ActionDetail,
            'ls_a+ls_b': {
                description_unitaire: 'combined LS',
                max_rho: 0.70,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { VLA: { equipmentId: 'VLA' }, VLB: { equipmentId: 'VLB' } },
            {},
        );
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 1.0,
        };
        const out = buildOverflowPinPayload(
            actions, meta, { VLA: 'SUB_A', VLB: 'SUB_B' }, 0.95,
            new Set(), new Set(), undefined, filters,
        );
        const byId = new Map(out.map(p => [p.actionId, p]));
        expect(byId.get('ls_a+ls_b')?.isCombined).toBe(true);
        const aPin = byId.get('ls_a');
        expect(aPin).toBeDefined();
        expect(aPin?.dimmedByFilter).toBeFalsy();
        const bPin = byId.get('ls_b');
        expect(bPin).toBeDefined();
        expect(bPin?.dimmedByFilter).toBe(true);
    });

    it('drops both combined pin AND failing constituents when the combined itself fails the filter', () => {
        const actions: Record<string, ActionDetail> = {
            ls_a: {
                description_unitaire: 'load shedding A',
                max_rho: 0.40,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            ls_b: {
                description_unitaire: 'load shedding B',
                max_rho: 1.20,
                load_shedding_details: [
                    { load_name: 'L2', voltage_level_id: 'VLB', shedded_mw: 12 },
                ],
            } as unknown as ActionDetail,
            'ls_a+ls_b': {
                description_unitaire: 'combined LS',
                max_rho: 1.30,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex(
            { VLA: { equipmentId: 'VLA' }, VLB: { equipmentId: 'VLB' } },
            {},
        );
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 1.0,
        };
        const out = buildOverflowPinPayload(
            actions, meta, { VLA: 'SUB_A', VLB: 'SUB_B' }, 0.95,
            new Set(), new Set(), undefined, filters,
        );
        const ids = out.map(p => p.actionId);
        expect(ids).toContain('ls_a');
        expect(ids).not.toContain('ls_b');
        expect(ids).not.toContain('ls_a+ls_b');
    });
});

// ---------------------------------------------------------------------
// Action-overview filter integration. ``buildOverflowPinPayload`` must
// drop pins identically to ``ActionOverviewDiagram`` so the three
// surfaces (Action Feed / overview NAD / overflow graph) stay in
// lock-step.
// ---------------------------------------------------------------------

describe('buildOverflowPinPayload — overviewFilters', () => {
    const baseFilters = (
        overrides: Partial<ActionOverviewFilters> = {},
    ): ActionOverviewFilters => ({
        ...DEFAULT_ACTION_OVERVIEW_FILTERS,
        ...overrides,
        categories: { ...DEFAULT_ACTION_OVERVIEW_FILTERS.categories,
            ...(overrides.categories ?? {}) },
    });

    const makeActions = () => ({
        // green ≈ low rho. ID includes ``load_shedding`` so the
        // type classifier resolves to the 'ls' bucket.
        load_shedding_green: {
            description_unitaire: '', max_rho: 0.5,
            load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
        } as unknown as ActionDetail,
        // orange ≈ slightly above monitoring factor
        load_shedding_orange: {
            description_unitaire: '', max_rho: 0.92,
            load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
        } as unknown as ActionDetail,
        // red ≈ above 1.0
        load_shedding_red: {
            description_unitaire: '', max_rho: 1.4,
            load_shedding_details: [{ voltage_level_id: 'V1', load_id: 'L', mw_shed: 1 }],
        } as unknown as ActionDetail,
    });

    const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });

    it('keeps every pin when every category is enabled and threshold is high', () => {
        const out = buildOverflowPinPayload(
            makeActions(), meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            undefined, baseFilters({ threshold: 3.0 }),
        );
        expect(new Set(out.map(p => p.actionId))).toEqual(
            new Set(['load_shedding_green', 'load_shedding_orange', 'load_shedding_red']),
        );
    });

    it('drops red pins when the red category is disabled', () => {
        const out = buildOverflowPinPayload(
            makeActions(), meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            undefined,
            baseFilters({
                categories: {
                    green: true, orange: true, red: false, grey: true,
                },
                threshold: 3.0,
            }),
        );
        expect(out.map(p => p.actionId).includes('load_shedding_red')).toBe(false);
    });

    it('drops pins above the max-loading threshold', () => {
        const out = buildOverflowPinPayload(
            makeActions(), meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            undefined,
            baseFilters({ threshold: 1.0 }),
        );
        // red1 has max_rho=1.4 > 1.0 → dropped.
        expect(out.map(p => p.actionId).includes('load_shedding_red')).toBe(false);
        expect(out.map(p => p.actionId).includes('load_shedding_green')).toBe(true);
    });

    it('action-type chip drops actions of other types (LS-only filter)', () => {
        // Mix a load_shedding action with a disco action; ask for
        // LS-only and verify the disco pin is dropped.
        const actions: Record<string, ActionDetail> = {
            ...makeActions(),
            disco_LINE: {
                description_unitaire: 'open line ouverture LINE_AB',
                max_rho: 0.5,
            } as unknown as ActionDetail,
        };
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            undefined,
            baseFilters({ actionType: 'ls', threshold: 3.0 }),
        );
        const ids = new Set(out.map(p => p.actionId));
        expect(ids.has('load_shedding_green')).toBe(true);
        expect(ids.has('disco_LINE')).toBe(false);
    });

    it('combined category + threshold + action-type filters apply together', () => {
        const out = buildOverflowPinPayload(
            makeActions(), meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
            undefined,
            baseFilters({
                categories: {
                    green: false, orange: true, red: false, grey: true,
                },
                threshold: 1.0,
                actionType: 'ls',
            }),
        );
        // green1 dropped (category off), red1 dropped (above
        // threshold); only orange1 survives.
        expect(out.map(p => p.actionId)).toEqual(['load_shedding_orange']);
    });

    it('omitting overviewFilters preserves the legacy "every resolvable pin" behaviour', () => {
        // Tests / standalone callers that don't pass filters must
        // continue to receive every pin the metadata can resolve.
        const out = buildOverflowPinPayload(
            makeActions(), meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(),
        );
        expect(out).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------
// Combined-only filter — the new "Combined only" pin chip on both the
// Action Overview NAD and the Overflow Analysis iframe must drop every
// unitary / un-simulated pin that is NOT a constituent of a passing
// combined pin, and dim the surviving constituents so they read as
// context for the pair glyph.
// ---------------------------------------------------------------------

describe('buildOverflowPinPayload — showCombinedOnly', () => {
    const makeCombinedFixture = () => {
        const actions: Record<string, ActionDetail> = {
            ls_a: {
                description_unitaire: 'load shedding A',
                max_rho: 0.40,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            ls_b: {
                description_unitaire: 'load shedding B',
                max_rho: 0.50,
                load_shedding_details: [
                    { load_name: 'L2', voltage_level_id: 'VLB', shedded_mw: 12 },
                ],
            } as unknown as ActionDetail,
            ls_solo: {
                description_unitaire: 'load shedding solo',
                max_rho: 0.60,
                load_shedding_details: [
                    { load_name: 'L3', voltage_level_id: 'VLC', shedded_mw: 15 },
                ],
            } as unknown as ActionDetail,
            'ls_a+ls_b': {
                description_unitaire: 'combined LS',
                max_rho: 0.70,
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({
            VLA: { equipmentId: 'VLA' },
            VLB: { equipmentId: 'VLB' },
            VLC: { equipmentId: 'VLC' },
        });
        const subs = { VLA: 'SUB_A', VLB: 'SUB_B', VLC: 'SUB_C' };
        return { actions, meta, subs };
    };

    it('drops every unitary pin that is NOT a combined-pair constituent', () => {
        const { actions, meta, subs } = makeCombinedFixture();
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 3.0,
            showCombinedOnly: true,
        };
        const out = buildOverflowPinPayload(
            actions, meta, subs, 0.95, new Set(), new Set(), undefined, filters,
        );
        const ids = new Set(out.map(p => p.actionId));
        // Solo pin disappears; constituents stay (dimmed); pair stays.
        expect(ids.has('ls_solo')).toBe(false);
        expect(ids.has('ls_a')).toBe(true);
        expect(ids.has('ls_b')).toBe(true);
        expect(ids.has('ls_a+ls_b')).toBe(true);
    });

    it('marks the surviving constituents with dimmedByFilter so the iframe renders them as context', () => {
        const { actions, meta, subs } = makeCombinedFixture();
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 3.0,
            showCombinedOnly: true,
        };
        const out = buildOverflowPinPayload(
            actions, meta, subs, 0.95, new Set(), new Set(), undefined, filters,
        );
        const byId = new Map(out.map(p => [p.actionId, p]));
        expect(byId.get('ls_a')?.dimmedByFilter).toBe(true);
        expect(byId.get('ls_b')?.dimmedByFilter).toBe(true);
        // Combined pin itself is NOT dimmed — it's the focus of the mode.
        expect(byId.get('ls_a+ls_b')?.dimmedByFilter).toBeFalsy();
        expect(byId.get('ls_a+ls_b')?.isCombined).toBe(true);
    });

    it('returns no unitary pins at all when no combined pair exists', () => {
        // showCombinedOnly with zero pairs ⇒ empty unitary output.
        // The payload may still carry the un-paired actions only if
        // a passing combined pair references them; otherwise drop.
        const actions: Record<string, ActionDetail> = {
            solo1: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [
                    { load_name: 'L1', voltage_level_id: 'V1', shedded_mw: 10 },
                ],
            } as unknown as ActionDetail,
            solo2: {
                description_unitaire: '',
                max_rho: 0.5,
                load_shedding_details: [
                    { load_name: 'L2', voltage_level_id: 'V1', shedded_mw: 11 },
                ],
            } as unknown as ActionDetail,
        };
        const meta = makeMetaIndex({ V1: { equipmentId: 'V1' } });
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 3.0,
            showCombinedOnly: true,
        };
        const out = buildOverflowPinPayload(
            actions, meta, { V1: 'SUB_A' }, 0.95,
            new Set(), new Set(), undefined, filters,
        );
        expect(out).toEqual([]);
    });

    it('drops the combined pin too when its own severity / threshold filter fails', () => {
        // showCombinedOnly only touches the unitary pins — combined
        // pins still go through their own filter, so a pair that
        // fails its severity / threshold check disappears entirely
        // (and so do its constituents, since nothing protects them).
        const { actions, meta, subs } = makeCombinedFixture();
        // Bump the pair max_rho above the threshold.
        actions['ls_a+ls_b'] = {
            ...actions['ls_a+ls_b'],
            max_rho: 1.30,
        } as ActionDetail;
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 1.0,
            showCombinedOnly: true,
        };
        const out = buildOverflowPinPayload(
            actions, meta, subs, 0.95, new Set(), new Set(), undefined, filters,
        );
        expect(out).toEqual([]);
    });

    it('does not touch the payload when showCombinedOnly is false (default behaviour preserved)', () => {
        const { actions, meta, subs } = makeCombinedFixture();
        const filters: ActionOverviewFilters = {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            threshold: 3.0,
            showCombinedOnly: false,
        };
        const out = buildOverflowPinPayload(
            actions, meta, subs, 0.95, new Set(), new Set(), undefined, filters,
        );
        const ids = new Set(out.map(p => p.actionId));
        // Solo pin survives at full strength alongside the pair.
        expect(ids.has('ls_solo')).toBe(true);
        expect(out.find(p => p.actionId === 'ls_solo')?.dimmedByFilter).toBeFalsy();
        expect(out.find(p => p.actionId === 'ls_a')?.dimmedByFilter).toBeFalsy();
    });
});

// ---------------------------------------------------------------------
// buildOverflowUnsimulatedPinPayload — Show-unsimulated path. Mirrors
// the Action-Overview ``buildUnsimulatedActionPins`` contract.
// ---------------------------------------------------------------------

describe('buildOverflowPinPayload — progressive reveal of the feed', () => {
    // Two load-shedding actions and their simulated pair.
    const actions: Record<string, ActionDetail> = {
        ls_a: {
            description_unitaire: 'load shedding A',
            max_rho: 0.4,
            load_shedding_details: [{ load_name: 'L1', voltage_level_id: 'VLA', shedded_mw: 10 }],
        } as unknown as ActionDetail,
        ls_b: {
            description_unitaire: 'load shedding B',
            max_rho: 0.5,
            load_shedding_details: [{ load_name: 'L2', voltage_level_id: 'VLB', shedded_mw: 12 }],
        } as unknown as ActionDetail,
        'ls_a+ls_b': { description_unitaire: 'combined LS', max_rho: 0.3 } as unknown as ActionDetail,
    };
    const meta = makeMetaIndex({ VLA: { equipmentId: 'VLA' }, VLB: { equipmentId: 'VLB' } });
    const build = (displayed?: string[], hidden: string[] = []) => buildOverflowPinPayload(
        actions, meta, { VLA: 'SUB_A', VLB: 'SUB_B' }, 0.95,
        new Set(), new Set(), undefined, undefined,
        displayed ? { displayedIds: new Set(displayed), hiddenIds: new Set(hidden) } : undefined,
    );

    it('marks listed and hidden suggestions, unitary and combined', () => {
        const out = build(['ls_b'], ['ls_a', 'ls_a+ls_b']);
        const byId = new Map(out.map(p => [p.actionId, p]));
        expect(byId.get('ls_b')?.feed).toBe('shown');
        expect(byId.get('ls_a')?.feed).toBe('hidden');
        expect(byId.get('ls_a+ls_b')?.feed).toBe('hidden');
    });

    it('omits `feed` on pins that are neither listed nor hidden', () => {
        const out = build(['ls_b']);
        expect(out.find(p => p.actionId === 'ls_a')).not.toHaveProperty('feed');
    });

    it('leaves the wire format unchanged when no reveal state is passed', () => {
        expect(build().some(p => 'feed' in p)).toBe(false);
    });
});

describe('buildOverflowUnsimulatedPinPayload', () => {
    const meta = makeMetaIndex(
        { V1: { equipmentId: 'V1' }, V2: { equipmentId: 'V2' } },
        { LINE_AB: { equipmentId: 'LINE_AB', node1: 'svg-V1', node2: 'svg-V2' } },
    );

    it('emits a dimmed grey pin with "?" label and the unsimulated flag', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1'],
            new Set(),
            meta,
            { V1: 'SUB_A' },
        );
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            actionId: 'load_shedding_V1',
            severity: 'grey',
            label: '?',
            unsimulated: true,
            isSelected: false,
            isRejected: false,
        });
    });

    it('skips ids already present in simulatedIds (no double pinning)', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1', 'disco_LINE_AB'],
            new Set(['load_shedding_V1']),
            meta,
            { V1: 'SUB_A', V2: 'SUB_B' },
        );
        expect(out.map(p => p.actionId)).toEqual(['disco_LINE_AB']);
    });

    it('returns [] when no metadata index is available', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1'], new Set(), null, { V1: 'SUB_A' },
        );
        expect(out).toEqual([]);
    });

    it('returns [] when no scored ids are passed', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            [], new Set(), meta, { V1: 'SUB_A' },
        );
        expect(out).toEqual([]);
    });

    it('dedupes repeated ids in the input list', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1', 'load_shedding_V1', 'load_shedding_V1'],
            new Set(),
            meta,
            { V1: 'SUB_A' },
        );
        expect(out).toHaveLength(1);
    });

    it('still resolves anchors via the same priority order as simulated pins', () => {
        // disco line action → expects line in lineNames (edge-midpoint
        // anchor), same as in buildOverflowPinPayload.
        const out = buildOverflowUnsimulatedPinPayload(
            ['disco_LINE_AB'],
            new Set(),
            meta,
            { V1: 'SUB_A', V2: 'SUB_B' },
        );
        expect(out).toHaveLength(1);
        expect(out[0].lineNames).toContain('LINE_AB');
    });

    it('emits a multi-line title carrying score / rank / MW-start when scoreInfo is supplied', () => {
        // Mirrors the Action Overview's hover tooltip exactly so an
        // operator hovering an unsimulated pin in the overflow
        // graph sees the same triage info (id + score + rank +
        // MW-start) as on the Action Overview NAD.
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1'],
            new Set(),
            meta,
            { V1: 'SUB_A' },
            {
                load_shedding_V1: {
                    type: 'load_shedding',
                    score: 0.42,
                    mwStart: 91.6,
                    tapStart: null,
                    rankInType: 3,
                    countInType: 8,
                    maxScoreInType: 1.5,
                },
            },
        );
        expect(out).toHaveLength(1);
        const title = out[0].title ?? '';
        expect(title).toContain('load_shedding_V1');
        expect(title).toContain('not yet simulated');
        expect(title).toContain('Type: load_shedding');
        expect(title).toContain('Score: 0.42');
        expect(title).toContain('rank 3 of 8');
        expect(title).toContain('MW start: 91.6');
    });

    it('falls back to a single-line generic title when scoreInfo is absent', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1'],
            new Set(),
            meta,
            { V1: 'SUB_A' },
        );
        expect(out[0].title).toBe(
            'load_shedding_V1 — not yet simulated (double-click to run)',
        );
    });

    it('action-type chip drops unsimulated ids of other types (LS-only filter)', () => {
        // Regression for the Overflow Analysis pin filter bug: the
        // ACTION PINS FILTERS chip row (DISCO / RECO / LS / OPEN /
        // CLOSE / PST) must filter unsimulated pins the same way the
        // Action Overview's `unsimulatedPins` memo does — otherwise
        // the operator sees pins for action types they explicitly
        // hid. Fixed by passing `overviewFilters` through to the
        // builder.
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1', 'disco_LINE_AB'],
            new Set(),
            meta,
            { V1: 'SUB_A', V2: 'SUB_B' },
            undefined,
            undefined,
            {
                categories: { green: true, orange: true, red: true, grey: true },
                threshold: 200,
                actionType: 'ls',
                showUnsimulated: true,
            },
        );
        expect(out.map(p => p.actionId)).toEqual(['load_shedding_V1']);
    });

    it('action-type chip prefers scoreInfo.type over id-based heuristics', () => {
        // When the score-info supplies a type, that wins over the
        // id-based `classifyActionType` fallback — same precedence
        // ActionOverviewDiagram applies. Use a load_shedding score-
        // type on an id whose tokens ("ambiguous_id_V1") would not
        // otherwise classify as `ls`.
        const out = buildOverflowUnsimulatedPinPayload(
            ['ambiguous_id_V1'],
            new Set(),
            meta,
            { V1: 'SUB_A' },
            {
                ambiguous_id_V1: {
                    type: 'load_shedding',
                    score: 0.5,
                    mwStart: 10,
                    tapStart: null,
                    rankInType: 1,
                    countInType: 1,
                    maxScoreInType: 0.5,
                },
            },
            undefined,
            {
                categories: { green: true, orange: true, red: true, grey: true },
                threshold: 200,
                actionType: 'ls',
                showUnsimulated: true,
            },
        );
        expect(out).toHaveLength(1);
        expect(out[0].actionId).toBe('ambiguous_id_V1');
    });

    it('action-type chip set to "all" keeps every unsimulated pin (no filter)', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1', 'disco_LINE_AB'],
            new Set(),
            meta,
            { V1: 'SUB_A', V2: 'SUB_B' },
            undefined,
            undefined,
            {
                categories: { green: true, orange: true, red: true, grey: true },
                threshold: 200,
                actionType: 'all',
                showUnsimulated: true,
            },
        );
        expect(out.map(p => p.actionId).sort()).toEqual(
            ['disco_LINE_AB', 'load_shedding_V1'],
        );
    });

    it('returns [] when showCombinedOnly is on (un-simulated actions can never be in a pair)', () => {
        const out = buildOverflowUnsimulatedPinPayload(
            ['load_shedding_V1', 'disco_LINE_AB'],
            new Set(),
            meta,
            { V1: 'SUB_A', V2: 'SUB_B' },
            undefined,
            undefined,
            {
                ...DEFAULT_ACTION_OVERVIEW_FILTERS,
                showUnsimulated: true,
                showCombinedOnly: true,
            },
        );
        expect(out).toEqual([]);
    });
});
