import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordIndex, normKey, parseWordList } from '../src/lib/words.js';

test('normKey reduces dictionary entries to the bare word', () => {
  const cases = {
    'der Hund': 'Hund',
    'die Zeitung, -en': 'Zeitung',
    'das Kind (Kinder)': 'Kind',
    'sich erinnern (an)': 'erinnern',
    'gehen, ging, ist gegangen': 'gehen',
    'auf|stehen': 'aufstehen',
    'auf·stehen': 'aufstehen',
    'der/die Angestellte': 'Angestellte',
    'r Hund': 'Hund',
    'e Frau': 'Frau',
    'der Schlüssel; die Schlüssel': 'Schlüssel',
    'zum Beispiel': 'zum Beispiel',
    'Achtung!': 'Achtung',
    'E-Mail': 'E-Mail',
    der: 'der',
    sich: 'sich',
    '': '',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normKey(input), want, input);
});

test('normKey keeps the capital that separates nouns from verbs', () => {
  assert.notEqual(normKey('das Essen'), normKey('essen'));
});

test('parseWordList reads "German = English" lines and skips comments', () => {
  const list = parseWordList('# top words\nder Hund = dog\n\ngehen = to go\nbroken line\n', 'Common');
  assert.deepEqual(
    list.map((w) => [w.id, w.de, w.en, w.rank]),
    [
      ['Hund', 'der Hund', 'dog', 0],
      ['gehen', 'gehen', 'to go', 1],
    ],
  );
});

test('custom words override the built-in list, without duplicates', () => {
  const builtin = parseWordList('der Hund = dog\ngehen = to go\ndas Essen = food\nessen = to eat', 'Common');
  const index = buildWordIndex({
    builtin,
    custom: {
      Hund: { de: 'der Hund', en: 'hound', src: 'My deck', r: 0 },
      katze: { de: 'katze', en: 'cat', src: 'My deck', r: 1 },
    },
  });
  assert.equal(index.list.length, 5);
  assert.equal(index.byId.get('Hund').en, 'hound');
  assert.equal(index.byId.get('Hund').src, 'My deck');
});

test('a lower-cased deck word replaces its capitalised built-in twin', () => {
  const builtin = parseWordList('der Hund = dog\ndas Essen = food\nessen = to eat', 'Common');
  const index = buildWordIndex({
    builtin,
    custom: {
      hund: { de: 'hund', en: 'dog', src: 'Deck', r: 0 },
      essen: { de: 'essen', en: 'to eat', src: 'Deck', r: 1 },
    },
  });
  assert.ok(!index.byId.has('Hund'), 'built-in Hund is dropped');
  // essen/Essen are two different words, so the built-in noun must survive.
  assert.ok(index.byId.has('Essen'));
  assert.equal(index.list.length, 3);
});

test('find matches the lemma the model writes to the list entry', () => {
  const builtin = parseWordList(
    'der Bahnhof = train station\nsich erinnern = to remember\ndas Essen = food\nessen = to eat\nzum Beispiel = for example',
    'Common',
  );
  const index = buildWordIndex({ builtin });
  assert.equal(index.find('der Bahnhof').en, 'train station');
  assert.equal(index.find('Bahnhof').en, 'train station');
  assert.equal(index.find('erinnern').en, 'to remember');
  assert.equal(index.find('das Essen').en, 'food');
  assert.equal(index.find('essen').en, 'to eat');
  assert.equal(index.find('bahnhof').en, 'train station', 'case-insensitive fallback');
  assert.equal(index.find('Flughafen'), null);
  assert.deepEqual(
    index.phrases.map((p) => p.id),
    ['zum Beispiel'],
  );
});

test('in a deck that uses capitals, a lower-case verb does not replace a built-in noun', () => {
  const builtin = parseWordList('der Laden = shop\ndie Miete = rent\ndas Jahr = year\nder Husten = cough', 'Common');
  const index = buildWordIndex({
    builtin,
    custom: {
      Jahr: { de: 'das Jahr', en: 'Noun: year', src: 'Deck', r: 0 },
      laden: { de: 'laden', en: 'Verb: to load', src: 'Deck', r: 1 },
      husten: { de: 'husten', en: 'Verb: to cough', src: 'Deck', r: 2 },
      // A noun the deck forgot to capitalise is still the same noun.
      miete: { de: 'die miete', en: 'Noun: rent', src: 'Deck', r: 3 },
    },
  });
  assert.equal(index.find('der Laden').en, 'shop');
  assert.equal(index.find('laden').en, 'Verb: to load');
  assert.equal(index.find('der Husten').en, 'cough');
  assert.equal(index.find('husten').en, 'Verb: to cough');
  assert.equal(index.find('die Miete').en, 'Noun: rent');
  assert.equal(index.list.length, 6);
});
