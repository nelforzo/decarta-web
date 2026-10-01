// Rewrites the official @sqlite.org/sqlite-wasm ES module into a classic script that a
// file:// page can actually load, and base64-embeds the wasm as the fetch()-less
// fallback. Driven by scripts/vendor-sqlite.sh; see the comments there for the why.
const fs = require('fs');

const { DIST, OUT, VERSION } = process.env;
for (const [name, value] of Object.entries({ DIST, OUT, VERSION })) {
  if (!value) throw new Error(`${name} is not set`);
}

let src = fs.readFileSync(`${DIST}/index.mjs`, 'utf8');

const exportLine = /^export \{ sqlite3InitModule as default, sqlite3Worker1Promiser\$1 as sqlite3Worker1Promiser \};\s*$/m;
if (!exportLine.test(src)) {
  throw new Error('the expected `export { … }` line is gone — the upstream bundle changed shape');
}
src = src.replace(exportLine, [
  'globalThis.sqlite3InitModule = sqlite3InitModule;',
  'globalThis.sqlite3Worker1Promiser = sqlite3Worker1Promiser$1;',
].join('\n'));

src = src.split('import.meta.url').join(
  '(globalThis.document?.currentScript?.src || globalThis.location?.href || "")');
if (src.includes('import.meta')) {
  throw new Error('import.meta survives the rewrite — a classic script would be a syntax error');
}

const banner = `// Vendored from @sqlite.org/sqlite-wasm@${VERSION} (dist/index.mjs), rewritten as a
// classic script so a file:// page can load it: see scripts/vendor-sqlite.sh. Do not edit.
`;
fs.writeFileSync(`${OUT}/sqlite3.js`, banner + src);

const wasm = fs.readFileSync(`${DIST}/sqlite3.wasm`);
fs.writeFileSync(`${OUT}/sqlite3.wasm.b64.js`,
  `// base64 of sqlite3.wasm (${wasm.length} bytes) — the fallback when fetch() is unavailable.\n` +
  `globalThis.SQLITE3_WASM_BASE64 = "${wasm.toString('base64')}";\n`);

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(`sqlite3.js           ${kib(fs.statSync(`${OUT}/sqlite3.js`).size)}`);
console.log(`sqlite3.wasm         ${kib(wasm.length)}`);
console.log(`sqlite3.wasm.b64.js  ${(fs.statSync(`${OUT}/sqlite3.wasm.b64.js`).size / 1048576).toFixed(1)} MiB`);
