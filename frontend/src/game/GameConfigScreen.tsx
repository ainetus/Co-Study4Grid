// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { colors, space, text, radius } from '../styles/tokens';
import {
  DIFFICULTY_TIERS,
  DEFAULT_DIFFICULTY,
  difficultyTier,
  type Difficulty,
  RTE7000_TIERS,
  sampleRte7000,
  type Rte7000Difficulty,
  MATPOWER_TIERS,
  sampleMatpower,
} from './presets';
import type { GameSessionConfig, GameStudy } from './types';

interface GameConfigScreenProps {
  onStart: (config: GameSessionConfig) => void;
}

// Per-tier network map shown on the landing page (generated from each grid's
// grid_layout.json by scripts/game_mode/gen_network_previews.py). Served from
// public/ so it ships with the same-origin SPA on the HuggingFace Space.
// France 2025 plays the High tier's fr225_400 grid, so it shares its map.
const PREVIEW_SRC: Record<Difficulty, string> = {
  'france-2025': '/game/preview-high.svg',
  medium: '/game/preview-medium.svg',
  high: '/game/preview-high.svg',
};

// The difficulty-graded scenario families. Both are played the same way — pick
// a level, pick how many cases, the studies are sampled — so the screen carries
// ONE set of branches parameterised by family rather than one per family.
// `key` drives the data-testids (`game-mode-tht`, `game-tht-count`, …), which
// is why it must stay stable.
type GradedMode = 'tht' | 'matpower';
type GameMode = 'demo' | GradedMode;

interface GradedFamily {
  key: GradedMode;
  button: string;
  buttonBlurb: string;
  short: string;
  tiers: { id: Rte7000Difficulty; label: string; blurb: string; studies: GameStudy[] }[];
  sample: (d: Rte7000Difficulty, n: number, seed?: number) => GameStudy[];
  // Network map shown on the landing page, generated from each grid's
  // grid_layout.json by scripts/game_mode/gen_network_previews.py and served
  // from public/ so it ships with the same-origin SPA on the HuggingFace Space.
  preview: string;
  previewAlt: string;
  previewCaption: string;
  summaryTail: string;
  configHint: string;
}

const GRADED: Record<GradedMode, GradedFamily> = {
  tht: {
    key: 'tht',
    button: '🇫🇷 France THT — graded',
    buttonBlurb: 'Real reconstructed French THT snapshots, graded easy / medium / hard — pick a '
      + 'level and how many cases to play.',
    short: 'France THT',
    tiers: RTE7000_TIERS,
    sample: sampleRte7000,
    preview: '/game/preview-tht.svg',
    previewAlt: 'France THT (RTE7000) network map',
    previewCaption: 'The France THT network — the 400 kV backbone in red, 225 kV in green.',
    summaryTail: 'the reconstructed France THT grid snapshots',
    configHint: 'France THT: choose the difficulty level and number of cases above; '
      + 'studies are sampled automatically.',
  },
  matpower: {
    key: 'matpower',
    button: '⚡ France EHV (Matpower) — graded',
    buttonBlurb: 'The public MATPOWER RTE cases — real 2013 French EHV operating points, rebuilt '
      + 'with busbars and couplers so topological levers exist. Far more stressed than the THT set.',
    short: 'France EHV (Matpower)',
    tiers: MATPOWER_TIERS,
    sample: sampleMatpower,
    preview: '/game/preview-matpower.svg',
    previewAlt: 'France EHV (Matpower) network map',
    previewCaption: 'The MATPOWER RTE 400 kV backbone, positioned on France by electrical-distance '
      + 'match against a named THT snapshot.',
    summaryTail: 'the four MATPOWER RTE operating points',
    configHint: 'France EHV (Matpower): choose the difficulty level and number of cases above; '
      + 'studies are sampled automatically.',
  },
};

const card: React.CSSProperties = {
  background: colors.surfaceRaised, border: `1px solid ${colors.border}`,
  borderRadius: radius.lg, padding: space[4], marginBottom: space[3],
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: text.xs, fontWeight: 600,
  color: colors.textSecondary, marginBottom: space.half,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: `${space[1]} ${space[2]}`, boxSizing: 'border-box',
  border: `1px solid ${colors.border}`, borderRadius: radius.sm,
  background: colors.surface, color: colors.textPrimary, fontSize: text.sm,
};
const bigInputStyle: React.CSSProperties = {
  ...inputStyle, padding: `${space[2]} ${space[3]}`, fontSize: text.md,
};
const btn = (bg: string, fg: string): React.CSSProperties => ({
  padding: `${space[1]} ${space[3]}`, borderRadius: radius.md, border: 'none',
  background: bg, color: fg, fontSize: text.sm, fontWeight: 600, cursor: 'pointer',
});
const smallBtn: React.CSSProperties = {
  ...btn(colors.surfaceMuted, colors.textSecondary),
  border: `1px solid ${colors.border}`, padding: `0 ${space[2]}`, fontSize: text.xs,
};

let customSeq = 0;

/** Lower-cased trimmed key used to compare session names case-insensitively. */
const sessionKey = (name: string): string => name.trim().toLowerCase();

/**
 * First `<player> — session <n>` name (n ≥ 1) not already taken. Scanning the
 * concrete names — rather than count + 1 — fills gaps and never re-suggests an
 * existing name when the recorded indices are non-contiguous (e.g. sessions
 * {1, 3} → suggests 2, not a colliding 3).
 */
function firstFreeSessionName(player: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(sessionKey(`${player} — session ${n}`))) n += 1;
  return `${player} — session ${n}`;
}

export default function GameConfigScreen({ onStart }: GameConfigScreenProps) {
  const [player, setPlayer] = useState('');
  const [sessionName, setSessionName] = useState('');
  // True once the player types their own session name — stops the auto-default
  // effect from overwriting it. Mirrored in a ref so the debounced fetch
  // callback reads the current value (its closure would otherwise be stale).
  const [sessionNameEdited, setSessionNameEdited] = useState(false);
  const sessionNameEditedRef = useRef(sessionNameEdited);
  useEffect(() => { sessionNameEditedRef.current = sessionNameEdited; }, [sessionNameEdited]);
  // Session names this player already recorded in the shared base — the
  // auto-suggest picks the first free index over them and Start is blocked
  // when the entered name collides with one.
  const [existingSessions, setExistingSessions] = useState<string[]>([]);
  const takenSessions = useMemo(
    () => new Set(existingSessions.map(sessionKey)), [existingSessions]);

  const [maxActions, setMaxActions] = useState(3);
  const [assistance, setAssistance] = useState(true);
  const [difficulty, setDifficulty] = useState<Difficulty>(DEFAULT_DIFFICULTY);
  const tier = difficultyTier(difficulty);
  // Per-study time limit, seeded by the set (France 2025 gives 20 minutes).
  const [minutes, setMinutes] = useState(Math.floor(tier.timerSeconds / 60));
  const [seconds, setSeconds] = useState(tier.timerSeconds % 60);
  const [studies, setStudies] = useState<GameStudy[]>(tier.studies);
  // Studies the player unticked on the landing page: left out of the session
  // but kept in the list, so they can be ticked back. Keyed by study id.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const playStudies = studies.filter((s) => !skipped.has(s.id));
  const [presetToAdd, setPresetToAdd] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  // Top-level mode: the curated PyPSA-EUR sets (the European grid by default) vs one
  // of the difficulty-graded scenario databases (sampled by level). The curated
  // sets are the only mode a participant sees by default — France THT and
  // France EHV (Matpower) stay hidden behind this toggle inside Configure
  // settings so the landing page doesn't ask newcomers to choose a dataset
  // family they don't yet have context for.
  const [showModePicker, setShowModePicker] = useState(false);
  const [mode, setMode] = useState<GameMode>('demo');
  const [thtDifficulty, setThtDifficulty] = useState<Rte7000Difficulty>('easy');
  const [numCases, setNumCases] = useState(5);
  const graded = mode === 'demo' ? null : GRADED[mode];
  const gradedTier = graded
    ? (graded.tiers.find((t) => t.id === thtDifficulty) ?? graded.tiers[0])
    : null;
  const thtPoolSize = gradedTier?.studies.length ?? 0;
  const thtCases = Math.min(numCases, thtPoolSize);

  const timerSeconds = minutes * 60 + seconds;

  // Fetch the player's existing session names from the shared base, then seed
  // a default that skips every taken index (so a re-play never re-suggests a
  // name that already exists). The fetch runs on every player change — even
  // after the name is edited — because the names also drive the duplicate
  // block below; only the auto-fill is gated on `sessionNameEdited`. Debounced
  // so it doesn't fire per keystroke; falls back to "session 1" / no known
  // sessions when the backend is unreachable (standalone build / offline).
  useEffect(() => {
    const name = player.trim();
    if (!name) {
      setExistingSessions([]);
      if (!sessionNameEditedRef.current) setSessionName('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.getPlayerSessions(name)
        .then((r) => {
          if (cancelled) return;
          const names = r.session_names ?? [];
          setExistingSessions(names);
          if (!sessionNameEditedRef.current) {
            setSessionName(firstFreeSessionName(name, new Set(names.map(sessionKey))));
          }
        })
        .catch(() => {
          if (cancelled) return;
          setExistingSessions([]);
          if (!sessionNameEditedRef.current) setSessionName(`${name} — session 1`);
        });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [player, sessionNameEdited]);

  // Switching difficulty swaps the whole study list to the new grid's
  // reference set (paths differ, so a mixed list would not load).
  const changeDifficulty = (d: Difficulty) => {
    const next = difficultyTier(d);
    setDifficulty(d);
    setStudies(next.studies);
    setSkipped(new Set());
    setMinutes(Math.floor(next.timerSeconds / 60));
    setSeconds(next.timerSeconds % 60);
    setPresetToAdd('');
    setPreviewError(false);
  };

  const toggleStudy = (id: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const updateStudy = (i: number, patch: Partial<GameStudy>) =>
    setStudies((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const removeStudy = (i: number) =>
    setStudies((prev) => prev.filter((_, j) => j !== i));
  const moveStudy = (i: number, dir: -1 | 1) =>
    setStudies((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const addPreset = () => {
    const p = tier.studies.find((s) => s.id === presetToAdd);
    if (!p) return;
    // Clone with a fresh id so the same preset can appear twice.
    setStudies((prev) => [...prev, { ...p, id: `${p.id}-${customSeq++}` }]);
    setPresetToAdd('');
  };

  const addCustom = () => {
    setStudies((prev) => [...prev, {
      id: `custom-${customSeq++}`,
      label: 'Custom study',
      networkPath: tier.networkPath,
      actionFilePath: tier.actionFilePath,
      layoutPath: tier.layoutPath,
      contingencyElementId: '',
      contingencyLabel: '',
    }]);
  };

  const needPlayer = player.trim().length === 0;
  const studiesValid = graded
    ? numCases >= 1 && thtPoolSize > 0
    : playStudies.length > 0 &&
      playStudies.every((s) => s.networkPath && s.actionFilePath && s.contingencyElementId);
  const noneTicked = !graded && studies.length > 0 && playStudies.length === 0;
  const timerValid = timerSeconds >= 10;
  // A session name the player already recorded blocks Start — the shared
  // solution base keys retentions by session name, so a duplicate would
  // merge two runs. Only meaningful once a name is entered.
  const trimmedSession = sessionName.trim();
  const duplicateSession = trimmedSession.length > 0 && takenSessions.has(sessionKey(trimmedSession));
  const canStart = !needPlayer && studiesValid && timerValid && !duplicateSession;

  const start = () => {
    if (!canStart) return;
    // Graded family: draw `numCases` scenarios of the chosen level across the
    // available graded cases (round-robined over the distinct grid snapshots).
    // Curated set: the ticked studies, in list order.
    const finalStudies = graded
      ? graded.sample(thtDifficulty, numCases)
      : playStudies;
    if (finalStudies.length === 0) return;
    onStart({
      sessionName: sessionName.trim() || `${player.trim()} — session 1`,
      player: player.trim(),
      timerSeconds,
      maxActions,
      assistance,
      studies: finalStudies,
    });
  };

  const startHint = needPlayer
    ? 'Enter your player name to start.'
    : duplicateSession
      ? 'You already played a session with this name — pick another.'
      : noneTicked
        ? 'Tick at least one study to play.'
        : (!studiesValid || !timerValid)
          ? 'Some studies need attention — open ⚙ Configure settings below to fix them.'
          : '';

  return (
    <div style={{
      minHeight: '100vh', background: colors.surfaceMuted,
      padding: `${space[5]} ${space[4]}`, boxSizing: 'border-box',
      color: colors.textPrimary,
    }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: text.xxl, color: colors.brand }}>
          🎮 Co-Study4Grid — Game Mode
        </h1>
        <p style={{ color: colors.textSecondary, fontSize: text.sm, marginTop: space[1] }}>
          Solve a series of grid contingencies against the clock. Enter your
          name, untick any study you'd rather skip and press start — you can
          tune the timer, difficulty and studies under settings.
        </p>

        {/* Landing — the only things a participant needs to start. */}
        <div style={card}>
          <div>
            <label style={labelStyle} htmlFor="game-player">Player name</label>
            <input id="game-player" data-testid="game-player" style={bigInputStyle}
              value={player} placeholder="your player name"
              onChange={(e) => setPlayer(e.target.value)} autoFocus />
            <p style={{ color: colors.textTertiary, fontSize: text.xs, margin: `${space.half} 0 0` }}>
              Signs the solutions you retain in the shared solution base.
            </p>
          </div>

          {graded && (
            <div style={{ display: 'flex', gap: space[4], marginTop: space[3], alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={labelStyle}>Difficulty level</label>
                <select data-testid={`game-${graded.key}-difficulty`} style={inputStyle} value={thtDifficulty}
                  onChange={(e) => setThtDifficulty(e.target.value as Rte7000Difficulty)}>
                  {graded.tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id.charAt(0).toUpperCase() + t.id.slice(1)} ({t.studies.length} cases)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Number of cases</label>
                <input type="number" data-testid={`game-${graded.key}-count`} min={1} max={thtPoolSize} value={numCases}
                  style={{ ...inputStyle, width: 110 }}
                  onChange={(e) => setNumCases(Math.min(thtPoolSize, Math.max(1, Number(e.target.value))))} />
              </div>
            </div>
          )}

          <div style={{ marginTop: space[3] }}>
            <label style={labelStyle} htmlFor="game-session-name">Session name</label>
            <input id="game-session-name" data-testid="game-session-name"
              style={{ ...inputStyle, borderColor: duplicateSession ? colors.dangerText : colors.border }}
              aria-invalid={duplicateSession}
              value={sessionName}
              placeholder={player.trim() ? '' : 'auto — set from your player name'}
              onChange={(e) => { setSessionName(e.target.value); setSessionNameEdited(true); }} />
            {duplicateSession && (
              <p data-testid="game-session-name-error"
                style={{ color: colors.dangerText, fontSize: text.xs, margin: `${space.half} 0 0` }}>
                You already played “{trimmedSession}” — pick another name.
              </p>
            )}
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', gap: space[1], marginTop: space[3],
            fontSize: text.sm, color: colors.textSecondary, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={assistance}
              onChange={(e) => setAssistance(e.target.checked)} />
            💡 Beginner assistance — show the levers most used by other players
            on each contingency
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: space[3], marginTop: space[4] }}>
            <button data-testid="game-start"
              style={{
                ...btn(colors.brand, colors.textOnBrand),
                padding: `${space[2]} ${space[5]}`, fontSize: text.md,
                opacity: canStart ? 1 : 0.5, cursor: canStart ? 'pointer' : 'not-allowed',
              }}
              onClick={start} disabled={!canStart}>
              ▶ Start session
            </button>
            {startHint && (
              <span style={{ color: colors.textTertiary, fontSize: text.xs }}>{startHint}</span>
            )}
          </div>
        </div>

        {/* Session preview — the configured studies + the network map. */}
        <div style={card} data-testid="game-session-preview">
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'baseline', marginBottom: space[2], gap: space[2],
          }}>
            <h2 style={{ margin: 0, fontSize: text.lg }}>
              This session — {graded
                ? `${thtCases} case${thtCases === 1 ? '' : 's'}`
                : playStudies.length < studies.length
                  ? `${playStudies.length} of ${studies.length} studies`
                  : `${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}`}
            </h2>
            <span style={{ fontSize: text.xs, color: colors.textTertiary }}>
              {graded ? `${graded.short} · ${thtDifficulty}` : tier.label}
            </span>
          </div>

          {graded ? (
            <>
              <p data-testid={`game-${graded.key}-summary`} style={{ color: colors.textSecondary, fontSize: text.sm }}>
                {thtCases} <strong>{thtDifficulty}</strong> case{thtCases === 1 ? '' : 's'} will be
                drawn at random from the {thtPoolSize} available and played in sequence, spread across
                {' '}{graded.summaryTail}. Dates are hidden — each is titled by
                month, weekday and time-of-day only.
              </p>
              {!previewError && (
                <figure data-testid={`game-${graded.key}-preview`} style={{ margin: `${space[3]} 0 0` }}>
                  <div style={{
                    border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.md,
                    background: colors.surface, padding: space[2], overflow: 'hidden',
                  }}>
                    <img src={graded.preview} alt={graded.previewAlt}
                      loading="lazy" onError={() => setPreviewError(true)}
                      style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 320, objectFit: 'contain' }} />
                  </div>
                  <figcaption style={{ color: colors.textTertiary, fontSize: text.xs, marginTop: space[1] }}>
                    {graded.previewCaption}
                  </figcaption>
                </figure>
              )}
            </>
          ) : (
            <>
              {studies.length === 0 ? (
                <p style={{ color: colors.textTertiary, fontSize: text.sm }}>
                  No studies yet — add some under ⚙ Configure settings below.
                </p>
              ) : (
                <>
                  {/* Played in list order; an unticked study is skipped. */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: space[2],
                    marginBottom: space[1], fontSize: text.xs, color: colors.textTertiary,
                  }}>
                    <span style={{ flex: 1 }}>Untick a study to leave it out of this session.</span>
                    <button data-testid="game-studies-all" style={smallBtn}
                      onClick={() => setSkipped(new Set())}>
                      All
                    </button>
                    <button data-testid="game-studies-none" style={smallBtn}
                      onClick={() => setSkipped(new Set(studies.map((s) => s.id)))}>
                      None
                    </button>
                  </div>
                  <ul data-testid="game-studies-summary" style={{
                    margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: space.half,
                  }}>
                    {studies.map((s) => {
                      const picked = !skipped.has(s.id);
                      const element = s.contingencyLabel || s.contingencyElementId;
                      return (
                        <li key={s.id} style={{ fontSize: text.sm }}>
                          <label style={{
                            display: 'flex', alignItems: 'baseline', gap: space[1],
                            cursor: 'pointer', opacity: picked ? 1 : 0.55,
                          }}>
                            <input type="checkbox" data-testid={`game-study-pick-${s.id}`}
                              checked={picked} onChange={() => toggleStudy(s.id)} />
                            <span>
                              <span style={{ fontWeight: 600 }}>{s.label}</span>
                              {element && !s.label.includes(element) && (
                                <span style={{ color: colors.textTertiary }}>{' · '}{element}</span>
                              )}
                              {s.baselineMaxLoadingPct != null && (
                                <span style={{ color: colors.textTertiary }}>
                                  {' · '}worst line {s.baselineMaxLoadingPct} %
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {!previewError && (
                <figure data-testid="game-network-preview" style={{ margin: `${space[3]} 0 0` }}>
                  <div style={{
                    border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.md,
                    background: colors.surface, padding: space[2], overflow: 'hidden',
                  }}>
                    <img src={PREVIEW_SRC[difficulty]} alt={`${tier.label} network map`}
                      loading="lazy" onError={() => setPreviewError(true)}
                      style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 320, objectFit: 'contain' }} />
                  </div>
                  <figcaption style={{ color: colors.textTertiary, fontSize: text.xs, marginTop: space[1] }}>
                    The network you'll work on — the ≥350 kV backbone in red, lower voltages in green.
                  </figcaption>
                </figure>
              )}
            </>
          )}
        </div>

        {/* Everything else lives behind the settings toggle. */}
        <button data-testid="game-settings-toggle"
          onClick={() => setShowSettings((v) => !v)}
          style={{
            ...btn(colors.surfaceRaised, colors.textSecondary),
            border: `1px solid ${colors.border}`, width: '100%',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: `${space[2]} ${space[3]}`, marginBottom: space[3],
          }}>
          <span>⚙ Configure settings — timer, difficulty &amp; studies</span>
          <span aria-hidden>{showSettings ? '▲' : '▼'}</span>
        </button>

        {showSettings && (
          <>
            {/* Session parameters banner */}
            <div style={card}>
              <div style={{ display: 'flex', gap: space[4], alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label style={labelStyle}>Time limit per study</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[1] }}>
                    <input type="number" data-testid="game-timer-minutes" min={0} max={59} value={minutes} style={{ ...inputStyle, width: 64 }}
                      onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))} />
                    <span style={{ fontSize: text.sm, color: colors.textSecondary }}>min</span>
                    <input type="number" data-testid="game-timer-seconds" min={0} max={59} value={seconds} style={{ ...inputStyle, width: 64 }}
                      onChange={(e) => setSeconds(Math.min(59, Math.max(0, Number(e.target.value))))} />
                    <span style={{ fontSize: text.sm, color: colors.textSecondary }}>sec</span>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Max actions / study</label>
                  <input type="number" min={1} max={3} value={maxActions} style={{ ...inputStyle, width: 80 }}
                    onChange={(e) => setMaxActions(Math.min(3, Math.max(1, Number(e.target.value))))} />
                </div>
                <div>
                  <label style={labelStyle}>Mode</label>
                  <button data-testid="game-mode-picker-toggle"
                    style={{
                      ...btn(colors.surfaceMuted, colors.textSecondary),
                      border: `1px solid ${colors.border}`,
                    }}
                    onClick={() => setShowModePicker((v) => !v)}>
                    {showModePicker ? 'Hide other modes ▲' : '🌐 Other modes / regions ▼'}
                  </button>
                </div>
              </div>

              {/* Hidden by default — France THT and France EHV (Matpower)
                  are advanced/graded datasets a newcomer doesn't need to
                  see on first load. Revealed verbatim (same buttons +
                  blurbs) by the toggle above. */}
              {showModePicker && (
                <div style={{ marginTop: space[3] }}>
                  <label style={labelStyle}>Mode</label>
                  <div style={{ display: 'flex', gap: space[2] }}>
                    <button data-testid="game-mode-demo"
                      style={{
                        ...btn(mode === 'demo' ? colors.brand : colors.surfaceMuted,
                               mode === 'demo' ? colors.textOnBrand : colors.textSecondary),
                        flex: 1, padding: `${space[2]} ${space[3]}`, textAlign: 'left',
                      }}
                      onClick={() => setMode('demo')}>
                      🌍 PyPSA-EUR — curated sets
                      <div style={{ fontSize: text.xs, fontWeight: 400, marginTop: space.half, opacity: 0.85 }}>
                        France and Europe on real 2025 hours, and the French worst-case set.
                      </div>
                    </button>
                    {Object.values(GRADED).map((fam) => (
                      <button key={fam.key} data-testid={`game-mode-${fam.key}`}
                        style={{
                          ...btn(mode === fam.key ? colors.brand : colors.surfaceMuted,
                                 mode === fam.key ? colors.textOnBrand : colors.textSecondary),
                          flex: 1, padding: `${space[2]} ${space[3]}`, textAlign: 'left',
                        }}
                        onClick={() => setMode(fam.key)}>
                        {fam.button}
                        <div style={{ fontSize: text.xs, fontWeight: 400, marginTop: space.half, opacity: 0.85 }}>
                          {fam.buttonBlurb}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {showModePicker && mode === 'demo' && (
                <div style={{ marginTop: space[3], maxWidth: 320 }}>
                  <label style={labelStyle}>Difficulty (network)</label>
                  <select style={inputStyle} value={difficulty}
                    onChange={(e) => changeDifficulty(e.target.value as Difficulty)}>
                    {DIFFICULTY_TIERS.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <p style={{ color: colors.textTertiary, fontSize: text.xs, margin: `${space[2]} 0 0` }}>
                {graded ? graded.configHint : tier.blurb}
              </p>
            </div>

            {/* Studies editor — demo mode only (France THT samples studies). */}
            {mode === 'demo' && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[2] }}>
                <h2 style={{ margin: 0, fontSize: text.lg }}>Studies ({studies.length})</h2>
                <div style={{ display: 'flex', gap: space[2], alignItems: 'center' }}>
                  <select value={presetToAdd} style={{ ...inputStyle, width: 260 }}
                    onChange={(e) => setPresetToAdd(e.target.value)}>
                    <option value="">Add preset contingency…</option>
                    {tier.studies.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <button style={btn(colors.brandSoft, colors.brand)} onClick={addPreset}
                    disabled={!presetToAdd}>+ Preset</button>
                  <button style={btn(colors.surfaceMuted, colors.textSecondary)} onClick={addCustom}>
                    + Custom
                  </button>
                </div>
              </div>

              {studies.length === 0 && (
                <p style={{ color: colors.textTertiary, fontSize: text.sm }}>
                  No studies yet — add a preset contingency or a custom study.
                </p>
              )}

              {studies.map((s, i) => (
                <div key={s.id} style={{
                  border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.md,
                  padding: space[2], marginBottom: space[2], background: colors.surface,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: space[2], marginBottom: space[1] }}>
                    <span style={{
                      fontWeight: 700, color: colors.textOnBrand, background: colors.brand,
                      borderRadius: radius.sm, padding: `0 ${space[1]}`, fontSize: text.xs,
                    }}>{i + 1}</span>
                    <input style={{ ...inputStyle, fontWeight: 600 }} value={s.label}
                      onChange={(e) => updateStudy(i, { label: e.target.value })} />
                    <button style={btn(colors.surfaceMuted, colors.textSecondary)}
                      onClick={() => moveStudy(i, -1)} disabled={i === 0} title="Move up">↑</button>
                    <button style={btn(colors.surfaceMuted, colors.textSecondary)}
                      onClick={() => moveStudy(i, 1)} disabled={i === studies.length - 1} title="Move down">↓</button>
                    <button style={btn(colors.dangerSoft, colors.dangerText)}
                      onClick={() => removeStudy(i)} title="Remove">✕</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space[2] }}>
                    <div>
                      <label style={labelStyle}>Contingency element id</label>
                      <input style={inputStyle} value={s.contingencyElementId}
                        placeholder="e.g. relation_9259308_b-225"
                        onChange={(e) => updateStudy(i, { contingencyElementId: e.target.value })} />
                    </div>
                    <div>
                      <label style={labelStyle}>Network path</label>
                      <input style={inputStyle} value={s.networkPath}
                        onChange={(e) => updateStudy(i, { networkPath: e.target.value })} />
                    </div>
                    <div>
                      <label style={labelStyle}>Action file path</label>
                      <input style={inputStyle} value={s.actionFilePath}
                        onChange={(e) => updateStudy(i, { actionFilePath: e.target.value })} />
                    </div>
                    <div>
                      <label style={labelStyle}>Layout path (optional)</label>
                      <input style={inputStyle} value={s.layoutPath || ''}
                        onChange={(e) => updateStudy(i, { layoutPath: e.target.value })} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
