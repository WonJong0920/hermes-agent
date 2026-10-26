#!/usr/bin/env python3
"""Per leg: CrBrowserMain top-level tasks (ThreadControllerImpl::RunTask),
excluding DevTools session traffic (the Playwright harness). Prints the max
task, count/sum of tasks >= 50 ms, and the 5 longest with their source."""
import json
import sys

for path in sys.argv[1:]:
    tr = json.load(open(path))
    ev = tr["traceEvents"] if isinstance(tr, dict) else tr
    names = {(e["pid"], e["tid"]): e["args"]["name"] for e in ev if e.get("ph") == "M" and e.get("name") == "thread_name"}
    procs = {e["pid"]: e["args"]["name"] for e in ev if e.get("ph") == "M" and e.get("name") == "process_name"}
    key = [k for k, v in names.items() if v == "CrBrowserMain" and procs.get(k[0]) == "Browser"][0]
    mine = [e for e in ev if (e.get("pid"), e.get("tid")) == key and e.get("ph") == "X"]
    tasks = [e for e in mine if e["name"] == "ThreadControllerImpl::RunTask"]
    devtools = set()
    for e in mine:
        tag = (e.get("args", {}).get("chrome_mojo_event_info") or {}).get("mojo_interface_tag", "")
        if e["name"] == "Receive mojo message" and "DevTools" in tag:
            devtools.add(e["ts"] // 1000)
    def is_dev(t):
        return any(t["ts"] // 1000 <= d <= (t["ts"] + t["dur"]) // 1000 for d in devtools) if t["dur"] > 20000 else False
    real = [t for t in tasks if not is_dev(t)]
    long = sorted(real, key=lambda t: -t["dur"])
    over = [t for t in real if t["dur"] >= 50000]
    print(f"{path.split('/')[-1]}: tasks={len(tasks)} max={long[0]['dur']/1000:.0f}ms >=50ms: n={len(over)} sum={sum(t['dur'] for t in over)/1000:.0f}ms  busy_total={sum(t['dur'] for t in real)/1000:.0f}ms")
    for t in long[:5]:
        a = t.get("args", {})
        print(f"    {t['dur']/1000:6.1f}ms {a.get('src_file','')}:{a.get('src_func','')}")
