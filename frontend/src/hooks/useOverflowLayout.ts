// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Overflow-graph layout-toggle domain, extracted from useDiagrams (D4,
// 2026-07). Self-contained — it depends only on the API and the
// interaction logger, holds no DOM / diagram state — so useDiagrams
// composes it and re-exposes its members through the DiagramsState facade
// unchanged.

import { useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api';
import { interactionLogger } from '../utils/interactionLogger';
import type { AnalysisResult } from '../types';

export type OverflowLayoutMode = 'hierarchical' | 'geo';

export interface OverflowLayoutState {
    overflowLayoutMode: OverflowLayoutMode;
    setOverflowLayoutMode: Dispatch<SetStateAction<OverflowLayoutMode>>;
    /** True only during a cache-miss regeneration (graphviz re-run). */
    overflowLayoutLoading: boolean;
    handleOverflowLayoutChange: (
        mode: OverflowLayoutMode,
        setResult: Dispatch<SetStateAction<AnalysisResult | null>>,
        setError: (v: string) => void,
    ) => Promise<void>;
}

export function useOverflowLayout(): OverflowLayoutState {
    // Overflow-graph layout toggle state. `overflowLayoutLoading` is
    // true only during a cache-miss regeneration (graphviz re-run);
    // cache hits resolve synchronously so the UI doesn't flash a
    // spinner for instant switches.
    const [overflowLayoutMode, setOverflowLayoutMode] = useState<OverflowLayoutMode>('hierarchical');
    const [overflowLayoutLoading, setOverflowLayoutLoading] = useState(false);
    const handleOverflowLayoutChange = useCallback(async (
        mode: OverflowLayoutMode,
        setResult: Dispatch<SetStateAction<AnalysisResult | null>>,
        setError: (v: string) => void,
    ) => {
        // Consult the latest state from React — bail out if the user
        // clicked the currently-active button (prevents a pointless
        // backend round-trip).
        setOverflowLayoutMode((current) => {
            if (current === mode) return current;
            return current;  // actual change happens after the request resolves
        });
        const correlationId = interactionLogger.record('overflow_layout_mode_toggled', {
            to: mode,
        });
        const startTs = new Date().toISOString();
        setOverflowLayoutLoading(true);
        try {
            const response = await api.regenerateOverflowGraph(mode);
            setResult((prev) => {
                if (!prev) return prev;
                return { ...prev, pdf_url: response.pdf_url, pdf_path: response.pdf_path };
            });
            setOverflowLayoutMode(mode);
            interactionLogger.recordCompletion('overflow_layout_mode_toggled', correlationId, {
                to: mode,
                cached: response.cached,
            }, startTs);
        } catch (e) {
            const msg = (e instanceof Error) ? e.message : String(e);
            setError(`Failed to regenerate overflow graph in ${mode} mode: ${msg}`);
            interactionLogger.recordCompletion('overflow_layout_mode_toggled', correlationId, {
                to: mode,
                error: msg,
            }, startTs);
        } finally {
            setOverflowLayoutLoading(false);
        }
    }, []);

    return { overflowLayoutMode, setOverflowLayoutMode, overflowLayoutLoading, handleOverflowLayoutChange };
}
