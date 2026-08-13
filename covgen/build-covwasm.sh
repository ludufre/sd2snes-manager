#!/usr/bin/env bash
#
# build-covwasm.sh, compile the .cov v4 + .gd DirectColor encoders (internal/cov + internal/gd,
# via cmd/covwasm) to WebAssembly so the Manager (web/) converts covers & info-screens client-side
# with the EXACT native code path. Outputs covgen.wasm + wasm_exec.js into the Manager's public/.
#
# This Go module is a self-contained copy of the encoder from the (now-archived) sd2snes-covers
# repo, kept here so the wasm can always be rebuilt from this repository alone.
#
# Usage: ./build-covwasm.sh [OUT_DIR]
#   OUT_DIR default: ../web/public   (the Manager's static assets dir)
#
# NOTE: covgen.wasm carries the Go runtime, so wasm_exec.js MUST come from the SAME Go version
#       used to build it, this script always regenerates both together. Keep them in lockstep.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # covgen/ (this Go module)
OUT="${1:-$HERE/../web/public}"
[ -d "$OUT" ] || { echo "✗ output dir not found: $OUT" >&2; exit 1; }

echo "▸ go $(go version | awk '{print $3}')  →  $OUT"
cd "$HERE"
GOOS=js GOARCH=wasm go build -trimpath -ldflags='-s -w' -o "$OUT/covgen.wasm" ./cmd/covwasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"

echo "✓ covgen.wasm ($(ls -lh "$OUT/covgen.wasm" | awk '{print $5}')) + wasm_exec.js ($(ls -lh "$OUT/wasm_exec.js" | awk '{print $5}'))"
