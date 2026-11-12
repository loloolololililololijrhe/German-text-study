import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  HISTORY_LIMIT,
  emptyHistory,
  emptyState,
  mergeHistories,
  mergeStates,
  packText,
  sanitizeHistory,
  sanitizeState,
  stableStringify,
  unpackSentences,
} from '../src/lib/merge.js';

const p = (s, u) => ({ s, n: 1, l: 0, t: u, u });
const c = (en, a, u = a) => ({ de: 'x', en, src: 'Deck', r: 0, a, u });

function state(patch) {
  return { ...emptyState(), ...patch };
}

test('merging keeps the newer copy of every word', () => {
  const phone = state({ progress: { Hund: p(-3, 200), gehen: p(1, 100) } });
  const laptop = state({ progress: { Hund: p(2, 100), Katze: p(1, 150) } });
  const merged = mergeStates(phone, laptop);
  assert.equal(merged.progress.Hund.s, -3);
  assert.equal(merged.progress.gehen.s, 1);
  assert.equal(merged.progress.Katze.s, 1);
});

test('merging is symmetric and idempotent', () => {
  const a = state({
    progress: { Hund: p(-3, 200) },
    custom: { Hund: c('dog', 50) },
    prefs: { ...DEFAULT_PREFS, level: 'B1', u: 5 },
  });
  const b = state({ progress: { Hund: p(2, 100), Katze: p(1, 150) }, custom: { Katze: c('cat', 60) } });
  const ab = stableStringify(mergeStates(a, b));
  assert.equal(ab, stableStringify(mergeStates(b, a)));
  assert.equal(ab, stableStringify(mergeStates(mergeStates(a, b), b)));
});

test('a reset on one device removes older scores everywhere, but not newer ones', () => {
  const phone = state({ progress: {}, resetAt: 300 });
  const laptop = state({ progress: { Hund: p(2, 100), Katze: p(1, 400) } });
  const merged = mergeStates(phone, laptop);
  assert.equal(merged.resetAt, 300);
  assert.equal(merged.progress.Hund, undefined);
  assert.equal(merged.progress.Katze.s, 1);
});

test('removing imported words on one device removes them everywhere', () => {
  const phone = state({ custom: {}, clearedAt: 300 });
  const laptop = state({ custom: { Hund: c('dog', 100), Katze: c('cat', 400) } });
  const merged = mergeStates(phone, laptop);
  assert.deepEqual(Object.keys(merged.custom), ['Katze']);
});

test('the newer edit of a custom word wins', () => {
  const merged = mergeStates(
    state({ custom: { Hund: c('dog', 100, 100) } }),
    state({ custom: { Hund: c('hound', 100, 200) } }),
  );
  assert.equal(merged.custom.Hund.en, 'hound');
});

test('the most recently changed preferences win as a whole', () => {
  const merged = mergeStates(
    state({ prefs: { ...DEFAULT_PREFS, level: 'B1', autoHard: false, u: 200 } }),
    state({ prefs: { ...DEFAULT_PREFS, level: 'A1', u: 100 } }),
  );
  assert.equal(merged.prefs.level, 'B1');
  assert.equal(merged.prefs.autoHard, false);
});

test('sanitizeState survives missing, partial and hostile input', () => {
  assert.deepEqual(sanitizeState(null), emptyState());
  assert.deepEqual(sanitizeState('nonsense'), emptyState());
  const s = sanitizeState({
    progress: { Hund: { s: '-3', n: 'x' }, bad: 5 },
    custom: { Hund: { de: 'der Hund', en: 'dog' }, bad: { de: 1 } },
    prefs: { level: 'B2' },
  });
  assert.deepEqual(Object.keys(s.progress), ['Hund']);
  assert.equal(s.progress.Hund.s, -3);
  assert.equal(s.progress.Hund.n, 0);
  assert.deepEqual(Object.keys(s.custom), ['Hund']);
  assert.equal(s.prefs.level, 'B2');
  assert.equal(s.prefs.autoHard, true, 'defaults fill the gaps');
});

test('stableStringify ignores key order', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, 2], c: 2 } }), stableStringify({ a: { c: 2, d: [1, 2] }, b: 1 }));
});

test('memory states survive loading, and values outside their range are brought back inside it', () => {
  const s = sanitizeState({
    progress: {
      Hund: { s: 0, n: 2, l: 1, t: 50, u: 60, S: 12.5, D: 4.25, due: 99 },
      Katze: { s: -9, n: 0, S: 0.4, D: 42, t: 5, u: 5 },
      Maus: { s: 0, n: 0, l: 0, t: 0, u: 3 },
    },
  });
  assert.deepEqual(s.progress.Hund, { s: 0, n: 2, l: 1, t: 50, u: 60, S: 12.5, D: 4.25, due: 99 });
  assert.equal(s.progress.Katze.s, -6);
  assert.equal(s.progress.Katze.D, 10);
  assert.deepEqual(s.progress.Maus, { s: 0, n: 0, l: 0, t: 0, u: 3 });
});

test('progress from before the schedule is upgraded when it is loaded', () => {
  const s = sanitizeState({
    progress: { Hund: { s: 4, n: 3, t: 1000, u: 1000 }, Katze: { s: -2, n: 1, t: 1000, u: 1000 } },
  });
  assert.equal(s.progress.Hund.s, 0);
  assert.ok(s.progress.Hund.S >= 21 && s.progress.Hund.due > 1000);
  assert.equal(s.progress.Katze.s, -2);
  assert.ok(s.progress.Katze.S > 0);
});

test('the count of new words started today follows the later day, or the larger count', () => {
  const on = (day, n) => state({ intro: { day, n } });
  assert.deepEqual(mergeStates(on('2026-11-10', 9), on('2026-11-11', 2)).intro, { day: '2026-11-11', n: 2 });
  assert.deepEqual(mergeStates(on('2026-11-11', 2), on('2026-11-10', 9)).intro, { day: '2026-11-11', n: 2 });
  assert.deepEqual(mergeStates(on('2026-11-11', 4), on('2026-11-11', 7)).intro, { day: '2026-11-11', n: 7 });
  assert.deepEqual(mergeStates(state({}), on('2026-11-11', 7)).intro, { day: '2026-11-11', n: 7 });
  assert.deepEqual(sanitizeState({ intro: { day: '2026-11-11', n: '5' } }).intro, { day: '2026-11-11', n: 5 });
  assert.deepEqual(sanitizeState({ intro: 'x' }).intro, { day: '', n: 0 });
});

test('the lists that are turned off are kept as a list of names', () => {
  assert.deepEqual(emptyState().prefs.listsOff, []);
  assert.deepEqual(sanitizeState({ prefs: { listsOff: ['Common words', 7, null] } }).prefs.listsOff, ['Common words']);
  assert.deepEqual(sanitizeState({ prefs: { listsOff: 'Common words' } }).prefs.listsOff, []);
  assert.deepEqual(sanitizeState({ prefs: { level: 'B1' } }).prefs.listsOff, []);
});

test('the deck and fields last used for an Anki file are remembered, if they are usable', () => {
  assert.equal(emptyState().prefs.anki, null);
  const anki = {
    type: 'DE1K',
    deck: 'Refold DE1K',
    de: 'Front of Card',
    en: ['Definitions 1', 'Definitions 2'],
    name: 'Refold DE1K',
    at: 5,
  };
  assert.deepEqual(sanitizeState({ prefs: { anki } }).prefs.anki, anki);
  assert.deepEqual(sanitizeState({ prefs: { anki: { type: 'X', de: 'Front', en: ['Back'] } } }).prefs.anki, {
    type: 'X',
    deck: '',
    de: 'Front',
    en: ['Back'],
    name: 'Imported deck',
    at: 0,
  });
  for (const bad of [undefined, 'x', {}, { type: 'X', de: 'Front', en: [] }, { type: 'X', en: ['Back'] }]) {
    assert.equal(sanitizeState({ prefs: { anki: bad } }).prefs.anki, null);
  }
});

// ---- past texts ----------------------------------------------------------------

const sentence = (de) => ({
  de,
  en: 'x',
  br: true,
  words: de
    .replace('.', '')
    .split(' ')
    .map((w) => ({ w, l: w.toLowerCase(), g: 'g' })),
});
const pastText = (id, at) =>
  packText({ id, at, title: `T${id}`, level: 'A2', hard: 1, sentences: [sentence('Der Hund schläft.')] });

test('a text is stored compactly and comes back as it was', () => {
  const sentences = [sentence('Der Hund schläft.'), { ...sentence('Er träumt.'), br: false }];
  const packed = packText({ id: 'a', at: 5, title: 'Der Hund', level: 'A2', hard: 2, sentences });
  assert.deepEqual(packed.sentences[0].w[0], ['Der', 'der', 'g']);
  assert.deepEqual(unpackSentences(packed), sentences);
  assert.deepEqual(unpackSentences(sanitizeHistory({ texts: [packed] }).texts[0]), sentences);
});

test('past texts from two devices are combined, newest first, without repeats', () => {
  const phone = { clearedAt: 0, texts: [pastText('c', 300), pastText('a', 100)] };
  const laptop = { clearedAt: 0, texts: [pastText('b', 200), pastText('a', 100)] };
  const merged = mergeHistories(phone, laptop);
  assert.deepEqual(
    merged.texts.map((t) => t.id),
    ['c', 'b', 'a'],
  );
  assert.equal(stableStringify(merged), stableStringify(mergeHistories(laptop, phone)));
  assert.equal(stableStringify(merged), stableStringify(mergeHistories(merged, phone)));
});

test('only the most recent texts are kept', () => {
  const many = {
    clearedAt: 0,
    texts: Array.from({ length: HISTORY_LIMIT + 12 }, (_, i) => pastText(`t${i}`, 1000 + i)),
  };
  const merged = mergeHistories(many, emptyHistory());
  assert.equal(merged.texts.length, HISTORY_LIMIT);
  assert.equal(merged.texts[0].id, `t${HISTORY_LIMIT + 11}`);
});

test('clearing the history on one device clears it everywhere, but not later texts', () => {
  const phone = { clearedAt: 250, texts: [] };
  const laptop = { clearedAt: 0, texts: [pastText('old', 200), pastText('new', 300)] };
  const merged = mergeHistories(phone, laptop);
  assert.equal(merged.clearedAt, 250);
  assert.deepEqual(
    merged.texts.map((t) => t.id),
    ['new'],
  );
});

test('sanitizeHistory survives missing, partial and hostile input', () => {
  assert.deepEqual(sanitizeHistory(null), emptyHistory());
  assert.deepEqual(sanitizeHistory({ texts: 'x' }), emptyHistory());
  const h = sanitizeHistory({
    clearedAt: '7',
    texts: [
      pastText('ok', 100),
      { id: 5, sentences: [] },
      { id: 'empty', at: 100, sentences: [] },
      { id: 'odd', at: 100, title: 9, sentences: [{ de: 'Hallo.', w: [['Hallo'], 'x', [1, 2]] }, { de: 4 }] },
    ],
  });
  assert.equal(h.clearedAt, 7);
  assert.deepEqual(h.texts.map((t) => t.id).sort(), ['odd', 'ok']);
  const odd = h.texts.find((t) => t.id === 'odd');
  assert.equal(odd.title, '');
  assert.deepEqual(odd.sentences, [{ de: 'Hallo.', en: '', br: false, w: [['Hallo', '', '']] }]);
});
