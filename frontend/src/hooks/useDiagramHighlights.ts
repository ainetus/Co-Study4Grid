// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  applyContingencyHighlight,
  applyDeltaVisuals,
  applyLoadingVisuals,
  applyOverloadedHighlights,
  applyActionTargetHighlights,
} from '../utils/svgUtils';
import { computeActionOverloadHighlights, computeN1OverloadHighlights } from '../utils/overloadHighlights';
import { interactionLogger } from '../utils/interactionLogger';
import type { AnalysisResult, BranchLabelControls, DiagramData, FlowMetric, MetadataIndex, TabId, ViewMode } from '../types';
import type { DiagramsState } from './useDiagrams';

interface UseDiagramHighlightsArgs {
  diagrams: DiagramsState;
  result: AnalysisResult | null;
  selectedContingency: string[];
  selectedOverloads: Set<string>;
  monitoringFactor: number;
  detachedTabs: Partial<Record<TabId, unknown>>;
}

interface UseDiagramHighlightsReturn {
  viewModeForTab: (tab: TabId) => 'network' | 'delta';
  handleViewModeChangeForTab: (tab: TabId, mode: 'network' | 'delta') => void;
  flowMetricForTab: (tab: TabId) => FlowMetric;
  handleFlowMetricChangeForTab: (tab: TabId, metric: FlowMetric) => void;
  /** The readable flow labels: each NAD tab's metadata index and the mid-branch values toggle. */
  branchLabels: BranchLabelControls;
}

/**
 * Branch colours + flow labels of one NAD: Flows / Impacts × active power /
 * loading rate. The P-delta pass always runs first — it restores the
 * original labels and owns the `nad-delta-*` classes the loading view of
 * Impacts reuses (see `applyLoadingVisuals`).
 */
function applyFlowVisuals(
  container: HTMLElement | null,
  diagram: DiagramData | null,
  metaIndex: MetadataIndex | null,
  mode: ViewMode,
  metric: FlowMetric,
  monitoringFactor: number,
) {
  applyDeltaVisuals(container, diagram, metaIndex, mode === 'delta' && metric === 'p');
  applyLoadingVisuals(container, diagram, metaIndex, metric === 'loading' ? mode : null, monitoringFactor);
}

/**
 * Owns the per-tab SVG highlighting pipeline:
 *
 *   - Per-tab Flow/Impacts view-mode state (`detachedViewModes` +
 *     `viewModeForTab`). Each detached popup keeps its own entry so
 *     toggling Impacts in a detached window leaves the main window's
 *     mode untouched, and reattaching drops the detached entry. The
 *     active power / loading-rate metric (`flowMetricForTab`) is scoped
 *     the same way.
 *   - `applyHighlightsForTab` — the DOM mutation pass that adds
 *     overload halos, contingency highlights, action-target halos,
 *     and delta visuals to the N-1 and action SVGs. Ordering matters:
 *     clone-based highlights MUST run BEFORE `applyDeltaVisuals`
 *     because delta classes on the original element poison the
 *     cascade of the cloned highlight layer. See the inline comment
 *     in this hook for the full cascade-ordering rationale.
 *   - The driving useEffect that fans the highlight pass across the
 *     main-window active tab AND every detached tab, guarded by a
 *     double-rAF on tab switches so `getScreenCTM()` reads settled
 *     layout.
 *
 * Re-exports `viewModeForTab` / `handleViewModeChangeForTab` (and their
 * flow-metric twins) so App can pass them down to `<VisualizationPanel>`.
 */
export function useDiagramHighlights({
  diagrams,
  result,
  selectedContingency,
  selectedOverloads,
  monitoringFactor,
  detachedTabs,
}: UseDiagramHighlightsArgs): UseDiagramHighlightsReturn {
  const {
    activeTab, nDiagram, n1Diagram, actionDiagram,
    selectedActionId, actionViewMode, flowMetric,
  } = diagrams;

  const staleHighlights = useRef<Set<TabId>>(new Set());
  const prevHighlightTabRef = useRef<TabId>(activeTab);

  // Flow vs Impacts view mode is TAB-SCOPED and WINDOW-SCOPED: main
  // window has `actionViewMode` (from useDiagrams) while each
  // detached tab has its own entry here. Toggling Impacts in a
  // detached popup therefore only affects that popup's tab; the
  // main window's mode is untouched, and vice versa. A reattach
  // clears the detached-mode entry so the tab resumes the
  // main-window mode from that point onward.
  const [detachedViewModes, setDetachedViewModes] = useState<Partial<Record<TabId, 'network' | 'delta'>>>({});

  const viewModeForTab = useCallback((tab: TabId): 'network' | 'delta' => {
    if (detachedTabs[tab]) return detachedViewModes[tab] ?? 'network';
    return actionViewMode;
  }, [detachedTabs, detachedViewModes, actionViewMode]);

  const handleViewModeChangeForTab = useCallback((tab: TabId, mode: 'network' | 'delta') => {
    interactionLogger.record('view_mode_changed', { mode, tab, scope: detachedTabs[tab] ? 'detached' : 'main' });
    if (detachedTabs[tab]) {
      setDetachedViewModes(prev => ({ ...prev, [tab]: mode }));
    } else {
      diagrams.setActionViewMode(mode);
    }
  }, [detachedTabs, diagrams]);

  // Active power vs loading rate: same window scoping as the view mode.
  const [detachedFlowMetrics, setDetachedFlowMetrics] = useState<Partial<Record<TabId, FlowMetric>>>({});

  const flowMetricForTab = useCallback((tab: TabId): FlowMetric => {
    if (detachedTabs[tab]) return detachedFlowMetrics[tab] ?? 'p';
    return flowMetric;
  }, [detachedTabs, detachedFlowMetrics, flowMetric]);

  const handleFlowMetricChangeForTab = useCallback((tab: TabId, metric: FlowMetric) => {
    interactionLogger.record('flow_metric_changed', { metric, tab, scope: detachedTabs[tab] ? 'detached' : 'main' });
    if (detachedTabs[tab]) {
      setDetachedFlowMetrics(prev => ({ ...prev, [tab]: metric }));
    } else {
      diagrams.setFlowMetric(metric);
    }
  }, [detachedTabs, diagrams]);

  // On reattach, drop the tab's detached view-mode and flow-metric
  // entries so the main window's state takes over for that tab from
  // that point onward — a re-detach after reattach restarts from the
  // main-window mode rather than resuming the previous detached one.
  // Computed off refs to avoid an effect→state cycle on every render;
  // each setState is guarded by the stale check in prune().
  const detachedViewModesRef = useRef(detachedViewModes);
  useLayoutEffect(() => { detachedViewModesRef.current = detachedViewModes; }, [detachedViewModes]);
  const detachedFlowMetricsRef = useRef(detachedFlowMetrics);
  useLayoutEffect(() => { detachedFlowMetricsRef.current = detachedFlowMetrics; }, [detachedFlowMetrics]);
  useEffect(() => {
    const prune = <T,>(current: Partial<Record<TabId, T>>): Partial<Record<TabId, T>> | null => {
      if ((Object.keys(current) as TabId[]).every(tabId => detachedTabs[tabId])) return null;
      const next: Partial<Record<TabId, T>> = {};
      for (const tabId of Object.keys(current) as TabId[]) {
        if (detachedTabs[tabId]) next[tabId] = current[tabId];
      }
      return next;
    };
    const nextModes = prune(detachedViewModesRef.current);
    if (nextModes) setDetachedViewModes(nextModes);
    const nextMetrics = prune(detachedFlowMetricsRef.current);
    if (nextMetrics) setDetachedFlowMetrics(nextMetrics);
  }, [detachedTabs]);

  const applyHighlightsForTab = useCallback((tab: TabId, mode?: 'network' | 'delta') => {
    const effectiveMode = mode ?? viewModeForTab(tab);
    const metric = flowMetricForTab(tab);
    const overloadedLines = result?.lines_overloaded || [];

    // For the N-1 tab, the overloads are known as soon as the N-1
    // diagram comes back from the backend (`n1Diagram.lines_overloaded`)
    // — well before any action analysis has run. Falling back to that
    // list lets the orange overload halos show up immediately on the
    // N-1 view, matching the standalone interface and what the user
    // expects to see right after picking a contingency. Once analysis
    // runs and `result.lines_overloaded` becomes available, we use that.
    // In both cases the user's selected-overload set (from the
    // Overloads panel) further filters the list down.
    const n1OverloadedLines = computeN1OverloadHighlights(
      overloadedLines,
      n1Diagram?.lines_overloaded,
      selectedOverloads,
    );

    if (tab === 'n') {
      applyFlowVisuals(diagrams.nSvgContainerRef.current, nDiagram, diagrams.nMetaIndex, effectiveMode, metric, monitoringFactor);
    }
    if (tab === 'contingency') {
      if (diagrams.n1SvgContainerRef.current) {
        // IMPORTANT: run highlight CLONES before applyDeltaVisuals.
        // The clone-based highlights (`applyOverloadedHighlights`,
        // `applyContingencyHighlight`) use cloneNode(true) on the
        // original SVG element. If applyDeltaVisuals has already
        // tagged the original with `nad-delta-positive/negative/grey`,
        // the clone inherits that class — and because the `.nad-delta-*`
        // CSS is declared LATER in App.css than `.nad-contingency-highlight`
        // / `.nad-overloaded`, the delta rule wins the cascade and the
        // halo becomes a thin orange/blue stroke, effectively making the
        // highlight disappear in Impacts mode. Cloning first guarantees
        // the halos stay on a pristine copy of the element.
        //
        // Stacking order (SVG draws later-appended clones ON TOP):
        // contingency halo appended FIRST (bottom) → overload halos
        // appended SECOND (on top). Matches the product spec
        // "action halo > overload halo > contingency halo".
        //
        // Overloaded lines must also be highlighted in BOTH Flows and
        // Impacts modes — the user looks at the Impacts view to see how
        // the action redistributes flows AND which lines are still
        // (or newly) overloaded; suppressing the halos in delta mode
        // hides exactly that information.
        applyContingencyHighlight(diagrams.n1SvgContainerRef.current, diagrams.n1MetaIndex, selectedContingency);
        if (diagrams.n1MetaIndex && n1OverloadedLines.length > 0) {
          applyOverloadedHighlights(diagrams.n1SvgContainerRef.current, diagrams.n1MetaIndex, n1OverloadedLines);
        }
        applyFlowVisuals(diagrams.n1SvgContainerRef.current, n1Diagram, diagrams.n1MetaIndex, effectiveMode, metric, monitoringFactor);
      }
    }
    if (tab === 'action') {
      const actionDetail = result?.actions?.[selectedActionId || ''];

      if (actionDetail) {
        // Same ordering rule as the N-1 tab: clone-based highlights
        // first (so they capture pristine elements), delta visuals
        // last. Overload halos render in both Flows and Impacts modes.
        // The list (empty when the card says "Solved") is shared with
        // the action SLD — see `computeActionOverloadHighlights`.
        const overloadsToHighlight = computeActionOverloadHighlights(
          actionDetail, overloadedLines, monitoringFactor,
        );

        // Stacking order (SVG draws later-appended clones ON TOP):
        // contingency halo appended FIRST (bottom), overload halos
        // SECOND (middle), action-target halo THIRD (top). Matches
        // the product spec "action halo > overload halo > contingency
        // halo".
        if (diagrams.actionSvgContainerRef.current) {
          applyContingencyHighlight(diagrams.actionSvgContainerRef.current, diagrams.actionMetaIndex, selectedContingency);
        }

        if (diagrams.actionSvgContainerRef.current && diagrams.actionMetaIndex) {
          applyOverloadedHighlights(diagrams.actionSvgContainerRef.current, diagrams.actionMetaIndex, overloadsToHighlight);
        }

        if (diagrams.actionSvgContainerRef.current) {
          applyActionTargetHighlights(diagrams.actionSvgContainerRef.current, diagrams.actionMetaIndex, actionDetail, selectedActionId);
        }
      }
      else {
        if (diagrams.actionSvgContainerRef.current) {
          applyActionTargetHighlights(diagrams.actionSvgContainerRef.current, null, null, null);
        }
      }

      // Delta visuals run LAST so they decorate the originals without
      // contaminating the highlight clones already in the background
      // layer.
      applyFlowVisuals(diagrams.actionSvgContainerRef.current, actionDiagram, diagrams.actionMetaIndex, effectiveMode, metric, monitoringFactor);
    }
    // QW14: depend on the SPECIFIC `diagrams` members this callback reads, not
    // the whole `diagrams` object — its identity churns on every pan/zoom
    // settle (nPZ/n1PZ/actionPZ change), which re-created this callback and
    // re-fired the driving effect below, re-running the whole highlight
    // pipeline on every gesture end. The two *SvgContainerRef values are stable
    // ref objects and the two *MetaIndex values are memoized off diagram
    // metadata, so no legitimate trigger is lost (the driving effect also lists
    // nDiagram/n1Diagram/actionDiagram + the metaIndexes directly).
  }, [nDiagram, n1Diagram, actionDiagram, result, selectedActionId, selectedContingency,
      diagrams.nSvgContainerRef, diagrams.n1SvgContainerRef, diagrams.actionSvgContainerRef,
      diagrams.nMetaIndex, diagrams.n1MetaIndex, diagrams.actionMetaIndex,
      monitoringFactor, viewModeForTab, flowMetricForTab, selectedOverloads]);

  useEffect(() => {
    const isTabSwitch = prevHighlightTabRef.current !== activeTab;
    prevHighlightTabRef.current = activeTab;
    const otherTabs: TabId[] = ['n', 'contingency', 'action'].filter(t => t !== activeTab) as TabId[];
    otherTabs.forEach(t => staleHighlights.current.add(t));

    // Apply highlights + delta visuals to both the main window's
    // active tab AND every currently-detached tab — because Impacts
    // mode must keep working inside a detached popup when only the
    // popup's view mode changes (the main window may be showing a
    // different tab entirely).
    const applyAll = () => {
      applyHighlightsForTab(activeTab);
      staleHighlights.current.delete(activeTab);
      for (const detachedId of Object.keys(detachedTabs) as TabId[]) {
        if (detachedId === activeTab) continue;
        if (detachedId === 'overflow') continue;
        applyHighlightsForTab(detachedId);
        staleHighlights.current.delete(detachedId);
      }
    };

    if (isTabSwitch) {
      // Double rAF to ensure browser layout is settled before getScreenCTM()
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          applyAll();
        });
      });
      return () => cancelAnimationFrame(id);
    } else {
      applyAll();
    }
  }, [nDiagram, n1Diagram, actionDiagram, diagrams.nMetaIndex, diagrams.n1MetaIndex, diagrams.actionMetaIndex, result, selectedActionId, actionViewMode, detachedViewModes, flowMetric, detachedFlowMetrics, detachedTabs, activeTab, selectedContingency, selectedOverloads, applyHighlightsForTab]);

  // The values at the middle of the branches (zoomed out): every tab and window alike, like the VL names.
  const [showMidValues, setShowMidValues] = useState(true);
  const onToggleMidValues = useCallback((show: boolean) => {
    interactionLogger.record('value_labels_toggled', { show });
    setShowMidValues(show);
  }, []);
  const branchLabels = useMemo<BranchLabelControls>(() => ({
    metaIndexes: { n: diagrams.nMetaIndex, contingency: diagrams.n1MetaIndex, action: diagrams.actionMetaIndex },
    showMidValues, onToggleMidValues,
  }), [diagrams.nMetaIndex, diagrams.n1MetaIndex, diagrams.actionMetaIndex, showMidValues, onToggleMidValues]);

  return { viewModeForTab, handleViewModeChangeForTab, flowMetricForTab, handleFlowMetricChangeForTab, branchLabels };
}
