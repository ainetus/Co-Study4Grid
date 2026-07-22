// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import GameConfigScreen from './GameConfigScreen';

const mockApi = vi.hoisted(() => ({ getPlayerSessions: vi.fn() }));
vi.mock('../api', () => ({ api: mockApi }));

beforeEach(() => {
  mockApi.getPlayerSessions.mockResolvedValue({ player: 'amarot', session_count: 2 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const sessionInput = () => screen.getByTestId('game-session-name') as HTMLInputElement;

describe('GameConfigScreen landing', () => {
  it('keeps Start disabled until a player name is entered', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    expect(screen.getByTestId('game-start')).toBeDisabled();
  });

  it('auto-fills the session name from the player + next session index', async () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    fireEvent.change(screen.getByTestId('game-player'), { target: { value: 'amarot' } });
    await waitFor(() => expect(sessionInput().value).toBe('amarot — session 3'));
    expect(mockApi.getPlayerSessions).toHaveBeenCalledWith('amarot');
  });

  it('falls back to session 1 when the backend is unreachable', async () => {
    mockApi.getPlayerSessions.mockRejectedValue(new Error('offline'));
    render(<GameConfigScreen onStart={vi.fn()} />);
    fireEvent.change(screen.getByTestId('game-player'), { target: { value: 'zoe' } });
    await waitFor(() => expect(sessionInput().value).toBe('zoe — session 1'));
  });

  it('does not overwrite a session name the user typed', async () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    fireEvent.change(sessionInput(), { target: { value: 'My custom run' } });
    fireEvent.change(screen.getByTestId('game-player'), { target: { value: 'amarot' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionInput().value).toBe('My custom run');
    expect(mockApi.getPlayerSessions).not.toHaveBeenCalled();
  });

  it('lists the configured studies and shows the network preview', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    expect(screen.getByTestId('game-studies-summary').querySelectorAll('li').length)
      .toBeGreaterThan(0);
    expect(screen.getByTestId('game-network-preview')).toBeInTheDocument();
  });

  it('hides settings by default and reveals timer / difficulty / studies on toggle', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    expect(screen.queryByText(/Time limit per study/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('game-settings-toggle'));
    expect(screen.getByText(/Time limit per study/)).toBeInTheDocument();
    expect(screen.getByText(/Difficulty \(network\)/)).toBeInTheDocument();
    expect(screen.getByText(/Studies \(/)).toBeInTheDocument();
  });

  it('starts a session with the entered config', async () => {
    const onStart = vi.fn();
    render(<GameConfigScreen onStart={onStart} />);
    fireEvent.change(screen.getByTestId('game-player'), { target: { value: 'amarot' } });
    await waitFor(() => expect(sessionInput().value).toBe('amarot — session 3'));
    fireEvent.click(screen.getByTestId('game-start'));

    expect(onStart).toHaveBeenCalledTimes(1);
    const cfg = onStart.mock.calls[0][0];
    expect(cfg.player).toBe('amarot');
    expect(cfg.sessionName).toBe('amarot — session 3');
    expect(cfg.assistance).toBe(true);
    expect(cfg.timerSeconds).toBe(300);
    expect(cfg.studies.length).toBeGreaterThan(0);
  });
});

describe('GameConfigScreen — France THT mode', () => {
  it('reveals the difficulty + case-count pickers and hides the demo studies/preview', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    // Demo is the default: its studies summary + network preview are shown.
    expect(screen.getByTestId('game-studies-summary')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('game-mode-tht'));
    expect(screen.getByTestId('game-tht-difficulty')).toBeInTheDocument();
    expect(screen.getByTestId('game-tht-count')).toBeInTheDocument();
    expect(screen.getByTestId('game-tht-summary')).toBeInTheDocument();
    // The demo studies list + per-network preview belong to demo mode only.
    expect(screen.queryByTestId('game-studies-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('game-network-preview')).not.toBeInTheDocument();
  });

  it('starts a France THT session by sampling the chosen number of cases', async () => {
    const onStart = vi.fn();
    render(<GameConfigScreen onStart={onStart} />);
    fireEvent.change(screen.getByTestId('game-player'), { target: { value: 'amarot' } });
    await waitFor(() => expect(sessionInput().value).toBe('amarot — session 3'));
    fireEvent.click(screen.getByTestId('game-mode-tht'));
    fireEvent.change(screen.getByTestId('game-tht-count'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('game-start'));

    expect(onStart).toHaveBeenCalledTimes(1);
    const cfg = onStart.mock.calls[0][0];
    expect(cfg.studies).toHaveLength(3);
    for (const s of cfg.studies) {
      expect(s.networkPath).toContain('data/rte7000_tht/grids/');
      expect(s.contingencyElementId).toBeTruthy();
    }
  });

  it('caps the number of cases at the pool size', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId('game-mode-tht'));
    const count = screen.getByTestId('game-tht-count') as HTMLInputElement;
    fireEvent.change(count, { target: { value: '999999' } });
    // Clamped to the difficulty's available cases (a positive, finite pool).
    expect(Number(count.value)).toBeGreaterThan(0);
    expect(Number(count.value)).toBeLessThan(999999);
  });

  it('still requires a player name to start in THT mode', () => {
    render(<GameConfigScreen onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId('game-mode-tht'));
    expect(screen.getByTestId('game-start')).toBeDisabled();
  });
});
