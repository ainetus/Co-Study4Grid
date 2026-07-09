// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Single reader for the backend's NDJSON (newline-delimited JSON) streams
// (`/api/run-analysis[-step2]`, `/api/simulate-and-variant-diagram`). This
// replaces five hand-copied reader loops (App.tsx ×2, useAnalysis,
// useDiagrams, ActionFeed) that had drifted apart: only the two App.tsx
// copies flushed a final line that lacked a trailing newline, and each
// re-implemented blank-line / parse-error handling slightly differently
// (D5 / QW10, 2026-07).
//
// Uniform semantics for every caller:
//   - decodes with `TextDecoder({stream:true})`, carrying the partial line
//     across chunk boundaries;
//   - yields one parsed value per COMPLETE line; blank lines are skipped;
//   - a line that fails `JSON.parse` is skipped (matches the legacy
//     "silent catch for incomplete rows" behaviour);
//   - on stream end, flushes the decoder and yields a trailing unterminated
//     final line if present (the robustness fix only two copies carried);
//   - honours an optional `AbortSignal`: aborting cancels the reader and
//     ends the iteration cleanly (a `for await` consumer simply stops and
//     the partial buffer is NOT flushed). Consumers distinguish an abort
//     from normal completion by checking `signal.aborted` after the loop.

/** Anything with a readable body — a `fetch` `Response`, or a test double. */
export interface NdjsonSource {
    body: ReadableStream<Uint8Array> | null;
}

export interface NdjsonStreamOptions {
    /** Abort the read (and end the iteration) when this signal fires. */
    signal?: AbortSignal;
}

function parseLine(line: string): { ok: true; value: unknown } | { ok: false } {
    if (!line.trim()) return { ok: false };
    try {
        return { ok: true, value: JSON.parse(line) };
    } catch {
        // A complete line that won't parse is malformed/partial — skip it,
        // preserving the legacy loops' silent behaviour rather than throwing
        // into the middle of a caller's event switch.
        return { ok: false };
    }
}

/**
 * Parse an NDJSON HTTP streaming body into an async iterable of parsed
 * events. Cast each yielded value to the caller's event union.
 */
export async function* parseNdjsonStream(
    source: NdjsonSource,
    options: NdjsonStreamOptions = {},
): AsyncGenerator<unknown, void, unknown> {
    const { signal } = options;
    const body = source.body;
    if (!body) return;
    if (signal?.aborted) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // A pending `reader.read()` won't settle until the next chunk arrives;
    // cancelling the reader on abort forces it to resolve so the loop can
    // notice the abort promptly even when the fetch itself wasn't wired to
    // the signal.
    // `reader.cancel?.()?.catch(...)` tolerates a reader that lacks
    // `cancel` (some test doubles) and never throws out of cleanup.
    const cancelReader = () => { reader.cancel?.()?.catch(() => { /* already closed */ }); };
    const onAbort = () => { cancelReader(); };
    if (signal) signal.addEventListener('abort', onAbort);

    try {
        while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (err) {
                if (signal?.aborted) return; // aborted mid-read → end cleanly
                throw err;
            }
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const parsed = parseLine(line);
                if (parsed.ok) yield parsed.value;
            }
        }
        // Don't flush a partial buffer that an abort left behind.
        if (signal?.aborted) return;
        // Flush the decoder's held bytes, then any trailing unterminated line.
        buffer += decoder.decode();
        const parsed = parseLine(buffer);
        if (parsed.ok) yield parsed.value;
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        // Release/cancel the underlying stream — important when a consumer
        // `break`s out early (e.g. on abort) so the network body is freed.
        cancelReader();
    }
}
