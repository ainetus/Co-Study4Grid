# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Consignations — the extra-high-voltage circuits a situation takes out.

PORTED from Carte-Front (``maintenance.detect_consignations_via_I``, applied
to a single situation file as ``carte_front/situation`` does for a *PtFige*):
a 400 / 225 kV line or transformer is *consigned* when

1. **no current flows** at either end — ``I`` is ``NaN`` (the end is off
   voltage) or below ``INACTIVE_I_THRESHOLD`` (0.5 A; a line energised from
   one end only keeps its charging current at the other, so it is NOT
   consigned) — and
2. it is **isolated** at the voltage level of each end, in the topology the
   datalake calls ``TOPO``: a node is a component of closed switches (and
   internal connections), with ALL its elements; the circuit is alone on its
   node, or shares it only with node-internal elements (busbar sections,
   ``fict_…`` / ``<voltage level>_…`` elements) and with other circuits that
   are themselves consigned — a *group* of consigned circuits tied together
   (an antenna) where none is "alone".

Carte-Front reconstitutes ``TOPO`` and ``I`` from the XIIDM file; here the
network is already parsed, so ``I`` is the pypowsybl current (else
``√(P² + Q²) / (√3·V)`` at the nominal voltage, as Carte-Front falls back
when a bus carries no computed voltage) and ``TOPO`` is read per candidate
voltage level from the node-breaker topology — a few hundred reads at most,
~0.35 ms each. A bus-breaker voltage level has no switches to reason on: an
end is isolated when its circuit is disconnected.

A file that carries no flow at all cannot say which circuits are out of
service — every circuit would look "without current" — so it gets none.
"""
from __future__ import annotations

import logging
import math
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

#: A current below this (A) at an end counts as no current (Carte-Front
#: ``INACTIVE_I_THRESHOLD``).
INACTIVE_I_THRESHOLD = 0.5
#: Nominal voltage (kV) → the class a circuit is drawn in. The RTE levels
#: (400 / 225 kV) and their European neighbours (380 / 220 kV) share a class.
VOLTAGE_CLASSES: tuple[tuple[float, str], ...] = ((300.0, "400 kV"), (180.0, "225 kV"))
#: Share of the extra-high-voltage circuits that must carry flow data for
#: the file to say anything about what is out of service.
FLOW_COVERAGE_MIN = 0.5

COLUMNS = ["vl1", "vl2", "voltage", "kind"]


def voltage_class(nominal_kv: float | None) -> str | None:
    """``"400 kV"`` / ``"225 kV"`` for an extra-high-voltage level, else ``None``."""
    if nominal_kv is None or not math.isfinite(nominal_kv):
        return None
    for floor, label in VOLTAGE_CLASSES:
        if nominal_kv >= floor:
            return label
    return None


def _num(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return pd.to_numeric(df[name], errors="coerce")
    return pd.Series(np.nan, index=df.index)


def _end_current(df: pd.DataFrame, end: str, nominal_kv: pd.Series) -> pd.Series:
    """``I`` (A) at one end: pypowsybl's, else ``√(P² + Q²)/(√3·V)`` at the
    nominal voltage; ``NaN`` where the end carries no value (off voltage)."""
    current = _num(df, f"i{end}")
    p, q = _num(df, f"p{end}"), _num(df, f"q{end}")
    apparent = np.hypot(p, q.fillna(0.0).where(p.notna()))
    fallback = apparent * 1000.0 / (math.sqrt(3.0) * nominal_kv)
    return current.where(current.notna(), fallback)


def _inactive(current: pd.Series) -> pd.Series:
    return current.isna() | (current.abs() < INACTIVE_I_THRESHOLD)


def _is_internal(member: str, member_type: str, voltage_level: str) -> bool:
    """A busbar section or a ``fict_…`` / ``<voltage level>_…`` element: part
    of the substation's own wiring, not a circuit or an injection."""
    return (member_type == "BUSBAR_SECTION" or member.startswith("fict_")
            or member.startswith(f"{voltage_level}_"))


class _VoltageLevelTopology:
    """Who shares a node with whom in one voltage level — the datalake's
    ``TOPO``: components of closed switches and internal connections."""

    def __init__(self, nodes: pd.DataFrame, switches: pd.DataFrame, internal: pd.DataFrame):
        parent: dict[int, int] = {int(n): int(n) for n in nodes.index}

        def find(n: int) -> int:
            while parent.setdefault(n, n) != n:
                parent[n] = parent[parent[n]]
                n = parent[n]
            return n

        if not switches.empty:
            closed = switches[~switches["open"].astype(bool)]
            for a, b in zip(closed["node1"], closed["node2"]):
                parent[find(int(a))] = find(int(b))
        if not internal.empty:
            for a, b in zip(internal["node1"], internal["node2"]):
                parent[find(int(a))] = find(int(b))
        self.members: dict[int, list[tuple[str, str]]] = {}
        self.node_of: dict[str, int] = {}
        for node, row in nodes.iterrows():
            element = str(row["connectable_id"] or "")
            if element:
                root = find(int(node))
                self.members.setdefault(root, []).append((element, str(row["connectable_type"])))
                self.node_of[element] = root

    def isolated(self, element: str, voltage_level: str, allowed: set[str]) -> bool | None:
        """Is ``element`` alone at its node, or only with node-internal
        elements and ``allowed`` (consigned) circuits? ``None``: not in this
        voltage level's topology."""
        root = self.node_of.get(element)
        if root is None:
            return None
        return all(m == element or m in allowed or _is_internal(m, kind, voltage_level)
                   for m, kind in self.members[root])


class _Topologies:
    """``_VoltageLevelTopology`` per voltage level, read once from the network."""

    def __init__(self, network: Any):
        self._network = network
        self._cache: dict[str, _VoltageLevelTopology | None] = {}

    def get(self, voltage_level: str) -> _VoltageLevelTopology | None:
        """``None`` for a bus-breaker voltage level (no switches to read)."""
        if voltage_level not in self._cache:
            try:
                topology = self._network.get_node_breaker_topology(voltage_level)
                self._cache[voltage_level] = _VoltageLevelTopology(
                    topology.nodes, topology.switches, topology.internal_connections)
            except Exception:  # bus-breaker voltage level, or an unreadable one
                logger.debug("No node-breaker topology for %s", voltage_level, exc_info=True)
                self._cache[voltage_level] = None
        return self._cache[voltage_level]


def _candidates(df: pd.DataFrame, kind: str, vl_nominal: dict[str, float]) -> pd.DataFrame:
    """Extra-high-voltage circuits of one table, with their flow evidence."""
    if df is None or df.empty or not {"voltage_level1_id", "voltage_level2_id"} <= set(df.columns):
        return pd.DataFrame(columns=COLUMNS + ["no_current", "flow_known", "connected1", "connected2"])
    vl1, vl2 = df["voltage_level1_id"].astype(str), df["voltage_level2_id"].astype(str)
    kv1, kv2 = vl1.map(vl_nominal).astype(float), vl2.map(vl_nominal).astype(float)
    class1, class2 = kv1.map(voltage_class), kv2.map(voltage_class)
    tht = class1.notna() & class2.notna()
    no_current = _inactive(_end_current(df, "1", kv1)) & _inactive(_end_current(df, "2", kv2))
    flow_known = (_num(df, "i1").notna() | _num(df, "p1").notna()
                  | _num(df, "i2").notna() | _num(df, "p2").notna())
    connected = {f"connected{n}": (df[f"connected{n}"].fillna(False).astype(bool)
                                   if f"connected{n}" in df.columns
                                   else pd.Series(True, index=df.index)) for n in "12"}
    out = pd.DataFrame({
        "vl1": vl1, "vl2": vl2,
        # A 400 / 225 kV transformer is drawn in its highest class.
        "voltage": np.where(kv1.fillna(0) >= kv2.fillna(0), class1, class2),
        "kind": kind, "no_current": no_current, "flow_known": flow_known, **connected,
    }, index=df.index.astype(str))
    return out[tht.to_numpy()]


def detect_consignations(network: Any, lines: pd.DataFrame, transformers: pd.DataFrame,
                         vl_nominal: dict[str, float]) -> pd.DataFrame:
    """The consigned circuits of a situation (see the module).

    ``lines`` / ``transformers`` are the pypowsybl tables (``get_lines()`` /
    ``get_2_windings_transformers()``), ``vl_nominal`` the nominal voltage (kV)
    of each voltage level. Returns one row per consigned circuit, indexed by
    its id: ``vl1``, ``vl2``, ``voltage`` (``"400 kV"`` / ``"225 kV"``),
    ``kind`` (``line`` / ``transformer``)."""
    if not vl_nominal:
        return pd.DataFrame(columns=COLUMNS)
    tables = [_candidates(lines, "line", vl_nominal),
              _candidates(transformers, "transformer", vl_nominal)]
    tables = [t for t in tables if not t.empty]
    if not tables:
        return pd.DataFrame(columns=COLUMNS)
    tht = pd.concat(tables)
    if tht["flow_known"].mean() < FLOW_COVERAGE_MIN:
        logger.info("Context map: the file carries no flows, consignations cannot be told")
        return pd.DataFrame(columns=COLUMNS)

    candidates = tht[tht["no_current"]]
    allowed = set(candidates.index)
    topologies = _Topologies(network)

    def isolated_at(element: str, voltage_level: str, connected: bool) -> bool:
        topology = topologies.get(voltage_level)
        verdict = topology.isolated(element, voltage_level, allowed) if topology else None
        return (not connected) if verdict is None else verdict

    consigned = np.array([
        isolated_at(eid, row.vl1, row.connected1) and isolated_at(eid, row.vl2, row.connected2)
        for eid, row in zip(candidates.index, candidates.itertuples())
    ], dtype=bool)
    return candidates[consigned][COLUMNS].sort_values(["voltage", "kind"], ascending=[False, True])
