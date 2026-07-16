// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import App from '../App';
import { colors, space, text, radius } from '../styles/tokens';
import GameConfigScreen from './GameConfigScreen';
import GameHintsPanel from './GameHintsPanel';
import GameHud from './GameHud';
import GameNoveltyToast from './GameNoveltyToast';
import GameResults from './GameResults';
import { useGameSession } from './useGameSession';

/** Best (lowest) resulting loading among the player's chosen actions. */
function bestRho(rhos: (number | null)[]): number | null {
  const valid = rhos.filter((r): r is number => typeof r === 'number');
  return valid.length ? Math.min(...valid) : null;
}

/**
 * The Game Mode entry point. Mounted by `main.tsx` instead of bare `<App/>`
 * when the app is launched with `?game=1`. Drives a session state machine
 * over the unchanged Co-Study4Grid workspace.
 */
export default function GameShell() {
  const game = useGameSession();

  if (game.phase === 'config') {
    return <GameConfigScreen onStart={game.startSession} />;
  }

  if (game.phase === 'results' && game.sessionLog) {
    return <GameResults log={game.sessionLog} onReplay={game.quit} />;
  }

  // playing | loading → HUD on top, the live workspace below.
  const cfg = game.config!;
  const study = cfg.studies[game.currentIndex];
  const finalMaxRho = bestRho(game.snapshot.chosenActions.map((a) => a.maxRho));

  return (
    <>
      <GameHud
        studyLabel={study?.label ?? ''}
        contingencyLabel={study?.contingencyLabel}
        studyIndex={game.currentIndex}
        totalStudies={cfg.studies.length}
        secondsLeft={game.secondsLeft}
        timerSeconds={cfg.timerSeconds}
        numActions={game.snapshot.chosenActions.length}
        maxActions={cfg.maxActions}
        finalMaxRho={finalMaxRho}
        onNext={game.advance}
        onQuit={game.quit}
      />

      <div className="game-app-host">
        <App />
      </div>

      {cfg.assistance && game.phase === 'playing' && study && (
        <GameHintsPanel key={study.id} study={study} />
      )}

      {game.noveltyToast && (
        <GameNoveltyToast feedback={game.noveltyToast} onDismiss={game.dismissNoveltyToast} />
      )}

      {game.phase === 'loading' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9500,
          background: 'rgba(0,0,0,0.55)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: colors.surfaceRaised, borderRadius: radius.lg,
            padding: space[5], textAlign: 'center', maxWidth: 420,
            border: `1px solid ${colors.border}`,
          }}>
            {game.loadError ? (
              <>
                <div style={{ fontSize: text.lg, color: colors.dangerText, marginBottom: space[2] }}>
                  ⚠ Failed to load study
                </div>
                <div style={{ fontSize: text.sm, color: colors.textSecondary, marginBottom: space[3] }}>
                  {game.loadError}
                </div>
                <div style={{ display: 'flex', gap: space[2], justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button
                    onClick={game.retryStudy}
                    style={{
                      padding: `${space[2]} ${space[4]}`, borderRadius: radius.md, border: 'none',
                      background: colors.brand, color: colors.textOnBrand, cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Retry
                  </button>
                  <button
                    onClick={game.finishEarly}
                    disabled={game.results.length === 0}
                    style={{
                      padding: `${space[2]} ${space[4]}`, borderRadius: radius.md,
                      border: `1px solid ${colors.border}`,
                      background: colors.surface,
                      color: game.results.length === 0 ? colors.textTertiary : colors.textPrimary,
                      cursor: game.results.length === 0 ? 'not-allowed' : 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Finish with {game.results.length} result{game.results.length === 1 ? '' : 's'}
                  </button>
                  <button
                    onClick={game.quit}
                    style={{
                      padding: `${space[2]} ${space[4]}`, borderRadius: radius.md,
                      border: `1px solid ${colors.border}`, background: 'transparent',
                      color: colors.textSecondary, cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    Quit to setup
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: text.lg, color: colors.brand, marginBottom: space[2] }}>
                  Loading study {game.currentIndex + 1}…
                </div>
                <div style={{ fontSize: text.sm, color: colors.textSecondary }}>
                  {study?.label}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
