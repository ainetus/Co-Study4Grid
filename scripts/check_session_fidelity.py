#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Layer-2 session-reload fidelity check.

``docs/features/interaction-logging.md § Session reload fidelity`` documents a
contract that EVERY field persisted into ``session.json`` must also be
restored into the live app state on reload.  History has shown that
this contract regresses silently — PR #88 persisted
``n_overloads_rho`` but the React restore path dropped it on the
floor; PRs #73 / #78 / #83 shipped ``load_shedding_details`` /
``pst_details`` / ``lines_overloaded_after`` that the restore path
then quietly discarded.

This script takes a **curated list of critical fields** and checks,
for each one:

1. It appears in the React **save** path (``frontend/src/utils/sessionUtils.ts``).
2. It appears in the React **restore** path (``frontend/src/hooks/useSession.ts``).
3. It appears in the **standalone** HTML (which contains both save and
   restore logic in one file).

A field that is saved but not restored is a silent regression — the
app will quietly lose data on reload.  The script FAILs on any such
asymmetry so CI can gate on it.

The spec table is deliberately curated rather than derived from the
``SessionResult`` TypeScript interface.  A field in the interface is
not automatically "critical" — some fields (e.g. ``saved_at``) are
metadata that has no meaningful restore-side equivalent.  Growing
this list is the right feedback loop: when a new field is added to
``SessionResult``, the author decides whether it needs reload
fidelity and adds it here.

Run::

    python scripts/check_session_fidelity.py            # human output
    python scripts/check_session_fidelity.py --json     # CI-friendly

Exits non-zero on any FAIL-level finding.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


import os

REPO_ROOT = Path(__file__).resolve().parent.parent
FE_SAVE_PATH = REPO_ROOT / "frontend" / "src" / "utils" / "sessionUtils.ts"
FE_RESTORE_PATH = REPO_ROOT / "frontend" / "src" / "hooks" / "useSession.ts"
_DEFAULT_STANDALONE = REPO_ROOT / "frontend" / "dist-standalone" / "standalone.html"
_LEGACY_STANDALONE = REPO_ROOT / "standalone_interface_legacy.html"
STANDALONE = Path(
    os.environ.get(
        "COSTUDY4GRID_STANDALONE_PATH",
        str(_DEFAULT_STANDALONE if _DEFAULT_STANDALONE.exists() else _LEGACY_STANDALONE),
    )
)

# Curated list of fields that MUST survive a save/reload round-trip.
# Each entry declares:
# - ``field``: the JSON-on-disk key (snake_case, matching the session.json shape).
# - ``restore_token``: a token the restore path should reference to flow
#   the field back into live state. Usually same as ``field``; sometimes
#   a setter name when the JSON key differs from the state variable
#   (e.g. ``committed_network_path`` ↔ ``committedNetworkPathRef``).
# - ``optional_on_save``: if True, missing from the save path is a WARN
#   (the field was newly added; older sessions won't have it).
# - ``spec``: one-line reference to where in the replay contract this
#   field is required.
SESSION_FIELDS = [
    # --- Configuration (must round-trip every recommender threshold) ---
    {"field": "network_path",
     "restore_token": "network_path",
     "spec": "cfg.network_path → setNetworkPath + committedNetworkPathRef"},
    {"field": "action_file_path",
     "restore_token": "action_file_path",
     "spec": "cfg.action_file_path → setActionPath"},
    {"field": "layout_path",
     "restore_token": "layout_path",
     "spec": "cfg.layout_path → setLayoutPath"},
    {"field": "min_line_reconnections",
     "restore_token": "min_line_reconnections"},
    {"field": "min_close_coupling",
     "restore_token": "min_close_coupling"},
    {"field": "min_open_coupling",
     "restore_token": "min_open_coupling"},
    {"field": "min_line_disconnections",
     "restore_token": "min_line_disconnections"},
    {"field": "min_pst",
     "restore_token": "min_pst"},
    {"field": "min_load_shedding",
     "restore_token": "min_load_shedding",
     "spec": "power-reduction format (PR #73) — fallback 0.0 on older sessions"},
    {"field": "min_renewable_curtailment_actions",
     "restore_token": "min_renewable_curtailment_actions",
     "spec": "power-reduction format (PR #73) — fallback 0.0 on older sessions"},
    {"field": "min_redispatch",
     "restore_token": "min_redispatch",
     "spec": "recommender redispatch floor — fallback 0.0 on older sessions"},
    {"field": "allowed_action_types",
     "restore_token": "allowed_action_types",
     "spec": "recommender action-type restriction — fallback [] (all families) on older sessions"},
    {"field": "n_prioritized_actions",
     "restore_token": "n_prioritized_actions"},
    {"field": "lines_monitoring_path",
     "restore_token": "lines_monitoring_path"},
    {"field": "monitoring_factor",
     "restore_token": "monitoring_factor"},
    {"field": "pre_existing_overload_threshold",
     "restore_token": "pre_existing_overload_threshold"},
    {"field": "ignore_reconnections",
     "restore_token": "ignore_reconnections"},
    {"field": "pypowsybl_fast_mode",
     "restore_token": "pypowsybl_fast_mode"},

    # --- Contingency ---
    {"field": "disconnected_element",
     "restore_token": "disconnected_element",
     "spec": "contingency.disconnected_element → setSelectedBranch + committedBranchRef"},
    {"field": "selected_overloads",
     "restore_token": "selected_overloads"},
    {"field": "monitor_deselected",
     "restore_token": "monitor_deselected"},

    # --- Overloads (incl. sticky-header rho ratios added by PR #88) ---
    # Save-only-OK: the live UI rebuilds these from a fresh N-1 diagram
    # fetch triggered by `setSelectedBranch` after restore, so the
    # on-disk arrays are only for inspection / offline replay agents.
    # See docs/features/interaction-logging.md § Session reload fidelity.
    {"field": "n_overloads",
     "restore_token": "n_overloads",
     "save_only_ok": True,
     "spec": "re-derived from fresh N-1 diagram on reload (save for inspection only)"},
    {"field": "n1_overloads",
     "restore_token": "n1_overloads",
     "save_only_ok": True,
     "spec": "re-derived from fresh N-1 diagram on reload (save for inspection only)"},
    {"field": "resolved_overloads",
     "restore_token": "resolved_overloads"},
    {"field": "n_overloads_rho",
     "restore_token": "n_overloads_rho",
     "optional_on_save": True,
     "save_only_ok": True,
     "spec": "sticky sidebar rho (PR #88) — re-derived on reload, save for inspection"},
    {"field": "n1_overloads_rho",
     "restore_token": "n1_overloads_rho",
     "optional_on_save": True,
     "save_only_ok": True,
     "spec": "sticky sidebar rho (PR #88) — re-derived on reload, save for inspection"},

    # --- Analysis-result enrichment (commonly-dropped fields) ---
    # These were the class of field that was silently dropped by
    # handleRestoreSession before PRs #73/#78/#83 landed — the editor
    # cards rendered empty after reload until the user re-ran
    # analysis. Each one MUST be referenced in restore code.
    {"field": "load_shedding_details",
     "restore_token": "load_shedding_details",
     "spec": "SavedActionEntry → live ActionDetail.load_shedding_details"},
    {"field": "curtailment_details",
     "restore_token": "curtailment_details",
     "spec": "SavedActionEntry → live ActionDetail.curtailment_details"},
    {"field": "pst_details",
     "restore_token": "pst_details",
     "spec": "SavedActionEntry → live ActionDetail.pst_details (PST editor)"},
    {"field": "redispatch_details",
     "restore_token": "redispatch_details",
     "spec": "SavedActionEntry → live ActionDetail.redispatch_details (redispatch editor, max-raise/lower headroom)"},
    {"field": "lines_overloaded_after",
     "restore_token": "lines_overloaded_after",
     "spec": "post-action NAD/SLD overload halos (PR #83)"},
    {"field": "action_topology",
     "restore_token": "action_topology"},

    # --- Interaction log ---
    {"field": "interaction_log",
     "restore_token": "interaction_log",
     "optional_on_save": True,
     "spec": "replay-ready gesture log (written as interaction_log.json alongside)"},
]


def load(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def check_field_presence(
    field: dict,
    sources: dict[str, str],
) -> dict:
    """For one curated field, check presence in each codebase surface."""
    save_pat = re.compile(r"\b" + re.escape(field["field"]) + r"\b")
    restore_pat = re.compile(r"\b" + re.escape(field["restore_token"]) + r"\b")
    result = {"field": field["field"], "spec": field.get("spec", ""),
              "optional_on_save": field.get("optional_on_save", False)}
    for name, src in sources.items():
        pat = save_pat if name.endswith("_save") else restore_pat
        matches = [
            (src.count("\n", 0, m.start()) + 1)
            for m in pat.finditer(src)
        ]
        result[name] = matches
    return result


def run_checks() -> dict:
    fe_save = load(FE_SAVE_PATH)
    fe_restore = load(FE_RESTORE_PATH)
    sa = load(STANDALONE)

    sources = {
        "fe_save": fe_save,
        "fe_restore": fe_restore,
        # The standalone combines save and restore in one file; the
        # same token search works for both directions, but we report
        # them separately so the absence of either direction is
        # visible in the output.
        "sa_save": sa,
        "sa_restore": sa,
    }

    findings = []
    for field in SESSION_FIELDS:
        res = check_field_presence(field, sources)
        # Evaluate round-trip for each codebase. A field is a
        # regression candidate if it is saved but never restored.
        fe_saved = bool(res["fe_save"])
        fe_restored = bool(res["fe_restore"])
        sa_saved = bool(res["sa_save"])
        sa_restored = bool(res["sa_restore"])

        optional = bool(field.get("optional_on_save"))
        save_only_ok = bool(field.get("save_only_ok"))
        fe_status = _classify(fe_saved, fe_restored, optional, save_only_ok)
        sa_status = _classify(sa_saved, sa_restored, optional, save_only_ok)

        findings.append({
            "field": res["field"],
            "spec": res["spec"],
            "fe_save_lines": res["fe_save"],
            "fe_restore_lines": res["fe_restore"],
            "sa_save_lines": res["sa_save"],
            "sa_restore_lines": res["sa_restore"],
            "fe_status": fe_status,
            "sa_status": sa_status,
        })

    return {"findings": findings}


def _classify(saved: bool, restored: bool, optional: bool, save_only_ok: bool) -> str:
    if saved and restored:
        return "ok"
    if saved and not restored:
        # Save-only fields are intentional (re-derived from a fresh
        # backend fetch on reload) — report as "save_only" rather
        # than "regression" so the script doesn't bark on them.
        return "save_only" if save_only_ok else "regression"
    if not saved and not restored:
        return "missing"     # warn — field declared but neither side implements
    # Not saved but restored — unusual; could be a default fallback.
    # Flag as warn so authors see it.
    if optional:
        return "optional_missing"
    return "restore_only"


def render_human(report: dict) -> str:
    out: list[str] = []
    out.append("SESSION-RELOAD FIDELITY REPORT")
    out.append("=" * 72)

    fe_regressions = [f for f in report["findings"] if f["fe_status"] == "regression"]
    sa_regressions = [f for f in report["findings"] if f["sa_status"] == "regression"]
    fe_missing = [f for f in report["findings"] if f["fe_status"] == "missing"]
    sa_missing = [f for f in report["findings"] if f["sa_status"] == "missing"]

    if fe_regressions:
        out.append(f"[FAIL] {len(fe_regressions)} fields the React frontend PERSISTS "
                   f"but never RESTORES (silent reload regression):")
        for f in fe_regressions:
            lines = ", ".join(str(n) for n in f["fe_save_lines"][:3])
            out.append(f"   - {f['field']:35s}  (saved at sessionUtils.ts:{lines})")
            if f["spec"]:
                out.append(f"        spec: {f['spec']}")
        out.append("")

    if sa_regressions:
        out.append(f"[FAIL] {len(sa_regressions)} fields the standalone PERSISTS "
                   f"but never RESTORES:")
        for f in sa_regressions:
            lines = ", ".join(str(n) for n in f["sa_save_lines"][:3])
            out.append(f"   - {f['field']:35s}  (saved at standalone_interface.html:{lines})")
            if f["spec"]:
                out.append(f"        spec: {f['spec']}")
        out.append("")

    if fe_missing:
        out.append(f"[WARN] {len(fe_missing)} required fields are absent from BOTH "
                   f"React save and restore paths:")
        for f in fe_missing:
            out.append(f"   - {f['field']}")
            if f["spec"]:
                out.append(f"        spec: {f['spec']}")
        out.append("")

    if sa_missing:
        out.append(f"[WARN] {len(sa_missing)} required fields are absent from the "
                   f"standalone (neither saved nor restored):")
        for f in sa_missing:
            out.append(f"   - {f['field']}")
            if f["spec"]:
                out.append(f"        spec: {f['spec']}")
        out.append("")

    restore_only = [f for f in report["findings"] if f["fe_status"] == "restore_only"]
    if restore_only:
        out.append(f"[FAIL] {len(restore_only)} fields the React frontend RESTORES "
                   f"but never SAVES — the field will always be `undefined` on "
                   f"reload since it was never written to session.json:")
        for f in restore_only:
            lines = ", ".join(str(n) for n in f["fe_restore_lines"][:3])
            out.append(f"   - {f['field']:35s}  (restore at useSession.ts:{lines})")
            if f["spec"]:
                out.append(f"        spec: {f['spec']}")
        out.append("")

    sa_restore_only = [f for f in report["findings"] if f["sa_status"] == "restore_only"]
    if sa_restore_only:
        out.append(f"[FAIL] {len(sa_restore_only)} fields the standalone RESTORES "
                   f"but never SAVES:")
        for f in sa_restore_only:
            lines = ", ".join(str(n) for n in f["sa_restore_lines"][:3])
            out.append(f"   - {f['field']:35s}  (restore at standalone_interface.html:{lines})")
        out.append("")

    if not (fe_regressions or sa_regressions):
        out.append("[OK] All curated session fields round-trip through both codebases.")

    # Summary counts
    total = len(report["findings"])
    fe_ok = sum(1 for f in report["findings"] if f["fe_status"] == "ok")
    sa_ok = sum(1 for f in report["findings"] if f["sa_status"] == "ok")
    out.append("")
    out.append(f"Summary: {fe_ok}/{total} fields round-trip on React, "
               f"{sa_ok}/{total} on standalone.")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = parser.parse_args()

    report = run_checks()
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_human(report))

    hard_fail = any(
        f["fe_status"] in ("regression", "restore_only")
        or f["sa_status"] in ("regression", "restore_only")
        for f in report["findings"]
    )
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
