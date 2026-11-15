// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

/**
 * "A study load is in flight" — emitted by `api.updateConfig` around its
 * `POST /api/config`, whatever the load path (Apply Settings, Load Study,
 * session reload, Game Mode).
 *
 * The Context tab listens to start reading its situation map while the
 * backend is still loading the action space: the map is ready a few
 * seconds before `/api/config` answers. A plain module-level signal (not
 * part of `api`) so suites that mock `api` wholesale are unaffected.
 */
export type StudyLoadPhase = 'start' | 'loaded' | 'failed';
type Listener = (phase: StudyLoadPhase) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function. */
export const onStudyLoad = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const signalStudyLoad = (phase: StudyLoadPhase): void => {
    listeners.forEach(l => l(phase));
};
