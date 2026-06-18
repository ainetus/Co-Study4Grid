// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    // Coverage floor (ratchet). Thresholds sit a few points below the
    // measured baseline (stmt 73.7 / branch 70 / func 73.8 / line 76.3) so
    // a routine PR passes but coverage can't silently erode. Raise as
    // coverage climbs. Run with `npm run test:coverage`. See §19.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 73,
      },
    },
  },
})
