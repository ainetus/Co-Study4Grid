# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Unit + integration tests for the unified API error contract (D2, 2026-07).

Guards `expert_backend/services/api_errors.py`:
- every HTTPException renders as ``{detail, code}`` (code additive);
- request-validation errors keep their rich detail + gain ``VALIDATION``;
- **uncaught exceptions never leak ``str(exc)``** (the QW6 / security fix):
  a generic ``500`` + ``code=INTERNAL``, with the real message only logged;
- the frontend's branch discriminator ``ACTION_RESULT_UNAVAILABLE`` reaches
  the client on the post-reload action-variant-diagram 400.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.requests import Request

from expert_backend.services.api_errors import (
    AppHTTPException,
    CODE_ACTION_RESULT_UNAVAILABLE,
    CODE_BAD_REQUEST,
    CODE_INTERNAL,
    CODE_NOT_FOUND,
    CODE_STUDY_BUSY,
    CODE_VALIDATION,
    _code_for,
    _http_exception_handler,
    _unhandled_exception_handler,
    _validation_exception_handler,
    install_error_handlers,
)


def _fake_request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/thing",
            "headers": [],
            "query_string": b"",
        }
    )


def _run(coro):
    return asyncio.run(coro)


def _body(response) -> dict:
    return json.loads(bytes(response.body))


# ---------------------------------------------------------------------
# AppHTTPException + _code_for
# ---------------------------------------------------------------------

def test_app_http_exception_carries_code_and_is_http_exception():
    exc = AppHTTPException(status_code=409, detail="busy", code=CODE_STUDY_BUSY)
    assert isinstance(exc, HTTPException)
    assert exc.status_code == 409
    assert exc.detail == "busy"
    assert exc.code == CODE_STUDY_BUSY


def test_code_for_prefers_explicit_code():
    exc = AppHTTPException(status_code=400, detail="x", code=CODE_ACTION_RESULT_UNAVAILABLE)
    assert _code_for(exc) == CODE_ACTION_RESULT_UNAVAILABLE


@pytest.mark.parametrize(
    "status, expected",
    [
        (400, CODE_BAD_REQUEST),
        (404, CODE_NOT_FOUND),
        (409, CODE_STUDY_BUSY),
        (422, CODE_VALIDATION),
        (500, CODE_INTERNAL),
        (418, CODE_BAD_REQUEST),  # unmapped status → conservative default
    ],
)
def test_code_for_default_mapping_by_status(status, expected):
    assert _code_for(HTTPException(status_code=status, detail="d")) == expected


# ---------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------

def test_http_handler_renders_detail_and_code():
    exc = HTTPException(status_code=404, detail="Not found")
    resp = _run(_http_exception_handler(_fake_request(), exc))
    assert resp.status_code == 404
    assert _body(resp) == {"detail": "Not found", "code": CODE_NOT_FOUND}


def test_http_handler_uses_explicit_app_code():
    exc = AppHTTPException(status_code=400, detail="no obs", code=CODE_ACTION_RESULT_UNAVAILABLE)
    resp = _run(_http_exception_handler(_fake_request(), exc))
    assert _body(resp) == {"detail": "no obs", "code": CODE_ACTION_RESULT_UNAVAILABLE}


def test_http_handler_reraises_non_http_exception():
    # Dispatch invariant: only registered for HTTPException.
    with pytest.raises(ValueError):
        _run(_http_exception_handler(_fake_request(), ValueError("boom")))


def test_validation_handler_keeps_errors_and_tags_validation():
    exc = RequestValidationError(
        [{"loc": ("body", "x"), "msg": "field required", "type": "missing"}]
    )
    resp = _run(_validation_exception_handler(_fake_request(), exc))
    body = _body(resp)
    assert resp.status_code == 422
    assert body["code"] == CODE_VALIDATION
    assert isinstance(body["detail"], list)
    assert body["detail"][0]["msg"] == "field required"


def test_unhandled_handler_returns_generic_500_and_does_not_leak():
    secret = "/home/operator/secret/path/grid.xiidm does not exist"
    resp = _run(_unhandled_exception_handler(_fake_request(), RuntimeError(secret)))
    body = _body(resp)
    assert resp.status_code == 500
    assert body == {"detail": "Internal server error.", "code": CODE_INTERNAL}
    # The security guarantee: the exception's message NEVER reaches the client.
    assert secret not in json.dumps(body)


# ---------------------------------------------------------------------
# Wiring on the real app
# ---------------------------------------------------------------------

def test_install_error_handlers_registers_all_three():
    from fastapi import FastAPI

    app = FastAPI()
    install_error_handlers(app)
    assert HTTPException in app.exception_handlers
    assert RequestValidationError in app.exception_handlers
    assert Exception in app.exception_handlers


def test_main_app_has_the_handlers_installed():
    from expert_backend.main import app

    assert Exception in app.exception_handlers
    assert HTTPException in app.exception_handlers


# ---------------------------------------------------------------------
# Integration: the frontend-branch discriminator reaches the client
# ---------------------------------------------------------------------

def test_action_variant_diagram_400_carries_action_result_unavailable_code():
    from unittest.mock import patch

    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from expert_backend.services.diagram_mixin import ActionResultUnavailableError

    with patch("expert_backend.main.recommender_service") as mock_rs:
        mock_rs.get_action_variant_diagram.side_effect = ActionResultUnavailableError(
            "No analysis result available. Run analysis first."
        )
        from expert_backend.main import app

        client = fastapi_testclient.TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/action-variant-diagram",
            json={"action_id": "a1", "mode": "network"},
        )
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == CODE_ACTION_RESULT_UNAVAILABLE
    assert "detail" in body


def test_response_validation_failure_becomes_generic_500_not_a_leak():
    """A response that doesn't match its `response_model` raises OUTSIDE the
    endpoint's try/except (during serialization) — proving the global
    Exception handler fires AND still returns the generic envelope."""
    from unittest.mock import patch

    fastapi_testclient = pytest.importorskip("fastapi.testclient")

    with patch("expert_backend.main.recommender_service") as mock_rs:
        # active_model must be a str for RecommenderModelResponse; returning a
        # dict makes response serialization fail with a ResponseValidationError.
        mock_rs.get_active_model_name.return_value = {"not": "a string"}
        mock_rs.get_compute_overflow_graph.return_value = True
        from expert_backend.main import app

        client = fastapi_testclient.TestClient(app, raise_server_exceptions=False)
        resp = client.post("/api/recommender-model", json={"model": "random"})
    assert resp.status_code == 500
    assert resp.json() == {"detail": "Internal server error.", "code": CODE_INTERNAL}
