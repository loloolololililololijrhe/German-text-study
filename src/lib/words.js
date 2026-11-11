// Word identity and list assembly. Pure functions, no DOM.

const ARTICLE = '(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)';
const LEADING_ARTICLES = new RegExp(`^${ARTICLE}(?:\\s*/\\s*${ARTICLE})*\\s+(?=\\S)`, 'i');
// Decks often abbreviate the article: "r Hund", "e Frau", "s Kind".
const SHORT_ARTICLE = /^[res]\s+(?=\p{Lu})/u;

/**
 * Reduce a dictionary entry or lemma to the key that identifies the word:
 * "der Hund" -> "Hund", "sich erinnern (an)" -> "erinnern",
 * "gehen, ging, gegangen" -> "gehen", "auf|stehen" -> "aufstehen".
 * Case is kept, because German separates "Essen" (food) from "essen" (to eat).
 */
export function normKey(raw) {
  if (raw == null) return '';
  let s = String(raw).normalize('NFC');
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ').trim();
  s = s.replace(LEADING_ARTICLES, '').replace(SHORT_ARTICLE, '');
  s = s.split(/[,;/]|\s[-–—]\s/)[0];
  s = s.replace(/(?<=\p{L})[|·•](?=\p{L})/gu, '');
  s = s.trim().replace(/^sich\s+(?=\S)/i, '');
  s = s
    .replace(/[^\p{L}\p{N}\- ']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.replace(/^-+|-+$/g, '');
}

/** Parse the built-in list format: one "German = English" per line, # comments. */
export function parseWordList(text, src) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cut = t.indexOf(' = ');
    if (cut === -1) continue;
    const de = t.slice(0, cut).trim();
    const en = t.slice(cut + 3).trim();
    const id = normKey(de);
    if (id && en) out.push({ id, de, en, src, rank: out.length });
  }
  return out;
}

/**
 * Combine the word sources into one list. Priority: custom (imported, edited or
 * added while reading) > default deck > built-in common words. A built-in word
 * is dropped when a higher-priority source already has it.
 *
 * Every entry carries `priority`: true for the learner's own words (a deck, or
 * words added while reading), false for the built-in common words. Texts are
 * written around priority words first.
 */
export function buildWordIndex({ builtin = [], deck = [], custom = {} }) {
  const byId = new Map();
  const add = (e) => {
    if (e.id && !byId.has(e.id)) byId.set(e.id, e);
  };

  // An edited built-in word is stored as a custom word but is still a built-in word.
  const builtinSrc = builtin[0]?.src;
  for (const [id, c] of Object.entries(custom)) {
    const src = c.src || 'custom';
    add({ id, de: c.de, en: c.en, src, rank: c.r ?? 1e6, priority: src !== builtinSrc });
  }
  deck.forEach((d, i) => {
    add({ id: normKey(d.de), de: d.de, en: d.en, src: d.src || 'deck', rank: i, priority: true });
  });

  // A built-in word whose spelling differs from a deck word only by capital
  // letter is usually the same word: decks often write "hund" for "der Hund".
  // It is a different word when the built-in list has both spellings
  // ("essen", "das Essen"), or when the deck does use capitals and the two are
  // different kinds of word (the deck's verb "laden" next to "der Laden").
  const isNoun = (e) => /^\p{Lu}/u.test(e.id) || /^(der|die|das)\s/i.test(e.de);
  const higher = new Map();
  const capitalising = new Set();
  for (const e of byId.values()) {
    const k = e.id.toLowerCase();
    if (!higher.has(k)) higher.set(k, []);
    higher.get(k).push(e);
    if (/^\p{Lu}/u.test(e.id)) capitalising.add(e.src);
  }
  const builtinLower = new Map();
  for (const b of builtin) {
    const k = b.id.toLowerCase();
    builtinLower.set(k, (builtinLower.get(k) || 0) + 1);
  }
  for (const b of builtin) {
    if (byId.has(b.id)) continue;
    const k = b.id.toLowerCase();
    const sameWord =
      builtinLower.get(k) === 1 &&
      (higher.get(k) || []).some((e) => !capitalising.has(e.src) || isNoun(e) === isNoun(b));
    if (!sameWord) add({ ...b, priority: false });
  }

  const list = [...byId.values()];
  const byLower = new Map();
  for (const e of list) {
    const k = e.id.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, []);
    byLower.get(k).push(e);
  }
  const phrases = list.filter((e) => e.id.includes(' '));

  return {
    list,
    byId,
    phrases,
    /** Find the list entry for a lemma as written by the model, or null. */
    find(lemma) {
      const k = normKey(lemma);
      if (!k) return null;
      return byId.get(k) || byLower.get(k.toLowerCase())?.[0] || null;
    },
  };
}

/**
 * Leave out the word lists the learner has turned off. A list is known by its
 * source name ("Common words", a deck's name, ...). Nothing is deleted: the
 * same sources with an empty `off` give the full list again.
 */
export function withoutLists({ builtin = [], deck = [], custom = {} }, off = []) {
  const hidden = new Set(off);
  if (!hidden.size) return { builtin, deck, custom };
  return {
    builtin: builtin.filter((e) => !hidden.has(e.src)),
    deck: deck.filter((e) => !hidden.has(e.src || 'deck')),
    custom: Object.fromEntries(Object.entries(custom).filter(([, c]) => !hidden.has(c.src || 'custom'))),
  };
}

/** The names of all word lists, on or off: the default deck, then the learner's own, then the built-in words. */
export function listNames({ builtin = [], deck = [], custom = {} }) {
  const names = new Set();
  for (const d of deck) names.add(d.src || 'deck');
  const builtinNames = new Set(builtin.map((b) => b.src));
  for (const c of Object.values(custom)) {
    const name = c.src || 'custom';
    if (!builtinNames.has(name)) names.add(name);
  }
  for (const name of builtinNames) names.add(name);
  return [...names];
}
