"""
calibrate_thermal_limits.py
===========================
Recalibrate per-line thermal (permanent current) limits on an XIIDM network
so that:

  * N-state loadings stay in a realistic band (most <50%, none >80%),
  * The most extreme post-contingency loading is capped near ``--n1-peak-pct``
    (default 130%) instead of running away to 200%+,
  * A non-trivial fraction of N-1 contingencies (≥ ``--min-overload-frac``,
    default 2%) still produce overloads (>100%), so the dataset remains a
    useful contingency-analysis benchmark.

Strategy
--------
1. Run a full AC security analysis on the input network.
2. For each line, look at the peak post-contingency current ``i_N1max`` across
   all contingencies (excluding the self-tripping row), and the N-state
   current ``i_N``.
3. Pick a new limit per line:

       new_limit = max(
           current_limit,              # never lower existing limits
           i_N1max / (n1_peak_pct/100),# cap N-1 peak at target_pct
           i_N    / (n_state_max_pct/100), # cap N-state at n_state_max_pct
       )

   Only lines whose peak exceeds the cap get raised.  Lines that are already
   well below target are untouched.
4. Patch ``permanentLimit`` attributes in the XIIDM XML in-place.
5. Re-run security analysis on the patched network and report the resulting
   distribution.

Usage
-----
    # Default: cap N-1 at 130%, keep ≥2% overloading contingencies
    python scripts/calibrate_thermal_limits.py --network data/pypsa_eur_fr225_400

    # Write to a different file instead of overwriting
    python scripts/calibrate_thermal_limits.py \\
        --network data/pypsa_eur_fr225_400 --output /tmp/calibrated.xiidm

    # Custom cap
    python scripts/calibrate_thermal_limits.py \\
        --network data/pypsa_eur_fr225_400 --n1-peak-pct 135
"""

from __future__ import annotations

import argparse
import logging
import re
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pypowsybl as pp

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


#: In a chunked sweep, only the post-contingency rows loaded at least this
#: much (of the current limit) are kept — all the overload statistics need.
KEEP_LOADING = 0.8


def _run_security(xiidm_path: Path, chunk_size: int = 0):
    """N-state and post-contingency currents of every line.

    ``chunk_size`` > 0 runs the contingencies in batches — a pan-European
    grid's full table (7 000 contingencies × 7 000 lines) exceeds the
    GraalVM heap — keeping each line's peak and the rows near or over the
    current limits."""
    net = pp.network.load(str(xiidm_path))
    try:
        from expert_op4grid_recommender.utils.make_env_utils import (
            create_olf_rte_parameter as _olf_params,
        )
        lf_params = _olf_params()
    except ImportError:
        lf_params = pp.loadflow.Parameters()

    pp.loadflow.run_ac(net, lf_params)

    lines_df = net.get_lines()
    line_ids = list(lines_df.index)

    # Current permanent limits from the loaded network
    ol = net.get_operational_limits().reset_index()
    cur_lim = (
        ol[(ol["type"] == "CURRENT") & (ol["side"] == "ONE")]
        .drop_duplicates("element_id")
        .set_index("element_id")["value"]
    )

    size = chunk_size if chunk_size > 0 else len(line_ids)
    i_n = None
    posts, peaks = [], []
    for start in range(0, len(line_ids), size):
        chunk = line_ids[start:start + size]
        if size < len(line_ids):
            log.info("  contingencies %d–%d of %d …", start + 1, start + len(chunk), len(line_ids))
        sa = pp.security.create_analysis()
        sa.add_single_element_contingencies(chunk)
        sa.add_monitored_elements(branch_ids=line_ids)
        result = sa.run_ac(net, parameters=lf_params)

        br = result.branch_results
        if "operator_strategy_id" in br.index.names:
            br = br.droplevel("operator_strategy_id")

        cont_ids = br.index.get_level_values("contingency_id")
        branch_ids = br.index.get_level_values("branch_id")
        i_max = br[["i1", "i2"]].abs().max(axis=1)

        # N-state currents (rows where contingency_id == "")
        n_mask = cont_ids == ""
        if i_n is None:
            i_n = pd.Series(i_max[n_mask].values, index=branch_ids[n_mask])

        # Post-contingency currents (exclude self-trip rows)
        post_mask = (cont_ids != "") & (cont_ids != branch_ids)
        post = pd.DataFrame({
            "contingency_id": cont_ids[post_mask],
            "branch_id": branch_ids[post_mask],
            "i": i_max[post_mask].values,
        })
        peaks.append(post.groupby("branch_id")["i"].max())
        if size < len(line_ids):
            lim = post["branch_id"].map(cur_lim).astype(float)
            post = post[post["i"] >= KEEP_LOADING * lim.where(lim > 0)]
        posts.append(post)
        del result, br

    post = pd.concat(posts, ignore_index=True)
    i_n1max = pd.concat(peaks).groupby(level=0).max()
    return line_ids, i_n, i_n1max, cur_lim, post


def _patch_xiidm_limits(xiidm_path: Path, out_path: Path, new_limits: dict[str, float]):
    """
    Update every ``<iidm:currentLimits permanentLimit="...">`` inside each
    ``<iidm:line id="...">`` block to the new value.

    We do this with a simple streaming regex pass rather than parsing the
    whole XML tree — XIIDM line blocks are self-contained and the
    ``permanentLimit`` attribute is the only float we're rewriting.
    """
    with open(xiidm_path, encoding="utf-8") as f:
        text = f.read()

    line_block_re = re.compile(r'<iidm:line\s+id="([^"]+)"[^>]*>.*?</iidm:line>', re.DOTALL)
    perm_re = re.compile(r'(permanentLimit=")([0-9.+\-eE]+)(")')

    updated = 0
    unchanged = 0
    no_limit_block = 0

    def rewrite(block_match: re.Match) -> str:
        nonlocal updated, unchanged, no_limit_block
        lid = block_match.group(1)
        block = block_match.group(0)
        if lid not in new_limits:
            unchanged += 1
            return block
        new_val = new_limits[lid]
        new_str = f"{new_val:.2f}"
        patched, n_sub = perm_re.subn(
            lambda m: m.group(1) + new_str + m.group(3), block
        )
        if n_sub == 0:
            no_limit_block += 1
            return block
        updated += 1
        return patched

    new_text = line_block_re.sub(rewrite, text)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(new_text)

    log.info(
        "  XIIDM patched: %d lines updated, %d unchanged, %d without currentLimits",
        updated, unchanged, no_limit_block,
    )


def _overload_fraction(post: pd.DataFrame, limits: pd.Series, threshold_pct: float = 100.0):
    """Fraction of contingencies that push at least one monitored line above ``threshold_pct``."""
    lim = post["branch_id"].map(limits).astype(float)
    loading = post["i"] / lim.where(lim > 0) * 100.0
    overloaded = post[loading > threshold_pct]
    n_overload_cont = overloaded["contingency_id"].nunique()
    total_cont = post["contingency_id"].nunique()
    return n_overload_cont, total_cont, loading.max()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--network", required=True,
                        help="Path to network directory containing network.xiidm")
    parser.add_argument("--output", default=None,
                        help="Output XIIDM path (default: overwrite input)")
    parser.add_argument("--n1-peak-pct", type=float, default=130.0,
                        help="Cap N-1 peak loading at this percent (default: 130)")
    parser.add_argument("--n-state-max-pct", type=float, default=80.0,
                        help="Cap N-state loading at this percent (default: 80)")
    parser.add_argument("--min-overload-frac", type=float, default=0.02,
                        help="Warn if <this fraction of contingencies overload (default: 0.02)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute new limits but don't patch the file")
    parser.add_argument("--chunk-size", type=int, default=0,
                        help="Run the contingencies in batches of this size (0 = one batch); "
                             "e.g. 1000 on a pan-European grid, whose full table exceeds the "
                             "GraalVM heap")
    args = parser.parse_args()

    network_dir = Path(args.network)
    xiidm_path = network_dir / "network.xiidm" if network_dir.is_dir() else network_dir
    assert xiidm_path.is_file(), f"No network.xiidm at {xiidm_path}"

    out_path = Path(args.output) if args.output else xiidm_path

    log.info("Input network: %s", xiidm_path)
    log.info("Target N-1 peak: %.1f%%   N-state max: %.1f%%",
             args.n1_peak_pct, args.n_state_max_pct)

    # ── Pass 1: measure currents on the existing network ─────────────────
    log.info("Pass 1: security analysis on input network …")
    t0 = time.time()
    line_ids, i_n, i_n1max, cur_lim, post = _run_security(xiidm_path, args.chunk_size)
    log.info("  Done in %.1fs", time.time() - t0)

    # Current loading stats
    cur_loading_n = (i_n / cur_lim.reindex(i_n.index)).fillna(0) * 100
    cur_loading_n1 = (i_n1max / cur_lim.reindex(i_n1max.index)).fillna(0) * 100
    n_over, n_total, peak_before = _overload_fraction(post, cur_lim)
    log.info("  Before: N-state max=%.1f%%, N-1 peak=%.1f%%, %d/%d contingencies overload (%.2f%%)",
             cur_loading_n.max(), peak_before, n_over, n_total, 100 * n_over / n_total)

    # ── Compute new limits ───────────────────────────────────────────────
    n1_factor = args.n1_peak_pct / 100.0
    n_factor = args.n_state_max_pct / 100.0

    new_limits = {}
    n_raised = 0
    for lid in line_ids:
        cur = float(cur_lim.get(lid, np.nan))
        if np.isnan(cur) or cur <= 0:
            continue
        need_n1 = float(i_n1max.get(lid, 0.0)) / n1_factor
        need_n = float(i_n.get(lid, 0.0)) / n_factor
        new = max(cur, need_n1, need_n)
        if new > cur * 1.001:  # ignore tiny numerical noise
            new_limits[lid] = new
            n_raised += 1
        else:
            new_limits[lid] = cur

    raises = [
        (lid, cur_lim[lid], new_limits[lid], new_limits[lid] / cur_lim[lid])
        for lid in line_ids
        if lid in new_limits and new_limits[lid] > cur_lim.get(lid, 0) * 1.001
    ]
    raises.sort(key=lambda x: x[3], reverse=True)
    log.info("  %d lines will have their limit raised (of %d total)", n_raised, len(line_ids))
    if raises:
        log.info("  Top 10 raises (old → new, factor):")
        for lid, old, new, factor in raises[:10]:
            log.info("    %-45s %8.1f → %8.1f A  (×%.2f)", lid[:45], old, new, factor)

    if args.dry_run:
        log.info("Dry run — not writing.")
        return

    # ── Patch the XIIDM file ─────────────────────────────────────────────
    log.info("Patching XIIDM → %s …", out_path)
    if out_path != xiidm_path:
        shutil.copy2(xiidm_path, out_path)
    _patch_xiidm_limits(xiidm_path, out_path, new_limits)

    # ── Pass 2: verify on the updated network ────────────────────────────
    log.info("Pass 2: security analysis on calibrated network …")
    t0 = time.time()
    line_ids2, i_n2, i_n1max2, cur_lim2, post2 = _run_security(out_path, args.chunk_size)
    log.info("  Done in %.1fs", time.time() - t0)

    loading_n = (i_n2 / cur_lim2.reindex(i_n2.index)).fillna(0) * 100
    loading_n1 = (i_n1max2 / cur_lim2.reindex(i_n1max2.index)).fillna(0) * 100
    n_over2, n_total2, peak_after = _overload_fraction(post2, cur_lim2)

    log.info("")
    log.info("─────── Calibration report ─────────────────────────────────")
    log.info("N-state loading distribution:")
    desc = loading_n.describe(percentiles=[0.5, 0.75, 0.9, 0.95, 0.99]).round(1)
    for k, v in desc.items():
        log.info("  %-6s %6.1f%%", k, v)
    log.info("N-state lines >50%%: %d / %d (%.1f%%)",
             (loading_n > 50).sum(), len(loading_n),
             100 * (loading_n > 50).sum() / len(loading_n))
    log.info("N-state lines >80%%: %d", (loading_n > 80).sum())

    log.info("")
    log.info("N-1 peak loading per line (distribution):")
    desc = loading_n1.describe(percentiles=[0.5, 0.9, 0.99]).round(1)
    for k, v in desc.items():
        log.info("  %-6s %6.1f%%", k, v)
    log.info("Lines with N-1 peak >100%%: %d", (loading_n1 > 100).sum())
    # Report with 0.5% slack so we don't flag FP noise from the 2-decimal
    # rounding in the patched XIIDM (peaks land at e.g. 130.005%).
    log.info("Lines with N-1 peak >%.1f%%: %d",
             args.n1_peak_pct + 0.5,
             (loading_n1 > args.n1_peak_pct + 0.5).sum())

    log.info("")
    log.info("Contingencies causing ≥1 overload (>100%%): %d / %d (%.2f%%)",
             n_over2, n_total2, 100 * n_over2 / n_total2)
    log.info("N-1 peak loading (absolute max): %.1f%%", peak_after)

    min_frac = args.min_overload_frac
    if n_over2 / n_total2 < min_frac:
        log.warning("Overload fraction below target %.2f%% — consider lowering --n1-peak-pct",
                    100 * min_frac)
    else:
        log.info("✓ Meets ≥%.1f%% overloading-contingency target", 100 * min_frac)


if __name__ == "__main__":
    main()
