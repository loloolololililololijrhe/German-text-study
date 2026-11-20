// The Read tab: choose a text, read it, tap words, finish.

import { store } from '../store.js';
import { fill, h, icon, plural, segmented as segmentedRow, toast } from './dom.js';
import { cleanRead, earlyMaxOf, hardRead, isDue, pickExtras, pickTargets, rulesOf, seen } from '../lib/scoring.js';
import { hasMemory } from '../lib/srs.js';
import { createStopwatch, tallyWords, textKey } from '../lib/metrics.js';
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
let watch = null; // time spent reading the text on screen
let showing = false; // whether the Read tab is the one on screen
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
    if (text && watch) text.ms = watch.ms();
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
  // A text left open by an earlier visit carries the reading time it had so far.
  if (text) watch = createStopwatch({ elapsed: text.ms || 0 });
  // Reading time counts while the text is on screen and the learner is active.
  const alive = () => text && showing && watch?.touch();
  window.addEventListener('scroll', alive, { passive: true });
  document.addEventListener('pointerdown', alive);
  document.addEventListener('keydown', alive);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeWatch();
    else pauseWatch();
  });
  window.addEventListener('pagehide', pauseWatch);
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
  showing = true;
  if (!text) render();
  else view.paintUnderline();
  resumeWatch();
}

export function leaveReader() {
  showing = false;
  view.stopListening();
  pauseWatch();
}

/** Count reading time only once there is something to read and the text is on screen. */
function resumeWatch() {
  if (text && text.sentences.length && showing && document.visibilityState === 'visible') watch?.start();
}

function pauseWatch() {
  if (!watch) return;
  watch.pause();
  saveText();
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
    goalLine(),
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

/** A choice among a few options; the form is redrawn to show the new one. */
function segmented(options, current, onPick, label) {
  const pick = (id) => {
    onPick(id);
    render();
  };
  return segmentedRow(options, current, pick, label);
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

/** Today's texts against the daily goal, when the learner has set one. */
function goalLine() {
  const { goal, done, left, met } = store.goal();
  if (!goal) return null;
  const of = `${done} of ${goal} ${goal === 1 ? 'text' : 'texts'} today`;
  let words = `${of} · ${left} to go`;
  if (done > goal) words = `Daily goal reached: ${plural(done, 'text')} today, ${done - goal} more than your goal`;
  else if (met) words = `Daily goal reached: ${of}`;
  return h(
    'div',
    { class: `goal${met ? ' is-met' : ''}` },
    h('p', { class: 'goal-text' }, met && icon('check', 16), words),
    h(
      'div',
      {
        class: 'goal-bar',
        role: 'progressbar',
        'aria-label': 'Texts read today',
        'aria-valuemin': '0',
        'aria-valuemax': String(goal),
        'aria-valuenow': String(Math.min(done, goal)),
      },
      h('span', { style: `width: ${Math.min(100, (done / goal) * 100)}%` }),
    ),
  );
}

function renderSummary() {
  const parts = [];
  if (summary.credit) {
    parts.push(`${plural(summary.up, 'word')} reviewed${summary.due ? `, ${summary.due} of them due` : ''}`);
  } else parts.push('Text skipped, nothing counted as read');
  if (summary.hard) parts.push(`${plural(summary.hard, 'word')} marked hard`);
  if (summary.started) parts.push(`${plural(summary.started, 'new word')} started`);
  if (summary.goalMet) parts.push('Daily goal reached');
  return h('p', { class: 'notice is-good', role: 'status' }, icon('check', 18), parts.join(' · '));
}

// ---- writing a text -------------------------------------------------------

async function generate() {
  if (abort) return;
  const prefs = store.state.prefs;
  const length = LENGTHS[prefs.length] ? prefs.length : 'medium';
  const now = Date.now();
  const { list } = store.index;
  const earlyMax = earlyMaxOf(prefs);
  const targets = pickTargets(list, store.state.progress, LENGTHS[length].targets, {
    now,
    newLeft: store.newLeft(),
    earlyMax,
  });
  // More due words for Claude to work in where they fit; each one that makes it is a review.
  const extras = pickExtras(list, store.state.progress, targets, LENGTHS[length].extras, { now, earlyMax });

  summary = null;
  error = '';
  text = {
    title: '',
    level: prefs.level,
    form: FORMS[prefs.form] ? prefs.form : 'prose',
    length,
    targets: targets.map((t) => ({ id: t.entry.id, hard: t.hard, kind: t.kind })),
    extras: extras.map((e) => e.id),
    t0: now, // when the request was sent, for the Stats tab
    sentences: [],
    hard: {}, // word id -> its progress before it was flagged in this text
    tapped: {}, // word ids looked up in this text
    surfaces: {}, // lower-cased spellings that were tapped
    complete: false,
  };
  abort = new AbortController();
  watch = createStopwatch();
  render();
  window.scrollTo(0, 0);

  const mine = text;
  const stream = new SentenceStream();
  try {
    // The Claude SDK is most of the app's size, so it is fetched on first use.
    const { generateText } = await import('../claude.js').catch(() => {
      throw new Error('Could not load the text writer. Check your internet connection and try again.');
    });
    const used = await generateText({
      apiKey: store.local.apiKey,
      model: prefs.model,
      prompt: buildUserPrompt({
        level: prefs.level,
        length,
        topic: prefs.topic,
        form: prefs.form,
        targets,
        extras,
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
        if (fresh.length && text.wait == null) {
          // The first sentence is here: the wait is over and reading can begin.
          text.wait = Date.now() - text.t0;
          resumeWatch();
        }
        if (fresh.length) saveText();
      },
    });
    Object.assign(mine, { gen: Date.now() - mine.t0, ...used });
    if (!mine.sentences.length) throw new Error('Claude returned an empty text. Please try again.');
  } catch (err) {
    if (text !== mine) return;
    if (err.aborted || !mine.sentences.length) {
      text = null;
      watch = null;
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
  const tally = []; // what happened to each word, for the Stats tab
  let up = 0;
  let due = 0;
  for (const id of present) {
    const p = store.progressOf(id);
    const flagged = id in text.hard;
    const tapped = flagged || !!text.tapped[id] || tappedPhrase.has(id);
    if (flagged) updates[id] = seen(p, now);
    else if (tapped) updates[id] = credit ? hardRead(p, now, rules) : seen(p, now);
    else if (credit) {
      updates[id] = cleanRead(p, now, rules);
      up++;
      if (isDue(p, now)) due++;
    }
    // A word the list only has because it was looked up in this text is counted as a lookup outside the lists.
    if (credit && !text.added?.[id]) tally.push({ before: flagged ? text.hard[id] : p, tapped, after: updates[id] });
  }

  // New words that this text got going count towards today's allowance.
  const started = text.targets.filter(
    (t) => t.kind === 'new' && hasMemory(updates[t.id] || store.progressOf(t.id)),
  ).length;
  store.addIntroduced(started);

  summary = { credit, up, due, hard: Object.keys(text.hard).length, started };
  if (credit) {
    // A text that was read counts towards the daily goal and is kept for the History tab.
    const before = store.goal();
    store.addRead();
    summary.goalMet = !before.met && store.goal().met;
    store.addText({ title: text.title, level: text.level, sentences: text.sentences, hard: summary.hard });
  }
  // This text's numbers for the Stats tab: the request, and for a text that was read, the reading.
  const counts = { inTok: text.inTok, outTok: text.outTok };
  if (text.gen != null) {
    Object.assign(counts, { timed: 1, waitS: (text.wait ?? text.gen) / 1000, genS: text.gen / 1000 });
  }
  if (credit) {
    const extras = text.extras || [];
    Object.assign(counts, tallyWords(tally, now), {
      texts: 1,
      readS: (watch ? watch.ms() : 0) / 1000,
      words: text.sentences.reduce((n, s) => n + s.words.length, 0),
      tapOut: text.out,
      started,
      marked: summary.hard,
      targets: text.targets.length,
      targetsUsed: text.targets.filter((t) => present.has(t.id)).length,
      extras: extras.length,
      extrasUsed: extras.filter((id) => present.has(id)).length,
    });
  } else counts.skipped = 1;
  const key = textKey(text.level, text.length || store.state.prefs.length);

  rememberTitle(text.title);
  text = null;
  watch = null;
  saveText();
  store.setProgressMany(updates);
  store.addStats(key, counts);
  render();
  window.scrollTo(0, 0);
  store.syncNow();
}
