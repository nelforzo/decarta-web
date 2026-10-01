# decarta-web

A portable, offline HTML viewer for the encyclopedia corpus built by
[decarta](../decarta). Same content, same search, no install, no server: open
`index.html` in a browser and browse the corpus straight out of the local `resources/`
directory.

```
Encarta 2003 DVD ──(decarta/extractor)──▶ corpus.db (+ media/) ──▶ decarta-web/resources/ ──▶ browser
```

`../decarta` is the reference implementation: this project reuses its `corpus.db`
unchanged (schema v2, 39,491 articles / 306,408 cross-references / 8,157 pictures) and
mirrors the native reader's behaviour — 五十音 browse sidebar, paged entry lists,
article reading with pictures and captions, cross-reference navigation, "referenced by"
backlinks, and the corpus's own FTS5 search path. Nothing about the corpus format is
re-derived here: `meta.schema_version` and `meta.tokenizer` travel with the data and all
three readers (web, SwiftUI, CLI) obey them.

## Running it

```sh
scripts/sync-resources.sh          # rollback-journal corpus + media into resources/
open index.html                    # the viewer; it asks for corpus.db the first time
scripts/open-viewer.command        # …or this, which loads resources/ by itself
```

`sync-resources.sh` takes `--link` to symlink instead of copying (8 s either way for
753 MB), and reads from `../decarta` by default.

## Why there are two ways to open it

A `file://` page is not allowed to `fetch()` anything — there is no origin to satisfy
CORS — so by default the viewer cannot read `resources/corpus.db` on its own and offers
a file picker instead (drag-drop works too). Measured in Chrome 151 on this corpus:

| from a `file://` page | with file access | without |
| --- | --- | --- |
| `fetch('resources/corpus.db')` | 200 | `Failed to fetch` |
| `fetch('vendor/sqlite3.wasm')` | 200 | `Failed to fetch` |
| ES module `import` | works | blocked |
| `<img src="resources/media/…">` | **works** | **works** |

So pictures need no special treatment at all, and `scripts/open-viewer.command` starts
Chrome/Edge/Brave with `--allow-file-access-from-files` (in its own profile, so an
already-running browser actually applies the flag) to make the corpus load by itself —
the offline behaviour this project exists for. Safari and Firefox have no such switch;
there the picker is the path. Either way nothing is uploaded, nothing is installed and
there is no network code in the viewer, and the panel closes with its ×, the backdrop, or
Esc once a corpus is open.

## How the reader works

- **SQLite in the browser.** `vendor/sqlite3.wasm` is the official `@sqlite.org/sqlite-wasm`
  build (3.53.4) — it has FTS5 and the `trigram` tokenizer compiled in, which is what this
  corpus's search needs (`sql.js`, the usual choice, ships neither). A `file://` page
  cannot fetch the wasm either, so the same bytes are vendored base64-encoded beside it
  and a `file://` page instantiates from those instead. `scripts/vendor-sqlite.sh`
  regenerates both from npm.
- **Classic scripts, not modules.** `index.html` loads the viewer as plain `<script>`s
  because a `file://` page cannot load ES modules in Chrome, Edge or Firefox. That is the
  only reason the code is written against a `Decarta` global and has no build step.
- **The corpus is fed to SQLite as bytes.** `sqlite3_deserialize()` opens the file the
  browser hands us, in memory, read-only. The 345 MB is streamed into the WASM heap in
  8 MB slices so it is never held twice. A WAL-mode corpus cannot be opened that way — the
  first query fails with `SQLITE_CANTOPEN` (14) because a write-ahead log needs a `-shm`
  sidecar a browser cannot create — so the viewer clears the file-format WAL flag (header
  bytes 18/19) in its *private copy* before opening it, and says so in the banner. That
  makes a corpus picked straight out of `../decarta/build` usable, with one caveat: the
  `-wal` file itself is never visible to the browser, so a corpus with un-checkpointed
  transactions would be read as of its last checkpoint. `sync-resources.sh` writes a
  rollback-journal copy with `VACUUM INTO` (as the native app bundles) and needs no such
  adjustment.
- **Search is the same query path as the CLI.** The query is tried as typed and only
  re-tried NFKC-normalized if it found nothing; `trigram` corpora take FTS5 `MATCH` of
  quoted phrases ranked by bm25 (title 8.0 / reading 4.0 / body 1.0) when every term is
  ≥ 3 characters, and a two-tier `LIKE` fallback when one is not — which reports "N+"
  rather than inventing a total, because counting there means scanning every body.

## Layout

```
index.html               the whole viewer
app/
  corpus.js              SQLite runtime, corpus opening, search (mirrors index.py)
  ui.js                  rendering; corpus text goes in as textContent, never markup
  main.js                browsing, search, reading, history; exposes Decarta.app
  styles.css             light/dark, Japanese-first typography
vendor/                  SQLite WASM, rewritten as a classic script (scripts/vendor-sqlite.sh)
scripts/
  sync-resources.sh      corpus + media into resources/ (VACUUM INTO for WAL corpora)
  open-viewer.command    start a browser allowed to read resources/
  vendor-sqlite.sh       regenerate vendor/ from npm
  selftest.cjs           headless end-to-end check in a real browser
resources/               corpus.db + media/ — git-ignored, see below
```

## Checking it

```sh
node scripts/selftest.cjs                      # fetch path (--allow-file-access-from-files)
node scripts/selftest.cjs --fallback           # the file-picker path
node scripts/selftest.cjs --wal ../decarta/build/corpus.db   # a WAL corpus picked from elsewhere
node scripts/selftest.cjs --screenshot out.png
```

It drives the shipped code in real Chromium over the DevTools Protocol (no npm
dependencies — Node's built-in WebSocket) and asserts on what comes back, including
reporting parity with the CLI. Measured on the real corpus: 23 checks green, corpus
browsable **0.6 s** after navigation, 345 MB opened out of `resources/`, `自由の女神`
→ the same 8 hits and the same top hit (`自由の女神像`) as `make query`, `ＦＵＪＩ` → 5
after NFKC retry, `火山` → the `LIKE` path with no invented total, 富士山's 4 pictures
decoded from `resources/media/`, cross-reference navigation and back. The `--wal` mode
additionally opens a WAL-flagged corpus (checked on disk first, so the pass cannot come
from being handed an ordinary file) and reads the same 39,491 articles through the
header fallback.

## Legal / provenance

Same policy as `decarta`: this repo contains no encyclopedia content. The corpus, the
media tree and anything extracted from the disc stay local and git-ignored; the viewer
reads only from `resources/`, fetches nothing but its own files, and has no network code.
Extraction happens in the `decarta` checkout against a disc the user owns; nothing here
redistributes or republishes it.

Do not commit `resources/`, a `corpus.db`, or the media tree.

## Status

The viewer works end to end against the real corpus: browse by 五十音, page through
entries, search, read, follow cross-references, back through history, pictures and
captions. Known gaps, all deliberate for now: the disc's thumbnail/audio/video
derivatives stay referenced-but-unshown (as in the native reader), there is no
"referenced by" paging beyond 40 rows, and the whole corpus lives in browser memory —
fine at 345 MB, not a design that would survive a 10× corpus.
