// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors, space, text, radius } from '../styles/tokens';
import { GAME_HUD_HEIGHT } from './GameHud';
import type { StudySolutionFeedback } from './types';

interface GameNoveltyToastProps {
  feedback: StudySolutionFeedback;
  onDismiss: () => void;
}

/**
 * Transient banner shown under the HUD when the just-committed study's
 * retained proposition turns out to be NEW in the shared solution base —
 * the player earned a novelty bonus and is told right away.
 */
export default function GameNoveltyToast({ feedback, onDismiss }: GameNoveltyToastProps) {
  const { novelty } = feedback;
  const completelyNew = novelty.newLevers.length > 0;
  return (
    <div
      role="status"
      style={{
        // Above the loading overlay (zIndex 9500) so the banner stays
        // visible + dismissable while the next study loads.
        position: 'fixed', top: GAME_HUD_HEIGHT + 8, left: '50%',
        transform: 'translateX(-50%)', zIndex: 9600, maxWidth: 640,
        display: 'flex', alignItems: 'center', gap: space[2],
        padding: `${space[2]} ${space[3]}`, borderRadius: radius.lg,
        background: colors.accentSoft, border: `1px solid ${colors.accentBorder}`,
        color: colors.accentText, fontSize: text.sm, boxSizing: 'border-box',
      }}
    >
      <span style={{ fontSize: text.lg }}>🌟</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>
          {completelyNew
            ? `Brand-new solution — nobody proposed it before! +${novelty.bonusPoints} bonus pts`
            : `New combination of known actions! +${novelty.bonusPoints} bonus pts`}
        </div>
        {completelyNew && (
          <div style={{ fontSize: text.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            New lever{novelty.newLevers.length > 1 ? 's' : ''}: {novelty.newLevers.join(', ')}
          </div>
        )}
      </div>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{
          marginLeft: space[2], border: 'none', background: 'transparent',
          color: colors.accentText, cursor: 'pointer', fontSize: text.sm, fontWeight: 700,
        }}
      >
        ✕
      </button>
    </div>
  );
}
