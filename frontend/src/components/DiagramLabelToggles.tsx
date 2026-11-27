// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { colors } from '../styles/tokens';

const toggleStyle = (on: boolean) => ({
    background: on ? colors.brand : colors.surface,
    color: on ? colors.textOnBrand : colors.textSecondary,
    border: `1px solid ${on ? colors.brand : colors.border}`,
    borderRadius: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
});

/**
 * The diagram's label toggles beside the Inspect field: voltage-level names
 * (`🏷 VL`) and the value labels on the branches (`🏷 Values`) — off for a
 * lighter reading: the colours stay and the hover tells any branch.
 */
export default function DiagramLabelToggles({ showVlNames, onToggleVlNames, showValues, onToggleValues }: {
    showVlNames: boolean;
    onToggleVlNames?: (show: boolean) => void;
    showValues: boolean;
    onToggleValues?: (show: boolean) => void;
}) {
    return (
        <>
            {onToggleVlNames && (
                <button
                    onClick={() => onToggleVlNames(!showVlNames)}
                    title={showVlNames
                        ? 'Hide voltage-level names on the diagram (hover bus circles to see them as tooltips)'
                        : 'Show voltage-level names on the diagram'}
                    aria-pressed={showVlNames}
                    data-testid="toggle-vl-names"
                    style={toggleStyle(showVlNames)}
                >
                    {'\u{1F3F7} VL'}
                </button>
            )}
            {onToggleValues && (
                <button
                    onClick={() => onToggleValues(!showValues)}
                    title={showValues
                        ? 'Hide the value labels on the branches (lighter reading): the colours stay, hover a branch for its values'
                        : 'Show the value labels on the branches'}
                    aria-pressed={showValues}
                    data-testid="toggle-values"
                    style={toggleStyle(showValues)}
                >
                    {'\u{1F3F7} Values'}
                </button>
            )}
        </>
    );
}
