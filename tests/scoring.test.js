import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HARD_STEP,
  DEFAULT_MAX_HARD,
  HARD_SHARE,
  MAX_HARD_CHOICES,
  MIN_SCORE,
  NEW_SHARE,
  ankiIsNewer,
  capHardness,
  cleanRead,
  clearHard,
  fromAnki,
  hardRead,
  hardStepChoices,
  hardStepOf,
  intervalOf,
  isDue,
  lookedUp,
  markHard,
  markKnown,
  maxHardOf,
  pickExtras,
  pickTargets,
  resetWord,
  rulesOf,
  seen,
  statusOf,
  upgradeProgress,
} from '../src/lib/scoring.js';
import { DAY } from '../src/lib/srs.js';

const NOW = Date.UTC(2026, 10, 11, 12);

/** Deterministic random numbers in (0, 1). */
function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s + 1) / 4294967297;
  };
}

/** A word on the schedule: last reviewed `ago` days ago, due `dueIn` days from now. */
const scheduled = (S, ago, dueIn) => ({ s: 0, n: 1, l: 0, S, D: 5, t: NOW - ago * DAY, due: NOW + dueIn * DAY, u: 1 });

// ---- reading and marking -------------------------------------------------------

test('reading a new word without tapping puts it on the schedule', () => {
  const p = cleanRead(undefined, NOW);
  assert.equal(statusOf(undefined), 'new');
  assert.equal(statusOf(p), 'learning');
  assert.equal(p.n, 1);
  assert.equal(p.t, NOW);
  assert.equal(intervalOf(p), 3, 'first interval at the default 88% target');
  assert.equal(isDue(p, NOW), false);
  assert.equal(isDue(p, NOW + 3 * DAY), true);
});

test('each clean read on the due date pushes the word further out, until it is known', () => {
  let p = cleanRead(undefined, NOW);
  let now = NOW;
  const intervals = [intervalOf(p)];
  for (let i = 0; i < 4; i++) {
    now = p.due;
    p = cleanRead(p, now);
    intervals.push(intervalOf(p));
  }
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i] > intervals[i - 1], `intervals keep growing: ${intervals.join(', ')}`);
  }
  assert.ok(intervals.at(-1) >= 21, `after five clean reads the interval is ${intervals.at(-1)} days`);
  assert.equal(statusOf(p), 'known');
  assert.equal(p.n, 5);
});

test('reading a word again before it is due barely changes its schedule', () => {
  const p = cleanRead(cleanRead(undefined, NOW), NOW + 3 * DAY);
  const again = cleanRead(p, NOW + 3 * DAY + 60_000);
  assert.ok(intervalOf(again) <= intervalOf(p) + 1, `${intervalOf(p)} -> ${intervalOf(again)}`);
  assert.equal(again.n, p.n + 1);
});

test('a looked-up word comes back sooner than one read cleanly', () => {
  const p = scheduled(10, 10, 0);
  assert.ok(intervalOf(hardRead(p, NOW)) < intervalOf(cleanRead(p, NOW)));
  assert.ok(intervalOf(hardRead(undefined, NOW)) < intervalOf(cleanRead(undefined, NOW)));
});

test('marking a word hard weakens its memory and asks for clean reads', () => {
  const before = scheduled(30, 20, 5);
  const p = markHard(before, NOW);
  assert.equal(p.s, -DEFAULT_HARD_STEP);
  assert.equal(statusOf(p), 'hard');
  assert.ok(p.S < before.S / 3, `stability ${before.S} -> ${p.S}`);
  assert.ok(p.D > before.D, 'and it counts as more difficult');
  assert.equal(p.l, 1);
  assert.equal(p.t, NOW);
  assert.equal(isDue(p, NOW + 99 * DAY), false, 'hard words are handled apart from the schedule');
  assert.equal(statusOf(markHard(undefined, NOW)), 'hard', 'a new word can be marked too');
});

test('a hard word returns to the schedule after as many clean reads as the step', () => {
  for (const step of [1, 2, 3, 4]) {
    let p = markHard(scheduled(30, 20, 5), NOW, { step });
    for (let i = 1; i < step; i++) {
      p = cleanRead(p, NOW + i * 60_000);
      assert.equal(statusOf(p), 'hard', `step ${step}, read ${i}`);
      assert.equal(p.s, -(step - i));
    }
    p = cleanRead(p, NOW + step * 60_000);
    assert.equal(p.s, 0);
    assert.equal(statusOf(p), 'learning');
    assert.ok(p.due >= NOW + DAY, 'its next review is at least a day away');
  }
});

test('a looked-up hard word makes no progress', () => {
  const p = markHard(undefined, NOW);
  assert.equal(hardRead(p, NOW + 1000).s, p.s);
});

test('repeated marks stop at the limit, whatever it is set to', () => {
  assert.deepEqual(MAX_HARD_CHOICES, [1, 2, 3, 4, 5, 6]);
  assert.equal(DEFAULT_MAX_HARD, 4);
  let p = markHard(undefined, NOW, { step: 3 });
  assert.equal(p.s, -3);
  p = markHard(p, NOW + 1, { step: 3 });
  assert.equal(p.s, -4, 'a second mark would reach -6 but the default limit is 4');
  for (const maxHard of MAX_HARD_CHOICES) {
    let q;
    for (let i = 0; i < 8; i++) q = markHard(q, NOW + i, { step: 2, maxHard });
    assert.equal(q.s, -maxHard, `limit ${maxHard}`);
  }
  assert.equal(MIN_SCORE, -6, 'stored values allow for the largest limit');
});

test('the step and the limit come from the settings, within their ranges', () => {
  assert.equal(DEFAULT_HARD_STEP, 2);
  assert.equal(maxHardOf({ maxHard: 6 }), 6);
  assert.equal(maxHardOf({ maxHard: 40 }), 6);
  for (const bad of [undefined, null, {}, { maxHard: 0 }, { maxHard: 'x' }]) assert.equal(maxHardOf(bad), 4);
  assert.equal(hardStepOf({ hardStep: '3' }), 3);
  assert.equal(hardStepOf({ hardStep: 5 }), 4, 'cut to the default limit of 4');
  assert.equal(hardStepOf({ hardStep: 5, maxHard: 6 }), 5);
  assert.equal(hardStepOf({ hardStep: 4, maxHard: 3 }), 3);
  assert.equal(hardStepOf({ maxHard: 1 }), 1);
  for (const bad of [undefined, {}, { hardStep: 0 }, { hardStep: 'x' }]) assert.equal(hardStepOf(bad), 2);
  assert.deepEqual(hardStepChoices({ maxHard: 2 }), [1, 2]);
  assert.deepEqual(rulesOf({ hardStep: 3, maxHard: 5, retention: 0.9 }), { step: 3, maxHard: 5, retention: 0.9 });
  assert.deepEqual(rulesOf({}), { step: 2, maxHard: 4, retention: 0.88 });
});

test('lowering the limit eases the words that were already beyond it, and only those', () => {
  const progress = {
    a: { s: -6, n: 1, l: 3, t: 5, u: 5 },
    b: { s: -3, n: 0, l: 1, t: 0, u: 5 },
    c: scheduled(5, 1, 2),
  };
  assert.deepEqual(capHardness(progress, 3, 9), { a: { s: -3, n: 1, l: 3, t: 5, u: 9 } });
  assert.deepEqual(capHardness(progress, 6, 9), {});
});

test('a stricter target brings words back sooner', () => {
  const p = scheduled(10, 10, 0);
  assert.ok(intervalOf(cleanRead(p, NOW, { retention: 0.95 })) < intervalOf(cleanRead(p, NOW, { retention: 0.8 })));
});

test('"I know this now" puts a hard word straight back on the schedule', () => {
  const p = clearHard(markHard(scheduled(30, 20, 5), NOW), NOW + 1000);
  assert.equal(p.s, 0);
  assert.notEqual(statusOf(p), 'hard');
  assert.ok(p.due > NOW + 1000);
});

test('"Mark as known" sends a word months away; reset forgets it', () => {
  const known = markKnown(undefined, NOW);
  assert.equal(statusOf(known), 'known');
  assert.ok(intervalOf(known) >= 60);
  assert.equal(statusOf(markKnown(markHard(undefined, NOW), NOW)), 'known');
  assert.equal(statusOf(resetWord(NOW)), 'new');
});

test('a sighting or a lookup alone does not reschedule a word', () => {
  const p = scheduled(10, 4, 6);
  assert.deepEqual(seen(p, NOW), { ...p, n: 2, u: NOW });
  assert.deepEqual(lookedUp(p, NOW), { ...p, l: 1, u: NOW });
});

// ---- carrying words over -------------------------------------------------------

test('a word from Anki keeps its memory state, last review and due date', () => {
  const study = { S: 42.5, D: 7.25, last: NOW - 30 * DAY, due: NOW + 9 * DAY, hard: false };
  const p = fromAnki(study, NOW);
  assert.deepEqual(p, { s: 0, n: 0, l: 0, t: study.last, u: NOW, S: 42.5, D: 7.25, due: study.due });
  assert.equal(statusOf(p), 'known');
  assert.equal(isDue(fromAnki({ ...study, due: NOW - DAY }, NOW), NOW), true);
});

test('a word Anki is still teaching comes in as a hard word', () => {
  const p = fromAnki({ S: 0.4, D: 9, last: NOW - 3600_000, due: 0, hard: true }, NOW, { step: 3 });
  assert.equal(p.s, -3);
  assert.equal(statusOf(p), 'hard');
  assert.equal(fromAnki({ S: 0.4, D: 9, hard: true }, NOW, { step: 3, maxHard: 2 }).s, -2);
});

test("Anki's record replaces the app's only where Anki is ahead", () => {
  const study = { S: 12, D: 6, last: NOW - 5 * DAY, due: NOW + 8 * DAY, hard: false };
  assert.equal(ankiIsNewer(undefined, study), true, 'a word the app has never met');
  assert.equal(ankiIsNewer(resetWord(1), study), true);
  const imported = fromAnki(study, NOW);
  assert.equal(ankiIsNewer(imported, study), false, 'importing the same file twice changes nothing');
  assert.equal(ankiIsNewer(imported, { ...study, S: 20, last: NOW - DAY }), true, 'a later Anki review is taken over');
  const readHere = cleanRead(imported, NOW);
  assert.equal(ankiIsNewer(readHere, { ...study, last: NOW - DAY }), false, 'the app reviewed it after Anki did');
  assert.equal(ankiIsNewer(readHere, { ...study, last: NOW + DAY }), true);
});

test('progress saved before the schedule existed is given a memory state', () => {
  const old = (s, n = 0) => upgradeProgress({ s, n, l: 0, t: NOW, u: NOW });
  assert.equal(statusOf(old(0)), 'new');
  assert.equal(statusOf(old(0, 2)), 'learning', 'seen but not yet familiar');
  assert.equal(statusOf(old(1)), 'learning');
  assert.equal(statusOf(old(3)), 'known', 'what used to count as known still does');
  assert.equal(statusOf(old(6)), 'known');
  assert.equal(old(6).s, 0, 'positive scores are no longer stored');
  const hard = old(-3, 1);
  assert.equal(hard.s, -3);
  assert.equal(statusOf(hard), 'hard');
  assert.ok(hard.S > 0);
  assert.equal(upgradeProgress({ s: -9, n: 0, l: 0, t: 0, u: 0 }).s, MIN_SCORE);
  const current = scheduled(12, 3, 4);
  assert.deepEqual(upgradeProgress(current), current, 'up-to-date records pass through');
});

// ---- choosing the words for a text ---------------------------------------------

/** `own` deck words (d0, d1, ...) followed by `builtin` common words (b0, ...). */
function wordList(own, builtin = 0) {
  return [
    ...Array.from({ length: own }, (_, i) => ({ id: `d${i}`, de: `d${i}`, en: '', rank: i, priority: true })),
    ...Array.from({ length: builtin }, (_, i) => ({ id: `b${i}`, de: `b${i}`, en: '', rank: i, priority: false })),
  ];
}
const ids = (picked, kind) => picked.filter((p) => !kind || p.kind === kind).map((p) => p.entry.id);
const kinds = (picked) => {
  const out = { hard: 0, due: 0, new: 0, early: 0 };
  for (const p of picked) out[p.kind]++;
  return out;
};

test('on the first day a text is made of new deck words, in deck order', () => {
  const picked = pickTargets(wordList(300, 1500), {}, 12, { now: NOW, newLeft: 15 });
  assert.deepEqual(
    ids(picked),
    Array.from({ length: 12 }, (_, i) => `d${i}`),
  );
  assert.ok(picked.every((p) => p.kind === 'new' && !p.hard));
});

test('with a backlog: about a sixth new, up to 40% hard, and due words take the rest', () => {
  assert.equal(HARD_SHARE, 0.4);
  assert.equal(NEW_SHARE, 1 / 6);
  const list = wordList(400, 500);
  const progress = {};
  for (let i = 0; i < 20; i++) progress[`d${i}`] = markHard(undefined, NOW - DAY);
  for (let i = 20; i < 150; i++) progress[`d${i}`] = scheduled(10, 15, -5);
  // The three text lengths: 10, 18 and 30 study words.
  for (const [count, want] of [
    [10, { hard: 4, due: 4, new: 2, early: 0 }],
    [18, { hard: 7, due: 8, new: 3, early: 0 }],
    [30, { hard: 12, due: 13, new: 5, early: 0 }],
  ]) {
    const picked = pickTargets(list, progress, count, { now: NOW, newLeft: 15, rng: rng(3) });
    assert.deepEqual(kinds(picked), want, `${count} places`);
    assert.equal(new Set(ids(picked)).size, count, 'no word twice');
    assert.deepEqual(
      ids(picked, 'new'),
      Array.from({ length: want.new }, (_, i) => `d${150 + i}`),
      'next in the deck',
    );
    // Due words, which the learner mostly knows, outnumber the new ones at least two to one.
    assert.ok(want.due >= want.new * 2);
  }
});

test('with few hard words, the due words take their places too', () => {
  const list = wordList(400);
  const progress = { d0: markHard(undefined, NOW - DAY) };
  for (let i = 20; i < 150; i++) progress[`d${i}`] = scheduled(10, 15, -5);
  assert.deepEqual(kinds(pickTargets(list, progress, 30, { now: NOW, newLeft: 15, rng: rng(2) })), {
    hard: 1,
    due: 24,
    new: 5,
    early: 0,
  });
});

test('further due words are offered as extras, without repeating the targets', () => {
  const list = wordList(400, 300);
  const progress = {};
  for (let i = 0; i < 60; i++) progress[`d${i}`] = scheduled(10, 15 + i, -5); // d59 is the most forgotten
  for (let i = 60; i < 80; i++) progress[`d${i}`] = scheduled(10, 1, i); // not due yet: d60 is due soonest
  for (let i = 0; i < 50; i++) progress[`b${i}`] = scheduled(3, 10, -6); // built-in words are never offered
  const targets = pickTargets(list, progress, 18, { now: NOW, newLeft: 15 });
  const extras = pickExtras(list, progress, targets, 20, { now: NOW });
  const targetIds = new Set(ids(targets));
  assert.equal(extras.length, 20);
  assert.ok(extras.every((e) => e.priority && !targetIds.has(e.id)));
  assert.ok(
    extras.every((e) => progress[e.id].due <= NOW),
    'due words come before words not yet due',
  );
  assert.equal(extras[0].id, `d${59 - ids(targets, 'due').length}`, 'continuing where the targets stopped');
  // When the due words run out, the ones due soonest follow.
  const many = pickExtras(list, progress, targets, 60, { now: NOW });
  assert.equal(many.filter((e) => progress[e.id].due > NOW)[0].id, 'd60');
  assert.deepEqual(pickExtras(list, {}, [], 20, { now: NOW }), [], 'nothing to offer before anything is learned');
});

test("new words stop when the day's allowance is used up", () => {
  const list = wordList(400);
  const progress = {};
  for (let i = 0; i < 100; i++) progress[`d${i}`] = scheduled(10, 15, -5);
  assert.deepEqual(kinds(pickTargets(list, progress, 12, { now: NOW, newLeft: 0 })), {
    hard: 0,
    due: 12,
    new: 0,
    early: 0,
  });
  assert.deepEqual(kinds(pickTargets(list, progress, 12, { now: NOW, newLeft: 2 })), {
    hard: 0,
    due: 10,
    new: 2,
    early: 0,
  });
});

test('when little is due, the allowance of new words fills the free places, then early practice', () => {
  const list = wordList(400);
  const progress = { d0: scheduled(10, 15, -5), d1: scheduled(10, 15, -5) };
  for (let i = 2; i < 40; i++) progress[`d${i}`] = scheduled(10, 2, 9);
  assert.deepEqual(kinds(pickTargets(list, progress, 12, { now: NOW, newLeft: 15 })), {
    hard: 0,
    due: 2,
    new: 10,
    early: 0,
  });
  assert.deepEqual(kinds(pickTargets(list, progress, 12, { now: NOW, newLeft: 4 })), {
    hard: 0,
    due: 2,
    new: 4,
    early: 6,
  });
});

test('due words are taken most-forgotten first', () => {
  const list = wordList(50);
  const progress = {
    d5: scheduled(10, 11, -1), // just due
    d6: scheduled(10, 60, -50), // long overdue
    d7: scheduled(2, 10, -7), // weak and overdue
    d8: scheduled(200, 230, -1), // strong, barely due
  };
  const picked = pickTargets(list, progress, 2, { now: NOW, newLeft: 0 });
  assert.deepEqual(ids(picked).sort(), ['d6', 'd7']);
});

test('with nothing due and no allowance left, the words due soonest are practised early', () => {
  const list = wordList(50);
  const progress = {};
  for (let i = 0; i < 30; i++) progress[`d${i}`] = scheduled(10, 1, 30 - i);
  const picked = pickTargets(list, progress, 5, { now: NOW, newLeft: 0 });
  assert.deepEqual(kinds(picked), { hard: 0, due: 0, new: 0, early: 5 });
  assert.deepEqual(ids(picked), ['d29', 'd28', 'd27', 'd26', 'd25']);
});

test('a brand-new learner still gets a full text once the allowance runs out', () => {
  const picked = pickTargets(wordList(300, 500), {}, 12, { now: NOW, newLeft: 3 });
  assert.equal(picked.length, 12);
  assert.ok(
    picked.every((p) => p.entry.priority),
    'from the deck, not from the built-in words',
  );
});

test('built-in words are not chosen while the deck can fill the text', () => {
  const list = wordList(300, 800);
  const progress = {};
  // Built-in words that were read in passing and are now due or new are left alone.
  for (let i = 0; i < 200; i++) progress[`b${i}`] = scheduled(3, 10, -6);
  const r = rng(9);
  for (let round = 0; round < 10; round++) {
    const picked = pickTargets(list, progress, 12, { now: NOW, newLeft: 15, rng: r });
    assert.ok(picked.every((p) => p.entry.priority));
  }
});

test('a hard word comes back whichever list it is from', () => {
  const list = wordList(300, 500);
  const progress = { b7: markHard(undefined, NOW - 1000) };
  const picked = pickTargets(list, progress, 10, { now: NOW, newLeft: 15, rng: rng(4) });
  assert.deepEqual(ids(picked, 'hard'), ['b7']);
  assert.equal(picked.find((p) => p.entry.id === 'b7').hard, true);
  assert.equal(picked.filter((p) => !p.entry.priority).length, 1);
});

test('the harder of two hard words is picked more often', () => {
  const list = wordList(40);
  const progress = {};
  for (let i = 0; i < 40; i++) progress[`d${i}`] = markHard(undefined, NOW);
  progress.d0 = markHard(progress.d0, NOW); // -4 against -2 for the rest
  const r = rng(11);
  let harder = 0;
  let other = 0;
  for (let i = 0; i < 400; i++) {
    const chosen = ids(pickTargets(list, progress, 5, { now: NOW, newLeft: 0, rng: r }));
    if (chosen.includes('d0')) harder++;
    if (chosen.includes('d1')) other++;
  }
  assert.ok(harder > other * 2, `harder=${harder} other=${other}`);
});

test('when the deck has nothing left, the built-in words take over', () => {
  const list = wordList(3, 500);
  const progress = {};
  for (let i = 0; i < 3; i++) progress[`d${i}`] = scheduled(100, 5, 90);
  const picked = pickTargets(list, progress, 8, { now: NOW, newLeft: 15 });
  assert.equal(picked.length, 8);
  assert.deepEqual(ids(picked, 'early').sort(), ['d0', 'd1', 'd2']);
  assert.deepEqual(ids(picked, 'new'), ['b0', 'b1', 'b2', 'b3', 'b4']);
  assert.equal(pickTargets(wordList(0, 500), {}, 12, { now: NOW, newLeft: 15 }).length, 12, 'no deck at all');
});

test('a list smaller than the text gives what there is', () => {
  const picked = pickTargets(wordList(4), { d0: markHard(undefined, NOW) }, 12, { now: NOW, newLeft: 15, rng: rng(1) });
  assert.equal(picked.length, 4);
  assert.equal(new Set(ids(picked)).size, 4);
});
