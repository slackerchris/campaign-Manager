#!/usr/bin/env python3
"""
Compare two speaker-labeled transcript artifacts.

Expected shape (both files):
{
  "lines": [
    {"start": 0.0, "end": 1.2, "speaker": "S1", "text": "...", "overlap": false}
  ]
}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_lines(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("lines", [])


def duration(lines):
    if not lines:
        return 0.0
    return max(float(l.get("end", 0)) for l in lines) - min(float(l.get("start", 0)) for l in lines)


def speaker_switches_per_min(lines):
    if not lines:
        return 0.0
    switches = 0
    prev = None
    for l in lines:
        s = l.get("speaker")
        if prev is not None and s != prev:
            switches += 1
        prev = s
    mins = max(1e-6, duration(lines) / 60.0)
    return switches / mins


def longest_consistent_block(lines):
    best = 0.0
    cur_s = None
    cur_d = 0.0
    for l in lines:
        s = l.get("speaker")
        d = max(0.0, float(l.get("end", 0)) - float(l.get("start", 0)))
        if s == cur_s:
            cur_d += d
        else:
            best = max(best, cur_d)
            cur_s = s
            cur_d = d
    best = max(best, cur_d)
    return best


def pct_unknown(lines):
    if not lines:
        return 0.0
    u = sum(1 for l in lines if str(l.get("speaker", "")).upper() in {"U", "UNKNOWN"})
    return (u / len(lines)) * 100.0


def overlap_freq(lines):
    if not lines:
        return 0.0
    ov = sum(1 for l in lines if bool(l.get("overlap", False)))
    return (ov / len(lines)) * 100.0


def metrics(lines):
    return {
        "lineCount": len(lines),
        "durationSec": round(duration(lines), 2),
        "switchesPerMin": round(speaker_switches_per_min(lines), 3),
        "longestConsistentBlockSec": round(longest_consistent_block(lines), 2),
        "unknownPct": round(pct_unknown(lines), 2),
        "overlapPct": round(overlap_freq(lines), 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="Artifact A (e.g., LLM-label output)")
    ap.add_argument("--b", required=True, help="Artifact B (e.g., pyannote-merge output)")
    ap.add_argument("--label-a", default="A")
    ap.add_argument("--label-b", default="B")
    args = ap.parse_args()

    a_lines = load_lines(Path(args.a))
    b_lines = load_lines(Path(args.b))

    out = {
        args.label_a: metrics(a_lines),
        args.label_b: metrics(b_lines),
        "diff": {
            "switchesPerMin": round(metrics(b_lines)["switchesPerMin"] - metrics(a_lines)["switchesPerMin"], 3),
            "longestConsistentBlockSec": round(metrics(b_lines)["longestConsistentBlockSec"] - metrics(a_lines)["longestConsistentBlockSec"], 2),
            "unknownPct": round(metrics(b_lines)["unknownPct"] - metrics(a_lines)["unknownPct"], 2),
            "overlapPct": round(metrics(b_lines)["overlapPct"] - metrics(a_lines)["overlapPct"], 2),
        },
    }

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
