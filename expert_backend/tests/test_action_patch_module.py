# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the MPL was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Coverage for ``services/diagram/action_patch.py``.

The action-variant patch pipeline (``/api/action-variant-diagram-patch``)
moved out of ``diagram_mixin.py`` into its own module to keep the
mixin under the function-LoC ceiling. The existing
``test_diagram_patch_helpers.py`` already covers the two pure helpers
(``compute_vl_topology_diff`` + ``get_disconnected_branches_from_snapshot``)
through the static-method wrappers on ``DiagramMixin``. This file
covers what the extraction added or moved:

* The direct import path (the helpers are now publicly importable
  from the new module — host code should prefer this over the mixin
  wrappers).
* The three new private orchestrator helpers:
  ``_extract_convergence_status``, ``_capture_action_snapshots``,
  ``_unpatchable_response``.
* ``extract_vl_subtrees_with_edges`` — exercised with a
  ``generate_diagram`` callable now that the NAD-generation seam is
  injected rather than read off ``self``.
* The early-return paths of ``build_action_patch_payload``
  (no-analysis-result / action-not-in-last-result). The happy path
  needs heavy pypowsybl machinery and is covered end-to-end by the
  integration tests; here we just check the soft-fail contract that
  the React frontend relies on.
"""
from __future__ import annotations

import pandas as pd
import pytest
from unittest.mock import MagicMock

from expert_backend.services.diagram.action_patch import (
    _capture_action_snapshots,
    _extract_convergence_status,
    _unpatchable_response,
    build_action_patch_payload,
    compute_vl_topology_diff,
    extract_vl_subtrees_with_edges,
    get_disconnected_branches_from_snapshot,
)


# ---------------------------------------------------------------------
# Public re-export — guards the contract that host code can import
# the helpers directly without going through the mixin wrappers.
# ---------------------------------------------------------------------

class TestPublicSurface:
    def test_pure_helpers_are_directly_importable(self):
        # The two pure helpers stay re-exported as static methods on
        # DiagramMixin for the existing test_diagram_patch_helpers
        # suite, but new callers should be able to use the module path.
        assert callable(compute_vl_topology_diff)
        assert callable(get_disconnected_branches_from_snapshot)

    def test_orchestrator_is_directly_importable(self):
        assert callable(build_action_patch_payload)
        assert callable(extract_vl_subtrees_with_edges)


# ---------------------------------------------------------------------
# _extract_convergence_status
# ---------------------------------------------------------------------

class TestExtractConvergenceStatus:
    def test_converged_when_no_exception(self):
        obs = MagicMock()
        obs._last_info = {"exception": None}
        lf_converged, lf_status, non_convergence = _extract_convergence_status(obs)
        assert lf_converged is True
        assert lf_status == "CONVERGED"
        assert non_convergence is None

    def test_missing_last_info_treated_as_converged(self):
        # Some upstream code paths don't stamp ``_last_info`` on the
        # observation at all. The helper must tolerate that — the
        # downstream payload would otherwise crash before the
        # frontend can fall back.
        obs = MagicMock(spec=[])  # no attributes at all
        lf_converged, lf_status, non_convergence = _extract_convergence_status(obs)
        assert lf_converged is True
        assert lf_status == "CONVERGED"
        assert non_convergence is None

    def test_single_exception_serialized_as_string(self):
        obs = MagicMock()
        obs._last_info = {"exception": ValueError("boom")}
        lf_converged, lf_status, non_convergence = _extract_convergence_status(obs)
        assert lf_converged is False
        assert "boom" in non_convergence
        assert lf_status == non_convergence

    def test_list_of_exceptions_joined_with_semicolon(self):
        # grid2op / pypowsybl wrappers sometimes return a list of
        # exceptions in ``info["exception"]``. The helper joins them
        # into a single human-readable string for the LF-status field
        # the React UI surfaces under each action card.
        obs = MagicMock()
        obs._last_info = {"exception": [ValueError("a"), RuntimeError("b")]}
        _, lf_status, non_convergence = _extract_convergence_status(obs)
        assert "a" in non_convergence and "b" in non_convergence
        assert "; " in non_convergence
        assert lf_status == non_convergence


# ---------------------------------------------------------------------
# _capture_action_snapshots
# ---------------------------------------------------------------------

class TestCaptureActionSnapshots:
    def test_happy_path_returns_five_snapshots(self):
        action_network = MagicMock()
        lines_df = pd.DataFrame(
            {"connected1": [True, False], "connected2": [True, True]},
            index=["L1", "L2"],
        )
        trafos_df = pd.DataFrame({"connected1": [True], "connected2": [True]}, index=["T1"])
        buses_df = pd.DataFrame({"voltage_level_id": ["VL1", "VL2"]}, index=["B1", "B2"])
        action_network.get_lines.return_value = lines_df
        action_network.get_2_windings_transformers.return_value = trafos_df
        action_network.get_buses.return_value = buses_df

        service = MagicMock()
        service._get_network_flows.return_value = {"p1": {"L1": 1.0}}
        service._get_asset_flows.return_value = {"GEN1": 50.0}

        snaps = _capture_action_snapshots(service, action_network)
        assert set(snaps.keys()) == {"lines_conn", "trafos_conn", "buses", "flows", "assets"}
        # ``.copy()`` discipline: the captured DataFrames must be a
        # fresh copy so a subsequent variant switch on the shared
        # network doesn't poison them.
        assert snaps["lines_conn"].equals(lines_df)
        assert snaps["lines_conn"] is not lines_df
        assert snaps["flows"] == {"p1": {"L1": 1.0}}
        assert snaps["assets"] == {"GEN1": 50.0}

    def test_each_snapshot_failure_independently_yields_none(self):
        # Pypowsybl can raise on any individual frame; the helper must
        # isolate failures so a single bad query doesn't prevent the
        # patch endpoint from soft-failing with a useful payload.
        action_network = MagicMock()
        action_network.get_lines.side_effect = RuntimeError("get_lines boom")
        action_network.get_2_windings_transformers.return_value = pd.DataFrame(
            {"connected1": [True], "connected2": [True]}, index=["T1"],
        )
        action_network.get_buses.side_effect = RuntimeError("get_buses boom")
        service = MagicMock()
        service._get_network_flows.return_value = {"p1": {}}
        service._get_asset_flows.side_effect = RuntimeError("assets boom")

        snaps = _capture_action_snapshots(service, action_network)
        assert snaps["lines_conn"] is None
        assert snaps["trafos_conn"] is not None
        assert snaps["buses"] is None
        assert snaps["flows"] == {"p1": {}}
        assert snaps["assets"] is None


# ---------------------------------------------------------------------
# _unpatchable_response
# ---------------------------------------------------------------------

class TestUnpatchableResponse:
    def test_carries_the_fixed_reason_and_supplied_metadata(self):
        out = _unpatchable_response(
            action_id="a1", lf_converged=True, lf_status="CONVERGED",
            non_convergence=None,
        )
        assert out == {
            "patchable": False,
            "reason": "vl_topology_changed",
            "action_id": "a1",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
        }

    def test_propagates_non_convergence_string(self):
        out = _unpatchable_response(
            action_id="a2", lf_converged=False, lf_status="boom; bang",
            non_convergence="boom; bang",
        )
        assert out["lf_converged"] is False
        assert out["non_convergence"] == "boom; bang"
        assert out["lf_status"] == "boom; bang"


# ---------------------------------------------------------------------
# extract_vl_subtrees_with_edges — uses the injected callable seam
# ---------------------------------------------------------------------

class TestExtractVlSubtreesWithEdges:
    def test_returns_empty_when_no_vl_ids(self):
        # No VL needs a sub-NAD → no work, no calls.
        gen = MagicMock()
        out = extract_vl_subtrees_with_edges(
            action_network=MagicMock(), vl_ids=[], generate_diagram=gen,
        )
        assert out == {}
        gen.assert_not_called()

    def test_uses_injected_generate_diagram_for_each_vl(self):
        # The helper used to read ``self._generate_diagram``; the
        # extraction swapped that for a callable kwarg. Smoke-check
        # that the callable is invoked with the right shape (depth=1
        # focused sub-NAD per VL).
        gen = MagicMock(return_value={"svg": "", "metadata": "{}"})
        out = extract_vl_subtrees_with_edges(
            action_network=MagicMock(),
            vl_ids=["VL_A", "VL_B"],
            generate_diagram=gen,
        )
        assert gen.call_count == 2
        for call_args in gen.call_args_list:
            assert call_args.kwargs["depth"] == 1
            assert isinstance(call_args.kwargs["voltage_level_ids"], list)
            assert len(call_args.kwargs["voltage_level_ids"]) == 1
        # Empty svg / metadata → nothing extractable, but the helper
        # must NOT raise — the orchestrator handles the partial result.
        assert out == {}

    def test_per_vl_failure_is_swallowed(self):
        # If pypowsybl raises for VL_B, VL_A's subtree must still be
        # returned (the orchestrator's "len(subtrees) != len(vl_diff)"
        # gate decides whether to fall back to the full NAD).
        gen = MagicMock(side_effect=[
            {"svg": "", "metadata": "{}"},  # VL_A: empty (no actual SVG)
            RuntimeError("VL_B exploded"),  # VL_B: hard failure
        ])
        out = extract_vl_subtrees_with_edges(
            action_network=MagicMock(),
            vl_ids=["VL_A", "VL_B"],
            generate_diagram=gen,
        )
        # Both VLs attempted; result dict size determined by what we
        # could extract (here zero — empty svg → no <g id> match —
        # but no exception bubbled up).
        assert gen.call_count == 2
        assert isinstance(out, dict)


# ---------------------------------------------------------------------
# build_action_patch_payload — early-return contract
# ---------------------------------------------------------------------

class TestBuildActionPatchPayloadEarlyReturns:
    """The patch endpoint MUST soft-fail with
    ``patchable: false`` (not raise) on the two "no usable cached
    action" cases so the React frontend can fall back to the full
    NAD without surfacing a 400 to the operator."""

    def test_soft_fails_when_no_analysis_result(self):
        service = MagicMock()
        service._last_result = None
        out = build_action_patch_payload(service, "any_action")
        assert out["patchable"] is False
        assert out["reason"] == "no-analysis-result"
        assert out["action_id"] == "any_action"

    def test_soft_fails_when_last_result_has_no_prioritized_actions(self):
        service = MagicMock()
        service._last_result = {}  # missing the key
        out = build_action_patch_payload(service, "x")
        assert out["patchable"] is False
        assert out["reason"] == "no-analysis-result"

    def test_soft_fails_when_action_id_not_in_last_result(self):
        service = MagicMock()
        service._last_result = {"prioritized_actions": {"a1": {}}}
        out = build_action_patch_payload(service, "a2")
        assert out["patchable"] is False
        assert out["reason"] == "action-not-in-last-result"
        assert out["action_id"] == "a2"
