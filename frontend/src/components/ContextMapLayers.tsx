// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { memo, useMemo } from 'react';
import type {
    ContextFiliere, ContextMapData, ContextMapFlow, ContextMapHighlight, ContextMapNuclearPlant,
    ContextMapNuclearUnit, ContextMapZone,
} from '../types';
import { contextFiliereColors, contextMapPalette as P } from '../styles/tokens';
import {
    DENSE_SCALE, DENSE_ZONE_COUNT, PIE_GAP_PT, PROD_REF_MW,
    arrowHead, arrowWidthPt, formatMw, highlightBox, highlightPoints, pieSlices, polylinePath,
    polylineMidpoint, ptUnit, rampColor, renderScale, ringPath, trimmedArc, volumeRadiusPt, type Point,
} from '../utils/contextMapGeometry';

type ContextHighlight = ContextMapHighlight;

export type ContextHover =
    | { kind: 'zone'; zone: ContextMapZone }
    | { kind: 'flow'; flow: ContextMapFlow; fromLabel: string; toLabel: string }
    | { kind: 'element'; highlight: ContextHighlight }
    | { kind: 'plant'; plant: ContextMapNuclearPlant; units: ContextMapNuclearUnit[] };

interface ContextMapLayersProps {
    data: ContextMapData;
    /** Draw the nuclear units layer. */
    showNuclear: boolean;
    /** Current view width / full view width: symbols keep their size on
     *  screen as the map zooms, as Carte-Front's zoomed views do. */
    zoom: number;
    highlights: ContextHighlight[];
    onHover: (hover: ContextHover | null, event?: React.MouseEvent) => void;
}

const FILIERE_ORDER = Object.keys(contextFiliereColors) as ContextFiliere[];
const SIGNAL = { contingency: 'var(--signal-contingency)', overload: 'var(--signal-overload)' } as const;
/** Transfer labels on a dense map (many zones): smaller, so all fit. */
const DENSE_LABEL_PT = 5.2;

interface Geometry {
    k: number;
    pt: number;
    scale: number;
    compact: boolean;
    zones: Map<string, ContextMapZone>;
    /** Radius (render units) of a power, on the pies' area scale. */
    volume: (mw: number) => number;
    radius: (zone: ContextMapZone) => number;
    pos: (zone: ContextMapZone) => Point;
}

/** Scale and symbol sizing shared by every layer. */
const useGeometry = (data: ContextMapData, zoom: number): Geometry => useMemo(() => {
    const k = renderScale(data.bounds);
    const pt = ptUnit(data.bounds) * k * zoom;
    const pies = data.zones.filter(z => z.placed && z.kind !== 'neighbor' && z.production_total > 0);
    const dense = pies.length > DENSE_ZONE_COUNT;
    const scale = dense ? DENSE_SCALE : 1;
    const refMw = data.mesh === 'region'
        ? PROD_REF_MW
        : Math.max(PROD_REF_MW, ...pies.map(z => z.production_total));
    return {
        k, pt, scale, compact: dense,
        zones: new Map(data.zones.map(z => [z.id, z])),
        volume: (mw: number) => volumeRadiusPt(mw, refMw, scale) * pt,
        radius: (zone: ContextMapZone) => volumeRadiusPt(zone.production_total, refMw, scale) * pt,
        pos: (zone: ContextMapZone) => [(zone.x ?? 0) * k, (zone.y ?? 0) * k],
    };
}, [data, zoom]);

/** Halo text, as Carte-Front's `path_effects=[withStroke(...)]`. */
const HaloText: React.FC<{
    x: number; y: number; size: number; halo: number; fill: string; haloColor: string;
    anchor?: 'start' | 'middle' | 'end'; baseline?: 'hanging' | 'middle' | 'auto';
    bold?: boolean; children: React.ReactNode;
}> = ({ x, y, size, halo, fill, haloColor, anchor = 'middle', baseline = 'middle', bold = true, children }) => (
    <text
        x={x} y={y} fontSize={size} fontWeight={bold ? 700 : 400} textAnchor={anchor}
        dominantBaseline={baseline} fill={fill} stroke={haloColor} strokeWidth={halo}
        strokeLinejoin="round" paintOrder="stroke" style={{ pointerEvents: 'none' }}
    >
        {children}
    </text>
);

const Basemap: React.FC<{ data: ContextMapData; g: Geometry }> = ({ data, g }) => {
    const paths = useMemo(() => data.basemap.map(c => ({
        iso: c.iso, active: c.active,
        d: c.rings.map(r => ringPath(r.map(([x, y]) => [x * g.k, y * g.k]))).join(''),
    })), [data, g.k]);
    return (
        <g data-testid="context-map-basemap">
            {paths.map(c => (
                <path
                    key={c.iso} d={c.d} fillRule="evenodd"
                    fill={c.active ? P.home : P.land}
                    stroke={c.active ? P.homeEdge : P.landEdge}
                    strokeWidth={(c.active ? 1.6 : 0.8) * g.pt}
                    strokeLinejoin="round"
                />
            ))}
            {data.country_labels.map(l => (
                <text
                    key={l.text} x={l.x * g.k} y={l.y * g.k} fontSize={8.5 * g.pt} fontWeight={700}
                    textAnchor="middle" dominantBaseline="middle" fill={P.countryText} opacity={0.9}
                    style={{ pointerEvents: 'none' }}
                >
                    {l.text}
                </text>
            ))}
        </g>
    );
};

/** A Carte-Front `FancyArrowPatch('-|>')` along an `arc3` curve. */
const Arrow: React.FC<{
    p0: Point; p1: Point; rad: number; widthPt: number; color: string; pt: number;
    shrinkStart: number; shrinkEnd: number; dashed?: boolean; opacity: number;
    onEnter?: (e: React.MouseEvent) => void; onLeave?: () => void;
}> = ({ p0, p1, rad, widthPt, color, pt, shrinkStart, shrinkEnd, dashed, opacity, onEnter, onLeave }) => {
    const line = trimmedArc(p0, p1, rad, shrinkStart, shrinkEnd);
    if (!line) return null;
    const mutation = (10 + widthPt * 1.8) * pt;
    const { shaft, head } = arrowHead(line, 0.4 * mutation, 0.2 * mutation);
    const width = widthPt * pt;
    return (
        <g opacity={opacity} onMouseEnter={onEnter} onMouseMove={onEnter} onMouseLeave={onLeave} style={{ cursor: 'default' }}>
            <path
                d={polylinePath(shaft)} fill="none" stroke={color} strokeWidth={width}
                strokeLinecap="round" strokeDasharray={dashed ? `${3.7 * width} ${1.6 * width}` : undefined}
            />
            <path d={polylinePath(head) + 'Z'} fill={color} stroke={color} strokeWidth={width * 0.3} strokeLinejoin="round" />
            {/* Wider transparent hit area for the tooltip. */}
            <path d={polylinePath(line)} fill="none" stroke="transparent" strokeWidth={Math.max(width, 6 * pt)} />
        </g>
    );
};

/** Where an arrow stops short of its zone: the pie edge, else the badge anchor. */
const shrinkOf = (zone: ContextMapZone, g: Geometry): number => {
    if (zone.kind === 'neighbor') return 6 * g.pt;
    return zone.production_total > 0 ? g.radius(zone) + PIE_GAP_PT * g.pt : 7 * g.pt;
};

const Flows: React.FC<{ data: ContextMapData; g: Geometry; onHover: ContextMapLayersProps['onHover'] }> = ({ data, g, onHover }) => {
    const vmax = (kind: ContextMapFlow['kind']) =>
        Math.max(1, ...data.flows.filter(f => f.kind === kind).map(f => f.mw));
    const vmaxByKind = { inter_zone: vmax('inter_zone'), border: vmax('border') };
    const drawn = data.flows.filter(f => g.zones.get(f.from)?.placed && g.zones.get(f.to)?.placed);
    return (
        <g data-testid="context-map-flows">
            {drawn.map(f => {
                const from = g.zones.get(f.from)!;
                const to = g.zones.get(f.to)!;
                const border = f.kind === 'border';
                const color = border ? (f.direction === 'import' ? P.import : P.export) : P.interZone;
                const widthPt = arrowWidthPt(f.mw, vmaxByKind[f.kind]);
                const enter = (e: React.MouseEvent) =>
                    onHover({ kind: 'flow', flow: f, fromLabel: from.label, toLabel: to.label }, e);
                return (
                    <Arrow
                        key={`${f.from}->${f.to}`} p0={g.pos(from)} p1={g.pos(to)} rad={f.rad}
                        widthPt={widthPt} color={color} pt={g.pt} dashed={border}
                        opacity={border ? 0.85 : 0.95}
                        shrinkStart={shrinkOf(from, g)} shrinkEnd={shrinkOf(to, g)}
                        onEnter={enter} onLeave={() => onHover(null)}
                    />
                );
            })}
        </g>
    );
};

/**
 * Every drawn transfer carries its value (an arrow the pies swallow, none).
 * The region mesh keeps Carte-Front's hand-placed label offsets; on the
 * country mesh the value sits halfway along the VISIBLE arrow — the chord
 * midpoint the payload gives falls under a pie when two countries are close.
 */
const FlowLabels: React.FC<{ data: ContextMapData; g: Geometry }> = ({ data, g }) => (
    <g data-testid="context-map-flow-labels">
        {data.flows.map(f => {
            const from = g.zones.get(f.from);
            const to = g.zones.get(f.to);
            if (!from?.placed || !to?.placed) return null;
            const line = trimmedArc(g.pos(from), g.pos(to), f.rad, shrinkOf(from, g), shrinkOf(to, g));
            if (!line) return null;
            const [x, y] = data.mesh === 'country' ? polylineMidpoint(line) : [f.label[0] * g.k, f.label[1] * g.k];
            const border = f.kind === 'border';
            const color = border ? (f.direction === 'import' ? P.import : P.export) : P.interZone;
            const size = g.compact ? DENSE_LABEL_PT : border ? 6.0 : 6.3;
            return (
                <HaloText
                    key={`${f.from}->${f.to}`} x={x} y={y}
                    size={size * g.pt} halo={2.5 * g.pt} fill={P.halo} haloColor={color}
                    bold={false}
                >
                    {formatMw(f.mw)}
                </HaloText>
            );
        })}
    </g>
);

/** Carte-Front `_label_box`: the neighbour's total, export / import / balance. */
const Badges: React.FC<{ data: ContextMapData; g: Geometry }> = ({ data, g }) => (
    <g data-testid="context-map-badges">
        {data.zones.filter(z => z.kind === 'neighbor' && z.placed
            && (z.badge || data.flows.some(f => f.from === z.id || f.to === z.id))).map(z => {
            // The neighbour's net export is the home country's import from it.
            const homeExport = -z.net_export;
            const [title, color] = Math.abs(homeExport) < 1
                ? ['Balanced', P.homeEdge]
                : homeExport > 0 ? ['Exports', P.export] : ['Imports', P.import];
            const [x, y] = z.badge ? [z.badge[0] * g.k, z.badge[1] * g.k] : g.pos(z);
            const w = 46 * g.pt;
            const h = 24 * g.pt;
            return (
                <g key={z.id} data-testid={`context-map-badge-${z.id}`}>
                    <rect
                        x={x - w / 2} y={y - h / 2} width={w} height={h} rx={4 * g.pt}
                        fill={P.badgeFill} stroke={color} strokeWidth={1.6 * g.pt}
                    />
                    <text x={x} y={y - 3.5 * g.pt} fontSize={8 * g.pt} fontWeight={700} textAnchor="middle"
                        dominantBaseline="middle" fill={P.textDark}>{title}</text>
                    <text x={x} y={y + 5.5 * g.pt} fontSize={8 * g.pt} fontWeight={700} textAnchor="middle"
                        dominantBaseline="middle" fill={P.textDark}>{formatMw(homeExport)}</text>
                    {/* A country the grid leaves out (no badge anchor around
                        France): its name, which no zone label carries. */}
                    {!z.badge && (
                        <HaloText x={x} y={y - h / 2 - 5 * g.pt} size={7 * g.pt} halo={2.2 * g.pt}
                            fill={P.textDark} haloColor={P.halo} anchor="middle">
                            {z.label}
                        </HaloText>
                    )}
                </g>
            );
        })}
    </g>
);

const ZoneLabel: React.FC<{ zone: ContextMapZone; g: Geometry; r: number }> = ({ zone, g, r }) => {
    const [cx, cy] = g.pos(zone);
    const gap = 3 * g.pt;
    const line = 6.6 * 1.3 * g.pt;
    const side = zone.label_side;
    const anchor = side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle';
    const x = side === 'left' ? cx - r - gap : side === 'right' ? cx + r + gap : cx;
    const lines: { text: string; color: string }[] = [{ text: zone.label, color: P.textDark }];
    if (!g.compact) {
        if (zone.production_total > 0) lines.push({ text: formatMw(zone.production_total), color: P.textDark });
        if (zone.consumption > 0) lines.push({ text: formatMw(zone.consumption), color: P.consumption });
    }
    const blockH = line * lines.length;
    const top = side === 'below' ? cy + r + gap
        : side === 'above' ? cy - r - gap - blockH
            : cy - blockH / 2;
    return (
        <g>
            {lines.map((l, i) => (
                <HaloText
                    key={i} x={x} y={top + line * (i + 0.5)} size={(g.compact ? 5.4 : 6.6) * g.pt}
                    halo={2.2 * g.pt} fill={l.color} haloColor={P.halo} anchor={anchor}
                >
                    {l.text}
                </HaloText>
            ))}
        </g>
    );
};

const Zones: React.FC<{ data: ContextMapData; g: Geometry; onHover: ContextMapLayersProps['onHover'] }> = ({ data, g, onHover }) => (
    <g data-testid="context-map-zones">
        {data.zones.filter(z => z.placed && z.kind !== 'neighbor').map(zone => {
            const [cx, cy] = g.pos(zone);
            const hasPie = zone.production_total > 0;
            const r = hasPie ? g.radius(zone) : 0;
            const parts = FILIERE_ORDER.map(f => [f, zone.production[f] ?? 0] as const);
            // Consumption ring, on the pies' area scale: it overflows the pie
            // of a net importer (Carte-Front `_draw_pies`).
            const ringR = zone.consumption > 0 ? g.volume(zone.consumption) : 0;
            const enter = (e: React.MouseEvent) => onHover({ kind: 'zone', zone }, e);
            return (
                <g key={zone.id} data-testid={`context-map-zone-${zone.id}`}
                    onMouseEnter={enter} onMouseMove={enter} onMouseLeave={() => onHover(null)}>
                    {hasPie ? pieSlices(cx, cy, r, parts).map(s => s.full ? (
                        <circle key={s.key} cx={cx} cy={cy} r={r} fill={contextFiliereColors[s.key]}
                            fillOpacity={0.8} stroke={P.halo} strokeWidth={0.5 * g.pt} />
                    ) : (
                        <path key={s.key} d={s.d} fill={contextFiliereColors[s.key]} fillOpacity={0.8}
                            stroke={P.halo} strokeWidth={0.5 * g.pt} strokeLinejoin="round" />
                    )) : (
                        <circle cx={cx} cy={cy} r={5.4 * g.pt} fill={P.pin} stroke={P.halo} strokeWidth={1.5 * g.pt} />
                    )}
                    {ringR > 0 && (
                        <circle cx={cx} cy={cy} r={ringR} fill="none" stroke={P.consumption}
                            strokeWidth={1.35 * g.pt} strokeDasharray={`${3 * 1.35 * g.pt} ${1.35 * g.pt}`} />
                    )}
                    <ZoneLabel zone={zone} g={g} r={Math.max(r, ringR, hasPie ? 0 : 5.4 * g.pt)} />
                </g>
            );
        })}
    </g>
);

const NUCLEAR_RAMP = [P.nuclearLow, P.nuclearMid, P.nuclearHigh] as const;
/** Dot radii (pt) — Carte-Front's scatter sizes 24 (running) and 18 (stopped). */
const UNIT_RUNNING_R_PT = Math.sqrt(24 / Math.PI);
const UNIT_STOPPED_R_PT = Math.sqrt(18 / Math.PI);

/**
 * Carte-Front `_draw_nuclear`: one dot per unit on its plant's ring, filled
 * by P / Pmax, hollow when stopped; a dashed outline per plant (the hover
 * target). Drawn over the pies, as Carte-Front's overlay axes.
 */
const Nuclear: React.FC<{ data: ContextMapData; g: Geometry; onHover: ContextMapLayersProps['onHover'] }> = ({ data, g, onHover }) => {
    const plants = data.nuclear?.plants ?? [];
    const units = data.nuclear?.units ?? [];
    if (plants.length === 0) return null;
    const byPlant = new Map<string, ContextMapNuclearUnit[]>();
    for (const u of units) byPlant.set(u.plant, [...(byPlant.get(u.plant) ?? []), u]);
    return (
        <g data-testid="context-map-nuclear">
            {plants.map(plant => {
                const enter = (e: React.MouseEvent) =>
                    onHover({ kind: 'plant', plant, units: byPlant.get(plant.id) ?? [] }, e);
                return (
                    <circle key={plant.id} data-testid={`context-map-plant-${plant.id}`}
                        cx={plant.x * g.k} cy={plant.y * g.k} r={plant.r * g.k}
                        fill="transparent" stroke={P.nuclearPlant} strokeOpacity={0.65} strokeWidth={g.pt}
                        strokeDasharray={`${4 * g.pt} ${2.5 * g.pt}`}
                        onMouseEnter={enter} onMouseMove={enter} onMouseLeave={() => onHover(null)} />
                );
            })}
            {/* Stopped units under the running ones (Carte-Front's order). */}
            {[...units].sort((a, b) => Number(a.running) - Number(b.running)).map(u => (
                <circle key={u.id} data-testid={`context-map-unit-${u.id}`} data-running={u.running}
                    cx={u.x * g.k} cy={u.y * g.k} style={{ pointerEvents: 'none' }}
                    r={(u.running ? UNIT_RUNNING_R_PT : UNIT_STOPPED_R_PT) * g.pt}
                    fill={u.running ? rampColor(NUCLEAR_RAMP, u.level) : 'none'}
                    stroke={u.running ? P.nuclearEdge : P.nuclearStoppedEdge}
                    strokeWidth={(u.running ? 0.6 : 0.7) * g.pt} />
            ))}
        </g>
    );
};

const AttentionRing: React.FC<{ data: ContextMapData; highlights: ContextHighlight[]; g: Geometry }> = ({ data, highlights, g }) => {
    const box = highlightBox(data, highlights);
    if (!box) return null;
    const r = Math.max(Math.hypot(box.w, box.h) / 2 + 10 * g.pt, 18 * g.pt);
    const color = highlights.some(h => h.role === 'contingency') ? SIGNAL.contingency : SIGNAL.overload;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return (
        <g data-testid="context-map-attention" style={{ pointerEvents: 'none' }}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={P.highlightCasing} strokeWidth={3.6 * g.pt} opacity={0.6} />
            <circle cx={cx} cy={cy} r={r} fill="none" style={{ stroke: color }} strokeWidth={2 * g.pt}
                strokeDasharray={`${5 * g.pt} ${3 * g.pt}`} />
        </g>
    );
};

/** Where an overload's loading is written: beside its line (on the side
 *  facing up, clear of the stroke), its substation, or its zones' link. */
const rhoAnchor = (h: ContextHighlight, g: Geometry): Point | null => {
    const pts = h.element.points ? highlightPoints(h, g.k) : null;
    if (pts && pts.length === 2) {
        const [[x1, y1], [x2, y2]] = pts;
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        let [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
        if (ny > 0) [nx, ny] = [-nx, -ny];
        return [(x1 + x2) / 2 + nx * 10 * g.pt, (y1 + y2) / 2 + ny * 10 * g.pt];
    }
    if (pts && pts.length === 1) return [pts[0][0] + 12 * g.pt, pts[0][1] - 8 * g.pt];
    const zones = [...new Set(h.element.zones.filter((z): z is string => !!z))]
        .map(id => g.zones.get(id)).filter((z): z is ContextMapZone => !!z?.placed);
    const line = zones.length >= 2 ? trimmedArc(g.pos(zones[0]), g.pos(zones[1]), 0.25, 0, 0) : null;
    if (line) {
        const [x, y] = polylineMidpoint(line);
        return [x, y - 9 * g.pt];
    }
    return zones.length === 1 ? [g.pos(zones[0])[0], g.pos(zones[0])[1] - g.radius(zones[0]) - 12 * g.pt] : null;
};

/** An overload's loading after the contingency, in a pill of its colour. */
const RhoLabel: React.FC<{ h: ContextHighlight; g: Geometry }> = ({ h, g }) => {
    const at = h.rho !== undefined ? rhoAnchor(h, g) : null;
    if (!at) return null;
    const text = `${Math.round(h.rho! * 100)} %`;
    const size = 7.5 * g.pt;
    const w = (text.length * 0.62 + 1.2) * size;
    const hgt = 1.55 * size;
    return (
        <g data-testid={`context-map-rho-${h.element.id}`} style={{ pointerEvents: 'none' }}>
            <rect x={at[0] - w / 2} y={at[1] - hgt / 2} width={w} height={hgt} rx={hgt / 2}
                style={{ fill: SIGNAL.overload }} stroke={P.highlightCasing} strokeWidth={0.9 * g.pt} />
            <text x={at[0]} y={at[1]} fontSize={size} fontWeight={700} textAnchor="middle"
                dominantBaseline="central" fill={P.highlightCasing}>{text}</text>
        </g>
    );
};

/** The contingency (yellow) and its overloads (orange, their loading beside
 *  them), Co-Study's halo colours. */
const Highlights: React.FC<{ highlights: ContextHighlight[]; g: Geometry; onHover: ContextMapLayersProps['onHover'] }> = ({ highlights, g, onHover }) => {
    // Overloads first: the contingency stays on top where they share a corridor.
    const ordered = [...highlights].sort((a, b) => (a.role === b.role ? 0 : a.role === 'overload' ? -1 : 1));
    return (
        <g data-testid="context-map-highlights">
            {ordered.map(h => <HighlightShape key={h.element.id} h={h} g={g} onHover={onHover} />)}
            {ordered.filter(h => h.role === 'overload').map(h => <RhoLabel key={h.element.id} h={h} g={g} />)}
        </g>
    );
};

/** One studied element: its line, its substation, or its zones' link. */
const HighlightShape: React.FC<{ h: ContextHighlight; g: Geometry; onHover: ContextMapLayersProps['onHover'] }> = ({ h, g, onHover }) => {
    const color = SIGNAL[h.role];
    const enter = (e: React.MouseEvent) => onHover({ kind: 'element', highlight: h }, e);
    const common = {
        'data-testid': `context-map-highlight-${h.element.id}`,
        'data-role': h.role,
        onMouseEnter: enter, onMouseMove: enter, onMouseLeave: () => onHover(null),
    };
    const pts = h.element.points ? highlightPoints(h, g.k) : null;
    if (pts && pts.length === 2) {
        const d = polylinePath(pts);
        return (
            <g {...common}>
                <path d={d} stroke={P.highlightCasing} strokeWidth={6.5 * g.pt} strokeLinecap="round" fill="none" />
                <path d={d} style={{ stroke: color }} strokeWidth={3.8 * g.pt} strokeLinecap="round" fill="none" />
                {pts.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={2.6 * g.pt} style={{ fill: color }}
                        stroke={P.highlightCasing} strokeWidth={1.1 * g.pt} />
                ))}
            </g>
        );
    }
    if (pts && pts.length === 1) {
        return (
            <circle {...common} cx={pts[0][0]} cy={pts[0][1]} r={4.5 * g.pt}
                style={{ fill: color }} stroke={P.highlightCasing} strokeWidth={1.4 * g.pt} />
        );
    }
    return <ZoneFallback h={h} g={g} color={color} common={common} />;
};

/** No georeference: link the zones the element touches, or ring its zone. */
const ZoneFallback: React.FC<{
    h: ContextHighlight; g: Geometry; color: string; common: Record<string, unknown>;
}> = ({ h, g, color, common }) => {
    const zones = [...new Set(h.element.zones.filter((z): z is string => !!z))]
        .map(id => g.zones.get(id)).filter((z): z is ContextMapZone => !!z?.placed);
    if (zones.length >= 2) {
        const line = trimmedArc(g.pos(zones[0]), g.pos(zones[1]), 0.25, 0, 0);
        if (!line) return null;
        return (
            <g {...common}>
                <path d={polylinePath(line)} stroke={P.highlightCasing} strokeWidth={6 * g.pt} fill="none" />
                <path d={polylinePath(line)} style={{ stroke: color }} strokeWidth={3.4 * g.pt} fill="none"
                    strokeDasharray={`${6 * g.pt} ${3 * g.pt}`} />
            </g>
        );
    }
    if (zones.length === 1) {
        const [cx, cy] = g.pos(zones[0]);
        const r = (zones[0].production_total > 0 ? g.radius(zones[0]) : 5.4 * g.pt) + 5 * g.pt;
        return (
            <g {...common}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={P.highlightCasing} strokeWidth={5.5 * g.pt} />
                <circle cx={cx} cy={cy} r={r} fill="none" style={{ stroke: color }} strokeWidth={3 * g.pt} />
            </g>
        );
    }
    return null;
};

/** The Context-tab map, every layer in Carte-Front's order (pies over arrows). */
const ContextMapLayers: React.FC<ContextMapLayersProps> = ({ data, showNuclear, zoom, highlights, onHover }) => {
    const g = useGeometry(data, zoom);
    const [bx, by, bw, bh] = data.bounds.map(v => v * g.k);
    return (
        <g>
            <rect x={bx - 4 * bw} y={by - 4 * bh} width={9 * bw} height={9 * bh} fill={P.sea} />
            <Basemap data={data} g={g} />
            <Flows data={data} g={g} onHover={onHover} />
            <Badges data={data} g={g} />
            <FlowLabels data={data} g={g} />
            <Zones data={data} g={g} onHover={onHover} />
            {showNuclear && <Nuclear data={data} g={g} onHover={onHover} />}
            <AttentionRing data={data} highlights={highlights} g={g} />
            <Highlights highlights={highlights} g={g} onHover={onHover} />
        </g>
    );
};

export default memo(ContextMapLayers);
