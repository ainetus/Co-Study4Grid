"""
dispatch_opf.py
===============
Optimal dispatch of one hour with PyPSA — a linear (DC) optimal power flow
solved by HiGHS, the way PyPSA-Eur dispatches its networks — on a problem
``build_situation.py --dispatch opf`` exports from a bundle:

    <problem>/buses.csv         id, v_nom
    <problem>/lines.csv         id, bus0, bus1, r, x (Ω), s_nom (MVA)
    <problem>/transformers.csv  id, bus0, bus1, r, x (p.u. of s_nom), s_nom
    <problem>/generators.csv    id, bus, carrier, p_nom, marginal_cost, p_min_pu, p_max_pu
    <problem>/loads.csv         id, bus, p_set (MW; fixed exchanges included)
    <problem>/meta.json         {"s_max_pu": 0.7, "shedding_cost": 3000}

Lines may only load up to ``s_max_pu`` of their rating (PyPSA-Eur's 0.7
keeps room for N-1). Two penalised slacks at ``shedding_cost`` keep every
bus solvable whatever the grid can carry: load shedding, and spilling a
fixed import a congested pocket cannot pass on; both are reported. Writes
``<out>`` (``id,p``: one row per generator) and ``<out>.json`` (status,
cost, shedding, spill, binding branches). Exits non-zero when the solver
finds no optimum.

Runs in its own environment (PyPSA pulls its own pandas)::

    python -m venv venv_opf && venv_opf/bin/pip install pypsa highspy
    venv_opf/bin/python scripts/pypsa_eur/dispatch_opf.py --problem <dir> --out dispatch.csv
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

SNAPSHOT = "hour"


def build_network(problem: Path):
    import pypsa
    meta = json.loads((problem / "meta.json").read_text(encoding="utf-8"))
    buses = pd.read_csv(problem / "buses.csv", index_col="id")
    lines = pd.read_csv(problem / "lines.csv", index_col="id")
    trafos = pd.read_csv(problem / "transformers.csv", index_col="id")
    gens = pd.read_csv(problem / "generators.csv", index_col="id")
    loads = pd.read_csv(problem / "loads.csv", index_col="id")

    n = pypsa.Network()
    n.set_snapshots([SNAPSHOT])
    n.add("Bus", buses.index, v_nom=buses["v_nom"])
    n.add("Line", lines.index, bus0=lines["bus0"], bus1=lines["bus1"], r=lines["r"], x=lines["x"],
          s_nom=lines["s_nom"], s_max_pu=float(meta.get("s_max_pu", 0.7)))
    if len(trafos):
        n.add("Transformer", trafos.index, bus0=trafos["bus0"], bus1=trafos["bus1"],
              r=trafos["r"], x=trafos["x"], s_nom=trafos["s_nom"])
    for carrier in sorted(set(gens["carrier"]) | {"shedding", "spill"}):
        n.add("Carrier", carrier)
    n.add("Generator", gens.index, bus=gens["bus"], carrier=gens["carrier"], p_nom=gens["p_nom"],
          marginal_cost=gens["marginal_cost"], p_min_pu=gens["p_min_pu"], p_max_pu=gens["p_max_pu"])
    penalty = float(meta.get("shedding_cost", 3000.0))
    demand = loads[loads["p_set"] > 0].groupby("bus")["p_set"].sum()
    n.add("Generator", "shed_" + demand.index, bus=demand.index, carrier="shedding",
          p_nom=demand.to_numpy(), marginal_cost=penalty)
    # Absorbing generator: negative output, penalised by a negative cost.
    surplus = (-loads["p_set"].clip(upper=0.0)).groupby(loads["bus"]).sum()
    forced = (gens["p_min_pu"].clip(lower=0.0) * gens["p_nom"]).groupby(gens["bus"]).sum()
    surplus = surplus.add(forced, fill_value=0.0)
    surplus = surplus[surplus > 0]
    n.add("Generator", "spill_" + surplus.index, bus=surplus.index, carrier="spill",
          p_nom=surplus.to_numpy(), p_min_pu=-1.0, p_max_pu=0.0, marginal_cost=-penalty)
    n.add("Load", loads.index, bus=loads["bus"], p_set=loads["p_set"])
    return n, meta


def solve(problem: Path, out: Path) -> dict:
    n, meta = build_network(problem)
    log.info("PyPSA: %d buses, %d lines, %d transformers, %d generators, %d loads",
             len(n.buses), len(n.lines), len(n.transformers), len(n.generators), len(n.loads))
    status, condition = n.optimize(solver_name="highs")
    log.info("  %s / %s", status, condition)
    if str(status) != "ok":
        raise SystemExit(f"PyPSA found no optimal dispatch: {status} / {condition}")
    p = n.generators_t.p.loc[SNAPSHOT]
    slack = p.index.str.startswith(("shed_", "spill_"))
    shed = p[p.index.str.startswith("shed_")]
    spill = -p[p.index.str.startswith("spill_")]
    p[~slack].rename("p").rename_axis("id").to_frame().to_csv(out)
    s_max_pu = float(meta.get("s_max_pu", 0.7))
    loading = (n.lines_t.p0.loc[SNAPSHOT].abs() / (n.lines["s_nom"] * s_max_pu)).sort_values(ascending=False)
    summary = {
        "status": str(status),
        "condition": str(condition),
        "objective_eur": float(n.objective),
        "shedding_mw": round(float(shed.sum()), 1),
        "shedding_buses": {b[5:]: round(float(v), 1) for b, v in shed[shed > 0.5].items()},
        "spill_mw": round(float(spill.sum()), 1),
        "spill_buses": {b[6:]: round(float(v), 1) for b, v in spill[spill > 0.5].items()},
        "binding_lines": int((loading > 0.999).sum()),
        "most_loaded_lines": {k: round(float(v), 3) for k, v in loading.head(20).items()},
    }
    out.with_suffix(".json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    log.info("  cost %.0f €, shedding %.0f MW, spill %.0f MW, %d lines at their limit",
             summary["objective_eur"], summary["shedding_mw"], summary["spill_mw"],
             summary["binding_lines"])
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--problem", required=True, type=Path, help="Problem directory.")
    parser.add_argument("--out", required=True, type=Path, help="Dispatch CSV to write.")
    args = parser.parse_args()
    solve(args.problem, args.out)


if __name__ == "__main__":
    main()
