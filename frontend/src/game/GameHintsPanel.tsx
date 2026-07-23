// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { colors, space, text, radius } from '../styles/tokens';
import type { GameLeverStatWire, LeverInteraction } from '../types';
import { gameBridge } from './gameBridge';
import { GAME_HUD_HEIGHT } from './GameHud';
import { buildLeverInteraction } from './solutionLog';
import type { GameStudy } from './types';

/** Single-click is deferred this long so a double-click can pre-empt it.
 *  Mirrors the VL-disk interactions' `VL_SINGLE_CLICK_DELAY_MS`. */
const LEVER_SINGLE_CLICK_DELAY_MS = 250;

/** Simulation state of one lever, driving the inline feedback + re-run block. */
type LeverSimStatus = 'idle' | 'simulating' | 'simulated';

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

  // Simulation feedback state. `inFlight` marks a lever whose simulation is
  // running (the "simulating…" chip + re-run block); `localDone` marks
  // coupling maneuvers whose fresh `user_topo_*` id the workspace snapshot
  // can't match back to a lever. Action-id levers (branch disco/reco +
  // injections) are marked "simulated" straight from `simulatedIds`, the set
  // of materialised action ids the App publishes on the game bridge — so a
  // lever also flips to "simulated" when its action arrives through the
  // recommender's suggestions, and a failed run self-clears (its id never
  // enters the set) leaving the lever runnable again.
  const [inFlight, setInFlight] = useState<Set<string>>(() => new Set());
  const [localDone, setLocalDone] = useState<Set<string>>(() => new Set());
  const [simulatedIds, setSimulatedIds] = useState<Set<string>>(
    () => new Set(gameBridge.getSnapshot().simulatedActionIds));
  useEffect(() => {
    setSimulatedIds(new Set(gameBridge.getSnapshot().simulatedActionIds));
    return gameBridge.subscribe((snap) => setSimulatedIds(new Set(snap.simulatedActionIds)));
  }, []);

  const leverStatus = useCallback((lever: GameLeverStatWire): LeverSimStatus => {
    const sig = lever.signature;
    if (inFlight.has(sig)) return 'simulating';
    if (localDone.has(sig)) return 'simulated';
    const actionId = buildLeverInteraction(lever).simulate?.actionId;
    if (actionId && simulatedIds.has(actionId)) return 'simulated';
    return 'idle';
  }, [inFlight, localDone, simulatedIds]);

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
      void gameBridge.requestLeverInteraction(buildLeverInteraction(lever), 'inspect');
    }, LEVER_SINGLE_CLICK_DELAY_MS);
  }, []);

  const handleLeverDoubleClick = useCallback(async (lever: GameLeverStatWire) => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    const interaction: LeverInteraction = buildLeverInteraction(lever);
    // Magnitude-free lever (PST / raw gen_p / load_p) → nothing to simulate;
    // let the handler degrade to inspect without any status tracking.
    if (!interaction.simulate) {
      void gameBridge.requestLeverInteraction(interaction, 'simulate');
      return;
    }
    // Already simulating or simulated → ignore, so a second double-click can't
    // fire a duplicate simulation of the same lever.
    if (leverStatus(lever) !== 'idle') return;
    const sig = lever.signature;
    setInFlight((prev) => new Set(prev).add(sig));
    try {
      await gameBridge.requestLeverInteraction(interaction, 'simulate');
      // Coupling maneuvers register under a fresh user_topo_<vl>_<ts> id the
      // snapshot can't map back to this lever, so record completion locally.
      // Action-id levers rely on `simulatedIds` (self-correcting on failure).
      if (!interaction.simulate.actionId) {
        setLocalDone((prev) => new Set(prev).add(sig));
      }
    } finally {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(sig);
        return next;
      });
    }
  }, [leverStatus]);

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
        {levers.map((lever) => {
          const status = leverStatus(lever);
          const done = status === 'simulated';
          const busy = status === 'simulating';
          return (
            <li key={lever.signature} style={{ marginBottom: space.half }}>
              <button
                onClick={() => handleLeverClick(lever)}
                onDoubleClick={() => handleLeverDoubleClick(lever)}
                title={done
                  ? `${lever.sample_description ?? lever.label} — already simulated; click to locate & inspect`
                  : `${lever.sample_description ?? lever.label} — click to locate & inspect, double-click to simulate`}
                data-testid={`game-lever-${lever.signature}`}
                style={{
                  border: 'none', background: 'transparent', padding: 0,
                  cursor: 'pointer', fontWeight: 600, fontSize: text.sm,
                  color: colors.infoText, textDecoration: 'underline',
                  textUnderlineOffset: 2, opacity: done ? 0.65 : 1,
                }}
              >
                {CATEGORY_ICONS[lever.category]} {lever.label}
              </button>
              <span style={{ color: colors.textTertiary, fontSize: text.xs }}>
                {' '}— {LEVER_CATEGORY_LABELS[lever.category]} · used {lever.count}×
              </span>
              {busy && (
                <span data-testid={`game-lever-status-${lever.signature}`}
                  style={{ color: colors.infoText, fontSize: text.xs, fontWeight: 600, marginLeft: space[1] }}>
                  ⏳ simulating…
                </span>
              )}
              {done && (
                <span data-testid={`game-lever-status-${lever.signature}`}
                  style={{ color: colors.successText, fontSize: text.xs, fontWeight: 600, marginLeft: space[1] }}>
                  ✓ simulated
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p style={{ margin: `${space[1]} 0 0`, fontSize: text.xs, color: colors.textTertiary }}>
        From {total} retained solution{total === 1 ? '' : 's'} by all players on this
        contingency. Click a lever to locate & inspect it; double-click to simulate it
        (once — a ✓ marks levers already simulated).
      </p>
    </div>
  );
}
