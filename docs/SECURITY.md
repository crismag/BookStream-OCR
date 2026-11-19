# Security

Private, single-owner deployment of possibly copyrighted library material. Scans must never be public.

| Control | Implementation |
|---|---|
| Authentication | Username + password (`password_hash`, bcrypt/argon per PHP default, rehash on login). First account only via `SETUP_TOKEN`; setup refused once a user exists. |
| Sessions | PHP sessions, cookie `HttpOnly`, `Secure` on HTTPS, `SameSite=Lax`, strict mode, ID regenerated on login, idle expiry (`SESSION_IDLE_SECONDS`). |
| CSRF | Per-session token returned by `/api/auth/state`; required in `X-CSRF-Token` for every non-GET request (including login/setup). |
| Rate limiting | Login: 20/15 min per IP, 8/15 min per username. Setup: 10/15 min per IP. Uploads: `UPLOADS_PER_MINUTE` per user. |
| Upload validation | Size limit, MIME by content (`finfo`), `getimagesize`, min/max dimensions and pixel count, client checksum verification. Only JPEG/PNG/WebP. Client filenames are stored as metadata only. |
| Path traversal | Filesystem paths are built exclusively from server-validated UUIDs; storage keys are regex-checked. |
| File delivery | Scans live outside the web root; served only via `/api/pages/{id}/image` after ownership check; storage also gets a deny-all `.htaccess`. |
| Access control | Every book/page/region lookup checks `books.user_id` against the session user (404 otherwise). Worker token: OCR endpoints + page images only. |
| SQL injection | PDO prepared statements, emulation off. |
| XSS | UI builds DOM with text nodes only (no `innerHTML`); JSON responses; CSP `script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'`. |
| Headers | HSTS (HTTPS), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` (camera self only). |
| HTTPS | `.htaccess` redirect + `FORCE_HTTPS` in PHP. |
| Secrets | `.env` outside web root, git-ignored; `.htaccess` denies dotfiles. Errors logged to `storage/logs` without request bodies; clients get generic 500s. |
| Data integrity | SHA-256 per capture, fsync + atomic rename, DB transactions, originals never modified, replacement keeps the old original. |
| Destructive actions | Book delete requires typing the exact title; page delete requires `confirm` and keeps the photo; preset reset over OCR text requires `force`. |

Known gaps: no 2FA; no account lockout notifications; rate limiting is per-database (fine for single node).
