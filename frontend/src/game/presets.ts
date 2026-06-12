// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { GameStudy } from './types';

// ---------------------------------------------------------------------------
// Built-in study presets.
//
// Curated from `data/pypsa_eur_fr225_400/n1_overload_contingencies.json` —
// the README's reference PyPSA-EUR France 225/400 kV network. Each preset is
// a single N-1 contingency that produces a >100 % overload, so every study is
// guaranteed to be a real remediation problem the player must solve.
//
// Paths are repo-root-relative, matching how the backend (run via
// `python -m expert_backend.main`) resolves `network_path` / `action_file_path`.
// ---------------------------------------------------------------------------

export const PRESET_NETWORK_PATH = 'data/pypsa_eur_fr225_400/network.xiidm';
export const PRESET_ACTION_PATH = 'data/pypsa_eur_fr225_400/actions.json';
export const PRESET_LAYOUT_PATH = 'data/pypsa_eur_fr225_400/grid_layout.json';

function preset(
  id: string,
  contingencyElementId: string,
  contingencyLabel: string,
  region: string,
  baselineMaxLoadingPct: number,
): GameStudy {
  return {
    id,
    label: `${region} — ${contingencyLabel}`,
    networkPath: PRESET_NETWORK_PATH,
    actionFilePath: PRESET_ACTION_PATH,
    layoutPath: PRESET_LAYOUT_PATH,
    contingencyElementId,
    contingencyLabel,
    baselineMaxLoadingPct,
    description: `Loss of ${contingencyLabel} (${region}) drives a worst-case ${baselineMaxLoadingPct}% line loading. Bring every monitored line back under 100% using at most the allowed remedial actions.`,
  };
}

/**
 * Reference 8-study tour of the fr225_400 grid (ordered easy → busy).
 *
 * Every entry is a contingency the expert model can actually remediate
 * (`can_proceed=True`) — verified end-to-end by
 * `scripts/game_mode/e2e_game_session.py`. Unsolvable "grid breaks apart"
 * contingencies are deliberately excluded so the game stays winnable.
 */
export const PRESET_STUDIES: GameStudy[] = [
  preset('s1', 'way_109818602-225', 'Saint-Orens - Verfeil', 'Toulouse 225 kV', 130),
  preset('s2', 'way_121500507-225', 'way/121500507', 'Biancon 225 kV', 130),
  preset('s3', 'relation_6028666_c-225', 'B.MONL61VALE8', 'Valence 225 kV', 130),
  preset('s4', 'relation_8307566_d-225', 'BREUIL63CHAST', 'Breuil 225 kV', 130),
  preset('s5', 'way_1463717755-225', 'way/1463717755', 'way/1463717755 225 kV', 130),
  preset('s6', 'way_130969307-225', 'Échalas - Le Soleil', 'Échalas 225 kV', 130),
  preset('s7', 'merged_way_100497456-400_1', 'Cornier - Génissiat', 'Génissiat 400 kV', 123.2),
  preset('s8', 'way_204035714-225', 'Liers - Villejust', 'Villejust 225 kV', 130),
];

/** A short 3-study warm-up used as the default new-session content. */
export const DEFAULT_SESSION_STUDIES: GameStudy[] = PRESET_STUDIES.slice(0, 3);
