# BookStream OCR

Scan a whole printed book with an Android phone, store every page safely on your own
(Hostinger) web hosting, and turn it into **structured** text: columns kept separate,
parallel original/translation text kept aligned, OCR kept apart from human corrections.

First project: *Darangen — Volume Two* (Maranao verse with English translation side by side).

## What works today

- **Scanner (phone)**: rear camera with full-resolution stills on Chrome/Samsung Internet (Galaxy S24), torch, tap-to-focus where exposed, single-page and two-page-spread modes, editable printed page numbers, haptic + visual feedback, screen kept awake, file-input fallback.
- **Capture now, process later**: photos go into a bounded queue in browser storage (never the gallery) and upload in the background with checksum-verified, idempotent acknowledgments and exponential backoff. Survives reloads and lost connectivity; a capture is deleted from the phone only after the server confirms the same SHA-256.
- **Library**: books with progress, missing/duplicate page detection, archive, guarded delete.
- **Structure**: per-book layout (single, two independent columns, parallel translation, mixed) with per-page override; regions with bounding boxes, column, reading order, language, role and block type; draggable region editor.
- **OCR**: self-hosted Tesseract.js running in any logged-in browser (laptop recommended) that pulls jobs from the server. Maranao is read with the Latin model and dictionaries **off**, so spellings are not "corrected" toward English. Low-confidence words are flagged.
- **Review**: image beside editable text per region, corrections stored separately, OCR version comparison, rotate, spread-split adjustment, page reordering, mark reviewed.
- **Alignment**: inferred pairs (by order, unpaired leftovers allowed), manual 1:1, 1:n, n:1 pairing, inferred vs verified status.
- **Exports**: TXT (full, original-only, translation-only, parallel), parallel TSV, versioned JSON (`bookstream.book.v1`) with full provenance.

## Quick start (local)

```bash
composer install
(cd web && npm install && npm run build)
printf 'SETUP_TOKEN=dev-setup-token\nDB_DRIVER=sqlite\n' > .env
php -S 127.0.0.1:8080 -t public public/router.php
# open http://127.0.0.1:8080 , enter the setup token, create your account
```

Deploying to Hostinger: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (`bash scripts/package.sh` builds an upload-ready zip).

## Tests

```bash
vendor/bin/phpunit                 # backend: 27 tests
(cd web && npm test)               # queue/uploader: 11 tests
python3 e2e/make_fixture.py /tmp/bs-e2e && \
python3 e2e/smoke.py http://127.0.0.1:8080 /tmp/bs-e2e/parallel.y4m <SETUP_TOKEN>   # real Chrome, fake camera, real OCR
```

## Layout

```
app/        PHP backend (no framework, no runtime Composer) — deployed OUTSIDE the web root
public/     web root: index.php (API), .htaccess, built SPA, self-hosted OCR assets
web/        TypeScript frontend (Vite) → builds into public/
storage/    scans + SQLite in dev (git-ignored, never web-served)
tests/      PHPUnit; e2e/ Playwright smoke test
docs/       PRD, architecture, security, deployment, testing, roadmap, status
```
