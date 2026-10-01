/* Wiring: opening a corpus, browsing, searching, reading, and history. */
(function () {
  'use strict';

  const D = globalThis.Decarta;
  const U = D.ui;
  const PAGE = 300;          // entries per page, matching the native reader's feel
  const BACKLINK_LIMIT = 40;
  const SEARCH_LIMIT = 300;
  const SEARCH_DEBOUNCE = 180;

  const dom = {
    banner: document.getElementById('banner'),
    layout: document.getElementById('layout'),
    search: document.getElementById('search'),
    searchstate: document.getElementById('searchstate'),
    stats: document.getElementById('stats'),
    openbutton: document.getElementById('openbutton'),
    categories: document.getElementById('categories'),
    listpane: document.getElementById('listpane'),
    listsummary: document.getElementById('listsummary'),
    entries: document.getElementById('entries'),
    listfoot: document.getElementById('listfoot'),
    reader: document.getElementById('reader'),
    readerbar: document.getElementById('readerbar'),
    back: document.getElementById('back'),
    article: document.getElementById('article'),
    dropper: document.getElementById('dropper'),
    dropmessage: document.getElementById('dropmessage'),
    fileinput: document.getElementById('fileinput'),
  };

  const state = {
    corpus: null,
    categories: [],
    totalArticles: 0,
    category: null,
    categoryTotal: 0,
    query: '',
    entries: [],
    matchTotal: 0,
    offset: 0,
    hasMore: false,
    loading: false,
    currentSlug: null,
    history: [],
    historyIndex: -1,
  };

  // ---- corpus loading ------------------------------------------------------

  function setStats() {
    const c = state.corpus;
    if (!c) { dom.stats.textContent = 'no corpus'; return; }
    const totals = c.totals();
    const built = (c.builtAt || '').slice(0, 10);
    dom.stats.textContent = `${U.number(totals.articles)} articles · `
      + `${U.number(totals.xrefs)} links · ${built}`;
    dom.stats.title = `source: ${c.sourceLabel}\ntokenizer: ${c.tokenizer}\n`
      + `picture rows: ${U.number(totals.media)}\ncharacters: ${U.number(totals.chars)}`;
  }

  function afterOpen(corpus) {
    state.corpus = corpus;
    setStats();
    state.categories = corpus.categories();
    state.totalArticles = corpus.countEntries(null);
    U.renderCategories(dom.categories, state.categories, state.category, state.totalArticles, selectCategory);
    dom.search.disabled = false;
    dom.layout.setAttribute('aria-busy', 'false');
    dom.dropper.hidden = true;
    dom.openbutton.hidden = false;
    U.setBanner(dom.banner, corpus.walMode
      ? 'This corpus is a WAL-mode database: it was opened from the checkpointed image inside'
        + ' the file, since a browser cannot create the sidecar a write-ahead log needs.'
        + ' Run scripts/sync-resources.sh for a corpus that needs no such adjustment.' : '');
    // How long the viewer needed before the corpus was browsable, measured from the
    // navigation start — the number the selftest reports and the docs quote.
    D.loadMs = Math.round(performance.now());
    selectCategory(null);
    updateStatsBanner();
  }

  function updateStatsBanner() {
    // One line of context about how this session got its bytes — never a silent mode.
    const how = [];
    how.push(`SQLite runtime: ${D.flags.wasm} wasm`);
    how.push(D.flags.corpus.startsWith('file') ? 'corpus: opened from a local file you picked'
      : 'corpus: read from resources/corpus.db');
    if (state.corpus && state.corpus.walMode) {
      how.push('journal: file was WAL-flagged; read as its checkpointed image');
    }
    dom.stats.title += `\n${how.join('\n')}`;
  }

  function showOpenPanel(message) {
    dom.dropper.hidden = false;
    U.clear(dom.dropmessage);
    const lines = String(message).split('\n');
    for (const line of lines) {
      dom.dropmessage.append(U.el('p', { text: line }));
    }
    dom.layout.setAttribute('aria-busy', 'false');
  }

  async function openFromResources() {
    U.setBanner(dom.banner, 'loading the SQLite runtime…');
    const sqlite3 = await D.loadRuntime();
    U.setBanner(dom.banner, `reading ${D.CORPUS_URL}…`);
    const corpus = await D.fetchCorpus(sqlite3, (fraction) => {
      U.setBanner(dom.banner, `reading ${D.CORPUS_URL}… ${Math.round(fraction * 100)}%`);
    });
    return corpus;
  }

  async function openFromFile(file) {
    if (!file) return;
    U.setBanner(dom.banner, `opening ${file.name} (${(file.size / 1048576).toFixed(0)} MiB)…`);
    dom.dropper.hidden = true;
    try {
      const sqlite3 = await D.loadRuntime();
      const corpus = await D.openFile(sqlite3, file, (fraction) => {
        U.setBanner(dom.banner, `reading ${file.name}… ${Math.round(fraction * 100)}%`);
      });
      afterOpen(corpus);
    } catch (error) {
      U.setBanner(dom.banner, `could not open ${file.name}: ${error.message}`, 'warn');
      showOpenPanel(error.message);
    }
  }

  // ---- list ----------------------------------------------------------------

  function selectCategory(category) {
    state.category = category;
    state.query = '';
    dom.search.value = '';
    dom.searchstate.textContent = '';
    state.categoryTotal = state.corpus.countEntries(category);
    state.entries = [];
    state.offset = 0;
    state.matchTotal = 0;
    U.renderCategories(dom.categories, state.categories, category, state.totalArticles, selectCategory);
    dom.listsummary.textContent = U.summary(state);
    U.clear(dom.entries);
    U.footNote(dom.listfoot, '');
    loadPage();
  }

  function loadPage() {
    if (!state.corpus || state.loading) return;
    const page = state.query
      ? null // search results arrive in one shot
      : state.corpus.entries(state.category, state.offset, PAGE);
    if (!page) return;
    state.loading = true;
    state.entries = state.entries.concat(page);
    state.offset += page.length;
    state.hasMore = page.length === PAGE && state.entries.length < state.categoryTotal;
    U.renderEntries(dom.entries, page, openSlug, true);
    dom.listsummary.textContent = U.summary(state);
    U.footNote(dom.listfoot, state.hasMore ? 'scroll for more…' : '');
    state.loading = false;
    if (state.currentSlug) U.selectRow(dom.entries, state.currentSlug);
  }

  function runSearch(text) {
    const query = text.trim();
    state.query = query;
    state.entries = [];
    state.offset = 0;
    state.hasMore = false;
    U.clear(dom.entries);
    U.footNote(dom.listfoot, '');
    if (!query) {
      dom.searchstate.textContent = '';
      selectCategory(state.category);
      return;
    }
    const started = performance.now();
    const result = state.corpus.search(query, SEARCH_LIMIT);
    state.entries = result.entries;
    state.matchTotal = result.total;
    state.categoryTotal = result.entries.length;
    const took = Math.round(performance.now() - started);
    U.renderEntries(dom.entries, result.entries, openSlug, false);
    dom.listsummary.textContent = U.summary(state);
    dom.searchstate.textContent = `${took} ms`;
    if (!result.entries.length) U.footNote(dom.listfoot, 'no matches');
    else if (result.total === null) U.footNote(dom.listfoot, 'the short-query path cannot count cheaply');
    else U.footNote(dom.listfoot, '');
    if (state.currentSlug) U.selectRow(dom.entries, state.currentSlug);
  }

  // ---- reading and history -------------------------------------------------

  function openSlug(slug, options) {
    const article = state.corpus.article(slug);
    if (!article) return;
    state.currentSlug = slug;
    U.selectRow(dom.entries, slug);
    if (!options || !options.fromHistory) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(slug);
      state.historyIndex = state.history.length - 1;
    }
    const backlinks = state.corpus.backlinks(slug, BACKLINK_LIMIT);
    U.renderArticle(dom.article, article, backlinks, { open: openSlug, mediaUrl: (m) => state.corpus.mediaUrl(m) });
    dom.readerbar.hidden = false;
    dom.back.disabled = state.historyIndex <= 0;
  }

  function goBack() {
    if (state.historyIndex <= 0) return;
    state.historyIndex -= 1;
    openSlug(state.history[state.historyIndex], { fromHistory: true });
  }

  dom.back.addEventListener('click', goBack);

  // ---- events --------------------------------------------------------------

  let searchTimer = null;
  dom.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const value = dom.search.value;
    if (!value.trim()) { runSearch(''); return; }
    searchTimer = setTimeout(() => runSearch(value), SEARCH_DEBOUNCE);
  });

  dom.listpane.addEventListener('scroll', () => {
    if (!state.hasMore || state.loading) return;
    const { scrollTop, scrollHeight, clientHeight } = dom.listpane;
    if (scrollHeight - (scrollTop + clientHeight) < 400) loadPage();
  });

  dom.fileinput.addEventListener('change', () => openFromFile(dom.fileinput.files[0]));
  dom.openbutton.addEventListener('click', () => showOpenPanel('Pick resources/corpus.db, or drop it anywhere on this window.'));

  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (event) => {
      event.preventDefault();
      if (!state.corpus) dom.dropper.hidden = false;
    });
  }
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) openFromFile(file);
  });

  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === '/' && document.activeElement !== dom.search) {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
      return;
    }
    if (event.key === 'Escape' && document.activeElement === dom.search) {
      dom.search.value = '';
      runSearch('');
      dom.search.blur();
      return;
    }
    if ((meta && event.key === '[') || (event.altKey && event.key === 'ArrowLeft')) {
      event.preventDefault();
      goBack();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'j' || event.key === 'k') {
      if (document.activeElement === dom.search || document.activeElement === dom.fileinput) return;
      const step = (event.key === 'ArrowDown' || event.key === 'j') ? 1 : -1;
      const index = state.entries.findIndex((e) => e.slug === state.currentSlug);
      const next = state.entries[index + step];
      if (next) {
        event.preventDefault();
        openSlug(next.slug);
        const row = dom.entries.querySelector(`.row[data-slug="${CSS.escape(next.slug)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  // ---- boot ----------------------------------------------------------------

  /* Exposed so a headless check can drive the same paths the UI uses (see
   * scripts/selftest.cjs) — the reader has no separate "test API". */
  D.app = {
    state,
    openSlug,
    runSearch,
    selectCategory,
    openFromFile,
    whenReady: null,
  };

  async function boot() {
    try {
      afterOpen(await openFromResources());
    } catch (error) {
      D.flags.corpus = 'unavailable';
      U.setBanner(dom.banner, `${error.message}`, 'warn');
      showOpenPanel(`resources/corpus.db could not be read automatically: ${error.message}`);
      // The runtime may still be usable for a file the user picks.
      D.loadRuntime().catch(() => {});
      dom.search.disabled = true;
    }
  }

  D.app.whenReady = boot();
})();
