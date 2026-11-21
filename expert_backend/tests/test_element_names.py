# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""The display-name rule every view shares: the contingency list, the SLD
feeder labels and the Context tab."""

import pytest

from expert_backend.services.element_names import (
    branch_display_name,
    is_real_name,
    short_vl_name,
)


@pytest.mark.parametrize("name, vl1, vl2, expected", [
    # A real name stays.
    ("REALTL71TAVEL", "REALTOR 400kV", "TAVEL 400kV", "REALTL71TAVEL"),
    # A raw OSM id, merged by PyPSA or not, gives way to the ends.
    ("merged_way/214858102-400+4", "PONTEAU 400kV", "REALTOR 400kV", "PONTEAU — REALTOR"),
    ("way/426020732-400", "CHARPENAY 400kV", "ST-VULBAS-EST 400kV", "CHARPENAY — ST-VULBAS-EST"),
    # So does a missing name.
    ("", "PONTEAU 400kV", "REALTOR 400kV", "PONTEAU — REALTOR"),
    # Both ends in one substation (a transformer), or only one end named.
    (None, "REALTOR 400kV", "REALTOR 225kV", "REALTOR"),
    ("relation_1-225", None, "SEPTEMES 225kV", "SEPTEMES"),
    # Nothing better than the raw name, then nothing but the id.
    ("merged_way/1-225+3", None, None, "merged_way/1-225+3"),
    ("L1", None, None, None),
])
def test_branch_display_name(name, vl1, vl2, expected):
    assert branch_display_name("L1", name, vl1, vl2) == expected


def test_short_vl_name_drops_the_voltage():
    assert short_vl_name("PONTEAU 400kV") == "PONTEAU"
    assert short_vl_name(float("nan")) == ""


def test_is_real_name():
    assert is_real_name("CIROLL61LOGES", "relation_9142329-225")
    assert not is_real_name("relation_9142329-225", "relation_9142329-225")
    assert not is_real_name("merged_relation/6221844_a-400+1", "x")
    assert not is_real_name("  ", "x")
