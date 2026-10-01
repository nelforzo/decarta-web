#!/bin/sh
# Open the viewer in a browser that may read resources/ straight off the filesystem.
#
#   scripts/open-viewer.command          # double-clickable from Finder, too
#
# A file:// page is refused fetch()/XHR by every browser (no origin to satisfy CORS), so
# by default the viewer can only offer a file picker for corpus.db. Chrome, Edge and
# Brave reopen that door with --allow-file-access-from-files, which makes the viewer load
# resources/ on its own — the offline behaviour this project is for.
#
# The browser is started with its own profile directory so the flag is actually applied
# (an already-running browser ignores arguments from a second launch) and so the user's
# normal session and windows are left alone.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
PAGE="$HERE/index.html"
PROFILE="$HOME/Library/Application Support/decarta-web/browser-profile"

if [ ! -f "$HERE/resources/corpus.db" ]; then
    echo "no resources/corpus.db — run scripts/sync-resources.sh first" >&2
    exit 1
fi

matching_browser() {
    for app in \
        "/Applications/Google Chrome.app" \
        "/Applications/Microsoft Edge.app" \
        "/Applications/Brave Browser.app" \
        "$HOME/Applications/Google Chrome.app" \
        "$HOME/Applications/Brave Browser.app"
    do
        if [ -d "$app" ]; then
            echo "$app"
            return 0
        fi
    done
    return 1
}

if BROWSER=$(matching_browser); then
    NAME=$(basename "$BROWSER" .app)
    echo "opening $PAGE in $NAME (file access enabled, profile: $PROFILE)…"
    exec "$BROWSER/Contents/MacOS/$NAME" \
        --allow-file-access-from-files \
        --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check \
        "file://$PAGE"
fi

echo "No Chrome, Edge or Brave found."
echo "Opening $PAGE in the default browser instead — pick resources/corpus.db there,"
echo "or run scripts/sync-resources.sh and use Chrome/Edge/Brave for automatic loading."
exec open "$PAGE"
