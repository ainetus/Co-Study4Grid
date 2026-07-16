# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unified API error contract (D2, 2026-07).

Before this module the backend collapsed every failure into ``HTTP 400``
with a bare ``{detail: str(exception)}`` — five different client-visible
shapes across the surface, absolute server paths leaking through
``str(e)``, and no machine-readable discriminator for the one error the
frontend actually branches on (the post-reload
``action-variant-diagram`` 400 that triggers a live re-simulation).

This introduces ONE error envelope — ``{"detail": <human string>,
"code": <STABLE_SLUG>}`` — produced in ONE place:

- Every ``HTTPException`` (raised anywhere) is rendered with a ``code``.
  Callers that care about the discriminator raise :class:`AppHTTPException`
  with an explicit ``code``; everything else gets a code derived from the
  status via :data:`_DEFAULT_CODE_BY_STATUS`. ``detail`` is unchanged, so
  existing clients / tests that read ``response.json()["detail"]`` keep
  working — ``code`` is purely additive.
- Any UNCAUGHT exception is turned into a clean ``500`` with a GENERIC
  detail (no ``str(e)`` path leak) and ``code="INTERNAL"``, logged
  server-side via ``logger.exception``.

Register both handlers once with :func:`install_error_handlers(app)`.

Stable codes (the wire contract — do not rename without a frontend +
`openapi.snapshot.json` update):
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# --- Stable error codes (wire contract) ---
CODE_BAD_REQUEST = "BAD_REQUEST"
CODE_NOT_FOUND = "NOT_FOUND"
CODE_STUDY_BUSY = "STUDY_BUSY"
CODE_VALIDATION = "VALIDATION"
CODE_INTERNAL = "INTERNAL"
# The frontend branches on THIS one: an expected post-reload / manual-action
# condition where the backend has no cached post-action observation, so the
# client falls back to /api/simulate-and-variant-diagram (a live simulation).
CODE_ACTION_RESULT_UNAVAILABLE = "ACTION_RESULT_UNAVAILABLE"
# A filesystem-touching RPC that is disabled on a locked-down (hosted,
# non-local) deployment — see the D7 lockdown profile in main.py.
CODE_LOCKED_DOWN = "LOCKED_DOWN"

_DEFAULT_CODE_BY_STATUS = {
    400: CODE_BAD_REQUEST,
    403: CODE_LOCKED_DOWN,
    404: CODE_NOT_FOUND,
    409: CODE_STUDY_BUSY,
    422: CODE_VALIDATION,
    500: CODE_INTERNAL,
}


class AppHTTPException(HTTPException):
    """An ``HTTPException`` carrying an explicit stable error ``code``.

    Use when a client branches on the specific failure (rather than just
    the status). Renders as ``{"detail": ..., "code": <code>}``.
    """

    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(status_code=status_code, detail=detail)
        self.code = code


def _code_for(exc: HTTPException) -> str:
    explicit = getattr(exc, "code", None)
    if explicit:
        return str(explicit)
    return _DEFAULT_CODE_BY_STATUS.get(exc.status_code, CODE_BAD_REQUEST)


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Render every HTTPException as ``{detail, code}`` (code additive).

    Typed as ``Exception`` to match Starlette's ``add_exception_handler``
    signature; the ``isinstance`` guard narrows it (this handler is only
    ever dispatched for ``HTTPException``).
    """
    if not isinstance(exc, HTTPException):  # pragma: no cover - dispatch invariant
        raise exc
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": _code_for(exc)},
        headers=getattr(exc, "headers", None),
    )


async def _validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """FastAPI request-validation errors keep their rich ``detail`` list
    but gain the uniform ``code`` so the frontend extractor is universal."""
    if not isinstance(exc, RequestValidationError):  # pragma: no cover - dispatch invariant
        raise exc
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "code": CODE_VALIDATION},
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Any uncaught exception → clean 500 with a GENERIC message.

    Never echoes ``str(exc)`` to the client — that leaked absolute server
    paths (QW6 / the security review). The full traceback is logged
    server-side instead.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error.", "code": CODE_INTERNAL},
    )


def install_error_handlers(app: FastAPI) -> None:
    """Register the unified error handlers on ``app`` (call once at import)."""
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
