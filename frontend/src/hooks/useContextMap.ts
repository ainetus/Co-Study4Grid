// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { apiErrorMessage } from '../utils/apiError';
import { computeN1OverloadHighlights } from '../utils/overloadHighlights';
import { onStudyLoad } from '../utils/studyLoadSignal';
import type { Notice } from '../components/NoticesPanel';
import type {
    AnalysisResult, ContextMapData, ContextMapElement, ContextMapHighlight, ContextMapUnavailable, DiagramData,
} from '../types';

type ContextMapPayload = ContextMapData | ContextMapUnavailable;

export interface ContextMapState {
    data: ContextMapData | null;
    loading: boolean;
    error: string | null;
    /**
     * Whether the loaded study has a situation map — its network places at
     * least two zones on the ground — `null` while that is being read. The
     * Context tab is shown only when this is not `false`.
     */
    available: boolean | null;
    /** The prerequisite the loaded network misses, when it has no map. */
    unavailableReason: string | null;
    /** The contingency and its overloads, resolved on the map. */
    highlights: ContextMapHighlight[];
}

/** Early read while /api/config runs: retry cadence and budget (~60 s). */
const EARLY_POLL_MS = 400;
const EARLY_POLL_MAX = 150;

interface UseContextMapArgs {
    /** Bumped on every successful `/api/config` (see `useSettings`). */
    studyGeneration: number;
    selectedContingency: readonly string[];
    result: AnalysisResult | null;
    n1Diagram: DiagramData | null;
    selectedOverloads: Set<string>;
}

/**
 * Overloads to show, with their loading when the N-1 diagram reported it —
 * the same source priority and selection filter as the N-1 tab's orange
 * halos (`computeN1OverloadHighlights`), so both tabs agree.
 */
const overloadsWithRho = (
    result: AnalysisResult | null, n1Diagram: DiagramData | null, selected: Set<string>,
): { id: string; rho?: number }[] => {
    const rho = new Map<string, number>();
    (n1Diagram?.lines_overloaded ?? []).forEach((id, i) => {
        const value = n1Diagram?.lines_overloaded_rho?.[i];
        if (value !== undefined) rho.set(id, value);
    });
    return computeN1OverloadHighlights(result?.lines_overloaded, n1Diagram?.lines_overloaded, selected)
        .map(id => ({ id, rho: rho.get(id) }));
};

/** The sidebar notice telling why a study has no Context tab. */
export const contextUnavailableNotice = (reason: string, onDismiss: () => void): Notice => ({
    id: 'context-tab-unavailable',
    severity: 'info',
    title: 'No Context tab for this network',
    body: `The situation map needs at least two zones on the ground: substations tagged with their `
        + `country (a grid spanning countries) or, in France, with their RTE region (regionCvg). `
        + `Here ${reason}.`,
    onDismiss,
});

/**
 * Owns the Context tab's data: the situation map of the loaded study and
 * the map position of the elements it highlights.
 *
 * The backend builds the map from a snapshot taken right after the network
 * is parsed, so it is read EARLY: as soon as `/api/config` is sent
 * (`studyLoadSignal`), while the backend is still loading the action space,
 * and well before the base NAD — the operator sees the situation first.
 * `studyGeneration` (bumped by `useSettings.applyConfigResponse` once the
 * config answered, on every load path) confirms it, or fetches it when the
 * early read could not run. A network the map cannot draw answers why
 * (`ContextMapUnavailable`): `available` turns false and the tab goes away.
 *
 * The contingency and its overloads are resolved to map geometry lazily
 * and cached per study: re-highlighting a known element is free.
 */
export function useContextMap({
    studyGeneration, selectedContingency, result, n1Diagram, selectedOverloads,
}: UseContextMapArgs): ContextMapState {
    const [payload, setPayload] = useState<ContextMapPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [geometry, setGeometry] = useState<Record<string, ContextMapElement | null>>({});
    const generationRef = useRef(studyGeneration);
    const payloadRef = useRef<ContextMapPayload | null>(null);
    /** Token of the live early read; bumping it stops that read. */
    const pollRef = useRef(0);

    const showMap = useCallback((next: ContextMapPayload) => {
        const current = payloadRef.current;
        if (current?.capture_id !== undefined && current.capture_id === next.capture_id) return;
        payloadRef.current = next;
        setPayload(next);
        setGeometry({});
        setError(null);
    }, []);

    // Early read: from the moment /api/config is sent, poll until the
    // backend serves the NEW study's map — a capture_id other than the one
    // on screen (the previous map is served until the backend resets).
    useEffect(() => onStudyLoad(phase => {
        if (phase !== 'start') {
            pollRef.current++;
            if (phase === 'failed' && !payloadRef.current) setLoading(false);
            return;
        }
        const token = ++pollRef.current;
        const stale = payloadRef.current?.capture_id;
        payloadRef.current = null;
        setPayload(null);
        setGeometry({});
        setError(null);
        setLoading(true);
        let attempts = 0;
        const poll = () => {
            if (token !== pollRef.current || attempts++ >= EARLY_POLL_MAX) return;
            api.getContextMap()
                .then(next => {
                    if (token !== pollRef.current) return;
                    if (next && next.capture_id !== stale) {
                        pollRef.current++;
                        showMap(next);
                        setLoading(false);
                    } else {
                        setTimeout(poll, EARLY_POLL_MS);
                    }
                })
                .catch(() => { if (token === pollRef.current) setTimeout(poll, EARLY_POLL_MS); });
        };
        poll();
    }), [showMap]);

    // /api/config answered: make sure the map is the loaded study's (a
    // no-op when the early read already showed it).
    useEffect(() => {
        generationRef.current = studyGeneration;
        if (studyGeneration <= 0) return;
        pollRef.current++;
        if (!payloadRef.current) setLoading(true);
        api.getContextMap()
            .then(next => {
                if (generationRef.current === studyGeneration && next) showMap(next);
            })
            .catch(err => {
                if (generationRef.current === studyGeneration && !payloadRef.current) setError(apiErrorMessage(err));
            })
            .finally(() => {
                if (generationRef.current === studyGeneration) setLoading(false);
            });
    }, [studyGeneration, showMap]);

    const data = payload && payload.available !== false ? payload : null;
    const unavailableReason = payload && payload.available === false ? payload.unavailable_reason : null;
    const available = payload ? payload.available !== false : loading ? null : false;

    const overloads = useMemo(
        () => overloadsWithRho(result, n1Diagram, selectedOverloads),
        [result, n1Diagram, selectedOverloads],
    );
    const highlightIds = useMemo(
        () => [...new Set([...selectedContingency, ...overloads.map(o => o.id)])],
        [selectedContingency, overloads],
    );
    const idsKey = highlightIds.join('\u0000');
    useEffect(() => {
        if (!data) return;
        const missing = idsKey ? idsKey.split('\u0000').filter(id => !(id in geometry)) : [];
        if (missing.length === 0) return;
        const generation = generationRef.current;
        api.getContextMapElements(missing)
            .then(found => {
                if (generationRef.current !== generation) return;
                setGeometry(prev => {
                    const next = { ...prev };
                    for (const id of missing) next[id] = null;
                    for (const el of found) next[el.id] = el;
                    return next;
                });
            })
            .catch(err => console.warn('Context map: element lookup failed', err));
    }, [data, idsKey, geometry]);

    const highlights = useMemo<ContextMapHighlight[]>(() => {
        const out: ContextMapHighlight[] = [];
        for (const id of selectedContingency) {
            const element = geometry[id];
            if (element) out.push({ element, role: 'contingency' });
        }
        for (const { id, rho } of overloads) {
            const element = geometry[id];
            if (element && !selectedContingency.includes(id)) out.push({ element, role: 'overload', rho });
        }
        return out;
    }, [selectedContingency, overloads, geometry]);

    return { data, loading, error, available, unavailableReason, highlights };
}
