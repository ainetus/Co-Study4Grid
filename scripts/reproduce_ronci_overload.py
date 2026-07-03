#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Reproducibility check: BEON L31CPVAN overload on contingency P.SAOL31RONCI.

Reproduces the *reference* post-contingency loading of line ``BEON L31CPVAN``
when ``P.SAOL31RONCI`` is tripped — on the reduced (``config_small_grid``) grid,
on the full French snapshot, and with the ``CHALOY631`` transformer-opening
remedial action applied after the contingency.

See ``docs/architecture/ronci-beon-reproducibility.md`` for the full write-up.

Background
----------
The reference values come from a pypowsybl ``SecurityAnalysis`` run with the
"Hades2-mimicking" OpenLoadFlow parameters (``parameters_hades2`` below) — this
is the recipe the previous reproducibility scripts / ``analyse_bare_grid_env``
notebook used. The JSON the operator reports ("violations" / "limitReduction"
/ "extensions.ActivePower" / "operator_strategy") is precisely a serialised
``SecurityAnalysis`` result, so reproducing it means re-running a
``SecurityAnalysis`` with the same parameters — NOT the product's grid2op
``obs.simulate`` pipeline.

References (BEON L31CPVAN, side TWO, against the 236 A IST permanent limit):

    grid             state                         i (A)     load     P (MW)
    ---------------  ----------------------------  --------  -------  --------
    reduced (93 VL)  N-1                           233.050   98.75 %  25.704
    full   (6835 VL) N-1                           226.785   96.10 %  24.972
    full   (6835 VL) N-1 + open CHALOY631          226.634   96.03 %  24.947
    (pre-contingency active power on all grids: 13.493 MW)

Why the live app differs
------------------------
The Co-Study4Grid backend detects the overload through the recommender's
grid2op ``obs.simulate`` path (a full AC re-run) using the library's RTE
load-flow parameters. Two things differ from the reference recipe:

  1. *Slack distribution.* The RTE parameters pin the slack to bus
     ``N.SE1P1_0#0`` with ``distributed_slack=True``. That bus node exists in
     NEITHER grid, so OpenLoadFlow silently falls back to its default slack
     selection. The Hades2 recipe uses a single slack
     (``distributed_slack=False``) / most-meshed-over-all-VLs selection. This
     is the dominant term.
  2. *Mechanism / convergence.* On the full grid, the product's *slow* AC
     re-run (full transformer + shunt voltage control, default 20 outer
     iterations) does NOT converge — it returns MAX_ITERATION_REACHED / null
     flows. The Hades2 recipe converges thanks to ``maxOuterLoopIterations=30``
     + ``transformerVoltageControlUseInitialTapPosition=true`` +
     ``AFTER_GENERATOR_VOLTAGE_CONTROL`` + ``MAX_VOLTAGE_CHANGE`` scaling.

Live-app numbers on the full grid:
  * RTE *fast* (xfo/shunt control off)  -> 95.4 % (converges)
  * RTE *slow* (full control)           -> diverges (null flows)
  * Hades2 recipe                       -> 95.99 % (converges; closest to ref)

Usage
-----
    python scripts/reproduce_ronci_overload.py

By default the reduced grid path is read from ``config_small_grid.json``. Point
``--full-grid`` at the full snapshot to also reproduce the 96.1 % reference and
the CHALOY631 remedial-action value.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pypowsybl as pp
import pypowsybl.loadflow as lf
import pypowsybl.network as pn

CONTINGENCY = "P.SAOL31RONCI"
MONITORED_LINE = "BEON L31CPVAN"
IST_LIMIT_A = 236.0  # permanent (IST) current limit on BEON L31CPVAN
REMEDIAL_TRANSFORMER = "CHALOY631"  # 2-winding transformer opened as a post-N-1 action

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "config_small_grid.json"
# Full French snapshot that yields the 96.1 % reference (6835 VLs). Optional.
DEFAULT_FULL_GRID = Path(
    "/home/marotant/dev/Expert_op4grid_recommender/data/bare_env_20240828T0100Z/grid.xiidm"
)

REF_PRE_CONTINGENCY_MW = 13.4935
TOL_A = 0.5  # tolerance on the reproduced current (Amps)

# Reference post-contingency values (BEON L31CPVAN, side TWO) per case.
#   key -> (current_a, active_mw, label, remedial_transformer_or_None)
CASES = {
    "reduced": (233.05036492893106, 25.70415528794635, "N-1", None),
    "full": (226.78494728387966, 24.971643228943947, "N-1", None),
    "full_action": (226.63426559954289, 24.947121542168418,
                    f"N-1 + open {REMEDIAL_TRANSFORMER}", REMEDIAL_TRANSFORMER),
}


def parameters_hades2() -> pp.loadflow.Parameters:
    """OpenLoadFlow parameters calibrated to mimic RTE's Hades2 reference LF.

    This is the recipe that reproduces the reference ``SecurityAnalysis``
    violations AND converges on the full French grid (where the product's
    "slow" RTE recipe hits MAX_ITERATION_REACHED). The decisive deviations from
    the product's RTE parameters are ``distributed_slack=False`` plus the
    Hades2 slack / voltage-control provider bundle.
    """
    return pp.loadflow.Parameters(
        use_reactive_limits=True,
        transformer_voltage_control_on=True,
        distributed_slack=False,
        twt_split_shunt_admittance=True,
        voltage_init_mode=pp.loadflow.VoltageInitMode.DC_VALUES,
        provider_parameters={
            "slackDistributionFailureBehavior": "FAIL",
            "maxOuterLoopIterations": "30",
            "transformerVoltageControlMode": "AFTER_GENERATOR_VOLTAGE_CONTROL",
            "stateVectorScalingMode": "MAX_VOLTAGE_CHANGE",
            "transformerVoltageControlUseInitialTapPosition": "true",
            "generatorVoltageControlMinNominalVoltage": "120",
            "fictitiousGeneratorVoltageControlCheckMode": "FORCED",
            # required because of the 0.95 limit reduction
            "mostMeshedSlackBusSelectorMaxNominalVoltagePercentile": "100",
        },
    )


def reproduce_via_security_analysis(grid_path: Path, remedial_transformer: str | None):
    """Run the reference SecurityAnalysis and return BEON L31CPVAN results.

    When ``remedial_transformer`` is given, an operator strategy that opens that
    transformer is applied after the contingency (TRUE_CONDITION) and the
    post-strategy row is returned.

    Returns ``(pre_active_mw, post_current_a, post_active_mw)``.
    """
    n = pn.load(str(grid_path))
    params = parameters_hades2()
    lf.run_ac(n, parameters=params)
    b = n.get_branches()
    pre_active = max(abs(b["p1"].get(MONITORED_LINE, 0.0)),
                     abs(b["p2"].get(MONITORED_LINE, 0.0)))

    sa = pp.security.create_analysis()
    sa.add_single_element_contingency(CONTINGENCY)
    sa.add_monitored_elements(branch_ids=[MONITORED_LINE])
    if remedial_transformer:
        action_id = f"open_{remedial_transformer}"
        sa.add_terminals_connection_action(action_id, remedial_transformer, opening=True)
        sa.add_operator_strategy(
            f"strat_{action_id}", CONTINGENCY, [action_id],
            condition_type=pp.security.ConditionType.TRUE_CONDITION,
        )

    res = sa.run_ac(n, parameters=params)
    rows = res.branch_results
    rows = rows[rows.index.get_level_values("branch_id") == MONITORED_LINE]
    # Last row is the post-strategy state when an action is applied, else the
    # post-contingency state.
    row = rows.iloc[-1]
    post_current = max(abs(row["i1"]), abs(row["i2"]))
    post_active = max(abs(row["p1"]), abs(row["p2"]))
    return pre_active, post_current, post_active


def report(label: str, grid_path: Path, case_key: str) -> bool:
    ref_i, ref_p, state, remedial = CASES[case_key]
    print("=" * 78)
    print(f"[{label}] {state}")
    print(f"   grid: {grid_path}")
    n = pn.load(str(grid_path))
    print(f"   voltage levels = {n.get_voltage_levels().shape[0]}, "
          f"lines = {n.get_lines().shape[0]}")
    pre_mw, cur_a, post_mw = reproduce_via_security_analysis(grid_path, remedial)
    loading = cur_a / IST_LIMIT_A * 100
    ref_loading = ref_i / IST_LIMIT_A * 100
    ok = abs(cur_a - ref_i) <= TOL_A

    print(f"   contingency             : {CONTINGENCY}")
    if remedial:
        print(f"   remedial action         : open transformer {remedial}")
    print(f"   monitored line          : {MONITORED_LINE} (IST limit {IST_LIMIT_A:.1f} A)")
    print(f"   pre-contingency active  : {pre_mw:8.3f} MW   (ref {REF_PRE_CONTINGENCY_MW:.3f})")
    print(f"   post active             : {post_mw:8.3f} MW   (ref {ref_p:.3f})")
    print(f"   post current            : {cur_a:8.3f} A  -> {loading:6.2f} %")
    print(f"   reference current       : {ref_i:8.3f} A  -> {ref_loading:6.2f} %")
    print(f"   delta                   : {cur_a - ref_i:+.3f} A   "
          f"[{'PASS' if ok else 'FAIL'} @ tol {TOL_A} A]")
    print()
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG,
                    help="config json holding the reduced-grid network_path")
    ap.add_argument("--full-grid", type=Path, default=DEFAULT_FULL_GRID,
                    help="full French snapshot grid.xiidm (for the 96.1%% refs)")
    args = ap.parse_args()

    print(f"pypowsybl {pp.__version__}\n")
    results = []

    # Reduced grid (the config_small_grid case the operator runs).
    reduced_path = None
    if args.config.exists():
        cfg = json.loads(args.config.read_text())
        reduced_path = Path(cfg.get("network_path", ""))
    if reduced_path and reduced_path.exists():
        results.append(report("REDUCED GRID (config_small_grid)", reduced_path, "reduced"))
    else:
        print(f"[skip] reduced grid not found via {args.config}\n")

    # Full grid (reproduces the original 96.1 % reference + the CHALOY631 action).
    if args.full_grid and args.full_grid.exists():
        results.append(report("FULL GRID (reference snapshot)", args.full_grid, "full"))
        results.append(report("FULL GRID (reference snapshot)", args.full_grid, "full_action"))
    else:
        print(f"[skip] full grid not found at {args.full_grid}\n")

    if not results:
        print("Nothing reproduced — no grid files found.")
        return 1
    ok = all(results)
    print("=" * 78)
    print(f"RESULT: {'ALL REFERENCES REPRODUCED' if ok else 'MISMATCH — see FAIL rows above'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
