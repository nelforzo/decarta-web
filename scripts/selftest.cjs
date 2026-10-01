#!/usr/bin/env node
/* Headless check of the viewer against a real browser, the same idea as the native
 * reader's `--selftest`: drive the shipped code path and assert on what it returns.
 *
 *   node scripts/selftest.cjs              # file:// with file access enabled (fetch path)
 *   node scripts/selftest.cjs --fallback   # file:// without it (the picker path)
 *
 * Chromium comes from the Playwright cache (CHROME=/path/to/binary to override), driven
 * over the DevTools Protocol with Node's built-in WebSocket — no npm dependencies.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = 'file://' + path.join(ROOT, 'index.html');
const CORPUS = path.join(ROOT, 'resources', 'corpus.db');
const FALLBACK = process.argv.includes('--fallback');
const PORT = Number(process.env.PORT || 9345);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  for (const entry of fs.readdirSync(cache)) {
    if (!entry.startsWith('chromium-')) continue;
    const dir = path.join(cache, entry, 'chrome-mac-arm64');
    if (!fs.existsSync(dir)) continue;
    const app = fs.readdirSync(dir).find((name) => name.endsWith('.app'));
    if (!app) continue;
    const name = fs.readdirSync(path.join(dir, app, 'Contents', 'MacOS'))[0];
    return path.join(dir, app, 'Contents', 'MacOS', name);
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function get(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed')));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    ready,
    onEvent(listener) { listeners.push(listener); },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function main() {
  if (!fs.existsSync(CORPUS)) {
    console.error(`no corpus at ${CORPUS} — run scripts/sync-resources.sh first`);
    process.exit(2);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('no Chromium found — set CHROME=/path/to/binary');
    process.exit(2);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'decarta-web-selftest-'));
  const flags = ['--no-sandbox', '--no-first-run', '--disable-gpu', '--headless=new',
    '--window-size=1440,900', '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
  if (!FALLBACK) flags.push('--allow-file-access-from-files');
  const chrome = spawn(chromePath, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const cleanup = () => { try { chrome.kill(); } catch (error) { /* gone */ } };
  process.on('exit', cleanup);

  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { await get(PORT, '/json/version'); up = true; } catch (error) { await sleep(200); }
  }
  if (!up) throw new Error('the browser never opened its devtools port');

  const target = JSON.parse(await get(PORT, '/json/new?about:blank', 'PUT'));
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');

  const problems = [];
  cdp.onEvent((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push(message.params.exceptionDetails.exception?.description
        || message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail.split('\n')[0]);
    }
    return result.result.value;
  };

  const poll = async (expression, predicate, timeoutMs, label) => {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      try { last = await evaluate(expression, true); } catch (error) { last = `threw ${error.message}`; }
      if (predicate(last)) return last;
      await sleep(300);
    }
    throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
  };

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  await cdp.send('Page.navigate', { url: PAGE_URL });

  if (FALLBACK) {
    // No file access: the page must say so and offer the picker rather than look broken.
    const panel = await poll('document.getElementById("dropper").hidden ? "" : document.getElementById("dropmessage").textContent',
      (value) => typeof value === 'string' && value.length > 0, 30000, 'the open panel');
    check('without file access the viewer asks for the corpus', panel.includes('could not be read'), panel.slice(0, 70));
    const node = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', { nodeId: node.root.nodeId, selector: '#fileinput' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [CORPUS] });
  }

  const settled = await poll(
    `(async () => { if (!globalThis.Decarta || !Decarta.app) return {corpus:false};
       await Decarta.app.whenReady; const s = Decarta.app.state;
       return { corpus: !!s.corpus, wasm: Decarta.flags.wasm, source: Decarta.flags.corpus,
         entries: s.entries.length, categories: s.categories.length,
         stats: document.getElementById('stats').textContent }; })()`,
    (value) => value && value.corpus, 240000, 'the corpus to load');

  check('corpus loaded', settled.corpus, `${settled.source} · wasm ${settled.wasm}`);
  check(FALLBACK ? 'corpus came from the picked file' : 'corpus read from resources/corpus.db',
    FALLBACK ? settled.source.startsWith('file') : settled.source === 'fetched', settled.source);
  if (!settled.corpus) { report(checks, problems); process.exit(1); }

  const facts = await evaluate(`(() => { const c = Decarta.app.state.corpus;
     const totals = c.totals(); const categories = c.categories();
     return { totals, tokenizer: c.tokenizer, schema: c.schemaVersion,
       categorySum: categories.reduce((n, row) => n + row.count, 0), categoryCount: categories.length,
       entries: Decarta.app.state.entries.length }; })()`);
  check('schema version is 2', facts.schema === '2', facts.schema);
  check('tokenizer travels with the corpus', facts.tokenizer === 'trigram', facts.tokenizer);
  check('article count matches meta', facts.totals.articles === 39491, String(facts.totals.articles));
  check('五十音 buckets cover every article', facts.categorySum === facts.totals.articles,
    `${facts.categorySum} over ${facts.categoryCount} buckets`);
  check('first page of entries is filled', facts.entries === 300, String(facts.entries));

  // Search parity with the CLI: `make query Q="自由の女神"` reports 8 results, top hit 自由の女神像.
  const search = await evaluate(`(() => { Decarta.app.runSearch('自由の女神'); const s = Decarta.app.state;
     return { total: s.matchTotal, top: s.entries.slice(0, 3).map((e) => e.title),
       summary: document.getElementById('listsummary').textContent }; })()`);
  check('trigram search matches the CLI count', search.total === 8, search.summary);
  check('search ranks the same top hit as the CLI', search.top[0] === '自由の女神像', search.top.join(' / '));

  // NFKC on retry: the query as typed must be tried first and only rewritten when it
  // matched nothing (rewriting up front is what makes `JAL（ジャル）` unfindable). The CLI
  // reports 5 results for the full-width form `ＦＵＪＩ`, 0 for it as typed.
  const quoted = await evaluate(`(() => { Decarta.app.runSearch('ＦＵＪＩ'); const s = Decarta.app.state;
     return { total: s.matchTotal, summary: document.getElementById('listsummary').textContent }; })()`);
  check('full-width Latin is normalised when it matches nothing', quoted.total === 5, quoted.summary);

  // Half-width kana must rank exactly like their full-width form, since normalization
  // happens on the retry and the LIKE path is what serves a two-character query.
  const kana = await evaluate(`(() => {
     Decarta.app.runSearch('フジ'); const wide = Decarta.app.state.entries.slice(0, 5).map((e) => e.title);
     Decarta.app.runSearch('ﾌｼﾞ'); const half = Decarta.app.state.entries.slice(0, 5).map((e) => e.title);
     return { wide, half }; })()`);
  check('half-width kana ranks like full-width',
    kana.wide.length > 0 && kana.wide.join('|') === kana.half.join('|'),
    kana.half.slice(0, 2).join(' / ') || 'no hits');

  // A two-character query cannot be served by the trigram index: it must take the LIKE
  // path and refuse to invent a total.
  const short = await evaluate(`(() => { Decarta.app.runSearch('火山'); const s = Decarta.app.state;
     return { total: s.matchTotal, shown: s.entries.length, summary: document.getElementById('listsummary').textContent }; })()`);
  check('short query takes the LIKE path', short.total === null && short.shown >= 100, short.summary);

  // Paging: a category list appends the next page when scrolled to the end.
  const paging = await evaluate(`(async () => { Decarta.app.runSearch('');
     Decarta.app.selectCategory('か行'); await new Promise((r) => setTimeout(r, 200));
     const before = Decarta.app.state.entries.length;
     document.getElementById('listpane').scrollTop = document.getElementById('listpane').scrollHeight;
     await new Promise((r) => setTimeout(r, 800));
     return { before, after: Decarta.app.state.entries.length }; })()`, true);
  check('scrolling appends the next page', paging.after > paging.before, `${paging.before} -> ${paging.after}`);

  // Reading: pictures are read from resources/media/ over file://, and cross-references
  // are navigable both ways.
  const article = await evaluate(`(async () => { const c = Decarta.app.state.corpus;
     const slug = c.rows("SELECT slug FROM articles WHERE title = '富士山' LIMIT 1")[0].slug;
     Decarta.app.openSlug(slug);
     await new Promise((r) => setTimeout(r, 3000));
     const images = [...document.querySelectorAll('.gallery img')];
     const chips = [...document.querySelectorAll('.relations .chip')];
     return { slug, title: document.querySelector('.articlehead h1').textContent,
       paragraphs: document.querySelectorAll('.articlebody p').length,
       pictures: images.length, loaded: images.filter((i) => i.complete && i.naturalWidth > 0).length,
       firstSize: images.length ? images[0].naturalWidth + 'x' + images[0].naturalHeight : 'n/a',
       captions: [...document.querySelectorAll('figcaption')].filter((f) => f.textContent.trim()).length,
       chips: chips.length, backlinks: document.querySelectorAll('.relations').length }; })()`, true);
  check('article body renders as paragraphs', article.paragraphs > 5, `${article.paragraphs} paragraphs`);
  check('pictures load from resources/media/', article.pictures > 0 && article.loaded === article.pictures,
    `${article.loaded}/${article.pictures} (${article.firstSize}), ${article.captions} captions`);
  check('cross-references and backlinks are offered', article.chips > 2, `${article.chips} links`);

  const navigation = await evaluate(`(async () => { const chip = [...document.querySelectorAll('.relations .chip')]
       .find((c) => !c.disabled); const before = document.querySelector('.articlehead h1').textContent;
     chip.click(); await new Promise((r) => setTimeout(r, 1200));
     const after = document.querySelector('.articlehead h1').textContent;
     document.getElementById('back').click(); await new Promise((r) => setTimeout(r, 1200));
     return { before, after, back: document.querySelector('.articlehead h1').textContent }; })()`, true);
  check('following a cross-reference and coming back works',
    navigation.after !== navigation.before && navigation.back === navigation.before,
    `${navigation.before} -> ${navigation.after} -> ${navigation.back}`);

  const layout = await evaluate(`(() => ({
     overflow: document.documentElement.scrollWidth - window.innerWidth,
     panes: [...document.querySelectorAll('#sidebar, #listpane, #reader')].map((p) => Math.round(p.getBoundingClientRect().width)),
     searchEnabled: !document.getElementById('search').disabled,
     stylesheets: document.styleSheets.length,
     rowFont: getComputedStyle(document.querySelector('.rowtitle') || document.body).fontSize,
     bodyLine: getComputedStyle(document.querySelector('.articlebody p') || document.body).lineHeight,
     loadMs: Decarta.loadMs,
     summary: document.getElementById('listsummary').textContent }))()`);
  check('three panes are laid out side by side', layout.panes.every((w) => w > 100), layout.panes.join(' / '));
  check('no horizontal overflow', layout.overflow <= 0, `overflow ${layout.overflow}px`);
  check('the stylesheet is applied', layout.stylesheets >= 1 && layout.rowFont === '14px',
    `${layout.stylesheets} sheet, row ${layout.rowFont}, article line-height ${layout.bodyLine}`);
  check('search box is live once the corpus is open', layout.searchEnabled, layout.summary);
  check('corpus was browsable within 30 s', layout.loadMs > 0 && layout.loadMs < 30000,
    `${(layout.loadMs / 1000).toFixed(1)} s from navigation start`);

  const shotIndex = process.argv.indexOf('--screenshot');
  if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.argv[shotIndex + 1], Buffer.from(shot.data, 'base64'));
    console.log(`screenshot -> ${process.argv[shotIndex + 1]}\n`);
  }
  // A corpus picked from elsewhere may be a WAL-mode database — the shape the extractor
  // leaves behind in ../decarta/build. The browser cannot open one from bytes (no sidecar),
  // so the viewer clears the file-format WAL flag in its private copy; this proves that and
  // that the corpus reads the same afterwards. The file's header is inspected on disk first,
  // so the check cannot pass by being handed a rollback-journal file.
  const walIndex = process.argv.indexOf('--wal');
  // Absolute: DOM.setFileInputFiles hands the path to the browser process, which does not
  // resolve it against this script's working directory.
  const walPath = walIndex !== -1 ? path.resolve(process.argv[walIndex + 1] || '') : null;
  if (walPath) {
    if (!fs.existsSync(walPath)) {
      check('the WAL corpus exists for the fallback check', false, walPath);
    } else {
      const onDisk = fs.readFileSync(walPath, { start: 0, end: 24 });
      check('the corpus really is WAL-flagged on disk', onDisk[18] === 2 && onDisk[19] === 2,
        `version bytes ${onDisk[18]}/${onDisk[19]}`);
      const node = await cdp.send('DOM.getDocument');
      const input = await cdp.send('DOM.querySelector', { nodeId: node.root.nodeId, selector: '#fileinput' });
      // The picker is hidden once a corpus is loaded, and setFileInputFiles needs a
      // rendered input, so the panel is revealed by hand first.
      await evaluate(`(() => { document.getElementById('dropper').hidden = false; return true; })()`);
      await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [walPath] });
      const swapped = await poll(
        `(async () => { await Decarta.app.whenReady; const c = Decarta.app.state.corpus;
           return { wal: c.walMode, articles: c.totals().articles, tokenizer: c.tokenizer }; })()`,
        (value) => value && value.wal === true, 180000, 'the WAL corpus to open');
      check('a WAL corpus opens anyway, with the fallback reported', swapped.wal === true,
        `${swapped.articles} articles`);
      check('the WAL corpus reads whole', swapped.articles === 39491, String(swapped.articles));
      const walSearch = await evaluate(`(() => { Decarta.app.runSearch('自由の女神');
         return { total: Decarta.app.state.matchTotal,
           banner: document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent.slice(0, 40) }; })()`);
      check('search works on the WAL corpus', walSearch.total === 8,
        `${walSearch.total} hits · banner “${walSearch.banner}…”`);
    }
  }

  check('no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 2).join(' | '));

  report(checks, problems);
  cleanup();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

function report(checks, problems) {
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed${FALLBACK ? ' (picker path)' : ''}`);
  if (problems.length) {
    console.log('\nconsole problems:');
    for (const problem of problems.slice(0, 10)) console.log('  ' + problem.split('\n')[0]);
  }
}

main().catch((error) => { console.error('selftest failed:', error.message); process.exit(1); });
