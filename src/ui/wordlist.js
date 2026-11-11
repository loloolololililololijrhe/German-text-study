// The Words tab: every word with where it stands on the schedule, and the
// controls to correct it.

import { store } from '../store.js';
import { fill, h, icon, plural, timeAgo, toast } from './dom.js';
import { clearHard, intervalOf, isDue, markHard, markKnown, resetWord, rulesOf, statusOf } from '../lib/scoring.js';
import { DAY, hasMemory, recallChance } from '../lib/srs.js';
import { tts } from '../tts.js';

const PAGE = 80;
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'due', label: 'Due' },
  { id: 'hard', label: 'Hard' },
  { id: 'learning', label: 'Learning' },
  { id: 'known', label: 'Known' },
  { id: 'new', label: 'New' },
];
const STATUS_LABEL = { hard: 'Hard', learning: 'Learning', known: 'Known', new: 'New' };

/** A length of time in days, written short: "3 d", "5 wk", "4 mo", "1.5 y". */
function span(days) {
  if (days < 1) return 'today';
  if (days < 14) return `${Math.round(days)} d`;
  if (days < 56) return `${Math.round(days / 7)} wk`;
  if (days < 700) return `${Math.round(days / 30.4)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

/** When a word comes back, for the right-hand column of the list. */
function whenLabel(r, now) {
  if (r.st === 'new') return '\u2013';
  if (r.st === 'hard') return `${-r.p.s} to go`;
  return r.p.due <= now ? 'due' : span((r.p.due - now) / DAY);
}

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

function update() {
  const now = Date.now();
  const rows = store.index.list.map((e) => {
    const p = store.progressOf(e.id);
    // "Due" counts the words a text can be written around: your own deck.
    return { e, p, st: statusOf(p), due: e.priority && isDue(p, now) };
  });
  const counts = { all: rows.length, due: 0, hard: 0, learning: 0, known: 0, new: 0 };
  for (const r of rows) {
    counts[r.st]++;
    if (r.due) counts.due++;
  }
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
    h(
      'p',
      { class: 'stat-note' },
      `${counts.due.toLocaleString('en')} due now · ${met.toLocaleString('en')} of ${plural(counts.all, 'word')} met so far`,
    ),
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
  if (filter === 'due') shown = shown.filter((r) => r.due);
  else if (filter !== 'all') shown = shown.filter((r) => r.st === filter);
  if (query) shown = shown.filter((r) => r.e.de.toLowerCase().includes(query) || r.e.en.toLowerCase().includes(query));
  // Due words: the most forgotten first. Hard words: the hardest first. Otherwise deck order.
  const order =
    filter === 'due'
      ? (a, b) => recallChance(a.p, now) - recallChance(b.p, now)
      : filter === 'hard'
        ? (a, b) => a.p.s - b.p.s
        : () => 0;
  shown.sort((a, b) => order(a, b) || a.e.rank - b.e.rank);

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
              h('span', { class: `when is-${r.st}${r.due ? ' is-due' : ''}` }, whenLabel(r, now)),
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
  if (filter === 'due') return 'Nothing is due right now.';
  if (filter === 'hard') return 'No hard words. Tap a word in a text to mark it.';
  if (filter === 'learning' || filter === 'known')
    return 'Nothing here yet. Finish a text and the words you read will appear.';
  return 'No words in this group.';
}

/** One line saying where a word stands on the schedule. */
function schedule(p, st, now) {
  if (st === 'new') return 'Not met yet.';
  if (st === 'hard') {
    return `Needs ${plural(-p.s, 'clean read')} before it goes back on the schedule.`;
  }
  const gap = `interval ${span(intervalOf(p))}`;
  return p.due <= now ? `Due now · ${gap}` : `Due in ${span((p.due - now) / DAY)} · ${gap}`;
}

function openDetail(id) {
  const wrap = h('div', { class: 'ws' });
  const draw = () => {
    const e = store.index.byId.get(id);
    if (!e) return sheet.close();
    const p = store.progressOf(id);
    const st = statusOf(p);
    const now = Date.now();
    const rules = rulesOf(store.state.prefs);
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
      h('p', { class: 'wd-meta' }, h('span', { class: `pill is-${st}` }, STATUS_LABEL[st]), ' ', schedule(p, st, now)),
      hasMemory(p) &&
        h(
          'p',
          { class: 'wd-src' },
          `Memory strength ${span(p.S)} · difficulty ${p.D.toFixed(1)} of 10 · recall chance now ${Math.round(recallChance(p, now) * 100)}%`,
        ),
      h(
        'p',
        { class: 'wd-src' },
        `Seen ${plural(p?.n ?? 0, 'time')} · looked up ${plural(p?.l ?? 0, 'time')}`,
        p?.t ? ` · last reviewed ${timeAgo(p.t)}` : '',
      ),
      h('p', { class: 'wd-src' }, `From: ${e.src}`),
      h(
        'div',
        { class: 'ws-actions' },
        st === 'hard'
          ? h(
              'button',
              { class: 'btn', type: 'button', onclick: () => set(clearHard(p, now, rules)) },
              icon('check', 18),
              'I know this now',
            )
          : h(
              'button',
              {
                class: 'btn btn-hard',
                type: 'button',
                onclick: () => set(markHard(p, now, rules)),
              },
              icon('flag', 18),
              'Mark as hard',
            ),
        st !== 'known' &&
          h('button', { class: 'btn', type: 'button', onclick: () => set(markKnown(p, now, rules)) }, 'Mark as known'),
        st !== 'new' &&
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => set(resetWord(now)) }, 'Reset'),
      ),
    );
  };
  draw();
  sheet.open(wrap);
}
