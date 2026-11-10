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
 */
export function buildWordIndex({ builtin = [], deck = [], custom = {} }) {
  const byId = new Map();
  const add = (e) => {
    if (e.id && !byId.has(e.id)) byId.set(e.id, e);
  };

  for (const [id, c] of Object.entries(custom)) {
    add({ id, de: c.de, en: c.en, src: c.src || 'custom', rank: c.r ?? 1e6 });
  }
  deck.forEach((d, i) => {
    add({ id: normKey(d.de), de: d.de, en: d.en, src: d.src || 'deck', rank: i });
  });

  // "hund" in a lower-cased deck is the same word as built-in "der Hund", but
  // "essen" must not swallow "das Essen" when the built-in list has both.
  const higherLower = new Set([...byId.keys()].map((k) => k.toLowerCase()));
  const builtinLower = new Map();
  for (const b of builtin) {
    const k = b.id.toLowerCase();
    builtinLower.set(k, (builtinLower.get(k) || 0) + 1);
  }
  for (const b of builtin) {
    if (byId.has(b.id)) continue;
    const k = b.id.toLowerCase();
    if (higherLower.has(k) && builtinLower.get(k) === 1) continue;
    add(b);
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
