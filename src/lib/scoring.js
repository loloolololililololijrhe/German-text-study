// What happens to a word when it is read, tapped or marked, and which words
// the next text is written around. Pure functions, no DOM.
//
// A word's progress:
//   s     0, or negative while the word is hard: the clean reads it still
//         needs before it goes back on the long-term schedule
//   S, D  its memory state (stability and difficulty, see srs.js)
//   t     when it was last reviewed
//   due   when it should next come back
//   n, l  how often it was seen in a finished text, and looked up
//   u     when this record last changed (for syncing)
//
// The life of a word follows Anki's:
//   new       never met
//   hard      marked hard; needs a few clean reads in the coming texts
//             (Anki's relearning steps), then returns to the schedule
//   learning  on the schedule with an interval under three weeks
//   known     on the schedule with an interval of three weeks or more

import {
  AGAIN,
  DAY,
  DEFAULT_RETENTION,
  EASY,
  GOOD,
  HARD,
  MATURE_DAYS,
  hasMemory,
  intervalDays,
  recallChance,
  retentionOf,
  review,
} from './srs.js';

/** The furthest below zero `s` is ever stored. */
export const MIN_SCORE = -6;

/**
 * How far below zero a word drops when it is marked hard, which is also how
 * many clean reads it then needs before it is back on the schedule.
 */
export const DEFAULT_HARD_STEP = 2;

/**
 * The hardest a word can get: marking it hard again never takes it further
 * below zero than this. The learner can change it in Settings.
 */
export const DEFAULT_MAX_HARD = 4;
export const MAX_HARD_CHOICES = [1, 2, 3, 4, 5, 6];

/** Share of a text's target words that hard words may take. */
export const HARD_SHARE = 0.6;

/** Share of a text's target words kept for new words, within the daily limit. */
export const NEW_SHARE = 0.25;

/** "Mark as known" gives a word at least this much stability (days). */
const KNOWN_STABILITY = 60;

export const blank = () => ({ s: 0, n: 0, l: 0, t: 0, u: 0 });

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

/** The settings the functions below need, taken from the learner's preferences. */
export function rulesOf(prefs) {
  return { step: hardStepOf(prefs), maxHard: maxHardOf(prefs), retention: retentionOf(prefs) };
}

const withDefaults = (rules) => ({
  step: DEFAULT_HARD_STEP,
  maxHard: DEFAULT_MAX_HARD,
  retention: DEFAULT_RETENTION,
  ...rules,
});

/** Days between the last review and the due date, or 0 for a word not on the schedule. */
export function intervalOf(p) {
  if (!hasMemory(p) || !p.due || !p.t) return 0;
  return Math.max(0, Math.round((p.due - p.t) / DAY));
}

export function statusOf(p) {
  if (!p) return 'new';
  if (p.s < 0) return 'hard';
  if (!hasMemory(p)) return 'new';
  return intervalOf(p) >= MATURE_DAYS ? 'known' : 'learning';
}

/** On the schedule and due now. */
export function isDue(p, now) {
  return hasMemory(p) && p.s >= 0 && (p.due || 0) <= now;
}

/** The due date for a word that is on the schedule and was reviewed just now. */
function nextDue(S, now, retention) {
  return now + intervalDays(S, retention) * DAY;
}

/**
 * The learner marked the word hard: Anki's "Again". Its memory weakens, and
 * it needs `step` clean reads before it is back on the schedule. Marking an
 * already-hard word again makes it harder, but never beyond `maxHard`.
 */
export function markHard(p, now, rules) {
  const { step, maxHard, retention } = withDefaults(rules);
  const b = p || blank();
  return {
    ...b,
    ...review(b, AGAIN, now, retention),
    s: Math.max(-maxHard, Math.min(b.s, 0) - step),
    l: b.l + 1,
    t: now,
    due: now,
    u: now,
  };
}

/**
 * The word appeared in a finished text and was not tapped: Anki's "Good".
 * A hard word has one clean read fewer to go; any other word, or a hard word
 * on its last clean read, gets its next due date.
 */
export function cleanRead(p, now, rules) {
  const { retention } = withDefaults(rules);
  const b = p || blank();
  const memory = review(b, GOOD, now, retention);
  const s = Math.min(0, b.s + 1);
  return { ...b, ...memory, s, n: b.n + 1, t: now, due: s < 0 ? now : nextDue(memory.S, now, retention), u: now };
}

/**
 * The word appeared in a finished text and was looked up without being
 * marked hard: Anki's "Hard". It comes back sooner than after a clean read,
 * and a hard word makes no progress.
 */
export function hardRead(p, now, rules) {
  const { retention } = withDefaults(rules);
  const b = p || blank();
  const memory = review(b, HARD, now, retention);
  return { ...b, ...memory, n: b.n + 1, t: now, due: b.s < 0 ? now : nextDue(memory.S, now, retention), u: now };
}

/** The word appeared in a text that was skipped, or was already dealt with: count the sighting only. */
export function seen(p, now) {
  const b = p || blank();
  return { ...b, n: b.n + 1, u: now };
}

/** A lookup, recorded the moment the word is tapped. */
export function lookedUp(p, now) {
  const b = p || blank();
  return { ...b, l: b.l + 1, u: now };
}

/** "I know this now": a hard word goes straight back on the schedule. */
export function clearHard(p, now, rules) {
  const { retention } = withDefaults(rules);
  const b = p || blank();
  const memory = hasMemory(b) ? { S: b.S, D: b.D } : review(b, GOOD, now, retention);
  return { ...b, ...memory, s: 0, t: b.t || now, due: nextDue(memory.S, now, retention), u: now };
}

/** "Mark as known": Anki's "Easy", and the word will not come back for months. */
export function markKnown(p, now, rules) {
  const { retention } = withDefaults(rules);
  const b = p || blank();
  const memory = review(b, EASY, now, retention);
  const S = Math.max(memory.S, KNOWN_STABILITY);
  return { ...b, S, D: memory.D, s: 0, t: now, due: nextDue(S, now, retention), u: now };
}

export function resetWord(now) {
  return { ...blank(), u: now };
}

/**
 * Carry a word over from Anki. `study` is what the import read from the
 * collection: its memory state, last review and due date, or `hard` for a
 * card Anki is still (re)learning.
 */
export function fromAnki(study, now, rules) {
  const { step, maxHard } = withDefaults(rules);
  const base = { ...blank(), S: study.S, D: study.D, t: study.last || now, u: now };
  if (study.hard) return { ...base, s: -Math.min(step, maxHard), due: now };
  return { ...base, due: study.due || now };
}

/**
 * Whether Anki's record of a word should replace the app's: when the app has
 * never reviewed the word itself, or Anki reviewed it more recently.
 */
export function ankiIsNewer(p, study) {
  if (!p || !hasMemory(p)) return true;
  if (p.n === 0 && p.l === 0) return (study.last || 0) !== (p.t || 0) || study.S !== p.S;
  return (study.last || 0) > (p.t || 0);
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

/**
 * Bring a record saved by an earlier version of the app up to date. Before
 * the schedule existed, a positive `s` counted clean reads; give such words a
 * memory state of roughly matching strength.
 */
export function upgradeProgress(p) {
  const s = Math.max(MIN_SCORE, Math.min(0, p.s));
  if (hasMemory(p)) return { ...p, s };
  const base = { s, n: p.n, l: p.l, t: p.t, u: p.u };
  if (p.s === 0 && p.n === 0) return base;
  const t = p.t || p.u || 0;
  const S = p.s < 0 ? 0.5 : [1, 2, 5, 21, 40, 80, 150][Math.min(6, p.s)];
  return { ...base, S, D: p.s < 0 ? 7 : 5, t, due: p.s < 0 ? t : t + intervalDays(S) * DAY };
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
 * Sort a word list into the groups a text can draw on. Only the learner's own
 * words (`priority`) are candidates, except that a hard word counts whichever
 * list it is from; the built-in words form a reserve for when the deck runs out.
 */
export function wordPools(entries, progress, now) {
  const pools = { hard: [], due: [], fresh: [], early: [], spareDue: [], spareFresh: [], spareEarly: [] };
  for (const e of entries) {
    const p = progress[e.id];
    if (p && p.s < 0) pools.hard.push({ e, w: 2 ** -p.s });
    else if (!hasMemory(p)) (e.priority ? pools.fresh : pools.spareFresh).push(e);
    else if ((p.due || 0) <= now) {
      (e.priority ? pools.due : pools.spareDue).push({ e, recall: recallChance(p, now) });
    } else (e.priority ? pools.early : pools.spareEarly).push({ e, due: p.due });
  }
  const byRank = (a, b) => a.rank - b.rank;
  const mostForgotten = (a, b) => a.recall - b.recall || a.e.rank - b.e.rank;
  const soonest = (a, b) => a.due - b.due || a.e.rank - b.e.rank;
  pools.fresh.sort(byRank);
  pools.spareFresh.sort(byRank);
  pools.due.sort(mostForgotten);
  pools.spareDue.sort(mostForgotten);
  pools.early.sort(soonest);
  pools.spareEarly.sort(soonest);
  return pools;
}

/**
 * Choose the words the next text is written around.
 *
 * 1. About a quarter of the places are kept for new words, in deck order, as
 *    long as today's allowance of new words (`newLeft`) lasts.
 * 2. Hard words take up to 60% of the places.
 * 3. Words that are due take what is left, the most forgotten first.
 * 4. Places still free go to more new words within the allowance, then to
 *    early practice of the words due soonest.
 * 5. If the text is still short, the limits above are passed (more hard, due
 *    and new words), and only after that do the built-in words get a turn.
 *
 * Each result is { entry, hard, kind }, kind being 'hard', 'due', 'new' or 'early'.
 */
export function pickTargets(
  entries,
  progress,
  count,
  { now = Date.now(), newLeft = Infinity, rng = Math.random } = {},
) {
  const pools = wordPools(entries, progress, now);
  const picked = [];
  const take = (kind, items) => {
    for (const it of items) picked.push({ entry: it.e || it, hard: kind === 'hard', kind });
    return items.length;
  };
  const room = () => count - picked.length;

  const allowance = Math.max(0, Math.min(pools.fresh.length, newLeft));
  const reserved = Math.min(allowance, Math.round(count * NEW_SHARE));
  const hardN = Math.min(pools.hard.length, Math.round(count * HARD_SHARE), count - reserved);
  const chosenHard = weightedSample(pools.hard, hardN, rng);
  take('hard', chosenHard);

  const dueN = take('due', pools.due.slice(0, Math.max(0, room() - reserved)));
  const newN = take('new', pools.fresh.slice(0, Math.min(allowance, room())));
  take('early', pools.early.slice(0, room()));

  // Still room, which happens when little has been learned yet: go past the
  // limits above rather than leave the text short, own words before built-in ones.
  if (room() > 0) {
    const leftHard = pools.hard.filter((x) => !chosenHard.includes(x));
    take('hard', weightedSample(leftHard, room(), rng));
  }
  if (room() > 0) take('due', pools.due.slice(dueN, dueN + room()));
  if (room() > 0) take('new', pools.fresh.slice(newN, newN + room()));
  if (room() > 0) take('due', pools.spareDue.slice(0, room()));
  if (room() > 0) take('new', pools.spareFresh.slice(0, room()));
  if (room() > 0) take('early', pools.spareEarly.slice(0, room()));
  return picked;
}
