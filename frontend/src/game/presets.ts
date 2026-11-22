// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { GameStudy } from './types';

// ---------------------------------------------------------------------------
// Built-in study presets, grouped into three curated sets:
//
//  - **Medium** (default): the pan-European `pypsa_eur_eur220_225_380_400`
//    grid rebuilt on real 2025 hours (`situations/`, see
//    docs/data/pypsa-eur-osm-to-xiidm.md) — two studies per hour. Moderate
//    loadings (102–110 %), so they are clearable with a couple of actions.
//  - **France 2025**: the French `pypsa_eur_fr225_400` grid on the same
//    hours — a starter on the July midday, then seven harder cases on the
//    January peak (98–130 %), with 20 minutes per study.
//  - **High**: the French `pypsa_eur_fr225_400` grid — worst-case ~130 %
//    loadings that demand sharper remediation.
//
// Each contingency element id is a real disconnectable branch verified to
// produce an overload (sourced from its network's
// `n1_overload_contingencies.json`, or — between 95 and 100 % — from the
// backend's step 1). Paths are repo-root-relative, matching how the backend
// resolves `network_path` / `action_file_path`.
// ---------------------------------------------------------------------------

interface GridPaths {
  networkPath: string;
  actionFilePath: string;
  layoutPath: string;
}

function makeStudy(
  paths: GridPaths,
  id: string,
  contingencyElementId: string,
  contingencyLabel: string,
  region: string,
  baselineMaxLoadingPct: number,
  description?: string,
): GameStudy {
  return {
    id,
    label: `${region} — ${contingencyLabel}`,
    networkPath: paths.networkPath,
    actionFilePath: paths.actionFilePath,
    layoutPath: paths.layoutPath,
    contingencyElementId,
    contingencyLabel,
    baselineMaxLoadingPct,
    description: description
      ?? `Loss of ${contingencyLabel} (${region}) drives a worst-case ${baselineMaxLoadingPct}% line loading. Bring every monitored line back under the 95% monitoring limit using at most the allowed remedial actions.`,
  };
}

/** One real-hour rebuild of a bundle: its own network, the bundle's actions and layout. */
function situationPaths(bundle: string, situation: string): GridPaths {
  return {
    networkPath: `${bundle}/situations/${situation}/network.xiidm`,
    actionFilePath: `${bundle}/actions.json`,
    layoutPath: `${bundle}/grid_layout.json`,
  };
}

// --- France 2025: French grid on real 2025 hours -----------------------------
const FR_BUNDLE = 'data/pypsa_eur_fr225_400';
const FR_JAN = situationPaths(FR_BUNDLE, '2025-01-14_0800Z_opf');
const FR_JUL = situationPaths(FR_BUNDLE, '2025-07-01_1100Z_opf');

/**
 * A starter on 1 July 2025 13:00 (heatwave midday), then seven cases on
 * 14 January 2025 9:00 (France's consumption peak) around Marseille, Paris
 * and Lyon — both hours in their PyPSA optimal dispatch. The player ticks the
 * ones to play on the start screen. Every one is winnable below the 95 %
 * monitoring factor with the expert model's suggestions, checked against the
 * real backend: a single action clears each, except Ponteau – Réaltor and
 * Réaltor – Septèmes n°1, which take a pair. Réaltor – Tavel n°1 and
 * Coubert – Moisenay load their line between 95 and 100 % — past the
 * monitoring limit, under the thermal one.
 */
const FR_2025_STUDIES: GameStudy[] = [
  makeStudy(
    FR_JUL, 'fr25-jul-attaques-mandarins', 'relation_5674508-400', 'Les Attaques – Mandarins n°2',
    'Starter · Calais – Dunkirk 400 kV, 1 Jul 13:00', 105.2,
    'Your first case, on the heatwave midday: losing Les Attaques – Mandarins n°2 loads Mandarins – Warande to 105 %. Bring it back under 95 %.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-realtor-tavel', 'relation_5989317-400', 'Réaltor – Tavel n°1',
    'Marseille 400 kV, 14 Jan 9:00', 97.5,
    "France's 2025 consumption peak: losing Réaltor – Tavel n°1 loads Les Iscles – Roquerousse to 97.5 %, past the 95 % monitoring limit. Bring it back under 95 %.",
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-ponteau-realtor', 'merged_way_214858102-400_4', 'Ponteau – Réaltor',
    'Marseille 400 kV, 14 Jan 9:00', 106.4,
    'Same hour: losing Ponteau – Réaltor loads Lavéra – Septèmes to 106 %. One action gets close; under 95 % takes two.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-realtor-septemes', 'relation_9509532_b-225', 'Réaltor – Septèmes n°1',
    'Marseille 225 kV, 14 Jan 9:00', 130,
    'Same hour, the hardest case: losing Réaltor – Septèmes n°1 loads its twin, n°3, to 130 %. No single action is enough.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-coubert-moisenay', 'relation_9176297-225', 'Coubert – Moisenay',
    'Paris 225 kV, 14 Jan 9:00', 97.7,
    'Same hour, south-east of Paris: losing Coubert – Moisenay loads Liers – Les Loges to 97.7 %, past the 95 % monitoring limit. Bring it back under 95 %.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-courtry-plison', 'way_118340005-225', 'Courtry – Plison n°1',
    'Paris 225 kV, 14 Jan 9:00', 108.3,
    'Same hour, east of Paris: losing Courtry – Plison n°1 loads Courtry – Moisenay to 108 % and pushes Coubert – Moisenay past the 95 % monitoring limit.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-mezerolles-yvelines', 'relation_6554458_a-400', 'Mézerolles – Yvelines-Ouest n°1',
    'Paris 400 kV, 14 Jan 9:00', 102,
    'Same hour, west of Paris: losing Mézerolles – Yvelines-Ouest n°1 loads Élancourt – Yvelines-Ouest (225 kV) to 102 %.',
  ),
  makeStudy(
    FR_JAN, 'fr25-jan-echalas-soleil', 'way_130228930-225', 'Échalas – Le Soleil n°2',
    'Lyon 225 kV, 14 Jan 9:00', 107.2,
    'Same hour, south of Lyon: losing Échalas – Le Soleil n°2 loads Échalas – La Rivière to 107 %.',
  ),
];

// --- Medium: European grid on real 2025 hours --------------------------------
const EUR_BUNDLE = 'data/pypsa_eur_eur220_225_380_400';
const JAN_OPF = situationPaths(EUR_BUNDLE, '2025-01-14_0800Z_opf');
const JUL_OPF = situationPaths(EUR_BUNDLE, '2025-07-01_1100Z_opf');

/**
 * Two studies per real hour — 14 January 2025 9:00 (France's consumption
 * peak) and 1 July 2025 13:00 (heatwave midday), both in their PyPSA optimal
 * dispatch. Every one is remediable by the expert model (`can_proceed=True`,
 * a top action clears it) — verified end-to-end by
 * `scripts/game_mode/e2e_game_session.py --grid custom`.
 */
const EUR_STUDIES: GameStudy[] = [
  makeStudy(
    JAN_OPF, 'eu-jan-opf-2', 'way_130228930-225', 'Échalas – Le Soleil n°2',
    'Lyon south 225 kV, 14 Jan 9:00', 109.4,
    "France's 2025 consumption peak: losing Échalas – Le Soleil n°2 loads Échalas – La Rivière to 109 %. Bring it back under 95 %.",
  ),
  makeStudy(
    JAN_OPF, 'eu-jan-opf', 'way_192698906-400', 'Saint-Avold – Vigy',
    'Lorraine / Saarland 400 kV, 14 Jan 9:00', 107.7,
    'Same hour: losing Saint-Avold – Vigy pushes the Ensdorf (DE) – Saint-Avold (FR) tie line to 108 %.',
  ),
  makeStudy(
    JUL_OPF, 'eu-jul-opf-2', 'relation_5674507-400', 'Les Attaques – Warande',
    'Calais – Dunkirk 400 kV, 1 Jul 13:00', 110.2,
    'Heatwave midday — Penly at full power, the GB links exporting: losing Les Attaques – Warande pushes Mandarins – Warande to 110 %.',
  ),
  makeStudy(
    JUL_OPF, 'eu-jul-opf', 'relation_3710278_b-380', 'Meitingen – Oberbachern',
    'Bavaria 380 kV, 1 Jul 13:00', 102.2,
    'Same hour: losing Meitingen – Oberbachern loads Kochel – Murnau, south of Munich, to 102 %.',
  ),
];

// --- High: French grid (worst-case ~130 % loadings) ------------------------
const FR_PATHS: GridPaths = {
  networkPath: `${FR_BUNDLE}/network.xiidm`,
  actionFilePath: `${FR_BUNDLE}/actions.json`,
  layoutPath: `${FR_BUNDLE}/grid_layout.json`,
};

/**
 * 8-study tour of the fr225_400 grid at ~130 % loadings. Every entry is
 * winnable below the 95 % monitoring factor with the expert model's
 * suggestions, checked against the real backend: one action clears Génitoy –
 * Villevaudé, Liers – Villejust, Néoules – Rocbaron and Bayet – Volvic; the
 * other four take a pair.
 */
const FR_STUDIES: GameStudy[] = [
  makeStudy(FR_PATHS, 's9', 'relation_8417719_a-225', 'Portet-Saint-Simon – Tarascon', 'Toulouse 225 kV', 128.9),
  makeStudy(FR_PATHS, 's10', 'merged_way_1458387157-225_1', 'Néoules – Rocbaron', 'Toulon 225 kV', 130),
  makeStudy(FR_PATHS, 's11', 'relation_7013974-225', 'Bayet – Volvic', 'Clermont-Ferrand 225 kV', 128.2),
  makeStudy(FR_PATHS, 's4', 'relation_8307566_d-225', 'BREUIL63CHAST', 'Breuil 225 kV', 130),
  makeStudy(FR_PATHS, 's5', 'way_1463717755-225', 'Génitoy – Villevaudé', 'Paris east 225 kV', 130),
  makeStudy(FR_PATHS, 's12', 'relation_8384686_g-225', 'Belle-Épine – Domloup', 'Rennes 225 kV', 130),
  makeStudy(FR_PATHS, 's13', 'merged_relation_6757413_b-400_2', 'Le Cheylas – Grande Île', 'Grenoble 400 kV', 130),
  makeStudy(FR_PATHS, 's8', 'way_204035714-225', 'Liers - Villejust', 'Villejust 225 kV', 130),
];

// --- Difficulty tiers ------------------------------------------------------

export type Difficulty = 'france-2025' | 'medium' | 'high';

export interface DifficultyTier extends GridPaths {
  id: Difficulty;
  label: string;
  blurb: string;
  /** Per-study time limit (seconds) the config screen sets when the set is picked. */
  timerSeconds: number;
  studies: GameStudy[];
}

export const DIFFICULTY_TIERS: DifficultyTier[] = [
  {
    id: 'medium',
    label: 'Medium — European grid',
    blurb: 'Pan-European 220 / 225 / 380 / 400 kV on real 2025 hours, PyPSA optimal dispatch — 14 January 9:00 and 1 July 13:00 (102–110 % overloads).',
    ...JAN_OPF,
    timerSeconds: 5 * 60,
    studies: EUR_STUDIES,
  },
  {
    id: 'france-2025',
    label: 'France 2025 — starter to hard',
    blurb: 'PyPSA-EUR France 225 / 400 kV on real 2025 hours, PyPSA optimal dispatch — a 1 July 13:00 starter (105 %), then the 14 January 9:00 peak around Marseille, Paris and Lyon (98–130 %). 20 minutes per study.',
    ...FR_JAN,
    timerSeconds: 20 * 60,
    studies: FR_2025_STUDIES,
  },
  {
    id: 'high',
    label: 'High — French grid',
    blurb: 'PyPSA-EUR France 225 / 400 kV — worst-case ~130 % loadings, harder to clear.',
    ...FR_PATHS,
    timerSeconds: 5 * 60,
    studies: FR_STUDIES,
  },
];

export const DEFAULT_DIFFICULTY: Difficulty = 'medium';

export function difficultyTier(d: Difficulty): DifficultyTier {
  return DIFFICULTY_TIERS.find((t) => t.id === d) ?? DIFFICULTY_TIERS[0];
}

const DEFAULT_TIER = difficultyTier(DEFAULT_DIFFICULTY);

/** Default new-session content: every study of the default (medium) tier. */
export const DEFAULT_SESSION_STUDIES: GameStudy[] = DEFAULT_TIER.studies;

// Back-compat exports (custom-study defaults) — point at the default tier.
export const PRESET_STUDIES: GameStudy[] = DEFAULT_TIER.studies;
export const PRESET_NETWORK_PATH = DEFAULT_TIER.networkPath;
export const PRESET_ACTION_PATH = DEFAULT_TIER.actionFilePath;
export const PRESET_LAYOUT_PATH = DEFAULT_TIER.layoutPath;

// --- RTE7000 France THT mode ------------------------------------------------
// Difficulty-graded scenarios on reconstructed real French THT operating points
// (see docs/features/game-mode-rte7000-tht.md). Generated from
// data/rte7000_tht/scenarios.json by scripts/game_mode/gen_rte7000_presets.py.
export {
  RTE7000_TIERS,
  RTE7000_EASY,
  RTE7000_MEDIUM,
  RTE7000_HARD,
  sampleRte7000,
} from './rte7000Presets';
export type { Rte7000Difficulty, Rte7000Tier } from './rte7000Presets';

// --- RTE Matpower France EHV mode -------------------------------------------
// Difficulty-graded scenarios on the public MATPOWER RTE cases, rebuilt as
// NODE_BREAKER so topological levers exist (see
// docs/features/game-mode-matpower.md). Generated from
// data/rte_matpower/scenarios.json by
// scripts/game_mode/matpower/gen_matpower_presets.py.
export {
  MATPOWER_TIERS,
  MATPOWER_EASY,
  MATPOWER_MEDIUM,
  MATPOWER_HARD,
  sampleMatpower,
} from './matpowerPresets';
export type { MatpowerDifficulty, MatpowerTier } from './matpowerPresets';
