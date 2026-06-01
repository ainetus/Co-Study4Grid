# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Elia Group `ToOp <https://github.com/eliagroup/ToOp>`_ topology optimizer.

ToOp is a Map-Elites topology optimiser: it searches for *whole network
topologies* (combinations of line switching + busbar splits across many
substations) that relieve N-1 congestion. The elementary moves are only
meaningful together — a single split that looks neutral in isolation can
be decisive inside the combined topology ToOp actually optimised.

This integration therefore treats **each ToOp candidate topology as one
combined action**, not as a bag of independent suggestions:

1. Export the live pypowsybl Network to XIIDM (ToOp ingests it directly).
2. Run ToOp's ``run_pipeline`` (preprocessing → DC Map-Elites → AC
   validation). It returns a list of *topology directories*, each with a
   ``modified_network.xiidm`` — the full target network state, best-first.
3. For each topology, diff ``modified_network.xiidm`` against the input
   grid along two axes — line connection flags and per-VL internal switch
   states — and fold **every** change into ONE merged action content
   (``set_bus`` assignments + ``switches`` dict, the same format the
   operator's curated coupling actions use; see
   ``data/action_space/reduced_model_actions_test.json``).
4. Return one merged grid2op action per topology under a clean id
   (``toop_topology_<rank>``). The step-2 assessment phase REALLY
   simulates each, so the resulting ``max_rho`` is the true combined
   loading of the whole topology.
5. ``_service_integration`` then reformats each simulated topology into a
   single combined-action card (the ``combined_actions`` channel) and
   injects the merged contents into the service ``_dict_action`` so the
   card stays re-simulatable / session-saveable.

ToOp is an **optional install** (Python 3.11 + heavy GPU deps). The
class only lazy-imports ``toop_engine_topology_optimizer`` inside
``recommend()``; a missing install yields an empty recommendation with a
clear log line instead of crashing the step-2 NDJSON stream.
"""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from expert_op4grid_recommender.models.base import (
    ParamSpec,
    RecommenderInputs,
    RecommenderModel,
    RecommenderOutput,
)

logger = logging.getLogger(__name__)


# Module-level so a unit test can patch it without monkey-patching the import system.
def _import_run_pipeline() -> Optional[Any]:
    """Lazy importer that returns ToOp's ``run_pipeline`` or ``None``.

    Returning ``None`` (rather than raising) lets :meth:`recommend`
    degrade to an empty output with a single log line — far friendlier
    than crashing the step-2 NDJSON stream when an operator selects
    ToOp on a backend where it isn't installed.
    """
    try:
        from toop_engine_topology_optimizer.benchmark.benchmark_utils import (  # type: ignore[import-not-found]
            run_pipeline,
        )
    except Exception as exc:  # ImportError, but also ModuleNotFoundError, etc.
        logger.warning(
            "ToOpRecommender: toop_engine_topology_optimizer is not importable "
            "from this backend's Python (%s: %s). Install it from "
            "https://github.com/eliagroup/ToOp on a Python 3.11 environment, "
            "in the SAME venv that runs `uvicorn expert_backend.main`.",
            type(exc).__name__, exc,
        )
        return None
    return run_pipeline


def _import_dictconfig() -> Optional[Any]:
    """Lazy importer for omegaconf's ``DictConfig`` (a ToOp transitive dep)."""
    try:
        from omegaconf import DictConfig  # type: ignore[import-not-found]
    except Exception as exc:
        logger.warning(
            "ToOpRecommender: omegaconf not available (%s: %s).",
            type(exc).__name__, exc,
        )
        return None
    return DictConfig


def _import_enrich() -> Optional[Any]:
    """Lazy importer for ``enrich_actions_lazy`` (populates switch-action content)."""
    try:
        from expert_op4grid_recommender.data_loader import enrich_actions_lazy
    except Exception as exc:
        logger.warning(
            "ToOpRecommender: enrich_actions_lazy not importable (%s: %s); "
            "cannot materialise busbar-split content.",
            type(exc).__name__, exc,
        )
        return None
    return enrich_actions_lazy


class ToOpRecommender(RecommenderModel):
    """Topology optimizer wrapper — one combined action per candidate topology.

    The model does NOT consume the overflow graph — ToOp does its own
    DC contingency analysis internally, so we set
    ``requires_overflow_graph = False`` and let the operator opt in via
    the Settings → Recommender toggle if they still want the graph
    rendered alongside.
    """

    name = "toop"
    label = "ToOp (Elia Group)"
    requires_overflow_graph = False

    @classmethod
    def params_spec(cls) -> List[ParamSpec]:
        return [
            ParamSpec(
                "n_prioritized_actions",
                "N Candidate Topologies",
                "int",
                default=5,
                min=1,
                max=50,
                description=(
                    "Maximum number of ToOp candidate topologies surfaced "
                    "as combined-action cards (best-first by ToOp's rank)."
                ),
            ),
            ParamSpec(
                "include_busbar_splits",
                "Include Busbar Splits",
                "bool",
                default=True,
                description=(
                    "Fold ToOp's internal substation switch changes into "
                    "each topology. Disable to keep only line-switching "
                    "changes in the combined action."
                ),
            ),
            ParamSpec(
                "runtime_seconds",
                "ToOp Runtime Budget (s)",
                "int",
                default=15,
                min=5,
                max=120,
                description=(
                    "Wall-clock budget passed to ToOp's DC optimization "
                    "stage. Higher = better topology coverage but blocks "
                    "the step-2 stream that long."
                ),
            ),
            ParamSpec(
                "n_worst_contingencies",
                "Contingencies Considered",
                "int",
                default=2,
                min=1,
                max=20,
                description=(
                    "Number of worst-N-1 contingencies ToOp evaluates "
                    "when scoring each topology candidate. Ignored when "
                    "`optimize_current_state_only` is enabled."
                ),
            ),
            ParamSpec(
                "optimize_current_state_only",
                "Optimize Current State Only",
                "bool",
                default=True,
                description=(
                    "Score topologies on the operator-selected contingency "
                    "state only (ToOp's N-0). Ignore the secondary N-1 "
                    "outages ToOp would otherwise explore from that state "
                    "— those are N-2 cases from the operator's viewpoint. "
                    "Disable to also weigh subsequent contingencies."
                ),
            ),
        ]

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------
    def recommend(self, inputs: RecommenderInputs, params: dict) -> RecommenderOutput:
        # Cleared up-front so a degraded return never leaves a stale
        # grouping behind for the service integration to consume.
        self._last_topology_groups: List[dict] = []
        self._last_topology_dict_entries: Dict[str, Any] = {}

        logger.warning(
            "ToOpRecommender: recommend() entry — params=%s, env=%s, network=%s, "
            "dict_action_size=%s",
            params,
            type(inputs.env).__name__ if inputs.env is not None else None,
            type(inputs.network).__name__ if inputs.network is not None else None,
            len(inputs.dict_action or {}),
        )
        run_pipeline = _import_run_pipeline()
        if run_pipeline is None:
            logger.warning(
                "ToOpRecommender: aborting because ToOp is not importable in this venv."
            )
            return RecommenderOutput(prioritized_actions={}, action_scores={})

        DictConfig = _import_dictconfig()
        if DictConfig is None:
            logger.warning("ToOpRecommender: aborting because omegaconf is not importable.")
            return RecommenderOutput(prioritized_actions={}, action_scores={})

        n = int(params.get("n_prioritized_actions", 5))
        runtime_seconds = int(params.get("runtime_seconds", 15))
        n_worst = int(params.get("n_worst_contingencies", 2))
        include_busbar_splits = bool(params.get("include_busbar_splits", True))
        current_state_only = bool(params.get("optimize_current_state_only", True))

        env = inputs.env
        if env is None:
            logger.warning("ToOpRecommender: inputs.env is None — returning {}.")
            return RecommenderOutput(prioritized_actions={}, action_scores={})

        with tempfile.TemporaryDirectory(prefix="toop_") as tmp:
            tmp_path = Path(tmp)
            iteration_dir = tmp_path / "iter"
            iteration_dir.mkdir(parents=True, exist_ok=True)
            logger.warning(
                "ToOpRecommender: exporting pypowsybl network to XIIDM under %s",
                iteration_dir,
            )
            # Export the POST-CONTINGENCY state, not the healthy N state.
            # ``inputs.network_defaut`` is documented as the same network
            # with the contingency variant active; we prefer it and then
            # explicitly re-assert the contingency by disconnecting
            # ``inputs.lines_defaut`` on the exported copy. This guarantees
            # ToOp's N-0 == the operator-selected N-1 even if the working
            # variant wasn't positioned — otherwise overload_energy_n_0 is
            # 0.0 (no overload to optimise) and the GA returns 0 topologies.
            export_source = inputs.network_defaut
            if export_source is None:
                export_source = inputs.network
            contingency_lines = list(inputs.lines_defaut or [])
            grid_file = self._export_network(
                export_source, iteration_dir, contingency_lines=contingency_lines
            )
            if grid_file is None:
                logger.warning("ToOpRecommender: network export returned None — aborting.")
                return RecommenderOutput(prioritized_actions={}, action_scores={})

            logger.warning(
                "ToOpRecommender: calling run_pipeline (runtime_seconds=%d, "
                "n_worst_contingencies=%d, current_state_only=%s) on %s",
                runtime_seconds, n_worst, current_state_only, grid_file,
            )
            try:
                pareto = self._run_toop(
                    run_pipeline=run_pipeline,
                    DictConfig=DictConfig,
                    grid_file=grid_file,
                    work_dir=tmp_path,
                    runtime_seconds=runtime_seconds,
                    n_worst_contingencies=n_worst,
                    current_state_only=current_state_only,
                )
            except Exception:
                logger.exception("ToOpRecommender: run_pipeline failed; returning {}.")
                return RecommenderOutput(prioritized_actions={}, action_scores={})

            # `run_pipeline` returns ``topology_paths`` — a list of
            # *directories* (``<snapshot_dir>/run_*/topology_*``), each
            # holding the full target ``modified_network.xiidm``, best-first.
            topology_list = pareto if isinstance(pareto, (list, tuple)) else []
            logger.warning(
                "ToOpRecommender: run_pipeline returned %d topology path(s); "
                "building one combined action per topology.",
                len(topology_list),
            )
            # Built inside the tempdir so the modified_network.xiidm files
            # are still on disk while we diff them.
            prioritized, scores, groups, dict_entries = self._build_topology_actions(
                topology_paths=topology_list,
                original_grid_file=grid_file,
                env=env,
                network=inputs.network,
                include_busbar_splits=include_busbar_splits,
                n=n,
            )

        # Stash the topology groupings + synthesised dict_action entries so
        # the model-aware step-2 integration can (a) inject the combined
        # contents into the service's _dict_action for re-simulation /
        # session save, and (b) reformat each topology into a single
        # combined-action card after the assessment phase has simulated it.
        self._last_topology_groups = groups
        self._last_topology_dict_entries = dict_entries

        logger.warning(
            "ToOpRecommender: returning %d topology action(s): %s",
            len(prioritized), list(prioritized.keys()),
        )
        # The library's reassessment (``propagate_non_convergence_to_scores``)
        # and the service's ``_compute_mw_start_for_scores`` both expect the
        # category-keyed score shape
        # ``{category: {"scores": {action_id: float}, "params": {}}}`` — the
        # same shape the Expert model returns. ``_build_topology_actions``
        # yields a flat ``{topology_id: float}``; wrap it in a single
        # "toop_topology" bucket so the downstream pipeline stops treating a
        # bare float as a dict (``AttributeError: 'float' object has no
        # attribute 'get'``). The "toop_topology" tag classifies as "other",
        # so MW-at-start is left undefined (None) rather than mis-computed.
        return RecommenderOutput(
            prioritized_actions=prioritized,
            action_scores=self._nest_scores(scores),
        )

    @staticmethod
    def _nest_scores(flat_scores: Dict[str, float]) -> Dict[str, Dict[str, Any]]:
        """Wrap a flat ``{action_id: score}`` map in the category-keyed shape.

        The reassessment pipeline and ``_compute_mw_start_for_scores`` both
        require ``{category: {"scores": {action_id: float}, "params": {}}}``
        (the Expert-model contract). Topology actions all live in a single
        "toop_topology" bucket. Returns ``{}`` for an empty input so the
        degraded path stays empty rather than carrying an empty bucket.
        """
        if not flat_scores:
            return {}
        return {"toop_topology": {"scores": dict(flat_scores), "params": {}}}

    # ------------------------------------------------------------------
    # Network export + ToOp invocation
    # ------------------------------------------------------------------
    def _export_network(
        self,
        network: Any,
        iteration_dir: Path,
        contingency_lines: Optional[List[str]] = None,
    ) -> Optional[Path]:
        """Save the live pypowsybl Network as XIIDM under ``iteration_dir``.

        ToOp's example notebooks consume XIIDM directly (``grid.xiidm``);
        no CGMES round-trip is necessary. Returns the absolute path of
        the saved file, or ``None`` on failure. The directory is
        already created by the caller.

        When ``contingency_lines`` is supplied, those branches are
        disconnected on the exported copy so the grid handed to ToOp is
        the operator-selected N-K state (ToOp's N-0). This is idempotent:
        if the exported network was already post-contingency the flips
        are no-ops.

        After saving, the file's CURRENT thermal limits are deflated by
        Co-Study4Grid's ``MONITORING_FACTOR_THERMAL_LIMITS`` so ToOp's
        overload-detection threshold (raw ρ ≥ 1.0) lines up with the
        operator's effective threshold (ρ ≥ monitoring_factor). The
        deflation is applied to a re-loaded copy — the live network the
        rest of the backend uses is left untouched.
        """
        if network is None:
            logger.warning("ToOpRecommender: inputs.network is None — cannot export.")
            return None
        out = iteration_dir / "grid.xiidm"
        try:
            # pypowsybl Network exposes either ``save`` (newer API) or
            # ``dump`` (older).
            if hasattr(network, "save"):
                network.save(str(out), format="XIIDM")
            elif hasattr(network, "dump"):
                network.dump(str(out), format="XIIDM")
            else:
                logger.warning("ToOpRecommender: pypowsybl Network has no save()/dump() method.")
                return None
        except Exception:
            logger.exception("ToOpRecommender: XIIDM export failed.")
            return None
        if not out.exists():
            # Some pypowsybl builds add the extension themselves or write
            # multiple files. Look for the first plausible match.
            for ext in (".xiidm", ".iidm", ".xml"):
                hits = list(iteration_dir.glob(f"*{ext}"))
                if hits:
                    out = hits[0]
                    break
            else:
                logger.warning(
                    "ToOpRecommender: XIIDM export produced no file under %s",
                    iteration_dir,
                )
                return None

        if contingency_lines:
            self._apply_contingency_state(out, contingency_lines)
        self._deflate_thermal_limits(out)
        return out

    def _apply_contingency_state(self, grid_file: Path, lines: List[str]) -> None:
        """Disconnect ``lines`` in ``grid_file`` to bake in the N-K state.

        Re-opens the exported XIIDM and disconnects both terminals of
        each contingency element so ToOp's base case (its N-0) matches
        the operator-selected contingency. Handles lines and 2-winding
        transformers; ids it cannot resolve are logged and skipped so a
        single stale name doesn't abort the whole export. Operates on the
        on-disk copy only — the live backend network is never mutated.
        """
        try:
            import pypowsybl.network as _pn
        except Exception:
            logger.exception(
                "ToOpRecommender: pypowsybl import failed; cannot apply contingency "
                "state — ToOp will run against the base (N) grid."
            )
            return

        try:
            net = _pn.load(str(grid_file))
        except Exception:
            logger.exception(
                "ToOpRecommender: failed to reload %s to apply contingency state.",
                grid_file,
            )
            return

        try:
            line_ids = set(net.get_lines().index)
        except Exception:
            line_ids = set()
        try:
            twt_ids = set(net.get_2_windings_transformers().index)
        except Exception:
            twt_ids = set()

        applied = 0
        missing: List[str] = []
        for elem in lines:
            try:
                if elem in line_ids:
                    net.update_lines(id=elem, connected1=False, connected2=False)
                    applied += 1
                elif elem in twt_ids:
                    net.update_2_windings_transformers(
                        id=elem, connected1=False, connected2=False
                    )
                    applied += 1
                else:
                    missing.append(elem)
            except Exception:
                logger.exception(
                    "ToOpRecommender: failed to disconnect contingency element %s.",
                    elem,
                )
                missing.append(elem)

        if missing:
            logger.warning(
                "ToOpRecommender: could not resolve %d contingency element(s) in the "
                "exported grid: %s", len(missing), missing,
            )
        if applied:
            try:
                net.save(str(grid_file), format="XIIDM")
            except Exception:
                logger.exception(
                    "ToOpRecommender: failed to save contingency state to %s.",
                    grid_file,
                )
                return
            logger.warning(
                "ToOpRecommender: applied operator contingency (%d element(s)) to the "
                "exported grid so ToOp optimises the N-K state.", applied,
            )

    def _deflate_thermal_limits(self, grid_file: Path) -> None:
        """Multiply CURRENT thermal limits in ``grid_file`` by the monitoring factor.

        Aligns ToOp's overload threshold with Co-Study4Grid's effective
        one: a line at ρ_raw = 0.97 with `monitoring_factor=0.95` becomes
        ρ_toop = 0.97 / 0.95 ≈ 1.02 in the exported grid, so ToOp's GA
        treats it as overloaded just like the operator's overload panel
        does. Skips work when the factor is ≥ 1.0 (no deflation needed),
        when the upstream library isn't importable, or when the network
        has no operational limits.
        """
        try:
            from expert_op4grid_recommender import config as _config
        except Exception as exc:
            logger.debug(
                "ToOpRecommender: expert_op4grid_recommender.config not importable "
                "(%s: %s); skipping thermal-limit deflation.",
                type(exc).__name__, exc,
            )
            return

        factor = float(getattr(_config, "MONITORING_FACTOR_THERMAL_LIMITS", 1.0) or 1.0)
        if factor >= 1.0 or factor <= 0.0:
            return

        try:
            import pypowsybl.network as _pn
        except Exception:
            logger.exception("ToOpRecommender: pypowsybl import failed; skipping deflation.")
            return

        try:
            net = _pn.load(str(grid_file))
            limits = net.get_operational_limits().reset_index()
        except Exception:
            logger.exception(
                "ToOpRecommender: failed to read operational limits from %s — "
                "ToOp will run against raw thermal limits.",
                grid_file,
            )
            return

        current_limits = limits[limits["type"] == "CURRENT"]
        if current_limits.empty:
            return

        # pypowsybl's update_operational_limits is strict about the
        # element_id / side / type / group_name columns being plain
        # strings — after reset_index() they come back as ``object``
        # dtype and `create_dataframe` rejects them. Pass via kwargs
        # with explicit list[str] coercion to bypass the dtype check.
        try:
            net.update_operational_limits(
                element_id=[str(v) for v in current_limits["element_id"]],
                side=[str(v) for v in current_limits["side"]],
                type=[str(v) for v in current_limits["type"]],
                acceptable_duration=[int(v) for v in current_limits["acceptable_duration"]],
                group_name=[str(v) for v in current_limits["group_name"]],
                value=[float(v) * factor for v in current_limits["value"]],
            )
            net.save(str(grid_file), format="XIIDM")
        except Exception:
            logger.exception(
                "ToOpRecommender: failed to deflate thermal limits in %s; "
                "ToOp will run against raw limits.",
                grid_file,
            )
            return

        logger.warning(
            "ToOpRecommender: deflated %d CURRENT thermal limits by factor %.3f "
            "to align ToOp's overload detection with Co-Study4Grid's monitoring factor.",
            len(current_limits), factor,
        )

    def _run_toop(
        self,
        run_pipeline: Any,
        DictConfig: Any,
        grid_file: Path,
        work_dir: Path,
        runtime_seconds: int,
        n_worst_contingencies: int,
        current_state_only: bool = True,
    ) -> Any:
        """Invoke ToOp's ``run_pipeline`` against an XIIDM grid file.

        Mirrors the structure of ``notebooks/example2_small_grid_toop.ipynb``.
        The Map Elites diversity axis is ``disconnected_branches`` so the
        search spreads candidates over the number of branches each
        topology opens; busbar splits emerge from the same search and are
        folded into the per-topology action downstream.
        """
        # Lazy imports — these symbols only exist when ToOp is installed.
        from toop_engine_topology_optimizer.benchmark.benchmark_utils import (
            PipelineConfig,
            PreprocessParameters,
            get_paths,
            prepare_importer_parameters,
        )

        iteration_name = grid_file.parent.name  # e.g. "iter"
        pipeline_cfg = PipelineConfig(
            root_path=work_dir,
            iteration_name=iteration_name,
            file_name=grid_file.name,
            grid_type="powsybl",
        )
        # `get_paths` validates the grid file exists, creates the
        # optimizer-snapshot directory, and returns the resolved sub-paths
        # we plug into the rest of the configs.
        iteration_path, file_path, data_folder, _snapshot_dir = get_paths(pipeline_cfg)
        results_dir = iteration_path / "results"
        results_dir.mkdir(parents=True, exist_ok=True)

        # Preprocessing writes ``static_information.hdf5`` under
        # ``data_folder``; the DC-optimisation stage reads it back via
        # ``fixed_files``. The path must be supplied even though the
        # file doesn't exist yet at config-build time — ToOp's
        # preprocessing creates it before the optimiser runs.
        static_info_file = data_folder / pipeline_cfg.static_info_relpath

        dc_optimization_cfg = DictConfig({
            "task_name": "costudy4grid",
            "fixed_files": [str(static_info_file)],
            "double_precision": None,
            "tensorboard_dir": str(results_dir / "{task_name}"),
            "stats_dir": str(results_dir / "{task_name}"),
            "summary_frequency": None,
            "checkpoint_frequency": None,
            "stdout": None,
            "double_limits": None,
            "num_cuda_devices": 1,
            "omp_num_threads": 1,
            "xla_force_host_platform_device_count": None,
            "output_json": str(results_dir / "output.json"),
            # `max_num_disconnections` defaults to 0 in ToOp's
            # LoadflowSolverParameters, which disables the line-switching
            # search entirely — without this override every solution is
            # forced to be a busbar split (out of MVP scope). Allow up
            # to 4 simultaneous disconnections so `best_topos[i].disconnections`
            # is populated for the parser below to consume.
            "lf_config": {"distributed": False, "max_num_disconnections": 4},
            "ga_config": {
                "runtime_seconds": runtime_seconds,
                # `disconnected_branches` is ToOp's accepted metric name
                # for the count of opened branches in a topology (the enum
                # is pinned in BatchedMEParameters; a wrong name fails with
                # a pydantic ValidationError).
                "me_descriptors": [{"metric": "disconnected_branches", "num_cells": 4}],
                # The grid we hand ToOp is already the operator-selected
                # contingency state — ToOp's N-0. When the operator wants
                # to optimise that state only (no further N-1 from it,
                # which would be N-2 from their viewpoint), target the
                # n_0 overload metric and clamp n_worst_contingencies
                # to the BatchedMEParameters minimum (it stays positive
                # but stops driving the score).
                "target_metrics": [
                    [
                        "overload_energy_n_0" if current_state_only else "overload_energy_n_1",
                        1.0,
                    ],
                ],
                "observed_metrics": (
                    ["overload_energy_n_0", "disconnected_branches"]
                    if current_state_only
                    else ["overload_energy_n_1", "disconnected_branches"]
                ),
                "n_worst_contingencies": 1 if current_state_only else n_worst_contingencies,
            },
        })
        ac_validation_cfg = DictConfig({
            "n_processes": 1,
            "k_best_topos": 5,
        })
        importer_parameters = prepare_importer_parameters(file_path, data_folder)
        preprocessing_parameters = PreprocessParameters(
            action_set_clip=1024,
            enable_bb_outage=False,
            bb_outage_as_nminus1=False,
        )
        return run_pipeline(
            pipeline_cfg=pipeline_cfg,
            dc_optim_config=dc_optimization_cfg,
            ac_validation_cfg=ac_validation_cfg,
            importer_parameters=importer_parameters,
            preprocessing_parameters=preprocessing_parameters,
        )

    # ------------------------------------------------------------------
    # Per-topology combined-action construction
    # ------------------------------------------------------------------
    def _build_topology_actions(
        self,
        topology_paths: List[Any],
        original_grid_file: Path,
        env: Any,
        network: Any,
        include_busbar_splits: bool,
        n: int,
    ) -> Tuple[Dict[str, Any], Dict[str, float], List[dict], Dict[str, Any]]:
        """Build one combined grid2op action per ToOp topology.

        Each topology directory holds a ``modified_network.xiidm`` — the
        full target state. We diff it against the input grid along two
        axes (line connection flags + per-VL internal switch states) and
        fold every change into ONE merged action content + one grid2op
        action object. Simulated as a whole by the assessment phase, that
        single object yields the *true* combined ``max_rho`` ToOp
        optimised — not the misleading effect of its parts in isolation.

        Returns ``(prioritized, scores, groups, dict_entries)``:

        - ``prioritized``  ``{topology_id: action_object}``
        - ``scores``       ``{topology_id: -rank}`` (UI sorts higher-first)
        - ``groups``       ``[{topology_id, constituents, rank,
          line_count, switch_vls}]`` — consumed by the service
          integration to build the combined-action card.
        - ``dict_entries`` ``{topology_id: {content, switches, …}}`` —
          injected into the service ``_dict_action`` for re-simulation.
        """
        import pypowsybl.network as pn

        try:
            original = pn.load(str(original_grid_file))
            orig_lines = original.get_lines()
            orig_switches = original.get_switches()
        except Exception:
            logger.exception(
                "ToOpRecommender: cannot reload original grid %s for diff.",
                original_grid_file,
            )
            return {}, {}, [], {}

        orig_line_open = {lid: _is_line_open(orig_lines, lid) for lid in orig_lines.index}
        has_switch_cols = (
            "open" in orig_switches.columns and "voltage_level_id" in orig_switches.columns
        )
        orig_sw_open: Dict[str, bool] = {}
        orig_sw_vl: Dict[str, str] = {}
        if has_switch_cols:
            for sid in orig_switches.index:
                try:
                    orig_sw_open[sid] = bool(orig_switches.at[sid, "open"])
                    orig_sw_vl[sid] = str(orig_switches.at[sid, "voltage_level_id"])
                except Exception:
                    continue
        elif include_busbar_splits:
            logger.warning(
                "ToOpRecommender: get_switches() lacks open/voltage_level_id "
                "columns (have %s); busbar splits will be omitted.",
                list(orig_switches.columns),
            )

        enrich = _import_enrich()

        prioritized: Dict[str, Any] = {}
        scores: Dict[str, float] = {}
        groups: List[dict] = []
        dict_entries: Dict[str, Any] = {}

        for rank, topo in enumerate(topology_paths or []):
            if len(prioritized) >= n:
                break
            topo_dir = Path(topo) if not isinstance(topo, Path) else topo
            modified = topo_dir / "modified_network.xiidm"
            if not modified.exists():
                logger.warning("ToOpRecommender: no modified_network.xiidm under %s", topo_dir)
                continue
            try:
                mod_net = pn.load(str(modified))
                mod_lines = mod_net.get_lines()
                mod_switches = mod_net.get_switches() if has_switch_cols else None
            except Exception:
                logger.exception("ToOpRecommender: cannot load %s for diff.", modified)
                continue

            # --- line toggles ---
            line_toggles: Dict[str, int] = {}
            for lid in mod_lines.index:
                if lid not in orig_line_open:
                    continue
                new_open = _is_line_open(mod_lines, lid)
                if new_open != orig_line_open[lid]:
                    line_toggles[lid] = -1 if new_open else 1

            # --- switch toggles grouped by VL (busbar splits) ---
            vl_switches: Dict[str, Dict[str, bool]] = {}
            if include_busbar_splits and mod_switches is not None:
                for sid in mod_switches.index:
                    if sid not in orig_sw_open:
                        continue
                    try:
                        new_open = bool(mod_switches.at[sid, "open"])
                    except Exception:
                        continue
                    if new_open == orig_sw_open[sid]:
                        continue
                    vl = orig_sw_vl.get(sid)
                    if not vl:
                        continue
                    key = sid if sid.startswith(f"{vl}_") else f"{vl}_{sid}"
                    vl_switches.setdefault(vl, {})[key] = new_open

            if not line_toggles and not vl_switches:
                logger.warning(
                    "ToOpRecommender: topology #%d (%s) differs by 0 lines / "
                    "0 switches; skipping.",
                    rank + 1, topo_dir.name,
                )
                continue

            merged, constituents = self._merge_topology_content(
                line_toggles=line_toggles,
                vl_switches=vl_switches,
                enrich=enrich,
                network=network,
            )
            if merged is None:
                logger.warning(
                    "ToOpRecommender: topology #%d produced no simulable content; skipping.",
                    rank + 1,
                )
                continue
            try:
                action_obj = env.action_space(merged)
            except Exception as e:
                logger.warning(
                    "ToOpRecommender: topology #%d rejected by env.action_space: %s",
                    rank + 1, e,
                )
                continue

            topology_id = f"toop_topology_{rank + 1}"
            description = f"ToOp topology #{rank + 1}: " + "; ".join(constituents)
            prioritized[topology_id] = action_obj
            scores[topology_id] = -float(rank)
            groups.append({
                "topology_id": topology_id,
                "constituents": constituents,
                "rank": rank,
                "line_count": len(line_toggles),
                "switch_vls": sorted(vl_switches.keys()),
            })
            # Flatten all VL switch dicts into one for the dict_action entry.
            flat_switches = {k: v for sw in vl_switches.values() for k, v in sw.items()}
            dict_entries[topology_id] = {
                "description": description,
                "description_unitaire": description,
                "VoltageLevelId": (sorted(vl_switches.keys())[0] if vl_switches else None),
                "switches": flat_switches,
                "content": merged,
            }
            logger.warning(
                "ToOpRecommender: topology #%d → %s (%d line toggle(s), %d VL split(s))",
                rank + 1, topology_id, len(line_toggles), len(vl_switches),
            )

        return prioritized, scores, groups, dict_entries

    def _merge_topology_content(
        self,
        line_toggles: Dict[str, int],
        vl_switches: Dict[str, Dict[str, bool]],
        enrich: Optional[Any],
        network: Any,
    ) -> Tuple[Optional[Dict[str, Any]], List[str]]:
        """Fold line toggles + per-VL switch flips into one action content.

        The busbar splits are enriched per-VL via ``enrich_actions_lazy``
        (which reads the live network to resolve each switch set into
        per-connectable ``set_bus`` assignments), then unioned into one
        merged ``set_bus`` / ``switches`` payload. Line toggles are
        applied last so an explicit open/close wins over a split's bus
        assignment for the same branch.

        Returns ``(merged_content, constituents)``. ``merged_content`` is
        ``None`` when nothing simulable could be built (every VL failed to
        enrich and there were no line toggles). ``constituents`` is the
        human-readable label list for the combined-action card.
        """
        merged: Dict[str, Any] = {
            "set_bus": {
                "lines_or_id": {}, "lines_ex_id": {},
                "loads_id": {}, "generators_id": {}, "shunts_id": {},
            },
            "switches": {},
        }
        constituents: List[str] = []

        if vl_switches and enrich is not None:
            # Match the action-entry shape `enrich_actions_lazy` saw when the
            # earlier per-VL synthesis worked end-to-end on the same grid:
            # `description` + `description_unitaire` populated, and the
            # action-id pattern uses the `toop_split_<vl>` prefix the library
            # already recognises (a leading underscore + free-form id caused
            # silent enrichment failure — no content was attached).
            raw = {
                f"toop_split_{vl_id}": {
                    "description": (
                        f"ToOp: substation reconfiguration at '{vl_id}' "
                        f"({len(switches)} switch operation(s))"
                    ),
                    "description_unitaire": f"ToOp split at {vl_id}",
                    "VoltageLevelId": vl_id,
                    "switches": dict(switches),
                    "content": None,
                }
                for vl_id, switches in vl_switches.items()
            }
            try:
                enriched = enrich(raw, network)
            except Exception:
                logger.exception(
                    "ToOpRecommender: enrich_actions_lazy failed during topology merge."
                )
                enriched = {}
            for vl_id in vl_switches:
                key = f"toop_split_{vl_id}"
                entry = _resolve_lazy_entry(enriched, key)
                content = _resolve_lazy_content(entry)
                if not content:
                    # enrich_actions_lazy could not resolve this VL's
                    # switch set into per-connectable set_bus assignments
                    # (e.g. the live network lacks the node-breaker detail
                    # the resolver needs). Rather than drop the split —
                    # which silently shrinks the topology and, when every
                    # VL fails, yields a 0-action result — fall back to the
                    # raw switch flips ToOp itself produced. They are still
                    # simulable: the action toggles the named switches even
                    # without the resolved bus assignments.
                    raw_switches = vl_switches[vl_id]
                    if raw_switches:
                        merged["switches"].update(raw_switches)
                        constituents.append(f"split {vl_id}")
                        logger.warning(
                            "ToOpRecommender: could not enrich VL %s split (%d switch(es); "
                            "entry=%s, content=%s); falling back to raw switch flips.",
                            vl_id, len(raw_switches),
                            type(entry).__name__ if entry is not None else None,
                            type(content).__name__ if content is not None else None,
                        )
                    else:
                        logger.warning(
                            "ToOpRecommender: VL %s split has no switches to "
                            "synthesise; excluded from this topology.", vl_id,
                        )
                    continue
                set_bus = content.get("set_bus", {}) if isinstance(content, dict) else {}
                for sub_key in ("lines_or_id", "lines_ex_id", "loads_id",
                                "generators_id", "shunts_id"):
                    sub = set_bus.get(sub_key)
                    if isinstance(sub, dict):
                        merged["set_bus"][sub_key].update(sub)
                sw = content.get("switches", {}) if isinstance(content, dict) else {}
                if isinstance(sw, dict):
                    merged["switches"].update(sw)
                constituents.append(f"split {vl_id}")
        elif vl_switches and enrich is None:
            # No enricher available — synthesise directly from the raw
            # switch flips so the busbar splits still surface (matches the
            # pre-rewrite behaviour) instead of being silently omitted.
            logger.warning(
                "ToOpRecommender: enrich unavailable — synthesising %d busbar "
                "split(s) from raw switch flips.", len(vl_switches),
            )
            for vl_id, switches in vl_switches.items():
                if switches:
                    merged["switches"].update(switches)
                    constituents.append(f"split {vl_id}")

        for line_id, status in line_toggles.items():
            merged["set_bus"]["lines_or_id"][line_id] = status
            merged["set_bus"]["lines_ex_id"][line_id] = status
            constituents.append(("open " if status == -1 else "close ") + line_id)

        if not constituents:
            return None, []
        return merged, constituents


# ---------------------------------------------------------------------
# Module-level helpers — kept module-level so tests can swap them out.
# ---------------------------------------------------------------------
def _resolve_lazy_entry(enriched: Any, key: str) -> Any:
    """Return ``enriched[key]`` regardless of whether enriched is a plain dict
    or a ``LazyActionDict`` proxy.

    ``enrich_actions_lazy`` returns a proxy in production: ``.get(key)`` may
    return ``None`` for keys whose entries haven't been touched yet, while
    ``proxy[key]`` triggers the lazy resolution. We try both, in that order.
    """
    if enriched is None:
        return None
    if hasattr(enriched, "get"):
        try:
            entry = enriched.get(key)
            if entry is not None:
                return entry
        except Exception:
            pass
    try:
        return enriched[key]
    except Exception:
        return None


def _resolve_lazy_content(entry: Any) -> Optional[Dict[str, Any]]:
    """Read ``entry["content"]`` regardless of whether entry is a dict or proxy.

    LazyActionDict wraps its entries so ``isinstance(entry, dict)`` is False
    even though they behave like one. We try mapping access AND attribute
    access AND finally fall back to ``.get`` — whichever first returns a
    populated dict-like value with the keys we need.
    """
    if entry is None:
        return None
    candidates = []
    try:
        candidates.append(entry["content"])
    except Exception:
        pass
    if hasattr(entry, "get"):
        try:
            candidates.append(entry.get("content"))
        except Exception:
            pass
    if hasattr(entry, "content"):
        candidates.append(getattr(entry, "content"))
    for c in candidates:
        if c and (isinstance(c, dict) or hasattr(c, "get")):
            return c if isinstance(c, dict) else None
    return None


def _is_line_open(lines_df: Any, line_id: str) -> bool:
    """Return True when at least one terminal of the line is disconnected.

    pypowsybl exposes per-terminal ``connected1`` / ``connected2``
    booleans on its lines DataFrame. A line is "open" (in operator
    terms) when *either* terminal is disconnected. Older pypowsybl
    builds used different column names — fall back conservatively to
    ``connected`` or treat the line as closed when columns are missing so
    a schema change doesn't silently flag every line as toggled.
    """
    for col_pair in (("connected1", "connected2"), ("connected",)):
        if all(c in lines_df.columns for c in col_pair):
            for c in col_pair:
                try:
                    if not bool(lines_df.at[line_id, c]):
                        return True
                except KeyError:
                    return False
            return False
    return False
