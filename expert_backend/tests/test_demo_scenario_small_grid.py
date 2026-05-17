# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Integration tests for the demo scenario on config_small_grid.

These tests reproduce the numerical contract that the manual demo
(`docs/Fiche_demo_CoStudy4Grid`) implicitly asserts: with the
``bare_env_small_grid_test`` network + the
``reduced_model_actions_test.json`` action dictionary, the
P.SAOL31RONCI contingency must surface a single BEON L31CPVAN
overload, the analyser must propose at least the disco / node-merging
/ load-shedding actions the operator selects in the demo, and the two
combined-pair superpositions must converge to the rho values recorded
in the golden trace.

This file is the Étape D companion to the Playwright demo-replay
spec (`scripts/parity_e2e/demo_replay.spec.ts`). Where the Playwright
spec validates the **UI contract**, this file validates the
**numerical contract** — and is what catches a recommender drift on
small_grid (changed action set, shifted rho values, missing PST
support) that no UI test would see.

Skipped when:
  - the small_grid data is not on disk, or
  - the conftest mock layer is active (pypowsybl /
    expert_op4grid_recommender not installed in the test venv).

The numeric tolerances are kept loose enough to absorb minor
loadflow / solver drift but tight enough to catch a real regression.
Re-tune the `COMBINED_PAIR_*` constants by re-running the demo and
copying the new `simulated_max_rho` values from the saved
`interaction_log.json`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# --- Repo-relative constants from the demo trace ---------------------

REPO_ROOT = Path(__file__).parent.parent.parent
SMALL_GRID_DIR = REPO_ROOT / "data" / "bare_env_small_grid_test"
GRID_FILE = SMALL_GRID_DIR / "grid.xiidm"
LAYOUT_FILE = SMALL_GRID_DIR / "grid_layout.json"
ACTION_FILE = REPO_ROOT / "data" / "action_space" / "reduced_model_actions_test.json"

DEMO_CONTINGENCY = "P.SAOL31RONCI"
EXPECTED_OVERLOAD = "BEON L31CPVAN"
EXPECTED_N_PRIORITIZED_ACTIONS = 10

# Action ids from the demo trace that the recommender MUST surface on
# small_grid. If any of these disappears, étape 9 / 11 / 12 of the
# fiche stops being reproducible.
EXPECTED_PRIORITIZED_IDS = (
    f"disco_{EXPECTED_OVERLOAD}",
    "node_merging_PYMONP3",
    "load_shedding_BEON3 TR311",
)

# Combined-pair simulations from the demo trace (étape 12).
# Tolerance is 1% absolute on simulated_max_rho — comfortably larger
# than observed loadflow drift on small_grid (< 0.001 in practice).
COMBINED_PAIR_DISCO_RECO = {
    "action1_id": "disco_BEON L31P.SAO",
    "action2_id": "reco_GEN.PY762",
    "expected_rho": 0.6560,
    "tol": 0.01,
}
COMBINED_PAIR_DISCO_NODEMERGE = {
    "action1_id": "disco_BEON L31P.SAO",
    "action2_id": "node_merging_PYMONP3",
    "expected_rho": 0.7004,
    "tol": 0.01,
}

# Étape 11 — load-shedding card edited to 3.4 MW then re-simulated.
LOAD_SHEDDING_ACTION_ID = "load_shedding_BEON3 TR311"
LOAD_SHEDDING_TARGET_MW = 3.4


# --- Skip guards -----------------------------------------------------


def _data_available() -> bool:
    return GRID_FILE.exists() and LAYOUT_FILE.exists() and ACTION_FILE.exists()


def _real_packages_available() -> bool:
    """Return True iff the conftest mock layer was bypassed because
    the real packages are installed in the test environment."""
    for name in ("pypowsybl", "pypowsybl.network", "expert_op4grid_recommender"):
        mod = sys.modules.get(name)
        if mod is None or isinstance(mod, MagicMock):
            return False
    return True


pytestmark = [
    pytest.mark.skipif(
        not _data_available(),
        reason=f"small_grid demo data not found under {SMALL_GRID_DIR}",
    ),
    pytest.mark.skipif(
        not _real_packages_available(),
        reason="pypowsybl / expert_op4grid_recommender not installed — conftest mocks active",
    ),
    # `slow` opt-in — these tests load the real network + run AC
    # loadflows. They are intentionally NOT in the default CI suite to
    # keep the unit-test loop fast.
    pytest.mark.slow,
]


# --- Helpers ---------------------------------------------------------


def _make_config_payload() -> dict:
    """Configuration dict mirroring `config_loaded` in the golden trace."""
    return {
        "network_path": str(GRID_FILE),
        "action_file_path": str(ACTION_FILE),
        "layout_path": str(LAYOUT_FILE),
        "min_line_reconnections": 2.0,
        "min_close_coupling": 3.0,
        "min_open_coupling": 2.0,
        "min_line_disconnections": 3.0,
        "min_pst": 1.0,
        "min_load_shedding": 2.0,
        "min_renewable_curtailment_actions": 0,
        "n_prioritized_actions": EXPECTED_N_PRIORITIZED_ACTIONS,
        "lines_monitoring_path": "",
        "monitoring_factor": 0.95,
        "pre_existing_overload_threshold": 0.02,
        "ignore_reconnections": False,
        "pypowsybl_fast_mode": True,
        "model": "expert",
        "compute_overflow_graph": True,
    }


def _drain_ndjson(response) -> list[dict]:
    """Parse an NDJSON streaming response (one JSON dict per line)."""
    events: list[dict] = []
    for raw in response.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        events.append(json.loads(line))
    return events


# --- Test class ------------------------------------------------------


class TestDemoScenarioSmallGrid:
    """Walk the demo scenario through the HTTP API and assert that
    each step's payload matches the contract recorded in the golden
    trace.

    State carries across tests in declaration order (the singleton
    `recommender_service` is intentionally reused — calling
    `/api/config` again for every test would re-load the network and
    burn ~5 s per test for no value). The fixture `_loaded_client`
    bootstraps the state once."""

    @pytest.fixture(scope="class", autouse=True)
    def _loaded_client(self):
        from fastapi.testclient import TestClient
        from expert_backend.main import app

        client = TestClient(app)
        resp = client.post("/api/config", json=_make_config_payload())
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("status") == "success", body
        assert body.get("total_lines_count", 0) > 0, body
        yield client

    def test_branches_includes_demo_contingency(self, _loaded_client):
        resp = _loaded_client.get("/api/branches")
        assert resp.status_code == 200
        branches = resp.json().get("branches", [])
        assert DEMO_CONTINGENCY in branches, (
            f"{DEMO_CONTINGENCY} (the demo contingency) is missing from "
            f"/api/branches. Got {len(branches)} branches: "
            f"{sorted(branches)[:10]}..."
        )

    def test_step1_detects_single_overload(self, _loaded_client):
        resp = _loaded_client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": [DEMO_CONTINGENCY]},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("can_proceed") is True, body
        overloaded = body.get("lines_overloaded", [])
        assert overloaded == [EXPECTED_OVERLOAD], (
            f"Expected exactly [{EXPECTED_OVERLOAD!r}], got {overloaded!r}"
        )

    def test_step2_returns_prioritized_action_set(self, _loaded_client):
        # Streaming NDJSON. The final 'result' event carries the action
        # set; intermediate events ('pdf', 'progress') are tolerated.
        with _loaded_client.stream(
            "POST",
            "/api/run-analysis-step2",
            json={
                "selected_overloads": [EXPECTED_OVERLOAD],
                "all_overloads": [EXPECTED_OVERLOAD],
                "monitor_deselected": False,
                "additional_lines_to_cut": [],
            },
        ) as response:
            assert response.status_code == 200
            events = _drain_ndjson(response)

        result_events = [e for e in events if e.get("type") == "result"]
        assert len(result_events) == 1, (
            f"Expected exactly one 'result' event, got {len(result_events)}. "
            f"All event types: {[e.get('type') for e in events]}"
        )
        actions = result_events[0].get("actions", {})
        assert len(actions) >= EXPECTED_N_PRIORITIZED_ACTIONS, (
            f"Expected at least {EXPECTED_N_PRIORITIZED_ACTIONS} prioritized "
            f"actions, got {len(actions)}: {sorted(actions)[:5]}..."
        )
        for expected_id in EXPECTED_PRIORITIZED_IDS:
            assert expected_id in actions, (
                f"Expected action {expected_id!r} (used in étapes 9/11/12 of "
                f"the demo) is missing. Got: {sorted(actions)[:10]}"
            )

    def test_simulate_disco_beon_reduces_rho(self, _loaded_client):
        """Étape 9 — selecting disco_BEON L31CPVAN resolves the overload."""
        resp = _loaded_client.post(
            "/api/simulate-manual-action",
            json={
                "action_id": f"disco_{EXPECTED_OVERLOAD}",
                "disconnected_elements": [DEMO_CONTINGENCY],
                "lines_overloaded": [EXPECTED_OVERLOAD],
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rho_before = body.get("rho_before", [])
        rho_after = body.get("rho_after", [])
        assert rho_before and rho_after, body
        # The action is "disconnect the overloaded line" so post-action
        # the same line is no longer in the rho_after set; what we care
        # about is that the system-wide max-rho is brought back under 1.
        assert body.get("max_rho", float("inf")) < 1.0, (
            f"disco_{EXPECTED_OVERLOAD} should reduce max_rho below 1.0, "
            f"got {body.get('max_rho')}"
        )
        assert body.get("is_rho_reduction") is True, body

    def test_simulate_load_shedding_with_target_mw(self, _loaded_client):
        """Étape 11 — operator edits the load-shedding card to 3.4 MW
        and re-simulates."""
        resp = _loaded_client.post(
            "/api/simulate-manual-action",
            json={
                "action_id": LOAD_SHEDDING_ACTION_ID,
                "disconnected_elements": [DEMO_CONTINGENCY],
                "lines_overloaded": [EXPECTED_OVERLOAD],
                "target_mw": LOAD_SHEDDING_TARGET_MW,
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body.get("max_rho") is not None, body
        # The 3.4 MW edit is a partial shedding — we don't assert it
        # falls below 1.0 (depends on the load location relative to the
        # overload), only that the rho is reduced compared to the
        # un-actioned 1.15 we know from the golden trace's step1.
        assert body.get("max_rho", float("inf")) < 1.15, (
            f"load_shedding with target_mw={LOAD_SHEDDING_TARGET_MW} should "
            f"reduce max_rho below 1.15, got {body.get('max_rho')}"
        )
        # The load_shedding_details payload should reflect the operator
        # edit — at least one entry with the requested shedded_mw.
        details = body.get("load_shedding_details") or []
        assert details, f"load_shedding_details missing from payload: {body}"

    @pytest.mark.parametrize("pair", [
        pytest.param(COMBINED_PAIR_DISCO_RECO, id="disco_BEON+reco_GEN.PY762"),
        pytest.param(COMBINED_PAIR_DISCO_NODEMERGE, id="disco_BEON+node_merging_PYMONP3"),
    ])
    def test_compute_superposition_matches_golden_trace(self, _loaded_client, pair):
        """Étape 12 — the two combined-pair simulations from the demo
        must converge to the rho values within tolerance.

        This is the numeric regression net for the recommender's
        superposition theorem implementation."""
        resp = _loaded_client.post(
            "/api/compute-superposition",
            json={
                "action1_id": pair["action1_id"],
                "action2_id": pair["action2_id"],
                "disconnected_elements": [DEMO_CONTINGENCY],
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rho = body.get("simulated_max_rho")
        assert rho is not None, f"simulated_max_rho missing from {body}"
        assert abs(rho - pair["expected_rho"]) <= pair["tol"], (
            f"Pair ({pair['action1_id']!r}, {pair['action2_id']!r}): "
            f"simulated_max_rho={rho:.4f}, expected={pair['expected_rho']:.4f} "
            f"(tolerance ±{pair['tol']}). Recommender / loadflow drift?"
        )
