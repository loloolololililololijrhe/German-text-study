import test from 'node:test';
import assert from 'node:assert/strict';
import { BANK } from '../src/data/leveltest.js';
import {
  LEVEL_PASS,
  LEVEL_SIZE,
  STAGE_NEAR,
  STAGE_PASS,
  STAGE_SIZE,
  TESTS_KEPT,
  TEST_LEVELS,
  bankProblems,
  drawItems,
  findResult,
  gradeStage,
  levelPassed,
  levelResult,
  markSeen,
  mergeTests,
  placement,
  present,
  sanitizeTests,
  textLevelFor,
} from '../src/lib/leveltest.js';
import { emptyState, mergeStates, sanitizeState } from '../src/lib/merge.js';
import { LEVELS } from '../src/lib/prompt.js';

function mulberry(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stages = (...correct) => correct.map((c, i) => ({ level: TEST_LEVELS[i], correct: c, total: STAGE_SIZE }));

// ---- the questions ---------------------------------------------------------

test('the question bank is well formed', () => {
  assert.deepEqual(bankProblems(BANK), []);
});

test('there are twenty questions for each of the six levels', () => {
  assert.deepEqual(TEST_LEVELS, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  for (const level of TEST_LEVELS) {
    assert.equal(BANK.filter((it) => it.level === level).length, 20, level);
  }
  assert.equal(BANK.length, 120);
});

test('every level mixes kinds of question and has something to read', () => {
  for (const level of TEST_LEVELS) {
    const kinds = new Set(BANK.filter((it) => it.level === level).map((it) => it.kind));
    assert.ok(kinds.has('gap') && kinds.has('meaning') && kinds.has('read'), `${level}: ${[...kinds]}`);
  }
});

test('a gap is filled by the first option without leaving a gap or a doubled word', () => {
  for (const it of BANK.filter((x) => x.kind === 'gap')) {
    const gaps = it.q.match(/___/g).length;
    const parts = it.o[0].split(' … ');
    assert.equal(parts.length, gaps, `${it.id}: one answer part per gap`);
    for (const o of it.o) assert.equal(o.split(' … ').length, gaps, `${it.id}: „${o}“`);
    let filled = it.q;
    for (const p of parts) filled = filled.replace('___', p);
    assert.ok(!/___/.test(filled) && !/\s{2,}/.test(filled), it.id);
  }
});

test('the checker itself notices a broken bank', () => {
  const good = BANK.find((it) => it.kind === 'gap');
  const bad = [
    { ...good, id: 'x1', o: ['a', 'b', 'c'] },
    { ...good, id: 'x2', o: ['a', 'A', 'b', 'c'] },
    { ...good, id: 'x3', q: 'No gap here.' },
    { ...good, id: 'x4', level: 'D1' },
    { ...good, id: 'x4', why: '' },
  ];
  const problems = bankProblems(bad).join('\n');
  for (const want of [
    'x1: needs exactly four options',
    'x2: options repeat',
    'x3: a gap question needs ___',
    'x4: unknown level',
    'x4: missing or repeated id',
    'x4: needs an explanation',
    'A1: only',
  ]) {
    assert.ok(problems.includes(want), want);
  }
});

// ---- drawing and showing questions ------------------------------------------

test('questions are drawn from the level asked for, without repeats', () => {
  const rng = mulberry(1);
  for (const level of TEST_LEVELS) {
    const got = drawItems(BANK, level, STAGE_SIZE, {}, rng);
    assert.equal(got.length, STAGE_SIZE);
    assert.ok(got.every((it) => it.level === level));
    assert.equal(new Set(got.map((it) => it.id)).size, STAGE_SIZE);
  }
  assert.equal(drawItems(BANK, 'B1', LEVEL_SIZE, {}, rng).length, LEVEL_SIZE);
  assert.equal(drawItems(BANK, 'B1', 50, {}, rng).length, 20, 'never more than there are');
  assert.deepEqual(drawItems(BANK, 'Z9', 5, {}, rng), []);
});

test('questions seen least often come first, so the next test is a different one', () => {
  const rng = mulberry(2);
  const first = drawItems(BANK, 'A2', STAGE_SIZE, {}, rng);
  const seen = markSeen({}, first);
  assert.ok(first.every((it) => seen[it.id] === 1));
  const second = drawItems(BANK, 'A2', STAGE_SIZE, seen, rng);
  assert.ok(
    second.every((it) => !first.includes(it)),
    'none of the first eight again',
  );
  const third = drawItems(BANK, 'A2', STAGE_SIZE, markSeen(seen, second), rng);
  const fresh = third.filter((it) => !first.includes(it) && !second.includes(it));
  assert.equal(fresh.length, 4, 'the four still unseen are all used before any repeat');
  assert.equal(markSeen(seen, first)[first[0].id], 2);
  assert.deepEqual(seen, markSeen({}, first), 'the record passed in is not changed');
});

test('a question is shown with its options shuffled and the right one remembered', () => {
  const item = BANK.find((it) => it.id === 'a1-01');
  const positions = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const q = present(item, mulberry(seed));
    assert.deepEqual([...q.options].sort(), [...item.o].sort());
    assert.equal(q.options[q.answer], item.o[0]);
    positions.add(q.answer);
  }
  assert.equal(positions.size, 4, 'the right answer turns up in every position');
  assert.equal(present(item).ask, 'Which word or phrase fits the gap?');
  const own = BANK.find((it) => it.ask);
  assert.equal(present(own).ask, own.ask, 'a question can bring its own instruction');
  const read = present(BANK.find((it) => it.kind === 'read'));
  assert.ok(read.text.length > 40 && read.q && read.why);
  assert.equal(present(BANK.find((it) => it.kind === 'order')).q, '');
});

// ---- passing a level ---------------------------------------------------------

test('a level of "Find my level" is passed with 6 of 8; 5 is a near miss', () => {
  assert.deepEqual([STAGE_SIZE, STAGE_PASS, STAGE_NEAR], [8, 6, 5]);
  assert.deepEqual(
    [8, 7, 6, 5, 4, 0].map((c) => gradeStage(c)),
    ['pass', 'pass', 'pass', 'near', 'fail', 'fail'],
  );
  assert.equal(gradeStage(3, 4), 'pass', 'a shorter set is held to the same share');
  assert.equal(gradeStage(2, 4), 'fail');
});

test('a single level is passed with 9 of 12', () => {
  assert.deepEqual([LEVEL_SIZE, LEVEL_PASS], [12, 9]);
  assert.equal(levelPassed(9), true);
  assert.equal(levelPassed(8), false);
  assert.equal(levelPassed(12), true);
  assert.equal(levelPassed(6, 8), true);
  assert.equal(levelPassed(5, 8), false);
});

test('"Find my level" goes up for as long as levels are passed and stops at the first that is not', () => {
  assert.deepEqual(placement([]), { level: '', next: 'A1' });
  assert.deepEqual(placement(stages(8)), { level: 'A1', next: 'A2' });
  assert.deepEqual(placement(stages(8, 6)), { level: 'A2', next: 'B1' });
  assert.deepEqual(placement(stages(8, 6, 3)), { level: 'A2', next: null });
  assert.deepEqual(placement(stages(2)), { level: '', next: null }, 'not even A1');
  assert.deepEqual(placement(stages(8, 8, 8, 8, 8, 8)), { level: 'C2', next: null });
  assert.deepEqual(placement(stages(8, 8, 8, 8, 8, 4)), { level: 'C1', next: null });
});

test('a near miss is forgiven if the next level is passed, but only once in a row', () => {
  assert.deepEqual(placement(stages(8, 5)), { level: 'A1', next: 'B1' }, 'one more level to make up for it');
  assert.deepEqual(placement(stages(8, 5, 7)), { level: 'B1', next: 'B2' }, 'made up');
  assert.deepEqual(placement(stages(8, 5, 5)), { level: 'A1', next: null }, 'two near misses end the test');
  assert.deepEqual(placement(stages(8, 5, 2)), { level: 'A1', next: null });
  assert.deepEqual(placement(stages(5)), { level: '', next: 'A2' });
  assert.deepEqual(placement(stages(5, 8)), { level: 'A2', next: 'B1' });
  assert.deepEqual(
    placement(stages(5, 8, 5, 6)),
    { level: 'B2', next: 'C1' },
    'a second near miss later on is forgiven too',
  );
  assert.deepEqual(
    placement(stages(8, 8, 8, 8, 8, 5)),
    { level: 'C1', next: null },
    'nothing follows C2 to make up for it',
  );
});

// ---- results -----------------------------------------------------------------

test('a finished test becomes a result that can be stored', () => {
  const find = findResult(stages(8, 6, 3), 1000);
  assert.deepEqual(find, {
    at: 1000,
    mode: 'find',
    level: 'A2',
    pass: true,
    scores: [
      ['A1', 8, 8],
      ['A2', 6, 8],
      ['B1', 3, 8],
    ],
  });
  assert.deepEqual(findResult(stages(1), 5), { at: 5, mode: 'find', level: '', pass: false, scores: [['A1', 1, 8]] });
  assert.deepEqual(levelResult('B1', 9, 12, 7), {
    at: 7,
    mode: 'level',
    level: 'B1',
    pass: true,
    scores: [['B1', 9, 12]],
  });
  assert.equal(levelResult('C1', 8, 12, 7).pass, false);
  assert.deepEqual(sanitizeTests([find]), [find], 'and loads back unchanged');
});

test('stored results survive missing, partial and hostile input', () => {
  for (const bad of [
    undefined,
    null,
    'x',
    7,
    {},
    [null, 'x', 5, {}, { at: 1 }, { at: 1, mode: 'x', scores: [['A1', 1, 8]] }],
  ]) {
    assert.deepEqual(sanitizeTests(bad), []);
  }
  const got = sanitizeTests([
    { at: 5, mode: 'level', level: 'B1', pass: 1, scores: [['B1', '9', '12'], ['ZZ', 1, 2], 'x', ['B2', 3, 0]] },
    { at: 9, mode: 'find', level: 'nonsense', pass: true, scores: [['A1', 99, 8]] },
    { at: 3, mode: 'level', level: '', scores: [['A1', 1, 8]] },
    { at: 4, mode: 'find', level: 'A1', scores: [] },
    { at: 5, mode: 'find', level: 'A1', scores: [['A1', 8, 8]] },
  ]);
  assert.deepEqual(got, [
    { at: 9, mode: 'find', level: '', pass: false, scores: [['A1', 8, 8]] },
    { at: 5, mode: 'level', level: 'B1', pass: true, scores: [['B1', 9, 12]] },
  ]);
});

test('results from two devices are combined, newest first, and only the latest are kept', () => {
  const r = (at) => levelResult('A2', 9, 12, at);
  assert.deepEqual(
    mergeTests([r(3), r(1)], [r(2), r(3)]).map((t) => t.at),
    [3, 2, 1],
  );
  assert.deepEqual(mergeTests(undefined, [r(1)]), [r(1)]);
  assert.deepEqual(mergeTests(undefined, undefined), []);
  const many = Array.from({ length: TESTS_KEPT + 5 }, (_, i) => r(i + 1));
  const kept = mergeTests(many, []);
  assert.equal(kept.length, TESTS_KEPT);
  assert.equal(kept[0].at, TESTS_KEPT + 5);
});

test('results are part of the synced state', () => {
  assert.deepEqual(emptyState().tests, []);
  assert.deepEqual(sanitizeState({}).tests, [], 'a state saved before the test existed');
  const a = { ...emptyState(), tests: [levelResult('A2', 9, 12, 10)] };
  const b = { ...emptyState(), tests: [findResult(stages(8, 2), 20)] };
  assert.deepEqual(
    mergeStates(a, b).tests.map((t) => [t.at, t.mode, t.level]),
    [
      [20, 'find', 'A1'],
      [10, 'level', 'A2'],
    ],
  );
  assert.deepEqual(mergeStates(a, sanitizeState({})).tests, a.tests);
  assert.deepEqual(sanitizeState(JSON.parse(JSON.stringify(mergeStates(a, b)))).tests, mergeStates(a, b).tests);
});

test('the result names a level of text the app can write', () => {
  const offered = Object.keys(LEVELS);
  assert.deepEqual(offered, ['A1', 'A2', 'B1', 'B2']);
  assert.equal(textLevelFor('', offered), 'A1', 'below A1: start at A1');
  assert.equal(textLevelFor('A1', offered), 'A1');
  assert.equal(textLevelFor('B1', offered), 'B1');
  assert.equal(textLevelFor('B2', offered), 'B2');
  assert.equal(textLevelFor('C1', offered), 'B2', 'above what the app writes: its highest level');
  assert.equal(textLevelFor('C2', offered), 'B2');
});
