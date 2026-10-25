"""Scores translations into English against a reference subtitle, as docs/research/asr-architecture.md
section 4.1 does: each clip's cues are grouped into 60 s windows by their midpoint, every window is
one segment, and the systems are scored with corpus BLEU and chrF from sacrebleu 2.4.3, per clip
and pooled over every clip, with a paired bootstrap against the first system.

    uv run --with sacrebleu==2.4.3 scripts/eval/translate-score.py \
        --systems canary,whisper \
        --clip ref1.srt canary1.srt whisper1.srt \
        --clip ref2.srt canary2.srt whisper2.srt

A cue file is SRT, WebVTT, or an akou job result as JSON (`GET /v1/jobs/{id}/result`, its
`segments`). Prints one line per clip and system, then the pooled scores as mean and 95 % interval
of the bootstrap with the p-value of each system against the first. Exits 2 on a bad argument and
1 when a reference has no cue, so an empty or misread file never scores as a number.
"""

import argparse
import json
import re
import sys

from sacrebleu.metrics import BLEU, CHRF
from sacrebleu.significance import PairedTest

TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})|(\d{2}):(\d{2})[.](\d{3})")
TAG = re.compile(r"<[^>]*>|\{[^}]*\}")


def seconds(s: str) -> float:
    m = TIME.fullmatch(s.strip().split(" ")[0])
    if not m:
        raise ValueError(f"not a cue time: {s!r}")
    if m.group(1):
        h, mi, se, ms = (int(m.group(i)) for i in range(1, 5))
    else:
        h, (mi, se, ms) = 0, (int(m.group(i)) for i in range(5, 8))
    return h * 3600 + mi * 60 + se + ms / 1000


def cues(path: str) -> list[tuple[float, float, str]]:
    """(start, end, text) of every cue in an SRT, VTT or akou result JSON file."""
    with open(path, encoding="utf-8-sig") as f:
        raw = f.read()
    if path.endswith(".json"):
        return [(s["s"], s["e"], s["text"]) for s in json.loads(raw)["segments"]]
    out = []
    for block in re.split(r"\n\s*\n", raw.replace("\r\n", "\n")):
        lines = [x for x in block.strip().split("\n") if x.strip()]
        at = next((i for i, x in enumerate(lines) if "-->" in x), None)
        if at is None:
            continue
        a, b = lines[at].split("-->")
        text = " ".join(TAG.sub("", x).strip() for x in lines[at + 1 :]).strip()
        if text:
            out.append((seconds(a), seconds(b), text))
    return out


def windows(cs: list[tuple[float, float, str]], size: float) -> dict[int, str]:
    """Each cue's text joined into the window its midpoint falls in."""
    w: dict[int, list[str]] = {}
    for s, e, t in sorted(cs):
        w.setdefault(int((s + e) / 2 // size), []).append(t)
    return {k: " ".join(v) for k, v in w.items()}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--systems", required=True, help="comma-separated names, the first is the baseline")
    p.add_argument("--clip", nargs="+", action="append", required=True, metavar="FILE",
                   help="the reference, then one hypothesis per system")
    p.add_argument("--window", type=float, default=60.0)
    p.add_argument("--samples", type=int, default=2000)
    a = p.parse_args()
    names = a.systems.split(",")
    for c in a.clip:
        if len(c) != len(names) + 1:
            p.error(f"--clip {' '.join(c)}: a reference and {len(names)} hypotheses")

    refs: list[str] = []
    hyps: dict[str, list[str]] = {n: [] for n in names}
    for c in a.clip:
        ref = windows(cues(c[0]), a.window)
        if not ref:
            sys.exit(f"{c[0]}: no cue read")
        sys_w = [windows(cues(h), a.window) for h in c[1:]]
        # Every window either side speaks in: a line invented over music counts against it.
        keys = sorted(set(ref).union(*sys_w))
        clip_ref = [ref.get(k, "") for k in keys]
        refs += clip_ref
        for n, w in zip(names, sys_w):
            h = [w.get(k, "") for k in keys]
            hyps[n] += h
            bleu = BLEU().corpus_score(h, [clip_ref]).score
            chrf = CHRF().corpus_score(h, [clip_ref]).score
            print(f"{c[0]}\t{n}\tBLEU {bleu:.1f}\tchrF {chrf:.1f}\twindows {len(keys)}")

    test = PairedTest([(n, hyps[n]) for n in names], {"BLEU": BLEU(), "chrF": CHRF()},
                      [refs], test_type="bs", n_samples=a.samples)
    _, scores = test()
    for metric, results in scores.items():
        if metric == "System":
            continue
        for n, r in zip(names, results):
            pv = "" if r.p_value is None else f"\tp={r.p_value:.2f}"
            print(f"pooled\t{n}\t{metric} {r.mean:.1f} ±{r.ci:.1f}{pv}\twindows {len(refs)}")


if __name__ == "__main__":
    main()
