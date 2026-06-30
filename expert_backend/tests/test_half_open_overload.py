# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Issue 3 — annotate the charging-current loading of a half-open overloaded line.

When an action leaves a still-"overloaded" line open at ONE end, the line is out
of service for active power (the SLD / NAD show p = 0) but its capacitance keeps
drawing reactive charging current from the live end, so its current-based loading
stays non-zero (the reported ~33 %). This is physically correct, not a bug — so
we keep the value and surface the live-end reactive power, letting the ActionCard
explain it instead of suppressing it.

Covers the variant-reading seam ``half_open_branch_reactive_from_obs`` and the
gating in ``half_open_overload_notes``. The pure ``build_half_open_reactive``
df→dict is covered in ``test_simulation_helpers.py``.
"""

from unittest.mock import MagicMock

import pandas as pd

from expert_backend.services.simulation_helpers import (
    half_open_branch_reactive_from_obs,
    half_open_overload_notes,
)


def _lines_df(rows: dict) -> pd.DataFrame:
    return pd.DataFrame.from_dict(rows, orient="index")


def _empty_trafos() -> pd.DataFrame:
    return pd.DataFrame(columns=["name", "connected1", "connected2", "q1", "q2"])


def _obs_with_variant(lines_df):
    obs = MagicMock()
    obs._variant_id = "action_var"
    network = MagicMock()
    network.get_working_variant_id.return_value = "orig"
    network.get_lines.return_value = lines_df
    network.get_2_windings_transformers.return_value = _empty_trafos()
    nm = MagicMock()
    nm.network = network
    obs._network_manager = nm
    return obs, nm


class TestHalfOpenBranchReactiveFromObs:
    def test_reads_live_end_reactive_by_id_and_name(self):
        obs, nm = _obs_with_variant(
            _lines_df(
                {
                    "relation_8423569-225": {
                        "name": "MARSIL61PRAGN",
                        "connected1": True, "connected2": False,
                        "q1": -16.8, "q2": 0.0,
                    },
                    "L2": {"name": "L2NAME", "connected1": True, "connected2": True,
                           "q1": 1.0, "q2": -1.0},
                }
            )
        )
        out = half_open_branch_reactive_from_obs(obs)
        assert out["relation_8423569-225"] == 16.8
        assert out["MARSIL61PRAGN"] == 16.8
        assert "L2" not in out  # fully connected → not half open

    def test_switches_to_action_variant_then_restores(self):
        obs, nm = _obs_with_variant(
            _lines_df({"L1": {"name": "L1", "connected1": True, "connected2": True,
                              "q1": 0.0, "q2": 0.0}})
        )
        half_open_branch_reactive_from_obs(obs)
        nm.set_working_variant.assert_any_call("action_var")
        # Shared network always restored to its prior working variant.
        assert nm.set_working_variant.call_args_list[-1].args == ("orig",)

    def test_missing_network_manager_returns_empty(self):
        obs = MagicMock()
        obs._network_manager = None
        obs._variant_id = "action_var"
        assert half_open_branch_reactive_from_obs(obs) == {}


class TestHalfOpenOverloadNotes:
    def test_annotates_half_open_overloaded_line_above_1pct(self):
        obs, _ = _obs_with_variant(
            _lines_df(
                {
                    "MARSIL61PRAGN": {
                        "name": "MARSIL61PRAGN",
                        "connected1": True, "connected2": False,
                        "q1": -16.8, "q2": 0.0,
                    },
                }
            )
        )
        # MARSIL61PRAGN overloaded, now at 33 % (charging current) → annotate.
        notes = half_open_overload_notes(
            obs, ["MARSIL61PRAGN", "L2"], rho_after=[0.333, 0.4]
        )
        assert notes == {"MARSIL61PRAGN": 16.8}

    def test_loading_at_or_below_1pct_is_not_annotated(self):
        obs, _ = _obs_with_variant(
            _lines_df(
                {
                    "L": {"name": "L", "connected1": True, "connected2": False,
                          "q1": -0.2, "q2": 0.0},
                }
            )
        )
        # Half open but loading is only 0.5 % → below the 1 % info threshold.
        notes = half_open_overload_notes(obs, ["L"], rho_after=[0.005])
        assert notes == {}

    def test_fully_connected_overloaded_line_is_not_annotated(self):
        obs, _ = _obs_with_variant(
            _lines_df(
                {"L": {"name": "L", "connected1": True, "connected2": True,
                       "q1": 5.0, "q2": -5.0}}
            )
        )
        notes = half_open_overload_notes(obs, ["L"], rho_after=[1.2])
        assert notes == {}

    def test_no_overloads_returns_empty(self):
        obs, _ = _obs_with_variant(_empty_trafos())
        assert half_open_overload_notes(obs, [], rho_after=[]) == {}
