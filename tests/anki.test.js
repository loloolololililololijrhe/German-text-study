// The fixtures were exported from Anki itself (26.09): the same small deck as a
// current-format package, a legacy-format package, and "Notes in Plain Text".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cleanField, extractWords, guessMapping, parseAnkiText, parseApkg } from '../src/lib/anki.js';

const require = createRequire(import.meta.url);
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const SQL = await require('sql.js')();

const EXPECTED = [
  ['der Bahnhof', 'train station'],
  ['die Zeitung, -en', 'newspaper'],
  ['sich erinnern (an)', 'to remember'],
  ['aufstehen', 'to get up'],
  ['müde', 'tired'],
  ['der Schlüssel; die Schlüssel', 'key'],
  ['gehen, ging, ist gegangen', 'to go'],
  ['das Essen', 'food; meal'],
  ['essen', 'to eat'],
  ['zum Beispiel', 'for example'],
];

function checkDeck(parsed, fieldNames) {
  assert.equal(parsed.noteTypes.length, 2);
  const [vocab, basic] = parsed.noteTypes;
  assert.equal(vocab.name, 'German Vocab');
  assert.equal(vocab.notes.length, 13);
  assert.equal(basic.notes.length, 2);
  if (fieldNames) assert.deepEqual(vocab.fields, fieldNames);

  const mapping = guessMapping(vocab);
  assert.deepEqual(mapping, { de: 0, en: 1 });
  const { words, skipped } = extractWords(vocab, mapping.de, mapping.en);
  assert.deepEqual(
    words.map((w) => [w.de, w.en]),
    EXPECTED,
  );
  assert.deepEqual(skipped, { empty: 1, long: 1, duplicate: 1 });
}

test('current-format .apkg (zstd-compressed collection)', () => {
  checkDeck(parseApkg(new Uint8Array(fixture('modern.apkg')), SQL), ['Deutsch', 'English', 'Beispiel']);
});

test('legacy-format .apkg', () => {
  checkDeck(parseApkg(new Uint8Array(fixture('legacy.apkg')), SQL), ['Deutsch', 'English', 'Beispiel']);
});

test('"Notes in Plain Text" export', () => {
  checkDeck(parseAnkiText(fixture('notes.txt').toString('utf8')));
});

test('a file that is not a deck is rejected with a clear message', () => {
  assert.throws(() => parseApkg(new Uint8Array([1, 2, 3, 4]), SQL), /not an Anki deck/);
});

test('plain CSV without Anki headers', () => {
  const parsed = parseAnkiText('Hund;dog\n"Katze; die";"cat ""kitty"""\n\nlaufen;to run\n');
  const [t] = parsed.noteTypes;
  assert.deepEqual(t.fields, ['Column 1', 'Column 2']);
  assert.deepEqual(t.notes, [
    ['Hund', 'dog'],
    ['Katze; die', 'cat "kitty"'],
    ['laufen', 'to run'],
  ]);
});

test('the mapping guess finds the German side even when it comes second', () => {
  const noteType = {
    name: 'x',
    fields: ['Back', 'Front'],
    notes: [
      ['to go', 'gehen'],
      ['the dog', 'der Hund'],
      ['tired', 'müde'],
      ['to remember', 'sich erinnern'],
    ],
  };
  assert.deepEqual(guessMapping(noteType), { de: 1, en: 0 });
});

test('field names decide the mapping when they are telling', () => {
  const noteType = { name: 'x', fields: ['Audio', 'English', 'German'], notes: [['', 'dog', 'Hund']] };
  assert.deepEqual(guessMapping(noteType), { de: 2, en: 1 });
});

test('cleanField strips markup, sound tags, cloze marks and entities', () => {
  assert.equal(cleanField('<div><b>der&nbsp;Hund</b></div>'), 'der Hund');
  assert.equal(cleanField('Hund [sound:hund.mp3]'), 'Hund');
  assert.equal(cleanField('{{c1::gehen::verb}} wir'), 'gehen wir');
  assert.equal(cleanField('&Auml;pfel &amp; Stra&szlig;e &#252;ber &#xDF;'), 'Äpfel & Straße über ß');
  assert.equal(cleanField('eins<br>zwei<br/>'), 'eins; zwei');
  assert.equal(cleanField(null), '');
});
