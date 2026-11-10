// Importing an Anki deck: pick a file, confirm which fields are which, add.

import { store } from '../store.js';
import { fill, h, plural, toast } from './dom.js';
import { extractWords, guessMapping, parseAnkiText, parseApkg } from '../lib/anki.js';

let sqlPromise;

/** The SQLite engine is large, so it is only fetched when a deck is imported. */
function loadSql() {
  sqlPromise ||= Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm-browser.wasm?url')]).then(([mod, wasm]) =>
    (mod.default || mod)({ locateFile: () => wasm.default }),
  );
  sqlPromise.catch(() => {
    sqlPromise = null;
  });
  return sqlPromise;
}

async function parseFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return parseApkg(bytes, await loadSql());
  return parseAnkiText(new TextDecoder('utf-8').decode(bytes));
}

/** Open the file picker. Must be called from a click handler. */
export function pickDeckFile() {
  // Off-screen rather than hidden: some mobile browsers ignore click() on a
  // file input that is not rendered.
  const input = h('input', {
    type: 'file',
    style: 'position:fixed;left:-999px;opacity:0',
    'aria-hidden': 'true',
    tabindex: '-1',
  });
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    toast('Reading the deck…');
    try {
      const parsed = await parseFile(file);
      openMapping(parsed, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      toast(err.message || 'Could not read this file.');
    }
  });
  document.body.append(input);
  input.click();
}

function openMapping(parsed, defaultName) {
  let typeIndex = 0;
  let mapping = guessMapping(parsed.noteTypes[0]);
  const nameInput = h('input', { class: 'input', type: 'text', value: defaultName, maxlength: '60' });
  const body = h('div', { class: 'dialog-body' });
  const dialog = h('dialog', { class: 'dialog' }, body);
  dialog.addEventListener('close', () => dialog.remove());

  const select = (options, current, onPick, label) =>
    h(
      'select',
      { class: 'input', 'aria-label': label, onchange: (e) => onPick(Number(e.target.value)) },
      options.map((o, i) => h('option', { value: String(i), selected: i === current }, o)),
    );

  const draw = () => {
    const type = parsed.noteTypes[typeIndex];
    const { words, skipped } = extractWords(type, mapping.de, mapping.en);
    const dropped = skipped.empty + skipped.long + skipped.duplicate;
    const reasons = [
      skipped.empty && `${skipped.empty} with an empty field`,
      skipped.duplicate && `${skipped.duplicate} repeated`,
      skipped.long && `${skipped.long} that look like sentences`,
    ].filter(Boolean);

    fill(
      body,
      h('h2', { class: 'dialog-title' }, 'Import deck'),
      parsed.noteTypes.length > 1 &&
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'label' }, 'Card type'),
          select(
            parsed.noteTypes.map((t) => `${t.name} (${plural(t.notes.length, 'note')})`),
            typeIndex,
            (i) => {
              typeIndex = i;
              mapping = guessMapping(parsed.noteTypes[i]);
              draw();
            },
            'Card type',
          ),
        ),
      h(
        'div',
        { class: 'field-pair' },
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'label' }, 'German word is in'),
          select(type.fields, mapping.de, (i) => ((mapping.de = i), draw()), 'German field'),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'label' }, 'English meaning is in'),
          select(type.fields, mapping.en, (i) => ((mapping.en = i), draw()), 'English field'),
        ),
      ),
      h(
        'div',
        { class: 'preview' },
        h('span', { class: 'label' }, 'Preview'),
        words.length
          ? h(
              'ul',
              { class: 'rows' },
              words
                .slice(0, 5)
                .map((w) =>
                  h(
                    'li',
                    { class: 'row is-static' },
                    h(
                      'span',
                      { class: 'row-text' },
                      h('span', { class: 'row-de', lang: 'de' }, w.de),
                      h('span', { class: 'row-en' }, w.en),
                    ),
                  ),
                ),
            )
          : h('p', { class: 'empty' }, 'No usable words with these fields. Try different ones.'),
      ),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name for this deck'), nameInput),
      h(
        'p',
        { class: 'dialog-note' },
        `${plural(words.length, 'word')} will be added.`,
        dropped ? ` Skipping ${reasons.join(', ')}.` : '',
        ' Words you already have keep their scores.',
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            disabled: !words.length,
            onclick: () => {
              const src = nameInput.value.trim() || 'Imported deck';
              const n = store.addCustom(words.map((w, i) => ({ ...w, src, rank: i })));
              dialog.close();
              toast(`Imported ${plural(n, 'word')}`);
              store.syncNow();
            },
          },
          'Import',
        ),
      ),
    );
  };

  draw();
  document.body.append(dialog);
  dialog.showModal();
}
