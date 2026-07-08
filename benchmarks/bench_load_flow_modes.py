#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Per-load-flow micro-benchmark: what makes "slow mode" 6x slower than "fast".

Isolates a SINGLE ``run_ac`` on the post-contingency (N-1) state and times it
under each load-flow parameter variant, so the cost of the per-action
reassessment (`utils/reassessment.py` re-simulates every prioritized action
with one AC LF each) can be attributed to a specific knob rather than guessed.

Key result on the full France grid (`bare_env_20240828T0100Z`, contingency
``P.SAOL31RONCI`` → overload ``BEON L31CPVAN``): the entire slow/fast gap is
the **transformer tap-changer voltage-control mode**. The provider default
(incremental outer loop) needs ~57 Newton iterations/LF; switching to
``AFTER_GENERATOR_VOLTAGE_CONTROL`` converges in ~20 for the same branch
current (<0.5 % delta). Disabling tap control entirely (the *old* fast mode)
is only marginally faster still but changes the currents. See
``docs/performance/history/reassessment-fast-mode-tap-control.md``.

Usage (from repo root, backend venv active)::

    python benchmarks/bench_load_flow_modes.py
    python benchmarks/bench_load_flow_modes.py --contingency P.SAOL31RONCI \
                                               --overload "BEON L31CPVAN" --reps 3

Override the grid with ``BENCH_NETWORK_PATH`` (see ``_bench_common``).
"""
from __future__ import annotations

import argparse
import time

import pypowsybl as pp
import pypowsybl.loadflow as lf

from _bench_common import NETWORK_PATH


def _base_params(**override):
    """The recommender's slow-mode default (NetworkManager._create_default_lf_parameters).

    ``override`` accepts any ``lf.Parameters`` attribute plus a special
    ``provider`` dict that is merged into ``provider_parameters``.
    """
    provider = {
        "useActiveLimits": "true",
        "svcVoltageMonitoring": "false",
        "voltageRemoteControl": "false",
        "writeReferenceTerminals": "false",
        "slackBusSelectionMode": "MOST_MESHED",
        "maxOuterLoopIterations": "100",
    }
    provider.update(override.pop("provider", {}))
    p = lf.Parameters(
        read_slack_bus=False,
        write_slack_bus=False,
        voltage_init_mode=override.pop("voltage_init_mode", lf.VoltageInitMode.PREVIOUS_VALUES),
        transformer_voltage_control_on=override.pop("transformer_voltage_control_on", True),
        use_reactive_limits=override.pop("use_reactive_limits", True),
        shunt_compensator_voltage_control_on=override.pop("shunt_compensator_voltage_control_on", True),
        phase_shifter_regulation_on=override.pop("phase_shifter_regulation_on", True),
        distributed_slack=True,
        dc_use_transformer_ratio=False,
        twt_split_shunt_admittance=True,
        provider_parameters=provider,
    )
    for k, v in override.items():
        setattr(p, k, v)
    return p


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--contingency", default="P.SAOL31RONCI")
    ap.add_argument("--overload", default="BEON L31CPVAN")
    ap.add_argument("--reps", type=int, default=3)
    args = ap.parse_args()

    net = pp.network.load(f"{NETWORK_PATH}/grid.xiidm")

    # Seed a valid state (DC_VALUES init — no previous voltages exist yet),
    # then apply the contingency on a fresh variant and seed it too, so every
    # timed config below starts from a converged PREVIOUS_VALUES baseline.
    seed = _base_params(voltage_init_mode=lf.VoltageInitMode.DC_VALUES)
    lf.run_ac(net, parameters=seed)
    net.clone_variant(net.get_variant_ids()[0], "n1")
    net.set_working_variant("n1")
    try:
        net.update_lines(id=args.contingency, connected1=False, connected2=False)
    except Exception:
        net.update_2_windings_transformers(id=args.contingency, connected1=False, connected2=False)
    lf.run_ac(net, parameters=seed)

    def run(label: str, params) -> None:
        ts = []
        res = None
        for _ in range(args.reps):
            t = time.perf_counter()
            try:
                res = lf.run_ac(net, parameters=params)
            except Exception as e:  # noqa: BLE001
                print(f"  {label:<44s} FAILED ({str(e)[:50]})")
                return
            ts.append(time.perf_counter() - t)
        r0 = res[0]
        try:
            ln = net.get_lines(attributes=["i1", "i2"]).loc[args.overload]
            imax = f"{max(abs(ln.i1), abs(ln.i2)):.1f}A"
        except Exception:
            imax = "n/a"
        print(f"  {label:<44s} {min(ts):6.3f}s  {r0.status.name:<10s} "
              f"nr={getattr(r0, 'iteration_count', '?'):>3}  I={imax}")

    print(f"Grid={NETWORK_PATH}  contingency={args.contingency}  overload={args.overload}")
    print(f"Per-LF run_ac ({args.reps} reps, min):")
    run("SLOW default (incremental tap control)", _base_params())
    run("FAST-old (transformer+shunt ctrl OFF)", _base_params(
        transformer_voltage_control_on=False, shunt_compensator_voltage_control_on=False))
    run("FAST-new (tap ctrl AFTER_GENERATOR)", _base_params(
        provider={"transformerVoltageControlMode": "AFTER_GENERATOR_VOLTAGE_CONTROL"}))
    run("slow, shunt ctrl OFF only", _base_params(shunt_compensator_voltage_control_on=False))
    run("slow, transformer ctrl OFF only", _base_params(transformer_voltage_control_on=False))
    run("slow, reactive_limits OFF", _base_params(use_reactive_limits=False))
    run("slow, phase_shifter_reg OFF", _base_params(phase_shifter_regulation_on=False))


if __name__ == "__main__":
    main()
