/**
 * Playwright global setup — wires the real-backend mode for the demo
 * replay specs.
 *
 * Activated when `COSTUDY4GRID_REAL_BACKEND=1` is set. The setup
 * either spawns `uvicorn expert_backend.main:app --port 8000`
 * (when `COSTUDY4GRID_SPAWN_BACKEND=1`) or assumes an externally-
 * managed backend is already listening on `127.0.0.1:8000`. In both
 * cases it then POSTs `/api/config` with the small_grid paths so the
 * subsequent specs hit a pre-loaded state.
 *
 * When `COSTUDY4GRID_REAL_BACKEND` is unset (the default), this setup
 * is a no-op and the specs run against their `page.route` mocks as
 * before.
 *
 * Why a globalSetup instead of a per-spec `beforeAll`:
 *   - The backend load takes ~5-10 s on small_grid and would be paid
 *     by every spec under per-spec setup (currently 3 demo_*.spec.ts).
 *   - Pytest's `setup_class` equivalent is one POST /api/config per
 *     test class; here we want ONE POST per test session.
 *
 * The matching teardown (`playwright.global-teardown.ts`) only kills
 * the uvicorn process when we spawned it; an externally-managed
 * backend is left untouched.
 *
 * Limitations / prereqs documented in `DEMO_REPLAY_README.md`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { FullConfig } from '@playwright/test';

const BACKEND_URL = process.env.COSTUDY4GRID_BACKEND_URL ?? 'http://127.0.0.1:8000';
const REPO_ROOT = path.resolve(__dirname, '../..');

// Resolved small_grid paths — must match what `test_demo_scenario_small_grid.py`
// uses on the pytest side so the two test layers agree on the fixture data.
const SMALL_GRID_CONFIG = {
    network_path: path.join(REPO_ROOT, 'data', 'bare_env_small_grid_test', 'grid.xiidm'),
    action_file_path: path.join(REPO_ROOT, 'data', 'action_space', 'reduced_model_actions_test.json'),
    layout_path: path.join(REPO_ROOT, 'data', 'bare_env_small_grid_test', 'grid_layout.json'),
    min_line_reconnections: 2.0,
    min_close_coupling: 3.0,
    min_open_coupling: 2.0,
    min_line_disconnections: 3.0,
    min_pst: 1.0,
    min_load_shedding: 2.0,
    min_renewable_curtailment_actions: 0,
    n_prioritized_actions: 10,
    lines_monitoring_path: '',
    monitoring_factor: 0.95,
    pre_existing_overload_threshold: 0.02,
    ignore_reconnections: false,
    pypowsybl_fast_mode: true,
    model: 'expert',
    compute_overflow_graph: true,
};

let spawnedBackend: ChildProcess | null = null;

async function waitForBackend(url: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${url}/api/user-config`);
            if (res.ok) return;
            lastError = new Error(`status ${res.status}`);
        } catch (err) {
            lastError = err;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(
        `Backend did not become ready at ${url} within ${timeoutMs}ms. Last error: ${String(lastError)}`,
    );
}

async function spawnUvicorn(): Promise<ChildProcess> {
    const proc = spawn(
        'uvicorn',
        ['expert_backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
        {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        },
    );
    // Surface backend stderr in the Playwright run so a failed boot
    // is debuggable from the test output.
    proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[uvicorn] ${chunk.toString()}`);
    });
    proc.on('exit', (code) => {
        if (code !== null && code !== 0) {
            process.stderr.write(`[uvicorn] exited with code ${code}\n`);
        }
    });
    return proc;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
    if (process.env.COSTUDY4GRID_REAL_BACKEND !== '1') {
        // Mock-backend mode: the specs' own `page.route` calls handle
        // everything. Nothing to do here.
        return;
    }

    if (process.env.COSTUDY4GRID_SPAWN_BACKEND === '1') {
        // eslint-disable-next-line no-console
        console.log('[globalSetup] spawning uvicorn for real-backend mode…');
        spawnedBackend = await spawnUvicorn();
        // Stash the pid on the env so teardown can find it without
        // sharing module state (Playwright re-imports the teardown
        // file in a fresh module context).
        process.env.COSTUDY4GRID_SPAWNED_PID = String(spawnedBackend.pid);
    } else {
        // eslint-disable-next-line no-console
        console.log(
            `[globalSetup] real-backend mode — expecting an externally-managed `
            + `backend at ${BACKEND_URL}. Set COSTUDY4GRID_SPAWN_BACKEND=1 to `
            + `auto-spawn uvicorn instead.`,
        );
    }

    await waitForBackend(BACKEND_URL);

    // POST /api/config with the small_grid paths. Subsequent specs
    // then run against this pre-loaded state.
    const configResp = await fetch(`${BACKEND_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SMALL_GRID_CONFIG),
    });
    if (!configResp.ok) {
        throw new Error(
            `POST /api/config failed: ${configResp.status} ${configResp.statusText} — `
            + `${await configResp.text()}`,
        );
    }
    const configBody = await configResp.json() as { status?: string; total_lines_count?: number };
    if (configBody.status !== 'success' || (configBody.total_lines_count ?? 0) === 0) {
        throw new Error(`POST /api/config returned unexpected body: ${JSON.stringify(configBody)}`);
    }
    // eslint-disable-next-line no-console
    console.log(
        `[globalSetup] backend configured against small_grid `
        + `(${configBody.total_lines_count} lines).`,
    );
}
