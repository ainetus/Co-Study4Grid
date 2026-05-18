// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { interactionLogger } from '../utils/interactionLogger';

// Mocking dependencies
vi.mock('../api', () => ({
    api: {
        getAvailableActions: vi.fn(async () => []),
        simulateManualAction: vi.fn(),
        simulateAndVariantDiagramStream: vi.fn(),
        getNetworkDiagram: vi.fn(),
        computeSuperposition: vi.fn(),
    }
}));

vi.mock('../utils/svgUtils', () => ({
    getActionTargetVoltageLevels: vi.fn(() => []),
    getActionTargetLines: vi.fn(() => []),
    processSvg: vi.fn((svg: string) => ({ svg, viewBox: { x: 0, y: 0, w: 100, h: 100 } })),
    buildMetadataIndex: vi.fn(),
    applyOverloadedHighlights: vi.fn(),
    applyDeltaVisuals: vi.fn(),
    applyActionTargetHighlights: vi.fn(),
    applyContingencyHighlight: vi.fn(),
    isCouplingAction: vi.fn(() => false),
    // Always passing the severity/threshold gate isolates the
    // action-type filter tests from the category/threshold filter.
    actionPassesOverviewFilter: vi.fn(() => true),
}));

import ActionFeed from './ActionFeed';
import { api } from '../api';
import { getActionTargetVoltageLevels, getActionTargetLines } from '../utils/svgUtils';
import type { ActionDetail, AnalysisResult, CombinedAction } from '../types';

describe('ActionFeed', () => {
    const emptyTopo = { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} };

    const defaultProps = {
        actions: {} as Record<string, ActionDetail>,
        actionScores: {} as Record<string, Record<string, unknown>>,
        linesOverloaded: ['LINE_1'] as string[],
        selectedActionId: null,
        selectedActionIds: new Set<string>(),
        rejectedActionIds: new Set<string>(),
        onActionSelect: vi.fn(),
        onActionFavorite: vi.fn(),
        onActionReject: vi.fn(),
        onAssetClick: vi.fn(),
        onDisplayPrioritizedActions: vi.fn(),
        onRunAnalysis: vi.fn(),
        canRunAnalysis: false,
        nodesByEquipmentId: new Map(),
        edgesByEquipmentId: new Map(),
        disconnectedElement: 'LINE_1',
        onManualActionAdded: vi.fn(),
        onActionResimulated: vi.fn(),
        analysisLoading: false,
        monitoringFactor: 0.95,
        manuallyAddedIds: new Set<string>(),
        pendingAnalysisResult: null as AnalysisResult | null,
        combinedActions: null as Record<string, CombinedAction> | null,
    };


    it('shows "Make a first guess" button when the Selected Actions section is empty', () => {
        // Regression guard: the standalone interface exposes a
        // "💡 Make a first guess" shortcut that opens the Manual
        // Selection search. The React frontend was missing it, so
        // users had no obvious entry point from the empty Selected
        // Actions slot into manual action exploration.
        render(<ActionFeed {...defaultProps} />);
        expect(screen.getByTestId('make-first-guess-button')).toBeInTheDocument();
        expect(screen.getByText(/Make a first guess/)).toBeInTheDocument();
    });

    it('"Make a first guess" opens the manual search dropdown', () => {
        render(<ActionFeed {...defaultProps} />);
        // The dropdown search input is not present until the user
        // opens the search.
        expect(screen.queryByPlaceholderText(/Search action by ID/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByTestId('make-first-guess-button'));
        expect(screen.getByPlaceholderText(/Search action by ID/)).toBeInTheDocument();
    });

    describe('"Make a first guess" gating after Analyze & Suggest', () => {
        // Product rule: once the user has triggered Analyze & Suggest
        // (or it's currently running, or its result is pending
        // display), the pre-analysis "Make a first guess" shortcut is
        // suppressed. It should reappear only after a state reset
        // (contingency change, study reload) clears actionScores /
        // pendingAnalysisResult / actions.

        it('hides the button while analysis is in progress', () => {
            render(<ActionFeed {...defaultProps} analysisLoading={true} />);
            expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();
        });

        it('hides the button while a pending analysis result is awaiting display', () => {
            const pending = {
                actions: {},
                lines_overloaded: [],
                action_scores: {},
            } as unknown as AnalysisResult;
            render(<ActionFeed {...defaultProps} pendingAnalysisResult={pending} />);
            expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();
        });

        it('hides the button when action scores are present (analysis completed)', () => {
            const actionScores = {
                line_disconnection: { scores: { 'disco_A': 1.0 }, params: {} },
            };
            render(<ActionFeed {...defaultProps} actionScores={actionScores} />);
            expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();
        });

        it('hides the button when the actions dict is non-empty (at least one simulated action)', () => {
            const actions = {
                manually_added: {
                    description_unitaire: 'Manual',
                    action_topology: emptyTopo,
                    is_manual: true,
                } as unknown as ActionDetail,
            };
            render(<ActionFeed {...defaultProps} actions={actions} />);
            expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();
        });

        it('still shows the button when actionScores is an empty object (analysis never ran)', () => {
            // The defaultProps already use `actionScores: {}` which is
            // the initial "analysis has not produced anything yet"
            // state — a truthy but empty object. The button must still
            // appear.
            render(<ActionFeed {...defaultProps} actionScores={{}} />);
            expect(screen.getByTestId('make-first-guess-button')).toBeInTheDocument();
        });

        it('re-appears after a simulated reset (all analysis-related state cleared)', () => {
            const { rerender } = render(
                <ActionFeed
                    {...defaultProps}
                    actionScores={{ line_disconnection: { scores: { 'disco_A': 1.0 }, params: {} } }}
                />,
            );
            expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();

            // Simulate state reset: parent clears result/actionScores
            // (emulating resetAllState on contingency/study change).
            rerender(
                <ActionFeed
                    {...defaultProps}
                    actionScores={{}}
                    pendingAnalysisResult={null}
                    analysisLoading={false}
                    actions={{}}
                />,
            );
            expect(screen.getByTestId('make-first-guess-button')).toBeInTheDocument();
        });
    });

    it('keeps a manually added action in Selected and shows the overlap warning when it is ALSO suggested by the analysis', () => {
        // Regression: a user "first guess" that coincides with a
        // recommender suggestion used to silently vanish from the
        // Selected bucket after analysis. It must stay selected and
        // the yellow "also recommended" warning must fire.
        const actionId = 'overlap_act';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Shared action',
                    rho_before: [1.1],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_manual: true,
                    action_topology: emptyTopo,
                },
            },
            // The same id is present in both the selected set (user
            // added it manually) and the analysis scores (the
            // recommender also recommends it).
            selectedActionIds: new Set([actionId]),
            manuallyAddedIds: new Set([actionId]),
            actionScores: {
                line_disconnection: {
                    scores: { [actionId]: 42 },
                    params: {},
                },
            },
        };
        render(<ActionFeed {...props} />);
        // Selected Actions section still shows the card. (The
        // description is now progressive-disclosure, so we assert on
        // the card root by testId rather than its description text.)
        expect(screen.getByTestId(`action-card-${actionId}`)).toBeInTheDocument();
        // Overlap is now an inline contextual hint (tier-warning-system PR — see
        // `docs/proposals/ui-design-critique.md` recommendation #4).
        const hint = screen.getByTestId('selected-overlap-hint');
        expect(hint).toBeInTheDocument();
        expect(hint.textContent).toMatch(/also recommended by the recent analysis/i);
        expect(hint.textContent).toContain(actionId);
    });

    it('hides "Make a first guess" when there are already selected actions', () => {
        const actionId = 'manual_1';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Manual Action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_manual: true,
                    action_topology: emptyTopo,
                },
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);
        expect(screen.queryByTestId('make-first-guess-button')).not.toBeInTheDocument();
    });

    it('renders "Scored Actions" heading when search is opened and actions are present', async () => {
        const actionId = 'act_1';
        const props = {
            ...defaultProps,
            actionScores: {
                line_reconnection: {
                    scores: { [actionId]: 10 },
                    params: {},
                }
            },
        };
        render(<ActionFeed {...props} />);

        fireEvent.click(screen.getByText('+ Manual Selection'));
        expect(await screen.findByText('Scored Actions')).toBeInTheDocument();
    });

    it('hides prioritized suggestions while analysis is loading', () => {
        const actionId = 'suggested_1';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Suggested Action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_manual: false,
                    action_topology: emptyTopo
                }
            },
            analysisLoading: true,
        };
        render(<ActionFeed {...props} />);

        expect(screen.queryByText('Suggested Action')).not.toBeInTheDocument();
        // Processing indicator is now visible during analysis
        expect(screen.getByText('⚙️ Analyzing…')).toBeInTheDocument();
    });

    it('shows manual actions while analysis is loading', () => {
        const actionId = 'manual_1';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Manual Action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_manual: true,
                    action_topology: emptyTopo
                }
            },
            selectedActionIds: new Set([actionId]),
            analysisLoading: true,
        };
        render(<ActionFeed {...props} />);

        // Card is rendered (description is progressive-disclosure).
        expect(screen.getByTestId(`action-card-${actionId}`)).toBeInTheDocument();
        // Processing indicator is visible even when viewing selected actions
        expect(screen.getByText('⚙️ Analyzing…')).toBeInTheDocument();
    });

    it('shows display prioritized actions button when pending results exist and loading is false', () => {
        const props = {
            ...defaultProps,
            analysisLoading: false,
            pendingAnalysisResult: {
                actions: { 'new_act': { description_unitaire: 'New', rho_before: [], rho_after: [], max_rho: 0.5, max_rho_line: '', is_rho_reduction: true, action_topology: emptyTopo } },
                lines_overloaded: [],
                topo_info: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} },
                pdf_path: null,
                pdf_url: null,
                message: 'done',
                dc_fallback: false
            } as AnalysisResult,
        };
        render(<ActionFeed {...props} />);

        expect(screen.getByText(/Display 1 prioritized actions/)).toBeInTheDocument();
    });

    it('calls onDisplayPrioritizedActions when display button is clicked', () => {
        const onDisplay = vi.fn();
        const props = {
            ...defaultProps,
            analysisLoading: false,
            onDisplayPrioritizedActions: onDisplay,
            pendingAnalysisResult: {
                actions: { 'new_act': { description_unitaire: 'New', rho_before: [], rho_after: [], max_rho: 0.5, max_rho_line: '', is_rho_reduction: true, action_topology: emptyTopo } },
                lines_overloaded: [],
                topo_info: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} },
                pdf_path: null,
                pdf_url: null,
                message: 'done',
                dc_fallback: false
            } as AnalysisResult,
        };
        render(<ActionFeed {...props} />);

        fireEvent.click(screen.getByText(/Display 1 prioritized actions/));
        expect(onDisplay).toHaveBeenCalled();
    });

    it('shows "computed" tag for actions without non_convergence in search table', async () => {
        const actionId = 'act_1';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Test',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: emptyTopo
                }
            },
            actionScores: {
                line_reconnection: {
                    scores: { [actionId]: 10 },
                    params: {},
                }
            }
        };
        render(<ActionFeed {...props} />);

        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByTestId(`badge-computed-${actionId}`)).toBeInTheDocument();
        expect(screen.queryByTestId(`badge-divergent-${actionId}`)).not.toBeInTheDocument();
    });

    it('shows "divergent" tag for non-convergent actions in search table', async () => {
        const actionId = 'act_2';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Test',
                    rho_before: [1.0],
                    rho_after: null,
                    max_rho: null,
                    max_rho_line: 'N/A',
                    is_rho_reduction: false,
                    non_convergence: 'LF error',
                    action_topology: emptyTopo
                }
            },
            actionScores: {
                line_reconnection: {
                    scores: { [actionId]: 5 },
                    params: {},
                }
            }
        };
        render(<ActionFeed {...props} />);

        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByTestId(`badge-divergent-${actionId}`)).toBeInTheDocument();
        expect(screen.queryByTestId(`badge-computed-${actionId}`)).not.toBeInTheDocument();
    });

    it('renders red "divergent" badge and orange warning box for non-convergent action card', () => {
        const actionId = 'act_bad';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Test Bad Action',
                    rho_before: [1.0],
                    rho_after: null,
                    max_rho: null,
                    max_rho_line: 'N/A',
                    is_rho_reduction: false,
                    non_convergence: 'Critical Error',
                    action_topology: emptyTopo
                }
            },
            selectedActionIds: new Set([actionId])
        };
        render(<ActionFeed {...props} />);

        const card = screen.getByTestId(`action-card-${actionId}`);

        // 1. Check Divergent Badge (danger token) — the severity badge is
        // an icon-only pictogram, its wording lives in the `title` tooltip.
        const badge = screen.getByTestId(`action-card-${actionId}-severity`);
        expect(badge).toHaveAttribute('title', 'divergent');
        expect(badge.style.background).toContain('var(--color-danger)');

        // 2. Check Warning Box (warning tokens)
        const warningBox = screen.getByText(/LoadFlow failure: Critical Error/);
        expect(warningBox.style.color).toContain('var(--color-warning-text)');
        expect(warningBox.style.backgroundColor).toContain('var(--color-warning-soft)');

        // 3. Check Card Background (danger-soft token)
        expect(card.style.background).toContain('var(--color-danger-soft)');
    });

    it('ranks non-convergent actions at the bottom', () => {
        const props = {
            ...defaultProps,
            actions: {
                act_good: { description_unitaire: 'Good Action', rho_before: [1.0], rho_after: [0.8], max_rho: 0.8, max_rho_line: 'A', is_rho_reduction: true, action_topology: emptyTopo },
                act_bad: { description_unitaire: 'Bad Action', rho_before: [1.0], rho_after: null, max_rho: null, max_rho_line: 'N/A', is_rho_reduction: false, non_convergence: 'Error', action_topology: emptyTopo }
            },
            selectedActionIds: new Set(['act_good', 'act_bad'])
        };
        render(<ActionFeed {...props} />);

        // Cards are referenced by their testIds — the description text
        // is hidden at-rest under progressive disclosure, so the
        // ordering check has to walk the action-card-${id} test IDs in
        // DOM order instead of scanning rendered text.
        const cards = screen.getAllByTestId(/^action-card-(act_good|act_bad)$/);
        const cardIds = cards.map(el => el.getAttribute('data-testid'));

        const goodIndex = cardIds.indexOf('action-card-act_good');
        const badIndex = cardIds.indexOf('action-card-act_bad');

        expect(goodIndex).toBeLessThan(badIndex);
    });

    // Backend regression guard: ``compute_action_metrics`` zeroes
    // ``max_rho`` on a non-convergent simulation (see
    // ``expert_backend/services/simulation_helpers.py`` —
    // ``"max_rho": 0.0`` is the default before the convergence
    // check). Sorting by ``max_rho`` alone would float the
    // divergent card to the top of the stack ahead of legitimate
    // solving actions — this test pins ``non_convergence`` as the
    // dominant ordering key in that situation.
    it('ranks divergent actions (max_rho=0) at the bottom, not the top', () => {
        const props = {
            ...defaultProps,
            actions: {
                act_solving: { description_unitaire: 'Solving Action', rho_before: [1.0], rho_after: [0.9], max_rho: 0.9, max_rho_line: 'A', is_rho_reduction: true, action_topology: emptyTopo },
                act_divergent: { description_unitaire: 'Divergent Action', rho_before: [1.0], rho_after: null, max_rho: 0, max_rho_line: 'N/A', is_rho_reduction: false, non_convergence: 'LoadFlow failure', action_topology: emptyTopo },
            },
            selectedActionIds: new Set(['act_solving', 'act_divergent']),
        };
        render(<ActionFeed {...props} />);

        const cards = screen.getAllByTestId(/^action-card-(act_solving|act_divergent)$/);
        const cardIds = cards.map(el => el.getAttribute('data-testid'));

        expect(cardIds.indexOf('action-card-act_solving')).toBeLessThan(
            cardIds.indexOf('action-card-act_divergent'),
        );
    });

    it('shows only PST actions in dropdown after clicking the PST chip', async () => {
        const pstAction = { id: 'pst_tap_up', description: 'PST action', type: 'pst_tap_change' };
        const regularAction = { id: 'line_reco_1', description: 'Regular action', type: 'line_reconnection' };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([pstAction, regularAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        const pstChip = await screen.findByTestId('sidebar-filter-type-pst');
        fireEvent.click(pstChip);

        // PST action visible, reco action hidden
        expect(await screen.findByText('pst_tap_up')).toBeInTheDocument();
        expect(screen.queryByText('line_reco_1')).not.toBeInTheDocument();
    });

    it('shows all actions in dropdown when ALL chip is active (default)', async () => {
        const pstAction = { id: 'pst_tap_up', description: 'PST action', type: 'pst_tap_change' };
        const regularAction = { id: 'line_reco_1', description: 'Regular action', type: 'line_reconnection' };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([pstAction, regularAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('pst_tap_up')).toBeInTheDocument();
        expect(screen.getByText('line_reco_1')).toBeInTheDocument();
    });

    it('hides PST actions in search results after setting filter to RECO', async () => {
        const pstAction = { id: 'pst_tap_up', description: 'PST action' };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([pstAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        // Set filter to RECO
        const recoChip = await screen.findByTestId('sidebar-filter-type-reco');
        fireEvent.click(recoChip);

        // Type "pst" in search
        const searchInput = screen.getByPlaceholderText(/Search action/);
        fireEvent.change(searchInput, { target: { value: 'pst' } });

        await waitFor(() => {
            expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
        });

        // PST action NOT visible because filter is 'reco'
        expect(screen.queryByText('pst_tap_up')).not.toBeInTheDocument();
        // Manual simulation option still visible
        expect(screen.getByText(/Simulate manual ID:/)).toBeInTheDocument();
    });

    it('shows only PST actions in dropdown after clicking PST chip (excludes disco and unknown)', async () => {
        const pstAction = { id: 'pst_1', description: 'PST action' };
        const discoAction = { id: 'abc', description: 'Ouverture de ligne' };
        const unknownAction = { id: 'xyz', description: 'Some unknown action' };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([pstAction, discoAction, unknownAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        const pstChip = await screen.findByTestId('sidebar-filter-type-pst');
        fireEvent.click(pstChip);

        expect(await screen.findByText('pst_1')).toBeInTheDocument();
        expect(screen.queryByText('abc')).not.toBeInTheDocument();
        expect(screen.queryByText('xyz')).not.toBeInTheDocument();
    });

    it('shows only LS actions in dropdown after clicking LS chip', async () => {
        const lsAction = { id: 'load_shedding_LOAD1', description: 'Load shedding LOAD1' };
        const regularAction = { id: 'line_reco_1', description: 'Reconnexion' };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([lsAction, regularAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        const lsChip = await screen.findByTestId('sidebar-filter-type-ls');
        fireEvent.click(lsChip);

        expect(await screen.findByText('load_shedding_LOAD1')).toBeInTheDocument();
        expect(screen.queryByText('line_reco_1')).not.toBeInTheDocument();
    });

    it('triggers manual simulation when "Simulate manual ID" is clicked', async () => {
        render(<ActionFeed {...defaultProps} />);

        // Open search
        fireEvent.click(screen.getByText('+ Manual Selection'));

        // Type something that doesn't exist
        const searchInput = screen.getByPlaceholderText(/Search action/);
        fireEvent.change(searchInput, { target: { value: 'custom_action_123' } });

        // Wait for loading to finish
        await waitFor(() => {
            expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
        });

        // Click "Simulate manual ID"
        const manualOption = screen.getByText(/Simulate manual ID:/);
        fireEvent.click(manualOption);

        // Verify simulateManualAction was called
        expect(api.simulateManualAction).toHaveBeenCalledWith(
            'custom_action_123',
            'LINE_1',
            null,
            ['LINE_1'],
            undefined,
            undefined,
        );
    });

    // Operator-requested addition: chain several manual simulations
    // from the wide score-table modal without it auto-closing each
    // round. Mirrors the Combine Actions modal's contract — the
    // operator typically wants to compare a handful of candidate
    // remedies before committing. The narrow no-score search still
    // auto-dismisses (one-shot "type an ID, hit enter" flow).
    describe('manual-selection modal lifecycle (multi-simulation flow)', () => {
        // ``defaultProps.onManualActionAdded`` (and the api module
        // mocks) are shared ``vi.fn()`` references at the describe-block
        // scope, so a successful simulation in this group would
        // otherwise carry call history into the unrelated
        // race-condition guard below ("awaits simulation before
        // calling onManualActionAdded …"). Clear before each test in
        // this group AND after the group finishes so the surrounding
        // suite sees a clean slate.
        beforeEach(() => {
            vi.clearAllMocks();
        });
        afterEach(() => {
            vi.clearAllMocks();
        });

        const buildScoredProps = () => ({
            ...defaultProps,
            actionScores: {
                line_reconnection: {
                    scores: { reco_A: 5, reco_B: 4 },
                    params: {},
                },
            } as Record<string, Record<string, unknown>>,
            actions: {} as Record<string, ActionDetail>,
        });

        const mockSimulateOk = (actionId: string) => {
            vi.mocked(api.simulateManualAction).mockResolvedValueOnce({
                action_id: actionId,
                description_unitaire: 'simulated',
                rho_before: [1.05],
                rho_after: [0.85],
                max_rho: 0.85,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                is_islanded: false,
                n_components: 1,
                disconnected_mw: 0,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                lines_overloaded_after: [],
                load_shedding_details: [],
                curtailment_details: [],
                pst_details: [],
                action_topology: emptyTopo,
                is_estimated: false,
            } as Awaited<ReturnType<typeof api.simulateManualAction>>);
        };

        it('keeps the wide score-table modal open after a successful manual simulation', async () => {
            const props = buildScoredProps();
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));

            // Wide layout active — scored actions visible.
            expect(screen.getByTestId('manual-selection-wide')).toBeInTheDocument();
            expect(screen.queryByTestId('manual-selection-dropdown')).not.toBeInTheDocument();

            // Wait for the available-actions fetch to settle before the
            // ScoreTable renders the row links.
            await waitFor(() => {
                expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
            });

            mockSimulateOk('reco_A');
            fireEvent.click(screen.getByText('reco_A'));

            await waitFor(() => {
                expect(api.simulateManualAction).toHaveBeenCalledTimes(1);
            });
            // The wide overlay must still be mounted — pre-fix it
            // unmounted on every simulation, forcing the operator
            // to reopen + re-scroll for the next candidate.
            expect(screen.getByTestId('manual-selection-wide')).toBeInTheDocument();
            // The score list is preserved so the next row is one
            // click away (no need to re-filter / re-search).
            expect(screen.getByText('reco_B')).toBeInTheDocument();
        });

        it('keeps the wide overlay layout when a chip filter empties the scored list', async () => {
            // Pre-fix the modal layout was driven by the *post-filter*
            // scoredActionsList length: switching to a chip with no
            // matching scored action collapsed the wide overlay back to
            // the small button-anchored dropdown, which read as the
            // modal closing mid-interaction. Once analysis has produced
            // any scored action the wide layout must stick across chip
            // toggles — empty chips just surface the existing
            // "no relevant action detected" warning + raw-action list.
            const props = buildScoredProps();
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            expect(screen.getByTestId('manual-selection-wide')).toBeInTheDocument();

            await waitFor(() => {
                expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
            });

            // Pick a chip filter that yields zero scored rows
            // (line_reconnection is the only scored type in
            // ``buildScoredProps``; the PST chip filters everything out).
            const pstChip = await screen.findByTestId('sidebar-filter-type-pst');
            fireEvent.click(pstChip);

            // The wide overlay must remain mounted; the narrow
            // dropdown must NOT take its place.
            expect(screen.getByTestId('manual-selection-wide')).toBeInTheDocument();
            expect(screen.queryByTestId('manual-selection-dropdown')).not.toBeInTheDocument();
        });

        it('still closes the narrow no-score dropdown after a manual ID is simulated', async () => {
            // No actionScores → narrow layout, traditional one-shot
            // flow. Closing on success is the expected UX.
            render(<ActionFeed {...defaultProps} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            expect(screen.getByTestId('manual-selection-dropdown')).toBeInTheDocument();

            const searchInput = screen.getByPlaceholderText(/Search action/);
            fireEvent.change(searchInput, { target: { value: 'custom_42' } });
            await waitFor(() => {
                expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
            });

            mockSimulateOk('custom_42');
            fireEvent.click(screen.getByText(/Simulate manual ID:/));

            await waitFor(() => {
                expect(screen.queryByTestId('manual-selection-dropdown')).not.toBeInTheDocument();
            });
        });
    });

    it('hides actions that classify as disco even when their score type is pst, when filter is "pst"', async () => {
        // classifyActionType puts this action in 'disco' because the description
        // starts with "Ouverture" — it should NOT appear under the PST chip filter.
        const pstDiscoAction = {
            id: 'disco_pst_branch',
            description: 'Ouverture de la branche PST',
            type: 'pst_tap_change',
        };

        vi.mocked(api.getAvailableActions).mockResolvedValueOnce([pstDiscoAction]);

        render(<ActionFeed {...defaultProps} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        const pstChip = await screen.findByTestId('sidebar-filter-type-pst');
        fireEvent.click(pstChip);

        await waitFor(() => {
            expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument();
        });

        expect(screen.queryByText('disco_pst_branch')).not.toBeInTheDocument();
        expect(screen.getByText('All actions already added')).toBeInTheDocument();
    });
    // Action-dictionary stats and recommender thresholds were moved
    // out of ActionFeed and into NoticesPanel (tier-warning-system PR — see
    // `docs/proposals/ui-design-critique.md` recommendation #4). The
    // matching coverage now lives in `NoticesPanel.test.tsx`.

    it('shows yellow processing button during analysisLoading', () => {
        const props = {
            ...defaultProps,
            analysisLoading: true,
        };
        render(<ActionFeed {...props} />);

        const banner = screen.getByText('⚙️ Analyzing…');
        expect(banner).toBeInTheDocument();
        expect(banner.style.background).toContain('var(--color-warning-soft)');
        expect(banner.style.color).toContain('var(--color-warning-text)');
    });

    // The recommender-settings hint and the action-dict "Change in
    // settings" affordance live in NoticesPanel after tier-warning-system PR. See
    // `NoticesPanel.test.tsx` for the moved coverage.
    it('awaits simulation before calling onManualActionAdded to prevent race conditions', async () => {
        const actionId = 'act1';
        const mockResult = {
            description_unitaire: 'Description',
            rho_before: [1.0],
            rho_after: [0.8],
            max_rho: 0.8,
            max_rho_line: 'LINE_A',
            is_rho_reduction: true,
            action_id: actionId,
            lines_overloaded: []
        };

        vi.mocked(api.getAvailableActions).mockResolvedValue([{ id: 'act1', type: 'disco', description: 'desc' }]);

        // Mock a slow simulation
        let simulationFinished = false;
        vi.mocked(api.simulateManualAction).mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            simulationFinished = true;
            return {
                ...mockResult,
                non_convergence: null,
                is_estimated: false,
                lines_overloaded: []
            } as { action_id: string; description_unitaire: string; rho_before: number[] | null; rho_after: number[] | null; max_rho: number | null; max_rho_line: string; is_rho_reduction: boolean; is_islanded?: boolean; n_components?: number; disconnected_mw?: number; non_convergence: string | null; lines_overloaded: string[]; };
        });

        const props = {
            ...defaultProps,
            disconnectedElement: 'contingency_A',
        };
        const { getByText, getByPlaceholderText } = render(<ActionFeed {...props} />);

        // Open search and add action
        fireEvent.click(getByText('+ Manual Selection'));

        // Wait for actions to load
        await waitFor(() => expect(screen.queryByText('Loading actions...')).not.toBeInTheDocument());

        const input = getByPlaceholderText('Search action by ID or description...');
        fireEvent.change(input, { target: { value: 'act1' } });

        const actionCard = await screen.findByTestId('action-card-act1');
        fireEvent.click(actionCard);

        // Verify it shows loading state
        expect(screen.getByText('Simulating...')).toBeInTheDocument();

        // At this point onManualActionAdded should NOT have been called yet
        expect(defaultProps.onManualActionAdded).not.toHaveBeenCalled();

        // Wait for simulation to finish
        await waitFor(() => expect(simulationFinished).toBe(true));

        // Now onManualActionAdded should have been called
        await waitFor(() => {
            expect(defaultProps.onManualActionAdded).toHaveBeenCalledWith(
                actionId,
                expect.objectContaining({ max_rho: 0.8 }),
                []
            );
        });
    });

    it('filters out combined actions that are marked as is_estimated', () => {
        const combinedId = 'act1+act2';
        const props = {
            ...defaultProps,
            actions: {
                [combinedId]: {
                    description_unitaire: 'Combined Action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_estimated: true, // This should cause it to be filtered out
                    action_topology: emptyTopo
                }
            },
            selectedActionIds: new Set([combinedId]),
            analysisLoading: false,
        };
        render(<ActionFeed {...props} />);

        expect(screen.queryByText('Combined Action')).not.toBeInTheDocument();
    });

    it('shows simulated combined actions that are NOT marked as is_estimated', () => {
        const combinedId = 'act1+act2';
        const props = {
            ...defaultProps,
            actions: {
                [combinedId]: {
                    description_unitaire: 'Simulated Combined Action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    is_estimated: false,
                    action_topology: emptyTopo
                }
            },
            selectedActionIds: new Set([combinedId]),
            analysisLoading: false,
        };
        render(<ActionFeed {...props} />);

        // Card is rendered (description is progressive-disclosure).
        expect(screen.getByTestId(`action-card-${combinedId}`)).toBeInTheDocument();
    });

    it('renders multiple asset badges for combined actions', () => {
        const combinedId = 'VL1+LINE_A';
        const props = {
            ...defaultProps,
            actions: {
                [combinedId]: {
                    description_unitaire: "Action on 'VL1' and LINE_A",
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_B',
                    is_rho_reduction: true,
                    action_topology: emptyTopo
                }
            },
            selectedActionIds: new Set([combinedId]),
            nodesByEquipmentId: new Map([['VL1', { equipmentId: 'VL1', svgId: 'svg-vl1', x: 0, y: 0 }]]),
            edgesByEquipmentId: new Map([['LINE_A', { equipmentId: 'LINE_A', svgId: 'svg-line-a', node1: 'n1', node2: 'n2' }]]),
        };

        // Mock utils to return the assets
        vi.mocked(getActionTargetVoltageLevels).mockReturnValue(['VL1']);
        vi.mocked(getActionTargetLines).mockReturnValue(['LINE_A']);

        render(<ActionFeed {...props} />);

        // Should see both badges
        expect(screen.getByText('VL1')).toBeInTheDocument();
        expect(screen.getByText('LINE_A')).toBeInTheDocument();

        // Clicking a badge should call onAssetClick
        fireEvent.click(screen.getByText('VL1'));
        expect(props.onAssetClick).toHaveBeenCalledWith(combinedId, 'VL1', 'action');

        fireEvent.click(screen.getByText('LINE_A'));
        expect(props.onAssetClick).toHaveBeenCalledWith(combinedId, 'LINE_A', 'action');
    });

    it('updates severity badges based on monitoringFactor', () => {
        const actionId = 'act_test';
        const actionDetail = {
            description_unitaire: 'Test Action',
            max_rho: 0.93,
            max_rho_line: 'LINE_A',
            rho_before: [1.0],
            rho_after: [0.93],
            is_rho_reduction: true,
            action_topology: emptyTopo
        };

        const renderWithMF = (mf: number) => render(
            <ActionFeed
                {...defaultProps}
                actions={{ [actionId]: actionDetail }}
                selectedActionIds={new Set([actionId])}
                monitoringFactor={mf}
            />
        );

        // 1. MF = 0.95 -> 0.93 is between (0.95-0.05) and 0.95 -> Orange
        // The severity badge is icon-only; its wording is in the tooltip.
        const { rerender } = renderWithMF(0.95);
        expect(screen.getByTitle('Solved \u2014 low margin')).toBeInTheDocument();

        // 2. MF = 0.90 -> 0.93 is above 0.90 -> Red
        rerender(
            <ActionFeed
                {...defaultProps}
                actions={{ [actionId]: actionDetail }}
                selectedActionIds={new Set([actionId])}
                monitoringFactor={0.90}
            />
        );
        expect(screen.getByTitle('Still overloaded')).toBeInTheDocument();

        // 3. MF = 1.00 -> 0.93 is below (1.00-0.05) -> Green
        rerender(
            <ActionFeed
                {...defaultProps}
                actions={{ [actionId]: actionDetail }}
                selectedActionIds={new Set([actionId])}
                monitoringFactor={1.00}
            />
        );
        expect(screen.getByTitle('Solves overload')).toBeInTheDocument();
    });

    it('displays load shedding description with MW, load name, and clickable voltage level', () => {
        const actionId = 'load_shed_1';
        const props = {
            ...defaultProps,
            // Editor disclosure is gated on the viewing state — set
            // selectedActionId so the load-shedding details panel
            // (which carries the LOAD_1 / Shedding-on copy this test
            // checks for) actually renders.
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Shedding action on load',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: { LOAD_1: -1 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_1', voltage_level_id: 'VL_ALPHA', shedded_mw: 42.5 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // Should show load shedding description with asset name
        expect(screen.getByText(/Shedding on/)).toBeInTheDocument();
        expect(screen.getByText('LOAD_1')).toBeInTheDocument();

        // VL should be rendered as clickable badge button
        const vlButtons = screen.getAllByText('VL_ALPHA');
        expect(vlButtons.length).toBeGreaterThanOrEqual(1);
        expect(vlButtons.every(el => el.tagName === 'BUTTON')).toBe(true);
    });

    it('shows VL badges from load_shedding_details instead of load name badges', () => {
        const actionId = 'load_shed_2';
        const props = {
            ...defaultProps,
            actions: {
                [actionId]: {
                    description_unitaire: 'Shedding action',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: { LOAD_X: -1 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_X', voltage_level_id: 'VL_BETA', shedded_mw: 10.0 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // VL badge should be present (green VL badge)
        const badges = screen.getAllByText('VL_BETA');
        // There should be at least one button element (the badge) with VL_BETA text
        const buttonBadges = badges.filter(el => el.tagName === 'BUTTON');
        expect(buttonBadges.length).toBeGreaterThan(0);
    });

    it('displays multiple load shedding entries when action sheds multiple loads', () => {
        const actionId = 'load_shed_multi';
        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Multi-load shedding',
                    rho_before: [1.0],
                    rho_after: [0.7],
                    max_rho: 0.7,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: { LOAD_A: -1, LOAD_B: -1 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_A', voltage_level_id: 'VL_1', shedded_mw: 20.0 },
                        { load_name: 'LOAD_B', voltage_level_id: 'VL_2', shedded_mw: 15.3 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // Both load names should be shown in the simplified format
        expect(screen.getByText('LOAD_A')).toBeInTheDocument();
        expect(screen.getByText('LOAD_B')).toBeInTheDocument();
        // Both entries should have "Load shedding on" text
        const lsTexts = screen.getAllByText(/Shedding on/);
        expect(lsTexts.length).toBe(2);
    });

    it('clicking VL button in load shedding description triggers onAssetClick', () => {
        const onAssetClick = vi.fn();
        const actionId = 'load_shed_click';
        const props = {
            ...defaultProps,
            onAssetClick,
            actions: {
                [actionId]: {
                    description_unitaire: 'Shedding for click test',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: { LOAD_C: -1 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_C', voltage_level_id: 'VL_GAMMA', shedded_mw: 30.0 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // Find the VL button in the load shedding description area (not the badge)
        const vlButtons = screen.getAllByText('VL_GAMMA');
        // Click the first one (description area)
        fireEvent.click(vlButtons[0]);
        expect(onAssetClick).toHaveBeenCalledWith(actionId, 'VL_GAMMA', 'action');
    });

    // ── MW Start column ────────────────────────────────────────────────────

    it('shows MW Start column header in score table', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                line_reconnection: {
                    scores: { act_reco: 8 },
                    mw_start: { act_reco: null },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('MW Start')).toBeInTheDocument();
    });

    it('shows numeric MW Start value for disco/pst/ls actions', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                line_disconnection: {
                    scores: { disco_L1: 9 },
                    mw_start: { disco_L1: 125.4 },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('125.4')).toBeInTheDocument();
    });

    it('shows N/A for reconnection and close-coupling actions', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                line_reconnection: {
                    scores: { reco_L2: 7 },
                    mw_start: { reco_L2: null },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('N/A')).toBeInTheDocument();
        expect(screen.queryByText(/^\d+\.\d$/)).not.toBeInTheDocument();
    });

    it('shows N/A when mw_start field is absent for the action', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                pst_tap_change: {
                    scores: { pst_act: 5 },
                    // no mw_start key at all
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('N/A')).toBeInTheDocument();
    });

    it('shows MW Start for load shedding action', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                load_shedding: {
                    scores: { ls_LOAD_1: 3 },
                    mw_start: { ls_LOAD_1: 75.0 },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));

        expect(await screen.findByText('75.0')).toBeInTheDocument();
    });

    // ── Power reduction format (loads_p / gens_p) ──────────────────────────

    it('displays load shedding details with new loads_p topology format', () => {
        const actionId = 'load_shed_new_format';
        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Load shedding (power reduction)',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {}, loads_p: { LOAD_PR: 0.0 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_PR', voltage_level_id: 'VL_PR', shedded_mw: 55.3 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // Simplified format: "Shedding on LOAD_PR in MW: [input]"
        expect(screen.getByText(/Shedding on/)).toBeInTheDocument();
        expect(screen.getByText('LOAD_PR')).toBeInTheDocument();
        // VL badge should still be rendered
        const vlButtons = screen.getAllByText('VL_PR');
        expect(vlButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('displays curtailment details with new gens_p topology format', () => {
        const actionId = 'curtail_new_format';
        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Curtailment (power reduction)',
                    rho_before: [1.0],
                    rho_after: [0.85],
                    max_rho: 0.85,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {}, gens_p: { WIND_1: 0.0 } },
                    curtailment_details: [
                        { gen_name: 'WIND_1', voltage_level_id: 'VL_WIND', curtailed_mw: 80.0 },
                    ],
                }
            },
            selectedActionIds: new Set([actionId]),
        };
        render(<ActionFeed {...props} />);

        // Simplified format: "Curtailment on WIND_1 in MW: [input]"
        expect(screen.getByText(/Curtailment on/)).toBeInTheDocument();
        expect(screen.getByText('WIND_1')).toBeInTheDocument();
        // VL badge should still be rendered
        const vlButtons = screen.getAllByText('VL_WIND');
        expect(vlButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('displays load shedding with loads_p and curtailment with gens_p in same action list', () => {
        // Only one card can be the viewing card at a time, so we
        // assert each editor through a focused rerender rather than
        // expecting both editor panels open simultaneously.
        const lsId = 'ls_new_1';
        const rcId = 'rc_new_1';
        const props = {
            ...defaultProps,
            actions: {
                [lsId]: {
                    description_unitaire: 'Load shedding power reduction',
                    rho_before: [1.0],
                    rho_after: [0.8],
                    max_rho: 0.8,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {}, loads_p: { LOAD_NEW: 0.0 } },
                    load_shedding_details: [
                        { load_name: 'LOAD_NEW', voltage_level_id: 'VL_LS', shedded_mw: 33.0 },
                    ],
                },
                [rcId]: {
                    description_unitaire: 'Curtailment power reduction',
                    rho_before: [1.0],
                    rho_after: [0.85],
                    max_rho: 0.85,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {}, gens_p: { GEN_NEW: 0.0 } },
                    curtailment_details: [
                        { gen_name: 'GEN_NEW', voltage_level_id: 'VL_RC', curtailed_mw: 66.0 },
                    ],
                }
            },
            selectedActionIds: new Set([lsId, rcId]),
        };

        // Both cards must be in the list regardless of viewing state.
        const { rerender } = render(<ActionFeed {...props} selectedActionId={lsId} />);
        expect(screen.getByTestId(`action-card-${lsId}`)).toBeInTheDocument();
        expect(screen.getByTestId(`action-card-${rcId}`)).toBeInTheDocument();

        // Viewing the LS card discloses the load-shedding editor.
        expect(screen.getByText(/Shedding on/)).toBeInTheDocument();
        expect(screen.getByText('LOAD_NEW')).toBeInTheDocument();

        // Viewing the RC card discloses the curtailment editor.
        rerender(<ActionFeed {...props} selectedActionId={rcId} />);
        expect(screen.getByText(/Curtailment on/)).toBeInTheDocument();
        expect(screen.getByText('GEN_NEW')).toBeInTheDocument();
    });

    it('shows Target MW column in score table for load shedding type', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                load_shedding: {
                    scores: { 'load_shedding_LOAD_1': 5.0 },
                    params: {},
                    mw_start: { 'load_shedding_LOAD_1': 100.0 },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        expect(await screen.findByText('Target MW')).toBeInTheDocument();
        expect(screen.getByTestId('target-mw-load_shedding_LOAD_1')).toBeInTheDocument();
    });

    it('shows Target MW column in score table for renewable curtailment type', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                renewable_curtailment: {
                    scores: { 'curtail_GEN_1': 3.0 },
                    params: {},
                    mw_start: { 'curtail_GEN_1': 80.0 },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        expect(await screen.findByText('Target MW')).toBeInTheDocument();
        expect(screen.getByTestId('target-mw-curtail_GEN_1')).toBeInTheDocument();
    });

    it('does NOT show Target MW column for line_disconnection type', async () => {
        const props = {
            ...defaultProps,
            actionScores: {
                line_disconnection: {
                    scores: { 'disco_LINE_1': 7.0 },
                    params: {},
                    mw_start: { 'disco_LINE_1': null },
                }
            },
        };
        render(<ActionFeed {...props} />);
        fireEvent.click(screen.getByText('+ Manual Selection'));
        await screen.findByText('LINE DISCONNECTION');
        expect(screen.queryByText('Target MW')).not.toBeInTheDocument();
    });

    it('shows editable MW and re-simulate button on load shedding action card', () => {
        // Parameter editors are progressive-disclosure (PR
        // claude/redesign-actioncard-…): they only render on the
        // currently-viewed card to keep at-rest cards to five
        // fields. Set `selectedActionId` so the editor is visible.
        const actionId = 'load_shedding_LOAD_X';
        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Load shedding on LOAD_X',
                    rho_before: [0.95],
                    rho_after: [0.70],
                    max_rho: 0.70,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    non_convergence: null,
                    load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                    action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                } as ActionDetail,
            },
        };
        render(<ActionFeed {...props} />);
        expect(screen.getByTestId(`edit-mw-${actionId}`)).toBeInTheDocument();
        expect(screen.getByTestId(`resimulate-${actionId}`)).toBeInTheDocument();
        expect(screen.getByTestId(`resimulate-${actionId}`)).toHaveTextContent('Re-simulate');
    });

    it('shows editable MW and re-simulate button on curtailment action card', () => {
        const actionId = 'curtail_GEN_Y';
        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Curtailment on GEN_Y',
                    rho_before: [0.95],
                    rho_after: [0.80],
                    max_rho: 0.80,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    non_convergence: null,
                    curtailment_details: [{ gen_name: 'GEN_Y', voltage_level_id: 'VL_W', curtailed_mw: 60.0 }],
                    action_topology: { ...emptyTopo, gens_p: { GEN_Y: 0.0 } },
                } as ActionDetail,
            },
        };
        render(<ActionFeed {...props} />);
        expect(screen.getByTestId(`edit-mw-${actionId}`)).toBeInTheDocument();
        expect(screen.getByTestId(`resimulate-${actionId}`)).toBeInTheDocument();
    });

    it('calls simulateManualAction with target_mw when re-simulate is clicked', async () => {
        const actionId = 'load_shedding_LOAD_X';
        const mockResult = {
            action_id: actionId,
            description_unitaire: 'Load shedding on LOAD_X',
            rho_before: [0.95],
            rho_after: [0.60],
            max_rho: 0.60,
            max_rho_line: 'LINE_1',
            is_rho_reduction: true,
            non_convergence: null,
            lines_overloaded: ['LINE_1'],
            load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 25.0 }],
        };
        (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

        const props = {
            ...defaultProps,
            selectedActionId: actionId,
            actions: {
                [actionId]: {
                    description_unitaire: 'Load shedding on LOAD_X',
                    rho_before: [0.95],
                    rho_after: [0.70],
                    max_rho: 0.70,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    non_convergence: null,
                    load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                    action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                } as ActionDetail,
            },
        };
        render(<ActionFeed {...props} />);

        // Change the MW input value
        const mwInput = screen.getByTestId(`edit-mw-${actionId}`);
        fireEvent.change(mwInput, { target: { value: '25' } });

        // Click re-simulate
        fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

        await waitFor(() => {
            expect(api.simulateManualAction).toHaveBeenCalledWith(
                actionId,
                'LINE_1',
                expect.anything(),
                ['LINE_1'],
                25,
            );
        });
    });

    // Bug 5: re-simulating a Suggested LS / RC / PST card must dispatch
    // through the `onActionResimulated` callback (which preserves the
    // action's current bucket) — NEVER `onManualActionAdded`, which would
    // silently promote the card into Selected Actions.
    describe('Re-simulate dispatches to onActionResimulated (Bug 5)', () => {
        const buildLsProps = () => {
            const actionId = 'load_shedding_LOAD_B5';
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                onManualActionAdded: vi.fn(),
                onActionResimulated: vi.fn(),
                actions: {
                    [actionId]: {
                        description_unitaire: 'ls B5',
                        rho_before: [0.95],
                        rho_after: [0.7],
                        max_rho: 0.7,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [
                            { load_name: 'LOAD_B5', voltage_level_id: 'VL', shedded_mw: 6.4 },
                        ],
                        action_topology: { ...emptyTopo, loads_p: { LOAD_B5: 0.0 } },
                    } as ActionDetail,
                },
            };
            const mockResult = {
                action_id: actionId,
                description_unitaire: 'ls B5',
                rho_before: [0.95],
                rho_after: [0.5],
                max_rho: 0.5,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                lines_overloaded_after: [],
                load_shedding_details: [
                    { load_name: 'LOAD_B5', voltage_level_id: 'VL', shedded_mw: 5.4 },
                ],
            };
            return { actionId, props, mockResult };
        };

        it('calls onActionResimulated (not onManualActionAdded) on LS re-simulate', async () => {
            const { actionId, props, mockResult } = buildLsProps();
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-mw-${actionId}`), { target: { value: '5.4' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });
            expect(props.onActionResimulated).toHaveBeenCalledWith(
                actionId,
                expect.objectContaining({
                    lines_overloaded_after: [],
                }),
                ['LINE_1'],
            );
            // Critical: the "add manual action" callback (which would
            // promote the card into Selected Actions) must NOT have been
            // invoked.
            expect(props.onManualActionAdded).not.toHaveBeenCalled();
        });

        it('calls onActionResimulated (not onManualActionAdded) on PST tap re-simulate', async () => {
            const pstActionId = 'pst_B5';
            const props = {
                ...defaultProps,
                selectedActionId: pstActionId,
                onManualActionAdded: vi.fn(),
                onActionResimulated: vi.fn(),
                actions: {
                    [pstActionId]: {
                        description_unitaire: 'pst B5',
                        rho_before: [0.95],
                        rho_after: [0.7],
                        max_rho: 0.7,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        pst_details: [
                            { pst_name: 'PST_B5', tap_position: 3, low_tap: -5, high_tap: 5 },
                        ],
                        action_topology: { ...emptyTopo, pst_tap: { PST_B5: 0 } },
                    } as ActionDetail,
                },
            };
            const mockResult = {
                action_id: pstActionId,
                description_unitaire: 'pst B5',
                rho_before: [0.95],
                rho_after: [0.5],
                max_rho: 0.5,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                lines_overloaded_after: [],
                pst_details: [
                    { pst_name: 'PST_B5', tap_position: 4, low_tap: -5, high_tap: 5 },
                ],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-tap-${pstActionId}`), { target: { value: '4' } });
            fireEvent.click(screen.getByTestId(`resimulate-tap-${pstActionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });
            expect(props.onManualActionAdded).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Re-simulation interaction logging (action_mw_resimulated / pst_tap_resimulated)
    // =========================================================================
    //
    // These events carry the raw user-entered target value so a replay
    // agent can type the same MW / tap into the card's input before
    // clicking Re-simulate. They are emitted from
    // ActionFeed.handleResimulate / handleResimulateTap — NOT from the
    // useActions hook, which used to log a mistyped
    // 'manual_action_simulated' event.
    // -------------------------------------------------------------------------
    describe('Re-simulation interaction logging', () => {
        beforeEach(() => {
            interactionLogger.clear();
        });

        const buildLsProps = () => {
            const actionId = 'load_shedding_LOG_A1';
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                onActionResimulated: vi.fn(),
                actions: {
                    [actionId]: {
                        description_unitaire: 'ls A1',
                        rho_before: [0.95],
                        rho_after: [0.7],
                        max_rho: 0.7,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [
                            { load_name: 'LOG_A1', voltage_level_id: 'VL', shedded_mw: 6.4 },
                        ],
                        action_topology: { ...emptyTopo, loads_p: { LOG_A1: 0.0 } },
                    } as ActionDetail,
                },
            };
            const mockResult = {
                action_id: actionId,
                description_unitaire: 'ls A1',
                rho_before: [0.95],
                rho_after: [0.55],
                max_rho: 0.55,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                lines_overloaded_after: [],
                load_shedding_details: [
                    { load_name: 'LOG_A1', voltage_level_id: 'VL', shedded_mw: 5.4 },
                ],
            };
            return { actionId, props, mockResult };
        };

        it('records action_mw_resimulated with the exact user-entered target MW on LS re-simulate', async () => {
            const { actionId, props, mockResult } = buildLsProps();
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-mw-${actionId}`), { target: { value: '5.4' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });

            const log = interactionLogger.getLog();
            const evt = log.find(e => e.type === 'action_mw_resimulated');
            expect(evt).toBeDefined();
            expect(evt!.details).toEqual({
                action_id: actionId,
                // parseFloat of the input string, before any backend
                // clamping — matches the value the user typed.
                target_mw: 5.4,
            });
        });

        it('does NOT record manual_action_simulated when re-simulating load shedding', async () => {
            const { actionId, props, mockResult } = buildLsProps();
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-mw-${actionId}`), { target: { value: '5.4' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });

            // Regression guard: re-simulation is a distinct gesture
            // and must NOT be logged as a manual action (which would
            // mislead a replay agent into promoting the card into
            // Selected Actions).
            const log = interactionLogger.getLog();
            expect(log.some(e => e.type === 'manual_action_simulated')).toBe(false);
        });

        it('records pst_tap_resimulated with the exact user-entered tap on PST re-simulate', async () => {
            const pstActionId = 'pst_A1';
            const props = {
                ...defaultProps,
                selectedActionId: pstActionId,
                onActionResimulated: vi.fn(),
                actions: {
                    [pstActionId]: {
                        description_unitaire: 'pst A1',
                        rho_before: [0.95],
                        rho_after: [0.7],
                        max_rho: 0.7,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        pst_details: [
                            { pst_name: 'PST_A1', tap_position: 3, low_tap: -5, high_tap: 5 },
                        ],
                        action_topology: { ...emptyTopo, pst_tap: { PST_A1: 0 } },
                    } as ActionDetail,
                },
            };
            const mockResult = {
                action_id: pstActionId,
                description_unitaire: 'pst A1',
                rho_before: [0.95],
                rho_after: [0.5],
                max_rho: 0.5,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                lines_overloaded_after: [],
                pst_details: [
                    { pst_name: 'PST_A1', tap_position: 4, low_tap: -5, high_tap: 5 },
                ],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-tap-${pstActionId}`), { target: { value: '4' } });
            fireEvent.click(screen.getByTestId(`resimulate-tap-${pstActionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });

            const log = interactionLogger.getLog();
            const evt = log.find(e => e.type === 'pst_tap_resimulated');
            expect(evt).toBeDefined();
            expect(evt!.details).toEqual({
                action_id: pstActionId,
                target_tap: 4,
            });

            // And again: a PST re-simulation must not masquerade as a
            // manual action.
            expect(log.some(e => e.type === 'manual_action_simulated')).toBe(false);
            expect(log.some(e => e.type === 'action_mw_resimulated')).toBe(false);
        });

        it('records target_mw as the parsed float even when the user types extra decimals', async () => {
            const { actionId, props, mockResult } = buildLsProps();
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            render(<ActionFeed {...props} />);
            fireEvent.change(screen.getByTestId(`edit-mw-${actionId}`), { target: { value: '5.400' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(props.onActionResimulated).toHaveBeenCalledTimes(1);
            });

            const log = interactionLogger.getLog();
            const evt = log.find(e => e.type === 'action_mw_resimulated');
            expect(evt).toBeDefined();
            expect(evt!.details.target_mw).toBe(5.4);
        });
    });

    // =========================================================================
    // PST Tap Start / Target Tap — score table tests
    // =========================================================================
    describe('PST score table - Tap Start and Target Tap', () => {
        const pstActionId = 'pst_tap_ARKA_TD_661_inc2';
        const pstActionId2 = 'pst_tap_PRAGNY661_inc2';

        /** Helper: build actionScores for a PST type with params + tap_start */
        function makePstScores(overrides?: {
            params?: Record<string, Record<string, unknown>>;
            tap_start?: Record<string, { pst_name: string; tap: number; low_tap: number | null; high_tap: number | null } | null>;
            scores?: Record<string, number>;
        }) {
            return {
                pst_tap_change: {
                    scores: overrides?.scores ?? { [pstActionId]: -9.23, [pstActionId2]: -0.07 },
                    params: overrides?.params ?? {
                        [pstActionId]: { 'pst_tap': 'ARKA TD 661', 'selected_pst_tap': 29, 'previous tap': 27 },
                        [pstActionId2]: { 'pst_tap': 'PRAGNY661', 'selected_pst_tap': 10, 'previous tap': 8 },
                    },
                    tap_start: overrides?.tap_start ?? {
                        [pstActionId]: { pst_name: 'ARKA TD 661', tap: 29, low_tap: 8, high_tap: 31 },
                        [pstActionId2]: { pst_name: 'PRAGNY661', tap: 10, low_tap: 0, high_tap: 16 },
                    },
                },
            };
        }

        /** Helper: build a computed PST ActionDetail */
        function makePstAction(tapPosition: number, pstName = 'ARKA TD 661'): ActionDetail {
            return {
                description_unitaire: `Variation PST ${pstName}`,
                rho_before: [1.1],
                rho_after: [0.95],
                max_rho: 0.95,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                action_topology: { ...emptyTopo, pst_tap: { [pstName]: tapPosition } },
                pst_details: [{ pst_name: pstName, tap_position: tapPosition, low_tap: 8, high_tap: 31 }],
            } as ActionDetail;
        }

        it('renders "Tap Start" and "Target Tap" headers for PST type in score table', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));

            expect(await screen.findByText('Tap Start')).toBeInTheDocument();
            expect(screen.getByText('Target Tap')).toBeInTheDocument();
        });

        it('shows "previous tap" from params as Tap Start, NOT the action target tap', async () => {
            // The key test: params has "previous tap": 27, but tap_start has tap: 29 (action target).
            // Tap Start must display 27 (the N-state value from params), NOT 29.
            const props = {
                ...defaultProps,
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            // Find the table rows for PST actions
            const rows = screen.getAllByRole('row');
            // Find the row containing our PST action
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();

            // Tap Start cell should show 27 (from params "previous tap"), not 29 (from tap_start.tap)
            expect(actionRow!.textContent).toContain('27');
            // It should NOT show 29 as the Tap Start display value
            // (29 may appear in Target Tap input, but the start text should be 27)
        });

        it('shows "previous tap" from params for second PST action too', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow2 = rows.find(r => r.textContent?.includes(pstActionId2));
            expect(actionRow2).toBeDefined();
            // Should show 8 (previous tap), not 10 (selected_pst_tap / tap_start)
            expect(actionRow2!.textContent).toContain('8');
        });

        it('does NOT show N/A when params has "previous tap" even if action is not yet simulated', async () => {
            // Actions not yet computed (not in actions dict) should still show Tap Start
            // from params "previous tap" — should never be N/A when params exist
            const props = {
                ...defaultProps,
                actions: {}, // No computed actions
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            // Must show 27, NOT N/A
            expect(actionRow!.textContent).toContain('27');
            expect(actionRow!.textContent).not.toContain('N/A');
        });

        it('does NOT show N/A for second PST action when params exist but action is not simulated', async () => {
            const props = {
                ...defaultProps,
                actions: {},
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow2 = rows.find(r => r.textContent?.includes(pstActionId2));
            expect(actionRow2).toBeDefined();
            expect(actionRow2!.textContent).toContain('8');
            expect(actionRow2!.textContent).not.toContain('N/A');
        });

        it('Tap Start remains stable at "previous tap" after simulation with different target', async () => {
            // After simulation, pst_details has tap_position: 29, but Tap Start must stay 27
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29), // simulated with target tap 29
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();

            // The Tap Start cell should contain "27", not "29"
            // Get all td cells in the row
            const cells = actionRow!.querySelectorAll('td');
            // Second cell is Tap Start (first is Action name)
            // Score sits in column 2 since the manual-selection score
            // table was reorganised so the ranking is visible right
            // after the action name. Tap Start now lives in column 3.
            const tapStartCell = cells[2];
            expect(tapStartCell).toBeDefined();
            // The textContent of the Tap Start cell should start with 27
            expect(tapStartCell.textContent).toMatch(/^27/);
        });

        it('Tap Start stays at "previous tap" even after re-simulation with a new tap', async () => {
            // User re-simulated with tap 31. pst_details.tap_position is now 31.
            // But Tap Start must still show 27 from params.
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(31), // re-simulated with target tap 31
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            const cells = actionRow!.querySelectorAll('td');
            // Score sits in column 2 since the manual-selection score
            // table was reorganised so the ranking is visible right
            // after the action name. Tap Start now lives in column 3.
            const tapStartCell = cells[2];
            expect(tapStartCell.textContent).toMatch(/^27/);
        });

        it('Target Tap input defaults to "previous tap" (start tap) when action not yet simulated', async () => {
            // When no action is computed, Target Tap defaults to start tap (previous tap)
            const props = {
                ...defaultProps,
                actions: {}, // NOT computed
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            // Should default to 27 (the previous tap / start tap) since not yet simulated
            expect(targetInput.value).toBe('27');
        });

        it('shows tap range [low..high] next to Tap Start', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            // Should show range from tap_start bounds
            expect(actionRow!.textContent).toContain('[8..31]');
        });

        it('falls back to tap_start when params has no "previous tap"', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores({
                    params: {
                        [pstActionId]: { 'pst_tap': 'ARKA TD 661', 'selected_pst_tap': 29 },
                        // No 'previous tap' key
                    },
                    scores: { [pstActionId]: -9.23 },
                }),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            // Falls back to tap_start which has tap: 29
            expect(actionRow!.textContent).toContain('29');
            expect(actionRow!.textContent).not.toContain('N/A');
        });

        it('falls back to computedPst when neither params nor tap_start available', async () => {
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29),
                },
                actionScores: makePstScores({
                    params: {}, // No params
                    tap_start: {}, // No tap_start
                    scores: { [pstActionId]: -9.23 },
                }),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            // Falls back to pst_details[0].tap_position which is 29
            expect(actionRow!.textContent).toContain('29');
        });

        it('shows N/A only when no params, no tap_start, and no pst_details', async () => {
            const props = {
                ...defaultProps,
                actions: {}, // Not computed
                actionScores: makePstScores({
                    params: {},
                    tap_start: {},
                    scores: { [pstActionId]: -9.23 },
                }),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            expect(actionRow!.textContent).toContain('N/A');
        });

        it('syncs Target Tap input change to cardEditTap state', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            fireEvent.change(targetInput, { target: { value: '30' } });
            expect(targetInput.value).toBe('30');
        });

        it('reads "previous_tap" (underscore variant) from params as Tap Start', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores({
                    params: {
                        [pstActionId]: { 'pst_tap': 'ARKA TD 661', 'selected_pst_tap': 29, 'previous_tap': 27 },
                    },
                    scores: { [pstActionId]: -9.23 },
                }),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            const cells = actionRow!.querySelectorAll('td');
            // Score sits in column 2 since the manual-selection score
            // table was reorganised so the ranking is visible right
            // after the action name. Tap Start now lives in column 3.
            const tapStartCell = cells[2];
            expect(tapStartCell.textContent).toMatch(/^27/);
        });

        it('reads "previousTap" (camelCase variant) from params as Tap Start', async () => {
            const props = {
                ...defaultProps,
                actionScores: makePstScores({
                    params: {
                        [pstActionId]: { 'pst_tap': 'ARKA TD 661', 'selected_pst_tap': 29, 'previousTap': 27 },
                    },
                    scores: { [pstActionId]: -9.23 },
                }),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            expect(actionRow).toBeDefined();
            const cells = actionRow!.querySelectorAll('td');
            // Score sits in column 2 since the manual-selection score
            // table was reorganised so the ranking is visible right
            // after the action name. Tap Start now lives in column 3.
            const tapStartCell = cells[2];
            expect(tapStartCell.textContent).toMatch(/^27/);
        });

        it('Target Tap defaults to simulated tap (not start tap) when action is computed', async () => {
            // Action was simulated with tap 29. Target Tap should show 29, not 27 (start tap).
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29), // simulated with target tap 29
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            // Must be 29 (simulated tap), NOT 27 (start/previous tap)
            expect(targetInput.value).toBe('29');
        });

        it('Target Tap defaults to start tap when action is NOT yet simulated', async () => {
            // Action not yet computed — Target Tap should show 27 (the start tap)
            const props = {
                ...defaultProps,
                actions: {}, // not computed
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            expect(targetInput.value).toBe('27');
        });

        it('Target Tap updates to re-simulated tap value (31) when action re-simulated', async () => {
            // After re-simulation with tap 31, pst_details has tap_position 31
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(31), // re-simulated with tap 31
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            // Must show 31 (latest simulated tap), NOT 27 (start) or 29 (first sim)
            expect(targetInput.value).toBe('31');
        });

        it('Tap Start stays at 27 while Target Tap shows 29 for a computed action', async () => {
            // Verifies both columns are independently correct
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29),
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            // Tap Start cell should show 27
            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            const cells = actionRow!.querySelectorAll('td');
            // Score sits in column 2 since the manual-selection score
            // table was reorganised so the ranking is visible right
            // after the action name. Tap Start now lives in column 3.
            const tapStartCell = cells[2];
            expect(tapStartCell.textContent).toMatch(/^27/);

            // Target Tap input should show 29
            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            expect(targetInput.value).toBe('29');
        });

        it('user editing Target Tap in score table overrides simulated tap', async () => {
            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29),
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            expect(targetInput.value).toBe('29'); // starts at simulated
            fireEvent.change(targetInput, { target: { value: '25' } });
            expect(targetInput.value).toBe('25'); // user override
        });

        it('re-simulate button in score table calls simulateManualAction with target_tap', async () => {
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                action_id: pstActionId,
                description_unitaire: 'Variation PST ARKA TD 661',
                rho_before: [1.1],
                rho_after: [0.9],
                max_rho: 0.9,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                pst_details: [{ pst_name: 'ARKA TD 661', tap_position: 30, low_tap: 8, high_tap: 31 }],
            });

            const props = {
                ...defaultProps,
                actions: {
                    [pstActionId]: makePstAction(29),
                },
                actionScores: makePstScores(),
            };
            render(<ActionFeed {...props} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            await screen.findByText('Tap Start');

            // Change target tap to 30
            const targetInput = screen.getByTestId(`target-tap-${pstActionId}`) as HTMLInputElement;
            fireEvent.change(targetInput, { target: { value: '30' } });

            // Click the row to trigger re-simulation
            const rows = screen.getAllByRole('row');
            const actionRow = rows.find(r => r.textContent?.includes(pstActionId));
            fireEvent.click(actionRow!);

            await waitFor(() => {
                expect(api.simulateManualAction).toHaveBeenCalledWith(
                    pstActionId,
                    'LINE_1',
                    expect.anything(),
                    ['LINE_1'],
                    null,
                    30,
                );
            });
        });
    });

    // =========================================================================
    // Combined estimation refresh on re-simulation
    // =========================================================================
    describe('Combined estimation refresh on re-simulation', () => {
        beforeEach(() => {
            vi.mocked(api.simulateManualAction).mockReset();
            vi.mocked(api.computeSuperposition).mockReset();
        });

        const actionId = 'load_shedding_LOAD_X';
        const otherActionId = 'line_reco_1';
        const pairId = `${actionId}+${otherActionId}`;

        const baseCombined: CombinedAction = {
            action1_id: actionId,
            action2_id: otherActionId,
            betas: [0.5],
            p_or_combined: [100],
            max_rho: 0.85,
            max_rho_line: 'LINE_1',
            is_rho_reduction: true,
            description: 'Combined action',
            rho_after: [0.85],
            rho_before: [1.05],
            estimated_max_rho: 0.85,
            estimated_max_rho_line: 'LINE_1',
        };

        it('calls computeSuperposition for related combined pairs after MW re-simulation', async () => {
            const mockSimResult = {
                action_id: actionId,
                description_unitaire: 'Load shedding on LOAD_X',
                rho_before: [0.95],
                rho_after: [0.60],
                max_rho: 0.60,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 25.0 }],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimResult);

            const mockSuperposition: CombinedAction = {
                ...baseCombined,
                estimated_max_rho: 0.75,
                estimated_max_rho_line: 'LINE_2',
            };
            (api.computeSuperposition as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSuperposition);

            const onUpdateCombinedEstimation = vi.fn();
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                actions: {
                    [actionId]: {
                        description_unitaire: 'Load shedding on LOAD_X',
                        rho_before: [0.95],
                        rho_after: [0.70],
                        max_rho: 0.70,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                        action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                    } as ActionDetail,
                },
                combinedActions: { [pairId]: baseCombined },
                onUpdateCombinedEstimation,
            };
            render(<ActionFeed {...props} />);

            // Change MW and re-simulate
            const mwInput = screen.getByTestId(`edit-mw-${actionId}`);
            fireEvent.change(mwInput, { target: { value: '25' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(api.computeSuperposition).toHaveBeenCalledWith(
                    actionId, otherActionId, 'LINE_1'
                );
            });

            await waitFor(() => {
                expect(onUpdateCombinedEstimation).toHaveBeenCalledWith(
                    pairId,
                    { estimated_max_rho: 0.75, estimated_max_rho_line: 'LINE_2' }
                );
            });
        });

        it('calls computeSuperposition for related combined pairs after PST tap re-simulation', async () => {
            const pstActionId = 'pst_tap_ARKA_TD_661_inc2';
            const pstPairId = `${pstActionId}+${otherActionId}`;

            const mockSimResult = {
                action_id: pstActionId,
                description_unitaire: 'Variation PST ARKA TD 661',
                rho_before: [1.1],
                rho_after: [0.90],
                max_rho: 0.90,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                pst_details: [{ pst_name: 'ARKA TD 661', tap_position: 30, low_tap: 8, high_tap: 31 }],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimResult);

            const mockSuperposition: CombinedAction = {
                ...baseCombined,
                action1_id: pstActionId,
                estimated_max_rho: 0.80,
                estimated_max_rho_line: 'LINE_B',
            };
            (api.computeSuperposition as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSuperposition);

            const onUpdateCombinedEstimation = vi.fn();
            const pstCombined: CombinedAction = {
                ...baseCombined,
                action1_id: pstActionId,
            };
            const props = {
                ...defaultProps,
                selectedActionId: pstActionId,
                actions: {
                    [pstActionId]: {
                        description_unitaire: 'Variation PST ARKA TD 661',
                        rho_before: [1.1],
                        rho_after: [0.95],
                        max_rho: 0.95,
                        max_rho_line: 'LINE_A',
                        is_rho_reduction: true,
                        action_topology: { ...emptyTopo, pst_tap: { 'ARKA TD 661': 29 } },
                        pst_details: [{ pst_name: 'ARKA TD 661', tap_position: 29, low_tap: 8, high_tap: 31 }],
                    } as ActionDetail,
                },
                combinedActions: { [pstPairId]: pstCombined },
                onUpdateCombinedEstimation,
            };
            render(<ActionFeed {...props} />);

            // Change tap and re-simulate
            const tapInput = screen.getByTestId(`edit-tap-${pstActionId}`);
            fireEvent.change(tapInput, { target: { value: '30' } });
            fireEvent.click(screen.getByTestId(`resimulate-tap-${pstActionId}`));

            await waitFor(() => {
                expect(api.computeSuperposition).toHaveBeenCalledWith(
                    pstActionId, otherActionId, 'LINE_1'
                );
            });

            await waitFor(() => {
                expect(onUpdateCombinedEstimation).toHaveBeenCalledWith(
                    pstPairId,
                    { estimated_max_rho: 0.80, estimated_max_rho_line: 'LINE_B' }
                );
            });
        });

        it('does not call computeSuperposition when no combined actions exist', async () => {
            const mockSimResult = {
                action_id: actionId,
                description_unitaire: 'Load shedding on LOAD_X',
                rho_before: [0.95],
                rho_after: [0.60],
                max_rho: 0.60,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 25.0 }],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimResult);

            const onUpdateCombinedEstimation = vi.fn();
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                actions: {
                    [actionId]: {
                        description_unitaire: 'Load shedding on LOAD_X',
                        rho_before: [0.95],
                        rho_after: [0.70],
                        max_rho: 0.70,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                        action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                    } as ActionDetail,
                },
                combinedActions: null,
                onUpdateCombinedEstimation,
            };
            render(<ActionFeed {...props} />);

            // Change MW and re-simulate
            const mwInput = screen.getByTestId(`edit-mw-${actionId}`);
            fireEvent.change(mwInput, { target: { value: '25' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(api.simulateManualAction).toHaveBeenCalled();
            });

            // computeSuperposition should NOT be called
            expect(api.computeSuperposition).not.toHaveBeenCalled();
            expect(onUpdateCombinedEstimation).not.toHaveBeenCalled();
        });

        it('does not call onUpdateCombinedEstimation when computeSuperposition returns error', async () => {
            const mockSimResult = {
                action_id: actionId,
                description_unitaire: 'Load shedding on LOAD_X',
                rho_before: [0.95],
                rho_after: [0.60],
                max_rho: 0.60,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 25.0 }],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimResult);

            const errorResult: CombinedAction = {
                ...baseCombined,
                error: 'Estimation failed',
            };
            (api.computeSuperposition as ReturnType<typeof vi.fn>).mockResolvedValueOnce(errorResult);

            const onUpdateCombinedEstimation = vi.fn();
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                actions: {
                    [actionId]: {
                        description_unitaire: 'Load shedding on LOAD_X',
                        rho_before: [0.95],
                        rho_after: [0.70],
                        max_rho: 0.70,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                        action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                    } as ActionDetail,
                },
                combinedActions: { [pairId]: baseCombined },
                onUpdateCombinedEstimation,
            };
            render(<ActionFeed {...props} />);

            const mwInput = screen.getByTestId(`edit-mw-${actionId}`);
            fireEvent.change(mwInput, { target: { value: '25' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(api.computeSuperposition).toHaveBeenCalled();
            });

            // onUpdateCombinedEstimation should NOT be called because of error
            expect(onUpdateCombinedEstimation).not.toHaveBeenCalled();
        });

        it('refreshes multiple combined pairs when action appears in several combinations', async () => {
            const thirdActionId = 'line_disco_2';
            const pairId2 = `${actionId}+${thirdActionId}`;

            const mockSimResult = {
                action_id: actionId,
                description_unitaire: 'Load shedding on LOAD_X',
                rho_before: [0.95],
                rho_after: [0.60],
                max_rho: 0.60,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
                load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 25.0 }],
            };
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimResult);

            const mockSuper1: CombinedAction = { ...baseCombined, estimated_max_rho: 0.75, estimated_max_rho_line: 'LINE_2' };
            const mockSuper2: CombinedAction = { ...baseCombined, action2_id: thirdActionId, estimated_max_rho: 0.80, estimated_max_rho_line: 'LINE_3' };
            (api.computeSuperposition as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce(mockSuper1)
                .mockResolvedValueOnce(mockSuper2);

            const onUpdateCombinedEstimation = vi.fn();
            const combined2: CombinedAction = { ...baseCombined, action2_id: thirdActionId };
            const props = {
                ...defaultProps,
                selectedActionId: actionId,
                actions: {
                    [actionId]: {
                        description_unitaire: 'Load shedding on LOAD_X',
                        rho_before: [0.95],
                        rho_after: [0.70],
                        max_rho: 0.70,
                        max_rho_line: 'LINE_1',
                        is_rho_reduction: true,
                        non_convergence: null,
                        load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: 'VL_A', shedded_mw: 42.5 }],
                        action_topology: { ...emptyTopo, loads_p: { LOAD_X: 0.0 } },
                    } as ActionDetail,
                },
                combinedActions: { [pairId]: baseCombined, [pairId2]: combined2 },
                onUpdateCombinedEstimation,
            };
            render(<ActionFeed {...props} />);

            const mwInput = screen.getByTestId(`edit-mw-${actionId}`);
            fireEvent.change(mwInput, { target: { value: '25' } });
            fireEvent.click(screen.getByTestId(`resimulate-${actionId}`));

            await waitFor(() => {
                expect(api.computeSuperposition).toHaveBeenCalledTimes(2);
            });

            await waitFor(() => {
                expect(onUpdateCombinedEstimation).toHaveBeenCalledTimes(2);
                expect(onUpdateCombinedEstimation).toHaveBeenCalledWith(
                    pairId, { estimated_max_rho: 0.75, estimated_max_rho_line: 'LINE_2' }
                );
                expect(onUpdateCombinedEstimation).toHaveBeenCalledWith(
                    pairId2, { estimated_max_rho: 0.80, estimated_max_rho_line: 'LINE_3' }
                );
            });
        });
    });

    describe('auto-scroll on selectedActionId change', () => {
        // The action feed mounts a useEffect that scrolls the
        // currently-viewed card into view whenever
        // `selectedActionId` flips. This is what lets a
        // double-click on a pin in the action overview center
        // the matching card in the sidebar without the operator
        // having to scroll.

        const makeProps = (overrides: Partial<typeof defaultProps> = {}) => ({
            ...defaultProps,
            actions: {
                'act_a': {
                    description_unitaire: 'A',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.5,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    action_topology: emptyTopo,
                },
                'act_b': {
                    description_unitaire: 'B',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.6,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    action_topology: emptyTopo,
                },
                'act_c': {
                    description_unitaire: 'C',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.7,
                    max_rho_line: 'LINE_1',
                    is_rho_reduction: true,
                    action_topology: emptyTopo,
                },
            },
            ...overrides,
        });

        beforeEach(() => {
            // jsdom doesn't implement scrollIntoView; stub it
            // so the effect can call it without throwing.
            Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
        });

        it('calls scrollIntoView on the matching card when selectedActionId changes', async () => {
            const { rerender } = render(<ActionFeed {...makeProps()} />);
            // Switch to selecting act_b
            rerender(<ActionFeed {...makeProps({ selectedActionId: 'act_b' })} />);
            // Wait one rAF for the deferred scroll to fire
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const card = screen.getByTestId('action-card-act_b');
            expect(card.scrollIntoView).toHaveBeenCalledWith(
                expect.objectContaining({ block: 'center' })
            );
        });

        it('does NOT scroll when selectedActionId is null', async () => {
            const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
            render(<ActionFeed {...makeProps()} />);
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            expect(scrollSpy).not.toHaveBeenCalled();
        });

        it('re-scrolls on each selectedActionId change', async () => {
            const { rerender } = render(<ActionFeed {...makeProps({ selectedActionId: 'act_a' })} />);
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const cardA = screen.getByTestId('action-card-act_a');
            expect(cardA.scrollIntoView).toHaveBeenCalled();

            rerender(<ActionFeed {...makeProps({ selectedActionId: 'act_c' })} />);
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const cardC = screen.getByTestId('action-card-act_c');
            expect(cardC.scrollIntoView).toHaveBeenCalled();
        });

        it('scrolls to card when scrollTarget is set (pin preview)', async () => {
            const { rerender } = render(<ActionFeed {...makeProps()} />);
            rerender(<ActionFeed {...makeProps({ scrollTarget: { id: 'act_b', seq: 1 } })} />);
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const card = screen.getByTestId('action-card-act_b');
            expect(card.scrollIntoView).toHaveBeenCalledWith(
                expect.objectContaining({ block: 'center' })
            );
        });

        it('re-scrolls to the same card when scrollTarget seq increments', async () => {
            const { rerender } = render(
                <ActionFeed {...makeProps({ scrollTarget: { id: 'act_a', seq: 1 } })} />
            );
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            const card = screen.getByTestId('action-card-act_a');
            expect(card.scrollIntoView).toHaveBeenCalledTimes(1);

            rerender(
                <ActionFeed {...makeProps({ scrollTarget: { id: 'act_a', seq: 2 } })} />
            );
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            expect(card.scrollIntoView).toHaveBeenCalledTimes(2);
        });
    });

    // Regression coverage for the "Add manual action → click card" pre-fetch
    // flow. When the parent wires `onActionDiagramPrimed` + `voltageLevelsLength`,
    // ActionFeed streams the combined `/api/simulate-and-variant-diagram`
    // endpoint instead of firing `simulateManualAction` on its own: the
    // metrics event feeds `onManualActionAdded` as before, AND the diagram
    // event is pushed into the useDiagrams cache so the next click on the
    // card paints the SVG without a second XHR. See
    // docs/performance/history/combined-action-endpoint.md "Option B".
    describe('Pre-fetch diagram on Add (option B)', () => {
        const buildNdjsonResponse = (events: Array<Record<string, unknown>>) => {
            const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
            const bytes = new TextEncoder().encode(body);
            let pushed = false;
            return {
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (pushed) return { done: true, value: undefined } as const;
                            pushed = true;
                            return { done: false, value: bytes } as const;
                        },
                    }),
                },
            } as unknown as Response;
        };

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('uses the streamed endpoint, calls onManualActionAdded with metrics, and primes the diagram', async () => {
            const metricsEvent = {
                type: 'metrics',
                action_id: 'manual_act',
                description_unitaire: 'Open LINE_Z',
                rho_before: [0.95],
                rho_after: [0.80],
                max_rho: 0.80,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
            };
            const diagramEvent = {
                type: 'diagram',
                svg: '<svg>post-action</svg>',
                metadata: '{}',
                action_id: 'manual_act',
                lf_converged: true,
                lf_status: 'CONVERGED',
            };
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            (api.simulateAndVariantDiagramStream as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce(buildNdjsonResponse([metricsEvent, diagramEvent]));

            const onActionDiagramPrimed = vi.fn();
            const onManualActionAdded = vi.fn();

            render(
                <ActionFeed
                    {...defaultProps}
                    onManualActionAdded={onManualActionAdded}
                    onActionDiagramPrimed={onActionDiagramPrimed}
                    voltageLevelsLength={42}
                />
            );

            fireEvent.click(screen.getByText('+ Manual Selection'));
            const searchInput = await screen.findByPlaceholderText(/Search action/i);
            fireEvent.change(searchInput, { target: { value: 'manual_act' } });
            const manualOption = await screen.findByText(/Simulate manual ID:/);
            fireEvent.click(manualOption);

            await waitFor(() => {
                expect(api.simulateAndVariantDiagramStream).toHaveBeenCalledTimes(1);
            });
            // Legacy single-shot endpoint must NOT be called on this path.
            expect(api.simulateManualAction).not.toHaveBeenCalled();

            await waitFor(() => {
                expect(onManualActionAdded).toHaveBeenCalledTimes(1);
            });
            const [, detail, linesOvl] = (onManualActionAdded.mock.calls[0] as unknown) as [string, ActionDetail, string[]];
            expect(detail.rho_after).toEqual([0.80]);
            expect(detail.max_rho_line).toBe('LINE_1');
            expect(linesOvl).toEqual(['LINE_1']);

            // Diagram event was forwarded to the cache primer.
            await waitFor(() => {
                expect(onActionDiagramPrimed).toHaveBeenCalledTimes(1);
            });
            expect(onActionDiagramPrimed.mock.calls[0][0]).toBe('manual_act');
            expect((onActionDiagramPrimed.mock.calls[0][1] as { svg: string }).svg).toBe('<svg>post-action</svg>');
            expect(onActionDiagramPrimed.mock.calls[0][2]).toBe(42);
        });

        it('falls back to simulateManualAction when the primer prop is not wired', async () => {
            // Without `onActionDiagramPrimed`, the legacy single-shot path
            // is preserved — this is what older tests and the existing
            // backward-compatible callers rely on.
            const mockResult = {
                action_id: 'manual_act',
                description_unitaire: 'Open LINE_Z',
                rho_before: [0.95],
                rho_after: [0.80],
                max_rho: 0.80,
                max_rho_line: 'LINE_1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: ['LINE_1'],
            };
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            (api.simulateManualAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

            const onManualActionAdded = vi.fn();
            render(
                <ActionFeed
                    {...defaultProps}
                    onManualActionAdded={onManualActionAdded}
                    // intentionally no onActionDiagramPrimed
                />
            );

            fireEvent.click(screen.getByText('+ Manual Selection'));
            const searchInput = await screen.findByPlaceholderText(/Search action/i);
            fireEvent.change(searchInput, { target: { value: 'manual_act' } });
            const manualOption = await screen.findByText(/Simulate manual ID:/);
            fireEvent.click(manualOption);

            await waitFor(() => {
                expect(api.simulateManualAction).toHaveBeenCalledTimes(1);
            });
            expect(api.simulateAndVariantDiagramStream).not.toHaveBeenCalled();
        });
    });

    describe('action-type filter — overview cards (overviewFilters.actionType)', () => {
        const makeFilter = (actionType: 'all' | 'disco' | 'reco' | 'ls' | 'rc' | 'open' | 'close' | 'pst') => ({
            categories: { green: true, orange: true, red: true, grey: true },
            threshold: 1.5,
            showUnsimulated: false,
            actionType,
        });

        const actionsMix: Record<string, ActionDetail> = {
            disco_LINE_A: {
                description_unitaire: 'Ouverture de la ligne LINE_A',
                rho_before: [1.1],
                rho_after: [0.9],
                max_rho: 0.9,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} },
            },
            reco_LINE_B: {
                description_unitaire: 'Fermeture de la ligne LINE_B',
                rho_before: [1.2],
                rho_after: [0.95],
                max_rho: 0.95,
                max_rho_line: 'LINE_B',
                is_rho_reduction: true,
                action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} },
            },
        };

        it('hides cards of the other bucket in the Selected list when overviewFilters.actionType is "disco"', () => {
            render(<ActionFeed
                {...defaultProps}
                actions={actionsMix}
                selectedActionIds={new Set(['disco_LINE_A', 'reco_LINE_B'])}
                overviewFilters={makeFilter('disco')}
            />);
            expect(screen.getByTestId('action-card-disco_LINE_A')).toBeInTheDocument();
            expect(screen.queryByTestId('action-card-reco_LINE_B')).not.toBeInTheDocument();
        });

        it('shows every card when overviewFilters.actionType is "all"', () => {
            render(<ActionFeed
                {...defaultProps}
                actions={actionsMix}
                selectedActionIds={new Set(['disco_LINE_A', 'reco_LINE_B'])}
                overviewFilters={makeFilter('all')}
            />);
            expect(screen.getByTestId('action-card-disco_LINE_A')).toBeInTheDocument();
            expect(screen.getByTestId('action-card-reco_LINE_B')).toBeInTheDocument();
        });

        it('shows every card when overviewFilters is undefined', () => {
            render(<ActionFeed
                {...defaultProps}
                actions={actionsMix}
                selectedActionIds={new Set(['disco_LINE_A', 'reco_LINE_B'])}
            />);
            expect(screen.getByTestId('action-card-disco_LINE_A')).toBeInTheDocument();
            expect(screen.getByTestId('action-card-reco_LINE_B')).toBeInTheDocument();
        });
    });

    describe('action-type filter — manual-selection ring (local state, independent of overview)', () => {
        it('manual-selection ring toggle does NOT call onOverviewFiltersChange', async () => {
            const onOverviewFiltersChange = vi.fn();
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            render(<ActionFeed
                {...defaultProps}
                overviewFilters={{ categories: { green: true, orange: true, red: true, grey: true }, threshold: 1.5, showUnsimulated: false, actionType: 'all', showCombinedOnly: false }}
                onOverviewFiltersChange={onOverviewFiltersChange}
            />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            const discoChip = await screen.findByTestId('sidebar-filter-type-disco');
            fireEvent.click(discoChip);
            // Local dropdown state — does NOT bubble up to the overview filter.
            expect(onOverviewFiltersChange).not.toHaveBeenCalled();
        });

        it('marks the active action-type toggle with aria-pressed="true" after clicking LS', async () => {
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            render(<ActionFeed {...defaultProps} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            const lsChip = await screen.findByTestId('sidebar-filter-type-ls');
            fireEvent.click(lsChip);
            expect(lsChip.getAttribute('aria-pressed')).toBe('true');
            expect(screen.getByTestId('sidebar-filter-type-disco').getAttribute('aria-pressed')).toBe('false');
        });

        it('filters the Scored Actions table after clicking DISCO chip', async () => {
            const actionScores = {
                line_disconnection: { scores: { disco_LINE_A: 10 } },
                line_reconnection: { scores: { reco_LINE_B: 20 } },
            };
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            render(<ActionFeed {...defaultProps} actionScores={actionScores} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            const discoChip = await screen.findByTestId('sidebar-filter-type-disco');
            fireEvent.click(discoChip);
            expect(await screen.findByText('disco_LINE_A')).toBeInTheDocument();
            expect(screen.queryByText('reco_LINE_B')).not.toBeInTheDocument();
        });

        it('clicking a dropdown chip does not throw', async () => {
            vi.mocked(api.getAvailableActions).mockResolvedValueOnce([]);
            render(<ActionFeed {...defaultProps} />);
            fireEvent.click(screen.getByText('+ Manual Selection'));
            const discoChip = await screen.findByTestId('sidebar-filter-type-disco');
            expect(() => fireEvent.click(discoChip)).not.toThrow();
        });
    });

    describe('AdditionalLinesPicker placement', () => {
        // Product rule: the picker sits directly above the
        // "Analyze & Suggest" button so the operator can configure
        // extra cuts where the analysis is launched.  It must
        // disappear the moment analysis is in flight or results are
        // pending — same gate as the button itself.
        const pickerProps = {
            branches: ['LINE_A', 'LINE_B', 'LINE_C'],
            additionalLinesToCut: new Set<string>(),
            onToggleAdditionalLineToCut: vi.fn(),
            n1Overloads: ['LINE_C'],
        };

        it('renders the picker alongside Analyze & Suggest in the empty state', () => {
            render(<ActionFeed {...defaultProps} {...pickerProps} canRunAnalysis />);
            expect(screen.getByTestId('additional-lines-picker')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Analyze & Suggest/ })).toBeInTheDocument();
        });

        it('hides the picker while analysis is running', () => {
            render(<ActionFeed {...defaultProps} {...pickerProps} analysisLoading />);
            expect(screen.queryByTestId('additional-lines-picker')).not.toBeInTheDocument();
            expect(screen.getByText(/Analyzing/)).toBeInTheDocument();
        });

        it('hides the picker when a pending result is awaiting display', () => {
            const pending: AnalysisResult = {
                actions: {}, action_scores: {}, lines_overloaded: ['LINE_C'],
                pdf_url: null, pdf_path: null, message: '', dc_fallback: false,
            } as unknown as AnalysisResult;
            render(
                <ActionFeed
                    {...defaultProps}
                    {...pickerProps}
                    pendingAnalysisResult={pending}
                />,
            );
            expect(screen.queryByTestId('additional-lines-picker')).not.toBeInTheDocument();
            expect(screen.getByText(/Display .* prioritized actions/)).toBeInTheDocument();
        });

        it('hides the picker when the picker props are not wired', () => {
            // Backwards-compat: ActionFeed must render correctly when
            // the parent forgets to pass branches / extras (e.g. an
            // unrelated test that doesn't care about the picker).
            render(<ActionFeed {...defaultProps} canRunAnalysis />);
            expect(screen.queryByTestId('additional-lines-picker')).not.toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Analyze & Suggest/ })).toBeInTheDocument();
        });
    });

    describe('action-type overview filter', () => {
        const DEFAULT_FILTERS = {
            categories: { green: true, orange: true, red: true, grey: true },
            threshold: 1.5,
            showUnsimulated: false,
            actionType: 'all' as const,
            showCombinedOnly: false,
        };
        // A reco action whose id starts with `reco_` but whose
        // description carries no `fermeture` marker — exactly the
        // shape that used to vanish under the RECO filter because
        // `classifyActionType` never inspects the id for disco / reco.
        const recoDetail: ActionDetail = {
            description_unitaire: 'Reconnect GEN.PY762',
            rho_before: [1.05],
            rho_after: [0.93],
            max_rho: 0.93,
            max_rho_line: 'LINE_1',
            is_rho_reduction: true,
            action_topology: emptyTopo,
        };

        it('keeps reco cards visible under the RECO filter using the recommender score type', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ 'reco_GEN.PY762': recoDetail }}
                    actionScores={{ line_reconnection: { scores: { 'reco_GEN.PY762': 0.04 } } }}
                    overviewFilters={{ ...DEFAULT_FILTERS, actionType: 'reco' }}
                    onOverviewFiltersChange={vi.fn()}
                />,
            );
            expect(screen.getByTestId('action-card-reco_GEN.PY762')).toBeInTheDocument();
            expect(screen.queryByTestId('overview-filter-hint')).not.toBeInTheDocument();
        });

        it('hides reco cards when a non-matching type filter (DISCO) is active', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ 'reco_GEN.PY762': recoDetail }}
                    actionScores={{ line_reconnection: { scores: { 'reco_GEN.PY762': 0.04 } } }}
                    overviewFilters={{ ...DEFAULT_FILTERS, actionType: 'disco' }}
                    onOverviewFiltersChange={vi.fn()}
                />,
            );
            expect(screen.queryByTestId('action-card-reco_GEN.PY762')).not.toBeInTheDocument();
            expect(screen.getByTestId('overview-filter-hint')).toBeInTheDocument();
        });

        it('suppresses the Analyze & Suggest button and shows the no-match notice when the filter hides every action', () => {
            // Product rule (PR — fix-empty-filter-message): when the
            // overview filter hides every otherwise-eligible action,
            // the Analyze & Suggest button must NOT reappear — only
            // clearing the filter (or pressing Clear) should bring it
            // back. The notice tells the operator why their feed
            // is empty.
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ 'reco_GEN.PY762': recoDetail }}
                    actionScores={{ line_reconnection: { scores: { 'reco_GEN.PY762': 0.04 } } }}
                    overviewFilters={{ ...DEFAULT_FILTERS, actionType: 'disco' }}
                    onOverviewFiltersChange={vi.fn()}
                    canRunAnalysis
                />,
            );
            expect(screen.queryByRole('button', { name: /Analyze & Suggest/ })).not.toBeInTheDocument();
            expect(screen.getByTestId('no-actions-match-filter')).toBeInTheDocument();
            expect(screen.getByText(/No actions match the active filter/)).toBeInTheDocument();
        });

        it('reshows the Analyze & Suggest button once the filter is cleared', () => {
            // Same fixture as above but with `actionType: 'all'` —
            // the action matches the filter, so the feed renders the
            // card AND the Analyze & Suggest slot stays hidden because
            // prioritizedEntries is non-empty. Clearing the type
            // filter alone is enough to restore the slot when no card
            // is left visible (verified by removing the action below).
            const { rerender } = render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ 'reco_GEN.PY762': recoDetail }}
                    actionScores={{ line_reconnection: { scores: { 'reco_GEN.PY762': 0.04 } } }}
                    overviewFilters={{ ...DEFAULT_FILTERS, actionType: 'disco' }}
                    onOverviewFiltersChange={vi.fn()}
                    canRunAnalysis
                />,
            );
            expect(screen.queryByRole('button', { name: /Analyze & Suggest/ })).not.toBeInTheDocument();
            rerender(
                <ActionFeed
                    {...defaultProps}
                    actions={{}}
                    actionScores={{}}
                    overviewFilters={{ ...DEFAULT_FILTERS, actionType: 'all' }}
                    onOverviewFiltersChange={vi.fn()}
                    canRunAnalysis
                />,
            );
            expect(screen.getByRole('button', { name: /Analyze & Suggest/ })).toBeInTheDocument();
            expect(screen.queryByTestId('no-actions-match-filter')).not.toBeInTheDocument();
        });
    });

    describe('recommendation-model selector + Clear', () => {
        // The model dropdown lives above "Analyze & Suggest" (a mirror of
        // the Settings → Recommender selector) so the operator can swap
        // model and re-run without opening Settings. After a run, the
        // model that produced the suggestions is reminded below the
        // Suggested Actions tab header alongside a danger-coloured Clear
        // button.
        const modelProps = {
            recommenderModel: 'expert',
            setRecommenderModel: vi.fn(),
            availableModels: [
                { name: 'expert', label: 'Expert system', requires_overflow_graph: true, is_default: true, params: [] },
                { name: 'random_overflow', label: 'Random (post overflow analysis)', requires_overflow_graph: true, is_default: false, params: [] },
            ],
        };

        const recAction = {
            description_unitaire: 'Disco LINE_X',
            action_topology: emptyTopo,
            is_manual: false,
            max_rho: 0.8,
        } as unknown as ActionDetail;

        beforeEach(() => {
            interactionLogger.clear();
        });

        it('renders the recommendation-model dropdown above Analyze & Suggest', () => {
            render(<ActionFeed {...defaultProps} {...modelProps} canRunAnalysis />);
            const select = screen.getByLabelText('Model:') as HTMLSelectElement;
            expect(select).toBeInTheDocument();
            expect(select.value).toBe('expert');
            expect(screen.getByRole('option', { name: 'Random (post overflow analysis)' })).toBeInTheDocument();
        });

        it('changing the model fires setRecommenderModel and logs recommender_model_changed', () => {
            const setRecommenderModel = vi.fn();
            render(
                <ActionFeed {...defaultProps} {...modelProps} setRecommenderModel={setRecommenderModel} canRunAnalysis />,
            );
            fireEvent.change(screen.getByLabelText('Model:'), { target: { value: 'random_overflow' } });
            expect(setRecommenderModel).toHaveBeenCalledWith('random_overflow');
            const evt = interactionLogger.getLog().find(e => e.type === 'recommender_model_changed');
            expect(evt).toBeTruthy();
            expect(evt!.details).toEqual({ model: 'random_overflow', source: 'action_feed' });
        });

        it('omits the model dropdown when setRecommenderModel is not wired', () => {
            // Backwards-compat: ActionFeed must render without the model
            // selector when the parent doesn't pass the recommender props.
            render(<ActionFeed {...defaultProps} canRunAnalysis />);
            expect(screen.queryByLabelText('Model:')).not.toBeInTheDocument();
        });

        it('shows the "Suggestions produced by <model>" reminder with the active model label', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rec_1: recAction }}
                    activeModelLabel="Expert system"
                    onClearSuggested={vi.fn()}
                />,
            );
            expect(screen.getByTestId('active-model-reminder')).toHaveTextContent(
                'Suggestions produced by Expert system',
            );
        });

        it('hides the active-model reminder when there are no suggested entries', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{}}
                    activeModelLabel="Expert system"
                    onClearSuggested={vi.fn()}
                />,
            );
            expect(screen.queryByTestId('active-model-reminder')).not.toBeInTheDocument();
        });

        it('shows the wall-clock total next to the active-model label with a full breakdown tooltip', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rec_1: recAction }}
                    activeModelLabel="Expert system"
                    step1Time={1.0}
                    overflowGraphTime={2.5}
                    actionPredictionTime={1.25}
                    assessmentTime={0.4}
                    enrichmentTime={0.1}
                    wallClockTime={5.5}
                />,
            );
            const total = screen.getByTestId('execution-time-total');
            // Wall-clock wins over the backend-sum (5.25s).
            expect(total).toHaveTextContent(/5\.50s/);
            const tooltip = total.getAttribute('title') ?? '';
            expect(tooltip).toMatch(/Step 1.*1\.00s/);
            expect(tooltip).toMatch(/Overflow analysis:\s*2\.50s/);
            expect(tooltip).toMatch(/Action prediction:\s*1\.25s/);
            expect(tooltip).toMatch(/Action assessment:\s*0\.40s/);
            expect(tooltip).toMatch(/Enrichment.*0\.10s/);
            // Residual = wall-clock - backend sum = 5.50 - 5.25 = 0.25s.
            expect(tooltip).toMatch(/Other.*0\.25s/);
            expect(tooltip).toMatch(/Total \(wall-clock.*5\.50s/);
        });

        it('falls back to the backend-sum total when wall-clock is not reported', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rec_1: recAction }}
                    activeModelLabel="Random"
                    overflowGraphTime={null}
                    actionPredictionTime={0.8}
                    assessmentTime={0.2}
                />,
            );
            const total = screen.getByTestId('execution-time-total');
            // backend-sum = 0.8 + 0.2 = 1.00s
            expect(total).toHaveTextContent(/1\.00s/);
            const tooltip = total.getAttribute('title') ?? '';
            expect(tooltip).toMatch(/Action prediction/);
            expect(tooltip).toMatch(/Action assessment/);
            expect(tooltip).not.toMatch(/Overflow analysis/);
        });

        it('hides the execution-time total when no timings are reported', () => {
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rec_1: recAction }}
                    activeModelLabel="Expert system"
                />,
            );
            expect(screen.queryByTestId('execution-time-total')).not.toBeInTheDocument();
        });

        it('Clear button calls onClearSuggested', () => {
            const onClearSuggested = vi.fn();
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rec_1: recAction }}
                    activeModelLabel="Expert system"
                    onClearSuggested={onClearSuggested}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
            expect(onClearSuggested).toHaveBeenCalledTimes(1);
        });

        it('hides the Analyze & Suggest slot while suggested entries are displayed', () => {
            render(<ActionFeed {...defaultProps} actions={{ rec_1: recAction }} canRunAnalysis />);
            expect(screen.queryByRole('button', { name: /Analyze & Suggest/ })).not.toBeInTheDocument();
        });

        it('reshows the Analyze & Suggest slot when only rejected actions remain (post-Clear)', () => {
            // After Clear, the operator's kept rejected action stays in
            // result.actions with is_manual=false. The analysis-trigger
            // slot must still reappear because the Suggested feed
            // (prioritizedEntries) is empty — gating on prioritizedEntries
            // rather than "any non-manual action" is what fixes this.
            render(
                <ActionFeed
                    {...defaultProps}
                    actions={{ rej_1: recAction }}
                    rejectedActionIds={new Set(['rej_1'])}
                    canRunAnalysis
                />,
            );
            expect(screen.getByRole('button', { name: /Analyze & Suggest/ })).toBeInTheDocument();
        });
    });
});
