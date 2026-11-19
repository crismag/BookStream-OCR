# Agent guide — BookStream OCR

Read `docs/IMPLEMENTATION_STATUS.md` first; it holds the current phase and next task.
Design decisions: `docs/superpowers/specs/2026-11-19-bookstream-design.md` and `docs/ARCHITECTURE.md`.

## Commands

| Task | Command |
|---|---|
| Install | `composer install && (cd web && npm install)` |
| Backend tests | `vendor/bin/phpunit` |
| PHP lint | `find app public tests -name '*.php' -print0 \| xargs -0 -n1 php -l` |
| Frontend typecheck / tests / build | `cd web && npm run typecheck && npm test && npm run build` |
| Dev server | `php -S 127.0.0.1:8080 -t public public/router.php` (needs `.env` with `SETUP_TOKEN`) |
| E2E | `python3 e2e/make_fixture.py /tmp/bs-e2e && python3 e2e/smoke.py http://127.0.0.1:8080 /tmp/bs-e2e/parallel.y4m <token>` |
| Deploy zip | `bash scripts/package.sh` |

## Hard rules

- Target is Hostinger shared hosting: PHP 8.1+, no shell/Node/Composer/workers at runtime. Backend code must not need Composer packages at runtime.
- Never flatten structure: the canonical model is pages → regions → OCR results / corrections / alignment. TXT is only an export.
- Never translate, modernize or auto-correct original-language text. OCR output and human corrections are stored separately and never overwritten.
- A capture is "stored" only after server validation, fsync+rename, DB commit and a checksum-matching ack. Never delete a client capture before that.
- Only UUIDs become filesystem path segments. Scans are served only through authorized endpoints.
- All mutating requests need the CSRF header; all SQL uses prepared statements; all UI text goes through text nodes (`h()` in `web/src/ui.ts`), never `innerHTML`.
- Never commit `.env`, credentials or real book scans (tests use synthetic fixtures).
- Run the tests after meaningful changes; update `docs/IMPLEMENTATION_STATUS.md` at each milestone.

## Coding standards

PHP: `declare(strict_types=1)`, PSR-12-ish, final classes, `BookStream\` namespace under `app/src`, errors as `HttpError`.
TypeScript: strict mode, no framework, views in `web/src/views/*` return a cleanup function.
