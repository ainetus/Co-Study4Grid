// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { DiagramData, FlowMetric, MetadataIndex, ViewMode } from '../types';
import {
    applyAffine, BranchIndex, buildLabelItems, invertAffine, layoutLabels, readBranchGeometry, LABEL_HEIGHT_PX,
    type Affine, type BranchGeometry, type LabelItem, type PlacedLabel, type Point,
} from '../utils/svg/branchLabels';
import { GESTURE_PROXY_ATTR } from '../utils/svg/canvasProxy';
import { maxLoading } from '../utils/svg/loadingVisuals';
import { colors, radius, space, text } from '../styles/tokens';

/** Set on the diagram container while this layer labels it: App.css then hides pypowsybl's own flow values. */
export const BRANCH_LABELS_ATTR = 'data-branch-labels';
const FONT_FAMILY = 'Inter, system-ui, Avenir, Helvetica, Arial, sans-serif';
/** Pointer distance (CSS px) within which a branch counts as hovered. */
const HOVER_TOLERANCE_PX = 8;
/** Other branches this much farther (CSS px) are hovered too: parallel circuits drawn over each other. */
const HOVER_TWIN_PX = 2;
/** The most branches one tooltip lists. */
const HOVER_MAX = 4;
const TOOLTIP_OFFSET_PX = 14;

interface BranchLabelLayerProps {
    /** The tab's diagram container (MemoizedSvgContainer), whose `<svg>` this layer labels. */
    containerRef: RefObject<HTMLDivElement | null>;
    diagram: DiagramData | null;
    metaIndex: MetadataIndex | null;
    mode: ViewMode;
    metric: FlowMetric;
    monitoringFactor: number;
    displayName?: (id: string) => string;
    /** The value labels; false for a lighter reading (the hover stays). */
    values?: boolean;
}

interface ViewState {
    diagram: DiagramData | null;
    metaIndex: MetadataIndex | null;
    mode: ViewMode;
    metric: FlowMetric;
    monitoringFactor: number;
    values: boolean;
}

/** What the layout read from the mounted diagram, and the labels of its view. */
interface Cache {
    svg: SVGSVGElement | null;
    metaIndex: MetadataIndex | null;
    geoms: BranchGeometry[];
    index: BranchIndex | null;
    itemsOf: unknown[];
    items: LabelItem[];
}

const isGesture = (container: HTMLElement) =>
    container.classList.contains('svg-interacting') || container.hasAttribute(GESTURE_PROXY_ATTR);

const labelWidths = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Label text width (CSS px): measured on a canvas in a browser, estimated without one (jsdom). */
const measureLabel = (label: string, important: boolean): number => {
    const key = `${important ? 'b' : 'n'}${label}`;
    let w = labelWidths.get(key);
    if (w !== undefined) return w;
    if (measureCtx === undefined) {
        measureCtx = typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)
            ? document.createElement('canvas').getContext('2d') : null;
    }
    const px = important ? 12 : 11;
    if (measureCtx) {
        measureCtx.font = `${important ? 700 : 600} ${px}px ${FONT_FAMILY}`;
        w = measureCtx.measureText(label).width;
    } else {
        w = label.length * px * 0.62;
    }
    labelWidths.set(key, w);
    return w;
};

/**
 * Readable flow labels over a NAD tab, in CSS px whatever the zoom:
 * pypowsybl's own values are user units, specks on a large grid until the
 * operator zooms far in. Laid out by utils/svg/branchLabels.ts each time the
 * view settles — hidden during a pan / zoom gesture — for the tab's view
 * (Flows / Impacts × MW / Loading %). Hovering a branch tells both its ends:
 * their voltage level, active power and loading.
 */
export default function BranchLabelLayer({
    containerRef, diagram, metaIndex, mode, metric, monitoringFactor, displayName, values = true,
}: BranchLabelLayerProps) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const [placed, setPlaced] = useState<PlacedLabel[]>([]);
    const [hovered, setHovered] = useState<BranchGeometry[]>([]);

    // The callbacks below (timer, observers, pointer) read the latest view from here.
    const latest = useRef<ViewState>({ diagram, metaIndex, mode, metric, monitoringFactor, values });
    useLayoutEffect(() => {
        latest.current = { diagram, metaIndex, mode, metric, monitoringFactor, values };
    });
    const cache = useRef<Cache>({ svg: null, metaIndex: null, geoms: [], index: null, itemsOf: [], items: [] });
    // The settled view's client → user mapping, for the hover.
    const viewRef = useRef<{ inverse: Affine; pxPerUnit: number } | null>(null);
    const pointer = useRef<Point>([0, 0]);
    // The hovered branches, as last shown (the state below re-renders the tooltip).
    const hoverRef = useRef<BranchGeometry[]>([]);
    const showHover = useCallback((geoms: BranchGeometry[]) => {
        const current = hoverRef.current;
        if (geoms.length === current.length && geoms.every((g, i) => g === current[i])) return;
        hoverRef.current = geoms;
        setHovered(geoms);
    }, []);

    const relayout = useCallback(() => {
        const container = containerRef.current;
        const wrap = wrapRef.current;
        if (!container || !wrap) return;
        if (isGesture(container)) {
            wrap.style.visibility = 'hidden';
            return;
        }
        // The view moved under a still pointer: the tooltip is stale.
        showHover([]);
        const svg = container.querySelector<SVGSVGElement>(':scope > svg');
        const { diagram: d, metaIndex: meta, mode: m, metric: k, monitoringFactor: mf, values: show } = latest.current;
        const c = cache.current;
        if (!svg || !d || !meta) {
            viewRef.current = null;
            setPlaced([]);
            return;
        }
        // A hidden tab (display: none) waits until it shows: the ResizeObserver brings it back.
        const rect = wrap.getBoundingClientRect();
        const ctm = svg.getScreenCTM?.();
        if (!ctm || !(rect.width > 0 && rect.height > 0)) return;
        if (c.svg !== svg || c.metaIndex !== meta) {
            Object.assign(c, { svg, metaIndex: meta, geoms: readBranchGeometry(container, meta), index: null, itemsOf: [] });
        }
        const itemsOf = [d, m, k, mf];
        if (itemsOf.some((v, i) => v !== c.itemsOf[i])) {
            c.items = buildLabelItems(c.geoms, d, m, k, mf);
            c.itemsOf = itemsOf;
        }
        // User units → this layer's CSS px.
        const toLayer: Affine = [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e - rect.left, ctm.f - rect.top];
        const inverse = invertAffine(toLayer);
        if (!inverse) return;
        const project = (p: Point) => applyAffine(toLayer, p);
        const pxPerUnit = Math.hypot(ctm.a, ctm.b);
        viewRef.current = { inverse, pxPerUnit };
        setPlaced(show ? layoutLabels(c.items, { width: rect.width, height: rect.height, project, pxPerUnit, measure: measureLabel }) : []);
        wrap.style.visibility = '';
    }, [containerRef, showHover]);

    // Lay out again once the view settles: a new view or diagram, a new viewBox, the end of a gesture, a resize.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const schedule = useCallback(() => {
        if (timer.current !== null) return;
        timer.current = setTimeout(() => {
            timer.current = null;
            relayout();
        }, 0);
    }, [relayout]);
    useEffect(() => { schedule(); }, [diagram, metaIndex, mode, metric, monitoringFactor, values, schedule]);

    useEffect(() => {
        const container = containerRef.current;
        const wrap = wrapRef.current;
        if (!container || !wrap) return;
        const View = container.ownerDocument.defaultView ?? window;
        container.setAttribute(BRANCH_LABELS_ATTR, '');
        const onGestureChange = () => {
            if (!isGesture(container)) {
                schedule();
                return;
            }
            wrap.style.visibility = 'hidden';
            showHover([]);
        };
        const gesture = new View.MutationObserver(onGestureChange);
        gesture.observe(container, { attributes: true, attributeFilter: ['class', GESTURE_PROXY_ATTR] });
        // The `<svg>` is swapped with each diagram: follow its viewBox, whichever is mounted.
        const viewBox = new View.MutationObserver(schedule);
        const watchSvg = () => {
            viewBox.disconnect();
            const svg = container.querySelector(':scope > svg');
            if (svg) viewBox.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
            schedule();
        };
        const mounted = new View.MutationObserver(watchSvg);
        mounted.observe(container, { childList: true });
        watchSvg();
        const resize = typeof View.ResizeObserver === 'function' ? new View.ResizeObserver(schedule) : null;
        resize?.observe(wrap);
        return () => {
            container.removeAttribute(BRANCH_LABELS_ATTR);
            gesture.disconnect();
            viewBox.disconnect();
            mounted.disconnect();
            resize?.disconnect();
            if (timer.current !== null) {
                clearTimeout(timer.current);
                timer.current = null;
            }
        };
    }, [containerRef, schedule, showHover]);

    // Beside the pointer, on the side where the tooltip fits in the panel.
    const placeTooltip = useCallback(() => {
        const tip = tooltipRef.current;
        const wrap = wrapRef.current;
        if (!tip || !wrap) return;
        const [x, y] = pointer.current;
        const w = tip.offsetWidth, h = tip.offsetHeight;
        const left = x + TOOLTIP_OFFSET_PX + w > wrap.clientWidth ? Math.max(0, x - TOOLTIP_OFFSET_PX - w) : x + TOOLTIP_OFFSET_PX;
        const top = y + TOOLTIP_OFFSET_PX + h > wrap.clientHeight ? Math.max(0, y - TOOLTIP_OFFSET_PX - h) : y + TOOLTIP_OFFSET_PX;
        tip.style.transform = `translate(${left}px, ${top}px)`;
    }, []);

    // Hover: the branch within a few px of the pointer — a grid lookup per move,
    // no hit test of the (huge) diagram, nothing while a button is down.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const onMove = (e: MouseEvent) => {
            const view = viewRef.current;
            const c = cache.current;
            const target = e.target as Element | null;
            if (e.buttons || !view || !c.geoms.length || isGesture(container) || target?.closest?.('.nad-vl-nodes, .nad-label-box')) {
                showHover([]);
                return;
            }
            c.index ??= new BranchIndex(c.geoms);
            const rect = wrapRef.current?.getBoundingClientRect();
            pointer.current = [e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0)];
            const at = applyAffine(view.inverse, pointer.current);
            const loading = latest.current.diagram?.branch_loading;
            // Parallel circuits drawn over each other: the most loaded first.
            const geoms = c.index.nearest(at, HOVER_TOLERANCE_PX / view.pxPerUnit, HOVER_TWIN_PX / view.pxPerUnit)
                .sort((a, b) => (maxLoading(loading?.[b.id]) ?? -1) - (maxLoading(loading?.[a.id]) ?? -1));
            showHover(geoms.slice(0, HOVER_MAX));
            placeTooltip();
        };
        const onLeave = () => showHover([]);
        container.addEventListener('mousemove', onMove, { passive: true });
        container.addEventListener('mouseleave', onLeave);
        return () => {
            container.removeEventListener('mousemove', onMove);
            container.removeEventListener('mouseleave', onLeave);
        };
    }, [containerRef, placeTooltip, showHover]);

    // A newly shown tooltip goes where the pointer is (it then follows it in onMove).
    useLayoutEffect(placeTooltip, [hovered, placeTooltip]);

    // The labels re-render with the layout only, not with the hover.
    const labels = useMemo(() => (
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
            {placed.map(l => (
                <g key={l.key} data-branch={l.id}
                    className={`branch-label branch-label--${l.tone}${l.important ? ' branch-label--important' : ''}`}
                    transform={`translate(${l.x.toFixed(1)},${l.y.toFixed(1)})`}>
                    {/* Outlined in the line's voltage colour, whatever the view; MW Flows writes the text in it too. */}
                    <rect x={-l.w / 2} y={-LABEL_HEIGHT_PX / 2} width={l.w} height={LABEL_HEIGHT_PX} rx={4}
                        style={l.ink ? { stroke: l.ink, strokeWidth: 2.5 } : undefined} />
                    <text textAnchor="middle" dominantBaseline="central"
                        style={l.ink && l.inkText ? { fill: l.ink, fontWeight: 700 } : undefined}>{l.text}</text>
                </g>
            ))}
        </svg>
    ), [placed]);

    return (
        <div ref={wrapRef} data-testid="branch-label-layer" style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 5,
        }}>
            {labels}
            {hovered.length > 0 && diagram && (
                <BranchTooltip ref={tooltipRef} geoms={hovered} diagram={diagram} metaIndex={metaIndex} displayName={displayName} />
            )}
        </div>
    );
}

const fmtMw = (v: number | null) => (v === null ? '—' : `${Math.round(v)} MW`);
const fmtLoading = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} %`);
const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

/** Both ends of each hovered branch: voltage level, active power, loading — and its change in Impacts. */
function BranchTooltip({ ref, geoms, diagram, metaIndex, displayName }: {
    ref: RefObject<HTMLDivElement | null>;
    geoms: BranchGeometry[];
    diagram: DiagramData;
    metaIndex: MetadataIndex | null;
    displayName?: (id: string) => string;
}) {
    const name = (id: string) => displayName?.(id) ?? id;
    const vl = (nodeSvgId: string) => {
        const id = metaIndex?.nodesBySvgId.get(nodeSvgId)?.equipmentId;
        return id ? name(id) : '\u2014';
    };
    const cell = { padding: `1px ${space[2]}`, whiteSpace: 'nowrap' as const };
    return (
        <div ref={ref} data-testid="branch-tooltip" style={{
            position: 'absolute', left: 0, top: 0, maxWidth: '360px',
            background: colors.surface, color: colors.textPrimary, border: `1px solid ${colors.border}`,
            borderRadius: radius.md, boxShadow: '0 4px 14px rgba(0,0,0,0.18)', padding: space[2],
            fontSize: text.xs, lineHeight: 1.4,
        }}>
            {geoms.map((geom, k) => {
                const loading = diagram.branch_loading?.[geom.id];
                const flowDelta = diagram.flow_deltas?.[geom.id];
                const loadingDelta = diagram.loading_deltas?.[geom.id];
                return (
                    <div key={geom.id} data-branch={geom.id} style={k > 0 ? {
                        marginTop: space[2], paddingTop: space[2], borderTop: `1px solid ${colors.borderSubtle}`,
                    } : undefined}>
                        <div style={{ fontWeight: 700, marginBottom: space[1] }}>{name(geom.id)}</div>
                        <table style={{ borderCollapse: 'collapse' }}>
                            <tbody>
                                {([0, 1] as const).map(end => (
                                    <tr key={end}>
                                        <td style={{ ...cell, paddingLeft: 0, color: colors.textSecondary }}>{vl(geom.nodes[end])}</td>
                                        <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtMw(geom.mw[end])}</td>
                                        <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtLoading(loading?.[end])}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {(flowDelta || loadingDelta) && (
                            <div style={{ marginTop: space[1], color: colors.textSecondary }}>
                                {flowDelta && <span>{`\u0394P ${signed(flowDelta.delta)} MW`}</span>}
                                {flowDelta && loadingDelta && ' \u00b7 '}
                                {loadingDelta && <span>{`\u0394 loading ${signed(loadingDelta.delta)} pts`}</span>}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
