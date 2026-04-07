# D&D Dashboard — Diarization Upgrade Process

Date: 2026-03-18
Owner: claw
Status: Draft implementation plan

---

## Goal

Replace text-only speaker guessing with a robust audio-based pipeline:

1. **ASR**: faster-whisper
2. **Diarization**: pyannote
3. **Alignment/Merge**: reliable segment ↔ speaker join
4. Keep current LLM extraction passes unchanged downstream

This improves speaker consistency, especially in noisy multi-speaker table audio.

---

## Current vs Target

### Current
- Whisper JSON segments (chunked)
- LLM guesses speaker tags (`S1..S5/U`) from transcript text
- Failover to raw transcript if speaker labeling fails

### Target
- faster-whisper segments + timestamps
- pyannote speaker turns from raw audio
- deterministic overlap-based merge
- optional speaker-name mapping (DM/PC aliases) post-merge

---

## High-Level Architecture

```text
Audio file
  -> preprocessing (mono/16k)
  -> faster-whisper ASR segments
  -> pyannote diarization turns
  -> timestamp aligner (ASR <-> diarization)
  -> speaker-labeled transcript
  -> existing pass0/pass1/pass2 extraction pipeline
```

---

## Prerequisites

## Runtime/infra
- Python 3.10+
- torch (CUDA build compatible with host GPU)
- faster-whisper
- pyannote.audio
- ffmpeg

## Audio preprocessing (required)
Before ASR + diarization, normalize source audio:

```bash
ffmpeg -i input.wav -ac 1 -ar 16000 -af "loudnorm,highpass=f=100,lowpass=f=8000" output.wav
```

This materially improves both transcription and diarization stability.

## Credentials
- Hugging Face token (for pyannote pipeline model access)
- Store securely (env or existing secrets pattern)

## GPU
- Confirm diarization host uses intended GPU (A2000 in your case)
- Verify with `nvidia-smi` during test runs

---

## Data Contracts (new artifacts)

Store under `data/campaigns/<id>/imports/`.

### 1) ASR segments artifact
`*-asr-segments.json`
```json
{
  "sourceId": "...",
  "engine": "faster-whisper",
  "language": "en",
  "segments": [
    {"start": 12.34, "end": 16.78, "text": "..."}
  ]
}
```

### 2) Diarization turns artifact
`*-diarization-turns.json`
```json
{
  "sourceId": "...",
  "engine": "pyannote",
  "turns": [
    {"start": 12.00, "end": 15.10, "speaker": "SPEAKER_00"}
  ]
}
```

### 3) Merged speaker transcript artifact
`*-merged-speakers.json`
```json
{
  "sourceId": "...",
  "method": "overlap-majority-v1",
  "lines": [
    {"start": 12.34, "end": 16.78, "speaker": "S1", "speakerRaw": "SPEAKER_00", "text": "..."}
  ]
}
```

---

## Merge Strategy (critical)

Use deterministic **weighted overlap matching**:

For each ASR segment:
1. Find diarization turns overlapping `[asr.start, asr.end]`
2. For each candidate speaker, compute:

```python
overlap_ratio = overlap_duration / max(segment_duration, 1e-6)
midpoint_anchor = 1.0 if segment_midpoint in speaker_turn else 0.0
score = overlap_ratio * 0.7 + midpoint_anchor * 0.3
```

3. Assign speaker with highest score
4. If top score < threshold (or no overlap above min sec), mark `U`

### Overlap handling (table chaos mode)
If second-best score is close to best (recommended: `second >= 0.40 * best`):
- set `overlap: true`
- either keep primary speaker only, or encode dual label (`S1+S2`) for debug artifacts

Default recommendation for downstream simplicity: keep primary speaker + `overlap: true`.

### Recommended tie-breakers
- Midpoint anchor first
- Then overlap duration
- Then temporal stability (same as previous speaker gets small bonus)
- Then previous segment speaker (hysteresis) if gap < short threshold

### Post-processing
- Smooth 1-line flicker (A-B-A pattern) when confidence low
- Merge adjacent same-speaker short segments for readability

---

## Confidence Scoring

Each merged line gets confidence from multiple signals:
- overlap ratio
- midpoint anchor hit/miss
- temporal stability bonus (same speaker continuity)
- overlap-chaos penalty (if overlap flag set)

Example heuristic:
```python
confidence = overlap_ratio
if midpoint_anchor: confidence += 0.10
if same_as_prev: confidence += 0.10
if overlap_flag: confidence -= 0.10
```

Bucketing:
- `high`: >= 0.65
- `medium`: 0.35–0.64
- `low`: < 0.35 or uncertain

Expose confidence in artifact for debugging; downstream LLM can ignore or use lightly.

---

## Implementation Phases

## Phase 1 — Sidecar prototype (no risk)
- Add Python sidecar script:
  - input: audio path
  - output: ASR segments + diarization turns + merged lines
- Do not change existing app behavior yet
- Save artifacts for comparison

### Deliverables
- `scripts/diarize_merge.py`
- test run on 2–3 known sessions
- accuracy notes in docs

## Phase 2 — Optional runtime path
- Add API flag/env:
  - `DIARIZATION_MODE=llm|pyannote`
- If `pyannote`, use sidecar output for speaker transcript
- fallback to current LLM mode on sidecar failure

### Deliverables
- integrated call from `processAudioJob`
- clear stage labels in job status:
  - `asr`
  - `diarization`
  - `merge speakers`

## Phase 3 — Default cutover
- Make `pyannote` default once stable
- Keep `llm` mode as explicit fallback
- Track error rate + runtime impact

### Deliverables
- parity report (speaker consistency improvement)
- updated operator docs

---

## API/Code Touchpoints

### Server (`server.mjs`)
- `processAudioJob`:
  - after chunk merge, call diarization sidecar
  - set `job.speakerTranscript` from merged output
- keep `runLLMStages` unchanged (it already consumes diarized transcript if present)

### New config/env
- `DIARIZATION_MODE=llm|pyannote`
- `PYANNOTE_DEVICE=cuda|cpu`
- `PYANNOTE_HF_TOKEN=...`
- `MERGE_OVERLAP_MIN_SEC=0.20`
- `MERGE_HYSTERESIS_MAX_GAP_SEC=0.75`

### UI
- Add read-only status in Session Import:
  - `Diarization mode: pyannote` / `llm`
- Optional: expose merged confidence summary in approval view

---

## Failure Handling

If pyannote path fails:
1. persist error artifact
2. set job note `diarization fallback engaged`
3. fallback to current LLM speaker labeling
4. continue pipeline (no hard stop)

This prevents “all-or-nothing” imports.

---

## Performance Expectations

- Diarization adds runtime (often significant on long sessions)
- Practical expectation: **~1.5x to 3x** total processing time on long sessions
- Accuracy gains are worth it for NPC/quote attribution quality
- For very long sessions, use chunked diarization (10–15 min windows) with 5–10s overlap stitching

---

## Validation Checklist

For each test file:
- [ ] merged transcript has continuous timestamps
- [ ] no major speaker flip-flop in monologues
- [ ] interruption scenes reasonably attributed
- [ ] fallback path works when pyannote unavailable
- [ ] artifacts written for ASR, diarization, and merge

Acceptance target (pragmatic):
- noticeably fewer wrong-speaker blocks than LLM-only mode
- zero pipeline aborts caused solely by diarization step

---

## Phase 1 hard requirements (before Phase 2)

- weighted overlap scoring + midpoint anchor
- explicit overlap flag handling
- basic speaker clustering/remap across long sessions (embedding cosine threshold)
- mandatory audio preprocessing

## A/B Diff Tool (required)

Add an automated comparison report between:
- current LLM speaker labeling
- pyannote merged output

Track:
- speaker switches per minute
- longest consistent speaker block
- `% unknown`
- overlap-flag frequency

## Recommended Next Step (immediate)

Implement **Phase 1 sidecar prototype** first and run A/B on 3 existing session audios before wiring default behavior.

That gives empirical quality data before touching main runtime path.
