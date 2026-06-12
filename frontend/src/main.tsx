// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { interactionLogger } from './utils/interactionLogger'
import { gameBridge } from './game/gameBridge'
import GameShell from './game/GameShell.tsx'

if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_LOGGER) {
  (window as unknown as { __interactionLogger: typeof interactionLogger }).__interactionLogger
    = interactionLogger;
}

// Game Mode wraps the unchanged workspace in a timed, scored session shell.
// Activated with `?game=1`; the bare workspace is the default.
const Root = gameBridge.isGameMode() ? GameShell : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
)
