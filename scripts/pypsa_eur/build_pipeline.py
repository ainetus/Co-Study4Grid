"""
build_pipeline.py
=================
End-to-end orchestrator that reproduces a PyPSA-EUR network dataset
(e.g. ``data/pypsa_eur_fr225_400`` or ``data/pypsa_eur_eur400``) from the raw OSM CSV inputs.

The master pipeline chains the six domain-specific scripts in this folder:

  1. fetch_osm_names.py        — OSM name lookup (cached, optional, safe to skip)
  2. convert_pypsa_to_xiidm.py — CSV → XIIDM network + initial limits + metadata
                                 (grid_layout.json in RAW Mercator metres)
  3. calibrate_thermal_limits.py — cap N-1 peak near 130% and keep ≥2% overload frac
  4. add_detailed_topology.py    — double-busbar + coupling breakers + actions.json
  5. generate_n1_overloads.py    — final N-1 overload report (JSON)
  6. separate_voltage_levels.py  — nudge collocated 225/400 kV VL disks apart

Each step is invoked as a subprocess so the existing CLIs stay the single
source of truth. Steps can be skipped selectively with ``--steps`` /
``--from-step``. After the selected steps run, a ``provenance.json`` manifest
(git commit, parameters, output checksums) is written into the bundle so it can
be traced back to the exact code + inputs that produced it.

Usage
-----
    # Default: rebuild data/pypsa_eur_fr225_400 end-to-end
    python scripts/pypsa_eur/build_pipeline.py

    # Custom voltages / output
    python scripts/pypsa_eur/build_pipeline.py --voltages 400 --output data/pypsa_eur_fr400

    # European 400 kV network (all countries, skip slow OSM fetch)
    python scripts/pypsa_eur/build_pipeline.py --country "" --voltages 400 --skip-osm

    # Skip expensive OSM name lookup (uses cached osm_names.json if present)
    python scripts/pypsa_eur/build_pipeline.py --skip-osm

    # Resume from a specific step (1..6)
    python scripts/pypsa_eur/build_pipeline.py --from-step 3

    # Only run selected steps
    python scripts/pypsa_eur/build_pipeline.py --steps 3,4,5
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).resolve().parent
BASE_DIR = SCRIPT_DIR.parent.parent


STEP_NAMES = {
    1: "fetch_osm_names",
    2: "convert_pypsa_to_xiidm",
    3: "calibrate_thermal_limits",
    4: "add_detailed_topology",
    5: "generate_n1_overloads",
    6: "separate_voltage_levels",
}

# Bundle files a provenance manifest checksums when present. These are the
# committed artifacts a reader needs to trust a bundle back to the pipeline.
PROVENANCE_OUTPUTS = (
    "network.xiidm",
    "grid_layout.json",
    "actions.json",
    "bus_id_mapping.json",
)


def _git_commit() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=str(BASE_DIR), text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_provenance_manifest(out_dir: Path, params: dict, steps: list[int]) -> Path:
    """Write provenance.json into a bundle, linking it to the pipeline that made it.

    Records the git commit, generation time, the pipeline steps + parameters, and
    a sha256 of each committed bundle artifact present — so a bundle can be traced
    back to the exact code and inputs, and a later rebuild can be diffed against it
    (D8: "no provenance record links any bundle to the pipeline version"). Returns
    the manifest path.
    """
    outputs = {}
    for name in PROVENANCE_OUTPUTS:
        p = Path(out_dir) / name
        if p.is_file():
            outputs[name] = {"sha256": _sha256(p), "bytes": p.stat().st_size}
    manifest = {
        "schema": "costudy4grid-bundle-provenance/1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_commit": _git_commit(),
        "pipeline": {
            "script": "scripts/pypsa_eur/build_pipeline.py",
            "steps": [{"n": s, "name": STEP_NAMES[s]} for s in steps],
            "params": params,
        },
        "outputs": outputs,
    }
    manifest_path = Path(out_dir) / "provenance.json"
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    return manifest_path


def run_step(label: str, cmd: list[str]) -> None:
    """Run a subprocess, stream its output live, fail fast on non-zero exit."""
    log.info("")
    log.info("━" * 70)
    log.info("▶ %s", label)
    log.info("  %s", " ".join(cmd))
    log.info("━" * 70)
    t0 = time.time()
    result = subprocess.run(cmd, cwd=str(BASE_DIR))
    elapsed = time.time() - t0
    if result.returncode != 0:
        log.error("Step failed (exit %d) after %.1fs: %s", result.returncode, elapsed, label)
        sys.exit(result.returncode)
    log.info("✓ %s — %.1fs", label, elapsed)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="End-to-end orchestrator for PyPSA-EUR → Co-Study4Grid XIIDM.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Steps:\n"
            "  1  fetch_osm_names        (optional; cached)\n"
            "  2  convert_pypsa_to_xiidm (OSM CSV → XIIDM + initial limits + metadata)\n"
            "  3  calibrate_thermal_limits (cap N-1 peak at 130%)\n"
            "  4  add_detailed_topology  (double-busbar + coupler actions)\n"
            "  5  generate_n1_overloads  (final overload report)\n"
            "  6  separate_voltage_levels (nudge collocated VL disks apart)\n"
            "\n"
            "A provenance.json manifest (git commit + params + output checksums)\n"
            "is written into the bundle after the selected steps run.\n"
        ),
    )
    parser.add_argument(
        "--voltages", type=str, default="225,400",
        help="Target voltage levels (comma-separated). Default: 225,400",
    )
    parser.add_argument(
        "--country", type=str, default="FR",
        help=(
            "Country filter passed to step 2 (default: FR). "
            "Pass '' or 'ALL' to include all countries (European network)."
        ),
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Network output directory (default: data/pypsa_eur_{country}{voltages}).",
    )
    parser.add_argument(
        "--steps", type=str, default=None,
        help="Comma-separated step numbers to run (e.g. '3,4,5').",
    )
    parser.add_argument(
        "--from-step", type=int, default=None,
        help="Run from this step onward (e.g. --from-step 3 runs 3,4,5,6).",
    )
    parser.add_argument(
        "--skip-osm", action="store_true",
        help="Skip step 1 (fetch_osm_names). Uses existing cached osm_names.json.",
    )
    parser.add_argument(
        "--osm-cache", type=str, default=None,
        help="Path to an existing osm_names.json used as cache for step 1.",
    )
    parser.add_argument(
        "--n1-peak-pct", type=float, default=130.0,
        help="Cap N-1 peak loading at this percent in step 3 (default: 130).",
    )
    parser.add_argument(
        "--min-branches", type=int, default=4,
        help="Minimum branches per VL for double-busbar split in step 4 (default: 4).",
    )
    args = parser.parse_args()

    # ── Resolve step selection ───────────────────────────────────────────
    if args.steps:
        steps = [int(s) for s in args.steps.split(",")]
    elif args.from_step:
        steps = list(range(args.from_step, 7))
    else:
        steps = [1, 2, 3, 4, 5, 6]

    if args.skip_osm and 1 in steps:
        steps = [s for s in steps if s != 1]

    for s in steps:
        if s not in STEP_NAMES:
            parser.error(f"Unknown step {s}. Valid: {list(STEP_NAMES.keys())}")

    # ── Resolve output directory ─────────────────────────────────────────
    voltages = args.voltages
    v_list = [v.strip() for v in voltages.split(",")]
    v_slug = "_".join(v_list)
    country = args.country if args.country and args.country.upper() != "ALL" else None
    country_slug = country.lower() if country else "eur"
    if args.output:
        out_dir = Path(args.output)
        if not out_dir.is_absolute():
            out_dir = BASE_DIR / out_dir
    else:
        out_dir = BASE_DIR / "data" / f"pypsa_eur_{country_slug}{v_slug}"

    # Path the subscripts expect (relative to repo root is OK).
    rel_out = os.path.relpath(out_dir, BASE_DIR)

    country_label = country if country else "ALL countries"
    log.info("━" * 70)
    log.info("PyPSA-EUR → Co-Study4Grid pipeline")
    log.info("  country:  %s", country_label)
    log.info("  voltages: %s", voltages)
    log.info("  output:   %s", rel_out)
    log.info("  steps:    %s", ", ".join(f"{s}.{STEP_NAMES[s]}" for s in steps))
    log.info("━" * 70)

    py = sys.executable

    t_global = time.time()

    # ── Step 1: OSM name fetch (optional, cached) ────────────────────────
    if 1 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "fetch_osm_names.py"),
            "--voltages", voltages,
            "--country", country if country else "ALL",
            "--output-dir", str(out_dir),
        ]
        if args.osm_cache:
            cmd += ["--cache-from", args.osm_cache]
        else:
            # Seed from the fr400 cache when available — entries are keyed by raw
            # OSM id, so reusing them is safe even for a Europe-wide run; it just
            # avoids re-fetching the French substations.
            default_cache = BASE_DIR / "data" / "pypsa_eur_fr400" / "osm_names.json"
            if default_cache.is_file():
                cmd += ["--cache-from", str(default_cache)]
        run_step("Step 1 — fetch_osm_names", cmd)

    # ── Step 2: OSM CSV → XIIDM ─────────────────────────────────────────
    if 2 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "convert_pypsa_to_xiidm.py"),
            "--voltages", voltages,
            "--country", country if country else "",
            "--output-dir", str(out_dir),
            "--skip-n1",
        ]
        run_step("Step 2 — convert_pypsa_to_xiidm", cmd)

    # ── Step 3: thermal limit recalibration ─────────────────────────────
    if 3 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "calibrate_thermal_limits.py"),
            "--network", str(out_dir),
            "--n1-peak-pct", str(args.n1_peak_pct),
        ]
        run_step("Step 3 — calibrate_thermal_limits", cmd)

    # ── Step 4: double-busbar detailed topology ─────────────────────────
    if 4 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "add_detailed_topology.py"),
            "--network", str(out_dir),
            "--voltages", voltages,
            "--min-branches", str(args.min_branches),
        ]
        run_step("Step 4 — add_detailed_topology", cmd)

    # ── Step 5: final N-1 overload report ───────────────────────────────
    if 5 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "generate_n1_overloads.py"),
            "--network", str(out_dir),
        ]
        run_step("Step 5 — generate_n1_overloads", cmd)

    # ── Step 6: separate collocated VL disks in the layout ──────────────
    # Layout post-processing that produced the committed bundles but was
    # previously run by hand (D8). Nudges co-located 225/400 kV VL disks apart
    # so pypowsybl's fixed-radius outer circles stop overlapping into a blob on
    # dense substations. Operates on the raw-Mercator-metres grid_layout.json
    # that step 2 now writes directly. See docs/data/voltage-level-separation.md.
    if 6 in steps:
        cmd = [
            py, str(SCRIPT_DIR / "separate_voltage_levels.py"),
            "--network", str(out_dir),
        ]
        run_step("Step 6 — separate_voltage_levels", cmd)

    # ── Provenance manifest ─────────────────────────────────────────────
    # Always written (even for a partial --steps run) so the bundle records the
    # code + inputs that produced its current contents.
    manifest_path = write_provenance_manifest(
        out_dir,
        params={
            "country": country if country else "ALL",
            "voltages": voltages,
            "n1_peak_pct": args.n1_peak_pct,
            "min_branches": args.min_branches,
        },
        steps=steps,
    )
    log.info("Wrote provenance manifest: %s", os.path.relpath(manifest_path, BASE_DIR))

    total = time.time() - t_global
    log.info("")
    log.info("━" * 70)
    log.info("Pipeline complete in %.1fs   (output: %s)", total, rel_out)
    log.info("━" * 70)


if __name__ == "__main__":
    main()
