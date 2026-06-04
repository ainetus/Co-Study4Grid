// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import {
    classifyActionType,
    classifyActionTypes,
    matchesActionTypeFilter,
    ACTION_TYPE_FILTER_TOKENS,
    ACTION_TYPE_LABELS,
    DEFAULT_ACTION_OVERVIEW_FILTERS,
    severityFromMaxRho,
    resolveRowSeverity,
    rowPassesSeverityFilter,
    rowPassesActionFilters,
} from './actionTypes';
import type { ActionOverviewFilters } from '../types';

describe('classifyActionType', () => {
    it('classifies line disconnection actions from their score-table type', () => {
        expect(classifyActionType('disco_LINE_A', null, 'line_disconnection')).toBe('disco');
    });

    it('classifies line reconnection actions from "reco_" prefix / description', () => {
        expect(classifyActionType('reco_LINE_A', 'Fermeture de la ligne', 'line_reconnection')).toBe('reco');
    });

    it('classifies open coupling actions', () => {
        expect(classifyActionType('open_coupling_VL_A', null, 'open_coupling')).toBe('open');
    });

    it('classifies close coupling actions', () => {
        expect(classifyActionType('close_coupling_VL_A', null, 'close_coupling')).toBe('close');
    });

    it('classifies "Ouverture du poste X" as OPEN coupling (not disco)', () => {
        // Description-only classification: couplings take precedence
        // over the desc-based disco check so "Ouverture du poste"
        // doesn't fall into the line-disconnection bucket.
        expect(classifyActionType('some_id', "Ouverture du poste 'VL_FAR'", null)).toBe('open');
    });

    it('classifies "Fermeture du poste X" as CLOSE coupling (not reco)', () => {
        expect(classifyActionType('some_id', "Fermeture du poste 'VL_FAR'", null)).toBe('close');
    });

    it('classifies "Ouverture OC ... dans le poste \'X\'" (TRO-coupler) as OPEN coupling', () => {
        // Operator-style description used for TRO-coupler open actions —
        // the coupling phrasing is "dans le poste 'X'" rather than the
        // recommender's "du poste 'X'". Both must read as coupling so
        // the overview pin and the feed card share the same bucket
        // (the un-quoted "dans le poste POSTE" line-opening case stays
        // in the disco bucket — see the regex comment for why).
        expect(classifyActionType(
            '466f2c03-90ce-401e-a458-fa177ad45abc_C.REGP6',
            "Ouverture OC 'C.REG6TRO.1AB DJ_OC' dans le poste 'C.REGP6'",
            null,
        )).toBe('open');
    });

    it('keeps "DJ_OC dans le poste UNQUOTED" classified as DISCO (no quote → not coupling)', () => {
        // Regression guard: the substation-name-without-quotes phrasing
        // is the line-opening case the previous regex was tuned around.
        // With the extended (du|dans le) regex still requiring a
        // following quote/apostrophe, the line action keeps its bucket.
        expect(classifyActionType(
            'some_id',
            'DJ_OC dans le poste POSTE — Ouverture de la ligne X',
            null,
        )).toBe('disco');
    });

    it('classifies a "reco_X" action by id alone (no scoreType, no desc marker)', () => {
        // Overview pin filter only has id + description in scope; this
        // case used to vanish from the overview because reco_X actions
        // often have no "fermeture" word in the description.
        expect(classifyActionType('reco_GEN.PY762', 'Reconnect GEN.PY762', null)).toBe('reco');
    });

    it('classifies a "disco_X" action by id alone (no scoreType, no desc marker)', () => {
        expect(classifyActionType('disco_LINE_A', 'Open line LINE_A', null)).toBe('disco');
    });

    it('classifies "Ouverture de la ligne X" as DISCO', () => {
        expect(classifyActionType('some_id', "Ouverture de la ligne 'LINE_A'", null)).toBe('disco');
    });

    it('classifies open-coupling via the id even when desc is empty', () => {
        expect(classifyActionType('open_coupling_VL_A', null, null)).toBe('open');
    });

    it('classifies node_merging_* as CLOSE coupling (id-based)', () => {
        // Regression: node_merging actions carry no "close_coupling"
        // or "fermeture" token — they used to fall into 'unknown'
        // and disappear when the CLOSE chip was active.
        expect(classifyActionType('node_merging_PYMONP3', null, null)).toBe('close');
        expect(classifyActionType('node_merging_PYMONP3', 'No description available', null)).toBe('close');
    });

    it('classifies node_splitting_* as OPEN coupling (id-based)', () => {
        expect(classifyActionType('node_splitting_VL_X', null, null)).toBe('open');
    });

    it('classifies node_merging/node_splitting from the score-table type too', () => {
        expect(classifyActionType('xyz', null, 'node_merging')).toBe('close');
        expect(classifyActionType('xyz', null, 'node_splitting')).toBe('open');
    });

    // Line vs coupling: "Ouverture X DJ_OC dans le poste Y"
    // describes opening a breaker on a LINE (not a bus coupling), so
    // it must land in DISCO — even though the description contains
    // both "poste" and "ouverture". Coupling actions carry either a
    // `_coupling` suffix on the id, a `COUPL` segment in the
    // description, or the specific "du poste 'X'" phrasing.
    describe('line vs coupling when description contains "poste"', () => {
        it('DJ_OC on a line (id without coupling token) → DISCO', () => {
            const id = 'b1a3225d-b06a-4c09-8890-9c8d6061d1db_C.FOUP3_C.FOU3MERVA.1';
            const desc = 'Ouverture C.FOUP3_C.FOU3MERVA.1 DJ_OC dans le poste C.FOUP3';
            expect(classifyActionType(id, desc, null)).toBe('disco');
        });

        it('DJ_OC with _coupling suffix in id → OPEN', () => {
            const id = 'f344b395-9908-43c2-bca0-75c5f298465e_COUCHP6_coupling';
            const desc = 'Ouverture COUCHP6_COUCH6COUPL DJ_OC dans le poste COUCHP6';
            expect(classifyActionType(id, desc, null)).toBe('open');
        });

        it('DJ_OC with "COUPL" / "coupling" inside the description → OPEN', () => {
            const id = '3617076a-a7f5-4f8a-9009-127ac9b85cff_VIELMP6';
            const desc = 'Ouverture VIELMP6_VIELM6COUPL DJ_OC dans le poste VIELMP6';
            expect(classifyActionType(id, desc, null)).toBe('open');
        });

        it('"Ouverture du poste \'X\'" with coupling-less id → OPEN (coupling-is-target phrasing)', () => {
            expect(classifyActionType('some_id', "Ouverture du poste 'VL_FAR'", null)).toBe('open');
        });

        it('line RECONNECTION with "dans le poste" phrasing → RECO', () => {
            const id = 'abc_LINE_A_LINE_B.1';
            const desc = 'Fermeture LINE_A_LINE_B.1 DJ_FE dans le poste POSTE_A';
            expect(classifyActionType(id, desc, null)).toBe('reco');
        });

        it('coupling CLOSE with _coupling id AND "Fermeture ... dans le poste" desc → CLOSE', () => {
            const id = 'zyx_COUCHP6_coupling';
            const desc = 'Fermeture COUCHP6_COUCH6COUPL DJ_FE dans le poste COUCHP6';
            expect(classifyActionType(id, desc, null)).toBe('close');
        });
    });

    it('classifies PST tap changes — and DOES NOT mis-bucket "PST" inside a coupling description', () => {
        expect(classifyActionType('pst_PST_X', 'PST tap change', 'pst_tap_change')).toBe('pst');
        // coupling description that mentions PST must still be open/close
        expect(classifyActionType('open_coupling_VL_A', "PST d'origine du poste", 'open_coupling')).toBe('open');
    });

    it('classifies load shedding from id / description / type', () => {
        expect(classifyActionType('load_shedding_LOAD_X', 'load shedding', 'load_shedding')).toBe('ls');
    });

    it('classifies renewable curtailment from open_gen / renewable_curtailment type', () => {
        expect(classifyActionType('rc_GEN_X', null, 'renewable_curtailment')).toBe('rc');
        expect(classifyActionType('rc_GEN_X', null, 'open_gen')).toBe('rc');
    });

    it('falls back to "unknown" when no signal matches', () => {
        expect(classifyActionType('mystery_action', 'floats', 'weird_type')).toBe('unknown');
    });

    it('uses description "Ouverture" as a disco signal when type is missing', () => {
        expect(classifyActionType('mystery', "Ouverture de la ligne 'LINE_A'", null)).toBe('disco');
    });
});

describe('matchesActionTypeFilter', () => {
    it('all matches everything, including unknown', () => {
        expect(matchesActionTypeFilter('all', 'mystery', 'floats', null)).toBe(true);
        expect(matchesActionTypeFilter('all', 'disco_LINE_A', null, 'line_disconnection')).toBe(true);
    });

    it('specific filter only matches its bucket', () => {
        expect(matchesActionTypeFilter('disco', 'disco_LINE_A', null, 'line_disconnection')).toBe(true);
        expect(matchesActionTypeFilter('reco', 'disco_LINE_A', null, 'line_disconnection')).toBe(false);
    });

    it('specific filter does NOT match unknown bucket actions', () => {
        expect(matchesActionTypeFilter('disco', 'mystery', 'floats', null)).toBe(false);
    });

    // Manual SLD-edit maneuver cards use the past participles
    // "ouvert"/"fermé" and may combine several switches.
    const openManeuver = 'Manoeuvre manuelle sur COUCHP6: COUCHP6_COUCH6COUPL DJ_OC ouvert';
    const closeManeuver = 'Manoeuvre manuelle sur PYMONP3: PYMONP3_PYMON3COUPL DJ_OC fermé';
    const combinedManeuver = `[COMBINED] ${openManeuver} + ${closeManeuver}`;

    it('matches an open-coupling maneuver on the open filter', () => {
        expect(matchesActionTypeFilter('open', 'user_topo_COUCHP6_1', openManeuver, null)).toBe(true);
        expect(matchesActionTypeFilter('close', 'user_topo_COUCHP6_1', openManeuver, null)).toBe(false);
    });

    it('matches a close-coupling maneuver on the close filter', () => {
        expect(matchesActionTypeFilter('close', 'user_topo_PYMONP3_1', closeManeuver, null)).toBe(true);
        expect(matchesActionTypeFilter('open', 'user_topo_PYMONP3_1', closeManeuver, null)).toBe(false);
    });

    it('matches a combined open+close maneuver on BOTH filters', () => {
        const id = 'user_topo_COUCHP6_1+user_topo_PYMONP3_2';
        expect(matchesActionTypeFilter('open', id, combinedManeuver, null)).toBe(true);
        expect(matchesActionTypeFilter('close', id, combinedManeuver, null)).toBe(true);
    });

    // A single maneuver can open a coupling AND a line (comma-joined),
    // so it must pass BOTH the open-coupling and line-disconnection
    // filters.
    const couplingPlusLineOpen = 'Manoeuvre manuelle sur COUCHP6: COUCHP6_COUCH6COUPL DJ_OC ouvert, COUCHP6_COUCH6CPVAN.1 DJ_OC ouvert';

    it('matches a maneuver that opens both a coupling and a line on open AND disco', () => {
        const id = 'user_topo_COUCHP6_1';
        expect(matchesActionTypeFilter('open', id, couplingPlusLineOpen, null)).toBe(true);
        expect(matchesActionTypeFilter('disco', id, couplingPlusLineOpen, null)).toBe(true);
        expect(matchesActionTypeFilter('close', id, couplingPlusLineOpen, null)).toBe(false);
    });
});

describe('classifyActionTypes (multi-bucket)', () => {
    it('returns a singleton for a normal recommender action', () => {
        expect([...classifyActionTypes('disco_LINE_A', null, 'line_disconnection')]).toEqual(['disco']);
    });

    it('returns both open and close for a combined maneuver', () => {
        const id = 'user_topo_A_1+user_topo_B_2';
        const desc = '[COMBINED] Manoeuvre manuelle sur A: A_COUPL DJ_OC ouvert + Manoeuvre manuelle sur B: B_COUPL DJ_OC fermé';
        const set = classifyActionTypes(id, desc, null);
        expect(set.has('open')).toBe(true);
        expect(set.has('close')).toBe(true);
    });

    it('buckets a non-coupling maneuver switch as disco/reco', () => {
        const set = classifyActionTypes(
            'user_topo_VL_1',
            'Manoeuvre manuelle sur VL: VL_SOMELINE DJ ouvert',
            null,
        );
        expect(set.has('disco')).toBe(true);
        expect(set.has('open')).toBe(false);
    });
});

describe('ACTION_TYPE_FILTER_TOKENS', () => {
    it('lists all eight chip tokens in display order', () => {
        expect(ACTION_TYPE_FILTER_TOKENS).toEqual(['all', 'disco', 'reco', 'ls', 'rc', 'open', 'close', 'pst']);
    });
});

describe('DEFAULT_ACTION_OVERVIEW_FILTERS', () => {
    it('defaults actionType to "all"', () => {
        expect(DEFAULT_ACTION_OVERVIEW_FILTERS.actionType).toBe('all');
    });

    it('enables every severity category by default', () => {
        expect(DEFAULT_ACTION_OVERVIEW_FILTERS.categories).toEqual({
            green: true, orange: true, red: true, grey: true,
        });
    });

    it('sets threshold to 1.5 and hides un-simulated pins by default', () => {
        expect(DEFAULT_ACTION_OVERVIEW_FILTERS.threshold).toBe(1.5);
        expect(DEFAULT_ACTION_OVERVIEW_FILTERS.showUnsimulated).toBe(false);
    });
});

describe('ACTION_TYPE_LABELS', () => {
    it('carries a human-readable label for every non-"all" filter token', () => {
        for (const token of ACTION_TYPE_FILTER_TOKENS) {
            if (token === 'all') continue;
            expect(ACTION_TYPE_LABELS[token]).toBeTruthy();
        }
    });

    it('labels couplings as voltage-level operations and lines as line operations', () => {
        expect(ACTION_TYPE_LABELS.disco).toBe('Line disconnection');
        expect(ACTION_TYPE_LABELS.reco).toBe('Line reconnection');
        expect(ACTION_TYPE_LABELS.open).toBe('Open coupling');
        expect(ACTION_TYPE_LABELS.close).toBe('Close coupling');
    });
});

describe('severityFromMaxRho', () => {
    const mf = 0.95;

    it('returns null when there is no value to classify', () => {
        expect(severityFromMaxRho(null, mf)).toBeNull();
        expect(severityFromMaxRho(undefined, mf)).toBeNull();
    });

    it('classifies above the monitoring factor as red', () => {
        expect(severityFromMaxRho(1.1, mf)).toBe('red');
    });

    it('classifies the low-margin band (mf-0.05 .. mf) as orange', () => {
        expect(severityFromMaxRho(0.93, mf)).toBe('orange');
    });

    it('classifies comfortably-below-limit as green', () => {
        expect(severityFromMaxRho(0.5, mf)).toBe('green');
    });
});

describe('resolveRowSeverity', () => {
    const mf = 0.95;

    it('classifies fault rows (divergent / islanded) as grey', () => {
        expect(resolveRowSeverity({ isFault: true, simulatedMaxRho: 0.5 }, mf)).toBe('grey');
    });

    it('prefers the simulated value over the estimated value', () => {
        // Simulated says green (0.5), estimated says red (1.2) — simulated wins.
        expect(resolveRowSeverity({ simulatedMaxRho: 0.5, estimatedMaxRho: 1.2 }, mf)).toBe('green');
    });

    it('falls back to the estimated value when no simulated value is available', () => {
        expect(resolveRowSeverity({ simulatedMaxRho: null, estimatedMaxRho: 1.2 }, mf)).toBe('red');
    });

    it('returns null when neither a simulated nor an estimated value exists', () => {
        expect(resolveRowSeverity({}, mf)).toBeNull();
    });
});

describe('rowPassesSeverityFilter', () => {
    const allOn = { green: true, orange: true, red: true, grey: true };

    it('passes everything — including null-severity rows — when no category is disabled', () => {
        expect(rowPassesSeverityFilter(null, allOn)).toBe(true);
        expect(rowPassesSeverityFilter('green', allOn)).toBe(true);
    });

    it('hides null-severity rows as soon as a category is disabled', () => {
        const partial = { ...allOn, red: false };
        expect(rowPassesSeverityFilter(null, partial)).toBe(false);
    });

    it('keeps a row whose severity bucket is still enabled', () => {
        const partial = { ...allOn, red: false };
        expect(rowPassesSeverityFilter('green', partial)).toBe(true);
        expect(rowPassesSeverityFilter('red', partial)).toBe(false);
    });
});

describe('rowPassesActionFilters', () => {
    const base: ActionOverviewFilters = DEFAULT_ACTION_OVERVIEW_FILTERS;

    it('passes a row that matches both the type ring and the severity ring', () => {
        const filters: ActionOverviewFilters = { ...base, actionType: 'reco' };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_GEN.PY762', scoreType: 'line_reconnection', simulatedMaxRho: 0.8,
        }, 0.95)).toBe(true);
    });

    it('rejects a row whose action-type bucket does not match the type ring', () => {
        const filters: ActionOverviewFilters = { ...base, actionType: 'disco' };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_GEN.PY762', scoreType: 'line_reconnection', simulatedMaxRho: 0.8,
        }, 0.95)).toBe(false);
    });

    it('rejects a row whose severity bucket is disabled', () => {
        const filters: ActionOverviewFilters = {
            ...base, categories: { ...base.categories, red: false },
        };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection', simulatedMaxRho: 1.2,
        }, 0.95)).toBe(false);
    });

    it('hides a scored-but-untested row (no value) once the severity ring is active', () => {
        const filters: ActionOverviewFilters = {
            ...base, categories: { ...base.categories, grey: false },
        };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection',
        }, 0.95)).toBe(false);
    });

    it('keeps a scored-but-untested row while no severity bucket is disabled', () => {
        expect(rowPassesActionFilters(base, {
            actionId: 'reco_X', scoreType: 'line_reconnection',
        }, 0.95)).toBe(true);
    });

    it('hides rows whose simulated max-ρ exceeds the threshold (Max-loading filter)', () => {
        // The Manual Selection / Combine Actions score tables route
        // their filtering through ``rowPassesActionFilters``; without
        // applying the threshold the Max-loading spinner in the
        // sidebar rings would silently no-op there.
        const filters: ActionOverviewFilters = { ...base, threshold: 0.9 };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection', simulatedMaxRho: 0.95,
        }, 0.95)).toBe(false);
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection', simulatedMaxRho: 0.85,
        }, 0.95)).toBe(true);
    });

    it('falls back to the estimated max-ρ for the threshold check when simulated is missing', () => {
        const filters: ActionOverviewFilters = { ...base, threshold: 0.9 };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection', estimatedMaxRho: 0.95,
        }, 0.95)).toBe(false);
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection', estimatedMaxRho: 0.85,
        }, 0.95)).toBe(true);
    });

    it('keeps a value-less row regardless of threshold (consistent with grey bucket / null max-ρ rule)', () => {
        const filters: ActionOverviewFilters = { ...base, threshold: 0.5 };
        expect(rowPassesActionFilters(filters, {
            actionId: 'reco_X', scoreType: 'line_reconnection',
        }, 0.95)).toBe(true);
    });
});
