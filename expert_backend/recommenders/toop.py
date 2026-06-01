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
                    "when scoring each topology candidate."
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
            grid_file = self._export_network(inputs.network, iteration_dir)
            if grid_file is None:
                logger.warning("ToOpRecommender: network export returned None — aborting.")
                return RecommenderOutput(prioritized_actions={}, action_scores={})

            logger.warning(
                "ToOpRecommender: calling run_pipeline (runtime_seconds=%d, "
                "n_worst_contingencies=%d) on %s",
                runtime_seconds, n_worst, grid_file,
            )
            try:
                pareto = self._run_toop(
                    run_pipeline=run_pipeline,
                    DictConfig=DictConfig,
                    grid_file=grid_file,
                    work_dir=tmp_path,
                    runtime_seconds=runtime_seconds,
                    n_worst_contingencies=n_worst,
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
        return RecommenderOutput(
            prioritized_actions=prioritized,
            action_scores=scores,
        )

    # ------------------------------------------------------------------
    # Network export + ToOp invocation
    # ------------------------------------------------------------------
    def _export_network(self, network: Any, iteration_dir: Path) -> Optional[Path]:
        """Save the live pypowsybl Network as XIIDM under ``iteration_dir``.

        ToOp's example notebooks consume XIIDM directly (``grid.xiidm``);
        no CGMES round-trip is necessary. Returns the absolute path of
        the saved file, or ``None`` on failure. The directory is
        already created by the caller.
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
                    return hits[0]
            logger.warning(
                "ToOpRecommender: XIIDM export produced no file under %s",
                iteration_dir,
            )
            return None
        return out

    def _run_toop(
        self,
        run_pipeline: Any,
        DictConfig: Any,
        grid_file: Path,
        work_dir: Path,
        runtime_seconds: int,
        n_worst_contingencies: int,
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
            "lf_config": {"distributed": False},
            "ga_config": {
                "runtime_seconds": runtime_seconds,
                # `disconnected_branches` is ToOp's accepted metric name
                # for the count of opened branches in a topology (the enum
                # is pinned in BatchedMEParameters; a wrong name fails with
                # a pydantic ValidationError).
                "me_descriptors": [{"metric": "disconnected_branches", "num_cells": 4}],
                "observed_metrics": ["overload_energy_n_1", "disconnected_branches"],
                "n_worst_contingencies": n_worst_contingencies,
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
                    logger.warning(
                        "ToOpRecommender: could not enrich VL %s split (%d switch(es); "
                        "entry=%s, content=%s); excluded from this topology.",
                        vl_id, len(vl_switches[vl_id]),
                        type(entry).__name__ if entry is not None else None,
                        type(content).__name__ if content is not None else None,
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
            logger.warning(
                "ToOpRecommender: enrich unavailable — %d busbar split(s) omitted "
                "from this topology.", len(vl_switches),
            )

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
