// The fixtures were exported from Anki itself (26.09): the same small deck as a
// current-format package, a legacy-format package, and "Notes in Plain Text".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  bestNoteType,
  cleanField,
  extractWords,
  fieldChoices,
  guessMapping,
  joinMeanings,
  parseAnkiText,
  parseApkg,
} from '../src/lib/anki.js';

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
  assert.equal(bestNoteType(parsed.noteTypes), 0);
  if (fieldNames) assert.equal(vocab.deck, 'German A2');
  assert.equal(vocab.name, 'German Vocab');
  assert.equal(vocab.notes.length, 13);
  assert.equal(basic.notes.length, 2);
  if (fieldNames) assert.deepEqual(vocab.fields, fieldNames);

  const mapping = guessMapping(vocab);
  assert.deepEqual(mapping, { de: 0, en: [1] });
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
  assert.deepEqual(guessMapping(noteType), { de: 1, en: [0] });
});

test('field names decide the mapping when they are telling', () => {
  const noteType = { name: 'x', fields: ['Audio', 'English', 'German'], notes: [['', 'dog', 'Hund']] };
  assert.deepEqual(guessMapping(noteType), { de: 2, en: [1] });
});

test('cleanField strips markup, sound tags, cloze marks and entities', () => {
  assert.equal(cleanField('<div><b>der&nbsp;Hund</b></div>'), 'der Hund');
  assert.equal(cleanField('Hund [sound:hund.mp3]'), 'Hund');
  assert.equal(cleanField('{{c1::gehen::verb}} wir'), 'gehen wir');
  assert.equal(cleanField('&Auml;pfel &amp; Stra&szlig;e &#252;ber &#xDF;'), 'Äpfel & Straße über ß');
  assert.equal(cleanField('eins<br>zwei<br/>'), 'eins; zwei');
  assert.equal(cleanField(null), '');
});

// A frequency deck laid out the way commercial 1,000-word decks often are:
// a bare lower-case headword, the display form with its article, meanings
// split over numbered fields, and a full example sentence with translation.
const FREQUENCY_DECK = {
  name: 'DE',
  deck: 'German 1K',
  fields: [
    'Sort Index',
    'Word',
    'Front of Card',
    'Irregular Forms 1',
    'Definitions 1',
    'Definitions 2',
    'Definitions 3',
    'Example Sentence',
    'Translation',
    'word_audio',
  ],
  notes: [
    [
      '1',
      'haben',
      'haben',
      'hat',
      'Verb: to have',
      '',
      '',
      'Ich habe heute leider keine Zeit für dich.',
      'Unfortunately I have no time for you today.',
      '',
    ],
    [
      '2',
      'werden',
      'werden',
      'wird',
      'Verb: to become',
      'Verb: to be going to, will',
      '',
      'Morgen wird es wieder sehr kalt werden.',
      'Tomorrow it is going to be very cold again.',
      '',
    ],
    [
      '3',
      'jahr',
      'das Jahr',
      '',
      'Noun: year',
      '',
      '',
      'Das neue Jahr beginnt für uns in Berlin.',
      'The new year begins for us in Berlin.',
      '',
    ],
    [
      '4',
      'gleichen',
      'gleich',
      '',
      'Adjective: same, equal',
      '',
      '',
      'Wir wohnen beide in der gleichen Straße.',
      'We both live in the same street.',
      '',
    ],
    [
      '5',
      'freuen',
      'sich freuen',
      '',
      'Verb: to be glad',
      '',
      '',
      'Ich freue mich sehr auf das Wochenende.',
      'I am really looking forward to the weekend.',
      '',
    ],
    [
      '6',
      'oder',
      'oder',
      '',
      'Conjunction: or',
      'Interjection: right?',
      '',
      'Möchtest du lieber Tee oder Kaffee trinken?',
      'Would you rather drink tea or coffee?',
      '',
    ],
    [
      '7',
      'gleich',
      'gleich',
      '',
      'Adjective: equal, alike',
      'Adverb: right away',
      '',
      'Ich komme gleich zu dir nach Hause.',
      'I am coming to your place right away.',
      '',
    ],
    [
      '8',
      'frau',
      'die Frau',
      '',
      'Noun: woman, wife',
      '',
      '',
      'Die Frau dort drüben ist meine Lehrerin.',
      'The woman over there is my teacher.',
      '',
    ],
  ],
};

test('a frequency deck: display form for German, numbered definitions combined, sentences ignored', () => {
  const mapping = guessMapping(FREQUENCY_DECK);
  assert.equal(FREQUENCY_DECK.fields[mapping.de], 'Front of Card');
  assert.deepEqual(
    mapping.en.map((i) => FREQUENCY_DECK.fields[i]),
    ['Definitions 1', 'Definitions 2', 'Definitions 3'],
  );
  const { words, skipped } = extractWords(FREQUENCY_DECK, mapping.de, mapping.en);
  assert.deepEqual(
    words.map((w) => [w.de, w.en]),
    [
      ['haben', 'Verb: to have'],
      ['werden', 'Verb: to become; to be going to, will'],
      ['das Jahr', 'Noun: year'],
      // The deck lists "gleich" twice; the entry with more senses wins, in the first position.
      ['gleich', 'Adjective: equal, alike; Adverb: right away'],
      ['sich freuen', 'Verb: to be glad'],
      ['oder', 'Conjunction: or; Interjection: right?'],
      ['die Frau', 'Noun: woman, wife'],
    ],
  );
  assert.deepEqual(skipped, { empty: 0, long: 0, duplicate: 1 });
});

test('numbered fields are offered as one combined choice; generated names are not', () => {
  const labels = fieldChoices(FREQUENCY_DECK).map((c) => c.label);
  assert.equal(labels[0], 'Definitions 1–3, combined');
  assert.ok(labels.includes('Definitions 2'));
  assert.ok(!labels.some((l) => /Irregular Forms.*combined/.test(l)), 'a single numbered field is not a group');
  const plain = fieldChoices({ fields: ['Field 1', 'Field 2', 'Column 3'], notes: [] });
  assert.deepEqual(
    plain.map((c) => c.label),
    ['Field 1', 'Field 2', 'Column 3'],
  );
});

test('a file with decks for two languages starts on the German one', () => {
  const spanish = {
    name: 'ES',
    fields: ['Index', 'Word', 'Definition', 'Example Sentence'],
    notes: [
      ['1', 'ser', 'to be', 'Soy humano.'],
      ['2', 'tener', 'to have', 'Tengo que irme.'],
      ['3', 'la casa', 'the house', 'La casa es grande.'],
      ['4', 'hacer', 'to do, make', 'No sé qué hacer.'],
    ],
  };
  assert.equal(bestNoteType([spanish, FREQUENCY_DECK]), 1);
  assert.equal(bestNoteType([FREQUENCY_DECK, spanish]), 0);
});

test('joinMeanings writes a shared label once and keeps different ones', () => {
  assert.equal(joinMeanings(['Verb: to become', 'Verb: will', '']), 'Verb: to become; will');
  assert.equal(joinMeanings(['Noun: court', 'Noun: dish']), 'Noun: court; dish');
  assert.equal(joinMeanings(['Conjunction: or', 'Interjection: right?']), 'Conjunction: or; Interjection: right?');
  assert.equal(joinMeanings(['to go', 'to walk']), 'to go; to walk');
  assert.equal(joinMeanings(['', undefined, 'dog']), 'dog');
  assert.equal(joinMeanings([]), '');
});

test('a collection package carries how well each word is known in Anki', () => {
  const parsed = parseApkg(new Uint8Array(fixture('studied.colpkg')), SQL);
  const [vocab] = parsed.noteTypes;
  assert.equal(vocab.deck, 'Wortschatz', 'the innermost deck name is suggested');
  // Review intervals of 60, 21, 20 and 3 days, then three unstudied notes.
  assert.deepEqual(vocab.levels, [2, 2, 1, 1, 0, 0, 0]);

  const mapping = guessMapping(vocab);
  const { words } = extractWords(vocab, mapping.de, mapping.en);
  assert.deepEqual(
    words.map((w) => [w.de, w.level]),
    [
      ['der Bahnhof', 2],
      ['die Zeitung', 2],
      ['aufstehen', 1],
      ['müde', 1],
      ['der Schlüssel', 0],
      ['gehen', 0],
    ],
  );
});

test('decks exported without scheduling, and text files, have no Anki progress', () => {
  const apkg = parseApkg(new Uint8Array(fixture('modern.apkg')), SQL).noteTypes[0];
  assert.ok(apkg.levels.every((l) => l === 0));
  const text = parseAnkiText('Hund;dog\nKatze;cat\n').noteTypes[0];
  const { words } = extractWords(text, 0, 1);
  assert.deepEqual(
    words.map((w) => w.level),
    [0, 0],
  );
});
