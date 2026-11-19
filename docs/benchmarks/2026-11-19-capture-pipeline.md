# Capture pipeline benchmark — 2026-11-19

**Environment:** headless desktop Chrome, fake camera playing a 1920×1440 synthetic page,
local PHP server (same code as production). Values are p50 / p95.
These numbers show *relative* costs and correctness of the pipeline. They are **not**
Galaxy S24 measurements: the fake camera tops out at 1920 px (so Fast/Balanced/Quality all
save 1920 px — never upscaled), and a real camera's `takePhoto()` is slower than this fake one.
Measure on the phone with **Settings → Diagnostics** (same metrics) and record results here.

Reproduce: `python3 e2e/bench.py <base> /tmp/bs-e2e/parallel.y4m <user> <password> out.json`

## Capture latency by preset

| Run | Saved image | Shutter ready again (ms) | Captured → saved locally (ms) | Upload (ms) | Server handling (ms) | JS heap |
|---|---|---|---|---|---|---|
| minimal (10 pages) | 1600×1200 · 59 kB | 9 / 10.2 | 35.3 / 44.8 | 12.7 / 16 | 4 / 7 | 6 MB |
| fast (10 pages) | 1920×1440 · 83 kB | 109.2 / 149.7 | 157.1 / 204.1 | 12.4 / 23.5 | 4 / 12 | 8 MB |
| balanced (10 pages) | 1920×1440 · 88 kB | 103.8 / 124.7 | 151.9 / 187.3 | 13.3 / 15.7 | 5 / 8 | 10 MB |
| quality (10 pages) | 1920×1440 · 94 kB | 125.2 / 165.7 | 177.4 / 205.7 | 12.8 / 15.7 | 5 / 6 | 11 MB |
| balanced ×30 (30 pages) | 1920×1440 · 88 kB | 123.4 / 157.5 | 170.3 / 204 | 14.3 / 22.4 | 5 / 9 | 13 MB |
| minimal ×30 (30 pages) | 1600×1200 · 59 kB | 9.3 / 11.6 | 36.6 / 47 | 13.1 / 17.6 | 4 / 6 | 9 MB |

- **Shutter ready again** = time from tap until the next capture can start (camera acquisition only;
  preparation, IndexedDB and upload happen in the background).
- Minimal uses the live preview frame (no still capture), hence ~10 ms vs ~120 ms for stills.

## Resilience checks

| Check | Result | Detail |
|---|---|---|
| minimal: 10 captures saved + uploaded, server pages +10 | ✅ | 1600×1200 · 59 kB |
| fast: 10 captures saved + uploaded, server pages +10 | ✅ | 1920×1440 · 83 kB |
| balanced: 10 captures saved + uploaded, server pages +10 | ✅ | 1920×1440 · 88 kB |
| quality: 10 captures saved + uploaded, server pages +10 | ✅ | 1920×1440 · 94 kB |
| balanced_30: 30 captures saved + uploaded, server pages +30 | ✅ | 1920×1440 · 88 kB |
| minimal_30: 30 captures saved + uploaded, server pages +30 | ✅ | 1600×1200 · 59 kB |
| Minimal preset saves at 1600 long edge (resolution really applied) | ✅ | 1600×1200 · 59 kB |
| weak network: 10 captures saved locally without waiting for uploads | ✅ | 2.7s; 💾 10 on phone |
| weak network: all 10 uploaded eventually, no duplicates | ✅ | 33.9s at 200 kbit/s up |
| offline: captures continue and stay on phone | ✅ | 💾 5 on phone |
| back online: uploads resume, none lost, none duplicated | ✅ |  |
| reload mid-upload: every capture arrives exactly once | ✅ | 4 of 4 |
| background releases camera; foreground restarts it and capture works | ✅ | camera stopped=True, new pages=1, status=['💾 1 on phone', '↑ 1 uploading'] |
| Minimal mode: no live page detection runs | ✅ | 0 detections in 2.5s |
| Enhanced mode: live detection throttled to ~2/s | ✅ | 6 detections in 2.5s |
| no JS errors | ✅ |  |
