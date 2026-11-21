// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextFiliere, ContextMapData, ContextMapHighlight, ViewBox } from '../types';
import type { ContextMapState } from '../hooks/useContextMap';
import { colors, contextFiliereColors, contextMapPalette as P, radius, space, text } from '../styles/tokens';
import { formatMw, highlightBox, productionMix, renderScale } from '../utils/contextMapGeometry';
import ContextMapLayers, { type ContextHover } from './ContextMapLayers';

const FILIERE_LABELS: Record<ContextFiliere, string> = {
    nuclear: 'Nuclear', gas: 'Gas', coal: 'Coal', oil: 'Oil', hydro: 'Hydro', wind: 'Wind',
    solar: 'Solar', biomass: 'Bioenergy', storage: 'Storage (pumping)', other: 'Other',
};
const MESH_LABELS = { region: 'RTE regions', country: 'Countries' } as const;

/** What the map shows: RTE regions, countries — or one country alone. */
const meshLabel = (data: ContextMapData): string =>
    (data.mesh === 'country' && data.home && data.zones.find(z => z.id === data.home)?.label)
    || MESH_LABELS[data.mesh];
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 3;
const WHEEL_SENSITIVITY = 0.0015;
const TOOLTIP_WIDTH = 240;
const SUMMARY_WIDTH = 250;
/** Zoom-to-incident frame: at least this share of the full view, padded. */
const FOCUS_MIN_SHARE = 0.18;
const FOCUS_PAD = 1.4;
const TOOLTIP_OFFSET = 14;

interface ContextMapViewProps {
    state: ContextMapState;
}

/** A floating card in the map's chrome (theme tokens: it flips with dark mode). */
const panel: React.CSSProperties = {
    background: colors.surface, color: colors.textPrimary,
    border: `1px solid ${colors.border}`, borderRadius: radius.lg, padding: `${space[2]} ${space[3]}`,
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)', fontSize: text.sm, lineHeight: 1.45,
};
const card: React.CSSProperties = { ...panel, position: 'absolute', zIndex: 20 };

const Swatch: React.FC<{ color: string; ring?: boolean; dashed?: boolean }> = ({ color, ring, dashed }) => (
    <span aria-hidden style={{
        display: 'inline-block', width: 10, height: 10, marginRight: 6, verticalAlign: 'middle',
        borderRadius: ring ? '50%' : 2,
        background: ring ? 'transparent' : color,
        border: ring ? `2px ${dashed ? 'dashed' : 'solid'} ${color}` : 'none',
    }} />
);

/** Map a client point to the SVG user space (xMidYMid meet viewBox). */
const clientToUser = (svg: SVGSVGElement, vb: ViewBox, clientX: number, clientY: number) => {
    const rect = svg.getBoundingClientRect();
    const a = Math.min(rect.width / vb.w, rect.height / vb.h) || 1;
    const offX = (rect.width - a * vb.w) / 2;
    const offY = (rect.height - a * vb.h) / 2;
    return { x: vb.x + (clientX - rect.left - offX) / a, y: vb.y + (clientY - rect.top - offY) / a, a };
};

/** Loading as an operator reads it: a whole percentage of the limit. */
const pct = (rho: number) => `${Math.round(rho * 100)} %`;

const HoverCard: React.FC<{ hover: ContextHover; monitoringFactor?: number }> = ({ hover, monitoringFactor }) => {
    if (hover.kind === 'plant') {
        const { plant, units } = hover;
        return (
            <>
                <div style={{ fontWeight: 700 }}>{plant.name} — nuclear</div>
                <div>{plant.running} of {plant.units} unit{plant.units > 1 ? 's' : ''} running</div>
                <div>
                    {plant.matched ? 'Estimated output' : 'Output'}: <b>{formatMw(plant.production)}</b>
                    {plant.capacity > 0 && ` of ${formatMw(plant.capacity)}`}
                </div>
                {units.map(u => (
                    <div key={u.id} style={{
                        display: 'flex', justifyContent: 'space-between', gap: 6, paddingLeft: 8, fontSize: text.xs,
                        color: u.running ? colors.textPrimary : colors.textTertiary,
                    }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name ?? u.id}</span>
                        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {u.running ? `${formatMw(u.p)}${u.pmax ? ` · ${Math.round(u.level * 100)} %` : ''}` : 'stopped'}
                        </span>
                    </div>
                ))}
            </>
        );
    }
    if (hover.kind === 'flow') {
        const f = hover.flow;
        return (
            <>
                <div style={{ fontWeight: 700 }}>{hover.fromLabel} → {hover.toLabel}</div>
                <div>{formatMw(f.mw)} · {f.circuits} circuit{f.circuits > 1 ? 's' : ''}</div>
            </>
        );
    }
    if (hover.kind === 'element') {
        const { element, role, rho, rhoBefore } = hover.highlight;
        return (
            <>
                <div style={{ fontWeight: 700 }}>{role === 'contingency' ? 'Contingency' : 'Overload'}: {element.name}</div>
                {element.name !== element.id && <div style={{ color: colors.textSecondary }}>{element.id}</div>}
                {rho !== undefined && (rhoBefore !== undefined
                    ? <div data-testid="context-map-tooltip-loading">
                        Loading: {pct(rhoBefore)} → <b>{pct(rho)}</b> with the contingency
                    </div>
                    : <div data-testid="context-map-tooltip-loading">Loading after contingency: <b>{pct(rho)}</b></div>)}
                {role === 'overload' && monitoringFactor !== undefined && (
                    <div style={{ color: colors.textSecondary, fontSize: text.xs }}>
                        Overloaded from {pct(monitoringFactor)} of its limit (monitoring factor)
                    </div>
                )}
                <div style={{ color: colors.textSecondary }}>
                    {[...new Set(element.zones.filter(Boolean))].join(' – ')}
                    {!element.points && ' (placed by zone: no geographic layout)'}
                </div>
            </>
        );
    }
    const z = hover.zone;
    const mix = (Object.keys(contextFiliereColors) as ContextFiliere[]).filter(f => (z.production[f] ?? 0) > 0);
    return (
        <>
            <div style={{ fontWeight: 700 }}>{z.label}</div>
            <div>Production: {formatMw(z.production_total)}</div>
            {mix.map(f => (
                <div key={f} style={{ paddingLeft: 8 }}>
                    <Swatch color={contextFiliereColors[f]} />{FILIERE_LABELS[f]}: {formatMw(z.production[f] ?? 0)}
                </div>
            ))}
            <div style={{ color: P.consumption }}>Consumption: {formatMw(z.consumption)}</div>
            <div>{z.net_export >= 0 ? 'Net export' : 'Net import'}: {formatMw(z.net_export)}</div>
        </>
    );
};

const formatShare = (share: number): string => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)} %`;
/** A share is written on its bar segment from this size up (else: hover). */
const MIX_LABEL_MIN_SHARE = 0.07;

/**
 * The national mix as one stacked bar, each type's share written on its
 * segment — the pies' colours, whose key is the bottom-left legend.
 */
const MixBar: React.FC<{ mix: { filiere: ContextFiliere; mw: number }[]; total: number }> = ({ mix, total }) => (
    <div data-testid="context-map-mix-bar" role="img"
        aria-label={`Production mix: ${mix.map(m => `${FILIERE_LABELS[m.filiere]} ${formatShare(m.mw / total)}`).join(', ')}`}
        style={{ display: 'flex', height: 16, borderRadius: 4, overflow: 'hidden', margin: '4px 0' }}>
        {mix.map(({ filiere, mw }) => (
            <span key={filiere} data-testid={`context-map-mix-${filiere}`}
                title={`${FILIERE_LABELS[filiere]}: ${formatMw(mw)} (${formatShare(mw / total)})`}
                style={{
                    width: `${(100 * mw) / total}%`, background: contextFiliereColors[filiere],
                    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                    fontSize: 10, fontWeight: 700, lineHeight: 1, whiteSpace: 'nowrap',
                    color: P.halo, textShadow: `0 0 2px ${P.textDark}, 0 0 1px ${P.textDark}`,
                }}>
                {mw / total >= MIX_LABEL_MIN_SHARE ? `${Math.round((100 * mw) / total)} %` : ''}
            </span>
        ))}
    </div>
);

/**
 * A network whose generators carry no type at all (`genreCvg` absent,
 * `energySource` OTHER — e.g. the Game Mode pan-European PyPSA grid): a
 * one-colour "100 %" bar would read as a mix.
 */
const untyped = (mix: { filiere: ContextFiliere }[]): boolean =>
    mix.length > 0 && mix.every(m => m.filiere === 'other');

const DISPATCH_LABELS: Record<string, string> = {
    observed: 'observed dispatch',
    opf: 'optimal dispatch (PyPSA)',
};

/** A real hour rebuilt on the grid: how it was dispatched, whose data — each
 *  licence after the sources it covers (a source may state none). */
const SituationCredit: React.FC<{ situation: NonNullable<ContextMapData['situation']> }> = ({ situation }) => {
    const byLicence = new Map<string, typeof situation.sources>();
    for (const s of situation.sources) byLicence.set(s.licence ?? '', [...(byLicence.get(s.licence ?? '') ?? []), s]);
    return (
        <div data-testid="context-map-situation" style={{ color: colors.textSecondary, fontSize: text.xs }}>
            Real hour, {DISPATCH_LABELS[situation.dispatch] ?? situation.dispatch} — data:{' '}
            {[...byLicence].map(([licence, sources], g) => (
                <React.Fragment key={licence}>
                    {g > 0 && '; '}
                    {sources.map((s, i) => (
                        <React.Fragment key={s.name}>
                            {i > 0 && ', '}
                            <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{s.name}</a>
                        </React.Fragment>
                    ))}
                    {licence && ` (${licence})`}
                </React.Fragment>
            ))}
        </div>
    );
};

/** The situation card, top-left: totals, the national mix bar, exchanges. */
const Summary: React.FC<{ data: ContextMapData }> = ({ data }) => {
    const mix = useMemo(() => productionMix(data), [data]);
    const total = mix.reduce((sum, m) => sum + m.mw, 0);
    return (
        <div data-testid="context-map-summary" style={{ ...panel, width: SUMMARY_WIDTH, boxSizing: 'border-box' }}>
            <div style={{ fontWeight: 700 }}>Situation — {meshLabel(data)}</div>
            {data.case_date && <div style={{ color: colors.textSecondary }}>{data.case_date.replace('T', ' ').slice(0, 16)}</div>}
            <div>Production: <b>{formatMw(data.totals.production)}</b></div>
            {untyped(mix) ? (
                <div data-testid="context-map-mix-untyped" style={{ color: colors.textSecondary, fontSize: text.xs }}>
                    Generation types are not given in this network.
                </div>
            ) : total > 0 && <MixBar mix={mix} total={total} />}
            {data.plant_source && (
                <div data-testid="context-map-plant-source" style={{ color: colors.textSecondary, fontSize: text.xs }}>
                    Mix estimated from the typical output of the plants matched in each zone —{' '}
                    <a href={data.plant_source.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                        {data.plant_source.name}
                    </a>{' '}({data.plant_source.licence})
                </div>
            )}
            {data.situation && <SituationCredit situation={data.situation} />}
            <div style={{ color: P.consumption }}>Consumption: <b>{formatMw(data.totals.consumption)}</b></div>
            {data.totals.net_export !== null && (
                <div>{data.totals.net_export >= 0 ? 'Net exports' : 'Net imports'}: <b>{formatMw(data.totals.net_export)}</b></div>
            )}
            {!data.flows_available && (
                <div style={{ color: colors.warningText, marginTop: 4 }}>
                    The network file carries no flows: transfers are not drawn.
                </div>
            )}
        </div>
    );
};

/** Bottom-left legend: generation-type colours (Carte-Front's production legend) and map symbols. */
const Legend: React.FC<{ data: ContextMapData; showNuclear: boolean; onShowNuclear: (show: boolean) => void }> = ({
    data, showNuclear, onShowNuclear,
}) => {
    const mix = productionMix(data);
    const border = data.flows.some(f => f.kind === 'border');
    const hasNuclear = (data.nuclear?.units.length ?? 0) > 0;
    return (
        <div data-testid="context-map-legend" style={{ ...panel, fontSize: text.xs }}>
            {untyped(mix)
                ? <div><Swatch color={contextFiliereColors.other} />Production (type not given)</div>
                : mix.map(({ filiere: f }) => <div key={f}><Swatch color={contextFiliereColors[f]} />{FILIERE_LABELS[f]}</div>)}
            <div><Swatch color={P.consumption} ring dashed />Consumption</div>
            {data.flows.some(f => f.kind === 'inter_zone') && <div><Swatch color={P.interZone} />Transfer between zones</div>}
            {border && <div><Swatch color={P.export} />Export · <Swatch color={P.import} />Import</div>}
            {hasNuclear && (
                <div data-testid="context-map-nuclear-legend" style={{ marginTop: 4, borderTop: `1px solid ${colors.border}`, paddingTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700, cursor: 'pointer' }}>
                        <input type="checkbox" data-testid="context-map-nuclear-toggle" checked={showNuclear}
                            onChange={e => onShowNuclear(e.target.checked)} style={{ margin: 0 }} />
                        Nuclear units
                    </label>
                    {showNuclear && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span aria-hidden style={{
                                display: 'inline-block', width: 34, height: 8, borderRadius: 4,
                                border: `1px solid ${P.nuclearEdge}`,
                                background: `linear-gradient(to right, ${P.nuclearLow}, ${P.nuclearMid}, ${P.nuclearHigh})`,
                            }} />
                            output / Pmax · <Swatch color={P.nuclearStoppedEdge} ring />stopped
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const HighlightLegend: React.FC<{ highlights: ContextMapHighlight[]; onFocus: () => void }> = ({ highlights, onFocus }) => {
    if (highlights.length === 0) return null;
    const contingency = highlights.filter(h => h.role === 'contingency');
    const overloads = highlights.filter(h => h.role === 'overload');
    return (
        <div data-testid="context-map-highlight-legend" style={{ ...panel, width: SUMMARY_WIDTH, boxSizing: 'border-box' }}>
            {contingency.length > 0 && (
                <div><Swatch color="var(--signal-contingency)" /><b>Contingency</b>: {contingency.map(h => h.element.name).join(', ')}</div>
            )}
            {overloads.length > 0 && (
                <div>
                    <Swatch color="var(--signal-overload)" /><b>Overloads</b>:{' '}
                    {overloads.map(h => h.rho !== undefined ? `${h.element.name} (${Math.round(h.rho * 100)} %)` : h.element.name).join(', ')}
                </div>
            )}
            <button type="button" data-testid="context-map-focus" onClick={onFocus} style={{
                marginTop: 4, padding: '2px 10px', borderRadius: radius.md, cursor: 'pointer', fontSize: text.xs,
                border: `1px solid ${colors.border}`, background: colors.surfaceRaised, color: colors.textPrimary,
            }}>
                Zoom to {contingency.length > 0 ? 'contingency' : 'overloads'}
            </button>
        </div>
    );
};

/**
 * The Context tab: the Carte-Front situation map of the loaded study —
 * zones with their production mix and consumption, transfers between
 * them, neighbour exchanges — plus the contingency and its overloads in
 * Co-Study's halo colours. Wheel to zoom, drag to pan, double-click to
 * reset.
 */
const ContextMapView: React.FC<ContextMapViewProps> = ({ state }) => {
    const { data, loading, error, highlights } = state;
    const svgRef = useRef<SVGSVGElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const base = useMemo<ViewBox | null>(() => {
        if (!data) return null;
        const k = renderScale(data.bounds);
        return { x: data.bounds[0] * k, y: data.bounds[1] * k, w: data.bounds[2] * k, h: data.bounds[3] * k };
    }, [data]);
    const [viewBox, setViewBox] = useState<ViewBox | null>(base);
    const [hover, setHover] = useState<{ hover: ContextHover; x: number; y: number } | null>(null);
    const drag = useRef<{ x: number; y: number; vb: ViewBox; a: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [showNuclear, setShowNuclear] = useState(true);

    // A new map opens on its own frame.
    useEffect(() => { setViewBox(base); }, [base]);
    /** The operator moved the map since the contingency was set: no auto-framing. */
    const movedRef = useRef(false);

    const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
        setViewBox(vb => {
            if (!vb || !base) return vb;
            const w = Math.min(Math.max(vb.w * factor, base.w * ZOOM_MIN), base.w * ZOOM_MAX);
            const f = w / vb.w;
            const px = cx ?? vb.x + vb.w / 2;
            const py = cy ?? vb.y + vb.h / 2;
            return { x: px - (px - vb.x) * f, y: py - (py - vb.y) * f, w, h: vb.h * f };
        });
    }, [base]);

    // Wheel zoom around the cursor; a native listener so it can preventDefault.
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            movedRef.current = true;
            setViewBox(vb => {
                if (!vb || !base) return vb;
                const p = clientToUser(svg, vb, e.clientX, e.clientY);
                const w = Math.min(Math.max(vb.w * Math.exp(e.deltaY * WHEEL_SENSITIVITY), base.w * ZOOM_MIN), base.w * ZOOM_MAX);
                const f = w / vb.w;
                return { x: p.x - (p.x - vb.x) * f, y: p.y - (p.y - vb.y) * f, w, h: vb.h * f };
            });
        };
        svg.addEventListener('wheel', onWheel, { passive: false });
        return () => svg.removeEventListener('wheel', onWheel);
    }, [base, data]);

    const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
        if (!viewBox || e.button !== 0) return;
        const { a } = clientToUser(e.currentTarget, viewBox, e.clientX, e.clientY);
        drag.current = { x: e.clientX, y: e.clientY, vb: viewBox, a };
        setDragging(true);
        setHover(null);
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const d = drag.current;
        if (!d) return;
        movedRef.current = true;
        setViewBox({ ...d.vb, x: d.vb.x - (e.clientX - d.x) / d.a, y: d.vb.y - (e.clientY - d.y) / d.a });
    };
    const endDrag = () => { drag.current = null; setDragging(false); };

    // Frame the studied elements, at least a few regions wide for context.
    const focusHighlights = useCallback(() => {
        const box = data ? highlightBox(data, highlights) : null;
        if (!box || !base) return;
        const w = Math.max(box.w, box.h * (base.w / base.h), base.w * FOCUS_MIN_SHARE) * FOCUS_PAD;
        const h = w * (base.h / base.w);
        setViewBox({ x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h });
    }, [data, highlights, base]);

    // A contingency opens framed — itself, then with its overloads once the
    // N-1 result names them — unless the operator has moved the map since.
    const contingencyKey = highlights.filter(h => h.role === 'contingency').map(h => h.element.id).join('|');
    const highlightKey = highlights.map(h => h.element.id).join('|');
    useEffect(() => { movedRef.current = false; }, [contingencyKey]);
    useEffect(() => {
        if (highlightKey && !movedRef.current) focusHighlights();
    }, [highlightKey, focusHighlights]);

    const onHover = useCallback((h: ContextHover | null, e?: React.MouseEvent) => {
        if (!h || !e || drag.current) { setHover(null); return; }
        const rect = containerRef.current?.getBoundingClientRect();
        // Keep the card inside the tab: flip it left of the cursor near the edge.
        const x = e.clientX - (rect?.left ?? 0);
        const left = rect && x + TOOLTIP_OFFSET + TOOLTIP_WIDTH > rect.width
            ? x - TOOLTIP_OFFSET - TOOLTIP_WIDTH : x + TOOLTIP_OFFSET;
        setHover({ hover: h, x: Math.max(0, left), y: e.clientY - (rect?.top ?? 0) + TOOLTIP_OFFSET });
    }, []);

    if (!data) {
        return (
            <div data-testid="context-map-placeholder" style={{
                width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: error ? colors.dangerText : colors.textSecondary, background: colors.surface,
            }}>
                {loading ? 'Loading the situation map…' : error ? `Context map unavailable: ${error}` : 'Load a study to see its situation map.'}
            </div>
        );
    }

    const vb = viewBox ?? base!;
    return (
        <div ref={containerRef} data-testid="context-map" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: P.sea }}>
            <svg
                ref={svgRef}
                role="img"
                aria-label={`Situation map — ${meshLabel(data)}`}
                viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ width: '100%', height: '100%', display: 'block', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
                onDoubleClick={() => { movedRef.current = true; setViewBox(base); }}
            >
                <ContextMapLayers data={data} showNuclear={showNuclear} zoom={base ? vb.w / base.w : 1}
                    highlights={highlights} onHover={onHover} />
            </svg>
            {/* Top-left: the situation first, then the studied elements. */}
            <div style={{
                position: 'absolute', left: space[2], top: space[2], zIndex: 20,
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space[2],
                maxHeight: `calc(100% - 2 * ${space[2]})`, overflowY: 'auto',
            }}>
                <Summary data={data} />
                <HighlightLegend highlights={highlights} onFocus={focusHighlights} />
            </div>
            <div style={{ position: 'absolute', left: space[2], bottom: space[2], zIndex: 20 }}>
                <Legend data={data} showNuclear={showNuclear} onShowNuclear={setShowNuclear} />
            </div>
            <div style={{ position: 'absolute', right: space[2], bottom: space[2], zIndex: 20, display: 'flex', gap: 4 }}>
                {([['+', 'Zoom in', 1 / 1.4], ['−', 'Zoom out', 1.4], ['⟲', 'Reset view', null]] as const)
                    .map(([label, title, factor]) => (
                        <button key={title} type="button" title={title} aria-label={title} onClick={() => {
                            movedRef.current = true;
                            if (factor === null) setViewBox(base); else zoomBy(factor);
                        }} style={{
                            width: 28, height: 28, borderRadius: radius.md, border: `1px solid ${colors.border}`,
                            background: colors.surface, color: colors.textPrimary, cursor: 'pointer', fontWeight: 700,
                        }}>{label}</button>
                    ))}
            </div>
            {hover && (
                <div data-testid="context-map-tooltip" style={{
                    ...card, left: hover.x, top: hover.y, pointerEvents: 'none', zIndex: 30,
                    width: TOOLTIP_WIDTH, boxSizing: 'border-box',
                }}>
                    <HoverCard hover={hover.hover} monitoringFactor={state.monitoringFactor} />
                </div>
            )}
        </div>
    );
};

export default ContextMapView;
