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
} from './presets';
import type { GameSessionConfig, GameStudy } from './types';

interface GameConfigScreenProps {
  onStart: (config: GameSessionConfig) => void;
}

// Per-tier network map shown on the landing page (generated from each grid's
// grid_layout.json by scripts/game_mode/gen_network_previews.py). Served from
// public/ so it ships with the same-origin SPA on the HuggingFace Space.
const PREVIEW_SRC: Record<Difficulty, string> = {
  medium: '/game/preview-medium.svg',
  high: '/game/preview-high.svg',
};

// France THT map (the RTE7000 400/225 kV backbone). All four snapshots share
// the same topology, so one map represents every difficulty tier.
const RTE7000_PREVIEW_SRC = '/game/preview-tht.svg';

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
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [maxActions, setMaxActions] = useState(3);
  const [assistance, setAssistance] = useState(true);
  const [difficulty, setDifficulty] = useState<Difficulty>(DEFAULT_DIFFICULTY);
  const tier = difficultyTier(difficulty);
  const [studies, setStudies] = useState<GameStudy[]>(tier.studies);
  const [presetToAdd, setPresetToAdd] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  // Top-level mode: the European demo grid (curated reference studies) vs the
  // France THT difficulty-graded scenario database (sampled by level).
  const [mode, setMode] = useState<'demo' | 'tht'>('demo');
  const [thtDifficulty, setThtDifficulty] = useState<Rte7000Difficulty>('easy');
  const [numCases, setNumCases] = useState(5);
  const thtTier = RTE7000_TIERS.find((t) => t.id === thtDifficulty) ?? RTE7000_TIERS[0];
  const thtPoolSize = thtTier.studies.length;
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
    setDifficulty(d);
    setStudies(difficultyTier(d).studies);
    setPresetToAdd('');
    setPreviewError(false);
  };

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
  const studiesValid = mode === 'tht'
    ? numCases >= 1 && thtPoolSize > 0
    : studies.length > 0 &&
      studies.every((s) => s.networkPath && s.actionFilePath && s.contingencyElementId);
  const timerValid = timerSeconds >= 10;
  // A session name the player already recorded blocks Start — the shared
  // solution base keys retentions by session name, so a duplicate would
  // merge two runs. Only meaningful once a name is entered.
  const trimmedSession = sessionName.trim();
  const duplicateSession = trimmedSession.length > 0 && takenSessions.has(sessionKey(trimmedSession));
  const canStart = !needPlayer && studiesValid && timerValid && !duplicateSession;

  const start = () => {
    if (!canStart) return;
    // France THT: draw `numCases` scenarios of the chosen level across the
    // available graded cases (round-robined over the distinct grid snapshots).
    const finalStudies = mode === 'tht'
      ? sampleRte7000(thtDifficulty, numCases)
      : studies;
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
          name and press start — you can tune the timer, difficulty and studies
          under settings.
        </p>

        {/* Mode: European demo grid vs France THT graded scenarios. */}
        <div style={card}>
          <label style={labelStyle}>Mode</label>
          <div style={{ display: 'flex', gap: space[2] }}>
            <button data-testid="game-mode-demo"
              style={{
                ...btn(mode === 'demo' ? colors.brand : colors.surfaceMuted,
                       mode === 'demo' ? colors.textOnBrand : colors.textSecondary),
                flex: 1, padding: `${space[2]} ${space[3]}`, textAlign: 'left',
              }}
              onClick={() => setMode('demo')}>
              🌍 European grid — demo
              <div style={{ fontSize: text.xs, fontWeight: 400, marginTop: space.half, opacity: 0.85 }}>
                The pan-European reference studies (and the French worst-case set).
              </div>
            </button>
            <button data-testid="game-mode-tht"
              style={{
                ...btn(mode === 'tht' ? colors.brand : colors.surfaceMuted,
                       mode === 'tht' ? colors.textOnBrand : colors.textSecondary),
                flex: 1, padding: `${space[2]} ${space[3]}`, textAlign: 'left',
              }}
              onClick={() => setMode('tht')}>
              🇫🇷 France THT — graded
              <div style={{ fontSize: text.xs, fontWeight: 400, marginTop: space.half, opacity: 0.85 }}>
                Real reconstructed French THT snapshots, graded easy / medium / hard — pick a
                level and how many cases to play.
              </div>
            </button>
          </div>
        </div>

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

          {mode === 'tht' && (
            <div style={{ display: 'flex', gap: space[4], marginTop: space[3], alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={labelStyle}>Difficulty level</label>
                <select data-testid="game-tht-difficulty" style={inputStyle} value={thtDifficulty}
                  onChange={(e) => setThtDifficulty(e.target.value as Rte7000Difficulty)}>
                  {RTE7000_TIERS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id.charAt(0).toUpperCase() + t.id.slice(1)} ({t.studies.length} cases)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Number of cases</label>
                <input type="number" data-testid="game-tht-count" min={1} max={thtPoolSize} value={numCases}
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
              This session — {mode === 'tht'
                ? `${thtCases} case${thtCases === 1 ? '' : 's'}`
                : `${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}`}
            </h2>
            <span style={{ fontSize: text.xs, color: colors.textTertiary }}>
              {mode === 'tht' ? `France THT · ${thtDifficulty}` : tier.label}
            </span>
          </div>

          {mode === 'tht' ? (
            <>
              <p data-testid="game-tht-summary" style={{ color: colors.textSecondary, fontSize: text.sm }}>
                {thtCases} <strong>{thtDifficulty}</strong> case{thtCases === 1 ? '' : 's'} will be
                drawn at random from the {thtPoolSize} available and played in sequence, spread across
                the reconstructed France THT grid snapshots. Dates are hidden — each is titled by
                month, weekday and time-of-day only.
              </p>
              {!previewError && (
                <figure data-testid="game-tht-preview" style={{ margin: `${space[3]} 0 0` }}>
                  <div style={{
                    border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.md,
                    background: colors.surface, padding: space[2], overflow: 'hidden',
                  }}>
                    <img src={RTE7000_PREVIEW_SRC} alt="France THT (RTE7000) network map"
                      loading="lazy" onError={() => setPreviewError(true)}
                      style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 320, objectFit: 'contain' }} />
                  </div>
                  <figcaption style={{ color: colors.textTertiary, fontSize: text.xs, marginTop: space[1] }}>
                    The France THT network — the 400 kV backbone in red, 225 kV in green.
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
                <ol data-testid="game-studies-summary" style={{
                  margin: 0, paddingLeft: space[4], display: 'grid', gap: space.half,
                }}>
                  {studies.map((s) => (
                    <li key={s.id} style={{ fontSize: text.sm }}>
                      <span style={{ fontWeight: 600 }}>{s.label}</span>
                      {(s.contingencyLabel || s.contingencyElementId) && (
                        <span style={{ color: colors.textTertiary }}>
                          {' · '}{s.contingencyLabel || s.contingencyElementId}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
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
                    <input type="number" min={0} max={59} value={minutes} style={{ ...inputStyle, width: 64 }}
                      onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))} />
                    <span style={{ fontSize: text.sm, color: colors.textSecondary }}>min</span>
                    <input type="number" min={0} max={59} value={seconds} style={{ ...inputStyle, width: 64 }}
                      onChange={(e) => setSeconds(Math.min(59, Math.max(0, Number(e.target.value))))} />
                    <span style={{ fontSize: text.sm, color: colors.textSecondary }}>sec</span>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Max actions / study</label>
                  <input type="number" min={1} max={3} value={maxActions} style={{ ...inputStyle, width: 80 }}
                    onChange={(e) => setMaxActions(Math.min(3, Math.max(1, Number(e.target.value))))} />
                </div>
                {mode === 'demo' && (
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={labelStyle}>Difficulty (network)</label>
                    <select style={inputStyle} value={difficulty}
                      onChange={(e) => changeDifficulty(e.target.value as Difficulty)}>
                      {DIFFICULTY_TIERS.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <p style={{ color: colors.textTertiary, fontSize: text.xs, margin: `${space[2]} 0 0` }}>
                {mode === 'tht'
                  ? 'France THT: choose the difficulty level and number of cases above; studies are sampled automatically.'
                  : tier.blurb}
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
