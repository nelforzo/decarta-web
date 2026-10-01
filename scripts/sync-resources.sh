#!/bin/sh
# Put the corpus where the web viewer expects it: resources/corpus.db (+ media).
#
#   scripts/sync-resources.sh [--link] [<decarta-checkout>]
#
# Default copies, so the folder can be carried to another machine; --link symlinks,
# which is what you want while iterating locally.
#
# The corpus is re-written with VACUUM INTO rather than copied when it is in WAL mode:
# the browser opens the bytes it is handed through sqlite3_deserialize(), and a WAL-mode
# database cannot be opened from a byte array at all (SQLITE_CANTOPEN — it needs the
# -shm sidecar it has no way to create). VACUUM INTO produces the same corpus in
# rollback-journal mode, which is what the native app bundles for the same reason.
set -eu

LINK=0
if [ "${1:-}" = "--link" ]; then LINK=1; shift; fi
SRC=${1:-../decarta}
DST=$(cd "$(dirname "$0")/.." && pwd)/resources
CORPUS="$SRC/build/corpus.db"
MEDIA="$SRC/build/media"

[ -f "$CORPUS" ] || { echo "no corpus at $CORPUS — run 'make ingest-disc' in $SRC first" >&2; exit 1; }
mkdir -p "$DST"
rm -f "$DST/corpus.db"

if [ "$LINK" = 1 ] && [ "$(sqlite3 "$CORPUS" 'pragma journal_mode')" = "delete" ]; then
    ln -s "$(cd "$(dirname "$CORPUS")" && pwd)/$(basename "$CORPUS")" "$DST/corpus.db"
    echo "linked corpus.db -> $CORPUS"
else
    # A WAL corpus is rewritten rather than linked (or copied): the browser opens the
    # corpus from its bytes, and a write-ahead log needs a -shm sidecar it cannot create,
    # so the viewer would have to fall back to clearing the WAL flag in its copy. VACUUM
    # INTO gives it a rollback-journal file that opens as-is, the same shape the native
    # app bundles.
    MODE=$(sqlite3 "$CORPUS" 'pragma journal_mode')
    echo "writing resources/corpus.db (rollback-journal copy of a $MODE $(du -h "$CORPUS" | cut -f1) source)…"
    sqlite3 "$CORPUS" "VACUUM INTO '$DST/corpus.db'"
fi

if [ -d "$MEDIA" ]; then
    rm -rf "$DST/media"
    if [ "$LINK" = 1 ]; then
        ln -s "$(cd "$MEDIA" && pwd)" "$DST/media"
        echo "linked media/ -> $MEDIA"
    else
        echo "copying media ($(du -sh "$MEDIA" | cut -f1))…"
        cp -R "$MEDIA" "$DST/media"
    fi
fi

echo
echo "resources ready:"
ls -la "$DST"
