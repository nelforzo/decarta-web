# decarta-web

A portable, offline HTML viewer for the encyclopedia corpus built by
[decarta](../decarta). Same content, same search, no install: open `index.html` in a
browser and browse the corpus straight out of the local `resources/` directory.

```
decarta (extractor)  ──▶  corpus.db (+ media/)  ──▶  decarta-web/resources/  ──▶  browser
```

The native macOS app in `../decarta` is the reference implementation: this project
reuses its `corpus.db` unchanged (schema v2) and mirrors its behaviour — 五十音 browse
sidebar, paged entry lists, article reading with media and captions, cross-reference
navigation and "referenced by" backlinks, and the corpus's own FTS5 search path.
Nothing about the corpus format is re-derived here; `meta.tokenizer` and
`meta.schema_version` travel with the data and both readers obey them.

## Layout

```
index.html            the whole viewer
app/                  viewer source (ES modules, no build step, no network)
vendor/               SQLite WASM runtime, vendored
scripts/
  sync-resources.sh   copy or symlink corpus.db + media from ../decarta into resources/
resources/            corpus.db + media/ + deps/ — git-ignored, see below
```

## Running it

```sh
scripts/sync-resources.sh          # or --link to symlink while iterating
open index.html                    # no server, no network
```

## Legal / provenance

Same policy as `decarta`: this repo contains no encyclopedia content. The corpus, the
media tree and anything extracted from the disc stay local and git-ignored; the viewer
reads only from `resources/`, fetches nothing, and has no network code. Extraction
happens in the `decarta` checkout against a disc the user owns; nothing here
redistributes or republishes it.

Do not commit `resources/`, a `corpus.db`, or the media tree.

## Status

Work in progress. The corpus format is proven (39,491 articles, 306,408 cross-references,
8,157 pictures, FTS5 + `trigram`) and the viewer is being built against it.
