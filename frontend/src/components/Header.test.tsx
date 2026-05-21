// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Header from './Header';
import type { AnalysisResult } from '../types';

describe('Header', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const defaultProps = {
        networkPath: '/path/to/network.xiidm',
        setNetworkPath: vi.fn(),
        onCommitNetworkPath: vi.fn(),
        configLoading: false,
        result: null,
        selectedContingency: [],
        sessionRestoring: false,
        onPickSettingsPath: vi.fn(),
        onLoadStudy: vi.fn(),
        onSaveResults: vi.fn(),
        onOpenReloadModal: vi.fn(),
        onOpenSettings: vi.fn(),
    };

    it('renders correctly with default props', () => {
        render(<Header {...defaultProps} />);
        expect(screen.getByText('⚡ Co-Study4Grid')).toBeInTheDocument();
        expect(screen.getByDisplayValue('/path/to/network.xiidm')).toBeInTheDocument();
        expect(screen.getByText('🔄 Load Study')).toBeInTheDocument();
    });

    it('shows loading state on Load Study button', () => {
        render(<Header {...defaultProps} configLoading={true} />);
        expect(screen.getByText('⏳ Loading...')).toBeInTheDocument();
        expect(screen.getByText('⏳ Loading...')).toBeDisabled();
    });

    it('disables Save Results when no result or selected branch', () => {
        render(<Header {...defaultProps} />);
        expect(screen.getByText('💾 Save Results')).toBeDisabled();
    });

    it('enables Save Results when result is present', () => {
        render(<Header {...defaultProps} result={{} as unknown as AnalysisResult} />); // result present
        expect(screen.getByText('💾 Save Results')).not.toBeDisabled();
    });

    it('calls callbacks when buttons are clicked', () => {
        render(<Header {...defaultProps} />);
        
        fireEvent.click(screen.getByText('🔄 Load Study'));
        expect(defaultProps.onLoadStudy).toHaveBeenCalled();

        fireEvent.click(screen.getByText('Reload Session'));
        expect(defaultProps.onOpenReloadModal).toHaveBeenCalled();

        fireEvent.click(screen.getByTitle('Settings'));
        expect(defaultProps.onOpenSettings).toHaveBeenCalledWith('paths');
    });

    it('calls onPickSettingsPath when file icon is clicked', () => {
        render(<Header {...defaultProps} />);
        fireEvent.click(screen.getByText('📄'));
        expect(defaultProps.onPickSettingsPath).toHaveBeenCalled();
    });

    // The picker must commit through onCommitNetworkPath (App's
    // confirmation pipeline) rather than calling setNetworkPath
    // directly, so that picking a different file while a study is
    // already loaded triggers the confirmation dialog.
    it('routes the file picker through onCommitNetworkPath', () => {
        const onCommitNetworkPath = vi.fn();
        const onPickSettingsPath = vi.fn();
        render(
            <Header
                {...defaultProps}
                onCommitNetworkPath={onCommitNetworkPath}
                onPickSettingsPath={onPickSettingsPath}
            />,
        );
        fireEvent.click(screen.getByText('📄'));
        expect(onPickSettingsPath).toHaveBeenCalledTimes(1);
        // Second positional argument is the setter the picker will
        // call with the chosen path; it must be onCommitNetworkPath.
        expect(onPickSettingsPath.mock.calls[0][0]).toBe('file');
        expect(onPickSettingsPath.mock.calls[0][1]).toBe(onCommitNetworkPath);
    });

    // Blurring the input after editing the path also goes through
    // onCommitNetworkPath so the dialog fires for users who type a
    // path manually rather than using the picker. The Header uses a
    // controlled input so we wrap it in a stateful harness — without
    // it, fireEvent.change would be reverted by React's reconciliation
    // and the blur callback would still see the old value.
    it('calls onCommitNetworkPath when the network path input loses focus', () => {
        const onCommitNetworkPath = vi.fn();
        const Harness = () => {
            const [networkPath, setNetworkPath] = useState('/old/path.xiidm');
            return (
                <Header
                    {...defaultProps}
                    networkPath={networkPath}
                    setNetworkPath={setNetworkPath}
                    onCommitNetworkPath={onCommitNetworkPath}
                />
            );
        };
        render(<Harness />);
        const input = screen.getByTestId('header-network-path-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '/new/path.xiidm' } });
        fireEvent.blur(input);
        expect(onCommitNetworkPath).toHaveBeenCalledWith('/new/path.xiidm');
    });

    describe('dark-mode toggle', () => {
        beforeEach(() => {
            localStorage.clear();
            document.documentElement.removeAttribute('data-theme');
            document.documentElement.style.colorScheme = '';
            window.matchMedia = vi.fn().mockImplementation((query: string) => ({
                matches: false, media: query, onchange: null,
                addEventListener: vi.fn(), removeEventListener: vi.fn(),
                addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
            }));
        });

        it('renders a theme toggle that shows the moon glyph in light mode', () => {
            render(<Header {...defaultProps} />);
            const toggle = screen.getByTestId('header-theme-toggle');
            expect(toggle).toHaveTextContent('☾');
            expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
        });

        it('flips the document theme and glyph when clicked', () => {
            render(<Header {...defaultProps} />);
            const toggle = screen.getByTestId('header-theme-toggle');

            fireEvent.click(toggle);

            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
            expect(toggle).toHaveTextContent('☀');
            expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');

            fireEvent.click(toggle);

            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
            expect(toggle).toHaveTextContent('☾');
        });
    });
});
