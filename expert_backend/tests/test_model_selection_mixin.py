# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Tests for :class:`ModelSelectionMixin`."""
from __future__ import annotations

from types import SimpleNamespace

from expert_backend.services.model_selection_mixin import ModelSelectionMixin


class _Host(ModelSelectionMixin):
    """Minimal host so we can exercise the mixin without RecommenderService."""
    pass


def test_defaults_after_reset():
    h = _Host()
    h._reset_model_settings()
    assert h.get_active_model_name() == "expert"
    assert h.get_compute_overflow_graph() is True


def test_apply_settings_with_explicit_values():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="random", compute_overflow_graph=False,
    ))
    assert h.get_active_model_name() == "random"
    assert h.get_compute_overflow_graph() is False


def test_apply_settings_strips_whitespace():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="  random_overflow  ", compute_overflow_graph=True,
    ))
    assert h.get_active_model_name() == "random_overflow"


def test_apply_settings_empty_model_falls_back_to_default():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="", compute_overflow_graph=True,
    ))
    assert h.get_active_model_name() == "expert"


def test_apply_settings_whitespace_only_model_falls_back():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="   ", compute_overflow_graph=True,
    ))
    assert h.get_active_model_name() == "expert"


def test_apply_settings_non_string_model_falls_back():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model=123, compute_overflow_graph=True,
    ))
    # Defensive: only strings should set the model name.
    assert h.get_active_model_name() == "expert"


def test_apply_settings_none_toggle_uses_default():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="random", compute_overflow_graph=None,
    ))
    assert h.get_compute_overflow_graph() is True


def test_apply_settings_truthy_non_bool_toggle_coerces():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace(
        model="random", compute_overflow_graph=1,
    ))
    assert h.get_compute_overflow_graph() is True


def test_apply_settings_missing_attrs_uses_defaults():
    h = _Host()
    h._reset_model_settings()
    h._apply_model_settings(SimpleNamespace())
    assert h.get_active_model_name() == "expert"
    assert h.get_compute_overflow_graph() is True


def test_getters_safe_without_reset():
    """Calling getters before _reset_model_settings is safe."""
    h = _Host()
    assert h.get_active_model_name() == "expert"
    assert h.get_compute_overflow_graph() is True
