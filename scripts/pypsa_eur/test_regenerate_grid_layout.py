"""
test_regenerate_grid_layout.py
==============================

Tests for regenerate_grid_layout.py — validates the layout generation logic
independently of pypowsybl by reading VL IDs from the XIIDM XML directly.

Test categories:
  1. Unit tests for the Mercator projection + rescaling logic
  2. Structural tests: generated layout keys match XIIDM VL IDs exactly
  3. Coordinate sanity: Mercator range, centering, aspect ratio
  4. Cross-network consistency: 400 kV nodes in fr225_400 vs fr400
  5. Regression guard: no raw lon/lat coordinates, no _0-suffixed keys

Usage:
    cd Co-Study4Grid-qwen3-5
    pytest scripts/test_regenerate_grid_layout.py -v
"""

import json
import math
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Helpers (mirror the script's logic for unit testing)
# ─────────────────────────────────────────────────────────────────────────────

EARTH_RADIUS = 6_378_137.0
# Default behaviour as of 2026-05-08: regenerate_grid_layout.py writes raw
# Mercator metres, so the layout's x-span equals the network's east-west
# extent in metres (≈ 1.4–1.6 M for the French grid). The legacy
# 8 000-unit target width is still reachable via ``--target-width 8000``
# but should NOT be the on-disk format — it forces VL-circle overlap on
# dense grids (see the script's module docstring).
EXPECTED_X_SPAN_MIN = 1_300_000.0
EXPECTED_X_SPAN_MAX = 1_700_000.0


def safe_id(raw: str) -> str:
    return re.sub(r"[^A-Za-z0-9_\-\.]", "_", raw)


def lon_lat_to_mercator(lon, lat):
    x = math.radians(lon) * EARTH_RADIUS
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH_RADIUS
    return x, y


def extract_vl_ids_from_xiidm(xiidm_path: str) -> set:
    """Extract voltage level IDs from an XIIDM file without pypowsybl."""
    tree = ET.parse(xiidm_path)
    root = tree.getroot()
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"
    vl_ids = set()
    for elem in root.iter():
        tag = elem.tag.replace(ns, "")
        if tag == "voltageLevel":
            vl_id = elem.get("id")
            if vl_id:
                vl_ids.add(vl_id)
    return vl_ids


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR = Path(__file__).parent.parent.parent


def _available_networks():
    """Discover which network directories exist and have both xiidm + layout."""
    data_dir = PROJECT_DIR / "data"
    networks = []
    for pattern in ("pypsa_eur_fr400", "pypsa_eur_fr225_400"):
        d = data_dir / pattern
        if (d / "network.xiidm").exists() and (d / "grid_layout.json").exists():
            networks.append(pattern)
    return networks


@pytest.fixture(scope="module", params=_available_networks())
def network_dir(request):
    return PROJECT_DIR / "data" / request.param


@pytest.fixture(scope="module")
def fr400_dir():
    d = PROJECT_DIR / "data" / "pypsa_eur_fr400"
    if not (d / "grid_layout.json").exists():
        pytest.skip("fr400 data not available")
    return d


@pytest.fixture(scope="module")
def fr225_400_dir():
    d = PROJECT_DIR / "data" / "pypsa_eur_fr225_400"
    if not (d / "grid_layout.json").exists():
        pytest.skip("fr225_400 data not available")
    return d


@pytest.fixture(scope="module")
def buses_csv():
    csv_path = PROJECT_DIR / "data" / "pypsa_eur_osm" / "buses.csv"
    if not csv_path.exists():
        pytest.skip("buses.csv not available")
    return pd.read_csv(csv_path, index_col=0)


def _load_layout(network_dir):
    with open(network_dir / "grid_layout.json") as f:
        return json.load(f)


def _load_vl_ids(network_dir):
    return extract_vl_ids_from_xiidm(str(network_dir / "network.xiidm"))


# ─────────────────────────────────────────────────────────────────────────────
# 1. Unit tests: Mercator projection
# ─────────────────────────────────────────────────────────────────────────────


class TestMercatorProjectionUnit:
    """Pure unit tests for the projection math."""

    def test_equator_y_is_zero(self):
        _, y = lon_lat_to_mercator(0, 0)
        assert abs(y) < 1e-6

    def test_greenwich_x_is_zero(self):
        x, _ = lon_lat_to_mercator(0, 45)
        assert abs(x) < 1e-6

    def test_positive_longitude_gives_positive_x(self):
        x, _ = lon_lat_to_mercator(3.0, 48.0)
        assert x > 0

    def test_negative_longitude_gives_negative_x(self):
        x, _ = lon_lat_to_mercator(-4.0, 48.0)
        assert x < 0

    def test_higher_latitude_gives_larger_y(self):
        _, y_south = lon_lat_to_mercator(2.0, 43.0)
        _, y_north = lon_lat_to_mercator(2.0, 51.0)
        assert y_north > y_south

    def test_france_bounds_reasonable(self):
        """France lon [-5, 9], lat [42, 51] should produce expected Mercator range."""
        x_w, _ = lon_lat_to_mercator(-5, 46)
        x_e, _ = lon_lat_to_mercator(9, 46)
        _, y_s = lon_lat_to_mercator(2, 42)
        _, y_n = lon_lat_to_mercator(2, 51)
        # x span ~1.5M metres, y span ~1.3M metres
        assert 1_000_000 < (x_e - x_w) < 2_000_000
        assert 1_000_000 < (y_n - y_s) < 2_000_000


# ─────────────────────────────────────────────────────────────────────────────
# 2. Structural tests: keys match XIIDM VL IDs
# ─────────────────────────────────────────────────────────────────────────────


class TestLayoutKeysMatchNetwork:
    """Layout keys must exactly match the set of VL IDs in the XIIDM."""

    def test_all_keys_have_vl_prefix(self, network_dir):
        layout = _load_layout(network_dir)
        bad = [k for k in layout if not k.startswith("VL_")]
        assert not bad, f"Keys without VL_ prefix: {bad[:5]}"

    def test_all_network_vls_present(self, network_dir):
        layout = _load_layout(network_dir)
        vl_ids = _load_vl_ids(network_dir)
        missing = vl_ids - set(layout.keys())
        assert not missing, f"{len(missing)} VLs missing from layout: {sorted(missing)[:5]}"

    def test_no_extra_keys(self, network_dir):
        layout = _load_layout(network_dir)
        vl_ids = _load_vl_ids(network_dir)
        extra = set(layout.keys()) - vl_ids
        assert not extra, f"{len(extra)} layout keys not in network: {sorted(extra)[:5]}"

    def test_exact_count(self, network_dir):
        layout = _load_layout(network_dir)
        vl_ids = _load_vl_ids(network_dir)
        assert len(layout) == len(vl_ids), (
            f"Layout has {len(layout)} entries, network has {len(vl_ids)} VLs"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Coordinate sanity
# ─────────────────────────────────────────────────────────────────────────────


class TestCoordinateSanity:
    """Coordinates must be Mercator-projected, centered, and properly scaled."""

    def test_values_are_numeric_pairs(self, network_dir):
        layout = _load_layout(network_dir)
        for vl_id, coord in layout.items():
            assert isinstance(coord, list) and len(coord) == 2, f"{vl_id}: bad shape"
            assert all(isinstance(v, (int, float)) for v in coord), f"{vl_id}: non-numeric"

    def test_not_raw_lonlat(self, network_dir):
        """Regression: coordinates must NOT be raw lon/lat (range ~[-5, 9] x [42, 51])."""
        layout = _load_layout(network_dir)
        xs = [c[0] for c in layout.values()]
        ys = [c[1] for c in layout.values()]
        x_span = max(xs) - min(xs)
        y_span = max(ys) - min(ys)
        # Raw lon/lat would have spans < 15 degrees; Mercator has spans > 5000
        assert x_span > 1000, (
            f"X span {x_span:.1f} looks like raw longitude — "
            f"expected Mercator-projected coordinates (span > 1000)"
        )
        assert y_span > 1000, (
            f"Y span {y_span:.1f} looks like raw latitude — "
            f"expected Mercator-projected coordinates (span > 1000)"
        )

    def test_x_span_matches_france_mercator(self, network_dir):
        """Default output is raw Mercator metres → French east-west extent.

        Regression guard: if someone reverts the script to the old
        ``--target-width 8000`` rescale, the on-disk layout will compress
        the French grid into 8 000 units and pypowsybl's fixed
        r = 27.5 user-unit VL circles will overlap their neighbours in
        every dense region. See ``regenerate_grid_layout.py`` module
        docstring.
        """
        layout = _load_layout(network_dir)
        xs = [c[0] for c in layout.values()]
        x_span = max(xs) - min(xs)
        assert EXPECTED_X_SPAN_MIN <= x_span <= EXPECTED_X_SPAN_MAX, (
            f"X span {x_span:.0f} is not in the expected Mercator-metres "
            f"range [{EXPECTED_X_SPAN_MIN:.0f}, {EXPECTED_X_SPAN_MAX:.0f}]. "
            "If you intentionally regenerated with --target-width N, also "
            "update this test (and remember pypowsybl's r=27.5 — the "
            "smaller the span, the more crowded the rendering)."
        )

    def test_centered_near_origin(self, network_dir):
        layout = _load_layout(network_dir)
        xs = [c[0] for c in layout.values()]
        ys = [c[1] for c in layout.values()]
        x_center = (min(xs) + max(xs)) / 2
        y_center = (min(ys) + max(ys)) / 2
        # Centering means the midpoint of the bounding box is at origin
        assert abs(x_center) < 1.0, f"X center {x_center:.2f} should be ~0"
        assert abs(y_center) < 1.0, f"Y center {y_center:.2f} should be ~0"

    def test_aspect_ratio_reasonable(self, network_dir):
        """France aspect ratio (width/height) should be between 0.7 and 1.5."""
        layout = _load_layout(network_dir)
        xs = [c[0] for c in layout.values()]
        ys = [c[1] for c in layout.values()]
        x_span = max(xs) - min(xs)
        y_span = max(ys) - min(ys)
        ratio = x_span / y_span if y_span > 0 else float("inf")
        assert 0.7 < ratio < 1.5, f"Aspect ratio {ratio:.2f} outside expected range"

    def test_unique_positions(self, network_dir):
        layout = _load_layout(network_dir)
        positions = [tuple(c) for c in layout.values()]
        n_unique = len(set(positions))
        n_dup = len(positions) - n_unique
        # Allow at most 1% duplicates (co-located substations)
        assert n_dup <= max(1, len(positions) // 100), (
            f"{n_dup} duplicate positions out of {len(positions)}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Regression: no _0-suffixed keys
# ─────────────────────────────────────────────────────────────────────────────


class TestNoStaleKeySuffixes:
    """Guard against the bug where layout keys had a spurious '_0' suffix."""

    def test_no_bus_id_0_suffix(self, network_dir):
        """Keys ending in '_0' that don't correspond to an actual VL ID are a bug."""
        layout = _load_layout(network_dir)
        vl_ids = _load_vl_ids(network_dir)
        for key in layout:
            assert key in vl_ids, (
                f"Layout key '{key}' is not a valid VL ID in the network"
            )

    def test_keys_dont_look_like_bus_ids(self, network_dir):
        """
        Bus IDs in node-breaker look like 'VL_xxx-400_0'. VL IDs look like
        'VL_xxx-400'. Ensure no keys have the bus-ID pattern (VL ID + _digit).
        """
        layout = _load_layout(network_dir)
        vl_ids = _load_vl_ids(network_dir)
        suspicious = []
        for key in layout:
            # If removing a trailing _0 or _1 produces a valid VL ID,
            # then this key is a bus ID, not a VL ID
            stripped = re.sub(r"_[01]$", "", key)
            if stripped != key and stripped in vl_ids:
                suspicious.append(key)
        assert not suspicious, (
            f"Found {len(suspicious)} keys that look like bus IDs "
            f"(VL ID + '_0'/'_1'): {suspicious[:5]}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cross-network consistency (fr225_400 vs fr400)
# ─────────────────────────────────────────────────────────────────────────────


class TestCrossNetworkConsistency:
    """
    The 400 kV nodes should be in approximately the same relative positions
    in both fr400 and fr225_400 layouts.
    """

    def _common_400kv_keys(self, layout_400, layout_225_400):
        """Find VL keys present in both layouts (the 400 kV overlap)."""
        return set(layout_400.keys()) & set(layout_225_400.keys())

    def test_significant_overlap(self, fr400_dir, fr225_400_dir):
        """Most fr400 VLs should exist in fr225_400."""
        l400 = _load_layout(fr400_dir)
        l225 = _load_layout(fr225_400_dir)
        common = self._common_400kv_keys(l400, l225)
        # fr400 has 192 VLs; almost all should be in fr225_400
        assert len(common) >= len(l400) * 0.95, (
            f"Only {len(common)} / {len(l400)} fr400 VLs found in fr225_400"
        )

    def test_same_coordinate_system(self, fr400_dir, fr225_400_dir):
        """Both layouts should use the same order of magnitude for coordinates."""
        l400 = _load_layout(fr400_dir)
        l225 = _load_layout(fr225_400_dir)
        span_400 = max(c[0] for c in l400.values()) - min(c[0] for c in l400.values())
        span_225 = max(c[0] for c in l225.values()) - min(c[0] for c in l225.values())
        # Both target 8000 width, so spans should be within 20%
        ratio = span_400 / span_225 if span_225 > 0 else float("inf")
        assert 0.8 < ratio < 1.2, (
            f"X-span ratio {ratio:.2f} — layouts use different scales "
            f"(fr400={span_400:.0f}, fr225_400={span_225:.0f})"
        )

    def test_relative_positions_preserved(self, fr400_dir, fr225_400_dir):
        """
        For shared 400 kV nodes, the pairwise distance ordering should be
        approximately preserved (Spearman correlation > 0.95).
        """
        l400 = _load_layout(fr400_dir)
        l225 = _load_layout(fr225_400_dir)
        common = sorted(self._common_400kv_keys(l400, l225))

        if len(common) < 10:
            pytest.skip("Not enough common VLs for correlation test")

        # Compute pairwise distances for a sample of pairs
        import random
        random.seed(42)
        pairs = []
        keys = list(common)
        n_pairs = min(500, len(keys) * (len(keys) - 1) // 2)
        seen = set()
        while len(pairs) < n_pairs:
            i, j = random.sample(range(len(keys)), 2)
            if (i, j) in seen:
                continue
            seen.add((i, j))
            pairs.append((keys[i], keys[j]))

        def dist(layout, k1, k2):
            c1, c2 = layout[k1], layout[k2]
            return math.hypot(c1[0] - c2[0], c1[1] - c2[1])

        dists_400 = [dist(l400, a, b) for a, b in pairs]
        dists_225 = [dist(l225, a, b) for a, b in pairs]

        # Spearman rank correlation (without scipy — use rank comparison)
        def _ranks(vals):
            indexed = sorted(enumerate(vals), key=lambda x: x[1])
            ranks = [0.0] * len(vals)
            for rank, (idx, _) in enumerate(indexed):
                ranks[idx] = float(rank)
            return ranks

        r400 = _ranks(dists_400)
        r225 = _ranks(dists_225)
        n = len(r400)
        mean_r400 = sum(r400) / n
        mean_r225 = sum(r225) / n

        cov = sum((a - mean_r400) * (b - mean_r225) for a, b in zip(r400, r225))
        std400 = math.sqrt(sum((a - mean_r400) ** 2 for a in r400))
        std225 = math.sqrt(sum((b - mean_r225) ** 2 for b in r225))
        spearman = cov / (std400 * std225) if std400 > 0 and std225 > 0 else 0

        assert spearman > 0.95, (
            f"Spearman rank correlation {spearman:.4f} < 0.95 — "
            f"relative positions of 400 kV nodes not preserved between layouts"
        )

    def test_geographic_orientation_consistent(self, fr400_dir, fr225_400_dir):
        """
        In both layouts, the westernmost 400 kV node should have the smallest x,
        and the northernmost should have the most negative y.
        """
        l400 = _load_layout(fr400_dir)
        l225 = _load_layout(fr225_400_dir)
        common = self._common_400kv_keys(l400, l225)

        if len(common) < 4:
            pytest.skip("Not enough common VLs")

        # Find extremes in fr400
        west_400 = min(common, key=lambda k: l400[k][0])
        east_400 = max(common, key=lambda k: l400[k][0])
        north_400 = min(common, key=lambda k: l400[k][1])  # most negative y = north
        south_400 = max(common, key=lambda k: l400[k][1])

        # The same nodes should be at the same extremes in fr225_400
        assert l225[west_400][0] < l225[east_400][0], (
            f"West/east ordering broken: {west_400} should have smaller x"
        )
        assert l225[north_400][1] < l225[south_400][1], (
            f"North/south ordering broken: {north_400} should have smaller y (more north)"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Script invocation test
# ─────────────────────────────────────────────────────────────────────────────


class TestScriptInvocation:
    """Test that the regenerate_grid_layout.py script runs successfully."""

    @pytest.fixture(scope="class")
    def script_path(self):
        return str(PROJECT_DIR / "scripts" / "pypsa_eur" / "regenerate_grid_layout.py")

    def test_script_exists(self, script_path):
        assert os.path.isfile(script_path)

    @pytest.mark.parametrize("network_name", _available_networks())
    def test_script_runs_without_error(self, script_path, network_name, tmp_path):
        """Run the script and verify it produces a valid layout."""
        # regenerate_grid_layout.py resolves VL coordinates from the raw OSM
        # buses.csv, which is NOT committed (only the built bundles are). Skip
        # rather than fail when it is absent, so the hermetic slice of this
        # suite still passes from a fresh clone / in CI (D8).
        if not (PROJECT_DIR / "data" / "pypsa_eur_osm" / "buses.csv").exists():
            pytest.skip("data/pypsa_eur_osm/buses.csv not available (raw OSM data not committed)")
        src_dir = PROJECT_DIR / "data" / network_name
        # Copy network.xiidm to tmp_path to avoid overwriting the real layout
        import shutil
        dest_dir = tmp_path / network_name
        dest_dir.mkdir()
        shutil.copy(src_dir / "network.xiidm", dest_dir / "network.xiidm")

        result = subprocess.run(
            [sys.executable, script_path, "--network", str(dest_dir)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, (
            f"Script failed with:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

        # Verify output file
        output_layout = dest_dir / "grid_layout.json"
        assert output_layout.exists(), "grid_layout.json not created"

        with open(output_layout) as f:
            layout = json.load(f)

        # Basic checks
        assert len(layout) > 0, "Layout is empty"
        vl_ids = extract_vl_ids_from_xiidm(str(dest_dir / "network.xiidm"))
        assert set(layout.keys()) == vl_ids, "Layout keys don't match network VL IDs"

        # Coordinate range check
        xs = [c[0] for c in layout.values()]
        x_span = max(xs) - min(xs)
        assert x_span > 1000, f"X span {x_span} looks like raw lon/lat"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
