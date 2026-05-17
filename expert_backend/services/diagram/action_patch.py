# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Action-variant diagram patch (``/api/action-variant-diagram-patch``)
payload builder and the helpers it depends on.

Extracted from ``diagram_mixin.py`` so that orchestrator file stays
under the function-LoC ceiling guarded by the code-quality gate. The
public entry point is :func:`build_action_patch_payload`; the mixin
keeps a thin ``get_action_variant_diagram_patch`` wrapper that
delegates here.

Three smaller helpers are also exposed because:
* :func:`compute_vl_topology_diff` and
  :func:`get_disconnected_branches_from_snapshot` are pure and have
  dedicated unit tests in ``tests/test_diagram_patch_helpers.py``
  (we keep static-method wrappers on the mixin for backward compat).
* :func:`extract_vl_subtrees_with_edges` is reused by the action-side
  rendering pipeline and takes ``generate_diagram`` as a callable so
  the mixin's NAD-generation seam stays the single source of truth.

Snapshot discipline: the orchestrator captures every action-variant
attribute frame BEFORE switching the shared pypowsybl Network to the
contingency variant — see the long block comment in
``build_action_patch_payload``. ``action_network`` and the
``cont_network`` we pull from ``service._get_base_network()`` may
share the same singleton handle, so reading "live" data after a
variant switch would poison the diff.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

from expert_backend.services.sanitize import sanitize_for_json

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Pure helpers — kept as free functions (unit-tested directly).
# ---------------------------------------------------------------------

def compute_vl_topology_diff(action_buses_snap, n1_network):
    """Return the list of voltage-level IDs whose bus count differs
    between the action-variant snapshot and the CURRENTLY-active N-1
    variant on ``n1_network``.

    An empty list means the action introduces no VL-node rendering
    change (pure line-breaker toggle or flow-only action); the patch
    path can skip VL-subtree generation entirely.

    ``None`` means we could not compute the diff reliably (snapshot
    missing or pypowsybl query raised) — caller should be conservative
    and fall back to the full NAD.

    Why bus counts per VL:
    - pypowsybl NAD renders each VL as a concentric multi-circle node
      whose ring count equals the number of electrical buses in that VL.
    - Node-merging / node-splitting / coupling toggles flip the bus
      count; disco_* / reco_* do not.

    Same snapshot discipline as elsewhere: ``action_network`` and
    ``n1_network`` share the underlying pypowsybl Network handle
    (singleton), so the action side must be captured BEFORE the working
    variant is switched to N-1.
    """
    if action_buses_snap is None:
        return None
    try:
        n1_buses = n1_network.get_buses(attributes=['voltage_level_id'])
        a_counts = action_buses_snap.groupby('voltage_level_id').size()
        n_counts = n1_buses.groupby('voltage_level_id').size()
        all_vls = set(a_counts.index) | set(n_counts.index)
        diff: list = []
        for vl in all_vls:
            a = int(a_counts.get(vl, 0))
            n = int(n_counts.get(vl, 0))
            if a != n:
                diff.append(vl)
        return diff
    except Exception as e:
        logger.debug(f"Bus count comparison failed: {e}")
        return None


def get_disconnected_branches_from_snapshot(action_lines_conn_snap, action_trafos_conn_snap):
    """Return branch IDs (lines + 2-winding transformers) that are
    disconnected in the action variant, using pre-captured connectivity
    snapshots.

    A branch is considered disconnected when either terminal is not
    connected (``connected1 AND connected2`` is False). The set
    includes:
    - the original N-1 contingency (still disconnected post-action),
    - any additional branches opened by a ``disco_*`` action,
    and EXCLUDES branches that the action reconnects (those had the
    dashed marker in N-1; ``applyPatchToClone.resetPriorPatch`` strips
    it, and since they are not in this list the patch does not re-apply
    the dashed class — they render solid again).
    """
    disconnected: list = []
    for df in (action_lines_conn_snap, action_trafos_conn_snap):
        if df is None:
            continue
        try:
            if len(df.index) == 0:
                continue
            c1 = df['connected1'].astype(bool).values
            c2 = df['connected2'].astype(bool).values
            mask = ~(c1 & c2)
            disconnected.extend(df.index[mask].tolist())
        except Exception as e:
            logger.debug(f"Disconnected-branch snapshot failed: {e}")
    return disconnected


def extract_vl_subtrees_with_edges(
    action_network: Any,
    vl_ids,
    *,
    generate_diagram: Callable[..., dict],
) -> dict:
    """Generate focused NADs for each target VL and return:
      - the ``<g id="nad-vl-{target}">`` subtree (new concentric
        multi-circle bus layout), and
      - the ``<g id="nad-l-{line}">`` / ``<g id="nad-t-{trafo}">``
        subtrees of every branch terminating at that VL (so the
        branch's piercing geometry at the target end matches the new
        bus count).

    Output shape (per VL)::

        {
          "node_svg":   "<g id=\"nad-vl-...\">...</g>",
          "node_sub_svg_id": "nad-vl-0",                   # sub-diagram id
          "edge_fragments": {
              "LINE_A": {"svg": "<g id=\"nad-l-...\">...</g>",
                         "sub_svg_id": "nad-l-3"},
              ...
          }
        }

    The sub-diagram svgIds are exported so the frontend can rewrite
    them to the main diagram's svgIds before splicing — pypowsybl emits
    positional svgIds (``nad-vl-0``, ``nad-l-3``, …) within a given
    diagram, so the numeric indices differ between the sub-diagram and
    the main NAD.

    Uses ``depth=1`` so the focused sub-diagram includes the neighbor
    VLs and the inter-VL edges; only the TARGET VL node and the edges
    terminating at it are returned — neighbor VL nodes and
    neighbor-to-neighbor edges are discarded.

    Failures are swallowed per-VL; caller falls back to the full NAD
    when extraction returns fewer subtrees than requested.

    Precondition: ``action_network`` must be on its action variant.
    ``generate_diagram`` is the service's NAD-generation seam injected
    here so the helper stays test-friendly without depending on the
    mixin instance.
    """
    from lxml import etree

    result: dict = {}
    if not vl_ids:
        return result

    for vl_id in vl_ids:
        try:
            sub = generate_diagram(action_network, voltage_level_ids=[vl_id], depth=1)
            svg = sub.get("svg") or ""
            meta_raw = sub.get("metadata")
            if not svg or not meta_raw:
                continue

            meta = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
            nodes = meta.get("nodes") or meta.get("busNodes") or []
            edges = meta.get("edges") or []

            # Target VL's sub-diagram svgId.
            node_sub_svg_id = None
            for n in nodes:
                if n.get("equipmentId") == vl_id:
                    node_sub_svg_id = n.get("svgId")
                    break
            if not node_sub_svg_id:
                node_sub_svg_id = f"nad-vl-{vl_id}"

            # Edges terminating at the target VL: match by metadata
            # node references. pypowsybl edges carry ``node1`` /
            # ``node2`` (sub-diagram svgIds) and ``equipmentId`` (the
            # line / transformer id).
            edge_entries: list = []
            for e in edges:
                eq_id = e.get("equipmentId")
                e_svg_id = e.get("svgId")
                node1 = e.get("node1")
                node2 = e.get("node2")
                if not eq_id or not e_svg_id:
                    continue
                if node1 == node_sub_svg_id or node2 == node_sub_svg_id:
                    edge_entries.append((eq_id, e_svg_id))

            parser = etree.XMLParser(recover=True, huge_tree=True)
            root = etree.fromstring(svg.encode("utf-8"), parser=parser)
            if root is None:
                continue

            # Pull the VL node subtree.
            vl_matches = root.xpath("//*[@id=$id]", id=node_sub_svg_id)
            if not vl_matches:
                continue
            node_svg_str = etree.tostring(vl_matches[0], encoding="unicode", method="xml")

            # Pull every affected edge subtree.
            edge_fragments: dict = {}
            for eq_id, e_svg_id in edge_entries:
                matches = root.xpath("//*[@id=$id]", id=e_svg_id)
                if not matches:
                    continue
                edge_fragments[eq_id] = {
                    "svg": etree.tostring(matches[0], encoding="unicode", method="xml"),
                    "sub_svg_id": e_svg_id,
                }

            result[vl_id] = {
                "node_svg": node_svg_str,
                "node_sub_svg_id": node_sub_svg_id,
                "edge_fragments": edge_fragments,
            }
        except Exception as e:
            logger.debug(f"[extract_vl_subtrees_with_edges] vl={vl_id} failed: {e}")
    return result


# ---------------------------------------------------------------------
# Orchestrator helpers — kept private to the module so the public
# entry point ``build_action_patch_payload`` stays under the
# function-LoC ceiling guarded by the code-quality gate. Each helper
# owns one slice of the pipeline and is exercised end-to-end through
# the orchestrator's integration coverage.
# ---------------------------------------------------------------------

def _extract_convergence_status(obs: Any) -> tuple:
    """Return ``(lf_converged, lf_status, non_convergence)`` from a
    cached post-action observation. Tolerant of a missing
    ``_last_info`` (treats it as converged) so the caller can route
    the value into the patch payload without further None-checks."""
    info_action = getattr(obs, '_last_info', {})
    sim_exception = info_action.get("exception")
    lf_converged = not bool(sim_exception)
    non_convergence = None
    if sim_exception:
        if isinstance(sim_exception, list):
            non_convergence = "; ".join([str(e) for e in sim_exception])
        else:
            non_convergence = str(sim_exception)
    lf_status = non_convergence if non_convergence else "CONVERGED"
    return lf_converged, lf_status, non_convergence


def _capture_action_snapshots(service: Any, action_network: Any) -> dict:
    """Take every action-variant attribute frame we need to diff
    against the contingency state. Must run BEFORE the shared
    pypowsybl Network is switched to the contingency variant — see
    the long block comment in ``build_action_patch_payload``.

    Returns a dict with five keys (``lines_conn``, ``trafos_conn``,
    ``buses``, ``flows``, ``assets``); each entry is ``None`` when its
    underlying pypowsybl query raised (logged at DEBUG).
    """
    def _safe(label: str, fn):
        try:
            return fn()
        except Exception as e:
            logger.debug(f"[action_patch] {label} snapshot failed: {e}")
            return None

    return {
        "lines_conn": _safe(
            "line-conn",
            lambda: action_network.get_lines(attributes=['connected1', 'connected2']).copy(),
        ),
        "trafos_conn": _safe(
            "trafo-conn",
            lambda: action_network.get_2_windings_transformers(
                attributes=['connected1', 'connected2'],
            ).copy(),
        ),
        "buses": _safe(
            "bus",
            lambda: action_network.get_buses(attributes=['voltage_level_id']).copy(),
        ),
        # Flows / asset balances are extracted via the service helpers
        # which return plain dicts — variant-independent once taken.
        "flows": _safe("flow", lambda: service._get_network_flows(action_network)),
        "assets": _safe("asset", lambda: service._get_asset_flows(action_network)),
    }


def _unpatchable_response(action_id: str, lf_converged: bool, lf_status: str,
                          non_convergence) -> dict:
    """Build the standard ``patchable=False`` payload for any
    fallback-to-full-NAD branch in the orchestrator."""
    return sanitize_for_json({
        "patchable": False,
        "reason": "vl_topology_changed",
        "action_id": action_id,
        "lf_converged": lf_converged,
        "lf_status": lf_status,
        "non_convergence": non_convergence,
    })


# ---------------------------------------------------------------------
# Orchestrator — takes the service so it can read the dozen-odd
# collaborators it needs (network, variant helpers, flow extractors,
# overload classifier, delta math, etc.) without exploding the
# argument list. The mixin owns those methods; we just consume them.
# ---------------------------------------------------------------------

def build_action_patch_payload(service: Any, action_id: str) -> dict:
    """Compute the action-variant patch payload (SVG-less) for ``action_id``.

    Detects topology-changing actions first and returns
    ``{patchable: False, reason: ...}`` so the frontend falls back to
    ``/api/action-variant-diagram``. Otherwise computes the same
    flow-delta / overload payload as ``get_action_variant_diagram``
    without the ~2-4 s NAD regeneration.

    See ``docs/performance/history/svg-dom-recycling.md`` for the
    higher-level design (PR #108).
    """
    t_start = time.time()

    # When the action isn't in the backend's last result — after a
    # session reload, or for any manually-added action — there is no
    # cached observation to diff. Soft-fail with ``patchable: False``
    # (the contract the frontend already handles) instead of raising a
    # 400: the frontend falls through to the full NAD and then to
    # ``/api/simulate-and-variant-diagram``. Soft-failing keeps this
    # expected path off the backend error log entirely.
    if not service._last_result or not service._last_result.get("prioritized_actions"):
        return sanitize_for_json({
            "patchable": False,
            "reason": "no-analysis-result",
            "action_id": action_id,
        })

    actions = service._last_result["prioritized_actions"]
    if action_id not in actions:
        return sanitize_for_json({
            "patchable": False,
            "reason": "action-not-in-last-result",
            "action_id": action_id,
        })

    obs = actions[action_id]["observation"]
    variant_id = obs._variant_id
    nm = obs._network_manager
    nm.set_working_variant(variant_id)
    action_network = nm.network

    lf_converged, lf_status, non_convergence = _extract_convergence_status(obs)

    # Snapshot every action-variant attribute frame BEFORE switching
    # the shared pypowsybl Network to the contingency variant —
    # ``action_network`` and ``cont_network`` may be the SAME object
    # (singleton, see expert_backend/CLAUDE.md "Singletons & shared
    # state"). Reading "live" data after a switch would poison the
    # diff and return ``patchable: True`` for genuinely unpatchable
    # actions (node-merging, coupling opens, …).
    snaps = _capture_action_snapshots(service, action_network)

    # Set up the contingency variant on the base network for topology
    # comparison AND reference flows.
    cont_network = service._get_base_network()
    original_variant_cont = cont_network.get_working_variant_id()
    cont_variant_id = service._get_contingency_variant(service._last_disconnected_elements)
    cont_network.set_working_variant(cont_variant_id)

    try:
        # Step 1: compute the VL-level bus-count diff between the
        # action variant and the currently-active contingency variant.
        # ``None`` means we could not compute it reliably (snapshot
        # missing / pypowsybl query raised) — be conservative and fall
        # back to the full NAD.
        vl_diff = compute_vl_topology_diff(snaps["buses"], cont_network)
        if vl_diff is None:
            logger.info(
                f"[RECO] Action '{action_id}' is not patchable "
                f"(vl_topology_changed; could not compute bus diff); "
                f"frontend will fall back to full NAD."
            )
            return _unpatchable_response(action_id, lf_converged, lf_status, non_convergence)

        # Step 1b: if any VL has a bus-count change, generate a
        # focused NAD on the ACTION variant for each affected VL and
        # extract the ``<g id="nad-vl-*">`` subtree. The client splices
        # these into the cloned base diagram, avoiding the full NAD
        # re-render. Any extraction failure triggers a graceful
        # full-NAD fallback — correctness before speed.
        vl_subtrees: dict = {}
        if vl_diff:
            try:
                nm.set_working_variant(variant_id)
                vl_subtrees = extract_vl_subtrees_with_edges(
                    action_network, vl_diff,
                    generate_diagram=service._generate_diagram,
                )
                # Re-activate the contingency variant for the
                # subsequent reference-flow computation (currently
                # served from snapshots, so the re-activation is only
                # needed for the overload scan further down — which
                # also re-pins the action variant explicitly).
                cont_network.set_working_variant(cont_variant_id)
            except Exception as e:
                logger.warning(
                    f"[RECO] Action '{action_id}' VL-subtree extraction "
                    f"failed ({e}); frontend will fall back to full NAD."
                )
                return _unpatchable_response(action_id, lf_converged, lf_status, non_convergence)
            if len(vl_subtrees) != len(vl_diff):
                # Partial extraction — safer to fall back than to
                # render a half-updated VL topology.
                logger.info(
                    f"[RECO] Action '{action_id}' VL-subtree extraction "
                    f"incomplete ({len(vl_subtrees)}/{len(vl_diff)}); "
                    f"frontend will fall back to full NAD."
                )
                return _unpatchable_response(action_id, lf_converged, lf_status, non_convergence)

        # Step 2: build the patch payload (same shape as N-1 patch, but
        # base_state is N-1 and deltas are vs N-1).
        payload = {
            "patchable": True,
            "action_id": action_id,
            "lf_converged": lf_converged,
            "lf_status": lf_status,
            "non_convergence": non_convergence,
            # Every branch that is currently disconnected in the action
            # variant (original N-1 contingency + any disco_* action +
            # excludes any reco_* reconnections). The svgPatch will
            # render these as dashed on the action tab, matching how
            # the N-1 tab renders them.
            "disconnected_edges": get_disconnected_branches_from_snapshot(
                snaps["lines_conn"], snaps["trafos_conn"],
            ),
            # Per-VL node subtrees to splice into the cloned base
            # diagram when bus counts changed (node-merging /
            # node-splitting / coupling toggles). Empty dict for
            # actions that only toggle line breakers or flows. Each
            # entry carries the pypowsybl-native
            # ``<g id="nad-vl-*">`` subtree rendered against the same
            # ``fixed_positions`` as the main NAD, so the splice is
            # geometrically correct.
            "vl_subtrees": vl_subtrees,
        }

        try:
            # Use the action-variant snapshots captured before the N-1
            # variant switch. Reading live from ``action_network`` here
            # would return N-1 data (same singleton handle).
            action_flows = snaps["flows"] or {
                "p1": {}, "p2": {}, "q1": {}, "q2": {}, "vl1": {}, "vl2": {},
            }
            action_assets = snaps["assets"] or {}

            # Contingency flows + assets (reference for deltas).
            cont_flows = service._get_network_flows(cont_network)
            cont_assets = service._get_asset_flows(cont_network)

            deltas = service._compute_deltas(action_flows, cont_flows)
            payload["absolute_flows"] = {
                "p1": action_flows["p1"],
                "p2": action_flows["p2"],
                "q1": action_flows["q1"],
                "q2": action_flows["q2"],
                "vl1": action_flows["vl1"],
                "vl2": action_flows["vl2"],
            }
            payload["flow_deltas"] = deltas["flow_deltas"]
            payload["reactive_flow_deltas"] = deltas["reactive_flow_deltas"]
            payload["asset_deltas"] = service._compute_asset_deltas(action_assets, cont_assets)
        except Exception as e:
            logger.warning(f"Warning: Failed to compute action patch flow deltas: {e}")
            payload["absolute_flows"] = {}
            payload["flow_deltas"] = {}
            payload["reactive_flow_deltas"] = {}
            payload["asset_deltas"] = {}

        # Overloads on the action variant. Filter against N-state to
        # exclude pre-existing ones (same convention as
        # get_contingency_diagram). Re-activate action variant for the
        # scan since we were measuring flows on both variants.
        try:
            cont_network.set_working_variant(original_variant_cont)
        except Exception as e:
            logger.debug(f"contingency variant restore pre-overload scan failed: {e}")
        try:
            nm.set_working_variant(variant_id)
            n_state_currents = getattr(service, '_n_state_currents', None)
            names, rhos = service._get_overloaded_lines(
                action_network,
                n_state_currents=n_state_currents,
                lines_we_care_about=service._get_lines_we_care_about(),
                with_rho=True,
            )
            payload["lines_overloaded"] = names
            payload["lines_overloaded_rho"] = rhos
        except Exception as e:
            logger.warning(f"Warning: Failed to compute action patch overloads: {e}")
            payload["lines_overloaded"] = []
            payload["lines_overloaded_rho"] = []

        payload["meta"] = {
            "base_state": "contingency",
            "elapsed_ms": int((time.time() - t_start) * 1000),
        }
        return sanitize_for_json(payload)
    finally:
        try:
            cont_network.set_working_variant(original_variant_cont)
        except Exception as e:
            logger.debug(f"Final contingency variant restore failed: {e}")
