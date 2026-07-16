// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors, space, text, radius } from '../styles/tokens';
import { buildSessionCsv, downloadFile, slugifySession } from './gameLog';
import { scoreSession } from './scoring';
import { sessionNoveltyBonus } from './solutionLog';
import type { ActionUsageFrequency, GameSessionLog } from './types';

interface GameResultsProps {
  log: GameSessionLog;
  onReplay: () => void;
}

const btn = (bg: string, fg: string): React.CSSProperties => ({
  padding: `${space[2]} ${space[4]}`, borderRadius: radius.md, border: 'none',
  background: bg, color: fg, fontSize: text.sm, fontWeight: 600, cursor: 'pointer',
});

const th: React.CSSProperties = {
  textAlign: 'left', padding: space[2], fontSize: text.xs,
  color: colors.textSecondary, borderBottom: `2px solid ${colors.border}`,
};
const td: React.CSSProperties = {
  padding: space[2], fontSize: text.sm, borderBottom: `1px solid ${colors.borderSubtle}`,
};

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}

/** End-of-session wording for one retained action's past usage. */
function frequencyLabel(f: ActionUsageFrequency): string {
  if (f.total === 0) return 'first solution ever retained on this contingency';
  if (f.count === 0) return `never retained before (0 / ${f.total} prior retentions)`;
  return `retained in ${f.count} / ${f.total} prior retentions (${(f.share * 100).toFixed(0)}%)`;
}

export default function GameResults({ log, onReplay }: GameResultsProps) {
  const score = scoreSession(log);
  const slug = slugifySession(log.sessionName);
  const noveltyBonus = sessionNoveltyBonus(log.studies);
  const studiesWithFeedback = log.studies.filter(
    (s) => s.solutionFeedback && s.solutionFeedback.frequencies.length > 0);

  const exportJson = () =>
    downloadFile(`costudy4grid_game_${slug}.json`, JSON.stringify(log, null, 2), 'application/json');
  const exportCsv = () =>
    downloadFile(`costudy4grid_game_${slug}.csv`, buildSessionCsv(log), 'text/csv');

  return (
    <div style={{
      minHeight: '100vh', background: colors.surfaceMuted,
      padding: `${space[5]} ${space[4]}`, boxSizing: 'border-box', color: colors.textPrimary,
    }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: text.xxl, color: colors.brand }}>🏁 Session complete</h1>
        <p style={{ color: colors.textSecondary, fontSize: text.sm }}>
          {log.sessionName}{log.player ? ` · ${log.player}` : ''}
        </p>

        {/* Headline score */}
        <div style={{
          display: 'flex', gap: space[4], alignItems: 'center',
          background: colors.surfaceRaised, border: `1px solid ${colors.border}`,
          borderRadius: radius.lg, padding: space[4], marginBottom: space[3],
        }}>
          <div style={{ textAlign: 'center', minWidth: 140 }}>
            <div style={{ fontSize: 48, fontWeight: 800, color: colors.brand, lineHeight: 1 }}>
              {score.finalScore.toFixed(1)}
            </div>
            <div style={{ fontSize: text.xs, color: colors.textTertiary }}>/ 100 final score</div>
          </div>
          <div style={{ borderLeft: `1px solid ${colors.border}`, paddingLeft: space[4] }}>
            <div style={{ fontSize: text.sm }}>
              <strong>{score.solvedCount}</strong> / {score.nStudies} studies solved
            </div>
            {noveltyBonus > 0 && (
              <div style={{ fontSize: text.sm, color: colors.accentText, marginTop: space[1], fontWeight: 600 }}>
                🌟 +{noveltyBonus} novelty bonus pts — {score.finalScore.toFixed(1)} + {noveltyBonus} = {(score.finalScore + noveltyBonus).toFixed(1)} with bonus
              </div>
            )}
            <div style={{ fontSize: text.xs, color: colors.textTertiary, marginTop: space[1] }}>
              Score = mean of per-study scores (physical result 60% · action economy 25% · speed 15%).
              {noveltyBonus > 0 && ' The novelty bonus rewards solutions never retained before and is shown on top of the Codabench score.'}
            </div>
          </div>
        </div>

        {/* Per-study table */}
        <div style={{
          background: colors.surfaceRaised, border: `1px solid ${colors.border}`,
          borderRadius: radius.lg, padding: space[3], marginBottom: space[3], overflowX: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Study</th>
                <th style={th}>Result</th>
                <th style={th}>Baseline → Final</th>
                <th style={th}>Actions</th>
                <th style={th}>Time</th>
                <th style={th}>Score</th>
              </tr>
            </thead>
            <tbody>
              {log.studies.map((s, i) => {
                const sc = score.perStudy[i];
                return (
                  <tr key={s.studyId}>
                    <td style={td}>{i + 1}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{s.label}</div>
                      <div style={{ fontSize: text.xs, color: colors.textTertiary }}>
                        {s.contingencyLabel || s.contingencyElementId}
                      </div>
                    </td>
                    <td style={td}>
                      {s.solved
                        ? <span style={{ color: colors.successText }}>✓ solved</span>
                        : s.timedOut
                          ? <span style={{ color: colors.dangerText }}>⏱ timed out</span>
                          : <span style={{ color: colors.warningText }}>⚠ unsolved</span>}
                      {s.solutionFeedback?.novelty.newProposition && (
                        <span
                          title={s.solutionFeedback.novelty.newLevers.length
                            ? `New lever(s): ${s.solutionFeedback.novelty.newLevers.join(', ')}`
                            : 'New combination of known actions'}
                          style={{
                            marginLeft: space[1], padding: `0 ${space[1]}`,
                            borderRadius: radius.sm, background: colors.accentSoft,
                            border: `1px solid ${colors.accentBorder}`,
                            color: colors.accentText, fontSize: text.xs, fontWeight: 700,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          🌟 new +{s.solutionFeedback.novelty.bonusPoints}
                        </span>
                      )}
                    </td>
                    <td style={td}>{pct(s.baselineMaxRho)} → {pct(s.finalMaxRho)}</td>
                    <td style={td}>{s.numActions} / {s.maxActions}</td>
                    <td style={td}>{(s.durationMs / 1000).toFixed(0)}s / {s.timeLimitSeconds}s</td>
                    <td style={{ ...td, fontWeight: 700 }}>{sc.total.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Solution capitalisation feedback — how common were the retained
            actions across ALL players' stored solutions on each contingency. */}
        {studiesWithFeedback.length > 0 && (
          <div style={{
            background: colors.surfaceRaised, border: `1px solid ${colors.border}`,
            borderRadius: radius.lg, padding: space[3], marginBottom: space[3],
          }}>
            <h2 style={{ margin: `0 0 ${space[1]}`, fontSize: text.lg }}>
              📚 Your retained actions vs the shared solution base
            </h2>
            <p style={{ margin: `0 0 ${space[2]}`, fontSize: text.xs, color: colors.textTertiary }}>
              Every solution you retain is capitalised (with your player name) into a
              base shared across players. Counts reflect the base as each study was committed.
            </p>
            {studiesWithFeedback.map((s) => (
              <div key={s.studyId} style={{ marginBottom: space[2] }}>
                <div style={{ fontWeight: 600, fontSize: text.sm }}>{s.label}</div>
                <ul style={{ margin: `${space.half} 0 0`, paddingLeft: space[4] }}>
                  {s.solutionFeedback!.frequencies.map((f) => (
                    <li key={f.actionId} style={{ fontSize: text.sm, marginBottom: space.half }}>
                      <span style={{ fontWeight: 600 }}>{f.description || f.actionId}</span>
                      {' — '}
                      <span style={{
                        color: f.count === 0 ? colors.accentText : colors.textSecondary,
                      }}>
                        {frequencyLabel(f)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: space[2], justifyContent: 'flex-end' }}>
          <button style={btn(colors.surfaceMuted, colors.textSecondary)} onClick={exportCsv}>⬇ CSV</button>
          <button style={btn(colors.brandSoft, colors.brand)} onClick={exportJson}>⬇ JSON (Codabench)</button>
          <button style={btn(colors.brand, colors.textOnBrand)} onClick={onReplay}>↺ New session</button>
        </div>
        <p style={{ textAlign: 'right', color: colors.textTertiary, fontSize: text.xs, marginTop: space[1] }}>
          Submit the JSON to the Co-Study4Grid Codabench competition to be ranked.
        </p>
      </div>
    </div>
  );
}
