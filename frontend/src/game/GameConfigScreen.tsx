// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useState } from 'react';
import { colors, space, text, radius } from '../styles/tokens';
import {
  DEFAULT_SESSION_STUDIES,
  PRESET_STUDIES,
  PRESET_ACTION_PATH,
  PRESET_NETWORK_PATH,
  PRESET_LAYOUT_PATH,
} from './presets';
import type { GameSessionConfig, GameStudy } from './types';

interface GameConfigScreenProps {
  onStart: (config: GameSessionConfig) => void;
}

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
const btn = (bg: string, fg: string): React.CSSProperties => ({
  padding: `${space[1]} ${space[3]}`, borderRadius: radius.md, border: 'none',
  background: bg, color: fg, fontSize: text.sm, fontWeight: 600, cursor: 'pointer',
});

let customSeq = 0;

export default function GameConfigScreen({ onStart }: GameConfigScreenProps) {
  const [sessionName, setSessionName] = useState('Training session');
  const [player, setPlayer] = useState('');
  const [minutes, setMinutes] = useState(3);
  const [seconds, setSeconds] = useState(0);
  const [maxActions, setMaxActions] = useState(3);
  const [studies, setStudies] = useState<GameStudy[]>(DEFAULT_SESSION_STUDIES);
  const [presetToAdd, setPresetToAdd] = useState('');

  const timerSeconds = minutes * 60 + seconds;

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
    const p = PRESET_STUDIES.find((s) => s.id === presetToAdd);
    if (!p) return;
    // Clone with a fresh id so the same preset can appear twice.
    setStudies((prev) => [...prev, { ...p, id: `${p.id}-${customSeq++}` }]);
    setPresetToAdd('');
  };

  const addCustom = () => {
    setStudies((prev) => [...prev, {
      id: `custom-${customSeq++}`,
      label: 'Custom study',
      networkPath: PRESET_NETWORK_PATH,
      actionFilePath: PRESET_ACTION_PATH,
      layoutPath: PRESET_LAYOUT_PATH,
      contingencyElementId: '',
      contingencyLabel: '',
    }]);
  };

  const canStart = studies.length > 0 && timerSeconds >= 10 &&
    studies.every((s) => s.networkPath && s.actionFilePath && s.contingencyElementId);

  const start = () => {
    if (!canStart) return;
    onStart({
      sessionName: sessionName.trim() || 'session',
      player: player.trim() || undefined,
      timerSeconds,
      maxActions,
      studies,
    });
  };

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
          Configure a timed contingency-solving session. Each study gives you a
          contingency to remediate with at most <strong>{maxActions}</strong> action
          {maxActions === 1 ? '' : 's'} before the clock runs out.
        </p>

        {/* Session parameters */}
        <div style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: space[3] }}>
            <div>
              <label style={labelStyle}>Session name</label>
              <input style={inputStyle} value={sessionName}
                onChange={(e) => setSessionName(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Player (optional)</label>
              <input style={inputStyle} value={player}
                onChange={(e) => setPlayer(e.target.value)} placeholder="anonymous" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: space[4], marginTop: space[3], alignItems: 'flex-end' }}>
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
          </div>
        </div>

        {/* Studies */}
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[2] }}>
            <h2 style={{ margin: 0, fontSize: text.lg }}>Studies ({studies.length})</h2>
            <div style={{ display: 'flex', gap: space[2], alignItems: 'center' }}>
              <select value={presetToAdd} style={{ ...inputStyle, width: 260 }}
                onChange={(e) => setPresetToAdd(e.target.value)}>
                <option value="">Add preset contingency…</option>
                {PRESET_STUDIES.map((p) => (
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space[2] }}>
          <button
            style={{ ...btn(colors.brand, colors.textOnBrand), padding: `${space[2]} ${space[5]}`, fontSize: text.md, opacity: canStart ? 1 : 0.5, cursor: canStart ? 'pointer' : 'not-allowed' }}
            onClick={start} disabled={!canStart}>
            ▶ Start session
          </button>
        </div>
        {!canStart && (
          <p style={{ textAlign: 'right', color: colors.textTertiary, fontSize: text.xs, marginTop: space[1] }}>
            Need ≥1 study, a ≥10 s timer, and every study must have a network, action file and contingency id.
          </p>
        )}
      </div>
    </div>
  );
}
