// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React, { useState, useMemo, type RefObject } from 'react';
import type { DiagramData, AnalysisResult, TabId, VlOverlay, SldTab, MetadataIndex, ActionOverviewFilters, UnsimulatedActionScoreInfo } from '../types';
import MemoizedSvgContainer from './MemoizedSvgContainer';
import SldOverlay from './SldOverlay';
import DetachableTabHost from './DetachableTabHost';
import ActionOverviewDiagram from './ActionOverviewDiagram';
import ActionCardPopover from './ActionCardPopover';
import DiagramLegend from './DiagramLegend';
import InspectSearchField from './InspectSearchField';
import DetachedPlaceholder from './DetachedPlaceholder';
import type { DetachedTabsMap } from '../hooks/useDetachedTabs';
import type { PZInstance } from '../hooks/useTiedTabsSync';
import { useOverflowIframe } from '../hooks/useOverflowIframe';
import { colors } from '../styles/tokens';
import {
    computePopoverStyle,
    POPOVER_WIDTH,
    POPOVER_MAX_HEIGHT,
} from '../utils/popoverPlacement';

// Module-level stable references so React.memo children don't
// break referential equality on every parent render.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const NOOP_ACTION_SELECT = (_id: string | null) => { /* intentional no-op */ };
const EMPTY_STRING_ARRAY: readonly string[] = [];

interface VisualizationPanelProps {
    activeTab: TabId;
    configLoading: boolean;
    onTabChange: (tab: TabId) => void;
    nDiagram: DiagramData | null;
    n1Diagram: DiagramData | null;
    n1Loading: boolean;
    actionDiagram: DiagramData | null;
    actionDiagramLoading: boolean;
    selectedActionId: string | null;
    result: AnalysisResult | null;
    analysisLoading: boolean;
    nSvgContainerRef: RefObject<HTMLDivElement | null>;
    n1SvgContainerRef: RefObject<HTMLDivElement | null>;
    actionSvgContainerRef: RefObject<HTMLDivElement | null>;
    uniqueVoltages: number[];
    voltageRange: [number, number];
    onVoltageRangeChange: (range: [number, number]) => void;
    actionViewMode: 'network' | 'delta';
    onViewModeChange: (mode: 'network' | 'delta') => void;
    /**
     * Resolves the Flow/Impacts view mode for a specific tab. A
     * detached tab has its own view mode independent of the main
     * window's `actionViewMode` — see App.tsx's `detachedViewModes`.
     */
    viewModeForTab?: (tab: TabId) => 'network' | 'delta';
    /**
     * Per-tab Flow/Impacts toggle handler. Routes the change into
     * either the main-window `actionViewMode` or the detached
     * tab's entry in `detachedViewModes` based on whether the tab
     * is currently detached.
     */
    onViewModeChangeForTab?: (tab: TabId, mode: 'network' | 'delta') => void;
    /**
     * Overflow Analysis tab layout toggle (Hierarchical / Geo). Only
     * rendered on the overflow tab when an overflow file is present.
     * Cache-backed on the backend — switching between modes is
     * instant after the first regeneration.
     */
    overflowLayoutMode?: 'hierarchical' | 'geo';
    overflowLayoutLoading?: boolean;
    onOverflowLayoutChange?: (mode: 'hierarchical' | 'geo') => void;
    inspectQuery: string;
    onInspectQueryChange: (query: string) => void;
    /**
     * Same as `onInspectQueryChange` but records which tab the
     * auto-zoom should target — used by per-tab overlays rendered
     * inside a detached popup so they zoom their own tab instead of
     * the main-window activeTab.
     */
    onInspectQueryChangeFor?: (targetTab: TabId, query: string) => void;
    inspectableItems: string[];
    onResetView: (targetTab?: TabId) => void;
    onZoomIn: (targetTab?: TabId) => void;
    onZoomOut: (targetTab?: TabId) => void;
    hasBranches: boolean;
    /** Currently APPLIED contingency (list of element IDs disconnected). */
    selectedContingency: string[];
    vlOverlay: VlOverlay | null;
    onOverlayClose: () => void;
    onOverlaySldTabChange: (tab: SldTab) => void;
    voltageLevels: string[];
    onVlOpen: (vlName: string) => void;
    /**
     * Single click on an overflow-graph action pin. Should focus the
     * feed card for that action (same as clicking an Action-Overview
     * pin) — NOT switch tabs. Optional so call sites that don't
     * surface the overflow viewer can omit it.
     */
    onOverflowPinPreview?: (actionId: string) => void;
    /**
     * Double-click on an action pin in the overflow graph. Routes the
     * user to the SLD overlay opened on the post-action ('action')
     * sub-tab for that substation. Optional so call sites that don't
     * surface the overflow viewer can omit it.
     */
    onOverflowPinDoubleClick?: (actionId: string, substation: string) => void;
    networkPath: string;
    layoutPath: string;
    onOpenSettings: (tab?: 'recommender' | 'configurations' | 'paths') => void;
    /**
     * Map of tabs currently living in a secondary browser window.
     * Optional so existing call sites / tests that don't care about the
     * detach feature continue to work without wiring the props up.
     */
    detachedTabs?: DetachedTabsMap;
    /** Detach a tab into a new popup window. */
    onDetachTab?: (tab: TabId) => void;
    /** Close the popup for a tab and fold it back inline. */
    onReattachTab?: (tab: TabId) => void;
    /** Bring focus to the popup window hosting a detached tab. */
    onFocusDetachedTab?: (tab: TabId) => void;
    /** True iff the given tab is currently "tied" to the main window's activeTab. */
    isTabTied?: (tab: TabId) => boolean;
    /** Toggle the "tied" flag for the given tab. */
    onToggleTabTie?: (tab: TabId) => void;
    /**
     * Metadata index for the N-1 diagram. Used by the
     * action-overview view (shown in the Remedial Action tab
     * when no card is selected) to resolve each action to an
     * (x, y) anchor on the network.
     */
    n1MetaIndex?: MetadataIndex | null;
    /**
     * Invoked when the user clicks a pin on the action-overview
     * view — should trigger the same action-select flow as
     * clicking a card in the sidebar. Accepts `null` so the
     * top-right ✕ button on the action tab can deselect.
     */
    onActionSelect?: (actionId: string | null) => void;
    /** Toggle an action's favourite (starred) status. */
    onActionFavorite?: (actionId: string) => void;
    /** Reject an action from the suggestions feed. */
    onActionReject?: (actionId: string) => void;
    /** Selected-action id set (for the overview popover styling). */
    selectedActionIds?: Set<string>;
    /** Rejected-action id set (for the overview popover styling). */
    rejectedActionIds?: Set<string>;
    /** Called when a pin is single-clicked on the overview (scroll sidebar to card). */
    onPinPreview?: (actionId: string) => void;
    /** Called when the overview's usePanZoom instance changes (for tied-tab sync). */
    onOverviewPzChange?: (pz: PZInstance) => void;
    /**
     * Monitoring factor used to derive each action's severity
     * colour, kept in sync with the card palette.
     */
    monitoringFactor?: number;
    /** Resolve an element/VL ID to its human-readable display name. */
    displayName?: (id: string) => string;
    /** Shared category + threshold + un-simulated filter state. */
    overviewFilters?: ActionOverviewFilters;
    /** Setter for the shared overview filter state (owned by App.tsx). */
    onOverviewFiltersChange?: (next: ActionOverviewFilters) => void;
    /** Ids of scored-but-not-simulated actions to render as dimmed pins. */
    unsimulatedActionIds?: readonly string[];
    /** Per-id score metadata used to enrich the un-simulated pin tooltip. */
    unsimulatedActionInfo?: Readonly<Record<string, UnsimulatedActionScoreInfo>>;
    /** Kick off a manual simulation when an un-simulated pin is double-clicked. */
    onSimulateUnsimulatedAction?: (actionId: string) => void;
    /**
     * When false, voltage-level labels rendered by pypowsybl inside the
     * NAD's `<foreignObject class="nad-text-nodes">` are hidden via CSS.
     * The VL name remains accessible as a native `<title>` tooltip on
     * hover over each bus-node group. Default is true.
     */
    showVoltageLevelNames?: boolean;
    onToggleVoltageLevelNames?: (show: boolean) => void;
    /**
     * Pre-computed pin descriptors posted to the overflow-graph
     * iframe when `overflowPinsEnabled` is true. Built upstream by
     * `buildOverflowPinPayload` from `actions`, `monitoringFactor`,
     * and the VL→substation map. Re-posted whenever the array
     * reference changes.
     */
    overflowPins?: ReadonlyArray<import('../utils/svg/overflowPinPayload').OverflowPin>;
    /** Toggle state — controlled by App.tsx so it survives tab swaps. */
    overflowPinsEnabled?: boolean;
    /** Setter for `overflowPinsEnabled` — wired to interactionLogger. */
    onOverflowPinsToggle?: (enabled: boolean) => void;
}


const VisualizationPanel: React.FC<VisualizationPanelProps> = ({
    activeTab,
    configLoading,
    onTabChange,
    nDiagram,
    n1Diagram,
    n1Loading,
    actionDiagram,
    actionDiagramLoading,
    selectedActionId,
    result,
    analysisLoading,
    nSvgContainerRef,
    n1SvgContainerRef,
    actionSvgContainerRef,
    uniqueVoltages,
    voltageRange,
    onVoltageRangeChange,
    actionViewMode,
    onViewModeChange,
    inspectQuery,
    onInspectQueryChange,
    inspectableItems,
    onResetView,
    onZoomIn,
    onZoomOut,
    hasBranches,
    selectedContingency,
    vlOverlay,
    onOverlayClose,
    onOverlaySldTabChange,
    voltageLevels,
    onVlOpen,
    onOverflowPinPreview,
    onOverflowPinDoubleClick,
    networkPath,
    layoutPath,
    onOpenSettings,
    detachedTabs = {},
    onDetachTab,
    onReattachTab,
    onFocusDetachedTab,
    onInspectQueryChangeFor,
    viewModeForTab,
    onViewModeChangeForTab,
    overflowLayoutMode,
    overflowLayoutLoading,
    onOverflowLayoutChange,
    isTabTied,
    onToggleTabTie,
    n1MetaIndex,
    onActionSelect,
    onActionFavorite,
    onActionReject,
    selectedActionIds,
    rejectedActionIds,
    onPinPreview,
    onOverviewPzChange,
    monitoringFactor,
    displayName,
    overviewFilters,
    onOverviewFiltersChange,
    unsimulatedActionIds,
    unsimulatedActionInfo,
    onSimulateUnsimulatedAction,
    showVoltageLevelNames = true,
    onToggleVoltageLevelNames,
    overflowPins,
    overflowPinsEnabled = false,
    onOverflowPinsToggle,
}) => {
    // No-op fallbacks so conditional branches don't need to guard.
    const detachTabCb = onDetachTab ?? (() => {});
    const reattachTabCb = onReattachTab ?? (() => {});
    const focusDetachedTabCb = onFocusDetachedTab ?? (() => {});
    const inspectQueryChangeForCb = onInspectQueryChangeFor
        ?? ((_tab: TabId, q: string) => onInspectQueryChange(q));
    // When the per-tab view mode hooks are not wired up (older call
    // sites / tests) we fall back to the global `actionViewMode`
    // state passed in as a prop. That preserves backward compatibility.
    const viewModeForTabFn = viewModeForTab ?? (() => actionViewMode);
    const viewModeChangeForTabCb = onViewModeChangeForTab ?? ((_tab: TabId, mode: 'network' | 'delta') => onViewModeChange(mode));
    const isTabTiedFn = isTabTied ?? (() => false);
    const toggleTabTieCb = onToggleTabTie ?? (() => {});

    // Stable fallbacks for the ActionOverviewDiagram props so that
    // React.memo on the child doesn't break on every parent render.
    const actionSelectCb = onActionSelect ?? NOOP_ACTION_SELECT;
    const overloadedLinesMemo = React.useMemo(
        () => n1Diagram?.lines_overloaded ?? result?.lines_overloaded ?? EMPTY_STRING_ARRAY,
        [n1Diagram?.lines_overloaded, result?.lines_overloaded],
    );
    const [warningDismissed, setWarningDismissed] = useState(false);
    const [voltageFilterExpanded, setVoltageFilterExpanded] = useState(false);

    const hasAnyDiagram = !!(nDiagram?.svg || n1Diagram?.svg || actionDiagram?.svg);
    const showPathWarning = !warningDismissed && !hasAnyDiagram;

    // Overflow-graph iframe ↔ parent-window plumbing (handshake,
    // pin / filter / node messages, popover state with outside-click
    // dismissal, pin & filter broadcasts). See useOverflowIframe.
    const {
        overflowIframeRef,
        overflowPopoverRef,
        overflowPopoverPin,
        setOverflowPopoverPin,
        overflowPopoverViewport,
        setOverflowPopoverViewport,
    } = useOverflowIframe({
        pdfUrl: result?.pdf_url,
        overflowPinsEnabled,
        overflowPins,
        overviewFilters,
        overflowGraphTime: result?.overflow_graph_time ?? null,
        onOverflowPinPreview,
        onOverflowPinDoubleClick,
        onSimulateUnsimulatedAction,
        onOverviewFiltersChange,
        onOverflowPinsToggle,
        onVlOpen,
        detachedWindow: detachedTabs['overflow']?.window ?? null,
    });

    const filteredInspectables = useMemo(() => {
        const q = inspectQuery.toUpperCase();
        if (!q) return inspectableItems.slice(0, 50);
        return inspectableItems.filter(b => b.toUpperCase().includes(q)).slice(0, 50);
    }, [inspectableItems, inspectQuery]);

    // Tab label adapts to the size of the applied contingency: N-1 for
    // a single disconnected element, N-2 / N-K for multi-element
    // studies, and a bare "Contingency" while no element is committed.
    const contingencyTabLabel = useMemo(() => {
        const k = selectedContingency.length;
        if (k <= 0) return 'Contingency';
        return `Contingency (N-${k})`;
    }, [selectedContingency]);

    // When a tab is portaled into a secondary window we inject a small
    // floating header with a Reattach button. This is the ONLY thing the
    // popup-specific wrapper adds on top of the regular tab content — the
    // rest of the layout (MemoizedSvgContainer, warning banners, etc.)
    // is the exact same React tree that lives in the main window, which
    // is why refs and zoom state survive the detach/reattach round-trip.
    const renderDetachedHeader = (tabId: TabId, label: string, accentColor: string, onDeselect?: () => void) => (
        <div style={{
            position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
            zIndex: 400, display: 'flex', alignItems: 'center', gap: '8px',
            padding: '4px 10px', background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${accentColor}`, borderRadius: '14px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', fontSize: '12px', fontWeight: 600,
            color: colors.chrome, pointerEvents: 'auto',
        }}>
            <span style={{ color: accentColor }}>●</span>
            <span>{label}</span>
            {/* Deselect chip — shown when an action is focused so
                the operator can return to the overview without
                reattaching the tab first. */}
            {onDeselect && (
                <button
                    data-testid="detached-action-deselect"
                    onClick={onDeselect}
                    title="Return to the action overview"
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        border: '1.5px solid var(--signal-action-target-strong)', background: 'var(--signal-action-target-soft)',
                        color: 'var(--signal-action-target-darker)', borderRadius: '10px',
                        padding: '2px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    }}
                >
                    {'\u2715 Overview'}
                </button>
            )}
            <button
                onClick={() => reattachTabCb(tabId)}
                title="Reattach this tab to the main window"
                style={{
                    border: `1px solid ${accentColor}`, background: 'white',
                    color: accentColor, borderRadius: '10px',
                    padding: '2px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                }}
            >
                {'\u21A9 Reattach'}
            </button>
        </div>
    );

    // Renders the per-tab control overlay (zoom in/out/reset, inspect
    // search, Flow/Impacts toggle, and the "tie" button for detached
    // tabs). This lives INSIDE each DetachableTabHost's children so
    // that when the tab is relocated into a popup the controls move
    // with it — which is how the operator gets zoom / asset focus /
    // flow-impacts interactions inside the detached window.
    //
    // Note that every tab renders its own copy of the overlay, but
    // only the currently-visible one (active-in-main-window OR
    // detached) is visible, because the tab container's home
    // placeholder carries `visibility: hidden` when neither applies.
    const renderTabOverlay = (tabId: TabId, supportsViewMode: boolean) => {
        if (tabId === 'overflow') return null;
        const isDetachedTab = !!detachedTabs[tabId];
        const hasDiagramForTab =
            (tabId === 'n' && !!nDiagram?.svg) ||
            (tabId === 'contingency' && !!n1Diagram?.svg) ||
            (tabId === 'action' && !!actionDiagram?.svg);
        const tied = isTabTiedFn(tabId);
        // Per-tab view mode: each detached popup tracks its own
        // Flow/Impacts state, independent of the main window — so
        // the toggle inside the popup only affects the popup, and
        // vice versa.
        const tabViewMode = viewModeForTabFn(tabId);

        return (
            <>
                {/* Top-right cluster: Flow/Impacts + Tie button.
                    Only rendered when the tab actually has a
                    diagram so we don't clutter empty tabs. The Tie
                    button lives DOWN in the bottom-left cluster next
                    to the controls it actually synchronises
                    (zoom / inspect), not here. */}
                {hasDiagramForTab && supportsViewMode && (
                    <div style={{
                        position: 'absolute', top: '10px', right: '10px', zIndex: 100,
                        display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                        <div style={{
                            display: 'flex',
                            borderRadius: '6px',
                            overflow: 'hidden',
                            border: `1px solid ${colors.border}`,
                            boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                            fontSize: '12px',
                            fontWeight: 600,
                            backgroundColor: colors.surface,
                        }}>
                            <button
                                onClick={() => viewModeChangeForTabCb(tabId, 'network')}
                                style={{
                                    padding: '4px 12px', border: 'none', cursor: 'pointer',
                                    backgroundColor: tabViewMode === 'network' ? colors.brand : colors.surface,
                                    color: tabViewMode === 'network' ? colors.surface : colors.textSecondary,
                                    transition: 'all 0.15s ease'
                                }}
                            >
                                Flows
                            </button>
                            <button
                                onClick={() => viewModeChangeForTabCb(tabId, 'delta')}
                                style={{
                                    padding: '4px 12px', border: 'none', borderLeft: `1px solid ${colors.border}`, cursor: 'pointer',
                                    backgroundColor: tabViewMode === 'delta' ? colors.brand : colors.surface,
                                    color: tabViewMode === 'delta' ? colors.surface : colors.textSecondary,
                                    transition: 'all 0.15s ease'
                                }}
                            >
                                Impacts
                            </button>
                        </div>
                    </div>
                )}

                {/* Bottom-left cluster: Tie (detached only) + zoom
                    controls + inspect search. The Tie button sits
                    directly above the zoom + inspect row so it's
                    visually associated with the interactions it
                    actually synchronises — pan/zoom and asset
                    focus. It is deliberately NOT grouped with the
                    Flow/Impacts toggle in the top-right because
                    view mode is per-window and never tied. */}
                {hasDiagramForTab && (
                    <div style={{
                        position: 'absolute',
                        bottom: '12px',
                        left: '12px',
                        zIndex: 100,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        alignItems: 'flex-start',
                    }}>
                        {isDetachedTab && (
                            <button
                                onClick={() => toggleTabTieCb(tabId)}
                                title={tied
                                    ? 'Untie: pan/zoom and asset focus no longer mirror between this window and the main window'
                                    : 'Tie: pan/zoom and asset focus will be mirrored between this window and the main window\'s active tab'}
                                style={{
                                    padding: '4px 10px', border: `1px solid ${tied ? colors.brand : colors.border}`,
                                    borderRadius: '6px', cursor: 'pointer',
                                    backgroundColor: tied ? colors.brandSoft : colors.surface,
                                    color: tied ? colors.brand : colors.textSecondary,
                                    fontSize: '12px', fontWeight: 600,
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                }}
                            >
                                {tied ? '\u{1F517} Tied' : '\u{26D3} Tie'}
                            </button>
                        )}
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            <button
                                onClick={() => onZoomIn(tabId)}
                                style={{
                                    background: 'white', color: colors.textPrimary,
                                    border: `1px solid ${colors.border}`, borderRadius: '4px',
                                    padding: '5px 12px', cursor: 'pointer',
                                    fontSize: '14px', fontWeight: 600,
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                }}
                                title="Zoom In"
                            >
                                +
                            </button>
                            <button
                                onClick={() => onResetView(tabId)}
                                style={{
                                    background: 'white', color: colors.textPrimary,
                                    border: `1px solid ${colors.border}`, borderRadius: '4px',
                                    padding: '5px 14px', cursor: 'pointer',
                                    fontSize: '12px', fontWeight: 600,
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                }}
                            >
                                🔍 Unzoom
                            </button>
                            <button
                                onClick={() => onZoomOut(tabId)}
                                style={{
                                    background: 'white', color: colors.textPrimary,
                                    border: `1px solid ${colors.border}`, borderRadius: '4px',
                                    padding: '5px 12px', cursor: 'pointer',
                                    fontSize: '14px', fontWeight: 600,
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                }}
                                title="Zoom Out"
                            >
                                -
                            </button>
                        </div>
                        {hasBranches && (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', position: 'relative' }}>
                                <InspectSearchField
                                    tabId={tabId}
                                    inspectQuery={inspectQuery}
                                    onChangeQuery={inspectQueryChangeForCb}
                                    filteredInspectables={filteredInspectables}
                                />
                                {onToggleVoltageLevelNames && (
                                    <button
                                        onClick={() => onToggleVoltageLevelNames(!showVoltageLevelNames)}
                                        title={showVoltageLevelNames
                                            ? 'Hide voltage-level names on the diagram (hover bus circles to see them as tooltips)'
                                            : 'Show voltage-level names on the diagram'}
                                        aria-pressed={showVoltageLevelNames}
                                        data-testid="toggle-vl-names"
                                        style={{
                                            background: showVoltageLevelNames ? colors.brandSoft : colors.surface,
                                            color: showVoltageLevelNames ? colors.brand : colors.textSecondary,
                                            border: `1px solid ${showVoltageLevelNames ? colors.brand : colors.border}`,
                                            borderRadius: '4px',
                                            padding: '4px 8px',
                                            cursor: 'pointer',
                                            fontSize: '12px',
                                            fontWeight: 600,
                                            boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                        }}
                                    >
                                        {'\u{1F3F7} VL'}
                                    </button>
                                )}
                                {inspectQuery && voltageLevels.includes(inspectQuery) && (
                                    <button
                                        onClick={() => onVlOpen(inspectQuery)}
                                        style={{
                                            background: colors.successSoft, color: colors.successText, border: 'none',
                                            borderRadius: '4px', padding: '4px 8px', cursor: 'pointer',
                                            fontSize: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                            fontWeight: 600
                                        }}
                                        title="Open Single Line Diagram"
                                    >
                                        📄 SLD
                                    </button>
                                )}
                                {inspectQuery && (
                                    <button
                                        onClick={() => inspectQueryChangeForCb(tabId, '')}
                                        style={{
                                            background: colors.danger, color: 'white', border: 'none',
                                            borderRadius: '4px', padding: '4px 8px', cursor: 'pointer',
                                            fontSize: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                        }}
                                        title="Clear"
                                    >
                                        X
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </>
        );
    };

    // Placeholder shown in the main window in place of a detached tab's
    // content. The tab's DOM lives in a popup — we show a friendly
    // "click to focus" indicator so the main-window user can find it.
    const renderDetachedPlaceholder = (tabId: TabId, label: string, accentColor: string) => (
        <DetachedPlaceholder
            tabId={tabId}
            label={label}
            accentColor={accentColor}
            onFocusDetachedTab={focusDetachedTabCb}
            onReattachTab={reattachTabCb}
        />
    );

    return (
        <>
            {/* Tab bar — all 4 tabs always visible; unavailable ones show placeholder.
                Each tab exposes a small detach/reattach button so the user can move
                its content into a secondary browser window and back. */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
                {(
                    [
                        { id: 'n' as TabId, label: 'Network (N)' as React.ReactNode, available: !!nDiagram?.svg, accentColor: colors.brand, dimColor: colors.chromeSoft, placeholder: 'Configure a network path in Settings to load the base-case diagram.' },
                        { id: 'contingency' as TabId, label: contingencyTabLabel as React.ReactNode, available: !!n1Diagram?.svg, accentColor: colors.danger, dimColor: colors.borderStrong, placeholder: 'Trigger a contingency from the dropdown to view the post-contingency state.' },
                        // When no card is selected, the Remedial Action tab hosts the
                        // action-overview view (pins over the N-1 network). It is considered
                        // "available" as soon as the N-1 diagram has loaded, so the tab is no
                        // longer italicised while the user is still browsing the overview.
                        //
                        // When a card IS selected, the action id is rendered as a
                        // clickable chip that deselects the action on click — taking
                        // the user back to the overview view in the same tab. The chip
                        // lives INSIDE the tab text instead of as a separate close
                        // button so it does not collide with the Flow/Impacts toggle
                        // and other top-right controls.
                        //
                        // The label uses a flex layout so the chip stays visible and
                        // clickable even on narrow tabs (the outer button otherwise
                        // applies `overflow: hidden; text-overflow: ellipsis` which
                        // was truncating the chip to a bare "..." ellipsis).
                        {
                            id: 'action' as TabId,
                            label: selectedActionId ? (
                                <span
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: 6,
                                        width: '100%',
                                        minWidth: 0,
                                    }}
                                >
                                    <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>Remedial Action:</span>
                                    <span
                                        data-testid="action-tab-deselect-chip"
                                        role="button"
                                        tabIndex={0}
                                        title={`${selectedActionId} — click to return to the overview`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onActionSelect?.(null);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onActionSelect?.(null);
                                            }
                                        }}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            padding: '2px 10px',
                                            borderRadius: 12,
                                            background: 'var(--signal-action-target-soft)',
                                            color: 'var(--signal-action-target-darker)',
                                            border: '1.5px solid var(--signal-action-target-strong)',
                                            cursor: 'pointer',
                                            fontWeight: 700,
                                            // Let the chip shrink before the "Remedial Action:" label does
                                            flex: '1 1 auto',
                                            minWidth: 0,
                                            maxWidth: '100%',
                                            overflow: 'hidden',
                                        }}
                                    >
                                        <span
                                            style={{
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                minWidth: 0,
                                            }}
                                        >
                                            {selectedActionId}
                                        </span>
                                        <span
                                            aria-hidden
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0,
                                                width: 14,
                                                height: 14,
                                                borderRadius: '50%',
                                                background: 'var(--signal-action-target-strong)',
                                                color: 'white',
                                                fontSize: 10,
                                                lineHeight: 1,
                                            }}
                                        >
                                            {'\u2715'}
                                        </span>
                                    </span>
                                </span>
                            ) as React.ReactNode : 'Remedial action: overview' as React.ReactNode,
                            available: !!actionDiagram?.svg || !!n1Diagram?.svg,
                            accentColor: 'var(--signal-action-target)',
                            dimColor: colors.borderStrong,
                            placeholder: 'Select a contingency and run the analysis to see remedial actions.',
                        },
                        { id: 'overflow' as TabId, label: 'Overflow Analysis' as React.ReactNode, available: !!result?.pdf_url, accentColor: colors.success, dimColor: colors.borderStrong, placeholder: 'Run \u201cAnalyze & Suggest\u201d to see the overflow graph.' },
                    ] as const
                ).map(tab => {
                    const isActive = activeTab === tab.id;
                    const isDetached = !!detachedTabs[tab.id];
                    return (
                        <div
                            key={tab.id}
                            style={{
                                flex: 1, display: 'flex', alignItems: 'stretch',
                                background: isActive && !isDetached ? 'white' : colors.surfaceMuted,
                                borderBottom: isActive && tab.available && !isDetached ? `3px solid ${tab.accentColor}` : 'none',
                                minWidth: 0,
                            }}
                        >
                            <button
                                data-testid={`tab-button-${tab.id}`}
                                data-tab-active={isActive ? 'true' : 'false'}
                                onClick={() => {
                                    if (isDetached) {
                                        focusDetachedTabCb(tab.id);
                                    } else {
                                        onTabChange(tab.id);
                                    }
                                }}
                                title={isDetached ? 'Tab is open in a separate window — click to focus it' : (tab.available ? undefined : tab.placeholder)}
                                style={{
                                    flex: 1, borderRadius: 0, border: 'none', padding: '8px 6px',
                                    cursor: 'pointer',
                                    fontWeight: isActive && tab.available && !isDetached ? 'bold' : 400,
                                    fontStyle: !tab.available || isDetached ? 'italic' : 'normal',
                                    background: 'transparent',
                                    color: isDetached ? colors.textTertiary : (tab.available ? (isActive ? colors.chrome : tab.dimColor) : colors.borderStrong),
                                    fontSize: tab.id === 'action' && selectedActionId ? '0.75rem' : '0.85rem',
                                    // The action tab with a selected card carries its
                                    // own flex label with internal ellipsis on the chip.
                                    // We must NOT apply white-space: nowrap /
                                    // text-overflow: ellipsis on the outer button for
                                    // that tab — it was truncating the whole label
                                    // down to a bare "Remedial Action: ..." string and
                                    // hiding the clickable deselect chip.
                                    overflow: 'hidden',
                                    textOverflow: tab.id === 'action' && selectedActionId ? 'clip' : 'ellipsis',
                                    whiteSpace: tab.id === 'action' && selectedActionId ? 'normal' : 'nowrap',
                                    display: tab.id === 'action' && selectedActionId ? 'flex' : undefined,
                                    alignItems: tab.id === 'action' && selectedActionId ? 'center' : undefined,
                                    justifyContent: tab.id === 'action' && selectedActionId ? 'center' : undefined,
                                    minWidth: 0,
                                }}
                            >
                                {tab.label}{isDetached ? ' \u21D7' : ''}
                            </button>
                            {tab.available && (
                                <button
                                    data-testid={`tab-detach-${tab.id}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (isDetached) reattachTabCb(tab.id);
                                        else detachTabCb(tab.id);
                                    }}
                                    title={isDetached ? 'Reattach this tab to the main window' : 'Detach this tab into a separate window'}
                                    style={{
                                        border: 'none', background: 'transparent', cursor: 'pointer',
                                        padding: '0 8px', color: isDetached ? tab.accentColor : colors.textTertiary,
                                        fontSize: '13px', fontWeight: 700,
                                    }}
                                >
                                    {isDetached ? '\u21A9' : '\u29C9'}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Content area */}
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {/* Flow/Impacts, zoom, inspect and tie controls now
                    live INSIDE each tab container (see renderTabOverlay).
                    That way they move with the tab into a detached
                    popup window. */}

                {/* Path Warning Banner */}
                {!nDiagram?.svg && !configLoading && showPathWarning && (
                    <div style={{
                        position: 'absolute',
                        top: '10px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 150,
                        backgroundColor: colors.warningSoft,
                        color: colors.warningText,
                        padding: '12px 20px',
                        borderRadius: '8px',
                        border: `1px solid ${colors.warningBorder}`,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        maxWidth: '80%',
                        fontSize: '13px'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span>⚠️</span> Configuration Paths
                            </div>
                            <button
                                onClick={() => setWarningDismissed(true)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '16px', color: colors.warningText }}
                            >✕</button>
                        </div>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <strong>Layout Path:</strong> {layoutPath || 'Not set'}
                        </div>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <strong>Output Folder:</strong> {networkPath ? networkPath.substring(0, networkPath.lastIndexOf('/')) : 'Not set'}
                        </div>
                        <div style={{ marginTop: '4px' }}>
                            <a
                                href="#"
                                onClick={(e) => { e.preventDefault(); onOpenSettings('paths'); }}
                                style={{ color: colors.brandStrong, textDecoration: 'underline', fontWeight: 500 }}
                            >
                                Change in settings
                            </a>
                        </div>
                    </div>
                )}

                {/* Overflow Container — always rendered via DetachableTabHost so
                    its sub-tree stays mounted across detach/reattach. */}
                <DetachableTabHost
                    detachedMountNode={detachedTabs['overflow']?.mountNode ?? null}
                    homeStyle={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                        backgroundColor: 'white',
                        zIndex: !detachedTabs['overflow'] && activeTab === 'overflow' ? 20 : -1,
                        visibility: !detachedTabs['overflow'] && activeTab === 'overflow' ? 'visible' : 'hidden',
                        pointerEvents: !detachedTabs['overflow'] && activeTab === 'overflow' ? 'auto' : 'none',
                    }}
                >
                    <div style={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                        backgroundColor: 'white',
                    }}>
                        {detachedTabs['overflow'] && renderDetachedHeader('overflow', 'Overflow Analysis', colors.success)}
                        {/* Hierarchical / Geo layout toggle — mirrors the
                            Flows/Impacts segmented pill used on the N, N-1
                            and Remedial Action tabs. Only visible when an
                            overflow file is present. Geo is disabled when
                            no grid_layout.json is configured because the
                            backend would silently fall back to
                            hierarchical rendering. */}
                        {result?.pdf_url && onOverflowLayoutChange && (() => {
                            const mode = overflowLayoutMode ?? 'hierarchical';
                            const loading = !!overflowLayoutLoading;
                            const hasLayout = !!layoutPath;
                            return (
                                <div style={{
                                    position: 'absolute', top: '10px', right: '10px', zIndex: 100,
                                    display: 'flex', alignItems: 'center', gap: '6px',
                                }}>
                                    <div style={{
                                        display: 'flex',
                                        borderRadius: '6px',
                                        overflow: 'hidden',
                                        border: `1px solid ${colors.border}`,
                                        boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                        fontSize: '12px',
                                        fontWeight: 600,
                                        backgroundColor: colors.surface,
                                        opacity: loading ? 0.7 : 1,
                                    }}>
                                        <button
                                            type="button"
                                            onClick={() => onOverflowLayoutChange('hierarchical')}
                                            disabled={loading}
                                            aria-pressed={mode === 'hierarchical'}
                                            style={{
                                                padding: '4px 12px', border: 'none',
                                                cursor: loading ? 'wait' : 'pointer',
                                                backgroundColor: mode === 'hierarchical' ? colors.brand : colors.surface,
                                                color: mode === 'hierarchical' ? colors.surface : colors.textSecondary,
                                                transition: 'all 0.15s ease',
                                            }}
                                        >
                                            Hierarchical
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onOverflowLayoutChange('geo')}
                                            disabled={loading || !hasLayout}
                                            aria-pressed={mode === 'geo'}
                                            title={hasLayout ? '' : 'No grid_layout.json configured — set the Layout Path in Settings'}
                                            style={{
                                                padding: '4px 12px', border: 'none', borderLeft: `1px solid ${colors.border}`,
                                                cursor: (loading || !hasLayout) ? 'not-allowed' : 'pointer',
                                                backgroundColor: mode === 'geo' ? colors.brand : colors.surface,
                                                color: mode === 'geo' ? colors.surface : (hasLayout ? colors.textSecondary : colors.borderStrong),
                                                transition: 'all 0.15s ease',
                                            }}
                                        >
                                            Geo
                                        </button>
                                    </div>
                                    {/* The pins on/off toggle moved INTO the
                                        iframe's filter panel header — see
                                        ``overflow_overlay.py``'s ``cs4g-filters``
                                        section. The iframe posts
                                        ``cs4g:overflow-pins-toggled`` and the
                                        parent (App.tsx) flips
                                        ``overflowPinsEnabled`` via the
                                        ``onOverflowPinsToggle`` hook prop —
                                        no React-side button needed here. */}
                                </div>
                            );
                        })()}
                        {result?.pdf_url ? (
                            <iframe
                                ref={overflowIframeRef}
                                src={`http://localhost:8000${result.pdf_url}`}
                                key={result.pdf_url}
                                style={{ width: '100%', height: '100%', border: 'none' }}
                                title="Overflow Graph"
                            />
                        ) : null}
                        {/* Floating ActionCard popover anchored on the
                            single-clicked overflow pin. Reuses the
                            exact same component the Action Overview
                            uses for its pin preview, so the visual
                            and interaction contract stays in lock-
                            step on both surfaces. */}
                        {result?.pdf_url && overflowPopoverPin && result?.actions?.[overflowPopoverPin.id] && (() => {
                            const popoverDetails = result.actions[overflowPopoverPin.id];
                            const keys = Object.keys(result.actions || {});
                            const popoverIndex = keys.indexOf(overflowPopoverPin.id) + 1;
                            return (
                                <ActionCardPopover
                                    popoverRef={overflowPopoverRef}
                                    testId="overflow-pin-popover"
                                    extraDataAttributes={{
                                        'data-place-above': overflowPopoverPin.placeAbove ? 'true' : 'false',
                                        'data-horizontal-align': overflowPopoverPin.horizontalAlign,
                                    }}
                                    actionId={overflowPopoverPin.id}
                                    details={popoverDetails}
                                    index={popoverIndex}
                                    style={{
                                        ...computePopoverStyle(overflowPopoverPin, overflowPopoverViewport ?? undefined),
                                        width: POPOVER_WIDTH,
                                        maxHeight: POPOVER_MAX_HEIGHT,
                                        overflowY: 'auto',
                                    }}
                                    linesOverloaded={overloadedLinesMemo}
                                    monitoringFactor={monitoringFactor ?? 1}
                                    metaIndex={n1MetaIndex ?? null}
                                    selectedActionIds={selectedActionIds}
                                    rejectedActionIds={rejectedActionIds}
                                    onActivateAction={(id) => {
                                        setOverflowPopoverPin(null);
                                        setOverflowPopoverViewport(null);
                                        if (onActionSelect) onActionSelect(id);
                                    }}
                                    onActionFavorite={onActionFavorite}
                                    onActionReject={onActionReject}
                                    onClose={() => {
                                        setOverflowPopoverPin(null);
                                        setOverflowPopoverViewport(null);
                                    }}
                                    displayName={displayName}
                                />
                            );
                        })()}
                        {!result?.pdf_url && (
                            <div style={{
                                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%',
                                // Keep the diagram window neutral while the recommender
                                // runs — a full-window yellow flood was distracting. The
                                // spinning gear + text already signal the busy state.
                                color: analysisLoading ? colors.textSecondary : colors.textTertiary,
                                background: 'white',
                                fontWeight: analysisLoading ? 600 : 'normal',
                                gap: '10px'
                            }}>
                                {analysisLoading ? (
                                    <>
                                        <span style={{ fontSize: '24px' }}>⚙️</span>
                                        <span>Processing Analysis...</span>
                                    </>
                                ) : <span style={{ fontStyle: 'italic', color: colors.textTertiary }}>Run &ldquo;Analyze &amp; Suggest&rdquo; to see the overflow graph.</span>}
                            </div>
                        )}
                    </div>
                </DetachableTabHost>
                {activeTab === 'overflow' && detachedTabs['overflow'] && renderDetachedPlaceholder('overflow', 'Overflow Analysis', colors.success)}

                {/* Inactive, non-detached SVG tabs use `display: none` (not
                    `visibility: hidden`) so their tens-of-thousands-of-node
                    SVG subtrees are excluded from Blink's layout & paint
                    passes. With `visibility: hidden`, every Layout still
                    walked the union of all three tab SVGs (~610k nodes on
                    large grids); with `display: none` only the active tab's
                    SVG participates. The React subtree and DetachableTabHost
                    portal target stay mounted, so refs, viewBox state and
                    the auto-zoom effect survive tab switches. */}
                <DetachableTabHost
                    detachedMountNode={detachedTabs['n']?.mountNode ?? null}
                    homeStyle={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                        zIndex: !detachedTabs['n'] && activeTab === 'n' ? 10 : -1,
                        display: !detachedTabs['n'] && activeTab === 'n' ? 'block' : 'none',
                        pointerEvents: !detachedTabs['n'] && activeTab === 'n' ? 'auto' : 'none',
                    }}
                >
                    <div style={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                    }}>
                        {detachedTabs['n'] && renderDetachedHeader('n', 'Network (N)', colors.brand)}
                        {/* Always mounted — see comment on N-1 container below. */}
                        <MemoizedSvgContainer svg={nDiagram?.svg || ''} containerRef={nSvgContainerRef} display="block" tabId="n" hideVlLabels={!showVoltageLevelNames} />
                        {configLoading && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, background: 'rgba(255,255,255,0.85)', zIndex: 20 }}>
                                Loading configuration...
                            </div>
                        )}
                        {!configLoading && !nDiagram?.svg && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, background: 'white' }}>
                                Load configuration to see diagram
                            </div>
                        )}
                        {renderTabOverlay('n', true)}
                        {nDiagram?.svg && (
                            <DiagramLegend tabId="n" uniqueVoltages={uniqueVoltages} vlNamesHidden={!showVoltageLevelNames} />
                        )}
                    </div>
                </DetachableTabHost>
                {activeTab === 'n' && detachedTabs['n'] && renderDetachedPlaceholder('n', 'Network (N)', colors.brand)}

                {/* N-1 Container — always mounted, but `display: none` when
                    inactive so its SVG does not enter Blink's layout tree.
                    See the comment on the N tab above for the full rationale. */}
                <DetachableTabHost
                    detachedMountNode={detachedTabs['contingency']?.mountNode ?? null}
                    homeStyle={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                        zIndex: !detachedTabs['contingency'] && activeTab === 'contingency' ? 10 : -1,
                        display: !detachedTabs['contingency'] && activeTab === 'contingency' ? 'block' : 'none',
                        pointerEvents: !detachedTabs['contingency'] && activeTab === 'contingency' ? 'auto' : 'none',
                    }}
                >
                    <div style={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                    }}>
                        {detachedTabs['contingency'] && renderDetachedHeader('contingency', contingencyTabLabel, colors.danger)}
                        {/* Convergence warning banner */}
                        {n1Diagram && n1Diagram.lf_converged === false && (
                            <div style={{
                                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
                                background: colors.warningSoft, color: colors.warningText, padding: '6px 12px',
                                fontSize: '0.8rem', borderBottom: `1px solid ${colors.warning}`,
                                textAlign: 'center', pointerEvents: 'none',
                            }}>
                                AC load flow: {n1Diagram.lf_status || 'did not converge'} — voltage values may be missing or approximate
                            </div>
                        )}
                        {/* MemoizedSvgContainer ALWAYS mounted to avoid unmount/remount
                            cycles when n1Diagram flips from null to loaded.  Remounting
                            would cause StrictMode to double-invoke its layout effect,
                            and the second DOM injection would overwrite the auto-zoom
                            viewBox that was applied between the two invocations. */}
                        <MemoizedSvgContainer svg={n1Diagram?.svg || ''} containerRef={n1SvgContainerRef} display="block" tabId="contingency" hideVlLabels={!showVoltageLevelNames} />
                        {n1Loading && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, background: 'rgba(255,255,255,0.85)', zIndex: 20 }}>
                                Generating N-1 Diagram...
                            </div>
                        )}
                        {!n1Loading && !n1Diagram?.svg && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontStyle: 'italic', textAlign: 'center', padding: '40px', background: 'white' }}>
                                Select a contingency element from the dropdown to view the N-1 state.
                            </div>
                        )}
                        {renderTabOverlay('contingency', true)}
                        {n1Diagram?.svg && (
                            <DiagramLegend tabId="contingency" uniqueVoltages={uniqueVoltages} vlNamesHidden={!showVoltageLevelNames} />
                        )}
                    </div>
                </DetachableTabHost>
                {activeTab === 'contingency' && detachedTabs['contingency'] && renderDetachedPlaceholder('contingency', contingencyTabLabel, colors.danger)}

                {/* Action Variant Container — always mounted, but `display: none`
                    when inactive so its SVG does not enter Blink's layout tree.
                    See the comment on the N tab above for the full rationale. */}
                <DetachableTabHost
                    detachedMountNode={detachedTabs['action']?.mountNode ?? null}
                    homeStyle={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                        zIndex: !detachedTabs['action'] && activeTab === 'action' ? 10 : -1,
                        display: !detachedTabs['action'] && activeTab === 'action' ? 'block' : 'none',
                        pointerEvents: !detachedTabs['action'] && activeTab === 'action' ? 'auto' : 'none',
                    }}
                >
                    <div style={{
                        width: '100%', height: '100%',
                        position: 'absolute', top: 0, left: 0,
                    }}>
                        {detachedTabs['action'] && renderDetachedHeader(
    'action',
    selectedActionId ? `Remedial Action: ${selectedActionId}` : 'Remedial action: overview',
    'var(--signal-action-target)',
    selectedActionId ? () => onActionSelect?.(null) : undefined,
)}
                        {/* Convergence warning banner */}
                        {actionDiagram && actionDiagram.lf_converged === false && (
                            <div style={{
                                position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
                                background: colors.warningSoft, color: colors.warningText, padding: '6px 12px',
                                fontSize: '0.8rem', borderBottom: `1px solid ${colors.warning}`,
                                textAlign: 'center', pointerEvents: 'none',
                            }}>
                                AC load flow: {actionDiagram.lf_status || 'did not converge'} — voltage values may be missing or approximate
                            </div>
                        )}
                        {/* Always mounted — see comment on N-1 container. */}
                        <MemoizedSvgContainer svg={actionDiagram?.svg || ''} containerRef={actionSvgContainerRef} display="block" tabId="action" hideVlLabels={!showVoltageLevelNames} />
                        {/*
                          Action-overview layer: rendered on top of the
                          (hidden) action-diagram container when no card
                          is selected. When a card IS selected it folds
                          away (visible=false) and the existing action
                          variant diagram + highlights take over, so the
                          selection-driven interactions persist intact.
                        */}
                        <ActionOverviewDiagram
                            n1Diagram={n1Diagram}
                            n1MetaIndex={n1MetaIndex ?? null}
                            actions={result?.actions}
                            monitoringFactor={monitoringFactor ?? 1}
                            onActionSelect={actionSelectCb}
                            onActionFavorite={onActionFavorite}
                            onActionReject={onActionReject}
                            selectedActionIds={selectedActionIds}
                            rejectedActionIds={rejectedActionIds}
                            onPinPreview={onPinPreview}
                            contingency={selectedContingency.length > 0 ? selectedContingency.join('+') : null}
                            overloadedLines={overloadedLinesMemo}
                            inspectableItems={inspectableItems}
                            visible={!selectedActionId && !actionDiagramLoading}
                            onPzChange={onOverviewPzChange}
                            isTied={isTabTiedFn('action')}
                            onToggleTie={() => toggleTabTieCb('action')}
                            isDetached={!!detachedTabs['action']}
                            displayName={displayName}
                            filters={overviewFilters}
                            onFiltersChange={onOverviewFiltersChange}
                            unsimulatedActionIds={unsimulatedActionIds}
                            unsimulatedActionInfo={unsimulatedActionInfo}
                            onSimulateUnsimulatedAction={onSimulateUnsimulatedAction}
                        />
                        {actionDiagramLoading && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, background: 'rgba(255,255,255,0.85)', zIndex: 20 }}>
                                Generating Action Variant Diagram...
                            </div>
                        )}
                        {!actionDiagramLoading && !actionDiagram?.svg && selectedActionId && (
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, background: 'white' }}>
                                Failed to load diagram for action {selectedActionId}
                            </div>
                        )}
                        {/*
                          The "select a card..." placeholder is now
                          replaced by the ActionOverviewDiagram above
                          (which itself shows its own empty-state copy
                          when the N-1 background is missing).
                        */}
                        {renderTabOverlay('action', true)}
                        {(actionDiagram?.svg || (n1Diagram?.svg && !selectedActionId)) && (
                            <DiagramLegend tabId="action" uniqueVoltages={uniqueVoltages} vlNamesHidden={!showVoltageLevelNames} />
                        )}
                    </div>
                </DetachableTabHost>
                {activeTab === 'action' && detachedTabs['action'] && renderDetachedPlaceholder('action', selectedActionId ? `Remedial Action: ${selectedActionId}` : 'Remedial action: overview', 'var(--signal-action-target)')}

                {/* Voltage Range Sidebar — collapsed by default, toggle to expand */}
                {uniqueVoltages.length > 1 && (() => {
                    const minV = uniqueVoltages[0];
                    const maxV = uniqueVoltages[uniqueVoltages.length - 1];
                    const logMin = Math.log(minV);
                    const logMax = Math.log(maxV);
                    const logScale = (kv: number) => ((Math.log(kv) - logMin) / (logMax - logMin)) * 100;
                    const pctLow = logScale(voltageRange[0]);
                    const pctHigh = logScale(voltageRange[1]);
                    if (!voltageFilterExpanded) {
                        return (
                            <button
                                className="voltage-sidebar-toggle"
                                onClick={() => setVoltageFilterExpanded(true)}
                                title="Show voltage filter"
                            >
                                <span style={{ writingMode: 'vertical-rl', fontSize: '11px', letterSpacing: '1px' }}>kV ▸</span>
                            </button>
                        );
                    }
                    return (
                        <div className="voltage-sidebar">
                            <button
                                onClick={() => setVoltageFilterExpanded(false)}
                                title="Hide voltage filter"
                                style={{
                                    alignSelf: 'flex-end', background: 'none', border: 'none',
                                    cursor: 'pointer', fontSize: '14px', color: colors.textTertiary,
                                    padding: '0 4px', lineHeight: 1,
                                }}
                            >✕</button>
                            <span className="vs-label">kV Filter</span>
                            <span className="vs-range-label">
                                {voltageRange[1]}<br />{voltageRange[0]}
                            </span>
                            <div className="voltage-slider-container">
                                <div className="voltage-slider-track" />
                                <div className="voltage-slider-range" style={{ bottom: pctLow + '%', top: (100 - pctHigh) + '%' }} />
                                {/* When both handles collapse at maxV, the default (high on
                                    top) pins the range: the high handle can't move up
                                    (already at max) and hides the low handle that could
                                    still be dragged down. Raise the low handle so the user
                                    can grab it to expand the range again. */}
                                {(() => {
                                    const collapsedAtMax = voltageRange[0] === voltageRange[1] && voltageRange[1] === maxV;
                                    const lowZ = collapsedAtMax ? 5 : 3;
                                    return (
                                        <>
                                            <input type="range"
                                                min={logMin} max={logMax} step="any"
                                                value={Math.log(voltageRange[0])}
                                                onChange={e => {
                                                    const logV = parseFloat(e.target.value);
                                                    const snapped = uniqueVoltages.reduce((best, uv) =>
                                                        Math.abs(Math.log(uv) - logV) < Math.abs(Math.log(best) - logV) ? uv : best
                                                    );
                                                    if (snapped <= voltageRange[1]) onVoltageRangeChange([snapped, voltageRange[1]]);
                                                }}
                                                style={{ zIndex: lowZ, height: '100%' }}
                                            />
                                            <input type="range"
                                                min={logMin} max={logMax} step="any"
                                                value={Math.log(voltageRange[1])}
                                                onChange={e => {
                                                    const logV = parseFloat(e.target.value);
                                                    const snapped = uniqueVoltages.reduce((best, uv) =>
                                                        Math.abs(Math.log(uv) - logV) < Math.abs(Math.log(best) - logV) ? uv : best
                                                    );
                                                    if (snapped >= voltageRange[0]) onVoltageRangeChange([voltageRange[0], snapped]);
                                                }}
                                                style={{ zIndex: 4, height: '100%' }}
                                            />
                                        </>
                                    );
                                })()}
                                <div className="voltage-slider-ticks">
                                    {uniqueVoltages.map(kv => (
                                        <span key={kv} style={{ bottom: logScale(kv) + '%' }}>
                                            {kv === 25 ? '<25' : kv}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* SLD Overlay — floating panel for voltage-level Single Line Diagram.
                    key={vlOverlay.vlName} ensures position/zoom resets automatically
                    when a different VL is selected. */}
                {vlOverlay && (
                    <SldOverlay
                        key={vlOverlay.vlName}
                        vlOverlay={vlOverlay}
                        actionViewMode={actionViewMode}
                        onOverlayClose={onOverlayClose}
                        onOverlaySldTabChange={onOverlaySldTabChange}
                        n1Diagram={n1Diagram}
                        actionDiagram={actionDiagram}
                        selectedContingency={selectedContingency}
                        result={result}
                        monitoringFactor={monitoringFactor}
                    />
                )}

                {/* (Zoom, inspect, Flow/Impacts and Tie controls are
                    rendered INSIDE each tab container via
                    renderTabOverlay so they follow detached tabs
                    into their popup windows.) */}
            </div>
        </>
    );
};

export default React.memo(VisualizationPanel);
