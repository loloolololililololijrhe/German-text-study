import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AGAIN,
  DAY,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_RETENTION,
  EASY,
  GOOD,
  HARD,
  dayKey,
  elapsedDays,
  hasMemory,
  intervalDays,
  memoryFromSm2,
  newPerDayOf,
  recallChance,
  retentionOf,
  review,
} from '../src/lib/srs.js';

const NOW = Date.UTC(2026, 10, 11, 12);

// Produced by Anki 26.09's own scheduler (FSRS on, default parameters): for a
// card with a given memory state, reviewed after a given number of days, the
// memory state Anki arrives at for each answer button.
const reference = JSON.parse(readFileSync(new URL('./fixtures/anki-fsrs-reference.json', import.meta.url), 'utf8'));

test('memory states after a review match Anki for every answer button', () => {
  let checked = 0;
  for (const c of reference.cases) {
    const p = { S: c.stability, D: c.difficulty, t: NOW - c.elapsed * DAY };
    for (const grade of [AGAIN, HARD, GOOD, EASY]) {
      const got = review(p, grade, NOW, reference.retention);
      const want = c.next[grade];
      const label = `S=${c.stability} D=${c.difficulty} after ${c.elapsed} d, grade ${grade}`;
      assert.ok(
        Math.abs(got.S - want.stability) <= want.stability * 1e-3 + 1e-3,
        `${label}: stability ${got.S} vs ${want.stability}`,
      );
      assert.ok(Math.abs(got.D - want.difficulty) <= 2e-3, `${label}: difficulty ${got.D} vs ${want.difficulty}`);
      checked++;
    }
  }
  assert.equal(checked, 36);
});

test('a word met for the first time starts where Anki starts it', () => {
  // The values Anki stored for new cards answered Again, Good and Easy.
  assert.deepEqual(review(null, AGAIN, NOW), { S: 0.212, D: 6.4133 });
  assert.deepEqual(review(undefined, GOOD, NOW), { S: 2.3065, D: 2.1181 });
  assert.deepEqual(review({ s: 0, n: 0 }, EASY, NOW), { S: 8.2956, D: 1 });
});

test('the interval grows with memory strength and shrinks with a stricter target', () => {
  assert.equal(intervalDays(0.01), 1, 'never less than a day');
  let last = 0;
  for (const S of [1, 3, 10, 30, 100, 400]) {
    const days = intervalDays(S, 0.88);
    assert.ok(days > last, `S=${S}`);
    last = days;
  }
  assert.equal(intervalDays(10, 0.9), 10, 'at a 90% target the interval is the stability itself');
  assert.ok(intervalDays(10, 0.8) > intervalDays(10, 0.88));
  assert.ok(intervalDays(10, 0.88) > intervalDays(10, 0.95));
});

test('the chance of recall is 90% once a word has waited as long as its stability', () => {
  assert.equal(recallChance({ S: 10, D: 5, t: NOW }, NOW), 1);
  assert.ok(Math.abs(recallChance({ S: 10, D: 5, t: NOW - 10 * DAY }, NOW) - 0.9) < 1e-9);
  assert.ok(recallChance({ S: 10, D: 5, t: NOW - 40 * DAY }, NOW) < 0.8);
  assert.equal(recallChance({ s: 0, n: 0 }, NOW), null);
  assert.equal(recallChance(undefined, NOW), null);
});

test('elapsed time is counted in whole days', () => {
  assert.equal(elapsedDays({ t: NOW - 23 * 3_600_000 }, NOW), 0);
  assert.equal(elapsedDays({ t: NOW - 25 * 3_600_000 }, NOW), 1);
  assert.equal(elapsedDays({ t: 0 }, NOW), 0);
  assert.equal(hasMemory({ S: 2, D: 5 }), true);
  assert.equal(hasMemory({ s: -2 }), false);
});

test('a day starts at 4 a.m., as in Anki', () => {
  const at = (h, m = 0) => new Date(2026, 10, 11, h, m).getTime();
  assert.equal(dayKey(at(3, 59)), '2026-11-10');
  assert.equal(dayKey(at(4, 0)), '2026-11-11');
  assert.equal(dayKey(at(23, 30)), '2026-11-11');
  assert.equal(dayKey(new Date(2027, 0, 1, 2).getTime()), '2026-12-31');
});

test('settings fall back to the defaults when nothing usable is stored', () => {
  assert.equal(DEFAULT_RETENTION, 0.88);
  assert.equal(DEFAULT_NEW_PER_DAY, 15);
  assert.equal(retentionOf({ retention: 0.92 }), 0.92);
  for (const bad of [undefined, {}, { retention: 0 }, { retention: 1 }, { retention: 'x' }]) {
    assert.equal(retentionOf(bad), DEFAULT_RETENTION);
  }
  assert.equal(newPerDayOf({ newPerDay: 0 }), 0);
  assert.equal(newPerDayOf({ newPerDay: '20' }), 20);
  for (const bad of [undefined, {}, { newPerDay: -1 }, { newPerDay: 'x' }]) {
    assert.equal(newPerDayOf(bad), DEFAULT_NEW_PER_DAY);
  }
});

test("cards from Anki's older scheduler get a memory state from interval and ease", () => {
  const usual = memoryFromSm2(14, 2.5);
  assert.equal(usual.S, 14);
  assert.ok(usual.D > 1 && usual.D < 10);
  assert.ok(memoryFromSm2(14, 1.3).D > usual.D, 'a low ease means a difficult card');
  assert.ok(memoryFromSm2(14, 3.2).D < usual.D);
  assert.equal(memoryFromSm2(14, 1.3).D, 10);
  assert.equal(memoryFromSm2(0, 2.5).S, 0.1);
});
