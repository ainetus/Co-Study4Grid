// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import React, { useState, useRef } from 'react';
import type { TabId } from '../types';
import { colors } from '../styles/tokens';

/**
 * Inspect text field + custom suggestions dropdown.
 *
 * This replaces a native <input list=...> + <datalist> pair. The
 * native datalist is unreliable when its owning subtree is physically
 * relocated between documents via DetachableTabHost — Chromium in
 * particular has been observed to show the dropdown in the wrong
 * window (or not at all in the window being typed into) when a tied
 * detached tab shares the same `inspectQuery` state with the main
 * window's active tab overlay.
 *
 * By rendering the suggestion list ourselves, as a plain
 * absolutely-positioned div sibling of the input, the dropdown is
 * guaranteed to live in the same DOM subtree as the input it belongs
 * to, in whichever window that subtree happens to be. It therefore
 * renders reliably whether the overlay sits in the main window or in
 * a detached popup, regardless of the tied state.
 */
const InspectSearchField: React.FC<{
    tabId: TabId;
    inspectQuery: string;
    onChangeQuery: (tab: TabId, q: string) => void;
    filteredInspectables: string[];
    /** id → human-readable name (the label drawn on the diagram). When a
     *  name exists, the dropdown shows it so an element can be found by the
     *  name visible on the network, not only by its raw id. */
    displayName?: (id: string) => string;
    placeholder?: string;
    inputTestId?: string;
    /** Called when an option is picked from the dropdown, in addition to
     *  onChangeQuery — lets a caller (e.g. the overview) zoom immediately. */
    onSelect?: (id: string) => void;
}> = ({ tabId, inspectQuery, onChangeQuery, filteredInspectables, displayName, placeholder, inputTestId, onSelect }) => {
    const [focused, setFocused] = useState(false);
    // Keep the dropdown visible long enough for an option click to
    // register before onBlur hides it (click fires after blur).
    const closeTimer = useRef<number | null>(null);

    // Hide the dropdown after a matched commit so the user isn't left
    // with a hovering suggestion panel while zoomed in on the asset.
    const exactMatch = inspectQuery.length > 0
        && filteredInspectables.some(v => v.toUpperCase() === inspectQuery.toUpperCase());
    const showDropdown = focused && inspectQuery.length > 0 && filteredInspectables.length > 0 && !exactMatch;

    return (
        <div style={{ position: 'relative' }}>
            <input
                data-testid={inputTestId}
                value={inspectQuery}
                onChange={e => onChangeQuery(tabId, e.target.value)}
                onFocus={() => {
                    if (closeTimer.current !== null) {
                        window.clearTimeout(closeTimer.current);
                        closeTimer.current = null;
                    }
                    setFocused(true);
                }}
                onBlur={() => {
                    // Defer the hide so onMouseDown on an option can
                    // complete and fire its onClick before the
                    // dropdown unmounts.
                    closeTimer.current = window.setTimeout(() => {
                        setFocused(false);
                        closeTimer.current = null;
                    }, 150);
                }}
                placeholder={placeholder ?? '🔍 Inspect...'}
                style={{
                    padding: '5px 10px',
                    border: inspectQuery ? `2px solid ${colors.brand}` : `1px solid ${colors.border}`,
                    borderRadius: '4px',
                    fontSize: '12px',
                    width: '180px',
                    boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
                    background: colors.surface,
                    color: colors.textPrimary,
                }}
            />
            {showDropdown && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        marginBottom: '4px',
                        width: '220px',
                        maxHeight: '220px',
                        overflowY: 'auto',
                        background: colors.surface,
                        color: colors.textPrimary,
                        border: `1px solid ${colors.brand}`,
                        borderRadius: '4px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
                        zIndex: 200,
                        fontSize: '12px',
                    }}
                >
                    {filteredInspectables.map(item => (
                        <div
                            key={item}
                            // Use onMouseDown (fires before the
                            // input's onBlur) so the selection is
                            // recorded even though the blur is about
                            // to hide us.
                            onMouseDown={e => {
                                e.preventDefault();
                                onChangeQuery(tabId, item);
                                onSelect?.(item);
                            }}
                            style={{
                                padding: '5px 10px',
                                cursor: 'pointer',
                                borderBottom: `1px solid ${colors.borderSubtle}`,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.brandSoft; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = colors.surface; }}
                            title={item}
                        >
                            {(() => {
                                const name = displayName ? displayName(item) : item;
                                return name && name !== item
                                    ? `${name}  —  ${item}`
                                    : item;
                            })()}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default InspectSearchField;
