"""Summarize drive.mjs result files: median over reps per scenario."""
import json, sys, statistics as stt
files = sys.argv[1:]
rows = []
def med(xs):
    xs = [x for x in xs if x is not None]
    return stt.median(xs) if xs else None
def fmt(v, nd=0):
    if v is None: return '–'
    return f"{v:.{nd}f}" if isinstance(v, (int, float)) else str(v)
for f in files:
    d = json.load(open(f))
    tag = f"{d['hw']}/{d['mode']}" + (f"+{d['exp']}" if d.get('exp') else '')
    by = {}
    for r in d['results']:
        by.setdefault(r['name'], []).append(r)
    print(f"\n### {tag}  ({f.split('/')[-1]})")
    if d.get('load'):
        L = d['load']; print(f"load click→N mounted {L.get('nMount',0)-L.get('click',0):.0f} ms; N tab first display {d['tabSwitch'].get('clickToPaint',0):.0f} ms; proxy {d.get('proxyStats')}")
    print("| scenario | first frame ms | fps | p50 ms | p90 ms | max ms | upd/s | done | flips | settle+ms | settle frame |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for n, rs in by.items():
        if 'inputToPaintedMs' in rs[0]:
            print(f"| {n} | input→painted {fmt(med([r['inputToPaintedMs'] for r in rs]))} ms | change frame {fmt(med([r['changeFrameMs'] for r in rs]))} ms | | | | | | | | |")
            continue
        ups = [r['visualUpdates'] / max(1, r['gestureMs']) * 1000 for r in rs]
        def done(r):
            c = r.get('completeness')
            # v1 results measured pans against usePanZoom's own (meet-unaware) scale.
            if c is not None and r.get('doneVersion') != 2 and not n.startswith('zoom'):
                c = c * 0.7756
            return c
        print(f"| {n} | {fmt(med([r['firstVisualMs'] for r in rs]))} | {fmt(med([r['fps'] for r in rs]),1)} | {fmt(med([r['frameMs']['p50'] for r in rs]))} | {fmt(med([r['frameMs']['p90'] for r in rs]))} | {fmt(med([r['frameMs']['max'] for r in rs]))} | {fmt(med(ups),1)} | {fmt(med([done(r) for r in rs]),2)} | {fmt(med([r.get('cullFlips') for r in rs]))} | {fmt(med([r['settleAfterLastInputMs'] for r in rs]))} | {fmt(med([r['settleFrameMs'] for r in rs]))} |")
