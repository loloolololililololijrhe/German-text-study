// The synced state and how two copies of it are reconciled. Pure functions.
//
// Each word's progress and each custom word carries `u`, the time it was last
// changed. Merging keeps the newer copy of every entry, so two devices that
// were both used offline lose nothing when they next sync.

import { DEFAULT_HARD_STEP } from './scoring.js';

export const DEFAULT_PREFS = {
  level: 'A2',
  length: 'medium',
  topic: 'fit',
  model: 'claude-opus-5-5',
  autoHard: true,
  hardStep: DEFAULT_HARD_STEP,
  underlineHard: true,
  rate: 0.85,
  u: 0,
};

export function emptyState() {
  return { v: 1, progress: {}, custom: {}, resetAt: 0, clearedAt: 0, prefs: { ...DEFAULT_PREFS } };
}

/** Accept anything parsed from storage or a gist and return a well-formed state. */
export function sanitizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(raw.progress)) {
    for (const [id, p] of Object.entries(raw.progress)) {
      if (!isObj(p)) continue;
      base.progress[id] = {
        s: Number(p.s) || 0,
        n: Number(p.n) || 0,
        l: Number(p.l) || 0,
        t: Number(p.t) || 0,
        u: Number(p.u) || 0,
      };
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
  if (isObj(raw.prefs)) base.prefs = { ...DEFAULT_PREFS, ...raw.prefs, u: Number(raw.prefs.u) || 0 };
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
