// Reading Anki decks: .apkg packages and "Notes in Plain Text" exports.
// No DOM. The SQLite engine (sql.js) is passed in so this also runs under Node.

import { unzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { normKey } from './words.js';
import { memoryFromSm2 } from './srs.js';

// Named entities are case-sensitive (&Auml; is not &auml;).
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ntilde: 'ñ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  euro: '€',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
};

/** Strip Anki markup from a field so only the readable text is left. */
export function cleanField(value) {
  let s = String(value ?? '');
  s = s.replace(/\[sound:[^\]]*\]/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, '; ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, '$1');
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? m;
  });
  s = s.replace(/\s+/g, ' ').replace(/(\s*;\s*)+/g, '; ');
  return s.replace(/^[;\s]+|[;\s]+$/g, '');
}

function rows(db, sql) {
  const res = db.exec(sql);
  return res.length ? res[0].values : [];
}

/**
 * @param {Uint8Array} bytes  the .apkg file
 * @param {object} SQL        an initialised sql.js module
 * @returns {{noteTypes: {name:string, deck:string, fields:string[], notes:string[][], study:(object|null)[]}[]}}
 *   `study[i]` is what Anki knows about note i (see cardStudy), or null if it was never studied.
 */
export function parseApkg(bytes, SQL) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => /^collection\.anki2(1b?)?$/.test(f.name) });
  } catch {
    throw new Error('This file is not an Anki deck package (.apkg).');
  }
  // Newer Anki writes the real collection zstd-compressed as collection.anki21b
  // and leaves a stub collection.anki2 that only says "please update".
  let dbBytes;
  if (files['collection.anki21b']) dbBytes = zstdDecompress(files['collection.anki21b']);
  else if (files['collection.anki21']) dbBytes = files['collection.anki21'];
  else if (files['collection.anki2']) dbBytes = files['collection.anki2'];
  else throw new Error('This file is not an Anki deck package (.apkg).');

  const db = withoutAnkiCollation(new SQL.Database(dbBytes), SQL);
  try {
    return readCollection(db);
  } finally {
    db.close();
  }
}

/**
 * Current Anki sorts names with a collation ("unicase") that only Anki
 * defines, and SQLite refuses to read tables that mention it. The data itself
 * is ordinary, so remove the collation from the schema and reopen.
 */
function withoutAnkiCollation(db, SQL) {
  let bytes;
  try {
    if (!rows(db, "SELECT 1 FROM sqlite_master WHERE sql LIKE '%unicase%' LIMIT 1").length) return db;
    db.run('PRAGMA writable_schema = 1');
    db.run("UPDATE sqlite_master SET sql = replace(sql, 'COLLATE unicase', '') WHERE sql LIKE '%unicase%'");
    bytes = db.export();
  } catch {
    return db; // field names fall back to "Field 1", "Field 2", ...
  }
  db.close();
  return new SQL.Database(bytes);
}

/**
 * What Anki knows about one card, or null for a card never studied.
 *
 * With FSRS (Anki's current scheduler) the card stores its memory state and
 * last review time. Cards scheduled the older way only have an interval and an
 * ease factor, which are converted. `hard` marks a card Anki is still teaching
 * or re-teaching; such a word comes into the app as a hard word.
 */
function cardStudy({ type, due, ivl, factor, data }, firstDay) {
  if (type === 0) return null;
  let info = {};
  try {
    info = JSON.parse(data || '{}') || {};
  } catch {
    /* no extra data */
  }
  const hard = type === 1 || type === 3;
  let memory;
  if (Number(info.s) > 0) memory = { S: Number(info.s), D: Number(info.d) || 5 };
  else if (ivl > 0) memory = memoryFromSm2(ivl, factor / 1000);
  else if (hard) memory = { S: 0.5, D: 6.4 };
  else return null;

  const onSchedule = type === 2 && firstDay > 0;
  const last = Number(info.lrt) > 0 ? info.lrt * 1000 : onSchedule ? (firstDay + (due - ivl) * 86400) * 1000 : 0;
  return {
    S: Math.round(memory.S * 10000) / 10000,
    D: Math.min(10, Math.max(1, Math.round(memory.D * 10000) / 10000)),
    last,
    due: onSchedule ? (firstDay + due * 86400) * 1000 : 0,
    hard,
  };
}

/** A note can have several cards. The best-known one speaks for the word. */
function betterStudy(a, b) {
  if (!b) return true;
  if (a.hard !== b.hard) return !a.hard;
  return a.S > b.S;
}

function readCollection(db) {
  const types = new Map(); // note type id -> { name, fields }

  // Older schema: note types are a JSON blob in the single `col` row.
  try {
    const models = JSON.parse(rows(db, 'SELECT models FROM col')[0]?.[0] || '{}');
    for (const [id, m] of Object.entries(models)) {
      const fields = [...(m.flds || [])].sort((a, b) => a.ord - b.ord).map((f) => f.name);
      types.set(String(id), { name: m.name || 'Notes', fields });
    }
  } catch {
    /* newer schema, handled below */
  }

  // Newer schema: note types and their fields are separate tables.
  if (!types.size) {
    try {
      for (const [id, name] of rows(db, 'SELECT id, name FROM notetypes')) {
        types.set(String(id), { name: name || 'Notes', fields: [] });
      }
      for (const [ntid, ord, name] of rows(db, 'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')) {
        const t = types.get(String(ntid));
        if (t) t.fields[ord] = name;
      }
    } catch {
      /* fall back to numbered fields */
    }
  }

  // Deck names, to suggest a name for the import. Older files keep them in the
  // `col` row; newer ones in a table, with \x1f between parent and child deck.
  const deckNames = new Map();
  try {
    const decks = JSON.parse(rows(db, 'SELECT decks FROM col')[0]?.[0] || '{}');
    for (const [id, d] of Object.entries(decks)) deckNames.set(String(id), d.name || '');
  } catch {
    /* newer schema, handled below */
  }
  if (!deckNames.size) {
    try {
      for (const [id, name] of rows(db, 'SELECT id, name FROM decks')) deckNames.set(String(id), String(name));
    } catch {
      /* no deck names: the file name is used instead */
    }
  }

  // The collection's first day, in seconds. A review card's `due` counts days from it.
  let firstDay = 0;
  try {
    firstDay = Number(rows(db, 'SELECT crt FROM col')[0]?.[0]) || 0;
  } catch {
    /* due dates stay unknown */
  }

  // In an unstudied deck, a card's `due` is its position in the intended order.
  const order = new Map();
  const deckOf = new Map();
  const studyOf = new Map();
  let untouched = true;
  try {
    for (const [nid, due, type, did, ivl, factor, data] of rows(
      db,
      'SELECT nid, due, type, did, ivl, factor, data FROM cards',
    )) {
      const id = String(nid);
      if (!order.has(id) || due < order.get(id)) order.set(id, due);
      if (!deckOf.has(id)) deckOf.set(id, String(did));
      if (type !== 0) untouched = false;
      const study = cardStudy({ type, due, ivl, factor, data }, firstDay);
      if (study && betterStudy(study, studyOf.get(id))) studyOf.set(id, study);
    }
  } catch {
    untouched = false;
  }

  const notes = rows(db, 'SELECT id, mid, flds FROM notes ORDER BY id').map(([id, mid, flds]) => ({
    id: String(id),
    mid: String(mid),
    fields: String(flds).split('\x1f').map(cleanField),
  }));
  if (untouched && order.size) {
    notes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  const grouped = new Map();
  for (const n of notes) {
    if (!grouped.has(n.mid)) grouped.set(n.mid, { list: [], study: [], decks: new Map() });
    const g = grouped.get(n.mid);
    g.list.push(n.fields);
    g.study.push(studyOf.get(n.id) || null);
    const did = deckOf.get(n.id);
    if (did) g.decks.set(did, (g.decks.get(did) || 0) + 1);
  }
  const noteTypes = [...grouped.entries()].map(([mid, { list, study, decks }]) => {
    const t = types.get(mid);
    const width = Math.max(...list.map((f) => f.length));
    const fields = Array.from({ length: width }, (_, i) => t?.fields[i] || `Field ${i + 1}`);
    const mainDeck = [...decks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const deck = (deckNames.get(mainDeck) || '')
      .split(/\x1f|::/)
      .pop()
      .trim();
    return { name: t?.name || 'Notes', deck, fields, notes: list, study };
  });
  noteTypes.sort((a, b) => b.notes.length - a.notes.length);
  if (!noteTypes.length) throw new Error('This deck has no notes in it.');
  return { noteTypes };
}

/** Parse Anki's "Notes in Plain Text" export, or any simple CSV/TSV word list. */
export function parseAnkiText(text) {
  const src = text.replace(/^﻿/, '');
  const meta = {};
  let body = src;
  for (;;) {
    const m = /^#([a-z ]+):(.*)\r?\n?/i.exec(body);
    if (!m) break;
    meta[m[1].trim().toLowerCase()] = m[2].trim();
    body = body.slice(m[0].length);
  }

  const named = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':' };
  let sep = meta.separator ? (named[meta.separator.toLowerCase()] ?? meta.separator) : null;
  if (!sep) {
    const first = body.split(/\r?\n/).find((l) => l.trim()) || '';
    sep = ['\t', ';', ',', '|'].find((c) => first.includes(c)) || '\t';
  }

  const table = parseDelimited(body, sep).filter((r) => r.some((c) => c.trim()));
  if (!table.length) throw new Error('No rows found in this file.');

  // Anki can prepend bookkeeping columns; they are not vocabulary.
  const column = (key) => parseInt(meta[key], 10) - 1;
  const typeCol = column('notetype column');
  const bookkeeping = new Set(
    [column('guid column'), typeCol, column('deck column'), column('tags column')].filter((i) => i >= 0),
  );

  const groups = new Map();
  for (const r of table) {
    const name = typeCol >= 0 ? cleanField(r[typeCol]) || 'Notes' : 'Text file';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r.filter((_, i) => !bookkeeping.has(i)).map(cleanField));
  }
  const noteTypes = [...groups.entries()].map(([name, list]) => {
    // Rows of one note type can still differ in length when trailing fields are empty.
    const width = Math.max(...list.map((r) => r.length));
    const prefix = bookkeeping.size ? 'Field' : 'Column';
    return {
      name,
      fields: Array.from({ length: width }, (_, i) => `${prefix} ${i + 1}`),
      notes: list.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    };
  });
  noteTypes.sort((x, y) => y.notes.length - x.notes.length);
  return { noteTypes };
}

function parseDelimited(text, sep) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

// ---- choosing the fields -------------------------------------------------

const GERMAN_NAME = /german|deutsch|^de$|wort/i;
const ENGLISH_NAME = /english|englisch|^en$|definition|meaning|bedeutung|gloss|translation|übersetzung/i;
// "Front", "Back" and "Word" say where a field sits, not which language it holds.
const WEAK_GERMAN_NAME = /front|word|vocab|expression|lemma|term/i;
const WEAK_ENGLISH_NAME = /back/i;
const NOT_VOCAB_NAME = /sentence|example|beispiel|satz|audio|sound|image|picture|bild|index|sort|hint|note/i;

const GERMAN_TEXT = /[äöüß]|^(der|die|das|sich)\s/i;
const ENGLISH_TEXT = /\bto \p{L}|^(the|a|an)\s|\b(of|with|and|or)\b/iu;

// "Definitions 1", "Definitions 2", ... Names this module made up do not count.
const NUMBERED = /^(.*?\D)\s*(\d+)$/;
const GENERATED = /^(field|column)$/i;

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** What each field of a note type looks like, judged from a sample of its notes. */
function profileFields(noteType) {
  const sample = noteType.notes.slice(0, 300);
  return noteType.fields.map((name, i) => {
    const values = sample.map((n) => n[i]).filter(Boolean);
    const share = (re) => (sample.length ? values.filter((v) => re.test(v)).length / sample.length : 0);
    const sentences = values.length ? values.filter((v) => /[.!?]$/.test(v)).length / values.length : 0;
    return {
      i,
      name,
      filled: values.length,
      // Words and short glosses, as opposed to sentences and numbering.
      wordLike:
        values.length > 0 &&
        median(values.map((v) => v.split(/\s+/).length)) <= 4 &&
        sentences <= 0.5 &&
        share(/^[\d.,]+$/) < 0.5,
      german: share(GERMAN_TEXT),
      english: share(ENGLISH_TEXT),
    };
  });
}

/**
 * The choices for the "meaning" field: every field on its own, plus each run
 * of numbered fields ("Definitions 1-3") offered as one combined choice.
 */
export function fieldChoices(noteType) {
  const groups = new Map();
  noteType.fields.forEach((name, i) => {
    const m = NUMBERED.exec(name);
    if (!m || GENERATED.test(m[1].trim())) return;
    const key = m[1].trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i, n: Number(m[2]), base: m[1].trim() });
  });
  const combined = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      g.sort((a, b) => a.n - b.n);
      return { label: `${g[0].base} ${g[0].n}–${g.at(-1).n}, combined`, fields: g.map((x) => x.i) };
    });
  return [...combined, ...noteType.fields.map((name, i) => ({ label: name, fields: [i] }))];
}

/**
 * Guess which field holds the German word and which field or fields hold the
 * English meaning. Returns { de: fieldIndex, en: fieldIndexes }.
 */
export function guessMapping(noteType) {
  const fields = profileFields(noteType);
  let pool = fields.filter((f) => f.wordLike && !NOT_VOCAB_NAME.test(f.name));
  if (pool.length < 2) pool = fields.filter((f) => f.filled);
  if (pool.length < 2) return { de: pool[0]?.i ?? 0, en: [pool[0]?.i === 0 ? 1 : 0] };

  const best = (list, score) => list.map((f) => ({ f, v: score(f) })).sort((a, b) => b.v - a.v || a.f.i - b.f.i)[0].f;
  const named = (f, strong, weak) => (strong.test(f.name) ? 1 : weak.test(f.name) ? 0.3 : 0);

  const de = best(pool, (f) => named(f, GERMAN_NAME, WEAK_GERMAN_NAME) + f.german - f.english);
  const en = best(
    pool.filter((f) => f !== de),
    (f) => named(f, ENGLISH_NAME, WEAK_ENGLISH_NAME) + f.english - f.german,
  );
  const group = fieldChoices(noteType).find((c) => c.fields.length > 1 && c.fields.includes(en.i));
  return { de: de.i, en: group ? group.fields : [en.i] };
}

/** Index of the note type that looks most like German vocabulary (a file can hold several decks). */
export function bestNoteType(noteTypes) {
  const scores = noteTypes.map((t) =>
    Math.max(
      0,
      ...profileFields(t)
        .filter((f) => f.wordLike)
        .map((f) => f.german - f.english),
    ),
  );
  return scores.indexOf(Math.max(...scores));
}

/**
 * Join the meanings of one word. When every part carries the same label
 * ("Verb: to become", "Verb: will"), the label is written once.
 */
export function joinMeanings(values) {
  const parts = values.map((v) => (v || '').trim()).filter(Boolean);
  if (parts.length > 1) {
    const split = parts.map((p) => /^(\p{Lu}[\p{L} ().]{1,24}):\s+(.+)$/u.exec(p));
    if (split.every((m) => m && m[1] === split[0][1])) {
      return `${split[0][1]}: ${split.map((m) => m[2]).join('; ')}`;
    }
  }
  return parts.join('; ');
}

/**
 * Turn mapped notes into word pairs, in deck order, dropping what cannot be
 * used. `enIndexes` is one field index or several, whose values are joined.
 * A word that appears twice is kept once, with the fuller of its meanings.
 * Each word carries `study`, what Anki knows about it, or null.
 */
export function extractWords(noteType, deIndex, enIndexes) {
  const enList = [enIndexes].flat();
  const words = [];
  const at = new Map();
  const skipped = { empty: 0, long: 0, duplicate: 0 };
  const senses = (en) => en.split(';').length;
  noteType.notes.forEach((n, row) => {
    const de = n[deIndex] || '';
    const en = joinMeanings(enList.map((i) => n[i]));
    const study = noteType.study?.[row] || null;
    const id = normKey(de);
    if (!id || !en) skipped.empty++;
    else if (id.split(' ').length > 5) skipped.long++;
    else if (at.has(id)) {
      skipped.duplicate++;
      const first = words[at.get(id)];
      if (senses(en) > senses(first.en)) first.en = en;
      if (study && betterStudy(study, first.study)) first.study = study;
    } else {
      at.set(id, words.length);
      words.push({ de, en, study });
    }
  });
  return { words, skipped };
}
