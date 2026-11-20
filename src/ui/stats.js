// The Stats tab: what the app has measured about the learner's reading.

import { store } from '../store.js';
import { fill, h, plural, segmented, toast } from './dom.js';
import { timeChart } from './chart.js';
import { tuneCard } from './tune.js';
import { textGoalOf } from '../lib/goal.js';
import {
  bucket,
  daySpan,
  daysEnding,
  firstDay,
  lookupRates,
  lookupsOf,
  reviewedOf,
  seriesOf,
  share,
  snapshotBefore,
  stuckAbove,
  toCsv,
  totalsOf,
} from '../lib/metrics.js';
import { LENGTHS } from '../lib/prompt.js';
import { hardStepOf, maxHardOf } from '../lib/scoring.js';
import { dayKey, retentionOf } from '../lib/srs.js';

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: 'all', label: 'All' },
];

/** Beyond this many days a chart shows weeks instead of days. */
const MAX_POINTS = 62;

/** The word statuses in the order their colours were checked to be told apart. */
const STATUSES = [
  { id: 'learning', name: 'Learning', color: 'var(--viz-1)' },
  { id: 'hard', name: 'Hard', color: 'var(--viz-2)' },
  { id: 'known', name: 'Known', color: 'var(--viz-3)' },
  { id: 'new', name: 'New', color: 'var(--viz-4)' },
];

let root;
let range = '7';
let showing = false;
let charts = [];

export function mountStats(el) {
  root = el;
  store.subscribe((what) => {
    if (showing && (what === 'stats' || what === 'words' || what === 'prefs')) render();
  });
}

export function showStats() {
  showing = true;
  render();
}

export function leaveStats() {
  showing = false;
}

// ---- wording ---------------------------------------------------------------

const num = (n) => Math.round(n).toLocaleString('en');
const one = (n) => (Math.round(n * 10) / 10).toLocaleString('en');
const pct = (rate) => `${Math.round(rate * 100)}%`;
const per = (n, of) => (of > 0 ? n / of : 0);

function duration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const tokens = (n) => (n >= 1e6 ? `${one(n / 1e6)}M` : n >= 1000 ? `${one(n / 1000)}K` : num(n));

function dateOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
const shortDay = (day) => dateOf(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const longDay = (day) => dateOf(day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** "A2:long" as "A2 · Long". */
function kindName(key) {
  const [level, length] = key.split(':');
  return `${level} · ${LENGTHS[length]?.label || length}`;
}

// ---- pieces ----------------------------------------------------------------

function card(title, ...children) {
  return h('section', { class: 'card' }, h('h2', { class: 'card-title' }, title), ...children);
}

function tile(label, value, sub) {
  return h(
    'div',
    { class: 'kpi' },
    h('span', { class: 'kpi-l' }, label),
    h('span', { class: 'kpi-v' }, value),
    sub && h('span', { class: 'kpi-s' }, sub),
  );
}

/** One row of a list of shares: a name, a bar and the figure. */
function ratio(name, { n, of, rate }, figure) {
  return h(
    'li',
    { class: 'ratio' },
    h('span', { class: 'ratio-name' }, name),
    h('span', { class: 'ratio-figure' }, rate == null ? 'no words yet' : figure),
    h(
      'span',
      {
        class: 'ratio-bar',
        role: 'meter',
        'aria-label': name,
        'aria-valuemin': '0',
        'aria-valuemax': String(of),
        'aria-valuenow': String(n),
      },
      h('span', { style: `width:${rate == null ? 0 : Math.min(100, rate * 100)}%` }),
    ),
  );
}

/** A table of numbers. The first column names the row; `text` lists further columns that hold words, not numbers. */
function table(head, rows, label, text = []) {
  const cls = (i) => (text.includes(i) ? 'is-text' : null);
  return h(
    'div',
    { class: 'num-scroll' },
    h(
      'table',
      { class: 'num-table', 'aria-label': label },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          head.map((x, i) => h('th', { scope: 'col', class: cls(i) }, x)),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            null,
            r.map((x, i) => (i ? h('td', { class: cls(i) }, x) : h('th', { scope: 'row' }, x))),
          ),
        ),
      ),
    ),
  );
}

function addChart(options) {
  const chart = timeChart(options);
  charts.push(chart);
  return chart.el;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- the page --------------------------------------------------------------

function render() {
  for (const c of charts) c.destroy();
  charts = [];

  const stats = store.stats;
  const prefs = store.state.prefs;
  const today = dayKey(Date.now());
  const first = firstDay(stats);
  const span = range === 'today' ? 1 : range === 'all' ? Math.max(1, first ? daySpan(first, today) : 1) : Number(range);
  const days = daysEnding(today, span);
  const { counts: c, byKey, active } = totalsOf(stats, days);
  const hasAny = !!first;

  const picker = segmented(
    RANGES,
    range,
    (id) => {
      range = id;
      render();
    },
    'Days shown',
  );

  fill(
    root,
    h('h1', { class: 'page-title' }, 'Stats'),
    picker,
    !hasAny &&
      h(
        'p',
        { class: 'notice' },
        'No numbers yet. From the next text you finish, the app keeps count of your reading time, your lookups, and how your words move between new, hard, learning and known.',
      ),
    hasAny && tiles(c, active, span),
    hasAny && tuneCard(),
    hasAny && lookupCard(c, prefs),
    hasAny && range !== 'today' && wordsCard(stats, days),
    hasAny && range !== 'today' && daysCard(stats, days, prefs),
    hasAny && kindsCard(byKey),
    hasAny && writerCard(c),
    leechCard(),
    hasAny && tableCard(stats, days),
  );
}

function tiles(c, active, span) {
  const lookups = lookupsOf(c);
  const reviewed = reviewedOf(c);
  return h(
    'div',
    { class: 'kpis' },
    tile(
      'Texts read',
      num(c.texts),
      span > 1
        ? `on ${plural(active, 'day')} of ${span}${c.skipped ? ` · ${c.skipped} skipped` : ''}`
        : c.skipped
          ? `${c.skipped} skipped`
          : '',
    ),
    tile('Reading time', duration(c.readS), c.texts ? `${duration(per(c.readS, c.texts))} a text` : ''),
    tile('Words reviewed', num(reviewed), c.texts ? `${num(per(reviewed, c.texts))} a text` : ''),
    tile('Words looked up', num(lookups), c.texts ? `${one(per(lookups, c.texts))} a text` : ''),
    tile('New words started', num(c.started), c.texts ? `${one(per(c.started, c.texts))} a text` : ''),
    tile('Hard words cleared', num(c.cleared), `${num(c.marked)} marked hard`),
  );
}

function lookupCard(c, prefs) {
  const r = lookupRates(c);
  const step = hardStepOf(prefs);
  const limit = stuckAbove(step, maxHardOf(prefs));
  const figure = (x, what) => `${pct(x.rate)} ${what} · ${num(x.n)} of ${num(x.of)}`;
  return card(
    'How often you looked a word up',
    h(
      'ul',
      { class: 'ratios' },
      ratio('New words', r.new, r.new.rate != null && figure(r.new, 'looked up on first sight')),
      ratio('Hard words', r.hard, r.hard.rate != null && figure(r.hard, 'looked up again')),
      ratio('Due words', r.due, r.due.rate != null && figure(r.due, 'looked up')),
      ratio('Words not due yet', r.other, r.other.rate != null && figure(r.other, 'looked up')),
    ),
    h(
      'ul',
      { class: 'help-list' },
      h(
        'li',
        null,
        limit == null
          ? 'Hard words: with your hard-word settings, one clean read always clears a hard word.'
          : `Hard words: with your hard-word settings they get stuck when this is above about ${pct(limit)}, because each lookup then adds more clean reads than the clean reads take away. A quicker preset in Settings raises that point.`,
      ),
      h(
        'li',
        null,
        r.due.rate == null
          ? `Due words: the schedule aims for you to still know ${pct(retentionOf(prefs))} of them.`
          : `Due words: you still knew ${pct(1 - r.due.rate)} of them. The schedule aims for ${pct(retentionOf(prefs))}; if you are well below it, the words are coming back too late for you.`,
      ),
      c.tapOut > 0 &&
        h(
          'li',
          null,
          `You also looked up ${plural(c.tapOut, 'word')} that ${c.tapOut === 1 ? 'is' : 'are'} in none of your lists.`,
        ),
    ),
  );
}

function wordsCard(stats, days) {
  const size = days.length > MAX_POINTS ? 7 : 1;
  const series = bucket(seriesOf(stats, days, snapshotBefore(stats, days[0])), size);
  const known = series.filter((x) => x.snapshot);
  if (known.length < 2) {
    return card(
      'Your words',
      h(
        'p',
        { class: 'help' },
        'Charts of your hard, learning, known and new words appear here once there are two days to compare.',
      ),
    );
  }
  const [from, to] = [known[0], known.at(-1)];
  const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : 'no change');
  const points = series.map((x) => ({ label: shortDay(x.to || x.day), long: longDay(x.to || x.day) }));
  const line = (st) => ({ name: st.name, color: st.color, values: series.map((x) => x.snapshot?.[st.id] ?? null) });
  const each = size > 1 ? 'week by week' : 'day by day';
  // The words not met yet are far more than the others to begin with, so they
  // get a chart of their own instead of flattening the other three lines.
  const met = STATUSES.filter((st) => st.id !== 'new');
  const fresh = STATUSES.find((st) => st.id === 'new');
  return card(
    'Your words',
    addChart({ title: `Words you have met, ${each}`, kind: 'line', points, series: met.map(line), height: 190 }),
    addChart({
      title: `New words still to come: ${num(to.snapshot.new)}`,
      kind: 'line',
      points,
      series: [{ ...line(fresh), name: 'new words' }],
      height: 120,
    }),
    h(
      'p',
      { class: 'help' },
      `Since ${shortDay(from.to || from.day)}: `,
      STATUSES.map((st) => `${st.name.toLowerCase()} ${signed(to.snapshot[st.id] - from.snapshot[st.id])}`).join(' · '),
      '.',
    ),
  );
}

function daysCard(stats, days, prefs) {
  const weekly = days.length > MAX_POINTS;
  const series = bucket(seriesOf(stats, days), weekly ? 7 : 1);
  const points = series.map((x) => ({
    label: shortDay(x.day),
    long: weekly ? `Week from ${shortDay(x.day)}` : longDay(x.day),
  }));
  const goal = textGoalOf(prefs);
  const values = (pick) => series.map((x) => (x.counts ? pick(x.counts) : null));
  const each = weekly ? 'each week' : 'each day';
  return card(
    weekly ? 'Week by week' : 'Day by day',
    addChart({
      title: `Texts read ${each}`,
      points,
      series: [{ name: 'texts', color: 'var(--accent)', values: values((c) => c.texts) }],
      goal: goal && !weekly ? { value: goal, label: `Goal ${goal}` } : null,
      height: 130,
    }),
    addChart({
      title: `Minutes of reading ${each}`,
      points,
      series: [{ name: 'minutes', color: 'var(--accent)', values: values((c) => Math.round(c.readS / 60)) }],
      height: 130,
    }),
    addChart({
      title: `Words looked up in each text, ${weekly ? 'weekly average' : 'daily average'}`,
      points,
      series: [
        {
          name: 'lookups a text',
          color: 'var(--accent)',
          values: values((c) => (c.texts ? Math.round(per(lookupsOf(c), c.texts) * 10) / 10 : null)),
        },
      ],
      format: one,
      whole: false,
      height: 130,
    }),
  );
}

function kindsCard(byKey) {
  const rows = Object.entries(byKey)
    .filter(([, c]) => c.texts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, c]) => [
      kindName(key),
      num(c.texts),
      one(per(c.readS / 60, c.texts)),
      num(per(reviewedOf(c), c.texts)),
      one(per(lookupsOf(c), c.texts)),
      one(per(reviewedOf(c), c.readS / 60)),
    ]);
  if (!rows.length) return null;
  return card(
    'By kind of text',
    table(
      ['Level and length', 'Texts', 'Minutes a text', 'Reviewed a text', 'Lookups a text', 'Reviewed a minute'],
      rows,
      'Numbers by level and length of text',
    ),
    h(
      'p',
      { class: 'help' },
      'Reviewed is the number of your words in a text. Reviewed a minute shows which length gets you through the most words for the time you spend.',
    ),
  );
}

function writerCard(c) {
  const written = c.texts + c.skipped;
  if (!written) return null;
  const used = share(c.targetsUsed, c.targets);
  const extra = share(c.extrasUsed, c.extras);
  const facts = [];
  if (c.timed) {
    facts.push(
      `First sentence after ${duration(per(c.waitS, c.timed))}, whole text after ${duration(per(c.genS, c.timed))}`,
    );
  }
  if (c.inTok + c.outTok) {
    facts.push(`${tokens(per(c.inTok, written))} tokens sent and ${tokens(per(c.outTok, written))} written a text`);
    facts.push(`${tokens(c.inTok + c.outTok)} tokens in all`);
  }
  return card(
    'The texts Claude wrote',
    h(
      'ul',
      { class: 'ratios' },
      ratio('Required words used', used, used.rate != null && `${pct(used.rate)} · ${num(used.n)} of ${num(used.of)}`),
      ratio(
        'Optional due words used',
        extra,
        extra.rate != null && `${pct(extra.rate)} · ${num(extra.n)} of ${num(extra.of)}`,
      ),
    ),
    facts.length > 0 && h('p', { class: 'help' }, facts.join(' · '), '.'),
  );
}

/** The words looked up most often, from the progress the app already keeps for every word. */
function leechCard() {
  const rows = [];
  for (const e of store.index.list) {
    const p = store.progressOf(e.id);
    if (p && p.l > 0) rows.push({ e, p });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.p.l - a.p.l || b.p.n - a.p.n || a.e.rank - b.e.rank);
  return card(
    'Words you look up most',
    table(
      ['Word', 'Meaning', 'Lookups', 'Times in a text'],
      rows.slice(0, 10).map(({ e, p }) => [e.de, e.en, num(p.l), num(p.n)]),
      'The ten words looked up most often',
      [1],
    ),
    h('p', { class: 'help' }, 'Counted since you started using the app, whichever days are shown above.'),
  );
}

function tableCard(stats, days) {
  const series = seriesOf(stats, days, snapshotBefore(stats, days[0]))
    .filter((x) => x.counts)
    .reverse();
  const rows = series.map(({ day, counts: c, snapshot: w }) => [
    shortDay(day),
    num(c.texts),
    num(c.readS / 60),
    num(reviewedOf(c)),
    num(lookupsOf(c)),
    num(c.started),
    num(c.cleared),
    w ? num(w.hard) : '',
    w ? num(w.learning) : '',
    w ? num(w.known) : '',
    w ? num(w.new) : '',
  ]);
  return card(
    'Every day as a table',
    rows.length
      ? h(
          'details',
          { class: 'num-details' },
          h('summary', null, `Show the numbers of ${plural(rows.length, 'day')}`),
          table(
            [
              'Day',
              'Texts',
              'Minutes',
              'Reviewed',
              'Looked up',
              'New started',
              'Hard cleared',
              'Hard',
              'Learning',
              'Known',
              'New',
            ],
            rows,
            'The numbers of each day',
          ),
        )
      : h('p', { class: 'help' }, 'No reading on the days shown.'),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => download(`german-text-study-${dayKey(Date.now())}.csv`, toCsv(stats)),
        },
        'Download everything (CSV)',
      ),
      h(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          onclick: () => {
            if (
              !confirm(
                'Delete all the numbers on the Stats tab, on every synced device? Your words and their progress are kept.',
              )
            )
              return;
            store.clearStats();
            toast('The numbers were deleted');
          },
        },
        'Delete the numbers',
      ),
    ),
    h(
      'p',
      { class: 'help' },
      'The file has one row per day with every number the app keeps, for a spreadsheet. The numbers are stored with your progress and sync the same way.',
    ),
  );
}
