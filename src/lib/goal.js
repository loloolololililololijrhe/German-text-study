// The daily goal: how many texts the learner wants to finish each day, and how
// many have been finished today. Pure functions, no DOM.

import { dayKey } from './srs.js';

/** The goals offered in Settings. 0 means no goal. */
export const TEXT_GOAL_CHOICES = [0, 1, 2, 3, 5, 10, 15, 20];

/** Finish times beyond this many in one day are not kept. */
const MAX_READS = 200;

/** The texts finished on the most recent day of reading: the day, and when each was finished. */
export const emptyRead = () => ({ day: '', at: [] });

/** The learner's goal in texts a day, or 0 when none is set. */
export function textGoalOf(prefs) {
  const n = Math.round(Number(prefs?.textsPerDay));
  return n >= 1 ? Math.min(n, 99) : 0;
}

/** Accept anything parsed from storage or a gist and return a well-formed record. */
export function sanitizeRead(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.day !== 'string' || !Array.isArray(raw.at)) return emptyRead();
  const at = [...new Set(raw.at.map(Number).filter((t) => t > 0))].sort((a, b) => a - b);
  return { day: raw.day, at: at.slice(-MAX_READS) };
}

/**
 * Two devices' records as one. The later day counts; on the same day the
 * finish times of both are kept, so texts read on each device all count.
 */
export function mergeReads(a, b) {
  const [x, y] = [a || emptyRead(), b || emptyRead()];
  if (x.day !== y.day) return x.day > y.day ? { day: x.day, at: [...x.at] } : { day: y.day, at: [...y.at] };
  return sanitizeRead({ day: x.day, at: [...x.at, ...y.at] });
}

/** The record after a text was finished at `now`. */
export function markRead(read, now) {
  const today = dayKey(now);
  const before = read && read.day === today ? read.at : [];
  return sanitizeRead({ day: today, at: [...before, now] });
}

/** How many texts were finished today. */
export function textsToday(read, now) {
  return read && read.day === dayKey(now) ? read.at.length : 0;
}

/** Where the learner stands today: { goal, done, left, met }. Without a goal, `met` is false. */
export function goalStatus(read, prefs, now) {
  const goal = textGoalOf(prefs);
  const done = textsToday(read, now);
  return { goal, done, left: Math.max(0, goal - done), met: goal > 0 && done >= goal };
}
