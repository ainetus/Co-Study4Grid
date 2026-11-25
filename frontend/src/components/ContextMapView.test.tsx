// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ContextMapView from './ContextMapView';
import type { ContextMapState } from '../hooks/useContextMap';
import type { ContextMapConsignation, ContextMapData, ContextMapHighlight, ContextMapNetwork } from '../types';

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

    it('names the one country a map draws alone', () => {
        // A France-only grid rebuilt on a real hour: France and its exchanges.
        const data: ContextMapData = {
            ...payload(), mesh: 'country',
            zones: [
                { id: 'FR', label: 'France', kind: 'country', country: 'FR', production: { nuclear: 52760 },
                  production_total: 52760, consumption: 56000, net_export: -3240, label_side: 'below',
                  placed: true, x: 2.4, y: -46.6 },
                ...payload().zones.filter(z => z.kind === 'neighbor'),
            ],
        };
        render(<ContextMapView state={state({ data })} />);
        expect(screen.getByTestId('context-map-summary')).toHaveTextContent('Situation — France');
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

    const realHour = (sources: { name: string; url: string; licence: string | null }[], dispatch = 'opf') =>
        ({ at_utc: '2025-01-14T08:00Z', dispatch, sources });
    const cc = 'CC BY 4.0';
    const openInfo = () => fireEvent.mouseEnter(screen.getByTestId('context-map-situation-info-wrap'));

    afterEach(() => { vi.useRealTimers(); });

    it('names the dispatch of a real hour and credits its data in the info bubble', () => {
        const situation = realHour([
            { name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: cc },
            { name: 'powerplantmatching', url: 'https://github.com/PyPSA/powerplantmatching', licence: cc },
        ]);
        render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        // The credit no longer sits in the card: it waits behind the bubble.
        expect(screen.queryByTestId('context-map-situation')).toBeNull();
        expect(screen.getByTestId('context-map-summary')).not.toHaveTextContent('Real hour');
        openInfo();
        const credit = screen.getByTestId('context-map-situation');
        expect(screen.getByTestId('context-map-situation-popover')).toContainElement(credit);
        expect(credit).toHaveTextContent('Real hour, optimal dispatch (PyPSA)');
        expect(credit).toHaveTextContent('Energy-Charts (Fraunhofer ISE), powerplantmatching (CC BY 4.0)');
        expect(credit.querySelectorAll('a')).toHaveLength(2);
    });

    it('puts the info bubble beside the situation name, only for a real hour', () => {
        const situation = realHour([{ name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: cc }]);
        const { unmount } = render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        const title = screen.getByText(/^Situation — /);
        expect(title).toContainElement(screen.getByTestId('context-map-situation-info'));
        unmount();
        // A situation file says nothing when absent: no bubble, nothing to open.
        render(<ContextMapView state={state()} />);
        expect(screen.queryByTestId('context-map-situation-info')).toBeNull();
    });

    it('shows the info bubble on hover only, and never keeps it up afterwards', () => {
        vi.useFakeTimers();
        const situation = realHour([{ name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: cc }]);
        render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        const wrap = screen.getByTestId('context-map-situation-info-wrap');
        const bubble = screen.getByTestId('context-map-situation-info');
        const popover = () => screen.queryByTestId('context-map-situation-popover');

        expect(popover()).toBeNull();
        fireEvent.mouseEnter(wrap);
        expect(popover()).not.toBeNull();
        expect(bubble).toHaveAttribute('aria-expanded', 'true');
        fireEvent.mouseLeave(wrap);
        act(() => { vi.advanceTimersByTime(300); });
        expect(popover()).toBeNull();

        // A click does not pin it: the pointer is on the bubble, the popover is up, and it still goes
        // away once the pointer leaves.
        fireEvent.mouseEnter(wrap);
        fireEvent.click(bubble);
        fireEvent.mouseLeave(wrap);
        act(() => { vi.advanceTimersByTime(300); });
        expect(popover()).toBeNull();
        expect(bubble).toHaveAttribute('aria-expanded', 'false');
    });

    it('stays up while the pointer travels from the bubble into the popover', () => {
        vi.useFakeTimers();
        const situation = realHour([{ name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: cc }]);
        render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        const wrap = screen.getByTestId('context-map-situation-info-wrap');
        fireEvent.mouseEnter(wrap);
        fireEvent.mouseLeave(wrap);
        act(() => { vi.advanceTimersByTime(50); });
        fireEvent.mouseEnter(wrap);
        act(() => { vi.advanceTimersByTime(500); });
        expect(screen.queryByTestId('context-map-situation-popover')).not.toBeNull();
    });

    it('puts each licence after the sources it covers', () => {
        const situation = realHour([
            { name: 'Energy-Charts (Fraunhofer ISE)', url: 'https://www.energy-charts.info', licence: cc },
            // The unit outputs' source states no licence: none is claimed for it.
            { name: 'ENTSO-E Transparency Platform', url: 'https://transparency.entsoe.eu', licence: null },
            { name: 'powerplantmatching', url: 'https://github.com/PyPSA/powerplantmatching', licence: cc },
        ], 'observed');
        render(<ContextMapView state={state({ data: { ...payload(), situation } })} />);
        openInfo();
        expect(screen.getByTestId('context-map-situation')).toHaveTextContent(
            'Energy-Charts (Fraunhofer ISE), powerplantmatching (CC BY 4.0); ENTSO-E Transparency Platform');
    });

    it('shows the date and hour in their own big tile above the figures', () => {
        render(<ContextMapView state={state()} />);
        const clock = screen.getByTestId('context-map-date');
        expect(clock).toHaveTextContent('2026-01-10 17:30');
        expect(clock.querySelector('time')).toHaveAttribute('datetime', '2026-01-10T17:30:00+00:00');
        // A tile of its own, ahead of production / consumption / exports in the card.
        const summary = screen.getByTestId('context-map-summary');
        expect(clock.parentElement).toBe(summary);
        expect(clock.compareDocumentPosition(screen.getByText('Production:')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(clock).not.toHaveTextContent('Production');
    });

    it('draws no date tile for a network without a case date', () => {
        render(<ContextMapView state={state({ data: { ...payload(), case_date: null } })} />);
        expect(screen.queryByTestId('context-map-date')).toBeNull();
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

    it('draws a contingency and the overload on its twin circuit side by side, not one over the other', () => {
        // Twin circuits: the same two substations, the overload digitised the other way round.
        const twin: ContextMapHighlight = {
            role: 'overload', rho: 1.21, rhoBefore: 0.87,
            element: { ...contingency.element, id: 'L3', name: 'LINE ONE BIS',
                points: [contingency.element.points![1], contingency.element.points![0]] },
        };
        render(<ContextMapView state={state({ highlights: [contingency, twin] })} />);
        const path = (id: string) => screen.getByTestId(`context-map-highlight-${id}`).querySelector('path')!.getAttribute('d')!;
        // Each runs its own course between the shared substations…
        const middle = (d: string) => d.split('L')[1];
        expect(middle(path('L1'))).not.toEqual(middle(path('L3')));
        // …and the contingency is drawn last, on top where they still meet.
        const shapes = [...screen.getByTestId('context-map-highlights').querySelectorAll('[data-role]')];
        expect(shapes.map(s => s.getAttribute('data-role'))).toEqual(['overload', 'contingency']);
    });

    it('tells the line and its loading before → after on hovering its percentage', () => {
        const twin: ContextMapHighlight = { ...overload, rho: 1.21, rhoBefore: 0.87 };
        render(<ContextMapView state={state({ highlights: [contingency, twin], monitoringFactor: 0.95 })} />);
        fireEvent.mouseEnter(screen.getByTestId('context-map-rho-L2'), { clientX: 10, clientY: 10 });
        const tip = screen.getByTestId('context-map-tooltip');
        expect(tip).toHaveTextContent('Overload: LINE TWO');
        expect(screen.getByTestId('context-map-tooltip-loading')).toHaveTextContent('87 % → 121 % with the contingency');
        expect(tip).toHaveTextContent('Overloaded from 95 % of its limit');
        fireEvent.mouseLeave(screen.getByTestId('context-map-rho-L2'));
        expect(screen.queryByTestId('context-map-tooltip')).toBeNull();
    });

    it('falls back to the loading after the contingency when the N loading is unknown', () => {
        render(<ContextMapView state={state({ highlights: [contingency, overload] })} />);
        fireEvent.mouseEnter(screen.getByTestId('context-map-rho-L2'), { clientX: 10, clientY: 10 });
        expect(screen.getByTestId('context-map-tooltip-loading')).toHaveTextContent('Loading after contingency: 108 %');
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

    describe('consignations', () => {
        const cons = (over: Partial<ContextMapConsignation> & { id: string }): ContextMapConsignation => ({
            name: over.id, voltage: '400 kV', kind: 'line', points: [[1.6, -48.6], [3.3, -45.8]],
            vls: ['PARIS 400kV', 'LYON 400kV'], ...over,
        });
        const withConsignations = (items: ContextMapConsignation[], total = items.length): ContextMapData =>
            ({ ...payload(), consignations: { items, total } });

        it('draws the consigned circuits by voltage, and can hide them', () => {
            const data = withConsignations([
                cons({ id: 'C400', name: 'PARIS — LYON' }),
                cons({ id: 'C225', voltage: '225 kV', points: [[1.6, -48.6], [2.4, -47.0]] }),
            ]);
            render(<ContextMapView state={state({ data })} />);
            const layer = screen.getByTestId('context-map-consignations');
            expect(layer.querySelectorAll('g[data-voltage]')).toHaveLength(2);
            // 400 kV: solid and wide, red casing; 225 kV: dashed and narrower, green casing.
            const [casing400, core400] = screen.getByTestId('context-map-consignation-C400').querySelectorAll('path');
            expect(casing400).toHaveAttribute('stroke', '#ff1744');
            expect(core400).toHaveAttribute('stroke', '#d5ccd1');
            expect(core400).not.toHaveAttribute('stroke-dasharray');
            const [casing225, core225] = screen.getByTestId('context-map-consignation-C225').querySelectorAll('path');
            expect(casing225).toHaveAttribute('stroke', '#00c853');
            expect(core225).toHaveAttribute('stroke-dasharray');
            expect(Number(casing225.getAttribute('stroke-width'))).toBeLessThan(Number(casing400.getAttribute('stroke-width')));
            // 225 kV beneath 400 kV, whatever the payload order.
            expect([...layer.querySelectorAll('g[data-voltage]')].map(g => g.getAttribute('data-voltage')))
                .toEqual(['225 kV', '400 kV']);
            fireEvent.click(screen.getByTestId('context-map-consignation-toggle'));
            expect(screen.queryByTestId('context-map-consignations')).toBeNull();
        });

        it('names the circuit on hover', () => {
            const data = withConsignations([cons({ id: 'ALBERL72BATHI', name: 'ALBERTVILLE — BATHIE' })]);
            render(<ContextMapView state={state({ data })} />);
            fireEvent.mouseEnter(screen.getByTestId('context-map-consignation-ALBERL72BATHI'), { clientX: 5, clientY: 5 });
            const tip = screen.getByTestId('context-map-tooltip');
            expect(tip).toHaveTextContent('Consigned: ALBERTVILLE — BATHIE');
            expect(tip).toHaveTextContent('ALBERL72BATHI');
            expect(tip).toHaveTextContent('400 kV line, out of service');
            expect(tip).toHaveTextContent('PARIS 400kV – LYON 400kV');
            expect(tip).toHaveTextContent('No current at either end, isolated at both substations');
        });

        it('draws a transformer, whose ends coincide, as a point', () => {
            const data = withConsignations([cons({ id: 'TR', kind: 'transformer', points: [[3.3, -45.8], [3.3, -45.8]] })]);
            render(<ContextMapView state={state({ data })} />);
            const tr = screen.getByTestId('context-map-consignation-TR');
            expect(tr.querySelectorAll('path')).toHaveLength(0);
            expect(tr.querySelectorAll('circle')).toHaveLength(1);
            fireEvent.mouseEnter(tr, { clientX: 5, clientY: 5 });
            expect(screen.getByTestId('context-map-tooltip')).toHaveTextContent('400 kV transformer, out of service');
        });

        it('counts them in the legend, and says when there are none or some are unplaced', () => {
            const { rerender } = render(<ContextMapView state={state({ data: withConsignations([cons({ id: 'A' })]) })} />);
            const legend = screen.getByTestId('context-map-consignation-legend');
            expect(legend).toHaveTextContent('Consignations');
            expect(legend).toHaveTextContent('1');
            expect(screen.getByTestId('context-map-network-legend')).toHaveTextContent('400 kV');
            rerender(<ContextMapView state={state({ data: withConsignations([cons({ id: 'A' })], 3) })} />);
            expect(screen.getByTestId('context-map-consignation-legend')).toHaveTextContent('1 of 3 placed');
            rerender(<ContextMapView state={state({ data: withConsignations([]) })} />);
            expect(screen.getByTestId('context-map-consignation-legend')).toHaveTextContent('none');
            expect(screen.getByTestId('context-map-consignation-toggle')).toBeDisabled();
            expect(screen.queryByTestId('context-map-consignations')).toBeNull();
            // A payload without the layer (older backend): no row.
            rerender(<ContextMapView state={state()} />);
            expect(screen.queryByTestId('context-map-consignation-legend')).toBeNull();
        });
    });

    describe('network outline', () => {
        const network: ContextMapNetwork = {
            capture_id: 1,
            segments: {
                '400 kV': [[1.6, -48.6, 3.3, -45.8], [3.3, -45.8, 2.0, -44.0]],
                '225 kV': [[1.6, -48.6, 2.4, -47.0]],
            },
        };

        it('is off until asked for, asks the backend once, and draws each voltage on its own', () => {
            const requestNetwork = vi.fn();
            const { rerender } = render(<ContextMapView state={state({ requestNetwork })} />);
            expect(screen.queryByTestId('context-map-network')).toBeNull();
            expect(screen.getByTestId('context-map-network-400-toggle')).not.toBeChecked();
            fireEvent.click(screen.getByTestId('context-map-network-400-toggle'));
            expect(requestNetwork).toHaveBeenCalledTimes(1);
            // Asked for, not yet there: the legend says so, nothing is drawn.
            rerender(<ContextMapView state={state({ requestNetwork, networkLoading: true })} />);
            expect(screen.getByTestId('context-map-network-legend')).toHaveTextContent('loading');
            // Arrived: the 400 kV trace only — the 225 kV box is still unchecked.
            rerender(<ContextMapView state={state({ requestNetwork, network })} />);
            const path400 = screen.getByTestId('context-map-network-400');
            expect(path400).toHaveAttribute('stroke', '#e08b8b');
            expect(path400.getAttribute('d')!.match(/M/g)).toHaveLength(2);
            expect(screen.queryByTestId('context-map-network-225')).toBeNull();
            fireEvent.click(screen.getByTestId('context-map-network-225-toggle'));
            expect(screen.getByTestId('context-map-network-225')).toHaveAttribute('stroke', '#7fc39a');
            fireEvent.click(screen.getByTestId('context-map-network-400-toggle'));
            expect(screen.queryByTestId('context-map-network-400')).toBeNull();
        });

        it('lies under the transfers and the zones', () => {
            render(<ContextMapView state={state({ network })} />);
            fireEvent.click(screen.getByTestId('context-map-network-225-toggle'));
            const order = [...screen.getByTestId('context-map').querySelectorAll('svg > g > g')]
                .map(g => g.getAttribute('data-testid'));
            expect(order.indexOf('context-map-network')).toBeGreaterThan(order.indexOf('context-map-basemap'));
            expect(order.indexOf('context-map-network')).toBeLessThan(order.indexOf('context-map-flows'));
            expect(order.indexOf('context-map-network')).toBeLessThan(order.indexOf('context-map-zones'));
        });

        it('cannot be drawn on a map without a georeference', () => {
            const data: ContextMapData = { ...payload(), georef: null };
            render(<ContextMapView state={state({ data })} />);
            expect(screen.getByTestId('context-map-network-400-toggle')).toBeDisabled();
            expect(screen.getByTestId('context-map-network-225-toggle')).toBeDisabled();
        });
    });
});
