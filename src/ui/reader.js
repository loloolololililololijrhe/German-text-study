// The Read tab: choose a text, read it, tap words, finish.

import { store } from '../store.js';
import { fill, h, icon, plural, toast } from './dom.js';
import { normKey } from '../lib/words.js';
import {
  cleanRead,
  clearHard,
  hardStepOf,
  lookedUp,
  markHard,
  pickTargets,
  resetWord,
  seen,
  statusOf,
} from '../lib/scoring.js';
import { SentenceStream, segmentSentence } from '../lib/textparse.js';
import { LENGTHS, LEVELS, TOPICS, buildUserPrompt } from '../lib/prompt.js';
import { DEFAULT_PREFS } from '../lib/merge.js';
import { tts } from '../tts.js';

const TEXT_KEY = 'gts.text';
const TITLES_KEY = 'gts.titles';
export const FROM_TEXT = 'Added while reading';

let root;
let sheet;
let openSettings;

let text = loadText();
let abort = null; // AbortController while a text is being written
let summary = null; // outcome of the text that was just finished
let error = '';
let speaking = false;

let bodyEl = null;
let paraEl = null;
let titleEl = null;
let footEl = null;
let listenBtn = null;
let activeEl = null;

function loadText() {
  try {
    const t = JSON.parse(localStorage.getItem(TEXT_KEY) || 'null');
    if (!t || !Array.isArray(t.sentences) || !t.sentences.length) return null;
    // A page closed mid-stream leaves a partial text; keep what arrived.
    return { hard: {}, tapped: {}, surfaces: {}, targets: [], ...t, complete: true };
  } catch {
    return null;
  }
}

function saveText() {
  try {
    if (text) localStorage.setItem(TEXT_KEY, JSON.stringify(text));
    else localStorage.removeItem(TEXT_KEY);
  } catch {
    /* ignore */
  }
}

function recentTitles() {
  try {
    return JSON.parse(localStorage.getItem(TITLES_KEY) || '[]');
  } catch {
    return [];
  }
}

function rememberTitle(title) {
  if (!title) return;
  try {
    localStorage.setItem(TITLES_KEY, JSON.stringify([title, ...recentTitles()].slice(0, 8)));
  } catch {
    /* ignore */
  }
}

export function mountReader(el, options) {
  root = el;
  sheet = options.sheet;
  openSettings = options.openSettings;
  store.subscribe((what) => {
    if (text) {
      if (what === 'progress' || what === 'words') repaintWords();
    } else if (what === 'words' && !root.contains(document.activeElement)) {
      render();
    }
  });
  render();
}

/** Called when the Read tab becomes visible, to pick up changes made elsewhere. */
export function showReader() {
  if (!text) render();
  else paintUnderline();
}

/** Hard words returning from earlier texts are underlined, unless the learner turned that off. */
function paintUnderline() {
  bodyEl?.classList.toggle('no-hard-underline', store.state.prefs.underlineHard === false);
}

export function leaveReader() {
  stopListening();
}

function render() {
  activeEl = null;
  fill(root, text ? renderText() : renderGenerator());
}

// ---- choosing the next text ---------------------------------------------

function renderGenerator() {
  const prefs = store.state.prefs;
  const custom = TOPICS.some((t) => t.id === prefs.topic) ? '' : prefs.topic;
  const hasKey = !!store.local.apiKey;

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Topic' },
    TOPICS.map((t) =>
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'data-topic': t.id,
          'aria-pressed': String(prefs.topic === t.id),
          onclick: () => {
            store.updatePrefs({ topic: t.id });
            render();
          },
        },
        t.label,
      ),
    ),
  );

  const topicInput = h('input', {
    class: 'input',
    type: 'text',
    value: custom,
    maxlength: '120',
    placeholder: 'Or type your own topic',
    'aria-label': 'Your own topic',
    oninput: (e) => {
      // No re-render here: replacing the form while typing would drop focus.
      const v = e.target.value.trim();
      store.updatePrefs({ topic: v || DEFAULT_PREFS.topic });
      for (const c of chips.children) {
        c.setAttribute('aria-pressed', String(!v && c.dataset.topic === DEFAULT_PREFS.topic));
      }
    },
  });

  return h(
    'section',
    { class: 'gen' },
    summary && renderSummary(),
    h('h1', { class: 'page-title' }, 'Your next text'),
    h('p', { class: 'gen-info' }, infoLine()),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Topic'), chips, topicInput),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'label' }, 'Length'),
      segmented(
        Object.entries(LENGTHS).map(([id, l]) => ({ id, label: l.label })),
        prefs.length,
        (id) => store.updatePrefs({ length: id }),
        'Length',
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'label' }, 'Level'),
      segmented(
        Object.keys(LEVELS).map((id) => ({ id, label: id })),
        prefs.level,
        (id) => store.updatePrefs({ level: id }),
        'Level',
      ),
    ),
    error && h('p', { class: 'notice is-error', role: 'alert' }, error),
    !hasKey &&
      h(
        'div',
        { class: 'notice has-action' },
        h('p', null, 'Texts are written by Claude. Add your Claude API key once to get started.'),
        h('button', { class: 'btn', type: 'button', onclick: openSettings }, 'Open settings'),
      ),
    h(
      'button',
      { class: 'btn btn-primary btn-big', type: 'button', disabled: !hasKey, onclick: generate },
      'Generate text',
    ),
  );
}

function segmented(options, current, onPick, label) {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(o.id === current),
          onclick: () => {
            onPick(o.id);
            render();
          },
        },
        o.label,
      ),
    ),
  );
}

function infoLine() {
  let hard = 0;
  let met = 0;
  for (const e of store.index.list) {
    const st = statusOf(store.progressOf(e.id));
    if (st === 'hard') hard++;
    if (st !== 'new') met++;
  }
  const total = store.index.list.length;
  const waiting = hard ? `${plural(hard, 'hard word')} waiting to come back` : 'No hard words yet';
  return `${waiting} · ${met.toLocaleString('en')} of ${plural(total, 'word')} met so far`;
}

function renderSummary() {
  const parts = [];
  if (summary.credit) parts.push(`${plural(summary.up, 'word')} moved up a step`);
  else parts.push('Text skipped, nothing counted as read');
  if (summary.hard) parts.push(`${plural(summary.hard, 'word')} marked hard`);
  return h('p', { class: 'notice is-good', role: 'status' }, icon('check', 18), parts.join(' · '));
}

// ---- writing a text -------------------------------------------------------

async function generate() {
  if (abort) return;
  const prefs = store.state.prefs;
  const length = LENGTHS[prefs.length] ? prefs.length : 'medium';
  const targets = pickTargets(store.index.list, store.state.progress, LENGTHS[length].targets);

  summary = null;
  error = '';
  text = {
    title: '',
    level: prefs.level,
    targets: targets.map((t) => ({ id: t.entry.id, hard: t.hard })),
    sentences: [],
    hard: {}, // word id -> its progress before it was flagged in this text
    tapped: {}, // word ids looked up in this text
    surfaces: {}, // lower-cased spellings that were tapped
    complete: false,
  };
  abort = new AbortController();
  render();
  window.scrollTo(0, 0);

  const mine = text;
  const stream = new SentenceStream();
  try {
    // The Claude SDK is most of the app's size, so it is fetched on first use.
    const { generateText } = await import('../claude.js').catch(() => {
      throw new Error('Could not load the text writer. Check your internet connection and try again.');
    });
    await generateText({
      apiKey: store.local.apiKey,
      model: prefs.model,
      prompt: buildUserPrompt({
        level: prefs.level,
        length,
        topic: prefs.topic,
        targets,
        recentTitles: recentTitles(),
      }),
      signal: abort.signal,
      onText(chunk) {
        if (text !== mine) return;
        const fresh = stream.push(chunk);
        if (stream.title && !text.title) {
          text.title = stream.title;
          titleEl.textContent = text.title;
        }
        for (const s of fresh) {
          text.sentences.push(s);
          appendSentence(text.sentences.length - 1);
        }
        if (fresh.length) saveText();
      },
    });
    if (!mine.sentences.length) throw new Error('Claude returned an empty text. Please try again.');
  } catch (err) {
    if (text !== mine) return;
    if (err.aborted || !mine.sentences.length) {
      text = null;
      error = err.aborted ? '' : err.message;
    } else {
      // Keep what arrived: a shorter text is still worth reading.
      toast(err.message);
    }
  }
  abort = null;
  if (text === mine) {
    text.complete = true;
    saveText();
    renderFooter();
  } else {
    saveText();
    render();
  }
}

// ---- reading --------------------------------------------------------------

function renderText() {
  bodyEl = h('div', { class: 'text-body', lang: 'de', onclick: onBodyClick, onkeydown: onBodyKey });
  paraEl = null;
  paintUnderline();
  text.sentences.forEach((_, i) => appendSentence(i));

  titleEl = h('h1', { class: 'text-title', lang: 'de' }, text.title || ' ');
  footEl = h('footer', { class: 'text-foot' });
  listenBtn = tts.supported ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleListening }) : null;
  paintListenBtn();
  renderFooter();

  const hardTargets = text.targets.filter((t) => t.hard).length;
  const meta = [
    text.level,
    plural(text.targets.length, 'target word') + (hardTargets ? `, ${hardTargets} of them hard` : ''),
  ];

  return h(
    'article',
    { class: 'text' },
    h(
      'header',
      { class: 'text-head' },
      h('p', { class: 'text-meta' }, meta.join(' · ')),
      titleEl,
      h('div', { class: 'text-tools' }, listenBtn, h('span', { class: 'text-hint' }, 'Tap any word you do not know')),
    ),
    bodyEl,
    footEl,
  );
}

function appendSentence(si) {
  const s = text.sentences[si];
  if (!paraEl || (s.br && si > 0)) {
    paraEl = h('p');
    bodyEl.append(paraEl);
  }
  const sent = h('span', { class: 'sent', 'data-si': String(si) });
  for (const seg of segmentSentence(s.de, s.words)) {
    if (seg.wi == null) {
      sent.append(seg.text);
    } else {
      const el = h('span', { class: 'w', role: 'button', tabindex: '0', 'data-wi': String(seg.wi) }, seg.text);
      paintWord(el, s.words[seg.wi]);
      sent.append(el);
    }
  }
  // Glued to the sentence's last character so it never wraps onto a line alone.
  sent.append(
    '⁠',
    h(
      'button',
      { class: 'sent-tr', type: 'button', lang: 'en', 'data-tr': String(si), 'aria-label': 'Translate this sentence' },
      'EN',
    ),
  );
  paraEl.append(sent, ' ');
}

function renderFooter() {
  if (!footEl) return;
  if (abort) {
    fill(
      footEl,
      h(
        'p',
        { class: 'writing', role: 'status' },
        h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
        'Writing your text',
      ),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => abort?.abort() }, 'Cancel'),
    );
    return;
  }
  fill(
    footEl,
    h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: () => finish(true) }, 'Done reading'),
    h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => finish(false) }, 'Skip this text'),
    h(
      'p',
      { class: 'foot-hint' },
      'Done counts every word you did not tap as read, so it shows up less often. Skip counts nothing but keeps the words you marked hard.',
    ),
  );
}

/** The list id for a word of the text, whether or not the list has it yet. */
function idOf(word) {
  return store.index.find(word.l)?.id || normKey(word.l) || normKey(word.w);
}

/** Names and numbers can be tapped for a translation but are never scored. */
function isUnscored(word) {
  return /^\(?\s*(name|proper noun)\s*\)?$/i.test(word.g) || /^[\d.,:]+$/.test(word.w);
}

function paintWord(el, word) {
  const id = idOf(word);
  const marked = id in text.hard;
  el.classList.toggle('is-marked', marked);
  el.classList.toggle('is-hard', !marked && (store.progressOf(id)?.s ?? 0) < 0);
  el.classList.toggle('is-looked', !marked && !!text.tapped[id]);
}

function repaintWords() {
  if (!bodyEl || !text) return;
  for (const el of bodyEl.querySelectorAll('.w')) {
    const si = Number(el.parentElement.dataset.si);
    paintWord(el, text.sentences[si].words[Number(el.dataset.wi)]);
  }
}

function setActive(el) {
  activeEl?.classList.remove('is-active');
  activeEl = el;
  activeEl?.classList.add('is-active');
}

function onBodyClick(e) {
  const tr = e.target.closest('.sent-tr');
  if (tr) return openSentence(Number(tr.dataset.tr));
  const w = e.target.closest('.w');
  if (w) openWord(w);
}

function onBodyKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('w')) {
    e.preventDefault();
    openWord(e.target);
  }
}

function openWord(el) {
  const si = Number(el.parentElement.dataset.si);
  const word = text.sentences[si].words[Number(el.dataset.wi)];
  const id = idOf(word);
  text.surfaces[word.w.toLowerCase()] = true;
  if (!text.tapped[id]) {
    text.tapped[id] = true;
    if (!isUnscored(word)) {
      if (store.state.prefs.autoHard) flag(word);
      else if (store.index.byId.has(id)) store.setProgress(id, lookedUp(store.progressOf(id), Date.now()));
    }
  }
  saveText();
  repaintWords();
  setActive(el);
  sheet.open(wordSheet(word, si), () => setActive(null));
}

/** Mark a word hard. A word the list does not have yet is added to it first. */
function flag(word) {
  let entry = store.index.find(word.l);
  if (!entry) {
    store.addCustom([{ de: word.l || word.w, en: word.g || '?', src: FROM_TEXT }]);
    entry = store.index.find(word.l);
    if (!entry) return;
  }
  if (entry.id in text.hard) return;
  const before = store.progressOf(entry.id) || null;
  text.hard[entry.id] = before;
  text.tapped[entry.id] = true;
  store.setProgress(entry.id, markHard(before, Date.now(), hardStepOf(store.state.prefs)));
  saveText();
}

function unflag(id) {
  const before = text.hard[id];
  delete text.hard[id];
  store.setProgress(id, before ? { ...before, u: Date.now() } : resetWord(Date.now()));
  saveText();
}

function speakButton(phrase) {
  if (!tts.supported) return null;
  return h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Listen',
      onclick: () => {
        stopListening();
        tts.speak([phrase], { rate: store.state.prefs.rate, voice: store.local.voice });
      },
    },
    icon('speaker'),
  );
}

function wordSheet(word, si) {
  const wrap = h('div', { class: 'ws' });
  const draw = () => {
    const entry = store.index.find(word.l);
    const id = entry?.id || idOf(word);
    const p = store.progressOf(id);
    const marked = id in text.hard;
    const hard = (p?.s ?? 0) < 0;
    const scored = !isUnscored(word);
    const base = entry?.de || word.l;
    const showBase = base && (base.toLowerCase() !== word.w.toLowerCase() || (entry && entry.en !== word.g));

    fill(
      wrap,
      h('div', { class: 'ws-head' }, h('span', { class: 'ws-word', lang: 'de' }, word.w), speakButton(word.w)),
      h('p', { class: 'ws-gloss' }, word.g || 'No translation available'),
      showBase &&
        h('p', { class: 'ws-base' }, h('span', { lang: 'de' }, base), entry && entry.en ? ` · ${entry.en}` : ''),
      h(
        'div',
        { class: 'ws-actions' },
        scored &&
          (marked
            ? h(
                'button',
                { class: 'btn btn-hard is-on', type: 'button', onclick: () => (unflag(id), draw()) },
                icon('flag', 18),
                'Marked hard · Undo',
              )
            : h(
                'button',
                { class: 'btn btn-hard', type: 'button', onclick: () => (flag(word), draw()) },
                icon('flag', 18),
                hard ? 'Mark hard again' : 'Mark as hard',
              )),
        scored &&
          hard &&
          !marked &&
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => (store.setProgress(id, clearHard(p, Date.now())), draw()),
            },
            icon('check', 18),
            'I know this now',
          ),
        h('button', { class: 'btn', type: 'button', onclick: () => openSentence(si) }, 'Whole sentence'),
      ),
    );
  };
  draw();
  return wrap;
}

function openSentence(si) {
  const s = text.sentences[si];
  setActive(bodyEl.querySelector(`.sent[data-si="${si}"]`));
  sheet.open(
    h(
      'div',
      { class: 'ws' },
      h('div', { class: 'ws-head' }, h('span', { class: 'ws-kicker' }, 'Sentence'), speakButton(s.de)),
      h('p', { class: 'ss-de', lang: 'de' }, s.de),
      h('p', { class: 'ss-en' }, s.en || 'No translation available'),
    ),
    () => setActive(null),
  );
}

// ---- listening -------------------------------------------------------------

function paintListenBtn() {
  if (!listenBtn) return;
  fill(listenBtn, icon(speaking ? 'stop' : 'play', 18), speaking ? 'Stop' : 'Listen');
}

function markSpeaking(si) {
  bodyEl?.querySelector('.sent.is-speaking')?.classList.remove('is-speaking');
  if (si >= 0) bodyEl?.querySelector(`.sent[data-si="${si}"]`)?.classList.add('is-speaking');
}

function stopListening() {
  if (!speaking) return;
  speaking = false;
  tts.stop();
  markSpeaking(-1);
  paintListenBtn();
}

function toggleListening() {
  if (speaking) return stopListening();
  if (!text?.sentences.length) return;
  speaking = true;
  paintListenBtn();
  tts.speak(
    text.sentences.map((s) => s.de),
    {
      rate: store.state.prefs.rate,
      voice: store.local.voice,
      onPiece: markSpeaking,
      onDone: () => {
        speaking = false;
        markSpeaking(-1);
        paintListenBtn();
      },
    },
  );
}

// ---- finishing -------------------------------------------------------------

/**
 * Close the text. With `credit`, every list word that appeared and was not
 * tapped moves up a step; tapped and flagged words only record the sighting.
 */
function finish(credit) {
  stopListening();
  sheet.close();
  const now = Date.now();

  const present = new Set();
  for (const s of text.sentences) {
    for (const w of s.words) {
      const e = store.index.find(w.l);
      if (e) present.add(e.id);
    }
  }
  // Multi-word entries ("zum Beispiel") cannot match a single word; look for
  // them in the running text instead.
  const running = text.sentences.map((s) => s.de.toLowerCase()).join(' ');
  const tappedPhrase = new Set();
  for (const e of store.index.phrases) {
    const phrase = e.id.toLowerCase();
    if (!running.includes(phrase)) continue;
    present.add(e.id);
    if (phrase.split(' ').some((part) => text.surfaces[part])) tappedPhrase.add(e.id);
  }

  const updates = {};
  let up = 0;
  for (const id of present) {
    const p = store.progressOf(id);
    if (id in text.hard || text.tapped[id] || tappedPhrase.has(id)) {
      updates[id] = seen(p, now);
    } else if (credit) {
      updates[id] = cleanRead(p, now);
      up++;
    }
  }

  summary = { credit, up, hard: Object.keys(text.hard).length };
  rememberTitle(text.title);
  text = null;
  saveText();
  store.setProgressMany(updates);
  render();
  window.scrollTo(0, 0);
  store.syncNow();
}
