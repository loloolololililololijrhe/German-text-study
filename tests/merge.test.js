import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, emptyState, mergeStates, sanitizeState, stableStringify } from '../src/lib/merge.js';

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
  assert.deepEqual(s.progress, { Hund: { s: -3, n: 0, l: 0, t: 0, u: 0 } });
  assert.deepEqual(Object.keys(s.custom), ['Hund']);
  assert.equal(s.prefs.level, 'B2');
  assert.equal(s.prefs.autoHard, true, 'defaults fill the gaps');
});

test('stableStringify ignores key order', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, 2], c: 2 } }), stableStringify({ a: { c: 2, d: [1, 2] }, b: 1 }));
});

test('scores saved under wider limits are brought back inside the current ones', () => {
  const s = sanitizeState({ progress: { Hund: { s: -6, n: 2 }, Katze: { s: 99 }, Maus: { s: -2 } } });
  assert.equal(s.progress.Hund.s, -4);
  assert.equal(s.progress.Katze.s, 6);
  assert.equal(s.progress.Maus.s, -2);
});
