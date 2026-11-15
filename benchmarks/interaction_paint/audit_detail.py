"""One-run detail table: rows = gesture scenarios, columns = frame stats + freeze after."""
import json
import statistics as st
import sys

fn = sys.argv[1]
by = {}
for r in json.load(open(fn))["results"]:
    by.setdefault(r["name"], []).append(r)


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def post_max(r):
    ts = []
    for tok in (r.get("timeline") or "").split():
        try:
            ts.append(int(tok.split(":")[0]))
        except ValueError:
            pass
    g = r.get("gestureMs") or 0
    gaps = [ts[i + 1] - ts[i] for i in range(len(ts) - 1) if ts[i] >= g - 20]
    return max(gaps) if gaps else None


NAMES = [("zoom_in_burst", "Zoom-in burst"), ("zoom_out_burst", "Zoom-out burst"), ("zoom_in_smooth", "Smooth zoom-in"),
         ("pan_overview", "Pan at full extent"), ("pan_region", "Pan at region zoom"), ("pan_detail", "Pan at detail zoom"),
         ("navigate_region", "Navigate across Europe")]
print("| Scenario | p50 / p90 / max frame | picture updates /s | freeze after |")
print("|---|---|---|---|")
for n, lab in NAMES:
    rs = by.get(n)
    if not rs:
        continue
    p50 = med([r["frameMs"]["p50"] for r in rs]); p90 = med([r["frameMs"]["p90"] for r in rs]); mx = med([r["frameMs"]["max"] for r in rs])
    ups = med([r["visualUpdates"] / max(1, r["gestureMs"]) * 1000 for r in rs])
    fz = med([post_max(r) for r in rs])
    print(f"| {lab} | {p50:.0f} / {p90:.0f} / {mx:.0f} ms | {ups:.1f} | {fz:.0f} ms |")
