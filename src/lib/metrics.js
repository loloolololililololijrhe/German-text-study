// What the app measures about the learner's reading, so the settings can be
// tuned from numbers instead of guesses. Pure functions, no DOM.
//
// Every finished text adds to the counters of its day. A day's counters are
// kept per device, so two devices never overwrite each other: each one only
// ever changes its own record, and merging keeps the newer copy of each.

import { hasMemory } from './srs.js';
import { isDue, statusOf } from './scoring.js';

/** The counters kept for each day, device and kind of text, in stored order. Only ever add to the end. */
export const FIELDS = [
  'texts', // texts finished with "Done reading"
  'skipped', // texts skipped
  'readS', // seconds spent reading the finished texts
  'timed', // texts whose writing was timed
  'waitS', // seconds until the first sentence appeared
  'genS', // seconds until the text was complete
  'words', // running words in the finished texts
  'seenNew', // list words met for the first time
  'tapNew', // ... of which looked up
  'seenHard', // hard words that came back
  'tapHard', // ... of which looked up again
  'seenDue', // words that were due for review
  'tapDue', // ... of which looked up
  'seenOther', // words on the schedule that were not due yet
  'tapOther', // ... of which looked up
  'tapOut', // lookups of words that are in none of the lists
  'started', // new words started
  'cleared', // hard words that went back on the schedule
  'marked', // words marked hard
  'targets', // words the text had to contain
  'targetsUsed', // ... of which it did contain
  'extras', // further due words offered to the writer
  'extrasUsed', // ... of which made it into the text
  'inTok', // tokens sent to Claude
  'outTok', // tokens Claude wrote
];

/** The word counts stored with a day: how many words had each status after its last text. */
export const SNAPSHOT = ['hard', 'learning', 'known', 'new', 'due'];

/** Days of numbers that are kept; older days are dropped. */
export const KEEP_DAYS = 730;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICE_RE = /^[a-z0-9]{1,16}$/;
const KEY_RE = /^[A-Za-z0-9]{1,8}:[a-z]{1,12}$/;

export const emptyStats = () => ({ v: 1, clearedAt: 0, days: {} });

/** All counters at zero, by name. */
export const zeroCounts = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));

const toRow = (counts) => FIELDS.map((f) => Math.max(0, Math.round(Number(counts?.[f]) || 0)));
const fromRow = (row) => Object.fromEntries(FIELDS.map((f, i) => [f, Math.max(0, Number(row?.[i]) || 0)]));

/** A short random name for this device's records. */
export function newDeviceId(rng = Math.random) {
  let id = '';
  while (id.length < 8) id += Math.floor(rng() * 36).toString(36);
  return id;
}

/** The key under which a text's numbers are filed: its level and length, e.g. "A2:long". */
export function textKey(level, length) {
  const key = `${level || 'A2'}:${length || 'medium'}`;
  return KEY_RE.test(key) ? key : 'A2:medium';
}

/** What kind of word this was when the text began: 'new', 'hard', 'due' or 'other'. */
export function kindBefore(p, now) {
  if (p && p.s < 0) return 'hard';
  if (!hasMemory(p)) return 'new';
  return isDue(p, now) ? 'due' : 'other';
}

/**
 * Count what happened to the list words of one finished text.
 * `words` has one item per list word that appeared: its progress before the
 * text (`before`), whether it was looked up (`tapped`), and its progress
 * afterwards (`after`).
 */
export function tallyWords(words, now) {
  const c = { seenNew: 0, tapNew: 0, seenHard: 0, tapHard: 0, seenDue: 0, tapDue: 0, seenOther: 0, tapOther: 0 };
  let cleared = 0;
  const name = { new: 'New', hard: 'Hard', due: 'Due', other: 'Other' };
  for (const w of words) {
    const kind = name[kindBefore(w.before, now)];
    c[`seen${kind}`]++;
    if (w.tapped) c[`tap${kind}`]++;
    if (kind === 'Hard' && w.after && w.after.s >= 0) cleared++;
  }
  return { ...c, cleared };
}

/** How many of the listed words have each status right now. */
export function snapshotOf(entries, progress, now) {
  const out = { hard: 0, learning: 0, known: 0, new: 0, due: 0 };
  for (const e of entries) {
    const p = progress[e.id];
    out[statusOf(p)]++;
    if (e.priority && isDue(p, now)) out.due++;
  }
  return out;
}

// ---- storing ---------------------------------------------------------------

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = { u: Number(raw.u) || 0, t: {} };
  if (raw.t && typeof raw.t === 'object') {
    for (const [key, row] of Object.entries(raw.t)) {
      if (KEY_RE.test(key) && Array.isArray(row)) rec.t[key] = toRow(fromRow(row));
    }
  }
  if (Array.isArray(raw.w)) rec.w = SNAPSHOT.map((_, i) => Math.max(0, Math.round(Number(raw.w[i]) || 0)));
  return Object.keys(rec.t).length || rec.w ? rec : null;
}

/** Drop what was cleared and the days beyond the limit. */
function tidy(stats) {
  const days = {};
  const keep = Object.keys(stats.days).sort().slice(-KEEP_DAYS);
  for (const day of keep) {
    const devices = {};
    for (const [device, rec] of Object.entries(stats.days[day])) {
      if (rec.u > stats.clearedAt) devices[device] = rec;
    }
    if (Object.keys(devices).length) days[day] = devices;
  }
  return { v: 1, clearedAt: stats.clearedAt, days };
}

/** Accept anything parsed from storage or a gist and return well-formed stats. */
export function sanitizeStats(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== 'object') return out;
  out.clearedAt = Number(raw.clearedAt) || 0;
  if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
    for (const [day, devices] of Object.entries(raw.days)) {
      if (!DAY_RE.test(day) || !devices || typeof devices !== 'object') continue;
      for (const [device, rec] of Object.entries(devices)) {
        const clean = DEVICE_RE.test(device) && cleanRecord(rec);
        if (clean) (out.days[day] ||= {})[device] = clean;
      }
    }
  }
  return tidy(out);
}

/** Two devices' numbers as one: for each day and device, the copy changed last. */
export function mergeStats(a, b) {
  const out = { v: 1, clearedAt: Math.max(a.clearedAt || 0, b.clearedAt || 0), days: {} };
  for (const day of new Set([...Object.keys(a.days), ...Object.keys(b.days)])) {
    const [x, y] = [a.days[day] || {}, b.days[day] || {}];
    for (const device of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const [p, q] = [x[device], y[device]];
      (out.days[day] ||= {})[device] = !p ? q : !q ? p : q.u > p.u ? q : p;
    }
  }
  return tidy(out);
}

/**
 * The stats after one more text. `counts` holds the text's numbers by field
 * name (missing fields count as zero), `snapshot` the word counts afterwards.
 */
export function addRecord(stats, { day, device, key, counts, snapshot, now }) {
  const before = stats.days[day]?.[device] || { u: 0, t: {} };
  const row = toRow(fromRow(before.t[key]));
  const add = toRow(counts);
  const rec = { u: now, t: { ...before.t, [key]: row.map((n, i) => n + add[i]) } };
  if (snapshot) rec.w = SNAPSHOT.map((s) => Math.max(0, Math.round(Number(snapshot[s]) || 0)));
  else if (before.w) rec.w = before.w;
  return tidy({ ...stats, days: { ...stats.days, [day]: { ...stats.days[day], [device]: rec } } });
}

// ---- reading the numbers ---------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** The day `n` days after (or before, if negative) a day given as YYYY-MM-DD. */
export function dayAdd(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** The `n` days ending with `last`, oldest first. */
export function daysEnding(last, n) {
  return Array.from({ length: n }, (_, i) => dayAdd(last, i - n + 1));
}

/** How many days from `from` to `to`, counting both. */
export function daySpan(from, to) {
  const at = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}

/** The first day that has numbers, or '' when there are none. */
export function firstDay(stats) {
  return Object.keys(stats.days).sort()[0] || '';
}

/**
 * One day's numbers across devices and kinds of text.
 * Returns { counts, byKey, snapshot } or null for a day without numbers.
 */
export function dayOf(stats, day) {
  const devices = stats.days[day];
  if (!devices) return null;
  const counts = zeroCounts();
  const byKey = {};
  let latest = null;
  for (const rec of Object.values(devices)) {
    for (const [key, row] of Object.entries(rec.t)) {
      const c = fromRow(row);
      const into = (byKey[key] ||= zeroCounts());
      for (const f of FIELDS) {
        counts[f] += c[f];
        into[f] += c[f];
      }
    }
    if (rec.w && (!latest || rec.u > latest.u)) latest = rec;
  }
  const snapshot = latest ? Object.fromEntries(SNAPSHOT.map((s, i) => [s, latest.w[i]])) : null;
  return { counts, byKey, snapshot };
}

/** The numbers of a run of days added up: { counts, byKey, active } where `active` is the days with a finished text. */
export function totalsOf(stats, days) {
  const counts = zeroCounts();
  const byKey = {};
  let active = 0;
  for (const day of days) {
    const d = dayOf(stats, day);
    if (!d) continue;
    if (d.counts.texts) active++;
    for (const f of FIELDS) counts[f] += d.counts[f];
    for (const [key, c] of Object.entries(d.byKey)) {
      const into = (byKey[key] ||= zeroCounts());
      for (const f of FIELDS) into[f] += c[f];
    }
  }
  return { counts, byKey, active };
}

/**
 * The days as a series for charts and tables: for each day its counts (or
 * null) and the word counts, carried over from the last day that had them.
 * `carry` is the snapshot to start from, for days before the first of `days`.
 */
export function seriesOf(stats, days, carry = null) {
  let snapshot = carry;
  return days.map((day) => {
    const d = dayOf(stats, day);
    if (d?.snapshot) snapshot = d.snapshot;
    return { day, counts: d ? d.counts : null, snapshot };
  });
}

/** The word counts on the last day before `day` that has them, or null. */
export function snapshotBefore(stats, day) {
  const earlier = Object.keys(stats.days)
    .filter((d) => d < day)
    .sort()
    .reverse();
  for (const d of earlier) {
    const s = dayOf(stats, d).snapshot;
    if (s) return s;
  }
  return null;
}

/** Join every `size` items of a series into one, for long ranges: counts add up, word counts are the last known. */
export function bucket(series, size) {
  if (size <= 1) return series;
  const out = [];
  for (let i = 0; i < series.length; i += size) {
    const part = series.slice(i, i + size);
    let counts = null;
    for (const p of part) {
      if (!p.counts) continue;
      counts ||= zeroCounts();
      for (const f of FIELDS) counts[f] += p.counts[f];
    }
    out.push({ day: part[0].day, to: part.at(-1).day, counts, snapshot: part.at(-1).snapshot });
  }
  return out;
}

/** A share as { n, of, rate }, with rate null when there is nothing to divide by. */
export const share = (n, of) => ({ n, of, rate: of > 0 ? n / of : null });

/** How often each kind of word was looked up. */
export function lookupRates(c) {
  return {
    new: share(c.tapNew, c.seenNew),
    hard: share(c.tapHard, c.seenHard),
    due: share(c.tapDue, c.seenDue),
    other: share(c.tapOther, c.seenOther),
  };
}

/** All lookups in the counted texts, in and outside the lists. */
export const lookupsOf = (c) => c.tapNew + c.tapHard + c.tapDue + c.tapOther + c.tapOut;

/** All list words reviewed in the counted texts. */
export const reviewedOf = (c) => c.seenNew + c.seenHard + c.seenDue + c.seenOther;

/**
 * Above this share of repeated lookups, hard words gain clean reads to do
 * faster than they lose them. Null when a single clean read always clears a
 * hard word, so there is no such point.
 */
export function stuckAbove(step, maxHard) {
  return maxHard > step ? 1 / (1 + step) : null;
}

/** Every day's numbers as CSV text, one row per day, oldest first. */
export function toCsv(stats) {
  const rows = [['day', ...FIELDS, ...SNAPSHOT.map((s) => `words_${s}`)].join(',')];
  for (const day of Object.keys(stats.days).sort()) {
    const d = dayOf(stats, day);
    rows.push([day, ...FIELDS.map((f) => d.counts[f]), ...SNAPSHOT.map((s) => d.snapshot?.[s] ?? '')].join(','));
  }
  return rows.join('\n') + '\n';
}

// ---- timing ----------------------------------------------------------------

/**
 * Measures time spent reading. It counts only while running, and stops
 * counting once nothing has happened for `idle` milliseconds, so a text left
 * open on the table does not count as an hour of reading.
 */
export function createStopwatch({ idle = 180_000, clock = Date.now, elapsed = 0 } = {}) {
  let total = elapsed;
  let mark = null; // start of the stretch not yet added to the total
  let last = 0; // the last sign of life
  const open = (t) => (mark == null ? 0 : Math.max(0, Math.min(t, last + idle) - mark));
  return {
    /** Start or resume. */
    start() {
      const t = clock();
      total += open(t);
      mark = t;
      last = t;
    },
    /** The learner did something: scrolled, tapped, pressed a key. */
    touch() {
      if (mark == null) return;
      const t = clock();
      total += open(t);
      mark = t;
      last = t;
    },
    pause() {
      total += open(clock());
      mark = null;
    },
    running: () => mark != null,
    ms: () => total + open(clock()),
  };
}
