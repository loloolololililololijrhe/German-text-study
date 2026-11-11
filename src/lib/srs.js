// Spaced repetition: when a word should come back.
//
// This is FSRS, the scheduler Anki uses. Each word has a memory state:
//   S  stability   how many days until the chance of recalling it falls to 90%
//   D  difficulty  1 (easy) to 10 (hard); hard words gain stability more slowly
// Every review moves both, and the next due date is the day the recall chance
// reaches the learner's target. The arithmetic comes from ts-fsrs, the
// reference implementation, and is tested against Anki's own results.

import { default_w, forgetting_curve, fsrs } from 'ts-fsrs';

export const DAY = 86_400_000;

/** Anki's grades. */
export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;

/** Anki calls a word mature once its interval reaches three weeks. */
export const MATURE_DAYS = 21;

/** The chance of recall at which a word is brought back. */
export const DEFAULT_RETENTION = 0.88;
export const RETENTION_CHOICES = [0.8, 0.85, 0.88, 0.9, 0.92, 0.95];

export const DEFAULT_NEW_PER_DAY = 15;
export const NEW_PER_DAY_CHOICES = [0, 5, 10, 15, 20, 30, 50];

export function retentionOf(prefs) {
  const r = Number(prefs?.retention);
  return r >= 0.7 && r <= 0.97 ? r : DEFAULT_RETENTION;
}

export function newPerDayOf(prefs) {
  const n = Math.round(Number(prefs?.newPerDay));
  return n >= 0 && n <= 200 ? n : DEFAULT_NEW_PER_DAY;
}

const schedulers = new Map();

function scheduler(retention) {
  if (!schedulers.has(retention)) {
    // No fuzz: the same history always gives the same due date.
    schedulers.set(retention, fsrs({ request_retention: retention, enable_fuzz: false, maximum_interval: 36500 }));
  }
  return schedulers.get(retention);
}

const round4 = (x) => Math.round(x * 10000) / 10000;

export function hasMemory(p) {
  return !!p && p.S > 0;
}

/** Whole days since the word was last reviewed, as Anki counts them. */
export function elapsedDays(p, now) {
  return p?.t ? Math.max(0, Math.floor((now - p.t) / DAY)) : 0;
}

/**
 * The memory state after reviewing a word with the given grade. A word with
 * no memory yet gets its starting state from the grade.
 */
export function review(p, grade, now, retention = DEFAULT_RETENTION) {
  const before = hasMemory(p) ? { stability: p.S, difficulty: p.D } : null;
  const after = scheduler(retention).next_state(before, before ? elapsedDays(p, now) : 0, grade);
  return { S: round4(after.stability), D: round4(after.difficulty) };
}

/** Days until the recall chance of a word with this stability falls to the target. At least 1. */
export function intervalDays(S, retention = DEFAULT_RETENTION) {
  return scheduler(retention).next_interval(S, 0);
}

/** The chance (0 to 1) of recalling the word right now, or null if it has no memory yet. */
export function recallChance(p, now) {
  if (!hasMemory(p)) return null;
  return forgetting_curve(default_w, Math.max(0, now - (p.t || now)) / DAY, p.S);
}

/**
 * The day a moment belongs to, as YYYY-MM-DD. Like Anki, a day starts at
 * 4 a.m., so reading past midnight still counts as the same day.
 */
export function dayKey(now) {
  const d = new Date(now - 4 * 3_600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A memory state for a card scheduled by Anki's older algorithm, which only
 * stores an interval and an ease factor. This is the conversion Anki itself
 * applies when FSRS is switched on for such a card.
 */
export function memoryFromSm2(intervalDaysValue, easeFactor) {
  const w = default_w;
  const S = Math.max(0.1, intervalDaysValue);
  const gain = Math.exp(w[8]) * S ** -w[9] * (Math.exp(0.1 * w[10]) - 1);
  const D = 11 - (Math.max(1.3, easeFactor) - 1) / gain;
  return { S: round4(S), D: round4(Math.min(10, Math.max(1, D))) };
}
