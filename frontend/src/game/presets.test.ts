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

describe('game difficulty presets', () => {
  it('defaults to Medium = the European grid', () => {
    expect(DEFAULT_DIFFICULTY).toBe('medium');
    const tier = difficultyTier(DEFAULT_DIFFICULTY);
    expect(tier.networkPath).toContain('pypsa_eur_eur220_225_380_400');
    expect(DEFAULT_SESSION_STUDIES).toBe(tier.studies);
  });

  it('the default session plays two studies per real hour, in its optimal dispatch', () => {
    const ids = DEFAULT_SESSION_STUDIES.map((s) => s.contingencyElementId);
    // Échalas – Le Soleil, Saint-Avold – Vigy, Les Attaques – Warande, Meitingen – Oberbachern.
    expect(ids).toEqual([
      'way_130228930-225',
      'way_192698906-400',
      'relation_5674507-400',
      'relation_3710278_b-380',
    ]);
    const situations = DEFAULT_SESSION_STUDIES.map((s) => s.networkPath.split('/situations/')[1]?.split('/')[0]);
    expect(situations).toEqual([
      '2025-01-14_0800Z_opf',
      '2025-01-14_0800Z_opf',
      '2025-07-01_1100Z_opf',
      '2025-07-01_1100Z_opf',
    ]);
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

  const trippedLineSet = (networkPath: string): Set<string> => {
    const jsonPath = resolve(
      __dirname, '../../../',
      networkPath.replace('network.xiidm', 'n1_overload_contingencies.json'),
    );
    const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as OverloadData;
    return new Set(data.contingencies.map(c => c.tripped_line));
  };

  it.each(DIFFICULTY_TIERS)('every "$id" preset contingency exists in its network\'s overload data', (tier) => {
    for (const study of tier.studies) {
      expect(
        trippedLineSet(study.networkPath).has(study.contingencyElementId),
        `preset "${study.id}" contingency ${study.contingencyElementId} is not in ${study.networkPath}'s n1_overload_contingencies.json`,
      ).toBe(true);
    }
  });
});
