"""Compact comparison table: one row per scenario, one column group per variant.

Usage: python3 compact.py label=file.json [...]
Cells: "first ms · fps · done" for gestures, "ms" for jumps.
"""
import json
import statistics as st
import sys

pairs = [a.split("=", 1) for a in sys.argv[1:]]
runs = []
for label, fn in pairs:
    by = {}
    for r in json.load(open(fn))["results"]:
        by.setdefault(r["name"], []).append(r)
    runs.append((label, by))


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def done(r, n):
    c = r.get("completeness")
    if c is not None and r.get("doneVersion") != 2 and not n.startswith("zoom"):
        c = c * 0.7756
    return c


LABELS = {
    "zoom_in_burst": "Zoom-in burst (16 notches)",
    "zoom_out_burst": "Zoom-out burst (20 notches)",
    "zoom_in_smooth": "Smooth zoom-in (trackpad-like)",
    "zoom_in_notches": "Notch-by-notch zoom (300 ms apart)",
    "pan_overview": "Pan at full extent",
    "pan_region": "Pan at region zoom (~35 %)",
    "pan_detail": "Pan at detail zoom (~12 %)",
    "pan_deep": "Pan at reading zoom (~4 %, text drawn)",
    "zoom_in_deep": "Zoom into reading zoom (10 notches)",
    "navigate_region": "Navigate across Europe (4 drags)",
    "unzoom_click": "Unzoom button",
    "inspect_jump": "Inspect → zoom to element",
    "tab_return_n": "Return to the N tab",
}
names = [n for n in LABELS if any(n in by for _, by in runs)]
print("| Scenario | " + " | ".join(lab for lab, _ in runs) + " |")
print("|---|" + "---|" * len(runs))
for n in names:
    cells = []
    for _, by in runs:
        rs = by.get(n)
        if not rs:
            cells.append("–")
            continue
        if "inputToPaintedMs" in rs[0]:
            v = med([r.get("inputToPaintedMs") for r in rs])
            cells.append(f"{v:.0f} ms" if v is not None else "–")
            continue
        first = med([r["firstVisualMs"] for r in rs])
        fps = med([r["fps"] for r in rs])
        d = med([done(r, n) for r in rs])
        if first is None or fps is None:
            cells.append("–")
        else:
            cells.append(f"{first:.0f} ms · {fps:.1f} fps" + (f" · {d:.2f}" if d is not None else ""))
    print(f"| {LABELS[n]} | " + " | ".join(cells) + " |")
