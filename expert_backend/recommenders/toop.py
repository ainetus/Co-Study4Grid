# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Elia Group `ToOp <https://github.com/eliagroup/ToOp>`_ topology optimizer.

MVP scope — **line switching only**. ToOp's broader output set
(busbar splits, busbar reassignments) is not yet translated into
remedial actions; that extension lives downstream once the line-switch
path is exercised on real grids.

ToOp is treated as an **optional install**. The Python package
``toop_engine_topology_optimizer`` pins Python 3.11 and pulls in heavy
GPU dependencies (JAX, qdax, Ray, …), so we never import it at module
load time — the import happens lazily inside :meth:`recommend` and a
missing install is reported as an empty recommendation with a clear
log line rather than a server crash.

Integration outline (see comments in ``recommend`` for details):

1. Export ``inputs.network`` (pypowsybl Network) to a temporary
   CGMES bundle — ToOp's importer pipeline ingests CGMES / UCT, not
   XIIDM.
2. Build the ``DictConfig`` quadruple ToOp's ``run_pipeline`` expects
   (DC optimization + AC validation + importer + preprocessing),
   constrained to line-status edits.
3. Run ``run_pipeline`` synchronously inside the streaming step-2
   endpoint, bounded by ``runtime_seconds``.
4. Parse the Pareto front for line-switching decisions and translate
   each to the Co-Study4Grid action format
   (``{"set_bus": {"lines_or_id": {line: ±1}, "lines_ex_id": {line: ±1}}}``)
   via ``env.action_space``.
5. Rank by ToOp's congestion metric (``overload_energy_n_1``); surface
   the top-N as ``prioritized_actions`` with ``action_scores``.
"""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from expert_op4grid_recommender.models.base import (
    ParamSpec,
    RecommenderInputs,
    RecommenderModel,
    RecommenderOutput,
)

from expert_backend.recommenders.network_existence import (
    filter_to_existing_network_elements,
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


class ToOpRecommender(RecommenderModel):
    """Topology optimizer wrapper. MVP surfaces line-switching only.

    The model does NOT consume the overflow graph — ToOp does its own
    DC contingency analysis internally, so we set
    ``requires_overflow_graph = False`` and let the operator opt in via
    the Settings → Recommender toggle if they still want the graph
    rendered alongside.
    """

    name = "toop"
    label = "ToOp (Elia Group — line switching)"
    requires_overflow_graph = False

    @classmethod
    def params_spec(cls) -> List[ParamSpec]:
        return [
            ParamSpec(
                "n_prioritized_actions",
                "N Prioritized Actions",
                "int",
                default=5,
                min=1,
                max=50,
                description=(
                    "Number of line-switching suggestions surfaced from "
                    "the Pareto front (top-N by congestion reduction)."
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
                    "stage. Higher = better Pareto coverage but blocks "
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

        env = inputs.env
        if env is None:
            logger.warning("ToOpRecommender: inputs.env is None — returning {}.")
            return RecommenderOutput(prioritized_actions={}, action_scores={})

        with tempfile.TemporaryDirectory(prefix="toop_") as tmp:
            tmp_path = Path(tmp)
            logger.warning(
                "ToOpRecommender: exporting pypowsybl network to CGMES under %s",
                tmp_path,
            )
            cgmes_path = self._export_to_cgmes(inputs.network, tmp_path)
            if cgmes_path is None:
                logger.warning("ToOpRecommender: CGMES export returned None — aborting.")
                return RecommenderOutput(prioritized_actions={}, action_scores={})

            logger.warning(
                "ToOpRecommender: calling run_pipeline (runtime_seconds=%d, "
                "n_worst_contingencies=%d) on %s",
                runtime_seconds, n_worst, cgmes_path,
            )
            try:
                pareto = self._run_toop(
                    run_pipeline=run_pipeline,
                    DictConfig=DictConfig,
                    cgmes_path=cgmes_path,
                    work_dir=tmp_path,
                    runtime_seconds=runtime_seconds,
                    n_worst_contingencies=n_worst,
                )
            except Exception:
                logger.exception("ToOpRecommender: run_pipeline failed; returning {}.")
                return RecommenderOutput(prioritized_actions={}, action_scores={})

        logger.warning(
            "ToOpRecommender: run_pipeline returned %s (type=%s)",
            "an iterable" if pareto is not None else "None",
            type(pareto).__name__ if pareto is not None else None,
        )
        switches = self._extract_line_switches(pareto, n=n)
        logger.warning(
            "ToOpRecommender: extracted %d line-switch suggestion(s) from Pareto front",
            len(switches),
        )
        if not switches:
            return RecommenderOutput(prioritized_actions={}, action_scores={})

        prioritized, scores = self._materialise_actions(
            switches=switches,
            env=env,
            dict_action=inputs.dict_action,
            non_connected_reconnectable_lines=inputs.non_connected_reconnectable_lines,
            network=inputs.network,
        )
        logger.warning(
            "ToOpRecommender: returning %d prioritized action(s): %s",
            len(prioritized), list(prioritized.keys()),
        )
        return RecommenderOutput(
            prioritized_actions=prioritized,
            action_scores=scores,
        )

    # ------------------------------------------------------------------
    # Internals (kept as methods so tests can patch them individually)
    # ------------------------------------------------------------------
    def _export_to_cgmes(self, network: Any, work_dir: Path) -> Optional[Path]:
        """Save the live pypowsybl Network to a CGMES bundle in ``work_dir``.

        Returns the bundle path, or ``None`` on failure. pypowsybl's
        CGMES export is best-effort: networks built from XIIDM with
        missing CGMES-required identifiers can fail here. We log the
        error and degrade gracefully — ToOp simply produces no
        suggestions on this grid.
        """
        if network is None:
            logger.warning("ToOpRecommender: inputs.network is None — cannot export to CGMES.")
            return None
        out = work_dir / "grid_cgmes"
        try:
            # pypowsybl Network exposes either ``save`` (newer API) or
            # ``dump`` (older). We try both before giving up.
            if hasattr(network, "save"):
                network.save(str(out), format="CGMES")
            elif hasattr(network, "dump"):
                network.dump(str(out), format="CGMES")
            else:
                logger.warning("ToOpRecommender: pypowsybl Network has no save()/dump() method.")
                return None
        except Exception:
            logger.exception("ToOpRecommender: CGMES export failed.")
            return None
        return out

    def _run_toop(
        self,
        run_pipeline: Any,
        DictConfig: Any,
        cgmes_path: Path,
        work_dir: Path,
        runtime_seconds: int,
        n_worst_contingencies: int,
    ) -> Any:
        """Invoke ToOp's ``run_pipeline`` with a line-switching-only config.

        ``me_descriptors`` is restricted to a single metric so the Map
        Elites search prioritises the line-switching axis; busbar-split
        descriptors are intentionally omitted in this MVP. Returns
        whatever ``run_pipeline`` returns (typically a path or a
        result object) — parsing is the caller's responsibility.
        """
        dc_optimization_cfg = DictConfig({
            "task_name": "costudy4grid",
            "fixed_files": [str(cgmes_path)],
            "runtime_seconds": runtime_seconds,
            "me_descriptors": [{"metric": "branch_switches", "num_cells": 4}],
            "observed_metrics": ["overload_energy_n_1", "branch_switches"],
            "n_worst_contingencies": n_worst_contingencies,
        })
        ac_validation_cfg = DictConfig({
            "enabled": True,
        })
        importer_parameters = DictConfig({
            "input_path": str(cgmes_path),
        })
        preprocessing_parameters = DictConfig({})
        pipeline_cfg = DictConfig({
            "work_dir": str(work_dir),
        })
        return run_pipeline(
            pipeline_cfg=pipeline_cfg,
            dc_optim_config=dc_optimization_cfg,
            ac_validation_cfg=ac_validation_cfg,
            importer_parameters=importer_parameters,
            preprocessing_parameters=preprocessing_parameters,
        )

    def _extract_line_switches(
        self,
        pareto: Any,
        n: int,
    ) -> List[Tuple[str, int, float]]:
        """Pull line-switching decisions out of a ToOp result.

        Returns a list of ``(line_id, target_status, score)`` tuples
        sorted by ``score`` (lower congestion = better, surfaced first).
        ``target_status`` is +1 (close) or -1 (open).

        The exact return shape of ``run_pipeline`` is not nailed down
        by the upstream docs (the example notebooks write results to
        disk via ``topo_path``), so this parser accepts several
        plausible shapes:

        - An iterable of dicts each carrying ``line_switches`` (list of
          ``{"line_id", "status"}`` or ``{"line_id", "open"}``) and a
          numeric score (``overload_energy_n_1`` / ``score`` / ``cost``).
        - An object with a ``.solutions`` attribute holding the same.

        When the shape is unrecognised we log once and return an empty
        list. The frontend then shows an empty action feed and the
        operator can pick a different model — far less disruptive than
        raising mid-stream.
        """
        candidates: Iterable[Any]
        if pareto is None:
            return []
        if hasattr(pareto, "solutions"):
            candidates = pareto.solutions
        elif isinstance(pareto, (list, tuple)):
            candidates = pareto
        elif hasattr(pareto, "__iter__"):
            candidates = pareto
        else:
            logger.warning(
                "ToOpRecommender: unrecognised result shape %r; "
                "extend _extract_line_switches when ToOp's output is finalised.",
                type(pareto).__name__,
            )
            return []

        # Flatten (solution, switch) into a single ranked list so the
        # top-N surfacing is per-switch, not per-solution. Two
        # solutions that both open the same line are deduplicated
        # keeping the better score.
        best_by_key: Dict[Tuple[str, int], float] = {}
        for sol in candidates:
            score = _coerce_score(sol)
            for line_id, target_status in _iter_switches(sol):
                key = (line_id, target_status)
                if key not in best_by_key or score < best_by_key[key]:
                    best_by_key[key] = score

        ranked = sorted(best_by_key.items(), key=lambda kv: kv[1])
        return [(line_id, status, score) for ((line_id, status), score) in ranked[:n]]

    def _materialise_actions(
        self,
        switches: List[Tuple[str, int, float]],
        env: Any,
        dict_action: Optional[Dict[str, Any]],
        non_connected_reconnectable_lines: Optional[Iterable[str]],
        network: Any,
    ) -> Tuple[Dict[str, Any], Dict[str, float]]:
        """Translate ToOp line-switches into ``env.action_space`` actions.

        Prefers an existing ``disco_<line>`` / reconnection entry in the
        operator's action dictionary when one exists (so suggestions
        match the vocabulary the user is already familiar with);
        otherwise synthesises a ``toop_disco_<line>`` /
        ``toop_reco_<line>`` entry on the fly. Actions whose target
        line isn't on the loaded network are filtered out via the same
        defensive guard used by the random recommenders.
        """
        # Network existence filter on the raw line IDs first.
        line_ids = [line_id for (line_id, _, _) in switches]
        synthetic_entries = {
            f"_existence_check_{line_id}": {
                "content": {
                    "set_bus": {
                        "lines_or_id": {line_id: 1},
                        "lines_ex_id": {line_id: 1},
                    }
                }
            }
            for line_id in line_ids
        }
        kept = set(
            filter_to_existing_network_elements(
                list(synthetic_entries.keys()),
                synthetic_entries,
                network,
            )
        )
        # Map back from check-id to line_id.
        kept_lines = {sid.replace("_existence_check_", "", 1) for sid in kept}

        reconnectable = set(non_connected_reconnectable_lines or [])
        prioritized: Dict[str, Any] = {}
        scores: Dict[str, float] = {}

        for line_id, target_status, score in switches:
            if line_id not in kept_lines:
                continue

            action_id, content = self._pick_action_for_switch(
                line_id=line_id,
                target_status=target_status,
                dict_action=dict_action,
                reconnectable=reconnectable,
            )
            try:
                prioritized[action_id] = env.action_space(content)
            except Exception as e:
                logger.debug("ToOpRecommender: action %s rejected by env: %s", action_id, e)
                continue
            # Lower congestion = better in ToOp's metric; surface the
            # negated score so the UI's "higher is better" sort agrees.
            scores[action_id] = -float(score)

        return prioritized, scores

    @staticmethod
    def _pick_action_for_switch(
        line_id: str,
        target_status: int,
        dict_action: Optional[Dict[str, Any]],
        reconnectable: set,
    ) -> Tuple[str, Dict[str, Any]]:
        """Return ``(action_id, content)`` for a single line-switch decision."""
        if target_status == -1:
            preferred_id = f"disco_{line_id}"
            if isinstance(dict_action, dict) and preferred_id in dict_action:
                content = (dict_action[preferred_id] or {}).get("content")
                if content is not None:
                    return preferred_id, content
            # Fallback: synthesise the open-line content.
            return (
                f"toop_disco_{line_id}",
                {
                    "set_bus": {
                        "lines_or_id": {line_id: -1},
                        "lines_ex_id": {line_id: -1},
                    }
                },
            )

        # target_status == +1 → reconnection. Only meaningful when the
        # line is currently disconnected; if it isn't reconnectable the
        # action will be a no-op but we still produce it (ToOp may know
        # something we don't about the live state).
        if line_id in reconnectable:
            preferred_id = f"reco_{line_id}"
            if isinstance(dict_action, dict) and preferred_id in dict_action:
                content = (dict_action[preferred_id] or {}).get("content")
                if content is not None:
                    return preferred_id, content
        return (
            f"toop_reco_{line_id}",
            {
                "set_bus": {
                    "lines_or_id": {line_id: 1},
                    "lines_ex_id": {line_id: 1},
                }
            },
        )


# ---------------------------------------------------------------------
# Tolerant parsers — kept module-level so tests can swap them out.
# ---------------------------------------------------------------------
def _coerce_score(sol: Any) -> float:
    """Pull a numeric congestion score off a ToOp solution-like object.

    Tries the metric names visible in the example notebook
    (``overload_energy_n_1``), then generic fallbacks. Returns
    ``float('inf')`` when nothing recognisable is present so the
    solution sinks to the bottom of the ranking rather than crashing
    the sort.
    """
    for key in ("overload_energy_n_1", "score", "cost", "objective"):
        if isinstance(sol, dict) and key in sol:
            try:
                return float(sol[key])
            except (TypeError, ValueError):
                continue
        if hasattr(sol, key):
            try:
                return float(getattr(sol, key))
            except (TypeError, ValueError):
                continue
    return float("inf")


def _iter_switches(sol: Any) -> Iterable[Tuple[str, int]]:
    """Yield ``(line_id, target_status)`` pairs out of a solution-like object."""
    raw = None
    if isinstance(sol, dict):
        raw = sol.get("line_switches") or sol.get("branch_switches")
    elif hasattr(sol, "line_switches"):
        raw = sol.line_switches
    elif hasattr(sol, "branch_switches"):
        raw = sol.branch_switches
    if not raw:
        return
    for entry in raw:
        line_id = None
        status: Optional[int] = None
        if isinstance(entry, dict):
            line_id = entry.get("line_id") or entry.get("branch_id") or entry.get("id")
            if "status" in entry:
                try:
                    status = int(entry["status"])
                except (TypeError, ValueError):
                    status = None
            elif "open" in entry:
                status = -1 if entry["open"] else 1
            elif "closed" in entry:
                status = 1 if entry["closed"] else -1
        elif isinstance(entry, (list, tuple)) and len(entry) == 2:
            line_id, raw_status = entry
            try:
                status = int(raw_status)
            except (TypeError, ValueError):
                status = None
        if not line_id or status not in (-1, 1):
            continue
        yield (str(line_id), status)
