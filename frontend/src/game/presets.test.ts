// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DIFFICULTY_TIERS,
  DEFAULT_DIFFICULTY,
  DEFAULT_SESSION_STUDIES,
  difficultyTier,
} from './presets';

const situationOf = (s: { networkPath: string }) =>
  s.networkPath.split('/situations/')[1]?.split('/')[0];

describe('game difficulty presets', () => {
  it('defaults to Medium = the European grid', () => {
    expect(DEFAULT_DIFFICULTY).toBe('medium');
    const tier = difficultyTier(DEFAULT_DIFFICULTY);
    expect(tier.networkPath).toContain('pypsa_eur_eur220_225_380_400');
    expect(DEFAULT_SESSION_STUDIES).toBe(tier.studies);
  });

  it('France 2025 gives 20 minutes per study, the other sets 5', () => {
    expect(difficultyTier('france-2025').timerSeconds).toBe(20 * 60);
    expect(difficultyTier('medium').timerSeconds).toBe(5 * 60);
    expect(difficultyTier('high').timerSeconds).toBe(5 * 60);
  });

  it('France 2025 opens on the July starter, then the January peak by region', () => {
    const france = difficultyTier('france-2025');
    expect(france.networkPath).toContain('pypsa_eur_fr225_400/situations/');
    const ids = france.studies.map((s) => s.contingencyElementId);
    expect(ids).toEqual([
      // Starter: Les Attaques – Mandarins n°2.
      'relation_5674508-400',
      // Marseille: Réaltor – Tavel n°1, Ponteau – Réaltor, Réaltor – Septèmes n°1.
      'relation_5989317-400', 'merged_way_214858102-400_4', 'relation_9509532_b-225',
      // Paris: Coubert – Moisenay, Courtry – Plison n°1, Mézerolles – Yvelines-Ouest n°1.
      'relation_9176297-225', 'way_118340005-225', 'relation_6554458_a-400',
      // Lyon: Échalas – Le Soleil n°2.
      'way_130228930-225',
    ]);
    expect(france.studies.map(situationOf)).toEqual([
      '2025-07-01_1100Z_opf',
      ...Array(7).fill('2025-01-14_0800Z_opf'),
    ]);
  });

  it("Medium plays the README's three reference studies on the European grid", () => {
    const medium = difficultyTier('medium');
    // Pyrenees (LANNEL61PRAGN), Campania (Santa Sofia — Montecorvino), Hinojosa 400 kV.
    expect(medium.studies.map((s) => s.contingencyElementId)).toEqual([
      'relation_8423570-225',
      'relation_13164355-380',
      'way_170479605-400',
    ]);
    // The bundle's own situation, not one of its real-hour rebuilds.
    for (const s of medium.studies) {
      expect(s.networkPath).toBe('data/pypsa_eur_eur220_225_380_400/network.xiidm');
    }
  });

  it('High = the French fr225_400 grid', () => {
    const high = difficultyTier('high');
    expect(high.networkPath).toContain('pypsa_eur_fr225_400');
    expect(high.studies.length).toBeGreaterThanOrEqual(8);
  });

  it('every study carries a network, action file and contingency id', () => {
    const bundle = (path: string) => path.split('/').slice(0, 2).join('/');
    for (const tier of DIFFICULTY_TIERS) {
      for (const s of tier.studies) {
        expect(s.networkPath).toBeTruthy();
        expect(s.actionFilePath).toBeTruthy();
        expect(s.contingencyElementId).toBeTruthy();
        // Studies of a tier share that tier's grid bundle — its actions and
        // layout — each on one of the bundle's situations.
        expect(bundle(s.networkPath)).toBe(bundle(tier.networkPath));
        expect(s.actionFilePath).toBe(tier.actionFilePath);
        expect(s.layoutPath).toBe(tier.layoutPath);
      }
    }
  });
});

// QW24b: the presets hardcode contingency ids; this guards them against the
// data artifacts they reference, so a regenerated / renamed grid that drops a
// contingency fails HERE (a fast static check) instead of silently shipping an
// unplayable Game Mode study. Complements the real-backend `can_proceed` replay
// in scripts/game_mode/e2e_game_session.py.
describe('preset ↔ overload-data consistency', () => {
  interface OverloadData { contingencies: { tripped_line: string }[] }

  const readRepoJson = (repoPath: string): unknown =>
    JSON.parse(readFileSync(resolve(__dirname, '../../../', repoPath), 'utf-8'));

  const trippedLineSet = (networkPath: string): Set<string> => {
    const data = readRepoJson(
      networkPath.replace('network.xiidm', 'n1_overload_contingencies.json'),
    ) as OverloadData;
    return new Set(data.contingencies.map(c => c.tripped_line));
  };

  /** Every line of the study's grid bundle (`<bundle>/line_id_names.json`). */
  const bundleLineIds = (networkPath: string): Set<string> => {
    const bundle = networkPath.split('/').slice(0, 2).join('/');
    return new Set(Object.keys(readRepoJson(`${bundle}/line_id_names.json`) as object));
  };

  it.each(DIFFICULTY_TIERS)('every "$id" preset contingency exists in its network\'s overload data', (tier) => {
    for (const study of tier.studies) {
      // The N-1 tables list overloads past 100 %. A study loading its line
      // between the 95 % monitoring limit and 100 % is not in them: check it
      // still names a line of its grid.
      if ((study.baselineMaxLoadingPct ?? 100) < 100) {
        expect(study.baselineMaxLoadingPct).toBeGreaterThanOrEqual(95);
        expect(
          bundleLineIds(study.networkPath).has(study.contingencyElementId),
          `preset "${study.id}" contingency ${study.contingencyElementId} is not a line of its grid bundle`,
        ).toBe(true);
        continue;
      }
      expect(
        trippedLineSet(study.networkPath).has(study.contingencyElementId),
        `preset "${study.id}" contingency ${study.contingencyElementId} is not in ${study.networkPath}'s n1_overload_contingencies.json`,
      ).toBe(true);
    }
  });
});
