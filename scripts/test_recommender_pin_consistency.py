# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Consistency guard for the recommender version pin (QW8).

recommender-pin.txt is the single source of truth for the pinned
expert_op4grid_recommender version. This hermetic (stdlib-only) test asserts
the PR/deploy install sites all consume it and that requirements_py310.txt
agrees, so the pin can't drift out of sync silently.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PIN_FILE = REPO / "recommender-pin.txt"


def _pinned_version() -> str:
    for line in PIN_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            m = re.fullmatch(r"expert_op4grid_recommender==(.+)", line)
            assert m, f"unexpected pin line: {line!r}"
            return m.group(1)
    raise AssertionError("recommender-pin.txt has no pin line")


def test_pin_file_has_exact_version():
    v = _pinned_version()
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:\.post\d+)?", v), f"pin must be exact, got {v!r}"


def test_ci_and_docker_install_from_the_pin_file():
    test_yml = (REPO / ".github" / "workflows" / "test.yml").read_text(encoding="utf-8")
    dockerfile = (REPO / "Dockerfile").read_text(encoding="utf-8")
    # Both must install via the pin file, not a floating ">=" spec.
    assert test_yml.count("-r recommender-pin.txt") >= 2, "test.yml must install the pin"
    assert "recommender-pin.txt" in dockerfile, "Dockerfile must install the pin"
    assert 'expert_op4grid_recommender>=' not in test_yml, "test.yml still has a floating spec"
    assert 'expert_op4grid_recommender>=' not in dockerfile, "Dockerfile still has a floating spec"


def test_requirements_py310_matches_the_pin():
    v = _pinned_version()
    reqs = (REPO / "requirements_py310.txt").read_text(encoding="utf-8")
    assert f"expert_op4grid_recommender=={v}" in reqs, (
        "requirements_py310.txt must match recommender-pin.txt"
    )


def test_circleci_config_is_gone():
    # QW23 — collapsed to a single CI system (GitHub Actions).
    assert not (REPO / ".circleci" / "config.yml").exists()
