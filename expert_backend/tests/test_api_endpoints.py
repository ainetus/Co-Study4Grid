# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

"""Tests for FastAPI API endpoints using TestClient with mocked services."""

import json
import pytest
from unittest.mock import patch, MagicMock, PropertyMock
from fastapi.testclient import TestClient


@pytest.fixture
def mock_services():
    """Patch both singleton services before importing the app."""
    with patch(
        "expert_backend.main.network_service"
    ) as mock_ns, patch(
        "expert_backend.main.recommender_service"
    ) as mock_rs:
        yield mock_ns, mock_rs


@pytest.fixture
def client(mock_services):
    """Create a TestClient with mocked services."""
    from expert_backend.main import app

    return TestClient(app)


class TestGetBranches:
    def test_success(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_disconnectable_elements.return_value = [
            "LINE_A",
            "LINE_B",
            "TRAFO_1",
        ]

        response = client.get("/api/branches")
        assert response.status_code == 200
        data = response.json()
        assert data["branches"] == ["LINE_A", "LINE_B", "TRAFO_1"]

    def test_error_returns_400(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_disconnectable_elements.side_effect = ValueError("Network not loaded")

        response = client.get("/api/branches")
        assert response.status_code == 400
        assert "Network not loaded" in response.json()["detail"]


class TestGetVoltageLevels:
    def test_success(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_voltage_levels.return_value = ["VL1", "VL2", "VL3"]

        response = client.get("/api/voltage-levels")
        assert response.status_code == 200
        assert response.json()["voltage_levels"] == ["VL1", "VL2", "VL3"]


class TestGetNominalVoltages:
    def test_success(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_nominal_voltages.return_value = {"VL1": 400.0, "VL2": 225.0}

        response = client.get("/api/nominal-voltages")
        assert response.status_code == 200
        data = response.json()
        assert data["mapping"] == {"VL1": 400.0, "VL2": 225.0}
        assert data["unique_kv"] == [225.0, 400.0]


class TestSetRecommenderModel:
    """POST /api/recommender-model — lightweight model swap on the
    running RecommenderService (no network reload, no action-dict
    rebuild). The frontend fires this whenever the operator changes the
    model dropdown (Settings modal OR the selector above Analyze &
    Suggest), so the next /api/run-analysis-step2 uses the chosen
    model.
    """

    def test_success_applies_model_and_echoes_active(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_active_model_name.return_value = "random_overflow"
        mock_rs.get_compute_overflow_graph.return_value = True

        response = client.post(
            "/api/recommender-model",
            json={"model": "random_overflow", "compute_overflow_graph": True},
        )
        assert response.status_code == 200
        data = response.json()
        assert data == {
            "status": "success",
            "active_model": "random_overflow",
            "compute_overflow_graph": True,
        }
        # The request object is threaded straight into _apply_model_settings.
        mock_rs._apply_model_settings.assert_called_once()
        applied = mock_rs._apply_model_settings.call_args[0][0]
        assert applied.model == "random_overflow"
        assert applied.compute_overflow_graph is True

    def test_compute_overflow_graph_is_optional(self, client, mock_services):
        # The pydantic model allows omitting compute_overflow_graph;
        # _apply_model_settings then falls back to its own default.
        _, mock_rs = mock_services
        mock_rs.get_active_model_name.return_value = "random"
        mock_rs.get_compute_overflow_graph.return_value = False

        response = client.post("/api/recommender-model", json={"model": "random"})
        assert response.status_code == 200
        applied = mock_rs._apply_model_settings.call_args[0][0]
        assert applied.model == "random"
        assert applied.compute_overflow_graph is None

    def test_missing_model_returns_422(self, client, mock_services):
        # `model` is a required field on RecommenderModelRequest.
        response = client.post("/api/recommender-model", json={})
        assert response.status_code == 422

    def test_error_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs._apply_model_settings.side_effect = ValueError("bad model")

        response = client.post("/api/recommender-model", json={"model": "expert"})
        assert response.status_code == 400
        assert "bad model" in response.json()["detail"]


class TestGetElementVoltageLevels:
    def test_success(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_element_voltage_levels.return_value = ["VL1", "VL2"]

        response = client.get("/api/element-voltage-levels?element_id=LINE_A")
        assert response.status_code == 200
        assert response.json()["voltage_level_ids"] == ["VL1", "VL2"]

    def test_missing_param(self, client, mock_services):
        response = client.get("/api/element-voltage-levels")
        assert response.status_code == 422  # Validation error


class TestGetNetworkDiagram:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        # No NAD prefetch was queued by update_config (or the test doesn't
        # exercise the prefetch path) — fall through to fresh compute.
        mock_rs.get_prefetched_base_nad.return_value = None
        mock_rs.get_network_diagram.return_value = {
            "svg": "<svg>diagram</svg>",
            "metadata": '{"nodes":[],"edges":[]}',
        }

        response = client.get("/api/network-diagram")
        assert response.status_code == 200
        data = response.json()
        assert "svg" in data
        assert "metadata" in data

    def test_error_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        mock_rs.get_network_diagram.side_effect = Exception("No network loaded")

        response = client.get("/api/network-diagram")
        assert response.status_code == 400

    def test_uses_prefetched_nad_when_available(self, client, mock_services):
        """When `prefetch_base_nad_async` has populated the cache during
        `/api/config`, `/api/network-diagram` serves the cached NAD and
        does NOT re-run the expensive `get_network_diagram()` pypowsybl
        code path. This is the core of the perf #2 optimisation — see
        docs/performance/history/nad-prefetch.md.
        """
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = {
            "svg": "<svg>prefetched</svg>",
            "metadata": '{"from":"prefetch"}',
        }

        response = client.get("/api/network-diagram")
        assert response.status_code == 200
        data = response.json()
        assert data["svg"] == "<svg>prefetched</svg>"
        # The fresh compute path MUST NOT have been taken.
        mock_rs.get_network_diagram.assert_not_called()

    def test_falls_through_to_fresh_compute_on_prefetch_timeout(self, client, mock_services):
        """If `get_prefetched_base_nad` returns None (timeout or never
        started), the endpoint falls back to the synchronous path. Keeps
        the endpoint usable when `update_config` was never called (e.g.
        external callers, process restart)."""
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None  # timed out / not queued
        mock_rs.get_network_diagram.return_value = {
            "svg": "<svg>fresh</svg>",
            "metadata": None,
        }

        response = client.get("/api/network-diagram")
        assert response.status_code == 200
        assert response.json()["svg"] == "<svg>fresh</svg>"
        mock_rs.get_network_diagram.assert_called_once()

    def test_prefetched_path_supports_text_format(self, client, mock_services):
        """format=text must work with the prefetched payload too."""
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = {
            "svg": "<svg>prefetched</svg>",
            "metadata": None,
            "lines_overloaded": ["L1"],
            "lines_overloaded_rho": [1.05],
        }

        response = client.get("/api/network-diagram?format=text")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        body = response.text
        nl = body.index("\n")
        assert body[nl + 1:] == "<svg>prefetched</svg>"
        mock_rs.get_network_diagram.assert_not_called()

    def test_text_format_returns_header_plus_svg(self, client, mock_services):
        """format=text returns a small JSON header on the first line,
        then the raw SVG as the rest of the body. The SVG must NOT be
        JSON-escaped (savings = no 25 MB JSON.parse on the client)."""
        import json as json_module

        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        mock_rs.get_network_diagram.return_value = {
            "svg": "<svg>diagram</svg>",
            "metadata": '{"nodes":[]}',
            "lines_overloaded": ["L1"],
            "lines_overloaded_rho": [1.05],
        }

        response = client.get("/api/network-diagram?format=text")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        body = response.text
        nl = body.index("\n")
        header = json_module.loads(body[:nl])
        svg = body[nl + 1:]
        assert svg == "<svg>diagram</svg>"
        assert "svg" not in header  # must be stripped from the JSON header
        assert header["lines_overloaded"] == ["L1"]
        assert header["lines_overloaded_rho"] == [1.05]
        assert header["metadata"] == '{"nodes":[]}'

    def test_text_format_gzip(self, client, mock_services):
        """Large text-format responses are gzip-compressed on the wire
        when the client signals Accept-Encoding: gzip."""
        import gzip as gzip_module

        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        big_svg = "<svg>" + ("x" * 20_000) + "</svg>"
        mock_rs.get_network_diagram.return_value = {
            "svg": big_svg,
            "metadata": None,
        }

        response = client.get(
            "/api/network-diagram?format=text",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        # TestClient auto-decodes gzip, so check the header explicitly.
        assert response.headers.get("content-encoding") == "gzip"
        body = response.text  # auto-decoded
        nl = body.index("\n")
        assert body[nl + 1:] == big_svg
        # Sanity: compressed body is much smaller than raw
        raw_len = len(big_svg) + 100
        # Re-encode to confirm compression ratio is credible
        assert len(gzip_module.compress(body.encode("utf-8"))) < raw_len


class TestGetN1Diagram:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_contingency_diagram.return_value = {
            "svg": "<svg>n1</svg>",
            "metadata": "{}",
            "lf_converged": True,
            "lf_status": "CONVERGED",
        }

        response = client.post(
            "/api/contingency-diagram",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lf_converged"] is True

    def test_missing_element(self, client, mock_services):
        response = client.post("/api/contingency-diagram", json={})
        assert response.status_code == 422


# ------------------------------------------------------------------
# SVG DOM recycling — patch endpoints
# ------------------------------------------------------------------
# /api/contingency-diagram-patch and /api/action-variant-diagram-patch return the
# same delta / overload payload as their full-NAD siblings but SKIP the
# ~2-4 s pypowsybl NAD generation and the ~20-28 MB SVG transfer. The
# frontend patches a clone of the already-loaded N-state SVG DOM.
# See docs/performance/history/svg-dom-recycling.md.

class TestGetN1DiagramPatch:
    def test_returns_patchable_payload_without_svg(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_contingency_diagram_patch.return_value = {
            "patchable": True,
            "contingency_id": "LINE_A",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "disconnected_edges": ["LINE_A"],
            "absolute_flows": {
                "p1": {"LINE_B": 12.3}, "p2": {"LINE_B": -12.3},
                "q1": {"LINE_B": 4.1},  "q2": {"LINE_B": -4.1},
                "vl1": {"LINE_B": "VL_1"}, "vl2": {"LINE_B": "VL_2"},
            },
            "lines_overloaded": ["LINE_C"],
            "lines_overloaded_rho": [1.05],
            "flow_deltas": {"LINE_B": {"delta": -1.0, "category": "negative", "flip_arrow": False}},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "meta": {"base_state": "N", "elapsed_ms": 120},
        }

        response = client.post(
            "/api/contingency-diagram-patch",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["patchable"] is True
        assert data["contingency_id"] == "LINE_A"
        assert data["disconnected_edges"] == ["LINE_A"]
        # SVG-less payload is the whole point of this endpoint.
        assert "svg" not in data
        assert "metadata" not in data

    def test_missing_element_returns_422(self, client, mock_services):
        response = client.post("/api/contingency-diagram-patch", json={})
        assert response.status_code == 422

    def test_service_error_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_contingency_diagram_patch.side_effect = ValueError("N state unavailable")

        response = client.post(
            "/api/contingency-diagram-patch",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 400
        assert "N state unavailable" in response.json()["detail"]

    def test_payload_carries_same_non_svg_fields_as_full_endpoint(self, client, mock_services):
        """Frontend contract: every non-SVG field returned by the full
        endpoint is also present in the patch payload. Enforces parity
        at the HTTP boundary so the frontend branch-logic can swap
        transparently."""
        _, mock_rs = mock_services
        shared_fields = {
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "lines_overloaded": ["X"],
            "lines_overloaded_rho": [1.05],
            "flow_deltas": {"X": {"delta": 1.0, "category": "positive", "flip_arrow": False}},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
        }
        mock_rs.get_contingency_diagram_patch.return_value = {
            "patchable": True,
            "contingency_id": "LINE_A",
            "disconnected_edges": ["LINE_A"],
            "absolute_flows": {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {}
            },
            "meta": {"base_state": "N", "elapsed_ms": 1},
            **shared_fields,
        }

        response = client.post(
            "/api/contingency-diagram-patch",
            json={"disconnected_elements": ["LINE_A"]},
        )
        data = response.json()
        for k, v in shared_fields.items():
            assert data[k] == v, f"mismatch on field {k}"


class TestGetActionVariantDiagramPatch:
    def test_returns_patchable_payload_for_pst_action(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": True,
            "action_id": "PST_42",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
            "disconnected_edges": [],
            "absolute_flows": {
                "p1": {"LINE_B": 20.0}, "p2": {"LINE_B": -20.0},
                "q1": {"LINE_B": 5.0},  "q2": {"LINE_B": -5.0},
                "vl1": {"LINE_B": "VL_1"}, "vl2": {"LINE_B": "VL_2"},
            },
            "lines_overloaded": [],
            "lines_overloaded_rho": [],
            "flow_deltas": {},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "meta": {"base_state": "N-1", "elapsed_ms": 80},
        }

        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "PST_42"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["patchable"] is True
        assert data["action_id"] == "PST_42"
        assert "svg" not in data
        assert "metadata" not in data

    def test_patchable_for_disco_action(self, client, mock_services):
        """Line-disconnection actions flip switch breakers but don't
        change VL bus counts; rendering is a pure dashed-class toggle
        on the disconnected line. The backend keeps them patchable
        and includes the line in `disconnected_edges`."""
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": True,
            "action_id": "disco_LINE_Y",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
            "disconnected_edges": ["CONTINGENCY", "LINE_Y"],
            "absolute_flows": {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {},
            },
            "lines_overloaded": [],
            "lines_overloaded_rho": [],
            "flow_deltas": {},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "meta": {"base_state": "N-1", "elapsed_ms": 30},
        }
        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "disco_LINE_Y"},
        )
        data = response.json()
        assert data["patchable"] is True
        assert "LINE_Y" in data["disconnected_edges"]

    def test_patchable_for_line_reconnect_action(self, client, mock_services):
        """Single-line reconnections / extra disconnections render as a
        pure dashed/solid toggle on one edge element, so the backend
        keeps them patchable and lets svgPatch swap the class list."""
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": True,
            "action_id": "RECO_LINE_Y",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
            "disconnected_edges": [],  # reco_* reconnects the contingency
            "absolute_flows": {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {},
            },
            "lines_overloaded": [],
            "lines_overloaded_rho": [],
            "flow_deltas": {},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "meta": {"base_state": "N-1", "elapsed_ms": 42},
        }

        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "RECO_LINE_Y"},
        )
        data = response.json()
        assert data["patchable"] is True
        assert data["disconnected_edges"] == []

    def test_patchable_carries_contingency_on_disconnected_edges(self, client, mock_services):
        """Post-action patch must mark the N-1 contingency as dashed
        on the action tab — it is still disconnected after the action
        unless the action explicitly reconnects it."""
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": True,
            "action_id": "LOAD_SHED_X",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
            "disconnected_edges": ["CONTINGENCY_LINE"],
            "absolute_flows": {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {},
            },
            "lines_overloaded": [],
            "lines_overloaded_rho": [],
            "flow_deltas": {},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "meta": {"base_state": "N-1", "elapsed_ms": 42},
        }

        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "LOAD_SHED_X"},
        )
        data = response.json()
        assert data["patchable"] is True
        assert data["disconnected_edges"] == ["CONTINGENCY_LINE"]

    def test_patchable_with_vl_subtrees_for_node_merging(self, client, mock_services):
        """Node-merging / node-splitting / coupling actions change bus
        counts per VL. The backend now patches those rendering
        changes via pypowsybl-native focused sub-diagrams instead of
        falling back to the full NAD. The frontend splices each
        `<g id=\"nad-vl-*\">` subtree into the cloned base."""
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": True,
            "action_id": "node_merging_PYMONP3",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
            "disconnected_edges": ["CONTINGENCY_LINE"],
            "absolute_flows": {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {},
            },
            "lines_overloaded": [],
            "lines_overloaded_rho": [],
            "flow_deltas": {},
            "reactive_flow_deltas": {},
            "asset_deltas": {},
            "vl_subtrees": {
                "PYMONP3": {"node_svg": "<g id=\"nad-vl-PYMONP3\"><circle r=\"100\"/></g>"},
            },
            "meta": {"base_state": "N-1", "elapsed_ms": 120},
        }
        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "node_merging_PYMONP3"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["patchable"] is True
        assert "PYMONP3" in data["vl_subtrees"]
        assert data["vl_subtrees"]["PYMONP3"]["node_svg"].startswith("<g")

    def test_returns_patchable_false_when_subtree_extraction_fails(self, client, mock_services):
        """Graceful fallback: if focused-NAD extraction fails on the
        backend, the service returns `patchable: false, reason:
        vl_topology_changed` so the frontend falls through to the
        full /api/action-variant-diagram endpoint. Correctness before
        speed."""
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.return_value = {
            "patchable": False,
            "action_id": "NODE_SPLIT_Z",
            "reason": "vl_topology_changed",
            "lf_converged": True,
            "lf_status": "CONVERGED",
            "non_convergence": None,
        }

        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "NODE_SPLIT_Z"},
        )
        data = response.json()
        assert data["patchable"] is False
        assert data["reason"] == "vl_topology_changed"

    def test_missing_action_returns_422(self, client, mock_services):
        response = client.post("/api/action-variant-diagram-patch", json={})
        assert response.status_code == 422

    def test_unknown_action_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram_patch.side_effect = ValueError(
            "Action 'unknown' not found in last analysis result."
        )

        response = client.post(
            "/api/action-variant-diagram-patch",
            json={"action_id": "unknown"},
        )
        assert response.status_code == 400
        assert "not found" in response.json()["detail"]


class TestRunAnalysis:
    def test_streaming_response(self, client, mock_services):
        _, mock_rs = mock_services

        def fake_analysis(element):
            yield {"type": "pdf", "pdf_path": "/tmp/graph.pdf"}
            yield {
                "type": "result",
                "actions": {},
                "action_scores": {},
                "lines_overloaded": [],
                "message": "Analysis completed",
                "dc_fallback": False,
            }

        mock_rs.run_analysis.return_value = fake_analysis("LINE_A")

        response = client.post(
            "/api/run-analysis",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/x-ndjson"

        # Parse NDJSON lines
        lines = [
            line for line in response.text.strip().split("\n") if line.strip()
        ]
        assert len(lines) == 2
        pdf_event = json.loads(lines[0])
        result_event = json.loads(lines[1])
        assert pdf_event["type"] == "pdf"
        assert pdf_event["pdf_url"] == "/results/pdf/graph.pdf"
        assert result_event["type"] == "result"
        assert result_event["message"] == "Analysis completed"

    def test_error_in_analysis(self, client, mock_services):
        _, mock_rs = mock_services

        def failing_analysis(element):
            raise RuntimeError("Analysis exploded")

        mock_rs.run_analysis.side_effect = failing_analysis

        response = client.post(
            "/api/run-analysis",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200  # Streaming always returns 200
        lines = [
            line for line in response.text.strip().split("\n") if line.strip()
        ]
        error_event = json.loads(lines[0])
        assert error_event["type"] == "error"


class TestRunAnalysisStep1:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.run_analysis_step1.return_value = {
            "lines_overloaded": ["LINE_1", "LINE_2"],
            "message": "Detected 2 overloads.",
            "can_proceed": True,
        }

        response = client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lines_overloaded"] == ["LINE_1", "LINE_2"]
        assert data["can_proceed"] is True

    def test_error_in_service(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.run_analysis_step1.side_effect = Exception("Step 1 failed")

        response = client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 400
        assert "Step 1 failed" in response.json()["detail"]


class TestRunAnalysisStep2:
    def test_streaming_response_success(self, client, mock_services):
        _, mock_rs = mock_services

        def fake_analysis_step2(selected_overloads, all_overloads=None, monitor_deselected=False, additional_lines_to_cut=None):
            yield {"type": "pdf", "pdf_path": "/tmp/graph.pdf"}
            yield {
                "type": "result",
                "actions": {},
                "action_scores": {},
                "lines_overloaded": ["LINE_1"],
                "message": "Analysis completed",
                "dc_fallback": False,
            }

        mock_rs.run_analysis_step2.side_effect = fake_analysis_step2

        response = client.post(
            "/api/run-analysis-step2",
            json={
                "selected_overloads": ["LINE_1"],
                "all_overloads": ["LINE_1", "LINE_2"],
                "monitor_deselected": True,
            },
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/x-ndjson"

        # Parse NDJSON lines
        lines = [
            line for line in response.text.strip().split("\n") if line.strip()
        ]
        assert len(lines) == 2
        pdf_event = json.loads(lines[0])
        result_event = json.loads(lines[1])
        
        assert pdf_event["type"] == "pdf"
        assert pdf_event["pdf_url"] == "/results/pdf/graph.pdf"
        assert result_event["type"] == "result"
        assert result_event["lines_overloaded"] == ["LINE_1"]

        # Verify service call parameters
        mock_rs.run_analysis_step2.assert_called_once_with(
            ["LINE_1"],
            all_overloads=["LINE_1", "LINE_2"],
            monitor_deselected=True,
            additional_lines_to_cut=[],
        )

    def test_additional_lines_to_cut_forwarded(self, client, mock_services):
        """The ``additional_lines_to_cut`` field on the request body must
        reach ``recommender_service.run_analysis_step2`` as the
        ``additional_lines_to_cut`` kwarg. Guards against an accidental
        drop in the FastAPI -> service plumbing (e.g. someone forgets to
        add the field to the Pydantic model)."""
        _, mock_rs = mock_services

        def fake_step2(selected_overloads, all_overloads=None, monitor_deselected=False, additional_lines_to_cut=None):
            yield {"type": "result", "actions": {}, "action_scores": {}, "lines_overloaded": []}

        mock_rs.run_analysis_step2.side_effect = fake_step2

        response = client.post(
            "/api/run-analysis-step2",
            json={
                "selected_overloads": ["LINE_1"],
                "all_overloads": ["LINE_1"],
                "monitor_deselected": False,
                "additional_lines_to_cut": ["EXTRA_A", "EXTRA_B"],
            },
        )

        assert response.status_code == 200
        mock_rs.run_analysis_step2.assert_called_once_with(
            ["LINE_1"],
            all_overloads=["LINE_1"],
            monitor_deselected=False,
            additional_lines_to_cut=["EXTRA_A", "EXTRA_B"],
        )

    def test_error_in_streaming(self, client, mock_services):
        _, mock_rs = mock_services

        def failing_analysis_step2(*args, **kwargs):
            raise RuntimeError("Step 2 exploded")

        mock_rs.run_analysis_step2.side_effect = failing_analysis_step2

        response = client.post(
            "/api/run-analysis-step2",
            json={"selected_overloads": ["LINE_1"]},
        )
        assert response.status_code == 200  # Streaming response
        lines = [
            line for line in response.text.strip().split("\n") if line.strip()
        ]
        error_event = json.loads(lines[0])
        assert error_event["type"] == "error"
        assert "Step 2 exploded" in error_event["message"]


class TestActionVariantDiagram:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram.return_value = {
            "svg": "<svg>action</svg>",
            "metadata": "{}",
            "action_id": "action_1",
        }

        response = client.post(
            "/api/action-variant-diagram",
            json={"action_id": "action_1"},
        )
        assert response.status_code == 200
        assert response.json()["action_id"] == "action_1"

    def test_with_mode(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram.return_value = {
            "svg": "<svg/>",
            "metadata": "{}",
        }

        response = client.post(
            "/api/action-variant-diagram",
            json={"action_id": "action_1", "mode": "delta"},
        )
        assert response.status_code == 200
        mock_rs.get_action_variant_diagram.assert_called_once_with(
            "action_1", mode="delta"
        )


class TestFocusedDiagram:
    def test_with_disconnected_element(self, client, mock_services):
        mock_ns, mock_rs = mock_services
        mock_ns.get_element_voltage_levels.return_value = ["VL1"]
        mock_rs.get_contingency_diagram.return_value = {
            "svg": "<svg>focused</svg>",
            "metadata": "{}",
        }

        response = client.post(
            "/api/focused-diagram",
            json={
                "element_id": "LINE_A",
                "depth": 2,
                "disconnected_elements": ["LINE_B"],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["voltage_level_ids"] == ["VL1"]
        assert data["depth"] == 2

    def test_without_disconnected_element(self, client, mock_services):
        mock_ns, mock_rs = mock_services
        mock_ns.get_element_voltage_levels.return_value = ["VL1", "VL2"]
        mock_rs.get_network_diagram.return_value = {
            "svg": "<svg>base</svg>",
            "metadata": "{}",
        }

        response = client.post(
            "/api/focused-diagram",
            json={"element_id": "LINE_A"},
        )
        assert response.status_code == 200

    def test_no_voltage_levels_returns_404(self, client, mock_services):
        mock_ns, _ = mock_services
        mock_ns.get_element_voltage_levels.return_value = []

        response = client.post(
            "/api/focused-diagram",
            json={"element_id": "NONEXISTENT"},
        )
        assert response.status_code == 404


class TestGetActions:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_all_action_ids.return_value = [
            {"id": "action_1", "description": "Test action", "type": "line_disconnection"},
        ]

        response = client.get("/api/actions")
        assert response.status_code == 200
        data = response.json()
        assert len(data["actions"]) == 1
        assert data["actions"][0]["id"] == "action_1"


class TestSimulateManualAction:
    def test_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = {
            "action_id": "action_1",
            "description_unitaire": "Open line X",
            "rho_before": [0.95],
            "rho_after": [0.80],
            "max_rho": 0.80,
            "max_rho_line": "LINE_A",
            "is_rho_reduction": True,
            "lines_overloaded": ["LINE_A"],
        }

        response = client.post(
            "/api/simulate-manual-action",
            json={
                "action_id": "action_1",
                "disconnected_elements": ["LINE_B"],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["is_rho_reduction"] is True
        assert data["max_rho"] == 0.80

    def test_missing_fields(self, client, mock_services):
        response = client.post(
            "/api/simulate-manual-action",
            json={"action_id": "action_1"},
        )
        assert response.status_code == 422


class TestPydanticModels:
    """Test request model validation."""

    def test_config_request_defaults(self, client, mock_services):
        """ConfigRequest should use default values for optional fields."""
        mock_ns, mock_rs = mock_services
        mock_ns.get_disconnectable_elements.return_value = []

        # Mock the import of expert_op4grid_recommender.config
        with patch("expert_backend.main.network_service", mock_ns):
            # Just test the model itself
            from expert_backend.main import ConfigRequest

            config = ConfigRequest(
                network_path="/test/path",
                action_file_path="/test/actions.json",
            )
            assert config.min_line_reconnections == 2.0
            assert config.min_close_coupling == 3.0
            assert config.min_open_coupling == 2.0
            assert config.min_line_disconnections == 3.0
            assert config.n_prioritized_actions == 10
            assert config.monitoring_factor == 0.95
            assert config.pre_existing_overload_threshold == 0.02
            assert config.ignore_reconnections is False
            assert config.pypowsybl_fast_mode is True
            assert config.lines_monitoring_path is None
            # Recommender restriction defaults to "no restriction" (None → []).
            assert config.allowed_action_types is None
            assert config.min_redispatch == 0

    def test_analysis_request_validation(self):
        from expert_backend.main import AnalysisRequest

        req = AnalysisRequest(disconnected_elements=["LINE_A"])
        assert req.disconnected_elements == ["LINE_A"]

    def test_focused_diagram_request_defaults(self):
        from expert_backend.main import FocusedDiagramRequest

        req = FocusedDiagramRequest(element_id="LINE_A")
        assert req.depth == 1
        assert req.disconnected_elements is None

    def test_action_variant_request_defaults(self):
        from expert_backend.main import ActionVariantRequest

        req = ActionVariantRequest(action_id="act_1")
        assert req.mode == "network"


class TestRestoreAnalysisContext:
    """Tests for POST /api/restore-analysis-context endpoint."""

    def test_restore_with_all_fields(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.restore_analysis_context.return_value = None

        response = client.post(
            "/api/restore-analysis-context",
            json={
                "lines_we_care_about": ["LINE_A", "LINE_B", "LINE_C"],
                "disconnected_elements": ["LINE_X"],
                "lines_overloaded": ["LINE_A"],
                "computed_pairs": {"LINE_A+LINE_B": {"max_rho": 0.5}},
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["lines_we_care_about_count"] == 3
        assert data["computed_pairs_count"] == 1

        mock_rs.restore_analysis_context.assert_called_once_with(
            lines_we_care_about=["LINE_A", "LINE_B", "LINE_C"],
            disconnected_elements=["LINE_X"],
            lines_overloaded=["LINE_A"],
            computed_pairs={"LINE_A+LINE_B": {"max_rho": 0.5}},
        )

    def test_restore_with_minimal_fields(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.restore_analysis_context.return_value = None

        response = client.post(
            "/api/restore-analysis-context",
            json={
                "lines_we_care_about": ["LINE_A"],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["lines_we_care_about_count"] == 1
        assert data["computed_pairs_count"] == 0

    def test_restore_with_null_lines(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.restore_analysis_context.return_value = None

        response = client.post(
            "/api/restore-analysis-context",
            json={
                "lines_we_care_about": None,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["lines_we_care_about_count"] == 0

    def test_restore_error_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.restore_analysis_context.side_effect = Exception("Restore failed")

        response = client.post(
            "/api/restore-analysis-context",
            json={
                "lines_we_care_about": ["LINE_A"],
            },
        )
        assert response.status_code == 400
        assert "Restore failed" in response.json()["detail"]


class TestRestoreAnalysisContextModel:
    """Tests for the RestoreAnalysisContextRequest Pydantic model."""

    def test_defaults(self):
        from expert_backend.main import RestoreAnalysisContextRequest

        req = RestoreAnalysisContextRequest()
        assert req.lines_we_care_about is None
        assert req.disconnected_elements is None
        assert req.lines_overloaded is None
        assert req.computed_pairs is None

    def test_full_model(self):
        from expert_backend.main import RestoreAnalysisContextRequest

        req = RestoreAnalysisContextRequest(
            lines_we_care_about=["L1", "L2"],
            disconnected_elements=["LINE_X"],
            lines_overloaded=["L1"],
            computed_pairs={"pair1": {"betas": [0.1, 0.2]}},
        )
        assert req.lines_we_care_about == ["L1", "L2"]
        assert req.disconnected_elements == ["LINE_X"]
        assert req.lines_overloaded == ["L1"]
        assert req.computed_pairs == {"pair1": {"betas": [0.1, 0.2]}}


class TestRunAnalysisLinesWeCareAbout:
    """Tests that analysis result events include lines_we_care_about."""

    def test_run_analysis_includes_lines_we_care_about(self, client, mock_services):
        _, mock_rs = mock_services

        def fake_analysis(element):
            yield {"type": "pdf", "pdf_path": "/tmp/graph.pdf"}
            yield {
                "type": "result",
                "actions": {},
                "action_scores": {},
                "lines_overloaded": ["LINE_A"],
                "lines_we_care_about": ["LINE_A", "LINE_B", "LINE_C"],
                "message": "Analysis completed",
                "dc_fallback": False,
            }

        mock_rs.run_analysis.return_value = fake_analysis("LINE_X")

        response = client.post(
            "/api/run-analysis",
            json={"disconnected_elements": ["LINE_X"]},
        )
        assert response.status_code == 200

        lines = [line for line in response.text.strip().split("\n") if line.strip()]
        result_event = json.loads(lines[1])
        assert result_event["type"] == "result"
        assert result_event["lines_we_care_about"] == ["LINE_A", "LINE_B", "LINE_C"]

    def test_run_analysis_null_lines_we_care_about(self, client, mock_services):
        _, mock_rs = mock_services

        def fake_analysis(element):
            yield {
                "type": "result",
                "actions": {},
                "action_scores": {},
                "lines_overloaded": [],
                "lines_we_care_about": None,
                "message": "Done",
                "dc_fallback": False,
            }

        mock_rs.run_analysis.return_value = fake_analysis("LINE_X")

        response = client.post(
            "/api/run-analysis",
            json={"disconnected_elements": ["LINE_X"]},
        )
        lines = [line for line in response.text.strip().split("\n") if line.strip()]
        result_event = json.loads(lines[0])
        assert result_event["lines_we_care_about"] is None

    def test_step2_includes_lines_we_care_about(self, client, mock_services):
        _, mock_rs = mock_services

        def fake_step2(selected_overloads, all_overloads=None, monitor_deselected=False, additional_lines_to_cut=None):
            yield {
                "type": "result",
                "actions": {},
                "action_scores": {},
                "lines_overloaded": ["LINE_1"],
                "lines_we_care_about": ["LINE_1", "LINE_2"],
                "combined_actions": {},
                "pre_existing_overloads": [],
                "message": "Done",
                "dc_fallback": False,
            }

        mock_rs.run_analysis_step2.side_effect = fake_step2

        response = client.post(
            "/api/run-analysis-step2",
            json={
                "selected_overloads": ["LINE_1"],
                "all_overloads": ["LINE_1", "LINE_2"],
            },
        )
        lines = [line for line in response.text.strip().split("\n") if line.strip()]
        result_event = json.loads(lines[0])
        assert result_event["lines_we_care_about"] == ["LINE_1", "LINE_2"]


class TestSimulateManualActionWithContext:
    """Tests that simulate_manual_action passes lines_overloaded to the service."""

    def test_passes_lines_overloaded(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = {
            "action_id": "action_1",
            "description_unitaire": "Open line X",
            "rho_before": [0.95],
            "rho_after": [0.70],
            "max_rho": 0.70,
            "max_rho_line": "LINE_A",
            "is_rho_reduction": True,
            "lines_overloaded": ["LINE_A"],
        }

        response = client.post(
            "/api/simulate-manual-action",
            json={
                "action_id": "action_1",
                "disconnected_elements": ["LINE_B"],
                "lines_overloaded": ["LINE_A", "LINE_C"],
            },
        )
        assert response.status_code == 200
        # Verify lines_overloaded was passed through to the service
        call_kwargs = mock_rs.simulate_manual_action.call_args
        assert call_kwargs[1].get("lines_overloaded") == ["LINE_A", "LINE_C"] or \
               (len(call_kwargs[0]) >= 4 and call_kwargs[0][3] == ["LINE_A", "LINE_C"])


class TestSimulateAndVariantDiagramStream:
    """Combined `POST /api/simulate-and-variant-diagram` NDJSON endpoint.

    Replaces the legacy two-shot
    `simulateManualAction -> getActionVariantDiagram` fallback path with a
    single streamed response so the action card's rho numbers can paint
    as soon as the grid2op simulation completes without waiting for the
    (expensive) post-action NAD regeneration.

    These tests lock in:
      - the two-event ordering (`metrics` first, then `diagram`);
      - the streaming content-type (`application/x-ndjson`);
      - the no-gzip invariant on streamed responses — wrapping this endpoint
        in `_maybe_gzip_json` or the global `GZipMiddleware` would break
        early-event delivery, which was the root cause of the step-2 rollback
        (see docs/performance/history/per-endpoint-gzip.md).
    """

    _SIM_RESULT = {
        "action_id": "act_1",
        "description_unitaire": "Open LINE_A",
        "rho_before": [0.95, 1.02],
        "rho_after": [0.80, 0.70],
        "max_rho": 0.80,
        "max_rho_line": "LINE_A",
        "is_rho_reduction": True,
        "non_convergence": None,
        "lines_overloaded": ["LINE_A"],
    }
    _DIAG_RESULT = {
        "svg": "<svg>post-action</svg>",
        "metadata": "{}",
        "action_id": "act_1",
        "lf_converged": True,
        "lf_status": "CONVERGED",
        "non_convergence": None,
    }

    def test_streams_metrics_then_diagram(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = self._SIM_RESULT
        mock_rs.get_action_variant_diagram.return_value = self._DIAG_RESULT

        response = client.post(
            "/api/simulate-and-variant-diagram",
            json={
                "action_id": "act_1",
                "disconnected_elements": ["LINE_B"],
            },
        )
        assert response.status_code == 200
        assert response.headers.get("content-type", "").startswith(
            "application/x-ndjson"
        )
        # Must NOT be gzipped — see class docstring.
        assert response.headers.get("content-encoding") != "gzip"

        lines = [ln for ln in response.text.splitlines() if ln.strip()]
        assert len(lines) == 2
        metrics = json.loads(lines[0])
        diagram = json.loads(lines[1])
        assert metrics["type"] == "metrics"
        assert metrics["description_unitaire"] == "Open LINE_A"
        assert metrics["rho_after"] == [0.80, 0.70]
        assert diagram["type"] == "diagram"
        assert diagram["svg"] == "<svg>post-action</svg>"
        assert diagram["lf_converged"] is True

    def test_ignores_accept_encoding_gzip(self, client, mock_services):
        """Client-sent `Accept-Encoding: gzip` must not cause the stream to be
        wrapped — the frontend reads NDJSON with TextDecoder and needs each
        event to arrive as soon as the server yields it.
        """
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = self._SIM_RESULT
        mock_rs.get_action_variant_diagram.return_value = self._DIAG_RESULT

        response = client.post(
            "/api/simulate-and-variant-diagram",
            json={"action_id": "act_1", "disconnected_elements": ["LINE_B"]},
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert response.headers.get("content-encoding") != "gzip"

    def test_error_on_simulate_is_reported_and_closes_stream(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.side_effect = ValueError("no dict loaded")

        response = client.post(
            "/api/simulate-and-variant-diagram",
            json={"action_id": "act_1", "disconnected_elements": ["LINE_B"]},
        )
        assert response.status_code == 200
        lines = [ln for ln in response.text.splitlines() if ln.strip()]
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["type"] == "error"
        assert "no dict loaded" in event["message"]
        mock_rs.get_action_variant_diagram.assert_not_called()

    def test_error_on_diagram_after_successful_metrics(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = self._SIM_RESULT
        mock_rs.get_action_variant_diagram.side_effect = ValueError("no observation")

        response = client.post(
            "/api/simulate-and-variant-diagram",
            json={"action_id": "act_1", "disconnected_elements": ["LINE_B"]},
        )
        assert response.status_code == 200
        lines = [ln for ln in response.text.splitlines() if ln.strip()]
        # Metrics event still arrives — the UI can at least update the sidebar.
        assert len(lines) == 2
        assert json.loads(lines[0])["type"] == "metrics"
        assert json.loads(lines[1])["type"] == "error"

    def test_passes_optional_params_through(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.simulate_manual_action.return_value = self._SIM_RESULT
        mock_rs.get_action_variant_diagram.return_value = self._DIAG_RESULT

        client.post(
            "/api/simulate-and-variant-diagram",
            json={
                "action_id": "act_1",
                "disconnected_elements": ["LINE_B"],
                "action_content": {"switches": {"sw1": True}},
                "lines_overloaded": ["LINE_A", "LINE_C"],
                "target_mw": 42.5,
                "target_tap": 3,
                "mode": "delta",
            },
        )
        call = mock_rs.simulate_manual_action.call_args
        assert call.kwargs["action_content"] == {"switches": {"sw1": True}}
        assert call.kwargs["lines_overloaded"] == ["LINE_A", "LINE_C"]
        assert call.kwargs["target_mw"] == 42.5
        assert call.kwargs["target_tap"] == 3
        diag_call = mock_rs.get_action_variant_diagram.call_args
        assert diag_call.kwargs["mode"] == "delta"


class TestDiagramGzipCompression:
    """Per-endpoint gzip on the 3 large SVG + 1 actions endpoints.

    We deliberately do NOT use Starlette's global `GZipMiddleware` because it
    buffers `StreamingResponse` bodies (NDJSON on /api/run-analysis(-step2)),
    which was the rollback cause in commits 8c15de7 -> 26bc49d. These tests
    lock in the per-endpoint behaviour so that future refactors can't
    silently regress back to the global middleware.
    """

    # A large-enough SVG body to cross the _GZIP_MIN_BYTES threshold.
    _BIG_SVG = "<svg>" + ("<g><path d='M0 0 L1 1'/></g>" * 1000) + "</svg>"

    def _assert_gzip(self, response):
        assert response.status_code == 200
        # httpx decodes Content-Encoding transparently, but exposes the header
        # value as seen on the wire — so we can still verify it was gzipped.
        assert response.headers.get("content-encoding") == "gzip"
        assert "accept-encoding" in response.headers.get("vary", "").lower()
        # Response body is still valid JSON after transparent decompression.
        data = response.json()
        assert "svg" in data or "actions" in data

    def _assert_no_gzip(self, response):
        assert response.status_code == 200
        assert response.headers.get("content-encoding") != "gzip"
        assert "accept-encoding" in response.headers.get("vary", "").lower()
        assert response.json()

    def test_network_diagram_gzip_when_accepted(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        mock_rs.get_network_diagram.return_value = {
            "svg": self._BIG_SVG,
            "metadata": "{}",
        }
        response = client.get(
            "/api/network-diagram",
            headers={"Accept-Encoding": "gzip"},
        )
        self._assert_gzip(response)

    def test_network_diagram_no_gzip_when_not_accepted(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        mock_rs.get_network_diagram.return_value = {
            "svg": self._BIG_SVG,
            "metadata": "{}",
        }
        response = client.get(
            "/api/network-diagram",
            headers={"Accept-Encoding": "identity"},
        )
        self._assert_no_gzip(response)

    def test_n1_diagram_gzip_when_accepted(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_contingency_diagram.return_value = {
            "svg": self._BIG_SVG,
            "metadata": "{}",
            "lf_converged": True,
        }
        response = client.post(
            "/api/contingency-diagram",
            json={"disconnected_elements": ["LINE_A"]},
            headers={"Accept-Encoding": "gzip"},
        )
        self._assert_gzip(response)
        assert response.json()["lf_converged"] is True

    def test_action_variant_diagram_gzip_when_accepted(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_action_variant_diagram.return_value = {
            "svg": self._BIG_SVG,
            "metadata": "{}",
        }
        response = client.post(
            "/api/action-variant-diagram",
            json={"action_id": "action_1"},
            headers={"Accept-Encoding": "gzip"},
        )
        self._assert_gzip(response)

    def test_small_payload_below_threshold_is_not_compressed(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_prefetched_base_nad.return_value = None
        # Tiny SVG — well below _GZIP_MIN_BYTES (10 kB).
        mock_rs.get_network_diagram.return_value = {
            "svg": "<svg/>",
            "metadata": "{}",
        }
        response = client.get(
            "/api/network-diagram",
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        assert response.headers.get("content-encoding") != "gzip"
        assert response.json()["svg"] == "<svg/>"

    def test_streaming_analysis_is_not_affected(self, client, mock_services):
        """/api/run-analysis-step2 MUST keep streaming NDJSON one event per line
        (the overflow PDF event must reach the browser before the result
        event). The per-endpoint gzip helper must not be wrapped around it.
        """
        _, mock_rs = mock_services

        def fake_step2(*args, **kwargs):
            yield {"type": "pdf", "pdf_path": "/tmp/graph.pdf"}
            yield {"type": "result", "analysis_result": {"actions": []}}

        mock_rs.run_analysis_step2.side_effect = fake_step2

        response = client.post(
            "/api/run-analysis-step2",
            json={"selected_overloads": ["LINE_A"]},
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.status_code == 200
        # NDJSON streaming response — never gzip-wrapped by the helper.
        assert response.headers.get("content-encoding") != "gzip"
        assert response.headers.get("content-type", "").startswith("application/x-ndjson")
        lines = [ln for ln in response.text.splitlines() if ln.strip()]
        assert len(lines) == 2
        assert json.loads(lines[0])["type"] == "pdf"
        assert json.loads(lines[1])["type"] == "result"


class TestRegenerateOverflowGraph:
    """`POST /api/regenerate-overflow-graph` — cache-backed Hierarchical
    / Geo toggle for the Overflow Analysis tab."""

    def test_success_adds_pdf_url(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.regenerate_overflow_graph.return_value = {
            "pdf_path": "/tmp/Overflow_Graph/overflow_geo.html",
            "mode": "geo",
            "cached": False,
        }
        response = client.post(
            "/api/regenerate-overflow-graph",
            json={"mode": "geo"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["mode"] == "geo"
        assert data["cached"] is False
        assert data["pdf_path"] == "/tmp/Overflow_Graph/overflow_geo.html"
        # `pdf_url` must be derived from the basename so the static mount
        # at /results/pdf/ can serve the file regardless of its on-disk
        # parent directory.
        assert data["pdf_url"] == "/results/pdf/overflow_geo.html"
        mock_rs.regenerate_overflow_graph.assert_called_once_with("geo")

    def test_cached_response_passes_through(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.regenerate_overflow_graph.return_value = {
            "pdf_path": "/tmp/Overflow_Graph/overflow_hierarchi.html",
            "mode": "hierarchical",
            "cached": True,
        }
        response = client.post(
            "/api/regenerate-overflow-graph",
            json={"mode": "hierarchical"},
        )
        assert response.status_code == 200
        assert response.json()["cached"] is True

    def test_no_prior_step2_returns_400(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.regenerate_overflow_graph.side_effect = ValueError(
            "No Step-2 context available. Run the analysis first."
        )
        response = client.post(
            "/api/regenerate-overflow-graph",
            json={"mode": "geo"},
        )
        assert response.status_code == 400
        assert "Step-2" in response.json()["detail"]

    def test_rejects_bad_mode_from_service(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.regenerate_overflow_graph.side_effect = ValueError(
            "Unknown overflow layout mode: 'foo'; expected 'hierarchical' or 'geo'."
        )
        response = client.post(
            "/api/regenerate-overflow-graph",
            json={"mode": "foo"},
        )
        assert response.status_code == 400
        assert "foo" in response.json()["detail"]

    def test_missing_pdf_path_does_not_set_url(self, client, mock_services):
        """When graphviz produced nothing (older recommender install,
        for example), pdf_path is None — the route must not synthesize
        a bogus pdf_url."""
        _, mock_rs = mock_services
        mock_rs.regenerate_overflow_graph.return_value = {
            "pdf_path": None,
            "mode": "geo",
            "cached": False,
        }
        response = client.post(
            "/api/regenerate-overflow-graph",
            json={"mode": "geo"},
        )
        assert response.status_code == 200
        assert "pdf_url" not in response.json()


class TestResponseModels:
    """The D2 response models on the small control endpoints must serialize
    the EXACT field set — a `response_model` silently drops any field the
    handler returns that isn't declared, so these lock the shape (and the
    OpenAPI snapshot documents it)."""

    def test_recommender_model_response_exact_fields(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.get_active_model_name.return_value = "random"
        mock_rs.get_compute_overflow_graph.return_value = False
        resp = client.post("/api/recommender-model", json={"model": "random"})
        assert resp.status_code == 200
        assert resp.json() == {
            "status": "success",
            "active_model": "random",
            "compute_overflow_graph": False,
        }

    def test_restore_analysis_context_response_exact_fields(self, client, mock_services):
        resp = client.post(
            "/api/restore-analysis-context",
            json={
                "lines_we_care_about": ["L1", "L2"],
                "computed_pairs": {"a+b": {}},
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "status": "success",
            "lines_we_care_about_count": 2,
            "computed_pairs_count": 1,
        }

    def test_save_session_response_exact_fields(self, client, mock_services, tmp_path):
        resp = client.post(
            "/api/save-session",
            json={
                "session_name": "costudy4grid_session_x",
                "json_content": "{}",
                "output_folder_path": str(tmp_path),
            },
        )
        assert resp.status_code == 200
        assert set(resp.json().keys()) == {"session_folder", "pdf_copied"}
        assert resp.json()["pdf_copied"] is False


class TestSessionPathTraversal:
    """`session_name` is joined onto a caller-supplied folder to build the
    session directory, so it must be a single path component — a `..`, a
    path separator, or an absolute path (which `os.path.join` honours,
    silently dropping the base) would let save/load escape the output
    folder (QW7, 2026-07). `_safe_session_dir` rejects those with a 400
    before any filesystem write."""

    def test_save_session_rejects_parent_traversal(self, client, mock_services, tmp_path):
        base = tmp_path / "sessions"
        base.mkdir()
        resp = client.post(
            "/api/save-session",
            json={
                "session_name": "../escaped",
                "json_content": "{}",
                "output_folder_path": str(base),
            },
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid session name"
        # Nothing was written outside the base folder.
        assert not (tmp_path / "escaped").exists()

    def test_save_session_rejects_path_separator(self, client, mock_services, tmp_path):
        resp = client.post(
            "/api/save-session",
            json={
                "session_name": "nested/child",
                "json_content": "{}",
                "output_folder_path": str(tmp_path),
            },
        )
        assert resp.status_code == 400
        assert not (tmp_path / "nested").exists()

    def test_save_session_rejects_absolute_name(self, client, mock_services, tmp_path):
        evil = tmp_path / "abs_escape"
        resp = client.post(
            "/api/save-session",
            json={
                "session_name": str(evil),
                "json_content": "{}",
                "output_folder_path": str(tmp_path / "base"),
            },
        )
        assert resp.status_code == 400
        assert not evil.exists()

    def test_load_session_rejects_parent_traversal(self, client, mock_services, tmp_path):
        resp = client.post(
            "/api/load-session",
            json={"folder_path": str(tmp_path), "session_name": "../../etc"},
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid session name"

    def test_save_session_allows_plain_name(self, client, mock_services, tmp_path):
        resp = client.post(
            "/api/save-session",
            json={
                "session_name": "costudy4grid_session_ok",
                "json_content": "{}",
                "output_folder_path": str(tmp_path),
            },
        )
        assert resp.status_code == 200
        assert (tmp_path / "costudy4grid_session_ok" / "session.json").is_file()


class TestEventLoopSafety:
    """`/api/run-analysis-step1` runs seconds of synchronous pypowsybl /
    grid2op work, so it MUST be a sync `def` route (dispatched to
    Starlette's threadpool) — an `async def` would run that blocking work
    on the event loop and freeze every other request for its duration
    (QW2, 2026-07). The streaming analysis routes stay `async def`: they
    return a StreamingResponse immediately and their sync generators are
    iterated in the threadpool."""

    def test_run_analysis_step1_is_sync_def(self):
        import inspect

        from expert_backend import main

        assert not inspect.iscoroutinefunction(main.run_analysis_step1), (
            "run_analysis_step1 must be a sync `def` route so its blocking "
            "pypowsybl work runs in the threadpool, not on the event loop."
        )


class TestStudyMutationBusyGate:
    """The study-mutation gate (D3, 2026-07): config load + the analysis
    pipeline mutate shared singleton state, so at most one runs at a
    time; a second concurrent one is rejected with HTTP 409 rather than
    queued behind seconds of work."""

    def test_config_returns_409_when_busy(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = False
        response = client.post(
            "/api/config",
            json={"network_path": "/n", "action_file_path": "/a"},
        )
        assert response.status_code == 409
        assert "in progress" in response.json()["detail"]
        # A rejected request must NOT release a gate it never acquired.
        mock_rs.end_study_mutation.assert_not_called()

    def test_step1_returns_409_when_busy(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = False
        response = client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 409
        mock_rs.run_analysis_step1.assert_not_called()
        mock_rs.end_study_mutation.assert_not_called()

    def test_step1_releases_gate_on_success(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = True
        mock_rs.run_analysis_step1.return_value = {
            "lines_overloaded": [], "can_proceed": False, "step1_time": 0.1,
        }
        response = client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 200
        mock_rs.end_study_mutation.assert_called_once()

    def test_step1_releases_gate_on_error(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = True
        mock_rs.run_analysis_step1.side_effect = ValueError("boom")
        response = client.post(
            "/api/run-analysis-step1",
            json={"disconnected_elements": ["LINE_A"]},
        )
        assert response.status_code == 400
        # Gate released even when the analysis raised.
        mock_rs.end_study_mutation.assert_called_once()

    def test_step2_returns_409_when_busy(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = False
        response = client.post(
            "/api/run-analysis-step2",
            json={"selected_overloads": ["LINE_A"]},
        )
        assert response.status_code == 409
        mock_rs.run_analysis_step2.assert_not_called()

    def test_step2_releases_gate_after_stream(self, client, mock_services):
        _, mock_rs = mock_services
        mock_rs.try_begin_study_mutation.return_value = True
        mock_rs.run_analysis_step2.return_value = iter([
            {"type": "pdf", "pdf_path": None},
            {"type": "result", "actions": {}},
        ])
        with client.stream(
            "POST", "/api/run-analysis-step2",
            json={"selected_overloads": ["LINE_A"]},
        ) as response:
            assert response.status_code == 200
            _ = list(response.iter_lines())
        # Gate released in the generator's finally once the stream drains.
        mock_rs.end_study_mutation.assert_called_once()


class TestPickPath:
    """Native file/folder picker — must succeed on macOS via osascript
    (no tkinter dependency) and on other platforms via the existing
    tkinter subprocess. The endpoint always returns 200 with a body
    of {"path": ...} or {"path": "", "error": ...}; it never relies
    on transport-level errors to surface a failure to the frontend."""

    def test_macos_file_picker_uses_osascript(self, client):
        completed = MagicMock(returncode=0, stdout="/Users/me/grid.xiidm\n", stderr="")
        with patch("expert_backend.main.platform.system", return_value="Darwin"), \
             patch("expert_backend.main.subprocess.run", return_value=completed) as run:
            response = client.get("/api/pick-path?type=file")
        assert response.status_code == 200
        assert response.json() == {"path": "/Users/me/grid.xiidm"}
        # The dispatcher must invoke osascript with the file-picker prompt.
        argv = run.call_args.args[0]
        assert argv[0] == "osascript"
        assert any("choose file" in a for a in argv)

    def test_macos_dir_picker_uses_osascript(self, client):
        completed = MagicMock(returncode=0, stdout="/Users/me/output\n", stderr="")
        with patch("expert_backend.main.platform.system", return_value="Darwin"), \
             patch("expert_backend.main.subprocess.run", return_value=completed) as run:
            response = client.get("/api/pick-path?type=dir")
        assert response.status_code == 200
        assert response.json() == {"path": "/Users/me/output"}
        argv = run.call_args.args[0]
        assert argv[0] == "osascript"
        assert any("choose folder" in a for a in argv)

    def test_macos_user_cancel_is_silent(self, client):
        # AppleScript exits with code 1 + stderr "User canceled. (-128)"
        # when the user dismisses the dialog. The frontend must NOT see
        # an `error` field — it would pop a noisy alert for a benign
        # cancel gesture.
        cancelled = MagicMock(
            returncode=1,
            stdout="",
            stderr="0:55: execution error: User canceled. (-128)",
        )
        with patch("expert_backend.main.platform.system", return_value="Darwin"), \
             patch("expert_backend.main.subprocess.run", return_value=cancelled):
            response = client.get("/api/pick-path?type=file")
        assert response.status_code == 200
        assert response.json() == {"path": ""}

    def test_macos_real_failure_surfaces_error(self, client):
        failed = MagicMock(
            returncode=1, stdout="", stderr="syntax error: unexpected end of file",
        )
        with patch("expert_backend.main.platform.system", return_value="Darwin"), \
             patch("expert_backend.main.subprocess.run", return_value=failed):
            response = client.get("/api/pick-path?type=file")
        assert response.status_code == 200
        body = response.json()
        assert body["path"] == ""
        assert "syntax error" in body["error"]

    def test_macos_osascript_missing_falls_back_to_error(self, client):
        # If osascript is absent (extremely rare on macOS), surface a
        # helpful error instead of crashing the route.
        with patch("expert_backend.main.platform.system", return_value="Darwin"), \
             patch("expert_backend.main.subprocess.run", side_effect=FileNotFoundError("osascript")):
            response = client.get("/api/pick-path?type=file")
        assert response.status_code == 200
        body = response.json()
        assert body["path"] == ""
        assert "osascript" in body["error"]

    def test_non_macos_uses_tkinter_subprocess(self, client):
        completed = MagicMock(returncode=0, stdout="/home/user/grid.xiidm\n", stderr="")
        with patch("expert_backend.main.platform.system", return_value="Linux"), \
             patch("expert_backend.main.subprocess.run", return_value=completed) as run:
            response = client.get("/api/pick-path?type=file")
        assert response.status_code == 200
        assert response.json() == {"path": "/home/user/grid.xiidm"}
        # tkinter path runs the python interpreter, NOT osascript.
        argv = run.call_args.args[0]
        assert argv[0] != "osascript"
        # The inlined script must contain the tkinter import.
        assert any("import tkinter" in a for a in argv)
