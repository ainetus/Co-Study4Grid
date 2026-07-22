# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Tests for the France THT game-mode tooling: the difficulty sampler
(sample_rte7000.py), the compressed-network transport (network.xiidm.gz.b64),
and consistency between the graded DB, the shipped frontend JSON, and the
per-grid on-disk assets. Hermetic — stdlib only, runs against the committed
data (no pypowsybl / network load)."""
import base64
import gzip
import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = REPO / "data" / "rte7000_tht"
GRIDS = DATA / "grids"
FRONTEND_JSON = REPO / "frontend" / "src" / "game" / "rte7000Scenarios.json"
DIFFICULTIES = ("easy", "medium", "hard")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sampler = _load("sample_rte7000")


# --------------------------------------------------------------------------- #
# sample_rte7000.py
# --------------------------------------------------------------------------- #
def test_sample_draws_n_of_the_requested_difficulty():
    got = sampler.sample("easy", 5, seed=1)
    assert len(got) == 5
    for s in got:
        assert "data/rte7000_tht/grids/" in s["networkPath"]
        assert s["actionFilePath"].endswith("actions.json")
        assert s["layoutPath"].endswith("grid_layout.json")
        assert s["contingencyElementId"]


def test_sample_is_deterministic_with_seed_and_varies_without():
    a = [s["id"] for s in sampler.sample("medium", 6, seed=42)]
    b = [s["id"] for s in sampler.sample("medium", 6, seed=42)]
    c = [s["id"] for s in sampler.sample("medium", 6, seed=7)]
    assert a == b
    assert a != c


def test_sample_caps_at_pool_size():
    db = sampler.load_db()
    pool = [s for s in db["scenarios"] if s["difficulty"] == "hard"]
    got = sampler.sample("hard", 10_000, seed=1)
    assert len(got) == len(pool)


def test_sample_never_leaks_the_reference_solution():
    for diff in DIFFICULTIES:
        for s in sampler.sample(diff, 8, seed=3):
            assert "solution" not in s


def test_sample_spreads_a_small_draw_across_grids():
    grids = {s["networkPath"] for s in sampler.sample("easy", 4, seed=3)}
    assert len(grids) > 1


def test_sample_rejects_unknown_difficulty():
    with pytest.raises(ValueError):
        sampler.sample("impossible", 3)


# --------------------------------------------------------------------------- #
# network.xiidm.gz.b64 transport
# --------------------------------------------------------------------------- #
def test_every_grid_ships_a_decodable_network():
    encoded = sorted(GRIDS.glob("*/network.xiidm.gz.b64"))
    assert len(encoded) == 4
    for enc in encoded:
        raw = gzip.decompress(base64.b64decode(enc.read_bytes()))
        assert raw[:5] == b"<?xml"
        assert b"iidm" in raw[:400].lower()
        assert len(raw) > 1_000_000  # ~8.8 MB XML, not a truncated stub


def test_network_iidm_version_is_readable_by_the_pinned_pypowsybl():
    """The networks must serialise at an IIDM schema the deployed pypowsybl can
    read. pyproject pins pypowsybl>=1.13,<1.15, and pypowsybl 1.14 rejects
    IIDM 1.16 ("Unsupported file format") — so the shipped transports must be
    IIDM <= 1.14. Guards against re-shipping a network exported by a newer
    pypowsybl (which defaults to 1.16)."""
    import re
    max_major, max_minor = 1, 14
    for enc in sorted(GRIDS.glob("*/network.xiidm.gz.b64")):
        raw = gzip.decompress(base64.b64decode(enc.read_bytes()))
        m = re.search(rb"iidm/(\d+)_(\d+)", raw[:400])
        assert m, f"no IIDM version in {enc.parent.name}/network.xiidm"
        major, minor = int(m.group(1)), int(m.group(2))
        assert (major, minor) <= (max_major, max_minor), (
            f"{enc.parent.name}: IIDM {major}.{minor} > 1.14 — the pinned "
            f"pypowsybl (<1.15) cannot read it; re-export with "
            f"parameters={{'iidm.export.xml.version': '1.14'}}")


# --------------------------------------------------------------------------- #
# DB <-> frontend JSON <-> on-disk assets consistency
# --------------------------------------------------------------------------- #
def test_frontend_json_matches_the_graded_database():
    db = json.loads((DATA / "scenarios.json").read_text())
    fe = json.loads(FRONTEND_JSON.read_text())
    db_by_diff = {d: [s for s in db["scenarios"] if s["difficulty"] == d] for d in DIFFICULTIES}
    for d in DIFFICULTIES:
        assert len(fe[d]) == len(db_by_diff[d]), f"{d} count drift DB vs frontend JSON"
        assert {s["id"] for s in fe[d]} == {s["id"] for s in db_by_diff[d]}
    assert sum(len(fe[d]) for d in DIFFICULTIES) == db["n_scenarios"] == 656


def test_scenarios_reference_existing_grid_assets():
    fe = json.loads(FRONTEND_JSON.read_text())
    seen_grids = set()
    for d in DIFFICULTIES:
        for s in fe[d]:
            gid = s["networkPath"].split("/")[3]  # data/rte7000_tht/grids/<gid>/...
            seen_grids.add(gid)
            assert (GRIDS / gid / "grid_layout.json").is_file()
    for gid in seen_grids:
        # network ships compressed (raw .xiidm is git-ignored, decoded at build).
        assert (GRIDS / gid / "network.xiidm.gz.b64").is_file()
        assert (GRIDS / gid / "actions.json").is_file()


def test_titles_do_not_leak_the_year():
    import re
    fe = json.loads(FRONTEND_JSON.read_text())
    year = re.compile(r"\b(19|20)\d\d\b")
    for d in DIFFICULTIES:
        for s in fe[d]:
            assert not year.search(s["label"]), f"year leaked in label: {s['label']}"
