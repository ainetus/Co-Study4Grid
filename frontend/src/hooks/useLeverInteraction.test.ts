// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const registerLeverHandler = vi.fn();
const isGameMode = vi.fn(() => true);
vi.mock('../game/gameBridge', () => ({
    gameBridge: {
        isGameMode: () => isGameMode(),
        registerLeverHandler: (fn: unknown) => registerLeverHandler(fn),
    },
}));

const getElementVoltageLevels = vi.fn();
vi.mock('../api', () => ({
    api: { getElementVoltageLevels: (id: string) => getElementVoltageLevels(id) },
}));

const notifyError = vi.fn();
const notifyInfo = vi.fn();
vi.mock('../utils/notifications', () => ({
    notifyError: (m: string) => notifyError(m),
    notifyInfo: (m: string) => notifyInfo(m),
}));

import { useLeverInteraction, type LeverInteractionParams } from './useLeverInteraction';
import type { DiagramsState } from './useDiagrams';
import type { LeverInteraction } from '../types';

type Handler = (i: LeverInteraction, mode: 'inspect' | 'simulate') => Promise<void>;

function makeParams(over: Partial<LeverInteractionParams> = {}): LeverInteractionParams {
    return {
        diagrams: {
            activeTab: 'contingency',
            setInspectQuery: vi.fn(),
            zoomToElement: vi.fn(),
        } as unknown as DiagramsState,
        handleSimulateUnsimulatedAction: vi.fn().mockResolvedValue(undefined),
        handleSimulateLever: vi.fn().mockResolvedValue(undefined),
        handleVlOpen: vi.fn(),
        ...over,
    };
}

/** Render the hook and return the handler it registered on the bridge. */
function renderAndGetHandler(params: LeverInteractionParams): Handler {
    renderHook(() => useLeverInteraction(params));
    return registerLeverHandler.mock.calls.at(-1)?.[0] as Handler;
}

describe('useLeverInteraction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isGameMode.mockReturnValue(true);
    });

    it('registers a lever handler only in game mode', () => {
        isGameMode.mockReturnValue(false);
        renderHook(() => useLeverInteraction(makeParams()));
        expect(registerLeverHandler).not.toHaveBeenCalled();

        isGameMode.mockReturnValue(true);
        renderHook(() => useLeverInteraction(makeParams()));
        expect(registerLeverHandler).toHaveBeenCalledTimes(1);
    });

    it('inspect on a branch lever centers on the branch itself (no VL lookup, no SLD)', async () => {
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => { await handler({ inspectQuery: 'LINE_A', category: 'branch' }, 'inspect'); });

        expect(params.diagrams.setInspectQuery).toHaveBeenCalledWith('LINE_A');
        expect(getElementVoltageLevels).not.toHaveBeenCalled();
        expect(params.diagrams.zoomToElement).toHaveBeenCalledWith('LINE_A', 'contingency');
        expect(params.handleVlOpen).not.toHaveBeenCalled();
    });

    it('inspect on an injection lever resolves its VL, centers there and opens the SLD', async () => {
        getElementVoltageLevels.mockResolvedValue({ voltage_level_ids: ['VL_G1'] });
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => { await handler({ inspectQuery: 'G1', category: 'generation' }, 'inspect'); });

        expect(getElementVoltageLevels).toHaveBeenCalledWith('G1');
        expect(params.diagrams.zoomToElement).toHaveBeenCalledWith('VL_G1', 'contingency');
        expect(params.handleVlOpen).toHaveBeenCalledWith('VL_G1');
    });

    it('simulate on a catalogue lever runs the action id directly', async () => {
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => {
            await handler({ inspectQuery: 'LINE_A', category: 'branch', simulate: { actionId: 'disco_LINE_A' } }, 'simulate');
        });

        expect(params.handleSimulateUnsimulatedAction).toHaveBeenCalledWith('disco_LINE_A');
        // Direct simulate short-circuits — no VL lookup / centering.
        expect(getElementVoltageLevels).not.toHaveBeenCalled();
        expect(params.diagrams.zoomToElement).not.toHaveBeenCalled();
    });

    it('simulate on a coupling lever resolves the VL and runs the maneuver', async () => {
        getElementVoltageLevels.mockResolvedValue({ voltage_level_ids: ['VL_SW'] });
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => {
            await handler({ inspectQuery: 'SW1', category: 'voltage_level', simulate: { switches: { SW1: true } } }, 'simulate');
        });

        expect(params.handleSimulateLever).toHaveBeenCalledWith({ voltageLevelId: 'VL_SW', switches: { SW1: true } });
        expect(params.handleVlOpen).not.toHaveBeenCalled();
    });

    it('warns when a coupling maneuver cannot be located to a single VL', async () => {
        getElementVoltageLevels.mockResolvedValue({ voltage_level_ids: [] });
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => {
            await handler({ inspectQuery: 'SW1', category: 'voltage_level', simulate: { switches: { SW1: true } } }, 'simulate');
        });

        expect(params.handleSimulateLever).not.toHaveBeenCalled();
        expect(notifyError).toHaveBeenCalledWith('Could not locate the substation for this maneuver.');
    });

    it('double-clicking a magnitude-free lever (PST / raw setpoint) degrades to inspect with a hint', async () => {
        // redispatch / ls / rc levers now carry a simulate spec; a lever that
        // reaches the handler with NO simulate (PST, raw gen_p/load_p) degrades.
        getElementVoltageLevels.mockResolvedValue({ voltage_level_ids: ['VL_G1'] });
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => { await handler({ inspectQuery: 'G1', category: 'generation' }, 'simulate'); });

        expect(notifyInfo).toHaveBeenCalledWith('Set the amount in the substation diagram, then Simulate.');
        expect(params.handleSimulateLever).not.toHaveBeenCalled();
        expect(params.handleSimulateUnsimulatedAction).not.toHaveBeenCalled();
        // Falls through to inspect: centers on the VL and opens its SLD.
        expect(params.diagrams.zoomToElement).toHaveBeenCalledWith('VL_G1', 'contingency');
        expect(params.handleVlOpen).toHaveBeenCalledWith('VL_G1');
    });

    it('falls back to centering on the id when VL resolution fails', async () => {
        getElementVoltageLevels.mockRejectedValue(new Error('not loaded'));
        const params = makeParams();
        const handler = renderAndGetHandler(params);

        await act(async () => { await handler({ inspectQuery: 'G1', category: 'generation' }, 'inspect'); });

        expect(params.diagrams.zoomToElement).toHaveBeenCalledWith('G1', 'contingency');
        expect(params.handleVlOpen).not.toHaveBeenCalled();
    });

    it('remaps the overflow tab to the contingency tab for centering', async () => {
        const params = makeParams({
            diagrams: {
                activeTab: 'overflow',
                setInspectQuery: vi.fn(),
                zoomToElement: vi.fn(),
            } as unknown as DiagramsState,
        });
        const handler = renderAndGetHandler(params);

        await act(async () => { await handler({ inspectQuery: 'LINE_A', category: 'branch' }, 'inspect'); });

        expect(params.diagrams.setInspectQuery).toHaveBeenCalledWith('LINE_A');
        expect(params.diagrams.zoomToElement).toHaveBeenCalledWith('LINE_A', 'contingency');
    });
});
