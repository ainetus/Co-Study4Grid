// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { extractApiError, apiErrorMessage, hasErrorCode } from './apiError';

describe('extractApiError', () => {
    it('reads the unified {detail, code} envelope from an axios error', () => {
        const err = { response: { status: 400, data: { detail: 'boom', code: 'BAD_REQUEST' } } };
        expect(extractApiError(err)).toEqual({ message: 'boom', code: 'BAD_REQUEST', status: 400 });
    });

    it('surfaces the ACTION_RESULT_UNAVAILABLE discriminator', () => {
        const err = {
            response: { status: 400, data: { detail: 'no obs', code: 'ACTION_RESULT_UNAVAILABLE' } },
        };
        expect(hasErrorCode(err, 'ACTION_RESULT_UNAVAILABLE')).toBe(true);
        expect(hasErrorCode(err, 'BAD_REQUEST')).toBe(false);
    });

    it('flattens a FastAPI 422 detail array into a message', () => {
        const err = {
            response: {
                status: 422,
                data: {
                    code: 'VALIDATION',
                    detail: [
                        { loc: ['body', 'x'], msg: 'field required', type: 'missing' },
                        { loc: ['body', 'y'], msg: 'must be int', type: 'int_type' },
                    ],
                },
            },
        };
        const out = extractApiError(err);
        expect(out.code).toBe('VALIDATION');
        expect(out.message).toBe('field required; must be int');
    });

    it('falls back to the axios error message when the body has no detail', () => {
        const err = { message: 'Network Error', response: { status: 500, data: {} } };
        expect(apiErrorMessage(err, 'fallback')).toBe('Network Error');
    });

    it('uses the provided fallback when nothing is extractable', () => {
        expect(apiErrorMessage({}, 'nothing here')).toBe('nothing here');
    });

    it('handles a plain Error', () => {
        expect(apiErrorMessage(new Error('plain'))).toBe('plain');
    });

    it('surfaces the 409 STUDY_BUSY envelope with its status', () => {
        const err = {
            response: {
                status: 409,
                data: {
                    detail: 'Another study operation is already in progress.',
                    code: 'STUDY_BUSY',
                },
            },
        };
        const out = extractApiError(err);
        expect(out.status).toBe(409);
        expect(out.code).toBe('STUDY_BUSY');
        expect(hasErrorCode(err, 'STUDY_BUSY')).toBe(true);
    });

    it('returns no code when the body omits one (pre-envelope backend)', () => {
        const err = { response: { status: 400, data: { detail: 'legacy only' } } };
        const out = extractApiError(err);
        expect(out.message).toBe('legacy only');
        expect(out.code).toBeUndefined();
    });
});
