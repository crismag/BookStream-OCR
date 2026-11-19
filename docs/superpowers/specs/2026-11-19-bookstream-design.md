# BookStream OCR — Design (2026-11-19)

Source requirements: the BookStream OCR main spec and the Layout-Aware Multilingual
Architecture Addendum (the addendum wins on conflict). This document records the
decisions taken to implement them.

## Intent

Digitize whole printed books (first: *Darangen — Volume Two*, Maranao/English parallel
verse, ~258 pages) using a Samsung Galaxy S24 at a library. Capture must never wait for
OCR. The canonical data is structured (pages → regions → OCR results/corrections →
alignments); TXT is only an export.

## Goals / non-goals / anti-goals

- Goals: fast reliable capture → remote storage; resumable; region-aware OCR; per-language
  and parallel exports; human review with OCR kept separate from corrections.
- Non-goals (now): native Android app, automatic capture, DOCX/PDF, Python worker.
- Anti-goals: silently translating, modernizing or "correcting" Maranao; losing an
  unconfirmed capture; images in the phone gallery; publicly reachable scans.

## Constraints

Hostinger Business shared hosting: PHP 8.x, MySQL, Apache `.htaccess`, no shell, no
workers, no Node at runtime. Built artifacts are uploaded via hPanel/SFTP.

## Approaches considered

1. **PWA + PHP API + browser OCR worker (chosen).** Matches hosting. OCR runs in any
   logged-in browser (laptop recommended) that pulls jobs from the server.
2. Native Android capture app. Better background upload and ML Kit document scanner,
   but needs an APK toolchain and loses "open a URL". Deferred; the upload API is
   client-agnostic so it can be added as a capture-only client.
3. Server-side OCR. Impossible on shared hosting (no binaries/workers).

## Decisions

- Backend: framework-free PHP 8.1+, own autoloader (no Composer at runtime), PDO.
  MySQL in production, SQLite for dev/tests, same portable schema (UUID string keys).
- Layout: `public/` = web root (`public_html`); `app/`, `storage/`, `.env` live one
  level above. `storage/` is never web-served; images go through an authorized endpoint.
- Auth: single user created through a first-run setup page guarded by `SETUP_TOKEN`.
  Native PHP sessions (HttpOnly, Secure, SameSite=Lax), CSRF token header on all
  mutating requests, login rate limiting, Argon2id/bcrypt via `password_hash`.
- Upload integrity: client creates a UUID per capture and a SHA-256 checksum. Server
  verifies MIME/dimensions/size, recomputes the checksum, writes temp → fsync → rename,
  commits DB rows in a transaction, then returns the checksum. Client treats a capture as
  confirmed only when the returned checksum matches. Same id + same checksum = idempotent
  replay; same id + different checksum = 409; replacement is an explicit endpoint.
- Ordering: each capture carries a client `capture_index` (monotonic per book, resumed
  from the server). Pages sort by `sort_key` (index×10 + side); reorder overrides it.
  Printed page numbers are separate, editable strings.
- Spread mode: one capture → two pages (`left`, `right`) with default half crops,
  adjustable later.
- Capture client: `getUserMedia` rear camera; `ImageCapture.takePhoto()` for full-res
  stills when available (Chrome/Samsung Internet on S24), frame grab fallback; torch if
  exposed; file-input fallback. Pending captures in IndexedDB, bounded (default 25),
  deleted only after confirmed ack. Exponential backoff retries.
- Structure: `regions` (normalized bbox, column id, reading order, language, block type,
  source), `ocr_results` (versioned, engine/settings provenance), `corrections`
  (separate), `alignment_groups` (group membership covers 1:1, 1:n, n:1; unpaired =
  no group; status inferred/verified).
- Layout presets per book with per-page override: `single`, `two_column`,
  `parallel` (left = original language, right = translation). Presets generate regions;
  the user can edit them.
- OCR: Tesseract.js self-hosted (core + language data bundled, no CDN). Jobs leased via
  API. For original-language (non-English) regions the dictionaries are disabled so
  historical spelling is not pulled toward English; low-confidence words are flagged.
- Exports: TXT (full / per-language / parallel), JSON (versioned schema), both built
  from corrected text when present, else OCR text, with page provenance.

## Left to the builder

Visual styling details, thumbnail sizes, exact limits (configurable in `.env`).
