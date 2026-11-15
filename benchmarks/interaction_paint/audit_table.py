"""Build the comparison tables of the audit from result files.

Usage: python3 table.py label=file.json [label=file.json ...]
Prints one markdown table per scenario family with median-over-reps values.
"""
import json
import statistics as st
import sys

pairs = [a.split("=", 1) for a in sys.argv[1:]]
data = []
for label, fn in pairs:
    d = json.load(open(fn))
    by = {}
    for r in d["results"]:
        by.setdefault(r["name"], []).append(r)
    data.append((label, d, by))


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def done(r, n):
    c = r.get("completeness")
    if c is not None and r.get("doneVersion") != 2 and not n.startswith("zoom"):
        c = c * 0.7756
    return c


def post_max(r):
    """Longest frame after the last input (the post-gesture freeze), from the stored timeline."""
    ts = []
    for tok in (r.get("timeline") or "").split():
        try:
            ts.append(int(tok.split(":")[0]))
        except ValueError:
            pass
    g = r.get("gestureMs") or 0
    gaps = [ts[i + 1] - ts[i] for i in range(len(ts) - 1) if ts[i] >= g - 20]
    return max(gaps) if gaps else None


def f(v, nd=0, suf=""):
    if v is None:
        return "–"
    return f"{v:.{nd}f}{suf}"


GESTURES = ["zoom_in_burst", "zoom_out_burst", "zoom_in_smooth", "zoom_in_notches",
            "pan_overview", "pan_region", "pan_detail", "navigate_region"]
JUMPS = ["unzoom_click", "inspect_jump", "tab_return_n"]

for n in GESTURES:
    rows = [(lab, by[n]) for lab, d, by in data if n in by]
    if not rows:
        continue
    print(f"\n**{n}**\n")
    print("| variant | first frame | fps | p50 / p90 / max frame | upd/s | done | freeze after |")
    print("|---|---|---|---|---|---|---|")
    for lab, rs in rows:
        ups = med([r["visualUpdates"] / max(1, r["gestureMs"]) * 1000 for r in rs])
        print(f"| {lab} | {f(med([r['firstVisualMs'] for r in rs]), 0, ' ms')} | {f(med([r['fps'] for r in rs]), 1)} | "
              f"{f(med([r['frameMs']['p50'] for r in rs]))} / {f(med([r['frameMs']['p90'] for r in rs]))} / {f(med([r['frameMs']['max'] for r in rs]))} ms | "
              f"{f(ups, 1)} | {f(med([done(r, n) for r in rs]), 2)} | {f(med([post_max(r) for r in rs]), 0, ' ms')} |")

for n in JUMPS:
    rows = [(lab, by[n]) for lab, d, by in data if n in by]
    if not rows:
        continue
    print(f"\n**{n}** (input → painted)\n")
    print("| variant | input → painted | frame |")
    print("|---|---|---|")
    for lab, rs in rows:
        print(f"| {lab} | {f(med([r.get('inputToPaintedMs') for r in rs]), 0, ' ms')} | {f(med([r.get('changeFrameMs') for r in rs]), 0, ' ms')} |")
