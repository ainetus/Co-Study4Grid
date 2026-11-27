// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { AssetDelta, BranchLoading, FlowDelta, FlowMetric, SldFeederNode, ViewMode, VlOverlay } from '../../types';
import { LOADING_CLASSES, NO_LOADING, formatChange, formatLoading, isPrintedNumber, loadingClass, maxLoading } from './loadingVisuals';

/**
 * The flow values of an SLD in the view its diagram tab shows — MW or
 * Loading %, Flows or Impacts — painted over pypowsybl's SVG:
 *
 * - **MW Impacts**: each feeder's P / Q read as their change (`Δ +12.3`),
 *   coloured like the NAD's deltas, the arrows turned to the change's
 *   direction.
 * - **Loading % Flows**: each branch feeder reads the loading of the end it
 *   draws (its `side`, else the other end — a transformer's side without a
 *   limit), its cell in the NAD's loading colours, the value on a pill of
 *   the same colour from 50 %. The Q arrow is hidden: one figure per end.
 * - **Loading % Impacts**: each branch feeder reads the branch's loading
 *   change (`+12%`, as on the NAD), coloured like the deltas.
 *
 * Loads and generators have no limit: in the Loading view they keep their
 * MW (their MW change in Impacts).
 */
export type SldFlowData = Pick<VlOverlay,
    'sldMetadata' | 'flow_deltas' | 'reactive_flow_deltas' | 'asset_deltas' | 'branch_loading' | 'loading_deltas'>;

const SVG_NS = 'http://www.w3.org/2000/svg';

const DELTA_CLASSES = [
    'sld-delta-positive', 'sld-delta-negative', 'sld-delta-grey',
    'sld-delta-text-positive', 'sld-delta-text-negative', 'sld-delta-text-grey',
];
/** The NAD's loading scale, on SLD cells (`sld-loading-low`, `-warn-1..5`, `-over`). */
const LOADING_CELL_CLASSES = LOADING_CLASSES.map(c => c.replace(/^nad-/, 'sld-'));
const PAINTED_CLASSES = [...DELTA_CLASSES, ...LOADING_CELL_CLASSES, 'sld-loading-text', 'sld-loading-hidden'];
const PILL = 'sld-loading-pill';
const PAINT_SELECTOR = [
    ...PAINTED_CLASSES.map(c => `.${c}`), `.${PILL}`, '[data-original-text]', '[data-arrow-flipped]',
].join(', ');

const formatLoadingChange = formatChange('%');
const formatDelta = (v: number): string => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));

/** Whether anything of this module is painted in `container` — a reconciliation may wipe it. */
export const hasSldFlowVisuals = (container: Element): boolean => container.querySelector(PAINT_SELECTOR) !== null;

/** Back to pypowsybl's own SLD: classes, pills, texts and arrows. */
export const clearSldFlowVisuals = (container: Element): void => {
    container.querySelectorAll(`.${PILL}`).forEach(el => el.remove());
    container.querySelectorAll(PAINTED_CLASSES.map(c => `.${c}`).join(','))
        .forEach(el => el.classList.remove(...PAINTED_CLASSES));
    container.querySelectorAll('[data-original-text]').forEach(el => {
        el.textContent = el.getAttribute('data-original-text');
        el.removeAttribute('data-original-text');
    });
    // Arrow directions (sld-in ↔ sld-out) flipped by the MW Impacts.
    container.querySelectorAll('[data-arrow-flipped]').forEach(el => {
        if (el.classList.contains('sld-in')) el.classList.replace('sld-in', 'sld-out');
        else if (el.classList.contains('sld-out')) el.classList.replace('sld-out', 'sld-in');
        el.removeAttribute('data-arrow-flipped');
    });
};

/**
 * A record entry by equipment id, trying dot ↔ underscore variants:
 * pypowsybl may sanitize dots differently in the network tables (the keys
 * here) and in the SLD metadata.
 */
const lookup = <T,>(rec: Record<string, T> | null | undefined, key: string): T | undefined => {
    if (!rec) return undefined;
    if (rec[key] !== undefined) return rec[key];
    const dotted = key.replace(/_/g, '.');
    if (dotted !== key && rec[dotted] !== undefined) return rec[dotted];
    const underscored = key.replace(/\./g, '_');
    if (underscored !== key && rec[underscored] !== undefined) return rec[underscored];
    return undefined;
};

interface SldIndex {
    /** Metadata entries: `nodes` (feeders, switches…) and `feederInfos` (the P / Q arrows). */
    entries: SldFeederNode[];
    equipIdToSvgIds: Map<string, string[]>;
    lookupById: (svgId: string) => Element | undefined;
    walkUpToCell: (el: Element) => Element;
    findCellEl: (equipId: string) => Element | null;
}

const buildIndex = (container: Element, sldMetadata: string | null): SldIndex => {
    // pypowsybl SLD metadata: 'nodes' (lines, transformers, breakers, busbar
    // sections) and 'feederInfos' (ARROW_ACTIVE / ARROW_REACTIVE); older
    // versions use 'feederNodes'.
    let entries: SldFeederNode[] = [];
    if (sldMetadata) {
        try {
            const meta = JSON.parse(sldMetadata) as {
                nodes?: SldFeederNode[]; feederInfos?: SldFeederNode[]; feederNodes?: SldFeederNode[];
            };
            entries = [...(meta.nodes ?? []), ...(meta.feederInfos ?? []), ...(meta.feederNodes ?? [])]
                .filter(e => e.equipmentId && e.id);
        } catch {
            // metadata parse failed — fall through to the substring fallback
        }
    }
    const equipIdToSvgIds = new Map<string, string[]>();
    for (const e of entries) {
        const ids = equipIdToSvgIds.get(e.equipmentId) ?? [];
        ids.push(e.id);
        equipIdToSvgIds.set(e.equipmentId, ids);
    }

    const elMap = new Map<string, Element>();
    container.querySelectorAll('[id]').forEach(el => elMap.set(el.id, el));
    // pypowsybl sometimes replaces dots with underscores in SVG ids while the
    // metadata keeps the original.
    const lookupById = (svgId: string): Element | undefined =>
        elMap.get(svgId) ?? elMap.get(svgId.replace(/\./g, '_')) ?? elMap.get(svgId.replace(/_/g, '.'));

    // The cell ancestor wraps BOTH the feeder symbol and its wire: the class
    // goes there to colour the whole branch.
    const walkUpToCell = (feederEl: Element): Element => {
        let cur: Element | null = feederEl.parentElement;
        while (cur && cur !== container) {
            if (cur.classList.contains('sld-extern-cell')
                || cur.classList.contains('sld-intern-cell')
                || cur.classList.contains('sld-shunt-cell')) return cur;
            cur = cur.parentElement;
        }
        return feederEl;
    };

    const findCellEl = (equipId: string): Element | null => {
        let feederEl: Element | undefined;
        const svgIds = equipIdToSvgIds.get(equipId)
            ?? equipIdToSvgIds.get(equipId.replace(/\./g, '_'))
            ?? equipIdToSvgIds.get(equipId.replace(/_/g, '.'));
        for (const svgId of svgIds ?? []) {
            feederEl = lookupById(svgId);
            if (feederEl) break;
        }
        if (!feederEl) {
            const sanitized = equipId.replace(/\./g, '_');
            for (const [eid, el] of elMap) {
                if (eid.includes(equipId) || (sanitized !== equipId && eid.includes(sanitized))) {
                    feederEl = el;
                    break;
                }
            }
        }
        return feederEl ? walkUpToCell(feederEl) : null;
    };

    return { entries, equipIdToSvgIds, lookupById, walkUpToCell, findCellEl };
};

const setText = (label: Element, text: string) => {
    if (!label.hasAttribute('data-original-text')) {
        label.setAttribute('data-original-text', label.textContent || '');
    }
    label.textContent = text;
};

const isNumeric = (label: Element) => isPrintedNumber(label.textContent || '');

const firstNumeric = (labels: NodeListOf<Element>): Element | undefined =>
    Array.from(labels).find(isNumeric);

/** The P label of a feeder cell, the first numeric label when the cell does not say. */
const activePowerLabel = (cellEl: Element): Element | undefined =>
    cellEl.querySelector('.sld-active-power .sld-label') ?? firstNumeric(cellEl.querySelectorAll('.sld-label'));

const applyPQLabels = (cellEl: Element, pStr: string, qStr: string | null) => {
    const pLabels = cellEl.querySelectorAll('.sld-active-power .sld-label');
    const p = firstNumeric(pLabels.length ? pLabels : cellEl.querySelectorAll('.sld-label'));
    if (p) setText(p, `Δ ${pStr}`);
    if (qStr === null) return;
    // Without a reactive-power group, the P label is no longer numeric: the
    // first numeric label left IS the Q label.
    const qLabels = cellEl.querySelectorAll('.sld-reactive-power .sld-label');
    const q = firstNumeric(qLabels.length ? qLabels : cellEl.querySelectorAll('.sld-label'));
    if (q) setText(q, `Δ ${qStr}`);
};

/** Flip the arrows of one power type: `.sld-in` / `.sld-out` pick the visible glyph. */
const flipArrows = (cellEl: Element, scopeClass: string) => {
    const sel = `.${scopeClass} .sld-in, .${scopeClass} .sld-out, .${scopeClass}.sld-in, .${scopeClass}.sld-out`;
    cellEl.querySelectorAll(sel).forEach(el => {
        if (el.hasAttribute('data-arrow-flipped')) return;
        if (el.classList.contains('sld-in')) el.classList.replace('sld-in', 'sld-out');
        else el.classList.replace('sld-out', 'sld-in');
        el.setAttribute('data-arrow-flipped', '1');
    });
};

const paintBranchDelta = (cellEl: Element, delta: FlowDelta, qDelta: FlowDelta | undefined) => {
    applyPQLabels(cellEl, formatDelta(delta.delta), qDelta !== undefined ? formatDelta(qDelta.delta) : null);
    const pLabels = cellEl.querySelectorAll('.sld-active-power .sld-label');
    (pLabels.length ? pLabels : cellEl.querySelectorAll('.sld-label'))
        .forEach(l => l.classList.add(`sld-delta-text-${delta.category}`));
    if (qDelta) {
        cellEl.querySelectorAll('.sld-reactive-power .sld-label')
            .forEach(l => l.classList.add(`sld-delta-text-${qDelta.category}`));
    }
    // P and Q arrows turn independently, whatever the category.
    if (delta.flip_arrow) flipArrows(cellEl, 'sld-active-power');
    if (qDelta?.flip_arrow) flipArrows(cellEl, 'sld-reactive-power');
};

const paintAssetDelta = (cellEl: Element, delta: AssetDelta) => {
    applyPQLabels(cellEl, formatDelta(delta.delta_p), formatDelta(delta.delta_q));
    const catP = delta.category_p || delta.category;
    const catQ = delta.category_q || delta.category;
    cellEl.querySelectorAll('.sld-active-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catP}`));
    cellEl.querySelectorAll('.sld-reactive-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catQ}`));
};

/**
 * MW Impacts. `flowDeltas` undefined (the Loading view) leaves the branches
 * to {@link paintLoading} and paints the loads and generators only.
 */
const paintPowerDeltas = (
    idx: SldIndex,
    flowDeltas: Record<string, FlowDelta> | undefined,
    reactiveDeltas: Record<string, FlowDelta> | undefined,
    assetDeltas: Record<string, AssetDelta> | undefined,
) => {
    // Every feeder of the metadata — branches, loads and generators.
    const processed = new Set<string>();
    for (const [equipId, svgIds] of idx.equipIdToSvgIds) {
        let feederEl: Element | undefined;
        for (const svgId of svgIds) {
            feederEl = idx.lookupById(svgId);
            if (feederEl) break;
        }
        if (!feederEl) continue;
        const cellEl = idx.walkUpToCell(feederEl);

        const branchDelta = lookup(flowDeltas, equipId);
        if (branchDelta) {
            cellEl.classList.add(`sld-delta-${branchDelta.category}`);
            paintBranchDelta(cellEl, branchDelta, lookup(reactiveDeltas, equipId));
            processed.add(equipId);
            continue;
        }
        const assetDelta = lookup(assetDeltas, equipId);
        if (assetDelta) {
            cellEl.classList.add(`sld-delta-${assetDelta.category}`);
            paintAssetDelta(cellEl, assetDelta);
            processed.add(equipId);
        }
    }

    const isProcessed = (id: string): boolean =>
        processed.has(id) || processed.has(id.replace(/\./g, '_')) || processed.has(id.replace(/_/g, '.'));

    // Keys the metadata did not reach (incomplete metadata, parse failure).
    for (const [equipId, delta] of Object.entries(flowDeltas ?? {})) {
        if (isProcessed(equipId)) continue;
        const cellEl = idx.findCellEl(equipId);
        if (cellEl) paintBranchDelta(cellEl, delta, lookup(reactiveDeltas, equipId));
    }
    for (const [equipId, assetDelta] of Object.entries(assetDeltas ?? {})) {
        if (isProcessed(equipId) || lookup(flowDeltas, equipId) !== undefined) continue;
        const cellEl = idx.findCellEl(equipId);
        if (!cellEl) continue;
        if (assetDelta.category !== 'grey' || (assetDelta.category_q && assetDelta.category_q !== 'grey')) {
            paintAssetDelta(cellEl, assetDelta);
        }
    }
};

/**
 * The loading a feeder shows: its end's (`side`), else the other end's — a
 * transformer's side without a limit — else the branch's when the side is
 * unknown.
 */
const endLoading = (ends: BranchLoading | undefined, side: string | undefined): number | undefined => {
    if (!ends) return undefined;
    if (side === 'ONE') return ends[0] ?? ends[1] ?? undefined;
    if (side === 'TWO') return ends[1] ?? ends[0] ?? undefined;
    return maxLoading(ends);
};

/** A pill of the loading colour behind a label — the NAD labels' look. */
const addPill = (label: Element, tone: string) => {
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
        box = (label as SVGGraphicsElement).getBBox();
    } catch {
        // not laid out (hidden overlay, jsdom): estimated below
    }
    if (!(box.width > 0 && box.height > 0)) {
        const size = parseFloat(label.ownerDocument.defaultView?.getComputedStyle(label).fontSize ?? '') || 8;
        const x = parseFloat(label.getAttribute('x') ?? '') || 0;
        const y = parseFloat(label.getAttribute('y') ?? '') || 0;
        box = { x, y: y - size * 0.8, width: (label.textContent ?? '').length * size * 0.6, height: size };
    }
    const pad = Math.max(1, box.height * 0.15);
    const pill = label.ownerDocument.createElementNS(SVG_NS, 'rect');
    pill.setAttribute('class', `${PILL} ${PILL}--${tone}`);
    pill.setAttribute('x', String(box.x - 2 * pad));
    pill.setAttribute('y', String(box.y - pad));
    pill.setAttribute('width', String(box.width + 4 * pad));
    pill.setAttribute('height', String(box.height + 2 * pad));
    pill.setAttribute('rx', String(box.height / 3));
    label.parentNode?.insertBefore(pill, label);
    label.classList.add('sld-loading-text');
};

/** The Loading view of the branch feeders. */
const paintLoading = (idx: SldIndex, data: SldFlowData, view: ViewMode, monitoringFactor: number) => {
    const loading = data.branch_loading;
    const deltas = view === 'delta' ? data.loading_deltas : undefined;
    // One cell per branch end drawn here. A branch's arrows carry its side;
    // one without loading (no limit) still reads as a branch, with a dash.
    const cells = new Map<Element, { equipmentId: string; side?: string }>();
    for (const e of idx.entries) {
        const isBranch = e.side !== undefined
            || lookup(loading, e.equipmentId) !== undefined
            || lookup(deltas, e.equipmentId) !== undefined;
        if (!isBranch) continue;
        const el = idx.lookupById(e.id);
        if (!el) continue;
        const cell = idx.walkUpToCell(el);
        const known = cells.get(cell);
        if (!known) cells.set(cell, { equipmentId: e.equipmentId, side: e.side });
        else if (!known.side && e.side && known.equipmentId === e.equipmentId) known.side = e.side;
    }

    for (const [cell, { equipmentId, side }] of cells) {
        cell.querySelectorAll('.sld-reactive-power').forEach(g => g.classList.add('sld-loading-hidden'));
        const label = activePowerLabel(cell);
        if (deltas) {
            const d = lookup(deltas, equipmentId);
            const category = d?.category ?? 'grey';
            cell.classList.add(`sld-delta-${category}`);
            if (label) {
                setText(label, d ? formatLoadingChange(d.delta) : NO_LOADING);
                label.classList.add(`sld-delta-text-${category}`);
            }
            continue;
        }
        const percent = endLoading(lookup(loading, equipmentId), side);
        const tone = percent === undefined ? 'nad-loading-low' : loadingClass(percent, monitoringFactor);
        cell.classList.add(tone.replace(/^nad-/, 'sld-'));
        if (!label) continue;
        setText(label, percent === undefined ? NO_LOADING : formatLoading(percent));
        if (tone !== 'nad-loading-low') addPill(label, tone.replace(/^nad-loading-/, ''));
    }
};

/**
 * Paint the SLD's flow values for `view` × `metric` over a cleared
 * container ({@link clearSldFlowVisuals}). MW Flows is pypowsybl's own
 * rendering: nothing to paint. The Loading view needs `branch_loading`;
 * without it the SLD keeps its MW.
 */
export const applySldFlowVisuals = (
    container: Element,
    data: SldFlowData,
    view: ViewMode,
    metric: FlowMetric,
    monitoringFactor: number,
): void => {
    const loadingView = metric === 'loading' && !!data.branch_loading;
    const powerDeltas = view === 'delta' && (!!data.flow_deltas || !!data.asset_deltas);
    if (!loadingView && !powerDeltas) return;
    const idx = buildIndex(container, data.sldMetadata);
    if (powerDeltas) {
        paintPowerDeltas(idx, loadingView ? undefined : data.flow_deltas,
            loadingView ? undefined : data.reactive_flow_deltas, data.asset_deltas);
    }
    if (loadingView) paintLoading(idx, data, view, monitoringFactor);
};
