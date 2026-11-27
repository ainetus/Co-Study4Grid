# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Readable names of a network's voltage levels, generators, loads, busbars
and switches.

Readers over a pypowsybl ``Network``, no service state: the network service
caches the voltage-level names and the generator / load names of the whole
network (they ride the ``/api/voltage-levels`` and ``/api/branches`` name
maps), the SLD endpoints name one voltage level's feeders, busbars and
switches, and a manual manoeuvre is described with the same names
(``describe_manual_action`` in ``simulation_helpers``). The naming rules
themselves live in ``element_names``.
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict, deque
from typing import Any

from expert_backend.services.element_names import (
    INJECTION_NOUNS,
    injection_display_name,
    is_real_name,
    kv_label,
    nameless_bus_name,
    short_vl_name,
    switch_display_name,
)

logger = logging.getLogger(__name__)

_INJECTION_TABLES = (("generator", "get_generators"), ("load", "get_loads"))


def _table(network: Any, getter: str, attributes: list[str]) -> Any:
    """``network.<getter>(attributes=…)``, else its default columns, else ``None``."""
    fetch = getattr(network, getter)
    try:
        return fetch(attributes=attributes)
    except Exception as e:
        logger.debug("%s(attributes=%s) failed: %s", getter, attributes, e)
        try:
            return fetch()
        except Exception as e2:
            logger.debug("%s failed: %s", getter, e2)
            return None


def _column(df: Any, name: str) -> list:
    """``df[name]`` as a list aligned on ``df.index`` (``None``s when absent)."""
    return df[name].tolist() if name in getattr(df, "columns", []) else [None] * len(df.index)


#: Real substations a nameless bus names at most — the nearest first.
_MAX_PLACES = 3
#: Real substations after which the walk from a nameless bus stops, at the
#: end of a hop. ``_pick`` names the nearest, completed with the next nearest
#: up to two: three found over whole hops settle it, even with one of them
#: left out (``seen_from``).
_ENOUGH_PLACES = 3
#: A raw bus id inside a name (``G.SOL - virtual_relation_19888985_1-225``).
_RAW_BUS_TOKEN = re.compile(r"(?:virtual_)?(?:relation|way)_[\w-]+")


def _is_virtual(vl: str) -> bool:
    """A PyPSA-EUR virtual bus (``VL_virtual_relation_…``, ``VL_virtual_way_…``):
    a point on a line — a tap or a junction — not a substation."""
    return "virtual_" in vl


def _branch_adjacency(network: Any) -> dict[str, set[str]]:
    """Voltage levels each voltage level reaches through one line or
    two-winding transformer."""
    adjacent: dict[str, set[str]] = defaultdict(set)
    for getter in ("get_lines", "get_2_windings_transformers"):
        df = _table(network, getter, ["voltage_level1_id", "voltage_level2_id"])
        if df is None:
            continue
        for a, b in zip(_column(df, "voltage_level1_id"), _column(df, "voltage_level2_id")):
            if a and b and a != b:
                adjacent[str(a)].add(str(b))
                adjacent[str(b)].add(str(a))
    return adjacent


class VoltageLevelNames:
    """Display names of a network's voltage levels.

    Its own name when it is a real one. A PyPSA virtual bus — a point on a
    line, never a substation, whatever the pipeline named it after (its raw
    id ``virtual_relation_10012409_a_1-225 225kV``, its line's code
    ``COQUAL61TOURB 225kV`` or name ``Liaison 225 kV n°2 Échalas - Le Soleil
    225kV``) — and a substation OSM never named read by the nearest real
    substations they tie (``nameless_bus_name``), found by walking the
    branches through the other virtual and nameless buses: every substation
    one hop away (at most three), completed with the next nearest up to two —
    ``Piquage EMALES(LES) / RANVILLE 225kV``. Two that would read alike are
    numbered (``Piquage CHANCEAUX (2) 225kV``).

    Seen from a line (:meth:`seen_from`), a bus leaves out the substation at
    the line's other end and names its nearest others only, so the line from
    RANVILLE to that tap reads ``RANVILLE — Piquage EMALES(LES)``. A name
    built from a nameless bus's (a generator's ``virtual_relation_… 225kV
    Solar``, a transformer's ``G.SOL - virtual_relation_…``) reads by its
    display name (:meth:`rewrite`, and ``injection_names``).
    """

    def __init__(self, network: Any) -> None:
        #: The network's own name of each voltage level (raw ones included).
        self.network_names: dict[str, str] = {}
        self._own: dict[str, str] = {}
        self._kv: dict[str, str] = {}
        df = _table(network, "get_voltage_levels", ["name", "nominal_v"])
        if df is not None:
            for vl, name, nominal in zip(df.index, _column(df, "name"), _column(df, "nominal_v")):
                vl = str(vl)
                self.network_names[vl] = "" if name is None else str(name).strip()
                if is_real_name(name, vl) and not _is_virtual(vl):
                    self._own[vl] = str(name).strip()
                self._kv[vl] = kv_label(nominal)
        nameless = [vl for vl in self.network_names if vl not in self._own]
        self._places: dict[str, list[tuple[int, str]]] = {vl: [] for vl in nameless}
        # No real substation to find when no voltage level has a name of its
        # own (an RTE grid's names are all empty): skip the walks.
        if nameless and self._own:
            adjacent = _branch_adjacency(network)
            for vl in nameless:
                self._places[vl] = self._reach(vl, adjacent)
        self._names = self._numbered({vl: self._name(vl) for vl in self.network_names})
        self._raw_tokens = {
            short_vl_name(self.network_names[vl]): short_vl_name(self._names[vl])
            for vl in self._places
            if self.network_names.get(vl) and self._names.get(vl, "") != self.network_names[vl]
        }

    def _crossable(self, vl: str) -> bool:
        """A bus the walk goes through: a virtual or nameless one."""
        return vl not in self._own

    def is_nameless(self, vl: str) -> bool:
        """True for a bus named by the substations it ties (virtual, or never
        named) rather than by a name of its own."""
        return vl in self._places

    def _reach(self, start: str, adjacent: dict[str, set[str]]) -> list[tuple[int, str]]:
        """``[(hops, substation)]`` of the real substations ``start`` ties,
        nearest first — up to the hop that finds ``_ENOUGH_PLACES`` of them:
        ``_pick`` reads no further."""
        best: dict[str, int] = {}
        seen, frontier, hops = {start}, [start], 0
        while frontier and len(best) < _ENOUGH_PLACES:
            hops += 1
            further = []
            for vl in frontier:
                for other in adjacent.get(vl, ()):
                    if other in seen:
                        continue
                    seen.add(other)
                    if self._crossable(other):
                        further.append(other)
                    else:
                        best.setdefault(short_vl_name(self._own[other]), hops)
            frontier = further
        return sorted((d, name) for name, d in best.items())

    @staticmethod
    def _pick(places: list[tuple[int, str]], exclude: str | None = None, at_least: int = 2) -> list[str]:
        """Every nearest substation (at most three), completed with the next
        nearest up to ``at_least``."""
        candidates = [(d, name) for d, name in places if name != exclude]
        if not candidates:
            return []
        nearest = candidates[0][0]
        first = [name for d, name in candidates if d == nearest][:_MAX_PLACES]
        if len(first) >= at_least:
            return first
        return first + [name for d, name in candidates if d != nearest][:at_least - len(first)]

    def _name(self, vl: str, exclude: str | None = None) -> str | None:
        if vl in self._own:
            return self._own[vl]
        picked = self._pick(self._places.get(vl, []), exclude, at_least=1 if exclude else 2)
        if picked:
            return nameless_bus_name(picked, _is_virtual(vl), self._kv.get(vl, ""))
        return self.network_names.get(vl) or None

    def _numbered(self, names: dict[str, str | None]) -> dict[str, str]:
        alike: dict[str, list[str]] = defaultdict(list)
        for vl, name in names.items():
            if name and vl in self._places:
                alike[name].append(vl)
        out = {vl: name for vl, name in names.items() if name}
        for name, vls in alike.items():
            kv = self._kv.get(vls[0], "")
            base = name[: -len(kv) - 1] if kv and name.endswith(f" {kv}") else name
            for i, vl in enumerate(sorted(vls)[1:], start=2):
                out[vl] = f"{base} ({i}) {kv}".rstrip()
        return out

    def name(self, vl: str) -> str:
        """The voltage level's display name (its id when it has none)."""
        return self._names.get(vl, vl)

    def seen_from(self, vl: str, other_vl: str) -> str | None:
        """Its display name at the end of a branch whose other end is
        ``other_vl`` — a nameless bus leaves that substation out; ``None``
        when it has no name at all."""
        if vl in self._places and other_vl in self._own:
            seen = self._name(vl, short_vl_name(self._own[other_vl]))
            if seen and seen != self.network_names.get(vl):
                return seen
        return self._names.get(vl)

    def as_dict(self) -> dict[str, str]:
        """``{vl id: display name}`` of every voltage level that has one."""
        return dict(self._names)

    def rewrite(self, text: str) -> str:
        """``text`` with every nameless bus's raw name in it read by its
        display name: ``G.SOL - virtual_relation_19888985_1-225`` →
        ``G.SOL - Piquage G.SOL (2)``."""
        if not self._raw_tokens:
            return text
        return _RAW_BUS_TOKEN.sub(lambda m: self._raw_tokens.get(m.group(0), m.group(0)), text)


def injection_names(
    network: Any,
    plants: dict[str, str] | None = None,
    voltage_level_id: str | None = None,
    vl_names: VoltageLevelNames | None = None,
) -> dict[str, str]:
    """``{generator / load id: display name}``, for one voltage level or all.

    Own name, else the plant matched onto a generator (``plants``, from
    ``power_plants.json``), else ``Generator — MANDARINS 400kV``. A name the
    pipeline built from a nameless voltage level's (``virtual_relation_… 225kV
    Solar``, ``COQUAL61TOURB 225kV Solar``) takes that voltage level's display
    name instead (``Piquage EMALES(LES) / RANVILLE 225kV Solar``). Unnamed injections of
    one kind sharing a voltage level are numbered (``Load 1 — X`` /
    ``Load 2 — X``) so the operator can tell them apart.
    """
    vl_names = vl_names or VoltageLevelNames(network)
    out: dict[str, str] = {}
    for kind, getter in _INJECTION_TABLES:
        df = _table(network, getter, ["name", "voltage_level_id"])
        if df is None or "voltage_level_id" not in getattr(df, "columns", []):
            continue
        if voltage_level_id:
            df = df[df["voltage_level_id"] == voltage_level_id]
        labels: dict[str, str] = {}
        by_place: dict[tuple[str, str], list[str]] = defaultdict(list)
        for eid, name, vl in zip(df.index, _column(df, "name"), _column(df, "voltage_level_id")):
            eid, vl = str(eid), str(vl)
            plant = (plants or {}).get(eid) if kind == "generator" else None
            if isinstance(name, str):
                own_vl = vl_names.network_names.get(vl, "")
                if own_vl and vl_names.is_nameless(vl) and name.startswith(own_vl):
                    name = vl_names.name(vl) + name[len(own_vl):]
                name = vl_names.rewrite(name)
            labels[eid] = injection_display_name(eid, name, kind, vl_names.name(vl), plant)
            by_place[(vl, labels[eid])].append(eid)
        noun = INJECTION_NOUNS[kind]
        for (_vl, label), ids in by_place.items():
            if len(ids) > 1 and label.startswith(f"{noun} — "):
                where = label[len(noun) + 3:]
                for i, eid in enumerate(sorted(ids), start=1):
                    labels[eid] = f"{noun} {i} — {where}"
        out.update(labels)
    return out


def busbar_names(network: Any, voltage_level_id: str) -> dict[str, str]:
    """``{busbar section id: its name}`` for the named busbars of a voltage level."""
    df = _table(network, "get_busbar_sections", ["name", "voltage_level_id"])
    if df is None:
        return {}
    return {
        str(bid): str(name).strip()
        for bid, name, vl in zip(df.index, _column(df, "name"), _column(df, "voltage_level_id"))
        if str(vl) == voltage_level_id and is_real_name(name, bid)
    }


class _BayGraph:
    """A voltage level's node-breaker graph: which feeders a switch's bay
    reaches without crossing a busbar."""

    def __init__(self, topology: Any) -> None:
        self.adjacent: dict[int, list[tuple[int, str]]] = defaultdict(list)
        self.busbar_at: dict[int, str] = {}
        self.equipment_at: dict[int, str] = {}
        switches, nodes = topology.switches, topology.nodes
        for sw_id, n1, n2 in zip(switches.index, _column(switches, "node1"), _column(switches, "node2")):
            self._link(int(n1), int(n2), str(sw_id))
        internal = topology.internal_connections
        for i, (n1, n2) in enumerate(zip(_column(internal, "node1"), _column(internal, "node2"))):
            self._link(int(n1), int(n2), f"internal:{i}")
        for node, cid, ctype in zip(nodes.index, _column(nodes, "connectable_id"),
                                    _column(nodes, "connectable_type")):
            if not cid or str(cid) == "nan":
                continue
            target = self.busbar_at if str(ctype) == "BUSBAR_SECTION" else self.equipment_at
            target[int(node)] = str(cid)

    def _link(self, n1: int, n2: int, edge: str) -> None:
        self.adjacent[n1].append((n2, edge))
        self.adjacent[n2].append((n1, edge))

    def feeders(self, start: int, skip: str) -> set[str]:
        """Equipment reachable from ``start`` without the edge ``skip``,
        stopping at busbars (a busbar joins every bay — crossing it would
        reach them all)."""
        found: set[str] = set()
        seen, queue = {start}, deque([start])
        while queue:
            node = queue.popleft()
            if node in self.equipment_at:
                found.add(self.equipment_at[node])
            if node in self.busbar_at:
                continue
            for other, edge in self.adjacent[node]:
                if edge != skip and other not in seen:
                    seen.add(other)
                    queue.append(other)
        return found


def switch_names(
    network: Any, voltage_level_id: str, element_names: dict[str, str],
) -> dict[str, str]:
    """``{switch id: display name}`` for the switches of a node-breaker
    voltage level, named after the feeder their bay serves
    (``disjoncteur ATTAQL61MANDA``) with ``element_names`` giving the feeders'
    names. ``{}`` for a bus-breaker voltage level or on any pypowsybl failure:
    the raw ids then stay."""
    try:
        topology = network.get_node_breaker_topology(voltage_level_id)
        graph = _BayGraph(topology)
    except Exception as e:
        logger.debug("Node-breaker topology unavailable for %s: %s", voltage_level_id, e)
        return {}
    busbars = busbar_names(network, voltage_level_id)
    switches = topology.switches
    out: dict[str, str] = {}
    for sw_id, kind, n1, n2 in zip(switches.index, _column(switches, "kind"),
                                   _column(switches, "node1"), _column(switches, "node2")):
        sw_id, n1, n2 = str(sw_id), int(n1), int(n2)
        reached = graph.feeders(n1, sw_id) | graph.feeders(n2, sw_id)
        feeders = sorted({element_names.get(eid, eid) for eid in reached})
        busbar = next((graph.busbar_at[n] for n in (n1, n2) if n in graph.busbar_at), None)
        out[sw_id] = switch_display_name(kind, feeders, busbars.get(busbar, busbar) if busbar else None)
    return out


def manual_action_names(
    network: Any,
    content: dict[str, Any],
    element_names: dict[str, str],
    voltage_level_names_map: dict[str, str] | None = None,
) -> dict[str, str]:
    """Display names of everything a manual action names: its switches (by
    the voltage levels they belong to), generators, loads and voltage levels —
    the ``names`` of ``build_manual_action_description``."""
    names = dict(voltage_level_names_map or {})
    names.update(element_names)
    switch_ids = [str(s) for s in (content.get("switches") or {})]
    if switch_ids:
        df = _table(network, "get_switches", ["voltage_level_id"])
        vl_of = dict(zip(map(str, df.index), _column(df, "voltage_level_id"))) if df is not None else {}
        for vl in {str(vl_of[s]) for s in switch_ids if s in vl_of}:
            names.update(switch_names(network, vl, element_names))
    return names
