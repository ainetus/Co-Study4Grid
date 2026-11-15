// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { GameStudy } from './types';

// ---------------------------------------------------------------------------
// Built-in study presets, grouped into two difficulty tiers:
//
//  - **Medium** (default): the pan-European `pypsa_eur_eur220_225_380_400`
//    grid rebuilt on real 2025 hours (`situations/`, see
//    docs/data/pypsa-eur-osm-to-xiidm.md) — one study per situation.
//    Moderate loadings (101–109 %), so they are clearable with a couple of
//    actions.
//  - **High**: the French `pypsa_eur_fr225_400` grid — worst-case ~130 %
//    loadings that demand sharper remediation.
//
// Each contingency element id is a real disconnectable branch verified to
// produce an overload (sourced from its network's
// `n1_overload_contingencies.json`). Paths are repo-root-relative, matching
// how the backend resolves `network_path` / `action_file_path`.
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
      ?? `Loss of ${contingencyLabel} (${region}) drives a worst-case ${baselineMaxLoadingPct}% line loading. Bring every monitored line back under 100% using at most the allowed remedial actions.`,
  };
}

// --- Medium: European grid on real 2025 hours --------------------------------
const EUR_BUNDLE = 'data/pypsa_eur_eur220_225_380_400';

/** One real-hour rebuild of the bundle: its own network, the bundle's actions and layout. */
function eurSituation(situation: string): GridPaths {
  return {
    networkPath: `${EUR_BUNDLE}/situations/${situation}/network.xiidm`,
    actionFilePath: `${EUR_BUNDLE}/actions.json`,
    layoutPath: `${EUR_BUNDLE}/grid_layout.json`,
  };
}

const JAN_OBSERVED = eurSituation('2025-01-14_0800Z_observed');
const JAN_OPF = eurSituation('2025-01-14_0800Z_opf');
const JUL_OBSERVED = eurSituation('2025-07-01_1100Z_observed');
const JUL_OPF = eurSituation('2025-07-01_1100Z_opf');

/**
 * One study per real hour — 14 January 2025 9:00 (France's consumption peak)
 * and 1 July 2025 13:00 (heatwave midday), each with its observed and its
 * PyPSA optimal dispatch. Every one is remediable by the expert model
 * (`can_proceed=True`, a top action clears it) — verified end-to-end by
 * `scripts/game_mode/e2e_game_session.py --grid custom`.
 */
const EUR_STUDIES: GameStudy[] = [
  makeStudy(
    JAN_OBSERVED, 'eu-jan-observed', 'relation_6630114-225', 'Carrières – Terrier n°2',
    'France 225 kV, 14 Jan 9:00 (observed)', 101.1,
    "France's 2025 consumption peak, as dispatched: losing Carrières – Terrier n°2 loads its twin n°1 to 101 %. Bring it back under 100 %.",
  ),
  makeStudy(
    JAN_OPF, 'eu-jan-opf', 'relation_13676255-400', 'Divača – Redipuglia',
    'Slovenia / Italy 400 kV, 14 Jan 9:00 (optimal dispatch)', 104.4,
    'Same hour, PyPSA optimal dispatch: losing Divača – Redipuglia loads the neighbouring Padriciano – Divača line to 104 %.',
  ),
  makeStudy(
    JUL_OBSERVED, 'eu-jul-observed', 'relation_5674507-400', 'Les Attaques – Warande',
    'Calais – Dunkirk 400 kV, 1 Jul 13:00 (observed)', 109.0,
    'Heatwave midday, as dispatched: losing Les Attaques – Warande pushes Mandarins – Warande to 109 %. Few of the suggested actions clear it.',
  ),
  makeStudy(
    JUL_OPF, 'eu-jul-opf', 'relation_1637163-380', 'Diele – Meeden (zwart)',
    'Germany / Netherlands 380 kV, 1 Jul 13:00 (optimal dispatch)', 102.1,
    'Same hour, PyPSA optimal dispatch: one of the two Diele – Meeden circuits trips and the other climbs to 102 %. Re-balance the border.',
  ),
];

// --- High: French grid (worst-case ~130 % loadings) ------------------------
const FR_PATHS: GridPaths = {
  networkPath: 'data/pypsa_eur_fr225_400/network.xiidm',
  actionFilePath: 'data/pypsa_eur_fr225_400/actions.json',
  layoutPath: 'data/pypsa_eur_fr225_400/grid_layout.json',
};

/**
 * 8-study tour of the fr225_400 grid. Every entry is a contingency the expert
 * model can remediate (`can_proceed=True`) — verified end-to-end by
 * `scripts/game_mode/e2e_game_session.py`.
 */
const FR_STUDIES: GameStudy[] = [
  makeStudy(FR_PATHS, 's1', 'way_109818602-225', 'Saint-Orens - Verfeil', 'Toulouse 225 kV', 130),
  makeStudy(FR_PATHS, 's2', 'way_121500507-225', 'way/121500507', 'Biancon 225 kV', 130),
  makeStudy(FR_PATHS, 's3', 'relation_6028666_c-225', 'B.MONL61VALE8', 'Valence 225 kV', 130),
  makeStudy(FR_PATHS, 's4', 'relation_8307566_d-225', 'BREUIL63CHAST', 'Breuil 225 kV', 130),
  makeStudy(FR_PATHS, 's5', 'way_1463717755-225', 'way/1463717755', 'way/1463717755 225 kV', 130),
  makeStudy(FR_PATHS, 's6', 'way_130969307-225', 'Échalas - Le Soleil', 'Échalas 225 kV', 130),
  makeStudy(FR_PATHS, 's7', 'merged_way_100497456-400_1', 'Cornier - Génissiat', 'Génissiat 400 kV', 123.2),
  makeStudy(FR_PATHS, 's8', 'way_204035714-225', 'Liers - Villejust', 'Villejust 225 kV', 130),
];

// --- Difficulty tiers ------------------------------------------------------

export type Difficulty = 'medium' | 'high';

export interface DifficultyTier extends GridPaths {
  id: Difficulty;
  label: string;
  blurb: string;
  studies: GameStudy[];
}

export const DIFFICULTY_TIERS: DifficultyTier[] = [
  {
    id: 'medium',
    label: 'Medium — European grid',
    blurb: 'Pan-European 220 / 225 / 380 / 400 kV on real 2025 hours — 14 January 9:00 and 1 July 13:00, observed and optimal dispatch (101–109 % overloads).',
    ...JAN_OBSERVED,
    studies: EUR_STUDIES,
  },
  {
    id: 'high',
    label: 'High — French grid',
    blurb: 'PyPSA-EUR France 225 / 400 kV — worst-case ~130 % loadings, harder to clear.',
    ...FR_PATHS,
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
