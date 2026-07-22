// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RTE7000_TIERS,
  RTE7000_EASY,
  RTE7000_MEDIUM,
  RTE7000_HARD,
  sampleRte7000,
  type Rte7000Difficulty,
} from './rte7000Presets';
import type { GameStudy } from './types';

const REPO_ROOT = resolve(__dirname, '../../../');
const POOLS: Record<Rte7000Difficulty, GameStudy[]> = {
  easy: RTE7000_EASY, medium: RTE7000_MEDIUM, hard: RTE7000_HARD,
};

describe('RTE7000 France THT scenario data', () => {
  it('has three tiers wired to their pools', () => {
    expect(RTE7000_TIERS.map((t) => t.id)).toEqual(['easy', 'medium', 'hard']);
    expect(RTE7000_TIERS[0].studies).toBe(RTE7000_EASY);
    expect(RTE7000_TIERS[1].studies).toBe(RTE7000_MEDIUM);
    expect(RTE7000_TIERS[2].studies).toBe(RTE7000_HARD);
    for (const t of RTE7000_TIERS) expect(t.label).toBeTruthy();
  });

  it('matches the graded database snapshot (656 = 453 easy / 79 medium / 124 hard)', () => {
    expect(RTE7000_EASY.length).toBe(453);
    expect(RTE7000_MEDIUM.length).toBe(79);
    expect(RTE7000_HARD.length).toBe(124);
    const total = RTE7000_EASY.length + RTE7000_MEDIUM.length + RTE7000_HARD.length;
    expect(total).toBe(656);
  });

  it('every study is playable (network + actions + layout + contingency)', () => {
    for (const pool of Object.values(POOLS)) {
      for (const s of pool) {
        expect(s.id).toBeTruthy();
        expect(s.networkPath).toContain('data/rte7000_tht/grids/');
        expect(s.actionFilePath).toContain('actions.json');
        expect(s.layoutPath).toContain('grid_layout.json');
        expect(s.contingencyElementId).toBeTruthy();
        expect(typeof s.baselineMaxLoadingPct).toBe('number');
      }
    }
  });

  it('never leaks the reference solution or the exact date to the client', () => {
    const yearRe = /\b(19|20)\d\d\b/;
    for (const pool of Object.values(POOLS)) {
      for (const s of pool) {
        // `solution` is server-side only — it must not be embedded in a GameStudy.
        expect((s as Record<string, unknown>).solution).toBeUndefined();
        // Titles / labels hide the year (dates are month + weekday + period only).
        expect(s.label ?? '').not.toMatch(yearRe);
      }
    }
  });

  it('ids are unique across the whole database', () => {
    const ids = [...RTE7000_EASY, ...RTE7000_MEDIUM, ...RTE7000_HARD].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every referenced grid ships its transport + action + layout files', () => {
    const grids = new Set([...RTE7000_EASY, ...RTE7000_MEDIUM, ...RTE7000_HARD]
      .map((s) => s.networkPath));
    expect(grids.size).toBe(4);
    for (const net of grids) {
      // network.xiidm itself is git-ignored (decoded at build); the committed
      // transport is network.xiidm.gz.b64.
      expect(existsSync(resolve(REPO_ROOT, net.replace('network.xiidm', 'network.xiidm.gz.b64')))).toBe(true);
    }
    for (const s of [RTE7000_EASY[0], RTE7000_MEDIUM[0], RTE7000_HARD[0]]) {
      expect(existsSync(resolve(REPO_ROOT, s.actionFilePath))).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, s.layoutPath as string))).toBe(true);
    }
  });
});

describe('sampleRte7000', () => {
  it('draws exactly N of the requested difficulty', () => {
    const got = sampleRte7000('easy', 5, 1);
    expect(got).toHaveLength(5);
    const easyIds = new Set(RTE7000_EASY.map((s) => s.id));
    for (const s of got) expect(easyIds.has(s.id)).toBe(true);
  });

  it('is deterministic for a given seed and varies with the seed', () => {
    const a = sampleRte7000('medium', 6, 42).map((s) => s.id);
    const b = sampleRte7000('medium', 6, 42).map((s) => s.id);
    const c = sampleRte7000('medium', 6, 7).map((s) => s.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('caps at the pool size when N exceeds it', () => {
    const got = sampleRte7000('hard', 100000, 1);
    expect(got).toHaveLength(RTE7000_HARD.length);
  });

  it('returns an empty list for a non-positive N', () => {
    expect(sampleRte7000('easy', 0, 1)).toHaveLength(0);
  });

  it('spreads a small draw across the distinct grid snapshots', () => {
    // Each difficulty spans all 4 grids, so a 4-case draw should round-robin
    // over more than one grid rather than exhausting a single snapshot.
    const grids = new Set(sampleRte7000('easy', 4, 3).map((s) => s.networkPath));
    expect(grids.size).toBeGreaterThan(1);
  });

  it('never repeats a scenario within one draw', () => {
    const ids = sampleRte7000('easy', 20, 9).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
