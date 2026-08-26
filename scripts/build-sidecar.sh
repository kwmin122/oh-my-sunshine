#!/usr/bin/env bash
# Builds the DevFlow daemon as a standalone single-binary sidecar for the
# desktop shell (V3 §13 / sprint S8).
#
#   daemon TS --esbuild--> one CJS bundle (zero npm deps at runtime)
#             --deno compile--> self-contained executable (runtime embedded)
#
# Output: apps/desktop/src-tauri/binaries/devflow-daemon-<target-triple>
# (Tauri's externalBin convention — the .app bundles it automatically.)
#
# Prerequisites: pnpm install (esbuild), deno >= 2.2 on PATH (node:sqlite).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[sidecar] bundling daemon (target: $TRIPLE)"
pnpm --dir "$ROOT/apps/daemon" exec esbuild "$ROOT/apps/daemon/src/main.ts" \
  --bundle --platform=node --format=cjs \
  "--outfile=$TMP/daemon-bundle.cjs" "--external:node:*"

echo "[sidecar] compiling standalone executable"
deno compile --no-check --allow-all \
  --output "$OUT_DIR/devflow-daemon-$TRIPLE" \
  "$TMP/daemon-bundle.cjs"

chmod +x "$OUT_DIR/devflow-daemon-$TRIPLE"
ls -lh "$OUT_DIR"
echo "[sidecar] done: $OUT_DIR/devflow-daemon-$TRIPLE"
