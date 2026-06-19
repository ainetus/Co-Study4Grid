# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import pytest
from unittest.mock import patch, MagicMock
from expert_backend.services.recommender_service import RecommenderService

class TestOverloadFiltering:
    @pytest.fixture
    def service(self):
        return RecommenderService()

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_filters_care_about(self, mock_run_discovery, mock_run_graph, service):
        """Verify that deselected overloads are removed from lines_we_care_about."""
        # Setup mocks
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["LINE_1", "LINE_2"]
        }
        
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["LINE_1", "LINE_2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": {"LINE_1", "LINE_2", "LINE_3"}
        }
        
        # Test with monitor_deselected=False (filtering happens)
        list(service.run_analysis_step2(
            selected_overloads=["LINE_1"],
            all_overloads=["LINE_1", "LINE_2"],
            monitor_deselected=False
        ))
        
        # Verify lines_we_care_about was updated (LINE_2 was deselected)
        assert service._analysis_context["lines_we_care_about"] == {"LINE_1", "LINE_3"}
        assert service._analysis_context["lines_overloaded_names"] == ["LINE_1"]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_preserves_care_about_when_monitoring(self, mock_run_discovery, mock_run_graph, service):
        """Verify that lines_we_care_about is NOT filtered when monitor_deselected=True."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["LINE_1", "LINE_2"]
        }
        
        initial_care = {"LINE_1", "LINE_2", "LINE_3"}
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["LINE_1", "LINE_2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": initial_care.copy()
        }
        
        list(service.run_analysis_step2(
            selected_overloads=["LINE_1"],
            all_overloads=["LINE_1", "LINE_2"],
            monitor_deselected=True
        ))
        
        # Verify lines_we_care_about remains the same
        assert service._analysis_context["lines_we_care_about"] == initial_care
        # But resolution targets are still filtered
        assert service._analysis_context["lines_overloaded_names"] == ["LINE_1"]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_handles_different_iterable_types(self, mock_run_discovery, mock_run_graph, service):
        """Verify filtering works for both sets and lists in lines_we_care_about."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1", "L2"]
        }
        
        # Case 1: List
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": ["L1", "L2", "L3"]
        }
        list(service.run_analysis_step2(selected_overloads=["L1"], all_overloads=["L1", "L2"], monitor_deselected=False))
        assert service._analysis_context["lines_we_care_about"] == ["L1", "L3"]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_handles_empty_selection(self, mock_run_discovery, mock_run_graph, service):
        """Verify that empty selected_overloads results in empty targets but doesn't crash."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1", "L2"]
        }
        
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": {"L1", "L2", "L3"}
        }
        
        list(service.run_analysis_step2(selected_overloads=[], all_overloads=["L1", "L2"], monitor_deselected=False))
        
        assert service._analysis_context["lines_overloaded_names"] == []
        assert service._analysis_context["lines_overloaded_ids"] == []
        assert service._analysis_context["lines_we_care_about"] == {"L3"}

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_antenna_mode_none_kept_ids(self, mock_run_discovery, mock_run_graph, service):
        """Antenna (islanded-pocket) mode: lines_overloaded_ids_kept is None.

        When the contingency breaks the grid apart, upstream
        run_analysis_step1 returns a full context but with
        lines_overloaded_ids_kept=None (the island guard keeps no
        overloads for the standard graph; a synthetic downstream graph
        is built instead). The step-2 narrow helper must preserve None
        rather than crash with 'NoneType' object is not iterable.
        """
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1", "L2"],
        }

        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": None,
            "antenna_mode": True,
            "lines_we_care_about": {"L1", "L2", "L3"},
        }

        # Must not raise.
        list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1", "L2"],
            monitor_deselected=False,
        ))

        # None is preserved so the upstream antenna path still dispatches,
        # while the operator's selection narrows the rest of the context.
        assert service._analysis_context["lines_overloaded_ids_kept"] is None
        assert service._analysis_context["lines_overloaded_names"] == ["L1"]
        assert service._analysis_context["lines_overloaded_ids"] == [0]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_handles_invalid_names_in_selection(self, mock_run_discovery, mock_run_graph, service):
        """Verify that invalid names in selected_overloads are ignored."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1", "L2"]
        }
        
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": {"L1", "L2", "L3"}
        }
        
        # Select "L1" and "INVALID"
        list(service.run_analysis_step2(
            selected_overloads=["L1", "INVALID"], 
            all_overloads=["L1", "L2"], 
            monitor_deselected=False
        ))
        
        assert service._analysis_context["lines_overloaded_names"] == ["L1"]
        assert service._analysis_context["lines_overloaded_ids"] == [0]
        # "L2" was in all_overloads but not in selected, so it should be removed from care
        assert service._analysis_context["lines_we_care_about"] == {"L1", "L3"}

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_routes_additional_lines_to_extra_channel(self, mock_run_discovery, mock_run_graph, service):
        """Operator-supplied extras are routed via the upstream
        ``extra_lines_to_cut_ids`` channel (which the recommender / alphaDeesp
        treat as cut-but-not-overload via ``OverFlowGraph(extra_lines_to_cut=…)``).
        They MUST NOT be appended to ``lines_overloaded_*`` — otherwise the
        viewer's "Overloads" layer would mis-classify them.
        """
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        obs = MagicMock()
        obs.name_line = ["L1", "L2", "EXTRA_1", "EXTRA_2"]
        service._analysis_context = {
            "env": MagicMock(),
            "obs_simu_defaut": obs,
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": ["L1", "L2", "L3"],
        }

        list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1", "L2"],
            monitor_deselected=False,
            additional_lines_to_cut=["EXTRA_1", "EXTRA_2", "UNKNOWN_LINE", "L1"],
        ))

        ctx = service._analysis_context
        # Overload lists stay narrowed to operator-selected detected
        # overloads — extras must NOT leak in.
        assert ctx["lines_overloaded_names"] == ["L1"]
        assert ctx["lines_overloaded_ids"] == [0]
        assert ctx["lines_overloaded_ids_kept"] == [0]
        # Extras flow through the upstream ``extra_lines_to_cut_ids``
        # channel (consumed by ``run_analysis_step2_graph`` and forwarded
        # to ``OverFlowGraph(extra_lines_to_cut=…)``).  L1 (already
        # selected) and UNKNOWN_LINE (not in name_line) are skipped.
        assert ctx["extra_lines_to_cut_ids"] == [2, 3]
        # Extras stay inside the monitoring scope.
        assert "EXTRA_1" in ctx["lines_we_care_about"]
        assert "EXTRA_2" in ctx["lines_we_care_about"]
        assert "L2" not in ctx["lines_we_care_about"]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_extra_lines_recover_from_deselect_filter(self, mock_run_discovery, mock_run_graph, service):
        """An extra that coincides with a deselected overload must be added
        back to lines_we_care_about so monitoring is not silently lost,
        and routed through ``extra_lines_to_cut_ids`` (not promoted back
        into the overload set)."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        obs = MagicMock()
        obs.name_line = ["L1", "L2"]
        service._analysis_context = {
            "env": MagicMock(),
            "obs_simu_defaut": obs,
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": {"L1", "L2"},
        }

        list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1", "L2"],
            monitor_deselected=False,
            additional_lines_to_cut=["L2"],
        ))

        ctx = service._analysis_context
        # L2 is back in care (re-merged after the deselect-filter would
        # have evicted it).
        assert "L2" in ctx["lines_we_care_about"]
        # L2 is routed through the extras channel — it must NOT have
        # been promoted back into the overload-resolution targets.
        assert ctx["extra_lines_to_cut_ids"] == [1]
        assert ctx["lines_overloaded_names"] == ["L1"]
        assert ctx["lines_overloaded_ids"] == [0]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_extras_default_empty_list(self, mock_run_discovery, mock_run_graph, service):
        """When the operator passes no extras, ``extra_lines_to_cut_ids`` is
        still set to ``[]`` so the upstream library reads a stable key (and
        does not fall through to ``context.get(...) or []`` ambiguity)."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        obs = MagicMock()
        obs.name_line = ["L1", "L2"]
        for additional in (None, [], ()):
            service._analysis_context = {
                "env": MagicMock(),
                "obs_simu_defaut": obs,
                "lines_overloaded_names": ["L1", "L2"],
                "lines_overloaded_ids": [0, 1],
                "lines_overloaded_ids_kept": [0, 1],
                "lines_we_care_about": ["L1", "L2"],
            }
            list(service.run_analysis_step2(
                selected_overloads=["L1"],
                all_overloads=["L1", "L2"],
                monitor_deselected=True,
                additional_lines_to_cut=additional,
            ))
            assert service._analysis_context["extra_lines_to_cut_ids"] == [], (
                f"empty input {additional!r} should yield extra_lines_to_cut_ids=[]"
            )

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_extras_dedup_within_input(self, mock_run_discovery, mock_run_graph, service):
        """Duplicate names in the operator's input collapse to a single
        ``extra_lines_to_cut_ids`` entry — guards against the upstream
        library seeing the same index twice (which would either be a
        no-op or trigger a defensive guard, depending on version)."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        obs = MagicMock()
        obs.name_line = ["L1", "EXTRA_1"]
        service._analysis_context = {
            "env": MagicMock(),
            "obs_simu_defaut": obs,
            "lines_overloaded_names": ["L1"],
            "lines_overloaded_ids": [0],
            "lines_overloaded_ids_kept": [0],
            "lines_we_care_about": ["L1", "EXTRA_1"],
        }

        list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1"],
            monitor_deselected=True,
            additional_lines_to_cut=["EXTRA_1", "EXTRA_1", "EXTRA_1"],
        ))

        assert service._analysis_context["extra_lines_to_cut_ids"] == [1]

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_extras_when_obs_simu_defaut_missing(self, mock_run_discovery, mock_run_graph, service):
        """If ``obs_simu_defaut`` is missing from the context, the extras
        fall through gracefully (warning logged, channel left empty) — we
        must NOT crash the entire step-2 stream."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        # obs_simu_defaut absent — name_line lookup must not crash.
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1"],
            "lines_overloaded_ids": [0],
            "lines_overloaded_ids_kept": [0],
            "lines_we_care_about": ["L1"],
        }

        events = list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1"],
            monitor_deselected=True,
            additional_lines_to_cut=["UNKNOWN"],
        ))

        # Stream completed without crashing.
        assert any(e.get("type") == "result" for e in events)
        # Empty-channel fallback — the unknown name is dropped silently
        # (with a warning).
        assert service._analysis_context["extra_lines_to_cut_ids"] == []

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_extras_with_lines_we_care_about_none(self, mock_run_discovery, mock_run_graph, service):
        """When monitoring scope is unbounded (``lines_we_care_about=None``,
        i.e. monitor every line), the extras still reach the upstream
        channel — we must not require a non-None care set."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }

        obs = MagicMock()
        obs.name_line = ["L1", "EXTRA_1"]
        service._analysis_context = {
            "env": MagicMock(),
            "obs_simu_defaut": obs,
            "lines_overloaded_names": ["L1"],
            "lines_overloaded_ids": [0],
            "lines_overloaded_ids_kept": [0],
            "lines_we_care_about": None,
        }

        list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1"],
            monitor_deselected=True,
            additional_lines_to_cut=["EXTRA_1"],
        ))

        ctx = service._analysis_context
        assert ctx["extra_lines_to_cut_ids"] == [1]
        # lines_we_care_about stays None (unbounded scope) — we must not
        # accidentally narrow it to just the extras.
        assert ctx["lines_we_care_about"] is None

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_handles_error(self, mock_run_discovery, mock_run_graph, service):
        """Verify that backend errors are caught and yielded as error events."""
        mock_run_graph.side_effect = Exception("Simulated Backend Crash")
        
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1"],
            "lines_overloaded_ids": [0],
            "lines_overloaded_ids_kept": [0]
        }
        
        events = list(service.run_analysis_step2(selected_overloads=["L1"], all_overloads=["L1"]))
        
        assert any(e.get("type") == "error" and "Simulated Backend Crash" in e.get("message") for e in events)

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_run_analysis_step2_care_initialization(self, mock_run_discovery, mock_run_graph, service):
        """Verify that 'care' is correctly handled (fixing UnboundLocalError regression)."""
        mock_run_graph.side_effect = lambda ctx: ctx
        mock_run_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"]
        }
        
        # Scenario where monitor_deselected is True (skips the filtering block where 'care' was defined)
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": ["L1", "L2"]
        }
        
        # This should NOT raise UnboundLocalError
        events = list(service.run_analysis_step2(
            selected_overloads=["L1"],
            all_overloads=["L1", "L2"],
            monitor_deselected=True
        ))

        result_event = next(e for e in events if e.get("type") == "result")
        assert result_event["lines_we_care_about"] == ["L1", "L2"]


class TestStep2GraphCacheReuse:
    """Step-2 caches the overflow graph keyed by an input signature
    (contingency + selected/all overloads + monitor toggle +
    additional_lines_to_cut). A re-run with an identical signature
    skips ``run_analysis_step2_graph`` and reuses the cached graph +
    the enriched context, jumping straight to action discovery — so
    swapping only the recommender model is near-instant. A changed
    signature (e.g. different additional_lines_to_cut) rebuilds.
    """

    @pytest.fixture
    def service(self):
        return RecommenderService()

    def _seed_context(self, service):
        # Mimics what run_analysis_step1 leaves on the service.
        service._last_disconnected_elements = ["LINE_C"]
        service._analysis_context = {
            "env": MagicMock(),
            "lines_overloaded_names": ["L1", "L2"],
            "lines_overloaded_ids": [0, 1],
            "lines_overloaded_ids_kept": [0, 1],
            "lines_we_care_about": {"L1", "L2"},
        }

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_identical_signature_skips_graph_rebuild(self, mock_discovery, mock_graph, service, tmp_path):
        pdf = tmp_path / "overflow.html"
        pdf.write_text("<html></html>")
        mock_graph.side_effect = lambda ctx: ctx
        mock_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }
        service._get_latest_pdf_path = MagicMock(return_value=str(pdf))

        # First run — builds the graph and seeds the cache.
        self._seed_context(service)
        list(service.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1", "L2"],
            monitor_deselected=False, additional_lines_to_cut=["EXTRA"],
        ))
        assert mock_graph.call_count == 1
        assert mock_discovery.call_count == 1
        assert service._last_step2_context is not None
        assert service._last_step2_signature is not None
        assert service._overflow_layout_cache.get("hierarchical") == str(pdf)

        # Second run, identical signature — the graph rebuild is skipped
        # but discovery still runs (it's where the recommender model is
        # consumed, so a model swap re-runs only this step).
        events = list(service.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1", "L2"],
            monitor_deselected=False, additional_lines_to_cut=["EXTRA"],
        ))
        assert mock_graph.call_count == 1   # NOT rebuilt
        assert mock_discovery.call_count == 2  # discovery re-ran
        pdf_event = next(e for e in events if e.get("type") == "pdf")
        assert pdf_event["pdf_path"] == str(pdf)
        assert pdf_event.get("cached") is True

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_changed_additional_lines_rebuilds_graph(self, mock_discovery, mock_graph, service, tmp_path):
        pdf = tmp_path / "overflow.html"
        pdf.write_text("<html></html>")
        mock_graph.side_effect = lambda ctx: ctx
        mock_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }
        service._get_latest_pdf_path = MagicMock(return_value=str(pdf))

        self._seed_context(service)
        list(service.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1", "L2"],
            monitor_deselected=False, additional_lines_to_cut=["EXTRA"],
        ))
        assert mock_graph.call_count == 1

        # Re-seed (step1 re-runs in the real flow) and change the
        # additional-lines hypothesis → signature differs → rebuild.
        self._seed_context(service)
        list(service.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1", "L2"],
            monitor_deselected=False, additional_lines_to_cut=["OTHER"],
        ))
        assert mock_graph.call_count == 2  # rebuilt for the new signature

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_result_event_carries_active_model(self, mock_discovery, mock_graph, service):
        mock_graph.side_effect = lambda ctx: ctx
        mock_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }
        # ModelSelectionMixin getters are attached via the
        # expert_backend.recommenders import side-effect — stub the
        # getter directly so the result event echoes the active model.
        service.get_active_model_name = MagicMock(return_value="random_overflow")
        self._seed_context(service)

        events = list(service.run_analysis_step2(selected_overloads=["L1"], all_overloads=["L1"]))
        result_event = next(e for e in events if e.get("type") == "result")
        assert result_event["active_model"] == "random_overflow"

    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph")
    @patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery")
    def test_result_event_active_model_none_when_getter_absent(
        self, mock_discovery, mock_graph, service
    ):
        # The legacy `AnalysisMixin.run_analysis_step2` result event
        # guards `get_active_model_name` with `hasattr` so a bare
        # RecommenderService (no ModelSelectionMixin) still emits the
        # event with active_model=None instead of crashing.
        #
        # This scenario only applies to the LEGACY generator. In
        # production `expert_backend.recommenders` is imported, which
        # BOTH attaches `get_active_model_name` AND replaces
        # `run_analysis_step2` with `_run_analysis_step2_with_model`
        # (which calls the getter unconditionally — no guard, none
        # needed). Skip unless the legacy method is the active one and
        # the getter is genuinely absent, i.e. the recommenders package
        # was never imported in this pytest process (the mock-layer
        # sandbox). Checked at call time — collection order can't be
        # relied on.
        if type(service).run_analysis_step2.__name__ != "run_analysis_step2":
            pytest.skip(
                "legacy AnalysisMixin.run_analysis_step2 is shadowed by the "
                "production model-aware replacement"
            )
        if hasattr(type(service), "get_active_model_name"):
            pytest.skip(
                "get_active_model_name was attached by a recommenders import "
                "earlier in this process — the 'getter absent' path can't be staged"
            )
        mock_graph.side_effect = lambda ctx: ctx
        mock_discovery.return_value = {
            "prioritized_actions": {},
            "action_scores": {},
            "lines_overloaded_names": ["L1"],
        }
        self._seed_context(service)

        events = list(service.run_analysis_step2(selected_overloads=["L1"], all_overloads=["L1"]))
        result_event = next(e for e in events if e.get("type") == "result")
        assert result_event["active_model"] is None

    def test_reset_clears_step2_signature(self, service):
        # The signature is a per-study cache — reset() MUST clear it so
        # a freshly loaded study never reuses the previous study's
        # overflow graph.
        service._last_step2_signature = ("LINE_C", ("L1",), ("L1",), False, ())
        service._last_step2_context = {"foo": "bar"}
        service.reset()
        assert service._last_step2_signature is None
        assert service._last_step2_context is None


class TestStep2GraphCacheHelpers:
    """Unit coverage for the shared `_step2_graph_signature` /
    `_can_reuse_step2_graph` helpers on AnalysisMixin. Both the legacy
    `run_analysis_step2` and the model-aware production replacement in
    `_service_integration` use these, so they're tested directly here
    (the production wrapper itself needs the real recommenders package
    and is covered in `tests/test_service_integration.py`)."""

    @pytest.fixture
    def service(self):
        return RecommenderService()

    def test_signature_is_deterministic_for_same_inputs(self, service):
        service._last_disconnected_elements = ["LINE_C"]
        sig_a = service._step2_graph_signature(["L1", "L2"], ["L1", "L2"], False, ["EXTRA"])
        sig_b = service._step2_graph_signature(["L1", "L2"], ["L1", "L2"], False, ["EXTRA"])
        assert sig_a == sig_b

    def test_signature_is_order_independent_for_the_list_inputs(self, service):
        # selected / all / additional are sorted into the signature, so
        # the operator picking the same lines in a different order does
        # NOT invalidate the cache.
        service._last_disconnected_elements = ["LINE_C"]
        sig_a = service._step2_graph_signature(["L1", "L2"], ["L2", "L1"], False, ["B", "A"])
        sig_b = service._step2_graph_signature(["L2", "L1"], ["L1", "L2"], False, ["A", "B"])
        assert sig_a == sig_b

    def test_signature_differs_when_additional_lines_change(self, service):
        # The whole point of the cache: only an `additional_lines_to_cut`
        # change (or a contingency / overload-selection change) should
        # force an overflow-graph rebuild.
        service._last_disconnected_elements = ["LINE_C"]
        base = service._step2_graph_signature(["L1"], ["L1"], False, [])
        with_extra = service._step2_graph_signature(["L1"], ["L1"], False, ["EXTRA"])
        assert base != with_extra

    def test_signature_differs_when_contingency_changes(self, service):
        service._last_disconnected_elements = ["LINE_C"]
        sig_c = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_disconnected_elements = ["LINE_D"]
        sig_d = service._step2_graph_signature(["L1"], ["L1"], False, [])
        assert sig_c != sig_d

    def test_can_reuse_when_signature_matches_and_pdf_on_disk(self, service, tmp_path):
        pdf = tmp_path / "overflow.html"
        pdf.write_text("<html></html>")
        sig = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_step2_signature = sig
        service._last_step2_context = {"enriched": True}
        service._overflow_layout_cache = {"hierarchical": str(pdf)}
        assert service._can_reuse_step2_graph(sig) is True

    def test_cannot_reuse_when_signature_differs(self, service, tmp_path):
        pdf = tmp_path / "overflow.html"
        pdf.write_text("<html></html>")
        service._last_step2_signature = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_step2_context = {"enriched": True}
        service._overflow_layout_cache = {"hierarchical": str(pdf)}
        other_sig = service._step2_graph_signature(["L1"], ["L1"], False, ["EXTRA"])
        assert service._can_reuse_step2_graph(other_sig) is False

    def test_cannot_reuse_when_context_missing(self, service, tmp_path):
        pdf = tmp_path / "overflow.html"
        pdf.write_text("<html></html>")
        sig = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_step2_signature = sig
        service._last_step2_context = None
        service._overflow_layout_cache = {"hierarchical": str(pdf)}
        assert service._can_reuse_step2_graph(sig) is False

    def test_cannot_reuse_when_no_cached_pdf(self, service):
        sig = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_step2_signature = sig
        service._last_step2_context = {"enriched": True}
        service._overflow_layout_cache = {}
        assert service._can_reuse_step2_graph(sig) is False

    def test_cannot_reuse_when_cached_pdf_no_longer_on_disk(self, service, tmp_path):
        # The HTML viewer file may have been cleaned up between runs.
        sig = service._step2_graph_signature(["L1"], ["L1"], False, [])
        service._last_step2_signature = sig
        service._last_step2_context = {"enriched": True}
        service._overflow_layout_cache = {"hierarchical": str(tmp_path / "gone.html")}
        assert service._can_reuse_step2_graph(sig) is False
