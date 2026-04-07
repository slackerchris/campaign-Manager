#!/usr/bin/env python3
"""
Phase-1 diarization sidecar prototype.

Pipeline:
1) ffmpeg preprocess -> mono/16k with light filtering
2) faster-whisper ASR segments
3) pyannote diarization turns
4) weighted overlap + midpoint anchor merge
5) write artifacts

Outputs (default):
- <prefix>-asr-segments.json
- <prefix>-diarization-turns.json
- <prefix>-merged-speakers.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


@dataclass
class AsrSeg:
    start: float
    end: float
    text: str


@dataclass
class DiaTurn:
    start: float
    end: float
    speaker: str


def run_ffmpeg_preprocess(inp: Path, outp: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(inp),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        "loudnorm,highpass=f=100,lowpass=f=8000",
        str(outp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg preprocess failed: {proc.stderr[-1000:]}")


def asr_faster_whisper(audio_path: Path, model: str, device: str, compute_type: str) -> List[AsrSeg]:
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        raise RuntimeError("faster-whisper not installed. pip install faster-whisper") from e

    wm = WhisperModel(model, device=device, compute_type=compute_type)
    segments, _info = wm.transcribe(str(audio_path), vad_filter=True)

    out: List[AsrSeg] = []
    for s in segments:
        txt = (s.text or "").strip()
        if not txt:
            continue
        out.append(AsrSeg(start=float(s.start), end=float(s.end), text=txt))
    return out


def diarize_pyannote(audio_path: Path, hf_token: str, device: str) -> List[DiaTurn]:
    try:
        import torch
        from pyannote.audio import Pipeline
    except Exception as e:
        raise RuntimeError("pyannote.audio not installed. pip install pyannote.audio") from e

    if not hf_token:
        raise RuntimeError("HF token missing. Set --hf-token or HUGGINGFACE_TOKEN")

    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
    if device == "cuda" and torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
    else:
        pipeline.to(torch.device("cpu"))

    diar = pipeline(str(audio_path))
    out: List[DiaTurn] = []
    for turn, _track, speaker in diar.itertracks(yield_label=True):
        out.append(DiaTurn(start=float(turn.start), end=float(turn.end), speaker=str(speaker)))
    return out


def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def merge_segments(
    asr: List[AsrSeg],
    turns: List[DiaTurn],
    overlap_min_sec: float = 0.20,
    overlap_ratio_flag: float = 0.40,
    temporal_bonus: float = 0.10,
) -> List[dict]:
    lines: List[dict] = []
    prev_spk = None

    # stable speaker alias map: raw -> S1/S2/...
    raw_to_s: Dict[str, str] = {}

    def s_label(raw: str) -> str:
        if raw not in raw_to_s:
            raw_to_s[raw] = f"S{len(raw_to_s)+1}"
        return raw_to_s[raw]

    for seg in asr:
        seg_dur = max(1e-6, seg.end - seg.start)
        mid = seg.start + (seg.end - seg.start) / 2.0

        by_speaker: Dict[str, Dict[str, float]] = {}
        for t in turns:
            ov = overlap(seg.start, seg.end, t.start, t.end)
            if ov < overlap_min_sec:
                continue
            item = by_speaker.setdefault(t.speaker, {"ov": 0.0, "mid": 0.0})
            item["ov"] += ov
            if t.start <= mid <= t.end:
                item["mid"] = 1.0

        if not by_speaker:
            lines.append(
                {
                    "start": seg.start,
                    "end": seg.end,
                    "speaker": "U",
                    "speakerRaw": None,
                    "text": seg.text,
                    "overlap": False,
                    "confidence": "low",
                    "score": 0.0,
                }
            )
            prev_spk = "U"
            continue

        scored: List[Tuple[str, float, float]] = []
        for spk, vals in by_speaker.items():
            overlap_ratio = vals["ov"] / seg_dur
            midpoint_anchor = vals["mid"]
            score = overlap_ratio * 0.7 + midpoint_anchor * 0.3
            if prev_spk and spk == prev_spk:
                score += temporal_bonus
            scored.append((spk, score, overlap_ratio))

        scored.sort(key=lambda x: x[1], reverse=True)
        best_spk, best_score, best_ratio = scored[0]
        second_score = scored[1][1] if len(scored) > 1 else 0.0
        overlap_flag = bool(len(scored) > 1 and second_score >= overlap_ratio_flag * max(best_score, 1e-6))

        conf_num = best_ratio
        if best_score >= 0.65:
            conf = "high"
        elif best_score >= 0.35:
            conf = "medium"
        else:
            conf = "low"

        lines.append(
            {
                "start": seg.start,
                "end": seg.end,
                "speaker": s_label(best_spk),
                "speakerRaw": best_spk,
                "text": seg.text,
                "overlap": overlap_flag,
                "confidence": conf,
                "score": round(float(best_score), 4),
                "overlapRatio": round(float(conf_num), 4),
            }
        )
        prev_spk = best_spk

    # simple A-B-A flicker smoothing for low confidence singletons
    for i in range(1, len(lines) - 1):
        a, b, c = lines[i - 1], lines[i], lines[i + 1]
        if a["speaker"] == c["speaker"] and b["speaker"] != a["speaker"] and b.get("confidence") == "low":
            b["speaker"] = a["speaker"]
            b["smoothed"] = True

    return lines


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="Input audio file")
    ap.add_argument("--out-dir", required=True, help="Output directory")
    ap.add_argument("--prefix", default="session", help="Artifact prefix")
    ap.add_argument("--model", default="medium", help="faster-whisper model")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"], help="ASR device")
    ap.add_argument("--compute-type", default="float16", help="faster-whisper compute_type")
    ap.add_argument("--pyannote-device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--hf-token", default=os.getenv("HUGGINGFACE_TOKEN", ""))
    ap.add_argument("--overlap-min-sec", type=float, default=0.20)
    args = ap.parse_args()

    in_audio = Path(args.audio)
    if not in_audio.exists():
        raise SystemExit(f"audio not found: {in_audio}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="dnd-audio-pre-") as td:
        pre = Path(td) / "preprocessed.wav"
        run_ffmpeg_preprocess(in_audio, pre)

        asr = asr_faster_whisper(pre, args.model, args.device, args.compute_type)
        turns = diarize_pyannote(pre, args.hf_token, args.pyannote_device)
        merged = merge_segments(asr, turns, overlap_min_sec=args.overlap_min_sec)

    asr_path = out_dir / f"{args.prefix}-asr-segments.json"
    dia_path = out_dir / f"{args.prefix}-diarization-turns.json"
    merged_path = out_dir / f"{args.prefix}-merged-speakers.json"

    write_json(
        asr_path,
        {
            "engine": "faster-whisper",
            "model": args.model,
            "segments": [s.__dict__ for s in asr],
        },
    )
    write_json(
        dia_path,
        {
            "engine": "pyannote/speaker-diarization-3.1",
            "turns": [t.__dict__ for t in turns],
        },
    )
    write_json(
        merged_path,
        {
            "method": "weighted-overlap-midpoint-v1",
            "lines": merged,
        },
    )

    print(str(merged_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
