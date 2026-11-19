# Architecture

```
 Galaxy S24 (PWA)                        Hostinger (PHP 8 + MySQL)                 Laptop browser
 ┌───────────────────────┐   HTTPS   ┌──────────────────────────────┐   HTTPS   ┌──────────────────────┐
 │ Camera (getUserMedia + │──upload──▶│ public_html/index.php        │◀─lease───│ Process tab          │
 │ ImageCapture.takePhoto)│◀──ack─────│  → app/ (outside web root)   │──image──▶│ Tesseract.js (WASM,  │
 │ IndexedDB queue        │           │  Auth · Books · Captures     │◀─results─│ self-hosted)         │
 │ Uploader (backoff)     │           │  Pages · Regions · OCR jobs  │           └──────────────────────┘
 │ Review / Export UI     │           │  Exports                     │
 └───────────────────────┘           │ storage/ (outside web root)  │
                                     └──────────────────────────────┘
```

## Backend (`app/`)

- `public/index.php` front controller → `BookStream\App::handle(Request): Response`.
- Router table in `App::registerRoutes()`; access levels `public`, `user`, `worker` (user session or `WORKER_TOKEN` bearer, OCR endpoints and page images only).
- `Db` wraps PDO (MySQL or SQLite), runs `app/migrations/*.sql` idempotently on each request (cheap check).
- `Storage` builds paths only from UUIDs; `persist()` copies → fsync → verifies hash → atomic rename.
- `ImageService` validates by content (finfo + getimagesize + pixel limit) and derives cached JPEG variants (`thumb` 360px, `view` 1600px, `full` 4000px) with crop/rotation. Originals are never modified.
- Controllers: Auth, Book, Capture, Page (regions, corrections, alignment), Ocr (job queue), Export.

## Data model

| Table | Key points |
|---|---|
| `books` | owner, languages (`original_language`, `translation_language`), `default_layout` |
| `captures` | physical photo; client UUID, `capture_index`, SHA-256, `storage_key` |
| `pages` | logical page; `side` (full/left/right), `printed_page_number` (string), `sort_key`, crop, rotation, layout override, `ocr_status`, `review_status` |
| `regions` | normalized bbox, `column_id`, `reading_order`, `lang`, `role` (original/translation/text), `block_type`, `source` (preset/manual) |
| `ocr_results` | per region, versioned; engine, engine_version, settings JSON, confidence, flagged words |
| `corrections` | per region; previous + corrected text; never overwrites OCR |
| `alignment_members` | (group_id, region_id, status inferred/verified) — groups express 1:1, 1:n, n:1; no group = unpaired |
| `ocr_jobs` | queued/leased/done/failed, lease token + expiry, attempts (max 3) |
| `rate_events`, `login_attempts` | rate limiting |

Effective text of a region = latest correction, else latest OCR result.

## Upload protocol

1. Client: capture → resize (≤3600px, JPEG 92%) → SHA-256 → IndexedDB (`pending`).
2. `POST /api/books/{id}/captures` multipart: `capture_id`, `checksum`, `capture_index`, `mode`, `printed_page_number`, `image`.
3. Server: validate → recompute SHA-256 → persist (fsync + rename) → DB transaction (capture + pages + preset regions) → `201 {status:"confirmed", checksum, pages}`.
4. Same id + same checksum → `200` replay with the same ack (covers lost responses). Same id + different checksum → `409`. Replacement only via `/api/captures/{id}/replace` with `confirm_replace=1` (old file kept).
5. Client deletes its copy only when `status=confirmed`, id and checksum match.

## OCR flow

`POST /api/books/{id}/ocr/enqueue` → jobs. A worker `POST /api/ocr/lease` (5-min lease) gets regions + `image_url`, crops each region, grayscale + contrast stretch (on a copy), Tesseract PSM 6 (single block, line breaks kept), dictionaries off for languages without their own model, and posts `complete` (or `fail`; 3 attempts). Parallel pages get an inferred alignment automatically.

## Frontend (`web/`)

Vanilla TypeScript + Vite, hash router, views return cleanup functions. `ui.h()` builds DOM with text nodes only. Service worker caches the app shell and OCR assets, never `/api/`.

## Extension points

- New OCR engine: any client implementing lease → complete with `engine`/`engine_version`/`settings`.
- Laptop Python worker (Surya/Marker/PaddleOCR): same API with `WORKER_TOKEN`.
- Native Android capture app: same upload API (client UUID + checksum).
