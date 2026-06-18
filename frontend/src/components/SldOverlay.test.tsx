// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SldOverlay from './SldOverlay';
import type { VlOverlay, SldTab, DiagramData, AnalysisResult } from '../types';

vi.mock('../utils/svgUtils', () => ({
    isCouplingAction: vi.fn(() => false),
}));

describe('SldOverlay', () => {
    const baseVlOverlay: VlOverlay = {
        vlName: 'VL_400',
        actionId: null,
        svg: '<svg><rect width="100" height="100"/></svg>',
        sldMetadata: null,
        loading: false,
        error: null,
        tab: 'n' as SldTab,
    };

    const defaultProps = {
        vlOverlay: baseVlOverlay,
        actionViewMode: 'network' as const,
        onOverlayClose: vi.fn(),
        onOverlaySldTabChange: vi.fn(),
        n1Diagram: null as DiagramData | null,
        actionDiagram: null as DiagramData | null,
        selectedContingency: [],
        result: null as AnalysisResult | null,
    };

    it('renders the voltage level name in the header', () => {
        render(<SldOverlay {...defaultProps} />);
        expect(screen.getByText('VL_400')).toBeInTheDocument();
    });

    it('renders the close button', () => {
        render(<SldOverlay {...defaultProps} />);
        expect(screen.getByTitle('Close')).toBeInTheDocument();
    });

    it('calls onOverlayClose when close button is clicked', () => {
        const onOverlayClose = vi.fn();
        render(<SldOverlay {...defaultProps} onOverlayClose={onOverlayClose} />);
        fireEvent.click(screen.getByTitle('Close'));
        expect(onOverlayClose).toHaveBeenCalled();
    });

    it('renders N tab button', () => {
        render(<SldOverlay {...defaultProps} />);
        expect(screen.getByText('N')).toBeInTheDocument();
    });

    it('calls onOverlaySldTabChange when a tab button is clicked', () => {
        const onOverlaySldTabChange = vi.fn();
        render(<SldOverlay {...defaultProps} onOverlaySldTabChange={onOverlaySldTabChange} />);
        fireEvent.click(screen.getByText('N'));
        expect(onOverlaySldTabChange).toHaveBeenCalledWith('n');
    });

    it('shows N-1 tab when n1Diagram exists', () => {
        const n1Diagram: DiagramData = { svg: '<svg/>', metadata: null };
        render(<SldOverlay {...defaultProps} n1Diagram={n1Diagram} />);
        expect(screen.getByText('N-1')).toBeInTheDocument();
    });

    it('does not show N-1 tab when n1Diagram is null', () => {
        render(<SldOverlay {...defaultProps} n1Diagram={null} />);
        expect(screen.queryByText('N-1')).not.toBeInTheDocument();
    });

    it('shows ACTION tab when actionDiagram exists', () => {
        const actionDiagram: DiagramData = { svg: '<svg/>', metadata: null };
        render(<SldOverlay {...defaultProps} actionDiagram={actionDiagram} />);
        expect(screen.getByText('ACTION')).toBeInTheDocument();
    });

    it('does not show ACTION tab when actionDiagram is null', () => {
        render(<SldOverlay {...defaultProps} actionDiagram={null} />);
        expect(screen.queryByText('ACTION')).not.toBeInTheDocument();
    });

    it('shows loading message when vlOverlay.loading is true', () => {
        const loadingOverlay = { ...baseVlOverlay, svg: null, loading: true };
        render(<SldOverlay {...defaultProps} vlOverlay={loadingOverlay} />);
        expect(screen.getByText(/Generating diagram/)).toBeInTheDocument();
    });

    it('shows error message when vlOverlay.error is set', () => {
        const errorOverlay = { ...baseVlOverlay, svg: null, error: 'Failed to load' };
        render(<SldOverlay {...defaultProps} vlOverlay={errorOverlay} />);
        expect(screen.getByText('Failed to load')).toBeInTheDocument();
    });

    it('renders SVG content when svg is available', () => {
        render(<SldOverlay {...defaultProps} />);
        // SVG is rendered via dangerouslySetInnerHTML; check that the container renders
        expect(screen.getByText('VL_400')).toBeInTheDocument();
    });

    it('shows mode indicator as "Flows" in network mode', () => {
        render(<SldOverlay {...defaultProps} actionViewMode="network" />);
        expect(screen.getByText('Flows')).toBeInTheDocument();
    });

    it('shows mode indicator as "Impacts" in delta mode', () => {
        render(<SldOverlay {...defaultProps} actionViewMode="delta" />);
        expect(screen.getByText('Impacts')).toBeInTheDocument();
    });

    describe('post-action overload highlight (Bug 2)', () => {
        // Minimal SVG + metadata so the cell-lookup machinery inside the
        // SldOverlay highlight effect can resolve an equipment id to a
        // DOM element and clone it with the `sld-highlight-overloaded`
        // class.
        // IDs must be unique — duplicate ids break both querySelector and
        // the elMap built inside SldOverlay's highlight effect. We only
        // need one id'd element per equipment; the highlight clone will
        // be inserted as a sibling and the original element gets tagged
        // with an `-original` class.
        const buildHighlightOverlay = (tab: SldTab): VlOverlay => ({
            vlName: 'VL_400',
            actionId: 'action_1',
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g><rect id="cell_resolved" width="10" height="10"/></g>'
                + '<g><rect id="cell_new" width="10" height="10"/></g>'
                + '<g><rect id="cell_n1" width="10" height="10"/></g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                nodes: [
                    { id: 'cell_resolved', equipmentId: 'LINE_RESOLVED' },
                    { id: 'cell_new', equipmentId: 'LINE_NEW' },
                    { id: 'cell_n1', equipmentId: 'LINE_N1' },
                ],
            }),
            loading: false,
            error: null,
            tab,
        });

        const baseActionDetail = {
            description_unitaire: 'test action',
            rho_before: null,
            rho_after: null,
            // Above the default monitoringFactor (0.95) so the "Solved —
            // low margin" gate added in 2026-04-20 does NOT suppress the
            // halo these tests assert on. A realistic "Still overloaded"
            // action that hasn't fully resolved the N-1 overload would
            // carry `lines_overloaded_after` alongside a red-card max_rho.
            max_rho: 1.05,
            max_rho_line: 'LINE_NEW',
            is_rho_reduction: true,
        };

        // When the SLD overlay is showing the ACTION tab, an overload that
        // existed in the N-1 state but was RESOLVED by the action must not
        // be highlighted — only the overloads that persist or newly appear
        // (lines_overloaded_after) should be highlighted.
        it('highlights post-action overloads on the ACTION tab, not stale N-1 overloads', () => {
            const vlOverlay = buildHighlightOverlay('action');
            const result = {
                actions: {
                    action_1: {
                        ...baseActionDetail,
                        lines_overloaded_after: ['LINE_NEW'],
                    },
                },
                lines_overloaded: ['LINE_RESOLVED'],
                pdf_path: null,
                pdf_url: null,
                message: '',
                dc_fallback: false,
            } as unknown as AnalysisResult;

            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );

            const highlights = container.querySelectorAll('.sld-highlight-overloaded');
            // Exactly one highlight clone, for the post-action overload,
            // NOT for the pre-action N-1 overload.
            expect(highlights.length).toBe(1);
            // The ORIGINAL element also gets tagged with an `-original`
            // class so it can be cleaned up on the next render pass.
            const tagged = container.querySelectorAll('.sld-highlight-overloaded-original');
            expect(tagged.length).toBe(1);
            // Confirm it is LINE_NEW that was highlighted, not LINE_RESOLVED.
            expect(container.querySelector('#cell_new.sld-highlight-overloaded-original')).toBeTruthy();
            expect(container.querySelector('#cell_resolved.sld-highlight-overloaded-original')).toBeNull();
        });

        // Regression guard: on the N-1 tab the overload list still comes
        // from result.lines_overloaded (N-1 state), independent of any
        // action's lines_overloaded_after.
        it('still highlights N-1 overloads on the N-1 tab', () => {
            const vlOverlay = buildHighlightOverlay('contingency');
            const result = {
                actions: {},
                lines_overloaded: ['LINE_N1'],
                pdf_path: null,
                pdf_url: null,
                message: '',
                dc_fallback: false,
            } as unknown as AnalysisResult;

            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );

            expect(container.querySelector('#cell_n1.sld-highlight-overloaded-original')).toBeTruthy();
        });

        // Regression: a persistent overload (the N-1 overloaded line is
        // STILL overloaded after the action — its equipment id is in
        // BOTH `result.lines_overloaded` and
        // `actionDetail.lines_overloaded_after`) must get a
        // `sld-highlight-overloaded` clone on the ACTION tab.
        it('highlights a persistent overload on the ACTION tab', () => {
            const vlOverlay = buildHighlightOverlay('action');
            const result = {
                actions: {
                    action_1: {
                        ...baseActionDetail,
                        // LINE_N1 was overloaded in N-1 and stays overloaded
                        // after the action.
                        lines_overloaded_after: ['LINE_N1'],
                    },
                },
                lines_overloaded: ['LINE_N1'],
                pdf_path: null,
                pdf_url: null,
                message: '',
                dc_fallback: false,
            } as unknown as AnalysisResult;

            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );

            expect(
                container.querySelector('#cell_n1.sld-highlight-overloaded-original'),
            ).toBeTruthy();
            expect(
                container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length,
            ).toBe(1);
        });

        // Regression: when the action creates MULTIPLE post-action
        // overloads — a mix of persistent and brand-new ones — ALL of
        // them must be highlighted on the ACTION tab.
        it('highlights a mix of persistent and newly-created overloads on the ACTION tab', () => {
            const vlOverlay = buildHighlightOverlay('action');
            const result = {
                actions: {
                    action_1: {
                        ...baseActionDetail,
                        // LINE_N1 was in N-1 and stays overloaded.
                        // LINE_NEW is a new overload the action created.
                        lines_overloaded_after: ['LINE_N1', 'LINE_NEW'],
                    },
                },
                // LINE_RESOLVED was in N-1 but is resolved by the action
                // — it must NOT get a highlight on the ACTION tab.
                lines_overloaded: ['LINE_N1', 'LINE_RESOLVED'],
                pdf_path: null,
                pdf_url: null,
                message: '',
                dc_fallback: false,
            } as unknown as AnalysisResult;

            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );

            expect(container.querySelector('#cell_n1.sld-highlight-overloaded-original')).toBeTruthy();
            expect(container.querySelector('#cell_new.sld-highlight-overloaded-original')).toBeTruthy();
            // The resolved overload must NOT be highlighted.
            expect(container.querySelector('#cell_resolved.sld-highlight-overloaded-original')).toBeNull();
            expect(
                container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length,
            ).toBe(2);
        });

        // When the action solves ALL overloads (lines_overloaded_after is
        // empty) no `sld-highlight-overloaded` clones are added at all.
        it('adds no overload clones when the action solves every overload', () => {
            const vlOverlay = buildHighlightOverlay('action');
            const result = {
                actions: {
                    action_1: {
                        ...baseActionDetail,
                        lines_overloaded_after: [],
                    },
                },
                lines_overloaded: ['LINE_RESOLVED'],
                pdf_path: null,
                pdf_url: null,
                message: '',
                dc_fallback: false,
            } as unknown as AnalysisResult;

            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );
            expect(container.querySelectorAll('.sld-highlight-overloaded').length).toBe(0);
        });
    });

    // When the user pans or zooms the SLD overlay, React reconciles the
    // <div dangerouslySetInnerHTML> wrapper, which in some cases wipes
    // out the highlight clones that were imperatively inserted as svg
    // siblings. The previous implementation only re-applied highlights
    // when a dep in its dep array changed, so a pan would leave the
    // user looking at a diagram with no highlights until they switched
    // tabs. The new implementation uses a self-gating layout effect
    // that runs after every render and re-plants the clones whenever
    // the DOM has lost them.
    describe('highlight persistence across pan/re-render (regression)', () => {
        const buildOverlay = (): VlOverlay => ({
            vlName: 'VL_400',
            actionId: null,
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g><rect id="cell_n1" width="10" height="10"/></g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                nodes: [{ id: 'cell_n1', equipmentId: 'LINE_N1' }],
            }),
            loading: false,
            error: null,
            tab: 'contingency' as SldTab,
        });

        const result = {
            actions: {},
            lines_overloaded: ['LINE_N1'],
            pdf_path: null,
            pdf_url: null,
            message: '',
            dc_fallback: false,
        } as unknown as AnalysisResult;

        it('replants highlight clones after they are wiped from the DOM', () => {
            const vlOverlay = buildOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );
            // Initial render plants exactly one overload clone for cell_n1.
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length).toBe(1);

            // Simulate what React's reconciliation does during a pan: it
            // reinjects the SVG into its wrapper, blowing away the
            // clones we planted.
            container.querySelectorAll('.sld-highlight-clone').forEach(el => el.remove());
            expect(container.querySelectorAll('.sld-highlight-clone').length).toBe(0);

            // A subsequent render (e.g. from the pan transform state
            // updating) must replant the clones, even though no
            // highlight-relevant prop changed.
            rerender(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length).toBe(1);
            expect(container.querySelector('#cell_n1.sld-highlight-overloaded-original')).toBeTruthy();
        });

        it('does not duplicate clones when a render fires but nothing changed', () => {
            const vlOverlay = buildOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />,
            );
            // Multiple rerenders with no DOM wipeout must NOT stack up
            // additional clones — the signature guard keeps the effect
            // idempotent.
            rerender(<SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />);
            rerender(<SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />);
            rerender(<SldOverlay {...defaultProps} vlOverlay={vlOverlay} result={result} selectedContingency={["L_FAULTY"]} />);
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length).toBe(1);
        });
    });

    // =====================================================================
    // LS / curtailment / PST highlight fallback (regression for the missing
    // load-shedding highlight on manually-simulated / re-simulated actions).
    //
    // The SLD highlight pass used to gate load/gen target collection behind
    // `if (topo) { if (!isCoupling) { ... } }`. That silently skipped
    // highlights whenever `action_topology` was empty — which happens for
    // manually-simulated load_shedding_/curtail_ actions whose grid2op
    // Action objects don't expose the `loads_p` / `gens_p` fields as
    // public attributes. The fix hoists the non-coupling block out of the
    // topo gate and ALWAYS consumes `load_shedding_details[].load_name`,
    // `curtailment_details[].gen_name`, and `pst_details[].pst_name` as
    // additional highlight sources. The signature cache was also extended
    // to include the LS/curtail/PST magnitudes so an in-place re-simulation
    // (same actionId, bumped MW / tap) invalidates stale clones.
    // =====================================================================
    describe('LS / curtailment / PST highlight fallback (regression)', () => {
        const makeOverlay = (): VlOverlay => ({
            vlName: 'VL_BEON',
            actionId: 'act_ls',
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g><rect id="cell_load" width="10" height="10"/></g>'
                + '<g><rect id="cell_gen" width="10" height="10"/></g>'
                + '<g><rect id="cell_pst" width="10" height="10"/></g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                nodes: [
                    { id: 'cell_load', equipmentId: 'LOAD_X' },
                    { id: 'cell_gen', equipmentId: 'GEN_Y' },
                    { id: 'cell_pst', equipmentId: 'PST_Z' },
                ],
            }),
            loading: false,
            error: null,
            tab: 'action' as SldTab,
        });

        const makeResult = (actionDetail: Record<string, unknown>) => ({
            actions: { act_ls: actionDetail },
            lines_overloaded: [],
            pdf_path: null,
            pdf_url: null,
            message: '',
            dc_fallback: false,
        } as unknown as AnalysisResult);

        it('highlights a shed load even when action_topology.loads_p is empty (manual-sim fallback)', () => {
            const detail = {
                description_unitaire: 'Shed LOAD_X',
                rho_before: [1.1],
                rho_after: [0.9],
                max_rho: 0.9,
                max_rho_line: 'X',
                is_rho_reduction: true,
                action_topology: {},  // <- the bug trigger
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_BEON', shedded_mw: 3.4 }],
            };
            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={makeOverlay()} result={makeResult(detail)} />,
            );
            // Load cell must now carry the action-target class even
            // though topology was empty — supplied via the details
            // fallback.
            expect(container.querySelector('#cell_load.sld-highlight-action-original')).toBeTruthy();
        });

        it('highlights a curtailed generator via curtailment_details fallback', () => {
            const detail = {
                description_unitaire: 'Curtail GEN_Y',
                rho_before: [1.1],
                rho_after: [0.85],
                max_rho: 0.85,
                max_rho_line: 'X',
                is_rho_reduction: true,
                action_topology: {},
                curtailment_details: [{ gen_name: 'GEN_Y', voltage_level_id: 'VL_BEON', curtailed_mw: 12 }],
            };
            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={makeOverlay()} result={makeResult(detail)} />,
            );
            expect(container.querySelector('#cell_gen.sld-highlight-action-original')).toBeTruthy();
        });

        it('highlights a PST via pst_details fallback', () => {
            const detail = {
                description_unitaire: 'Move PST_Z tap',
                rho_before: [1.1],
                rho_after: [0.95],
                max_rho: 0.95,
                max_rho_line: 'X',
                is_rho_reduction: true,
                action_topology: {},
                pst_details: [{ pst_name: 'PST_Z', tap_position: 5, low_tap: -16, high_tap: 16 }],
            };
            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={makeOverlay()} result={makeResult(detail)} />,
            );
            expect(container.querySelector('#cell_pst.sld-highlight-action-original')).toBeTruthy();
        });

        it('falls back to SVG <text> search when SLD metadata equipmentId does not match load_name', () => {
            // Regression for the case observed on `bare_env_small_grid_test`:
            // the backend's LS action carries `load_name: "P.SAO3TR311"`
            // but the SLD metadata's `equipmentId` is a different IIDM
            // form (e.g. `"P.SAO3_TR311_load"` or a UUID). The direct
            // lookup + substring fallbacks in `findCellForEquipment`
            // miss, so the highlight only appears if we ALSO scan the
            // rendered <text> labels for a prefix match and walk up to
            // the enclosing cell. Legacy standalone had this fallback
            // (`standalone_interface_legacy.html:5462-5472`) — without
            // porting it the frontend silently dropped the highlight.
            const svg = '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g class="sld-extern-cell" id="cell_for_load">'
                +   '<rect width="10" height="10"/>'
                +   '<text>P.SAO3TR311</text>'
                + '</g>'
                + '</svg>';
            const vlOverlay: VlOverlay = {
                vlName: 'P.SAOP3',
                actionId: 'load_shedding_P.SAO3TR311',
                svg,
                sldMetadata: JSON.stringify({
                    // Intentional mismatch: metadata uses a sanitised
                    // / fully-qualified form that won't pass the direct
                    // or substring lookups. The text-label fallback is
                    // the only path that can land the highlight.
                    nodes: [{ id: 'cell_for_load', equipmentId: 'IIDM_UUID_123' }],
                }),
                loading: false,
                error: null,
                tab: 'action' as SldTab,
            };
            const detail = {
                description_unitaire: 'Shed P.SAO3TR311',
                rho_before: [1.1],
                rho_after: [0.9],
                max_rho: 0.9,
                max_rho_line: 'X',
                is_rho_reduction: true,
                action_topology: {},
                load_shedding_details: [{ load_name: 'P.SAO3TR311', voltage_level_id: 'P.SAOP3', shedded_mw: 3.4 }],
            };
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={vlOverlay}
                    result={{
                        actions: { 'load_shedding_P.SAO3TR311': detail },
                        lines_overloaded: [],
                        pdf_path: null,
                        pdf_url: null,
                        message: '',
                        dc_fallback: false,
                    } as unknown as AnalysisResult}
                />,
            );
            // The highlight landed on the cell via the <text> fallback
            // even though SLD metadata's equipmentId was "IIDM_UUID_123"
            // and neither the direct nor substring lookup of "P.SAO3TR311"
            // matched.
            expect(container.querySelector('#cell_for_load.sld-highlight-action-original')).toBeTruthy();
        });

        it('suppresses the post-action overloaded halo when max_rho <= monitoringFactor (Solved / low-margin regression)', () => {
            // Regression for the low-margin halo bug reported 2026-04-20.
            // Backend `simulation_mixin.py:536` flags
            // `lines_overloaded_after` on raw rho >= monitoring_factor
            // (0.95), while `analysis_mixin.py:97` uses >= 1.0. For a
            // manually-simulated action with raw rho ~0.96 (displayed
            // max_rho ~0.912), the two paths disagree: manual ships a
            // non-empty list, analysis ships []. The SLD overload
            // highlight trusted the list and drew a pink halo even
            // though the ActionCard classified the action as "Solved —
            // low margin". The fix gates the halo on
            // `max_rho <= monitoringFactor`, matching the card.
            const svg =
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g class="sld-extern-cell" id="cell_load">'
                +   '<rect width="10" height="10"/>'
                + '</g>'
                + '<g class="sld-extern-cell" id="cell_branch">'
                +   '<rect width="10" height="10"/>'
                + '</g>'
                + '</svg>';
            const vlOverlay: VlOverlay = {
                vlName: 'VL_400',
                actionId: 'load_shedding_A',
                svg,
                sldMetadata: JSON.stringify({
                    nodes: [
                        { id: 'cell_load', equipmentId: 'LOAD_A' },
                        { id: 'cell_branch', equipmentId: 'LINE_OLD_OVERLOAD' },
                    ],
                }),
                loading: false,
                error: null,
                tab: 'action' as SldTab,
            };
            const detail = {
                description_unitaire: 'Shed LOAD_A',
                rho_before: [1.05],
                rho_after: [0.912],
                max_rho: 0.912,                  // <= 0.95 → orange "Solved — low margin"
                max_rho_line: 'LINE_OLD_OVERLOAD',
                is_rho_reduction: true,
                action_topology: { loads_p: { LOAD_A: 3.4 } },
                // Backend (manual path) still reports the line as
                // "overloaded_after" because raw rho ≈ 0.96 ≥ 0.95.
                lines_overloaded_after: ['LINE_OLD_OVERLOAD'],
            };
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={vlOverlay}
                    result={{
                        actions: { load_shedding_A: detail },
                        lines_overloaded: ['LINE_OLD_OVERLOAD'],
                        pdf_path: null,
                        pdf_url: null,
                        message: '',
                        dc_fallback: false,
                    } as unknown as AnalysisResult}
                    monitoringFactor={0.95}
                />,
            );
            // Load cell (action target) still gets the action-target
            // class: the user needs to know which equipment the action
            // touched.
            expect(container.querySelector('#cell_load.sld-highlight-action-original')).toBeTruthy();
            // But the old overloaded line does NOT carry the
            // overloaded halo — the card says "Solved", so the SLD
            // must agree.
            expect(container.querySelector('#cell_branch.sld-highlight-overloaded-original')).toBeFalsy();
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-overloaded').length).toBe(0);
        });

        it('DOES highlight the overloaded line when max_rho > monitoringFactor (Still-overloaded red card)', () => {
            // Complementary guard: when the action doesn't fully solve
            // the overload (red card), the halo must still show so the
            // operator sees which line is still at risk.
            const svg =
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g class="sld-extern-cell" id="cell_branch">'
                +   '<rect width="10" height="10"/>'
                + '</g>'
                + '</svg>';
            const vlOverlay: VlOverlay = {
                vlName: 'VL_400',
                actionId: 'load_shedding_B',
                svg,
                sldMetadata: JSON.stringify({
                    nodes: [{ id: 'cell_branch', equipmentId: 'LINE_STILL_HOT' }],
                }),
                loading: false,
                error: null,
                tab: 'action' as SldTab,
            };
            const detail = {
                description_unitaire: 'Shed LOAD_B',
                rho_before: [1.05],
                rho_after: [1.02],
                max_rho: 1.02,                  // > 0.95 → red "Still overloaded"
                max_rho_line: 'LINE_STILL_HOT',
                is_rho_reduction: true,
                action_topology: {},
                lines_overloaded_after: ['LINE_STILL_HOT'],
            };
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={vlOverlay}
                    result={{
                        actions: { load_shedding_B: detail },
                        lines_overloaded: ['LINE_STILL_HOT'],
                        pdf_path: null,
                        pdf_url: null,
                        message: '',
                        dc_fallback: false,
                    } as unknown as AnalysisResult}
                    monitoringFactor={0.95}
                />,
            );
            expect(container.querySelector('#cell_branch.sld-highlight-overloaded-original')).toBeTruthy();
        });

        it('re-applies highlights when an in-place re-simulation bumps shedded_mw (signature invalidation)', () => {
            // Signature cache must include the LS magnitude, otherwise
            // the highlight pass short-circuits after a re-simulation
            // and the operator keeps seeing the stale clone.
            const baseDetail = {
                description_unitaire: 'Shed LOAD_X',
                rho_before: [1.1],
                rho_after: [0.95],
                max_rho: 0.95,
                max_rho_line: 'X',
                is_rho_reduction: true,
                action_topology: {},
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_BEON', shedded_mw: 2.0 }],
            };
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={makeOverlay()} result={makeResult(baseDetail)} />,
            );
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-action').length).toBe(1);

            // Simulate pan reconciliation wiping the clones.
            container.querySelectorAll('.sld-highlight-clone').forEach(el => el.remove());
            expect(container.querySelectorAll('.sld-highlight-clone').length).toBe(0);

            // User re-simulated with a new MW value. The actionId is the
            // same but the detail carries an updated shedded_mw. The
            // signature must see the change and re-plant the clones.
            const bumpedDetail = {
                ...baseDetail,
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_BEON', shedded_mw: 4.5 }],
            };
            rerender(
                <SldOverlay {...defaultProps} vlOverlay={makeOverlay()} result={makeResult(bumpedDetail)} />,
            );
            expect(container.querySelectorAll('.sld-highlight-clone.sld-highlight-action').length).toBe(1);
        });
    });

    // Regression: the delta-flow painter used to run only when a dep
    // in its useEffect's dep list changed. But React reconciles the
    // `dangerouslySetInnerHTML` wrapper during pan/zoom updates
    // (overlayTransform state changes) — re-injecting the SVG and
    // wiping every `sld-delta-*` class and `data-original-text`
    // attribute the painter had planted. None of the deps changed,
    // so the effect didn't re-run — the overlay stayed stuck on the
    // Flows rendering until a tab switch forced a re-fetch. The
    // fix converts the painter into a self-gating every-render pass
    // with a signature + DOM-presence probe (mirrors the highlight
    // layoutEffect immediately below it).
    describe('Impacts delta persistence across pan/re-render (regression)', () => {
        const buildDeltaOverlay = (): VlOverlay => ({
            vlName: 'VL_400',
            actionId: 'act-1',
            // Minimal SLD fixture: one extern-cell containing a
            // feeder group + an active-power label. Enough for the
            // painter to find the cell, tag it with
            // `sld-delta-positive`, and rewrite the numeric label.
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g class="sld-extern-cell">'
                + '<g id="feeder-lineA"></g>'
                + '<g class="sld-active-power"><text class="sld-label">100</text></g>'
                + '</g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                feederInfos: [{ id: 'feeder-lineA', equipmentId: 'LINE_A' }],
            }),
            loading: false,
            error: null,
            tab: 'action' as SldTab,
            flow_deltas: {
                LINE_A: { delta: 5.5, category: 'positive', flip_arrow: false },
            },
        });

        it('paints delta classes + delta text on initial render (actionViewMode=delta)', () => {
            const overlay = buildDeltaOverlay();
            const { container } = render(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );
            expect(container.querySelector('.sld-extern-cell.sld-delta-positive')).toBeTruthy();
            const label = container.querySelector('.sld-active-power .sld-label');
            expect(label).toBeTruthy();
            expect(label!.textContent).toMatch(/Δ/); // delta symbol "Δ"
            expect(label!.getAttribute('data-original-text')).toBe('100');
            expect(label!.classList.contains('sld-delta-text-positive')).toBe(true);
        });

        it('re-paints delta state after a pan reconciliation wipes it from the DOM', () => {
            const overlay = buildDeltaOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );
            // Guard: initial paint landed.
            expect(container.querySelector('.sld-delta-positive')).toBeTruthy();

            // Simulate React's reconciliation of the
            // `dangerouslySetInnerHTML` wrapper during pan — every
            // delta class & data-original-text gets dropped.
            container.querySelectorAll('.sld-delta-positive, .sld-delta-text-positive').forEach(el => {
                el.classList.remove('sld-delta-positive', 'sld-delta-text-positive');
            });
            container.querySelectorAll('[data-original-text]').forEach(el => {
                el.removeAttribute('data-original-text');
            });
            // Also restore the label text so the sig-gate can detect
            // the wipe via the DOM-presence probe.
            const lbl = container.querySelector('.sld-active-power .sld-label')!;
            lbl.textContent = '100';

            expect(container.querySelector('.sld-delta-positive')).toBeNull();

            // A pan-triggered rerender (transform state in SldOverlay
            // changes, props stay identical). The self-gating effect
            // must detect the wipe and repaint.
            rerender(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );

            expect(container.querySelector('.sld-extern-cell.sld-delta-positive')).toBeTruthy();
            const labelAfter = container.querySelector('.sld-active-power .sld-label')!;
            expect(labelAfter.textContent).toMatch(/Δ/);
            expect(labelAfter.getAttribute('data-original-text')).toBe('100');
            expect(labelAfter.classList.contains('sld-delta-text-positive')).toBe(true);
        });

        it('clears delta state when toggling back to Flows (actionViewMode=network)', () => {
            const overlay = buildDeltaOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );
            expect(container.querySelector('.sld-delta-positive')).toBeTruthy();

            rerender(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="network" />,
            );
            // Flows mode — no delta paint should remain on the cell.
            expect(container.querySelector('.sld-delta-positive')).toBeNull();
            // Original numeric label restored.
            const label = container.querySelector('.sld-active-power .sld-label')!;
            expect(label.textContent).toBe('100');
            expect(label.getAttribute('data-original-text')).toBeNull();
        });

        it('is idempotent across consecutive rerenders with identical props (no sig thrash)', () => {
            const overlay = buildDeltaOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );
            const originalAttr = container.querySelector('.sld-active-power .sld-label')!.getAttribute('data-original-text');
            // Consecutive re-renders must not stack up "Δ Δ Δ" prefixes
            // on the label — the painter's reset step runs before
            // every repaint, so the text stays "Δ +5.5" whatever the
            // render count is.
            rerender(<SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />);
            rerender(<SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />);
            rerender(<SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />);
            const label = container.querySelector('.sld-active-power .sld-label')!;
            // Exactly one Δ prefix — no accumulation.
            const deltaCount = (label.textContent ?? '').split('Δ').length - 1;
            expect(deltaCount).toBe(1);
            // data-original-text preserved (not re-captured from the
            // already-Δ-prefixed label, which would corrupt it).
            expect(label.getAttribute('data-original-text')).toBe(originalAttr);
            expect(label.getAttribute('data-original-text')).toBe('100');
        });

        // Regression: dragging the substation glyph in the SLD with the
        // mouse fires a stream of `setOverlayTransform` updates, each
        // re-rendering the component. The user reported a visible
        // impact↔flow blink during the drag that stabilised on impact
        // only when the mouse was released. Root cause: the delta
        // painter was a `useEffect`, which runs AFTER the browser
        // paints — so each rapid re-render produced a single-frame
        // flash of the un-painted (Flows) state between commit and
        // effect-flush. Promoting it to `useLayoutEffect` runs the
        // painter synchronously between commit and paint, so the
        // browser only ever sees the post-paint impact state. This
        // test locks in the architectural choice by source-level
        // inspection (jsdom can't reproduce the real paint cycle, but
        // a future refactor flipping it back to `useEffect` would
        // also re-introduce the blink).
        it('delta painter uses useLayoutEffect, not useEffect (no blink between commit and paint)', () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const path = require('path');
            const src = fs.readFileSync(
                path.resolve(__dirname, 'SldOverlay.tsx'),
                'utf-8',
            ) as string;
            const sigDeclIdx = src.indexOf('const appliedDeltaSigRef');
            expect(sigDeclIdx).toBeGreaterThan(-1);
            // The `useLayoutEffect(...)` invocation MUST sit on the
            // line immediately after the sig-ref declaration — that's
            // the delta painter. If anyone flips it back to
            // `useEffect`, the rapid pan re-renders will once again
            // expose the un-painted Flows state for a single frame
            // between React's commit and the post-paint effect flush.
            const after = src.slice(sigDeclIdx, sigDeclIdx + 400);
            expect(after).toMatch(/useLayoutEffect\s*\(/);
            expect(after).not.toMatch(/^\s*useEffect\s*\(/m);
        });
    });

    // =====================================================================
    // Switch-click targeting (interactive SLD topology edit).
    //
    // pypowsybl draws breaker / disconnector glyphs as small squares, so
    // the operator reported having to click several times "around" a
    // switch before it toggled. The click handler now (a) keeps the
    // pixel-perfect hit fast-path, (b) snaps to the closest editable
    // switch within a screen-px radius on a near-miss, and (c) ignores
    // the trailing click of a pan-drag. The body cursor is the standard
    // arrow (not a hand) while editing.
    // =====================================================================
    describe('switch-click targeting (edit mode)', () => {
        const buildEditOverlay = (): VlOverlay => ({
            vlName: 'VL_400',
            actionId: null,
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g id="sw_1"><rect width="6" height="6"/></g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                nodes: [{ id: 'sw_1', equipmentId: 'SWITCH_A' }],
            }),
            loading: false,
            error: null,
            tab: 'contingency' as SldTab,
            switch_states: { SWITCH_A: false },
        });

        it('toggles a switch on a pixel-perfect click (exact hit)', () => {
            const onSwitchClick = vi.fn();
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={buildEditOverlay()}
                    editMode
                    onEditModeChange={vi.fn()}
                    onSwitchClick={onSwitchClick}
                />,
            );
            fireEvent.click(container.querySelector('#sw_1')!);
            expect(onSwitchClick).toHaveBeenCalledWith('SWITCH_A');
        });

        it('snaps to the nearest switch on a near-miss click', () => {
            const onSwitchClick = vi.fn();
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={buildEditOverlay()}
                    editMode
                    onEditModeChange={vi.fn()}
                    onSwitchClick={onSwitchClick}
                />,
            );
            // jsdom returns an all-zero rect by default; give the switch
            // a real box so the distance maths has something to chew on.
            const sw = container.querySelector('#sw_1')! as Element;
            sw.getBoundingClientRect = () =>
                ({ left: 100, top: 100, right: 106, bottom: 106, width: 6, height: 6, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;

            // Click 5px to the right of the glyph — a miss, but well
            // within the snap radius.
            const body = screen.getByTestId('sld-overlay-body');
            fireEvent.click(body, { clientX: 111, clientY: 103 });
            expect(onSwitchClick).toHaveBeenCalledWith('SWITCH_A');
        });

        it('does not toggle when the near-miss click is outside the snap radius', () => {
            const onSwitchClick = vi.fn();
            const { container } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={buildEditOverlay()}
                    editMode
                    onEditModeChange={vi.fn()}
                    onSwitchClick={onSwitchClick}
                />,
            );
            const sw = container.querySelector('#sw_1')! as Element;
            sw.getBoundingClientRect = () =>
                ({ left: 100, top: 100, right: 106, bottom: 106, width: 6, height: 6, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;

            // 200px away — far outside the 26px snap radius.
            const body = screen.getByTestId('sld-overlay-body');
            fireEvent.click(body, { clientX: 300, clientY: 300 });
            expect(onSwitchClick).not.toHaveBeenCalled();
        });

        it('uses the arrow cursor (not a hand) while editing, grab otherwise', () => {
            const { rerender } = render(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={buildEditOverlay()}
                    editMode={false}
                    onEditModeChange={vi.fn()}
                    onSwitchClick={vi.fn()}
                />,
            );
            expect(screen.getByTestId('sld-overlay-body')).toHaveStyle({ cursor: 'grab' });

            rerender(
                <SldOverlay
                    {...defaultProps}
                    vlOverlay={buildEditOverlay()}
                    editMode
                    onEditModeChange={vi.fn()}
                    onSwitchClick={vi.fn()}
                />,
            );
            expect(screen.getByTestId('sld-overlay-body')).toHaveStyle({ cursor: 'default' });
        });
    });

    describe('Impacts delta persistence across pan/re-render (regression) — continued', () => {
        const buildDeltaOverlay = (): VlOverlay => ({
            vlName: 'VL_400',
            actionId: 'act-1',
            svg:
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<g class="sld-extern-cell">'
                + '<g id="feeder-lineA"></g>'
                + '<g class="sld-active-power"><text class="sld-label">100</text></g>'
                + '</g>'
                + '</svg>',
            sldMetadata: JSON.stringify({
                feederInfos: [{ id: 'feeder-lineA', equipmentId: 'LINE_A' }],
            }),
            loading: false,
            error: null,
            tab: 'action' as SldTab,
            flow_deltas: {
                LINE_A: { delta: 5.5, category: 'positive', flip_arrow: false },
            },
        });

        it('delta classes survive a sequence of pan-driven rerenders without ever vanishing', () => {
            // Behavioural complement to the source-inspection test
            // above. Even if a future refactor changed the effect
            // implementation, the delta DOM state must NEVER be
            // momentarily absent between successive renders. Mirrors
            // what happens when the operator drags the SLD: a stream
            // of `setOverlayTransform` updates → many cheap re-renders.
            const overlay = buildDeltaOverlay();
            const { container, rerender } = render(
                <SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />,
            );
            const queryDelta = () => container.querySelector('.sld-delta-positive');
            expect(queryDelta()).toBeTruthy();
            // Re-render 8× in quick succession (any pan gesture fires
            // dozens of these per second).
            for (let i = 0; i < 8; i += 1) {
                rerender(<SldOverlay {...defaultProps} vlOverlay={overlay} actionViewMode="delta" />);
                // Probe immediately after each commit — the delta
                // class MUST still be there, never transiently null.
                expect(queryDelta()).toBeTruthy();
            }
        });
    });
});
