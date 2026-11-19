# Product requirements — BookStream OCR

Condensed from the BookStream OCR main specification and the Layout-Aware Multilingual
Architecture Addendum (the addendum takes precedence).

## Problem

Digitize complete printed books found in libraries using only an Android phone, without
filling the phone, without losing pages, and without destroying the book's structure —
especially side-by-side original/translation texts such as *Darangen — Volume Two*
(Maranao/English, ~258 pages, verse, historical orthography).

## Users

A single owner (private deployment), scanning on a Samsung Galaxy S24 and reviewing on a
laptop. Multi-user later without weakening isolation (books are already owner-scoped).

## Core principles

1. **Capture now, process later** — scanning never waits for OCR.
2. **Never lose a page** — durable, verified, idempotent uploads; resumable sessions.
3. **Structure is canonical** — regions, columns, languages, alignment; TXT is an export.
4. **Original text is sacred** — no silent translation, normalization or correction.
5. **Honest status** — nothing is marked verified automatically; uncertainty is shown.

## Functional requirements (status in IMPLEMENTATION_STATUS.md)

- Auth, book library (create/edit/archive/delete-with-confirmation, progress stats).
- Scanner: rear camera, full-res stills, torch/focus where available, single/spread modes, page numbering, undo/retake, pause/resume, finish, bounded queue, offline handling, file-input fallback.
- Upload: async, retry with backoff, idempotent by capture UUID, checksum-verified ack, ordering by capture index, missing/duplicate page detection.
- Pages: gallery, reorder, renumber, delete (keeps original), crop (spread split), rotate.
- Structure: per-book layout + per-page override; regions with bbox/column/order/lang/role/type.
- OCR: pluggable, browser Tesseract first; provenance (engine, version, settings); retryable jobs; confidence + flagged words.
- Review: side-by-side editor, corrections separate from OCR, version comparison, statuses.
- Alignment: 1:1, 1:n, n:1, unpaired; inferred vs verified.
- Export: TXT (full/original/translation/parallel), TSV, JSON; later DOCX, HTML, searchable PDF.

## Non-goals (current)

Native Android app, automatic capture, cloud OCR, collaborative multi-user editing.
