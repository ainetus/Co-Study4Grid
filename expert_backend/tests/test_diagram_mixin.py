# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid.

"""Unit tests for :mod:`expert_backend.services.diagram_mixin`.

Covers the invariants guaranteed by :class:`DiagramMixin`:

- :meth:`DiagramMixin._default_nad_parameters` — the minimal-render
  config documented in ``docs/performance/nad-profile-bare-env.md`` (``bus_legend``,
  ``substation_description_displayed``, ``voltage_level_details``,
  ``injections_added`` all off; ``power_value_precision=0``;
  ``layout_type=GEOGRAPHICAL``).

- :meth:`DiagramMixin._load_layout` — instance-level cache keyed by
  ``(path, mtime)`` so repeated NAD generations skip the JSON + DataFrame
  rebuild.

- :meth:`DiagramMixin._get_element_max_currents` — vectorised numpy path
  returning ``{element_id: max(|i1|, |i2|)}`` with rows containing NaN
  excluded.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

pypowsybl = pytest.importorskip("pypowsybl")

from pypowsybl.network import NadLayoutType, NadParameters

from expert_backend.services.diagram_mixin import DiagramMixin


class TestDefaultNadParameters:
    """Guard against regressions on the NAD parameter defaults.

    The GEOGRAPHICAL layout is a deliberate choice — reverting to the
    default FORCE_LAYOUT would silently add ~450 ms per NAD generation
    on the PyPSA-EUR France 118 MB grid. See
    ``docs/perf-geographical-layout.md`` and the docstring on
    :meth:`DiagramMixin._default_nad_parameters`.
    """

    def test_returns_nad_parameters_instance(self):
        mixin = DiagramMixin()
        params = mixin._default_nad_parameters()
        assert isinstance(params, NadParameters)

    def test_uses_geographical_layout_type(self):
        """layout_type must be GEOGRAPHICAL (not FORCE_LAYOUT).

        Regression guard: if someone reverts to `FORCE_LAYOUT` (or removes
        the kwarg so pypowsybl defaults apply), NAD gen slows back down.
        """
        mixin = DiagramMixin()
        params = mixin._default_nad_parameters()
        # The NadParameters Java wrapper doesn't expose layout_type as a
        # readable attribute on every pypowsybl version, so we verify via
        # a patched NadParameters constructor (next test).
        # Here we just make sure the call does not blow up when the enum
        # value is applied.
        assert params is not None

    def test_passes_geographical_layout_type_to_constructor(self, mocker=None):
        """Verify NadParameters is invoked with layout_type=GEOGRAPHICAL."""
        from unittest.mock import patch

        mixin = DiagramMixin()
        with patch("pypowsybl.network.NadParameters") as mock_cls:
            mock_cls.return_value = object()
            mixin._default_nad_parameters()
            mock_cls.assert_called_once()
            kwargs = mock_cls.call_args.kwargs
            assert "layout_type" in kwargs, (
                "NadParameters must receive an explicit layout_type kwarg"
            )
            assert kwargs["layout_type"] == NadLayoutType.GEOGRAPHICAL, (
                f"Expected GEOGRAPHICAL layout, got {kwargs['layout_type']!r}. "
                "Reverting to FORCE_LAYOUT would regress NAD gen by ~11 % "
                "on 118 MB grids."
            )

    def test_minimal_render_parameters(self):
        """Companion kwargs guard — these are the minimal-render toggles
        documented in ``docs/performance/nad-profile-bare-env.md`` (section
        "Results — after #6"). Flipping any of them silently regresses
        NAD perf on large grids (e.g. ``bus_legend=True`` adds ~1 MB SVG
        and ~160 ms; ``injections_added=True`` adds ~11 MB / ~1 s)."""
        mixin = DiagramMixin()
        with patch("pypowsybl.network.NadParameters") as mock_cls:
            mock_cls.return_value = object()
            mixin._default_nad_parameters()
            kwargs = mock_cls.call_args.kwargs

        expected = {
            "edge_name_displayed": False,
            "id_displayed": False,
            "edge_info_along_edge": True,
            "power_value_precision": 0,
            "angle_value_precision": 0,
            "current_value_precision": 1,
            "voltage_value_precision": 0,
            "bus_legend": False,
            "substation_description_displayed": False,
            "voltage_level_details": False,
            "injections_added": False,
        }
        for key, value in expected.items():
            assert kwargs.get(key) == value, (
                f"NadParameters kwarg {key!r} expected {value!r}, got {kwargs.get(key)!r}"
            )


class TestLoadLayoutCache:
    """`_load_layout` must cache its DataFrame on the instance keyed by
    ``(path, mtime)``. Cache must invalidate when the file changes.
    """

    def _write_layout(self, path: Path, records: dict) -> None:
        path.write_text(json.dumps(records))

    def test_returns_none_when_layout_path_unset(self):
        mixin = DiagramMixin()
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = None
            assert mixin._load_layout() is None

    def test_returns_none_when_layout_file_missing(self, tmp_path):
        missing = tmp_path / "nope.json"
        mixin = DiagramMixin()
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = missing
            assert mixin._load_layout() is None

    def test_loads_layout_dataframe(self, tmp_path):
        layout_file = tmp_path / "grid_layout.json"
        self._write_layout(layout_file, {"A": [1.0, 2.0], "B": [3.5, -0.5]})

        mixin = DiagramMixin()
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = layout_file
            df = mixin._load_layout()

        assert df is not None
        assert list(df.index) == ["A", "B"]
        assert list(df.columns) == ["x", "y"]
        assert df.loc["A", "x"] == 1.0
        assert df.loc["B", "y"] == -0.5

    def test_cache_hit_skips_file_read(self, tmp_path):
        """Second call for an unchanged file must not re-open it."""
        layout_file = tmp_path / "grid_layout.json"
        self._write_layout(layout_file, {"A": [1.0, 2.0]})

        mixin = DiagramMixin()
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = layout_file
            first = mixin._load_layout()

            # After the first load, patch `open` to detect any re-read.
            with patch("builtins.open") as mock_open:
                second = mixin._load_layout()
                mock_open.assert_not_called(), (
                    "_load_layout must return the cached DataFrame when "
                    "(path, mtime) is unchanged"
                )

        assert second is first, "Cached call should return the same DataFrame object"

    def test_cache_invalidates_on_mtime_change(self, tmp_path):
        """Editing the layout file must invalidate the cache."""
        layout_file = tmp_path / "grid_layout.json"
        self._write_layout(layout_file, {"A": [1.0, 2.0]})

        mixin = DiagramMixin()
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = layout_file
            first = mixin._load_layout()

            # Bump mtime far enough that even coarse filesystems notice,
            # then overwrite the file with new content.
            future_mtime = time.time() + 10
            import os
            os.utime(layout_file, (future_mtime, future_mtime))
            self._write_layout(layout_file, {"A": [1.0, 2.0], "B": [9.0, 9.0]})
            os.utime(layout_file, (future_mtime + 1, future_mtime + 1))

            second = mixin._load_layout()

        assert second is not first, "Cache must not return the stale DataFrame"
        assert "B" in second.index, "Reloaded layout must include the newly added entry"

    def test_reset_clears_layout_cache_across_studies(self, tmp_path):
        """Bugfix: loading a new study must not reuse the previous study's
        cached layout DataFrame as ``fixed_positions`` for NAD generation.

        Reproduces the bug described in issue "grid layout not properly
        reset" — two different grids pointing at different layout files
        must each get their own DataFrame back from ``_load_layout`` after
        ``reset()``, even if ``(path, mtime)`` were to coincide.

        We use :class:`RecommenderService` rather than the bare mixin
        because the cache invalidation happens in ``reset()``, which is
        defined on the composed service class.
        """
        from expert_backend.services.recommender_service import RecommenderService

        layout_a = tmp_path / "grid_layout_A.json"
        layout_b = tmp_path / "grid_layout_B.json"
        self._write_layout(layout_a, {"SUB_A1": [1.0, 2.0], "SUB_A2": [3.0, 4.0]})
        self._write_layout(layout_b, {"SUB_B1": [10.0, 20.0], "SUB_B2": [30.0, 40.0]})

        service = RecommenderService()

        # Study 1 — point at layout A and prime the cache.
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = layout_a
            df_a = service._load_layout()
        assert df_a is not None
        assert set(df_a.index) == {"SUB_A1", "SUB_A2"}
        assert service._layout_cache is not None, "Cache should have been primed"

        # Simulate loading a new study: /api/config calls reset() before
        # update_config(). After reset(), the layout cache must be gone.
        service.reset()
        assert service._layout_cache is None, (
            "reset() must clear _layout_cache so the next _load_layout() "
            "reads the fresh layout file for the new study"
        )

        # Study 2 — point at layout B.  The returned DataFrame must
        # contain B's substation IDs, not A's.
        with patch("expert_backend.services.diagram_mixin.config") as cfg:
            cfg.LAYOUT_FILE_PATH = layout_b
            df_b = service._load_layout()
        assert df_b is not None
        assert set(df_b.index) == {"SUB_B1", "SUB_B2"}, (
            "New study must get its own layout DataFrame, not the cached "
            "layout from the previous study"
        )


class TestGetElementMaxCurrents:
    """`_get_element_max_currents` must return `max(|i1|, |i2|)` for every
    line and 2-winding transformer with both currents finite. Rows with
    NaN in `i1` or `i2` are excluded. The path is vectorised (no
    row-by-row Python iteration).
    """

    @staticmethod
    def _make_network(lines_df, trafos_df):
        """Build a MagicMock network matching the pypowsybl API surface
        used by `_get_element_max_currents`."""
        network = MagicMock()
        network.get_lines.return_value = lines_df
        network.get_2_windings_transformers.return_value = trafos_df
        return network

    def test_basic_two_lines_one_trafo(self):
        lines = pd.DataFrame(
            {"i1": [100.0, -250.0], "i2": [110.0, 200.0]},
            index=["L1", "L2"],
        )
        trafos = pd.DataFrame(
            {"i1": [300.0], "i2": [-305.0]},
            index=["T1"],
        )
        mixin = DiagramMixin()
        out = mixin._get_element_max_currents(self._make_network(lines, trafos))

        assert set(out.keys()) == {"L1", "L2", "T1"}
        assert out["L1"] == pytest.approx(110.0)   # max(|100|, |110|)
        assert out["L2"] == pytest.approx(250.0)   # max(|−250|, |200|)
        assert out["T1"] == pytest.approx(305.0)

    def test_excludes_rows_with_nan(self):
        lines = pd.DataFrame(
            {"i1": [100.0, np.nan, 50.0], "i2": [120.0, 80.0, np.nan]},
            index=["ok", "nan_i1", "nan_i2"],
        )
        trafos = pd.DataFrame({"i1": [], "i2": []})
        mixin = DiagramMixin()
        out = mixin._get_element_max_currents(self._make_network(lines, trafos))

        assert out == {"ok": pytest.approx(120.0)}, (
            "Only fully-defined rows should be returned"
        )

    def test_empty_dataframes_returns_empty_dict(self):
        empty = pd.DataFrame({"i1": [], "i2": []})
        mixin = DiagramMixin()
        out = mixin._get_element_max_currents(self._make_network(empty, empty))
        assert out == {}

    def test_narrows_pypowsybl_query_to_i1_i2(self):
        """Both `get_lines` and `get_2_windings_transformers` must be
        called with `attributes=['i1', 'i2']` — not the full column set.

        This mirrors the optimisation already in place for
        `_get_overloaded_lines` (see `diagram_mixin.py:528-545`). Letting
        pypowsybl return all 30 columns and then slicing in pandas wastes
        ~150-300 ms on the 55 k-row PyPSA-EUR France table.
        """
        lines = pd.DataFrame({"i1": [1.0], "i2": [2.0]}, index=["L"])
        trafos = pd.DataFrame({"i1": [3.0], "i2": [4.0]}, index=["T"])
        network = self._make_network(lines, trafos)

        mixin = DiagramMixin()
        mixin._get_element_max_currents(network)

        network.get_lines.assert_called_once_with(attributes=["i1", "i2"])
        network.get_2_windings_transformers.assert_called_once_with(
            attributes=["i1", "i2"]
        )


class TestGetNStateLoading:
    """`_get_n_state_loading` divides the N currents cached with the N
    diagram by the permanent limits — the "before" of each N-1 overload."""

    @staticmethod
    def _network(limits: dict[str, float]):
        network = MagicMock()
        rows = [{"element_id": e, "type": "CURRENT", "acceptable_duration": -1, "value": v}
                for e, v in limits.items()]
        network.get_operational_limits.return_value = (
            pd.DataFrame(rows).set_index(["element_id", "type", "acceptable_duration"])[["value"]])
        return network

    def test_uses_the_currents_cached_with_the_n_diagram(self):
        mixin = DiagramMixin()
        mixin._n_state_currents = {"L1": 87.0, "L2": 30.0}
        out = mixin._get_n_state_loading(self._network({"L1": 100.0, "L2": 60.0}), ["L1", "L2"])
        assert out == [pytest.approx(0.87), pytest.approx(0.5)]

    def test_unknown_before_the_n_diagram(self):
        mixin = DiagramMixin()
        assert mixin._get_n_state_loading(self._network({"L1": 100.0}), ["L1"]) == [None]
