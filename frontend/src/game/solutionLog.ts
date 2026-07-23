// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

// ---------------------------------------------------------------------------
// Solution capitalisation — client side.
//
// At every study commit the retained (starred) actions are logged into the
// shared solution base (POST /api/game/log-solution), mirroring the
// manoeuvre IHM scenario base of expert_op4grid_recommender. The backend
// judges novelty on magnitude-free *unitary signatures*; this module
// computes them from the enriched ActionDetail the App already publishes:
//
//   - injections mobilise *levers* — `redispatch:<gen>`, `ls:<load>`,
//     `rc:<gen>`, `pst:<pst>` — with NO MW / tap value, so retuning a
//     known lever is not novel but mobilising a new one is;
//   - manual SLD maneuvers decompose into `switch:<id>=<state>` +
//     `load_p:<load>` / `gen_p:<gen>` levers (their generated action ids
//     are not stable across sessions);
//   - plain catalogue actions keep their stable `action_id` identity
//     (no levers → the backend signs them `action:<id>`).
// ---------------------------------------------------------------------------

import type {
  ActionDetail,
  AnalysisResult,
  GameLeverStatWire,
  LeverInteraction,
  LogGameSolutionRequest,
  LogGameSolutionResponse,
} from '../types';
import { classifyActionType } from '../utils/actionTypes';
import type {
  ChosenActionRecord,
  GameSessionConfig,
  GameStudy,
  GameStudyResult,
  StudySolutionFeedback,
} from './types';

/** Score-table type of an action (`action_scores` outer key), if scored. */
function scoreTypeFor(result: AnalysisResult | null, actionId: string): string | null {
  for (const [scoreType, entry] of Object.entries(result?.action_scores ?? {})) {
    if (entry?.scores && actionId in entry.scores) return scoreType;
  }
  return null;
}

/** Magnitude-free levers + action-type bucket for one action. */
export function buildActionLevers(
  actionId: string,
  detail: ActionDetail | undefined,
  scoreType: string | null,
): { actionType?: string; levers: string[] } {
  const bucket = classifyActionType(actionId, detail?.description_unitaire, scoreType);
  const levers: string[] = [];
  detail?.redispatch_details?.forEach((r) => levers.push(`redispatch:${r.gen_name}`));
  detail?.load_shedding_details?.forEach((l) => levers.push(`ls:${l.load_name}`));
  detail?.curtailment_details?.forEach((c) => levers.push(`rc:${c.gen_name}`));
  detail?.pst_details?.forEach((p) => levers.push(`pst:${p.pst_name}`));
  const topo = detail?.action_topology;
  Object.entries(topo?.switches ?? {}).forEach(([switchId, state]) =>
    levers.push(`switch:${switchId}=${String(state)}`));
  // Injection retunes (loads_p / gens_p) — skipped per ELEMENT when a
  // *_details entry already describes it (catalogue injection actions carry
  // both representations), but kept for elements the detail arrays don't
  // cover (e.g. a maneuver retuning a renewable AND a dispatchable gen).
  const coveredLoads = new Set(
    (detail?.load_shedding_details ?? []).map((l) => l.load_name));
  const coveredGens = new Set([
    ...(detail?.curtailment_details ?? []).map((c) => c.gen_name),
    ...(detail?.redispatch_details ?? []).map((r) => r.gen_name),
  ]);
  Object.keys(topo?.loads_p ?? {})
    .filter((load) => !coveredLoads.has(load))
    .forEach((load) => levers.push(`load_p:${load}`));
  Object.keys(topo?.gens_p ?? {})
    .filter((gen) => !coveredGens.has(gen))
    .forEach((gen) => levers.push(`gen_p:${gen}`));
  return {
    actionType: bucket === 'unknown' ? undefined : bucket,
    levers: [...new Set(levers)],
  };
}

/**
 * A combined `a+b` action must beat its underlying actions by at least
 * this much (per-unit loading — 0.01 == 1 loading-point) to count as
 * effective. Combining two actions has an operational cost; the bonus
 * only rewards combinations that genuinely outperform their parts.
 */
export const COMBINED_MIN_RHO_GAIN = 0.01;

/**
 * True when a combined action outperforms its underlying actions: its
 * worst loading sits ≥ 1 loading-point below the BEST of the parts.
 * Single actions pass trivially; so does a combination whose parts were
 * never simulated alone (nothing to compare against).
 */
function combinedBeatsUnderlying(
  actionId: string,
  maxRho: number,
  result: AnalysisResult | null,
): boolean {
  if (!actionId.includes('+')) return true;
  const partRhos = actionId.split('+')
    .map((part) => result?.actions[part.trim()]?.max_rho)
    .filter((rho): rho is number => typeof rho === 'number');
  if (!partRhos.length) return true;
  return maxRho <= Math.min(...partRhos) - COMBINED_MIN_RHO_GAIN;
}

/** One starred action → the enriched record published to the game shell. */
export function buildChosenActionRecord(
  actionId: string,
  result: AnalysisResult | null,
  baselineMaxRho: number | null,
): ChosenActionRecord {
  const detail = result?.actions[actionId];
  const maxRho = detail?.max_rho ?? null;
  const after = detail?.lines_overloaded_after;
  const solved = maxRho != null && maxRho < 1.0 && (!after || after.length === 0);
  const { actionType, levers } = buildActionLevers(
    actionId, detail, scoreTypeFor(result, actionId));
  // Effective = the action improves on the bare N-1 state (or outright
  // solves it), AND — for a combined action — outperforms its parts.
  const improves = solved
    || (maxRho != null && baselineMaxRho != null && maxRho < baselineMaxRho);
  const effective = maxRho != null && improves
    && combinedBeatsUnderlying(actionId, maxRho, result);
  return {
    actionId,
    description: detail?.description_unitaire,
    actionType,
    levers,
    maxRho,
    linesOverloadedAfter: after,
    solved,
    effective,
  };
}

/** Wire payload of POST /api/game/log-solution for one committed study. */
export function buildSolutionLogRequest(
  config: GameSessionConfig,
  study: GameStudy,
  studyResult: GameStudyResult,
): LogGameSolutionRequest {
  return {
    player: config.player ?? null,
    session_name: config.sessionName,
    study_id: studyResult.studyId,
    study_label: studyResult.label,
    network_path: study.networkPath,
    contingency_id: study.contingencyElementId,
    solved: studyResult.solved,
    final_max_rho: studyResult.finalMaxRho,
    baseline_max_rho: studyResult.baselineMaxRho,
    actions: studyResult.actionsChosen.map((a) => ({
      action_id: a.actionId,
      description: a.description ?? null,
      action_type: a.actionType ?? null,
      levers: a.levers ?? [],
      effective: a.effective ?? true,
    })),
  };
}

/** Backend response → the camelCase feedback attached to the study result. */
export function toStudyFeedback(
  studyId: string,
  response: LogGameSolutionResponse,
): StudySolutionFeedback {
  return {
    studyId,
    novelty: {
      newProposition: response.novelty.new_proposition,
      newLevers: response.novelty.new_levers,
      effective: response.novelty.effective,
      bonusPoints: response.novelty.bonus_points,
    },
    frequencies: response.frequencies.map((f) => ({
      actionId: f.action_id,
      description: f.description ?? undefined,
      count: f.count,
      total: f.total,
      share: f.share,
    })),
  };
}

/**
 * Total novelty bonus of a session. Displayed ON TOP of the Codabench
 * score — the 60/25/15 formula in scoring.ts is twin-locked with
 * scoring_program/score.py and must not absorb it.
 */
export function sessionNoveltyBonus(studies: GameStudyResult[]): number {
  return studies.reduce(
    (sum, s) => sum + (s.solutionFeedback?.novelty.bonusPoints ?? 0), 0);
}

/**
 * Network element a lever hint should pre-fill the Inspect field with.
 * Injection / PST / switch levers already carry the element id as their
 * label; catalogue `action:disco_<branch>` / `action:reco_<branch>` ids
 * embed the branch id — strip the prefix so Inspect can locate the line.
 */
export function leverInspectTarget(lever: { signature: string; label: string }): string {
  if (lever.signature.startsWith('action:')) {
    const actionId = lever.signature.slice('action:'.length);
    const branch = actionId.match(/^(?:disco|reco)_(.+)$/);
    return branch ? branch[1] : actionId;
  }
  return lever.label;
}

/**
 * Injection lever prefix → the backend dynamic-action id prefix it maps to.
 * The backend auto-creates these on the fly (`_create_dynamic_actions_if_needed`)
 * and, when simulated with no `target_mw`, applies the DEFAULT incremental
 * injection delta (`REDISPATCH_DEFAULT_DELTA_MW` for redispatch, the full-reduction
 * default for shedding / curtailment). So a magnitude-free lever can be
 * simulated straight from a double-click without the operator entering an amount.
 * PST (`pst:`) and the raw `gen_p:` / `load_p:` levers stay magnitude-free
 * (a tap variation / signed setpoint is needed), so they still degrade to inspect.
 */
const INJECTION_LEVER_ACTION_PREFIX: Record<string, string> = {
  redispatch: 'redispatch_',
  ls: 'load_shedding_',
  rc: 'curtail_',
};

/**
 * Backend dynamic-action id an injection lever maps to (or `null` for a lever
 * that can't be simulated without a magnitude). Exported so the hints panel can
 * tell whether a lever's action already sits in the workspace's simulated set.
 */
export function injectionLeverActionId(signature: string): string | null {
  const colon = signature.indexOf(':');
  if (colon <= 0) return null;
  const prefix = INJECTION_LEVER_ACTION_PREFIX[signature.slice(0, colon)];
  const body = signature.slice(colon + 1);
  return prefix && body ? `${prefix}${body}` : null;
}

/**
 * Translate a lever hint into a workspace interaction the App handler can act
 * on without knowing lever-signature semantics:
 *   - `inspectQuery` locates the element (branch id, injection / switch name);
 *   - `simulate` is present when the lever maps to a fully-specified action —
 *     a catalogue branch disco/reco (`action:<id>`), a coupling maneuver
 *     (`switch:<id>=<state>`), or an injection (`redispatch:` / `ls:` / `rc:`)
 *     re-run with the default incremental delta. Magnitude-free PST / raw
 *     `gen_p:` / `load_p:` levers carry no `simulate`, so a double-click on
 *     them degrades to inspect.
 */
export function buildLeverInteraction(lever: GameLeverStatWire): LeverInteraction {
  const interaction: LeverInteraction = {
    inspectQuery: leverInspectTarget(lever),
    category: lever.category,
  };
  const { signature } = lever;
  if (signature.startsWith('action:')) {
    interaction.simulate = { actionId: signature.slice('action:'.length) };
  } else if (signature.startsWith('switch:')) {
    const body = signature.slice('switch:'.length);
    const eq = body.lastIndexOf('=');
    const switchId = eq >= 0 ? body.slice(0, eq) : body;
    const targetOpen = eq >= 0 ? body.slice(eq + 1) === 'true' : true;
    interaction.simulate = { switches: { [switchId]: targetOpen } };
  } else {
    const actionId = injectionLeverActionId(signature);
    if (actionId) interaction.simulate = { actionId };
  }
  return interaction;
}
