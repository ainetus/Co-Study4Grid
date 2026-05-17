/**
 * Playwright global teardown — counterpart to `playwright.global-setup.ts`.
 *
 * Kills the uvicorn child process we spawned in setup, if any. An
 * externally-managed backend (the default real-backend mode) is left
 * untouched.
 */
import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(_config: FullConfig): Promise<void> {
    const pid = process.env.COSTUDY4GRID_SPAWNED_PID;
    if (!pid) return;

    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid) || numericPid <= 0) return;

    try {
        process.kill(numericPid, 'SIGTERM');
        // eslint-disable-next-line no-console
        console.log(`[globalTeardown] sent SIGTERM to spawned uvicorn (pid=${numericPid})`);
    } catch (err) {
        // Process is already gone — that's fine.
        process.stderr.write(`[globalTeardown] kill failed (pid may be dead): ${String(err)}\n`);
    }
}
