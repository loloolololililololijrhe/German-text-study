// The synced state and how two copies of it are reconciled. Pure functions.
//
// Each word's progress and each custom word carries `u`, the time it was last
// changed. Merging keeps the newer copy of every entry, so two devices that
// were both used offline lose nothing when they next sync.

import { DEFAULT_HARD_STEP, DEFAULT_MAX_HARD, upgradeProgress } from './scoring.js';
import { DEFAULT_NEW_PER_DAY, DEFAULT_RETENTION } from './srs.js';

export const DEFAULT_PREFS = {
  level: 'A2',
  length: 'medium',
  topic: 'fit',
  model: 'claude-opus-5-5',
  autoHard: true,
  hardStep: DEFAULT_HARD_STEP,
  maxHard: DEFAULT_MAX_HARD,
  underlineHard: true,
  retention: DEFAULT_RETENTION,
  newPerDay: DEFAULT_NEW_PER_DAY,
  // Names of the word lists the learner has turned off.
  listsOff: [],
  // Set after the first import from an Anki file: see sanitizeState.
  anki: null,
  rate: 0.85,
  u: 0,
};

export function emptyState() {
  return {
    v: 1,
    progress: {},
    custom: {},
    resetAt: 0,
    clearedAt: 0,
    // How many new words were started on the most recent day of reading.
    intro: { day: '', n: 0 },
    prefs: { ...DEFAULT_PREFS },
  };
}

/** Accept anything parsed from storage or a gist and return a well-formed state. */
export function sanitizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(raw.progress)) {
    for (const [id, p] of Object.entries(raw.progress)) {
      if (!isObj(p)) continue;
      const clean = {
        s: Number(p.s) || 0,
        n: Number(p.n) || 0,
        l: Number(p.l) || 0,
        t: Number(p.t) || 0,
        u: Number(p.u) || 0,
      };
      if (Number(p.S) > 0) {
        clean.S = Number(p.S);
        clean.D = Math.min(10, Math.max(1, Number(p.D) || 5));
        clean.due = Number(p.due) || 0;
      }
      base.progress[id] = upgradeProgress(clean);
    }
  }
  if (isObj(raw.custom)) {
    for (const [id, c] of Object.entries(raw.custom)) {
      if (!isObj(c) || typeof c.de !== 'string' || typeof c.en !== 'string') continue;
      base.custom[id] = {
        de: c.de,
        en: c.en,
        src: typeof c.src === 'string' ? c.src : 'custom',
        r: Number.isFinite(c.r) ? c.r : 1e6,
        a: Number(c.a) || 0,
        u: Number(c.u) || 0,
      };
    }
  }
  base.resetAt = Number(raw.resetAt) || 0;
  base.clearedAt = Number(raw.clearedAt) || 0;
  if (isObj(raw.intro) && typeof raw.intro.day === 'string') {
    base.intro = { day: raw.intro.day, n: Math.max(0, Number(raw.intro.n) || 0) };
  }
  if (isObj(raw.prefs)) {
    base.prefs = { ...DEFAULT_PREFS, ...raw.prefs, u: Number(raw.prefs.u) || 0 };
    const off = raw.prefs.listsOff;
    base.prefs.listsOff = Array.isArray(off) ? off.filter((x) => typeof x === 'string') : [];
    // The deck and fields last used to read an Anki file.
    const a = raw.prefs.anki;
    const usable =
      isObj(a) && typeof a.type === 'string' && typeof a.de === 'string' && Array.isArray(a.en) && a.en.length > 0;
    base.prefs.anki = usable
      ? {
          type: a.type,
          deck: typeof a.deck === 'string' ? a.deck : '',
          de: a.de,
          en: a.en.filter((x) => typeof x === 'string'),
          name: typeof a.name === 'string' && a.name ? a.name : 'Imported deck',
          at: Number(a.at) || 0,
        }
      : null;
  }
  return base;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.u || 0) > (a.u || 0) ? b : a;
}

export function mergeStates(a, b) {
  const out = emptyState();
  out.resetAt = Math.max(a.resetAt || 0, b.resetAt || 0);
  out.clearedAt = Math.max(a.clearedAt || 0, b.clearedAt || 0);

  for (const id of new Set([...Object.keys(a.progress), ...Object.keys(b.progress)])) {
    const p = newer(a.progress[id], b.progress[id]);
    if ((p.u || 0) > out.resetAt) out.progress[id] = p;
  }
  for (const id of new Set([...Object.keys(a.custom), ...Object.keys(b.custom)])) {
    const c = newer(a.custom[id], b.custom[id]);
    if ((c.a || 0) > out.clearedAt) out.custom[id] = c;
  }
  out.prefs = { ...newer(a.prefs, b.prefs) };
  // The later day counts; on the same day both devices started new words, so
  // the larger count is the safer one (it can only hold new words back).
  const [ia, ib] = [a.intro || out.intro, b.intro || out.intro];
  out.intro = ia.day === ib.day ? { day: ia.day, n: Math.max(ia.n, ib.n) } : ia.day > ib.day ? { ...ia } : { ...ib };
  return out;
}

/** Deterministic JSON, so two states can be compared by value. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---- past texts ------------------------------------------------------------
//
// Finished texts are kept so they can be read again. They sync as a file of
// their own, so that ordinary progress syncs stay small.

/** How many past texts are kept. */
export const HISTORY_LIMIT = 30;

export function emptyHistory() {
  return { clearedAt: 0, texts: [] };
}

/** A text as it is stored: words as [spelling, dictionary form, meaning] to save space. */
export function packText({ id, at, title, level, hard, sentences }) {
  return {
    id,
    at,
    title: title || '',
    level: level || '',
    hard: hard || 0,
    sentences: sentences.map((s) => ({ de: s.de, en: s.en, br: !!s.br, w: s.words.map((x) => [x.w, x.l, x.g]) })),
  };
}

/** The sentences of a stored text, in the form the reader displays. */
export function unpackSentences(entry) {
  return entry.sentences.map((s) => ({
    de: s.de,
    en: s.en,
    br: s.br,
    words: s.w.map(([w, l, g]) => ({ w, l, g })),
  }));
}

/** Accept anything parsed from storage or a gist and return a well-formed history. */
export function sanitizeHistory(raw) {
  const out = emptyHistory();
  if (!raw || typeof raw !== 'object') return out;
  out.clearedAt = Number(raw.clearedAt) || 0;
  const text = (x) => (typeof x === 'string' ? x : '');
  for (const t of Array.isArray(raw.texts) ? raw.texts : []) {
    if (!t || typeof t.id !== 'string' || !Array.isArray(t.sentences)) continue;
    const sentences = t.sentences
      .filter((s) => s && typeof s.de === 'string' && Array.isArray(s.w))
      .map((s) => ({
        de: s.de,
        en: text(s.en),
        br: !!s.br,
        w: s.w.filter((x) => Array.isArray(x) && typeof x[0] === 'string').map((x) => [x[0], text(x[1]), text(x[2])]),
      }));
    if (!sentences.length) continue;
    out.texts.push({
      id: t.id,
      at: Number(t.at) || 0,
      title: text(t.title),
      level: text(t.level),
      hard: Number(t.hard) || 0,
      sentences,
    });
  }
  return mergeHistories(out, emptyHistory());
}

/** Both devices' texts, newest first, without the ones cleared, up to the limit. */
export function mergeHistories(a, b) {
  const clearedAt = Math.max(a.clearedAt || 0, b.clearedAt || 0);
  const byId = new Map();
  for (const t of [...a.texts, ...b.texts]) {
    if (t.at > clearedAt && !byId.has(t.id)) byId.set(t.id, t);
  }
  const texts = [...byId.values()].sort((x, y) => y.at - x.at || (x.id < y.id ? -1 : 1)).slice(0, HISTORY_LIMIT);
  return { clearedAt, texts };
}
