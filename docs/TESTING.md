# Testing

All fixtures are synthetic (generated images/text); no access to the physical book is needed.

## Backend — PHPUnit (`vendor/bin/phpunit`)

In-process requests against `App::handle()` with SQLite + temp storage.

- `AuthTest`: setup token, single setup, login/logout, hashed passwords, login rate limit, idle session expiry, CSRF required.
- `CaptureTest`: checksum-verified ack, idempotent replay, conflict on different bytes, checksum mismatch, non-image / oversized rejection, malicious filename & invalid ids (path traversal), spread → left/right pages with numbering, ordering by capture index (out-of-order arrival), missing/duplicate page detection, explicit replacement keeps old original, cross-user access denied, storage deny file, 100 shuffled simulated captures.
- `OcrExportTest`: enqueue (no duplicates), lease, Maranao regions with dictionaries off, verbatim text with line breaks, inferred alignment, corrections separate from OCR, original/translation/parallel TXT + TSV + JSON, verified many-to-one alignment survives re-inference, unequal counts → unpaired, retry ×3 then failed + re-enqueue, lease token + worker token scope, export with missing/unprocessed pages, preset change guarded when OCR exists, book delete confirmation.

## Frontend — Vitest (`cd web && npm test`)

`uploader.test.ts` with fake IndexedDB: capture-order uploads, delete only on matching ack, exponential backoff, blocked non-retryable errors + manual retry, idempotent replay, interrupted-upload recovery after reload, pause, 30 consecutive captures, SHA-256 parity with PHP, page-number advance.

## End-to-end — real Chrome (`e2e/smoke.py`)

Chrome with a fake camera playing a synthetic parallel Maranao/English page (`e2e/make_fixture.py`), mobile viewport:
setup → create book → 3 captures → all confirmed → reload/resume numbering → gallery thumbnails → unauthenticated image denied → queue OCR → in-browser Tesseract worker → review text (Maranao words and verse line breaks intact) → correction → language-selective TXT, TSV, JSON provenance → no JS errors.

## Not automatable here (manual, on the S24)

- Real rear camera: autofocus, torch, full-resolution `takePhoto`, rotation, permission recovery.
- Uploads on real mobile data / Wi-Fi drop-outs in the library.
- Battery/memory over a 258-page session.

Record results in `IMPLEMENTATION_STATUS.md`.
