// The Read tab: choose a text, read it, tap words, finish.

import { store } from '../store.js';
import { fill, h, icon, plural, toast } from './dom.js';
import { cleanRead, hardRead, isDue, pickTargets, rulesOf, seen } from '../lib/scoring.js';
import { hasMemory } from '../lib/srs.js';
import { SentenceStream } from '../lib/textparse.js';
import { createTextView } from './textview.js';
import { FORMS, LENGTHS, LEVELS, TOPICS, buildUserPrompt } from '../lib/prompt.js';
import { DEFAULT_PREFS } from '../lib/merge.js';

const TEXT_KEY = 'gts.text';
const TITLES_KEY = 'gts.titles';

let root;
let sheet;
let openSettings;

let text = loadText();
let abort = null; // AbortController while a text is being written
let summary = null; // outcome of the text that was just finished
let error = '';

let view; // the text on screen: tapping, marking, read-aloud
let titleEl = null;
let footEl = null;

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
  view = createTextView({ sheet, onChange: saveText });
  store.subscribe((what) => {
    if (text) {
      if (what === 'progress' || what === 'words') view.repaint();
    } else if (what === 'words' && !root.contains(document.activeElement)) {
      render();
    }
  });
  render();
}

/** Called when the Read tab becomes visible, to pick up changes made elsewhere. */
export function showReader() {
  if (!text) render();
  else view.paintUnderline();
}

export function leaveReader() {
  view.stopListening();
}

function render() {
  fill(root, text ? renderText() : renderGenerator());
}

// ---- choosing the next text ---------------------------------------------

function renderGenerator() {
  const prefs = store.state.prefs;
  const custom = TOPICS.some((t) => t.id === prefs.topic) ? '' : prefs.topic;
  const hasKey = !!store.local.apiKey;
  const hasWords = store.index.list.length > 0;

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
      h('span', { class: 'label' }, 'Form'),
      segmented(
        Object.entries(FORMS).map(([id, f]) => ({ id, label: f.label })),
        FORMS[prefs.form] ? prefs.form : 'prose',
        (id) => store.updatePrefs({ form: id }),
        'Form',
      ),
      h(
        'span',
        { class: 'help' },
        'Text is a story or report. Play is written as lines spoken between people, with the name before each line.',
      ),
    ),
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
    !hasWords &&
      h(
        'div',
        { class: 'notice has-action' },
        h('p', null, 'Every word list is turned off. Turn one on to have something to read about.'),
        h('button', { class: 'btn', type: 'button', onclick: openSettings }, 'Open settings'),
      ),
    h(
      'button',
      { class: 'btn btn-primary btn-big', type: 'button', disabled: !hasKey || !hasWords, onclick: generate },
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
  const now = Date.now();
  let hard = 0;
  let due = 0;
  for (const e of store.index.list) {
    const p = store.progressOf(e.id);
    if (!p) continue;
    if (p.s < 0) hard++;
    else if (e.priority && isDue(p, now)) due++;
  }
  const fresh = store.newLeft();
  if (!hard && !due && !fresh) return 'Nothing is due right now. The next text practises the words due soonest.';
  return [
    `${plural(hard, 'hard word')}`,
    `${due.toLocaleString('en')} due`,
    `${plural(fresh, 'new word')} left today`,
  ].join(' · ');
}

function renderSummary() {
  const parts = [];
  if (summary.credit) parts.push(`${plural(summary.up, 'word')} reviewed`);
  else parts.push('Text skipped, nothing counted as read');
  if (summary.hard) parts.push(`${plural(summary.hard, 'word')} marked hard`);
  if (summary.started) parts.push(`${plural(summary.started, 'new word')} started`);
  return h('p', { class: 'notice is-good', role: 'status' }, icon('check', 18), parts.join(' · '));
}

// ---- writing a text -------------------------------------------------------

async function generate() {
  if (abort) return;
  const prefs = store.state.prefs;
  const length = LENGTHS[prefs.length] ? prefs.length : 'medium';
  const targets = pickTargets(store.index.list, store.state.progress, LENGTHS[length].targets, {
    now: Date.now(),
    newLeft: store.newLeft(),
  });

  summary = null;
  error = '';
  text = {
    title: '',
    level: prefs.level,
    form: FORMS[prefs.form] ? prefs.form : 'prose',
    targets: targets.map((t) => ({ id: t.entry.id, hard: t.hard, kind: t.kind })),
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
        form: prefs.form,
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
          view.appendSentence(text.sentences.length - 1);
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
  const bodyEl = view.mount(text);
  const listenBtn = view.listenButton();
  titleEl = h('h1', { class: 'text-title', lang: 'de' }, text.title || ' ');
  footEl = h('footer', { class: 'text-foot' });
  renderFooter();

  // What the text was built from: "12 target words: 7 hard, 2 due, 3 new".
  const kinds = { hard: 0, due: 0, new: 0, early: 0 };
  for (const t of text.targets) kinds[t.kind || (t.hard ? 'hard' : 'due')]++;
  const mix = Object.entries(kinds)
    .filter(([, n]) => n)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  const meta = [text.level, plural(text.targets.length, 'target word') + (mix ? `: ${mix}` : '')];

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

// ---- finishing -------------------------------------------------------------

/**
 * Close the text and reschedule its words. With `credit`, every list word that
 * appeared counts as a review: a clean read if it was not tapped ("Good" in
 * Anki), a weaker one if it was looked up ("Hard"). Words marked hard were
 * dealt with when they were marked. Without `credit` nothing is rescheduled.
 */
function finish(credit) {
  view.stopListening();
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

  const rules = rulesOf(store.state.prefs);
  const updates = {};
  let up = 0;
  for (const id of present) {
    const p = store.progressOf(id);
    if (id in text.hard) updates[id] = seen(p, now);
    else if (text.tapped[id] || tappedPhrase.has(id)) updates[id] = credit ? hardRead(p, now, rules) : seen(p, now);
    else if (credit) {
      updates[id] = cleanRead(p, now, rules);
      up++;
    }
  }

  // New words that this text got going count towards today's allowance.
  const started = text.targets.filter(
    (t) => t.kind === 'new' && hasMemory(updates[t.id] || store.progressOf(t.id)),
  ).length;
  store.addIntroduced(started);

  summary = { credit, up, hard: Object.keys(text.hard).length, started };
  // A text that was read is kept for the History tab.
  if (credit) store.addText({ title: text.title, level: text.level, sentences: text.sentences, hard: summary.hard });
  rememberTitle(text.title);
  text = null;
  saveText();
  store.setProgressMany(updates);
  render();
  window.scrollTo(0, 0);
  store.syncNow();
}
