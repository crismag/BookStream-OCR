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
| Vitest | 19 tests — pass (queue/uploader incl. parallel uploads, page detection, homography/warp) |
| TypeScript strict typecheck | pass |
| E2E (Chrome, fake camera, real Tesseract) | smoke 19/19; auto-crop 8/8 (rotated page on dark desk → cropped 1334×999, 76 kB, OCR intact) |

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

## Next executable task

Deploy to a Hostinger subdomain following `docs/DEPLOYMENT.md`, scan 10 pages on the S24, record camera mode shown on the scan screen (`Full-res photos …`), upload behaviour and OCR quality here.
