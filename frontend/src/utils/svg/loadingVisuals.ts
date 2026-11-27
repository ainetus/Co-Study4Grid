// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { BranchLoading, FlowDelta, MetadataIndex, ViewMode } from '../../types';
import { getIdMap } from './idMap';
import { DELTA_CLASSES } from './deltaVisuals';

/** Loading below this share of the permanent limit reads as unremarkable (grey). */
export const LOADING_WATCH_THRESHOLD = 0.5;
/** Yellow → orange steps between the watch threshold and the monitoring factor. */
export const LOADING_WARN_STEPS = 5;

export const LOADING_CLASSES = [
    'nad-loading-low',
    ...Array.from({ length: LOADING_WARN_STEPS }, (_, i) => `nad-loading-warn-${i + 1}`),
    'nad-loading-over',
] as const;

/**
 * Colour class of a branch loaded at `percent` % of its permanent limit:
 * grey below 50 %, five pale yellow → orange steps up to the monitoring
 * factor, vivid orange at or above it (where the overload scan flags it).
 */
export const loadingClass = (percent: number, monitoringFactor: number): string => {
    const rho = percent / 100;
    if (rho >= monitoringFactor) return 'nad-loading-over';
    if (rho < LOADING_WATCH_THRESHOLD) return 'nad-loading-low';
    const t = (rho - LOADING_WATCH_THRESHOLD) / (monitoringFactor - LOADING_WATCH_THRESHOLD);
    return `nad-loading-warn-${Math.min(LOADING_WARN_STEPS, Math.floor(t * LOADING_WARN_STEPS) + 1)}`;
};

/** A branch's loading: its more loaded end (an end without a limit has none). */
export const maxLoading = (ends: BranchLoading | undefined): number | undefined => {
    const known = ends ? ends.filter((v): v is number => v !== null) : [];
    return known.length ? Math.max(...known) : undefined;
};

// Floored, so a branch never reads at the monitoring factor before its colour says so.
export const formatLoading = (percent: number): string => `${Math.floor(percent)}%`;

export const formatLoadingDelta = (delta: number): string =>
    `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;

/**
 * A change as the diagrams print it (branch labels, the SLD's Loading view):
 * rounded, its sign telling up from down — `+40%`, `-58`. Under one unit it
 * keeps a decimal (`-0.4%`), or a change coloured as a decrease would read
 * `0`; none at all reads `0`. The hover keeps a decimal.
 */
export const formatChange = (unit: string) => (delta: number): string => {
    const rounded = Math.round(delta);
    const shown = rounded !== 0 ? rounded : Math.round(delta * 10) / 10;
    return shown === 0 ? `0${unit}` : `${shown > 0 ? '+' : '-'}${Math.abs(shown)}${unit}`;
};

export const NO_LOADING = '—';

// pypowsybl groups the thousands of the values it prints: `-1,297` (SLD, NAD).
const GROUPED_NUMBER = /^-?\d{1,3}(?:[,\u00a0\u202f ]\d{3})+(?:\.\d+)?$/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Whether a diagram text is a number pypowsybl printed (`-19`, `1,550`). */
export const isPrintedNumber = (text: string): boolean => {
    const t = text.trim();
    return PLAIN_NUMBER.test(t) || GROUPED_NUMBER.test(t);
};

/** The number a diagram text prints — `-1,297` is -1297, not -1. */
export const parsePrintedNumber = (text: string): number => {
    const t = text.trim();
    return parseFloat(GROUPED_NUMBER.test(t) ? t.replace(/[,\u00a0\u202f ]/g, '') : t);
};

/**
 * Strip the Flows / Impacts × MW / Loading decoration from a copy of a
 * live NAD — colour classes and rewritten flow labels — so a clone of a
 * decorated diagram starts from pypowsybl's own values. The svgPatch
 * clones of the N SVG need it: otherwise the N state's labels, kept in
 * `data-original-text`, would be restored over the patched N-1 / action
 * flows.
 */
export const resetFlowVisuals = (root: Element) => {
    const classes = [...Object.values(DELTA_CLASSES), ...LOADING_CLASSES];
    root.querySelectorAll(classes.map(c => `.${c}`).join(','))
        .forEach(el => el.classList.remove(...classes));
    root.querySelectorAll('[data-original-text]').forEach(el => {
        el.textContent = el.getAttribute('data-original-text');
        el.removeAttribute('data-original-text');
    });
};

/**
 * Loading-rate view of a NAD: each branch is coloured by its loading (its
 * more loaded end) and each end's flow label reads that end's loading, in
 * percent of its permanent limit, instead of MW. In Impacts mode (`view === 'delta'`, when the diagram carries
 * `loading_deltas`) the branches show the loading change in percentage
 * points, coloured like the flow deltas (orange up / blue down / grey
 * negligible). A branch without a limit greys out with a dash.
 *
 * `view === null` only clears the loading classes: it relies on
 * `applyDeltaVisuals` having run first on the same container — that pass
 * restores the original labels and owns the `nad-delta-*` classes reused
 * here, which is why the two always run in that order.
 */
export const applyLoadingVisuals = (
    container: HTMLElement | null,
    diagram: {
        branch_loading?: Record<string, BranchLoading>;
        loading_deltas?: Record<string, FlowDelta>;
    } | null,
    metaIndex: MetadataIndex | null,
    view: ViewMode | null,
    monitoringFactor: number,
) => {
    if (!container) return;
    container.querySelectorAll(LOADING_CLASSES.map(c => `.${c}`).join(','))
        .forEach(el => el.classList.remove(...LOADING_CLASSES));

    if (!view || !diagram?.branch_loading || !metaIndex) return;

    const loading = diagram.branch_loading;
    const deltas = view === 'delta' ? diagram.loading_deltas : undefined;
    const idMap = getIdMap(container);

    const setLabel = (edgeInfoId: string | undefined, label: string) => {
        if (!edgeInfoId) return;
        idMap.get(edgeInfoId)?.querySelectorAll('foreignObject, text').forEach(t => {
            if (!t.hasAttribute('data-original-text')) {
                t.setAttribute('data-original-text', t.textContent || '');
            }
            t.textContent = label;
        });
    };

    for (const [equipmentId, edge] of metaIndex.edgesByEquipmentId) {
        // A branch pypowsybl draws without flow labels (open in this state)
        // is still recoloured, or it would keep its voltage colour.
        if (!edge.svgId) continue;
        const el = idMap.get(edge.svgId);

        if (deltas) {
            const d = deltas[equipmentId];
            el?.classList.add(DELTA_CLASSES[d?.category ?? 'grey']);
            const label = d ? formatLoadingDelta(d.delta) : NO_LOADING;
            setLabel(edge.edgeInfo1?.svgId, label);
            setLabel(edge.edgeInfo2?.svgId, label);
            continue;
        }
        const ends = loading[equipmentId];
        const percent = maxLoading(ends);
        el?.classList.add(percent === undefined ? 'nad-loading-low' : loadingClass(percent, monitoringFactor));
        const endLabel = (v: number | null | undefined) => (v === null || v === undefined ? NO_LOADING : formatLoading(v));
        setLabel(edge.edgeInfo1?.svgId, endLabel(ends?.[0]));
        setLabel(edge.edgeInfo2?.svgId, endLabel(ends?.[1]));
    }
};
