# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Tests for the canonical :class:`RandomRecommender` /
:class:`RandomOverflowRecommender` shipped with Co-Study4Grid.

The tests use ``unittest.mock`` to fake the simulation environment, so
they run without a live pypowsybl / grid2op stack.
"""
from __future__ import annotations

import random
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# The random recommenders subclass the upstream RecommenderModel base —
# skip in mock-only environments.
pytest.importorskip("expert_op4grid_recommender.models.base")

from expert_op4grid_recommender.models.base import RecommenderInputs
from expert_backend.recommenders.random_basic import RandomRecommender
from expert_backend.recommenders.random_overflow import RandomOverflowRecommender


@pytest.fixture(autouse=True)
def _seed_random():
    random.seed(42)
    yield


def _mock_env_accepting_all():
    env = MagicMock()
    env.action_space = MagicMock(side_effect=lambda content: ("ACT", content))
    return env


def _mock_obs(load_count=2, gen_count=2):
    obs = MagicMock()
    obs.name_load = [f"load_{i}" for i in range(load_count)]
    obs.load_p = [10.0 for _ in range(load_count)]
    obs.name_gen = [f"gen_{i}" for i in range(gen_count)]
    obs.gen_p = [20.0 for _ in range(gen_count)]
    return obs


def _empty_obs():
    return MagicMock(name_load=[], load_p=[], name_gen=[], gen_p=[])


class _StubGraph:
    """Minimal Structured_Overload_Distribution_Graph stand-in."""
    def __init__(self, dispatch_lines=(), loop_nodes=(),
                 constrained_lines=(), constrained_nodes=(), other_blue_nodes=()):
        self._dl = list(dispatch_lines)
        self._ln = list(loop_nodes)
        self._cl = list(constrained_lines)
        self._cn = list(constrained_nodes)
        self._obn = list(other_blue_nodes)

    def get_dispatch_edges_nodes(self, only_loop_paths=False):
        return ([], self._ln) if only_loop_paths else (self._dl, [])

    def get_constrained_edges_nodes(self):
        return (self._cl, self._cn, [], self._obn)


def _mock_pypowsybl_network(vl_ids=("VL_A",), line_ids=("L_dispatch",), twt_ids=()):
    net = MagicMock()
    net.get_voltage_levels.return_value = SimpleNamespace(index=list(vl_ids))
    net.get_lines.return_value = SimpleNamespace(index=list(line_ids))
    net.get_2_windings_transformers.return_value = SimpleNamespace(index=list(twt_ids))
    return net


def _inputs(*, dict_action=None, filtered=None, non_connected=None,
            env=None, obs=None, obs_defaut=None, network=None,
            distribution_graph=None, hubs=None):
    return RecommenderInputs(
        obs=obs if obs is not None else _mock_obs(),
        obs_defaut=obs_defaut if obs_defaut is not None else _mock_obs(),
        lines_defaut=[],
        lines_overloaded_names=[],
        lines_overloaded_ids=[],
        dict_action=dict_action or {},
        env=env if env is not None else _mock_env_accepting_all(),
        classifier=None,
        network=network,
        distribution_graph=distribution_graph,
        hubs=hubs,
        non_connected_reconnectable_lines=non_connected or [],
        filtered_candidate_actions=filtered,
    )


# =====================================================================
# RandomRecommender
# =====================================================================

class TestRandomMetadata:
    def test_name_and_flags(self):
        assert RandomRecommender.name == "random"
        assert RandomRecommender.requires_overflow_graph is False

    def test_params_spec_is_minimal(self):
        specs = RandomRecommender.params_spec()
        assert len(specs) == 1
        assert specs[0].name == "n_prioritized_actions"
        assert specs[0].kind == "int"


class TestRandomSampling:
    def test_samples_n_from_dict_action(self):
        rec = RandomRecommender()
        inputs = _inputs(
            dict_action={
                "a1": {"content": {}}, "a2": {"content": {}},
                "a3": {"content": {}}, "a4": {"content": {}},
            },
            obs_defaut=_empty_obs(),
            non_connected=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 2})
        assert len(out.prioritized_actions) == 2

    def test_caps_at_pool_size(self):
        rec = RandomRecommender()
        inputs = _inputs(
            dict_action={"a1": {"content": {}}},
            obs_defaut=_empty_obs(),
            non_connected=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 50})
        assert len(out.prioritized_actions) == 1
        assert "a1" in out.prioritized_actions

    def test_empty_pool_returns_empty(self):
        rec = RandomRecommender()
        inputs = _inputs(
            dict_action={},
            obs_defaut=_empty_obs(),
            non_connected=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert out.prioritized_actions == {}

    def test_augments_with_reconnections(self):
        rec = RandomRecommender()
        inputs = _inputs(
            dict_action={},
            obs_defaut=_empty_obs(),
            non_connected=["LINE_X", "LINE_Y"],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert any(k.startswith("random_reco_") for k in out.prioritized_actions)

    def test_drops_dict_entries_for_unknown_network_elements(self):
        """Regression: the AUBE P4 case from the small_grid bug."""
        rec = RandomRecommender()
        network = _mock_pypowsybl_network(vl_ids=("VL_A",))
        inputs = _inputs(
            dict_action={
                "on_grid": {"VoltageLevelId": "VL_A", "content": {}},
                "AUBE_P4_bad": {"VoltageLevelId": "AUBE P4", "content": {}},
            },
            obs_defaut=_empty_obs(),
            non_connected=[],
            network=network,
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 10})
        assert "AUBE_P4_bad" not in out.prioritized_actions
        assert "on_grid" in out.prioritized_actions

    def test_skips_actions_that_action_space_refuses(self):
        rec = RandomRecommender()
        env = MagicMock()

        def fake_action_space(content):
            if isinstance(content, dict) and content.get("kind") == "bad":
                raise ValueError("invalid")
            return ("ACT", content)

        env.action_space = MagicMock(side_effect=fake_action_space)
        obs = _empty_obs()
        inputs = RecommenderInputs(
            obs=obs, obs_defaut=obs,
            lines_defaut=[], lines_overloaded_names=[],
            lines_overloaded_ids=[],
            dict_action={
                "a_ok": {"content": {"kind": "ok"}},
                "a_bad": {"content": {"kind": "bad"}},
            },
            env=env, classifier=None,
            non_connected_reconnectable_lines=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 10})
        assert "a_bad" not in out.prioritized_actions
        assert "a_ok" in out.prioritized_actions

    def test_skips_entries_without_content(self):
        rec = RandomRecommender()
        inputs = _inputs(
            dict_action={
                "with": {"content": {"foo": 1}},
                "without": {"description": "no content"},
            },
            obs_defaut=_empty_obs(),
            non_connected=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 10})
        assert "without" not in out.prioritized_actions
        assert "with" in out.prioritized_actions


# =====================================================================
# RandomOverflowRecommender
# =====================================================================

class TestRandomOverflowMetadata:
    def test_name_and_flags(self):
        assert RandomOverflowRecommender.name == "random_overflow"
        assert RandomOverflowRecommender.requires_overflow_graph is True

    def test_params_spec_is_minimal(self):
        specs = RandomOverflowRecommender.params_spec()
        assert len(specs) == 1
        assert specs[0].name == "n_prioritized_actions"


class TestRandomOverflowFallbackSemantics:
    """None (filter didn't run) vs [] (filter ran, nothing passed)."""

    def test_none_filtered_falls_back_to_dict(self):
        """None → expert filter didn't run → fallback with warning."""
        rec = RandomOverflowRecommender()
        inputs = _inputs(
            dict_action={"a1": {"content": {}}, "a2": {"content": {}}},
            filtered=None,
            distribution_graph=None,
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert set(out.prioritized_actions) <= {"a1", "a2"}
        assert len(out.prioritized_actions) > 0

    def test_empty_filtered_returns_empty_no_fallback(self):
        """[] → filter ran but nothing passed → return {} (not fallback).

        This is the bug RandomOverflow was hitting: empty filter result
        was silently falling back to dict_action keys, defeating the
        whole point of the model.
        """
        rec = RandomOverflowRecommender()
        inputs = _inputs(
            dict_action={"a1": {"content": {}}, "a2": {"content": {}}},
            filtered=[],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert out.prioritized_actions == {}


class TestRandomOverflowSampling:
    def test_samples_only_from_filtered_set(self):
        rec = RandomOverflowRecommender()
        inputs = _inputs(
            dict_action={
                "a1": {"content": {}}, "a2": {"content": {}},
                "a3": {"content": {}}, "a4": {"content": {}},
            },
            filtered=["a1", "a3"],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert set(out.prioritized_actions) <= {"a1", "a3"}
        assert "a2" not in out.prioritized_actions
        assert "a4" not in out.prioritized_actions

    def test_path_filter_drops_actions_off_paths(self):
        """Regression: with a populated distribution graph, actions whose
        target doesn't touch any path are dropped before sampling."""
        rec = RandomOverflowRecommender()
        graph = _StubGraph(
            dispatch_lines=["L_dispatch"],
            loop_nodes=["VL_LOOP"],
        )
        inputs = _inputs(
            dict_action={
                "on_path": {"content": {"set_bus": {"lines_or_id": {"L_dispatch": 1}}}},
                "off_path": {"content": {"set_bus": {"lines_or_id": {"FAR": -1}}}},
            },
            filtered=["on_path", "off_path"],
            distribution_graph=graph,
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert "off_path" not in out.prioritized_actions
        assert "on_path" in out.prioritized_actions

    def test_network_existence_drops_actions_for_unknown_vl(self):
        """Layer-3 filter: actions whose VL isn't in the network are dropped."""
        rec = RandomOverflowRecommender()
        graph = _StubGraph(loop_nodes=["VL_A", "FOREIGN_VL"])
        network = _mock_pypowsybl_network(vl_ids=("VL_A",))
        inputs = _inputs(
            dict_action={
                "on_grid": {"VoltageLevelId": "VL_A", "content": {}},
                "off_grid": {"VoltageLevelId": "FOREIGN_VL", "content": {}},
            },
            filtered=["on_grid", "off_grid"],
            distribution_graph=graph,
            network=network,
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert "off_grid" not in out.prioritized_actions
        assert "on_grid" in out.prioritized_actions

    def test_three_layer_filter_chain_returns_empty_on_full_rejection(self):
        """When every layer rejects, the pool empties to {}."""
        rec = RandomOverflowRecommender()
        graph = _StubGraph(dispatch_lines=["REAL_LINE"], loop_nodes=[])
        inputs = _inputs(
            dict_action={
                "bad": {"content": {"set_bus": {"lines_or_id": {"OTHER_LINE": -1}}}},
            },
            filtered=["bad"],
            distribution_graph=graph,
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert out.prioritized_actions == {}

    def test_skips_unknown_action_ids_in_filtered(self):
        rec = RandomOverflowRecommender()
        inputs = _inputs(
            dict_action={"a1": {"content": {}}},
            filtered=["a1", "unknown_id"],
        )
        out = rec.recommend(inputs, params={"n_prioritized_actions": 5})
        assert set(out.prioritized_actions) <= {"a1"}
