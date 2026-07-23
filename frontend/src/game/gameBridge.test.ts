// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { gameBridge } from './gameBridge';
import type { LeverInteraction } from '../types';

const INTERACTION: LeverInteraction = {
    inspectQuery: 'LINE_A',
    category: 'branch',
    simulate: { actionId: 'disco_LINE_A' },
};

describe('gameBridge — lever interaction handler', () => {
    // NOTE: `gameBridge` is a module singleton and there is no unregister API,
    // so the "no handler yet" case must be asserted FIRST, before any test
    // registers one (Vitest runs a file's tests in definition order and gives
    // each test file its own module registry).
    it('requestLeverInteraction is a no-op before any handler is registered', () => {
        expect(() => gameBridge.requestLeverInteraction(INTERACTION, 'inspect')).not.toThrow();
    });

    it('routes the interaction AND mode to the registered handler', () => {
        const handler = vi.fn();
        gameBridge.registerLeverHandler(handler);

        gameBridge.requestLeverInteraction(INTERACTION, 'simulate');

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(INTERACTION, 'simulate');
    });

    it('a later registration replaces the earlier handler', () => {
        const first = vi.fn();
        const second = vi.fn();
        gameBridge.registerLeverHandler(first);
        gameBridge.registerLeverHandler(second);

        gameBridge.requestLeverInteraction(INTERACTION, 'inspect');

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith(INTERACTION, 'inspect');
    });

    it('forwards both modes through the same handler', () => {
        const handler = vi.fn();
        gameBridge.registerLeverHandler(handler);

        gameBridge.requestLeverInteraction(INTERACTION, 'inspect');
        gameBridge.requestLeverInteraction(INTERACTION, 'simulate');

        expect(handler.mock.calls.map((c) => c[1])).toEqual(['inspect', 'simulate']);
    });
});
