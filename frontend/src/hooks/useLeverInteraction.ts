// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Game-Mode beginner-assistance wiring, extracted from App.tsx to keep the
// hub under its size ceiling. Registers a handler on `gameBridge` that drives
// the workspace from a lever hint (the "most-used levers" panel):
//   - single-click ('inspect'): fill the Inspect field, center the NAD on the
//     element (resolving an injection / coupling switch to its home VL), and
//     open that substation's SLD so the beginner can inspect it;
//   - double-click ('simulate'): run the mapped action directly — a catalogue
//     branch disco/reco, or a coupling maneuver at the resolved VL. Magnitude-
//     free injection / PST levers carry no action, so they degrade to inspect
//     with a hint to set the amount in the SLD.
//
// App keeps ownership of the collaborators (diagrams + the two simulate
// entry points + the SLD opener) and passes them in, so this stays a thin
// orchestrator and the bare (non-game) app never touches the bridge.

import { useCallback, useEffect } from 'react';
import { api } from '../api';
import { gameBridge, type LeverInteractionMode } from '../game/gameBridge';
import { notifyError, notifyInfo } from '../utils/notifications';
import type { LeverInteraction } from '../types';
import type { DiagramsState } from './useDiagrams';

export interface LeverInteractionParams {
    diagrams: DiagramsState;
    /** Simulate a catalogue action (branch disco/reco) by id. */
    handleSimulateUnsimulatedAction: (actionId: string) => Promise<void>;
    /** Simulate a coupling maneuver (switch toggle) at a resolved VL. */
    handleSimulateLever: (spec: { voltageLevelId: string; switches: Record<string, boolean> }) => Promise<void>;
    /** Open the SLD overlay for a voltage level. */
    handleVlOpen: (vlName: string) => void;
}

export function useLeverInteraction(params: LeverInteractionParams): void {
    const { diagrams, handleSimulateUnsimulatedAction, handleSimulateLever, handleVlOpen } = params;

    const handleLeverInteraction = useCallback(
        async (interaction: LeverInteraction, mode: LeverInteractionMode) => {
            const { inspectQuery, category, simulate } = interaction;
            // The overflow tab isn't a NAD — center on the contingency tab instead.
            const tab = diagrams.activeTab === 'overflow' ? 'contingency' : diagrams.activeTab;

            // Fill the Inspect field with the clicked element (both modes). We
            // center explicitly below, so use the plain setter that doesn't pin
            // a focus tab (an injection / switch name never matches a NAD id,
            // which would otherwise leave that pin dangling).
            diagrams.setInspectQuery(inspectQuery);

            // A catalogue action (branch disco/reco) simulates directly by id.
            if (mode === 'simulate' && simulate?.actionId) {
                await handleSimulateUnsimulatedAction(simulate.actionId);
                return;
            }

            // Resolve the element's home VL for everything that isn't a branch
            // (a branch spans two VLs and is centered directly by its own id).
            let homeVl: string | null = null;
            if (category !== 'branch') {
                try {
                    const { voltage_level_ids } = await api.getElementVoltageLevels(inspectQuery);
                    if (voltage_level_ids.length === 1) homeVl = voltage_level_ids[0];
                } catch {
                    // Resolution is best-effort — fall through to centering on the id.
                }
            }

            // A coupling maneuver simulates directly once we know its VL.
            if (mode === 'simulate' && simulate?.switches) {
                if (homeVl) await handleSimulateLever({ voltageLevelId: homeVl, switches: simulate.switches });
                else notifyError('Could not locate the substation for this maneuver.');
                return;
            }

            // Magnitude-free lever double-clicked: it can't be simulated as-is,
            // so guide the operator to set the amount in the SLD, then fall
            // through to inspect (locate + open the substation).
            if (mode === 'simulate' && !simulate) {
                notifyInfo('Set the amount in the substation diagram, then Simulate.');
            }

            // Inspect: center the NAD, and open the SLD when the lever lives in
            // one substation (an injection or a coupling switch → a single VL).
            if (homeVl) {
                diagrams.zoomToElement(homeVl, tab);
                handleVlOpen(homeVl);
            } else {
                diagrams.zoomToElement(inspectQuery, tab);
            }
        },
        [diagrams, handleSimulateUnsimulatedAction, handleSimulateLever, handleVlOpen],
    );

    useEffect(() => {
        if (!gameBridge.isGameMode()) return;
        gameBridge.registerLeverHandler(handleLeverInteraction);
    }, [handleLeverInteraction]);
}
