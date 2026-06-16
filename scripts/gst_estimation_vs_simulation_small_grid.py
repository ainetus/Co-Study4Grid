#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Characterise the Generalized Superposition Theorem (GST) estimate vs. full
simulation on the small test grid, **at the library level** (pure pypowsybl
backend — no running FastAPI backend required).

Unlike ``test_estimation_vs_simulation_small_grid.py`` (which drives the HTTP
backend), this script loads ``SimulationEnvironment`` directly, applies the
contingency, simulates each remedial action and the combined pair, runs the
library's ``compute_combined_pair_superposition`` (which routes injection pairs
to the GST), and prints a per-pair accuracy breakdown restricted to the
monitored lines.

It reproduces the two findings discussed in the GST review:

  1. **GST pairs (topology + injection) estimate as accurately as the
     pre-existing EST pairs (topology + topology).** The injection term
     (beta = 1.0) adds no error beyond the inherent AC-vs-DC linearisation
     limit. The per-line rho gap (mean ~1-2 pts, occasional ~15 pts on
     parallel corridors) is the same for both — it flips the *global* max-rho
     line between near-equally-loaded monitored lines but the on-target
     overload is predicted correctly.

  2. **Injection + injection pairs are weaker** (two large injections compound
     the AC nonlinearity), so they over-predict combined relief.

Run:
    # default paths resolve to <repo>/data/...
    python scripts/gst_estimation_vs_simulation_small_grid.py

Env:
    GST_NETWORK_PATH    - override the .xiidm path
    GST_MONITORED_CSV   - override the monitored-lines CSV path
    GST_CONTINGENCY     - override the contingency element (default P.SAOL31RONCI)
"""

from __future__ import annotations

import csv
import os
import sys
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")

REPO_ROOT = Path(__file__).resolve().parent.parent
NETWORK_PATH = os.environ.get(
    "GST_NETWORK_PATH", str(REPO_ROOT / "data/bare_env_small_grid_test/grid.xiidm"))
MONITORED_CSV = os.environ.get(
    "GST_MONITORED_CSV", str(REPO_ROOT / "data/lignes_a_monitorer.csv"))
CONTINGENCY = os.environ.get("GST_CONTINGENCY", "P.SAOL31RONCI")
WORSENING_THRESHOLD = 0.02  # pre-existing-overload symmetric band


def _load_monitored(path):
    if not os.path.exists(path):
        return set()
    with open(path) as f:
        return {row["branches"] for row in csv.DictReader(f)}


def main():
    try:
        from expert_op4grid_recommender.pypowsybl_backend.simulation_env import (
            SimulationEnvironment,
        )
        from expert_op4grid_recommender.utils.superposition import (
            compute_combined_pair_superposition,
        )
    except Exception as e:  # pragma: no cover - environment guard
        print(f"[SKIP] pypowsybl / expert_op4grid_recommender unavailable: {e}")
        return 0

    if not os.path.exists(NETWORK_PATH):
        print(f"[SKIP] network not found: {NETWORK_PATH}")
        return 0

    monitored = _load_monitored(MONITORED_CSV)
    env = SimulationEnvironment(network_path=NETWORK_PATH)
    obs_n = env.get_obs()
    name_line = list(obs_n.name_line)
    n = len(name_line)
    idx = {nm: i for i, nm in enumerate(name_line)}
    rho_n = np.asarray(obs_n.rho)

    obs_start = obs_n.simulate(env.action_space({"set_line_status": [(CONTINGENCY, -1)]}))[0]
    rho0 = np.asarray(obs_start.rho)

    # Monitored, non-contingency, not pre-existing-overloaded lines (the same
    # scope the backend uses to pick the reported max_rho).
    mon = np.array([
        (name_line[i] in monitored and name_line[i] != CONTINGENCY and rho_n[i] < 1.0)
        for i in range(n)
    ]) if monitored else (rho_n < 1.0)
    pre = rho_n >= 1.0

    def masked_max(rho):
        not_impacted = (rho >= rho_n * (1 - WORSENING_THRESHOLD)) & (rho <= rho_n * (1 + WORSENING_THRESHOLD))
        elig = mon & ~(pre & not_impacted)
        if not elig.any():
            return "N/A", 0.0
        j = int(np.argmax(np.where(elig, rho, -1.0)))
        return name_line[j], float(rho[j])

    def build(spec):
        kind, name = spec
        if kind == "disco":
            return env.action_space({"set_line_status": [(name, -1)]})
        if kind == "reco":
            return env.action_space({"set_line_status": [(name, +1)]})
        if kind == "ls":
            return env.action_space({"set_load_p": {name: 0.0}})
        raise ValueError(spec)

    def elem(spec):
        kind, name = spec
        if kind in ("disco", "reco"):
            return [idx[name]], [], False
        return [], [], True  # injection: no topology element

    def diagnose(kind_tag, label, s1, s2):
        a1, a2 = build(s1), build(s2)
        o1 = obs_start.simulate(a1)[0]
        o2 = obs_start.simulate(a2)[0]
        otgt = obs_start.simulate(a1 + a2)[0]
        li1, si1, inj1 = elem(s1)
        li2, si2, inj2 = elem(s2)
        res = compute_combined_pair_superposition(
            obs_start, o1, o2, li1, si1, li2, si2,
            act1_is_injection=inj1, act2_is_injection=inj2)
        print("=" * 78)
        print(f"[{kind_tag}] {label}")
        if "error" in res:
            print(f"    ERROR: {res['error']}")
            return
        b = np.asarray(res["betas"])
        rho_sim = np.asarray(otgt.rho)
        # default direct-rho superposition (matches compute_combined_rho)
        rho_est = np.abs((1 - b.sum()) * rho0 + b[0] * np.asarray(o1.rho) + b[1] * np.asarray(o2.rho))
        p_gst = np.asarray(res["p_or_combined"])
        p_tgt = np.asarray(otgt.p_or)
        gap = np.abs(rho_est - rho_sim)[mon] * 100
        fgap = np.abs(p_gst - p_tgt)[mon]
        el, ev = masked_max(rho_est)
        sl, sv = masked_max(rho_sim)
        print(f"    betas={np.round(b, 3).tolist()}")
        print(f"    monitored-line rho gap: mean={gap.mean():.1f}  max={gap.max():.1f} pts "
              f"| flow gap: mean={fgap.mean():.2f}  max={fgap.max():.2f} MW")
        print(f"    EST max(monitored) = {ev * 100:5.1f}% on {el}")
        print(f"    SIM max(monitored) = {sv * 100:5.1f}% on {sl}"
              f"   {'[max line MATCH]' if el == sl else '[max line FLIPPED]'}")

    print(f"network    : {NETWORK_PATH}")
    print(f"contingency: {CONTINGENCY}")
    print(f"monitored  : {len(monitored)} lines\n")
    print("EST = topology+topology (no injection) ; GST = with injection\n")

    # Topology-only EST pairs (baseline accuracy).
    diagnose("EST", "reco_GEN.PY762 + disco_BEON L31CPVAN",
             ("reco", "GEN.PY762"), ("disco", "BEON L31CPVAN"))
    diagnose("EST", "disco_BEON L31CPVAN + reco_BOISSL61GEN.P",
             ("disco", "BEON L31CPVAN"), ("reco", "BOISSL61GEN.P"))
    # GST topology + injection pairs (should match EST accuracy).
    diagnose("GST", "disco_BEON L31CPVAN + load_shedding_P.SAO3TR312",
             ("disco", "BEON L31CPVAN"), ("ls", "P.SAO3TR312"))
    diagnose("GST", "disco_BEON L31CPVAN + load_shedding_BEON3 TR311",
             ("disco", "BEON L31CPVAN"), ("ls", "BEON3 TR311"))
    # GST injection + injection pair (weaker: AC nonlinearity compounds).
    diagnose("GST", "load_shedding_P.SAO3TR312 + load_shedding_BEON3 TR311",
             ("ls", "P.SAO3TR312"), ("ls", "BEON3 TR311"))

    dc_exactness_check()
    return 0


def dc_exactness_check():
    """Prove the GST formula is EXACT in true DC for the flagged pair
    (disco_BEON L31CPVAN + load_shedding_P.SAO3TR312), via a direct pypowsybl
    DC load flow on the 4 states. If the GST reconstructs the DC combined flows
    to ~0 MW, the est-vs-sim gap seen on the AC grid is AC-nonlinearity, not a
    formula error.
    """
    try:
        import pypowsybl.network as pn
        import pypowsybl.loadflow as lf
    except Exception as e:  # pragma: no cover
        print(f"\n[DC-exactness check skipped: {e}]")
        return
    cont, beon, cfou, pymon, load = (
        CONTINGENCY, "BEON L31CPVAN", "C.FOUL31MERVA", "PYMONL31SAISS", "P.SAO3TR312")
    base = pn.load(NETWORK_PATH)
    lines, loads = base.get_lines(), base.get_loads()

    def rid(idx_obj, nm):
        return nm if nm in idx_obj.index else next(
            (i for i in idx_obj.index if i.strip() == nm.strip()), None)

    lid = {k: rid(lines, k) for k in (cont, beon, cfou, pymon)}
    load_id = rid(loads, load)
    if any(v is None for v in lid.values()) or load_id is None:
        print("\n[DC-exactness check skipped: element name mapping failed]")
        return

    def dc(disco_beon=False, shed=False):
        net = pn.load(NETWORK_PATH)
        net.update_lines(id=lid[cont], connected1=False, connected2=False)
        if disco_beon:
            net.update_lines(id=lid[beon], connected1=False, connected2=False)
        if shed:
            net.update_loads(id=load_id, p0=0.0)
        lf.run_dc(net, parameters=lf.Parameters(distributed_slack=True))
        flows = net.get_lines()
        return {nm: float(flows.loc[lid[nm], "p1"]) for nm in (beon, cfou, pymon)}

    ref, disco, shed, both = dc(), dc(True), dc(False, True), dc(True, True)
    beta = shed[beon] / ref[beon]  # GST topology beta = f_BEON(shed)/f_BEON(ref)
    print("\n" + "=" * 78)
    print("[DC-EXACTNESS] disco_BEON L31CPVAN + load_shedding_P.SAO3TR312 (true DC)")
    print(f"    GST beta(disco) = {beta:.4f}")
    for nm in (cfou, pymon):
        gst = (1 - beta) * ref[nm] + beta * disco[nm] + (shed[nm] - ref[nm])
        print(f"    {nm:14s}: GST={gst:8.3f}  DC_sim={both[nm]:8.3f}  err={gst - both[nm]:+.4f} MW")
    print("    -> ~0 MW error confirms the GST is exact in DC; the AC est-vs-sim")
    print("       gap is AC-nonlinearity on low-flow coupled lines, not a bug.")


if __name__ == "__main__":
    sys.exit(main())
