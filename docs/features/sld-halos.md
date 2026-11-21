# SLD halos — contingency, overloads and action targets, as on the NAD

The Single Line Diagram (SLD) overlay draws the same halos as the network
diagram (NAD) behind the feeders of the displayed voltage level, with the
same colours and meaning, so a substation opened from the N-1 or the
Remedial action tab reads like the diagram it was opened from.

| Halo | Colour token | NAD class | SLD class | N-1 tab | Action tab |
|------|--------------|-----------|-----------|---------|------------|
| Contingency | `--signal-contingency` (yellow) | `.nad-contingency-highlight` | `.sld-highlight-contingency` | tripped branch(es) | tripped branch(es) |
| Overload | `--signal-overload` (orange) | `.nad-overloaded` | `.sld-highlight-overloaded` | N-1 overloads | lines still overloaded after the action |
| Action target | `--signal-action-target` (pink) | `.nad-action-target` | `.sld-highlight-action` | — | lines / loads / generators / PSTs acted on, coupler of a coupling action |
| Switch | `--signal-breaker` (light purple) | — | `.sld-highlight-breaker` | — | breakers the action changed |

The N sub-tab draws none (no contingency applied there), as on the N NAD.

## Which elements get a halo

The lists come from the helpers the NAD pipeline uses
(`utils/overloadHighlights.ts`), so the two views cannot drift apart:

- **Contingency** — `selectedContingency` (IIDM ids, N-1 or N-K).
- **N-1 overloads** — `computeN1OverloadHighlights(result.lines_overloaded,
  n1Diagram.lines_overloaded, selectedOverloads)`, the list the N-1 NAD and
  the Context tab read. The N-1 diagram reports its overloads as soon as the
  contingency is applied, so the halos are there **before "Analyze &
  Suggest"** (the SLD used to read `result.lines_overloaded` only, and showed
  no overload until an analysis had run). The operator's selection in the
  Overloads panel narrows the list as on the NAD (empty selection = all).
- **Post-action overloads** — `computeActionOverloadHighlights(actionDetail,
  result.lines_overloaded, monitoringFactor)`, shared with the action NAD:
  nothing when the card says "Solved" (`max_rho <= monitoringFactor`), else
  `lines_overloaded_after`, else (legacy / partially enriched results) the
  N-1 overloads whose `rho_after` is still above the factor plus
  `max_rho_line`. Overloads the action resolved get no halo.
- **Action targets** — the action's topology keys (`lines_or_bus`,
  `lines_ex_bus`, `gens_bus`, `loads_bus`, `pst_tap`, `loads_p`, `gens_p`)
  plus the detail arrays (`load_shedding_details`, `curtailment_details`,
  `redispatch_details`, `pst_details`); switches from the SLD response's
  `changed_switches` (else `action_topology.switches`). A coupling action
  draws its coupler in the action-target colour, other switch changes in
  the switch colour. The SLD action is the one the overlay was opened for
  (`vlOverlay.actionId`).

## How a halo lands on a feeder

`components/SldOverlay.tsx` maps each equipment id to its SVG node through
the SLD metadata (`nodes` / `feederInfos` / `feederNodes`, dot↔underscore
variants tolerated), walks up to the enclosing bay (`.sld-extern-cell`,
`.sld-intern-cell`, `.sld-shunt-cell`) and inserts a clone of the bay
**right before it** — same parent, so it follows pan / zoom without any
transform. The clone's strokes take the halo colour (`App.css`), its text is
hidden, and the original bay gets a `-original` class that keeps it fully
opaque in Impacts mode.

- **Friendly names.** An overload reported by its operator name
  (`MARSIL61PRAGN`) is resolved to the IIDM-id-keyed bay through the
  `feeder_labels` map (see [`sld-diagram-feeder-labels.md`](sld-diagram-feeder-labels.md) §2).
- **Both extremities.** The pass runs against whichever VL is displayed, so
  the contingency / overload stays haloed when the operator jumps to the far
  end of the branch by clicking its feeder name.
- **One halo per bay**, first come first served: contingency, then action
  target, then switch, then overload. On the NAD an action target drawn over
  an overload hides it the same way (equal widths).
- **Targets of another voltage level are skipped.** The detail arrays carry
  each load's / generator's `voltage_level_id`; a target of another VL is
  not on this SLD, so it is not looked up at all. The last-resort lookup —
  a `<text>` whose content contains the target's first five characters,
  kept for grids whose SLD metadata ids differ from the action's names
  (`bare_env_small_grid_test`) — only accepts a label inside a feeder bay,
  never a bus-bar title or a halo clone. On PyPSA-EUR grids every id starts
  with `L_way` / `VL_way`, and a load shed at Moisenay used to put a pink
  halo on the Courtry bus-bar title.

## Keeping the halos on screen

The pass is a `useLayoutEffect` with no dependency array: it runs after every
render and self-gates on a signature (SVG / metadata size, tab, action, the
contingency, **the overload list it computed**, changed switches, injection
magnitudes) plus the presence of its clones. A pan that makes React
reconcile the SVG wrapper re-plants the clones at once; the N-1 diagram
arriving after the SLD, or a change of the overload selection, changes the
signature and redraws them.

## Tests

- `components/SldOverlay.test.tsx` — "N-1 halos match the NAD before any
  analysis" (contingency + N-1 diagram overloads with no analysis result,
  overload selection, late N-1 diagram, none on N, contingency kept on the
  action tab), "post-action overload highlight" (incl. the `max_rho_line`
  fallback), "action targets of another voltage level", the LS / curtailment
  / PST fallbacks and the friendly-name bridge.
- `utils/overloadHighlights.test.ts` — `computeN1OverloadHighlights` and
  `computeActionOverloadHighlights`.
- `hooks/useDiagramHighlights.test.ts` — NAD halo order (contingency →
  overload → action).
