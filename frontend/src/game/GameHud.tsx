// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors, space, text, radius } from '../styles/tokens';

export const GAME_HUD_HEIGHT = 56;

interface GameHudProps {
  studyLabel: string;
  contingencyLabel?: string;
  studyIndex: number;
  totalStudies: number;
  secondsLeft: number;
  timerSeconds: number;
  numActions: number;
  maxActions: number;
  finalMaxRho: number | null;
  onNext: () => void;
  onQuit: () => void;
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function GameHud(props: GameHudProps) {
  const {
    studyLabel, contingencyLabel, studyIndex, totalStudies,
    secondsLeft, timerSeconds, numActions, maxActions,
    finalMaxRho, onNext, onQuit,
  } = props;

  const lowTime = secondsLeft <= 10;
  const atCap = numActions >= maxActions;
  const solved = finalMaxRho != null && finalMaxRho < 1.0;

  const pill = (bg: string, fg: string, border: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: space[1],
    padding: `${space[1]} ${space[2]}`, borderRadius: radius.md,
    background: bg, color: fg, border: `1px solid ${border}`,
    fontSize: text.sm, fontWeight: 600, whiteSpace: 'nowrap',
  });

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: GAME_HUD_HEIGHT,
        zIndex: 9000, display: 'flex', alignItems: 'center', gap: space[3],
        padding: `0 ${space[3]}`, background: colors.surfaceRaised,
        borderBottom: `2px solid ${colors.brand}`, boxSizing: 'border-box',
      }}
    >
      <span style={{ fontWeight: 700, color: colors.brand, fontSize: text.md }}>
        🎮 Game Mode
      </span>

      <span style={pill(colors.surfaceMuted, colors.textSecondary, colors.border)}>
        Study {studyIndex + 1}/{totalStudies}
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={{
          fontWeight: 600, color: colors.textPrimary, fontSize: text.sm,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {studyLabel}
        </span>
        {contingencyLabel && (
          <span style={{
            color: colors.textTertiary, fontSize: text.xs,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            Contingency: {contingencyLabel}
          </span>
        )}
      </div>

      <span style={pill(
        atCap ? colors.warningSoft : colors.surfaceMuted,
        atCap ? colors.warningText : colors.textSecondary,
        atCap ? colors.warningBorder : colors.border,
      )}>
        Actions {numActions}/{maxActions}
      </span>

      {finalMaxRho != null && (
        <span style={pill(
          solved ? colors.successSoft : colors.dangerSoft,
          solved ? colors.successText : colors.dangerText,
          solved ? colors.success : colors.danger,
        )}>
          {solved ? '✓' : '⚠'} {(finalMaxRho * 100).toFixed(0)}%
        </span>
      )}

      <span
        style={{
          ...pill(
            lowTime ? colors.dangerSoft : colors.surfaceMuted,
            lowTime ? colors.dangerText : colors.textPrimary,
            lowTime ? colors.danger : colors.border,
          ),
          fontVariantNumeric: 'tabular-nums', minWidth: 64, justifyContent: 'center',
        }}
        title={`Time limit: ${fmtClock(timerSeconds)}`}
      >
        ⏱ {fmtClock(secondsLeft)}
      </span>

      <button
        onClick={onNext}
        style={{
          padding: `${space[1]} ${space[3]}`, borderRadius: radius.md,
          background: colors.brand, color: colors.textOnBrand, border: 'none',
          fontSize: text.sm, fontWeight: 700, cursor: 'pointer',
        }}
      >
        Next study →
      </button>

      <button
        onClick={onQuit}
        title="Quit session"
        style={{
          padding: `${space[1]} ${space[2]}`, borderRadius: radius.md,
          background: 'transparent', color: colors.textTertiary,
          border: `1px solid ${colors.border}`, fontSize: text.sm, cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  );
}
