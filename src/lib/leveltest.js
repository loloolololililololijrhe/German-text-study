// The level test: how questions are drawn, how a level is passed, and how the
// results are kept. Pure functions, no DOM. The questions are in
// src/data/leveltest.js.

/** The levels the test covers, easiest first. */
export const TEST_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** "Find my level": questions per level, and how many must be right. */
export const STAGE_SIZE = 8;
export const STAGE_PASS = 6;
/** One short of a pass: the next level gets a chance to make up for it. */
export const STAGE_NEAR = 5;

/** The test of a single level. */
export const LEVEL_SIZE = 12;
export const LEVEL_PASS = 9;

/** How many results are remembered. */
export const TESTS_KEPT = 20;

const KINDS = ['gap', 'meaning', 'order', 'read'];

/** What the learner is asked to do, unless the question says so itself. */
const ASK = {
  gap: 'Which word or phrase fits the gap?',
  meaning: 'What does this mean?',
  order: 'Which sentence is correct?',
  read: 'Read the text, then answer the question.',
};

export const isTestLevel = (level) => TEST_LEVELS.includes(level);

/** 'pass', 'near' or 'fail' for a level of "Find my level". */
export function gradeStage(correct, total = STAGE_SIZE) {
  // The marks are set for a full set of questions; a shorter one is held to the same share.
  const need = (n) => Math.ceil((n * total) / STAGE_SIZE);
  if (correct >= need(STAGE_PASS)) return 'pass';
  return correct >= need(STAGE_NEAR) ? 'near' : 'fail';
}

/** Whether a single-level test was passed. */
export function levelPassed(correct, total = LEVEL_SIZE) {
  return correct >= Math.ceil((LEVEL_PASS * total) / LEVEL_SIZE);
}

/**
 * Where "Find my level" stands after the levels taken so far, in order from
 * A1. `scores` is a list of { level, correct, total }.
 *
 * A level is passed with 6 of 8. The test stops at the first level that is
 * not passed, except that a near miss (5 of 8) is forgiven if the level after
 * it is passed outright.
 *
 * Returns { level, next }: the highest level reached ('' if not even A1), and
 * the level to test next, or null when the test is over.
 */
export function placement(scores) {
  let level = '';
  let pending = false; // the level before was a near miss
  for (let i = 0; i < TEST_LEVELS.length; i++) {
    const s = scores[i];
    if (!s) return { level, next: TEST_LEVELS[i] };
    const grade = gradeStage(s.correct, s.total);
    if (grade === 'pass') {
      level = TEST_LEVELS[i];
      pending = false;
    } else if (grade === 'near' && !pending) {
      pending = true;
    } else {
      return { level, next: null };
    }
  }
  return { level, next: null };
}

/**
 * Choose `n` questions of a level. Questions the learner has seen least often
 * come first, in random order among equals, so a second test differs from the
 * first. `seen` maps question ids to how often they were shown.
 */
export function drawItems(bank, level, n, seen = {}, rng = Math.random) {
  return bank
    .filter((it) => it.level === level)
    .map((it) => ({ it, times: seen[it.id] || 0, r: rng() }))
    .sort((a, b) => a.times - b.times || a.r - b.r)
    .slice(0, n)
    .map((x) => ({ it: x.it, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.it);
}

/** `seen` after these questions were shown once more. */
export function markSeen(seen, items) {
  const out = { ...seen };
  for (const it of items) out[it.id] = (out[it.id] || 0) + 1;
  return out;
}

/** A question as it is shown: its options in random order, and which one is right. */
export function present(item, rng = Math.random) {
  const order = item.o.map((text, i) => ({ text, right: i === 0, r: rng() })).sort((a, b) => a.r - b.r);
  return {
    id: item.id,
    level: item.level,
    kind: item.kind,
    ask: item.ask || ASK[item.kind],
    text: item.text || '',
    q: item.q || '',
    options: order.map((x) => x.text),
    answer: order.findIndex((x) => x.right),
    why: item.why,
  };
}

/** Everything that is wrong with a question bank, as a list of messages. An empty list means it is usable. */
export function bankProblems(bank) {
  const problems = [];
  const ids = new Set();
  const faces = new Set();
  for (const it of bank) {
    const at = it?.id || '(no id)';
    const say = (m) => problems.push(`${at}: ${m}`);
    if (!it?.id || ids.has(it.id)) say('missing or repeated id');
    ids.add(it?.id);
    if (!isTestLevel(it.level)) say('unknown level');
    if (!KINDS.includes(it.kind)) say('unknown kind');
    if (!Array.isArray(it.o) || it.o.length !== 4) say('needs exactly four options');
    else if (new Set(it.o.map((x) => String(x).trim().toLowerCase())).size !== 4) say('options repeat');
    else if (it.o.some((x) => typeof x !== 'string' || !x.trim())) say('empty option');
    if (typeof it.why !== 'string' || it.why.length < 8) say('needs an explanation');
    if (it.kind === 'gap' && !/___/.test(it.q || '')) say('a gap question needs ___');
    if (it.kind !== 'gap' && /___/.test(it.q || '')) say('only gap questions have ___');
    if (it.kind === 'read' && !(it.text && it.text.length > 40)) say('a reading question needs a text');
    if (it.kind !== 'read' && it.text) say('only reading questions have a text');
    if (it.kind !== 'order' && !(it.q && it.q.trim())) say('needs a question');
    const face = `${it.text || ''}|${it.q || ''}|${it.o?.[0]}`;
    if (faces.has(face)) say('repeats another question');
    faces.add(face);
  }
  for (const level of TEST_LEVELS) {
    const n = bank.filter((it) => it.level === level).length;
    if (n < Math.max(STAGE_SIZE, LEVEL_SIZE)) problems.push(`${level}: only ${n} questions`);
  }
  return problems;
}

// ---- results ---------------------------------------------------------------
//
// A result: { at, mode, level, pass, scores }
//   mode 'find'   "Find my level": `level` is the level reached ('' below A1)
//   mode 'level'  one level: `level` is the level tested, `pass` whether it was passed
//   scores        [[level, correct, total], ...] in the order taken

function cleanTest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  const mode = raw.mode === 'level' ? 'level' : raw.mode === 'find' ? 'find' : '';
  if (!(at > 0) || !mode) return null;
  const level = isTestLevel(raw.level) ? raw.level : '';
  if (mode === 'level' && !level) return null;
  const scores = (Array.isArray(raw.scores) ? raw.scores : [])
    .filter((s) => Array.isArray(s) && isTestLevel(s[0]) && Number(s[2]) > 0)
    .map((s) => {
      const total = Math.round(Number(s[2]));
      return [s[0], Math.max(0, Math.min(total, Math.round(Number(s[1]) || 0))), total];
    });
  if (!scores.length) return null;
  return { at, mode, level, pass: mode === 'find' ? level !== '' : !!raw.pass, scores };
}

/** Accept anything parsed from storage or a gist and return a well-formed list of results, newest first. */
export function sanitizeTests(raw) {
  const byTime = new Map();
  for (const t of Array.isArray(raw) ? raw : []) {
    const clean = cleanTest(t);
    if (clean && !byTime.has(clean.at)) byTime.set(clean.at, clean);
  }
  return [...byTime.values()].sort((a, b) => b.at - a.at).slice(0, TESTS_KEPT);
}

/** The results of two devices as one list. */
export function mergeTests(a, b) {
  return sanitizeTests([...(a || []), ...(b || [])]);
}

/** The result of a finished "Find my level" test. */
export function findResult(scores, at) {
  return {
    at,
    mode: 'find',
    level: placement(scores).level,
    pass: placement(scores).level !== '',
    scores: scores.map((s) => [s.level, s.correct, s.total]),
  };
}

/** The result of a finished single-level test. */
export function levelResult(level, correct, total, at) {
  return { at, mode: 'level', level, pass: levelPassed(correct, total), scores: [[level, correct, total]] };
}

/**
 * The level of text to read after a "Find my level" result, from the levels
 * the app can write (`offered`, easiest first): the level reached, or the
 * nearest one the app has.
 */
export function textLevelFor(level, offered) {
  if (!level) return offered[0];
  if (offered.includes(level)) return level;
  return TEST_LEVELS.indexOf(level) > TEST_LEVELS.indexOf(offered.at(-1)) ? offered.at(-1) : offered[0];
}
