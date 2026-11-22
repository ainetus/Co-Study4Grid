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
    injection_display_name,
    is_real_name,
    kv_label,
    nameless_bus_name,
    short_vl_name,
    switch_display_name,
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
    # A PyPSA virtual bus named by its raw id is not named either.
    assert not is_real_name("virtual_relation_10012409_a_1-225 225kV", "x")
    assert not is_real_name("virtual_way_86148821_0-225 225kV", "x")


def test_kv_label():
    assert kv_label(225.0) == "225kV"
    assert kv_label(380) == "380kV"
    assert kv_label(None) == ""
    assert kv_label(float("nan")) == ""


def test_nameless_bus_name():
    # A virtual bus is a point on a line — a tap ("piquage").
    assert nameless_bus_name(["EMALES(LES)", "RANVILLE"], True, "225kV") == \
        "Piquage EMALES(LES) / RANVILLE 225kV"
    # A substation OSM never named sits near the ones it ties.
    assert nameless_bus_name(["BEAUTOR", "CAPELLE (LA)"], False, "225kV") == \
        "Poste près de BEAUTOR / CAPELLE (LA) 225kV"
    assert nameless_bus_name(["FEUILLANE"], False) == "Poste près de FEUILLANE"


@pytest.mark.parametrize("name, plant, expected", [
    # Its own name first, then the plant matched onto it, then what and where.
    ("MANDARINS 400kV Solar", "Gravelines", "MANDARINS 400kV Solar"),
    ("", "Gravelines", "Gravelines"),
    ("G1", None, "Generator — MANDARINS 400kV"),
    (float("nan"), None, "Generator — MANDARINS 400kV"),
])
def test_injection_display_name(name, plant, expected):
    assert injection_display_name("G1", name, "generator", "MANDARINS 400kV", plant) == expected


def test_injection_display_name_of_a_load_without_location():
    assert injection_display_name("L1", None, "load", "MANDARINS 400kV") == "Load — MANDARINS 400kV"
    assert injection_display_name("L1", None, "load", "") == "Load L1"


@pytest.mark.parametrize("kind, feeders, busbar, expected", [
    ("BREAKER", ["MANDAL71WARAN"], None, "disjoncteur MANDAL71WARAN"),
    ("DISCONNECTOR", ["MANDAL71WARAN"], "MANDARINS JdB1", "sectionneur MANDAL71WARAN (MANDARINS JdB1)"),
    ("BREAKER", [], None, "disjoncteur de couplage"),
    ("LOAD_BREAK_SWITCH", ["A", "B"], None, "interrupteur A / B"),
])
def test_switch_display_name(kind, feeders, busbar, expected):
    # The state word the frontend classifier reads is appended by the
    # description builder, never part of the name.
    assert switch_display_name(kind, feeders, busbar) == expected
