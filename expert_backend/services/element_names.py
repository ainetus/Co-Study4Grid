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

Generators and loads follow the same idea (``injection_display_name``): their
own name, else the power plant matched onto them, else what they are and where
(``Load — MANDARINS 400kV``). Switches read by the feeder they serve
(``switch_display_name``: ``disjoncteur ATTAQL61MANDA``), so a manual
manoeuvre is described with the names the operator sees. A PyPSA virtual bus —
a point on a line, whatever the pipeline named it after (its raw id, its line's
code or name) — and a substation OSM never named read by the real substations
they tie (``nameless_bus_name``: ``Piquage EMALES(LES) / RANVILLE 225kV``): a
voltage-level label never shows a line's name.
"""
from __future__ import annotations

import re
from typing import Any

#: A name that is still a raw OSM id — PyPSA virtual buses included
#: (``virtual_relation_10012409_a_1-225 225kV``).
RAW_OSM_NAME = re.compile(r"^(merged_|virtual_)?(way|relation)[/_]")
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


#: What an unnamed injection is, for its fallback display name.
INJECTION_NOUNS = {"generator": "Generator", "load": "Load"}


def injection_display_name(
    element_id: Any, name: Any, kind: str, location: Any, plant: Any = None,
) -> str:
    """A generator's or load's display name: its own when it is a real one,
    else the power plant matched onto it, else ``<Kind> — <location>``
    (``Generator — MANDARINS 400kV``), ``location`` being the display name of
    its voltage level."""
    if is_real_name(name, element_id):
        return _text(name)
    if _text(plant):
        return _text(plant)
    noun = INJECTION_NOUNS.get(kind, kind.capitalize())
    where = _text(location)
    return f"{noun} — {where}" if where else f"{noun} {element_id}"


#: French noun of a switch kind — the language of the manoeuvre descriptions.
SWITCH_NOUNS = {"BREAKER": "disjoncteur", "DISCONNECTOR": "sectionneur",
                "LOAD_BREAK_SWITCH": "interrupteur"}


def switch_display_name(
    kind: Any, feeders: list[str], busbar: str | None = None,
) -> str:
    """A switch's display name, from the feeder(s) its bay serves:
    ``disjoncteur ATTAQL61MANDA``; a busbar-selection disconnector names its
    busbar too (``sectionneur ATTAQL61MANDA (MANDARINS JdB1)``); a bay that
    serves no feeder is a coupling (``disjoncteur de couplage``)."""
    noun = SWITCH_NOUNS.get(_text(kind).upper(), "organe")
    what = " / ".join(feeders) if feeders else "de couplage"
    return f"{noun} {what} ({busbar})" if busbar else f"{noun} {what}"


def kv_label(nominal_v: Any) -> str:
    """``225kV`` for a nominal voltage of 225 (``''`` when unknown) — the
    suffix every voltage-level name carries."""
    try:
        kv = float(nominal_v)
    except (TypeError, ValueError):
        return ""
    return f"{kv:g}kV" if kv == kv and kv > 0 else ""


def nameless_bus_name(places: list[str], virtual: bool, kv: str = "") -> str:
    """The display name of a bus with no name of its own, from the real
    substations it ties, nearest first. A PyPSA virtual bus is a point on a
    line — a tap: ``Piquage EMALES(LES) / RANVILLE 225kV``; a substation OSM
    never named sits near them: ``Poste près de BEAUTOR / CAPELLE (LA) 225kV``."""
    prefix = "Piquage" if virtual else "Poste près de"
    text = f"{prefix} {' / '.join(places)}"
    return f"{text} {kv}" if kv else text
