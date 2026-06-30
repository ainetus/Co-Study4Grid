# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Issue 3 — action card loading coherence with the SLD / NAD diagrams.

When an action disconnects an overloaded line, grid2op's forecast ``obs.rho``
can stay non-zero (a backend obs-vs-variant desync) so the card showed e.g.
33 % on a line the diagrams correctly draw with zero flow. The fix reads the
post-action variant connectivity (the same state the diagrams read) and zeros
those loadings.

These tests cover the variant-reading seam ``disconnected_branch_names_from_obs``;
the pure ``compute_action_metrics`` / ``build_branch_connectivity`` zeroing is
covered in ``test_simulation_helpers.py``.
"""

from unittest.mock import MagicMock

import pandas as pd

from expert_backend.services.simulation_helpers import disconnected_branch_names_from_obs


def _lines_df(rows: dict) -> pd.DataFrame:
    return pd.DataFrame.from_dict(rows, orient="index")


def _empty_trafos() -> pd.DataFrame:
    return pd.DataFrame(columns=["name", "connected1", "connected2"])


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


class TestDisconnectedBranchNamesFromObs:
    def test_reads_disconnected_branches_by_id_and_name(self):
        obs, nm = _obs_with_variant(
            _lines_df(
                {
                    "relation_8423569-225": {
                        "name": "MARSIL61PRAGN", "connected1": True, "connected2": False,
                    },
                    "L2": {"name": "L2NAME", "connected1": True, "connected2": True},
                }
            )
        )

        names = disconnected_branch_names_from_obs(obs)

        # Disconnected line reachable by both IIDM id and grid2op/operator name.
        assert "MARSIL61PRAGN" in names
        assert "relation_8423569-225" in names
        # Connected line absent.
        assert "L2" not in names
        assert "L2NAME" not in names

    def test_switches_to_action_variant_then_restores(self):
        obs, nm = _obs_with_variant(
            _lines_df({"L1": {"name": "L1", "connected1": True, "connected2": True}})
        )

        disconnected_branch_names_from_obs(obs)

        nm.set_working_variant.assert_any_call("action_var")
        # The shared network is always restored to its prior working variant.
        assert nm.set_working_variant.call_args_list[-1].args == ("orig",)

    def test_missing_network_manager_returns_empty(self):
        obs = MagicMock()
        obs._network_manager = None
        obs._variant_id = "action_var"
        assert disconnected_branch_names_from_obs(obs) == set()
