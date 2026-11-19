# Deploying BookStream OCR to Hostinger (hPanel, shared hosting)

No shell, Node, Composer or background workers are needed on the server.

## Requirements

- PHP **8.1+** (8.2/8.3 recommended). Extensions: `pdo_mysql` (or `pdo_sqlite`), `gd`, `fileinfo`, `mbstring`, `exif`, `json`, `session`. All are enabled by default on Hostinger Business.
- MySQL database (hPanel → **Databases → Management**).
- HTTPS (hPanel → **Security → SSL**). The camera only works on HTTPS.
- PHP limits (hPanel → **Advanced → PHP Configuration → PHP Options**): `upload_max_filesize` ≥ 20M, `post_max_size` ≥ 24M, `memory_limit` ≥ 512M, `max_execution_time` ≥ 120. `.htaccess` also requests these.

## Option A — Git deploy with build (hPanel → Websites → Git / build settings)

Recommended: every push to `main` redeploys automatically.

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Node version | 22.x |
| Root directory | `web` |
| Build command | `npm run build` |
| Package manager | npm |
| Output directory | `dist` |

`web/dist` is a complete web root: the app, `.htaccess`, the PHP entry point `index.php` and the PHP code in `_bookstream/` (blocked from the web by `.htaccess`).

Private data is **not** part of the deploy. On the first request `index.php` creates `domains/<domain>/bookstream/` **next to** `public_html` and keeps there:

- `.env` — your settings (you create it once, see below)
- `storage/` — scans, the SQLite database (default) and logs

Redeploys replace `public_html` only, so scans and text survive every deploy.

**One-time setup after the first successful deploy:**

1. Open `https://<domain>/api/health` → should show `{"ok":true,...}`. This also creates `domains/<domain>/bookstream/`.
2. In File Manager, open `domains/<domain>/bookstream/` and create a file named `.env` containing one line:
   `SETUP_TOKEN=<a long random string>`
   (SQLite is used automatically. For MySQL add the `DB_*` lines from `.env.example`.)
3. Open `https://<domain>/` on the phone, enter the token, create your account, then delete the `SETUP_TOKEN` line.

## Option B — Upload a zip manually

### 1. Build the package

On your computer (or download the `bookstream-deploy` artifact from the GitHub Actions run):

```bash
bash scripts/package.sh        # → dist/bookstream-deploy.zip
```

The zip contains two folders:

| Folder | Upload to | Purpose |
|---|---|---|
| `public_html/` | `domains/<your-domain>/public_html/` (or a subdomain's folder) | Web root: app, `.htaccess`, API entry `index.php` |
| `bookstream/` | `domains/<your-domain>/bookstream/` — **next to** `public_html`, not inside it | PHP code, `.env`, uploaded scans (`storage/`) |

`public_html/index.php` finds `../bookstream/app` automatically.

## 2. Upload

hPanel → **Files → File Manager**: open `domains/<your-domain>/`, upload the zip, **Extract**, then move the contents of the extracted `public_html/` into the real `public_html/` and keep `bookstream/` beside it. (SFTP works equally: hPanel → Files → FTP Accounts.)

**Subdomain (recommended, e.g. `scan.example.com`):** Hostinger usually puts a subdomain's files in `domains/example.com/public_html/scan/`. Upload the `public_html/` contents there and put `bookstream/` at `domains/example.com/bookstream/`. `index.php` looks for the app one *and* two levels up, so both layouts work, and `bookstream/` stays outside every web root.

## 3. Configure

1. Create a MySQL database + user in hPanel and note name/user/password.
2. In `bookstream/`, copy `.env.example` to `.env` and set:
   - `DB_DRIVER=mysql`, `DB_NAME`, `DB_USER`, `DB_PASS` (host is `localhost`)
   - `SETUP_TOKEN` = a long random string (used once)
   - `FORCE_HTTPS=true`
3. Permissions: folders `755`, files `644`; `bookstream/storage` must be writable by PHP (`755` is enough on Hostinger since PHP runs as your user). `.env` → `600`.

Tables are created automatically on the first request (migrations in `bookstream/app/migrations`).

## 4. First run

1. Open `https://your-domain/` on your phone.
2. Enter the setup token, choose a username and a 10+ character password.
3. **Remove `SETUP_TOKEN` from `.env`** (setup is refused anyway once an account exists).
4. Add the site to your home screen (Chrome/Samsung Internet menu → *Add to Home screen*) for a full-screen scanner.

## 5. Verify

- `https://your-domain/api/health` → `{"ok":true,...}`
- `https://your-domain/bookstream/.env` and `/storage/` must **not** be reachable (they are outside the web root).
- Scan one page, then open **Pages**: the thumbnail appears and the queue says *All uploaded*.

## Optional: laptop OCR worker token

The in-browser **Process** screen needs only your login. For a future script-based worker, set `WORKER_TOKEN` (24+ random characters) in `.env`; it grants access to OCR job endpoints and page images only.

## Updating

Rebuild the zip and overwrite `public_html/*` and `bookstream/app/`. Never overwrite `bookstream/.env` or `bookstream/storage/`.

## Backup

Everything lives in two places:

1. **Database**: hPanel → Databases → phpMyAdmin → Export (or the automatic Hostinger backups).
2. **Scans**: `bookstream/storage/books/` (originals are the irreplaceable part).

Download both regularly (File Manager → compress `bookstream/storage` → download). Hostinger Business also keeps daily/weekly backups (hPanel → Files → Backups).

## Restore

1. Upload `bookstream/storage/books/` back to the same path.
2. Import the SQL dump into an empty database via phpMyAdmin.
3. Restore `.env` with the database credentials.

Each capture's SHA-256 is stored in the database; the JSON export includes it so originals can be verified after a restore.

## Local development

```bash
composer install && (cd web && npm install)
printf 'SETUP_TOKEN=dev-setup-token\nDB_DRIVER=sqlite\n' > .env
(cd web && npm run build)
php -S 127.0.0.1:8080 -t public public/router.php
```

`localhost` counts as secure, so the camera works in desktop Chrome. To test on the S24 over Wi-Fi you need HTTPS (e.g. deploy to a Hostinger subdomain).
