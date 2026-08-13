#!/usr/bin/env bash
#
# deploy.sh, production build (build.sh) + rsync to the server.
#
# DEPLOYS ARE NON-DESTRUCTIVE for live sessions: hashed assets of PREVIOUS builds are kept on the
# server (no --delete), so a tab that loaded the old app can still lazy-spawn its worker / pdfjs
# chunk after a deploy. index.html is uploaded LAST, so a fresh page load never sees an index that
# references chunks which haven't arrived yet. Leftovers are pruned only when they are BOTH absent
# from the current build AND older than 7 days, no session lives that long, so pruning can never
# break anyone.
#
# Usage:
#   ./deploy.sh                 build, then rsync to the server (+ prune >7d leftovers)
#   ./deploy.sh --dry-run       build, then PREVIEW the rsync + prune (no changes), run this first!
#   ./deploy.sh --skip-build    skip the build, just rsync the existing dist
#   ./deploy.sh --skip-install  pass-through to build.sh (reuse node_modules)
#
# Server: set SSH_HOST, SSH_PORT and SSH_DEST in a local `.env` (see .env.example), or
# export them in the shell. Nothing about the target is hard-coded here.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/web/dist/web/browser"

# --- server (read from .env; anything already exported wins over the file) ---
if [ -f "$SCRIPT_DIR/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      ''|\#*) continue ;;
      SSH_HOST|SSH_PORT|SSH_DEST)
        if [ -z "${!key:-}" ]; then export "$key=$value"; fi ;;
    esac
  done < "$SCRIPT_DIR/.env"
fi
SSH_PORT="${SSH_PORT:-22}"

for var in SSH_HOST SSH_DEST; do
  if [ -z "${!var:-}" ]; then
    echo "✗ $var is not set. Copy .env.example to .env and fill in your server," >&2
    echo "  or export $var before running this script." >&2
    exit 1
  fi
done

# --- options ---
DRY_RUN=0
SKIP_BUILD=0
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)    sed -n '2,19p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
    *)            BUILD_ARGS+=("$arg") ;; # forwarded to build.sh (e.g. --skip-install)
  esac
done

# --- 1) build ---
if [ "$SKIP_BUILD" -eq 0 ]; then
  if [ ${#BUILD_ARGS[@]} -gt 0 ]; then
    "$SCRIPT_DIR/build.sh" "${BUILD_ARGS[@]}"
  else
    "$SCRIPT_DIR/build.sh"
  fi
fi

[ -f "$DEPLOY_DIR/index.html" ] || { echo "✗ no build at $DEPLOY_DIR, run without --skip-build" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "✗ rsync not found" >&2; exit 1; }

# --- 2) rsync (trailing slash on source → copy CONTENTS into dest) ---
#
# -a implies -p, so THE LOCAL MODE BITS ARE WHAT THE SERVER GETS, including on files whose content
# is unchanged, which rsync fixes up without re-transferring. That is a feature here and the repair
# path for the incident below, but it is also how the incident happened: assets staged by
# setup-ffmpeg.sh / setup-pdfjs.sh and the version.json stamp inherit the machine's umask, and a
# batch that landed 0700 locally was mirrored to the server, where the web server runs as another
# user. Those URLs then answered 403 with an HTML body, which is how covgen.wasm arrived at
# WebAssembly.instantiate as "<htm" and every cover in a bulk run failed.
#
# The guard therefore lives in build.sh, which normalizes the artifact and REFUSES to finish while
# anything under it lacks o+r. Do not "fix" this with --chmod: macOS ships openrsync, which rejects
# --chmod=D755,F644 outright and, given a form it does accept, applies it only to files it actually
# transfers and ignores the directory rules entirely, so it would silently miss exactly the
# already-wrong files this needs to repair.
# NO --delete: previous builds' hashed assets stay alive for the sessions that reference them.
# The prune step below is the counterpart that keeps the accumulation bounded.
RSYNC_OPTS=(-avz --human-readable --progress -e "ssh -p $SSH_PORT")
if [ "$DRY_RUN" -eq 1 ]; then
  RSYNC_OPTS+=(--dry-run)
  echo "▸ DRY RUN. Previewing changes, nothing will be written"
fi

# Phase A: everything EXCEPT index.html. Phase B: index.html alone, last, so the entry point only
# ever points at chunks that are already on the server (an effectively atomic deploy for new loads).
echo "▸ rsync (assets) → $SSH_HOST:$SSH_DEST"
rsync "${RSYNC_OPTS[@]}" --exclude=/index.html "$DEPLOY_DIR/" "$SSH_HOST:$SSH_DEST"
echo "▸ rsync (index.html, last)"
rsync "${RSYNC_OPTS[@]}" "$DEPLOY_DIR/index.html" "$SSH_HOST:$SSH_DEST"

# --- 3) prune: server files that are NOT in the current build AND older than 7 days ------------
# Everything under $SSH_DEST is owned by this script, so "not in the manifest" == "no current app
# references it"; the 7-day grace covers any session still holding the old chunk names. find's
# -mtime +7 = strictly older than 7 whole days. Newline-delimited paths are safe: the build never
# emits filenames with newlines, and spaces survive the read -r loop.
PRUNE_CMD='DRY='"$DRY_RUN"'; DEST='"'$SSH_DEST'"';
  cat > /tmp/manager-manifest.$$ && cd "$DEST" &&
  find . -type f -mtime +7 | LC_ALL=C sort | LC_ALL=C comm -23 - /tmp/manager-manifest.$$ > /tmp/manager-prune.$$;
  n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$DRY" -eq 0 ] && rm -f -- "$f"
    n=$((n+1)); echo "  prune: $f"
  done < /tmp/manager-prune.$$
  [ "$DRY" -eq 0 ] && find . -type d -empty -delete
  echo "▸ pruned $n stale file(s) (>7d, not in current build)"
  rm -f /tmp/manager-manifest.$$ /tmp/manager-prune.$$'
# LC_ALL=C on BOTH sorts: comm requires identical collation, and a macOS-vs-Linux locale mismatch
# here would misalign the streams and list LIVE files as prunable.
(cd "$DEPLOY_DIR" && find . -type f | LC_ALL=C sort) | ssh -p "$SSH_PORT" "$SSH_HOST" "$PRUNE_CMD"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "✓ dry run complete (prune listed only), re-run without --dry-run to deploy"
else
  echo "✓ deployed to $SSH_HOST:$SSH_DEST"
fi
