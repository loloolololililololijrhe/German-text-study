// How words gain and lose weight. Pure functions, no DOM.
//
// Every word has one number, its score `s`:
//   s < 0   hard      marking a word hard pushes it below zero, by the step
//                     the learner chose in Settings (2 unless changed)
//   s = 0   new
//   s > 0   familiar  each time you read past it without tapping, s goes up by 1
//
// A word's chance of being picked for the next text halves with every point of
// score, so hard words come back often and familiar words fade out. Nothing
// ever reaches zero weight, so every word stays learnable.

/** The limits a score is stored within. */
export const MIN_SCORE = -6;
export const MAX_SCORE = 6;

/**
 * How far below zero a word drops when it is marked hard, which is also how
 * many clean reads it then needs to count as normal again.
 */
export const DEFAULT_HARD_STEP = 2;

/**
 * The hardest a word can get: marking it hard again never takes it further
 * below zero than this. The learner can change it in Settings.
 */
export const DEFAULT_MAX_HARD = 4;
export const MAX_HARD_CHOICES = [1, 2, 3, 4, 5, 6];
export const KNOWN_AT = 3;

/** Share of a text's target words reserved for hard words, when there are enough. */
export const HARD_SHARE = 0.6;

export const blank = () => ({ s: 0, n: 0, l: 0, t: 0, u: 0 });

export function statusOf(p) {
  if (!p) return 'new';
  if (p.s < 0) return 'hard';
  if (p.s >= KNOWN_AT) return 'known';
  if (p.n > 0 || p.s > 0) return 'learning';
  return 'new';
}

/** The learner's limit on hardness, or the default if nothing usable is stored. */
export function maxHardOf(prefs) {
  const n = Math.round(Number(prefs?.maxHard));
  if (!(n >= 1)) return DEFAULT_MAX_HARD;
  return Math.min(n, MAX_HARD_CHOICES.at(-1));
}

/** The learner's chosen step. It cannot be larger than the limit on hardness. */
export function hardStepOf(prefs) {
  const max = maxHardOf(prefs);
  const n = Math.round(Number(prefs?.hardStep));
  return Math.min(n >= 1 ? n : DEFAULT_HARD_STEP, max);
}

/** The steps offered in Settings: 1 up to the limit on hardness. */
export function hardStepChoices(prefs) {
  return MAX_HARD_CHOICES.filter((n) => n <= maxHardOf(prefs));
}

/**
 * The learner flagged the word. Flagging an already-hard word makes it
 * harder, but never further below zero than `maxHard`.
 */
export function markHard(p, now, step = DEFAULT_HARD_STEP, maxHard = DEFAULT_MAX_HARD) {
  const b = p || blank();
  return { ...b, s: Math.max(-maxHard, Math.min(b.s, 0) - step), l: b.l + 1, u: now };
}

/**
 * When the limit on hardness is lowered, words already harder than it are
 * eased to the new limit. Returns only the entries that change.
 */
export function capHardness(progress, maxHard, now) {
  const updates = {};
  for (const [id, p] of Object.entries(progress)) {
    if (p.s < -maxHard) updates[id] = { ...p, s: -maxHard, u: now };
  }
  return updates;
}

/** The word appeared in a finished text and was not tapped. */
export function cleanRead(p, now) {
  const b = p || blank();
  return { ...b, s: Math.min(MAX_SCORE, b.s + 1), n: b.n + 1, t: now, u: now };
}

/** The word appeared but was looked up or flagged: count the sighting, keep the score. */
export function seen(p, now) {
  const b = p || blank();
  return { ...b, n: b.n + 1, t: now, u: now };
}

/** A lookup that was not flagged as hard. */
export function lookedUp(p, now) {
  const b = p || blank();
  return { ...b, l: b.l + 1, u: now };
}

/** "I know this now": lift a hard word straight back to normal. */
export function clearHard(p, now) {
  const b = p || blank();
  return { ...b, s: Math.max(b.s, 1), u: now };
}

/** Mark as known from the word list: it will rarely be picked again. */
export function markKnown(p, now) {
  const b = p || blank();
  return { ...b, s: Math.max(b.s, KNOWN_AT + 1), u: now };
}

export function resetWord(now) {
  return { ...blank(), u: now };
}

/** More common words (low rank) are preferred, gently. */
export function frequencyWeight(rank) {
  return 1 / (1 + Math.max(0, rank) / 300);
}

export function weightOf(entry, p) {
  const s = p?.s ?? 0;
  const base = 2 ** -s;
  return s < 0 ? base : base * frequencyWeight(entry.rank);
}

/** Weighted sampling without replacement (Efraimidis-Spirakis). */
export function weightedSample(items, k, rng = Math.random) {
  if (k <= 0) return [];
  return items
    .map((it) => ({ it, key: Math.log(rng() || 1e-12) / it.w }))
    .sort((a, b) => b.key - a.key)
    .slice(0, k)
    .map((x) => x.it);
}

/**
 * A starting point for a word already studied in Anki: 2 = well learned
 * (starts as known), 1 = still being learned (starts as learning).
 */
export function fromAnki(level, now) {
  return { ...blank(), s: level >= 2 ? KNOWN_AT : 1, u: now };
}

/**
 * Choose the words the next text is written around.
 *
 * 1. Hard words get their own share of the slots, so they are not drowned out
 *    by thousands of unseen words.
 * 2. The other slots go to priority words (the learner's own deck) that are
 *    not yet known, weighted by score and frequency.
 * 3. Only when those run out do the remaining words get a turn: the built-in
 *    common words and deck words that are already known. Until then they
 *    simply appear whenever a text needs them.
 */
export function pickTargets(entries, progress, count, rng = Math.random) {
  const hard = [];
  const first = [];
  const rest = [];
  for (const e of entries) {
    const p = progress[e.id];
    const s = p?.s ?? 0;
    const item = { e, w: weightOf(e, p) };
    if (s < 0) hard.push(item);
    else if (e.priority && s < KNOWN_AT) first.push(item);
    else rest.push(item);
  }
  let hardN = Math.min(hard.length, Math.round(count * HARD_SHARE));
  const others = Math.min(first.length + rest.length, count - hardN);
  hardN = Math.min(hard.length, count - others);
  const firstN = Math.min(first.length, others);
  const plain = (x) => ({ entry: x.e, hard: false });
  return [
    ...weightedSample(hard, hardN, rng).map((x) => ({ entry: x.e, hard: true })),
    ...weightedSample(first, firstN, rng).map(plain),
    ...weightedSample(rest, others - firstN, rng).map(plain),
  ];
}
