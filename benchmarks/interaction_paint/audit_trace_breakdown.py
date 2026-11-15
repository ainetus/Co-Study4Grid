"""Break a Chrome trace of a pan/zoom gesture down by pipeline stage.

Usage: python trace_breakdown.py trace.json [--from-ms X --to-ms Y]

Reports, for the renderer main thread, the SELF time per event name
(stack-based, so nested events are not double counted) and, for the
compositor / raster / GPU threads, the total wall time of their top-level
slices.  Also lists each main-thread frame (BeginMainFrame-ish window) with
its style / layout / prepaint / paint / commit split.
"""
import json
import sys
from collections import defaultdict

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
events = data["traceEvents"] if isinstance(data, dict) else data

threads = {}
procs = {}
for e in events:
    if e.get("ph") == "M":
        if e.get("name") == "thread_name":
            threads[(e["pid"], e["tid"])] = e["args"]["name"]
        elif e.get("name") == "process_name":
            procs[e["pid"]] = e["args"]["name"]

# Pick the renderer main thread that did the most work.
by_thread = defaultdict(float)
for e in events:
    if e.get("ph") == "X" and "dur" in e:
        by_thread[(e["pid"], e["tid"])] += e["dur"]
renderer_mains = [k for k, v in threads.items() if v == "CrRendererMain"]
main = max(renderer_mains, key=lambda k: by_thread.get(k, 0))
rpid = main[0]

# Window: the user-timing-free heuristic = span of EventDispatch(wheel/mousemove)
# on the main thread, unless explicit bounds are given.
lo = hi = None
if "--from-ms" in sys.argv:
    lo = float(sys.argv[sys.argv.index("--from-ms") + 1]) * 1000
    hi = float(sys.argv[sys.argv.index("--to-ms") + 1]) * 1000
inputs = [e for e in events if (e["pid"], e.get("tid")) == main and e.get("name") == "EventDispatch"
          and e.get("args", {}).get("data", {}).get("type") in ("wheel", "mousemove", "mousedown", "mouseup")]
if lo is None and inputs:
    lo = min(e["ts"] for e in inputs) - 5000
    hi = max(e["ts"] + e.get("dur", 0) for e in inputs) + 1_500_000
print(f"renderer pid {rpid}; window {(hi - lo) / 1000:.0f} ms; input events on main: {len(inputs)}")


def complete_events(key):
    """Return X events for a thread, converting B/E pairs."""
    out = []
    stack = []
    for e in events:
        if (e.get("pid"), e.get("tid")) != key:
            continue
        ph = e.get("ph")
        if ph == "X" and "dur" in e:
            out.append((e["ts"], e["ts"] + e["dur"], e["name"], e.get("args", {})))
        elif ph == "B":
            stack.append(e)
        elif ph == "E" and stack:
            b = stack.pop()
            out.append((b["ts"], e["ts"], b["name"], b.get("args", {})))
    out.sort(key=lambda x: (x[0], -(x[1] - x[0])))
    return out


def self_times(evs):
    selfs = defaultdict(float)
    counts = defaultdict(int)
    stack = []  # (end, name, child_time_acc_index)
    acc = []
    for s, t, name, _ in evs:
        if t < lo or s > hi:
            continue
        while stack and stack[-1][0] <= s:
            end, nm, i = stack.pop()
        stack.append((t, name, len(acc)))
        acc.append([name, t - s, 0.0])
    # second pass: proper self time via interval nesting
    selfs = defaultdict(float)
    stack = []
    for s, t, name, _ in evs:
        if t < lo or s > hi:
            continue
        while stack and stack[-1][1] <= s:
            stack.pop()
        dur = t - s
        if stack:
            selfs[stack[-1][2]] -= dur
        selfs[name] += dur
        counts[name] += 1
        stack.append((s, t, name))
    return selfs, counts


main_evs = complete_events(main)
selfs, counts = self_times(main_evs)
total = sum(v for v in selfs.values() if v > 0)
print("\n== Renderer main thread: self time by event (top 28) ==")
for name, v in sorted(selfs.items(), key=lambda x: -x[1])[:28]:
    print(f"  {name:55s} {v / 1000:9.1f} ms  x{counts[name]}")
print(f"  {'TOTAL':55s} {total / 1000:9.1f} ms")

# Per-thread top-level busy time for other renderer/GPU threads.
print("\n== Other threads: busy time (top-level slices) in window ==")
rows = []
for key, nm in threads.items():
    if key == main:
        continue
    evs = complete_events(key)
    busy = 0
    end = -1
    for s, t, name, _ in evs:
        if t < lo or s > hi:
            continue
        if s >= end:
            busy += t - s
            end = t
        elif t > end:
            busy += t - end
            end = t
    if busy > 20_000:
        rows.append((busy, procs.get(key[0], key[0]), nm))
for busy, p, nm in sorted(rows, reverse=True)[:14]:
    print(f"  {str(p)[:22]:22s} {nm:35s} {busy / 1000:9.1f} ms")

# Per-frame breakdown on the main thread: group pipeline stages between
# successive 'UpdateLayoutTree'/'Layout'/'Paint' runs into frames delimited by
# 'Commit' / 'ProxyMain::BeginMainFrame'.
STAGES = ["UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit", "UpdateLayer",
          "HitTest", "FunctionCall", "EventDispatch", "FireAnimationFrame", "IntersectionObserverController::computeIntersections"]
frames = [e for e in main_evs if e[2] in ("ProxyMain::BeginMainFrame", "BeginMainFrame") and lo <= e[0] <= hi]
print(f"\n== Main-thread frames in window: {len(frames)} ==")
for s, t, name, _ in frames[:40]:
    inner = defaultdict(float)
    for s2, t2, n2, _ in main_evs:
        if s2 >= s and t2 <= t and n2 in STAGES:
            inner[n2] += t2 - s2
    parts = " ".join(f"{k}={v / 1000:.0f}" for k, v in sorted(inner.items(), key=lambda x: -x[1]) if v > 1000)
    print(f"  +{(s - lo) / 1000:7.0f} ms  frame {(t - s) / 1000:6.1f} ms  | {parts}")

# Long tasks outside BeginMainFrame (event handlers forcing style/layout).
print("\n== Long main-thread tasks (>30 ms) ==")
for s, t, name, args in main_evs:
    if name in ("ThreadControllerImpl::RunTask", "RunTask") and lo <= s <= hi and t - s > 30_000:
        inner = defaultdict(float)
        for s2, t2, n2, a2 in main_evs:
            if s2 >= s and t2 <= t and n2 in STAGES:
                key = n2
                if n2 == "EventDispatch":
                    key = "EventDispatch:" + a2.get("data", {}).get("type", "")
                inner[key] += t2 - s2
        parts = " ".join(f"{k}={v / 1000:.0f}" for k, v in sorted(inner.items(), key=lambda x: -x[1]) if v > 1000)
        print(f"  +{(s - lo) / 1000:7.0f} ms  task {(t - s) / 1000:6.1f} ms  | {parts}")
