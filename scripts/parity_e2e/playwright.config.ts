import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

/**
 * Playwright config for the Layer-3 parity spec.
 *
 * The spec serves the built React app via a tiny static server
 * (see webServer below) and loads the standalone HTML straight from
 * the repo via file://, so no pypowsybl backend is required.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: ['*parity.spec.ts', 'demo_*.spec.ts'],
  timeout: 90_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // `vite preview` serves the production build. If the build is
    // missing, fail fast rather than run against a stale dist.
    command: 'npm --prefix ../../frontend run preview -- --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: path.resolve(__dirname),
  },
  projects: [
    { name: 'chromium', use: { channel: 'chromium' } },
  ],
});
