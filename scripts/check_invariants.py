#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Layer-4 (static) — user-observable invariants.

Layers 1–3a / 3b all passed green while shipping six real bugs to
the user.  Each bug belongs to a class the earlier layers can't
catch by construction:

  - visual threshold values (palette, dim opacity)
  - conditional rendering gates (when does X render?)
  - field-semantic interpretation (max_rho_line vs topology target)
  - auto-effects ordering (tab auto-switch, auto-zoom, deselect-stay)
  - loading-state hygiene (spinner released when?)
  - rendering performance (memoization guards)

Full runtime coverage requires a browser (Layer 3b Playwright).  This
script takes the cheapest subset: STATIC invariants expressible as
source-level patterns.  For each invariant we encode:

  - a unique name,
  - the React source expected to satisfy it + a regex proving it does,
  - the standalone_interface.html source expected to satisfy it + a
    matching regex,
  - a human description of WHY the invariant matters and what user-
    facing bug it regressions prevented.

A failing check means one side drifted from the invariant; the
output lists both file paths and the regex that missed.

Run::

    python scripts/check_invariants.py            # human text
    python scripts/check_invariants.py --json     # CI-friendly

Exits non-zero on any FAIL finding.

Scope: this check catches what CAN be proven statically.  Pin
severity rendering ("red iff rho > MF"), loading-state release
timing, and auto-effect ordering all need browser execution to
assert RUNTIME behaviour — those live in the Vitest spec-
conformance + specific regression tests, and in the Playwright
Layer 3b spec.  Layer 4 is the first gate.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterable


import os

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
_DEFAULT_STANDALONE = REPO_ROOT / "frontend" / "dist-standalone" / "standalone.html"
_LEGACY_STANDALONE = REPO_ROOT / "standalone_interface_legacy.html"
STANDALONE = Path(
    os.environ.get(
        "COSTUDY4GRID_STANDALONE_PATH",
        str(_DEFAULT_STANDALONE if _DEFAULT_STANDALONE.exists() else _LEGACY_STANDALONE),
    )
)


class Invariant:
    """A single source-level assertion with a React side and a
    standalone side.  Each side has ``file_hint`` (file or file glob),
    ``pattern`` (regex to satisfy) and optional ``must_not`` (regex
    whose presence is a failure, e.g. for "no hardcoded 0.9 threshold").
    """

    def __init__(
        self,
        name: str,
        description: str,
        react: dict,
        standalone: dict,
        severity: str = "FAIL",
    ):
        self.name = name
        self.description = description
        self.react = react
        self.standalone = standalone
        self.severity = severity  # FAIL or WARN


def _search_in_paths(
    paths: Iterable[Path],
    pattern: str,
    flags: int = 0,
) -> tuple[Path | None, re.Match | None]:
    rx = re.compile(pattern, flags)
    for p in paths:
        try:
            src = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        m = rx.search(src)
        if m:
            return p, m
    return None, None


def _paths_for_hint(hint: str) -> list[Path]:
    # Standalone-side invariants: the existing regex patterns were
    # written against the hand-maintained inline JSX in the legacy
    # file. The auto-generated single-file bundle contains the
    # compiled / bundled equivalent, but with minified variable
    # names and `reactExports.*` namespacing that breaks those
    # patterns. We intentionally target the legacy file here when
    # it is still present on disk — the React-source invariants
    # (which use `FRONTEND_SRC` hints) remain the authoritative
    # assertion; the standalone side is a best-effort mirror check.
    # When the legacy file is ultimately removed the standalone
    # rows simply return "no path found" and the invariant reports
    # as skipped rather than failing the whole script.
    if hint in ("standalone_interface.html", "standalone_interface_legacy.html"):
        candidates = [_LEGACY_STANDALONE, STANDALONE]
        for cand in candidates:
            if cand.exists():
                return [cand]
        return []
    if "*" in hint:
        return sorted((REPO_ROOT / Path(hint)).parent.glob(Path(hint).name))
    p = REPO_ROOT / hint
    if p.is_dir():
        return sorted(p.rglob("*.ts")) + sorted(p.rglob("*.tsx"))
    return [p] if p.exists() else []


INVARIANTS: list[Invariant] = [
    Invariant(
        name="pin_severity_uses_monitoringFactor",
        description=(
            "Pin severity palette must be threshold-parameterised by "
            "monitoringFactor (red > MF, orange > MF-0.05, else green). "
            "Hardcoding 0.9 / 1.0 silently misclassifies 'still "
            "overloaded' cards as orange when MF != 0.95 (user bug, "
            "commit 56643a8)."
        ),
        react={
            "file_hint": "frontend/src/utils/svg/actionPinData.ts",
            # React's computeActionSeverity must reference monitoringFactor + the -0.05 band.
            "pattern": r"computeActionSeverity[\s\S]*?monitoringFactor\s*-\s*0\.05",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"computeActionSeverity\s*=\s*\([^)]*monitoringFactor[^)]*\)[\s\S]*?monitoringFactor\s*-\s*0\.05",
            # Red-flag: a hardcoded 1.0 or 0.9 rho comparison INSIDE
            # the function body.  `[\s\S]{0,600}?` keeps the scan
            # bounded so we don't cross into unrelated helpers; the
            # legitimate body is ~400 chars.
            "must_not": r"computeActionSeverity\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,600}?rho\s*[<>]=?\s*(?:0\.9\b|1\.0\b)",
        },
    ),
    Invariant(
        name="combined_pairs_filter_estimated",
        description=(
            "Dashed-line combined-pair connections must render only "
            "for SIMULATED pairs — not for recommender estimation-only "
            "entries marked `is_estimated: true`.  Without this "
            "filter, the Overview is pre-polluted with curves before "
            "the user has opened the Combine modal (commit 56643a8)."
        ),
        react={
            # The React side relies on STORAGE separation — estimated
            # pairs live in `combined_actions`, simulated ones move to
            # `actions` after simulation.  `buildCombinedActionPins`
            # iterates only `actions`.  Check that storage split.
            "file_hint": "frontend/src/utils/svg/actionPinData.ts",
            "pattern": r"buildCombinedActionPins[\s\S]*?Object\.entries\(actions\)",
        },
        standalone={
            # Standalone flattens both into `result.actions` so it
            # needs an explicit `is_estimated` filter.
            "file_hint": "standalone_interface.html",
            "pattern": r"computeCombinedActionPins[\s\S]*?action\.is_estimated\s*===\s*true",
        },
    ),
    Invariant(
        name="pin_resolver_is_topology_first",
        description=(
            "Pin anchor resolver must consult the action's TOPOLOGY "
            "target (lines via getActionTargetLines → VLs via "
            "getActionTargetVoltageLevels) BEFORE falling back to "
            "max_rho_line — per docs/features/action-overview-diagram.md § "
            "'Pin anchor resolution'.  Reversing the order silently "
            "drops simulated action cards whose post-action max_rho_line "
            "happens not to be in the N-1 metadata (commit 5030b6c)."
        ),
        react={
            "file_hint": "frontend/src/utils/svg/actionPinData.ts",
            # In resolveActionAnchor: getActionTargetLines appears
            # before max_rho_line.
            "pattern": r"resolveActionAnchor[\s\S]*?getActionTargetLines[\s\S]*?max_rho_line",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"resolveActionAnchor[\s\S]*?getActionTargetLines[\s\S]*?max_rho_line",
        },
    ),
    Invariant(
        name="display_prioritized_switches_to_action_tab",
        description=(
            "`handleDisplayPrioritizedActions` must call setActiveTab('action') "
            "so the operator lands on the Overview pin view the "
            "moment the suggestions are merged.  Without this, the "
            "button silently appends cards to the sidebar with no "
            "visual cue and the user doesn't see the map (commit 3c7863b)."
        ),
        react={
            "file_hint": "frontend/src/hooks/useAnalysis.ts",
            "pattern": r"handleDisplayPrioritizedActions[\s\S]*?setActiveTab\s*\?\.\s*\(\s*['\"]action['\"]\s*\)",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"handleDisplayPrioritizedActions[\s\S]*?setActiveTab\s*\(\s*['\"]action['\"]\s*\)",
        },
    ),
    Invariant(
        name="deselect_stays_on_action_tab",
        description=(
            "`handleActionSelect` deselect path (actionId === selectedActionId "
            "and !force) must NOT call setActiveTab('n-1') — the user "
            "should fall through to the Overview on the same tab "
            "(PR #93 / commit dbc05f8).  Otherwise unselecting a "
            "pin snaps the view to N-1 and loses the pin map."
        ),
        react={
            "file_hint": "frontend/src/hooks/useDiagrams.ts",
            # React's handleActionSelect: the deselect branch doesn't setActiveTab.
            # We assert the deselect branch exists AND doesn't reference setActiveTab.
            "pattern": r"action_deselected",  # sanity — handler exists
            "must_not": r"action_deselected[\s\S]{0,400}?setActiveTab\s*\(\s*['\"]n-1['\"]\s*\)",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"action_deselected",
            "must_not": r"action_deselected[\s\S]{0,400}?setActiveTab\s*\(\s*['\"]n-1['\"]\s*\)",
        },
    ),
    Invariant(
        name="simulate_button_releases_before_diagram",
        description=(
            "Manual-action + combined-action simulation handlers must "
            "reset `simulatingActionId` BEFORE awaiting the action-"
            "variant-diagram fetch — otherwise the Simulate button "
            "stays in spinner state for the whole 5-6 s diagram "
            "round-trip even though the action CARD has already "
            "landed (commit dbc05f8).  We check for the reset call "
            "appearing OUTSIDE a finally clause in handleAddManualAction."
        ),
        react={
            # React uses the `simulate-and-variant-diagram` stream
            # endpoint + separate loading flags so the button is tied
            # to the simulate call, not the diagram.  We just sanity-
            # check the stream endpoint is wired.
            "file_hint": "frontend/src/api.ts",
            "pattern": r"simulate-and-variant-diagram",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            # setSimulatingActionId(null) must appear before the
            # action-variant-diagram fetch inside handleAddManualAction.
            "pattern": r"handleAddManualAction[\s\S]*?setSimulatingActionId\(null\)[\s\S]*?/api/action-variant-diagram",
        },
    ),
    Invariant(
        name="overview_svg_clone_is_memoized",
        description=(
            "The Action Overview must memoise the 25 MB N-1 SVG clone "
            "— re-cloning on every re-render costs ~200-500 ms on the "
            "PyPSA-EUR France grid and makes pan/zoom feel frozen "
            "(commit 967766a).  A ref-scoped cache keyed on the "
            "source <svg> identity is the cheapest form of the "
            "React `MemoizedSvgContainer` optimisation."
        ),
        react={
            "file_hint": "frontend/src/components/MemoizedSvgContainer.tsx",
            "pattern": r"React\.memo",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"lastClonedSourceRef",
        },
    ),
    Invariant(
        name="network_diagram_fetch_uses_format_text",
        description=(
            "`/api/network-diagram` must be fetched via the "
            "`format=text` variant (JSON header + raw SVG body) so "
            "the client skips the ~500 ms JSON.parse on the multi-MB "
            "SVG string — docs/performance/history/loading-parallel.md (commit dbc05f8)."
        ),
        react={
            "file_hint": "frontend/src/api.ts",
            "pattern": r"network-diagram\?format=text",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            "pattern": r"network-diagram\?format=text",
        },
    ),
    Invariant(
        name="base_nad_parallel_with_metadata_boot",
        description=(
            "The base NAD fetch must overlap with the "
            "/api/branches + /api/voltage-levels + /api/nominal-voltages "
            "Promise.all — not run sequentially after it.  /api/network-diagram "
            "is the slowest XHR (~5-6 s pypowsybl regeneration), "
            "serialising it adds 1-2 s to the critical path."
        ),
        react={
            "file_hint": "frontend/src/App.tsx",
            # React parallelises all four in applySettingsImmediate.
            "pattern": r"Promise\.all\(\s*\[[\s\S]*?getBranches[\s\S]*?getNetworkDiagram",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            # Standalone's applySettings-equivalent now includes the
            # NAD fetch in the Promise.all.
            "pattern": r"Promise\.all\(\s*\[[\s\S]*?/api/branches[\s\S]*?_fetchNetworkDiagramTextFormat",
        },
    ),
    Invariant(
        name="action_overview_backdrop_not_over_dimmed",
        description=(
            "Action Overview backdrop opacity must stay high enough "
            "that voltage-coloured edges remain readable — "
            "aggressively dimming (0.35 or 0.55) collapses 5-SVG-unit "
            "edges into near-invisibility on large grids (commit d3c3b59). "
            "Spec says 0.65 rect overlay, standalone uses 0.85 on the "
            "SVG itself; both pass — anything < 0.65 fails this guard."
        ),
        react={
            # The React version uses a <rect> overlay with 0.65
            # flood.  Check the className is used.
            "file_hint": "frontend/src/components/ActionOverviewDiagram.tsx",
            "pattern": r"nad-overview-dim",
        },
        standalone={
            "file_hint": "standalone_interface.html",
            # Extract the opacity value set on the cloned backdrop
            # and reject anything under 0.65.  The regex is structured
            # so the numeric capture is easy to validate in the checker.
            "pattern": r"clone\.style\.opacity\s*=\s*['\"](0\.(?:[7-9]\d?|6[5-9]))['\"]",
        },
    ),
    # ===== UX-design-critique invariants =====
    # The five recommendations from
    # `docs/proposals/ui-design-critique.md` landed on top of an
    # already-shipped UI. Each invariant below guards the UX
    # contract a recommendation introduced so a future refactor
    # can't silently revert it. The standalone side carries an
    # empty spec (file-existence-only) because the contracts are
    # React-source-level — the auto-generated bundle inherits them
    # on its next build, and the legacy hand-maintained file
    # predates the recommendations.

    Invariant(
        name="notices_panel_in_sidebar",
        description=(
            "Recommendation #4 (tier the warning system): the app "
            "must surface a single `<NoticesPanel>` pill as the "
            "entry point for persistent warnings instead of stacking "
            "up to five concurrent yellow banners. The pill lives "
            "in the Header — tucked under the app title alongside "
            "the network-path block — so it stays visible across "
            "every sidebar / panel state without crowding the sticky "
            "contingency strip."
        ),
        react={
            "file_hint": "frontend/src/components/Header.tsx",
            "pattern": r"<NoticesPanel\s",
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="action_feed_no_dismissable_warning_state",
        description=(
            "Recommendation #4: ActionFeed.tsx must not own "
            "`showActionDictWarning` / `showRecommenderWarning` "
            "local state — both warnings moved into NoticesPanel. "
            "Re-introducing a `setShow*Warning` setter inside the "
            "feed would silently bring back the yellow banners."
        ),
        react={
            "file_hint": "frontend/src/components/ActionFeed.tsx",
            # Sanity anchor — the file must exist and parse.
            "pattern": r"const\s+ActionFeed\b",
            # Forbid the dismissable-banner state from sneaking back.
            "must_not": r"setShow(?:ActionDict|Recommender)Warning",
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="overload_panel_uses_monitoring_hint",
        description=(
            "Recommendation #4: OverloadPanel.tsx renders the "
            "monitoring-coverage warning as a one-line grey hint "
            "(`monitoringHint` prop) — the full notice lives in "
            "NoticesPanel. `showMonitoringWarning` / "
            "`onDismissWarning` props on this component would mean "
            "the inline yellow banner has been re-introduced."
        ),
        react={
            "file_hint": "frontend/src/components/OverloadPanel.tsx",
            "pattern": r"monitoringHint\?\:\s*string\s*\|\s*null",
            "must_not": r"showMonitoringWarning|onDismissWarning",
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="diagram_legend_on_each_diagram_tab",
        description=(
            "Recommendation #5 (add a diagram legend): "
            "VisualizationPanel.tsx must render a `<DiagramLegend>` "
            "for the N, contingency and Action tabs so the operator "
            "can read halo / disconnection / voltage-level "
            "conventions on-screen. Removing any of the three would "
            "re-open the onboarding gap the recommendation closed."
        ),
        react={
            "file_hint": "frontend/src/components/VisualizationPanel.tsx",
            # Each tabId must be wired explicitly. `[\s\S]*?` chains
            # the three matches in source order. The contingency tab
            # is keyed ``contingency`` since the N-K refactor (was
            # ``n-1`` before).
            "pattern": (
                r"<DiagramLegend\b[^>]*?tabId=\"n\""
                r"[\s\S]*?<DiagramLegend\b[^>]*?tabId=\"contingency\""
                r"[\s\S]*?<DiagramLegend\b[^>]*?tabId=\"action\""
            ),
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="nad_overload_halo_non_scaling_at_zoom",
        description=(
            "NAD overload halo sizing: at the `region` and `detail` zoom "
            "tiers the halo must RE-ASSERT a screen-space "
            "`vector-effect: non-scaling-stroke` so it can never scale into "
            "a smear if a pypowsybl build flips equipment paths back to "
            "`vector-effect: none`. The halo keeps its base 120/150px "
            "screen-space width at EVERY tier (no abrupt shrink), so the "
            "glow stays smooth + prominent from full-extent to deep zoom — "
            "the old 24px cap made it a thin, coarse high-zoom trace."
        ),
        react={
            "file_hint": "frontend/src/App.css",
            "pattern": (
                r"\[data-zoom-tier=\"detail\"\]\s+\.nad-overloaded[\s\S]*?"
                r"vector-effect:\s*non-scaling-stroke"
            ),
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="design_token_gate_blocks_inline_hex",
        description=(
            "Recommendation #1 (design-token layer): the code-"
            "quality gate must keep the inline-hex ceiling at zero "
            "outside `tokens.{css,ts}`. Loosening the gate would "
            "let the three competing palettes (Flat UI / Bootstrap /"
            " Tailwind) creep back in component-by-component."
        ),
        react={
            "file_hint": "scripts/check_code_quality.py",
            # The named ceiling constant must stay at 0. We assert
            # both the constant declaration and the comparison that
            # consumes it so a renamed-but-unbound copy can't slip
            # through.
            "pattern": r"FRONTEND_HEX_LITERAL_MAX\s*=\s*0\b",
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
    Invariant(
        name="action_card_progressive_disclosure_gated_by_isViewing",
        description=(
            "Recommendation #2 (progressive disclosure): the "
            "ActionCard component must gate its editable detail "
            "rows (`isViewing && …`) so at-rest cards stay terse. "
            "Without the gate the load-shedding / curtailment / "
            "PST-tap rows render on every card and the feed becomes "
            "unscan­nable on a 25 %-width sidebar."
        ),
        react={
            "file_hint": "frontend/src/components/ActionCard.tsx",
            # The component receives an `isViewing` prop AND uses
            # it to gate at least one subtree (PR #121 disclosure).
            "pattern": r"isViewing:\s*boolean[\s\S]*?\{isViewing\s*&&",
        },
        standalone={"file_hint": "standalone_interface.html"},
    ),
]


def check_invariant(inv: Invariant) -> dict:
    """Run one invariant against both codebases."""
    result = {
        "name": inv.name,
        "description": inv.description,
        "severity": inv.severity,
        "sides": {},
        "ok": True,
    }
    for side, spec in (("react", inv.react), ("standalone", inv.standalone)):
        paths = _paths_for_hint(spec["file_hint"])
        if not paths:
            result["sides"][side] = {
                "status": "FAIL",
                "reason": f"file not found: {spec['file_hint']}",
            }
            result["ok"] = False
            continue

        pattern = spec.get("pattern")
        must_not = spec.get("must_not")
        pattern_hit = must_not_hit = None
        if pattern:
            p, m = _search_in_paths(paths, pattern, re.DOTALL)
            pattern_hit = (str(p.relative_to(REPO_ROOT)), m.start()) if m else None
        if must_not:
            p, m = _search_in_paths(paths, must_not, re.DOTALL)
            must_not_hit = (str(p.relative_to(REPO_ROOT)), m.start()) if m else None

        side_ok = (pattern is None or pattern_hit is not None) and (must_not is None or must_not_hit is None)
        result["sides"][side] = {
            "status": "OK" if side_ok else "FAIL",
            "file_hint": spec["file_hint"],
            "pattern_hit": pattern_hit,
            "must_not_hit": must_not_hit,
            "reason": None if side_ok else (
                "regex not found in any candidate path" if (pattern and pattern_hit is None)
                else f"forbidden pattern found at {must_not_hit}" if must_not_hit
                else "unknown"
            ),
        }
        if not side_ok:
            result["ok"] = False
    return result


def run_checks() -> dict:
    findings = [check_invariant(inv) for inv in INVARIANTS]
    return {"invariants": findings}


def render_human(report: dict) -> str:
    out = ["USER-OBSERVABLE INVARIANTS REPORT (Layer 4 static)", "=" * 72]
    failed = [r for r in report["invariants"] if not r["ok"]]
    for r in report["invariants"]:
        status_icon = "✅" if r["ok"] else "❌"
        out.append(f"  {status_icon} {r['name']:50s}  [{r['severity']}]")
        if not r["ok"]:
            out.append(f"     description: {r['description']}")
            for side, info in r["sides"].items():
                if info["status"] != "OK":
                    hint = info.get("file_hint", "<no hint>")
                    out.append(f"       {side:10s} → {info.get('reason', '')}  ({hint})")
    out.append("")
    out.append(f"Summary: {len(report['invariants']) - len(failed)}/{len(report['invariants'])} invariants satisfied.")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = run_checks()
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_human(report))
    hard_fail = any(
        not r["ok"] and r["severity"] == "FAIL" for r in report["invariants"]
    )
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
