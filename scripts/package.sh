#!/usr/bin/env bash
# Build an upload-ready Hostinger package: dist/bookstream-deploy.zip
#   public_html/   -> upload into the domain's public_html
#   bookstream/    -> upload NEXT TO public_html (outside the web root)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

(cd web && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)

STAGE=$(mktemp -d)
mkdir -p "$STAGE/public_html" "$STAGE/bookstream/storage"
cp -a public/. "$STAGE/public_html/"
rm -f "$STAGE/public_html/router.php"
cp -a app "$STAGE/bookstream/app"
cp .env.example "$STAGE/bookstream/.env.example"
printf 'Require all denied\nDeny from all\n' > "$STAGE/bookstream/.htaccess"
printf 'Require all denied\nDeny from all\n' > "$STAGE/bookstream/storage/.htaccess"
cp docs/DEPLOYMENT.md "$STAGE/DEPLOYMENT.md"

mkdir -p dist
rm -f dist/bookstream-deploy.zip
(cd "$STAGE" && zip -qr "$ROOT/dist/bookstream-deploy.zip" .)
rm -rf "$STAGE"
echo "dist/bookstream-deploy.zip ($(du -h dist/bookstream-deploy.zip | cut -f1))"
