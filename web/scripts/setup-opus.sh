#!/usr/bin/env bash
#
# setup-opus.sh, stage the Opus decoder (opus.wasm, libopus compiled to WebAssembly) into public/opus/
# from node_modules, so the Xeno Crisis music pack builder can fetch it same-origin (no CDN, CSP-friendly).
# It is only requested when someone actually builds a pack. Small (~320 KB) and reproducible, so it is
# gitignored and regenerated here. Run after `pnpm install`, before `ng build` (build.sh does this) or
# before `pnpm start` if you want to try the pack builder locally.
#
set -euo pipefail
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$WEB/public/opus"
SRC="$WEB/node_modules/@evan/opus"

[ -f "$SRC/wasm/opus.wasm" ] || { echo "✗ @evan/opus not installed, run pnpm install" >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC/wasm/opus.wasm" "$DEST/opus.wasm"
cp "$SRC/LICENSE" "$DEST/LICENSE-evan-opus.txt"
cat > "$DEST/LICENSE-libopus.txt" <<'LIC'
opus.wasm contains libopus. Its licence, verbatim:

Copyright 2001-2011 Xiph.Org, Skype Limited, Octasic,
                    Jean-Marc Valin, Timothy B. Terriberry,
                    CSIRO, Gregory Maxwell, Mark Borgerding,
                    Erik de Castro Lopo

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of Internet Society, IETF or IETF Trust, nor the
names of specific contributors, may be used to endorse or promote
products derived from this software without specific prior written
permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Opus is subject to the royalty-free patent licenses which are
specified at:

Xiph.Org Foundation:
https://datatracker.ietf.org/ipr/1524/

Microsoft Corporation:
https://datatracker.ietf.org/ipr/1914/

Broadcom Corporation:
https://datatracker.ietf.org/ipr/1526/
LIC

echo "✓ opus decoder → public/opus/ (opus.wasm $(ls -lh "$DEST/opus.wasm" | awk '{print $5}'))"
