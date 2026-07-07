# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Tests for the new ConfigRequest fields + ``/api/models`` endpoint."""
from __future__ import annotations

import pytest

# expert_backend.main imports the recommenders package, whose __init__
# registers the concrete upstream model classes — skip in mock-only
# environments (same convention as test_recommenders_registry.py).
pytest.importorskip("expert_op4grid_recommender.models.base")

fastapi_testclient = pytest.importorskip("fastapi.testclient")
TestClient = fastapi_testclient.TestClient

from expert_backend.main import ConfigRequest, app


client = TestClient(app)


# ---------------------------------------------------------------------
# ConfigRequest schema
# ---------------------------------------------------------------------

def test_config_request_default_model_is_expert():
    cr = ConfigRequest(network_path="/n", action_file_path="/a")
    assert cr.model == "expert"
    assert cr.compute_overflow_graph is True


def test_config_request_accepts_custom_model():
    cr = ConfigRequest(
        network_path="/n", action_file_path="/a",
        model="random", compute_overflow_graph=False,
    )
    assert cr.model == "random"
    assert cr.compute_overflow_graph is False


def test_config_request_roundtrips_through_json():
    payload = {
        "network_path": "/n", "action_file_path": "/a",
        "model": "random_overflow", "compute_overflow_graph": True,
    }
    cr = ConfigRequest(**payload)
    dumped = cr.model_dump()
    assert dumped["model"] == "random_overflow"
    assert dumped["compute_overflow_graph"] is True


# ---------------------------------------------------------------------
# GET /api/models endpoint
# ---------------------------------------------------------------------

def test_models_endpoint_returns_200():
    resp = client.get("/api/models")
    assert resp.status_code == 200


def test_models_endpoint_lists_canonical_three():
    payload = client.get("/api/models").json()
    names = {m["name"] for m in payload["models"]}
    assert {"expert", "random", "random_overflow"}.issubset(names)


def test_models_endpoint_marks_expert_default():
    payload = client.get("/api/models").json()
    expert = next(m for m in payload["models"] if m["name"] == "expert")
    assert expert["is_default"] is True
    assert expert["requires_overflow_graph"] is True


def test_models_endpoint_random_does_not_require_graph():
    payload = client.get("/api/models").json()
    rnd = next(m for m in payload["models"] if m["name"] == "random")
    assert rnd["requires_overflow_graph"] is False


def test_models_endpoint_random_overflow_requires_graph():
    payload = client.get("/api/models").json()
    ro = next(m for m in payload["models"] if m["name"] == "random_overflow")
    assert ro["requires_overflow_graph"] is True


def test_models_endpoint_random_has_minimal_params():
    payload = client.get("/api/models").json()
    rnd = next(m for m in payload["models"] if m["name"] == "random")
    names = {p["name"] for p in rnd["params"]}
    assert names == {"n_prioritized_actions"}


def test_models_endpoint_expert_has_legacy_knobs():
    payload = client.get("/api/models").json()
    expert = next(m for m in payload["models"] if m["name"] == "expert")
    names = {p["name"] for p in expert["params"]}
    for required in (
        "n_prioritized_actions",
        "min_line_reconnections",
        "min_close_coupling",
        "min_open_coupling",
        "min_line_disconnections",
        "min_pst",
        "min_load_shedding",
        "min_renewable_curtailment_actions",
        "ignore_reconnections",
    ):
        assert required in names, f"missing param {required!r}"


def test_models_endpoint_param_shape():
    payload = client.get("/api/models").json()
    for model in payload["models"]:
        for param in model["params"]:
            assert {"name", "label", "kind", "default"}.issubset(param)
            assert param["kind"] in {"int", "float", "bool"}
