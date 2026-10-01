#!/bin/sh
# Vendor the SQLite WASM runtime the viewer loads offline.
#
#   scripts/vendor-sqlite.sh            # SQLITE_WASM_VERSION to override
#
# The official build ships an ES module, and a file:// page cannot load one (Chrome and
# Firefox refuse module scripts off the filesystem), so it is rewritten into a classic
# script: the single `export` becomes a global, and `import.meta.url` — used only to
# locate the wasm binary beside the script — becomes a document/location fallback.
#
# The wasm is vendored twice on purpose. `sqlite3.wasm` is what the runtime fetches when
# the page is served over http; `sqlite3.wasm.b64.js` carries the same bytes
# base64-encoded, so the runtime still initializes when fetch() is not available, which
# is exactly the offline case this project targets.
set -eu

VERSION=${SQLITE_WASM_VERSION:-3.53.4-build1}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/vendor"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "installing @sqlite.org/sqlite-wasm@${VERSION}…"
cd "$TMP"
npm init -y >/dev/null 2>&1
npm i --silent --no-audit --no-fund "@sqlite.org/sqlite-wasm@$VERSION" >/dev/null
DIST="$TMP/node_modules/@sqlite.org/sqlite-wasm/dist"

mkdir -p "$OUT"
cp "$DIST/sqlite3.wasm" "$OUT/sqlite3.wasm"

DIST="$DIST" OUT="$OUT" VERSION="$VERSION" node "$ROOT/scripts/vendor-sqlite.cjs"
