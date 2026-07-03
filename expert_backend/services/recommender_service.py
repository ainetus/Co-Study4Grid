# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""RecommenderService — main orchestrator for grid contingency analysis.

This module was refactored from a 3,100+ line monolith into focused
modules.  Business logic lives in mixin classes:

- DiagramMixin   (diagram_mixin.py)  — NAD/SLD generation, flow deltas
- AnalysisMixin  (analysis_mixin.py) — contingency analysis, action enrichment
- SimulationMixin(simulation_mixin.py) — manual simulation, superposition

This file contains the core class definition, state management,
configuration, and network/environment lifecycle.
"""

import logging
import os
from pathlib import Path

import numpy as np

from expert_op4grid_recommender import config
from expert_op4grid_recommender.data_loader import load_actions, enrich_actions_lazy
from expert_op4grid_recommender.main import (
    Backend, run_analysis, run_analysis_step1, run_analysis_step2,
    run_analysis_step2_graph, run_analysis_step2_discovery,
)
from expert_op4grid_recommender.utils.make_env_utils import create_olf_rte_parameter
from expert_op4grid_recommender.utils.superposition import (
    compute_combined_pair_superposition,
    _identify_action_elements,
    get_virtual_line_flow,
)
from expert_op4grid_recommender.action_evaluation.classifier import ActionClassifier
from expert_op4grid_recommender.environment import load_interesting_lines

from expert_backend.services.sanitize import sanitize_for_json
from expert_backend.services.diagram_mixin import DiagramMixin
from expert_backend.services.analysis_mixin import AnalysisMixin
from expert_backend.services.simulation_mixin import SimulationMixin

logger = logging.getLogger(__name__)


class RecommenderService(DiagramMixin, AnalysisMixin, SimulationMixin):
    """Central service for grid contingency analysis and remedial action recommendation.

    Inherits domain logic from:
    - DiagramMixin:    diagram generation and flow analysis
    - AnalysisMixin:   contingency analysis and action enrichment
    - SimulationMixin: manual action simulation and superposition
    """

    def __init__(self):
        self._last_result = None
        self._is_running = False
        self._generator = None
        self._base_network = None
        self._simulation_env = None
        self._last_disconnected_elements: list[str] = []
        self._dict_action = None
        self._analysis_context = None
        self._saved_computed_pairs = None
        # Phase 2 caches for faster manual action simulation
        self._cached_obs_n = None
        self._cached_obs_n_id = None
        self._cached_obs_n1 = None
        self._cached_obs_n1_id = None
        # Tuple of contingency element IDs that produced ``_cached_obs_n1``.
        # Lets ``run_analysis_step1`` validate the cache against the exact
        # element list before trusting it (defense-in-depth on top of the
        # variant-ID check).
        self._cached_obs_n1_elements: tuple[str, ...] | None = None
        # Pre-built SimulationEnvironment reused across contingency analyses
        self._cached_env_context = None
        # N-state PST tap positions captured at network load time
        self._initial_pst_taps = None  # dict: pst_name -> {tap, low_tap, high_tap}
        # LF status cache keyed by N-1 variant id (populated when
        # `_get_n1_variant` runs the AC LF on a fresh variant).
        # `get_n1_diagram` can read this instead of re-running AC LF
        # for the sole purpose of getting the status — saves ~600 ms
        # per N-1 diagram on the PyPSA-EUR France grid (cold path) and
        # ~1 s on the warm path (repeat views of same contingency).
        self._lf_status_by_variant = {}
        # Grid-layout DataFrame cache (populated by `DiagramMixin._load_layout`,
        # keyed by `(path, mtime)`). Owned here so `reset()` can clear it when
        # a new study is loaded — otherwise a stale layout can leak across
        # studies that share the same layout filename / mtime, producing a
        # NAD whose `fixed_positions` reference the previous grid's substations.
        self._layout_cache = None
        # Pre-fetched base NAD (populated by `prefetch_base_nad_async` during
        # `update_config`, consumed by `/api/network-diagram`). See
        # docs/performance/history/nad-prefetch.md.
        self._prefetched_base_nad = None       # dict result (see DiagramMixin.get_network_diagram)
        self._prefetched_base_nad_error = None  # Exception if the prefetch thread failed
        self._prefetched_base_nad_event = None  # threading.Event signalling completion
        self._prefetched_base_nad_thread = None # threading.Thread handle (join on reset)
        # Overflow-graph layout toggle (Hierarchical / Geo).
        # `_overflow_layout_mode` holds the currently-rendered mode; the
        # cache maps mode -> absolute path of the HTML file produced for
        # that mode during the current Step-2 run so subsequent toggles
        # are instant (no graphviz re-run). Cleared on reset() and at the
        # start of each fresh run_analysis_step2.
        self._overflow_layout_mode = "hierarchical"
        self._overflow_layout_cache: dict[str, str] = {}
        # Enriched Step-2 context (populated by `AnalysisMixin.run_analysis_step2`
        # after `run_analysis_step2_graph` returns). Preserved so
        # `/api/regenerate-overflow-graph` can re-invoke graph generation
        # without redoing step1 setup or action discovery.
        self._last_step2_context = None
        # Signature of the inputs that produced ``_last_step2_context`` +
        # the cached overflow-graph HTML. When a re-run posts the same
        # signature, ``run_analysis_step2`` skips the OverFlowGraph
        # rebuild and jumps straight to action discovery — see the
        # comment on the fast path in ``analysis_mixin.run_analysis_step2``.
        self._last_step2_signature = None
        # Wall-clock for the most recent ``run_analysis_step1`` call so
        # ``run_analysis_step2`` can echo it in the result event next to
        # its own per-stage timings.
        self._last_step1_time: float | None = None

    def reset(self) -> None:
        """Clear all cached analysis state. Called when loading a new study."""
        # Drain any in-flight NAD prefetch thread BEFORE we tear down the
        # network it depends on. A dangling thread that finishes after
        # reset() would write into the next study's `_prefetched_base_nad`
        # and serve stale SVG.
        self._drain_pending_base_nad_prefetch()

        self._last_result = None
        self._is_running = False
        self._generator = None
        self._base_network = None
        self._simulation_env = None
        self._last_disconnected_elements = []
        self._dict_action = None
        self._analysis_context = None
        self._saved_computed_pairs = None
        # Phase 2 caches for faster manual action simulation
        self._cached_obs_n = None
        self._cached_obs_n_id = None
        self._cached_obs_n1 = None
        self._cached_obs_n1_id = None
        self._cached_obs_n1_elements = None
        self._cached_env_context = None
        self._initial_pst_taps = None
        self._lf_status_by_variant = {}
        # Layout cache must be cleared when a new study is loaded so the
        # next `_load_layout()` call reads the fresh `grid_layout.json`
        # for the new grid. Without this, the previous study's layout
        # DataFrame could be re-served for the new grid if `(path, mtime)`
        # happens to match (shared filename, coarse filesystem mtime
        # resolution), producing a NAD whose `fixed_positions` reference
        # substation IDs from the wrong grid.
        self._layout_cache = None

        self._prefetched_base_nad = None
        self._prefetched_base_nad_error = None
        self._prefetched_base_nad_event = None
        self._prefetched_base_nad_thread = None
        # Overflow-graph toggle state: reset so a new study always starts
        # in hierarchical mode with an empty file-path cache.
        self._overflow_layout_mode = "hierarchical"
        self._overflow_layout_cache = {}
        self._last_step2_context = None
        self._last_step2_signature = None
        self._last_step1_time = None

    # ------------------------------------------------------------------
    # Overflow-graph layout (Hierarchical / Geo)
    # ------------------------------------------------------------------

    def _load_layout_coords(self) -> dict:
        """Return ``{substation_id: (x, y)}`` from the cached
        ``grid_layout.json`` DataFrame, or an empty dict when no
        layout file is configured / readable.

        Unlike the earlier ``_custom_layout_for_env`` helper (now
        removed), this does NOT require alignment with
        ``env.name_sub``.  The geo rendering is a pure SVG transform
        over the already-produced hierarchical HTML — it only needs
        coordinates for nodes that actually appear in the graph, and
        silently leaves unknown nodes at their original position (see
        ``services/analysis/overflow_geo_transform.py``).
        """
        df = self._load_layout()
        if df is None or getattr(df, "empty", True):
            logger.warning(
                "Overflow geo layout unavailable: _load_layout() returned "
                "empty/None. Check LAYOUT_FILE_PATH (current: %r).",
                getattr(config, "LAYOUT_FILE_PATH", None),
            )
            return {}
        # DataFrame shape from services/diagram/layout_cache.py:
        # index=id, columns=[x, y]. Defensive 'id in columns' branch
        # for callers that might build the DataFrame differently.
        if "id" in df.columns:
            return {row["id"]: (float(row["x"]), float(row["y"])) for _, row in df.iterrows()}
        return {idx: (float(row["x"]), float(row["y"])) for idx, row in df.iterrows()}

    # ------------------------------------------------------------------
    # Base-NAD prefetch (concurrent with update_config's env-setup phase)
    # ------------------------------------------------------------------

    def _drain_pending_base_nad_prefetch(self) -> None:
        """Wait for the in-flight NAD prefetch thread to finish and discard
        its result. Called on `reset()` so a still-running prefetch cannot
        leak into the next study by writing into fresh prefetch state."""
        thread = self._prefetched_base_nad_thread
        if thread is not None and thread.is_alive():
            # join is safe here — the thread only calls pypowsybl and
            # returns; it has no other blocking I/O.
            thread.join(timeout=60)

    def prefetch_base_nad_async(self) -> None:
        """Kick off base-NAD generation in a background thread.

        Designed to be called from `update_config` just before the expensive
        `setup_environment_configs_pypowsybl()` step, so the two pieces of
        pypowsybl work overlap and the client's subsequent
        `/api/network-diagram` XHR becomes a near-instant cache hit.

        Thread-safety notes:
          - `self._base_network` is pre-loaded in the main thread *before*
            the worker starts (see below), so the worker never races on the
            lazy-init path of `_get_base_network()`.
          - The grid2op environment built in parallel uses its own
            pypowsybl network instance (grid2op backends wrap their own
            `pp.network.load()`), so variant switching inside
            `_generate_diagram` does not collide with env setup.
          - We swallow exceptions in the worker and surface them on the
            foreground call to `get_prefetched_base_nad()`; the foreground
            thread MUST NOT see a partially-populated cache.
        """
        import threading

        # Cancel any in-flight previous prefetch (defensive; reset() normally
        # runs first, but a direct re-call of update_config would bypass it).
        self._drain_pending_base_nad_prefetch()

        # Pre-warm the network cache in the main thread so the worker only
        # sees an O(1) attribute access — eliminates the lazy-init race.
        try:
            self._get_base_network()
        except Exception as e:
            # If we can't even load the network, don't spawn a worker that
            # will fail the same way — record the error directly and mark
            # the prefetch as already-completed.
            self._prefetched_base_nad = None
            self._prefetched_base_nad_error = e
            ev = threading.Event()
            ev.set()
            self._prefetched_base_nad_event = ev
            self._prefetched_base_nad_thread = None
            return

        event = threading.Event()
        self._prefetched_base_nad = None
        self._prefetched_base_nad_error = None
        self._prefetched_base_nad_event = event

        def _worker() -> None:
            try:
                diagram = self.get_network_diagram()
                self._prefetched_base_nad = diagram
            except Exception as exc:  # noqa: BLE001 — any failure is surfaced to the caller
                logger.warning(f"[prefetch_base_nad_async] NAD prefetch failed: {exc}")
                self._prefetched_base_nad_error = exc
            finally:
                event.set()

        t = threading.Thread(target=_worker, name="NADPrefetch", daemon=True)
        self._prefetched_base_nad_thread = t
        t.start()

    def get_prefetched_base_nad(self, timeout=60):
        """Return the prefetched NAD if one was queued, else None.

        If the prefetch is still running, waits up to `timeout` seconds for
        it to finish. If the prefetch failed, re-raises the stored exception.
        Returns None when no prefetch was ever started (e.g. update_config
        was not called in this process, or a direct test bypasses it).
        """
        event = self._prefetched_base_nad_event
        if event is None:
            return None
        finished = event.wait(timeout=timeout)
        if not finished:
            # Prefetch is still running after `timeout`; fall back to fresh
            # compute in the caller. Leave the prefetch running — it will
            # complete eventually and its result will be discarded on the
            # next `reset()`.
            logger.warning(
                "[get_prefetched_base_nad] Prefetch did not complete within "
                f"{timeout}s; caller should fall back to fresh compute."
            )
            return None
        if self._prefetched_base_nad_error is not None:
            raise self._prefetched_base_nad_error
        return self._prefetched_base_nad

    def restore_analysis_context(self, lines_we_care_about, disconnected_elements=None, lines_overloaded=None, computed_pairs=None) -> None:
        """Restore analysis context from a saved session.

        This sets _analysis_context so that subsequent simulate_manual_action
        calls use the same monitored lines (lines_we_care_about) that were
        determined during the original analysis.  Without this, session reload
        falls back to _get_monitoring_parameters which may return a different
        set of lines and produce inconsistent max_rho values.
        """
        self._analysis_context = {
            "lines_we_care_about": list(lines_we_care_about) if lines_we_care_about else None,
        }
        if disconnected_elements:
            self._last_disconnected_elements = list(disconnected_elements)
        if lines_overloaded is not None:
            self._analysis_context["lines_overloaded"] = list(lines_overloaded)
        if computed_pairs is not None:
            self._saved_computed_pairs = computed_pairs
        logger.info(f"[restore_analysis_context] Restored context: "
              f"{len(lines_we_care_about) if lines_we_care_about else 0} monitored lines, "
              f"disconnected={list(disconnected_elements) if disconnected_elements else []}, "
              f"{len(lines_overloaded) if lines_overloaded else 0} overloaded lines, "
              f"{len(computed_pairs) if computed_pairs else 0} computed pairs")

    def get_saved_computed_pairs(self):
        """Return saved computed pairs from session restore, or None."""
        return self._saved_computed_pairs

    def update_config(self, settings) -> None:
        # Update the global config of the package
        path_obj = Path(settings.network_path)
        config.ENV_NAME = path_obj.name
        config.ENV_FOLDER = path_obj.parent
        config.ENV_PATH = path_obj
        
        config.ACTION_FILE_PATH = Path(settings.action_file_path)
        
        # Apply the new settings parameters
        config.MIN_LINE_RECONNECTIONS = settings.min_line_reconnections
        config.MIN_CLOSE_COUPLING = settings.min_close_coupling
        config.MIN_OPEN_COUPLING = settings.min_open_coupling
        config.MIN_LINE_DISCONNECTIONS = settings.min_line_disconnections
        config.N_PRIORITIZED_ACTIONS = settings.n_prioritized_actions
        if hasattr(settings, 'monitoring_factor'):
            config.MONITORING_FACTOR_THERMAL_LIMITS = settings.monitoring_factor
        if hasattr(settings, 'pre_existing_overload_threshold') and settings.pre_existing_overload_threshold is not None:
            config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = settings.pre_existing_overload_threshold
        if hasattr(settings, 'ignore_reconnections') and settings.ignore_reconnections is not None:
            config.IGNORE_RECONNECTIONS = settings.ignore_reconnections
        if hasattr(settings, 'pypowsybl_fast_mode') and settings.pypowsybl_fast_mode is not None:
            config.PYPOWSYBL_FAST_MODE = settings.pypowsybl_fast_mode
        if hasattr(settings, 'min_pst') and settings.min_pst is not None:
            config.MIN_PST = settings.min_pst
        if hasattr(settings, 'min_load_shedding') and settings.min_load_shedding is not None:
            config.MIN_LOAD_SHEDDING = settings.min_load_shedding
        if hasattr(settings, 'min_renewable_curtailment_actions') and settings.min_renewable_curtailment_actions is not None:
            config.MIN_RENEWABLE_CURTAILMENT_ACTIONS = settings.min_renewable_curtailment_actions
        if hasattr(settings, 'min_redispatch') and settings.min_redispatch is not None:
            config.MIN_REDISPATCH = settings.min_redispatch
        if hasattr(settings, 'redispatch_default_delta_mw') and settings.redispatch_default_delta_mw is not None:
            config.REDISPATCH_DEFAULT_DELTA_MW = settings.redispatch_default_delta_mw
        # Recommender restriction: empty / missing → all families allowed.
        if hasattr(settings, 'allowed_action_types'):
            config.ALLOWED_ACTION_TYPES = list(settings.allowed_action_types or [])

        # New layout file path
        if hasattr(settings, 'layout_path') and settings.layout_path:
            config.LAYOUT_FILE_PATH = Path(settings.layout_path)
        else:
            config.LAYOUT_FILE_PATH = None

        # Force the requested global flags
        config.MAX_RHO_BOTH_EXTREMITIES = True
        
        # Handle lines monitoring optionally
        if hasattr(settings, 'lines_monitoring_path') and settings.lines_monitoring_path:
            if os.path.exists(settings.lines_monitoring_path):
                config.IGNORE_LINES_MONITORING = False
                config.LINES_MONITORING_FILE = Path(settings.lines_monitoring_path)
            else:
                config.IGNORE_LINES_MONITORING = True
                config.LINES_MONITORING_FILE = None
                config.MONITORED_LINES_COUNT = 0
                logger.warning(f"Ignoring lines monitoring (file path {settings.lines_monitoring_path} does not exist).")
        else:
            # No monitoring file specified by UI → monitor all lines.
            # The library's setup_environment_configs_pypowsybl will set
            # lines_we_care_about = all lines when IGNORE_LINES_MONITORING is True.
            config.IGNORE_LINES_MONITORING = True
            config.LINES_MONITORING_FILE = None
            config.MONITORED_LINES_COUNT = 0

        if not getattr(config, 'IGNORE_LINES_MONITORING', True):
            try:
                from expert_op4grid_recommender.data_loader import load_interesting_lines
                lines = list(load_interesting_lines(file_name=config.LINES_MONITORING_FILE))
                config.MONITORED_LINES_COUNT = len(lines)
                logger.info(f"Loaded lines monitoring file: {config.LINES_MONITORING_FILE} ({config.MONITORED_LINES_COUNT} lines)")
            except Exception as e:
                logger.warning(f"Failed to count lines in {config.LINES_MONITORING_FILE}: {e}")
                config.MONITORED_LINES_COUNT = -1

        # Kick off the base-NAD prefetch worker here — at the earliest point
        # where all the config globals the worker depends on are set
        # (ENV_PATH, LAYOUT_FILE_PATH, IGNORE_LINES_MONITORING, MONITORING_FACTOR_*).
        # The worker runs in parallel with THE REST of update_config (action
        # dict load + enrich_actions_lazy ≈ 2 s, then env setup ≈ 2 s), giving
        # it ~4 s of parallel runtime instead of ~2 s when spawned later.
        # NAD compute is ~6 s → by the time /api/config returns, the worker
        # is ~2 s from done instead of ~4 s, so the subsequent
        # /api/network-diagram XHR wait drops from ~2 s to ~0-1 s on large
        # grids. See docs/performance/history/nad-prefetch-earlier-spawn.md.
        self.prefetch_base_nad_async()

        # Load and cache the action dictionary immediately if path changed or not loaded
        new_action_path = Path(settings.action_file_path)
        if getattr(self, '_last_action_path', None) != new_action_path or self._dict_action is None:
            raw_dict_action = load_actions(config.ACTION_FILE_PATH)
            self._last_action_path = new_action_path

            # Auto-generate disco actions if none exist in the file
            has_disco = any(k.startswith("disco_") for k in raw_dict_action)
            if not has_disco:
                from expert_backend.services.network_service import network_service
                branches = network_service.get_disconnectable_elements()
                for branch in branches:
                    action_id = f"disco_{branch}"
                    raw_dict_action[action_id] = {
                        "description": f"Disconnection of line/transformer '{branch}'",
                        "description_unitaire": f"Ouverture de la ligne '{branch}'",
                        "content": {
                            "set_bus": {
                                "lines_or_id": {branch: -1},
                                "lines_ex_id": {branch: -1},
                            }
                        },
                    }
                logger.info(f"[RecommenderService] Auto-generated {len(branches)} disco_ actions")

                # Save the raw entries (without content) so the core analysis engine can read them
                import json
                with open(config.ACTION_FILE_PATH, 'w') as f:
                    json.dump(raw_dict_action, f, indent=2)

            # Wrap with LazyActionDict so 'content' is computed on demand from 'switches'
            from expert_backend.services.network_service import network_service
            self._dict_action = enrich_actions_lazy(raw_dict_action, network_service.network)
        else:
            logger.info("Action dictionary already loaded, skipping reload.")

        # Inject missing config parameter and redirect output
        config.DO_VISUALIZATION = getattr(settings, 'do_visualization', True)
        # Don't check all actions
        config.CHECK_ACTION_SIMULATION = False

        # Set visualization output to local 'Overflow_Graph' directory in backend/
        # uvicorn runs from root, so 'Overflow_Graph' in CWD
        config.SAVE_FOLDER_VISUALIZATION = Path(os.getcwd()) / "Overflow_Graph"
        if not config.SAVE_FOLDER_VISUALIZATION.exists():
            config.SAVE_FOLDER_VISUALIZATION.mkdir(parents=True, exist_ok=True)

        # Switch the overflow-graph output from PDF to the interactive HTML
        # viewer shipped in expert_op4grid_recommender. The "Overflow
        # Analysis" tab in the React UI renders it via <iframe>. Legacy
        # sessions that still carry a .pdf on disk continue to load — see
        # the /api/load-session glob in main.py.
        config.VISUALIZATION_FORMAT = "html"
        logger.info("Overflow visualization format: %s", config.VISUALIZATION_FORMAT)

        # Disable the combined-action-pair simulation verification
        # (`VERIFY_SUPERPOSITION_MAX_RHO` upstream). When enabled, every
        # superposition pair is also simulated end-to-end just to log the
        # estimated-vs-simulated max-rho gap — it roughly doubles the
        # Step-2 runtime and is only useful when validating the
        # superposition approximation offline. Guarded with hasattr so
        # older recommender installs (before commit 1f980169) stay happy.
        if hasattr(config, "VERIFY_SUPERPOSITION_MAX_RHO"):
            config.VERIFY_SUPERPOSITION_MAX_RHO = False

        # (base-NAD prefetch was kicked off earlier — right after the
        # monitoring config block — so it has more parallel runtime with
        # the enrich + env-setup work below. See docstring above in
        # `update_config` for the rationale.)

        # Pre-build SimulationEnvironment so run_analysis_step1 can reuse it
        # (avoids ~4s network load + AC/DC LF + ~3.8s detect_non_reconnectable_lines on every call)
        #
        # We inject the already-loaded pypowsybl Network (`self._base_network`,
        # pre-warmed above by `prefetch_base_nad_async`) so the upstream
        # helper skips its own `pp.network.load()` call — saves ~1-5 s of
        # duplicate XML parse on large grids. Requires
        # expert_op4grid_recommender >= 0.2.0.post1 (the `network=` kwarg).
        # See docs/performance/history/grid2op-shared-network.md.
        try:
            from expert_op4grid_recommender.environment_pypowsybl import setup_environment_configs_pypowsybl
            # `skip_initial_obs=True`: we discard `_obs` below anyway, and
            # `_cached_env_context` does not store it. Upstream's
            # `env.get_obs()` call on large grids is ~3-5 s of pypowsybl
            # reads that we simply waste. When `run_analysis_step1` later
            # needs an observation, it calls `env.get_obs()` itself.
            # Requires expert_op4grid_recommender >= 0.2.0.post3.
            # See docs/performance/history/skip-initial-obs.md.
            env, _obs, env_path, chronic_name, custom_layout, _raw_dict, lines_non_reconnectable, lines_we_care_about = \
                setup_environment_configs_pypowsybl(
                    network=self._base_network,
                    skip_initial_obs=True,
                )
            self._cached_env_context = {
                'env': env,
                'path_chronic': env_path,
                'chronic_name': chronic_name,
                'custom_layout': custom_layout,
                'lines_non_reconnectable': lines_non_reconnectable,
                'lines_we_care_about': lines_we_care_about,
            }
            logger.info("[RecommenderService] SimulationEnvironment pre-built and cached.")
        except Exception as e:
            logger.warning(f"[RecommenderService] Warning: Failed to pre-build SimulationEnvironment: {e}")
            self._cached_env_context = None

    def _run_ac_with_fallback(self, network, params):
        import pypowsybl.loadflow as lf

        # Raise OpenLoadFlow's outer-loop iteration cap on the diagram / overload
        # path. create_olf_rte_parameter() (make_env_utils) inherits the stock
        # maxOuterLoopIterations=20; on the full French grid the
        # IncrementalTransformerVoltageControl outer loop needs ~40-50 iterations
        # to settle after a contingency, so slow-mode AC otherwise returns
        # MAX_ITERATION_REACHED / null flows (reproduced on P.SAOL31RONCI). Mirror
        # the lib analysis-path default of 100 (lib
        # docs/architecture/simulation-pipeline.md §3.6; see
        # docs/architecture/ronci-beon-reproducibility.md).
        provider = dict(params.provider_parameters)
        provider["maxOuterLoopIterations"] = "100"
        params.provider_parameters = provider

        is_fast_mode = getattr(config, 'PYPOWSYBL_FAST_MODE', False)
        if is_fast_mode:
            fast_params = lf.Parameters.from_json(params.to_json())
            fast_params.transformer_voltage_control_on = False
            fast_params.shunt_compensator_voltage_control_on = False
            try:
                results = lf.run_ac(network, parameters=fast_params)
                if results and results[0].status == lf.ComponentStatus.CONVERGED:
                    return results
            except Exception as e:
                logger.warning(f"Warning: Fast mode AC load flow failed ({e}). Retrying in slow mode...")
                
        return lf.run_ac(network, parameters=params)

    def _get_base_network(self):
        """Return the base pypowsybl network, caching it on the service.

        **Mutualises `network_service.network`** when it is available, so the
        same .xiidm file is not re-parsed twice by pypowsybl. On large grids
        the XML parse alone is ~3-5 s — previously we paid it twice because
        `network_service` and `recommender_service` each called
        `pp.network.load()` on the same path.

        Sharing is safe:
          - `network_service` only READS the network (get_lines,
            get_voltage_levels, …), never switches variants.
          - `recommender_service` switches variants inside
            `_get_n_variant` / `_get_n1_variant` but always restores the
            original variant in a try/finally, so `network_service` reads
            see a consistent state.

        Falls back to `pp.network.load(config.ENV_PATH)` when
        `network_service.network` is None — preserves the behaviour for
        unit tests that construct a `RecommenderService` directly without
        going through `/api/config`.
        """
        if self._base_network is not None:
            return self._base_network

        # Prefer the Network instance already loaded by network_service.
        # See docstring for the safety argument.
        try:
            from expert_backend.services.network_service import network_service
            if network_service.network is not None:
                n = network_service.network
                # Convenience method not in pypowsybl API: return line IDs as a list.
                # Idempotent: re-attaching on an already-monkey-patched network
                # is a no-op since it's the same lambda shape.
                n.get_line_ids = lambda: n.get_lines().index.tolist()
                self._base_network = n
                # PST tap snapshot must still run (recommender-specific state).
                self._capture_initial_pst_taps(n)
                return self._base_network
        except Exception as e:
            # Fall through to the standalone load — don't let a network_service
            # import error break the recommender's own path.
            logger.warning(f"[_get_base_network] network_service unavailable, loading standalone: {e}")

        import pypowsybl as pp

        network_file = config.ENV_PATH
        if network_file.is_dir():
            files = [f for f in network_file.iterdir() if f.suffix.lower() in ['.xiidm', '.iidm', '.xml']]
            if files:
                network_file = files[0]
            else:
                # Also check in grid/ subfolder
                grid_folder = network_file / "grid"
                if grid_folder.is_dir():
                    files = [f for f in grid_folder.iterdir() if f.suffix.lower() in ['.xiidm', '.iidm', '.xml']]
                    if files:
                        network_file = files[0]

        if not network_file.exists():
            raise FileNotFoundError(f"Network file not found: {network_file}")

        n = pp.network.load(str(network_file))
        # Convenience method not in pypowsybl API: return line IDs as a list
        n.get_line_ids = lambda: n.get_lines().index.tolist()
        self._base_network = n

        # Capture N-state PST tap positions immediately after loading (before any simulation)
        self._capture_initial_pst_taps(n)

        return self._base_network

    def _capture_initial_pst_taps(self, network) -> None:
        """Snapshot all PST tap positions from the freshly-loaded network.

        Called once at network load time so the values are guaranteed to be
        the original N-state taps, unaffected by any subsequent simulation.
        """
        import pandas as pd
        self._initial_pst_taps = {}
        try:
            ptc = network.get_phase_tap_changers()
            if ptc is not None and not ptc.empty:
                for pst_name, row in ptc.iterrows():
                    self._initial_pst_taps[pst_name] = {
                        "tap": int(row["tap_position"]) if pd.notna(row.get("tap_position")) else 0,
                        "low_tap": int(row["low_tap_position"]) if pd.notna(row.get("low_tap_position")) else None,
                        "high_tap": int(row["high_tap_position"]) if pd.notna(row.get("high_tap_position")) else None,
                    }
                logger.info(f"[_capture_initial_pst_taps] Captured {len(self._initial_pst_taps)} PST tap positions")
        except Exception as e:
            logger.warning(f"[_capture_initial_pst_taps] Warning: could not read phase tap changers: {e}")

    def _get_n_variant(self):
        """Return the variant ID for the N state, creating and simulating it if necessary."""
        n = self._get_base_network()
        variant_id = "N_state_cached"
        if variant_id not in n.get_variant_ids():
            original_variant = n.get_working_variant_id()
            n.clone_variant(original_variant, variant_id)
            # Use try/finally so an exception during the AC load flow cannot
            # leave the shared Network stuck on `variant_id` — the base
            # Network is now shared with `network_service` and grid2op's
            # backend (see docs/performance/history/grid2op-shared-network.md) so leaving
            # it on an unexpected variant would silently corrupt reads
            # from those consumers.
            try:
                n.set_working_variant(variant_id)
                params = create_olf_rte_parameter()
                self._run_ac_with_fallback(n, params)
            finally:
                n.set_working_variant(original_variant)
        return variant_id

    def _apply_contingency_element(self, n, contingency: str) -> bool:
        """Disconnect ``contingency`` (a line or 2-winding transformer) on
        the current working variant of ``n``.

        ``pypowsybl.network.disconnect()`` silently returns ``False``
        (without raising) when the equipment's terminals don't expose
        the disconnectors the high-level API expects — which happens on
        small test grids and some RTE xiidm exports. Simply catching
        exceptions therefore misses the failure and leaves the
        contingency variant identical to N, which then looks like "no
        overloads anywhere" on the diagram even though the analysis
        pipeline correctly finds them (it uses grid2op, which
        disconnects at the line level, not at the pypowsybl switch
        level).

        Fall back to ``update_lines`` / ``update_2_windings_transformers``
        with ``connected1=False, connected2=False`` — that directly sets
        the terminal connection flags regardless of the breaker model.
        Returns True when the line is effectively disconnected after the
        call, False when both paths failed (logged as a warning).
        """
        try:
            ok = n.disconnect(contingency)
        except Exception as e:
            logger.warning("n.disconnect(%s) raised: %s", contingency, e)
            ok = False
        if ok:
            return True
        # Fall back to direct terminal-connection updates. We try lines
        # first (most common case) and only fall back to transformers
        # if the update reports no match.
        is_line = contingency in n.get_lines().index
        is_tfo = (not is_line) and contingency in n.get_2_windings_transformers().index
        try:
            if is_line:
                n.update_lines(id=contingency, connected1=False, connected2=False)
            elif is_tfo:
                n.update_2_windings_transformers(id=contingency, connected1=False, connected2=False)
            else:
                logger.warning(
                    "Cannot disconnect %r: not found as line or 2-winding "
                    "transformer.",
                    contingency,
                )
                return False
            return True
        except Exception as e:
            logger.warning(
                "Fallback update_* failed for %s: %s — contingency variant "
                "will not reflect the disconnection and overload detection "
                "will be wrong.",
                contingency, e,
            )
            return False

    @staticmethod
    def _normalize_contingency_elements(elements) -> list[str]:
        """Coerce caller-supplied contingency input into a clean list.

        Accepts ``None``, a single string (legacy single-element shape
        still used by a few internal call-sites), or any iterable of
        strings. Strips empties and preserves caller order — order
        matters for variant-id stability across calls in a single
        session.
        """
        if elements is None:
            return []
        if isinstance(elements, str):
            return [elements] if elements else []
        out: list[str] = []
        for e in elements:
            if e:
                out.append(str(e))
        return out

    @staticmethod
    def _contingency_variant_id(elements: list[str]) -> str:
        """Build a deterministic variant ID for a (possibly multi-element)
        contingency.  Order-sensitive on purpose so an N-2 with
        ``[A, B]`` and ``[B, A]`` share the same variant cache (we sort).
        """
        if not elements:
            return "contingency_state_none"
        safe = sorted(
            e.replace(" ", "_").replace("-", "_").replace("/", "_")
            for e in elements
        )
        joined = "__".join(safe)
        # Variant IDs end up in pypowsybl logs / error messages so we keep
        # them readable for short contingencies and fall back to a hash
        # only for very long lists (rare, but possible for N-K studies).
        if len(joined) > 120:
            import hashlib
            digest = hashlib.sha1("\x00".join(safe).encode("utf-8")).hexdigest()[:16]
            return f"contingency_state_{len(safe)}elts_{digest}"
        return f"contingency_state_{joined}"

    def _get_contingency_variant(self, elements):
        """Return the variant ID for the contingency state, creating and
        simulating it if necessary.

        ``elements`` may be a single string (legacy) or an iterable of
        element IDs.  Empty / None returns the N variant.

        Always clones from the N state variant (not the current working
        variant) to avoid inheriting modifications from prior action
        simulations.
        """
        norm = self._normalize_contingency_elements(elements)
        if not norm:
            return self._get_n_variant()

        n = self._get_base_network()
        variant_id = self._contingency_variant_id(norm)

        if variant_id not in n.get_variant_ids():
            original_variant = n.get_working_variant_id()
            # Clone from the clean N state — not the working variant, which
            # may have been left on a simulation variant with modified topology.
            n_variant_id = self._get_n_variant()
            n.clone_variant(n_variant_id, variant_id)
            try:
                n.set_working_variant(variant_id)
                for elt in norm:
                    self._apply_contingency_element(n, elt)
                params = create_olf_rte_parameter()
                results = self._run_ac_with_fallback(n, params)
                try:
                    converged = any(r.status.name == 'CONVERGED' for r in results)
                    status_name = results[0].status.name if results else "UNKNOWN"
                    self._lf_status_by_variant[variant_id] = {
                        "converged": converged,
                        "lf_status": status_name,
                    }
                except Exception as e:
                    logger.debug(f"Could not cache LF status for {variant_id}: {e}")
            finally:
                n.set_working_variant(original_variant)
        return variant_id

    # ------------------------------------------------------------------
    # Variant-state guard for analyze/simulate entry points
    # ------------------------------------------------------------------

    def _ensure_n_state_ready(self) -> None:
        """Guarantee the shared pypowsybl Network is positioned on the N
        variant with no background work still touching it.

        Called at the entry of `run_analysis` and `run_analysis_step1`,
        which start from a fresh N state before computing the
        contingency. `simulate_manual_action` and `compute_superposition`
        use `_ensure_n1_state_ready(disconnected_element)` instead —
        they operate on top of an already-known contingency and the
        natural entry state is N-1.

        Steps:

        1. `_drain_pending_base_nad_prefetch()` — joins the NAD worker if
           still alive. After this, no other thread is mutating the Network.
        2. Resolve the N variant (creating it if this is the first call
           post-config) and set it as the working variant on the shared
           Network. Subsequent `env.get_obs()` / pypowsybl reads see the
           N state without races.

        Safe to call multiple times (idempotent) and safe to call before
        `_base_network` is populated — in that case the guard is a no-op
        and the caller's later `_get_base_network()` will raise its own
        clear error.
        """
        self._drain_pending_base_nad_prefetch()
        # If /api/config was never called (e.g. a test that bypasses it,
        # or an HTTP call before the first study is loaded), `_base_network`
        # is None and there is nothing meaningful to guard. Let the caller
        # produce its own error when it actually needs the network.
        if self._base_network is None and getattr(config, 'ENV_PATH', None) is None:
            return
        try:
            n = self._get_base_network()
            n_variant = self._get_n_variant()
            n.set_working_variant(n_variant)
        except Exception as e:
            # Don't swallow the caller's error if the network really isn't
            # loadable — log and let downstream code raise with a clearer
            # message.
            logger.warning(f"[_ensure_n_state_ready] Could not position N variant: {e}")

    def _ensure_contingency_state_ready(self, disconnected_elements) -> None:
        """Guarantee the shared pypowsybl Network is positioned on the
        contingency variant for ``disconnected_elements`` with no
        background work still touching it.

        Called at the entry of `simulate_manual_action` and
        `compute_superposition`, whose natural entry state is the
        contingency state: they simulate actions ON TOP of a
        contingency that is already the subject of the current
        analysis session.

        Same drain-then-position pattern as `_ensure_n_state_ready`,
        just with `_get_contingency_variant(disconnected_elements)` as
        the target.  Creating the variant on a cold cache triggers an
        AC load flow (~2-5 s on large grids) — that's a one-off cost
        amortised across every subsequent action simulation against
        this contingency.
        """
        self._drain_pending_base_nad_prefetch()
        if self._base_network is None and getattr(config, 'ENV_PATH', None) is None:
            return
        norm = self._normalize_contingency_elements(disconnected_elements)
        if not norm:
            # Nothing to position on — simulation endpoints do pass a
            # contingency; an empty list here means the caller
            # skipped the analysis flow entirely. Drain-only, no
            # variant assertion.
            return
        try:
            n = self._get_base_network()
            variant = self._get_contingency_variant(norm)
            n.set_working_variant(variant)
        except Exception as e:
            logger.warning(f"[_ensure_contingency_state_ready] Could not position "
                           f"contingency variant for {norm!r}: {e}")

    def _get_simulation_env(self):
        """Return a SimulationEnvironment instance, caching it."""
        if self._simulation_env is not None:
            return self._simulation_env

        from expert_op4grid_recommender.pypowsybl_backend.simulation_env import SimulationEnvironment
        
        n = self._get_base_network()
        monitoring_factor = getattr(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95)
        
        # Initialize SimulationEnvironment with the pre-loaded network
        self._simulation_env = SimulationEnvironment(
            network=n,
            threshold_thermal_limit=monitoring_factor
        )
        return self._simulation_env

    def _get_monitoring_parameters(self, obs) -> tuple:
        """Get monitoring parameters (lines_we_care_about, branches_with_limits)."""
        # 1. Identify branches with permanent limits in pypowsybl
        try:
            n_grid = obs._network_manager.network
            limits = n_grid.get_operational_limits()
            if not limits.empty:
                # Filter for permanent thermal limits (type=CURRENT, duration=-1)
                perm_limits = limits[(limits['type'] == 'CURRENT') & (limits['acceptable_duration'] == -1)]
                branches_with_limits = set(perm_limits['element_id'].unique())
            else:
                branches_with_limits = set()
        except Exception as e:
            logger.warning(f"Warning: Failed to identify branches with limits: {e}")
            branches_with_limits = set(obs.name_line)

        # 2. Prefer using lines_we_care_about from active analysis context (respects user selection in Suggestions Feed)
        if self._analysis_context and "lines_we_care_about" in self._analysis_context:
            care = self._analysis_context["lines_we_care_about"]
            lines_we_care_about = list(care) if care is not None else list(obs.name_line)
            return lines_we_care_about, branches_with_limits

        # 3. Fallback to global config or full line list
        if not getattr(config, 'IGNORE_LINES_MONITORING', True) and getattr(config, 'LINES_MONITORING_FILE', None):
            try:
                lines_we_care_about = list(load_interesting_lines(file_name=config.LINES_MONITORING_FILE))
            except Exception as e:
                logger.warning(f"Failed to load lines_we_care_about from file: {e}")
                lines_we_care_about = list(obs.name_line)
        else:
            lines_we_care_about = list(obs.name_line)

        return lines_we_care_about, branches_with_limits


recommender_service = RecommenderService()
