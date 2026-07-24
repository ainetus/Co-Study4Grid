# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Rebuild a bus-branch MATPOWER pypowsybl network as NODE_BREAKER, giving
each substation a busbar topology the expert_op4grid_recommender can act on.

MATPOWER networks import as BUS_BREAKER with no switches, so the recommender
has no topological (coupler / node-splitting) actions — only redispatch /
load-shedding, too weak for the stressed matpower states. We rebuild the same
electrical network node-breaker: every voltage level gets a busbar section and
each feeder a bay (breaker + disconnector); VLs with >= COUPLER_MIN_FEEDERS get
a SECOND busbar + a CLOSED coupler named ``*_COUPL.*`` (the name the recommender
keys on) so opening it splits the node (an ``open_coupling`` action).

Feasibility validated end-to-end (BusView resolves, NetworkTopologyCache builds,
opening a COUPL breaker increases the VL node count). See
docs/features/game-mode-matpower (topology section).
"""
from __future__ import annotations

import collections

import pandas as pd
import pypowsybl as pp
import pypowsybl.network as ppn

COUPLER_MIN_FEEDERS = 5  # VLs with >= this many branches get a 2nd busbar + coupler


def _feeder_degree(src) -> dict:
    deg: dict = collections.Counter()
    for df, c1, c2 in [(src.get_lines(), "voltage_level1_id", "voltage_level2_id"),
                       (src.get_2_windings_transformers(), "voltage_level1_id", "voltage_level2_id")]:
        for _, r in df.iterrows():
            deg[r[c1]] += 1
            deg[r[c2]] += 1
    return deg


def _source_bus_index(src):
    """Per-VL ordered source buses + every feeder terminal's source bus.

    The MATPOWER import leaves 208 VLs holding MORE THAN ONE electrical bus
    (up to 9). Those are genuinely separate nodes: collapsing them onto one
    busbar rewires the grid (~610 MW of extra losses, 26 deg angle shifts,
    3 GW flow errors). We reproduce them as one busbar per source bus.
    """
    order: dict = collections.defaultdict(list)
    for bid, r in src.get_buses(attributes=["voltage_level_id"]).iterrows():
        order[r["voltage_level_id"]].append(bid)
    idx = {vl: {b: i for i, b in enumerate(bs)} for vl, bs in order.items()}

    def slot(vl, bus_id):
        return idx.get(vl, {}).get(bus_id, 0)

    feeder: dict = {}
    for getter, pairs in (("lines", (("voltage_level1_id", "bus1_id", 1),
                                     ("voltage_level2_id", "bus2_id", 2))),
                          ("2_windings_transformers", (("voltage_level1_id", "bus1_id", 1),
                                                       ("voltage_level2_id", "bus2_id", 2)))):
        df = getattr(src, f"get_{getter}")(all_attributes=True)
        for eid, r in df.iterrows():
            for vlc, busc, side in pairs:
                feeder[(str(eid), side)] = slot(r[vlc], r[busc])
    for getter in ("loads", "generators", "shunt_compensators"):
        df = getattr(src, f"get_{getter}")(all_attributes=True)
        for eid, r in df.iterrows():
            feeder[(str(eid), 0)] = slot(r["voltage_level_id"], r["bus_id"])
    return {vl: len(bs) for vl, bs in order.items()}, feeder


def _busbar_counts(vls, deg, bus_sub, rte_struct, coupler_min, n_src):
    """Busbar sections per VL: the REAL RTE7000 count for identity-mapped
    substations, else the generic >=coupler_min -> 2 fallback — but never fewer
    than the VL's source electrical-bus count, so the loaded node count is
    preserved exactly.

    Capped by the feeder count (splitting more busbars than feeders is
    meaningless) and floored at 2 so a mapped VL stays splittable.
    """
    nbus, n_rte = {}, 0
    for vl in vls.index:
        d = deg.get(vl, 0)
        n = 2 if d >= coupler_min else 1
        m = None
        if bus_sub and rte_struct:
            try:
                m = bus_sub.get(int(str(vl).split("-")[-1]))
            except ValueError:
                m = None
        if m and d >= 2:
            kv = int(round(float(vls.loc[vl, "nominal_v"])))
            ref_n = (rte_struct.get(m["substation"]) or {}).get(kv)
            if ref_n:
                n = max(2, min(int(ref_n), d))
                n_rte += 1
        nbus[vl] = max(n, int(n_src.get(vl, 1)))
    return nbus, n_rte


def rebuild_node_breaker(src, bus_sub: dict | None = None,
                         rte_struct: dict | None = None,
                         coupler_min: int = COUPLER_MIN_FEEDERS):
    dst = pp.network.create_empty("matpower_nb")
    subs = src.get_substations()
    dst.create_substations(id=subs.index.tolist(),
                           country=[c if isinstance(c, str) and c else "FR"
                                    for c in subs.get("country", ["FR"] * len(subs))])
    vls = src.get_voltage_levels()
    dst.create_voltage_levels(
        id=vls.index.tolist(), substation_id=vls["substation_id"].tolist(),
        topology_kind=["NODE_BREAKER"] * len(vls), nominal_v=vls["nominal_v"].tolist(),
        high_voltage_limit=vls["high_voltage_limit"].tolist(),
        low_voltage_limit=vls["low_voltage_limit"].tolist(),
    )
    deg = _feeder_degree(src)
    n_src, feeder_slot = _source_bus_index(src)
    nbus, n_rte = _busbar_counts(vls, deg, bus_sub, rte_struct, coupler_min, n_src)
    for vl in vls.index:
        ppn.create_voltage_level_topology(dst, id=vl,
                                          aligned_buses_or_busbar_count=nbus[vl], section_count=1)
    # busbar section id form from create_voltage_level_topology: '<vl>_<busbar>_1'
    def bbs(vl, slot=0):
        return f"{vl}_{min(slot, nbus[vl] - 1) + 1}_1"

    # Chain n-1 couplers. A coupler joining two busbars that carry DISTINCT
    # source buses is left OPEN, so the VL keeps exactly its loaded electrical
    # node count (and the recommender gets a close_coupling lever); the extra
    # busbars added for splittability are joined CLOSED, so opening one is an
    # open_coupling action.
    to_open = []
    for vl in vls.index:
        for i in range(1, nbus[vl]):
            ppn.create_coupling_device(
                dst, bus_or_busbar_section_id_1=f"{vl}_{i}_1",
                bus_or_busbar_section_id_2=f"{vl}_{i + 1}_1",
                switch_prefix_id=f"{vl}_COUPL.{i}")
            if i < int(n_src.get(vl, 1)):
                to_open.append(f"{vl}_COUPL.{i}_BREAKER")
    pos = collections.Counter()

    def nextpos(vl):
        pos[vl] += 10
        return pos[vl]

    # feeders via bays
    lines = src.get_lines()
    for lid, r in lines.iterrows():
        v1, v2 = r["voltage_level1_id"], r["voltage_level2_id"]
        s1 = feeder_slot.get((str(lid), 1), 0)
        s2 = feeder_slot.get((str(lid), 2), 0)
        ppn.create_line_bays(
            dst, id=str(lid), r=float(r["r"]), x=float(r["x"]),
            g1=float(r["g1"]), b1=float(r["b1"]), g2=float(r["g2"]), b2=float(r["b2"]),
            bus_or_busbar_section_id_1=bbs(v1, s1), position_order_1=nextpos(v1),
            bus_or_busbar_section_id_2=bbs(v2, s2), position_order_2=nextpos(v2))
    t2 = src.get_2_windings_transformers()
    for tid, r in t2.iterrows():
        v1, v2 = r["voltage_level1_id"], r["voltage_level2_id"]
        ppn.create_2_windings_transformer_bays(
            dst, id=str(tid), r=float(r["r"]), x=float(r["x"]), g=float(r["g"]), b=float(r["b"]),
            rated_u1=float(r["rated_u1"]), rated_u2=float(r["rated_u2"]),
            bus_or_busbar_section_id_1=bbs(v1, feeder_slot.get((str(tid), 1), 0)),
            position_order_1=nextpos(v1),
            bus_or_busbar_section_id_2=bbs(v2, feeder_slot.get((str(tid), 2), 0)),
            position_order_2=nextpos(v2))
    loads = src.get_loads(attributes=["voltage_level_id", "p0", "q0"])
    for lid, r in loads.iterrows():
        vl = r["voltage_level_id"]
        ppn.create_load_bay(dst, id=str(lid), p0=float(r["p0"]), q0=float(r["q0"]),
                            bus_or_busbar_section_id=bbs(vl, feeder_slot.get((str(lid), 0), 0)),
                            position_order=nextpos(vl))
    gens = src.get_generators(attributes=["voltage_level_id", "max_p", "min_p", "target_p",
                                          "target_q", "target_v", "voltage_regulator_on"])
    for gid, r in gens.iterrows():
        vl = r["voltage_level_id"]
        ppn.create_generator_bay(
            dst, id=str(gid), max_p=float(r["max_p"]), min_p=float(r["min_p"]),
            target_p=float(r["target_p"]), target_q=float(r.get("target_q", 0.0) or 0.0),
            voltage_regulator_on=bool(r["voltage_regulator_on"]),
            target_v=float(r["target_v"]) if r["target_v"] == r["target_v"] else 400.0,
            bus_or_busbar_section_id=bbs(vl, feeder_slot.get((str(gid), 0), 0)),
            position_order=nextpos(vl))
    # Generator reactive limits (MIN_MAX) — the bay call does not carry them and
    # missing Q limits let generators produce unbounded reactive power, which
    # alone stops the (stiff) AC load flow converging.
    gq = src.get_generators(attributes=["min_q", "max_q"])
    dst.update_generators(id=gq.index.tolist(),
                          min_q=gq["min_q"].tolist(), max_q=gq["max_q"].tolist())
    # Shunt compensators: reactive support, likewise required for convergence.
    sh = src.get_shunt_compensators(all_attributes=True)
    for sid, r in sh.iterrows():
        vl = r["voltage_level_id"]
        sdf = pd.DataFrame([{
            "id": str(sid), "name": "", "model_type": "LINEAR",
            "section_count": int(r["section_count"]), "target_v": float("nan"),
            "target_deadband": float("nan"),
            "bus_or_busbar_section_id": bbs(vl, feeder_slot.get((str(sid), 0), 0)),
            "position_order": nextpos(vl),
        }]).set_index("id")
        ldf = pd.DataFrame([{
            "id": str(sid), "g_per_section": float(r["g"]),
            "b_per_section": float(r["b"]) / max(int(r["section_count"]), 1),
            "max_section_count": int(r["max_section_count"]),
        }]).set_index("id")
        ppn.create_shunt_compensator_bay(dst, shunt_df=sdf, linear_model_df=ldf)
    if to_open:
        present = set(dst.get_switches().index)
        opening = [s_ for s_ in to_open if s_ in present]
        if opening:
            dst.update_switches(id=opening, open=[True] * len(opening))
    _copy_phase_tap_changers(src, dst)
    copy_connection_state(src, dst)
    copy_slack_terminal(src, dst)
    return dst, nbus, n_rte


def copy_slack_terminal(src, dst) -> int:
    """Copy the designated slack bus (MATPOWER REF bus).

    Without it OpenLoadFlow picks its own slack, which redistributes the power
    balance and settles the rebuild on a visibly more stressed operating point
    than the source (peak loading 324 % vs 199 %) even though every element
    parameter is identical.
    """
    try:
        ext = src.get_extensions("slackTerminal")
    except Exception:  # noqa: BLE001  (extension absent)
        return 0
    if ext is None or ext.empty:
        return 0
    df = ext.reset_index()[["voltage_level_id", "element_id"]].set_index("voltage_level_id")
    dst.create_extensions("slackTerminal", df)
    return len(df)


def copy_connection_state(src, dst) -> int:
    """Replicate out-of-service elements (MATPOWER ``STATUS = 0``).

    The bay helpers create every feeder connected; the RTE cases carry ~700
    out-of-service generators, and silently connecting them injects phantom
    generation that makes the load flow diverge.
    """
    n = 0
    for getter in ("generators", "loads", "shunt_compensators"):
        s = getattr(src, f"get_{getter}")(all_attributes=True)
        if "connected" not in s.columns:
            continue
        off = [i for i, c in zip(s.index, s["connected"].astype(bool)) if not c]
        if off:
            getattr(dst, f"update_{getter}")(id=off, connected=[False] * len(off))
            n += len(off)
    for getter in ("lines", "2_windings_transformers"):
        s = getattr(src, f"get_{getter}")(all_attributes=True)
        for col in ("connected1", "connected2"):
            if col not in s.columns:
                continue
            off = [i for i, c in zip(s.index, s[col].astype(bool)) if not c]
            if off:
                getattr(dst, f"update_{getter}")(id=off, **{col: [False] * len(off)})
                n += len(off)
    return n


def _copy_phase_tap_changers(src, dst) -> int:
    """Re-create phase shifters (dropped by the transformer bay call)."""
    ptc = src.get_phase_tap_changers(all_attributes=True)
    if ptc.empty:
        return 0
    keep = [t for t in ptc.index if t in set(dst.get_2_windings_transformers().index)]
    if not keep:
        return 0
    steps = src.get_phase_tap_changer_steps().reset_index()
    ptc_df = pd.DataFrame({
        "id": keep,
        "low_tap": [int(ptc.loc[t, "low_tap"]) for t in keep],
        "tap": [int(ptc.loc[t, "tap"]) for t in keep],
        "regulating": [False] * len(keep),
        "regulation_mode": ["CURRENT_LIMITER"] * len(keep),
    }).set_index("id")
    steps_df = steps[steps["id"].isin(keep)][["id", "rho", "alpha", "r", "x", "g", "b"]].set_index("id")
    dst.create_phase_tap_changers(ptc_df, steps_df)
    return len(keep)


# MATPOWER bus-matrix column indices (standard layout).
_VM, _VA, _BASE_KV = 7, 8, 9


def seed_voltages(dst, case) -> int:
    """Seed the MATPOWER solved voltage state onto the rebuilt network.

    These RTE cases are stiff: they only AC-converge from their own solved
    (VM, VA) point, and rebuilding via ``create_empty`` starts flat. Seeding
    restores the warm start so a PREVIOUS_VALUES load flow converges.
    """
    ref = {int(r[0]): (float(r[_VM]) * float(r[_BASE_KV]), float(r[_VA])) for r in case.bus}
    buses = dst.get_buses(attributes=["voltage_level_id"])
    ids, mags, angs = [], [], []
    for bid, row in buses.iterrows():
        try:
            n = int(str(row["voltage_level_id"]).split("-")[-1])
        except ValueError:
            continue
        if n in ref:
            v, a = ref[n]
            ids.append(bid)
            mags.append(v)
            angs.append(a)
    if ids:
        dst.update_buses(id=ids, v_mag=mags, v_angle=angs)
    return len(ids)


def seed_voltages_from_network(src, dst) -> int:
    """Seed dst's bus voltages from src's ALREADY-SETTLED state.

    Preferred over :func:`seed_voltages`: the raw case (VM, VA) is a different
    starting point from the source network's converged operating point, and
    re-settling from it lands on a more stressed equilibrium. Copying the
    settled state keeps the rebuild on the same operating point as the source.
    """
    s = src.get_buses(attributes=["voltage_level_id", "v_mag", "v_angle"])
    by_vl = {r["voltage_level_id"]: (r["v_mag"], r["v_angle"]) for _, r in s.iterrows()}
    d = dst.get_buses(attributes=["voltage_level_id"])
    ids, mags, angs = [], [], []
    for bid, row in d.iterrows():
        hit = by_vl.get(row["voltage_level_id"])
        if hit and hit[0] == hit[0]:
            ids.append(bid)
            mags.append(float(hit[0]))
            angs.append(float(hit[1]))
    if ids:
        dst.update_buses(id=ids, v_mag=mags, v_angle=angs)
    return len(ids)


def copy_current_limits(src, dst) -> int:
    """Copy src's CURRENT permanent limits onto dst (element ids are preserved
    by the rebuild)."""
    ol = src.get_operational_limits(all_attributes=True).reset_index()
    perm = ol[(ol["type"] == "CURRENT") & (ol["acceptable_duration"] == -1)]
    dst_branches = set(dst.get_lines().index) | set(dst.get_2_windings_transformers().index)
    rows = [(str(r.element_id), str(r.side), "permanent_limit", "CURRENT",
             float(r.value), -1)
            for r in perm.itertuples(index=False) if str(r.element_id) in dst_branches]
    if not rows:
        return 0
    df = pd.DataFrame(rows, columns=["element_id", "side", "name", "type",
                                     "value", "acceptable_duration"]).set_index("element_id")
    dst.create_operational_limits(df)
    return len(df)


def validate(net) -> dict:
    """Run the BusView + topology-cache checks that flush out invalid builds."""
    out = {}
    for name, fn in [("buses", lambda: net.get_buses(attributes=["connected_component"])),
                     ("loads", lambda: net.get_loads(attributes=["bus_id"])),
                     ("gens", lambda: net.get_generators(attributes=["bus_id"])),
                     ("branches", lambda: net.get_branches(attributes=["bus1_id", "bus2_id"]))]:
        try:
            fn()
            out[name] = "ok"
        except Exception as ex:  # noqa: BLE001
            out[name] = f"FAIL {type(ex).__name__}: {str(ex)[:80]}"
    return out
