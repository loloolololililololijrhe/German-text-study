// Turning the model's JSON stream into sentences, and sentences into tappable
// words. Pure functions, no DOM.

/**
 * Incrementally reads `{"title": "...", "sentences": [ {...}, {...} ]}` as it
 * streams in and hands back each sentence object the moment it is complete, so
 * the learner can start reading before the whole text has been written.
 */
export class SentenceStream {
  constructor() {
    this.buf = '';
    this.pos = 0;
    this.inArray = false;
    this.ended = false;
    this.title = '';
    this.sentences = [];
  }

  push(chunk) {
    this.buf += chunk;
    const fresh = [];
    if (!this.title) {
      const m = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(this.buf);
      if (m) {
        try {
          this.title = JSON.parse(m[1]);
        } catch {
          /* wait for more */
        }
      }
    }
    if (!this.inArray) {
      const m = /"sentences"\s*:\s*\[/.exec(this.buf);
      if (!m) return fresh;
      this.inArray = true;
      this.pos = m.index + m[0].length;
    }
    while (!this.ended) {
      while (this.pos < this.buf.length && /[\s,]/.test(this.buf[this.pos])) this.pos++;
      if (this.pos >= this.buf.length) break;
      const c = this.buf[this.pos];
      if (c === ']') {
        this.ended = true;
        break;
      }
      if (c !== '{') {
        this.pos++;
        continue;
      }
      const end = matchObject(this.buf, this.pos);
      if (end === -1) break;
      try {
        const s = normalizeSentence(JSON.parse(this.buf.slice(this.pos, end + 1)));
        if (s) {
          this.sentences.push(s);
          fresh.push(s);
        }
      } catch {
        /* skip a malformed object */
      }
      this.pos = end + 1;
    }
    return fresh;
  }
}

/** Index of the `}` closing the object that starts at `start`, or -1 if incomplete. */
function matchObject(buf, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

export function normalizeSentence(raw) {
  if (!raw || typeof raw.de !== 'string' || !raw.de.trim()) return null;
  const words = Array.isArray(raw.words)
    ? raw.words
        .filter((w) => w && typeof w.w === 'string' && w.w.trim())
        .map((w) => ({ w: w.w.trim(), l: String(w.l ?? w.w).trim(), g: String(w.g ?? '').trim() }))
    : [];
  return { de: raw.de.trim(), en: String(raw.en ?? '').trim(), br: !!raw.br, words };
}

const LETTER = /[\p{L}\p{N}]/u;

function findWord(text, surface, from, fold) {
  const hay = fold ? text.toLowerCase() : text;
  const needle = fold ? surface.toLowerCase() : surface;
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    const before = i > 0 ? text[i - 1] : '';
    const after = text[i + needle.length] || '';
    if (!(before && LETTER.test(before)) && !(after && LETTER.test(after))) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

/**
 * Split a sentence into plain text and word segments, in order. `wi` is the
 * index into `words`; segments without it are punctuation and spacing.
 */
export function segmentSentence(de, words) {
  const segs = [];
  let pos = 0;
  words.forEach((word, wi) => {
    let i = findWord(de, word.w, pos, false);
    if (i === -1) i = findWord(de, word.w, pos, true);
    if (i === -1) return;
    if (i > pos) segs.push({ text: de.slice(pos, i) });
    segs.push({ text: de.slice(i, i + word.w.length), wi });
    pos = i + word.w.length;
  });
  if (pos < de.length) segs.push({ text: de.slice(pos) });
  return segs;
}
