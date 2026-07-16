// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { ChosenActionRecord, GameStudy } from './types';

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
}

const EMPTY_SNAPSHOT: GameStudySnapshot = {
  contingencyElementIds: [],
  baselineMaxRho: null,
  chosenActions: [],
};

type SnapshotListener = (s: GameStudySnapshot) => void;
type StudyLoader = (study: GameStudy) => Promise<void>;
type InspectHandler = (query: string) => void;

class GameBridge {
  private snapshot: GameStudySnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<SnapshotListener>();
  private loader: StudyLoader | null = null;
  private inspector: InspectHandler | null = null;
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
   * App registers its Inspect-field setter so game UI (the hints panel)
   * can pre-fill it — same auto-zoom path as typing in the box.
   */
  registerInspector(inspector: InspectHandler): void {
    this.inspector = inspector;
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

  /** Shell asks App to pre-fill the Inspect field. No-op before App mounts. */
  requestInspect(query: string): void {
    this.inspector?.(query);
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
