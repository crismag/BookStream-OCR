# Implementation status

_Last updated: 2026-11-19_

## Current phase

Phases 0–4 implemented (minus DOCX/HTML/PDF exports). **Next: on-device validation on the Galaxy S24 and Hostinger deployment.**

## Completed

- Phase 0: README, AGENTS/CLAUDE, PRD, ARCHITECTURE, SECURITY, DEPLOYMENT, TESTING, ROADMAP, design spec; CI (PHP 8.1/8.3 lint + tests + audit; TS typecheck + tests + build + audit; deploy-zip artifact); `scripts/package.sh`.
- Phase 1: setup/login/logout, sessions + CSRF + rate limits; book CRUD/archive/delete; camera (rear, full-res stills, torch, tap-focus, wake lock, file fallback, permission recovery); single/spread modes; page numbering; undo; pause/resume; bounded IndexedDB queue; checksum-verified idempotent uploads with backoff; offline handling; gallery; resume after reload.
- Phase 2: regions with presets (single, two-column, parallel, mixed) and per-page override; drag/resize region editor; OCR job queue with leases/retries; in-browser Tesseract worker (self-hosted, no CDN); corrections separate from OCR; versioned OCR results; TXT + JSON export.
- Phase 3: language-selective exports, missing/duplicate detection, reorder, renumber, rotate, spread split position.
- Phase 4 (partial): alignment groups (inferred/verified, 1:1, 1:n, n:1, unpaired), parallel TXT and TSV.

## Added 2026-11-19 (after first on-device feedback)

- Automatic page-edge detection with live green outline on the preview; captures are cropped to the page and perspective-straightened in a Web Worker (3% safety margin). If edges are not clearly visible (page fills frame, light background) the full photo is kept. Toggle: “Auto-crop” on the scan screen / Settings.
- Resolution presets on the scan screen (Fast 2400px, Balanced 3000px default, Max 4000px, Full sensor) and size of each capture shown under the thumbnail.
- Two parallel uploads; “Upload later” mode (photos stay on the phone, upload when switched back); waiting-photo limit raised to 300 (max 1000) with a phone-storage guard.

## Capture pipeline v2 (BOOKSTREAM-CAPTURE-PIPELINE-V2, 2026-11-19)

Implemented on branch `capture-pipeline-v2`:

- **Viewfinder:** full-height `object-fit: contain` stage (whole camera frame visible), 4:3 preview capped at 1920 px (was a 4K 16:9 stream), adjustable page guide (Auto/A4/Letter/custom ratio, size slider, spine line for spreads), dimmed area outside the guide, controls outside the frame; landscape layout.
- **Resolution:** preview / still / saved separated. Presets Minimal 1600 · Fast 2000 · Balanced 2400 (default, JPEG 85%) · Quality 3000 · Maximum native. Minimal uses the preview frame; others request the smallest supported still ≥ target (was always 4032). Never upscales. Camera JPEGs that already fit are stored byte-for-byte (header parsed, no decode). Quality override.
- **Minimal mode:** no live detection, auto-crop unavailable (guide crop allowed), no thumbnails, status updates ≤1/s.
- **Pipeline:** shutter frees right after acquisition; preparation (crop/resize/encode/SHA-256) in a Web Worker, ≤3 in flight; IndexedDB v2 stores metadata and image bytes separately (lossless upgrade) so status reads never load images; uploads 2 in parallel (configurable 1–4), drop to 1 on network errors and recover after 3 successes.
- **Automatic OCR:** every upload queues OCR jobs idempotently (`AUTO_OCR`, default on). Workers send heartbeats; scanner and Pages show *OCR queued* vs *running* and warn **“no worker”**. Optional OCR on the phone that yields to the camera and reuses just-uploaded images (no re-download).
- **Controls:** self-timer, explicit hands-free interval start/stop, torch, manual focus (if exposed), upload now/later, pause/resume scanning (releases camera), undo, retry; volume keys where the browser delivers them.
- **Manual crop correction** in Review (non-destructive `crop_region` on the original capture).
- **Instrumentation:** acquire, decode, detect, warp/resize, encode, checksum, IndexedDB, upload, server handling, OCR queue delay, OCR job and per-region execution — p50/p95 in Settings → Diagnostics and `GET /api/books/{id}/metrics`.
- **Bugs found and fixed while testing:** (1) after a reload, uploads started before the session's security token loaded and were *blocked* (also in the live v1) — now uploads start after sign-in, token errors retry, and previously blocked captures are released on startup; (2) reconnecting re-rendered the whole app and restarted the camera; (3) a tap right after returning to the app could fail before the first video frame — capture now waits for the camera.

Benchmarks: `docs/benchmarks/2026-11-19-capture-pipeline.md` (headless Chrome; S24 numbers still to be recorded).

## In progress

—

## Remaining

- DOCX, HTML, searchable PDF exports.
- Free-form crop editor (only spread split + rotation today).
- Automatic capture, stability/duplicate-page detection (Phase 5).
- Optional Python laptop worker; OCR engine benchmark on real pages.

## Test results (2026-11-19, this environment)

| Suite | Result |
|---|---|
| PHPUnit (PHP 8.3, SQLite) | 27 tests, 276 assertions — pass |
| PHPUnit (v2) | 32 tests, 309 assertions — pass (adds auto-OCR, worker heartbeat, metrics, migration rerun) |
| Vitest | 26 tests — pass (queue v2, adaptive uploads, session recovery, JPEG header, page detection) |
| TypeScript strict typecheck | pass |
| E2E (Chrome, fake camera, real Tesseract) | smoke 24/24; crop 8/8; bench/resilience 16/16 (presets, 10/30 pages, weak network, offline, reload mid-upload, background/foreground, Minimal disables detection) |

Not yet run: MySQL backend (schema is portable; CI uses SQLite), real S24 camera, Hostinger.

## Known defects / limitations

- Tesseract may insert blank lines between verse lines when line spacing is wide (it reports them as paragraph breaks). Text is otherwise verbatim; review if line breaks matter.
- Presets use fixed boxes; irregular pages need manual region adjustment.
- Auto-crop needs the page to contrast with the background (dark table works best); it does not flatten page curl near the binding.
- Cropping happens on the phone, so the uploaded image is the cropped page (not the raw photo). Turn auto-crop off to keep full frames.
- Background Sync is not used (unreliable on Android); uploads continue only while the app is open.

## Deployment status

Hostinger Git build deploy configured by the owner for `bookstream.crishub.com` (root `web`, output `dist`). The first build failed because the build wrote to `../public` only; fixed: `npm run build` now also assembles `web/dist` (SPA + `index.php` + `_bookstream/app`). Private data lives in `domains/<domain>/bookstream/` outside the web root and survives redeploys (verified in a simulated layout: e2e 19/19, data intact after replacing the web root). Manual zip deploy (`scripts/package.sh`) still works.

## External blockers

- Choose a domain/subdomain on Hostinger and create a MySQL database (owner action).
- On-device test with the S24.

## Next executable task (after v2 merge)

On the S24: scan 10 pages in Minimal and Balanced, open Settings → Diagnostics, copy the numbers into `docs/benchmarks/`. Then compare OCR quality of Balanced vs Quality on real Darangen pages.

## Earlier next task

Deploy to a Hostinger subdomain following `docs/DEPLOYMENT.md`, scan 10 pages on the S24, record camera mode shown on the scan screen (`Full-res photos …`), upload behaviour and OCR quality here.
