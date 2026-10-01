/* Reading a decarta corpus (schema v2) in a browser.
 *
 * Loaded as a classic script — see index.html for why this project cannot use ES
 * modules. Everything hangs off globalThis.Decarta.
 *
 * The SQL here is deliberately the same as the native reader's
 * (../decarta/app/Sources/decarta/Corpus.swift) and the CLI's
 * (../decarta/extractor/decarta_extract/index.py), so the web viewer answers a query
 * exactly the way the other two do. The interesting part is search dispatch: the corpus
 * stores which tokenizer it was built with in meta.tokenizer, and the reader obeys it.
 */
(function () {
  'use strict';

  const D = (globalThis.Decarta = globalThis.Decarta || {});

  D.SCHEMA_VERSION = '2';
  D.SHORT_QUERY_LENGTH = 3;
  D.CORPUS_URL = 'resources/corpus.db';
  D.MEDIA_DIR = 'resources/media';
  D.WASM_URL = 'vendor/sqlite3.wasm';

  /* How we got the bytes this session — shown in the UI so it is never a mystery
   * whether the reader found resources/ by itself. */
  D.flags = { wasm: 'pending', corpus: 'pending' };

  const CHUNK_BYTES = 8 * 1024 * 1024;

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  let runtimePromise = null;

  /* Instantiate SQLite. The wasm is loaded with fetch() when that works (an http-
   * served page, or a browser started with file access enabled) and otherwise from the
   * base64 copy vendored beside it, because a file:// page is not allowed to fetch. */
  D.loadRuntime = function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
      const config = {};
      try {
        const response = await fetch(D.WASM_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        config.wasmBinary = await response.arrayBuffer();
        D.flags.wasm = 'fetched';
      } catch (error) {
        if (!globalThis.SQLITE3_WASM_BASE64) {
          throw new Error(`could not load the SQLite runtime (${error.message}) and `
            + 'vendor/sqlite3.wasm.b64.js is missing — run scripts/vendor-sqlite.sh');
        }
        config.wasmBinary = base64ToBytes(globalThis.SQLITE3_WASM_BASE64);
        D.flags.wasm = 'embedded';
      }
      if (typeof globalThis.sqlite3InitModule !== 'function') {
        throw new Error('vendor/sqlite3.js did not load — check the script path in index.html');
      }
      return globalThis.sqlite3InitModule(config);
    })();
    return runtimePromise;
  };

  /* `resources/corpus.db`, when the page is allowed to read it. Streamed straight into
   * the wasm heap when the server declares a length, so the 345 MB is never held twice;
   * a body of unknown length (which is what a file:// fetch gives) is collected first. */
  D.fetchCorpus = async function fetchCorpus(sqlite3, onProgress) {
    const response = await fetch(D.CORPUS_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${D.CORPUS_URL}`);
    const declared = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const writer = declared ? heapWriter(sqlite3, declared) : null;
    const chunks = [];
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writer) {
        if (seen + value.length > declared) {
          throw new Error(`${D.CORPUS_URL} is longer than the ${declared} bytes it announced`);
        }
        writer.write(value, seen);
      } else {
        chunks.push(value);
      }
      seen += value.length;
      if (onProgress) onProgress(declared ? seen / declared : 0);
    }
    if (!seen) throw new Error(`${D.CORPUS_URL} is empty`);
    D.flags.corpus = 'fetched';
    if (writer) {
      if (seen !== declared) {
        throw new Error(`${D.CORPUS_URL} is ${seen} bytes, not the ${declared} it announced`);
      }
      return D.openPointer(sqlite3, writer.done().pointer, seen);
    }
    const bytes = new Uint8Array(seen);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return D.openBytes(sqlite3, bytes);
  };

  /* Copy a File into the wasm heap a slice at a time.
   *
   * The corpus is ~345 MB. Reading it into one JS ArrayBuffer and then handing that to
   * the wasm would hold both copies at once; writing 8 MB slices straight into the heap
   * keeps the peak at the heap plus one slice. */
  D.readIntoHeap = async function readIntoHeap(sqlite3, file, onProgress) {
    const size = file.size;
    if (!size) throw new Error(`${file.name} is empty`);
    const writer = heapWriter(sqlite3, size);
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, size);
      const slice = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      writer.write(slice, offset);
      if (onProgress) onProgress(end / size);
    }
    return writer.done();
  };

  /* A preallocated stretch of the wasm heap that slices can be copied into, plus the
   * pointer/size pair sqlite3_deserialize wants. */
  function heapWriter(sqlite3, size) {
    const pointer = sqlite3.wasm.alloc(size);
    if (!pointer) throw new Error('could not allocate memory for the corpus');
    return {
      write(chunk, offset) { sqlite3.wasm.heap8u().set(chunk, pointer + offset); },
      done() { return { pointer, size }; },
    };
  }

  D.openFile = async function openFile(sqlite3, file, onProgress) {
    const { pointer, size } = await D.readIntoHeap(sqlite3, file, onProgress);
    D.flags.corpus = `file ${file.name}`;
    return D.openPointer(sqlite3, pointer, size);
  };

  /* Wrap a byte array (already in wasm memory) as a database.
   *
   * sqlite3_deserialize() is the way to open a database the reader cannot be handed as a
   * path: the file is in a directory the browser will not open, so its bytes are the only
   * thing we have. SQLITE_DESERIALIZE_FREEONCLOSE gives that buffer to SQLite, which frees
   * it when the database closes; RESIZEABLE keeps the file writable in-memory, which the
   * compiled-in WAL/rollback machinery expects.
   *
   * A WAL-mode corpus cannot be opened this way — it wants -shm sidecars it has no way to
   * create — and reports SQLITE_CANTOPEN; scripts/sync-resources.sh writes the corpus in
   * rollback-journal mode for exactly this reason, and the error below says so. */
  D.openPointer = function openPointer(sqlite3, pointer, size) {
    const capi = sqlite3.capi;
    const db = new sqlite3.oo1.DB();
    const flags = (capi.SQLITE_DESERIALIZE_FREEONCLOSE || 1) | (capi.SQLITE_DESERIALIZE_RESIZEABLE || 2);
    const rc = capi.sqlite3_deserialize(db.pointer, 'main', pointer, size, size, flags);
    if (rc !== 0) {
      try { db.close(); } catch (ignore) { /* already unusable */ }
      const name = (capi.sqlite3_js_rc_str && capi.sqlite3_js_rc_str(rc)) || rc;
      throw new Error(rc === 14
        ? `${name} — a WAL-mode corpus cannot be opened from bytes; re-run scripts/sync-resources.sh`
        : `${name} — the database could not be opened`);
    }
    db.exec('PRAGMA query_only = 1');
    const meta = {};
    for (const row of db.selectObjects('SELECT key, value FROM meta')) meta[row.key] = row.value;
    const version = meta.schema_version;
    if (version !== D.SCHEMA_VERSION) {
      db.close();
      throw new Error(`corpus schema ${version} is not supported by this build (expected ${D.SCHEMA_VERSION})`);
    }
    if (meta.tokenizer !== 'trigram' && meta.tokenizer !== 'unicode61') {
      db.close();
      throw new Error(`corpus was built with an unknown tokenizer (${meta.tokenizer})`);
    }
    return new Corpus(sqlite3, db, meta);
  };

  D.openBytes = function openBytes(sqlite3, bytes) {
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    return D.openPointer(sqlite3, pointer, bytes.byteLength);
  };

  // ---- search, mirroring index.py / Corpus.swift --------------------------

  /* Split a query on whitespace, leaving the text exactly as typed. */
  D.splitTerms = function splitTerms(text) {
    return text.trim().split(/\s+/u).filter(Boolean);
  };

  /* NFKC-normalize the query and split it. Buttons and IMEs hand over full-width Latin
   * and half-width katakana that never match the indexed text — measured on this corpus,
   * `ＦＵＪＩ` matched 0 articles as typed and 5 once normalized, `ﾌｼﾞ` went from 0 to 126.
   * JavaScript's normalize('NFKC') is the same operation Python used to build the corpus,
   * and unlike Swift's it composes the result, so no second pass is needed. */
  D.queryTerms = function queryTerms(text) {
    return text.normalize('NFKC').trim().split(/\s+/u).filter(Boolean);
  };

  D.phrase = function phrase(text) {
    return `"${text.replace(/"/g, '""')}"`;
  };

  /* Escape the LIKE wildcards so a user can search for `%` or `_`. */
  D.escapeLike = function escapeLike(text) {
    return text.replace(/[\\%_]/g, (c) => `\\${c}`);
  };

  D.LEXICAL_CACHE = null;

  class Corpus {
    constructor(sqlite3, db, meta) {
      this.sqlite3 = sqlite3;
      this.db = db;
      this.meta = meta;
      this.tokenizer = meta.tokenizer;
      this.closed = false;
    }

    get schemaVersion() { return this.meta.schema_version; }
    get sourceLabel() { return this.meta.source_label || 'unknown'; }
    get builtAt() { return this.meta.built_at || 'unknown'; }
    get mediaRoot() { return this.meta.media_root || ''; }

    rows(sql, bind) {
      // Passing an empty bind array at all is an error in this wrapper ("no bindable
      // parameters"), so the argument is only supplied when there is something to bind.
      return bind && bind.length ? this.db.selectObjects(sql, bind) : this.db.selectObjects(sql);
    }

    value(sql, bind) {
      return bind && bind.length ? this.db.selectValue(sql, bind) : this.db.selectValue(sql);
    }

    totals() {
      return {
        articles: Number(this.value('SELECT COUNT(*) FROM articles')),
        media: Number(this.value("SELECT COUNT(*) FROM media WHERE kind = 'image'")),
        xrefs: Number(this.value('SELECT COUNT(*) FROM xrefs')),
        chars: Number(this.value('SELECT COALESCE(SUM(char_count), 0) FROM articles')),
      };
    }

    categories() {
      return this.rows('SELECT category, COUNT(*) AS n FROM articles'
        + ' GROUP BY category ORDER BY category')
        .map((row) => ({ category: row.category, count: Number(row.n) }));
    }

    countEntries(category) {
      return Number(category
        ? this.value('SELECT COUNT(*) FROM articles WHERE category = ?', [category])
        : this.value('SELECT COUNT(*) FROM articles'));
    }

    /* A page of entries, in the native reader's order (kana reading, then title). */
    entries(category, offset, limit) {
      const columns = 'id, slug, title, reading, category, char_count';
      const order = 'ORDER BY reading COLLATE NOCASE, title COLLATE NOCASE';
      const rows = category
        ? this.rows(`SELECT ${columns} FROM articles WHERE category = ? ${order} LIMIT ? OFFSET ?`,
          [category, limit, offset])
        : this.rows(`SELECT ${columns} FROM articles ${order} LIMIT ? OFFSET ?`, [limit, offset]);
      return rows.map(entry);
    }

    entry(slug) {
      const rows = this.rows('SELECT id, slug, title, reading, category, char_count'
        + ' FROM articles WHERE slug = ? LIMIT 1', [slug]);
      return rows.length ? entry(rows[0]) : null;
    }

    article(slug) {
      const rows = this.rows('SELECT id, slug, title, reading, category, char_count, body, source_path'
        + ' FROM articles WHERE slug = ? LIMIT 1', [slug]);
      if (!rows.length) return null;
      const row = rows[0];
      const pictures = this.rows('SELECT id, kind, rel_path, caption FROM media WHERE article_id = ?',
        [Number(row.id)]);
      const xrefs = this.rows('SELECT x.target_slug, x.anchor, COALESCE(a.title, \'\') AS title'
        + ' FROM xrefs x LEFT JOIN articles a ON a.slug = x.target_slug'
        + ' WHERE x.article_id = ? ORDER BY x.ordinal', [Number(row.id)]);
      return {
        entry: entry(row),
        body: row.body,
        sourcePath: row.source_path,
        media: pictures.map((m) => ({
          id: Number(m.id),
          kind: m.kind,
          relPath: m.rel_path,
          caption: m.caption,
        })),
        xrefs: xrefs.map((x) => ({
          targetSlug: x.target_slug,
          anchor: x.anchor,
          title: x.title,
        })),
      };
    }

    /* Every article that cross-references `slug` — the "referenced by" direction. */
    backlinks(slug, limit) {
      return this.rows('SELECT a.id, a.slug, a.title, a.reading, a.category, a.char_count'
        + ' FROM xrefs x JOIN articles a ON a.id = x.article_id'
        + ' WHERE x.target_slug = ? GROUP BY a.id ORDER BY a.title COLLATE NOCASE LIMIT ?',
      [slug, limit]).map(entry);
    }

    /* How many picture rows exist and how many are actually beside the corpus. The
     * browser cannot stat a file, so the count of copied pictures is a manifest check:
     * thumbnails and audio were never copied out of the disc's containers. */
    mediaStats() {
      return {
        pictures: Number(this.value("SELECT COUNT(*) FROM media WHERE kind = 'image'")),
        derived: Number(this.value("SELECT COUNT(*) FROM media WHERE kind = 'thumb'")),
      };
    }

    mediaUrl(media) {
      return `${D.MEDIA_DIR}/${media.relPath}`;
    }

    /* Full-text search, dispatching on the corpus's tokenizer.
     *
     * The query is tried exactly as typed and only re-tried NFKC-normalized when that
     * finds nothing — normalizing up front breaks as much as it fixes, since titles on
     * this disc legitimately contain full-width punctuation (`JAL（ジャル）`).
     *
     * Returns { entries, total } where `total` is null on the LIKE path: counting there
     * means scanning every body (~50-90 ms measured), so the UI says "N+" instead of
     * inventing a number. */
    search(text, limit) {
      const raw = D.splitTerms(text);
      if (!raw.length) return { entries: [], total: 0 };
      const typed = this.searchTerms(raw, limit);
      if (typed.entries.length) return typed;
      const normalized = D.queryTerms(text);
      if (sameTerms(normalized, raw)) return typed;
      return this.searchTerms(normalized, limit);
    }

    searchTerms(terms, limit) {
      if (this.tokenizer === 'trigram' && terms.some((t) => t.length < D.SHORT_QUERY_LENGTH)) {
        return this.likeSearch(terms, limit);
      }
      try {
        const match = this.matchExpression(terms);
        if (!match) return { entries: [], total: 0 };
        return {
          entries: this.ftsSearch(match, limit),
          total: Number(this.value('SELECT COUNT(*) FROM articles_fts WHERE articles_fts MATCH ?', [match])),
        };
      } catch (error) {
        // Anything the FTS parser rejects degrades to LIKE rather than surfacing an error.
        return this.likeSearch(terms, limit);
      }
    }

    matchExpression(terms) {
      if (this.tokenizer === 'trigram') {
        // Substring matching is how CJK is searched; quoting keeps prose punctuation
        // from becoming FTS syntax.
        return terms.map(D.phrase).join(' AND ');
      }
      const tokens = [];
      for (const term of terms) {
        for (const token of term.match(/[^\W_]+/gu) || []) tokens.push(token);
      }
      if (!tokens.length) return '';
      const parts = tokens.map(D.phrase);
      parts[parts.length - 1] += '*'; // prefix on the last token: live-feeling Latin search
      return parts.join(' ');
    }

    ftsSearch(match, limit) {
      return this.rows('SELECT a.id, a.slug, a.title, a.reading, a.category, a.char_count,'
        + " snippet(articles_fts, 2, '', '', '…', 18) AS snip"
        + ' FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid'
        + ' WHERE articles_fts MATCH ? ORDER BY bm25(articles_fts, 8.0, 4.0, 1.0) LIMIT ?',
      [match, limit]).map(entry);
    }

    /* Two-tier LIKE for queries the trigram index cannot serve (< 3 characters).
     *
     * Ranking every match by length(title) forces a scan and sort of the whole corpus
     * (82-104 ms measured). Titles and readings are instead queried and ranked on their
     * own — few rows, and the most relevant ones anyway — and the body only fills the
     * rest of the page, unordered. */
    likeSearch(terms, limit) {
      const patterns = terms.map((term) => `%${D.escapeLike(term)}%`);
      const head = terms.map(() => "(title LIKE ? ESCAPE '\\' OR reading LIKE ? ESCAPE '\\')").join(' AND ');
      const headBind = patterns.flatMap((pattern) => [pattern, pattern]);
      const columns = 'id, slug, title, reading, category, char_count';
      const entries = this.rows(`SELECT ${columns}, '' AS snip FROM articles WHERE ${head}`
        + ' ORDER BY length(title), title COLLATE NOCASE LIMIT ?', [...headBind, limit]).map(entry);
      if (entries.length >= limit) return { entries, total: null };

      const body = terms.map(() => "(title LIKE ? ESCAPE '\\' OR reading LIKE ? ESCAPE '\\'"
        + " OR body LIKE ? ESCAPE '\\')").join(' AND ');
      const bodyBind = patterns.flatMap((pattern) => [pattern, pattern, pattern]);
      const seen = new Set(entries.map((e) => e.id));
      const extra = this.rows(`SELECT ${columns}, substr(body, 1, 160) AS snip FROM articles`
        + ` WHERE ${body} LIMIT ?`, [...bodyBind, limit + entries.length])
        .map(entry)
        .filter((e) => !seen.has(e.id));
      return { entries: entries.concat(extra).slice(0, limit), total: null };
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.db.close();
    }
  }

  function entry(row) {
    return {
      id: Number(row.id),
      slug: row.slug,
      title: row.title,
      reading: row.reading || '',
      category: row.category,
      charCount: Number(row.char_count),
      snippet: row.snip || '',
    };
  }

  function sameTerms(a, b) {
    return a.length === b.length && a.every((term, i) => term === b[i]);
  }

  D.Corpus = Corpus;
})();
