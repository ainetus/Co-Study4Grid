// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { notifications } from '../utils/notifications';

// @ts-expect-error: IS_REACT_ACT_ENVIRONMENT is not in the global type definitions
global.IS_REACT_ACT_ENVIRONMENT = true;

// The notification store (D5) is a module singleton, so reset it between
// tests to keep toasts from one test leaking into the next.
afterEach(() => { notifications.clear(); });

// Mock SVG getScreenCTM and related methods which are not implemented in JSDOM
if (typeof window !== 'undefined') {
    const mockMatrix = {
        a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
        multiply: () => mockMatrix,
        inverse: () => mockMatrix,
    };

    // @ts-expect-error: mocking internal SVG methods
    window.SVGElement.prototype.getScreenCTM = function() {
        return mockMatrix;
    };

    // @ts-expect-error: mocking internal SVG methods
    window.SVGSVGElement.prototype.createSVGMatrix = function() {
        return mockMatrix;
    };
    
    // @ts-expect-error: mocking internal SVG methods
    window.SVGSVGElement.prototype.getScreenCTM = function() {
        return mockMatrix;
    };
}
