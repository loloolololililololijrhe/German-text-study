// Reading Anki decks: .apkg packages and "Notes in Plain Text" exports.
// No DOM. The SQLite engine (sql.js) is passed in so this also runs under Node.

import { unzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { normKey } from './words.js';

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
 * @returns {{noteTypes: {name:string, fields:string[], notes:string[][]}[]}}
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

  // In an unstudied deck, a card's `due` is its position in the intended order.
  const order = new Map();
  let untouched = true;
  try {
    for (const [nid, due, maxType] of rows(db, 'SELECT nid, MIN(due), MAX(type) FROM cards GROUP BY nid')) {
      order.set(String(nid), due);
      if (maxType !== 0) untouched = false;
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
    if (!grouped.has(n.mid)) grouped.set(n.mid, []);
    grouped.get(n.mid).push(n.fields);
  }
  const noteTypes = [...grouped.entries()].map(([mid, list]) => {
    const t = types.get(mid);
    const width = Math.max(...list.map((f) => f.length));
    const fields = Array.from({ length: width }, (_, i) => t?.fields[i] || `Field ${i + 1}`);
    return { name: t?.name || 'Notes', fields, notes: list };
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

const GERMAN_HINT = /[äöüß]|^(der|die|das|ein|eine|sich)\s|(en|ung|keit|heit|lich|isch)$/i;
const ENGLISH_HINT = /^(to|the|a|an)\s|\b(of|with|and|or|is|not)\b|(ing|tion|ly|ness)$/i;

/** Guess which field holds the German word and which the English meaning. */
export function guessMapping(noteType) {
  const sample = noteType.notes.slice(0, 200);
  const score = (i, re) => sample.filter((n) => n[i] && re.test(n[i])).length;
  const usable = noteType.fields.map((name, i) => ({ i, name })).filter((f) => sample.some((n) => n[f.i]));
  if (usable.length < 2) return { de: usable[0]?.i ?? 0, en: usable[0]?.i === 0 ? 1 : 0 };

  const byName = (re) => usable.find((f) => re.test(f.name))?.i;
  let de = byName(/german|deutsch|^de$|wort/i);
  let en = byName(/english|englisch|^en$|meaning|translation|übersetzung|bedeutung/i);
  if (de == null) {
    de = usable
      .filter((f) => f.i !== en)
      .map((f) => ({ i: f.i, v: score(f.i, GERMAN_HINT) - score(f.i, ENGLISH_HINT) }))
      .sort((a, b) => b.v - a.v || a.i - b.i)[0].i;
  }
  if (en == null) {
    en = usable
      .filter((f) => f.i !== de)
      .map((f) => ({ i: f.i, v: score(f.i, ENGLISH_HINT) - score(f.i, GERMAN_HINT) }))
      .sort((a, b) => b.v - a.v || a.i - b.i)[0].i;
  }
  return { de, en };
}

/** Turn mapped notes into word pairs, in deck order, dropping what cannot be used. */
export function extractWords(noteType, deIndex, enIndex) {
  const words = [];
  const seen = new Set();
  const skipped = { empty: 0, long: 0, duplicate: 0 };
  for (const n of noteType.notes) {
    const de = n[deIndex] || '';
    const en = n[enIndex] || '';
    const id = normKey(de);
    if (!id || !en) skipped.empty++;
    else if (id.split(' ').length > 5) skipped.long++;
    else if (seen.has(id)) skipped.duplicate++;
    else {
      seen.add(id);
      words.push({ de, en });
    }
  }
  return { words, skipped };
}
