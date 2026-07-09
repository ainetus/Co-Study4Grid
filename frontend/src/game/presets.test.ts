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

  it('the default session is the three README reference studies', () => {
    const ids = DEFAULT_SESSION_STUDIES.map((s) => s.contingencyElementId);
    // France/Spain Pyrenees, Italy Campania (Brusciano-Nola), Spain Hinojosa.
    expect(ids).toEqual([
      'relation_8423570-225',
      'relation_13164355-380',
      'way_170479605-400',
    ]);
    expect(DEFAULT_SESSION_STUDIES).toHaveLength(3);
  });

  it('High = the French fr225_400 grid', () => {
    const high = difficultyTier('high');
    expect(high.networkPath).toContain('pypsa_eur_fr225_400');
    expect(high.studies.length).toBeGreaterThanOrEqual(8);
  });

  it('every study carries a network, action file and contingency id', () => {
    for (const tier of DIFFICULTY_TIERS) {
      for (const s of tier.studies) {
        expect(s.networkPath).toBeTruthy();
        expect(s.actionFilePath).toBeTruthy();
        expect(s.contingencyElementId).toBeTruthy();
        // Studies of a tier all share that tier's grid.
        expect(s.networkPath).toBe(tier.networkPath);
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

  it.each(DIFFICULTY_TIERS)('every "$id" preset contingency exists in the grid overload data', (tier) => {
    const trippedLines = trippedLineSet(tier.networkPath);
    for (const study of tier.studies) {
      expect(
        trippedLines.has(study.contingencyElementId),
        `preset "${study.id}" contingency ${study.contingencyElementId} is not in ${tier.networkPath}'s n1_overload_contingencies.json`,
      ).toBe(true);
    }
  });
});
