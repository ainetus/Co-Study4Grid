// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { FlowDelta, MetadataIndex, ViewMode } from '../../types';
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

// Floored, so a branch never reads at the monitoring factor before its colour says so.
const formatLoading = (percent: number): string => `${Math.floor(percent)}%`;

const formatLoadingDelta = (delta: number): string =>
    `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;

const NO_LOADING = '—';

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
 * Loading-rate view of a NAD: each branch is coloured by its loading
 * and its flow labels read in percent of the permanent limit instead
 * of MW. In Impacts mode (`view === 'delta'`, when the diagram carries
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
        branch_loading?: Record<string, number>;
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

    const setLabels = (edgeInfoIds: (string | undefined)[], label: string) => {
        for (const svgId of edgeInfoIds) {
            if (!svgId) continue;
            idMap.get(svgId)?.querySelectorAll('foreignObject, text').forEach(t => {
                if (!t.hasAttribute('data-original-text')) {
                    t.setAttribute('data-original-text', t.textContent || '');
                }
                t.textContent = label;
            });
        }
    };

    for (const [equipmentId, edge] of metaIndex.edgesByEquipmentId) {
        // A branch pypowsybl draws without flow labels (open in this state)
        // is still recoloured, or it would keep its voltage colour.
        if (!edge.svgId) continue;
        const el = idMap.get(edge.svgId);
        const infoIds = [edge.edgeInfo1?.svgId, edge.edgeInfo2?.svgId];

        if (deltas) {
            const d = deltas[equipmentId];
            el?.classList.add(DELTA_CLASSES[d?.category ?? 'grey']);
            setLabels(infoIds, d ? formatLoadingDelta(d.delta) : NO_LOADING);
            continue;
        }
        const percent = loading[equipmentId];
        el?.classList.add(percent === undefined ? 'nad-loading-low' : loadingClass(percent, monitoringFactor));
        setLabels(infoIds, percent === undefined ? NO_LOADING : formatLoading(percent));
    }
};
