# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Game Mode solution capitalisation store.

Every remedial-action proposition a player retains (stars) at a Game Mode
study commit is persisted into a **shared JSON base** — one file per unique
proposition per (network, contingency) context — so retained solutions
accumulate across players and sessions. The layout mirrors the manoeuvre
IHM scenario base of ``expert_op4grid_recommender`` (a flat directory of
JSON records under a persistent root, exact-duplicate detection, free-text
author attribution): on a HuggingFace Space, mount persistent storage and
set ``COSTUDY4GRID_DATA_DIR=/data`` so the base survives restarts.

Novelty is judged on **signatures** that deliberately ignore magnitudes:

- an **injection** action (redispatch / load shedding / curtailment / PST)
  contributes its *levers* — ``redispatch:<gen>``, ``ls:<load>``,
  ``rc:<gen>``, ``pst:<pst>`` — with **no MW / tap value**, so novelty
  means *mobilising a new lever*, not retuning a known one;
- an action operating switches contributes per-switch levers
  (``switch:<id>=<state>``) — this covers manual SLD maneuvers AND
  catalogue coupling actions whose payload exposes switches, so the same
  physical maneuver signs identically wherever it came from; injection
  retunes without detail arrays sign ``load_p:<load>`` / ``gen_p:<gen>``;
- an action exposing **no lever at all** (typically catalogue line
  disconnections / reconnections) falls back to its stable catalogue
  identity ``action:<action_id>``.

The *proposition signature* is the sorted union of the unitary signatures
of all retained actions. :func:`log_solution` reports whether the
proposition is completely new (it mobilises at least one never-seen
unitary lever → the big bonus), a new combination of known unitary
actions (small bonus), or already known — in which case the caller gets
the usage frequency of each retained action across the stored base as
end-of-session feedback.

Levers are computed by the frontend (``frontend/src/game/solutionLog.ts``)
from the enriched action payloads it already holds; this module treats
them as opaque strings so the store stays a pure, dependency-free file-IO
layer (no pypowsybl import — trivially testable).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# Serializes every read-classify-write on the store. The endpoint is a sync
# `def` (FastAPI threadpool), so concurrent commits WOULD interleave between
# the read and the write — losing retentions and awarding phantom novelty
# bonuses. A module-level lock is enough: the store is single-process.
_STORE_LOCK = threading.Lock()

SCHEMA_VERSION = "1.0"

# Bonus awarded when the retained proposition mobilises at least one
# never-seen unitary lever ("proposition complètement nouvelle").
BONUS_NEW_LEVER = 20
# Smaller bonus for a new combination of already-known unitary actions.
BONUS_NEW_COMBINATION = 10
# Bonuses are only paid when EVERY retained action is effective — the
# frontend computes each action's ``effective`` flag (it reduces the
# baseline worst loading; a combined action must additionally beat its
# underlying actions' loading by ≥ 1 loading-point, see
# frontend/src/game/solutionLog.ts). Novelty itself is still reported for
# an ineffective proposition — it just earns no points.

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _persist_root() -> str | None:
    """Persistent data root (mirror of the manoeuvre IHM ``MANOEUVRE_DATA_DIR``).

    On the HuggingFace Space: Settings → Persistent storage mounts a volume
    at ``/data``; set ``COSTUDY4GRID_DATA_DIR=/data`` so the shared solution
    base lands on it. Unset → the store falls back to a repo-local folder
    (dev / ephemeral deployments).
    """
    return os.environ.get("COSTUDY4GRID_DATA_DIR") or None


def solutions_dir() -> Path:
    """Root directory of the shared solution base (resolved per call so
    tests can repoint it via the environment)."""
    explicit = os.environ.get("COSTUDY4GRID_GAME_SOLUTIONS_DIR")
    if explicit:
        return Path(explicit).expanduser()
    root = _persist_root()
    if root:
        return Path(root).expanduser() / "game_solutions"
    return _PROJECT_ROOT / "game_solutions"


def _safe_name(name: str, fallback: str = "unnamed") -> str:
    """Filesystem-safe slug (same alphabet as the manoeuvre IHM store —
    path separators collapse to ``_``, so a crafted id cannot escape the
    base directory)."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip()) or fallback


def _network_key(network_path: str) -> str:
    """Discriminating short key for a network file.

    Sample grids all ship a file literally named ``network.xiidm``, so the
    basename alone would collide across grids — include the parent folder
    (the grid id, e.g. ``pypsa_eur_fr225_400``) when there is one.
    """
    p = Path((network_path or "").strip())
    stem = p.name
    for suffix in (".zip", ".bz2", ".gz", ".xiidm", ".iidm", ".xml"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
    parent = p.parent.name
    return f"{parent}_{stem}" if parent else stem


def context_key(network_path: str, contingency_id: str) -> str:
    """Sub-directory name for one (network, contingency) solution context.

    The slug alone is lossy (``line 1/2`` and ``line 1 2`` both sanitize to
    ``line_1_2``), so an 8-char digest of the *raw* pair disambiguates —
    two distinct contexts can never share a directory. The digest is
    computed on ``_network_key`` (not the raw path) so relative vs absolute
    paths to the same grid still map to one context.
    """
    net_key = _network_key(network_path)
    digest = hashlib.sha1(
        f"{net_key}\n{(contingency_id or '').strip()}".encode("utf-8")
    ).hexdigest()[:8]
    return f"{_safe_name(net_key)}__{_safe_name(contingency_id)}__{digest}"


def unitary_signatures(action: dict) -> list[str]:
    """Sorted unitary signatures of one retained action.

    Levers (opaque, magnitude-free strings computed by the frontend) win;
    an action without levers falls back to its catalogue identity
    ``action:<action_id>``.
    """
    levers = sorted({
        str(lever).strip()
        for lever in (action.get("levers") or [])
        if str(lever).strip()
    })
    if levers:
        return levers
    action_id = str(action.get("action_id") or "").strip()
    if not action_id:
        raise ValueError("A retained action needs an action_id or at least one lever")
    return [f"action:{action_id}"]


def proposition_signature(actions: list[dict]) -> tuple[str, list[str], list[list[str]]]:
    """``(signature, all_sigs, per_action_sigs)`` for a retained proposition.

    The signature is order-independent: the sorted union of every action's
    unitary signatures joined with `` + ``.
    """
    per_action_sigs = [unitary_signatures(a) for a in actions]
    all_sigs = sorted({sig for sigs in per_action_sigs for sig in sigs})
    return " + ".join(all_sigs), all_sigs, per_action_sigs


def _new_record_path(ctx_dir: Path, signature: str) -> Path:
    """Path for a NEW proposition record (full sha1 name; a numeric suffix
    sidesteps the leftovers of a corrupt/colliding file instead of silently
    overwriting its history)."""
    base = hashlib.sha1(signature.encode("utf-8")).hexdigest()
    path = ctx_dir / f"{base}.json"
    n = 1
    while path.exists():
        path = ctx_dir / f"{base}-{n}.json"
        n += 1
    return path


def _atomic_write_json(path: Path, record: dict) -> None:
    """Write-to-temp + rename so a crash mid-write can never truncate an
    existing record (``os.replace`` is atomic within one directory)."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _load_records(ctx_dir: Path) -> list[tuple[Path, dict]]:
    """All readable records of a context (corrupt files are skipped, logged)."""
    records: list[tuple[Path, dict]] = []
    if not ctx_dir.is_dir():
        return records
    for path in sorted(ctx_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning("Skipping unreadable solution record %s: %s", path, exc)
            continue
        if isinstance(data, dict) and data.get("signature"):
            records.append((path, data))
    return records


#: Categories the beginner-assistance panel groups levers under.
LEVER_CATEGORIES = ("voltage_level", "branch", "generation", "load", "other")


def _lever_category(signature: str) -> str:
    """Equipment family a unitary signature acts on.

    Prefix-driven for lever signatures; catalogue ``action:<id>`` falls back
    to the id heuristics the frontend classifier uses (disco_/reco_ →
    branch, coupling/busbar/node → voltage level).
    """
    if signature.startswith(("redispatch:", "rc:", "gen_p:")):
        return "generation"
    if signature.startswith(("ls:", "load_p:")):
        return "load"
    if signature.startswith("switch:"):
        return "voltage_level"
    if signature.startswith("pst:"):
        return "branch"
    if signature.startswith("action:"):
        action_id = signature[len("action:"):].lower()
        if any(tok in action_id for tok in ("coupl", "busbar", "node_merging", "node_splitting", "noeud")):
            return "voltage_level"
        if action_id.startswith(("disco_", "reco_")) or "line" in action_id:
            return "branch"
    return "other"


def _lever_label(signature: str) -> str:
    """Human-oriented element label of a signature (prefix stripped,
    switch state dropped)."""
    _, _, rest = signature.partition(":")
    label = rest or signature
    if signature.startswith("switch:"):
        label = label.partition("=")[0]
    return label


def lever_stats(network_path: str, contingency_id: str, top_n: int = 5) -> dict:
    """Most-used unitary levers of one (network, contingency) context.

    Beginner assistance for Game Mode: each lever's ``count`` is the number
    of retention events (all players) whose proposition mobilised it, so a
    proposition retained three times weighs three. Returns the ``top_n``
    levers sorted by count (ties broken alphabetically), each with its
    equipment category and a sample action description for display.
    """
    contingency = str(contingency_id or "").strip()
    if not contingency:
        raise ValueError("contingency_id is required")
    key = context_key(network_path, contingency)

    with _STORE_LOCK:
        records = _load_records(solutions_dir() / key)

    counts: dict[str, int] = {}
    samples: dict[str, str] = {}
    total = 0
    for _, record in records:
        weight = len(record.get("retentions") or [])
        total += weight
        for sig in record.get("unitary_signatures") or []:
            counts[sig] = counts.get(sig, 0) + weight
            if sig not in samples:
                for action in record.get("actions") or []:
                    covers = (sig in (action.get("levers") or [])
                              or sig == f"action:{action.get('action_id')}")
                    if covers and action.get("description"):
                        samples[sig] = str(action["description"])
                        break

    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        "context_key": key,
        "total_retentions": total,
        "levers": [
            {
                "signature": sig,
                "label": _lever_label(sig),
                "category": _lever_category(sig),
                "count": count,
                "share": (count / total) if total else 0.0,
                "sample_description": samples.get(sig),
            }
            for sig, count in ranked[: max(0, top_n)]
        ],
    }


def _action_entry(action: dict) -> dict:
    return {
        "action_id": action.get("action_id"),
        "description": action.get("description"),
        "action_type": action.get("action_type"),
        "levers": [str(lever) for lever in (action.get("levers") or [])],
        "effective": bool(action.get("effective", True)),
    }


def log_solution(payload: dict) -> dict:
    """Persist one retained proposition and report novelty + frequencies.

    ``payload`` is the wire dict of ``POST /api/game/log-solution``. Raises
    ``ValueError`` on an empty proposition or missing contingency (mapped
    to HTTP 400 at the API boundary).
    """
    actions = payload.get("actions") or []
    if not actions:
        raise ValueError("At least one retained action is required")
    contingency_id = str(payload.get("contingency_id") or "").strip()
    if not contingency_id:
        raise ValueError("contingency_id is required")
    network_path = str(payload.get("network_path") or "")

    signature, all_sigs, per_action_sigs = proposition_signature(actions)
    key = context_key(network_path, contingency_id)
    ctx_dir = solutions_dir() / key

    retention = {
        "player": (str(payload.get("player") or "")).strip() or None,
        "session_name": payload.get("session_name"),
        "study_id": payload.get("study_id"),
        "study_label": payload.get("study_label"),
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "solved": bool(payload.get("solved")),
        "final_max_rho": payload.get("final_max_rho"),
        "baseline_max_rho": payload.get("baseline_max_rho"),
        "num_actions": len(actions),
    }

    with _STORE_LOCK:
        records = _load_records(ctx_dir)
        known_propositions = {record["signature"] for _, record in records}
        known_unitaries = {
            sig
            for _, record in records
            for sig in (record.get("unitary_signatures") or [])
        }
        total_past = sum(len(record.get("retentions") or []) for _, record in records)

        new_proposition = signature not in known_propositions
        new_levers = [sig for sig in all_sigs if sig not in known_unitaries]
        all_effective = all(bool(a.get("effective", True)) for a in actions)
        bonus = 0
        if new_proposition and all_effective:
            bonus = BONUS_NEW_LEVER if new_levers else BONUS_NEW_COMBINATION

        # Usage frequency of each retained action across the base BEFORE
        # this retention — the end-of-session feedback ("this action was
        # part of N of the M retentions stored so far on this contingency").
        frequencies = []
        for action, sigs in zip(actions, per_action_sigs):
            matching = [
                record
                for _, record in records
                if set(sigs) <= set(record.get("unitary_signatures") or [])
            ]
            count = sum(len(record.get("retentions") or []) for record in matching)
            frequencies.append({
                "action_id": action.get("action_id"),
                "description": action.get("description"),
                "signatures": sigs,
                "count": count,
                "total": total_past,
                "share": (count / total_past) if total_past else 0.0,
            })

        if new_proposition:
            ctx_dir.mkdir(parents=True, exist_ok=True)
            record_path = _new_record_path(ctx_dir, signature)
            record = {
                "schema_version": SCHEMA_VERSION,
                "context": {
                    "network_key": _network_key(network_path),
                    "contingency_id": contingency_id,
                },
                "signature": signature,
                "unitary_signatures": all_sigs,
                "actions": [_action_entry(a) for a in actions],
                "retentions": [retention],
            }
        else:
            record_path, record = next(
                (path, rec) for path, rec in records if rec["signature"] == signature
            )
            record.setdefault("retentions", []).append(retention)

        _atomic_write_json(record_path, record)

    return {
        "stored": True,
        "duplicate": not new_proposition,
        "context_key": key,
        "signature": signature,
        "novelty": {
            "new_proposition": new_proposition,
            "new_levers": new_levers,
            "effective": all_effective,
            "bonus_points": bonus,
        },
        "frequencies": frequencies,
        "context_stats": {
            "distinct_propositions": len(records) + (1 if new_proposition else 0),
            "total_retentions": total_past + 1,
        },
    }
