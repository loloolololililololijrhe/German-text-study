import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_GOAL_CHOICES,
  emptyRead,
  goalStatus,
  markRead,
  mergeReads,
  sanitizeRead,
  textGoalOf,
  textsToday,
} from '../src/lib/goal.js';
import { DEFAULT_PREFS, emptyState, mergeStates, sanitizeState } from '../src/lib/merge.js';
import { DAY, dayKey } from '../src/lib/srs.js';

// Noon, local time, on an ordinary day: well away from the 4 a.m. start of a day.
const NOON = new Date(2026, 10, 16, 12, 0, 0).getTime();
const HOUR = 3_600_000;

test('no goal is set until the learner chooses one', () => {
  assert.equal(DEFAULT_PREFS.textsPerDay, 0);
  assert.equal(TEXT_GOAL_CHOICES[0], 0);
  assert.equal(textGoalOf(DEFAULT_PREFS), 0);
  assert.equal(textGoalOf({ textsPerDay: 3 }), 3);
  assert.equal(textGoalOf({ textsPerDay: '10' }), 10);
  for (const bad of [undefined, null, 'x', -2, 0, NaN]) assert.equal(textGoalOf({ textsPerDay: bad }), 0);
  assert.equal(textGoalOf(undefined), 0);
});

test('every finished text counts towards today', () => {
  let read = emptyRead();
  assert.equal(textsToday(read, NOON), 0);
  read = markRead(read, NOON);
  read = markRead(read, NOON + HOUR);
  assert.equal(textsToday(read, NOON + 2 * HOUR), 2);
  assert.deepEqual(read, { day: dayKey(NOON), at: [NOON, NOON + HOUR] });
});

test('a new day starts the count again, at 4 a.m. and not at midnight', () => {
  const evening = new Date(2026, 10, 16, 23, 30).getTime();
  const afterMidnight = new Date(2026, 10, 17, 1, 0).getTime();
  const morning = new Date(2026, 10, 17, 9, 0).getTime();
  let read = markRead(markRead(emptyRead(), evening), afterMidnight);
  assert.equal(textsToday(read, afterMidnight), 2, 'reading past midnight is still the same day');
  assert.equal(textsToday(read, morning), 0, 'yesterday does not count today');
  read = markRead(read, morning);
  assert.deepEqual(read, { day: dayKey(morning), at: [morning] });
});

test('the goal is met once enough texts are finished, and stays met', () => {
  const prefs = { textsPerDay: 3 };
  let read = emptyRead();
  assert.deepEqual(goalStatus(read, prefs, NOON), { goal: 3, done: 0, left: 3, met: false });
  read = markRead(markRead(read, NOON), NOON + 1);
  assert.deepEqual(goalStatus(read, prefs, NOON + 2), { goal: 3, done: 2, left: 1, met: false });
  read = markRead(read, NOON + 2);
  assert.deepEqual(goalStatus(read, prefs, NOON + 3), { goal: 3, done: 3, left: 0, met: true });
  read = markRead(read, NOON + 3);
  assert.deepEqual(goalStatus(read, prefs, NOON + 4), { goal: 3, done: 4, left: 0, met: true });
  assert.deepEqual(goalStatus(read, prefs, NOON + DAY), { goal: 3, done: 0, left: 3, met: false });
  assert.deepEqual(goalStatus(read, {}, NOON + 4), { goal: 0, done: 4, left: 0, met: false }, 'no goal, never met');
});

test('texts read on two devices on the same day all count; otherwise the later day does', () => {
  const day = dayKey(NOON);
  const a = { day, at: [NOON, NOON + 2 * HOUR] };
  const b = { day, at: [NOON, NOON + HOUR] };
  assert.deepEqual(mergeReads(a, b), { day, at: [NOON, NOON + HOUR, NOON + 2 * HOUR] });
  assert.deepEqual(mergeReads(b, a), mergeReads(a, b));
  assert.deepEqual(mergeReads(a, a), a);
  const next = { day: dayKey(NOON + DAY), at: [NOON + DAY] };
  assert.deepEqual(mergeReads(a, next), next);
  assert.deepEqual(mergeReads(next, a), next);
  assert.deepEqual(mergeReads(undefined, a), a);
  assert.deepEqual(mergeReads(undefined, undefined), emptyRead());
});

test('the record survives missing, partial and hostile input', () => {
  for (const bad of [undefined, null, 'x', 7, [], { day: 5, at: [] }, { day: '2026-11-16' }, { at: [1] }]) {
    assert.deepEqual(sanitizeRead(bad), emptyRead());
  }
  assert.deepEqual(sanitizeRead({ day: 'd', at: [3, '2', 'x', -1, 0, 3, null] }), { day: 'd', at: [2, 3] });
  assert.equal(sanitizeRead({ day: 'd', at: Array.from({ length: 500 }, (_, i) => i + 1) }).at.length, 200);
});

test('the goal and the day’s texts are part of the synced state', () => {
  const day = dayKey(NOON);
  assert.deepEqual(emptyState().read, emptyRead());
  assert.deepEqual(sanitizeState({}).read, emptyRead(), 'a state saved before goals existed');
  assert.deepEqual(sanitizeState({ read: { day, at: [NOON, 'x'] } }).read, { day, at: [NOON] });
  assert.equal(sanitizeState({ prefs: { textsPerDay: '5' } }).prefs.textsPerDay, 5);
  assert.equal(sanitizeState({ prefs: { textsPerDay: 'lots' } }).prefs.textsPerDay, 0);
  assert.equal(sanitizeState({ prefs: {} }).prefs.textsPerDay, 0);

  const a = { ...emptyState(), read: { day, at: [NOON] } };
  const b = { ...emptyState(), read: { day, at: [NOON + HOUR] } };
  assert.deepEqual(mergeStates(a, b).read, { day, at: [NOON, NOON + HOUR] });
  assert.deepEqual(mergeStates(a, sanitizeState({})).read, a.read, 'a device without the record loses nothing');
});
