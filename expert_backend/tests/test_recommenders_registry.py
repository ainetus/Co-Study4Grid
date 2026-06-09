# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Resilience tests for the recommender registry's ``list_models``.

Guards the regression where a single model whose ``params_spec()`` raised
(e.g. it referenced a config attribute missing from a stale install) took
down the whole ``GET /api/models`` endpoint — blanking out every model AND
every parameter in the Settings → Recommender tab.

Needs the real ``expert_op4grid_recommender`` (the registry's package
``__init__`` imports the concrete model classes), so it is skipped under
the conftest mock layer.
"""
import pytest

pytest.importorskip("expert_op4grid_recommender.models.base")

from expert_backend.recommenders.registry import register, unregister, list_models  # noqa: E402


class _GoodModel:
    name = "test_good_model"
    label = "Good"
    requires_overflow_graph = False

    @classmethod
    def params_spec(cls):
        from expert_op4grid_recommender.models.base import ParamSpec
        return [ParamSpec("foo", "Foo", "int", default=1, min=0, max=10)]


class _ThrowingModel:
    name = "test_throwing_model"
    label = "Throwing"
    requires_overflow_graph = False

    @classmethod
    def params_spec(cls):
        raise AttributeError("simulated stale-config attribute error")


def test_list_models_degrades_when_a_model_params_spec_raises():
    register(_GoodModel)
    register(_ThrowingModel)
    try:
        out = {m["name"]: m for m in list_models()}
        # The endpoint stays up and serves EVERY model.
        assert "test_good_model" in out
        assert "test_throwing_model" in out
        # Healthy model keeps its params.
        assert [p["name"] for p in out["test_good_model"]["params"]] == ["foo"]
        # Offending model degrades to an empty param list instead of a 500.
        assert out["test_throwing_model"]["params"] == []
    finally:
        unregister("test_good_model")
        unregister("test_throwing_model")


def test_expert_model_exposes_redispatch_params():
    """The bundled expert model declares the redispatch knobs so the
    Settings UI can render the Min Redispatch field."""
    out = {m["name"]: m for m in list_models()}
    assert "expert" in out
    expert_params = {p["name"] for p in out["expert"]["params"]}
    assert "min_redispatch" in expert_params
    assert "redispatch_default_delta_mw" in expert_params
