#!/bin/sh
# Put the corpus where the web viewer expects it: resources/corpus.db (+ media).
#
#   scripts/sync-resources.sh [--link] [<decarta-checkout>]
#
# Default copies (so the folder can be moved to another machine / USB stick);
# --link symlinks instead, which is what you want while iterating locally.
set -eu

LINK=0
if [ "${1:-}" = "--link" ]; then LINK=1; shift; fi
SRC=${1:-../decarta}
DST=$(cd "$(dirname "$0")/.." && pwd)/resources
CORPUS="$SRC/build/corpus.db"
MEDIA="$SRC/build/media"

[ -f "$CORPUS" ] || { echo "no corpus at $CORPUS — run 'make ingest-disc' in $SRC first" >&2; exit 1; }

mkdir -p "$DST"
if [ "$LINK" = 1 ]; then
    rm -f "$DST/corpus.db"; ln -s "$(cd "$(dirname "$CORPUS")" && pwd)/$(basename "$CORPUS")" "$DST/corpus.db"
    [ -d "$MEDIA" ] && { rm -f "$DST/media"; ln -s "$(cd "$MEDIA" && pwd)" "$DST/media"; }
else
    echo "copying corpus.db ($(du -h "$CORPUS" | cut -f1))…"
    cp "$CORPUS" "$DST/corpus.db"
    if [ -d "$MEDIA" ]; then
        echo "copying media ($(du -sh "$MEDIA" | cut -f1))…"
        rm -rf "$DST/media"
        cp -R "$MEDIA" "$DST/media"
    fi
fi
echo "resources ready:"
ls -la "$DST"
