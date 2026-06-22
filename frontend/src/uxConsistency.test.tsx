// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

// Cross-component UX consistency checks rooted in
// `docs/proposals/ui-design-critique.md`. Each `describe` block guards
// the user-observable contract of one of the five recommendations:
//
//   1. Design-token layer — no raw hex literals leak into rendered
//      DOM `style` attributes for the migrated components.
//   2. Progressive-disclosure ActionCard — at-rest cards hide the
//      editable detail rows; viewing cards reveal them.
//   3. NAD overload-halo zoom-adaptive width (CSS + usePanZoom contract —
//      also covered by the Layer-4 static invariant
//      `nad_overload_halo_zoom_adaptive`. The runtime check would require a
//      real pypowsybl SVG, so the static invariant is the gate and we only
//      assert here that the var-driven rule lives in App.css and that
//      usePanZoom drives `--nad-halo-w` continuously).
//   4. Tier the warning system — no inline yellow banner in the
//      ActionFeed / OverloadPanel surfaces; NoticesPanel surfaces
//      one entry point in the Header, under the app title.
//   5. Diagram legend — every diagram tab carries a collapsible
//      legend pill when its SVG is mounted.
//
// These tests render the real components (no mocks of the components
// under test) so a future refactor that violates the contract — for
// example, re-introducing the dismissable yellow banner inside
// ActionFeed — fails this file even if the per-component unit tests
// keep passing.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('./utils/svgUtils', async () => {
    const actual = await vi.importActual<typeof import('./utils/svgUtils')>('./utils/svgUtils');
    return {
        ...actual,
        // Override the side-effecting / SVG-mutating ones with no-ops
        // so jsdom doesn't choke on raw pypowsybl payloads. The pure
        // helpers (`actionPassesOverviewFilter`, `processSvg`, etc.)
        // come through unmodified from `actual`.
        applyOverloadedHighlights: vi.fn(),
        applyDeltaVisuals: vi.fn(),
        applyActionTargetHighlights: vi.fn(),
        applyContingencyHighlight: vi.fn(),
        applyActionOverviewHighlights: vi.fn(),
        applyActionOverviewPins: vi.fn(),
        rescaleActionOverviewPins: vi.fn(),
        attachVlInteractions: vi.fn(() => () => {}),
        boostSvgForLargeGrid: vi.fn(),
        invalidateIdMapCache: vi.fn(),
    };
});

import OverloadPanel from './components/OverloadPanel';
import ActionFeed from './components/ActionFeed';
import AppSidebar from './components/AppSidebar';
import Header from './components/Header';
import VisualizationPanel from './components/VisualizationPanel';
import ActionCard from './components/ActionCard';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from './utils/actionTypes';
import type { Notice } from './components/NoticesPanel';
import type { ActionDetail, AnalysisResult, CombinedAction, DiagramData, TabId } from './types';

/** Minimal Header props — the warning-tier tests only care about the
 *  NoticesPanel pill the Header renders under the app title. */
const headerProps = {
    networkPath: '',
    setNetworkPath: vi.fn(),
    onCommitNetworkPath: vi.fn(),
    configLoading: false,
    result: null,
    selectedContingency: [] as string[],
    sessionRestoring: false,
    onPickSettingsPath: vi.fn(),
    onLoadStudy: vi.fn(),
    onSaveResults: vi.fn(),
    onOpenReloadModal: vi.fn(),
    onOpenSettings: vi.fn(),
};

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const HEX_LITERAL_RE = /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

/**
 * Walk every `[style]` attribute under `root` and collect raw inline
 * hex literals. The design-token migration (recommendation #1) means
 * components must emit `var(--…)` strings rather than baked hex.
 *
 * pypowsybl SVG fixtures are exempt because the bundled diagram
 * payloads still carry the original `<style>` block — we only audit
 * inline styles authored in our own components.
 */
function collectRawHexInInlineStyles(root: HTMLElement): { selector: string; hex: string }[] {
    const hits: { selector: string; hex: string }[] = [];
    root.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
        const style = el.getAttribute('style') || '';
        const matches = style.match(HEX_LITERAL_RE);
        if (matches) {
            for (const hex of matches) {
                hits.push({ selector: describeNode(el), hex });
            }
        }
    });
    return hits;
}

function describeNode(el: HTMLElement): string {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className ? `.${String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : '';
    const testId = el.getAttribute('data-testid');
    return `${el.tagName.toLowerCase()}${id}${cls}${testId ? `[data-testid="${testId}"]` : ''}`;
}

/** True iff any descendant element renders the warning-banner palette
 *  (yellow soft fill from `var(--color-warning-soft)`). Used to guard
 *  the warning-tier consolidation. */
function hasInlineWarningBanner(root: HTMLElement): HTMLElement | null {
    const candidates = root.querySelectorAll<HTMLElement>('[style*="var(--color-warning-soft)"]');
    for (const el of candidates) {
        const styleAttr = el.getAttribute('style') || '';
        if (styleAttr.includes('background') && styleAttr.includes('var(--color-warning-soft)')) {
            return el;
        }
    }
    return null;
}

// ------------------------------------------------------------------
// Recommendation #1 — Design tokens
// ------------------------------------------------------------------

describe('UX consistency — Recommendation #1 (design tokens)', () => {
    it('OverloadPanel emits no raw hex literals in inline styles', () => {
        const { container } = render(
            <OverloadPanel
                nOverloads={['LINE_A']}
                n1Overloads={['LINE_B']}
                onAssetClick={vi.fn()}
                monitoringHint="130/150 lines monitored — see Notices for details."
            />,
        );
        expect(collectRawHexInInlineStyles(container)).toEqual([]);
    });

    it('AppSidebar emits no raw hex literals in inline styles', () => {
        const { container } = render(
            <AppSidebar
                selectedContingency={[]} pendingContingency={[]} onPendingContingencyChange={vi.fn()} onContingencyApply={vi.fn()}
                branches={[]}
                nameMap={{}}
                n1LinesOverloaded={undefined}
                n1LinesOverloadedRho={undefined}
                selectedOverloads={undefined}

                displayName={(id) => id}
                onContingencyZoom={vi.fn()}
                onOverloadClick={vi.fn()}
            >
                <div />
            </AppSidebar>,
        );
        expect(collectRawHexInInlineStyles(container)).toEqual([]);
    });
});

// ------------------------------------------------------------------
// Recommendation #2 — Progressive-disclosure ActionCard
// ------------------------------------------------------------------

describe('UX consistency — Recommendation #2 (progressive disclosure)', () => {
    const emptyTopo = { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} };
    const baseDetails: ActionDetail = {
        description_unitaire: 'Shed load on LD_A — 12.5 MW',
        rho_before: [1.05],
        rho_after: [0.85],
        max_rho: 0.85,
        max_rho_line: 'LINE_A',
        is_rho_reduction: true,
        action_topology: emptyTopo,
        load_shedding_details: [{ load_name: 'LD_A', shedded_mw: 12.5 }],
    };
    const baseProps = {
        id: 'act_1',
        details: baseDetails,
        index: 0,
        isSelected: false,
        isRejected: false,
        linesOverloaded: ['LINE_A'],
        monitoringFactor: 0.95,
        nodesByEquipmentId: null,
        edgesByEquipmentId: null,
        cardEditMw: {} as Record<string, string>,
        cardEditTap: {} as Record<string, string>,
        resimulating: null as string | null,
        onActionSelect: vi.fn(),
        onActionFavorite: vi.fn(),
        onActionReject: vi.fn(),
        onAssetClick: vi.fn(),
        onVlDoubleClick: vi.fn(),
        onCardEditMwChange: vi.fn(),
        onCardEditTapChange: vi.fn(),
        onResimulate: vi.fn(),
        onResimulateTap: vi.fn(),
    };

    it('hides the disclosure subtree at rest (isViewing=false)', () => {
        render(<ActionCard {...baseProps} isViewing={false} />);
        expect(screen.queryByTestId('action-card-act_1-disclosure')).not.toBeInTheDocument();
        // The description and the load-shedding editor row both belong
        // to the disclosure, so neither should appear at rest.
        expect(screen.queryByText('Shed load on LD_A — 12.5 MW')).not.toBeInTheDocument();
        expect(screen.queryByTestId('edit-mw-act_1')).not.toBeInTheDocument();
    });

    it('reveals the disclosure subtree when isViewing=true', () => {
        render(<ActionCard {...baseProps} isViewing={true} />);
        expect(screen.getByTestId('action-card-act_1-disclosure')).toBeInTheDocument();
        expect(screen.getByText('Shed load on LD_A — 12.5 MW')).toBeInTheDocument();
        expect(screen.getByTestId('edit-mw-act_1')).toBeInTheDocument();
    });
});

// ------------------------------------------------------------------
// Recommendation #3 — NAD overload halo (CSS contract)
// ------------------------------------------------------------------

describe('UX consistency — overload-halo width is zoom-adaptive (smooth, no tier snap)', () => {
    // The halo is screen-space (non-scaling-stroke) and its width is driven
    // CONTINUOUSLY by usePanZoom through the `--nad-halo-w` CSS var: thin (a
    // clean ~24px trace) when zoomed in, growing toward a prominent marker when
    // zoomed out — no abrupt `data-zoom-tier` snap. The shared rule defaults
    // thin so the look is correct even before JS sets the var, and re-asserts
    // non-scaling-stroke as a guard against a pypowsybl build flipping equipment
    // paths to vector-effect:none.
    it('drives the overload halo width from the --nad-halo-w var with a thin default + non-scaling-stroke', () => {
        const css = readFileSync(resolve(__dirname, 'App.css'), 'utf-8');
        // The shared halo rule binds stroke-width to the zoom-adaptive var with
        // a thin fallback, and keeps the stroke screen-space.
        expect(css).toMatch(
            /\.nad-overloaded path[^{]*{[^}]*stroke-width:\s*var\(--nad-halo-w,\s*24px\)[^}]*vector-effect:\s*non-scaling-stroke/s,
        );
        // No fixed per-tier width snap survives (neither the old thin 24px cap
        // nor a fat 120px override) — width is the var, continuously.
        expect(css).not.toMatch(
            /\[data-zoom-tier="(?:region|detail)"\]\s+\.nad-overloaded[^{]*{[^}]*stroke-width:/s,
        );
    });

    it('drives the var continuously from the zoom ratio (no tier-stepped width) in usePanZoom', () => {
        const hook = readFileSync(resolve(__dirname, 'hooks/usePanZoom.ts'), 'utf-8');
        // usePanZoom writes --nad-halo-w from a continuous ratio function, not a
        // tier lookup, so the width transitions smoothly between zoom levels.
        expect(hook).toMatch(/setProperty\(\s*['"]--nad-halo-w['"]/s);
        expect(hook).toMatch(/computeHaloWidthPx/s);
    });
});

// ------------------------------------------------------------------
// Interaction-time paint culling (pan/zoom fluidity, CSS contract)
// ------------------------------------------------------------------

describe('UX consistency — interaction paint culling', () => {
    // While a pan/zoom gesture is active, usePanZoom adds `.svg-interacting`
    // to the container. The CSS culls the two most expensive paint element
    // classes (HTML VL labels + edge-info flow values) for that window so
    // the per-frame viewBox repaint stays cheaper on large grids (measured
    // ~1.5x faster pan / ~1.7x faster zoom on the 5247-VL European grid in
    // a software-rendered headless benchmark; larger expected on GPU).
    // Guard the rule so a refactor that drops it fails here rather than
    // silently regressing fluidity. See
    // docs/performance/history/interaction-paint-culling.md.
    const readCss = () => readFileSync(resolve(__dirname, 'App.css'), 'utf-8');

    it('hides the edge-info flow group during active interaction', () => {
        expect(readCss()).toMatch(
            /\.svg-container\.svg-interacting\s+\.nad-edge-infos[^{]*{[^}]*display:\s*none/s,
        );
    });

    it('hides the HTML voltage-level labels during active interaction', () => {
        // At least one of the pypowsybl VL-label foreignObject shapes
        // must be culled under `.svg-interacting`.
        expect(readCss()).toMatch(
            /\.svg-container\.svg-interacting\s+(?:foreignObject\.nad-text-nodes|\.nad-text-nodes|\.nad-vl-nodes\s+foreignObject)[^{]*{[^}]*display:\s*none/s,
        );
    });
});

// ------------------------------------------------------------------
// Recommendation #4 — Tier the warning system
// ------------------------------------------------------------------

describe('UX consistency — Recommendation #4 (tier the warning system)', () => {
    it('OverloadPanel renders no inline yellow banner when monitoringHint is null', () => {
        const { container } = render(
            <OverloadPanel
                nOverloads={[]}
                n1Overloads={[]}
                onAssetClick={vi.fn()}
                monitoringHint={null}
            />,
        );
        expect(hasInlineWarningBanner(container)).toBeNull();
    });

    it('OverloadPanel renders the monitoring hint as small grey text, never as a yellow banner', () => {
        const { container } = render(
            <OverloadPanel
                nOverloads={[]}
                n1Overloads={[]}
                onAssetClick={vi.fn()}
                monitoringHint="130/150 lines monitored — see Notices for details."
            />,
        );
        const hint = screen.getByTestId('overload-monitoring-hint');
        expect(hint).toBeInTheDocument();
        const styleAttr = hint.getAttribute('style') || '';
        expect(styleAttr).toContain('var(--color-text-tertiary)');
        // The hint is grey + italic — no warning-soft / warning-border palette.
        expect(styleAttr).not.toContain('var(--color-warning-soft)');
        expect(styleAttr).not.toContain('var(--color-warning-border)');
        expect(hasInlineWarningBanner(container)).toBeNull();
    });

    it('ActionFeed renders no inline yellow banner with default empty state', () => {
        const props = {
            actions: {} as Record<string, ActionDetail>,
            actionScores: {} as Record<string, Record<string, unknown>>,
            linesOverloaded: ['LINE_1'],
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
        const { container } = render(<ActionFeed {...props} />);
        // The old code shipped up to two yellow banners here — the
        // action-dictionary info and the recommender-thresholds box.
        // Both moved into NoticesPanel, so the feed must stay clean.
        expect(hasInlineWarningBanner(container)).toBeNull();
    });

    it('Header surfaces the NoticesPanel pill when notices are passed', () => {
        const notices: Notice[] = [
            { id: 'a', title: 'Action dict', body: 'body', severity: 'info' },
            { id: 'b', title: 'Monitoring', body: 'body', severity: 'warning' },
        ];
        render(<Header {...headerProps} notices={notices} />);
        const pill = screen.getByTestId('notices-pill');
        expect(pill).toHaveTextContent('2');
    });

    it('Notices pill shares the Network Path label row, above the file opener', () => {
        // The single notices entry point lives in the header, sharing
        // one row with the "Network Path" label (no wasted standalone
        // row) and sitting above the input + file-opener row.
        const notices: Notice[] = [
            { id: 'a', title: 'Monitoring', body: 'body', severity: 'warning' },
        ];
        render(<Header {...headerProps} notices={notices} />);
        const pill = screen.getByTestId('notices-pill');
        const input = screen.getByTestId('header-network-path-input');
        const label = screen.getByText('Network Path');
        // Pill shares the label's row...
        expect(label.parentElement).toContainElement(pill);
        // ...and that row sits above the input + file-opener row.
        expect(pill.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Header omits the NoticesPanel entirely when no notices are active', () => {
        render(<Header {...headerProps} notices={[]} />);
        expect(screen.queryByTestId('notices-pill')).not.toBeInTheDocument();
        expect(screen.queryByTestId('notices-panel')).not.toBeInTheDocument();
    });
});

// ------------------------------------------------------------------
// Recommendation #5 — Diagram legend per tab
// ------------------------------------------------------------------

describe('UX consistency — Recommendation #5 (diagram legend)', () => {
    const dummyDiagram: DiagramData = {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
        viewBox: { x: 0, y: 0, w: 100, h: 100 },
        metadata: null,
    };

    function renderPanel(active: TabId, overrides: Record<string, unknown> = {}) {
        return render(
            <VisualizationPanel
                activeTab={active}
                configLoading={false}
                onTabChange={vi.fn()}
                nDiagram={dummyDiagram}
                n1Diagram={dummyDiagram}
                n1Loading={false}
                actionDiagram={dummyDiagram}
                actionDiagramLoading={false}
                selectedActionId={'act_1'}
                result={null}
                analysisLoading={false}
                nSvgContainerRef={createRef<HTMLDivElement>()}
                n1SvgContainerRef={createRef<HTMLDivElement>()}
                actionSvgContainerRef={createRef<HTMLDivElement>()}
                uniqueVoltages={[63, 225, 400]}
                voltageRange={[0, 1000]}
                onVoltageRangeChange={vi.fn()}
                actionViewMode="network"
                onViewModeChange={vi.fn()}
                inspectQuery=""
                onInspectQueryChange={vi.fn()}
                inspectableItems={[]}
                onResetView={vi.fn()}
                onZoomIn={vi.fn()}
                onZoomOut={vi.fn()}
                hasBranches={true}
                selectedContingency={['BRANCH_A']}
                vlOverlay={null}
                onOverlayClose={vi.fn()}
                onOverlaySldTabChange={vi.fn()}
                voltageLevels={[]}
                onVlOpen={vi.fn()}
                networkPath=""
                layoutPath=""
                onOpenSettings={vi.fn()}
                {...overrides}
            />,
        );
    }

    it('mounts a Legend pill on the Network (N) tab when the diagram is loaded', () => {
        renderPanel('n');
        expect(screen.getByTestId('diagram-legend-pill-n')).toBeInTheDocument();
    });

    it('mounts a Legend pill on the Contingency (N-1) tab when the diagram is loaded', () => {
        renderPanel('contingency');
        expect(screen.getByTestId('diagram-legend-pill-contingency')).toBeInTheDocument();
    });

    it('mounts a Legend pill on the Remedial Action tab when the diagram is loaded', () => {
        renderPanel('action');
        expect(screen.getByTestId('diagram-legend-pill-action')).toBeInTheDocument();
    });

    it('omits the Legend pill on a tab whose diagram has not loaded yet', () => {
        renderPanel('n', { nDiagram: null });
        expect(screen.queryByTestId('diagram-legend-pill-n')).not.toBeInTheDocument();
    });
});

// ------------------------------------------------------------------
// Cross-recommendation source-text invariants
// ------------------------------------------------------------------

describe('UX consistency — source-text invariants', () => {
    function readSource(rel: string): string {
        return readFileSync(resolve(__dirname, rel), 'utf-8');
    }

    it('ActionFeed.tsx no longer owns the dismissable banner state setters', () => {
        const src = readSource('components/ActionFeed.tsx');
        expect(src).not.toMatch(/setShowActionDictWarning/);
        expect(src).not.toMatch(/setShowRecommenderWarning/);
    });

    it('OverloadPanel.tsx exposes monitoringHint and not the legacy banner props', () => {
        const src = readSource('components/OverloadPanel.tsx');
        expect(src).toMatch(/monitoringHint\?:\s*string\s*\|\s*null/);
        expect(src).not.toMatch(/showMonitoringWarning/);
        expect(src).not.toMatch(/onDismissWarning/);
    });

    it('Header.tsx renders <NoticesPanel /> as the single warning entry point', () => {
        // The NoticesPanel pill now lives in the Header, under the app
        // title — the sidebar strip no longer owns it.
        const headerSrc = readSource('components/Header.tsx');
        expect(headerSrc).toMatch(/<NoticesPanel\s/);
        const summarySrc = readSource('components/SidebarSummary.tsx');
        expect(summarySrc).not.toMatch(/<NoticesPanel\s/);
    });

    it('VisualizationPanel.tsx wires <DiagramLegend /> for n / n-1 / action', () => {
        const src = readSource('components/VisualizationPanel.tsx');
        expect(src).toMatch(/<DiagramLegend\s+tabId="n"/);
        expect(src).toMatch(/<DiagramLegend\s+tabId="contingency"/);
        expect(src).toMatch(/<DiagramLegend\s+tabId="action"/);
    });
});

// ------------------------------------------------------------------
// Smoke — both new components are independently importable.
// ------------------------------------------------------------------

describe('UX consistency — component import smoke', () => {
    it('AppSidebar children slot keeps rendering inside the sidebar shell', () => {
        render(
            <AppSidebar
                selectedContingency={[]} pendingContingency={[]} onPendingContingencyChange={vi.fn()} onContingencyApply={vi.fn()}
                branches={[]}
                nameMap={{}}
                n1LinesOverloaded={undefined}
                n1LinesOverloadedRho={undefined}
                selectedOverloads={undefined}

                displayName={(id) => id}
                onContingencyZoom={vi.fn()}
                onOverloadClick={vi.fn()}
            >
                <div data-testid="children-slot">payload</div>
            </AppSidebar>,
        );
        const slot = screen.getByTestId('children-slot');
        expect(slot).toHaveTextContent('payload');
        const sidebar = screen.getByTestId('sidebar');
        expect(within(sidebar).getByTestId('children-slot')).toBeInTheDocument();
    });

    it('AppSidebar forwards the overview filters into SidebarSummary so the rings render', () => {
        // App → AppSidebar → SidebarSummary prop chain: when the feed
        // has actions and the shared filter state is wired, the
        // ActionFilterRings show up in the sticky strip.
        render(
            <AppSidebar
                selectedContingency={['LINE_A']} pendingContingency={['LINE_A']} onPendingContingencyChange={vi.fn()} onContingencyApply={vi.fn()}
                branches={[]}
                nameMap={{}}
                n1LinesOverloaded={undefined}
                n1LinesOverloadedRho={undefined}
                selectedOverloads={undefined}
                displayName={(id) => id}
                onContingencyZoom={vi.fn()}
                onOverloadClick={vi.fn()}
                overviewFilters={DEFAULT_ACTION_OVERVIEW_FILTERS}
                onOverviewFiltersChange={vi.fn()}
                hasActions
            >
                <div />
            </AppSidebar>,
        );
        const summary = screen.getByTestId('sticky-feed-summary');
        expect(within(summary).getByTestId('sidebar-action-filters')).toBeInTheDocument();
    });
});
