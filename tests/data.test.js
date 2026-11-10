// The word lists shipped with the app are written by hand; keep them well-formed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normKey, parseWordList } from '../src/lib/words.js';

const read = (name) => readFileSync(new URL(`../src/data/${name}`, import.meta.url), 'utf8');

test('built-in common words: one "German = English" per line, no word twice', () => {
  const seen = new Map();
  let count = 0;
  for (const n of [1, 2, 3, 4]) {
    read(`common-${n}.txt`)
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return;
        const where = `common-${n}.txt:${i + 1} "${t}"`;
        assert.match(t, /^[^=]+ = [^=]+$/, where);
        const id = normKey(t.split(' = ')[0]);
        assert.ok(id, where);
        assert.ok(!seen.has(id), `${where} repeats ${seen.get(id)}`);
        seen.set(id, where);
        count++;
      });
  }
  assert.ok(count > 1500, `only ${count} words`);
  assert.equal(parseWordList([1, 2, 3, 4].map((n) => read(`common-${n}.txt`)).join('\n'), 'x').length, count);
});

test('default deck: a name and a list of distinct words with meanings', () => {
  const deck = JSON.parse(read('deck.json'));
  const words = Array.isArray(deck) ? deck : deck.words;
  assert.ok(Array.isArray(words));
  if (!Array.isArray(deck)) assert.equal(typeof deck.name, 'string');
  const ids = new Set();
  for (const w of words) {
    assert.equal(typeof w.de, 'string');
    assert.ok(w.en && typeof w.en === 'string', w.de);
    const id = normKey(w.de);
    assert.ok(id && !ids.has(id), `"${w.de}" is empty or repeated`);
    ids.add(id);
  }
});
