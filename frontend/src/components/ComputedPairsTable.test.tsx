// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ComputedPairsTable, { type ComputedPairEntry } from './ComputedPairsTable';

describe('ComputedPairsTable', () => {
    const basePair: ComputedPairEntry = {
        id: 'act1+act2',
        action1: 'act1',
        action2: 'act2',
        betas: [1.0, 0.9],
        estimated_max_rho: 0.75,
        estimated_max_rho_line: 'L3',
        is_suspect: false,
        isSimulated: false,
        simulated_max_rho: null,
        simulated_max_rho_line: null,
        simData: null,
    };

    const defaultProps = {
        computedPairsList: [basePair],
        monitoringFactor: 0.95,
        simulating: false,
        onSimulate: vi.fn(),
    };

    it('renders table headers', () => {
        render(<ComputedPairsTable {...defaultProps} />);
        expect(screen.getByText('Action 1')).toBeInTheDocument();
        expect(screen.getByText('Action 2')).toBeInTheDocument();
        expect(screen.getByText('Betas')).toBeInTheDocument();
        expect(screen.getByText('Max Loading (Est.)')).toBeInTheDocument();
    });

    it('renders a pair row with action names and estimated max rho', () => {
        render(<ComputedPairsTable {...defaultProps} />);
        expect(screen.getByText('act1')).toBeInTheDocument();
        expect(screen.getByText('act2')).toBeInTheDocument();
        expect(screen.getByText('75.0%')).toBeInTheDocument();
    });

    it('renders betas as formatted values', () => {
        render(<ComputedPairsTable {...defaultProps} />);
        expect(screen.getByText('1.00, 0.90')).toBeInTheDocument();
    });

    it('shows "Not simulated" when pair is not simulated', () => {
        render(<ComputedPairsTable {...defaultProps} />);
        expect(screen.getByText('Not simulated')).toBeInTheDocument();
    });

    it('shows Simulate button for unsimulated pairs', () => {
        render(<ComputedPairsTable {...defaultProps} />);
        expect(screen.getByText('Simulate')).toBeInTheDocument();
    });

    it('calls onSimulate when Simulate button is clicked', () => {
        const onSimulate = vi.fn();
        render(<ComputedPairsTable {...defaultProps} onSimulate={onSimulate} />);
        fireEvent.click(screen.getByText('Simulate'));
        expect(onSimulate).toHaveBeenCalledWith('act1+act2');
    });

    it('shows Re-Simulate button for already simulated pairs', () => {
        const simulatedPair: ComputedPairEntry = {
            ...basePair,
            isSimulated: true,
            simulated_max_rho: 0.72,
            simulated_max_rho_line: 'L3',
            simData: { max_rho: 0.72, max_rho_line: 'L3', is_rho_reduction: true },
        };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[simulatedPair]} />);
        expect(screen.getByText('Re-Simulate')).toBeInTheDocument();
        expect(screen.getByText('72.0%')).toBeInTheDocument();
    });

    it('shows empty state when no pairs exist', () => {
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[]} />);
        expect(screen.getByText(/No computed combinations found/)).toBeInTheDocument();
        expect(screen.getByText(/Explore Pairs/)).toBeInTheDocument();
    });

    it('colors estimated rho green when below monitoring factor', () => {
        const greenPair: ComputedPairEntry = { ...basePair, estimated_max_rho: 0.80 };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[greenPair]} />);
        const badge = screen.getByText('80.0%');
        expect(badge).toBeInTheDocument();
    });

    it('colors estimated rho red when above monitoring factor', () => {
        const redPair: ComputedPairEntry = { ...basePair, estimated_max_rho: 1.05 };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[redPair]} />);
        const badge = screen.getByText('105.0%');
        expect(badge).toBeInTheDocument();
    });

    it('shows suspect warning for islanded estimation', () => {
        const suspectPair: ComputedPairEntry = { ...basePair, is_suspect: true };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[suspectPair]} />);
        expect(screen.getByTitle('Estimation suspect due to islanding')).toBeInTheDocument();
    });

    it('disables Simulate button when simulating', () => {
        render(<ComputedPairsTable {...defaultProps} simulating={true} />);
        const button = screen.getByText('⌛');
        expect(button).toBeDisabled();
    });

    it('shows "—" for pair with null estimated_max_rho', () => {
        const noPair: ComputedPairEntry = { ...basePair, estimated_max_rho: null };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[noPair]} />);
        expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows a "target: X% on LINE" subtitle when the target overload differs from the estimated max line', () => {
        const focusedPair: ComputedPairEntry = {
            ...basePair,
            estimated_max_rho: 0.82,
            estimated_max_rho_line: 'LOUHAL31PYMON',
            target_max_rho: 0.20,
            target_max_rho_line: 'BEON L31CPVAN',
        };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[focusedPair]} />);
        expect(screen.getByText(/target:.*20\.0%.*BEON L31CPVAN/)).toBeInTheDocument();
    });

    it('does not render target subtitle when target line equals estimated line', () => {
        const matchingPair: ComputedPairEntry = {
            ...basePair,
            estimated_max_rho: 0.82,
            estimated_max_rho_line: 'L3',
            target_max_rho: 0.82,
            target_max_rho_line: 'L3',
        };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[matchingPair]} />);
        expect(screen.queryByText(/target:/)).not.toBeInTheDocument();
    });

    it('shows islanding icon for simulated islanded pair', () => {
        const islandedPair: ComputedPairEntry = {
            ...basePair,
            isSimulated: true,
            simulated_max_rho: 0.70,
            simulated_max_rho_line: 'L1',
            simData: { max_rho: 0.70, max_rho_line: 'L1', is_rho_reduction: true, is_islanded: true },
        };
        render(<ComputedPairsTable {...defaultProps} computedPairsList={[islandedPair]} />);
        expect(screen.getByTitle('Islanding detected')).toBeInTheDocument();
    });
});
