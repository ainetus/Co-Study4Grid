# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Payload slimming: the step-2 result must not ship full-grid per-branch
arrays (``p_or_combined`` / ``p_ex_combined``) the frontend never reads.

These arrays are one float per line of the grid (~6–8k on the PyPSA-EUR grids)
× ~100 combined pairs = tens of MB of JSON, the dominant chunk of the
"Other (network / streaming)" time. The frontend's ``CombinedAction`` reads
none of them (session-reload rebuilds them as ``[]``), so the backend empties
them at the API boundary.
"""
from expert_backend.services.analysis.combined_pairs import (
    slim_combined_actions_for_payload as _slim_combined_actions_for_payload,
)


def _pair(p_or, p_ex, **extra):
    d = {
        "betas": [0.5, 0.5],
        "max_rho": 1.1,
        "max_rho_line": "L1",
        "rho_before": [1.2],
        "rho_after": [1.05],
        "p_or_combined": p_or,
        "p_ex_combined": p_ex,
    }
    d.update(extra)
    return d


def test_heavy_arrays_emptied():
    combined = {"a+b": _pair(list(range(8000)), list(range(8000)))}
    _slim_combined_actions_for_payload(combined)
    assert combined["a+b"]["p_or_combined"] == []
    assert combined["a+b"]["p_ex_combined"] == []


def test_key_is_kept_not_deleted():
    """Emptied, not removed — shape stays identical to a reloaded session."""
    combined = {"a+b": _pair([1.0, 2.0], [3.0, 4.0])}
    _slim_combined_actions_for_payload(combined)
    assert "p_or_combined" in combined["a+b"]
    assert "p_ex_combined" in combined["a+b"]


def test_light_fields_untouched():
    combined = {"a+b": _pair([1.0] * 8000, [2.0] * 8000,
                              target_max_rho=0.9, is_rho_reduction=True)}
    _slim_combined_actions_for_payload(combined)
    p = combined["a+b"]
    assert p["betas"] == [0.5, 0.5]
    assert p["max_rho"] == 1.1
    assert p["rho_before"] == [1.2]
    assert p["rho_after"] == [1.05]
    assert p["target_max_rho"] == 0.9
    assert p["is_rho_reduction"] is True


def test_multiple_pairs():
    combined = {
        "a+b": _pair([1] * 100, [2] * 100),
        "c+d": _pair([3] * 100, [4] * 100),
    }
    _slim_combined_actions_for_payload(combined)
    assert all(p["p_or_combined"] == [] and p["p_ex_combined"] == []
               for p in combined.values())


def test_empty_or_none_is_noop():
    assert _slim_combined_actions_for_payload({}) == {}
    assert _slim_combined_actions_for_payload(None) is None


def test_already_empty_pair_stays_empty():
    combined = {"a+b": _pair([], [])}
    _slim_combined_actions_for_payload(combined)
    assert combined["a+b"]["p_or_combined"] == []


def test_non_dict_pair_skipped():
    """Defensive: never raise on an unexpected value shape."""
    combined = {"a+b": None, "c+d": _pair([1] * 10, [2] * 10)}
    _slim_combined_actions_for_payload(combined)
    assert combined["a+b"] is None
    assert combined["c+d"]["p_or_combined"] == []


def test_missing_error_pair_untouched():
    """An error pair (no arrays) passes through unharmed."""
    combined = {"a+b": {"betas": [0.5, 0.5], "error": "unreliable"}}
    _slim_combined_actions_for_payload(combined)
    assert combined["a+b"] == {"betas": [0.5, 0.5], "error": "unreliable"}
