import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_SHARE,
  KNOWN_AT,
  MAX_SCORE,
  MIN_SCORE,
  cleanRead,
  clearHard,
  markHard,
  markKnown,
  pickTargets,
  seen,
  statusOf,
  weightOf,
} from '../src/lib/scoring.js';

/** Deterministic random numbers in (0, 1). */
function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s + 1) / 4294967297;
  };
}

const words = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, de: `w${i}`, en: '', rank: i }));

test('marking hard lowers the score and repeated marks go lower, to a floor', () => {
  let p = markHard(undefined, 1);
  assert.equal(p.s, -3);
  assert.equal(statusOf(p), 'hard');
  p = markHard(p, 2);
  assert.equal(p.s, -6);
  p = markHard(p, 3);
  assert.equal(p.s, MIN_SCORE);
});

test('marking a familiar word hard starts from zero, not from its old score', () => {
  const p = markHard({ s: 4, n: 5, l: 0, t: 0, u: 0 }, 1);
  assert.equal(p.s, -3);
});

test('a hard word fades back to normal after three clean reads', () => {
  let p = markHard(undefined, 1);
  p = cleanRead(p, 2);
  p = cleanRead(p, 3);
  assert.equal(statusOf(p), 'hard');
  p = cleanRead(p, 4);
  assert.equal(p.s, 0);
  assert.equal(statusOf(p), 'learning');
});

test('clean reads raise the score up to a ceiling and make the word known', () => {
  let p;
  for (let i = 0; i < 20; i++) p = cleanRead(p, i);
  assert.equal(p.s, MAX_SCORE);
  assert.equal(p.n, 20);
  assert.equal(statusOf(p), 'known');
  assert.equal(statusOf(cleanRead(cleanRead(cleanRead(undefined, 1), 2), 3)), 'known');
  assert.equal(KNOWN_AT, 3);
});

test('a looked-up word records the sighting without changing its score', () => {
  const p = seen({ s: 2, n: 1, l: 1, t: 0, u: 0 }, 9);
  assert.deepEqual(p, { s: 2, n: 2, l: 1, t: 9, u: 9 });
});

test('"I know this now" and "mark as known" lift a hard word', () => {
  assert.equal(statusOf(clearHard(markHard(undefined, 1), 2)), 'learning');
  assert.equal(statusOf(markKnown(markHard(undefined, 1), 2)), 'known');
});

test('weights: hard > new > familiar, and no word ever reaches zero', () => {
  const e = { rank: 0 };
  const hard = weightOf(e, { s: -3 });
  const fresh = weightOf(e, undefined);
  const familiar = weightOf(e, { s: 2 });
  const known = weightOf({ rank: 5000 }, { s: MAX_SCORE });
  assert.ok(hard > fresh && fresh > familiar);
  assert.ok(known > 0);
  assert.ok(weightOf({ rank: 0 }, undefined) > weightOf({ rank: 1500 }, undefined), 'common words are preferred');
});

test('pickTargets returns distinct words of the requested count', () => {
  const list = words(500);
  const picked = pickTargets(list, {}, 12, rng(7));
  assert.equal(picked.length, 12);
  assert.equal(new Set(picked.map((p) => p.entry.id)).size, 12);
  assert.ok(picked.every((p) => !p.hard));
});

test('a few hard words are not drowned out by thousands of unseen ones', () => {
  const list = words(3000);
  const progress = { w2900: markHard(undefined, 1), w2950: markHard(undefined, 1), w2999: markHard(undefined, 1) };
  const r = rng(3);
  for (let i = 0; i < 20; i++) {
    const ids = pickTargets(list, progress, 12, r).map((p) => p.entry.id);
    for (const id of Object.keys(progress)) assert.ok(ids.includes(id), `${id} missing in round ${i}`);
  }
});

test('with many hard words, they take their share and leave room for others', () => {
  const list = words(1000);
  const progress = {};
  for (let i = 0; i < 100; i++) progress[`w${i}`] = markHard(undefined, 1);
  const picked = pickTargets(list, progress, 10, rng(5));
  const hard = picked.filter((p) => p.hard).length;
  assert.equal(hard, Math.round(10 * HARD_SHARE));
  assert.equal(picked.length, 10);
});

test('the harder of two hard words is picked more often', () => {
  const list = words(40);
  const progress = {};
  for (let i = 0; i < 40; i++) progress[`w${i}`] = markHard(undefined, 1);
  progress.w0 = markHard(progress.w0, 2); // -6 against -3 for the rest
  const r = rng(11);
  let harder = 0;
  let other = 0;
  for (let i = 0; i < 400; i++) {
    const ids = pickTargets(list, progress, 5, r).map((p) => p.entry.id);
    if (ids.includes('w0')) harder++;
    if (ids.includes('w1')) other++;
  }
  assert.ok(harder > other * 2, `harder=${harder} other=${other}`);
});

test('familiar words are picked far less often than new ones, but still sometimes', () => {
  const list = words(200);
  const progress = {};
  for (let i = 0; i < 100; i++) progress[`w${i}`] = { s: 3, n: 3, l: 0, t: 0, u: 0 };
  const r = rng(13);
  let familiar = 0;
  let total = 0;
  for (let i = 0; i < 300; i++) {
    for (const p of pickTargets(list, progress, 10, r)) {
      total++;
      if (Number(p.entry.id.slice(1)) < 100) familiar++;
    }
  }
  assert.ok(familiar > 0, 'known words must stay reachable');
  assert.ok(familiar / total < 0.35, `familiar share ${familiar / total}`);
});

test('pickTargets copes with a list smaller than the request', () => {
  const list = words(4);
  const picked = pickTargets(list, { w0: markHard(undefined, 1) }, 12, rng(1));
  assert.equal(picked.length, 4);
});
