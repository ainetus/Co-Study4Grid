# Action card — readable names, pictograms, grouped outcome

The remedial-action card (`frontend/src/components/ActionCard.tsx`, shared by
the Action feed and the overview-pin popover `ActionCardPopover`) names what
an action acts on instead of its raw id, says the rest with pictograms that
recall their meaning on hover, and groups the information in the order the
operator reads it.

## Before / after

Before, on the 1 July 2025 Les Attaques – Mandarins case (a breaker opened by
hand on the Mandarins 400 kV SLD):

```
(x) #1 — user_topo_VL_way_1271288345-400_1795338763679
    Max loading: 138.6% on ATTAQL61MANDA
    ─────────────────────────────────────
    Manoeuvre manuelle sur VL_way_1271288345-400:
    VL_way_1271288345-400_BK_relation_5674501-400_s1 ouvert
    Overload loading after: MANDAL71WARAN: 1.1% — open one end · 19.9 MVAr capacitive
    Source: Manual simulation (user)
```

After:

```
(x) #1 ┆ MANDARINS 400kV                                   ☆ ✕
        Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur MANDAL71WARAN ouvert
      ┌──────────────────────────────────────────────┐
      │ ◠ 138.6%  ATTAQL61MANDA                       │
      │ ⋀ 1.1%  MANDAL71WARAN  [⌐ open one end · 19.9 MVAr] │
      └──────────────────────────────────────────────┘
        👤 Manual simulation (user)      user_topo_VL_way_12… ⧉
```

## Layout — the order the operator reads

1. **Outcome first, in its own column**: the severity pictogram (✓ solves /
   ! low margin / ✕ still overloaded, divergent, islanded), colour-coded,
   wording in its tooltip. It sits in a column of its own so the eye scans
   the outcomes down the feed, and every line of text starts on one left
   edge.
2. **What** — the title row: rank (`#1`, muted), the action-type
   pictogram(s) (`ActionTypeIcon`, tooltip `ACTION_TYPE_LABELS`), then the
   **names of the elements the action acts on**. The raw action id is the
   title's tooltip. The star / reject rail stays at the right, revealed on
   hover.
3. **How** — the description, right under the title: one line at rest
   (ellipsis, full text on hover), in full on the viewing card (the raw
   description on hover when names replaced ids).
4. **Outcome in figures** — one loading group: the max loading (gauge
   pictogram, value in the severity colour, the worst line as a link) and,
   on the viewing card, the loading after the action of each line the
   contingency overloads (peak-line pictogram, each value in its own
   severity colour, a half-open line flagged by an "open one end · MVAr"
   chip whose tooltip explains the charging current). Both rows read alike:
   the rate first, then the line. When the most loaded line is still the
   overloaded one (same line, same value), the second row would only repeat
   the first: it is left out and the max-loading row says *still the most
   loaded* (taking the half-open chip along, when there is one). On the
   viewing card the group is a framed panel: same kind of information, one
   place.
5. **The rest** — location chips (where an injection sits), fault pills
   (load-flow failure, islanding, pre-existing N overloads), the parameter
   editors (shedding / curtailment / redispatch MW, PST tap), and last the
   provenance: source pictogram (a person for a manual simulation, a chip
   for a recommender model) and the raw action id with a copy button.

Progressive disclosure is kept: at rest a card is three lines (title,
description, max loading); the editors, the overloads-after line and the
provenance only open on the viewing card.

## Design principles applied

No design skill was available when this landed, so the redesign states its
principles explicitly:

- **Names over ids.** Everything the operator reads is a name; every id
  stays one hover (tooltip) or one click (copy) away for traceability.
- **Each name once.** The elements an action acts on form its title and are
  links (click: zoom; double-click a voltage level: its SLD) — the chip row
  that repeated them is gone. Only a location the title does not name (the
  voltage level of a shed load) keeps a chip, with a pin pictogram.
- **Pictograms replace repeated labels** ("Max loading:", "Overload loading
  after:", "Source:"), each with a tooltip spelling out its meaning; no
  pictogram means two things (the overloads-after glyph is a line with a
  loading peak, not the arrow-onto-a-bar of load shedding). Emoji
  affordances (⭐ ❌ ⚠️ 🏝️ ℹ️) became monochrome glyphs (`Glyph.tsx`) in the
  `ActionTypeIcon` / `SeverityIcon` family.
- **Group by kind of information**: description with the title; max loading
  with the overloads after; attribution last.
- **Tokens only**, so both themes follow (`colors` / `radius` / `text` from
  `styles/tokens.ts`; no hex literal).

## Where the names come from

| On the card | Source |
|---|---|
| Title — lines, coupled voltage levels, shed loads, curtailed / redispatched generators | `utils/actionLabels.collectActionTargets` (the former badge logic, plus the voltage level a `user_topo_<vl>_<ts>` manoeuvre was built on) read through `displayName` |
| Location chips | the voltage levels of the injection details |
| Description | the backend's `description_unitaire`, every known id replaced by its name (`humanizeIds`, display only) |
| Manual-action description | built by the backend in names: `Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur MANDAL71WARAN ouvert` (`simulation_helpers.describe_manual_action`) |
| Dictionary coupling description | the step-2 enrichment drops the coupler's switch id (`action_enrichment.name_switches_in`): `Ouverture du couplage dans le poste 'MANDARINS 400kV'` |

`displayName` reads the `/api/branches` name map, which carries the display
names of the branches **and of the generators and loads** (own name, else
the plant matched in `power_plants.json`, else `Generator — MANDARINS
400kV`); the voltage-level names come from `/api/voltage-levels`. The naming
rules live in `expert_backend/services/element_names.py` and
`services/equipment_names.py` — see
[`sld-diagram-feeder-labels.md`](sld-diagram-feeder-labels.md) § 4.

The stored description, the session file and the interaction log keep what
they always carried; the action-type classifier still reads the description
(each switch clause of a manual description ends with its state word,
`ouvert` / `fermé`, and a coupling switch is named "… de couplage").

## Tests

`ActionCard.test.tsx` (layout order, readable title / manual title /
description / location chip / fallbacks, pictograms and their tooltips, the
copy button), `utils/actionLabels.test.ts`, the progressive-disclosure spec
in `uxConsistency.test.tsx`, and the provenance end-to-end
`App.actionOrigin.test.tsx`.
