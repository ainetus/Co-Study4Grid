// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { DiagramData, AnalysisResult, ActionDetail, VlOverlay, SldTab, SldFeederNode } from '../types';
import { isCouplingAction } from '../utils/svgUtils';
import { colors } from '../styles/tokens';
import SldEditPanel from './SldEditPanel';
import SldInjectionPopover from './SldInjectionPopover';
import type { SwitchToggleEntry, InjectionChangeEntry } from '../hooks/useSldTopologyEdit';

export interface SldOverlayProps {
    vlOverlay: VlOverlay;
    actionViewMode: 'network' | 'delta';
    onOverlayClose: () => void;
    onOverlaySldTabChange: (tab: SldTab) => void;
    n1Diagram: DiagramData | null;
    actionDiagram: DiagramData | null;
    /** Currently APPLIED contingency (list of element IDs disconnected). */
    selectedContingency: string[];
    result: AnalysisResult | null;
    /**
     * User-configured monitoring-factor threshold (typically 0.95).
     * Used to gate the post-action overload highlight on the `action`
     * tab: when `actionDetail.max_rho <= monitoringFactor` the card
     * is classified "Solved" (orange = low margin, green = clean) so
     * the overload halo is suppressed to match. Defaults to 0.95
     * when the parent hasn't plumbed it through yet — preserves the
     * pre-fix behaviour for legacy callers.
     */
    monitoringFactor?: number;
    /**
     * Interactive edit affordance. When ``editMode`` is on the overlay
     * renders the pending-changes panel under the SVG body and forwards
     * taps on the SVG to ``onSwitchClick`` / opens the injection editor.
     * Edit mode is now driven entirely by App (on for an open editable
     * tab, off on close / N state) — there is no in-overlay toggle.
     * The actual state lives in ``useSldTopologyEdit`` on the App side.
     *
     * The whole bundle is optional so older callers (overflow pin
     * double-click, etc.) keep working without changes.
     */
    editMode?: boolean;
    /** @deprecated No in-overlay toggle anymore (edit mode is implicit
     *  while the SLD is open). Retained so existing callers/tests that
     *  still pass it keep type-checking; the value is ignored. */
    onEditModeChange?: (next: boolean) => void;
    pendingSwitches?: Record<string, boolean>;
    pendingChanges?: SwitchToggleEntry[];
    onSwitchClick?: (equipmentId: string) => void;
    onSimulateEdit?: () => void;
    onResetEdit?: () => void;
    editSimulationBusy?: boolean;
    /**
     * Interactive injection (load / generator active-power) edit. When
     * provided, clicking a load / generator glyph in edit mode opens a
     * floating editor (``SldInjectionPopover``) seeded from the
     * ``vlOverlay.injections`` baseline; staged retunes are listed in the
     * maneuver panel and simulate as part of the same manual action as
     * switch toggles.
     */
    pendingInjections?: Record<string, number>;
    injectionChanges?: InjectionChangeEntry[];
    onInjectionStage?: (equipmentId: string, targetP: number) => void;
    onInjectionRemove?: (equipmentId: string) => void;
    /** Base action id when editing on a post-action SLD (combined card). */
    editCombinedWithActionId?: string | null;
    /**
     * Target-topology preview. When set, the overlay renders this SVG
     * (switches drawn in their target state + topological-colouring
     * connectivity, computed by the backend) instead of the baseline,
     * and greys the flow values via ``sld-preview-stale`` because no
     * load flow was run. Cleared when the operator resets / exits edit
     * mode or commits the simulation.
     */
    previewSvg?: string | null;
    previewMetadata?: string | null;
    previewStale?: boolean;
    previewLoading?: boolean;
    /**
     * Maneuver-list focus: when set, only this switch's cell is
     * outlined (the operator clicked its row in the panel). Null =
     * outline every staged change.
     */
    focusedSwitchId?: string | null;
    onSwitchFocus?: (equipmentId: string | null) => void;
    onSwitchRemove?: (equipmentId: string) => void;
    onSwitchRemoveMany?: (equipmentIds: string[]) => void;
}

const SldOverlay: React.FC<SldOverlayProps> = ({
    vlOverlay, actionViewMode,
    onOverlayClose, onOverlaySldTabChange,
    n1Diagram, actionDiagram,
    selectedContingency, result,
    monitoringFactor = 0.95,
    editMode = false,
    pendingSwitches,
    pendingChanges,
    onSwitchClick,
    onSimulateEdit,
    onResetEdit,
    editSimulationBusy = false,
    pendingInjections,
    injectionChanges,
    onInjectionStage,
    onInjectionRemove,
    editCombinedWithActionId = null,
    previewSvg = null,
    previewMetadata = null,
    previewStale = false,
    previewLoading = false,
    focusedSwitchId = null,
    onSwitchFocus,
    onSwitchRemove,
    onSwitchRemoveMany,
}) => {
    const overlayBodyRef = useRef<HTMLDivElement>(null);
    // True once a press-drag has moved the pointer beyond a small slop
    // radius — used to tell a deliberate switch click apart from a
    // pan gesture that happens to end near a breaker (both fire a
    // trailing `click` event).
    const panMovedRef = useRef(false);
    // When a target-topology preview is showing, the backend already
    // drew the switches in target state with topological colouring, so
    // the client-side delta / highlight / toggle-paint passes (which
    // target the baseline SVG) are suppressed.
    const previewActive = !!previewSvg;
    const activeSvg = previewSvg ?? vlOverlay.svg;
    const activeMetadata = previewMetadata ?? vlOverlay.sldMetadata;
    const [overlayPos, setOverlayPos] = useState({ x: 16, y: 16 });
    const [overlayTransform, setOverlayTransform] = useState({ scale: 1, tx: 0, ty: 0 });
    // Keep the latest transform readable inside layout effects that depend
    // only on the SVG identity (so they don't re-run on every pan frame).
    // Updated in an effect (never during render) — by the time the
    // SVG-identity layout effect reads it, it still mirrors the transform
    // the SVG is currently rendered with (auto-size hasn't run yet).
    const overlayTransformRef = useRef(overlayTransform);
    useEffect(() => { overlayTransformRef.current = overlayTransform; }, [overlayTransform]);
    // Auto-computed overlay window size (fits the VL diagram on open). Null
    // until the first SVG is measured → falls back to the default size. Only
    // re-set when a NEW diagram loads, so a manual resize (resize: both)
    // persists between renders.
    const [overlaySize, setOverlaySize] = useState<{ w: number; h: number } | null>(null);
    const autoSizedKeyRef = useRef<string>('');
    // Open injection editor: the clicked load / generator + a body-relative
    // (untransformed) anchor for the floating ``SldInjectionPopover``.
    const [injectionPopover, setInjectionPopover] = useState<{ equipmentId: string; x: number; y: number } | null>(null);

    // Dismiss the injection editor whenever the SLD context changes
    // (edit mode off, VL / tab / action switch) so a stale bubble never
    // points at the wrong network state. Reset-on-identity-change is the
    // canonical allowed setState-in-effect; same suppression pattern as
    // useSldTopologyEdit's baseline-prune effect.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setInjectionPopover(null);
    }, [editMode, vlOverlay.vlName, vlOverlay.tab, vlOverlay.actionId]);

    // Auto-size the overlay window to the VL diagram so it opens fully
    // visible — no manual expansion each time. Measures the rendered SVG
    // once per new diagram (keyed on its identity, so pans / manual resizes
    // never re-trigger it), sizes the window to fit (clamped to the
    // viewport), and fits the SVG into the body. The operator can still
    // shrink it afterwards via the resize handle.
    useLayoutEffect(() => {
        const body = overlayBodyRef.current;
        if (!body || vlOverlay.loading || previewActive || !activeSvg) return;
        const key = `${vlOverlay.vlName}|${vlOverlay.tab}|${vlOverlay.actionId ?? ''}|${activeSvg.length}`;
        if (autoSizedKeyRef.current === key) return;
        const svgEl = body.querySelector('svg');
        if (!svgEl) return;
        const scale = overlayTransformRef.current.scale || 1;
        const rect = svgEl.getBoundingClientRect();
        const natW = rect.width / scale;
        const natH = rect.height / scale;
        // jsdom (and a not-yet-laid-out SVG) report a zero box — keep the
        // default size in that case rather than collapsing the window.
        if (!(natW > 1 && natH > 1)) return;
        autoSizedKeyRef.current = key;

        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 900;
        const HEADER = 46, PANEL = 86, PAD = 14;
        const targetW = Math.round(Math.min(Math.max(natW + PAD, 320), vw * 0.95));
        const targetH = Math.round(Math.min(Math.max(natH + HEADER + PANEL + PAD, 300), vh * 0.92));
        setOverlaySize({ w: targetW, h: targetH });

        const bodyW = targetW - PAD;
        const bodyH = targetH - HEADER - PANEL;
        const fitRaw = Math.min(bodyW / natW, bodyH / natH, 1);
        const fitScale = fitRaw > 0 && Number.isFinite(fitRaw) ? fitRaw : 1;
        // Centre horizontally, top-align vertically: the spare height below
        // the diagram is where the (initially collapsed) edit panel grows,
        // so staging a change doesn't clip the top of the diagram.
        const tx = Math.max(4, (bodyW - natW * fitScale) / 2);
        setOverlayTransform({ scale: fitScale, tx, ty: 4 });
    }, [activeSvg, vlOverlay.vlName, vlOverlay.tab, vlOverlay.actionId, vlOverlay.loading, previewActive]);

    // Apply / clear delta flow colors on the SLD whenever svg/metadata, tab, or mode changes.
    //
    // pypowsybl SLD SVG structure (GraphMetadata):
    //   feederNodes[].id         → SVG element ID of the feeder <g> (sld-top-feeder / sld-bottom-feeder)
    //   feederNodes[].equipmentId → network equipment ID (matches flow_deltas keys)
    //
    // The cell ancestor (sld-extern-cell) wraps BOTH the feeder symbol AND the connecting
    // wire (sld-wire), so we must apply the delta class one level up to color the full branch.
    //
    // Runs as a useLayoutEffect — synchronously after every commit but
    // BEFORE the browser paints. Same scheduling as the highlight
    // layoutEffect immediately below it. A plain `useEffect` runs
    // AFTER paint, which during continuous panning produces a visible
    // single-frame flash of the un-painted (Flows) state between the
    // commit and the effect — perceived as the impact/flow blink the
    // operator reported. Self-gates via signature + DOM-presence
    // probe so identical re-renders short-circuit instead of
    // re-painting every cell on every pan frame.
    const appliedDeltaSigRef = useRef<string>('');
    useLayoutEffect(() => {
        const container = overlayBodyRef.current;
        if (!container) return;
        // Preview render owns the canvas — its flows are greyed and its
        // switches are already in target state; baseline deltas must not
        // repaint over it.
        if (previewActive) return;

        const deltaSig = JSON.stringify({
            svgLen: vlOverlay.svg?.length ?? 0,
            meta: vlOverlay.sldMetadata?.length ?? 0,
            tab: vlOverlay.tab,
            mode: actionViewMode,
            fd: vlOverlay.flow_deltas ? Object.keys(vlOverlay.flow_deltas).sort() : [],
            rfd: vlOverlay.reactive_flow_deltas ? Object.keys(vlOverlay.reactive_flow_deltas).sort() : [],
            ad: vlOverlay.asset_deltas ? Object.keys(vlOverlay.asset_deltas).sort() : [],
        });
        const expectDelta = actionViewMode === 'delta'
            && !!vlOverlay.svg
            && (!!vlOverlay.flow_deltas || !!vlOverlay.asset_deltas);
        const deltaDomPresent = container.querySelector(
            '.sld-delta-positive, .sld-delta-negative, .sld-delta-grey, '
            + '.sld-delta-text-positive, .sld-delta-text-negative, .sld-delta-text-grey, '
            + '[data-original-text]',
        ) !== null;
        // Short-circuit only when we already applied for the current
        // inputs AND the DOM still reflects it (or we expect no delta
        // state at all). Otherwise fall through and (re-)apply.
        if (deltaSig === appliedDeltaSigRef.current
            && (expectDelta ? deltaDomPresent : !deltaDomPresent)) {
            return;
        }
        appliedDeltaSigRef.current = deltaSig;

        // Clear any previously applied SLD delta classes
        const SLD_DELTA_CLASSES = [
            'sld-delta-positive', 'sld-delta-negative', 'sld-delta-grey',
            'sld-delta-text-positive', 'sld-delta-text-negative', 'sld-delta-text-grey'
        ];
        container.querySelectorAll(SLD_DELTA_CLASSES.map(c => '.' + c).join(','))
            .forEach(el => el.classList.remove(...SLD_DELTA_CLASSES));

        // Restore original text labels
        container.querySelectorAll('[data-original-text]').forEach(el => {
            el.textContent = el.getAttribute('data-original-text');
            el.removeAttribute('data-original-text');
        });

        // Restore flipped arrow directions (sld-in ↔ sld-out)
        container.querySelectorAll('[data-arrow-flipped]').forEach(el => {
            if (el.classList.contains('sld-in')) {
                el.classList.replace('sld-in', 'sld-out');
            } else if (el.classList.contains('sld-out')) {
                el.classList.replace('sld-out', 'sld-in');
            }
            el.removeAttribute('data-arrow-flipped');
        });

        if (!vlOverlay.svg || actionViewMode !== 'delta') return;

        // Choose deltas based on the SLD tab being shown
        const flowDeltas = vlOverlay.flow_deltas;
        const reactiveDeltas = vlOverlay.reactive_flow_deltas;
        const assetDeltas = vlOverlay.asset_deltas;

        if (!flowDeltas && !assetDeltas) return;

        // Build equipmentId → [svgId, ...] multimap from SLD metadata.
        // pypowsybl SLD metadata uses 'nodes' (for lines, transformers, breakers,
        // bus-bar sections) and 'feederInfos' (for ARROW_ACTIVE/ARROW_REACTIVE).
        // Older versions may use 'feederNodes' instead.
        const equipIdToSvgIds = new Map<string, string[]>();
        if (vlOverlay.sldMetadata) {
            try {
                const meta = JSON.parse(vlOverlay.sldMetadata) as {
                    nodes?: SldFeederNode[];
                    feederInfos?: SldFeederNode[];
                    feederNodes?: SldFeederNode[];
                };
                // Collect entries from all possible metadata arrays
                const sources = [
                    ...(meta.nodes ?? []),
                    ...(meta.feederInfos ?? []),
                    ...(meta.feederNodes ?? []),
                ];
                for (const fn of sources) {
                    if (fn.equipmentId && fn.id) {
                        const ids = equipIdToSvgIds.get(fn.equipmentId) ?? [];
                        ids.push(fn.id);
                        equipIdToSvgIds.set(fn.equipmentId, ids);
                    }
                }
            } catch {
                // metadata parse failed — fall through to substring fallback
            }
        }

        // Quick lookup of all elements by SVG id
        const elMap = new Map<string, Element>();
        container.querySelectorAll('[id]').forEach(el => elMap.set(el.id, el));

        /**
         * Look up an SVG element by ID, trying the exact ID first and then
         * common sanitization variants (pypowsybl sometimes replaces dots with
         * underscores in SVG element IDs while preserving the original in metadata).
         */
        const lookupById = (svgId: string): Element | undefined =>
            elMap.get(svgId)
            ?? elMap.get(svgId.replace(/\./g, '_'))   // dots → underscores
            ?? elMap.get(svgId.replace(/_/g, '.'));    // underscores → dots

        /**
         * Look up a key in a Record, trying the exact key first and then
         * dot↔underscore variants.  pypowsybl may sanitize dots in equipment
         * IDs differently between get_lines() (used for flow_deltas keys) and
         * SLD metadata (used for equipmentId).
         */
        const lookupDelta = <T,>(rec: Record<string, T> | null | undefined, key: string): T | undefined => {
            if (!rec) return undefined;
            const exact = rec[key];
            if (exact !== undefined) return exact;
            const dotted = key.replace(/_/g, '.');
            if (dotted !== key && rec[dotted] !== undefined) return rec[dotted];
            const underscored = key.replace(/\./g, '_');
            if (underscored !== key && rec[underscored] !== undefined) return rec[underscored];
            return undefined;
        };

        const applyTextDelta = (label: Element, val: string) => {
            if (!label.hasAttribute('data-original-text')) {
                label.setAttribute('data-original-text', label.textContent || '');
            }
            label.textContent = `\u0394 ${val}`;
        };

        const fmtDelta = (v: number) => v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);

        /** Walk up from a feeder element to the enclosing cell ancestor. */
        const walkUpToCell = (feederEl: Element): Element => {
            let cellEl: Element = feederEl;
            let cur: Element | null = feederEl.parentElement;
            while (cur && cur !== container) {
                if (cur.classList.contains('sld-extern-cell') ||
                    cur.classList.contains('sld-intern-cell') ||
                    cur.classList.contains('sld-shunt-cell')) {
                    cellEl = cur;
                    break;
                }
                cur = cur.parentElement;
            }
            return cellEl;
        };

        /**
         * Find the cell ancestor element for a given equipment ID.
         * Tries the metadata-based SVG IDs first (with sanitization variants),
         * then falls back to substring matching against all element IDs.
         */
        const findCellEl = (equipId: string): Element | null => {
            let feederEl: Element | undefined;
            // Try exact key, then dot↔underscore variants in metadata map
            const svgIds = equipIdToSvgIds.get(equipId)
                ?? equipIdToSvgIds.get(equipId.replace(/\./g, '_'))
                ?? equipIdToSvgIds.get(equipId.replace(/_/g, '.'));
            if (svgIds) {
                for (const svgId of svgIds) {
                    feederEl = lookupById(svgId);
                    if (feederEl) break;
                }
            }
            if (!feederEl) {
                // Substring fallback: also try with dots replaced by underscores
                const sanitized = equipId.replace(/\./g, '_');
                for (const [eid, el] of elMap) {
                    if (eid.includes(equipId) || (sanitized !== equipId && eid.includes(sanitized))) {
                        feederEl = el;
                        break;
                    }
                }
            }
            if (!feederEl) return null;
            return walkUpToCell(feederEl);
        };

        /** Replace the first numeric label in a query result with a delta string. */
        const replaceFirstNumericLabel = (labels: NodeListOf<Element>, val: string) => {
            for (const label of Array.from(labels)) {
                if (/^-?\d+(\.\d+)?$/.test((label.textContent || '').trim())) {
                    applyTextDelta(label, val);
                    return;
                }
            }
        };

        // Helper to apply P & Q delta text to a cell element
        const applyPQLabels = (cellEl: Element, pStr: string, qStr: string | null) => {
            let pLabels = cellEl.querySelectorAll('.sld-active-power .sld-label');
            if (pLabels.length === 0) pLabels = cellEl.querySelectorAll('.sld-label');
            replaceFirstNumericLabel(pLabels, pStr);

            if (qStr !== null) {
                const qLabels = cellEl.querySelectorAll('.sld-reactive-power .sld-label');
                if (qLabels.length > 0) {
                    replaceFirstNumericLabel(qLabels, qStr);
                } else {
                    // Fallback: P label already replaced (no longer numeric),
                    // so the first remaining numeric label IS the Q label.
                    replaceFirstNumericLabel(cellEl.querySelectorAll('.sld-label'), qStr);
                }
            }
        };

        /** Flip arrow direction within a specific power-type scope.
         *  pypowsybl SLD SVGs use .sld-in / .sld-out classes to control
         *  which arrow (.sld-arrow-in / .sld-arrow-out) is visible.
         *  P and Q arrows are flipped independently by scoping to
         *  .sld-active-power or .sld-reactive-power. */
        const flipArrows = (cellEl: Element, scopeClass: string) => {
            const sel = `.${scopeClass} .sld-in, .${scopeClass} .sld-out, .${scopeClass}.sld-in, .${scopeClass}.sld-out`;
            cellEl.querySelectorAll(sel).forEach(el => {
                if (el.hasAttribute('data-arrow-flipped')) return;
                if (el.classList.contains('sld-in')) {
                    el.classList.replace('sld-in', 'sld-out');
                } else {
                    el.classList.replace('sld-out', 'sld-in');
                }
                el.setAttribute('data-arrow-flipped', '1');
            });
        };

        // Iterate ALL feeders from SLD metadata so we process branches, loads,
        // and generators — not just equipment IDs found in flow_deltas.
        const processedEquipIds = new Set<string>();

        for (const [equipId, svgIds] of equipIdToSvgIds) {
            // Find the first matching feeder element across all SVG IDs for this equipment
            let feederEl: Element | undefined;
            for (const svgId of svgIds) {
                feederEl = lookupById(svgId);
                if (feederEl) break;
            }
            if (!feederEl) continue;

            const cellEl = walkUpToCell(feederEl);

            // Check branch (line/transformer) deltas first
            const branchDelta = lookupDelta(flowDeltas, equipId);
            if (branchDelta) {
                cellEl.classList.add(`sld-delta-${branchDelta.category}`);

                const pStr = fmtDelta(branchDelta.delta);
                const qDelta = lookupDelta(reactiveDeltas, equipId);
                const qStr = qDelta !== undefined ? fmtDelta(qDelta.delta) : null;

                // Always apply labels to ensure original flows are replaced
                applyPQLabels(cellEl, pStr, qStr);

                // Apply specific category classes to the labels instead of the cell
                let pLabels = cellEl.querySelectorAll('.sld-active-power .sld-label');
                if (pLabels.length === 0) pLabels = cellEl.querySelectorAll('.sld-label');
                pLabels.forEach(l => l.classList.add(`sld-delta-text-${branchDelta.category}`));

                if (qDelta) {
                    cellEl.querySelectorAll('.sld-reactive-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${qDelta.category}`));
                }

                // Flip P and Q arrows independently (regardless of category)
                if (branchDelta.flip_arrow) {
                    flipArrows(cellEl, 'sld-active-power');
                }
                if (qDelta && qDelta.flip_arrow) {
                    flipArrows(cellEl, 'sld-reactive-power');
                }
                processedEquipIds.add(equipId);
                continue;
            }

            // Check asset (load/generator) deltas
            const assetDelta = lookupDelta(assetDeltas, equipId);
            if (assetDelta) {
                cellEl.classList.add(`sld-delta-${assetDelta.category}`);
                const pStr = fmtDelta(assetDelta.delta_p);
                const qStr = fmtDelta(assetDelta.delta_q);
                // Always apply labels to ensure original flows are replaced
                applyPQLabels(cellEl, pStr, qStr);

                // Use independent categories for labels if available
                const catP = assetDelta.category_p || assetDelta.category;
                const catQ = assetDelta.category_q || assetDelta.category;

                cellEl.querySelectorAll('.sld-active-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catP}`));
                cellEl.querySelectorAll('.sld-reactive-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catQ}`));

                processedEquipIds.add(equipId);
            }
        }

        // Helper: check if an equipment ID (or a dot↔underscore variant) was
        // already processed in the metadata-based loop above.
        const isProcessed = (id: string): boolean =>
            processedEquipIds.has(id)
            || processedEquipIds.has(id.replace(/\./g, '_'))
            || processedEquipIds.has(id.replace(/_/g, '.'));

        // Fallback: process any flow_deltas / asset_deltas keys not found
        // via metadata (in case metadata was incomplete or parse failed).
        for (const [equipId, delta] of Object.entries(flowDeltas ?? {})) {
            if (isProcessed(equipId)) continue;
            const cellEl = findCellEl(equipId);
            if (!cellEl) continue;
            const pStr = fmtDelta(delta.delta);
            const qDelta = lookupDelta(reactiveDeltas, equipId);
            const qStr = qDelta !== undefined ? fmtDelta(qDelta.delta) : null;

            // Always apply labels to ensure original flows are replaced
            applyPQLabels(cellEl, pStr, qStr);

            let pLabels = cellEl.querySelectorAll('.sld-active-power .sld-label');
            if (pLabels.length === 0) pLabels = cellEl.querySelectorAll('.sld-label');
            pLabels.forEach(l => l.classList.add(`sld-delta-text-${delta.category}`));

            if (qDelta) {
                cellEl.querySelectorAll('.sld-reactive-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${qDelta.category}`));
            }

            if (delta.flip_arrow) flipArrows(cellEl, 'sld-active-power');
            const qDeltaForFlip = lookupDelta(reactiveDeltas, equipId);
            if (qDeltaForFlip && qDeltaForFlip.flip_arrow) flipArrows(cellEl, 'sld-reactive-power');
        }
        for (const [equipId, assetDelta] of Object.entries(assetDeltas ?? {})) {
            if (isProcessed(equipId)) continue;
            if (lookupDelta(flowDeltas, equipId) !== undefined) continue;
            const cellEl = findCellEl(equipId);
            if (!cellEl) continue;
            if (assetDelta.category !== 'grey' || (assetDelta.category_q && assetDelta.category_q !== 'grey')) {
                const pStr = fmtDelta(assetDelta.delta_p);
                const qStr = fmtDelta(assetDelta.delta_q);
                // Always apply labels to ensure original flows are replaced
                applyPQLabels(cellEl, pStr, qStr);

                const catP = assetDelta.category_p || assetDelta.category;
                const catQ = assetDelta.category_q || assetDelta.category;

                cellEl.querySelectorAll('.sld-active-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catP}`));
                cellEl.querySelectorAll('.sld-reactive-power .sld-label').forEach(l => l.classList.add(`sld-delta-text-${catQ}`));
            }
        }
        // No deps on purpose: run every render and self-gate via
        // `appliedDeltaSigRef` + DOM presence check. Catches the
        // pan-reconciliation wipe that would otherwise strand the
        // overlay on Flows rendering until a tab switch.
    });

    // ===== Highlight impacted assets on the SLD =====
    // Uses a clone-behind technique: clones target elements and inserts them as
    // direct siblings (before the original) so they naturally track the original
    // during pan/zoom without needing CTM-based repositioning.
    //
    // Uses `useLayoutEffect` with no deps (runs after every render) plus a
    // signature-based guard so we only rewrite the DOM when the highlight
    // inputs actually change, BUT we also detect when the clones have been
    // wiped out from under us (e.g. when the pan transform causes React to
    // reconcile the innerHTML div and replace its children) and re-apply.
    const appliedSigRef = useRef<string>('');
    useLayoutEffect(() => {
        const container = overlayBodyRef.current;
        if (!container || !vlOverlay.svg) return;
        if (previewActive) return;

        // Compute a signature that summarises what SHOULD be highlighted
        // right now. If the signature hasn't changed AND the clones are
        // still in the DOM, there is nothing to do. If the signature is
        // the same but the clones are missing (pan reconciliation ate
        // them), re-apply.
        const actionDetailForSig: ActionDetail | undefined =
            (vlOverlay.actionId && result?.actions) ? result.actions[vlOverlay.actionId] : undefined;
        // Include load-shedding / curtailment / PST identity AND
        // magnitudes in the signature so an in-place re-simulation
        // (which keeps `actionId` the same but bumps the MW / tap
        // value) forces the highlight pass to re-run against the
        // refreshed SLD instead of short-circuiting on stale clones.
        const ls = actionDetailForSig?.load_shedding_details ?? [];
        const cu = actionDetailForSig?.curtailment_details ?? [];
        const pst = actionDetailForSig?.pst_details ?? [];
        const sig = JSON.stringify({
            svgLen: vlOverlay.svg.length,
            meta: vlOverlay.sldMetadata?.length ?? 0,
            tab: vlOverlay.tab,
            actionId: vlOverlay.actionId,
            changedSwitches: vlOverlay.changed_switches
                ? Object.keys(vlOverlay.changed_switches).sort()
                : [],
            branch: selectedContingency.join('+'),
            n1Overloads: result?.lines_overloaded ?? [],
            actionOverloads: actionDetailForSig?.lines_overloaded_after ?? [],
            ls: ls.map(d => `${d.load_name}:${d.shedded_mw}`).sort(),
            cu: cu.map(d => `${d.gen_name}:${d.curtailed_mw}`).sort(),
            pst: pst.map(d => `${d.pst_name}:${d.tap_position}`).sort(),
        });
        const clonesExist = container.querySelector('.sld-highlight-clone') !== null;
        if (sig === appliedSigRef.current && clonesExist) {
            return;
        }
        appliedSigRef.current = sig;

        // Remove previous highlight clones
        container.querySelectorAll('.sld-highlight-clone').forEach(el => el.remove());

        // Remove previous "-original" classes from assets
        const ORIGINAL_CLASSES = [
            'sld-highlight-contingency-original',
            'sld-highlight-action-original',
            'sld-highlight-breaker-original',
            'sld-highlight-overloaded-original'
        ];
        container.querySelectorAll(ORIGINAL_CLASSES.map(c => '.' + c).join(','))
            .forEach(el => el.classList.remove(...ORIGINAL_CLASSES));

        // Build equipmentId → SVG element ID map from SLD metadata
        const equipIdToSvgIds = new Map<string, string[]>();
        if (vlOverlay.sldMetadata) {
            try {
                const meta = JSON.parse(vlOverlay.sldMetadata) as {
                    nodes?: SldFeederNode[];
                    feederInfos?: SldFeederNode[];
                    feederNodes?: SldFeederNode[];
                };
                const sources = [
                    ...(meta.nodes ?? []),
                    ...(meta.feederInfos ?? []),
                    ...(meta.feederNodes ?? []),
                ];
                for (const fn of sources) {
                    if (fn.equipmentId && fn.id) {
                        const ids = equipIdToSvgIds.get(fn.equipmentId) ?? [];
                        ids.push(fn.id);
                        equipIdToSvgIds.set(fn.equipmentId, ids);
                    }
                }
            } catch {
                // metadata parse failed
            }
        }
        if (equipIdToSvgIds.size === 0) return;

        const svg = container.querySelector('svg');
        if (!svg) return;

        // Build element ID → DOM element map
        const elMap = new Map<string, Element>();
        container.querySelectorAll('[id]').forEach(el => elMap.set(el.id, el));

        const lookupById = (svgId: string): Element | undefined =>
            elMap.get(svgId)
            ?? elMap.get(svgId.replace(/\./g, '_'))
            ?? elMap.get(svgId.replace(/_/g, '.'));

        const walkUpToCell = (el: Element): Element => {
            let cellEl: Element = el;
            let cur: Element | null = el.parentElement;
            while (cur && cur !== container) {
                if (cur.classList.contains('sld-extern-cell') ||
                    cur.classList.contains('sld-intern-cell') ||
                    cur.classList.contains('sld-shunt-cell')) {
                    cellEl = cur;
                    break;
                }
                cur = cur.parentElement;
            }
            return cellEl;
        };

        const findCellForEquipment = (equipId: string): Element | null => {
            const svgIds = equipIdToSvgIds.get(equipId)
                ?? equipIdToSvgIds.get(equipId.replace(/\./g, '_'))
                ?? equipIdToSvgIds.get(equipId.replace(/_/g, '.'));
            if (svgIds) {
                for (const svgId of svgIds) {
                    const el = lookupById(svgId);
                    if (el) return walkUpToCell(el);
                }
            }
            for (const [metaEquipId, metaSvgIds] of equipIdToSvgIds) {
                if (metaEquipId.includes(equipId) || equipId.includes(metaEquipId)) {
                    for (const svgId of metaSvgIds) {
                        const el = lookupById(svgId);
                        if (el) return walkUpToCell(el);
                    }
                }
            }
            const sanitized = equipId.replace(/\./g, '_');
            for (const [eid, el] of elMap) {
                if (eid.includes(equipId) || (sanitized !== equipId && eid.includes(sanitized))) {
                    return walkUpToCell(el);
                }
            }
            return null;
        };

        // Clone an element and insert it right before the original in the DOM.
        // SVG renders in document order, so the clone (earlier) appears behind
        // the original (later). Being a sibling in the same parent group means
        // the clone moves with the original during pan/zoom — no CTM needed.
        const cloneHighlight = (el: Element, highlightClass: string) => {
            const clone = el.cloneNode(true) as SVGGraphicsElement;
            clone.removeAttribute('id');
            clone.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
            clone.classList.add('sld-highlight-clone', highlightClass);
            el.parentNode?.insertBefore(clone, el);
            el.classList.add(highlightClass + '-original');
        };

        const highlightedCells = new Set<Element>();

        const actionId = vlOverlay.actionId;
        const actionDetail: ActionDetail | undefined =
            (actionId && result?.actions) ? result.actions[actionId] : undefined;

        // --- Contingency highlight (contingency and action tabs) ---
        if (vlOverlay.tab !== 'n' && selectedContingency.length > 0) {
            for (const id of selectedContingency) {
                const cell = findCellForEquipment(id);
                if (cell) {
                    cloneHighlight(cell, 'sld-highlight-contingency');
                    highlightedCells.add(cell);
                }
            }
        }

        // --- Action target highlights (action tab) ---
        if (vlOverlay.tab === 'action' && actionDetail) {
            const topo = actionDetail.action_topology;
            const isCoupling = isCouplingAction(actionId, actionDetail.description_unitaire);

            // Collect target equipment IDs from BOTH `action_topology`
            // and the dedicated detail arrays. The two sources can
            // disagree: manually-simulated load-shedding / curtailment
            // actions sometimes arrive with `action_topology = {}` (the
            // grid2op Action object does not expose the fields as public
            // attributes — the backend normally back-fills them in
            // `simulation_mixin.py:598-607` but the fallback has edge
            // cases), while `load_shedding_details` / `curtailment_details`
            // / `pst_details` always carry the equipment names the
            // backend computed for the ActionCard breakdown. Feeding
            // both into `findCellForEquipment` makes the SLD highlight
            // robust regardless of which side populated the data.
            const isLoadShedding = (actionDetail.load_shedding_details?.length ?? 0) > 0;
            const isRenewableCurtailment = (actionDetail.curtailment_details?.length ?? 0) > 0;

            if (!isCoupling) {
                const targetEquipIds = new Set<string>();
                if (topo) {
                    for (const id of Object.keys(topo.lines_ex_bus || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.lines_or_bus || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.gens_bus || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.loads_bus || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.pst_tap || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.loads_p || {})) targetEquipIds.add(id);
                    for (const id of Object.keys(topo.gens_p || {})) targetEquipIds.add(id);
                }
                // Detail-array fallback — covers LS / curtailment / PST
                // actions whose topology was not round-tripped.
                for (const d of actionDetail.load_shedding_details ?? []) {
                    if (d?.load_name) targetEquipIds.add(d.load_name);
                }
                for (const d of actionDetail.curtailment_details ?? []) {
                    if (d?.gen_name) targetEquipIds.add(d.gen_name);
                }
                for (const d of actionDetail.redispatch_details ?? []) {
                    if (d?.gen_name) targetEquipIds.add(d.gen_name);
                }
                for (const d of actionDetail.pst_details ?? []) {
                    if (d?.pst_name) targetEquipIds.add(d.pst_name);
                }

                for (const equipId of targetEquipIds) {
                    let cell: Element | null = findCellForEquipment(equipId);

                    // Extreme fallback for load-shedding / curtailment:
                    // when the SLD metadata's `equipmentId` doesn't match
                    // the grid2op load / generator name (e.g. pypowsybl
                    // returns a fully-qualified IIDM connectable ID but
                    // the action carries a bare "P.SAO3TR311"), fall back
                    // to matching on the rendered text label. The label
                    // almost always carries the short grid2op name, so
                    // scanning <text> nodes for a 5-character prefix
                    // reliably lands on the shed load / curtailed
                    // generator cell. Parity with the legacy standalone
                    // at `standalone_interface_legacy.html:5462-5472`,
                    // which is what made the LS highlight work on the
                    // `bare_env_small_grid_test` data where metadata
                    // equipment IDs and action names disagree.
                    if (!cell && (isRenewableCurtailment || isLoadShedding)) {
                        const texts = container.querySelectorAll('text');
                        const q = equipId.toLowerCase().substring(0, 5);
                        if (q) {
                            for (const txt of Array.from(texts)) {
                                const content = (txt.textContent ?? '').toLowerCase();
                                if (content.includes(q)) {
                                    cell = walkUpToCell(txt);
                                    if (cell) break;
                                }
                            }
                        }
                    }

                    if (cell && !highlightedCells.has(cell)) {
                        cloneHighlight(cell, 'sld-highlight-action');
                        highlightedCells.add(cell);
                    }
                }
            }

            if (topo) {

                // Highlight affected breakers/switches.
                // Prefer changed_switches from SLD response (robust N-1 vs action comparison)
                // over action_topology.switches (may be empty for grid2op actions).
                const changedSwitches = vlOverlay.changed_switches;
                const topoSwitches = topo.switches as Record<string, unknown> | undefined;
                const switchSource = changedSwitches && Object.keys(changedSwitches).length > 0
                    ? changedSwitches
                    : topoSwitches;
                // Coupling action breakers highlighted yellow (same as action targets);
                // regular breaker/switch actions use purple.
                const breakerClass = isCoupling ? 'sld-highlight-action' : 'sld-highlight-breaker';
                if (switchSource) {
                    for (const switchId of Object.keys(switchSource)) {
                        const cell = findCellForEquipment(switchId);
                        if (cell && !highlightedCells.has(cell)) {
                            cloneHighlight(cell, breakerClass);
                            highlightedCells.add(cell);
                        }
                    }
                }
            }

            // Fallback: parse description for breaker/switch names
            const breakerClass = isCouplingAction(actionId, actionDetail.description_unitaire)
                ? 'sld-highlight-action' : 'sld-highlight-breaker';
            const desc = actionDetail.description_unitaire;
            if (desc && highlightedCells.size === 0) {
                const ocMatch = desc.match(/OC\s+'([^']+)'/);
                if (ocMatch) {
                    const ocName = ocMatch[1].replace(/\s+DJ_OC$/, '');
                    const cell = findCellForEquipment(ocName);
                    if (cell && !highlightedCells.has(cell)) {
                        cloneHighlight(cell, breakerClass);
                        highlightedCells.add(cell);
                    }
                }
                const lineMatch = desc.match(/(?:Ouverture|Fermeture)\s+(\S+)\s+DJ_OC/);
                if (lineMatch) {
                    const cell = findCellForEquipment(lineMatch[1]);
                    if (cell && !highlightedCells.has(cell)) {
                        cloneHighlight(cell, breakerClass);
                        highlightedCells.add(cell);
                    }
                }
            }
        }

        // --- Overloaded lines ---
        // N-1 tab: highlight overloads present in the N-1 state.
        // Action tab: highlight post-action overloads (overloads that persist or new
        // ones that emerged). Overloads solved by the action are NOT highlighted here.
        //
        // "Solved" = max_rho <= monitoringFactor — matches the ActionCard's
        // orange/green severity classification. Suppressing the halo in
        // this band aligns the SLD with the card's label and with the
        // corresponding NAD gate in App.tsx. Without this, manually
        // simulated actions in the low-margin band (raw rho in
        // `[mf, 1.0)`) showed halos while suggested actions with the
        // same displayed max_rho did not — the backend thresholds
        // diverge (`simulation_mixin.py:536` vs `analysis_mixin.py:97`).
        let overloadedLinesToShow: string[] | undefined;
        if (vlOverlay.tab === 'contingency') {
            overloadedLinesToShow = result?.lines_overloaded;
        } else if (vlOverlay.tab === 'action' && actionDetail) {
            const isSolved = actionDetail.max_rho != null
                && actionDetail.max_rho <= monitoringFactor;
            overloadedLinesToShow = isSolved ? [] : actionDetail.lines_overloaded_after;
        }
        if (overloadedLinesToShow && overloadedLinesToShow.length > 0) {
            for (const lineId of overloadedLinesToShow) {
                const cell = findCellForEquipment(lineId);
                if (cell && !highlightedCells.has(cell)) {
                    cloneHighlight(cell, 'sld-highlight-overloaded');
                    highlightedCells.add(cell);
                }
            }
        }

        // No deps on purpose: this layoutEffect intentionally runs after
        // every render and self-gates via `appliedSigRef` + `clonesExist`.
        // That way, if React reconciles the innerHTML container during a
        // pan and drops the clones, we immediately replant them instead
        // of waiting for a tab switch to re-trigger the effect.
    });

    // Repaint pending switch toggles whenever the override map or the
    // SLD content changes. Walks the SLD metadata to find every SVG
    // element id mapped to a switch equipmentId, then adds the
    // ``sld-user-toggle-{open,closed}`` class on the enclosing cell
    // (same ancestor lookup used by the delta + highlight passes).
    useLayoutEffect(() => {
        const container = overlayBodyRef.current;
        if (!container) return;
        const CUE_AND_STAGED = [
            'sld-user-toggle-open', 'sld-user-toggle-closed', 'sld-user-injection',
            'sld-switch-editable', 'sld-injection-editable',
        ];
        container.querySelectorAll(CUE_AND_STAGED.map(c => '.' + c).join(','))
            .forEach(el => el.classList.remove(...CUE_AND_STAGED));

        // In edit mode: (1) mark EVERY editable breaker / load / generator
        // with a persistent "clickable" cue so the operator sees what can be
        // manipulated, and (2) outline the staged switch toggles AND
        // injection retunes — even on the preview — so they keep seeing WHERE
        // the network changed. When a maneuver row is focused, only that
        // staged element keeps its outline (the cue is unaffected).
        if (!editMode) return;
        const switchBaseline = vlOverlay.switch_states ?? {};
        const injectionBaseline = vlOverlay.injections ?? {};
        const switchEntries = pendingSwitches ? Object.entries(pendingSwitches) : [];
        const injectionIds = pendingInjections ? Object.keys(pendingInjections) : [];
        const hasCueTargets = Object.keys(switchBaseline).length > 0
            || Object.keys(injectionBaseline).length > 0;
        if (!hasCueTargets && switchEntries.length === 0 && injectionIds.length === 0) return;

        const equipIdToSvgIds = new Map<string, string[]>();
        if (activeMetadata) {
            try {
                const meta = JSON.parse(activeMetadata) as {
                    nodes?: SldFeederNode[];
                    feederInfos?: SldFeederNode[];
                    feederNodes?: SldFeederNode[];
                };
                const sources = [
                    ...(meta.nodes ?? []),
                    ...(meta.feederInfos ?? []),
                    ...(meta.feederNodes ?? []),
                ];
                for (const fn of sources) {
                    if (fn.equipmentId && fn.id) {
                        const ids = equipIdToSvgIds.get(fn.equipmentId) ?? [];
                        ids.push(fn.id);
                        equipIdToSvgIds.set(fn.equipmentId, ids);
                    }
                }
            } catch {
                return;
            }
        }

        const elMap = new Map<string, Element>();
        container.querySelectorAll('[id]').forEach(el => elMap.set(el.id, el));
        const lookupById = (svgId: string): Element | undefined =>
            elMap.get(svgId)
            ?? elMap.get(svgId.replace(/\./g, '_'))
            ?? elMap.get(svgId.replace(/_/g, '.'));

        const paintCell = (equipmentId: string, cls: string, respectFocus: boolean) => {
            if (respectFocus && focusedSwitchId && equipmentId !== focusedSwitchId) return;
            const svgIds = equipIdToSvgIds.get(equipmentId)
                ?? equipIdToSvgIds.get(equipmentId.replace(/\./g, '_'))
                ?? equipIdToSvgIds.get(equipmentId.replace(/_/g, '.'));
            for (const sid of svgIds ?? [equipmentId]) {
                const el = lookupById(sid);
                if (!el) continue;
                const cell = el.closest('.sld-extern-cell, .sld-intern-cell, .sld-shunt-cell') ?? el;
                cell.classList.add(cls);
            }
        };

        // (1) Persistent clickable cue on every editable element.
        for (const equipmentId of Object.keys(switchBaseline)) {
            paintCell(equipmentId, 'sld-switch-editable', false);
        }
        for (const equipmentId of Object.keys(injectionBaseline)) {
            paintCell(equipmentId, 'sld-injection-editable', false);
        }
        // (2) Staged-change outlines (focus-filtered).
        for (const [equipmentId, targetOpen] of switchEntries) {
            paintCell(equipmentId, targetOpen ? 'sld-user-toggle-open' : 'sld-user-toggle-closed', true);
        }
        for (const equipmentId of injectionIds) {
            paintCell(equipmentId, 'sld-user-injection', true);
        }
    });

    // Render every editable injection's NAME as a dark-blue button: inject a
    // rounded <rect> behind the matching name <text> and recolour the label
    // on top (CSS). The whole thing is the click target that opens the
    // active-power editor (data-injection-equip, read by the click delegate).
    //
    // Runs every render and self-gates via signature + presence (same pattern
    // as the delta / highlight passes above): the action / contingency
    // highlight effect CLONES cells (the clone is inserted before the
    // original and later removed), so (a) we must skip clones when matching
    // the name text — otherwise the button lands on the soon-to-be-removed
    // clone and the action target's name loses its button — and (b) we must
    // re-apply if a reconciliation / tab switch drops the buttons.
    const appliedNameBtnSigRef = useRef<string>('');
    useLayoutEffect(() => {
        const container = overlayBodyRef.current;
        if (!container) return;
        const injections = editMode ? vlOverlay.injections : undefined;
        const ids = injections ? Object.keys(injections) : [];
        const sig = JSON.stringify({
            edit: editMode,
            ids: [...ids].sort(),
            svgLen: activeSvg?.length ?? 0,
            tab: vlOverlay.tab,
            action: vlOverlay.actionId,
            preview: previewActive,
        });
        const btnsPresent = container.querySelector('.sld-injection-name-btn') !== null;
        const expectBtns = ids.length > 0 && !!activeSvg;
        if (sig === appliedNameBtnSigRef.current && (expectBtns ? btnsPresent : !btnsPresent)) {
            return;
        }
        appliedNameBtnSigRef.current = sig;

        container.querySelectorAll('.sld-injection-name-btn').forEach(el => el.remove());
        container.querySelectorAll('.sld-injection-name-label').forEach(el => {
            el.classList.remove('sld-injection-name-label');
            el.removeAttribute('data-injection-equip');
        });
        if (!injections || ids.length === 0) return;

        const SVGNS = 'http://www.w3.org/2000/svg';
        // Skip highlight clones — they carry a copy of the name text but are
        // removed on the next render, so a button placed on a clone vanishes.
        const texts = Array.from(container.querySelectorAll<SVGTextElement>('text'))
            .filter(t => !t.closest('.sld-highlight-clone'));
        for (const equipmentId of ids) {
            const variants = new Set([
                equipmentId,
                equipmentId.replace(/\./g, '_'),
                equipmentId.replace(/_/g, '.'),
            ]);
            const textEl = texts.find(t => variants.has((t.textContent ?? '').trim()));
            if (!textEl || !textEl.parentNode) continue;
            let bbox: DOMRect;
            try {
                bbox = textEl.getBBox();
            } catch {
                continue; // getBBox unavailable (jsdom) / not laid out
            }
            if (!(bbox.width > 0 && bbox.height > 0)) continue;
            const padX = 4, padY = 2.5;
            const rect = document.createElementNS(SVGNS, 'rect');
            rect.setAttribute('x', String(bbox.x - padX));
            rect.setAttribute('y', String(bbox.y - padY));
            rect.setAttribute('width', String(bbox.width + padX * 2));
            rect.setAttribute('height', String(bbox.height + padY * 2));
            rect.setAttribute('rx', '3');
            rect.setAttribute('class', 'sld-injection-name-btn');
            rect.setAttribute('data-injection-equip', equipmentId);
            textEl.parentNode.insertBefore(rect, textEl);
            textEl.classList.add('sld-injection-name-label');
            textEl.setAttribute('data-injection-equip', equipmentId);
        }
        // No deps on purpose — runs every render, self-gates via the
        // signature + presence probe above (catches clone churn + drops).
    });

    // Delegate switch clicks on the SVG body when edit mode is on.
    // We attach to the body container (capture phase) so taps on the
    // breaker's nested children still fire. The ``equipmentId`` is
    // resolved via the SLD metadata — switches not present in the
    // baseline ``switch_states`` map are silently ignored by
    // ``useSldTopologyEdit.toggleSwitch``.
    useEffect(() => {
        const container = overlayBodyRef.current;
        if (!container) return;
        if (!editMode) return;
        const editableSwitches = vlOverlay.switch_states ?? {};
        const editableInjections = vlOverlay.injections ?? {};
        const canSwitch = !!onSwitchClick && Object.keys(editableSwitches).length > 0;
        const canInjection = !!onInjectionStage && Object.keys(editableInjections).length > 0;
        if (!canSwitch && !canInjection) return;

        const svgToEquip = new Map<string, string>();
        if (activeMetadata) {
            try {
                const meta = JSON.parse(activeMetadata) as {
                    nodes?: SldFeederNode[];
                    feederInfos?: SldFeederNode[];
                    feederNodes?: SldFeederNode[];
                };
                const sources = [
                    ...(meta.nodes ?? []),
                    ...(meta.feederInfos ?? []),
                    ...(meta.feederNodes ?? []),
                ];
                for (const fn of sources) {
                    if (fn.equipmentId && fn.id) {
                        svgToEquip.set(fn.id, fn.equipmentId);
                        svgToEquip.set(fn.id.replace(/\./g, '_'), fn.equipmentId);
                        svgToEquip.set(fn.id.replace(/_/g, '.'), fn.equipmentId);
                    }
                }
            } catch {
                return;
            }
        }

        // SVG ids that resolve to an editable switch — the candidate set
        // for the near-miss snap below.
        const editableSvgIds: string[] = [];
        for (const [svgId, equip] of svgToEquip) {
            if (equip in editableSwitches) editableSvgIds.push(svgId);
        }

        // Open the floating injection editor anchored near the click. The
        // anchor is body-relative (untransformed) and clamped so the bubble
        // stays inside the overlay body (which clips overflow).
        const openInjectionEditor = (equip: string, ev: MouseEvent) => {
            const POP_W = 218, POP_H = 190;
            const rect = container.getBoundingClientRect();
            const x = Math.max(4, Math.min(ev.clientX - rect.left + 8, rect.width - POP_W));
            const y = Math.max(4, Math.min(ev.clientY - rect.top + 8, rect.height - POP_H));
            setInjectionPopover({ equipmentId: equip, x, y });
        };

        // Generous click target: pypowsybl draws breaker / disconnector
        // glyphs as small squares, so requiring a pixel-perfect hit made
        // the operator click several times around the object. When the
        // pointer doesn't land squarely on a switch we snap to the
        // closest editable one within this radius (screen px).
        const SNAP_PX = 26;

        const onClick = (ev: MouseEvent) => {
            // A drag-to-pan also ends in a `click`; only a (near-)
            // stationary press should toggle a switch / open the editor.
            if (panMovedRef.current) return;
            const target = ev.target as Element | null;
            if (!target) return;

            // Clicks inside the injection editor bubble must NOT fall through
            // to the diagram. The bubble is a DOM descendant of the body, so
            // this CAPTURE-phase listener fires for them too — and the
            // near-miss snap below would toggle a switch under the bubble,
            // turning an "Appliquer" into a spurious topology maneuver. A
            // React stopPropagation on the bubble can't stop a capture-phase
            // native listener, so we filter here.
            if (target.closest('[data-testid="sld-injection-popover"]')) return;

            // Injection NAME button (rect / label tagged with
            // data-injection-equip) — opens the active-power editor.
            const nameHit = target.closest('[data-injection-equip]');
            if (nameHit && canInjection) {
                const eq = nameHit.getAttribute('data-injection-equip');
                if (eq && eq in editableInjections) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    openInjectionEditor(eq, ev);
                    return;
                }
            }

            // Exact hit: pointer landed on the glyph or one of its children.
            let cur: Element | null = target;
            while (cur && cur !== container) {
                if (cur.id) {
                    const equip = svgToEquip.get(cur.id);
                    if (equip && canSwitch && equip in editableSwitches) {
                        ev.stopPropagation();
                        ev.preventDefault();
                        setInjectionPopover(null);
                        onSwitchClick!(equip);
                        return;
                    }
                    if (equip && canInjection && equip in editableInjections) {
                        ev.stopPropagation();
                        ev.preventDefault();
                        openInjectionEditor(equip, ev);
                        return;
                    }
                }
                cur = cur.parentElement;
            }

            // Near-miss: snap to the closest editable switch within
            // SNAP_PX (breakers are the small targets that need this;
            // load / gen glyphs are large enough for an exact hit).
            // Resolve elements fresh on each click — a pan reconciliation
            // can replace the inner SVG nodes, so cached references go stale.
            if (!canSwitch) return;
            const elMap = new Map<string, Element>();
            container.querySelectorAll('[id]').forEach(el => elMap.set(el.id, el));
            let bestEquip: string | null = null;
            let bestDist = SNAP_PX;
            for (const svgId of editableSvgIds) {
                const el = elMap.get(svgId);
                if (!el) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const dx = Math.max(rect.left - ev.clientX, 0, ev.clientX - rect.right);
                const dy = Math.max(rect.top - ev.clientY, 0, ev.clientY - rect.bottom);
                const dist = Math.hypot(dx, dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestEquip = svgToEquip.get(svgId) ?? null;
                }
            }
            if (bestEquip) {
                ev.stopPropagation();
                ev.preventDefault();
                setInjectionPopover(null);
                onSwitchClick!(bestEquip);
            }
        };
        container.addEventListener('click', onClick, true);
        return () => { container.removeEventListener('click', onClick, true); };
    }, [editMode, onSwitchClick, onInjectionStage, activeMetadata, vlOverlay.switch_states, vlOverlay.injections, activeSvg]);

    // Non-passive wheel zoom on overlay body
    useEffect(() => {
        const el = overlayBodyRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const rect = el.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            setOverlayTransform(prev => {
                const s = Math.max(0.1, Math.min(10, prev.scale * factor));
                return { scale: s, tx: cx - (cx - prev.tx) * (s / prev.scale), ty: cy - (cy - prev.ty) * (s / prev.scale) };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // Use the owner window of the event target so drag still works when
    // the SLD overlay is portaled into a detached popup window.
    const startOverlayDrag = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const ownerWindow = (e.currentTarget as HTMLElement).ownerDocument.defaultView ?? window;
        const x0 = e.clientX, y0 = e.clientY;
        const px0 = overlayPos.x, py0 = overlayPos.y;
        const onMove = (ev: MouseEvent) => setOverlayPos({ x: px0 + ev.clientX - x0, y: py0 + ev.clientY - y0 });
        const onUp = () => { ownerWindow.removeEventListener('mousemove', onMove); ownerWindow.removeEventListener('mouseup', onUp); };
        ownerWindow.addEventListener('mousemove', onMove);
        ownerWindow.addEventListener('mouseup', onUp);
    };

    const startOverlayPan = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        panMovedRef.current = false;
        const ownerWindow = (e.currentTarget as HTMLElement).ownerDocument.defaultView ?? window;
        const x0 = e.clientX, y0 = e.clientY;
        const tx0 = overlayTransform.tx, ty0 = overlayTransform.ty;
        const onMove = (ev: MouseEvent) => {
            if (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 3) {
                panMovedRef.current = true;
            }
            setOverlayTransform(prev => ({ ...prev, tx: tx0 + ev.clientX - x0, ty: ty0 + ev.clientY - y0 }));
        };
        const onUp = () => { ownerWindow.removeEventListener('mousemove', onMove); ownerWindow.removeEventListener('mouseup', onUp); };
        ownerWindow.addEventListener('mousemove', onMove);
        ownerWindow.addEventListener('mouseup', onUp);
    };

    return (
        <div
            data-testid="sld-overlay"
            data-vl-name={vlOverlay.vlName}
            style={{
                position: 'absolute', top: overlayPos.y + 'px', left: overlayPos.x + 'px',
                width: overlaySize ? overlaySize.w + 'px' : '440px',
                height: overlaySize ? overlaySize.h + 'px' : '420px',
                minWidth: '220px', minHeight: '150px', maxWidth: '95vw', maxHeight: '92vh',
                background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: '8px',
                boxShadow: '0 4px 24px rgba(0,0,0,0.22)', zIndex: 45,
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                resize: 'both', boxSizing: 'border-box',
            }}
        >
            {/* Header — drag handle */}
            <div
                onMouseDown={startOverlayDrag}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: colors.successSoft, borderBottom: `1px solid ${colors.successSoft}`, flexShrink: 0, cursor: 'move', userSelect: 'none' }}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: colors.successText }}>{vlOverlay.vlName}</span>
                        {/* Mode indicator — shows which Flow vs Impact mode was active when overlay opened */}
                        <span style={{
                            fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '10px',
                            background: actionViewMode === 'delta' ? colors.brandSoft : colors.surfaceMuted,
                            color: actionViewMode === 'delta' ? colors.brandStrong : colors.textPrimary,
                        }}>
                            {actionViewMode === 'delta' ? 'Impacts' : 'Flows'}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        {(['n', 'contingency', 'action'] as SldTab[]).filter(tabMode => {
                            if (tabMode === 'contingency') return !!n1Diagram;
                            // The SLD's "action" sub-tab depends on the
                            // overlay being scoped to an action — NOT on
                            // the main-window NAD already being on the
                            // action variant. The overflow-graph pin
                            // double-click opens the SLD overlay with
                            // ``vlOverlay.actionId`` set BEFORE any
                            // top-level action diagram has been loaded;
                            // hiding the tab in that case would strand
                            // the operator on a card-less variant view.
                            if (tabMode === 'action') {
                                return !!actionDiagram || !!vlOverlay.actionId;
                            }
                            return true; // always show N
                        }).map(tabMode => (
                            <button
                                key={tabMode}
                                onMouseDown={e => e.stopPropagation()}
                                onClick={(e) => { e.stopPropagation(); onOverlaySldTabChange(tabMode); }}
                                style={{
                                    background: vlOverlay.tab === tabMode ? colors.successStrong : colors.surfaceMuted,
                                    color: vlOverlay.tab === tabMode ? colors.textOnBrand : colors.textPrimary,
                                    border: 'none', borderRadius: '4px', padding: '2px 8px',
                                    fontSize: '11px', fontWeight: vlOverlay.tab === tabMode ? 'bold' : 'normal',
                                    cursor: vlOverlay.loading ? 'wait' : 'pointer',
                                }}
                            >
                                {tabMode === 'contingency'
                                    ? (selectedContingency.length > 1 ? `N-${selectedContingency.length}` : 'N-1')
                                    : tabMode.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onOverlayClose(); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: colors.textTertiary, lineHeight: 1, padding: '0 2px' }}
                        title="Close"
                    >✕</button>
                </div>
            </div>
            {/* Body — pan/zoom canvas */}
            <div
                ref={overlayBodyRef}
                data-testid="sld-overlay-body"
                style={{ flex: 1, overflow: 'hidden', minHeight: 0, cursor: editMode ? 'default' : 'grab', userSelect: 'none', position: 'relative' }}
                onMouseDown={startOverlayPan}
            >
                {vlOverlay.loading && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.textTertiary, fontSize: '13px' }}>
                        Generating diagram…
                    </div>
                )}
                {vlOverlay.error && (
                    <div style={{ padding: '12px', color: colors.danger, fontSize: '12px' }}>{vlOverlay.error}</div>
                )}
                {activeSvg && (
                    <div
                        key={previewActive ? 'preview' : 'baseline'}
                        className={previewStale ? 'sld-preview-stale' : undefined}
                        style={{
                            transformOrigin: '0 0',
                            transform: `translate(${overlayTransform.tx}px,${overlayTransform.ty}px) scale(${overlayTransform.scale})`,
                            padding: '4px',
                        }} dangerouslySetInnerHTML={{ __html: activeSvg }} />
                )}
                {previewLoading && (
                    <div data-testid="sld-preview-loading" style={{
                        position: 'absolute', top: '8px', right: '8px',
                        background: colors.brandSoft, color: colors.brandStrong,
                        fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px',
                    }}>Preview…</div>
                )}
                {injectionPopover && onInjectionStage && vlOverlay.injections?.[injectionPopover.equipmentId] && (
                    <SldInjectionPopover
                        equipmentId={injectionPopover.equipmentId}
                        injection={vlOverlay.injections[injectionPopover.equipmentId]}
                        currentValue={
                            pendingInjections?.[injectionPopover.equipmentId]
                            ?? vlOverlay.injections[injectionPopover.equipmentId].p
                            ?? 0
                        }
                        staged={!!pendingInjections && injectionPopover.equipmentId in pendingInjections}
                        position={{ x: injectionPopover.x, y: injectionPopover.y }}
                        onApply={(p) => { onInjectionStage(injectionPopover.equipmentId, p); setInjectionPopover(null); }}
                        onRemove={() => { onInjectionRemove?.(injectionPopover.equipmentId); setInjectionPopover(null); }}
                        onClose={() => setInjectionPopover(null)}
                    />
                )}
            </div>
            {editMode && onSimulateEdit && onResetEdit
                && ((pendingChanges?.length ?? 0) > 0 || (injectionChanges?.length ?? 0) > 0) && (
                <SldEditPanel
                    pendingChanges={pendingChanges ?? []}
                    injectionChanges={injectionChanges}
                    onReset={onResetEdit}
                    onSimulate={onSimulateEdit}
                    busy={editSimulationBusy}
                    combinedWithActionId={editCombinedWithActionId}
                    focusedSwitchId={focusedSwitchId}
                    onFocus={onSwitchFocus}
                    onRemove={onSwitchRemove}
                    onRemoveMany={onSwitchRemoveMany}
                    onInjectionRemove={onInjectionRemove}
                />
            )}
        </div>
    );
};

export default SldOverlay;
