# Temporary probe (dcn5 lane): time press -> mic open -> session.started on a real runner,
# and count how often the old smoke order (stop right after the posts) loses the session.
import json, subprocess, sys, threading, time

helper, keys, mode, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

def once(mode):
    p = subprocess.Popen([helper, "dictate", "--hotkey", "Control+Shift+Space", "--warm", "off"],
                         stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    lines = []
    def read():
        for l in p.stderr:
            lines.append((time.monotonic(), l.strip()))
    t = threading.Thread(target=read, daemon=True); t.start()
    def seen(s): return next((ts for ts, l in lines if s in l), None)
    end = time.monotonic() + 10
    while seen('"type":"ready"') is None and time.monotonic() < end: time.sleep(0.005)
    t0 = time.monotonic()
    subprocess.run([keys], stdout=subprocess.DEVNULL)
    t_keys = time.monotonic()
    if mode == "new":
        end = time.monotonic() + 10
        while seen('"type":"session.started"') is None and time.monotonic() < end: time.sleep(0.005)
    t_stop = time.monotonic()
    p.stdin.write('{"type":"stop"}\n'); p.stdin.flush(); p.stdin.close()
    p.wait(); t.join(2)
    ms = lambda x: None if x is None else round((x - t0) * 1000)
    r = {"mode": mode, "ok": seen('"type":"session.started"') is not None,
         "press": ms(seen('"type":"press"')), "mic_open": ms(seen('"open":true')),
         "started": ms(seen('"type":"session.started"')), "keys_done": ms(t_keys), "stop": ms(t_stop)}
    print(json.dumps(r), flush=True)
    if not r["ok"]:
        for ts, l in lines: print("   ", ms(ts), l[:160])
    return r

rs = [once("old")]  # the first open on this runner, as in CI
for i in range(n):
    rs.append(once(mode if mode != "both" else ("old" if i % 2 == 0 else "new")))
for m in ("old", "new"):
    sel = [r for r in rs if r["mode"] == m]
    if sel:
        print(f"SUMMARY {m}: {sum(not r['ok'] for r in sel)} of {len(sel)} without session.started; "
              f"open->started ms {sorted(r['started'] - r['mic_open'] for r in sel if r['ok'])}")
