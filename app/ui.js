/* DOM rendering for the viewer. No framework, no innerHTML for corpus text: every
 * article body, title and caption goes in through textContent, so nothing the disc
 * shipped can be read as markup. */
(function () {
  'use strict';

  const D = (globalThis.Decarta = globalThis.Decarta || {});
  const U = (D.ui = {});

  const nf = new Intl.NumberFormat('en-US');

  U.number = (n) => nf.format(n);

  U.el = function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children || []) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  U.clear = clear;

  /* A summary line mirroring the native toolbar's wording. `shown` is what is on screen,
   * `shownTotal` what the corpus holds, `matchTotal` the exact hit count when it is cheap
   * to know (null on the LIKE path, where the UI says "N+" rather than guess). */
  U.summary = function summary(state) {
    const shown = state.entries.length;
    if (state.query) {
      const query = state.query;
      if (state.matchTotal === null) return `${U.number(shown)}+ results for “${query}”`;
      if (shown < state.matchTotal) {
        return `${U.number(shown)} of ${U.number(state.matchTotal)} results for “${query}”`;
      }
      return `${U.number(state.matchTotal)} result${state.matchTotal === 1 ? '' : 's'} for “${query}”`;
    }
    if (state.category) {
      const total = state.categoryTotal;
      if (shown < total) {
        return `showing ${U.number(shown)} of ${U.number(total)} entries in ${state.category}`;
      }
      return `${U.number(shown)} entries in ${state.category}`;
    }
    const total = state.categoryTotal;
    if (shown < total) return `showing ${U.number(shown)} of ${U.number(total)} entries`;
    return `${U.number(shown)} entr${shown === 1 ? 'y' : 'ies'}`;
  };

  // ---- sidebar -------------------------------------------------------------

  U.renderCategories = function renderCategories(node, categories, selected, total, onSelect) {
    clear(node);
    const all = U.el('li', {}, [
      U.el('button', {
        type: 'button',
        class: `cat${selected === null ? ' selected' : ''}`,
        onclick: () => onSelect(null),
      }, [U.el('span', { class: 'catname', text: 'All entries' }),
        U.el('span', { class: 'catcount', text: U.number(total) })]),
    ]);
    node.append(all);
    for (const { category, count } of categories) {
      node.append(U.el('li', {}, [
        U.el('button', {
          type: 'button',
          class: `cat${selected === category ? ' selected' : ''}`,
          onclick: () => onSelect(category),
        }, [U.el('span', { class: 'catname', text: category }),
          U.el('span', { class: 'catcount', text: U.number(count) })]),
      ]));
    }
  };

  // ---- entry list ----------------------------------------------------------

  U.entryRow = function entryRow(entry, selected, onOpen) {
    const metaParts = [];
    if (!entry.snippet && entry.reading) metaParts.push(entry.reading);
    if (!entry.snippet) metaParts.push(`${U.number(entry.charCount)} chars`);
    const row = U.el('button', {
      type: 'button',
      class: `row${selected ? ' selected' : ''}`,
      dataset: { slug: entry.slug },
      onclick: () => onOpen(entry.slug),
    }, [
      U.el('div', { class: 'rowtitle', text: entry.title }),
      entry.snippet
        ? U.el('div', { class: 'rowsnippet', text: entry.snippet })
        : U.el('div', { class: 'rowmeta', text: metaParts.join(' · ') }),
    ]);
    return row;
  };

  U.renderEntries = function renderEntries(node, entries, onOpen, append) {
    if (!append) clear(node);
    for (const entry of entries) {
      node.append(U.entryRow(entry, false, onOpen));
    }
  };

  U.selectRow = function selectRow(node, slug) {
    for (const row of node.querySelectorAll('.row')) {
      row.classList.toggle('selected', row.dataset.slug === slug);
    }
  };

  U.footNote = function footNote(node, text) {
    clear(node);
    if (text) node.append(U.el('div', { class: 'foot', text }));
  };

  // ---- reader --------------------------------------------------------------

  /* Only `<image>` records are pictures. `<thumb>`/`<picon>` are proprietary
   * derivatives (.jsm/.jtn/.gsm/.gtn) the disc shipped for its own viewer, so they are
   * neither displayed nor counted as missing — the native reader draws the same line. */
  U.renderArticle = function renderArticle(node, article, backlinks, hooks) {
    clear(node);
    const pictures = article.media.filter((m) => m.kind === 'image');
    const missing = [];

    const head = U.el('header', { class: 'articlehead' }, [
      U.el('h1', { text: article.entry.title }),
      article.entry.reading ? U.el('p', { class: 'reading', text: article.entry.reading }) : null,
      U.el('p', {
        class: 'provenance',
        text: `${article.entry.category} · ${U.number(article.entry.charCount)} chars`
          + (article.sourcePath ? ` · ${article.sourcePath}` : ''),
      }),
    ]);

    const body = U.el('div', { class: 'articlebody' });
    for (const paragraph of article.body.split(/\n{2,}/)) {
      const text = paragraph.trim();
      if (text) body.append(U.el('p', { text }));
    }

    const children = [head];

    if (pictures.length) {
      const note = U.el('p', { class: 'missing' });
      const gallery = U.el('section', { class: 'gallery' }, [
        U.el('h2', { text: pictures.length === 1 ? 'Picture' : 'Pictures' }),
      ]);
      // A picture that will not load is one that was never copied out of the disc's
      // containers; the row exists in the corpus either way, so say so under the gallery.
      const markMissing = () => {
        note.textContent = `${U.number(missing.length)} picture`
          + `${missing.length === 1 ? '' : 's'} not copied — re-ingest with media enabled`
          + ` to include ${missing.length === 1 ? 'it' : 'them'}.`;
        if (!note.isConnected) gallery.append(note);
      };
      for (const picture of pictures) {
        const figure = U.el('figure');
        const image = U.el('img', {
          class: 'picture',
          loading: 'lazy',
          alt: picture.caption || picture.relPath,
          src: hooks.mediaUrl(picture),
          onerror: () => {
            missing.push(picture);
            figure.remove();
            markMissing();
          },
        });
        figure.append(image);
        if (picture.caption) figure.append(U.el('figcaption', { text: picture.caption }));
        gallery.append(figure);
      }
      children.push(gallery);
    }

    children.push(body);

    if (article.xrefs.length) {
      children.push(U.el('section', { class: 'relations' }, [
        U.el('h2', { text: 'See also' }),
        U.el('div', { class: 'chips' }, article.xrefs.map((xref) => {
          const known = xref.title || xref.anchor;
          return U.el('button', {
            type: 'button',
            class: 'chip',
            text: known,
            disabled: !xref.title,
            title: xref.title ? xref.title : `${xref.targetSlug} is not in this corpus`,
            onclick: () => hooks.open(xref.targetSlug),
          });
        })),
      ]));
    }

    if (backlinks.length) {
      children.push(U.el('section', { class: 'relations' }, [
        U.el('h2', { text: `Referenced by (${U.number(backlinks.length)})` }),
        U.el('div', { class: 'chips' }, backlinks.map((item) => U.el('button', {
          type: 'button',
          class: 'chip',
          text: item.title,
          onclick: () => hooks.open(item.slug),
        }))),
      ]));
    }

    node.append(U.el('div', { class: 'articleinner' }, children));
    node.scrollTop = 0;
  };

  U.renderPlaceholder = function renderPlaceholder(node, title, message) {
    clear(node);
    const block = U.el('div', { class: 'placeholder' }, [
      U.el('h2', { text: title }),
      message ? U.el('p', { text: message }) : null,
    ]);
    node.append(block);
  };

  U.setBanner = function setBanner(node, text, kind) {
    if (!text) {
      node.hidden = true;
      clear(node);
      return;
    }
    node.hidden = false;
    node.className = `banner${kind ? ` ${kind}` : ''}`;
    clear(node);
    node.append(document.createTextNode(text));
  };
})();
