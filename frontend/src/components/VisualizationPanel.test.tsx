// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import VisualizationPanel from './VisualizationPanel';
import type { DiagramData, AnalysisResult, TabId, ActionOverviewFilters } from '../types';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../utils/actionTypes';

const createDefaultProps = (overrides: Record<string, unknown> = {}) => ({
    activeTab: 'n' as TabId,
    configLoading: false,
    onTabChange: vi.fn(),
    nDiagram: null as DiagramData | null,
    n1Diagram: null as DiagramData | null,
    n1Loading: false,
    actionDiagram: null as DiagramData | null,
    actionDiagramLoading: false,
    selectedActionId: null as string | null,
    result: null as AnalysisResult | null,
    analysisLoading: false,
    nSvgContainerRef: createRef<HTMLDivElement>(),
    n1SvgContainerRef: createRef<HTMLDivElement>(),
    actionSvgContainerRef: createRef<HTMLDivElement>(),
    uniqueVoltages: [] as number[],
    voltageRange: [0, 1000] as [number, number],
    onVoltageRangeChange: vi.fn(),
    actionViewMode: 'network' as 'network' | 'delta',
    onViewModeChange: vi.fn(),
    inspectQuery: '',
    onInspectQueryChange: vi.fn(),
    inspectableItems: [] as string[],
    onResetView: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    hasBranches: false,
    selectedContingency: [],
    vlOverlay: null,
    onOverlayClose: vi.fn(),
    onOverlaySldTabChange: vi.fn(),
    voltageLevels: [] as string[],
    onVlOpen: vi.fn(),
    networkPath: '',
    layoutPath: '',
    onOpenSettings: vi.fn(),
    ...overrides,
});

describe('VisualizationPanel', () => {
    it('renders the Network (N) tab', () => {
        render(<VisualizationPanel {...createDefaultProps()} />);
        expect(screen.getByText('Network (N)')).toBeInTheDocument();
    });

    it('always renders the Contingency tab (even without branch selected)', () => {
        render(<VisualizationPanel {...createDefaultProps()} />);
        // No applied contingency yet → bare ``Contingency`` label
        // (the ``(N-K)`` suffix is appended once the user triggers).
        expect(screen.getByText('Contingency')).toBeInTheDocument();
    });

    it('renders Contingency tab as N-1 when a single branch is applied', () => {
        render(<VisualizationPanel {...createDefaultProps({ selectedContingency: ['LINE_A'] })} />);
        expect(screen.getByText('Contingency (N-1)')).toBeInTheDocument();
    });

    it('renders action tab with action ID when action is selected', () => {
        render(<VisualizationPanel {...createDefaultProps({ selectedActionId: 'action_1' })} />);
        // The label is now JSX: "Remedial Action: " + a clickable
        // chip containing the action id. Assert on the chip
        // presence + content rather than the plain-text match.
        const chip = screen.getByTestId('action-tab-deselect-chip');
        expect(chip).toBeInTheDocument();
        expect(chip.textContent).toContain('action_1');
    });

    it('renders action tab with default label when no action selected', () => {
        render(<VisualizationPanel {...createDefaultProps()} />);
        expect(screen.getByText('Remedial action: overview')).toBeInTheDocument();
    });

    it('always renders overflow tab (even without pdf_url)', () => {
        render(<VisualizationPanel {...createDefaultProps()} />);
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
    });

    it('overflow tab is always visible regardless of pdf_url', () => {
        const result: AnalysisResult = {
            pdf_path: '/tmp/graph.pdf',
            pdf_url: '/results/pdf/graph.pdf',
            actions: {},
            lines_overloaded: [],
            message: 'Done',
            dc_fallback: false,
        };
        render(<VisualizationPanel {...createDefaultProps({ result })} />);
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
    });

    it('calls onTabChange when N-1 tab is clicked', async () => {
        const user = userEvent.setup();
        const onTabChange = vi.fn();
        render(<VisualizationPanel {...createDefaultProps({ selectedContingency: ['LINE_A'], onTabChange })} />);

        await user.click(screen.getByText('Contingency (N-1)'));
        expect(onTabChange).toHaveBeenCalledWith('contingency');
    });

    it('shows placeholder when no diagram loaded', () => {
        render(<VisualizationPanel {...createDefaultProps()} />);
        expect(screen.getByText('Load configuration to see diagram')).toBeInTheDocument();
    });

    it('shows N-1 loading message', () => {
        render(<VisualizationPanel {...createDefaultProps({
            activeTab: 'contingency',
            selectedContingency: ['LINE_A'],
            n1Loading: true,
        })} />);
        expect(screen.getByText('Generating N-1 Diagram...')).toBeInTheDocument();
    });

    it('shows action loading message', () => {
        render(<VisualizationPanel {...createDefaultProps({
            activeTab: 'action',
            selectedActionId: 'act_1',
            actionDiagramLoading: true,
        })} />);
        expect(screen.getByText('Generating Action Variant Diagram...')).toBeInTheDocument();
    });

    it('renders zoom controls inside a tab when that tab has a diagram', () => {
        // Zoom controls now live inside each tab container and are
        // only shown when the tab has a diagram to zoom, so the test
        // must provide a diagram for the active tab.
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        render(<VisualizationPanel {...createDefaultProps({ nDiagram })} />);
        expect(screen.getAllByTitle('Zoom In').length).toBeGreaterThan(0);
        expect(screen.getAllByTitle('Zoom Out').length).toBeGreaterThan(0);
    });

    it('calls zoom handlers (with target tab argument) when the per-tab buttons are clicked', async () => {
        const user = userEvent.setup();
        const onZoomIn = vi.fn();
        const onZoomOut = vi.fn();
        const onResetView = vi.fn();
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        render(<VisualizationPanel {...createDefaultProps({
            nDiagram, onZoomIn, onZoomOut, onResetView,
        })} />);

        // Use getAllByTitle because each tab renders its own copy —
        // even though only the active-tab copy is visible, all four
        // are in the DOM for performance reasons. The N tab is the
        // active one in this test.
        await user.click(screen.getAllByTitle('Zoom In')[0]);
        // Per-tab click now passes the tabId as the first argument.
        expect(onZoomIn).toHaveBeenCalledWith('n');

        await user.click(screen.getAllByTitle('Zoom Out')[0]);
        expect(onZoomOut).toHaveBeenCalledWith('n');
    });

    it('shows view mode toggle when diagram is loaded', () => {
        const nDiagram: DiagramData = {
            svg: '<svg>test</svg>',
            metadata: null,
        };
        render(<VisualizationPanel {...createDefaultProps({ nDiagram })} />);
        expect(screen.getByText('Flows')).toBeInTheDocument();
        expect(screen.getByText('Impacts')).toBeInTheDocument();
    });

    it('calls onViewModeChange when toggle clicked', async () => {
        const user = userEvent.setup();
        const onViewModeChange = vi.fn();
        const nDiagram: DiagramData = {
            svg: '<svg>test</svg>',
            metadata: null,
        };
        render(<VisualizationPanel {...createDefaultProps({ nDiagram, onViewModeChange })} />);

        await user.click(screen.getByText('Impacts'));
        expect(onViewModeChange).toHaveBeenCalledWith('delta');
    });

    // Regression tests for the Tie button location (third
    // iteration). The Tie button used to be grouped in the
    // top-right cluster next to the Flow/Impacts toggle, which
    // was misleading because Tie only synchronises pan/zoom and
    // asset focus — the Flow/Impacts mode is deliberately NOT
    // tied between main and detached windows. The button now
    // lives in the bottom-left cluster, directly above the
    // zoom/inspect controls it actually mirrors.
    describe('Tie button placement and visibility', () => {
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };

        // Helper: make a detached-tabs map whose mount node is
        // attached to `document.body` so testing-library's `within`
        // queries can reach it. Returns the mount node so tests can
        // scope their assertions to the "popup" content.
        const makeDetached = (tabId: 'n' | 'contingency' | 'action') => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            return {
                mountNode,
                detachedTabs: { [tabId]: { window: {} as Window, mountNode } },
            };
        };

        it('does not render the Tie button when the tab is not detached', () => {
            // No detachedTabs → no popup → no Tie button visible.
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                hasBranches: true,
                isTabTied: () => false,
                onToggleTabTie: vi.fn(),
            })} />);
            // The Tie button carries a title starting with "Tie"
            // — easy to query without confusion with similar words.
            const tieButtons = document.body.querySelectorAll('button[title^="Tie"]');
            expect(tieButtons).toHaveLength(0);
        });

        it('renders the Tie button in the bottom-left cluster when the tab is detached', () => {
            const { mountNode } = makeDetached('n');
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                hasBranches: true,
                detachedTabs: { n: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie: vi.fn(),
            })} />);

            // The Tie button lives inside the imperatively-moved
            // orphan div, which is now a descendant of the fake
            // popup's mountNode — NOT inside testing-library's
            // container. Query the mountNode directly.
            const tieButton = mountNode.querySelector('button[title^="Tie"]');
            expect(tieButton).not.toBeNull();
            document.body.removeChild(mountNode);
        });

        it('places the Tie button in the same cluster as the Zoom buttons, NOT in the top-right Flows/Impacts cluster', () => {
            const { mountNode } = makeDetached('n');
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                hasBranches: true,
                detachedTabs: { n: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie: vi.fn(),
            })} />);

            const tieButton = mountNode.querySelector('button[title^="Tie"]') as HTMLElement | null;
            const zoomInButton = mountNode.querySelector('button[title="Zoom In"]') as HTMLElement | null;
            const flowsButton = Array.from(
                mountNode.querySelectorAll('button')
            ).find(b => b.textContent === 'Flows') as HTMLElement | undefined;

            expect(tieButton).not.toBeNull();
            expect(zoomInButton).not.toBeNull();
            expect(flowsButton).toBeDefined();

            // Walk up from zoomIn collecting ancestors; the Tie
            // button must live in that same ancestor chain.
            const zoomAncestors = new Set<HTMLElement>();
            let cursor: HTMLElement | null = zoomInButton;
            while (cursor) {
                zoomAncestors.add(cursor);
                cursor = cursor.parentElement;
            }
            let tieCursor: HTMLElement | null = tieButton;
            let sharedWithZoom = false;
            while (tieCursor) {
                if (zoomAncestors.has(tieCursor)) { sharedWithZoom = true; break; }
                tieCursor = tieCursor.parentElement;
            }
            expect(sharedWithZoom).toBe(true);

            // And the Flow/Impacts top-right cluster must NOT
            // contain the Tie button. Walk up from Flows to the
            // absolutely-positioned cluster div and check.
            let flowsCluster: HTMLElement | null = flowsButton!.parentElement;
            while (flowsCluster && flowsCluster.style.position !== 'absolute') {
                flowsCluster = flowsCluster.parentElement;
            }
            expect(flowsCluster).not.toBeNull();
            expect(flowsCluster!.contains(tieButton)).toBe(false);

            document.body.removeChild(mountNode);
        });

        it('calls onToggleTabTie with the tab id when clicked', async () => {
            const user = userEvent.setup();
            const { mountNode } = makeDetached('n');
            const onToggleTabTie = vi.fn();
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                hasBranches: true,
                detachedTabs: { n: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie,
            })} />);

            const tieButton = mountNode.querySelector('button[title^="Tie"]') as HTMLElement;
            await user.click(tieButton);
            expect(onToggleTabTie).toHaveBeenCalledWith('n');
            document.body.removeChild(mountNode);
        });

        it('renders the "Untie" (Tied) variant when the tab is already tied', () => {
            const { mountNode } = makeDetached('n');
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                hasBranches: true,
                detachedTabs: { n: { window: {} as Window, mountNode } },
                isTabTied: (t: TabId) => t === 'n',
                onToggleTabTie: vi.fn(),
            })} />);
            // When tied the button's title starts with "Untie".
            const untieButton = mountNode.querySelector('button[title^="Untie"]');
            expect(untieButton).not.toBeNull();
            document.body.removeChild(mountNode);
        });
    });

    // Regression tests for the Flow/Impacts mode being PER-TAB in a
    // detached popup. Before the fix, the mode was a global state
    // shared between main and popup: flipping Impacts in one
    // window automatically flipped it in the other, and Impacts
    // never rendered in the popup because the highlights effect
    // only reran for the main activeTab.
    describe('per-tab Flow/Impacts view mode (detached window)', () => {
        it('reads the per-tab view mode from viewModeForTab so each tab shows its own mode', () => {
            // Simulate a world where the 'n' tab is in delta (popup)
            // while 'contingency' is still in network (main). The per-tab
            // getter returns 'delta' for 'n' and 'network' for 'contingency'.
            const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
            const n1Diagram: DiagramData = { svg: '<svg>n1</svg>', metadata: null };
            const viewModeForTab = vi.fn((tab: TabId) => tab === 'n' ? 'delta' : 'network');

            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                n1Diagram,
                viewModeForTab,
            })} />);

            // viewModeForTab must have been invoked for each tab
            // that has a diagram (n and n-1) when their overlays
            // rendered.
            const calledTabs = viewModeForTab.mock.calls.map(c => c[0]);
            expect(calledTabs).toContain('n');
            expect(calledTabs).toContain('contingency');
        });

        it('routes the Impacts click through onViewModeChangeForTab with the tab id', async () => {
            const user = userEvent.setup();
            const onViewModeChangeForTab = vi.fn();
            const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                nDiagram,
                onViewModeChangeForTab,
                // When the per-tab getter exists, the overlay reads
                // from it rather than the global actionViewMode.
                viewModeForTab: () => 'network' as const,
            })} />);

            // All three tabs render an overlay (n / n-1 / action);
            // only the active one (n) is actually visible, but all
            // three buttons are in the DOM.
            const impactsButtons = screen.getAllByText('Impacts');
            // Click the first one (the active N tab's overlay).
            await user.click(impactsButtons[0]);
            // The call must include the tab id, proving that the
            // router can dispatch to the right per-window state.
            expect(onViewModeChangeForTab).toHaveBeenCalled();
            const [firstCall] = onViewModeChangeForTab.mock.calls;
            expect(firstCall[0]).toBe('n');
            expect(firstCall[1]).toBe('delta');
        });
    });

    it('shows convergence warning for N-1 when AC did not converge', () => {
        const n1Diagram: DiagramData = {
            svg: '<svg>n1</svg>',
            metadata: null,
            lf_converged: false,
            lf_status: 'MAX_ITERATION_REACHED',
        };
        render(<VisualizationPanel {...createDefaultProps({
            activeTab: 'contingency',
            selectedContingency: ['LINE_A'],
            n1Diagram,
        })} />);
        expect(screen.getByText(/MAX_ITERATION_REACHED/)).toBeInTheDocument();
    });

    it('renders inspect input when branches exist and the active tab has a diagram', () => {
        // Inspect now lives inside each tab overlay and only appears
        // when the tab has a diagram AND there are branches.
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        render(<VisualizationPanel {...createDefaultProps({ hasBranches: true, nDiagram })} />);
        expect(screen.getAllByPlaceholderText(/Inspect/).length).toBeGreaterThan(0);
    });

    it('does not render inspect input when there are no branches', () => {
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        render(<VisualizationPanel {...createDefaultProps({ hasBranches: false, nDiagram })} />);
        expect(screen.queryByPlaceholderText(/Inspect/)).not.toBeInTheDocument();
    });

    it('inspect field does not rely on a native <datalist>', () => {
        // Regression guard for the "tied detached window hides the
        // main-window suggestions dropdown" bug: the inspect field
        // used to pair <input list=...> with a <datalist> sibling,
        // but that combo is unreliable when the overlay subtree is
        // physically relocated to a popup window via
        // DetachableTabHost. We now render a custom suggestions
        // dropdown, so there must be no <datalist> anywhere in the
        // tab overlays.
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        const { container } = render(<VisualizationPanel {...createDefaultProps({
            hasBranches: true,
            nDiagram,
            inspectableItems: ['LINE_A', 'LINE_B'],
        })} />);
        expect(container.querySelectorAll('datalist').length).toBe(0);
        const inputs = screen.getAllByPlaceholderText(/Inspect/);
        inputs.forEach(input => {
            expect(input.getAttribute('list')).toBeNull();
        });
    });

    it('inspect field shows a custom suggestions dropdown when typing matches items', async () => {
        const user = userEvent.setup();
        const onInspectQueryChange = vi.fn();
        const nDiagram: DiagramData = { svg: '<svg>n</svg>', metadata: null };
        // Use an inspectQuery value that matches some items — the
        // custom dropdown shows once the field is focused and the
        // query has at least one non-exact filtered match.
        render(<VisualizationPanel {...createDefaultProps({
            hasBranches: true,
            nDiagram,
            inspectableItems: ['LINE_A', 'LINE_B', 'BUS_C'],
            inspectQuery: 'LIN',
            onInspectQueryChange,
        })} />);
        // Focus the visible inspect input (the active-tab overlay's).
        const inputs = screen.getAllByPlaceholderText(/Inspect/);
        // Focus every overlay input so the test is tolerant to which
        // of the (always-mounted) tab overlays the test environment
        // exposes first.
        for (const input of inputs) {
            await user.click(input);
        }
        // Both LINE_A and LINE_B are valid custom-dropdown rows.
        expect(screen.getAllByText('LINE_A').length).toBeGreaterThan(0);
        expect(screen.getAllByText('LINE_B').length).toBeGreaterThan(0);
    });

    it('shows analysis loading text in overflow tab with yellow theme', () => {
        render(<VisualizationPanel {...createDefaultProps({
            activeTab: 'overflow',
            analysisLoading: true,
        })} />);
        expect(screen.getByText('Processing Analysis...')).toBeInTheDocument();
        const placeholder = screen.getByText('Processing Analysis...').parentElement;
        if (placeholder) {
            // jsdom doesn't expand the `background:` shorthand into
            // `backgroundColor` longhand for var(--…) values, so read
            // the shorthand directly.
            expect(placeholder.style.background).toContain('var(--color-warning-soft)');
            expect(placeholder.style.color).toContain('var(--color-warning-text)');
        }
    });

    it('keeps overflow tab visible when result has pdf_url and activeTab is overflow', () => {
        const result: AnalysisResult = {
            pdf_path: '/tmp/graph.pdf',
            pdf_url: '/results/pdf/graph.pdf',
            actions: { act_1: { description_unitaire: 'Test', rho_before: [1.0], rho_after: [0.8], max_rho: 0.8, max_rho_line: 'L1', is_rho_reduction: true } },
            lines_overloaded: ['L1'],
            message: 'Done',
            dc_fallback: false,
        };
        render(<VisualizationPanel {...createDefaultProps({ result, activeTab: 'overflow' })} />);

        // Overflow tab button should be visible
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
        // iframe should render the PDF
        const iframe = document.querySelector('iframe[title="Overflow Graph"]');
        expect(iframe).toBeInTheDocument();
        expect(iframe?.getAttribute('src')).toContain('/results/pdf/graph.pdf');
    });

    it('shows placeholder message in overflow tab when result has no pdf_url', () => {
        const result: AnalysisResult = {
            pdf_path: null,
            pdf_url: null,
            actions: { act_1: { description_unitaire: 'Test', rho_before: [1.0], rho_after: [0.8], max_rho: 0.8, max_rho_line: 'L1', is_rho_reduction: true } },
            lines_overloaded: ['L1'],
            message: 'Done',
            dc_fallback: false,
        };
        render(<VisualizationPanel {...createDefaultProps({ result, activeTab: 'overflow' })} />);
        // Tab is always visible
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
        // But no iframe
        expect(document.querySelector('iframe[title="Overflow Graph"]')).not.toBeInTheDocument();
    });

    it('overflow tab remains when result is updated but pdf_url is preserved', () => {
        const result1: AnalysisResult = {
            pdf_path: '/tmp/graph.pdf',
            pdf_url: '/results/pdf/graph.pdf',
            actions: {},
            lines_overloaded: [],
            message: 'Done',
            dc_fallback: false,
        };
        const { rerender } = render(<VisualizationPanel {...createDefaultProps({ result: result1, activeTab: 'overflow' })} />);
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();

        // Simulate what happens after handleDisplayPrioritizedActions with the fix:
        // result is updated with new actions but pdf_url is preserved via ...prev spread
        const result2: AnalysisResult = {
            ...result1,
            actions: { act_1: { description_unitaire: 'New', rho_before: [1.0], rho_after: [0.8], max_rho: 0.8, max_rho_line: 'L1', is_rho_reduction: true } },
        };
        rerender(<VisualizationPanel {...createDefaultProps({ result: result2, activeTab: 'overflow' })} />);

        // Overflow tab should still be visible
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
        const iframe = document.querySelector('iframe[title="Overflow Graph"]');
        expect(iframe).toBeInTheDocument();
    });

    it('overflow tab stays visible when result loses pdf_url; iframe disappears', () => {
        const result1: AnalysisResult = {
            pdf_path: '/tmp/graph.pdf',
            pdf_url: '/results/pdf/graph.pdf',
            actions: {},
            lines_overloaded: [],
            message: 'Done',
            dc_fallback: false,
        };
        const { rerender } = render(<VisualizationPanel {...createDefaultProps({ result: result1, activeTab: 'overflow' })} />);
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
        expect(document.querySelector('iframe[title="Overflow Graph"]')).toBeInTheDocument();

        // Simulate loss of pdf_url
        const resultNoPdf: AnalysisResult = {
            pdf_path: null,
            pdf_url: null,
            actions: { act_1: { description_unitaire: 'New', rho_before: [1.0], rho_after: [0.8], max_rho: 0.8, max_rho_line: 'L1', is_rho_reduction: true } },
            lines_overloaded: [],
            message: 'Done',
            dc_fallback: false,
        };
        rerender(<VisualizationPanel {...createDefaultProps({ result: resultNoPdf, activeTab: 'overflow' })} />);

        // Tab is always visible, but iframe is gone
        expect(screen.getByText('Overflow Analysis')).toBeInTheDocument();
        expect(document.querySelector('iframe[title="Overflow Graph"]')).not.toBeInTheDocument();
    });

    describe('SLD Overlay Delta Class Cleanup', () => {
        it('clears sld-delta-text-* classes from the rendered SVG', () => {
            const svgContent = '<svg><text id="test-text" class="sld-delta-text-positive some-other-class">100</text></svg>';
            const vlOverlay = {
                vlName: 'test-node',
                actionId: null,
                svg: svgContent,
                sldMetadata: null, // Bypasses applyDeltaVisuals, leaving only the cleanup effect
                loading: false,
                error: null,
                tab: 'n' as TabId,
            };

            const props = createDefaultProps({
                vlOverlay,
                actionViewMode: 'network', // Doesn't matter which mode, cleanup runs first always
                activeTab: 'n',
                n1Diagram: null,
                actionDiagram: null,
            });

            const { container } = render(<VisualizationPanel {...props} />);
            
            const textEl = container.querySelector('#test-text');
            expect(textEl).toBeInTheDocument();
            
            // The cleanup effect strips out sld-delta-text-* classes immediately on mount or update
            expect(textEl).not.toHaveClass('sld-delta-text-positive');
            // But it preserves unrelated classes
            expect(textEl).toHaveClass('some-other-class');
        });
    });

    describe('grouped sldEdit prop (D4 consolidation)', () => {
        it('threads the grouped SLD-edit controls down to the edit panel', () => {
            const vlOverlay = {
                vlName: 'VL_A',
                actionId: null,
                svg: '<svg><g/></svg>',
                sldMetadata: null,
                loading: false,
                error: null,
                tab: 'contingency' as TabId,
            };
            const props = createDefaultProps({
                vlOverlay,
                activeTab: 'contingency',
                // One cohesive object in place of the former ~22 sld* props.
                sldEdit: {
                    sldEditMode: true,
                    onSldEditSimulate: vi.fn(),
                    onSldEditReset: vi.fn(),
                    onSldSwitchClick: vi.fn(),
                    sldEditPendingChanges: [{ switchId: 'SW_1', baselineOpen: false, targetOpen: true }],
                },
            });

            render(<VisualizationPanel {...props} />);

            // The grouped controls reach SldOverlay → SldEditPanel: the panel
            // renders only when editMode + onSimulate + onReset + a pending
            // change are ALL present, so this proves the object was unpacked
            // and forwarded field-by-field.
            expect(screen.getByTestId('sld-edit-panel')).toBeInTheDocument();
            expect(screen.getByTestId('sld-edit-change-SW_1')).toBeInTheDocument();
        });

        it('renders the overlay without the edit panel when no sldEdit is passed', () => {
            const vlOverlay = {
                vlName: 'VL_A', actionId: null, svg: '<svg><g/></svg>',
                sldMetadata: null, loading: false, error: null, tab: 'contingency' as TabId,
            };
            render(<VisualizationPanel {...createDefaultProps({ vlOverlay, activeTab: 'contingency' })} />);
            expect(screen.queryByTestId('sld-edit-panel')).not.toBeInTheDocument();
        });
    });

    // ===== Regression tests for auto-zoom double-injection fix =====
    // The N / N-1 / action diagram containers (MemoizedSvgContainer) are kept
    // ALWAYS mounted with an empty-string placeholder.  This prevents React
    // StrictMode from double-invoking the layout effect on mount, which would
    // overwrite the viewBox that the auto-zoom effect just applied.

    describe('Always-mounted SVG containers (auto-zoom preservation)', () => {
        it('keeps N container mounted even before nDiagram loads', () => {
            const { container } = render(<VisualizationPanel {...createDefaultProps()} />);
            // Container div always present
            expect(container.querySelector('#n-svg-container')).toBeInTheDocument();
            // Placeholder message shown via overlay
            expect(screen.getByText('Load configuration to see diagram')).toBeInTheDocument();
        });

        it('keeps N-1 container mounted even before n1Diagram loads', () => {
            const { container } = render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'contingency',
                selectedContingency: ['LINE_A'],
            })} />);
            expect(container.querySelector('#contingency-svg-container')).toBeInTheDocument();
            // Prompt message shown as overlay
            expect(screen.getByText(/Select a contingency element/)).toBeInTheDocument();
        });

        it('keeps N-1 container mounted while n1Loading is true (overlays loading message)', () => {
            const { container } = render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'contingency',
                selectedContingency: ['LINE_A'],
                n1Loading: true,
            })} />);
            // Container still present — not unmounted by loading state
            expect(container.querySelector('#contingency-svg-container')).toBeInTheDocument();
            // Loading message overlay shown
            expect(screen.getByText('Generating N-1 Diagram...')).toBeInTheDocument();
        });

        it('keeps action container mounted even before actionDiagram loads', () => {
            const { container } = render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
            })} />);
            expect(container.querySelector('#action-svg-container')).toBeInTheDocument();
        });

        it('keeps action container mounted while actionDiagramLoading is true', () => {
            const { container } = render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: 'act_1',
                actionDiagramLoading: true,
            })} />);
            expect(container.querySelector('#action-svg-container')).toBeInTheDocument();
            expect(screen.getByText('Generating Action Variant Diagram...')).toBeInTheDocument();
        });

        it('does NOT unmount N-1 container when transitioning loading → loaded', () => {
            const { container, rerender } = render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'contingency',
                selectedContingency: ['LINE_A'],
                n1Loading: true,
            })} />);
            const loadingContainer = container.querySelector('#contingency-svg-container');
            expect(loadingContainer).toBeInTheDocument();

            // Simulate fetchN1 completing
            const n1Diagram: DiagramData = {
                svg: '<svg viewBox="0 0 100 100"><g/></svg>',
                metadata: null,
            };
            rerender(<VisualizationPanel {...createDefaultProps({
                activeTab: 'contingency',
                selectedContingency: ['LINE_A'],
                n1Loading: false,
                n1Diagram,
            })} />);

            // Same container div — NOT a fresh remount
            const loadedContainer = container.querySelector('#contingency-svg-container');
            expect(loadedContainer).toBeInTheDocument();
            expect(loadedContainer).toBe(loadingContainer);
            // Loading overlay gone
            expect(screen.queryByText('Generating N-1 Diagram...')).not.toBeInTheDocument();
        });

        it('does NOT unmount N container when configLoading flips false', () => {
            const { container, rerender } = render(<VisualizationPanel {...createDefaultProps({
                configLoading: true,
            })} />);
            const initialContainer = container.querySelector('#n-svg-container');
            expect(initialContainer).toBeInTheDocument();
            expect(screen.getByText('Loading configuration...')).toBeInTheDocument();

            const nDiagram: DiagramData = {
                svg: '<svg viewBox="0 0 100 100"><g/></svg>',
                metadata: null,
            };
            rerender(<VisualizationPanel {...createDefaultProps({
                configLoading: false,
                nDiagram,
            })} />);

            const afterContainer = container.querySelector('#n-svg-container');
            expect(afterContainer).toBe(initialContainer);
            expect(screen.queryByText('Loading configuration...')).not.toBeInTheDocument();
        });
    });

    describe('Action tab "back to overview" interaction', () => {
        // The "back to overview" affordance lives INSIDE the
        // action tab label as a clickable chip around the action
        // id (data-testid="action-tab-deselect-chip"). The
        // previous top-right ✕ button was removed because it
        // overlapped with the Flow/Impacts toggle.
        const actionDiagram: DiagramData = {
            svg: '<svg viewBox="0 0 100 100"><g/></svg>',
            metadata: null,
        };

        it('renders the deselect chip when a card is selected', () => {
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action' as TabId,
                selectedActionId: 'action_1',
                actionDiagram,
                n1Diagram: { svg: '<svg/>', metadata: null },
            })} />);
            const chip = screen.getByTestId('action-tab-deselect-chip');
            expect(chip).toBeInTheDocument();
            expect(chip.textContent).toContain('action_1');
        });

        it('does NOT render the deselect chip when no action is selected', () => {
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action' as TabId,
                selectedActionId: null,
                actionDiagram,
                n1Diagram: { svg: '<svg/>', metadata: null },
            })} />);
            expect(screen.queryByTestId('action-tab-deselect-chip')).not.toBeInTheDocument();
            // The default overview label is shown instead.
            expect(screen.getByText('Remedial action: overview')).toBeInTheDocument();
        });

        it('clicking the chip calls onActionSelect(null) and does NOT trigger onTabChange', async () => {
            const onActionSelect = vi.fn();
            const onTabChange = vi.fn();
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action' as TabId,
                selectedActionId: 'action_1',
                actionDiagram,
                n1Diagram: { svg: '<svg/>', metadata: null },
                onActionSelect,
                onTabChange,
            })} />);
            await userEvent.click(screen.getByTestId('action-tab-deselect-chip'));
            expect(onActionSelect).toHaveBeenCalledWith(null);
            // stopPropagation must keep the parent <button>'s
            // onTabChange from firing.
            expect(onTabChange).not.toHaveBeenCalled();
        });

        it('Enter / Space on the chip also deselects the action (keyboard accessibility)', () => {
            const onActionSelect = vi.fn();
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action' as TabId,
                selectedActionId: 'action_1',
                actionDiagram,
                n1Diagram: { svg: '<svg/>', metadata: null },
                onActionSelect,
            })} />);
            const chip = screen.getByTestId('action-tab-deselect-chip');
            chip.focus();
            // Use fireEvent.keyDown directly to exercise the
            // span's role="button" + onKeyDown handler.
            fireEvent.keyDown(chip, { key: 'Enter' });
            expect(onActionSelect).toHaveBeenCalledWith(null);
        });
    });

    describe('detached action tab deselect', () => {
        it('shows a deselect button in the detached header when an action is selected', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: 'act_42',
                n1Diagram: { svg: '<svg></svg>' },
                actionDiagram: { svg: '<svg></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
                onActionSelect: vi.fn(),
            })} />);
            // The deselect button lives inside the portal target
            // (mountNode), not in testing-library's container.
            const btn = mountNode.querySelector('[data-testid="detached-action-deselect"]');
            expect(btn).not.toBeNull();
            document.body.removeChild(mountNode);
        });

        it('does NOT show a deselect button when no action is selected', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: null,
                n1Diagram: { svg: '<svg></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
            })} />);
            expect(mountNode.querySelector('[data-testid="detached-action-deselect"]')).toBeNull();
            document.body.removeChild(mountNode);
        });

        it('calls onActionSelect(null) when the detached deselect button is clicked', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            const onActionSelect = vi.fn();
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: 'act_42',
                n1Diagram: { svg: '<svg></svg>' },
                actionDiagram: { svg: '<svg></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
                onActionSelect,
            })} />);
            const btn = mountNode.querySelector('[data-testid="detached-action-deselect"]') as HTMLElement;
            fireEvent.click(btn);
            expect(onActionSelect).toHaveBeenCalledWith(null);
            document.body.removeChild(mountNode);
        });
    });

    describe('detached action overview Tie button', () => {
        it('shows the Tie button in detached overview (no action selected, n1Diagram present)', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: null,
                n1Diagram: { svg: '<svg viewBox="0 0 100 100"></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie: vi.fn(),
            })} />);
            // The Tie button now lives inside ActionOverviewDiagram's
            // control cluster (above the Unzoom button).
            const btn = mountNode.querySelector('[data-testid="overview-tie-button"]');
            expect(btn).not.toBeNull();
            expect(btn!.textContent).toContain('Tie');
            document.body.removeChild(mountNode);
        });

        it('does NOT show the overview Tie button when an action is selected (regular overlay handles it)', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: 'act_42',
                n1Diagram: { svg: '<svg viewBox="0 0 100 100"></svg>' },
                actionDiagram: { svg: '<svg></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie: vi.fn(),
            })} />);
            // The overview is hidden when an action is selected, so
            // the Tie button inside the overview should not be visible.
            // The regular renderTabOverlay provides its own Tie button.
            expect(mountNode.querySelector('[data-testid="overview-tie-button"]')).toBeNull();
            document.body.removeChild(mountNode);
        });

        it('calls onToggleTabTie("action") when clicked', () => {
            const mountNode = document.createElement('div');
            document.body.appendChild(mountNode);
            const onToggleTabTie = vi.fn();
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'action',
                selectedActionId: null,
                n1Diagram: { svg: '<svg viewBox="0 0 100 100"></svg>' },
                detachedTabs: { action: { window: {} as Window, mountNode } },
                isTabTied: () => false,
                onToggleTabTie,
            })} />);
            const btn = mountNode.querySelector('[data-testid="overview-tie-button"]') as HTMLElement;
            fireEvent.click(btn);
            expect(onToggleTabTie).toHaveBeenCalledWith('action');
            document.body.removeChild(mountNode);
        });
    });

    describe('Overflow Analysis tab — Hierarchical / Geo toggle', () => {
        const propsWithOverflow = (overrides: Record<string, unknown> = {}) =>
            createDefaultProps({
                activeTab: 'overflow',
                result: {
                    pdf_url: '/results/pdf/overflow_hierarchi.html',
                    pdf_path: '/tmp/Overflow_Graph/overflow_hierarchi.html',
                    actions: {},
                    action_scores: null,
                    lines_overloaded: [],
                    message: '',
                    dc_fallback: false,
                } as AnalysisResult,
                ...overrides,
            });

        it('renders the segmented pill when pdf_url is set and handler provided', () => {
            const onOverflowLayoutChange = vi.fn();
            render(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: false,
                onOverflowLayoutChange,
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            expect(screen.getByRole('button', { name: 'Hierarchical' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Geo' })).toBeInTheDocument();
        });

        it('disables Geo button when no layoutPath is configured', () => {
            render(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: false,
                onOverflowLayoutChange: vi.fn(),
                layoutPath: '',
            })} />);
            const geoBtn = screen.getByRole('button', { name: 'Geo' });
            expect(geoBtn).toBeDisabled();
            expect(geoBtn).toHaveAttribute(
                'title',
                expect.stringContaining('grid_layout.json') as unknown as string,
            );
        });

        it('calls onOverflowLayoutChange with the target mode on click', () => {
            const onOverflowLayoutChange = vi.fn();
            render(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: false,
                onOverflowLayoutChange,
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            fireEvent.click(screen.getByRole('button', { name: 'Geo' }));
            expect(onOverflowLayoutChange).toHaveBeenCalledWith('geo');
            fireEvent.click(screen.getByRole('button', { name: 'Hierarchical' }));
            expect(onOverflowLayoutChange).toHaveBeenCalledWith('hierarchical');
        });

        it('marks the active mode via aria-pressed', () => {
            const { rerender } = render(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'geo',
                overflowLayoutLoading: false,
                onOverflowLayoutChange: vi.fn(),
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            expect(screen.getByRole('button', { name: 'Geo' })).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getByRole('button', { name: 'Hierarchical' })).toHaveAttribute('aria-pressed', 'false');
            rerender(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: false,
                onOverflowLayoutChange: vi.fn(),
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            expect(screen.getByRole('button', { name: 'Hierarchical' })).toHaveAttribute('aria-pressed', 'true');
        });

        it('disables both buttons while loading (cache-miss regeneration)', () => {
            render(<VisualizationPanel {...propsWithOverflow({
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: true,
                onOverflowLayoutChange: vi.fn(),
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            expect(screen.getByRole('button', { name: 'Hierarchical' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Geo' })).toBeDisabled();
        });

        it('does not render the pill on other tabs', () => {
            render(<VisualizationPanel {...createDefaultProps({
                activeTab: 'n',
                result: {
                    pdf_url: '/results/pdf/overflow.html',
                    pdf_path: '/tmp/overflow.html',
                    actions: {},
                    action_scores: null,
                    lines_overloaded: [],
                    message: '',
                    dc_fallback: false,
                } as AnalysisResult,
                overflowLayoutMode: 'hierarchical',
                overflowLayoutLoading: false,
                onOverflowLayoutChange: vi.fn(),
                layoutPath: '/tmp/grid_layout.json',
            })} />);
            // The pill is rendered inside the overflow tab only, so
            // Hierarchical / Geo buttons must not be queryable when
            // another tab is active.
            expect(screen.queryByRole('button', { name: 'Hierarchical' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Geo' })).toBeNull();
        });
    });

    describe('kV voltage filter', () => {
        // Regression guard for the collapse-at-max bug: when the user pulled
        // both handles together to maxV, the default z-order pinned the high
        // handle (it cannot move beyond maxV) and hid the low handle beneath
        // it, so the range could no longer be expanded.
        const openFilter = async () => {
            const toggle = screen.getByTitle('Show voltage filter');
            await userEvent.click(toggle);
        };
        const sliders = () =>
            document.querySelectorAll<HTMLInputElement>('.voltage-slider-container input[type=range]');

        it('puts the high handle on top by default when the range is not collapsed at maxV', async () => {
            render(<VisualizationPanel {...createDefaultProps({
                uniqueVoltages: [25, 225, 400],
                voltageRange: [25, 400] as [number, number],
            })} />);
            await openFilter();
            const [low, high] = sliders();
            expect(parseInt(low.style.zIndex, 10)).toBeLessThan(parseInt(high.style.zIndex, 10));
        });

        it('raises the low handle above the high handle when both are collapsed at maxV', async () => {
            render(<VisualizationPanel {...createDefaultProps({
                uniqueVoltages: [25, 225, 400],
                voltageRange: [400, 400] as [number, number],
            })} />);
            await openFilter();
            const [low, high] = sliders();
            expect(parseInt(low.style.zIndex, 10)).toBeGreaterThan(parseInt(high.style.zIndex, 10));
        });

        it('keeps the high handle on top when both are collapsed at minV (high can still move up)', async () => {
            render(<VisualizationPanel {...createDefaultProps({
                uniqueVoltages: [25, 225, 400],
                voltageRange: [25, 25] as [number, number],
            })} />);
            await openFilter();
            const [low, high] = sliders();
            expect(parseInt(low.style.zIndex, 10)).toBeLessThan(parseInt(high.style.zIndex, 10));
        });
    });

    // ===== readability-feed PR: ActionFilterRings ride along when the
    // sidebar is collapsed. The strip moves into the tab row on the
    // left so the operator can still tune the overview filter without
    // re-expanding the sidebar.
    describe('Overview filter strip when the sidebar is collapsed', () => {
        const filterProps = (overrides: Record<string, unknown> = {}) => createDefaultProps({
            overviewFilters: DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters,
            onOverviewFiltersChange: vi.fn(),
            hasActions: true,
            sidebarCollapsed: true,
            ...overrides,
        });

        it('renders the inline filter strip when sidebar is collapsed and actions exist', () => {
            render(<VisualizationPanel {...filterProps()} />);
            expect(screen.getByTestId('viz-panel-overview-filters')).toBeInTheDocument();
        });

        it('hides the inline filter strip when the sidebar is expanded', () => {
            render(<VisualizationPanel {...filterProps({ sidebarCollapsed: false })} />);
            expect(screen.queryByTestId('viz-panel-overview-filters')).not.toBeInTheDocument();
        });

        it('hides the inline filter strip when there are no actions to filter', () => {
            render(<VisualizationPanel {...filterProps({ hasActions: false })} />);
            expect(screen.queryByTestId('viz-panel-overview-filters')).not.toBeInTheDocument();
        });

        it('hides the inline filter strip when no filter state is wired', () => {
            render(<VisualizationPanel {...filterProps({ overviewFilters: undefined, onOverviewFiltersChange: undefined })} />);
            expect(screen.queryByTestId('viz-panel-overview-filters')).not.toBeInTheDocument();
        });
    });
});
