// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/**
 * Filter inspectable ids by a query, matching the raw id OR its
 * human-readable name (the label drawn on the diagram), so an element can
 * be found by the name the operator sees — e.g. "LESQUIVE 400kV" — and not
 * only by its raw id. Shared by every inspect surface (the N / N-1 / action
 * tabs and the Remedial-action overview) so they stay in lock-step.
 */
export function filterInspectables(
    items: readonly string[],
    query: string,
    displayName?: (id: string) => string,
    limit = 50,
): string[] {
    const q = query.toUpperCase();
    if (!q) return items.slice(0, limit);
    return items
        .filter(item =>
            item.toUpperCase().includes(q)
            || (displayName ? displayName(item).toUpperCase().includes(q) : false))
        .slice(0, limit);
}
