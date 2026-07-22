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


def test_bonus_values_are_20_and_10():
    assert game_solutions.BONUS_NEW_LEVER == 20
    assert game_solutions.BONUS_NEW_COMBINATION == 10


def test_ineffective_proposition_is_novel_but_earns_no_bonus(store_dir):
    res = game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": [], "effective": False}]))
    assert res["novelty"]["new_proposition"] is True
    assert res["novelty"]["effective"] is False
    assert res["novelty"]["bonus_points"] == 0


def test_one_ineffective_action_blocks_the_bonus(store_dir):
    res = game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": [], "effective": True},
                 {"action_id": "reco_B", "levers": [], "effective": False}]))
    assert res["novelty"]["new_proposition"] is True
    assert res["novelty"]["effective"] is False
    assert res["novelty"]["bonus_points"] == 0
    # The stored record keeps the per-action effectiveness for audit.
    files = list(store_dir.glob("*/*.json"))
    record = json.loads(files[0].read_text(encoding="utf-8"))
    assert [a["effective"] for a in record["actions"]] == [True, False]


def test_effective_actions_earn_the_bonus(store_dir):
    res = game_solutions.log_solution(payload(
        actions=[{"action_id": "disco_A", "levers": [], "effective": True}]))
    assert res["novelty"]["effective"] is True
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
# Writable-base fallback (a not-yet-mounted / read-only bucket must not 500)
# ---------------------------------------------------------------------------

def _wire_unwritable_preferred(tmp_path, monkeypatch):
    """Point the preferred base at an uncreatable path (parent is a file) and
    redirect the repo-local fallback into the temp dir."""
    monkeypatch.setattr(game_solutions, "_PROJECT_ROOT", tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setenv("COSTUDY4GRID_GAME_SOLUTIONS_DIR", str(blocker / "nested"))
    game_solutions._EFFECTIVE_FALLBACK_WARNED.clear()


def test_effective_base_dir_falls_back_when_unwritable(tmp_path, monkeypatch):
    _wire_unwritable_preferred(tmp_path, monkeypatch)
    assert game_solutions._effective_base_dir() == tmp_path / "game_solutions"


def test_log_solution_survives_unwritable_preferred_base(tmp_path, monkeypatch):
    _wire_unwritable_preferred(tmp_path, monkeypatch)
    res = game_solutions.log_solution(payload())
    assert res["stored"] is True
    # Landed in the repo-local fallback, not the unwritable preferred base.
    files = list((tmp_path / "game_solutions").glob("*/*.json"))
    assert len(files) == 1


# ---------------------------------------------------------------------------
# player_session_count — default session-name / index seed
# ---------------------------------------------------------------------------

def test_player_session_count_counts_distinct_sessions(store_dir):
    game_solutions.log_solution(payload(player="alice", session_name="s1"))
    # Same session, different proposition (same contingency) → still one session.
    game_solutions.log_solution(payload(player="alice", session_name="s1",
        actions=[{"action_id": "reco_B", "levers": []}]))
    # A second session on another contingency.
    game_solutions.log_solution(payload(player="alice", session_name="s2",
        contingency_id="other_line"))
    game_solutions.log_solution(payload(player="bob", session_name="s9"))

    assert game_solutions.player_session_count("alice") == {
        "player": "alice", "session_count": 2}
    # Handle match is case-insensitive.
    assert game_solutions.player_session_count("ALICE")["session_count"] == 2
    assert game_solutions.player_session_count("bob")["session_count"] == 1
    assert game_solutions.player_session_count("carol")["session_count"] == 0


def test_player_session_count_empty_handle(store_dir):
    assert game_solutions.player_session_count("  ") == {
        "player": "", "session_count": 0}


# ---------------------------------------------------------------------------
# lever_stats — beginner-assistance hints
# ---------------------------------------------------------------------------

def test_lever_category_mapping():
    cat = game_solutions._lever_category
    assert cat("redispatch:G1") == "generation"
    assert cat("rc:WIND_1") == "generation"
    assert cat("gen_p:G2") == "generation"
    assert cat("ls:LOAD_1") == "load"
    assert cat("load_p:LOAD_2") == "load"
    assert cat("switch:VL1_COUPL=true") == "voltage_level"
    assert cat("pst:PST_A") == "branch"
    assert cat("action:disco_LINE_A") == "branch"
    assert cat("action:reco_LINE_B") == "branch"
    assert cat("action:open_coupler_VL_X") == "voltage_level"
    assert cat("action:mystery") == "other"


def test_lever_label_strips_prefix_and_switch_state():
    assert game_solutions._lever_label("redispatch:G1") == "G1"
    assert game_solutions._lever_label("switch:VL1_COUPL=true") == "VL1_COUPL"
    assert game_solutions._lever_label("action:disco_LINE_A") == "disco_LINE_A"


def test_lever_stats_ranks_by_retention_weight(store_dir):
    # disco_LINE_A retained twice (two players), redispatch once.
    game_solutions.log_solution(payload())
    game_solutions.log_solution(payload(player="bob"))
    game_solutions.log_solution(payload(
        player="carol",
        actions=[{"action_id": "redispatch_G1_50MW", "action_type": "redispatch",
                  "description": "Redispatch G1", "levers": ["redispatch:G1"]}]))

    stats = game_solutions.lever_stats(
        payload()["network_path"], payload()["contingency_id"])
    assert stats["total_retentions"] == 3
    assert [lever["signature"] for lever in stats["levers"]] == [
        "action:disco_LINE_A", "redispatch:G1"]
    top = stats["levers"][0]
    assert top["count"] == 2
    assert top["share"] == pytest.approx(2 / 3)
    assert top["category"] == "branch"
    assert top["label"] == "disco_LINE_A"
    assert top["sample_description"] == "Ouverture LINE_A"
    assert stats["levers"][1]["category"] == "generation"


def test_lever_stats_caps_at_top_n(store_dir):
    for i in range(7):
        game_solutions.log_solution(payload(
            actions=[{"action_id": f"disco_L{i}", "levers": []}]))
    stats = game_solutions.lever_stats(
        payload()["network_path"], payload()["contingency_id"], top_n=5)
    assert len(stats["levers"]) == 5


def test_lever_stats_empty_context(store_dir):
    stats = game_solutions.lever_stats("data/grid/network.xiidm", "never_played")
    assert stats["total_retentions"] == 0
    assert stats["levers"] == []


def test_lever_stats_requires_contingency(store_dir):
    with pytest.raises(ValueError):
        game_solutions.lever_stats("net.xiidm", "  ")


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


def test_lever_stats_endpoint(store_dir, client):
    client.post("/api/game/log-solution", json=payload())
    resp = client.get("/api/game/lever-stats", params={
        "network_path": payload()["network_path"],
        "contingency_id": payload()["contingency_id"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_retentions"] == 1
    assert body["levers"][0]["signature"] == "action:disco_LINE_A"
    assert body["levers"][0]["category"] == "branch"

    missing = client.get("/api/game/lever-stats", params={"contingency_id": " "})
    assert missing.status_code == 400


def test_player_sessions_endpoint(store_dir, client):
    client.post("/api/game/log-solution", json=payload(player="alice", session_name="s1"))
    client.post("/api/game/log-solution", json=payload(
        player="alice", session_name="s2", contingency_id="c2"))
    resp = client.get("/api/game/player-sessions", params={"player": "alice"})
    assert resp.status_code == 200
    assert resp.json() == {"player": "alice", "session_count": 2}

    empty = client.get("/api/game/player-sessions", params={"player": ""})
    assert empty.json() == {"player": "", "session_count": 0}
