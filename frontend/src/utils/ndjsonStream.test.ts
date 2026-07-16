// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseNdjsonStream, type NdjsonSource } from './ndjsonStream';

/** Build a source whose body emits the given string chunks in order. */
function sourceFromChunks(chunks: string[]): NdjsonSource {
    const enc = new TextEncoder();
    let i = 0;
    return {
        body: new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
                else controller.close();
            },
        }),
    };
}

async function collect(src: NdjsonSource, opts?: { signal?: AbortSignal }): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of parseNdjsonStream(src, opts)) out.push(ev);
    return out;
}

describe('parseNdjsonStream', () => {
    it('yields one parsed event per complete line', async () => {
        const out = await collect(sourceFromChunks([
            JSON.stringify({ type: 'a' }) + '\n' + JSON.stringify({ type: 'b' }) + '\n',
        ]));
        expect(out).toEqual([{ type: 'a' }, { type: 'b' }]);
    });

    it('carries a partial line across chunk boundaries', async () => {
        const line = JSON.stringify({ type: 'split', n: 42 });
        const mid = Math.floor(line.length / 2);
        const out = await collect(sourceFromChunks([line.slice(0, mid), line.slice(mid) + '\n']));
        expect(out).toEqual([{ type: 'split', n: 42 }]);
    });

    it('splits a multi-line chunk emitted at once', async () => {
        const out = await collect(sourceFromChunks([
            [JSON.stringify({ i: 1 }), JSON.stringify({ i: 2 }), JSON.stringify({ i: 3 }), ''].join('\n'),
        ]));
        expect(out).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    });

    it('flushes a trailing line that lacks a final newline', async () => {
        const out = await collect(sourceFromChunks([
            JSON.stringify({ type: 'a' }) + '\n' + JSON.stringify({ type: 'last' }),
        ]));
        expect(out).toEqual([{ type: 'a' }, { type: 'last' }]);
    });

    it('skips blank lines', async () => {
        const out = await collect(sourceFromChunks(['\n\n' + JSON.stringify({ type: 'a' }) + '\n\n']));
        expect(out).toEqual([{ type: 'a' }]);
    });

    it('skips a complete line that fails JSON.parse', async () => {
        const out = await collect(sourceFromChunks([
            'not json\n' + JSON.stringify({ type: 'ok' }) + '\n',
        ]));
        expect(out).toEqual([{ type: 'ok' }]);
    });

    it('does not yield a malformed trailing line', async () => {
        const out = await collect(sourceFromChunks([JSON.stringify({ type: 'a' }) + '\n{ partial']));
        expect(out).toEqual([{ type: 'a' }]);
    });

    it('returns nothing for a null body', async () => {
        const out = await collect({ body: null });
        expect(out).toEqual([]);
    });

    it('returns nothing when the signal is already aborted', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const out = await collect(
            sourceFromChunks([JSON.stringify({ type: 'a' }) + '\n']),
            { signal: ctrl.signal },
        );
        expect(out).toEqual([]);
    });

    it('stops without flushing the partial buffer when aborted mid-stream', async () => {
        const enc = new TextEncoder();
        const ctrl = new AbortController();
        let pulled = 0;
        const src: NdjsonSource = {
            body: new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulled++;
                    if (pulled === 1) {
                        // One complete line + a VALID but unterminated trailing line.
                        controller.enqueue(enc.encode(
                            JSON.stringify({ type: 'first' }) + '\n' + JSON.stringify({ type: 'trailing' }),
                        ));
                    } else {
                        // Abort before any more data / close arrives.
                        ctrl.abort();
                    }
                },
            }),
        };
        const out = await collect(src, { signal: ctrl.signal });
        // The completed line is delivered; the unterminated trailing line is
        // NOT flushed because the stream was aborted, not finished.
        expect(out).toEqual([{ type: 'first' }]);
    });
});
