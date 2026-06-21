#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Layer-1 static parity check: frontend/ vs standalone_interface.html.

Extracts canonical inventories from the React source (the source of
truth) and diffs them against the standalone HTML mirror. Emits a
CI-friendly report with file:line anchors on every failure.

Three inventories checked today:

1. ``InteractionType`` union (``frontend/src/types.ts``) — every event
   type the React app claims the standalone must support.
2. Backend API paths (``frontend/src/api.ts``) — every endpoint wired
   into the React HTTP client must also be wired into the standalone.
3. ``SettingsState`` interface (``frontend/src/hooks/useSettings.ts``)
   — every field the Settings modal exposes must be mirrored.

For each ``interactionLogger.record('TYPE', { key1, key2, ... })``
call site, we also collect the union of detail keys emitted per
event type in BOTH codebases and diff them — catches the
``voltage_range_changed { min_kv, max_kv }`` vs. spec
``{ min, max }`` class of regression.

Run::

    python scripts/check_standalone_parity.py            # human output
    python scripts/check_standalone_parity.py --json     # CI-friendly

Exits non-zero on any FAIL-level finding so the script can gate CI.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
# Standalone target: the hand-maintained mirror was decommissioned
# 2026-04-20 (renamed to `standalone_interface_legacy.html` and
# untracked via `.gitignore`). The canonical target is now the
# auto-generated single-file bundle. Callers that want to audit a
# different artifact can set `COSTUDY4GRID_STANDALONE_PATH` to any
# path — the legacy file is still readable on disk if present.
#
# Resolution order when `COSTUDY4GRID_STANDALONE_PATH` is unset:
#   1. `frontend/dist-standalone/standalone.html` — fresh local build
#      (gitignored; only present after `npm run build:standalone`).
#   2. `frontend/dist-standalone/standalone_v*.html` — the latest
#      committed versioned snapshot (lexicographically greatest).
#      CI checks out this file since step 1's output is gitignored.
#   3. `standalone_interface_legacy.html` — frozen last version of
#      the hand-maintained mirror, kept as a last-resort reference.
_DIST_STANDALONE_DIR = REPO_ROOT / "frontend" / "dist-standalone"
_DEFAULT_STANDALONE = _DIST_STANDALONE_DIR / "standalone.html"
_LEGACY_STANDALONE = REPO_ROOT / "standalone_interface_legacy.html"


def _resolve_standalone_path() -> Path:
    override = os.environ.get("COSTUDY4GRID_STANDALONE_PATH")
    if override:
        return Path(override)
    if _DEFAULT_STANDALONE.exists():
        return _DEFAULT_STANDALONE
    if _DIST_STANDALONE_DIR.is_dir():
        versioned = sorted(_DIST_STANDALONE_DIR.glob("standalone_v*.html"))
        if versioned:
            return versioned[-1]
    return _LEGACY_STANDALONE


STANDALONE = _resolve_standalone_path()
TYPES_TS = FRONTEND_SRC / "types.ts"
API_TS = FRONTEND_SRC / "api.ts"
USE_SETTINGS_TS = FRONTEND_SRC / "hooks" / "useSettings.ts"


# ---------------------------------------------------------------------
# Spec table — the replay contract from docs/features/interaction-logging.md
# ---------------------------------------------------------------------
#
# Encoded per event type as `(required_keys, optional_keys)`. Both are
# `frozenset` so the dict stays cheap to hash. Optional keys are
# fields the spec marks "only populated when ..." (e.g.
# `pending_branch` for `contingency_confirmed`) — they MAY be present
# without being flagged as an extra.
#
# Source of truth: docs/features/interaction-logging.md § "Replay Contract:
# Required Details Per Event Type". When the spec changes, update
# this table in the same PR — the three-way-diff check (`--spec`)
# compares FE and SA emissions against this.
#
# Events whose frontend details are passed via a bare identifier
# (e.g. ``record('config_loaded', buildConfigInteractionDetails())``)
# have SA compared to spec but FE can only be compared by a separate
# static-analysis pass that resolves the identifier's return shape;
# we don't attempt that here and mark FE as "deferred".

_CONFIG_FIELDS = frozenset({
    "network_path", "action_file_path", "layout_path", "output_folder_path",
    "min_line_reconnections", "min_close_coupling", "min_open_coupling",
    "min_line_disconnections", "min_pst", "min_load_shedding",
    "min_renewable_curtailment_actions", "min_redispatch",
    "allowed_action_types", "n_prioritized_actions",
    "lines_monitoring_path", "monitoring_factor",
    "pre_existing_overload_threshold", "ignore_reconnections",
    "pypowsybl_fast_mode",
})


def _spec_row(required: set[str], optional: set[str] = frozenset()) -> dict:
    return {"required": frozenset(required), "optional": frozenset(optional)}


SPEC_DETAILS: dict[str, dict] = {
    # --- Configuration & Study Loading ---
    "config_loaded":           _spec_row(_CONFIG_FIELDS),
    "settings_opened":         _spec_row({"tab"}),
    "settings_tab_changed":    _spec_row({"from_tab", "to_tab"}),
    "settings_applied":        _spec_row(_CONFIG_FIELDS),
    "settings_cancelled":      _spec_row(set()),
    "path_picked":             _spec_row({"type", "path"}),
    # --- Contingency (single + N-K multi-element) ---
    "contingency_selected":         _spec_row({"element"}),
    "contingency_confirmed":        _spec_row({"type"}, optional={"pending_branch"}),
    "contingency_element_added":    _spec_row({"element"}),
    "contingency_element_removed":  _spec_row({"element"}),
    "contingency_applied":          _spec_row({"elements"}),
    # --- Two-Step Analysis ---
    "analysis_step1_started":   _spec_row({"element"}),
    "analysis_step1_completed": _spec_row({
        "element", "overloads_found", "n_overloads",
        "can_proceed", "dc_fallback", "message",
    }),
    "overload_toggled":         _spec_row({"overload", "selected"}),
    "analysis_step2_started":   _spec_row({
        "element", "selected_overloads", "all_overloads", "monitor_deselected",
        # PR #134 — operator-selectable extra "lines to cut" forwarded
        # to the discovery engine as ``extra_lines_to_cut_ids``.
        "additional_lines_to_cut",
    }),
    "additional_line_to_cut_toggled": _spec_row({"line", "selected"}),
    "recommender_model_changed": _spec_row({"model"}, optional={"source"}),
    "suggested_actions_cleared": _spec_row({"n_cleared"}),
    "analysis_step2_completed": _spec_row({
        "n_actions", "action_ids", "dc_fallback", "message", "pdf_url",
    }),
    "prioritized_actions_displayed": _spec_row({"n_actions"}),
    # --- Action ---
    "action_selected":          _spec_row({"action_id"}),
    "action_deselected":        _spec_row({"previous_action_id"}),
    "action_favorited":         _spec_row({"action_id"}),
    "action_unfavorited":       _spec_row({"action_id"}),
    "action_rejected":          _spec_row({"action_id"}),
    "action_unrejected":        _spec_row({"action_id"}),
    "manual_action_simulated":  _spec_row({"action_id"}),
    "action_mw_resimulated":    _spec_row({"action_id", "target_mw"}),
    "pst_tap_resimulated":      _spec_row({"action_id", "target_tap"}),
    # --- Combined Actions ---
    "combine_modal_opened":     _spec_row(set()),
    "combine_modal_closed":     _spec_row(set()),
    "combine_pair_toggled":     _spec_row({"action_id", "selected"}),
    "combine_pair_estimated":   _spec_row({
        "action1_id", "action2_id",
        "estimated_max_rho", "estimated_max_rho_line",
    }),
    "combine_pair_simulated":   _spec_row({
        "combined_id", "action1_id", "action2_id", "simulated_max_rho",
    }),
    # --- Visualization ---
    "diagram_tab_changed":      _spec_row({"tab"}),
    "tab_detached":             _spec_row({"tab"}),
    "tab_reattached":           _spec_row({"tab"}),
    "tab_tied":                 _spec_row({"tab"}),
    "tab_untied":               _spec_row({"tab"}),
    "view_mode_changed":        _spec_row({"mode", "tab", "scope"}),
    # Overflow Analysis tab layout toggle ("Hierarchical" / "Geo").
    # Start event carries the target mode; completion event adds
    # `cached` (boolean) or `error` (string).
    "overflow_layout_mode_toggled": _spec_row({"to"}),
    # Co-Study4Grid pin overlay on the overflow graph.
    "overflow_pins_toggled":    _spec_row({"enabled"}),
    "overflow_pin_clicked":     _spec_row({"actionId"}),
    "overflow_pin_double_clicked": _spec_row({"actionId", "substation"}),
    "overflow_layer_toggled":   _spec_row({"key", "label", "visible"}),
    "overflow_select_all_layers": _spec_row({"visible"}),
    "overflow_node_double_clicked": _spec_row({"name"}),
    "voltage_range_changed":    _spec_row({"min", "max"}),
    "asset_clicked":            _spec_row({"action_id", "asset_name", "tab"}),
    "zoom_in":                  _spec_row({"tab"}),
    "zoom_out":                 _spec_row({"tab"}),
    "zoom_reset":               _spec_row({"tab"}),
    "inspect_query_changed":    _spec_row({"query"}, optional={"target_tab"}),
    "vl_names_toggled":         _spec_row({"show"}),
    # --- Action Overview Diagram ---
    "overview_shown":           _spec_row({"has_pins", "pin_count"}),
    "overview_hidden":          _spec_row(set()),
    "overview_pin_clicked":     _spec_row({"action_id"}),
    "overview_pin_double_clicked": _spec_row({"action_id"}),
    "overview_popover_closed":  _spec_row({"reason"}),
    "overview_zoom_in":         _spec_row(set()),
    "overview_zoom_out":        _spec_row(set()),
    "overview_zoom_fit":        _spec_row(set()),
    "overview_inspect_changed": _spec_row({"query", "action"}),
    "overview_filter_changed":  _spec_row({"kind"}, optional={"category", "enabled", "threshold", "action_type"}),
    "overview_unsimulated_toggled":     _spec_row({"enabled"}),
    "overview_unsimulated_pin_simulated": _spec_row({"action_id"}),
    # --- SLD Overlay ---
    "sld_overlay_opened":       _spec_row({"vl_name", "action_id"}),
    "sld_overlay_tab_changed":  _spec_row({"tab", "vl_name"}),
    "sld_overlay_closed":       _spec_row(set()),
    "sld_edit_mode_toggled":    _spec_row({"enabled"}),
    "sld_switch_toggled":       _spec_row({"equipment_id"}),
    "sld_maneuver_removed":     _spec_row({"equipment_ids"}),
    "sld_maneuver_focused":     _spec_row({"equipment_id"}),
    "sld_edit_reset":           _spec_row(set()),
    "sld_topology_simulated":   _spec_row({"voltage_level_id", "switches"}, {"combined_with"}),
    # --- Session Management ---
    "session_saved":            _spec_row({"output_folder"}),
    "session_reload_modal_opened": _spec_row(set()),
    "session_reloaded":         _spec_row({"session_name"}),
    # --- Sidebar layout / contingency clear ---
    "sidebar_collapsed_toggled": _spec_row({"collapsed"}),
    "contingency_clear_requested": _spec_row({"had_analysis_state"}),
    # --- Theme ---
    "theme_toggled":            _spec_row({"theme"}),
    # --- Smooth pan/zoom (GPU) preference ---
    "smooth_pan_zoom_toggled":  _spec_row({"enabled", "mode"}),
}

# Event types whose details argument is a bare identifier or a
# function call — the regex cannot see inside them. The auto-generated
# standalone bundle now shares the React source's call pattern (both
# emit `buildConfigInteractionDetails()`), so deferred treatment must
# apply symmetrically: a bare-call details argument is a false-positive
# mismatch on either side.
_DEFERRED_TYPES = frozenset({"config_loaded", "settings_applied"})


# ---------------------------------------------------------------------
# Extractors (React source → canonical sets)
# ---------------------------------------------------------------------

def extract_interaction_types(ts_path: Path) -> set[str]:
    """Parse the ``InteractionType`` union from types.ts.

    We only need the set of string literals between
    ``export type InteractionType =`` and the terminating ``;``.
    Comments, whitespace, and ``|`` separators are tolerated.
    """
    src = ts_path.read_text(encoding="utf-8")
    m = re.search(r"export type InteractionType\s*=\s*(.*?);", src, re.DOTALL)
    if not m:
        raise RuntimeError(f"InteractionType union not found in {ts_path}")
    body = m.group(1)
    # Drop line comments and block comments.
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    return set(re.findall(r"'([a-z0-9_]+)'", body))


def extract_api_paths(api_path: Path) -> set[str]:
    """Pull every ``/api/...`` path out of the axios client.

    Matches the template-literal form the repo uses throughout, e.g.
    ``${API_BASE_URL}/api/run-analysis-step1``.
    """
    src = api_path.read_text(encoding="utf-8")
    paths = set(re.findall(r"/api/[A-Za-z0-9_\-]+", src))
    return paths


def extract_settings_state_fields(hook_path: Path) -> set[str]:
    """Parse field names from the exported ``SettingsState`` interface.

    We only keep fields that have a paired ``set<Name>`` setter in the
    same interface — this is the useSettings convention and it filters
    out inline function-type signatures (e.g. ``buildConfigRequest:
    () => { network_path: string; ... }``) whose return-type body would
    otherwise leak snake-case identifiers into the extracted set.
    """
    src = hook_path.read_text(encoding="utf-8")
    m = re.search(r"export interface SettingsState\s*\{(.*?)^\}", src, re.DOTALL | re.MULTILINE)
    if not m:
        raise RuntimeError(f"SettingsState interface not found in {hook_path}")
    body = m.group(1)
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    # Pair-based extraction: a field ``foo: T;`` counts only if
    # ``setFoo: (v: T) => void;`` also appears in the body.
    setters = set(re.findall(r"\bset([A-Z][A-Za-z0-9_]*)\s*:\s*\(", body))
    setter_targets = {s[0].lower() + s[1:] for s in setters}
    fields: set[str] = set()
    for name in re.findall(r"^\s*([a-z][A-Za-z0-9_]*)\s*:\s*", body, re.MULTILINE):
        if name in setter_targets:
            fields.add(name)
    return fields


RECORD_CALL = re.compile(
    r"interactionLogger\.record\(\s*['\"]([a-z0-9_]+)['\"]",
)
RECORD_COMPLETION_CALL = re.compile(
    r"interactionLogger\.recordCompletion\(\s*['\"]([a-z0-9_]+)['\"]",
)


def _extract_second_arg(src: str, after: int) -> tuple[str, int] | None:
    """Starting at `src[after] == ','`, return the source slice of the
    second argument to ``interactionLogger.record`` and the offset
    past it.  Handles balanced ``{}`` nesting (so JSX and inline
    expressions like ``Object.keys({}).length`` don't truncate the
    capture), and handles bare identifiers / method calls (returns
    them verbatim so the caller can note it's "deferred").

    Returns None if the call has no second argument.
    """
    i = after
    # Expect `,` followed by whitespace, then the arg.
    if i >= len(src) or src[i] != ",":
        return None
    i += 1
    while i < len(src) and src[i].isspace():
        i += 1
    if i >= len(src):
        return None
    start = i
    if src[i] == "{":
        # Balance braces; strings and comments can harbour unbalanced
        # braces so we skip them explicitly.
        depth = 0
        while i < len(src):
            c = src[i]
            if c == "{":
                depth += 1
                i += 1
            elif c == "}":
                depth -= 1
                i += 1
                if depth == 0:
                    return (src[start:i], i)
            elif c in "\"'":
                # Skip string literal
                quote = c
                i += 1
                while i < len(src) and src[i] != quote:
                    if src[i] == "\\":
                        i += 2
                    else:
                        i += 1
                i += 1
            elif c == "`":
                # Template literal — just skip to the matching `
                i += 1
                while i < len(src) and src[i] != "`":
                    if src[i] == "\\":
                        i += 2
                    else:
                        i += 1
                i += 1
            elif src[i:i + 2] == "//":
                while i < len(src) and src[i] != "\n":
                    i += 1
            elif src[i:i + 2] == "/*":
                i += 2
                while i < len(src) and src[i:i + 2] != "*/":
                    i += 1
                i += 2
            else:
                i += 1
        return None
    # Bare identifier / call expression — read until top-level `)` or
    # `,` at paren-depth 0.
    paren_depth = 0
    while i < len(src):
        c = src[i]
        if c == "(":
            paren_depth += 1
        elif c == ")":
            if paren_depth == 0:
                break
            paren_depth -= 1
        elif c == "," and paren_depth == 0:
            break
        i += 1
    return (src[start:i], i)


def _strip_comments(src: str) -> str:
    """Remove ``//``-line and ``/* */``-block comments so they don't
    pollute the DETAIL_KEY walk. (The tokenizer above already skips
    comments while walking braces, but the body passed to DETAIL_KEY
    is the raw slice — stripping here is the simplest way to keep
    the key walker honest against call-site comments.)
    """
    src = re.sub(r"//[^\n]*", "", src)
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    return src
# Match only property-start positions inside an object literal so we
# capture keys (not value identifiers).  Both explicit and JS shorthand
# properties are supported:
#   { name: value, ... }   → name
#   { name, ... }          → name   (shorthand, followed by `,`)
#   { name }               → name   (shorthand, followed by `}`)
# The leading ``[{,]`` anchor forces "first token of a property".
DETAIL_KEY = re.compile(
    r"[{,]\s*"
    r"([a-zA-Z_][a-zA-Z0-9_]*)"
    r"\s*(?=[:,}]|$)"
)


def walk_record_calls(
    root: Path,
    patterns: Iterable[str],
    exclude: Iterable[str] = (),
) -> tuple[dict[str, set[str]], dict[str, list[tuple[str, int]]]]:
    """Collect ``{event_type: set(detail_keys)}`` + file:line anchors.

    For each ``interactionLogger.record('type', { a, b: 1, ... })``:
    - event_type → 'type'
    - detail_keys → {'a', 'b'} (keys of the object-literal argument
      when it is an object literal; if the argument is a bare
      identifier, the keys are skipped — the call still counts toward
      presence but not toward schema diffing).
    """
    keys_by_type: dict[str, set[str]] = defaultdict(set)
    sites_by_type: dict[str, list[tuple[str, int]]] = defaultdict(list)
    excluded = tuple(exclude)

    files: list[Path] = []
    for pattern in patterns:
        files.extend(root.rglob(pattern))
    for path in sorted(set(files)):
        rel = str(path.relative_to(REPO_ROOT))
        if any(ex in rel for ex in excluded):
            continue
        src = path.read_text(encoding="utf-8", errors="replace")
        # Use line-by-line search so we can cheaply attach line numbers.
        for m in RECORD_CALL.finditer(src):
            event_type = m.group(1)
            line_no = src.count("\n", 0, m.start()) + 1
            sites_by_type[event_type].append((rel, line_no))
            second = _extract_second_arg(src, m.end())
            if second is None:
                continue
            details_src, _end = second
            if details_src.startswith("{"):
                # Strip comments before the key walk — a comment between
                # ``{`` and the first property would otherwise hide the
                # first key (the anchor ``[{,]\s*`` can't skip across
                # arbitrary non-whitespace text).
                cleaned = _strip_comments(details_src)
                for km in DETAIL_KEY.finditer(cleaned):
                    keys_by_type[event_type].add(km.group(1))
    return keys_by_type, sites_by_type


def walk_record_completion_calls(
    root: Path,
    patterns: Iterable[str],
    exclude: Iterable[str] = (),
) -> set[str]:
    """Return the set of event types that appear in ``recordCompletion(...)``
    calls. The start side is already handled by :func:`walk_record_calls`.
    """
    seen: set[str] = set()
    excluded = tuple(exclude)
    for pattern in patterns:
        for path in root.rglob(pattern):
            rel = str(path.relative_to(REPO_ROOT))
            if any(ex in rel for ex in excluded):
                continue
            src = path.read_text(encoding="utf-8", errors="replace")
            for m in RECORD_COMPLETION_CALL.finditer(src):
                seen.add(m.group(1))
    return seen


# ---------------------------------------------------------------------
# Extractors (standalone HTML → standalone inventories)
# ---------------------------------------------------------------------

def walk_standalone_record_calls(
    html_path: Path,
) -> tuple[dict[str, set[str]], dict[str, list[tuple[str, int]]]]:
    """Same contract as :func:`walk_record_calls` but for the
    single-file standalone HTML. The standalone inlines React-like JSX
    + JS, so ``interactionLogger.record(...)`` literals look identical
    to the frontend ones. We re-use the same extractor.
    """
    keys_by_type: dict[str, set[str]] = defaultdict(set)
    sites_by_type: dict[str, list[tuple[str, int]]] = defaultdict(list)
    src = html_path.read_text(encoding="utf-8", errors="replace")
    for m in RECORD_CALL.finditer(src):
        event_type = m.group(1)
        line_no = src.count("\n", 0, m.start()) + 1
        sites_by_type[event_type].append((str(html_path.name), line_no))
        second = _extract_second_arg(src, m.end())
        if second is None:
            continue
        details_src, _end = second
        if details_src.startswith("{"):
            cleaned = _strip_comments(details_src)
            for km in DETAIL_KEY.finditer(cleaned):
                keys_by_type[event_type].add(km.group(1))
    return keys_by_type, sites_by_type


def extract_standalone_api_paths(html_path: Path) -> set[str]:
    """Return ``/api/...`` paths referenced in the standalone HTML.

    The standalone uses both ``fetch`` and ``axios`` / string literals;
    grepping the literal path is enough.
    """
    src = html_path.read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r"/api/[A-Za-z0-9_\-]+", src))


def extract_standalone_setting_fields(html_path: Path) -> set[str]:
    """Best-effort extraction of ``useState`` field identifiers in the
    standalone that plausibly correspond to Settings state.

    The standalone does not expose a ``SettingsState`` type, so we
    sniff for ``const [fieldName, setFieldName] = useState(...)`` and
    intersect with the canonical SettingsState field names. Fields
    the frontend exposes but that do not appear here are flagged as
    potentially missing.
    """
    src = html_path.read_text(encoding="utf-8", errors="replace")
    names = set(re.findall(r"const\s+\[\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*set", src))
    return names


# ---------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------

def fmt_sites(sites: list[tuple[str, int]], limit: int = 3) -> str:
    head = sites[:limit]
    rest = len(sites) - len(head)
    base = ", ".join(f"{p}:{ln}" for p, ln in head)
    return base + (f" (+{rest} more)" if rest > 0 else "")


def run_checks() -> dict:
    """Execute every check and return a structured dict of findings.

    Top-level keys::

        {
          "missing_event_types":   [...],
          "orphan_event_types":    [...],        # in HTML, not in union
          "missing_completion":    [...],        # in FE, not in HTML
          "detail_key_drift":      [{...}, ...], # per-event detail diff
          "missing_api_paths":     [...],
          "missing_settings":      [...],
        }
    """
    canonical_events = extract_interaction_types(TYPES_TS)
    canonical_api = extract_api_paths(API_TS)
    canonical_settings = extract_settings_state_fields(USE_SETTINGS_TS)

    # Exclude all test files so the inventories reflect production
    # call sites only — `*.test.ts` / `*.test.tsx` emit events with
    # placeholder shapes (`{ path: '/data' }`) that would pollute the
    # details-key diff.
    fe_keys, fe_sites = walk_record_calls(
        FRONTEND_SRC,
        ("*.ts", "*.tsx"),
        exclude=(".test.ts", ".test.tsx"),
    )
    fe_completion = walk_record_completion_calls(
        FRONTEND_SRC,
        ("*.ts", "*.tsx"),
        exclude=(".test.ts", ".test.tsx"),
    )

    sa_keys, sa_sites = walk_standalone_record_calls(STANDALONE)
    sa_completion = set()  # populated below if any recordCompletion calls present
    sa_src = STANDALONE.read_text(encoding="utf-8", errors="replace")
    for m in RECORD_COMPLETION_CALL.finditer(sa_src):
        sa_completion.add(m.group(1))

    fe_event_types = set(fe_sites.keys())
    sa_event_types = set(sa_sites.keys())

    # Union membership — a canonical type the frontend emits but the
    # standalone never does.
    missing_event_types = sorted(
        t for t in canonical_events
        if t in fe_event_types and t not in sa_event_types
    )

    # Standalone references a type the union has dropped or never had.
    orphan_event_types = sorted(t for t in sa_event_types if t not in canonical_events)

    # Async-completion gap — types where frontend calls
    # `recordCompletion(type)` but standalone never does.
    missing_completion = sorted(t for t in fe_completion if t not in sa_completion)

    # Per-event detail-key drift. Only compare events whose frontend
    # call site provides an object literal — when the React handler
    # passes a bare identifier (e.g. ``record('config_loaded',
    # buildConfigInteractionDetails())``) the regex cannot see into
    # the return value and the extracted key set would be empty,
    # producing false "drift" signals against a standalone that
    # correctly emits all documented keys.
    detail_key_drift: list[dict] = []
    for t in sorted(fe_event_types & sa_event_types & canonical_events):
        fe = fe_keys.get(t, set())
        sa = sa_keys.get(t, set())
        if not fe:
            continue  # frontend details are in a bare identifier
        if fe and sa and fe != sa:
            # A diff that is spec-conformant on both sides (only
            # optional keys are present on one side but not the other)
            # is not real drift — skip it rather than flag it as a
            # parity failure.  The spec marks the difference as
            # intentional, typically when one codebase supports a
            # feature the other doesn't (e.g. detached-tab overlays).
            spec = SPEC_DETAILS.get(t)
            if spec is not None:
                required = spec["required"]
                optional = spec["optional"]
                symmetric_diff = (fe ^ sa)
                # Benign if every differing key is either optional or
                # both sides have all required keys.
                fe_ok = required <= fe
                sa_ok = required <= sa
                all_diffs_optional = symmetric_diff <= optional
                if fe_ok and sa_ok and all_diffs_optional:
                    continue
            detail_key_drift.append({
                "event_type": t,
                "frontend_keys": sorted(fe),
                "standalone_keys": sorted(sa),
                "missing_in_standalone": sorted(fe - sa),
                "extra_in_standalone": sorted(sa - fe),
                "frontend_sites": fe_sites[t][:3],
                "standalone_sites": sa_sites[t][:3],
            })

    # Three-way diff vs the replay-contract spec
    # (docs/features/interaction-logging.md § Replay Contract). Distinct from the
    # FE-vs-SA drift: both codebases can agree yet still drift from the
    # contract, and conversely one side can be correct while the other
    # drifts. Encoding the spec here lets the report attribute each
    # finding to the side that needs to move.
    fe_spec_drift: list[dict] = []
    sa_spec_drift: list[dict] = []
    missing_spec_rows: list[str] = []
    for t in sorted(canonical_events):
        spec = SPEC_DETAILS.get(t)
        if spec is None:
            missing_spec_rows.append(t)
            continue
        required = spec["required"]
        optional = spec["optional"]
        known = required | optional

        # Frontend side.
        if t in fe_event_types and t not in _DEFERRED_TYPES:
            fe = fe_keys.get(t, set())
            # Empty object literal is a valid emission — only flag a
            # missing-required gap when the event actually carries a
            # non-empty shape or the spec requires anything.
            fe_missing = sorted(required - fe) if (fe or required) else []
            fe_extras = sorted(fe - known)
            if fe_missing or fe_extras:
                fe_spec_drift.append({
                    "event_type": t,
                    "spec_required": sorted(required),
                    "spec_optional": sorted(optional),
                    "frontend_keys": sorted(fe),
                    "missing_required": fe_missing,
                    "unknown_extras": fe_extras,
                    "frontend_sites": fe_sites[t][:3],
                })

        # Standalone side.
        if t in sa_event_types and t not in _DEFERRED_TYPES:
            sa = sa_keys.get(t, set())
            sa_missing = sorted(required - sa) if (sa or required) else []
            sa_extras = sorted(sa - known)
            if sa_missing or sa_extras:
                sa_spec_drift.append({
                    "event_type": t,
                    "spec_required": sorted(required),
                    "spec_optional": sorted(optional),
                    "standalone_keys": sorted(sa),
                    "missing_required": sa_missing,
                    "unknown_extras": sa_extras,
                    "standalone_sites": sa_sites[t][:3],
                })

    sa_api = extract_standalone_api_paths(STANDALONE)
    missing_api_paths = sorted(
        p for p in canonical_api
        if p not in sa_api
        # Filter picker / PDF static routes handled outside axios
        and p not in {"/api/pick-path"}
    )

    sa_settings = extract_standalone_setting_fields(STANDALONE)
    # The React side uses camelCase (``networkPath``); the standalone
    # historically mirrors the API payload (``network_path``) and uses
    # that as the useState key. Compare on a normalised form (lower +
    # underscores stripped) so we don't flag the convention drift as a
    # parity failure.

    def _norm(name: str) -> str:
        return re.sub(r"_", "", name).lower()

    sa_norm = {_norm(s) for s in sa_settings}
    missing_settings = sorted(
        s for s in canonical_settings
        if _norm(s) not in sa_norm
    )

    return {
        "canonical_event_count": len(canonical_events),
        "frontend_event_count": len(fe_event_types),
        "standalone_event_count": len(sa_event_types),
        "missing_event_types": [
            {"type": t, "frontend_sites": fe_sites[t][:3]}
            for t in missing_event_types
        ],
        "orphan_event_types": [
            {"type": t, "standalone_sites": sa_sites[t][:3]}
            for t in orphan_event_types
        ],
        "missing_completion": missing_completion,
        "detail_key_drift": detail_key_drift,
        "fe_spec_drift": fe_spec_drift,
        "sa_spec_drift": sa_spec_drift,
        "missing_spec_rows": missing_spec_rows,
        "missing_api_paths": missing_api_paths,
        "missing_settings": missing_settings,
    }


def render_human(report: dict) -> str:
    out: list[str] = []
    out.append("STANDALONE PARITY REPORT")
    out.append("=" * 72)
    out.append(
        f"InteractionType union: {report['canonical_event_count']} types. "
        f"Frontend emits {report['frontend_event_count']}, "
        f"standalone emits {report['standalone_event_count']}."
    )
    out.append("")

    fail = False

    # ---- Missing event types
    m = report["missing_event_types"]
    if m:
        fail = True
        out.append(f"[FAIL] {len(m)} event types emitted by the frontend but "
                   f"not by the standalone:")
        for entry in m:
            out.append(f"   - {entry['type']:35s}  (fe: {fmt_sites(entry['frontend_sites'])})")
        out.append("")

    # ---- Orphan event types
    o = report["orphan_event_types"]
    if o:
        fail = True
        out.append(f"[FAIL] {len(o)} event types emitted by the standalone but "
                   f"not declared in InteractionType:")
        for entry in o:
            out.append(f"   - {entry['type']:35s}  (sa: {fmt_sites(entry['standalone_sites'])})")
        out.append("")

    # ---- recordCompletion gap
    mc = report["missing_completion"]
    if mc:
        fail = True
        out.append(f"[FAIL] {len(mc)} async wait-point *_completed events emitted "
                   f"by the frontend but never in the standalone:")
        for t in mc:
            out.append(f"   - {t}")
        out.append("")

    # ---- Detail-key drift
    d = report["detail_key_drift"]
    if d:
        fail = True
        out.append(f"[FAIL] {len(d)} events whose `details` object-literal keys "
                   f"diverge between frontend and standalone:")
        for entry in d:
            out.append(f"   - {entry['event_type']}")
            out.append(f"        frontend:   {{{', '.join(entry['frontend_keys'])}}}")
            out.append(f"        standalone: {{{', '.join(entry['standalone_keys'])}}}")
            if entry["missing_in_standalone"]:
                out.append(f"        missing:    {entry['missing_in_standalone']}")
            if entry["extra_in_standalone"]:
                out.append(f"        extra:      {entry['extra_in_standalone']}")
        out.append("")

    # ---- FE-vs-spec drift
    fs = report["fe_spec_drift"]
    if fs:
        fail = True
        out.append(f"[FAIL] {len(fs)} events where the frontend drifts from the "
                   f"replay-contract spec (docs/features/interaction-logging.md):")
        for entry in fs:
            out.append(f"   - {entry['event_type']}")
            out.append(f"        spec required: {{{', '.join(entry['spec_required'])}}}")
            if entry["spec_optional"]:
                out.append(f"        spec optional: {{{', '.join(entry['spec_optional'])}}}")
            out.append(f"        frontend:      {{{', '.join(entry['frontend_keys'])}}}")
            if entry["missing_required"]:
                out.append(f"        missing:       {entry['missing_required']}")
            if entry["unknown_extras"]:
                out.append(f"        unknown extras: {entry['unknown_extras']}")
            out.append(f"        fe sites:      {fmt_sites(entry['frontend_sites'])}")
        out.append("")

    # ---- SA-vs-spec drift
    ss = report["sa_spec_drift"]
    if ss:
        fail = True
        out.append(f"[FAIL] {len(ss)} events where the standalone drifts from the "
                   f"replay-contract spec (docs/features/interaction-logging.md):")
        for entry in ss:
            out.append(f"   - {entry['event_type']}")
            out.append(f"        spec required: {{{', '.join(entry['spec_required'])}}}")
            if entry["spec_optional"]:
                out.append(f"        spec optional: {{{', '.join(entry['spec_optional'])}}}")
            out.append(f"        standalone:    {{{', '.join(entry['standalone_keys'])}}}")
            if entry["missing_required"]:
                out.append(f"        missing:       {entry['missing_required']}")
            if entry["unknown_extras"]:
                out.append(f"        unknown extras: {entry['unknown_extras']}")
            out.append(f"        sa sites:      {fmt_sites(entry['standalone_sites'])}")
        out.append("")

    # ---- Spec rows still missing from SPEC_DETAILS
    mr = report.get("missing_spec_rows") or []
    if mr:
        out.append(f"[WARN] {len(mr)} InteractionType values have no SPEC_DETAILS "
                   f"entry — extend the spec table in this script:")
        for t in mr:
            out.append(f"   - {t}")
        out.append("")

    # ---- API-path gap
    ma = report["missing_api_paths"]
    if ma:
        fail = True
        out.append(f"[FAIL] {len(ma)} API paths referenced by the frontend but "
                   f"not by the standalone:")
        for p in ma:
            out.append(f"   - {p}")
        out.append("")

    # ---- Settings-field gap
    ms = report["missing_settings"]
    if ms:
        fail = True
        out.append(f"[WARN] {len(ms)} SettingsState fields whose identifier was "
                   f"not found in the standalone (best-effort grep):")
        for s in ms:
            out.append(f"   - {s}")
        out.append("")

    if not fail:
        out.append("[OK] standalone_interface.html is in full Layer-1 parity with frontend/.")
    return "\n".join(out)


def render_markdown(report: dict) -> str:
    """Render the findings as Markdown tables suitable for pasting
    into ``CLAUDE.md`` (§ "Machine-grounded findings").

    This is what the ``--emit-markdown`` flag prints. The intent is
    that the audit table in the root CLAUDE.md is NEVER hand-edited
    — it is always regenerated from this function's output, so the
    doc and the script can never drift.
    """
    out: list[str] = []
    out.append(
        f"_Generated by `scripts/check_standalone_parity.py`._ "
        f"InteractionType union: **{report['canonical_event_count']}** types. "
        f"Frontend emits **{report['frontend_event_count']}**, "
        f"standalone emits **{report['standalone_event_count']}**."
    )
    out.append("")

    me = report["missing_event_types"]
    if me:
        out.append(f"#### Event types emitted by the frontend but NOT by the standalone ({len(me)})")
        out.append("")
        out.append("| Event type | React source |")
        out.append("|---|---|")
        for entry in me:
            sites = fmt_sites(entry["frontend_sites"])
            out.append(f"| `{entry['type']}` | `{sites}` |")
        out.append("")

    oe = report["orphan_event_types"]
    if oe:
        out.append(f"#### Event types emitted by the standalone but NOT in `InteractionType` ({len(oe)})")
        out.append("")
        out.append("| Event type | Standalone source |")
        out.append("|---|---|")
        for entry in oe:
            sites = fmt_sites(entry["standalone_sites"])
            out.append(f"| `{entry['type']}` | `{sites}` |")
        out.append("")

    fs = report["fe_spec_drift"]
    if fs:
        out.append(f"#### Frontend drifts from the replay-contract spec ({len(fs)})")
        out.append("")
        out.append("| Event | Spec required | Frontend emits | Missing | React source |")
        out.append("|---|---|---|---|---|")
        for entry in fs:
            req = ", ".join(entry["spec_required"])
            fe = ", ".join(entry["frontend_keys"]) or "(empty)"
            missing = ", ".join(entry["missing_required"]) or "—"
            sites = fmt_sites(entry["frontend_sites"])
            out.append(f"| `{entry['event_type']}` | `{{{req}}}` | `{{{fe}}}` | `{missing}` | `{sites}` |")
        out.append("")

    ss = report["sa_spec_drift"]
    if ss:
        out.append(f"#### Standalone drifts from the replay-contract spec ({len(ss)})")
        out.append("")
        out.append("| Event | Spec required | Standalone emits | Missing | Standalone source |")
        out.append("|---|---|---|---|---|")
        for entry in ss:
            req = ", ".join(entry["spec_required"])
            sa = ", ".join(entry["standalone_keys"]) or "(empty)"
            missing = ", ".join(entry["missing_required"]) or "—"
            sites = fmt_sites(entry["standalone_sites"])
            out.append(f"| `{entry['event_type']}` | `{{{req}}}` | `{{{sa}}}` | `{missing}` | `{sites}` |")
        out.append("")

    d = report["detail_key_drift"]
    if d:
        out.append(f"#### FE ↔ SA details-key drift (no spec row) ({len(d)})")
        out.append("")
        out.append("| Event | Frontend | Standalone |")
        out.append("|---|---|---|")
        for entry in d:
            fe = ", ".join(entry["frontend_keys"]) or "(empty)"
            sa = ", ".join(entry["standalone_keys"]) or "(empty)"
            out.append(f"| `{entry['event_type']}` | `{{{fe}}}` | `{{{sa}}}` |")
        out.append("")

    ma = report["missing_api_paths"]
    if ma:
        out.append(f"#### API paths referenced by the frontend but not by the standalone ({len(ma)})")
        out.append("")
        for p in ma:
            out.append(f"- `{p}`")
        out.append("")

    mc = report["missing_completion"]
    if mc:
        out.append(f"#### `recordCompletion(...)` events emitted by the frontend but not the standalone ({len(mc)})")
        out.append("")
        for t in mc:
            out.append(f"- `{t}`")
        out.append("")

    if not out:
        out.append("_No findings — `standalone_interface.html` is in full Layer-1 parity with `frontend/`._")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument(
        "--emit-markdown", action="store_true",
        help="render a Markdown report suitable for pasting into CLAUDE.md",
    )
    parser.add_argument(
        "--allow-warn", action="store_true",
        help="exit 0 even if there are [WARN] findings (FAILs still exit 1)",
    )
    args = parser.parse_args()

    report = run_checks()
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif args.emit_markdown:
        print(render_markdown(report))
    else:
        print(render_human(report))

    hard_fail = (
        report["missing_event_types"]
        or report["orphan_event_types"]
        or report["missing_completion"]
        or report["detail_key_drift"]
        or report["fe_spec_drift"]
        or report["sa_spec_drift"]
        or report["missing_api_paths"]
    )
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
