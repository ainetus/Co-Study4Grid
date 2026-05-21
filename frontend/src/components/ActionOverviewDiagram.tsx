// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ActionDetail, ActionOverviewFilters, DiagramData, MetadataIndex, UnsimulatedActionScoreInfo, ViewBox } from '../types';
import { DEFAULT_ACTION_OVERVIEW_FILTERS, matchesActionTypeFilter } from '../utils/actionTypes';
import { colors } from '../styles/tokens';
import {
    actionPassesOverviewFilter,
    applyActionOverviewHighlights,
    applyActionOverviewPins,
    buildActionOverviewPins,
    buildCombinedActionPins,
    buildUnsimulatedActionPins,
    computeActionOverviewFitRect,
    computeEquipmentFitRect,
    invalidateIdMapCache,
    rescaleActionOverviewPins,
} from '../utils/svgUtils';
import { usePanZoom } from '../hooks/usePanZoom';
import ActionCardPopover from './ActionCardPopover';
import { interactionLogger } from '../utils/interactionLogger';
import {
    POPOVER_WIDTH,
    POPOVER_MAX_HEIGHT,
    decidePopoverPlacement,
    computePopoverStyle,
} from '../utils/popoverPlacement';

/** Measure a named code section and log it to the console + Performance timeline. */
const perfMeasure = (name: string, startMark: string, endMark: string) => {
    const entry = performance.measure(name, startMark, endMark);
    console.log(`[PERF] ${name}: ${entry.duration.toFixed(2)}ms`);
};

/**
 * Action-overview diagram.
 *
 * When the Remedial Action tab is opened without any action card
 * selected, this view is rendered inside that tab. It shows the
 * N-1 NAD as an immutable background and overlays one Google-Maps
 * style pin per prioritised action, anchored on the asset the
 * corresponding action card highlights in its badges.
 *
 * Interactions supported here:
 *  - auto-zoom on open to the bounding rectangle of
 *    (contingency + overloads + all pins), with a small margin
 *  - wheel-zoom + drag-pan via the shared `usePanZoom` hook
 *  - local zoom-in / zoom-out / reset buttons
 *  - asset-focus inspect search that pans/zooms to a named
 *    equipment (line or voltage-level) using the same metadata
 *    index as the rest of the NAD highlights
 *  - pin click → delegate to the existing action-select flow,
 *    which folds this view away and reveals the detailed
 *    action-variant diagram with all its existing interactions
 */
interface ActionOverviewDiagramProps {
    n1Diagram: DiagramData | null;
    n1MetaIndex: MetadataIndex | null;
    actions: Record<string, ActionDetail> | undefined;
    monitoringFactor: number;
    /**
     * Called with a pin id on a DOUBLE click — this is the
     * "activate the action drill-down view" path. The parent
     * wires it to the existing action-select flow so the action
     * network diagram replaces the overview in the tab.
     */
    onActionSelect: (actionId: string) => void;
    /** Toggle the favourite status of an action (popover action). */
    onActionFavorite?: (actionId: string) => void;
    /** Reject an action (popover action). */
    onActionReject?: (actionId: string) => void;
    /** Selected-action set — pins are highlighted with a gold star. */
    selectedActionIds?: Set<string>;
    /** Rejected-action set — pins are dimmed with a red cross. */
    rejectedActionIds?: Set<string>;
    /**
     * Called when a pin is single-clicked (preview). The parent can
     * use this to scroll the sidebar action feed to the matching card.
     */
    onPinPreview?: (actionId: string) => void;
    /** Current contingency (selected branch) — included in the auto-fit rectangle. */
    contingency: string | null;
    /** Overloaded lines in the N-1 state — included in the auto-fit rectangle. */
    overloadedLines: readonly string[];
    /** Searchable equipment ids for the inspect field. */
    inspectableItems: readonly string[];
    visible: boolean;
    /**
     * Called whenever the overview's `usePanZoom` instance changes
     * (which happens on every viewBox update, since usePanZoom
     * returns a new object identity via useMemo).  The parent stores
     * the instance in React **state** so the tied-tabs sync hook
     * sees the new viewBox in its dependency list and can propagate
     * the change bidirectionally.
     *
     * A ref-based approach doesn't work here: writing to a ref
     * doesn't trigger a re-render of App, so the sync hook's
     * `actionVb` dep stays stale and detached→main mirroring
     * never fires.
     */
    onPzChange?: (pz: ReturnType<typeof usePanZoom>) => void;
    /** Whether the action tab is currently tied (zoom-sync with main window). */
    isTied?: boolean;
    /** Toggle the tied state for the action tab. */
    onToggleTie?: () => void;
    /** Whether the action tab is currently detached (controls Tie button visibility). */
    isDetached?: boolean;
    /** Resolve an element/VL ID to its human-readable display name. */
    displayName?: (id: string) => string;
    /**
     * Active category + threshold filters shared with the ActionFeed.
     * When omitted all categories are enabled and the threshold is 1.5.
     */
    filters?: ActionOverviewFilters;
    /** Update the filter state (owned by App.tsx). */
    onFiltersChange?: (next: ActionOverviewFilters) => void;
    /**
     * Ids of scored-but-not-simulated actions the pin layer can render
     * as dimmed, dashed pins when {@link filters}.showUnsimulated is
     * enabled. Supplied by App.tsx from `result.action_scores`.
     */
    unsimulatedActionIds?: readonly string[];
    /**
     * Per-id score metadata (type, score, MW/tap start, rank in
     * category, max score in category) — when provided, enriches the
     * pin tooltip so the operator can triage un-simulated actions
     * without leaving the overview.
     */
    unsimulatedActionInfo?: Readonly<Record<string, UnsimulatedActionScoreInfo>>;
    /**
     * Kick off a manual simulation for an unsimulated action when its
     * pin is double-clicked. Expected to call the same code path as
     * the Manual Selection dropdown.
     */
    onSimulateUnsimulatedAction?: (actionId: string) => void;
}

const ZOOM_STEP_IN = 0.8;
const ZOOM_STEP_OUT = 1.25;

const scaleViewBox = (vb: ViewBox, factor: number): ViewBox => ({
    x: vb.x + (vb.w * (1 - factor)) / 2,
    y: vb.y + (vb.h * (1 - factor)) / 2,
    w: vb.w * factor,
    h: vb.h * factor,
});

const ActionOverviewDiagram: React.FC<ActionOverviewDiagramProps> = ({
    n1Diagram,
    n1MetaIndex,
    actions,
    monitoringFactor,
    onActionSelect,
    onActionFavorite,
    onActionReject,
    selectedActionIds,
    rejectedActionIds,
    onPinPreview,
    contingency,
    overloadedLines,
    inspectableItems,
    visible,
    onPzChange,
    isTied,
    onToggleTie,
    isDetached,
    displayName,
    filters,
    onFiltersChange,
    unsimulatedActionIds,
    unsimulatedActionInfo,
    onSimulateUnsimulatedAction,
}) => {
    // Normalize against DEFAULT_ACTION_OVERVIEW_FILTERS so legacy call sites that
    // predate a given field (e.g. `actionType`) don't crash the
    // matcher with `undefined`. Later shipped-filters win over the
    // defaults for the fields they set.
    const activeFilters = useMemo<ActionOverviewFilters>(() => {
        if (!filters) return DEFAULT_ACTION_OVERVIEW_FILTERS;
        return {
            ...DEFAULT_ACTION_OVERVIEW_FILTERS,
            ...filters,
            actionType: filters.actionType ?? DEFAULT_ACTION_OVERVIEW_FILTERS.actionType,
        };
    }, [filters]);
    const containerRef = useRef<HTMLDivElement | null>(null);
    // Pull the svg string into a local so the React Compiler can
    // see that both the injection effect and the initialViewBox memo
    // depend on the same primitive, not on the full `n1Diagram`
    // object identity.
    const svgSource = n1Diagram?.svg ?? null;
    // `svgReady` is derived, not stateful: svg injection happens
    // synchronously in the layout effect below (which is declared
    // BEFORE usePanZoom so its layout effect runs first, i.e. the
    // DOM is already populated by the time usePanZoom caches its
    // svgElRef). Once the source is in hand the svg IS in the DOM.
    const svgReady = svgSource != null;

    // Pre-parse the SVG string into an SVGSVGElement so the layout
    // effect below can inject it with `replaceChildren()` — zero
    // extra parse, matching the MemoizedSvgContainer optimisation
    // used by the N and N-1 tabs.  The dim-layer wrapping is done
    // here as well (moving children into a `<g>` with reduced
    // opacity) so the DOM mutation happens on the detached element
    // before it enters the live document — no forced layout.
    //
    // When `svgSource` is already a pre-parsed SVGSVGElement — the
    // case when the N-1 tab was populated via the svgPatch
    // DOM-recycling path (see docs/performance/history/svg-dom-recycling.md)
    // — skip the string round-trip entirely and clone the element.
    /* eslint-disable react-hooks/purity -- performance.now() is side-effect-free in practice (timing only) */
    const preparedSvg = useMemo<SVGSVGElement | null>(() => {
        if (!svgSource) return null;
        const start = performance.now();
        let svg: SVGSVGElement;
        if (typeof svgSource === 'string') {
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgSource, 'image/svg+xml');
            svg = doc.documentElement as unknown as SVGSVGElement;
        } else {
            // Clone so we don't detach the element from the N-1 tab.
            svg = svgSource.cloneNode(true) as SVGSVGElement;
        }
        if (!svg || svg.nodeName !== 'svg') return null;

        // Style the root so it fills the container; viewBox is the
        // only thing usePanZoom manipulates.
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        // Guard: jsdom's DOMParser returns XML documents whose
        // elements lack a `.style` property; real browsers always
        // have it.
        if (svg.style) {
            svg.style.width = '100%';
            svg.style.height = '100%';
        }

        // Dim the network background by inserting a semi-transparent
        // white <rect> that covers the entire viewBox, placed AFTER
        // all the original NAD content.  This dims everything behind
        // it without applying `opacity` to any child element — which
        // avoids creating stacking contexts (CSS per-child opacity)
        // or SVG transparency groups (SVG opacity attribute on <g>),
        // both of which force Chrome's Layerize step to composite
        // each child individually (~25-31s on large grids).
        //
        // Visual stack (back to front):
        //   1. highlight layer (inserted later by applyActionOverviewHighlights
        //      at SVG start — behind NAD, matching N-1 tab behaviour)
        //   2. original NAD content (full opacity)
        //   3. white rect overlay (opacity 0.65 → dims NAD + highlights)
        //   4. pin layer (inserted later by applyActionOverviewPins)
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const vb = svg.getAttribute('viewBox');
        if (vb) {
            const parts = vb.split(/[\s,]+/).map(Number);
            if (parts.length === 4) {
                const dimRect = document.createElementNS(SVG_NS, 'rect');
                dimRect.setAttribute('class', 'nad-overview-dim-rect');
                // Extend 10% beyond viewBox on each side to cover any
                // pan-zoom overshoot — the rect is cheap, and gaps at
                // the edges look ugly.
                const margin = Math.max(parts[2], parts[3]) * 0.1;
                dimRect.setAttribute('x', String(parts[0] - margin));
                dimRect.setAttribute('y', String(parts[1] - margin));
                dimRect.setAttribute('width', String(parts[2] + 2 * margin));
                dimRect.setAttribute('height', String(parts[3] + 2 * margin));
                dimRect.setAttribute('fill', 'white');
                dimRect.setAttribute('opacity', '0.65');
                // pointer-events: none so clicks pass through to
                // highlights/pins above OR the NAD content below.
                dimRect.setAttribute('pointer-events', 'none');
                svg.appendChild(dimRect);
            }
        }
        // Mark the SVG so highlight/pin insertion code knows the
        // dimming rect is present.
        svg.classList.add('nad-overview-dimmed');
        console.log(`[SVG] Action overview pre-parse took ${(performance.now() - start).toFixed(2)}ms`);
        return svg;
    }, [svgSource]);
    /* eslint-enable react-hooks/purity */

    // Three-pass pin build so combined-action constituents are kept
    // visible (dimmed) even when they would individually be filtered
    // out by the category/threshold header:
    //  1. Build every unitary pin unfiltered so combined pins have
    //     endpoints to anchor on.
    //  2. Build combined pins from the unfiltered set, then drop the
    //     ones that fail the overview filter themselves.
    //  3. Compute the set of unitary ids referenced by any surviving
    //     combined pin — those are "protected" from being hidden.
    //  4. Re-filter the unitary pin list: passing pins go through
    //     as-is, protected-but-failing pins come through with a
    //     `dimmedByFilter` flag, everything else is dropped.
    // Helpers that combine the severity/threshold filter AND the
    // single-select action-type chip. When `actionType` is 'all' the
    // chip check is a no-op.
    const passesAll = useCallback((id: string, det: ActionDetail) => {
        if (!actionPassesOverviewFilter(
            det, monitoringFactor,
            activeFilters.categories, activeFilters.threshold,
        )) return false;
        return matchesActionTypeFilter(activeFilters.actionType, id, det.description_unitaire, null);
    }, [monitoringFactor, activeFilters.categories, activeFilters.threshold, activeFilters.actionType]);

    const pins = useMemo(() => {
        if (!n1MetaIndex || !actions) return [];
        performance.mark('aod:buildPins:start');
        const allUnitary = buildActionOverviewPins(actions, n1MetaIndex, monitoringFactor);
        const allCombined = buildCombinedActionPins(actions, allUnitary, monitoringFactor);
        // A combined pin is considered "in scope" for the type
        // filter if EITHER constituent matches — combined actions are
        // inherently multi-type and hiding a pair because one side
        // doesn't match the chip would surprise the operator.
        const combinedPassesTypeFilter = (cp: { action1Id: string; action2Id: string }): boolean => {
            if (activeFilters.actionType === 'all') return true;
            const d1 = actions[cp.action1Id];
            const d2 = actions[cp.action2Id];
            return (
                (d1 ? matchesActionTypeFilter(activeFilters.actionType, cp.action1Id, d1.description_unitaire, null) : false)
                || (d2 ? matchesActionTypeFilter(activeFilters.actionType, cp.action2Id, d2.description_unitaire, null) : false)
            );
        };
        const protectedIds = new Set<string>();
        for (const cp of allCombined) {
            const det = actions[cp.pairId];
            if (!det) continue;
            if (actionPassesOverviewFilter(
                det, monitoringFactor,
                activeFilters.categories, activeFilters.threshold,
            ) && combinedPassesTypeFilter(cp)) {
                protectedIds.add(cp.action1Id);
                protectedIds.add(cp.action2Id);
            }
        }
        const result: typeof allUnitary = [];
        for (const p of allUnitary) {
            const det = actions[p.id];
            const passes = det ? passesAll(p.id, det) : true;
            if (activeFilters.showCombinedOnly) {
                // Combined-only mode: emit unitary pins ONLY when they
                // are constituents of a passing combined pin. Everything
                // else is dropped so the operator's focus stays on the
                // pair glyphs. Constituents come through dimmed because
                // they are context for the pair, not first-class actions.
                if (protectedIds.has(p.id)) {
                    result.push({ ...p, dimmedByFilter: true });
                }
            } else if (passes) {
                result.push(p);
            } else if (protectedIds.has(p.id)) {
                result.push({ ...p, dimmedByFilter: true });
            }
        }
        performance.mark('aod:buildPins:end');
        perfMeasure('aod:buildPins', 'aod:buildPins:start', 'aod:buildPins:end');
        return result;
    }, [n1MetaIndex, actions, monitoringFactor, activeFilters.categories, activeFilters.threshold, activeFilters.actionType, activeFilters.showCombinedOnly, passesAll]);

    const combinedPins = useMemo(() => {
        if (!actions || pins.length === 0) return [];
        // Combined pins themselves are filtered by the overview
        // header: a combined action whose severity/threshold fails
        // the filter is dropped. Unfiltered constituents on the
        // kept combined pins stay visible via the dimmed branch in
        // the `pins` memo above.
        return buildCombinedActionPins(actions, pins, monitoringFactor).filter(cp => {
            const det = actions[cp.pairId];
            if (!det) return true;
            if (!actionPassesOverviewFilter(
                det, monitoringFactor,
                activeFilters.categories, activeFilters.threshold,
            )) return false;
            if (activeFilters.actionType === 'all') return true;
            const d1 = actions[cp.action1Id];
            const d2 = actions[cp.action2Id];
            return (
                (d1 ? matchesActionTypeFilter(activeFilters.actionType, cp.action1Id, d1.description_unitaire, null) : false)
                || (d2 ? matchesActionTypeFilter(activeFilters.actionType, cp.action2Id, d2.description_unitaire, null) : false)
            );
        });
    }, [actions, pins, monitoringFactor, activeFilters.categories, activeFilters.threshold, activeFilters.actionType]);

    const unsimulatedPins = useMemo(() => {
        if (!activeFilters.showUnsimulated) return [];
        // Un-simulated actions are by definition NOT part of any
        // computed pair — drop them entirely when "combined only" is
        // active so the overview stays focused on the pair glyphs.
        if (activeFilters.showCombinedOnly) return [];
        if (!n1MetaIndex || !unsimulatedActionIds || unsimulatedActionIds.length === 0) return [];
        const simulatedIds = new Set(Object.keys(actions ?? {}));
        // Drop ids that don't match the active type chip. We rely
        // on the score-info `type` string when available; fall back
        // to the id-based heuristics in `classifyActionType`.
        const filteredIds = activeFilters.actionType === 'all'
            ? unsimulatedActionIds
            : unsimulatedActionIds.filter(id => {
                const scoreType = unsimulatedActionInfo?.[id]?.type ?? null;
                return matchesActionTypeFilter(activeFilters.actionType, id, null, scoreType);
            });
        return buildUnsimulatedActionPins(filteredIds, simulatedIds, n1MetaIndex, unsimulatedActionInfo);
    }, [activeFilters.showUnsimulated, activeFilters.showCombinedOnly, activeFilters.actionType, n1MetaIndex, unsimulatedActionIds, actions, unsimulatedActionInfo]);

    // Deterministic auto-fit rectangle derived from the bounding
    // box of contingency + overloads + pins. Recomputed whenever any
    // of those inputs changes — the new object identity propagates
    // into `usePanZoom` via its `initialViewBox` effect, which
    // re-applies the fit automatically.
    const fitRect = useMemo<ViewBox | null>(() => {
        if (!n1MetaIndex) return null;
        const allPinPositions = [...pins, ...combinedPins, ...unsimulatedPins];
        return computeActionOverviewFitRect(n1MetaIndex, contingency, overloadedLines, allPinPositions);
    }, [n1MetaIndex, contingency, overloadedLines, pins, combinedPins, unsimulatedPins]);

    // Fall back to the original NAD viewBox if we couldn't build a
    // fit rectangle (e.g. no analysis has run yet) — that way the
    // user still sees the full network the moment the tab opens.
    const initialViewBox = useMemo<ViewBox | null>(() => {
        if (fitRect) return fitRect;
        if (!svgSource) return null;
        const vbAttr = typeof svgSource === 'string'
            ? (svgSource.match(/viewBox=["']([^"']+)["']/)?.[1] ?? null)
            : svgSource.getAttribute('viewBox');
        if (!vbAttr) return null;
        const parts = vbAttr.split(/\s+|,/).map(parseFloat);
        if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return null;
        return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }, [fitRect, svgSource]);

    // Inject the pre-parsed SVGSVGElement into the container using
    // `replaceChildren()` — zero extra parse, matching the
    // MemoizedSvgContainer optimisation used by the N/N-1 tabs.
    //
    // DECLARED BEFORE `usePanZoom` so React runs this layout
    // effect first and the hook can cache its svgElRef against the
    // freshly-injected element.
    //
    // The dim-layer wrapping has already been done in `preparedSvg`
    // (off-DOM), so this effect only moves the ready element in.
    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        if (!preparedSvg) {
            container.replaceChildren();
            return;
        }
        const start = performance.now();
        container.replaceChildren(preparedSvg);
        // The id-map cache from a previous SVG is now stale.
        invalidateIdMapCache(container);
        console.log(`[SVG] Action overview replaceChildren took ${(performance.now() - start).toFixed(2)}ms`);
    }, [preparedSvg]);

    // The hook handles wheel-zoom and drag-pan on the container.
    // `active` gates the event listeners so an invisible overview
    // doesn't steal wheel events from other tabs.
    const pz = usePanZoom(containerRef, initialViewBox, visible && svgReady);

    // Notify the parent whenever the PZ instance changes.  Because
    // `usePanZoom` returns a new object on every viewBox update
    // (line 313 of usePanZoom.ts: `useMemo([viewBox, setViewBox])`),
    // this fires on every pan/zoom — which is exactly what the
    // tied-tabs sync hook needs to detect a change in the detached
    // popup and mirror it to the main window.
    useEffect(() => {
        onPzChange?.(pz);
    }, [pz, onPzChange]);

    // Asset-focus "consume once" tracking — declared up here so
    // `handleReset` (defined just below) can clear it.
    //
    // Mirrors the pattern used by `useDiagrams` for the main
    // inspect field (see `lastZoomState` and the auto-zoom
    // effect around useDiagrams.ts:787): only apply the zoom
    // when the resolved query TRANSITIONS to a new value. If we
    // re-ran the zoom on every dependency change (e.g. every
    // time `pz.viewBox` updates on wheel-zoom), the user would
    // get yanked back onto the asset the moment they try to
    // zoom out — the "sticking" bug.
    const lastFocusedRef = useRef<string | null>(null);

    // ----- Click popover -----
    // Single-click on a pin opens a floating ActionCard popover
    // anchored next to the pin in screen coordinates; double-click
    // activates the full action drill-down view (see
    // `handlePinDoubleClick`) and closes the popover.
    //
    // Placement is computed at click time from the pin's screen
    // position relative to the viewport. The popover may sit
    // ABOVE or BELOW the pin (whichever side has more room) and
    // is horizontally aligned LEFT-of, CENTERED-on, or RIGHT-of
    // the pin to avoid clipping at the visualisation panel
    // edges. See `decidePopoverPlacement` for the rules.
    const [popoverPin, setPopoverPin] = useState<{
        id: string;
        screenX: number;
        screenY: number;
        placeAbove: boolean;
        horizontalAlign: 'start' | 'center' | 'end';
    } | null>(null);
    // Viewport captured at click time so `computePopoverStyle` renders
    // the popover relative to the popup window that was actually
    // clicked — otherwise detached-window clicks would fall back to
    // the main window's dimensions (see popoverPlacement.defaultViewport).
    const [popoverViewport, setPopoverViewport] = useState<{ width: number; height: number } | null>(null);

    const handlePinClick = useCallback((actionId: string, screenPos: { x: number; y: number }) => {
        interactionLogger.record('overview_pin_clicked', { action_id: actionId });
        performance.mark('aod:pinClick:start');
        // When the overview is detached into a secondary window, the
        // container lives in that window's document — use its viewport
        // (not main-window `window.innerWidth/innerHeight`) so the
        // above/below placement reflects where the pin actually sits
        // on the user's screen. Falls back to the default (main window)
        // viewport when the ref isn't attached yet.
        const ownerWin = containerRef.current?.ownerDocument?.defaultView ?? null;
        const viewport = ownerWin
            ? { width: ownerWin.innerWidth, height: ownerWin.innerHeight }
            : undefined;
        const placement = decidePopoverPlacement(screenPos.x, screenPos.y, viewport);
        setPopoverPin({
            id: actionId,
            screenX: screenPos.x,
            screenY: screenPos.y,
            ...placement,
        });
        setPopoverViewport(viewport ?? null);
        // Scroll the sidebar action feed to the matching card so the
        // operator can see both the popover on the diagram and the full
        // card details side-by-side.
        onPinPreview?.(actionId);
        // Measure will complete after React commits the state update.
        requestAnimationFrame(() => {
            performance.mark('aod:pinClick:end');
            perfMeasure('aod:pinClick', 'aod:pinClick:start', 'aod:pinClick:end');
        });
    }, [onPinPreview]);

    const handlePinDoubleClick = useCallback((actionId: string) => {
        interactionLogger.record('overview_pin_double_clicked', { action_id: actionId });
        // Make sure no stale popover is left behind on the way
        // into the drill-down view.
        setPopoverPin(null);
        onActionSelect(actionId);
    }, [onActionSelect]);

    const handleUnsimulatedPinDoubleClick = useCallback((actionId: string) => {
        interactionLogger.record('overview_unsimulated_pin_simulated', { action_id: actionId });
        setPopoverPin(null);
        if (onSimulateUnsimulatedAction) {
            onSimulateUnsimulatedAction(actionId);
        } else {
            // Fall back on the default select path so the operator is
            // never stranded when the parent hasn't wired the simulate
            // callback yet.
            onActionSelect(actionId);
        }
    }, [onSimulateUnsimulatedAction, onActionSelect]);

    // (Re)apply contingency + overload highlights whenever the
    // contingency or the N-1 overload set changes.  Mirrors what
    // the N-1 tab shows so the operator keeps the same situational
    // awareness on the overview.  The helper inserts a dedicated
    // `.nad-overview-highlight-layer` at the START of the SVG so
    // the halos render behind the NAD content, matching the N-1
    // tab's getBackgroundLayer() pattern.
    useEffect(() => {
        if (!svgReady) return;
        const container = containerRef.current;
        if (!container) return;
        performance.mark('aod:highlights:start');
        applyActionOverviewHighlights(container, n1MetaIndex ?? null, contingency, overloadedLines);
        performance.mark('aod:highlights:end');
        perfMeasure('aod:highlights', 'aod:highlights:start', 'aod:highlights:end');
    }, [svgReady, preparedSvg, n1MetaIndex, contingency, overloadedLines]);

    // (Re)apply pins whenever the source SVG or pin list changes.
    // Pins are appended to the SVG itself (not to the container
    // div) so the existing viewBox-based pan/zoom naturally
    // transforms them with the rest of the diagram.
    useEffect(() => {
        if (!svgReady) return;
        const container = containerRef.current;
        if (!container) return;
        performance.mark('aod:applyPins:start');
        applyActionOverviewPins(container, pins, handlePinClick, handlePinDoubleClick, {
            selectedActionIds,
            rejectedActionIds,
            combinedPins,
            unsimulatedPins,
            onUnsimulatedPinDoubleClick: handleUnsimulatedPinDoubleClick,
        });
        performance.mark('aod:applyPins:end');
        perfMeasure('aod:applyPins', 'aod:applyPins:start', 'aod:applyPins:end');
    }, [pins, handlePinClick, handlePinDoubleClick, svgReady, preparedSvg, selectedActionIds, rejectedActionIds, combinedPins, unsimulatedPins, handleUnsimulatedPinDoubleClick]);

    // Screen-constant pin compensation.
    //
    // The pin glyph is drawn in SVG-space at a base radius equal to
    // the voltage-level circle radius (so at normal zoom they match
    // the VL glyphs). As the operator zooms OUT, the SVG units map
    // to fewer screen pixels and the pins would become tiny dots on
    // large grids. To fight that we upscale the pin body in
    // SVG-space whenever the viewBox changes — same spirit as the
    // non-scaling-stroke trick used on overload / contingency
    // circle halos in App.css.
    //
    // A MutationObserver on the svg's `viewBox` attribute catches
    // every update: the wheel-zoom path in usePanZoom writes the
    // DOM directly (bypassing React state for perf), so a plain
    // `pz.viewBox` useEffect dep would lag behind the live drag.
    //
    // The rescale call is rAF-throttled because the wheel-zoom and
    // drag-pan paths in usePanZoom mutate the viewBox on every
    // animation frame (and sometimes more than once per frame on
    // wheel bursts). Without throttling, large grids would call
    // `getScreenCTM()` — a forced layout — many times per frame
    // and freeze the page (the "Page ne répondant pas" we saw in
    // the field). One scheduled rescale per frame is enough.
    useEffect(() => {
        if (!svgReady || !visible) return;
        const container = containerRef.current;
        if (!container) return;
        const svg = container.querySelector('svg');
        if (!svg) return;

        // Initial compensation — pins are already mounted by the
        // applyActionOverviewPins effect above; make sure they
        // come up at the right size on the first paint.
        rescaleActionOverviewPins(container);

        let rafId: number | null = null;
        const scheduleRescale = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                rescaleActionOverviewPins(container);
            });
        };
        const observer = new MutationObserver(scheduleRescale);
        observer.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
        return () => {
            observer.disconnect();
            if (rafId !== null) cancelAnimationFrame(rafId);
        };
    }, [svgReady, visible, preparedSvg, pins]);

    // When the view becomes visible for the first time (or again
    // after a round-trip through an action drill-down), re-assert
    // the fit rectangle. Without this, a card selection + deselect
    // would leave the overview on whatever viewBox the user had
    // last panned to — surprising, because the tab is nominally
    // "opening fresh".
    const wasVisibleRef = useRef(false);
    useEffect(() => {
        if (visible && !wasVisibleRef.current) {
            interactionLogger.record('overview_shown', { has_pins: pins.length > 0, pin_count: pins.length });
            if (initialViewBox) pz.setViewBox(initialViewBox);
        } else if (!visible && wasVisibleRef.current) {
            interactionLogger.record('overview_hidden');
        }
        wasVisibleRef.current = visible;
    }, [visible, initialViewBox, pz, pins.length]);

    const handleZoomIn = useCallback(() => {
        if (!pz.viewBox) return;
        interactionLogger.record('overview_zoom_in');
        pz.setViewBox(scaleViewBox(pz.viewBox, ZOOM_STEP_IN));
    }, [pz]);

    const handleZoomOut = useCallback(() => {
        if (!pz.viewBox) return;
        interactionLogger.record('overview_zoom_out');
        pz.setViewBox(scaleViewBox(pz.viewBox, ZOOM_STEP_OUT));
    }, [pz]);

    const handleReset = useCallback(() => {
        interactionLogger.record('overview_zoom_fit');
        if (initialViewBox) pz.setViewBox(initialViewBox);
        // Clearing here ensures that re-typing the same asset id
        // after a reset will focus it again — without this the
        // consume-once guard would treat the effect re-run as
        // "nothing changed" and silently skip the zoom.
        lastFocusedRef.current = null;
    }, [initialViewBox, pz]);

    // ----- Inspect / asset-focus search -----
    // Kept deliberately local so the overview manages its own
    // focus without plumbing through the detached-tab /
    // tied-tab infrastructure of the main-window inspect field.
    const [inspectQuery, setInspectQuery] = useState('');
    const [inspectFocused, setInspectFocused] = useState(false);
    const closeTimerRef = useRef<number | null>(null);

    const filteredInspectables = useMemo(() => {
        const q = inspectQuery.toUpperCase();
        if (!q) return [] as string[];
        return inspectableItems.filter(item => item.toUpperCase().includes(q)).slice(0, 20);
    }, [inspectQuery, inspectableItems]);

    const exactInspectMatch = useMemo(() => {
        if (!inspectQuery) return null;
        const q = inspectQuery.toUpperCase();
        return inspectableItems.find(item => item.toUpperCase() === q) ?? null;
    }, [inspectQuery, inspectableItems]);

    useEffect(() => {
        if (!svgReady || !visible || !n1MetaIndex) return;
        // Nothing changed — bail out. This is the guard that
        // suppresses re-zooming when the effect re-runs because
        // `pz.viewBox` (and therefore the `pz` object) changed
        // during a user-initiated pan/zoom.
        if (exactInspectMatch === lastFocusedRef.current) return;

        if (exactInspectMatch) {
            // Consume the new query — zoom onto the asset.
            interactionLogger.record('overview_inspect_changed', { query: exactInspectMatch, action: 'focus' });
            const target = computeEquipmentFitRect(n1MetaIndex, exactInspectMatch);
            if (target) pz.setViewBox(target);
        } else if (lastFocusedRef.current && initialViewBox) {
            interactionLogger.record('overview_inspect_changed', { query: '', action: 'cleared' });
            // Query cleared (or no longer an exact match): go
            // back to the auto-fit rectangle so the user sees
            // the whole network-plus-pins again.
            pz.setViewBox(initialViewBox);
        }
        lastFocusedRef.current = exactInspectMatch;
    }, [exactInspectMatch, svgReady, visible, n1MetaIndex, pz, initialViewBox]);

    // Imperative zoom helper used by the suggestions dropdown —
    // committing the query through state triggers the effect
    // above, but the dropdown also commits the text value so
    // the click feels instantaneous without waiting for the
    // next effect tick.
    const focusEquipment = useCallback((equipmentId: string) => {
        const target = computeEquipmentFitRect(n1MetaIndex, equipmentId);
        if (target) pz.setViewBox(target);
        lastFocusedRef.current = equipmentId;
    }, [n1MetaIndex, pz]);

    const hasAnyAction = !!actions && Object.keys(actions).length > 0;
    const noBackground = !n1Diagram?.svg;

    // ----- Popover dismissal -----
    // All close paths (Escape, outside-click, ✕ button, drill-down
    // activation) route through this helper so the log entry is
    // emitted exactly once per dismiss.
    const closePopover = useCallback((reason: string) => {
        interactionLogger.record('overview_popover_closed', { reason });
        setPopoverPin(null);
        setPopoverViewport(null);
    }, []);

    const popoverRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!popoverPin) return;
        const onDocMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (popoverRef.current && target && popoverRef.current.contains(target)) return;
            if (target instanceof Element && target.closest('.nad-action-overview-pin')) return;
            closePopover('outside_click');
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closePopover('escape');
        };
        document.addEventListener('mousedown', onDocMouseDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [popoverPin, closePopover]);

    // ----- Filter controls (category toggles + threshold slider +
    //        un-simulated-pin toggle). These mutate shared filter
    //        state owned by App.tsx so the ActionFeed follows the
    //        same visibility rules.
    const pushFilters = useCallback((next: ActionOverviewFilters) => {
        onFiltersChange?.(next);
    }, [onFiltersChange]);

    // ``setThreshold`` moved to ActionFilterRings — the sidebar
    // strip now owns the Max-loading control so the overview header
    // stays single-row (avoids two-line wrap on narrow viewports).

    const toggleUnsimulated = useCallback(() => {
        const next = !activeFilters.showUnsimulated;
        interactionLogger.record('overview_unsimulated_toggled', { enabled: next });
        pushFilters({ ...activeFilters, showUnsimulated: next });
    }, [activeFilters, pushFilters]);

    const toggleCombinedOnly = useCallback(() => {
        const next = !activeFilters.showCombinedOnly;
        interactionLogger.record('overview_filter_changed', {
            kind: 'combined_only',
            enabled: next,
        });
        pushFilters({ ...activeFilters, showCombinedOnly: next });
    }, [activeFilters, pushFilters]);

    // Pre-compute the props ActionCard needs for the popover render.
    const popoverDetails = popoverPin && actions ? actions[popoverPin.id] : null;
    const popoverIndex = useMemo(() => {
        if (!popoverPin || !actions) return 0;
        const keys = Object.keys(actions);
        const idx = keys.indexOf(popoverPin.id);
        return idx < 0 ? 0 : idx;
    }, [popoverPin, actions]);
    // ActionCardPopover wraps the no-op stubs for the
    // re-simulate / asset-click callbacks internally — we only
    // need to pass the minimal set of handlers below.
    const showInspectDropdown = inspectFocused
        && inspectQuery.length > 0
        && filteredInspectables.length > 0
        && !exactInspectMatch;

    return (
        <div
            data-testid="action-overview-diagram"
            style={{
                position: 'absolute',
                inset: 0,
                display: visible ? 'flex' : 'none',
                flexDirection: 'column',
                background: colors.diagramSurface,
                // Sit above the hidden MemoizedSvgContainer for
                // actionDiagram (which stays mounted to preserve
                // zoom state) so clicks land on the overview.
                zIndex: 15,
            }}
        >
            {/* Single-row header: compact pin counter + the
                threshold / show-unsimulated / combined-only filters.
                The severity (action-card colour) toggles and the
                action-type chips were removed — they are now driven
                solely by the sidebar's ActionFilterRings, which writes
                the same shared `overviewFilters` this view consumes. */}
            <div
                data-testid="action-overview-header"
                style={{
                    flexShrink: 0,
                    padding: '4px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'nowrap',
                    gap: '6px',
                    fontSize: '12px',
                    background: colors.surfaceMuted,
                    borderBottom: `1px solid ${colors.borderSubtle}`,
                    color: colors.textPrimary,
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                }}
            >
                {hasAnyAction && (
                    <span
                        data-testid="overview-pin-counter"
                        title={`${pins.length} pin${pins.length === 1 ? '' : 's'} on the N-1 network${unsimulatedPins.length > 0 ? ` (+ ${unsimulatedPins.length} un-simulated)` : ''}`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: colors.textPrimary, flexShrink: 0 }}
                    >
                        <span aria-hidden>{'\uD83D\uDCCD'}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {pins.length}
                            {unsimulatedPins.length > 0 ? ` (+${unsimulatedPins.length})` : ''}
                        </span>
                    </span>
                )}
                {/* Max-loading threshold now lives in the sidebar
                    ``ActionFilterRings`` strip alongside the severity
                    + action-type rings, so the overview header no
                    longer renders its own copy. */}
                <label
                    data-testid="filter-show-unsimulated"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', flexShrink: 0 }}
                    title="Show scored-but-not-yet-simulated actions as dimmed pins. Double-click a dimmed pin to run its simulation."
                >
                    <input
                        type="checkbox"
                        checked={activeFilters.showUnsimulated}
                        onChange={toggleUnsimulated}
                    />
                    <span style={{ color: colors.textSecondary }}>Show unsimulated</span>
                </label>
                <label
                    data-testid="filter-combined-only"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', flexShrink: 0 }}
                    title="Show only pins related to combined actions (computed pairs). Constituents stay on the graph dimmed for context."
                >
                    <input
                        type="checkbox"
                        checked={activeFilters.showCombinedOnly}
                        onChange={toggleCombinedOnly}
                    />
                    <span style={{ color: colors.textSecondary }}>Combined only</span>
                </label>
            </div>

            {/* SVG body: the pan/zoom container. Wheel + drag work
                via usePanZoom listeners bound in useEffect. */}
            <div
                ref={containerRef}
                className="svg-container nad-action-overview-container"
                style={{
                    flex: 1,
                    overflow: 'hidden',
                    position: 'relative',
                }}
            />

            {/* Bottom-left control cluster: zoom buttons + inspect
                search. Rendered inside the overview's own flex
                layout (not via renderTabOverlay) so they are
                trivially shown/hidden with the overview itself. */}
            {svgReady && visible && (
                <div
                    data-testid="overview-controls"
                    style={{
                        position: 'absolute',
                        bottom: 12,
                        left: 12,
                        zIndex: 100,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        alignItems: 'flex-start',
                        pointerEvents: 'none',
                    }}
                >
                    {isDetached && onToggleTie && (
                        <div style={{ pointerEvents: 'auto' }}>
                            <button
                                data-testid="overview-tie-button"
                                onClick={onToggleTie}
                                title={isTied
                                    ? 'Untie: pan/zoom and asset focus no longer mirror between this window and the main window'
                                    : 'Tie: pan/zoom and asset focus will be mirrored between this window and the main window\'s active tab'}
                                style={{
                                    ...controlButtonStyle,
                                    padding: '4px 10px',
                                    fontSize: 12,
                                    border: `1px solid ${isTied ? colors.brand : colors.border}`,
                                    backgroundColor: isTied ? colors.brandSoft : colors.surface,
                                    color: isTied ? colors.brand : colors.textSecondary,
                                }}
                            >
                                {isTied ? '\u{1F517} Tied' : '\u{26D3} Tie'}
                            </button>
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', pointerEvents: 'auto' }}>
                        <button
                            onClick={handleZoomIn}
                            title="Zoom In"
                            style={controlButtonStyle}
                        >
                            +
                        </button>
                        <button
                            onClick={handleReset}
                            title="Reset view to auto-fit (contingency + overloads + pins)"
                            style={{ ...controlButtonStyle, padding: '5px 14px', fontSize: 12 }}
                        >
                            {'\uD83D\uDD0D Unzoom'}
                        </button>
                        <button
                            onClick={handleZoomOut}
                            title="Zoom Out"
                            style={controlButtonStyle}
                        >
                            -
                        </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', position: 'relative', pointerEvents: 'auto' }}>
                        <div style={{ position: 'relative' }}>
                            <input
                                data-testid="overview-inspect-input"
                                value={inspectQuery}
                                onChange={e => setInspectQuery(e.target.value)}
                                onFocus={() => {
                                    if (closeTimerRef.current !== null) {
                                        window.clearTimeout(closeTimerRef.current);
                                        closeTimerRef.current = null;
                                    }
                                    setInspectFocused(true);
                                }}
                                onBlur={() => {
                                    closeTimerRef.current = window.setTimeout(() => {
                                        setInspectFocused(false);
                                        closeTimerRef.current = null;
                                    }, 150);
                                }}
                                placeholder="🔍 Focus asset..."
                                style={{
                                    padding: '5px 10px',
                                    border: inspectQuery ? `2px solid ${colors.brand}` : `1px solid ${colors.border}`,
                                    borderRadius: 4,
                                    fontSize: 12,
                                    width: 180,
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                    background: colors.surface,
                                    color: colors.textPrimary,
                                }}
                            />
                            {showInspectDropdown && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        bottom: '100%',
                                        left: 0,
                                        marginBottom: 4,
                                        width: 220,
                                        maxHeight: 220,
                                        overflowY: 'auto',
                                        background: colors.surface,
                                        color: colors.textPrimary,
                                        border: `1px solid ${colors.brand}`,
                                        borderRadius: 4,
                                        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                                        zIndex: 200,
                                        fontSize: 12,
                                    }}
                                >
                                    {filteredInspectables.map(item => (
                                        <div
                                            key={item}
                                            onMouseDown={e => {
                                                e.preventDefault();
                                                setInspectQuery(item);
                                                focusEquipment(item);
                                            }}
                                            style={{
                                                padding: '5px 10px',
                                                cursor: 'pointer',
                                                borderBottom: `1px solid ${colors.borderSubtle}`,
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                            }}
                                            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.brandSoft; }}
                                            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.surface; }}
                                        >
                                            {item}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        {inspectQuery && (
                            <button
                                onClick={() => setInspectQuery('')}
                                style={{
                                    background: colors.danger, color: colors.textOnBrand, border: 'none',
                                    borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
                                    fontSize: 12, boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                                }}
                                title="Clear"
                            >
                                X
                            </button>
                        )}
                    </div>
                </div>
            )}

            {noBackground && (
                <div style={{
                    position: 'absolute', inset: 0, top: 40,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: colors.textTertiary, fontStyle: 'italic', textAlign: 'center', padding: '40px',
                    pointerEvents: 'none',
                }}>
                    Load a contingency first, then run the analysis to populate this overview.
                </div>
            )}
            {!noBackground && !hasAnyAction && (
                <div style={{
                    position: 'absolute', inset: 0, top: 40,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: colors.textTertiary, fontStyle: 'italic', textAlign: 'center', padding: '40px',
                    pointerEvents: 'none',
                }}>
                    Run &ldquo;Analyze &amp; Suggest&rdquo; to see prioritised remedial actions as pins on the network.
                </div>
            )}

            {/*
              Click popover.
              - Position is fixed (not absolute) because the
                click handler captured screen-space coordinates
                at click time, and we want the popover to land
                exactly next to the pin the operator clicked.
              - `portaled` via React means the popover sits in
                the same React tree as the overview, so React
                owns its lifecycle and we don't need a separate
                reconciliation root.
              - Outside clicks, Escape, and popover close button
                all dismiss it via setPopoverPin(null).
            */}
            {/*
              Popover.
              The ActionCard rendered inside the popover is the
              EXACT SAME `ActionCard` component the sidebar feed
              uses — both callsites import from the same module.
              The `ActionCardPopover` wrapper handles the floating
              chrome (position, close button, shadow) and forwards
              the minimal set of callbacks this preview view
              needs, so when we add or rename a field on
              `ActionCard` we only need to update the feed's
              render call and the popover wrapper — never
              two parallel implementations.
            */}
            {visible && popoverPin && popoverDetails && (
                <ActionCardPopover
                    popoverRef={popoverRef}
                    testId="action-overview-popover"
                    extraDataAttributes={{
                        'data-place-above': popoverPin.placeAbove ? 'true' : 'false',
                        'data-horizontal-align': popoverPin.horizontalAlign,
                    }}
                    actionId={popoverPin.id}
                    details={popoverDetails}
                    index={popoverIndex}
                    style={{
                        ...computePopoverStyle(popoverPin, popoverViewport ?? undefined),
                        width: POPOVER_WIDTH,
                        maxHeight: POPOVER_MAX_HEIGHT,
                        overflowY: 'auto',
                    }}
                    linesOverloaded={overloadedLines}
                    monitoringFactor={monitoringFactor}
                    metaIndex={n1MetaIndex ?? null}
                    selectedActionIds={selectedActionIds}
                    rejectedActionIds={rejectedActionIds}
                    onActivateAction={onActionSelect}
                    onActionFavorite={onActionFavorite}
                    onActionReject={onActionReject}
                    onClose={() => closePopover('close_button')}
                    displayName={displayName}
                />
            )}
        </div>
    );
};

const controlButtonStyle: React.CSSProperties = {
    background: colors.surface,
    color: colors.textPrimary,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
};

export default React.memo(ActionOverviewDiagram);
