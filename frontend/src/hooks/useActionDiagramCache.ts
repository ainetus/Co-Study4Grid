// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Action-variant diagram cache domain, extracted from useDiagrams (D4,
// 2026-07). Owns the "prime a streamed post-action NAD now, paint it
// instantly on click later" cache. The cache clears whenever the
// contingency changes (a stale post-action NAD from a previous N-1 must
// not leak through). useDiagrams composes it, reads the ref from its
// action-select handler, and re-exposes `primeActionDiagram` through the
// DiagramsState facade unchanged. The single ref-clearing effect
// manipulates no DOM, so it carries no effect-ordering constraint.

import { useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { processSvg } from '../utils/svgUtils';
import type { DiagramData } from '../types';

export interface ActionDiagramCacheState {
    /** Keyed by action id; values are ALREADY processed (processSvg ran). */
    actionDiagramCacheRef: MutableRefObject<Map<string, DiagramData>>;
    /** Process a streamed diagram event's SVG and store it for click-to-view. */
    primeActionDiagram: (actionId: string, raw: DiagramData & { svg: string }, voltageLevelsLength: number) => void;
}

export function useActionDiagramCache(selectedContingencyKey: string): ActionDiagramCacheState {
    // Action-variant diagram cache. Populated by ActionFeed when it adds or
    // re-simulates a manual action through the streamed
    // `simulateAndVariantDiagramStream` endpoint — the `{type:"diagram",...}`
    // event yields a ready-to-render diagram while the user is still reading
    // the sidebar card. If the user subsequently clicks that card,
    // `handleActionSelect` reads the cache and paints the SVG instantly,
    // saving the 5-7 s server-side pypowsybl NAD regeneration.
    //
    // Keyed by action id. Values are ALREADY processed (processSvg ran, so
    // the entry has `originalViewBox` and the scaled SVG). Cleared whenever
    // the contingency changes so a stale post-action NAD from a previous
    // N-1 can't leak through.
    const actionDiagramCacheRef = useRef<Map<string, DiagramData>>(new Map());
    useEffect(() => {
        actionDiagramCacheRef.current.clear();
    }, [selectedContingencyKey]);

    // Exposed to ActionFeed via App.tsx props: processes the raw NDJSON
    // diagram event's SVG and stores it for later click-to-view.
    const primeActionDiagram = useCallback((actionId: string, raw: DiagramData & { svg: string }, voltageLevelsLength: number) => {
        try {
            const { svg, viewBox } = processSvg(raw.svg, voltageLevelsLength);
            actionDiagramCacheRef.current.set(actionId, { ...raw, svg, originalViewBox: viewBox });
        } catch (e) {
            console.warn('[primeActionDiagram] processSvg failed for', actionId, e);
        }
    }, []);

    return { actionDiagramCacheRef, primeActionDiagram };
}
