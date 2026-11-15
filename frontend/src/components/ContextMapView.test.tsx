// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ContextMapView from './ContextMapView';
import type { ContextMapState } from '../hooks/useContextMap';
import type { ContextMapData, ContextMapHighlight } from '../types';

/** France frame, two regions, one neighbour — a trimmed real payload. */
const payload = (): ContextMapData => ({
    mesh: 'region', home: 'FR', frame: 'geo', georef: 'op4grid_plan', flows_available: true,
    case_date: '2026-01-10T17:30:00+00:00', capture_id: 1,
    bounds: [-4.05, -52, 11.54, 11.1],
    basemap: [
        { iso: 'FR', name: 'France', active: true, rings: [[[-3, -48], [5, -50], [5, -43], [-3, -43]]] },
        { iso: 'ES', name: 'Spain', active: true, rings: [[[-6, -43], [2, -43], [2, -37], [-6, -37]]] },
    ],
    country_labels: [{ text: 'Spain', x: -1.2, y: -42.15 }],
    zones: [
        { id: 'LYON', label: 'Lyon', kind: 'region', country: 'FR', production: { nuclear: 3000, hydro: 2500 },
          production_total: 5500, consumption: 5000, net_export: 300, label_side: 'left', placed: true, x: 3.3, y: -45.8 },
        { id: 'PARIS', label: 'Paris region', kind: 'region', country: 'FR', production: { nuclear: 7700 },
          production_total: 7700, consumption: 16000, net_export: -500, label_side: 'left', placed: true, x: 1.6, y: -48.6 },
        { id: 'ES', label: 'Spain', kind: 'neighbor', country: 'ES', production: {}, production_total: 0,
          consumption: 0, net_export: 200, label_side: 'below', placed: true, x: 0.2, y: -41.7, badge: [0, -41.2] },
    ],
    flows: [
        { from: 'LYON', to: 'PARIS', mw: 1622, circuits: 10, kind: 'inter_zone', rad: 0.16, label: [2.4, -47.2] },
        { from: 'ES', to: 'LYON', mw: 200, circuits: 2, kind: 'border', rad: 0.12, label: [1.7, -43.7], direction: 'import' },
    ],
    totals: { production: 13200, consumption: 21000, net_export: -200 },
});

const state = (over: Partial<ContextMapState> = {}): ContextMapState => ({
    data: payload(), loading: false, error: null, highlights: [], ...over,
});

const contingency: ContextMapHighlight = {
    role: 'contingency',
    element: { id: 'L1', name: 'LINE ONE', kind: 'branch', zones: ['LYON', 'LYON'],
        points: [[3.0, -45.5], [3.4, -45.9]], zone_points: [[3.3, -45.8], [3.3, -45.8]] },
};
const overload: ContextMapHighlight = {
    role: 'overload', rho: 1.08,
    element: { id: 'L2', name: 'LINE TWO', kind: 'branch', zones: ['LYON', 'PARIS'],
        points: null, zone_points: [[3.3, -45.8], [1.6, -48.6]] },
};

describe('ContextMapView', () => {
    it('shows a loading / error / idle placeholder without a map', () => {
        const { rerender } = render(<ContextMapView state={state({ data: null, loading: true })} />);
        expect(screen.getByTestId('context-map-placeholder')).toHaveTextContent('Loading the situation map');
        rerender(<ContextMapView state={state({ data: null, error: 'down' })} />);
        expect(screen.getByTestId('context-map-placeholder')).toHaveTextContent('Context map unavailable: down');
        rerender(<ContextMapView state={state({ data: null })} />);
        expect(screen.getByTestId('context-map-placeholder')).toHaveTextContent('Load a study');
    });

    it('draws the basemap, pies, transfers and the neighbour badge', () => {
        render(<ContextMapView state={state()} />);
        expect(screen.getByTestId('context-map-basemap').querySelectorAll('path')).toHaveLength(2);
        // Two slices for Lyon, a full circle for Paris (single type).
        expect(screen.getByTestId('context-map-zone-LYON').querySelectorAll('path')).toHaveLength(2);
        expect(screen.getByTestId('context-map-zone-PARIS').querySelector('circle')).not.toBeNull();
        expect(screen.queryByTestId('context-map-zone-ES')).toBeNull();
        // Spain imports into France: an "Imports" badge, its own export negated.
        // (jest-dom folds the thin no-break space of formatMw into a space.)
        expect(screen.getByTestId('context-map-badge-ES')).toHaveTextContent('Imports');
        expect(screen.getByTestId('context-map-badge-ES')).toHaveTextContent('200 MW');
        // Around France the basemap names the neighbour: the badge does not.
        expect(screen.getByTestId('context-map-badge-ES')).not.toHaveTextContent('Spain');
        expect(screen.getByTestId('context-map-flow-labels')).toHaveTextContent(/1\s622 MW/);
    });

    it('names a country the grid leaves out on its badge', () => {
        // A rebuilt PyPSA-EUR hour: Great Britain only exchanges over HVDC.
        const base = payload();
        const data: ContextMapData = {
            ...base,
            zones: [...base.zones, { id: 'GB', label: 'United Kingdom', kind: 'neighbor', country: 'GB',
                production: {}, production_total: 0, consumption: 0, net_export: 1900,
                label_side: 'below', placed: true, x: -1.5, y: -52.5 }],
            flows: [...base.flows, { from: 'GB', to: 'PARIS', mw: 1900, circuits: 3, kind: 'border', rad: 0.12,
                label: [0.0, -50.5], direction: 'import' }],
        };
        render(<ContextMapView state={state({ data })} />);
        const badge = screen.getByTestId('context-map-badge-GB');
        expect(badge).toHaveTextContent('United Kingdom');
        expect(badge).toHaveTextContent(/Imports.*1\s900 MW/);
    });

    it('summarises the situation and lists only the generation types present', () => {
        render(<ContextMapView state={state()} />);
        const summary = screen.getByTestId('context-map-summary');
        expect(summary).toHaveTextContent('RTE regions');
        expect(summary).toHaveTextContent('2026-01-10 17:30');
        expect(summary).toHaveTextContent('Net imports: 200 MW');
        // The national mix: one bar, each share written on its segment.
        expect(screen.getByTestId('context-map-mix-nuclear')).toHaveTextContent('81 %');
        expect(screen.getByTestId('context-map-mix-hydro')).toHaveTextContent('19 %');
        expect(screen.getByTestId('context-map-mix-bar')).toHaveAttribute('aria-label', expect.stringContaining('Nuclear 81 %'));
        // The colour key lives in the bottom-left legend.
        const legend = screen.getByTestId('context-map-legend');
        expect(legend).toHaveTextContent('Nuclear');
        expect(legend).toHaveTextContent('Hydro');
        expect(legend).not.toHaveTextContent('Solar');
    });

    it('draws the nuclear units on their plant, by output level, and can hide them', () => {
        const data: ContextMapData = {
            ...payload(),
            nuclear: {
                plants: [{ id: 'Bugey', name: 'Bugey', x: 3.6, y: -45.8, r: 0.09, units: 2, running: 1,
                    production: 900, capacity: 1800 }],
                units: [
                    { id: 'U1', plant: 'Bugey', x: 3.6, y: -45.75, running: true, p: 900, pmax: 900, level: 1 },
                    { id: 'U2', plant: 'Bugey', x: 3.6, y: -45.85, running: false, p: 0, pmax: 900, level: 0 },
                ],
            },
        };
        render(<ContextMapView state={state({ data })} />);
        expect(screen.getByTestId('context-map-unit-U1')).toHaveAttribute('fill', 'rgb(193, 41, 10)');
        expect(screen.getByTestId('context-map-unit-U2')).toHaveAttribute('fill', 'none');
        fireEvent.mouseEnter(screen.getByTestId('context-map-plant-Bugey'), { clientX: 5, clientY: 5 });
        const tip = screen.getByTestId('context-map-tooltip');
        expect(tip).toHaveTextContent('Bugey — nuclear');
        expect(tip).toHaveTextContent('1 of 2 units running');
        expect(tip).toHaveTextContent('U2stopped');
        fireEvent.click(screen.getByTestId('context-map-nuclear-toggle'));
        expect(screen.queryByTestId('context-map-nuclear')).toBeNull();
    });

    it('labels every transfer of a dense country map, on its visible arrow', () => {
        // 14 countries on a 4×4 grid (dense: > 12 pies), one strong transfer
        // and weak ones that a strength cut-off used to leave unlabelled.
        const zones = Array.from({ length: 14 }, (_, i) => ({
            id: `C${i}`, label: `Country ${i}`, kind: 'country' as const, country: `C${i}`,
            production: { other: 1000 }, production_total: 1000, consumption: 1000, net_export: 0,
            label_side: 'below', placed: true, x: (i % 4) * 4, y: -40 - Math.floor(i / 4) * 4,
        }));
        const flows = [[0, 1, 900], [1, 2, 5], [4, 5, 12], [8, 9, 3]].map(([a, b, mw]) => ({
            from: `C${a}`, to: `C${b}`, mw, circuits: 1, kind: 'inter_zone' as const, rad: 0.1,
            // The chord midpoint the payload gives; the drawing ignores it here.
            label: [0, 0] as [number, number],
        }));
        const data: ContextMapData = {
            ...payload(), mesh: 'country', home: null, bounds: [-2, -56, 16, 18], basemap: [], country_labels: [],
            zones, flows, totals: { production: 14000, consumption: 14000, net_export: null },
        };
        render(<ContextMapView state={state({ data })} />);
        const labels = [...screen.getByTestId('context-map-flow-labels').querySelectorAll('text')];
        expect(labels.map(t => t.textContent)).toEqual(['900 MW', '5 MW', '12 MW', '3 MW']);
        // Between C0 (x = 0) and C1 (x = 4): not at the payload's (0, 0).
        const x = Number(labels[0].getAttribute('x'));
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(Number(labels[1].getAttribute('x')));
    });

    it('names the units of a matched plant and flags its output as estimated', () => {
        const data: ContextMapData = {
            ...payload(),
            nuclear: {
                plants: [{ id: 'Gravelines', name: 'Gravelines', x: 2.1, y: -51.0, r: 0.1, units: 2, running: 2,
                    production: 360, capacity: 1902, matched: true }],
                units: [
                    { id: 'G_relation_1-400#1', name: 'Gravelines 1', plant: 'Gravelines', x: 2.1, y: -50.98,
                        running: true, p: 180, pmax: 951, level: 0.19 },
                    { id: 'G_relation_1-400#2', name: 'Gravelines 2', plant: 'Gravelines', x: 2.1, y: -51.02,
                        running: true, p: 180, pmax: 951, level: 0.19 },
                ],
            },
        };
        render(<ContextMapView state={state({ data })} />);
        fireEvent.mouseEnter(screen.getByTestId('context-map-plant-Gravelines'), { clientX: 5, clientY: 5 });
        const tip = screen.getByTestId('context-map-tooltip');
        expect(tip).toHaveTextContent('Estimated output');
        expect(tip).toHaveTextContent(/1\s902 MW/);
        expect(tip).toHaveTextContent('Gravelines 2');
        expect(tip).not.toHaveTextContent('G_relation');
    });

    it('credits the plant database a typeless network was matched with', () => {
        const source = { name: 'powerplantmatching', url: 'https://github.com/PyPSA/powerplantmatching', licence: 'CC BY 4.0' };
        render(<ContextMapView state={state({ data: { ...payload(), plant_source: source } })} />);
        const credit = screen.getByTestId('context-map-plant-source');
        expect(credit).toHaveTextContent('powerplantmatching (CC BY 4.0)');
        expect(credit.querySelector('a')).toHaveAttribute('href', source.url);
        // Without a matching, no credit line.
        render(<ContextMapView state={state()} />);
        expect(screen.getAllByTestId('context-map-plant-source')).toHaveLength(1);
    });

    it('names the dispatch of a real hour and credits its data', () => {
        const situation = {
            at_utc: '2025-01-14T08:00Z', dispatch: 'opf',
            sources: [
                { name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: 'CC BY 4.0' },
                { name: 'powerplantmatching', url: 'https://github.com/PyPSA/powerplantmatching', licence: 'CC BY 4.0' },
            ],
        };
        render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        const credit = screen.getByTestId('context-map-situation');
        expect(credit).toHaveTextContent('Real hour, optimal dispatch (PyPSA)');
        expect(credit).toHaveTextContent('Energy-Charts (Fraunhofer ISE), powerplantmatching (CC BY 4.0)');
        expect(credit.querySelectorAll('a')).toHaveLength(2);
        // A situation file says nothing when absent.
        render(<ContextMapView state={state()} />);
        expect(screen.getAllByTestId('context-map-situation')).toHaveLength(1);
    });

    it('says so instead of a one-colour mix bar when no generator is typed', () => {
        // The Game Mode pan-European grid: every generator energySource OTHER.
        const base = payload();
        const data: ContextMapData = {
            ...base,
            zones: base.zones.map(z => z.kind === 'neighbor' ? z : { ...z, production: { other: z.production_total } }),
        };
        render(<ContextMapView state={state({ data })} />);
        expect(screen.queryByTestId('context-map-mix-bar')).toBeNull();
        expect(screen.getByTestId('context-map-mix-untyped')).toHaveTextContent('not given in this network');
        const legend = screen.getByTestId('context-map-legend');
        expect(legend).toHaveTextContent('Production (type not given)');
        expect(legend).not.toHaveTextContent('Other');
    });

    it('warns when the network file carries no flows', () => {
        render(<ContextMapView state={state({ data: { ...payload(), flows_available: false } })} />);
        expect(screen.getByTestId('context-map-summary')).toHaveTextContent('carries no flows');
    });

    it('highlights the contingency and its overloads, their loading beside them', () => {
        render(<ContextMapView state={state({ highlights: [contingency, overload] })} />);
        expect(screen.getByTestId('context-map-highlight-L1')).toHaveAttribute('data-role', 'contingency');
        expect(screen.getByTestId('context-map-highlight-L2')).toHaveAttribute('data-role', 'overload');
        expect(screen.getByTestId('context-map-attention')).toBeInTheDocument();
        const legend = screen.getByTestId('context-map-highlight-legend');
        expect(legend).toHaveTextContent('Contingency: LINE ONE');
        expect(legend).toHaveTextContent('LINE TWO (108 %)');
        // The overload's loading is written on the map, beside its line.
        expect(screen.getByTestId('context-map-rho-L2')).toHaveTextContent('108 %');
        expect(screen.queryByTestId('context-map-rho-L1')).toBeNull();
    });

    it('frames a new contingency and its overloads, unless the map was moved', () => {
        const { rerender } = render(<ContextMapView state={state()} />);
        const svg = screen.getByRole('img', { name: /Situation map/ });
        const box = () => svg.getAttribute('viewBox')!.split(' ').map(Number);
        const base = box();
        // The contingency arrives: the map frames it.
        rerender(<ContextMapView state={state({ highlights: [contingency] })} />);
        expect(box()[2]).toBeLessThan(base[2]);
        // The operator steps back; the overloads arriving leave the view alone.
        fireEvent.doubleClick(svg);
        expect(box()).toEqual(base);
        rerender(<ContextMapView state={state({ highlights: [contingency, overload] })} />);
        expect(box()).toEqual(base);
        // The button still frames them; a new contingency frames itself again.
        fireEvent.click(screen.getByTestId('context-map-focus'));
        expect(box()[2]).toBeLessThan(base[2]);
        fireEvent.doubleClick(svg);
        const other = { ...contingency, element: { ...contingency.element, id: 'L9' } };
        rerender(<ContextMapView state={state({ highlights: [other] })} />);
        expect(box()[2]).toBeLessThan(base[2]);
    });

    it('describes a zone on hover', () => {
        render(<ContextMapView state={state()} />);
        fireEvent.mouseEnter(screen.getByTestId('context-map-zone-LYON'), { clientX: 10, clientY: 10 });
        const tip = screen.getByTestId('context-map-tooltip');
        expect(tip).toHaveTextContent('Lyon');
        expect(tip).toHaveTextContent(/Hydro: 2\s500 MW/);
        expect(tip).toHaveTextContent('Net export: 300 MW');
        fireEvent.mouseLeave(screen.getByTestId('context-map-zone-LYON'));
        expect(screen.queryByTestId('context-map-tooltip')).toBeNull();
    });
});
