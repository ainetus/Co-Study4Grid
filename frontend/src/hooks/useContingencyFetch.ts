// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useEffect, useRef } from 'react';
import { api } from '../api';
import { cloneBaseSvg, applyPatchToClone, patchDiagramFields } from '../utils/svgPatch';
import { processSvg } from '../utils/svgUtils';
import type { DiagramsState } from './useDiagrams';
import type { ConfirmDialogState } from '../components/modals/ConfirmationDialog';

interface UseContingencyFetchArgs {
  /** Ordered list of element IDs disconnected for the current contingency. */
  selectedContingency: string[];
  branches: string[];
  voltageLevelsLength: number;
  diagrams: DiagramsState;
  analysisLoading: boolean;
  hasAnalysisState: () => boolean;
  clearContingencyState: () => void;
  setSelectedContingency: (v: string[]) => void;
  setConfirmDialog: (v: ConfirmDialogState) => void;
  setError: (v: string) => void;
  /**
   * The study has a Context tab: a new contingency opens there first —
   * itself and its overloads, with their loading, on the situation map —
   * and the N-1 tab glows once its diagram is ready.
   */
  contextFirst?: boolean;
}

const sameElements = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Drives the contingency diagram fetch whenever the user commits a
 * contingency (or when a session reload rehydrates
 * ``selectedContingency`` under an analysis result that pre-exists the
 * diagram). Owns two paths:
 *
 *   1. Fast svgPatch DOM-recycling path — clone the N-state SVG and
 *      mutate only what changed (dashed disconnected lines, flow labels,
 *      overload halos). Avoids a fresh ~20 MB NAD fetch on large grids.
 *      See docs/performance/history/svg-dom-recycling.md.
 *
 *   2. Full ``/api/contingency-diagram`` fallback — used when the base
 *      N SVG is not yet mounted, the backend rejects the patch
 *      (``patchable: false``), the patch throws, or we're restoring a
 *      saved session (the reload contract mandates a full-fetch
 *      round-trip).
 *
 * The effect also routes through the contingency-change confirmation
 * dialog when a study is already loaded, and short-circuits when the
 * fetch for the current ``selectedContingency`` is already done / in
 * flight — the EXCEPT clause that keeps session-restore from being
 * silently skipped is ``diagrams.restoringSessionRef.current``.
 */
export function useContingencyFetch({
  selectedContingency,
  branches,
  voltageLevelsLength,
  diagrams,
  analysisLoading,
  hasAnalysisState,
  clearContingencyState,
  setSelectedContingency,
  setConfirmDialog,
  setError,
  contextFirst = false,
}: UseContingencyFetchArgs): void {
  const { n1Diagram, n1Loading, nDiagram } = diagrams;
  // Read when a contingency is committed — not a reason to refetch.
  const contextFirstRef = useRef(contextFirst);
  useEffect(() => { contextFirstRef.current = contextFirst; }, [contextFirst]);

  useEffect(() => {
    if (selectedContingency.length === 0) {
      diagrams.setN1Diagram(null);
      if (!hasAnalysisState()) {
        diagrams.committedBranchRef.current = [];
      }
      return;
    }

    if (branches.length > 0) {
      // Reject if any element is unknown (e.g. stale typing partial).
      for (const elt of selectedContingency) {
        if (!branches.includes(elt)) return;
      }
    }

    const committed = diagrams.committedBranchRef.current;
    if (sameElements(selectedContingency, committed)
        && !diagrams.restoringSessionRef.current
        && (n1Diagram || hasAnalysisState() || n1Loading || analysisLoading)) return;

    if (!sameElements(selectedContingency, committed)
        && hasAnalysisState()
        && !diagrams.restoringSessionRef.current) {
      setConfirmDialog({ type: 'contingency', pendingBranch: selectedContingency.join('+') });
      setSelectedContingency([...committed]);
      return;
    }
    // Capture BEFORE we reset the ref so the rest of this effect can
    // distinguish "user changed contingency" from "session was just
    // restored". Without the local capture, any later branch in
    // this effect would see ``restoringSessionRef.current === false``
    // and incorrectly wipe the just-restored analysis state via
    // ``clearContingencyState()``.
    const isRestoring = diagrams.restoringSessionRef.current;
    diagrams.restoringSessionRef.current = false;

    diagrams.committedBranchRef.current = [...selectedContingency];
    if (!isRestoring) {
      clearContingencyState();
      diagrams.setN1Diagram(null);
    }

    const fetchContingency = async () => {
      diagrams.setN1Loading(true);
      // On user-initiated contingency change, switch to the Context tab
      // when the study has one (the contingency and its overloads on the
      // situation map; the N-1 tab glows once ready), else to the N-1 tab
      // so the fetched diagram is visible. On session restore, leave
      // the active tab alone so the user lands on whichever tab the
      // VisualizationPanel default (Action / Overflow) resolves to given
      // the restored state.
      if (!isRestoring) {
        diagrams.setActiveTab(contextFirstRef.current ? 'context' : 'contingency');
        diagrams.setN1Pending(contextFirstRef.current);
      }

      // Fast path — svgPatch DOM-recycling. Clone the N-state SVG and
      // mutate only what changed (the dashed disconnected lines, flow
      // labels, overload halos) instead of fetching a fresh ~20 MB NAD.
      // Falls back to the full /api/contingency-diagram endpoint on any
      // error or when the base N DOM is not yet mounted. Session reload
      // always uses the full-fetch path to preserve the reload contract.
      // See docs/performance/history/svg-dom-recycling.md.
      const baseSvgEl = diagrams.nSvgContainerRef.current?.querySelector('svg') as SVGSVGElement | null;
      const baseMeta = diagrams.nMetaIndex;
      const canPatch = !!baseSvgEl && !!baseMeta && !isRestoring;
      if (canPatch) {
        console.log('[svgPatch] contingency patch PATH — calling /api/contingency-diagram-patch', selectedContingency);
        try {
          const patch = await api.getContingencyDiagramPatch(selectedContingency);
          if (patch.patchable) {
            console.log('[svgPatch] contingency patch applied (patchable=true)', selectedContingency);
            const cloned = cloneBaseSvg(baseSvgEl!);
            applyPatchToClone(cloned, baseMeta!, patch);
            diagrams.setN1Diagram({
              svg: cloned,
              metadata: nDiagram?.metadata ?? null,
              originalViewBox: nDiagram?.originalViewBox ? { ...nDiagram.originalViewBox } : null,
              ...patchDiagramFields(patch),
            });
            diagrams.lastZoomState.current = { query: '', branch: '' };
            diagrams.setN1Loading(false);
            return;
          }
        } catch (e) {
          console.warn('[svgPatch] contingency patch threw — falling back to full fetch', e);
        }
      } else {
        console.log('[svgPatch] contingency patch SKIPPED — no base N SVG/meta yet. baseSvgEl:', !!baseSvgEl, 'baseMeta:', !!baseMeta, 'restoring:', isRestoring);
      }

      try {
        const res = await api.getContingencyDiagram(selectedContingency);
        const { svg, viewBox } = processSvg(res.svg, voltageLevelsLength);
        diagrams.setN1Diagram({ ...res, svg, originalViewBox: viewBox });
        // Ensure auto-zoom fires after the new contingency diagram is
        // ready. Reset lastZoomState so the auto-zoom effect sees a
        // "branch change" on the render that has both
        // ``activeTab='contingency'`` and the new SVG in DOM.
        diagrams.lastZoomState.current = { query: '', branch: '' };
      } catch (err) {
        console.error('Failed to fetch contingency diagram', err);
        setError(`Failed to fetch contingency diagram for ${selectedContingency.join('+')}`);
      } finally {
        diagrams.setN1Loading(false);
      }
    };
    fetchContingency();
  }, [
    selectedContingency, branches, voltageLevelsLength, hasAnalysisState,
    clearContingencyState, analysisLoading, n1Diagram, n1Loading, setError,
    diagrams, nDiagram, setConfirmDialog, setSelectedContingency,
  ]);
}
