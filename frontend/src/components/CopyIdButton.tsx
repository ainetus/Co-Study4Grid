// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useEffect, useState } from 'react';
import { colors } from '../styles/tokens';
import { Glyph } from './Glyph';

/**
 * Copy a raw id to the clipboard. Readable names replace the ids on screen
 * (SLD title, action cards); this keeps the id one click away for
 * traceability — searching a log, a session file, the network itself.
 */
const CopyIdButton: React.FC<{ value: string; label?: string; testId?: string }> = ({ value, label = 'id', testId }) => {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1200);
        return () => clearTimeout(t);
    }, [copied]);
    const copy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
    };
    return (
        <button
            type="button"
            data-testid={testId}
            onClick={copy}
            onMouseDown={e => e.stopPropagation()}
            title={copied ? 'Copied' : `Copy ${label}: ${value}`}
            aria-label={`Copy ${label} ${value}`}
            style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
                color: copied ? colors.success : colors.textTertiary, lineHeight: 0, flexShrink: 0,
            }}
        >
            <Glyph kind={copied ? 'check' : 'copy'} size={12} />
        </button>
    );
};

export default CopyIdButton;
