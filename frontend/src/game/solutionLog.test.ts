// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import type { ActionDetail, AnalysisResult, LogGameSolutionResponse } from '../types';
import {
  buildActionLevers,
  buildChosenActionRecord,
  buildLeverInteraction,
  buildSolutionLogRequest,
  leverInspectTarget,
  sessionNoveltyBonus,
  toStudyFeedback,
} from './solutionLog';
import type { GameLeverStatWire, GameSessionConfig, GameStudy, GameStudyResult } from './types';

function detail(over: Partial<ActionDetail> = {}): ActionDetail {
  return {
    description_unitaire: 'desc',
    rho_before: null,
    rho_after: null,
    max_rho: 0.9,
    max_rho_line: 'L1',
    is_rho_reduction: true,
    ...over,
  };
}

function analysisResult(actions: Record<string, ActionDetail>): AnalysisResult {
  return {
    pdf_path: null,
    pdf_url: null,
    actions,
    lines_overloaded: [],
    message: '',
    dc_fallback: false,
  };
}

describe('buildActionLevers', () => {
  it('derives MW-agnostic levers for injection actions', () => {
    const lo = buildActionLevers('redispatch_G1_up', detail({
      redispatch_details: [{ gen_name: 'G1', voltage_level_id: 'VL1', delta_mw: 50, target_mw: 150, direction: 'up' }],
    }), 'redispatch');
    const hi = buildActionLevers('redispatch_G1_up', detail({
      redispatch_details: [{ gen_name: 'G1', voltage_level_id: 'VL1', delta_mw: 120, target_mw: 220, direction: 'up' }],
    }), 'redispatch');
    // Different MW, same lever — novelty must not depend on the magnitude.
    expect(lo.levers).toEqual(['redispatch:G1']);
    expect(hi.levers).toEqual(lo.levers);
    expect(lo.actionType).toBe('redispatch');
  });

  it('maps each injection family to its lever prefix', () => {
    expect(buildActionLevers('a', detail({
      load_shedding_details: [{ load_name: 'LOAD_X', voltage_level_id: null, shedded_mw: 10 }],
    }), 'load_shedding').levers).toEqual(['ls:LOAD_X']);
    expect(buildActionLevers('a', detail({
      curtailment_details: [{ gen_name: 'WIND_1', voltage_level_id: null, curtailed_mw: 5 }],
    }), 'renewable_curtailment').levers).toEqual(['rc:WIND_1']);
    expect(buildActionLevers('a', detail({
      pst_details: [{ pst_name: 'PST_A', tap_position: 3, low_tap: -5, high_tap: 5 }],
    }), 'pst_tap_change').levers).toEqual(['pst:PST_A']);
  });

  it('decomposes a manual maneuver into switch + injection-retune levers', () => {
    const { levers } = buildActionLevers('user_topo_1', detail({
      description_unitaire: "Manoeuvre manuelle sur VL1: SW_A ouvert",
      action_topology: {
        lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {},
        switches: { SW_A: true },
        loads_p: { LOAD_1: 12 },
        gens_p: { GEN_1: 80 },
      },
    }), null);
    expect(levers).toContain('switch:SW_A=true');
    expect(levers).toContain('load_p:LOAD_1');
    expect(levers).toContain('gen_p:GEN_1');
  });

  it('does not duplicate levers when *_details already cover the elements', () => {
    const { levers } = buildActionLevers('a', detail({
      load_shedding_details: [{ load_name: 'LOAD_1', voltage_level_id: null, shedded_mw: 10 }],
      action_topology: {
        lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {},
        loads_p: { LOAD_1: 0 },
      },
    }), 'load_shedding');
    expect(levers).toEqual(['ls:LOAD_1']);
  });

  it('keeps injection-retune levers for elements the detail arrays do not cover', () => {
    // WIND_1 is described by curtailment_details, GEN_2 only by gens_p —
    // suppressing ALL gen_p levers would merge distinct propositions.
    const { levers } = buildActionLevers('a', detail({
      curtailment_details: [{ gen_name: 'WIND_1', voltage_level_id: null, curtailed_mw: 5 }],
      action_topology: {
        lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {},
        gens_p: { WIND_1: 0, GEN_2: 120 },
      },
    }), 'renewable_curtailment');
    expect(levers).toContain('rc:WIND_1');
    expect(levers).toContain('gen_p:GEN_2');
    expect(levers).not.toContain('gen_p:WIND_1');
  });

  it('leaves catalogue topology actions to their stable action id', () => {
    const { actionType, levers } = buildActionLevers(
      'disco_LINE_A', detail({ description_unitaire: 'Ouverture LINE_A' }), null);
    expect(levers).toEqual([]);
    expect(actionType).toBe('disco');
  });
});

describe('buildChosenActionRecord', () => {
  it('assembles the published record with type + levers from the result', () => {
    const result = analysisResult({
      redispatch_G1: detail({
        description_unitaire: 'Redispatch G1',
        max_rho: 0.85,
        lines_overloaded_after: [],
        redispatch_details: [{ gen_name: 'G1', voltage_level_id: null, delta_mw: 50, target_mw: 100, direction: 'up' }],
      }),
    });
    result.action_scores = { redispatch: { scores: { redispatch_G1: 1.2 } } };
    const rec = buildChosenActionRecord('redispatch_G1', result, 1.2);
    expect(rec).toMatchObject({
      actionId: 'redispatch_G1',
      description: 'Redispatch G1',
      actionType: 'redispatch',
      levers: ['redispatch:G1'],
      maxRho: 0.85,
      solved: true,
      effective: true,
    });
  });

  it('tolerates a missing result (unsimulated pick)', () => {
    const rec = buildChosenActionRecord('a1', null, 1.2);
    expect(rec.maxRho).toBeNull();
    expect(rec.solved).toBe(false);
    expect(rec.levers).toEqual([]);
    expect(rec.effective).toBe(false);
  });

  it('marks an action ineffective when it does not beat the baseline', () => {
    const result = analysisResult({
      // Still overloaded AND worse than doing nothing.
      a1: detail({ max_rho: 1.25, lines_overloaded_after: ['L9'] }),
      // Improves the loading without fully solving → effective.
      a2: detail({ max_rho: 1.05, lines_overloaded_after: ['L9'] }),
    });
    expect(buildChosenActionRecord('a1', result, 1.2).effective).toBe(false);
    expect(buildChosenActionRecord('a2', result, 1.2).effective).toBe(true);
  });

  it('requires a combined action to beat its parts by ≥ 1 loading-point', () => {
    const result = analysisResult({
      a1: detail({ max_rho: 0.95, lines_overloaded_after: [] }),
      a2: detail({ max_rho: 0.99, lines_overloaded_after: [] }),
      // 0.945 is < 1 point below the best part (0.95) → NOT effective.
      'a1+a2': detail({ max_rho: 0.945, lines_overloaded_after: [] }),
      // 0.94 is exactly 1 point below → effective.
      'a1+a3': detail({ max_rho: 0.94, lines_overloaded_after: [] }),
      a3: detail({ max_rho: 0.95, lines_overloaded_after: [] }),
    });
    expect(buildChosenActionRecord('a1+a2', result, 1.2).effective).toBe(false);
    expect(buildChosenActionRecord('a1+a3', result, 1.2).effective).toBe(true);
  });

  it('lets a combined action pass when its parts were never simulated alone', () => {
    const result = analysisResult({
      'disco_X+user_topo_VL1_123': detail({ max_rho: 0.9, lines_overloaded_after: [] }),
    });
    expect(buildChosenActionRecord('disco_X+user_topo_VL1_123', result, 1.2).effective).toBe(true);
  });
});

const STUDY: GameStudy = {
  id: 's1',
  label: 'Study 1',
  networkPath: 'data/grid/network.xiidm',
  actionFilePath: 'actions.json',
  contingencyElementId: 'ctg_1',
};

const CONFIG: GameSessionConfig = {
  sessionName: 'sess',
  player: 'alice',
  timerSeconds: 300,
  maxActions: 3,
  studies: [STUDY],
};

function studyResult(over: Partial<GameStudyResult> = {}): GameStudyResult {
  return {
    studyId: 's1',
    label: 'Study 1',
    contingencyElementId: 'ctg_1',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:03:00Z',
    durationMs: 180000,
    timedOut: false,
    timeLimitSeconds: 300,
    maxActions: 3,
    actionsChosen: [
      { actionId: 'disco_A', description: 'Ouverture A', actionType: 'disco', levers: [], maxRho: 0.9, solved: true, effective: true },
    ],
    numActions: 1,
    baselineMaxRho: 1.2,
    finalMaxRho: 0.9,
    solved: true,
    ...over,
  };
}

describe('buildSolutionLogRequest', () => {
  it('builds the snake_case wire payload', () => {
    expect(buildSolutionLogRequest(CONFIG, STUDY, studyResult())).toEqual({
      player: 'alice',
      session_name: 'sess',
      study_id: 's1',
      study_label: 'Study 1',
      network_path: 'data/grid/network.xiidm',
      contingency_id: 'ctg_1',
      solved: true,
      final_max_rho: 0.9,
      baseline_max_rho: 1.2,
      actions: [{
        action_id: 'disco_A',
        description: 'Ouverture A',
        action_type: 'disco',
        levers: [],
        effective: true,
      }],
    });
  });
});

const RESPONSE: LogGameSolutionResponse = {
  stored: true,
  duplicate: false,
  context_key: 'grid_network__ctg_1',
  signature: 'action:disco_A',
  novelty: { new_proposition: true, new_levers: ['action:disco_A'], effective: true, bonus_points: 20 },
  frequencies: [
    { action_id: 'disco_A', description: 'Ouverture A', signatures: ['action:disco_A'], count: 0, total: 0, share: 0 },
  ],
  context_stats: { distinct_propositions: 1, total_retentions: 1 },
};

describe('toStudyFeedback / sessionNoveltyBonus', () => {
  it('maps the wire response to camelCase feedback', () => {
    const fb = toStudyFeedback('s1', RESPONSE);
    expect(fb).toEqual({
      studyId: 's1',
      novelty: { newProposition: true, newLevers: ['action:disco_A'], effective: true, bonusPoints: 20 },
      frequencies: [{
        actionId: 'disco_A', description: 'Ouverture A', count: 0, total: 0, share: 0,
      }],
    });
  });

  it('derives the Inspect target of a lever hint', () => {
    // Catalogue disco/reco ids embed the branch — Inspect the branch itself.
    expect(leverInspectTarget({ signature: 'action:disco_LINE_A', label: 'disco_LINE_A' }))
      .toBe('LINE_A');
    expect(leverInspectTarget({ signature: 'action:reco_relation_123-225', label: 'reco_relation_123-225' }))
      .toBe('relation_123-225');
    // Other catalogue ids and element levers pass through.
    expect(leverInspectTarget({ signature: 'action:open_coupler_VL_X', label: 'open_coupler_VL_X' }))
      .toBe('open_coupler_VL_X');
    expect(leverInspectTarget({ signature: 'redispatch:G1', label: 'G1' })).toBe('G1');
    expect(leverInspectTarget({ signature: 'switch:VL1_COUPL=true', label: 'VL1_COUPL' }))
      .toBe('VL1_COUPL');
  });

  describe('buildLeverInteraction', () => {
    const lever = (over: Partial<GameLeverStatWire>): GameLeverStatWire => ({
      signature: 'action:disco_LINE_A', label: 'disco_LINE_A', category: 'branch',
      count: 1, share: 1, ...over,
    });

    it('maps a catalogue branch lever to an inspectable branch + simulatable action id', () => {
      const i = buildLeverInteraction(lever({ signature: 'action:disco_LINE_A', label: 'disco_LINE_A' }));
      expect(i.inspectQuery).toBe('LINE_A');       // branch id, for centering
      expect(i.category).toBe('branch');
      expect(i.simulate).toEqual({ actionId: 'disco_LINE_A' }); // full id, for simulating
    });

    it('maps a switch/coupling lever to its VL-openable id + a switch maneuver', () => {
      const i = buildLeverInteraction(lever({
        signature: 'switch:VL1_COUPL=true', label: 'VL1_COUPL', category: 'voltage_level',
      }));
      expect(i.inspectQuery).toBe('VL1_COUPL');
      expect(i.category).toBe('voltage_level');
      expect(i.simulate).toEqual({ switches: { VL1_COUPL: true } });
    });

    it('parses the target open-state of a switch lever (false closes it)', () => {
      const i = buildLeverInteraction(lever({
        signature: 'switch:SW_9=false', label: 'SW_9', category: 'voltage_level',
      }));
      expect(i.simulate).toEqual({ switches: { SW_9: false } });
    });

    it('leaves magnitude-free injection levers without a simulate spec', () => {
      const redispatch = buildLeverInteraction(lever({
        signature: 'redispatch:G1', label: 'G1', category: 'generation',
      }));
      expect(redispatch.inspectQuery).toBe('G1');
      expect(redispatch.simulate).toBeUndefined();

      const shedding = buildLeverInteraction(lever({
        signature: 'ls:LOAD_9', label: 'LOAD_9', category: 'load',
      }));
      expect(shedding.simulate).toBeUndefined();
    });

    it('keeps a non-branch catalogue action id verbatim (no disco/reco strip)', () => {
      const i = buildLeverInteraction(lever({
        signature: 'action:open_coupler_VL_X', label: 'open_coupler_VL_X', category: 'voltage_level',
      }));
      // Not a disco_/reco_ id → the id passes through for both inspect + simulate.
      expect(i.inspectQuery).toBe('open_coupler_VL_X');
      expect(i.simulate).toEqual({ actionId: 'open_coupler_VL_X' });
    });

    it('leaves PST and other levers without a simulate spec (magnitude-free / opaque)', () => {
      expect(buildLeverInteraction(lever({
        signature: 'pst:PST_1', label: 'PST_1', category: 'branch',
      })).simulate).toBeUndefined();
      expect(buildLeverInteraction(lever({
        signature: 'load_p:LOAD_2', label: 'LOAD_2', category: 'load',
      })).simulate).toBeUndefined();
    });

    it('defaults a switch lever with no explicit target-state to open', () => {
      const i = buildLeverInteraction(lever({
        signature: 'switch:SW_7', label: 'SW_7', category: 'voltage_level',
      }));
      expect(i.simulate).toEqual({ switches: { SW_7: true } });
    });
  });

  it('sums the per-study bonus points on top of the Codabench score', () => {
    const s1 = studyResult({ solutionFeedback: toStudyFeedback('s1', RESPONSE) });
    const s2 = studyResult({ studyId: 's2' });
    const s3 = studyResult({
      studyId: 's3',
      solutionFeedback: toStudyFeedback('s3', {
        ...RESPONSE,
        novelty: { new_proposition: true, new_levers: [], effective: true, bonus_points: 10 },
      }),
    });
    expect(sessionNoveltyBonus([s1, s2, s3])).toBe(30);
  });
});
