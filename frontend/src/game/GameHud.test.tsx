// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import GameHud from './GameHud';

const props = {
  studyLabel: 'Study', studyIndex: 0, totalStudies: 1, secondsLeft: 100, timerSeconds: 300,
  numActions: 1, maxActions: 3, onNext: vi.fn(), onQuit: vi.fn(),
};

afterEach(cleanup);

describe('GameHud loading pill — judged against the monitoring factor', () => {
  it('flags a loading past the monitoring factor, even under 100 %', () => {
    render(<GameHud {...props} finalMaxRho={0.97} monitoringFactor={0.95} />);
    expect(screen.getByText(/⚠ 97\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/target < 95%/)).toBeInTheDocument();
  });

  it('ticks a loading under the monitoring factor', () => {
    render(<GameHud {...props} finalMaxRho={0.944} monitoringFactor={0.95} />);
    expect(screen.getByText(/✓ 94\.4%/)).toBeInTheDocument();
  });

  it('falls back to the thermal limit when no factor is given', () => {
    render(<GameHud {...props} finalMaxRho={0.97} />);
    expect(screen.getByText(/✓ 97\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/target < 100%/)).toBeInTheDocument();
  });
});
