// Importing an Anki deck: pick a file, confirm which fields are which, add.

import { store } from '../store.js';
import { normKey } from '../lib/words.js';
import { ankiIsNewer, fromAnki, rulesOf } from '../lib/scoring.js';
import { fill, h, plural, toast } from './dom.js';
import { bestNoteType, extractWords, fieldChoices, guessMapping, parseAnkiText, parseApkg } from '../lib/anki.js';

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

function openMapping(parsed, fileName) {
  // A collection file can hold decks for several languages; start on the German one.
  let typeIndex = bestNoteType(parsed.noteTypes);
  let mapping = guessMapping(parsed.noteTypes[typeIndex]);
  const suggestedName = () => parsed.noteTypes[typeIndex].deck || fileName;
  let nameEdited = false;
  let useProgress = true;
  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: suggestedName(),
    maxlength: '60',
    oninput: () => {
      nameEdited = true;
    },
  });
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
    const choices = fieldChoices(type);
    const enChoice = choices.findIndex((c) => c.fields.join() === mapping.en.join());
    const { words, skipped } = extractWords(type, mapping.de, mapping.en);
    const listed = words.map((w, i) => ({ ...w, id: normKey(w.de), rank: i }));
    // A deck word the list already holds, word for word, needs no second copy.
    const fresh = listed.filter((w) => {
      const e = store.index.byId.get(w.id);
      return !(e && e.priority && e.de === w.de && e.en === w.en);
    });
    const already = listed.length - fresh.length;
    // What Anki knows about these words, for the ones where it is ahead of this app.
    const now = Date.now();
    const fromDeck = listed.filter((w) => w.study && ankiIsNewer(store.progressOf(w.id), w.study));
    const relearning = fromDeck.filter((w) => w.study.hard).length;
    const scheduled = fromDeck.length - relearning;
    const dueNow = fromDeck.filter((w) => !w.study.hard && w.study.due <= now).length;
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
          h('span', { class: 'label' }, 'Deck'),
          select(
            parsed.noteTypes.map((t) => `${t.deck || t.name} (${plural(t.notes.length, 'note')})`),
            typeIndex,
            (i) => {
              typeIndex = i;
              mapping = guessMapping(parsed.noteTypes[i]);
              if (!nameEdited) nameInput.value = suggestedName();
              draw();
            },
            'Deck',
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
          select(
            choices.map((c) => c.label),
            enChoice,
            (i) => ((mapping.en = choices[i].fields), draw()),
            'English field',
          ),
        ),
      ),
      fromDeck.length > 0 &&
        h(
          'label',
          { class: 'switch-row' },
          h(
            'span',
            null,
            h('span', { class: 'switch-title' }, 'Use my Anki progress'),
            h(
              'span',
              { class: 'help' },
              [
                `${plural(scheduled, 'word')} carry on from Anki's schedule, with the same memory strength and due date`,
                dueNow ? ` (${dueNow.toLocaleString('en')} are due now)` : '',
                relearning
                  ? `, and ${relearning.toLocaleString('en')} that Anki is still teaching you come in as hard words`
                  : '',
                '. Words you have reviewed here more recently than in Anki are left alone.',
              ].join(''),
            ),
          ),
          h('input', {
            class: 'switch',
            type: 'checkbox',
            role: 'switch',
            checked: useProgress,
            onchange: (e) => {
              useProgress = e.target.checked;
            },
          }),
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
        `${plural(fresh.length, 'word')} will be added.`,
        already ? ` ${already.toLocaleString('en')} are already in your list.` : '',
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
              // Importing into a list that was turned off turns it back on.
              if (fresh.length && store.isListOff(src)) store.setListOn(src, true);
              const added = fresh.length
                ? store.addCustom(fresh.map((w) => ({ de: w.de, en: w.en, src, rank: w.rank })))
                : 0;
              // Anki's record replaces the app's only where Anki is ahead.
              const updates = {};
              if (useProgress) {
                const rules = rulesOf(store.state.prefs);
                for (const w of fromDeck) updates[w.id] = fromAnki(w.study, now, rules);
              }
              const marked = Object.keys(updates).length;
              if (marked) store.setProgressMany(updates);
              dialog.close();
              toast(
                [added && `Imported ${plural(added, 'word')}`, marked && `${plural(marked, 'word')} updated from Anki`]
                  .filter(Boolean)
                  .join(' · ') || 'Nothing new to import',
              );
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
