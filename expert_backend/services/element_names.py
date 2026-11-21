# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Display names of network elements — one rule for every view.

The PyPSA→IIDM conversion leaves some lines named by their raw OSM id
(``way/426020732-400``, ``relation_9142329-225``, or ``merged_way/…`` when
PyPSA merged several ways into one line). Such a name, like a missing one,
gives way to the names of the line's end voltage levels, so the contingency
list (``network_service.get_element_names``), the SLD feeder labels and the
Context tab all read ``PONTEAU — REALTOR``.
"""
from __future__ import annotations

import re
from typing import Any

#: A name that is still a raw OSM id.
RAW_OSM_NAME = re.compile(r"^(merged_)?(way|relation)[/_]")
_KV_SUFFIX = re.compile(r"\s+\d+\s*kV$")


def _text(value: Any) -> str:
    """``value`` as a stripped string; ``''`` for ``None`` / NaN."""
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s == "nan" else s


def is_real_name(name: Any, element_id: Any) -> bool:
    """True when ``name`` is a human-readable label: not blank, not the
    element id, not a raw OSM id."""
    s = _text(name)
    return bool(s) and s != str(element_id) and not RAW_OSM_NAME.match(s)


def short_vl_name(name: Any) -> str:
    """A voltage level's name without its voltage (``PONTEAU 400kV`` → ``PONTEAU``)."""
    return _KV_SUFFIX.sub("", _text(name))


def branch_display_name(
    element_id: Any, name: Any, vl1_name: Any, vl2_name: Any,
) -> str | None:
    """A line's or transformer's display name: its own when it is a real
    one, else its end voltage levels' (``A — B``, or the one that is named),
    else whatever raw name it has; ``None`` when it has nothing but its id."""
    if is_real_name(name, element_id):
        return _text(name)
    end1, end2 = short_vl_name(vl1_name), short_vl_name(vl2_name)
    if end1 and end2 and end1 != end2:
        return f"{end1} — {end2}"
    if end1 or end2:
        return end1 or end2
    raw = _text(name)
    return raw if raw and raw != str(element_id) else None
