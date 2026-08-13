#!/usr/bin/env bash
#
# setup-ffmpeg.sh, stage the ffmpeg.wasm runtime assets into public/ffmpeg/ from node_modules,
# so the Angular build serves them same-origin under /manager/ffmpeg/ (CSP-friendly; no CDN).
# These are large (~31 MB core) and reproducible, so they're gitignored and regenerated here.
# Run after `pnpm install`, before `ng build` (build.sh does this).
#
set -euo pipefail
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$WEB/public/ffmpeg"
CORE="$WEB/node_modules/@ffmpeg/core/dist/esm"
WRAP="$WEB/node_modules/@ffmpeg/ffmpeg/dist/esm"

[ -f "$CORE/ffmpeg-core.wasm" ] || { echo "✗ @ffmpeg/core not installed, run pnpm install" >&2; exit 1; }

mkdir -p "$DEST/esm"
cp "$CORE/ffmpeg-core.js" "$CORE/ffmpeg-core.wasm" "$DEST/"
cp "$WRAP"/*.js "$DEST/esm/"   # the classWorker (worker.js) + its same-origin imports

echo "✓ ffmpeg assets → public/ffmpeg/ (core $(ls -lh "$DEST/ffmpeg-core.wasm" | awk '{print $5}') + classWorker)"
