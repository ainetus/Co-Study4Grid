# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Game Mode solution capitalisation store — services/game_solutions.py
and the POST /api/game/log-solution endpoint.

Pure file-IO layer: no pypowsybl / recommender involvement, so no service
mocks are needed — only a temp store directory via the
COSTUDY4GRID_GAME_SOLUTIONS_DIR environment override.
"""

import json

import pytest
from fastapi.testclient import TestClient

from expert_backend.services import game_solutions


@pytest.fixture
def store_dir(tmp_path, monkeypatch):
    """Repoint the shared solution base at a temp directory."""
    target = tmp_path / "game_solutions"
    monkeypatch.setenv("COSTUDY4GRID_GAME_SOLUTIONS_DIR", str(target))
    return target


@pytest.fixture
def client():
    from expert_backend.main import app
    return TestClient(app)


def payload(**overrides) -> dict:
    base = {
        "player": "alice",
        "session_name": "warmup",
        "study_id": "study-1",
        "study_label": "Study 1",
        "network_path": "data/pypsa_eur_fr225_400/network.xiidm",
        "contingency_id": "relation_9259308_b-225",
        "solved": True,
        "final_max_rho": 0.93,
        "baseline_max_rho": 1.21,
        "actions": [
            {"action_id": "disco_LINE_A", "description": "Ouverture LINE_A",
             "action_type": "disco", "levers": []},
        ],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Signatures
# ---------------------------------------------------------------------------

def test_unitary_signature_falls_back_to_action_id():
    assert game_solutions.unitary_signatures(
        {"action_id": "disco_L1", "levers": []}
    ) == ["action:disco_L1"]


def test_unitary_signature_prefers_levers_sorted_deduped():
    sigs = game_solutions.unitary_signatures(
        {"action_id": "x", "levers": ["redispatch:G2", "redispatch:G1", "redispatch:G2"]}
    )
    assert sigs == ["redispatch:G1", "redispatch:G2"]


def test_unitary_signature_requires_id_or_lever():
    with pytest.raises(ValueError):
        game_solutions.unitary_signatures({"action_id": "", "levers": []})


def test_proposition_signature_is_order_independent():
    a = {"action_id": "a1", "levers": []}
    b = {"action_id": "b1", "levers": ["ls:LOAD_X"]}
    sig_ab, _, _ = game_solutions.proposition_signature([a, b])
    sig_ba, _, _ = game_solutions.proposition_signature([b, a])
    assert sig_ab == sig_ba == "action:a1 + ls:LOAD_X"


def test_context_key_discriminates_grids_and_sanitizes():
    k1 = game_solutions.context_key("data/gridA/network.xiidm", "line 1/2")
    k2 = game_solutions.context_key("data/gridB/network.xiidm", "line 1/2")
    assert k1 != k2
    assert "/" not in k1 and " " not in k1
    assert k1.startswith("gridA_network__line_1_2__")


def test_context_key_disambiguates_sanitization_collisions():
    # 'line 1/2' and 'line 1 2' slug identically — the raw-pair digest must
    # keep the two contexts apart.
    k1 = game_solutions.context_key("data/gridA/network.xiidm", "line 1/2")
    k2 = game_solutions.context_key("data/gridA/network.xiidm", "line 1 2")
    assert k1 != k2
    # Relative vs absolute path to the same grid stays ONE context.
    k3 = game_solutions.context_key("/abs/data/gridA/network.xiidm", "line 1/2")
    assert k1 == k3


def test_network_key_strips_compound_extensions():
    assert game_solutions._network_key("d/grid/network.xiidm.zip") == "grid_network"


# ---------------------------------------------------------------------------
# log_solution — novelty, bonus, dedup, frequencies
# ---------------------------------------------------------------------------

def test_first_retention_is_completely_new_with_lever_bonus(store_dir):
    res = game_solutions.log_solution(payload())
    assert res["stored"] is True
    assert res["duplicate"] is False
    assert res["novelty"]["new_proposition"] is True
    assert res["novelty"]["new_levers"] == ["action:disco_LINE_A"]
    assert res["novelty"]["bonus_points"] == game_solutions.BONUS_NEW_LEVER
    assert res["context_stats"] == {"distinct_propositions": 1, "total_retentions": 1}
    # Frequencies describe the base BEFORE this retention.
    assert res["frequencies"][0]["count"] == 0
    assert res["frequencies"][0]["total"] == 0

    files = list(store_dir.glob("*/*.json"))
    assert len(files) == 1
    record = json.loads(files[0].read_text(encoding="utf-8"))
    assert record["signature"] == "action:disco_LINE_A"
    assert record["retentions"][0]["player"] == "alice"
    assert record["retentions"][0]["solved"] is True


def test_duplicate_retention_appends_and_reports_frequency(store_dir):
    game_solutions.log_solution(payload())
    res = game_solutions.log_solution(payload(player="bob", session_name="s2"))
    assert res["duplicate"] is True
    assert res["novelty"]["new_proposition"] is False
    assert res["novelty"]["bonus_points"] == 0
    freq = res["frequencies"][0]
    assert freq["count"] == 1 and freq["total"] == 1 and freq["share"] == 1.0
    assert res["context_stats"] == {"distinct_propositions": 1, "total_retentions": 2}

    files = list(store_dir.glob("*/*.json"))
    assert len(files) == 1
    record = json.loads(files[0].read_text(encoding="utf-8"))
    assert [r["player"] for r in record["retentions"]] == ["alice", "bob"]


def test_new_combination_of_known_actions_gets_small_bonus(store_dir):
    game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": []}]))
    game_solutions.log_solution(payload(
        actions=[{"action_id": "reco_B", "levers": []}]))
    res = game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": []},
                 {"action_id": "reco_B", "levers": []}]))
    assert res["novelty"]["new_proposition"] is True
    assert res["novelty"]["new_levers"] == []
    assert res["novelty"]["bonus_points"] == game_solutions.BONUS_NEW_COMBINATION


def test_injection_lever_novelty_ignores_magnitude(store_dir):
    # Two redispatches on the SAME generator with different MW → same lever,
    # therefore the second proposition is a known one (dedup), not novel.
    game_solutions.log_solution(payload(
        actions=[{"action_id": "redispatch_G1_50MW",
                  "action_type": "redispatch", "levers": ["redispatch:G1"]}]))
    res = game_solutions.log_solution(payload(
        actions=[{"action_id": "redispatch_G1_120MW",
                  "action_type": "redispatch", "levers": ["redispatch:G1"]}]))
    assert res["duplicate"] is True
    assert res["novelty"]["bonus_points"] == 0

    # A redispatch on a NEW generator is a new lever → full bonus.
    res2 = game_solutions.log_solution(payload(
        actions=[{"action_id": "redispatch_G2_50MW",
                  "action_type": "redispatch", "levers": ["redispatch:G2"]}]))
    assert res2["novelty"]["new_levers"] == ["redispatch:G2"]
    assert res2["novelty"]["bonus_points"] == game_solutions.BONUS_NEW_LEVER


def test_frequency_counts_actions_within_larger_propositions(store_dir):
    game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": []},
                 {"action_id": "reco_B", "levers": []}]))
    game_solutions.log_solution(payload(
        player="bob",
        actions=[{"action_id": "disco_A", "levers": []}]))
    res = game_solutions.log_solution(payload(
        player="carol",
        actions=[{"action_id": "disco_A", "levers": []}]))
    freq = res["frequencies"][0]
    # disco_A appeared in both past propositions (2 retentions in total).
    assert freq["count"] == 2 and freq["total"] == 2


def test_contexts_are_isolated_per_contingency(store_dir):
    game_solutions.log_solution(payload())
    res = game_solutions.log_solution(payload(contingency_id="other_line"))
    assert res["novelty"]["new_proposition"] is True
    assert res["novelty"]["bonus_points"] == game_solutions.BONUS_NEW_LEVER


def test_corrupt_record_is_skipped(store_dir):
    first = game_solutions.log_solution(payload())
    ctx_dir = store_dir / first["context_key"]
    (ctx_dir / "corrupt.json").write_text("{not json", encoding="utf-8")
    res = game_solutions.log_solution(payload(player="bob"))
    assert res["duplicate"] is True
    assert res["context_stats"]["total_retentions"] == 2


def test_empty_actions_rejected(store_dir):
    with pytest.raises(ValueError):
        game_solutions.log_solution(payload(actions=[]))


def test_missing_contingency_rejected(store_dir):
    with pytest.raises(ValueError):
        game_solutions.log_solution(payload(contingency_id="  "))


def test_concurrent_retentions_are_neither_lost_nor_double_bonused(store_dir):
    # The store lock + atomic write must make N simultaneous commits of the
    # same proposition yield exactly ONE novelty verdict and N retentions.
    import threading

    results = []
    barrier = threading.Barrier(8)

    def worker(i):
        barrier.wait()
        results.append(game_solutions.log_solution(payload(player=f"p{i}")))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    novel = [r for r in results if r["novelty"]["new_proposition"]]
    assert len(novel) == 1
    files = list(store_dir.glob("*/*.json"))
    assert len(files) == 1
    record = json.loads(files[0].read_text(encoding="utf-8"))
    assert len(record["retentions"]) == 8


def test_solutions_dir_env_cascade(tmp_path, monkeypatch):
    monkeypatch.delenv("COSTUDY4GRID_GAME_SOLUTIONS_DIR", raising=False)
    monkeypatch.setenv("COSTUDY4GRID_DATA_DIR", str(tmp_path / "data"))
    assert game_solutions.solutions_dir() == tmp_path / "data" / "game_solutions"
    monkeypatch.setenv("COSTUDY4GRID_GAME_SOLUTIONS_DIR", str(tmp_path / "explicit"))
    assert game_solutions.solutions_dir() == tmp_path / "explicit"


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

def test_endpoint_logs_and_reports_novelty(store_dir, client):
    resp = client.post("/api/game/log-solution", json=payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["novelty"]["new_proposition"] is True
    assert body["novelty"]["bonus_points"] == game_solutions.BONUS_NEW_LEVER

    resp2 = client.post("/api/game/log-solution", json=payload(player="bob"))
    assert resp2.json()["duplicate"] is True


def test_endpoint_rejects_empty_actions(store_dir, client):
    resp = client.post("/api/game/log-solution", json=payload(actions=[]))
    assert resp.status_code == 400
    assert resp.json()["code"] == "BAD_REQUEST"


def test_endpoint_validates_required_fields(store_dir, client):
    resp = client.post("/api/game/log-solution", json={"actions": []})
    assert resp.status_code == 422
