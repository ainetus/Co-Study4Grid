"""
convert_pypsa_to_xiidm.py
=========================
Converts the France OSM dataset (Zenodo 18619025) directly into a
pypowsybl XIIDM network file — no MATPOWER intermediate step.

Pipeline steps:
  1. load       — Load & filter buses/lines/transformers from raw OSM CSVs
  2. network    — Build a pypowsybl Network object (node-breaker topology)
  3. calibrate  — Calibrate operational limits from N-state AC loadflow
  4. n1verify   — N-1 verification pass: cap overloads at 130% (slow, skippable)
  5. metadata   — Write grid_layout.json, bus_id_mapping.json, actions.json

Usage:
    # Full pipeline (default)
    python scripts/convert_pypsa_to_xiidm.py --voltages 225,400

    # Skip N-1 verification (much faster for large networks)
    python scripts/convert_pypsa_to_xiidm.py --voltages 225,400 --skip-n1

    # Run only specific steps
    python scripts/convert_pypsa_to_xiidm.py --voltages 225,400 --steps 1,2,5

    # Resume from a specific step (network.xiidm must already exist)
    python scripts/convert_pypsa_to_xiidm.py --voltages 225,400 --from-step 3

    # Regenerate only metadata (layout, actions, mapping)
    python scripts/convert_pypsa_to_xiidm.py --voltages 225,400 --from-step 5
"""

import os
import re
import json
import math
import logging
import argparse
import warnings
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd
import networkx as nx

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Shared utilities
# ─────────────────────────────────────────────────────────────────────────────


def safe_id(raw: str) -> str:
    """Convert an OSM id to a valid IIDM identifier."""
    return re.sub(r"[^A-Za-z0-9_\-\.]", "_", raw)


EARTH_RADIUS = 6_378_137.0  # WGS-84 semi-major axis (metres)


def lon_lat_to_mercator(lon: float, lat: float) -> tuple:
    """Project WGS-84 lon/lat to Web Mercator."""
    x = math.radians(lon) * EARTH_RADIUS
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH_RADIUS
    return x, y


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline state: carries data between steps
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class PipelineContext:
    """Shared state passed between pipeline steps."""

    # Config
    target_voltages: list = field(default_factory=list)
    target_country: Optional[str] = "FR"
    data_dir: str = ""
    out_dir: str = ""

    # Step 1 outputs
    buses: Optional[pd.DataFrame] = None
    lines: Optional[pd.DataFrame] = None
    trafos: Optional[pd.DataFrame] = None
    bus_list: list = field(default_factory=list)
    slack_bus: str = ""
    bus_display_names: dict = field(default_factory=dict)
    line_display_names: dict = field(default_factory=dict)

    # Step 2 outputs
    vl_next_node: dict = field(default_factory=dict)
    bus_to_ss: dict = field(default_factory=dict)
    vl_df: Optional[pd.DataFrame] = None
    line_ids: list = field(default_factory=list)
    line_data: dict = field(default_factory=dict)
    t_ids: list = field(default_factory=list)
    t_data: dict = field(default_factory=dict)
    line_i_nom: dict = field(default_factory=dict)
    xiidm_path: str = ""
    node_counter_path: str = ""

    # Step 3 outputs
    lim_map: dict = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Load and filter data
# ─────────────────────────────────────────────────────────────────────────────


def step_load_data(ctx: PipelineContext) -> None:
    """Load raw OSM CSVs, filter by country/voltage, keep main connected component."""

    # ── Load CSVs ──
    log.info("Step 1 — Loading raw OSM CSVs …")
    buses_raw = pd.read_csv(os.path.join(ctx.data_dir, "buses.csv"), index_col=0)
    lines_raw = pd.read_csv(
        os.path.join(ctx.data_dir, "lines.csv"), index_col=0, quotechar="'"
    )
    trafos_raw = pd.read_csv(
        os.path.join(ctx.data_dir, "transformers.csv"), index_col=0, quotechar="'"
    )
    log.info(
        f"  Raw: {len(buses_raw)} buses, {len(lines_raw)} lines, {len(trafos_raw)} trafos"
    )

    # ── Filter ──
    country_label = ctx.target_country if ctx.target_country else "ALL countries"
    log.info(
        f"Step 1b — Filtering to {country_label} "
        f"{'/'.join(str(int(v)) for v in ctx.target_voltages)} kV AC …"
    )
    voltage_mask = (
        buses_raw["voltage"].isin(ctx.target_voltages)
        & (buses_raw["dc"] == "f")
        & (buses_raw["under_construction"] == "f")
    )
    if ctx.target_country:
        voltage_mask = voltage_mask & (buses_raw["country"] == ctx.target_country)
    buses = buses_raw[voltage_mask].copy()

    bus_ids = set(buses.index)
    lines = lines_raw[
        lines_raw["bus0"].isin(bus_ids)
        & lines_raw["bus1"].isin(bus_ids)
        & (lines_raw["under_construction"] == "f")
    ].copy()
    trafos = trafos_raw[
        trafos_raw["bus0"].isin(bus_ids) & trafos_raw["bus1"].isin(bus_ids)
    ].copy()

    log.info(
        f"  After filter: {len(buses)} buses, {len(lines)} lines, {len(trafos)} trafos"
    )

    # ── Connected component ──
    log.info("Step 1c — Connected component analysis …")
    G = nx.Graph()
    G.add_nodes_from(bus_ids)
    for _, row in lines.iterrows():
        G.add_edge(row["bus0"], row["bus1"])
    for _, row in trafos.iterrows():
        G.add_edge(row["bus0"], row["bus1"])

    main_comp = max(nx.connected_components(G), key=len)
    log.info(f"  Main component: {len(main_comp)} buses")

    buses = buses[buses.index.isin(main_comp)].copy()
    lines = lines[
        lines["bus0"].isin(main_comp) & lines["bus1"].isin(main_comp)
    ].copy()
    trafos = trafos[
        trafos["bus0"].isin(main_comp) & trafos["bus1"].isin(main_comp)
    ].copy()

    bus_list = sorted(buses.index.tolist())
    log.info(
        f"  Final: {len(buses)} buses, {len(lines)} lines, {len(trafos)} trafos"
    )

    # ── Load OSM names ──
    osm_names_file = os.path.join(ctx.out_dir, "osm_names.json")
    bus_display_names = {}
    line_display_names = {}

    if os.path.exists(osm_names_file):
        log.info("Step 1d — Loading OSM names for real labels …")
        with open(osm_names_file, encoding="utf-8") as f:
            osm_names = json.load(f)
        for bus_idx, info in osm_names.get("bus_to_name", {}).items():
            name = info.get("display_name", "")
            if name:
                bus_display_names[bus_idx] = name
        for line_idx, info in osm_names.get("line_to_name", {}).items():
            name = info.get("name") or info.get("display_name", "")
            if name:
                line_display_names[line_idx] = name
        log.info(
            f"  Loaded {len(bus_display_names)} bus names, "
            f"{len(line_display_names)} line names"
        )
    else:
        log.warning(
            "  osm_names.json not found — using raw IDs. "
            "Run fetch_osm_names.py first."
        )

    # Store in context
    ctx.buses = buses
    ctx.lines = lines
    ctx.trafos = trafos
    ctx.bus_list = bus_list
    ctx.slack_bus = bus_list[0]
    ctx.bus_display_names = bus_display_names
    ctx.line_display_names = line_display_names


# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Build pypowsybl Network + export XIIDM
# ─────────────────────────────────────────────────────────────────────────────


def step_build_network(ctx: PipelineContext) -> None:
    """Build pypowsybl Network from filtered data, export to XIIDM."""
    import pypowsybl as pp

    buses = ctx.buses
    lines = ctx.lines
    trafos = ctx.trafos
    bus_list = ctx.bus_list

    def _bus_name(bus_id: str) -> str:
        return ctx.bus_display_names.get(bus_id, safe_id(bus_id))

    def _line_name(line_id: str) -> str:
        return ctx.line_display_names.get(line_id, str(line_id))

    log.info("Step 2 — Building pypowsybl Network …")

    country_slug = ctx.target_country.lower() if ctx.target_country else "eur"
    v_str = "_".join(str(int(v)) for v in ctx.target_voltages)
    n = pp.network.create_empty(f"pypsa_eur_{country_slug}{v_str}")

    # ── Substations (merge transformer-connected buses) ──
    bus_to_ss = {b: f"SS_{safe_id(b)}" for b in bus_list}
    for _, row in trafos.iterrows():
        b0, b1 = row["bus0"], row["bus1"]
        if b0 in bus_to_ss and b1 in bus_to_ss:
            bus_to_ss[b1] = bus_to_ss[b0]

    unique_ss = sorted(set(bus_to_ss.values()))
    log.info(f"  Substations: {len(unique_ss)} (merged trafo pairs)")

    ss_name_map = {}
    ss_country_map = {}
    for b in bus_list:
        ss_id = bus_to_ss[b]
        if ss_id not in ss_name_map:
            ss_name_map[ss_id] = _bus_name(b)
            ss_country_map[ss_id] = (
                ctx.target_country
                if ctx.target_country
                else str(buses.loc[b, "country"]) if "country" in buses.columns else ""
            )

    n.create_substations(
        pd.DataFrame(
            {
                "country": [ss_country_map.get(ss, ctx.target_country or "") for ss in unique_ss],
                "name": [ss_name_map.get(ss, ss) for ss in unique_ss],
            },
            index=unique_ss,
        )
    )

    # ── Voltage levels ──
    vl_names = []
    for b in bus_list:
        display = _bus_name(b)
        kv = int(buses.loc[b, "voltage"])
        vl_names.append(f"{display} {kv}kV")

    vl_df = pd.DataFrame(
        {
            "substation_id": [bus_to_ss[b] for b in bus_list],
            "topology_kind": ["NODE_BREAKER"] * len(bus_list),
            "nominal_v": [float(buses.loc[b, "voltage"]) for b in bus_list],
            "high_voltage_limit": [
                float(buses.loc[b, "voltage"]) * 1.10 for b in bus_list
            ],
            "low_voltage_limit": [
                float(buses.loc[b, "voltage"]) * 0.90 for b in bus_list
            ],
            "name": vl_names,
        },
        index=[f"VL_{safe_id(b)}" for b in bus_list],
    )
    n.create_voltage_levels(vl_df)

    # ── Busbar sections ──
    bbs_df = pd.DataFrame(
        {
            "voltage_level_id": [f"VL_{safe_id(b)}" for b in bus_list],
            "node": [0] * len(bus_list),
            "name": [f"{_bus_name(b)} JdB1" for b in bus_list],
        },
        index=[f"VL_{safe_id(b)}_BBS1" for b in bus_list],
    )
    n.create_busbar_sections(bbs_df)
    log.info(f"  Created {len(bus_list)} VLs with node-breaker topology")

    # ── Node counter ──
    vl_next_node = {f"VL_{safe_id(b)}": 2 for b in bus_list}

    def _allocate_nodes(vl_id: str, count: int) -> list:
        start = vl_next_node[vl_id]
        vl_next_node[vl_id] = start + count
        return list(range(start, start + count))

    # ── Generators and loads ──
    log.info("Step 2b — Adding generators and loads …")

    target_total_load_mw = 75000.0
    target_total_gen_mw = 85000.0
    load_scale = target_total_load_mw / len(bus_list)
    gen_scale = target_total_gen_mw / len(bus_list)

    degree_graph = nx.Graph()
    degree_graph.add_nodes_from(bus_list)
    for _, row in lines.iterrows():
        if row["bus0"] in bus_list and row["bus1"] in bus_list:
            degree_graph.add_edge(row["bus0"], row["bus1"])
    for _, row in trafos.iterrows():
        if row["bus0"] in bus_list and row["bus1"] in bus_list:
            degree_graph.add_edge(row["bus0"], row["bus1"])

    bus_degrees = dict(degree_graph.degree())
    min_degree = min(bus_degrees.values()) if bus_degrees else 1
    max_degree = max(bus_degrees.values()) if bus_degrees else 1
    degree_weights = {
        b: max(1.0, float(bus_degrees[b] - min_degree + 1)) for b in bus_list
    }
    degree_weight_sum = sum(degree_weights.values())

    log.info(
        f"  Bus connectivity: min degree {min_degree}, max degree {max_degree}, "
        f"avg {sum(bus_degrees.values()) / len(bus_list):.1f}"
    )

    gen_sw_ids, gen_sw_data = [], {
        "voltage_level_id": [], "node1": [], "node2": [], "kind": [], "name": [],
    }
    gen_ids, gen_data = [], {
        "voltage_level_id": [], "node": [], "target_p": [], "target_q": [],
        "target_v": [], "min_p": [], "max_p": [], "voltage_regulator_on": [],
    }
    load_sw_ids, load_sw_data = [], {
        "voltage_level_id": [], "node1": [], "node2": [], "kind": [], "name": [],
    }
    load_ids, load_data = [], {
        "voltage_level_id": [], "node": [], "p0": [], "q0": [],
    }

    for b in bus_list:
        vl_id = f"VL_{safe_id(b)}"
        g_id = f"G_{safe_id(b)}"
        l_id = f"L_{safe_id(b)}"

        # Generator switches + data
        node_d, node_e = _allocate_nodes(vl_id, 2)
        gen_sw_ids.extend([f"{vl_id}_D_{g_id}", f"{vl_id}_BK_{g_id}"])
        for sw_id, n1, n2, kind, sw_name in [
            (f"{vl_id}_D_{g_id}", 0, node_d, "DISCONNECTOR", f"D {g_id[:25]}"),
            (f"{vl_id}_BK_{g_id}", node_d, node_e, "BREAKER", f"BK {g_id[:24]}"),
        ]:
            gen_sw_data["voltage_level_id"].append(vl_id)
            gen_sw_data["node1"].append(n1)
            gen_sw_data["node2"].append(n2)
            gen_sw_data["kind"].append(kind)
            gen_sw_data["name"].append(sw_name)

        gen_ids.append(g_id)
        gen_data["voltage_level_id"].append(vl_id)
        gen_data["node"].append(node_e)
        gen_data["target_p"].append(gen_scale)
        gen_data["target_q"].append(0.0)
        gen_data["target_v"].append(float(buses.loc[b, "voltage"]))
        gen_data["min_p"].append(0.0)
        gen_data["max_p"].append(
            gen_scale * 2.0 if b == ctx.slack_bus else gen_scale * 1.5
        )
        gen_data["voltage_regulator_on"].append(True)

        # Load switches + data
        node_d, node_e = _allocate_nodes(vl_id, 2)
        load_sw_ids.extend([f"{vl_id}_D_{l_id}", f"{vl_id}_BK_{l_id}"])
        for sw_id, n1, n2, kind, sw_name in [
            (f"{vl_id}_D_{l_id}", 0, node_d, "DISCONNECTOR", f"D {l_id[:25]}"),
            (f"{vl_id}_BK_{l_id}", node_d, node_e, "BREAKER", f"BK {l_id[:24]}"),
        ]:
            load_sw_data["voltage_level_id"].append(vl_id)
            load_sw_data["node1"].append(n1)
            load_sw_data["node2"].append(n2)
            load_sw_data["kind"].append(kind)
            load_sw_data["name"].append(sw_name)

        weight = degree_weights.get(b, 1.0)
        load_mw = (load_scale * weight / degree_weight_sum) * len(bus_list)
        load_ids.append(l_id)
        load_data["voltage_level_id"].append(vl_id)
        load_data["node"].append(node_e)
        load_data["p0"].append(load_mw)
        load_data["q0"].append(load_mw * 0.1)

    n.create_switches(pd.DataFrame(gen_sw_data, index=gen_sw_ids))
    n.create_generators(pd.DataFrame(gen_data, index=gen_ids))
    n.create_switches(pd.DataFrame(load_sw_data, index=load_sw_ids))
    n.create_loads(pd.DataFrame(load_data, index=load_ids))
    log.info(
        f"  Added {len(gen_ids)} generators + {len(load_ids)} loads "
        f"(gen={target_total_gen_mw:.0f} MW, load={target_total_load_mw:.0f} MW)"
    )

    # ── AC lines ──
    log.info("Step 2c — Adding AC lines …")

    line_sw_ids, line_sw_data = [], {
        "voltage_level_id": [], "node1": [], "node2": [], "kind": [], "name": [],
    }
    line_ids, line_data_dict = [], {
        "voltage_level1_id": [], "node1": [], "voltage_level2_id": [], "node2": [],
        "r": [], "x": [], "b1": [], "b2": [], "g1": [], "g2": [], "name": [],
    }
    line_i_nom = {}
    skipped = 0
    seen_ids = set()

    for line_id, row in lines.iterrows():
        try:
            b0 = safe_id(row["bus0"])
            b1 = safe_id(row["bus1"])
            vl1_id = f"VL_{b0}"
            vl2_id = f"VL_{b1}"
            circuits = max(1, int(row.get("circuits", 1) or 1))
            r = max(float(row["r"]) / circuits, 1e-4)
            x = max(float(row["x"]) / circuits, 1e-3)
            b = float(row["b"]) * circuits

            uid = safe_id(line_id)
            counter = 0
            while uid in seen_ids:
                counter += 1
                uid = f"{safe_id(line_id)}_{counter}"
            seen_ids.add(uid)

            # Side 1 switches
            node_d1, node_e1 = _allocate_nodes(vl1_id, 2)
            for sw_id, n1, n2, kind, sw_name in [
                (f"{vl1_id}_D_{uid}_s1", 0, node_d1, "DISCONNECTOR", f"D {uid[:23]}_s1"),
                (f"{vl1_id}_BK_{uid}_s1", node_d1, node_e1, "BREAKER", f"BK {uid[:22]}_s1"),
            ]:
                line_sw_ids.append(sw_id)
                line_sw_data["voltage_level_id"].append(vl1_id)
                line_sw_data["node1"].append(n1)
                line_sw_data["node2"].append(n2)
                line_sw_data["kind"].append(kind)
                line_sw_data["name"].append(sw_name)

            # Side 2 switches
            node_d2, node_e2 = _allocate_nodes(vl2_id, 2)
            for sw_id, n1, n2, kind, sw_name in [
                (f"{vl2_id}_D_{uid}_s2", 0, node_d2, "DISCONNECTOR", f"D {uid[:23]}_s2"),
                (f"{vl2_id}_BK_{uid}_s2", node_d2, node_e2, "BREAKER", f"BK {uid[:22]}_s2"),
            ]:
                line_sw_ids.append(sw_id)
                line_sw_data["voltage_level_id"].append(vl2_id)
                line_sw_data["node1"].append(n1)
                line_sw_data["node2"].append(n2)
                line_sw_data["kind"].append(kind)
                line_sw_data["name"].append(sw_name)

            line_ids.append(uid)
            line_data_dict["voltage_level1_id"].append(vl1_id)
            line_data_dict["node1"].append(node_e1)
            line_data_dict["voltage_level2_id"].append(vl2_id)
            line_data_dict["node2"].append(node_e2)
            line_data_dict["r"].append(r)
            line_data_dict["x"].append(x)
            line_data_dict["b1"].append(b / 2)
            line_data_dict["b2"].append(b / 2)
            line_data_dict["g1"].append(0.0)
            line_data_dict["g2"].append(0.0)
            line_data_dict["name"].append(_line_name(line_id))

            i_nom_ka = float(row.get("i_nom", 0) or 0)
            if i_nom_ka > 0:
                line_i_nom[uid] = i_nom_ka * 1000.0 * circuits
        except Exception as e:
            log.debug(f"  Skipping line {line_id}: {e}")
            skipped += 1

    n.create_switches(pd.DataFrame(line_sw_data, index=line_sw_ids))
    n.create_lines(pd.DataFrame(line_data_dict, index=line_ids))
    log.info(f"  Added {len(line_ids)} lines (skipped {skipped})")

    # Operational limits
    if line_i_nom:
        limit_ids, limit_data = [], {
            "element_id": [], "element_type": [], "side": [],
            "name": [], "type": [], "value": [], "acceptable_duration": [],
        }
        for uid, i_lim_a in line_i_nom.items():
            limit_ids.append(f"{uid}_perm_limit")
            limit_data["element_id"].append(uid)
            limit_data["element_type"].append("LINE")
            limit_data["side"].append("ONE")
            limit_data["name"].append("permanent_limit")
            limit_data["type"].append("CURRENT")
            limit_data["value"].append(i_lim_a)
            limit_data["acceptable_duration"].append(-1)
        n.create_operational_limits(pd.DataFrame(limit_data, index=limit_ids))
        log.info(f"  Added permanent current limits to {len(limit_ids)} lines")

    # ── Transformers ──
    log.info("Step 2d — Adding transformers …")
    t_ids, t_data_dict = [], {
        "rated_u1": [], "rated_u2": [], "rated_s": [], "r": [], "x": [],
        "g": [], "b": [], "voltage_level1_id": [], "node1": [],
        "voltage_level2_id": [], "node2": [], "name": [],
    }

    if len(trafos) > 0:
        t_sw_ids, t_sw_data = [], {
            "voltage_level_id": [], "node1": [], "node2": [], "kind": [], "name": [],
        }
        for tid, row in trafos.iterrows():
            b0 = safe_id(row["bus0"])
            b1 = safe_id(row["bus1"])
            vl1_id = f"VL_{b0}"
            vl2_id = f"VL_{b1}"
            v0 = (
                float(buses.loc[row["bus0"], "voltage"])
                if row["bus0"] in buses.index else 400.0
            )
            v1 = (
                float(buses.loc[row["bus1"], "voltage"])
                if row["bus1"] in buses.index else 400.0
            )
            s = float(row["s_nom"]) if pd.notna(row.get("s_nom")) else 100.0
            t_id = f"T_{safe_id(tid)}"

            # Side 1 switches
            node_d1, node_e1 = _allocate_nodes(vl1_id, 2)
            for sw_id, n1, n2, kind, sw_name in [
                (f"{vl1_id}_D_{t_id}_s1", 0, node_d1, "DISCONNECTOR", f"D {t_id[:23]}_s1"),
                (f"{vl1_id}_BK_{t_id}_s1", node_d1, node_e1, "BREAKER", f"BK {t_id[:22]}_s1"),
            ]:
                t_sw_ids.append(sw_id)
                t_sw_data["voltage_level_id"].append(vl1_id)
                t_sw_data["node1"].append(n1)
                t_sw_data["node2"].append(n2)
                t_sw_data["kind"].append(kind)
                t_sw_data["name"].append(sw_name)

            # Side 2 switches
            node_d2, node_e2 = _allocate_nodes(vl2_id, 2)
            for sw_id, n1, n2, kind, sw_name in [
                (f"{vl2_id}_D_{t_id}_s2", 0, node_d2, "DISCONNECTOR", f"D {t_id[:23]}_s2"),
                (f"{vl2_id}_BK_{t_id}_s2", node_d2, node_e2, "BREAKER", f"BK {t_id[:22]}_s2"),
            ]:
                t_sw_ids.append(sw_id)
                t_sw_data["voltage_level_id"].append(vl2_id)
                t_sw_data["node1"].append(n1)
                t_sw_data["node2"].append(n2)
                t_sw_data["kind"].append(kind)
                t_sw_data["name"].append(sw_name)

            t_ids.append(t_id)
            t_data_dict["rated_u1"].append(v0)
            t_data_dict["rated_u2"].append(v1)
            t_data_dict["rated_s"].append(s)
            t_data_dict["r"].append(0.1)
            t_data_dict["x"].append(10.0)
            t_data_dict["g"].append(0.0)
            t_data_dict["b"].append(0.0)
            t_data_dict["voltage_level1_id"].append(vl1_id)
            t_data_dict["node1"].append(node_e1)
            t_data_dict["voltage_level2_id"].append(vl2_id)
            t_data_dict["node2"].append(node_e2)
            t_data_dict["name"].append(
                f"{_bus_name(row['bus0'])} - {_bus_name(row['bus1'])}"
            )

        n.create_switches(pd.DataFrame(t_sw_data, index=t_sw_ids))
        n.create_2_windings_transformers(pd.DataFrame(t_data_dict, index=t_ids))
        log.info(f"  Added {len(t_ids)} transformers")
    else:
        log.info("  No transformers to add")

    # ── Export XIIDM ──
    log.info("Step 2e — Exporting to XIIDM …")
    xiidm_path = os.path.join(ctx.out_dir, "network.xiidm")
    n.dump(xiidm_path, format="XIIDM")
    size_kb = os.path.getsize(xiidm_path) / 1024
    log.info(f"  Written: {xiidm_path}  ({size_kb:.1f} KB)")

    node_counter_path = os.path.join(ctx.out_dir, "vl_next_node.json")
    with open(node_counter_path, "w") as f:
        json.dump(vl_next_node, f, indent=2)
    log.info(f"  Written: {node_counter_path}")

    # Round-trip verification
    n2 = pp.network.load(xiidm_path)
    log.info(
        f"  Round-trip: {len(n2.get_buses())} buses, {len(n2.get_lines())} lines, "
        f"{len(n2.get_2_windings_transformers())} trafos, "
        f"{len(n2.get_switches())} switches"
    )

    # Store in context
    ctx.vl_next_node = vl_next_node
    ctx.bus_to_ss = bus_to_ss
    ctx.vl_df = vl_df
    ctx.line_ids = line_ids
    ctx.line_data = line_data_dict
    ctx.t_ids = t_ids
    ctx.t_data = t_data_dict
    ctx.line_i_nom = line_i_nom
    ctx.xiidm_path = xiidm_path
    ctx.node_counter_path = node_counter_path


# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Calibrate operational limits from N-state flows
# ─────────────────────────────────────────────────────────────────────────────


def step_calibrate_limits(ctx: PipelineContext) -> None:
    """Calibrate operational limits using rank-based distribution from AC loadflow."""
    import pypowsybl as pp
    import numpy as np
    import hashlib

    log.info("Step 3 — Calibrating operational limits from N-state flows …")

    xiidm_path = ctx.xiidm_path
    if not xiidm_path:
        xiidm_path = os.path.join(ctx.out_dir, "network.xiidm")
        ctx.xiidm_path = xiidm_path

    from expert_op4grid_recommender.utils.make_env_utils import (
        create_olf_rte_parameter as _olf_params,
    )

    n2 = pp.network.load(xiidm_path)
    lf_results = pp.loadflow.run_ac(n2, parameters=_olf_params())
    lf_ok = any(r.status.name == "CONVERGED" for r in lf_results)

    if not lf_ok:
        log.warning("  AC load flow did not converge — keeping raw i_nom limits")
        return

    n2_lines = n2.get_lines()[["i1", "i2"]]
    MIN_LIMIT_A = 100.0
    LOADING_MIN = 0.20
    LOADING_MAX = 0.65

    # Compute N-state flow per line
    line_flows = {}
    for lid, row in n2_lines.iterrows():
        if np.isnan(row["i1"]) or np.isnan(row["i2"]):
            continue
        line_flows[lid] = max(abs(row["i1"]), abs(row["i2"]))

    sorted_lines = sorted(line_flows.items(), key=lambda x: x[1], reverse=True)
    n_lines = len(sorted_lines)
    lim_map = {}
    loadings = []

    for rank, (lid, flow) in enumerate(sorted_lines):
        t = rank / max(1, n_lines - 1)
        target_loading = LOADING_MAX - (LOADING_MAX - LOADING_MIN) * (t ** 0.6)

        hash_val = int(hashlib.md5(lid.encode()).hexdigest()[:8], 16)
        jitter = ((hash_val % 1000) / 1000.0 - 0.5) * 0.10
        target_loading = max(LOADING_MIN, min(LOADING_MAX, target_loading + jitter))

        new_lim = max(MIN_LIMIT_A, flow / target_loading)
        lim_map[lid] = new_lim
        if new_lim > 0:
            loadings.append(flow / new_lim * 100.0)

    loadings.sort()
    pct_below_50 = sum(1 for x in loadings if x <= 50.0) / len(loadings) * 100
    log.info("  N-state loading distribution:")
    log.info(
        f"    min={loadings[0]:.1f}%, median={loadings[len(loadings) // 2]:.1f}%, "
        f"max={loadings[-1]:.1f}%"
    )
    log.info(f"    {pct_below_50:.0f}% of lines at ≤50% loading")
    log.info(
        f"    P25={loadings[len(loadings) // 4]:.1f}%, "
        f"P75={loadings[3 * len(loadings) // 4]:.1f}%, "
        f"P90={loadings[int(len(loadings) * 0.9)]:.1f}%"
    )

    # Update limits in XIIDM XML
    from lxml import etree

    tree = etree.parse(xiidm_path)
    root = tree.getroot()
    xml_updated = 0
    for line_el in root.iter():
        tag = line_el.tag.split("}")[-1] if "}" in line_el.tag else line_el.tag
        if tag == "line":
            el_id = line_el.get("id")
            if el_id in lim_map:
                for cl_el in line_el.iter():
                    cl_tag = (
                        cl_el.tag.split("}")[-1] if "}" in cl_el.tag else cl_el.tag
                    )
                    if cl_tag == "currentLimits" and "permanentLimit" in cl_el.attrib:
                        cl_el.set("permanentLimit", f"{lim_map[el_id]:.1f}")
                        xml_updated += 1
    tree.write(xiidm_path, xml_declaration=True, encoding="UTF-8")
    log.info(f"  Updated {xml_updated} line limits in XML")

    ctx.lim_map = lim_map


# ─────────────────────────────────────────────────────────────────────────────
# Step 4: N-1 verification pass (optional, slow)
# ─────────────────────────────────────────────────────────────────────────────


def step_n1_verify(ctx: PipelineContext) -> None:
    """Run all N-1 contingencies and bump limits exceeding 130%."""
    import pypowsybl as pp
    import numpy as np

    log.info("Step 4 — N-1 verification pass …")

    xiidm_path = ctx.xiidm_path
    if not xiidm_path:
        xiidm_path = os.path.join(ctx.out_dir, "network.xiidm")
        ctx.xiidm_path = xiidm_path

    lim_map = ctx.lim_map
    if not lim_map:
        log.warning("  No limit map available — skipping N-1 verification")
        return

    from expert_op4grid_recommender.utils.make_env_utils import (
        create_olf_rte_parameter as _olf_params,
    )
    from lxml import etree

    MAX_N1_LOADING = 1.30
    MAX_N1_PASSES = 3

    for pass_num in range(1, MAX_N1_PASSES + 1):
        log.info(
            f"  N-1 verification pass {pass_num} "
            f"(cap={MAX_N1_LOADING * 100:.0f}%) …"
        )
        n1_net = pp.network.load(xiidm_path)
        n1_lines_list = list(n1_net.get_lines().index)
        bumps = {}

        for i, cont_id in enumerate(n1_lines_list):
            if (i + 1) % 200 == 0:
                log.info(
                    f"    Progress: {i + 1}/{len(n1_lines_list)} contingencies …"
                )
            nc = pp.network.load(xiidm_path)
            try:
                nc.update_lines(id=[cont_id], connected1=[False], connected2=[False])
            except Exception:
                continue
            lf_c = pp.loadflow.run_ac(nc, parameters=_olf_params())
            if not any(r.status.name == "CONVERGED" for r in lf_c):
                continue
            c_lines = nc.get_lines()[["i1", "i2"]]
            for clid, crow in c_lines.iterrows():
                if clid == cont_id or np.isnan(crow["i1"]):
                    continue
                c_flow = max(abs(crow["i1"]), abs(crow["i2"]))
                c_lim = lim_map.get(clid, 0)
                if c_lim > 0 and c_flow / c_lim > MAX_N1_LOADING:
                    needed = c_flow / (MAX_N1_LOADING - 0.02)
                    if clid not in bumps or needed > bumps[clid]:
                        bumps[clid] = needed

        if not bumps:
            log.info(
                f"    No lines exceed {MAX_N1_LOADING * 100:.0f}% — "
                f"verification passed ✓"
            )
            break

        log.info(
            f"    Bumping limits on {len(bumps)} lines to stay under "
            f"{MAX_N1_LOADING * 100:.0f}%"
        )
        for bid, new_val in bumps.items():
            lim_map[bid] = new_val

        # Re-write XML with bumped limits
        tree = etree.parse(xiidm_path)
        root = tree.getroot()
        for line_el in root.iter():
            tag = line_el.tag.split("}")[-1] if "}" in line_el.tag else line_el.tag
            if tag == "line":
                el_id = line_el.get("id")
                if el_id in bumps:
                    for cl_el in line_el.iter():
                        cl_tag = (
                            cl_el.tag.split("}")[-1]
                            if "}" in cl_el.tag
                            else cl_el.tag
                        )
                        if (
                            cl_tag == "currentLimits"
                            and "permanentLimit" in cl_el.attrib
                        ):
                            cl_el.set("permanentLimit", f"{lim_map[el_id]:.1f}")
        tree.write(xiidm_path, xml_declaration=True, encoding="UTF-8")
    else:
        log.warning(
            f"  N-1 verification did not converge after {MAX_N1_PASSES} passes"
        )

    # Final N-state loading summary
    n_final = pp.network.load(xiidm_path)
    pp.loadflow.run_ac(n_final, parameters=_olf_params())
    final_lines = n_final.get_lines()[["i1", "i2"]]
    final_loadings = []
    for flid, frow in final_lines.iterrows():
        if np.isnan(frow["i1"]):
            continue
        f_flow = max(abs(frow["i1"]), abs(frow["i2"]))
        f_lim = lim_map.get(flid, 0)
        if f_lim > 0:
            final_loadings.append(f_flow / f_lim * 100.0)
    final_loadings.sort()
    f_pct50 = sum(1 for x in final_loadings if x <= 50.0) / len(final_loadings) * 100
    log.info(
        f"  Final N-state loading: min={final_loadings[0]:.1f}%, "
        f"median={final_loadings[len(final_loadings) // 2]:.1f}%, "
        f"max={final_loadings[-1]:.1f}%, "
        f"{f_pct50:.0f}% at ≤50%"
    )

    ctx.lim_map = lim_map


# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Write metadata (layout, mapping, actions)
# ─────────────────────────────────────────────────────────────────────────────


def step_write_metadata(ctx: PipelineContext) -> None:
    """Write grid_layout.json, bus_id_mapping.json, and actions.json."""
    buses = ctx.buses
    bus_list = ctx.bus_list

    def _bus_name(bus_id: str) -> str:
        return ctx.bus_display_names.get(bus_id, safe_id(bus_id))

    # ── Grid layout (Mercator projection) ──
    log.info("Step 5 — Writing grid_layout.json …")

    # Raw Mercator metres — NOT the legacy 8 000-unit rescale. pypowsybl emits
    # VL outer circles at a FIXED r=27.5 user-units regardless of layout extent,
    # so a layout squashed to ~8 000 units across France forces the disks to
    # overlap into a blob on dense regions (Paris/Lyon). Keep the projection at
    # native metre scale (span ~1.4 M for France) and only re-centre it near the
    # origin. This matches regenerate_grid_layout.py's default and the contract
    # in docs/data/grid-layout-coordinate-scale.md (the 2026-05-08 fix). The old
    # `TARGET_WIDTH = 8_000` rescale here silently produced the forbidden layout.
    raw_positions = {}
    for bus_id, row in buses.iterrows():
        sid = safe_id(bus_id)
        lon = float(row["x"])
        lat = float(row["y"])
        mx, my = lon_lat_to_mercator(lon, lat)
        raw_positions[f"VL_{sid}"] = (mx, -my)

    raw_xs = [v[0] for v in raw_positions.values()]
    raw_ys = [v[1] for v in raw_positions.values()]
    p_cx = (min(raw_xs) + max(raw_xs)) / 2
    p_cy = (min(raw_ys) + max(raw_ys)) / 2

    layout = {}
    for vl_id, (rx, ry) in raw_positions.items():
        layout[vl_id] = [round(rx - p_cx, 2), round(ry - p_cy, 2)]

    layout_path = os.path.join(ctx.out_dir, "grid_layout.json")
    with open(layout_path, "w") as f:
        json.dump(layout, f, indent=2)
    log.info(f"  Written: {layout_path}  ({len(layout)} entries)")

    # ── Bus ID mapping ──
    log.info("Step 5b — Writing bus_id_mapping.json …")
    mapping = {safe_id(b): b for b in buses.index}
    mapping_path = os.path.join(ctx.out_dir, "bus_id_mapping.json")
    with open(mapping_path, "w") as f:
        json.dump(mapping, f, indent=2)
    log.info(f"  Written: {mapping_path}")

    # ── Actions ──
    log.info("Step 5c — Generating actions.json …")

    line_ids = ctx.line_ids
    line_data = ctx.line_data
    vl_df = ctx.vl_df

    # If line_ids is empty, we need to reload from existing XIIDM
    if not line_ids:
        log.info("  Loading line/transformer IDs from existing XIIDM …")
        import xml.etree.ElementTree as ET

        xiidm_path = ctx.xiidm_path or os.path.join(ctx.out_dir, "network.xiidm")
        tree = ET.parse(xiidm_path)
        root = tree.getroot()
        ns = ""
        if root.tag.startswith("{"):
            ns = root.tag.split("}")[0] + "}"

        # Extract lines
        for elem in root.iter():
            tag = elem.tag.replace(ns, "")
            if tag == "line":
                lid = elem.get("id")
                lname = elem.get("name", lid)
                if lid:
                    line_ids.append(lid)
                    if "name" not in line_data:
                        line_data["name"] = []
                    line_data["name"].append(lname)
                    # Extract VL IDs from parent structure
                    vl1 = elem.get("voltageLevelId1", "")
                    vl2 = elem.get("voltageLevelId2", "")
                    if "voltage_level1_id" not in line_data:
                        line_data["voltage_level1_id"] = []
                        line_data["voltage_level2_id"] = []
                    line_data["voltage_level1_id"].append(vl1)
                    line_data["voltage_level2_id"].append(vl2)

        # Extract transformers
        t_ids = ctx.t_ids
        t_data = ctx.t_data
        for elem in root.iter():
            tag = elem.tag.replace(ns, "")
            if tag == "twoWindingsTransformer":
                tid = elem.get("id")
                tname = elem.get("name", tid)
                if tid:
                    t_ids.append(tid)
                    if "name" not in t_data:
                        t_data["name"] = []
                    t_data["name"].append(tname)

    # Build line id → display name mapping
    line_id_to_name = {}
    if line_data.get("name"):
        for uid, name in zip(line_ids, line_data["name"]):
            line_id_to_name[uid] = name

    actions = {}

    # Line disconnection actions
    for i, uid in enumerate(line_ids):
        display = line_id_to_name.get(uid, uid)
        vl1_name = ""
        vl2_name = ""
        if line_data.get("voltage_level1_id") and i < len(line_data["voltage_level1_id"]):
            vl1_id = line_data["voltage_level1_id"][i]
            vl2_id = line_data["voltage_level2_id"][i]
            if vl_df is not None and vl1_id in vl_df.index:
                vl1_name = vl_df.loc[vl1_id, "name"]
                vl2_name = vl_df.loc[vl2_id, "name"]
            else:
                vl1_name = vl1_id
                vl2_name = vl2_id

        actions[f"disco_{uid}"] = {
            "description": f"Disconnection of line '{display}' ({vl1_name} — {vl2_name})",
            "description_unitaire": f"Ouverture de la ligne '{display}'",
        }

    # Transformer disconnection actions
    t_ids = ctx.t_ids
    t_data = ctx.t_data
    if t_ids and t_data.get("name"):
        for t_id, t_name in zip(t_ids, t_data["name"]):
            actions[f"disco_{t_id}"] = {
                "description": f"Disconnection of transformer '{t_name}'",
                "description_unitaire": f"Ouverture du transformateur '{t_name}'",
            }

    actions_path = os.path.join(ctx.out_dir, "actions.json")
    with open(actions_path, "w", encoding="utf-8") as f:
        json.dump(actions, f, indent=2, ensure_ascii=False)
    log.info(f"  Written: {actions_path}  ({len(actions)} actions)")

    # Save line id → display name mapping
    line_names_path = os.path.join(ctx.out_dir, "line_id_names.json")
    with open(line_names_path, "w", encoding="utf-8") as f:
        json.dump(line_id_to_name, f, indent=2, ensure_ascii=False)
    log.info(f"  Written: {line_names_path}")


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline orchestration
# ─────────────────────────────────────────────────────────────────────────────

ALL_STEPS = {
    1: ("load", "Load & filter raw OSM data", step_load_data),
    2: ("network", "Build pypowsybl Network + export XIIDM", step_build_network),
    3: ("calibrate", "Calibrate operational limits", step_calibrate_limits),
    4: ("n1verify", "N-1 verification pass (slow)", step_n1_verify),
    5: ("metadata", "Write layout, mapping, actions", step_write_metadata),
}


def run_pipeline(
    target_voltages: list,
    target_country: str,
    out_dir: str,
    data_dir: str,
    steps: list,
    skip_n1: bool = False,
) -> None:
    """Run the conversion pipeline with the specified steps."""

    ctx = PipelineContext(
        target_voltages=target_voltages,
        target_country=target_country,
        data_dir=data_dir,
        out_dir=out_dir,
    )
    ctx.xiidm_path = os.path.join(out_dir, "network.xiidm")

    effective_steps = [s for s in steps if not (s == 4 and skip_n1)]

    country_label = target_country if target_country else "ALL countries"
    log.info("=" * 60)
    log.info(
        f"Pipeline: {country_label} "
        f"{'/'.join(str(int(v)) for v in target_voltages)} kV"
    )
    log.info(f"Output: {out_dir}")
    step_names = [f"{s}.{ALL_STEPS[s][0]}" for s in effective_steps]
    log.info(f"Steps: {', '.join(step_names)}")
    if skip_n1 and 4 in steps:
        log.info("  (N-1 verification skipped)")
    log.info("=" * 60)

    for step_num in effective_steps:
        name, desc, func = ALL_STEPS[step_num]

        # Check prerequisites
        if step_num >= 2 and ctx.buses is None and 1 not in effective_steps:
            log.info(f"  Auto-running step 1 (required by step {step_num}) …")
            step_load_data(ctx)
        if step_num >= 3 and not os.path.exists(ctx.xiidm_path):
            if 2 not in effective_steps:
                raise RuntimeError(
                    f"Step {step_num} requires network.xiidm but it doesn't exist "
                    f"and step 2 is not in the pipeline. "
                    f"Run with --steps 1,2,{step_num} or ensure network.xiidm exists."
                )

        func(ctx)

    # Summary
    log.info("=" * 60)
    log.info("Pipeline complete ✓")
    log.info(f"  Output directory: {out_dir}")
    for f in ["network.xiidm", "grid_layout.json", "actions.json",
              "bus_id_mapping.json", "vl_next_node.json", "line_id_names.json"]:
        fpath = os.path.join(out_dir, f)
        if os.path.exists(fpath):
            log.info(f"  ✓ {f}  ({os.path.getsize(fpath) / 1024:.1f} KB)")
    log.info("=" * 60)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Convert PyPSA-EUR OSM data to XIIDM network",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Steps:
  1  load       Load & filter raw OSM data + connected component
  2  network    Build pypowsybl Network + export to XIIDM
  3  calibrate  Calibrate operational limits from N-state AC loadflow
  4  n1verify   N-1 verification pass (cap at 130%%) — SLOW, skippable
  5  metadata   Write grid_layout.json, bus_id_mapping.json, actions.json

Examples:
  %(prog)s --voltages 225,400                    # full pipeline
  %(prog)s --voltages 225,400 --skip-n1          # skip N-1 (faster)
  %(prog)s --voltages 225,400 --steps 1,2,5      # skip calibration + N-1
  %(prog)s --voltages 225,400 --from-step 5      # metadata only (XIIDM must exist)
  %(prog)s --voltages 225,400 --from-step 3      # resume from calibration
        """,
    )
    parser.add_argument(
        "--voltages", type=str, default="400",
        help="Target voltage levels (comma-separated, e.g., '225,400')",
    )
    parser.add_argument(
        "--country", type=str, default="FR",
        help="Country filter (default: FR). Pass '' or 'ALL' for all countries.",
    )
    parser.add_argument(
        "--output-dir", type=str, default=None,
        help="Output directory (default: data/pypsa_eur_fr{voltage})",
    )
    parser.add_argument(
        "--skip-n1", action="store_true",
        help="Skip N-1 verification pass (step 4)",
    )
    parser.add_argument(
        "--steps", type=str, default=None,
        help="Comma-separated list of steps to run (e.g., '1,2,5')",
    )
    parser.add_argument(
        "--from-step", type=int, default=None,
        help="Run from this step onward (e.g., --from-step 3 runs steps 3,4,5)",
    )

    args = parser.parse_args()

    # Resolve paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.join(script_dir, "..", "..")
    data_dir = os.path.join(base_dir, "data", "pypsa_eur_osm")

    target_voltages = [float(v.strip()) for v in args.voltages.split(",")]
    target_country = args.country if args.country and args.country.upper() != "ALL" else None

    if args.output_dir:
        out_dir = args.output_dir
    else:
        c_slug = target_country.lower() if target_country else "eur"
        v_str = "_".join(str(int(v)) for v in target_voltages)
        out_dir = os.path.join(base_dir, "data", f"pypsa_eur_{c_slug}{v_str}")
    os.makedirs(out_dir, exist_ok=True)

    # Resolve steps
    if args.steps:
        steps = [int(s.strip()) for s in args.steps.split(",")]
    elif args.from_step:
        steps = list(range(args.from_step, max(ALL_STEPS.keys()) + 1))
    else:
        steps = list(ALL_STEPS.keys())

    for s in steps:
        if s not in ALL_STEPS:
            parser.error(f"Unknown step {s}. Valid: {list(ALL_STEPS.keys())}")

    run_pipeline(
        target_voltages=target_voltages,
        target_country=target_country,
        out_dir=out_dir,
        data_dir=data_dir,
        steps=steps,
        skip_n1=args.skip_n1,
    )


if __name__ == "__main__":
    main()
