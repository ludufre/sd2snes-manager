#!/usr/bin/env bash
#
# setup-pdfjs.sh, stage the pdf.js worker into public/pdfjs/ from node_modules, so the Angular
# build serves it same-origin under /manager/pdfjs/ (CSP-friendly; no CDN). Same pattern as
# scripts/setup-ffmpeg.sh: reproducible from node_modules, so it's gitignored and regenerated here.
# Run after `pnpm install`, before `ng build` (build.sh does this).
#
set -euo pipefail
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$WEB/public/pdfjs"
SRC="$WEB/node_modules/pdfjs-dist/build/pdf.worker.min.mjs"

[ -f "$SRC" ] || { echo "✗ pdfjs-dist not installed, run pnpm install" >&2; exit 1; }

mkdir -p "$DEST"
# Stage as `.js` (NOT `.mjs`): the prod server has no MIME mapping for `.mjs` (serves it as
# application/octet-stream), and with nosniff the browser refuses the module worker. `.js` is served
# as text/javascript. The file's content is still an ES module (loaded via {type:'module'}). See
# ensurePdfjs() in src/app/lib/man.js.
rm -f "$DEST/pdf.worker.min.mjs"
cp "$SRC" "$DEST/pdf.worker.min.js"

echo "✓ pdf.js worker → public/pdfjs/pdf.worker.min.js ($(ls -lh "$DEST/pdf.worker.min.js" | awk '{print $5}'))"
