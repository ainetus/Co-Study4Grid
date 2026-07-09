// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  applyContingencyHighlight,
  applyDeltaVisuals,
  applyOverloadedHighlights,
  applyActionTargetHighlights,
} from '../utils/svgUtils';
import { computeN1OverloadHighlights } from '../utils/overloadHighlights';
import { interactionLogger } from '../utils/interactionLogger';
import type { AnalysisResult, TabId } from '../types';
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
}

/**
 * Owns the per-tab SVG highlighting pipeline:
 *
 *   - Per-tab Flow/Impacts view-mode state (`detachedViewModes` +
 *     `viewModeForTab`). Each detached popup keeps its own entry so
 *     toggling Impacts in a detached window leaves the main window's
 *     mode untouched, and reattaching drops the detached entry.
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
 * Re-exports `viewModeForTab` / `handleViewModeChangeForTab` so App
 * can pass them down to `<VisualizationPanel>`.
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
    selectedActionId, actionViewMode,
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

  // On reattach, drop the tab's detached view-mode entry so the main
  // window's `actionViewMode` takes over for that tab from that
  // point onward. Computed off a ref to avoid an effect→state cycle
  // on every render. The setState call is guarded by a stale check,
  // but the react-hooks `set-state-in-effect` rule can't see through
  // that (it bans setState in effects categorically), and the behavior
  // — a re-detach after reattach must restart from the main-window
  // mode rather than resume the previous detached mode — must be
  // preserved byte-for-byte, so we suppress the rule for this one call.
  const detachedViewModesRef = useRef(detachedViewModes);
  useLayoutEffect(() => { detachedViewModesRef.current = detachedViewModes; }, [detachedViewModes]);
  useEffect(() => {
    const current = detachedViewModesRef.current;
    let hasStale = false;
    for (const tabId of Object.keys(current) as TabId[]) {
      if (!detachedTabs[tabId]) { hasStale = true; break; }
    }
    if (!hasStale) return;
    const next: Partial<Record<TabId, 'network' | 'delta'>> = {};
    for (const tabId of Object.keys(current) as TabId[]) {
      if (detachedTabs[tabId]) next[tabId] = current[tabId];
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preserves the reattach-prune behavior from the pre-extraction App.tsx; guarded by the hasStale short-circuit above.
    setDetachedViewModes(next);
  }, [detachedTabs]);

  const applyHighlightsForTab = useCallback((tab: TabId, mode?: 'network' | 'delta') => {
    const effectiveMode = mode ?? viewModeForTab(tab);
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
        applyDeltaVisuals(diagrams.n1SvgContainerRef.current, n1Diagram, diagrams.n1MetaIndex, effectiveMode === 'delta');
      }
    }
    if (tab === 'action') {
      const actionDetail = result?.actions?.[selectedActionId || ''];

      if (actionDetail) {
        // Same ordering rule as the N-1 tab: clone-based highlights
        // first (so they capture pristine elements), delta visuals
        // last. Overload halos render in both Flows and Impacts modes.
        //
        // ActionCard severity classification (`components/ActionCard.tsx:76-78`):
        //   - red:    `max_rho > monitoringFactor`         ("Still overloaded")
        //   - orange: `max_rho > monitoringFactor - 0.05`  ("Solved — low margin")
        //   - green:  else                                 ("Solves overload")
        // When the card says "Solved" (orange or green) no line in the
        // post-action state exceeds the operator's tolerance threshold,
        // so overload halos on the NAD contradict the card's label.
        // The backend's manual-simulation path flags `lines_overloaded_after`
        // on raw rho >= monitoring_factor (0.95) whereas the analysis
        // path uses raw rho >= 1.0 (`analysis_mixin.py:97` vs
        // `simulation_mixin.py:536`). In the low-margin band — raw rho
        // in `[mf, 1.0)` — the two paths disagree: manual ships a
        // non-empty list, analysis ships an empty one. Without this
        // gate, halos appear on manual low-margin actions but not on
        // suggested ones with the same displayed max_rho — the exact
        // user-reported bug (commit-time 2026-04-20).
        const isSolved =
          actionDetail.max_rho != null && actionDetail.max_rho <= monitoringFactor;

        let overloadsToHighlight: string[] = [];

        if (!isSolved) {
          if (actionDetail.lines_overloaded_after && actionDetail.lines_overloaded_after.length > 0) {
            overloadsToHighlight = actionDetail.lines_overloaded_after;
          } else {
            // Fallback for legacy results or actions without full enrichment
            if (overloadedLines.length > 0 && actionDetail.rho_after) {
              overloadedLines.forEach((name, i) => {
                const rho = actionDetail.rho_after![i];
                if (rho != null && rho > monitoringFactor) {
                  overloadsToHighlight.push(name);
                }
              });
            }
            if (actionDetail.max_rho != null && actionDetail.max_rho > monitoringFactor && actionDetail.max_rho_line) {
              if (!overloadsToHighlight.includes(actionDetail.max_rho_line)) {
                overloadsToHighlight.push(actionDetail.max_rho_line);
              }
            }
          }
        }

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
      applyDeltaVisuals(diagrams.actionSvgContainerRef.current, actionDiagram, diagrams.actionMetaIndex, effectiveMode === 'delta');
    }
    // QW14: depend on the SPECIFIC `diagrams` members this callback reads, not
    // the whole `diagrams` object — its identity churns on every pan/zoom
    // settle (nPZ/n1PZ/actionPZ change), which re-created this callback and
    // re-fired the driving effect below, re-running the whole highlight
    // pipeline on every gesture end. The two *SvgContainerRef values are stable
    // ref objects and the two *MetaIndex values are memoized off diagram
    // metadata, so no legitimate trigger is lost (the driving effect also lists
    // nDiagram/n1Diagram/actionDiagram + the metaIndexes directly).
  }, [n1Diagram, actionDiagram, result, selectedActionId, selectedContingency,
      diagrams.n1SvgContainerRef, diagrams.actionSvgContainerRef,
      diagrams.n1MetaIndex, diagrams.actionMetaIndex,
      monitoringFactor, viewModeForTab, selectedOverloads]);

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
  }, [nDiagram, n1Diagram, actionDiagram, diagrams.nMetaIndex, diagrams.n1MetaIndex, diagrams.actionMetaIndex, result, selectedActionId, actionViewMode, detachedViewModes, detachedTabs, activeTab, selectedContingency, selectedOverloads, applyHighlightsForTab]);

  return { viewModeForTab, handleViewModeChangeForTab };
}
