#!/usr/bin/env bash
#
# build.sh, produce the production build of the sd2snes covers web app.
#
# The app lives in web/ (Angular, @angular/build:application). The deployable
# static files land in web/dist/web/browser/, serve those on any web server/CDN.
#
# Usage:
#   ./build.sh                      install deps + production build
#   ./build.sh --zip                also package the build into a release .zip
#   ./build.sh --skip-install       reuse the existing node_modules
#   BASE_HREF=/covers/ ./build.sh   set <base href> for a sub-path deploy (default "/")
#
set -euo pipefail

# --- resolve paths (works from any cwd) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/web"
OUT_DIR="$WEB_DIR/dist/web"
DEPLOY_DIR="$OUT_DIR/browser"

# --- options ---
DO_ZIP=0
DO_INSTALL=1
BASE_HREF="${BASE_HREF:-/manager/}"
for arg in "$@"; do
  case "$arg" in
    --zip)          DO_ZIP=1 ;;
    --skip-install) DO_INSTALL=0 ;;
    -h|--help)      sed -n '2,15p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- preflight ---
command -v pnpm >/dev/null 2>&1 || { echo "✗ pnpm not found, install it: https://pnpm.io" >&2; exit 1; }
[ -d "$WEB_DIR" ] || { echo "✗ web/ not found at $WEB_DIR" >&2; exit 1; }
cd "$WEB_DIR"

echo "▸ node $(node -v 2>/dev/null || echo '?')  ·  pnpm $(pnpm -v)"
echo "▸ base href: $BASE_HREF"

# --- dependencies (reproducible) ---
if [ "$DO_INSTALL" -eq 1 ]; then
  echo "▸ installing dependencies (frozen lockfile)…"
  pnpm install --frozen-lockfile
fi

# --- stage ffmpeg.wasm runtime assets into public/ffmpeg/ (gitignored, served same-origin) ---
echo "▸ staging ffmpeg.wasm assets…"
bash scripts/setup-ffmpeg.sh

# --- stage the pdf.js worker into public/pdfjs/ (gitignored, served same-origin) ---
echo "▸ staging pdf.js worker…"
bash scripts/setup-pdfjs.sh

# --- stamp the build version (read by the app, versioned by the service worker) ---
APP_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '0.0.0')"
COMMIT="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$APP_VERSION" "$COMMIT" "$BUILT" > public/version.json
echo "▸ version: $APP_VERSION · $COMMIT · $BUILT"

# --- clean + build (defaultConfiguration is production) ---
rm -rf "$OUT_DIR"
echo "▸ building production…"
pnpm exec ng build --configuration production --base-href "$BASE_HREF"

# --- verify ---
[ -f "$DEPLOY_DIR/index.html" ] || { echo "✗ build produced no $DEPLOY_DIR/index.html" >&2; exit 1; }

# --- normalize permissions: the artifact must be world-readable ---
# Angular copies public/ verbatim, mode included, and the ffmpeg/pdf.js staging above plus the
# version.json stamp inherit this machine's umask. Anything that lands without o+r is served as 403
# by the host (an HTML error body, which a wasm/JSON consumer then chokes on). deploy.sh forces the
# modes on its own side too; this keeps the artifact itself correct for any other transport.
chmod -R go+rX "$DEPLOY_DIR"
UNREADABLE="$(find "$DEPLOY_DIR" -not -perm -o=r | head -5)"
[ -z "$UNREADABLE" ] || { echo "✗ files still not world-readable:" >&2; echo "$UNREADABLE" >&2; exit 1; }

echo ""
echo "✓ Production build ready"
echo "  deployable files: $DEPLOY_DIR"
du -sh "$DEPLOY_DIR" 2>/dev/null | awk '{print "  total size:      "$1}'

# --- optional release archive ---
if [ "$DO_ZIP" -eq 1 ]; then
  command -v zip >/dev/null 2>&1 || { echo "✗ zip not found" >&2; exit 1; }
  ZIP="$OUT_DIR/sd2snes-covers-web.zip"
  rm -f "$ZIP"
  ( cd "$DEPLOY_DIR" && zip -rq "$ZIP" . )
  echo "✓ release archive: $ZIP ($(du -h "$ZIP" | awk '{print $1}'))"
fi

echo ""
echo "Deploy the CONTENTS of $DEPLOY_DIR to any static host."
echo "Route all unknown paths to index.html (SPA fallback) so deep links work."
