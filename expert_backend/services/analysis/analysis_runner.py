# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Legacy single-step analysis runner.

Wraps the original ``run_analysis`` with:
  - AC load flow → DC load-flow fallback on the "Initial contingency
    simulation failed" RuntimeError surfaced by the discovery engine
  - a background worker thread so the caller can poll the output
    folder for the overflow-graph PDF and emit a ``pdf`` NDJSON event
    before the full result lands
  - stdout redirection so library ``print`` diagnostics are captured
    as a string, not leaked to the FastAPI process log

Yields NDJSON-ready dicts ``{"type": "pdf", "pdf_path": ...}`` and
a final ``{"analysis_result": ..., "analysis_message": ...,
"dc_fallback_used": ..., "output": ..., "latest_pdf": ...}``.  The
orchestrator on ``AnalysisMixin`` turns that last dict into the
public ``result`` event after enriching actions and scores.
"""
from __future__ import annotations

import io
import logging
import os
import threading
import time
from contextlib import redirect_stdout
from typing import Any, Callable, Generator

from expert_op4grid_recommender import config
from expert_op4grid_recommender.main import Backend
from expert_op4grid_recommender.main import run_analysis as _default_run_analysis

from expert_backend.services.analysis.pdf_watcher import find_latest_pdf

logger = logging.getLogger(__name__)

# How often the caller polls for PDF availability / thread completion.
_POLL_INTERVAL_S = 0.5

# Hard deadline for the legacy single-step analysis stream (QW22). The
# background AnalysisWorker sets ``shared_state['done']`` when it finishes; if
# it hangs inside ``runner_fn`` and never does, this generator would loop
# forever — the streaming endpoint never closes and the D3 study-mutation gate
# stays claimed, wedging every subsequent study operation behind an HTTP 409.
# On the deadline we raise ``TimeoutError``; the endpoint turns it into a
# ``{type:'error'}`` event and releases the gate in its ``finally``. The
# orphaned worker is a daemon thread, so it can't block interpreter shutdown.
# Env-overridable; 10-minute default (well above the slowest real analysis).
_ANALYSIS_DEADLINE_S = float(os.environ.get("COSTUDY4GRID_ANALYSIS_TIMEOUT_S", "600"))


def _make_worker(
    disconnected_elements,
    shared_state: dict[str, Any],
    runner_fn: Callable,
) -> Callable[[], None]:
    """Return a zero-arg worker that populates ``shared_state``.

    ``disconnected_elements`` may be a single string (legacy single-
    element contingency) or an iterable of element IDs for N-K
    contingencies — both are normalised to a list before forwarding to
    the discovery engine's ``current_lines_defaut`` parameter.

    Returned as a closure (not a bound method) so callers that mock
    ``threading.Thread`` and invoke ``target()`` with no args — the
    pre-extraction shape in legacy tests — keep working.
    """
    if isinstance(disconnected_elements, str):
        elements_list = [disconnected_elements] if disconnected_elements else []
    else:
        elements_list = [e for e in (disconnected_elements or []) if e]

    def worker() -> None:
        try:
            # Attempt 1: AC
            config.USE_DC_LOAD_FLOW = False
            f_stdout = io.StringIO()
            with redirect_stdout(f_stdout):
                res = runner_fn(
                    analysis_date=None,
                    current_timestep=0,
                    current_lines_defaut=list(elements_list),
                    backend=Backend.PYPOWSYBL,
                )
            shared_state["result"] = res
            shared_state["output"] = f_stdout.getvalue()
        except RuntimeError as e:
            if "Initial contingency simulation failed" in str(e):
                try:
                    config.USE_DC_LOAD_FLOW = True
                    shared_state["dc_fallback_used"] = True
                    shared_state["analysis_message"] = (
                        "Warning: AC Load Flow did not converge. "
                        "Fallback to DC Load Flow was used."
                    )
                    f_stdout = io.StringIO()
                    with redirect_stdout(f_stdout):
                        res = runner_fn(
                            analysis_date=None,
                            current_timestep=0,
                            current_lines_defaut=list(elements_list),
                            backend=Backend.PYPOWSYBL,
                        )
                    shared_state["result"] = res
                    shared_state["output"] = f_stdout.getvalue()
                except Exception as inner_e:
                    shared_state["error"] = RuntimeError(
                        f"Analysis failed globally (AC and DC): {inner_e}"
                    )
            else:
                shared_state["error"] = e
        except Exception as e:
            shared_state["error"] = e
        finally:
            shared_state["done"] = True

    return worker


def run_with_pdf_polling(
    disconnected_elements,
    save_folder: str,
    runner_fn: Callable | None = None,
) -> Generator[dict, None, None]:
    """Run the legacy analysis, yielding a ``pdf`` event ASAP then the final payload.

    ``runner_fn`` is the discovery engine's ``run_analysis`` entry point.
    It's injected so callers (the mixin, tests) can plug a mock without
    monkey-patching this module directly. Defaults to
    ``expert_op4grid_recommender.main.run_analysis``.

    Events yielded (first-to-last):
      - ``{"type": "pdf", "pdf_path": "..."}`` — emitted at most once,
        as soon as the overflow PDF lands in ``save_folder``.
      - ``{"_final": True, ...}`` — internal sentinel carrying the
        raw analysis result / output / fallback flag / latest_pdf.
        The orchestrator consumes it and produces the public
        ``result`` NDJSON event after enrichment.
    """
    if runner_fn is None:
        runner_fn = _default_run_analysis
    analysis_start_time = time.time()
    shared_state: dict[str, Any] = {
        "analysis_message": "Analysis completed successfully using AC Load Flow.",
        "dc_fallback_used": False,
        "result": None,
        "output": "",
        "error": None,
        "done": False,
        "latest_pdf": None,
    }

    worker = _make_worker(disconnected_elements, shared_state, runner_fn)
    # daemon=True so a hung worker (see the deadline below) can't block
    # interpreter shutdown after this generator abandons it.
    thread = threading.Thread(target=worker, name="AnalysisWorker", daemon=True)
    thread.start()

    deadline = analysis_start_time + _ANALYSIS_DEADLINE_S
    pdf_sent = False
    while not shared_state["done"]:
        if not pdf_sent:
            latest = find_latest_pdf(save_folder, analysis_start_time)
            if latest:
                shared_state["latest_pdf"] = latest
                yield {"type": "pdf", "pdf_path": str(latest)}
                pdf_sent = True
        if shared_state["error"]:
            raise shared_state["error"]
        if time.time() > deadline:
            raise TimeoutError(
                f"Legacy analysis exceeded its {_ANALYSIS_DEADLINE_S:.0f}s "
                "deadline and was abandoned"
            )
        time.sleep(_POLL_INTERVAL_S)

    if shared_state["error"]:
        raise shared_state["error"]

    # Final PDF check, if the worker finished before the poll loop
    # noticed the file.
    if not pdf_sent:
        latest = find_latest_pdf(save_folder, analysis_start_time)
        if latest:
            shared_state["latest_pdf"] = latest
            yield {"type": "pdf", "pdf_path": str(latest)}

    yield {
        "_final": True,
        "result": shared_state["result"],
        "output": shared_state["output"],
        "analysis_message": shared_state["analysis_message"],
        "dc_fallback_used": shared_state["dc_fallback_used"],
        "latest_pdf": shared_state["latest_pdf"],
    }


def derive_analysis_message(
    analysis_message: str,
    output: str,
    result: Any,
) -> str:
    """Refine the message based on known discovery-output phrases.

    Called by the orchestrator when ``result`` is ``None`` — the library
    prints a diagnostic like "No topological solution without load
    shedding" and the UI needs a user-friendly translation.
    """
    if result is not None:
        return analysis_message
    if "No topological solution without load shedding" in output:
        return (
            "No topological solution found without load shedding. "
            "The grid might be too constrained."
        )
    if "Overload breaks the grid apart" in output:
        return "Grid instability detected: Overload breaks the grid apart."
    return "Analysis finished but no recommendations were found."
