// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { LeverInteraction } from '../types';
import type { ChosenActionRecord, GameStudy } from './types';

/** How a lever hint was activated: single-click inspects, double-click simulates. */
export type LeverInteractionMode = 'inspect' | 'simulate';

// ---------------------------------------------------------------------------
// gameBridge — decoupling layer between the Game Mode shell and the App.
//
// The Game shell lives *outside* <App/> and must (a) drive the workspace
// (load a study's network + contingency) and (b) observe its physical result
// (which actions the player starred and the loading they achieve). Rather
// than plumb props through App's whole tree, both sides talk through this
// module-level singleton — mirroring the existing `interactionLogger`
// pattern. App registers a loader and pushes snapshots; the shell sends load
// commands and subscribes to snapshots. When game mode is off, App never
// touches the bridge, so normal operation is unaffected.
// ---------------------------------------------------------------------------

/** Physical state of the current study, published by App on every change. */
export interface GameStudySnapshot {
  contingencyElementIds: string[];
  /** Worst loading of the bare N-1 state (per-unit), or null if unknown. */
  baselineMaxRho: number | null;
  /** Remedial actions the player has starred, with their resulting loading. */
  chosenActions: ChosenActionRecord[];
  /**
   * Ids of every action already simulated (materialised with a result) in the
   * workspace — recommender-suggested, manually simulated, or lever-driven.
   * The beginner-assistance panel reads it to mark a lever "simulated" (even
   * when the action surfaced through the recommender's suggestions) and to
   * block a redundant second simulation of the same lever.
   */
  simulatedActionIds: string[];
}

const EMPTY_SNAPSHOT: GameStudySnapshot = {
  contingencyElementIds: [],
  baselineMaxRho: null,
  chosenActions: [],
  simulatedActionIds: [],
};

type SnapshotListener = (s: GameStudySnapshot) => void;
type StudyLoader = (study: GameStudy) => Promise<void>;
type LeverInteractionHandler = (
  interaction: LeverInteraction, mode: LeverInteractionMode,
) => void | Promise<void>;

class GameBridge {
  private snapshot: GameStudySnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<SnapshotListener>();
  private loader: StudyLoader | null = null;
  private leverHandler: LeverInteractionHandler | null = null;
  private maxActions = 3;

  /**
   * True when the app was launched in game mode. Two triggers:
   * - `?game=1` query param (local dev / shareable link), or
   * - a `VITE_GAME_MODE=1` build flag, so a dedicated deployment (e.g. the
   *   HuggingFace Space) boots straight into the game without a query string.
   */
  isGameMode(): boolean {
    if (import.meta.env.VITE_GAME_MODE === '1') return true;
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('game') === '1' || params.has('game');
  }

  // --- App side ----------------------------------------------------------

  /** App registers the function the shell calls to load a study. */
  registerLoader(loader: StudyLoader): void {
    this.loader = loader;
  }

  /**
   * App registers the handler that drives the workspace from a lever hint
   * (the beginner-assistance panel): single-click locates the element (and
   * opens the substation SLD), double-click simulates the mapped action.
   */
  registerLeverHandler(handler: LeverInteractionHandler): void {
    this.leverHandler = handler;
  }

  /** App publishes the current physical snapshot; shell listeners fire. */
  publishSnapshot(snapshot: GameStudySnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((l) => l(snapshot));
  }

  /**
   * App asks whether starring one more action is allowed under the active
   * session's cap. Returns true when game mode is off (no constraint).
   */
  canStarAnotherAction(currentlyStarred: number): boolean {
    if (!this.isGameMode()) return true;
    return currentlyStarred < this.maxActions;
  }

  // --- Shell side --------------------------------------------------------

  /** Shell sets the per-study action cap for the running session. */
  setMaxActions(n: number): void {
    this.maxActions = n;
  }

  getMaxActions(): number {
    return this.maxActions;
  }

  /** Shell requests App to load a study; resolves when the load completes.
   *
   * App registers its loader from a mount effect, which only runs once the
   * shell has flipped to the `loading`/`playing` phase that mounts `<App/>`.
   * The very first load therefore races that effect, so we poll briefly for
   * the loader to appear before giving up. */
  async loadStudy(study: GameStudy): Promise<void> {
    const start = Date.now();
    while (!this.loader) {
      if (Date.now() - start > 5000) {
        throw new Error('gameBridge: no study loader registered by App');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.loader(study);
  }

  /** Game UI asks App to inspect or simulate a lever. Resolves when the
   *  handler settles so the caller (the hints panel) can show a
   *  simulating → simulated transition; resolves immediately before App
   *  mounts (no handler registered yet). */
  requestLeverInteraction(interaction: LeverInteraction, mode: LeverInteractionMode): Promise<void> {
    return Promise.resolve(this.leverHandler?.(interaction, mode));
  }

  getSnapshot(): GameStudySnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reset published state between studies. */
  reset(): void {
    this.snapshot = EMPTY_SNAPSHOT;
  }
}

export const gameBridge = new GameBridge();
