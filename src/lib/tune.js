// Tuning the study settings: which settings can be tuned, sets of them that
// are saved to go back to, and the request that asks Claude to adjust them
// from the learner's numbers. Pure functions, no DOM.

import { TEXT_GOAL_CHOICES, textGoalOf } from './goal.js';
import {
  FIELDS,
  SNAPSHOT,
  dayOf,
  daySpan,
  daysEnding,
  firstDay,
  lookupRates,
  lookupsOf,
  reviewedOf,
  stuckAbove,
  totalsOf,
} from './metrics.js';
import { LENGTHS, LEVELS } from './prompt.js';
import { EARLY_MAX_CHOICES, MAX_HARD_CHOICES, earlyMaxOf, hardStepOf, maxHardOf } from './scoring.js';
import { NEW_PER_DAY_CHOICES, RETENTION_CHOICES, newPerDayOf, retentionOf } from './srs.js';

const reads = (n) => `${n} clean ${n === 1 ? 'read' : 'reads'}`;

/**
 * The settings that shape how the learner studies. A saved set holds exactly
 * these, and these are what Claude may adjust. `show` writes a value for people.
 */
export const TUNABLE = [
  { key: 'level', label: 'Level of the texts', choices: Object.keys(LEVELS), show: (v) => v },
  { key: 'length', label: 'Length of the texts', choices: Object.keys(LENGTHS), show: (v) => LENGTHS[v]?.label || v },
  { key: 'newPerDay', label: 'New words a day', choices: NEW_PER_DAY_CHOICES, show: (v) => (v ? String(v) : 'none') },
  {
    key: 'retention',
    label: 'Chance of knowing a word at which it comes back',
    choices: RETENTION_CHOICES,
    show: (v) => `${Math.round(v * 100)}%`,
  },
  { key: 'hardStep', label: 'A hard word is back on the schedule after', choices: MAX_HARD_CHOICES, show: reads },
  { key: 'maxHard', label: 'The hardest a word can get', choices: MAX_HARD_CHOICES, show: reads },
  {
    key: 'earlyMax',
    label: 'Early words when only hard words are left',
    choices: EARLY_MAX_CHOICES,
    show: (v) => (v < 0 ? 'no limit' : v === 0 ? 'none' : String(v)),
  },
  { key: 'autoHard', label: 'Mark tapped words as hard', choices: [true, false], show: (v) => (v ? 'on' : 'off') },
  {
    key: 'textsPerDay',
    label: 'Daily goal',
    choices: TEXT_GOAL_CHOICES,
    show: (v) => (v ? `${v} ${v === 1 ? 'text' : 'texts'} a day` : 'no goal'),
  },
];

const spec = (key) => TUNABLE.find((t) => t.key === key);

/** A value as people read it, e.g. 0.88 as "88%". */
export function showValue(key, value) {
  return spec(key)?.show(value) ?? String(value);
}

/** The tunable settings as they stand in the learner's preferences. */
export function settingsOf(prefs) {
  const early = earlyMaxOf(prefs);
  return {
    level: LEVELS[prefs?.level] ? prefs.level : 'A2',
    length: LENGTHS[prefs?.length] ? prefs.length : 'medium',
    newPerDay: newPerDayOf(prefs),
    retention: retentionOf(prefs),
    hardStep: hardStepOf(prefs),
    maxHard: maxHardOf(prefs),
    earlyMax: Number.isFinite(early) ? early : -1,
    autoHard: prefs?.autoHard !== false,
    textsPerDay: textGoalOf(prefs),
  };
}

/** One value brought to an allowed choice: as it is, the nearest number, or null if it is unusable. */
function toChoice({ key, choices }, raw) {
  if (typeof choices[0] === 'boolean') {
    if (raw === true || raw === 'true') return true;
    return raw === false || raw === 'false' ? false : null;
  }
  if (typeof choices[0] === 'string') return choices.includes(raw) ? raw : null;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  // "No limit" is a choice of its own, not a small number.
  if (key === 'earlyMax' && n < 0) return -1;
  const numbers = choices.filter((c) => c >= 0);
  return numbers.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), numbers[0]);
}

/**
 * A full, valid set of settings from anything: each value is taken if it is
 * usable (numbers go to the nearest allowed choice) and comes from `base`
 * otherwise. The step of a hard word never exceeds the limit on hardness.
 */
export function cleanSettings(raw, base) {
  const out = {};
  for (const t of TUNABLE) {
    const v = raw && typeof raw === 'object' ? toChoice(t, raw[t.key]) : null;
    out[t.key] = v == null ? base[t.key] : v;
  }
  out.hardStep = Math.min(out.hardStep, out.maxHard);
  return out;
}

/** The keys in which two sets of settings differ, in the usual order. */
export function changedKeys(a, b) {
  return TUNABLE.map((t) => t.key).filter((k) => a[k] !== b[k]);
}

export const sameSettings = (a, b) => changedKeys(a, b).length === 0;

/** A set of settings in one line, e.g. "A2 · Long · 15 new a day · 88% · …". */
export function describeSettings(s) {
  return [
    s.level,
    showValue('length', s.length),
    s.newPerDay ? `${s.newPerDay} new a day` : 'no new words',
    showValue('retention', s.retention),
    `hard words ${s.hardStep}/${s.maxHard}`,
    s.earlyMax < 0 ? 'early words unlimited' : `${s.earlyMax} early`,
    s.autoHard ? 'taps mark hard' : 'taps only look up',
    showValue('textsPerDay', s.textsPerDay),
  ].join(' · ');
}

// ---- saved sets ------------------------------------------------------------
//
// { id, name, at, by, settings, why, prev }
//   by    'ai' (what Claude suggested), 'before' (what was in use before
//         that), or 'you' (saved by hand)
//   why   Claude's summary, for an 'ai' set
//   prev  for an 'ai' set, the id of the set that was in use before it

/** How many saved sets are kept. */
export const PRESETS_KEPT = 12;

const BASE = settingsOf({});

function cleanPreset(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const by = ['ai', 'before', 'you'].includes(raw.by) ? raw.by : 'you';
  const text = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
  return {
    id: raw.id.slice(0, 40),
    name: text(raw.name, 80) || 'Saved settings',
    at: Number(raw.at) || 0,
    by,
    settings: cleanSettings(raw.settings, BASE),
    why: text(raw.why, 1200),
    prev: by === 'ai' ? text(raw.prev, 40) : '',
  };
}

/** Accept anything parsed from storage or a gist and return a well-formed list of saved sets, newest first. */
export function sanitizePresets(raw) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    const clean = cleanPreset(p);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.push(clean);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, PRESETS_KEPT);
}

const stamp = (now) =>
  new Date(now).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A new saved set. `label` is what it is: "AI tuning", "Before AI tuning", "My settings". */
export function makePreset({ label, by, settings, now, why = '', prev = '', rng = Math.random }) {
  const id = `${now.toString(36)}-${Math.floor(rng() * 36 ** 5).toString(36)}`;
  return cleanPreset({ id, name: `${label} · ${stamp(now)}`, at: now, by, settings, why, prev });
}

/** The list with a set added. */
export function withPreset(presets, preset) {
  return sanitizePresets([preset, ...presets]);
}

/** The list without a set. */
export function withoutPreset(presets, id) {
  return presets.filter((p) => p.id !== id);
}

/**
 * The 'ai' set that is in use right now and the set to go back to, if both
 * are still there: { ai, before }, or null.
 */
export function tuningInUse(presets, current) {
  const ai = presets.find((p) => p.by === 'ai' && sameSettings(p.settings, current));
  const before = ai && presets.find((p) => p.id === ai.prev);
  return ai && before ? { ai, before } : null;
}

// ---- asking Claude ---------------------------------------------------------

export const TUNE_SYSTEM = `You tune the study settings of a German reading app for one learner. The learner reads short texts that are written around words from their own vocabulary deck; the app records what happens in every text and sends you the numbers. Decide which settings to change, if any, so that the learner learns more for the time they spend, and explain each change in plain English.

How the app works
- Every word has a memory strength, as in Anki (FSRS). A word that appears in a finished text without being tapped counts as remembered and is scheduled further into the future. It is "due" when the estimated chance of still knowing it has fallen to the retention target.
- Tapping a word shows its translation. With autoHard on, a tapped word is marked hard at once (Anki's "Again"). With it off, a tap only counts as hesitation (Anki's "Hard") and the learner marks words hard by hand.
- A hard word leaves the schedule and has to be read without tapping hardStep times, in later texts, before it returns. Every further lookup of a hard word adds hardStep more clean reads, up to maxHard. So if hard words are looked up again more often than about 1 time in (1 + hardStep), they pile up faster than they clear. When hardStep equals maxHard, one clean read always clears a word.
- A text must contain a fixed number of the learner's words: 10 (short), 18 (medium) or 30 (long). About a sixth of the places are kept for new words, up to newPerDay a day. Hard words take up to 40%. Due words take the rest. Places that nothing else needs go to more hard words, apart from earlyMax places for words that are not due yet. More due words are offered to the writer as optional.
- level sets the grammar and the ordinary vocabulary around those words, from A1 to B2. length sets how long the text is as well as how many words it must contain.
- textsPerDay is a goal shown to the learner. It changes nothing else.

How to read the numbers
- The "seen" and "looked up" figures count the learner's words that appeared in finished texts, by what the word was when the text began: new, hard, due, or on the schedule but not due yet.
- The share of hard words looked up again, against the point above which hard words get stuck, matters most. Above that point, lower hardStep and maxHard, or slow the inflow with fewer new words a day.
- 1 minus the share of due words looked up is the retention the learner really has. Well below the target means the words come back too late: raise the target one step. Well above it, with a large backlog of due words, means it can be lowered one step.
- The word counts by status over the days show whether the pile of hard words and the backlog of due words grow or shrink. If they grow while new words are still being started, start fewer new words a day. If they are small and shrinking and lookups are few, more new words a day are affordable.
- Lookups per text and per 100 running words show whether the texts are too hard or too easy. Minutes per text and words reviewed per minute, by kind of text, show which length uses the learner's time best.
- The daily goal belongs near what the learner manages on the days they read, a little above it at most.

Rules
- Change as little as needed: usually one to three settings, each by one step. Leave a setting alone unless a number argues for changing it.
- With little data (fewer than about ten finished texts, or fewer than three days of reading) say so in "caution" and make one cautious change at most, or none.
- Use only the allowed values. hardStep must not be larger than maxHard.
- Lowering maxHard also eases words that are already harder, and going back does not undo that. Say so if you lower it.
- Raise level only if lookups are low and a level test result supports it.
- In "settings" return every setting, changed or not, as text exactly as the allowed values are written.
- In "reasons" give one entry for each setting you changed and none for the others: one or two short sentences for a learner who is not technical, naming the number that led you to it. No jargon and no field names.
- "summary": two or three sentences on what the numbers show overall. "caution": what the numbers cannot tell yet, or an empty string.`;

const asText = (choices) => choices.map(String);
const one = (type, extra = {}) => ({ type, ...extra });

/** What Claude must return. Values are text, so that every setting can be held to its allowed choices. */
export const TUNE_SCHEMA = {
  type: 'object',
  properties: {
    summary: one('string'),
    settings: {
      type: 'object',
      properties: Object.fromEntries(
        TUNABLE.map((t) => [
          t.key,
          typeof t.choices[0] === 'boolean' ? one('boolean') : one('string', { enum: asText(t.choices) }),
        ]),
      ),
      required: TUNABLE.map((t) => t.key),
      additionalProperties: false,
    },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { setting: one('string', { enum: TUNABLE.map((t) => t.key) }), reason: one('string') },
        required: ['setting', 'reason'],
        additionalProperties: false,
      },
    },
    caution: one('string'),
  },
  required: ['summary', 'settings', 'reasons', 'caution'],
  additionalProperties: false,
};

const pct = (x) => (x.rate == null ? 'no words yet' : `${Math.round(x.rate * 100)}% (${x.n} of ${x.of})`);
const per = (n, of) => (of > 0 ? Math.round((n / of) * 10) / 10 : 0);

/** The numbers of a run of days, with the figures worked out from them. */
function period(stats, days) {
  const { counts: c, active } = totalsOf(stats, days);
  const r = lookupRates(c);
  const written = c.texts + c.skipped;
  return {
    days: days.length,
    days_with_reading: active,
    texts_finished: c.texts,
    texts_skipped: c.skipped,
    minutes_of_reading: Math.round(c.readS / 60),
    minutes_per_text: per(c.readS / 60, c.texts),
    texts_per_reading_day: per(c.texts, active),
    words_reviewed: reviewedOf(c),
    words_reviewed_per_text: per(reviewedOf(c), c.texts),
    words_reviewed_per_minute: per(reviewedOf(c), c.readS / 60),
    lookups: lookupsOf(c),
    lookups_per_text: per(lookupsOf(c), c.texts),
    lookups_per_100_running_words: per(lookupsOf(c) * 100, c.words),
    new_words_looked_up_on_first_sight: pct(r.new),
    hard_words_looked_up_again: pct(r.hard),
    due_words_looked_up: pct(r.due),
    words_not_due_yet_looked_up: pct(r.other),
    lookups_of_words_outside_the_lists: c.tapOut,
    new_words_started: c.started,
    words_marked_hard: c.marked,
    hard_words_cleared: c.cleared,
    required_words_used_by_the_text: pct({
      n: c.targetsUsed,
      of: c.targets,
      rate: c.targets ? c.targetsUsed / c.targets : null,
    }),
    optional_due_words_used_by_the_text: pct({
      n: c.extrasUsed,
      of: c.extras,
      rate: c.extras ? c.extrasUsed / c.extras : null,
    }),
    seconds_until_first_sentence: per(c.waitS, c.timed),
    tokens_per_text: per(c.inTok + c.outTok, written),
  };
}

/** Days sent row by row; older ones are covered by the totals. */
const DAYS_SENT = 60;

/**
 * The message for Claude: the settings as they are, every number the app has,
 * and the day-by-day table.
 *
 * @param {object} o
 * @param {object} o.stats      the stored numbers (see metrics.js)
 * @param {object} o.prefs      the learner's preferences
 * @param {string} o.today      today as YYYY-MM-DD
 * @param {object} o.words      how many words have each status right now
 * @param {object[]} [o.tests]  results of the level test, newest first
 * @param {object[]} [o.leeches] the words looked up most: { de, en, lookups, seen }
 */
export function buildTuneRequest({ stats, prefs, today, words, tests = [], leeches = [] }) {
  const now = settingsOf(prefs);
  const first = firstDay(stats);
  const all = first ? daysEnding(today, Math.max(1, daySpan(first, today))) : [today];
  const limit = stuckAbove(now.hardStep, now.maxHard);

  const settings = TUNABLE.map(
    (t) =>
      `- ${t.key} = ${now[t.key]}   (${t.label}; allowed: ${t.choices.map(String).join(', ')}${t.key === 'earlyMax' ? '; -1 means no limit' : ''}${t.key === 'textsPerDay' ? '; 0 means no goal' : ''})`,
  );

  const byKind = Object.entries(totalsOf(stats, all).byKey)
    .filter(([, c]) => c.texts)
    .map(([kind, c]) => ({
      kind,
      texts: c.texts,
      minutes_per_text: per(c.readS / 60, c.texts),
      words_reviewed_per_text: per(reviewedOf(c), c.texts),
      lookups_per_text: per(lookupsOf(c), c.texts),
      words_reviewed_per_minute: per(reviewedOf(c), c.readS / 60),
    }));

  const withNumbers = all.filter((day) => stats.days[day]).slice(-DAYS_SENT);
  const table = [
    ['day', ...FIELDS, ...SNAPSHOT.map((s) => `words_${s}`)].join(','),
    ...withNumbers.map((day) => {
      const d = dayOf(stats, day);
      return [day, ...FIELDS.map((f) => d.counts[f]), ...SNAPSHOT.map((s) => d.snapshot?.[s] ?? '')].join(',');
    }),
  ];

  const report = {
    today,
    first_day_with_numbers: first || 'none',
    words_right_now: words,
    hard_words_get_stuck_above:
      limit == null
        ? 'never, with the current hard-word settings one clean read always clears a hard word'
        : `${Math.round(limit * 100)}% looked up again, with the current hard-word settings`,
    retention_target: `${Math.round(now.retention * 100)}% of due words still known`,
    last_7_days: period(stats, daysEnding(today, 7)),
    last_30_days: period(stats, daysEnding(today, 30)),
    all_time: period(stats, all),
    by_kind_of_text_all_time: byKind,
    level_test_results: tests.slice(0, 5).map((t) => ({
      day: new Date(t.at).toISOString().slice(0, 10),
      test: t.mode === 'find' ? 'find my level' : `single level ${t.level}`,
      result: t.mode === 'find' ? t.level || 'below A1' : t.pass ? 'passed' : 'not passed',
      scores: t.scores.map(([level, correct, total]) => `${level} ${correct}/${total}`).join(', '),
    })),
    words_looked_up_most: leeches.slice(0, 10).map((w) => `${w.de} (${w.en}): ${w.lookups} lookups in ${w.seen} texts`),
  };

  return [
    'SETTINGS NOW',
    ...settings,
    '',
    'NUMBERS',
    JSON.stringify(report, null, 1),
    '',
    `DAY BY DAY (the ${withNumbers.length} most recent days with numbers; seconds end in S, token counts in Tok)`,
    ...table,
  ].join('\n');
}

/**
 * Claude's answer as the app uses it: { summary, caution, settings, changes },
 * where `settings` is a full valid set and `changes` lists what differs from
 * `current` as { key, from, to, reason }. Throws if the answer is unusable.
 */
export function readAdvice(raw, current) {
  if (!raw || typeof raw !== 'object' || !raw.settings || typeof raw.settings !== 'object') {
    throw new Error('Claude’s answer could not be read. Please try again.');
  }
  const settings = cleanSettings(raw.settings, current);
  const reasons = new Map();
  for (const r of Array.isArray(raw.reasons) ? raw.reasons : []) {
    if (r && typeof r.setting === 'string' && typeof r.reason === 'string') reasons.set(r.setting, r.reason.trim());
  }
  const text = (x) => (typeof x === 'string' ? x.trim() : '');
  return {
    summary: text(raw.summary),
    caution: text(raw.caution),
    settings,
    changes: changedKeys(current, settings).map((key) => ({
      key,
      from: current[key],
      to: settings[key],
      reason: reasons.get(key) || '',
    })),
  };
}
