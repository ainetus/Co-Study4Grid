# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""The OpenAPI contract snapshot must stay in sync with the live app (D2).

Runs the same normalization as ``scripts/check_openapi_contract.py`` in
the pytest process, so an endpoint / request-model / response-model /
status-code change that isn't accompanied by a regenerated
``openapi.snapshot.json`` fails here (and in CI) instead of silently
drifting from the hand-mirrored ``types.ts``.

Regenerate intentionally with:
    python scripts/check_openapi_contract.py --write
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPT = _REPO_ROOT / "scripts" / "check_openapi_contract.py"
_SNAPSHOT = _REPO_ROOT / "expert_backend" / "openapi.snapshot.json"


def _load_checker():
    spec = importlib.util.spec_from_file_location("_openapi_checker", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_openapi_snapshot_matches_live_app():
    checker = _load_checker()
    rendered = checker._normalize(checker._render_spec())
    committed = _SNAPSHOT.read_text(encoding="utf-8")
    assert rendered == committed, (
        "OpenAPI contract drift — the live app.openapi() no longer matches "
        "expert_backend/openapi.snapshot.json. If the change is intentional, "
        "run: python scripts/check_openapi_contract.py --write"
    )


def test_error_responses_use_the_unified_envelope():
    """Every 4xx/5xx the app can raise renders as {detail, code}."""
    from fastapi.testclient import TestClient

    from expert_backend.main import app

    client = TestClient(app, raise_server_exceptions=False)

    # 422 validation error (missing required body field) — uniform envelope.
    r = client.post("/api/run-analysis-step1", json={})
    assert r.status_code == 422
    body = r.json()
    assert "code" in body and body["code"] == "VALIDATION"
    assert "detail" in body

    # 404 from the artifact route — uniform envelope with NOT_FOUND.
    r = client.get("/results/pdf/does-not-exist.html")
    assert r.status_code == 404
    assert r.json()["code"] == "NOT_FOUND"
