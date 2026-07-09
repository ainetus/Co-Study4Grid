"""
test_grid_layout.py
===================

Tests for ``grid_layout.json`` — the VL-id → [x, y] lookup used by
pypowsybl NAD rendering.

Fixtures (``network``, ``grid_layout``, ``data_dir``) come from
``conftest.py``, so the suite runs against whatever dataset is selected
via ``--pypsa-network``.

Validations:
1. All keys are voltage-level IDs (format ``VL_*``), not bus IDs.
2. All network VLs are present in the layout (no missing positions).
3. Coordinate spans fall in a reasonable range (5000–20000 units).
4. Geographic orientation: north = more negative y.
5. Mercator projection logic is sound (unit tests — no I/O).

Usage::

    pytest scripts/pypsa_eur/test_grid_layout.py -v
"""
from __future__ import annotations

import json
import math
import re

import pytest

# Skip everything if pypowsybl isn't installed.
pytest.importorskip("pypowsybl")


# ─────────────────────────────────────────────────────────────────────────────
# Module-local helper fixture — resolves VL IDs from the conftest network
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def network_vl_ids(network):
    """Return all voltage-level IDs in the currently-loaded network."""
    vls = network.get_voltage_levels()
    return set(vls.index.tolist())


# ─────────────────────────────────────────────────────────────────────────────
# Tests: Layout Key Validation
# ─────────────────────────────────────────────────────────────────────────────

class TestLayoutKeyValidation:
    """Validate the format and content of layout keys."""

    def test_all_keys_start_with_vl(self, grid_layout):
        invalid_keys = [k for k in grid_layout if not k.startswith("VL_")]
        assert len(invalid_keys) == 0, (
            f"Found {len(invalid_keys)} keys without 'VL_' prefix "
            f"(these may be bus IDs): {invalid_keys[:5]}"
        )

    def test_no_bus_id_suffixes(self, grid_layout):
        """Flag pure '_0' / '_1' suffixes (bus IDs) but not '_0-400' (VL IDs)."""
        truly_invalid = [
            k for k in grid_layout
            if k.endswith(("_0", "_1")) and not re.search(r"_[01](-\d+)$", k)
        ]
        assert len(truly_invalid) == 0, (
            f"Found {len(truly_invalid)} keys with bus-ID-like suffixes: "
            f"{truly_invalid[:5]}"
        )

    def test_keys_are_valid_iidm_ids(self, grid_layout):
        """IIDM IDs can contain letters, digits, underscore, hyphen, dot."""
        valid_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_\-\.]*$")
        invalid_keys = [k for k in grid_layout if not valid_pattern.match(k)]
        assert len(invalid_keys) == 0, (
            f"Found {len(invalid_keys)} invalid IIDM IDs: {invalid_keys}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests: Coverage & Completeness
# ─────────────────────────────────────────────────────────────────────────────

class TestLayoutCoverage:
    """Ensure the layout covers all network voltage levels."""

    def test_all_network_vls_in_layout(self, grid_layout, network_vl_ids):
        layout_keys = set(grid_layout.keys())
        missing_vls = network_vl_ids - layout_keys
        assert len(missing_vls) == 0, (
            f"Found {len(missing_vls)} network VLs missing from layout: "
            f"{sorted(missing_vls)[:5]}"
        )

    def test_layout_size_matches_network(self, grid_layout, network_vl_ids):
        assert len(grid_layout) == len(network_vl_ids), (
            f"Layout has {len(grid_layout)} entries but network has "
            f"{len(network_vl_ids)} VLs. "
            f"Extra layout keys: "
            f"{sorted(set(grid_layout.keys()) - network_vl_ids)[:5]}"
        )

    def test_no_extra_keys_in_layout(self, grid_layout, network_vl_ids):
        layout_keys = set(grid_layout.keys())
        extra_keys = layout_keys - network_vl_ids
        assert len(extra_keys) == 0, (
            f"Found {len(extra_keys)} extra keys in layout: "
            f"{sorted(extra_keys)[:5]}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests: Coordinate Range Validation
# ─────────────────────────────────────────────────────────────────────────────

class TestCoordinateRanges:
    """Validate coordinate ranges match pypowsybl's force-layout scale."""

    def test_coordinates_are_lists_of_two_numbers(self, grid_layout):
        for vl_id, coord in grid_layout.items():
            assert isinstance(coord, list), f"VL {vl_id}: coordinate is not a list"
            assert len(coord) == 2, (
                f"VL {vl_id}: coordinate has {len(coord)} values, expected 2"
            )
            assert isinstance(coord[0], (int, float)), f"VL {vl_id}: x is not numeric"
            assert isinstance(coord[1], (int, float)), f"VL {vl_id}: y is not numeric"

    def test_coordinate_spans_in_reasonable_range(self, grid_layout):
        # The on-disk layout MUST be in raw Mercator metres (span ≈ 1.3–1.6 M
        # for the French grid), NOT the legacy 8 000-unit rescale — pypowsybl
        # emits VL outer circles at a fixed r=27.5 user-units, so a squashed
        # layout forces overlap on dense regions. See
        # docs/data/grid-layout-coordinate-scale.md (the 2026-05-08 fix). The
        # old [5000, 20000] assertion here enshrined the forbidden scale and
        # failed against the correctly-committed raw-metres layouts (D8).
        RAW_METRES_MIN = 1_000_000
        RAW_METRES_MAX = 2_000_000
        xs = [coord[0] for coord in grid_layout.values()]
        ys = [coord[1] for coord in grid_layout.values()]

        x_span = max(xs) - min(xs)
        y_span = max(ys) - min(ys)

        assert RAW_METRES_MIN <= x_span <= RAW_METRES_MAX, (
            f"X-span {x_span:.0f} is outside the raw-Mercator-metres range "
            f"[{RAW_METRES_MIN}, {RAW_METRES_MAX}] — a span ~8000 means the "
            f"forbidden legacy rescale; a span ~10 means raw lon/lat. "
            f"X range: [{min(xs):.0f}, {max(xs):.0f}]"
        )
        assert RAW_METRES_MIN <= y_span <= RAW_METRES_MAX, (
            f"Y-span {y_span:.0f} is outside the raw-Mercator-metres range "
            f"[{RAW_METRES_MIN}, {RAW_METRES_MAX}]. "
            f"Y range: [{min(ys):.0f}, {max(ys):.0f}]"
        )

    def test_coordinates_are_centered_near_origin(self, grid_layout):
        xs = [coord[0] for coord in grid_layout.values()]
        ys = [coord[1] for coord in grid_layout.values()]

        x_span = max(xs) - min(xs)
        y_span = max(ys) - min(ys)
        x_center = (min(xs) + max(xs)) / 2
        y_center = (min(ys) + max(ys)) / 2

        assert abs(x_center) < x_span * 0.1, (
            f"X center {x_center:.0f} is too far from origin "
            f"(more than 10% of x_span {x_span:.0f})"
        )
        assert abs(y_center) < y_span * 0.1, (
            f"Y center {y_center:.0f} is too far from origin "
            f"(more than 10% of y_span {y_span:.0f})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests: Geographic Orientation
# ─────────────────────────────────────────────────────────────────────────────

class TestGeographicOrientation:
    """Validate geographic orientation (north = negative y)."""

    def test_north_south_gradient_exists(self, grid_layout):
        """Y-span should be significant relative to X-span for France."""
        ys = [coord[1] for coord in grid_layout.values()]
        xs = [coord[0] for coord in grid_layout.values()]

        y_span = max(ys) - min(ys)
        x_span = max(xs) - min(xs)

        # France is ~600 km N-S and ~900 km E-W.
        assert y_span > x_span * 0.4, (
            f"Y-span {y_span:.0f} too small relative to X-span {x_span:.0f}. "
            "Expected geographic N-S variation."
        )

    def test_y_range_shows_north_south_gradient(self, grid_layout):
        """IQR of y values should be at least 30% of full range."""
        ys = [coord[1] for coord in grid_layout.values()]
        y_range = max(ys) - min(ys)

        sorted_ys = sorted(ys)
        q25 = sorted_ys[len(sorted_ys) // 4]
        q75 = sorted_ys[3 * len(sorted_ys) // 4]
        iq_range = q75 - q25

        assert iq_range > y_range * 0.3, (
            f"Y-coordinate distribution is too skewed. "
            f"IQR {iq_range:.0f} is less than 30% of range {y_range:.0f}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests: Mercator Projection Logic (pure unit tests)
# ─────────────────────────────────────────────────────────────────────────────

class TestMercatorProjection:
    """Validate the Mercator projection used in the conversion script."""

    @staticmethod
    def lon_lat_to_mercator(lon, lat):
        """Convert WGS-84 lon/lat to Web Mercator metres."""
        EARTH_RADIUS = 6_378_137.0
        x = math.radians(lon) * EARTH_RADIUS
        y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH_RADIUS
        return x, y

    def test_mercator_north_south_ordering(self):
        dunkerque_lon, dunkerque_lat = 2.38, 51.03
        perpignan_lon, perpignan_lat = 2.90, 42.70

        _, dunkerque_my = self.lon_lat_to_mercator(dunkerque_lon, dunkerque_lat)
        _, perpignan_my = self.lon_lat_to_mercator(perpignan_lon, perpignan_lat)

        assert dunkerque_my > perpignan_my, (
            f"Mercator broken: Dunkerque y={dunkerque_my:.0f} should be "
            f"> Perpignan y={perpignan_my:.0f}"
        )

    def test_mercator_east_west_ordering(self):
        brest_lon, brest_lat = -4.49, 48.39
        strasbourg_lon, strasbourg_lat = 7.75, 48.57

        brest_mx, _ = self.lon_lat_to_mercator(brest_lon, brest_lat)
        strasbourg_mx, _ = self.lon_lat_to_mercator(strasbourg_lon, strasbourg_lat)

        assert strasbourg_mx > brest_mx, (
            f"Mercator broken: Strasbourg x={strasbourg_mx:.0f} should be "
            f"> Brest x={brest_mx:.0f}"
        )

    def test_mercator_negation_for_screen_coordinates(self):
        _, dunkerque_my = self.lon_lat_to_mercator(2.38, 51.03)
        _, perpignan_my = self.lon_lat_to_mercator(2.90, 42.70)

        dunkerque_screen_y = -dunkerque_my
        perpignan_screen_y = -perpignan_my

        assert dunkerque_screen_y < perpignan_screen_y, (
            f"Dunkerque (north) screen_y={dunkerque_screen_y:.0f} should be "
            f"< Perpignan (south) screen_y={perpignan_screen_y:.0f}"
        )

    def test_rescaling_preserves_ordering(self):
        coords = [
            (2.38, 51.03, "Dunkerque"),
            (2.90, 42.70, "Perpignan"),
            (-4.49, 48.39, "Brest"),
            (7.75, 48.57, "Strasbourg"),
        ]

        projected = []
        for lon, lat, name in coords:
            mx, my = self.lon_lat_to_mercator(lon, lat)
            projected.append((mx, -my, name))

        xs = [p[0] for p in projected]
        ys = [p[1] for p in projected]
        p_cx = (min(xs) + max(xs)) / 2
        p_cy = (min(ys) + max(ys)) / 2
        p_xrange = max(xs) - min(xs)

        TARGET_WIDTH = 8_000.0
        scale = TARGET_WIDTH / p_xrange

        rescaled = [((mx - p_cx) * scale, (my - p_cy) * scale, n) for mx, my, n in projected]

        dunkerque_y = next(r[1] for r in rescaled if r[2] == "Dunkerque")
        perpignan_y = next(r[1] for r in rescaled if r[2] == "Perpignan")
        assert dunkerque_y < perpignan_y

        brest_x = next(r[0] for r in rescaled if r[2] == "Brest")
        strasbourg_x = next(r[0] for r in rescaled if r[2] == "Strasbourg")
        assert strasbourg_x > brest_x

    def test_mercator_coordinates_within_expected_bounds(self):
        france_bounds = [
            (-4.49, 48.39, "Brest"),
            (7.75, 48.57, "Strasbourg"),
            (2.38, 51.03, "Dunkerque"),
            (2.90, 42.70, "Perpignan"),
        ]

        for lon, lat, name in france_bounds:
            mx, my = self.lon_lat_to_mercator(lon, lat)
            assert -600_000 < mx < 900_000, (
                f"{name}: Mercator x={mx:.0f} outside expected range for France"
            )
            assert 5_000_000 < my < 7_000_000, (
                f"{name}: Mercator y={my:.0f} outside expected range for France"
            )


# ─────────────────────────────────────────────────────────────────────────────
# Integration Tests
# ─────────────────────────────────────────────────────────────────────────────

class TestLayoutIntegration:
    """Integration tests combining multiple validation aspects."""

    def test_layout_is_valid_json(self, data_dir):
        path = data_dir / "grid_layout.json"
        with open(path, "r") as f:
            data = json.load(f)
        assert isinstance(data, dict), "Layout should be a JSON object"

    def test_all_vls_have_unique_positions(self, grid_layout):
        positions = [tuple(coord) for coord in grid_layout.values()]
        unique_positions = len(set(positions))
        total_vls = len(grid_layout)

        duplicate_count = total_vls - unique_positions
        assert duplicate_count <= max(1, total_vls // 100), (
            f"Found {duplicate_count} duplicate coordinates out of {total_vls} VLs"
        )

    def test_layout_statistics_reasonable(self, grid_layout, network_name):
        xs = [coord[0] for coord in grid_layout.values()]
        ys = [coord[1] for coord in grid_layout.values()]

        x_span = max(xs) - min(xs)
        y_span = max(ys) - min(ys)

        print(f"\nLayout Statistics for {network_name}:")
        print(f"  Total VLs: {len(grid_layout)}")
        print(f"  X range: [{min(xs):.0f}, {max(xs):.0f}] (span: {x_span:.0f})")
        print(f"  Y range: [{min(ys):.0f}, {max(ys):.0f}] (span: {y_span:.0f})")
        aspect = x_span / y_span if y_span > 0 else float("inf")
        print(f"  Aspect ratio (X/Y span): {aspect:.2f}")

        assert len(grid_layout) > 0, "Layout should have entries"
        assert x_span > 0, "X span should be positive"
        assert y_span > 0, "Y span should be positive"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
