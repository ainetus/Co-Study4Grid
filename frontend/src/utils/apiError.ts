// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Single frontend reader for the unified backend error envelope (D2, 2026-07).
//
// The backend now renders EVERY error as `{ detail, code }` (see
// `expert_backend/services/api_errors.py`). Before this, error handling was
// scattered as `err?.response?.data?.detail || 'fallback'` at ~10 call sites,
// each re-deriving the shape and none reading the machine-readable `code`.
// `extractApiError` centralizes that: it copes with the axios error shape, a
// raw `{detail, code}` body, FastAPI's 422 `detail` array, and a plain
// `Error`, and always returns a `{ message, code }` pair.

/** Stable error codes the frontend may branch on. Mirror of the backend
 *  `CODE_*` constants in `expert_backend/services/api_errors.py`. */
export type ApiErrorCode =
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'STUDY_BUSY'
    | 'VALIDATION'
    | 'INTERNAL'
    | 'ACTION_RESULT_UNAVAILABLE'
    | 'LOCKED_DOWN';

export interface ApiError {
    message: string;
    /** Present when the backend tagged the failure with a stable code. */
    code?: ApiErrorCode | string;
    /** HTTP status, when the error came from an HTTP response. */
    status?: number;
}

function detailToMessage(detail: unknown): string | undefined {
    if (typeof detail === 'string') return detail;
    // FastAPI 422: `detail` is an array of `{ loc, msg, type }` entries.
    if (Array.isArray(detail)) {
        const msgs = detail
            .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : null))
            .filter((m): m is string => !!m);
        if (msgs.length) return msgs.join('; ');
    }
    return undefined;
}

/**
 * Normalize any thrown value from an `api.*` call into `{ message, code, status }`.
 *
 * @param err      the caught value (axios error, Error, or unknown)
 * @param fallback message to use when nothing better can be extracted
 */
export function extractApiError(err: unknown, fallback = 'Request failed'): ApiError {
    // Axios error: `err.response.data` is the parsed JSON body.
    const response = (err as { response?: { status?: number; data?: unknown } } | undefined)?.response;
    if (response) {
        const data = response.data as { detail?: unknown; code?: unknown } | undefined;
        const message = detailToMessage(data?.detail);
        const code = typeof data?.code === 'string' ? data.code : undefined;
        return {
            message: message ?? (err as { message?: string })?.message ?? fallback,
            code,
            status: response.status,
        };
    }
    // Plain Error / anything else.
    const message = (err as { message?: string })?.message;
    return { message: message ?? fallback };
}

/** Convenience: just the human-facing message (the common case at UI call sites). */
export function apiErrorMessage(err: unknown, fallback = 'Request failed'): string {
    return extractApiError(err, fallback).message;
}

/** True when the backend tagged the error with the given stable code. */
export function hasErrorCode(err: unknown, code: ApiErrorCode): boolean {
    return extractApiError(err).code === code;
}
