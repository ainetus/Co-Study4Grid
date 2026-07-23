// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { colors, space, text, radius } from '../styles/tokens';
import type { GameLeverStatWire } from '../types';
import { gameBridge } from './gameBridge';
import { GAME_HUD_HEIGHT } from './GameHud';
import { buildLeverInteraction } from './solutionLog';
import type { GameStudy } from './types';

/** Single-click is deferred this long so a double-click can pre-empt it.
 *  Mirrors the VL-disk interactions' `VL_SINGLE_CLICK_DELAY_MS`. */
const LEVER_SINGLE_CLICK_DELAY_MS = 250;

interface GameHintsPanelProps {
  study: GameStudy;
}

/** Display wording for each lever equipment category. */
const LEVER_CATEGORY_LABELS: Record<GameLeverStatWire['category'], string> = {
  voltage_level: 'Voltage level',
  branch: 'Branch',
  generation: 'Generation',
  load: 'Load',
  other: 'Other',
};

const CATEGORY_ICONS: Record<GameLeverStatWire['category'], string> = {
  voltage_level: '🔀',
  branch: '🔌',
  generation: '⚡',
  load: '🏠',
  other: '🔧',
};

/**
 * Beginner-assistance hints — the 5 levers most used across ALL players'
 * retained solutions on the current contingency (shared solution base),
 * each tagged with the equipment family it acts on. Collapsible so the
 * hint never covers the workspace; fetched once per study, best-effort
 * (no data / no backend → the panel stays hidden).
 */
export default function GameHintsPanel({ study }: GameHintsPanelProps) {
  const [levers, setLevers] = useState<GameLeverStatWire[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(true);

  // A single-click locates + inspects the lever; a double-click simulates it.
  // The single-click action is deferred so a double-click can pre-empt it —
  // otherwise the first click of a double-click would fire an inspect too.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
  }, []);

  const handleLeverClick = useCallback((lever: GameLeverStatWire) => {
    if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      gameBridge.requestLeverInteraction(buildLeverInteraction(lever), 'inspect');
    }, LEVER_SINGLE_CLICK_DELAY_MS);
  }, []);

  const handleLeverDoubleClick = useCallback((lever: GameLeverStatWire) => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    gameBridge.requestLeverInteraction(buildLeverInteraction(lever), 'simulate');
  }, []);

  // No synchronous state reset here: GameShell keys the panel by study id,
  // so each study mounts a fresh panel with empty initial state.
  useEffect(() => {
    let cancelled = false;
    if (!study.contingencyElementId) return;
    api.getGameLeverStats(study.networkPath, study.contingencyElementId)
      .then((stats) => {
        if (cancelled) return;
        setLevers(stats.levers);
        setTotal(stats.total_retentions);
      })
      .catch(() => {
        // Hints are best-effort: without a reachable base the panel hides.
      });
    return () => { cancelled = true; };
  }, [study.networkPath, study.contingencyElementId]);

  if (!levers.length) return null;

  const pill: React.CSSProperties = {
    position: 'fixed', top: GAME_HUD_HEIGHT + 8, right: space[3], zIndex: 9300,
    boxSizing: 'border-box',
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Show the community's most-used levers for this contingency"
        style={{
          ...pill, padding: `${space[1]} ${space[2]}`, borderRadius: radius.md,
          background: colors.infoSoft, border: `1px solid ${colors.infoBorder}`,
          color: colors.infoText, fontSize: text.sm, fontWeight: 600, cursor: 'pointer',
        }}
      >
        💡 Hints
      </button>
    );
  }

  return (
    <div
      role="complementary"
      aria-label="Beginner assistance — most-used levers"
      style={{
        ...pill, width: 320, maxWidth: '90vw', padding: space[2],
        borderRadius: radius.lg, background: colors.surfaceRaised,
        border: `1px solid ${colors.infoBorder}`, fontSize: text.sm,
        color: colors.textPrimary,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space[1], marginBottom: space[1] }}>
        <span style={{ fontWeight: 700, color: colors.infoText, flex: 1 }}>
          💡 Most-used levers here
        </span>
        <button
          onClick={() => setOpen(false)}
          title="Collapse hints"
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: colors.textTertiary, fontSize: text.sm, fontWeight: 700,
          }}
        >
          ✕
        </button>
      </div>
      <ol style={{ margin: 0, paddingLeft: space[4] }}>
        {levers.map((lever) => (
          <li key={lever.signature} style={{ marginBottom: space.half }}>
            <button
              onClick={() => handleLeverClick(lever)}
              onDoubleClick={() => handleLeverDoubleClick(lever)}
              title={`${lever.sample_description ?? lever.label} — click to locate & inspect, double-click to simulate`}
              style={{
                border: 'none', background: 'transparent', padding: 0,
                cursor: 'pointer', fontWeight: 600, fontSize: text.sm,
                color: colors.infoText, textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
            >
              {CATEGORY_ICONS[lever.category]} {lever.label}
            </button>
            <span style={{ color: colors.textTertiary, fontSize: text.xs }}>
              {' '}— {LEVER_CATEGORY_LABELS[lever.category]} · used {lever.count}×
            </span>
          </li>
        ))}
      </ol>
      <p style={{ margin: `${space[1]} 0 0`, fontSize: text.xs, color: colors.textTertiary }}>
        From {total} retained solution{total === 1 ? '' : 's'} by all players on this
        contingency. Click a lever to locate & inspect it; double-click to simulate it.
      </p>
    </div>
  );
}
