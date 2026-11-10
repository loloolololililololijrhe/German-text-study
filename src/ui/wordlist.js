// The Words tab: every word with its score, and the controls to correct it.

import { store } from '../store.js';
import { fill, h, icon, plural, timeAgo, toast } from './dom.js';
import { clearHard, markHard, markKnown, resetWord, statusOf } from '../lib/scoring.js';
import { tts } from '../tts.js';

const PAGE = 80;
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'hard', label: 'Hard' },
  { id: 'learning', label: 'Learning' },
  { id: 'known', label: 'Known' },
  { id: 'new', label: 'New' },
];
const STATUS_LABEL = { hard: 'Hard', learning: 'Learning', known: 'Known', new: 'New' };

let sheet;
let filter = 'all';
let query = '';
let limit = PAGE;
let statsEl;
let chipsEl;
let listEl;
let visible = false;

export function mountWords(root, options) {
  sheet = options.sheet;
  statsEl = h('div', { class: 'stats' });
  chipsEl = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  listEl = h('div', { class: 'wordlist' });
  fill(
    root,
    h('h1', { class: 'page-title' }, 'Words'),
    statsEl,
    h(
      'label',
      { class: 'search' },
      icon('search', 18),
      h('input', {
        type: 'search',
        placeholder: 'Search German or English',
        'aria-label': 'Search words',
        oninput: (e) => {
          query = e.target.value.trim().toLowerCase();
          limit = PAGE;
          update();
        },
      }),
    ),
    chipsEl,
    listEl,
  );
  store.subscribe((what) => {
    if (visible && (what === 'progress' || what === 'words')) update();
  });
}

export function showWords() {
  visible = true;
  update();
}

export function leaveWords() {
  visible = false;
}

function scoreLabel(s) {
  return s > 0 ? `+${s}` : s < 0 ? `−${-s}` : '0';
}

function update() {
  const rows = store.index.list.map((e) => {
    const p = store.progressOf(e.id);
    return { e, p, st: statusOf(p) };
  });
  const counts = { all: rows.length, hard: 0, learning: 0, known: 0, new: 0 };
  for (const r of rows) counts[r.st]++;
  const met = counts.all - counts.new;

  fill(
    statsEl,
    h(
      'div',
      { class: 'stat-row' },
      ['hard', 'learning', 'known', 'new'].map((st) =>
        h(
          'div',
          { class: `stat is-${st}` },
          h('span', { class: 'stat-n' }, counts[st].toLocaleString('en')),
          h('span', { class: 'stat-l' }, STATUS_LABEL[st]),
        ),
      ),
    ),
    h(
      'div',
      { class: 'meter', role: 'img', 'aria-label': `${met} of ${counts.all} words met` },
      h('span', { class: 'meter-known', style: `width:${pct(counts.known, counts.all)}%` }),
      h('span', { class: 'meter-learning', style: `width:${pct(counts.learning, counts.all)}%` }),
      h('span', { class: 'meter-hard', style: `width:${pct(counts.hard, counts.all)}%` }),
    ),
    h('p', { class: 'stat-note' }, `${met.toLocaleString('en')} of ${plural(counts.all, 'word')} met so far`),
  );

  fill(
    chipsEl,
    ...FILTERS.map((f) =>
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(filter === f.id),
          onclick: () => {
            filter = f.id;
            limit = PAGE;
            update();
          },
        },
        `${f.label} ${counts[f.id].toLocaleString('en')}`,
      ),
    ),
  );

  let shown = rows;
  if (filter !== 'all') shown = shown.filter((r) => r.st === filter);
  if (query) shown = shown.filter((r) => r.e.de.toLowerCase().includes(query) || r.e.en.toLowerCase().includes(query));
  // Hardest first when looking at hard words; otherwise most common first.
  shown.sort((a, b) => (filter === 'hard' ? (a.p?.s ?? 0) - (b.p?.s ?? 0) : 0) || a.e.rank - b.e.rank);

  if (!shown.length) {
    fill(listEl, h('p', { class: 'empty' }, emptyMessage()));
    return;
  }
  fill(
    listEl,
    h(
      'ul',
      { class: 'rows' },
      shown
        .slice(0, limit)
        .map((r) =>
          h(
            'li',
            null,
            h(
              'button',
              { class: 'row', type: 'button', onclick: () => openDetail(r.e.id) },
              h(
                'span',
                { class: 'row-text' },
                h('span', { class: 'row-de', lang: 'de' }, r.e.de),
                h('span', { class: 'row-en' }, r.e.en),
              ),
              h('span', { class: `pill is-${r.st}` }, STATUS_LABEL[r.st]),
              h('span', { class: `score is-${r.st}`, 'aria-label': `Score ${r.p?.s ?? 0}` }, scoreLabel(r.p?.s ?? 0)),
            ),
          ),
        ),
    ),
    shown.length > limit &&
      h(
        'button',
        {
          class: 'btn btn-quiet more',
          type: 'button',
          onclick: () => {
            limit += PAGE * 2;
            update();
          },
        },
        `Show more (${(shown.length - limit).toLocaleString('en')} left)`,
      ),
  );
}

function pct(n, total) {
  return total ? ((n / total) * 100).toFixed(2) : 0;
}

function emptyMessage() {
  if (query) return 'No words match that search.';
  if (filter === 'hard') return 'No hard words. Tap a word in a text to mark it.';
  if (filter === 'learning' || filter === 'known')
    return 'Nothing here yet. Finish a text and the words you read will appear.';
  return 'No words in this group.';
}

function openDetail(id) {
  const wrap = h('div', { class: 'ws' });
  const draw = () => {
    const e = store.index.byId.get(id);
    if (!e) return sheet.close();
    const p = store.progressOf(id);
    const st = statusOf(p);
    const now = Date.now();
    const set = (next) => {
      store.setProgress(id, next);
      draw();
    };

    const input = h('input', {
      class: 'input',
      type: 'text',
      value: e.en,
      'aria-label': 'English meaning',
      maxlength: '200',
    });
    const save = () => {
      const en = input.value.trim();
      if (!en || en === e.en) return;
      store.addCustom([{ de: e.de, en, src: e.src }]);
      toast('Meaning updated');
      draw();
    };
    input.addEventListener('keydown', (ev) => ev.key === 'Enter' && save());

    fill(
      wrap,
      h(
        'div',
        { class: 'ws-head' },
        h('span', { class: 'ws-word', lang: 'de' }, e.de),
        tts.supported &&
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              'aria-label': 'Listen',
              onclick: () => tts.speak([e.de], { rate: store.state.prefs.rate, voice: store.local.voice }),
            },
            icon('speaker'),
          ),
      ),
      h('div', { class: 'edit-row' }, input, h('button', { class: 'btn', type: 'button', onclick: save }, 'Save')),
      h(
        'p',
        { class: 'wd-meta' },
        h('span', { class: `pill is-${st}` }, STATUS_LABEL[st]),
        ` Score ${scoreLabel(p?.s ?? 0)} · seen ${plural(p?.n ?? 0, 'time')} · looked up ${plural(p?.l ?? 0, 'time')}`,
        p?.t ? ` · last seen ${timeAgo(p.t)}` : '',
      ),
      h('p', { class: 'wd-src' }, `From: ${e.src}`),
      h(
        'div',
        { class: 'ws-actions' },
        st === 'hard'
          ? h(
              'button',
              { class: 'btn', type: 'button', onclick: () => set(clearHard(p, now)) },
              icon('check', 18),
              'I know this now',
            )
          : h(
              'button',
              { class: 'btn btn-hard', type: 'button', onclick: () => set(markHard(p, now)) },
              icon('flag', 18),
              'Mark as hard',
            ),
        st !== 'known' &&
          h('button', { class: 'btn', type: 'button', onclick: () => set(markKnown(p, now)) }, 'Mark as known'),
        st !== 'new' &&
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => set(resetWord(now)) }, 'Reset'),
      ),
    );
  };
  draw();
  sheet.open(wrap);
}
