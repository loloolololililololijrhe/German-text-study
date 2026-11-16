import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELDS,
  KEEP_DAYS,
  SNAPSHOT,
  addRecord,
  bucket,
  createStopwatch,
  dayAdd,
  dayOf,
  daySpan,
  daysEnding,
  emptyStats,
  firstDay,
  kindBefore,
  lookupRates,
  lookupsOf,
  mergeStats,
  newDeviceId,
  reviewedOf,
  sanitizeStats,
  seriesOf,
  share,
  snapshotBefore,
  snapshotOf,
  stuckAbove,
  tallyWords,
  textKey,
  toCsv,
  totalsOf,
  zeroCounts,
} from '../src/lib/metrics.js';
import { cleanRead, markHard } from '../src/lib/scoring.js';
import { DAY } from '../src/lib/srs.js';

const NOW = Date.UTC(2026, 10, 16, 12);
const SNAP = { hard: 5, learning: 6, known: 7, new: 8, due: 2 };

const rec = (stats, day, device, counts, o = {}) =>
  addRecord(stats, { day, device, key: o.key || 'A2:long', counts, snapshot: o.snapshot, now: o.now || NOW });

test('the fields have distinct names, and new ones can only be added at the end', () => {
  assert.equal(new Set(FIELDS).size, FIELDS.length);
  // The stored rows are arrays in this order: changing it would misread old numbers.
  assert.deepEqual(FIELDS.slice(0, 7), ['texts', 'skipped', 'readS', 'timed', 'waitS', 'genS', 'words']);
  assert.deepEqual(SNAPSHOT, ['hard', 'learning', 'known', 'new', 'due']);
  assert.ok(Object.values(zeroCounts()).every((n) => n === 0));
});

test('a word is counted by what it was before the text', () => {
  const rules = {};
  const hard = markHard(null, NOW - DAY, rules);
  const learned = cleanRead(null, NOW - 30 * DAY, rules);
  const fresh = cleanRead(null, NOW - 60_000, rules);
  assert.equal(kindBefore(undefined, NOW), 'new');
  assert.equal(kindBefore(null, NOW), 'new');
  assert.equal(kindBefore({ s: 0, n: 2, l: 1, t: 0, u: 0 }, NOW), 'new', 'seen in a skipped text, never reviewed');
  assert.equal(kindBefore(hard, NOW), 'hard');
  assert.equal(kindBefore(learned, NOW), 'due');
  assert.equal(kindBefore(fresh, NOW), 'other');
});

test('the words of a text are tallied by kind, with the lookups and the hard words cleared', () => {
  const rules = { step: 1, maxHard: 1 };
  const hard = markHard(null, NOW - DAY, rules);
  const due = cleanRead(null, NOW - 30 * DAY, rules);
  const early = cleanRead(null, NOW - 60_000, rules);
  const got = tallyWords(
    [
      { before: null, tapped: true, after: markHard(null, NOW, rules) },
      { before: undefined, tapped: false, after: cleanRead(null, NOW, rules) },
      { before: hard, tapped: false, after: cleanRead(hard, NOW, rules) }, // cleared
      { before: hard, tapped: true, after: markHard(hard, NOW, rules) },
      { before: due, tapped: false, after: cleanRead(due, NOW, rules) },
      { before: due, tapped: true, after: markHard(due, NOW, rules) },
      { before: due, tapped: false, after: cleanRead(due, NOW, rules) },
      { before: early, tapped: false, after: cleanRead(early, NOW, rules) },
    ],
    NOW,
  );
  assert.deepEqual(got, {
    seenNew: 2,
    tapNew: 1,
    seenHard: 2,
    tapHard: 1,
    seenDue: 3,
    tapDue: 1,
    seenOther: 1,
    tapOther: 0,
    cleared: 1,
  });
  assert.deepEqual(tallyWords([], NOW), {
    seenNew: 0,
    tapNew: 0,
    seenHard: 0,
    tapHard: 0,
    seenDue: 0,
    tapDue: 0,
    seenOther: 0,
    tapOther: 0,
    cleared: 0,
  });
});

test('the word counts by status are taken over the listed words', () => {
  const hard = markHard(null, NOW, {});
  const due = cleanRead(null, NOW - 30 * DAY, {});
  const entries = [
    { id: 'a', priority: true },
    { id: 'b', priority: true },
    { id: 'c', priority: true },
    { id: 'd', priority: false },
  ];
  const got = snapshotOf(entries, { a: hard, b: due, d: due, gone: hard }, NOW);
  assert.deepEqual(got, { hard: 1, learning: 2, known: 0, new: 1, due: 1 });
});

test('texts add up within a day, device and kind of text', () => {
  let s = emptyStats();
  s = rec(s, '2026-11-16', 'ipad', { texts: 1, readS: 300.4, tapNew: 2, seenNew: 3 }, { snapshot: SNAP });
  s = rec(s, '2026-11-16', 'ipad', { texts: 1, readS: 200.4, tapNew: 1, seenNew: 1 }, { now: NOW + 1 });
  s = rec(s, '2026-11-16', 'ipad', { texts: 1, readS: 100 }, { key: 'A2:short', now: NOW + 2 });
  const d = dayOf(s, '2026-11-16');
  assert.equal(d.counts.texts, 3);
  assert.equal(d.counts.readS, 600, 'seconds are stored whole');
  assert.equal(d.counts.tapNew, 3);
  assert.equal(d.byKey['A2:long'].texts, 2);
  assert.equal(d.byKey['A2:short'].readS, 100);
  assert.deepEqual(d.snapshot, SNAP, 'the word counts stay until a later text replaces them');
  assert.equal(s.days['2026-11-16'].ipad.u, NOW + 2);
  assert.equal(dayOf(s, '2026-11-17'), null);
  assert.equal(firstDay(s), '2026-11-16');
  assert.equal(firstDay(emptyStats()), '');
});

test('two devices keep their own record of a day, and merging loses nothing', () => {
  let ipad = rec(emptyStats(), '2026-11-16', 'ipad', { texts: 2, seenHard: 10, tapHard: 4 }, { snapshot: SNAP });
  let phone = rec(
    emptyStats(),
    '2026-11-16',
    'phone',
    { texts: 1, seenHard: 5, tapHard: 1 },
    {
      snapshot: { ...SNAP, hard: 3 },
      now: NOW + 5,
    },
  );
  const merged = mergeStats(ipad, phone);
  assert.deepEqual(mergeStats(phone, ipad), merged, 'in either order');
  assert.deepEqual(mergeStats(merged, ipad), merged, 'and again');
  const d = dayOf(merged, '2026-11-16');
  assert.equal(d.counts.texts, 3);
  assert.equal(d.counts.seenHard, 15);
  assert.equal(d.snapshot.hard, 3, 'the word counts of whichever device read last');

  // The iPad reads another text, then syncs with a copy that has its older record.
  ipad = rec(merged, '2026-11-16', 'ipad', { texts: 1 }, { now: NOW + 9 });
  const again = mergeStats(merged, ipad);
  assert.equal(dayOf(again, '2026-11-16').counts.texts, 4, 'the newer copy of a device’s record wins');
  phone = rec(phone, '2026-11-17', 'phone', { texts: 1 }, { now: NOW + DAY });
  assert.deepEqual(Object.keys(mergeStats(again, phone).days).sort(), ['2026-11-16', '2026-11-17']);
});

test('clearing the numbers on one device clears them everywhere, but not later ones', () => {
  const before = rec(emptyStats(), '2026-11-16', 'ipad', { texts: 2 });
  const cleared = { ...emptyStats(), clearedAt: NOW + 10 };
  assert.deepEqual(mergeStats(before, cleared).days, {});
  const after = rec(emptyStats(), '2026-11-16', 'phone', { texts: 1 }, { now: NOW + 20 });
  const merged = mergeStats(mergeStats(before, cleared), after);
  assert.equal(merged.clearedAt, NOW + 10);
  assert.equal(dayOf(merged, '2026-11-16').counts.texts, 1);
});

test('stored numbers survive missing, partial and hostile input', () => {
  for (const bad of [undefined, null, 'x', 7, [], { days: 'x' }, { days: [] }]) {
    assert.deepEqual(sanitizeStats(bad), emptyStats());
  }
  const got = sanitizeStats({
    clearedAt: '5',
    days: {
      '2026-11-16': {
        ipad: { u: 9, t: { 'A2:long': [1, 'x', -3, 2.6], 'not a key': [1], 'B1:short': 'x' }, w: [1, 2, '3'] },
        'BAD DEVICE': { u: 9, t: { 'A2:long': [1] } },
        empty: { u: 9, t: {} },
        old: { u: 3, t: { 'A2:long': [1] } },
      },
      yesterday: { ipad: { u: 9, t: { 'A2:long': [1] } } },
      '2026-11-15': 'x',
    },
  });
  assert.deepEqual(Object.keys(got.days), ['2026-11-16']);
  assert.deepEqual(Object.keys(got.days['2026-11-16']), ['ipad'], 'bad names, empty and cleared records are dropped');
  const row = got.days['2026-11-16'].ipad.t['A2:long'];
  assert.equal(row.length, FIELDS.length, 'a short row is filled up, so fields can be added later');
  assert.deepEqual(row.slice(0, 4), [1, 0, 0, 3]);
  assert.deepEqual(got.days['2026-11-16'].ipad.w, [1, 2, 3, 0, 0]);
  assert.deepEqual(sanitizeStats(JSON.parse(JSON.stringify(got))), got, 'what is stored loads back unchanged');
});

test('only the most recent days are kept', () => {
  let s = emptyStats();
  const last = '2026-11-16';
  for (const day of [dayAdd(last, -KEEP_DAYS - 5), dayAdd(last, -KEEP_DAYS + 1), last])
    s = rec(s, day, 'ipad', { texts: 1 });
  assert.equal(Object.keys(s.days).length, 3);
  for (let i = 1; i < KEEP_DAYS; i++) s.days[dayAdd(last, -i)] ||= { ipad: { u: NOW, t: { 'A2:long': [1] } } };
  assert.equal(Object.keys(sanitizeStats(s).days).length, KEEP_DAYS);
  assert.equal(firstDay(sanitizeStats(s)), dayAdd(last, -KEEP_DAYS + 1));
});

test('days are counted on the calendar, across month ends and clock changes', () => {
  assert.equal(dayAdd('2026-11-30', 1), '2026-12-01');
  assert.equal(dayAdd('2026-03-01', -1), '2026-02-28');
  assert.equal(dayAdd('2026-03-28', 2), '2026-03-30', 'over the change to summer time');
  assert.equal(dayAdd('2026-10-24', 2), '2026-10-26', 'and back');
  assert.deepEqual(daysEnding('2026-11-02', 4), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(daySpan('2026-11-10', '2026-11-16'), 7);
  assert.equal(daySpan('2026-11-16', '2026-11-16'), 1);
  assert.equal(daySpan('2026-03-01', '2026-04-01'), 32);
});

test('a run of days adds up, and the word counts carry over days without reading', () => {
  let s = emptyStats();
  s = rec(s, '2026-11-13', 'ipad', { texts: 1, readS: 60 }, { snapshot: { ...SNAP, hard: 9 } });
  s = rec(s, '2026-11-14', 'ipad', { texts: 2, readS: 120 }, { snapshot: SNAP });
  s = rec(s, '2026-11-16', 'ipad', { skipped: 1 }, { key: 'B1:short' });
  const days = daysEnding('2026-11-16', 3);
  const t = totalsOf(s, days);
  assert.equal(t.counts.texts, 2);
  assert.equal(t.counts.skipped, 1);
  assert.equal(t.active, 1, 'a day with only a skipped text is not a day of reading');
  assert.deepEqual(Object.keys(t.byKey).sort(), ['A2:long', 'B1:short']);

  assert.equal(snapshotBefore(s, '2026-11-14').hard, 9);
  assert.equal(snapshotBefore(s, '2026-11-13'), null);
  const series = seriesOf(s, days, snapshotBefore(s, days[0]));
  assert.deepEqual(
    series.map((x) => [x.day, x.counts?.texts ?? null, x.snapshot?.hard ?? null]),
    [
      ['2026-11-14', 2, 5],
      ['2026-11-15', null, 5],
      ['2026-11-16', 0, 5],
    ],
  );
  assert.equal(seriesOf(s, ['2026-11-12'])[0].snapshot, null, 'nothing is known before the first text');

  const weeks = bucket(seriesOf(s, daysEnding('2026-11-16', 4), null), 2);
  assert.deepEqual(
    weeks.map((w) => [w.day, w.to, w.counts?.texts ?? null, w.snapshot?.hard]),
    [
      ['2026-11-13', '2026-11-14', 3, 5],
      ['2026-11-15', '2026-11-16', 0, 5],
    ],
  );
  assert.equal(bucket(series, 1), series);
});

test('lookup rates are shares of the words seen, and empty when there were none', () => {
  const c = { ...zeroCounts(), seenNew: 10, tapNew: 6, seenHard: 8, tapHard: 2, seenDue: 20, tapDue: 3, tapOut: 4 };
  const r = lookupRates(c);
  assert.deepEqual(r.new, { n: 6, of: 10, rate: 0.6 });
  assert.equal(r.hard.rate, 0.25);
  assert.equal(r.due.rate, 0.15);
  assert.deepEqual(r.other, { n: 0, of: 0, rate: null });
  assert.equal(lookupsOf(c), 15);
  assert.equal(reviewedOf(c), 38);
  assert.deepEqual(share(0, 0), { n: 0, of: 0, rate: null });
});

test('hard words get stuck above a lookup rate that depends on the hard-word settings', () => {
  assert.equal(stuckAbove(2, 4), 1 / 3, 'Thorough: a lookup costs two clean reads');
  assert.equal(stuckAbove(1, 2), 1 / 2, 'Balanced');
  assert.equal(stuckAbove(1, 1), null, 'Quick: one clean read always clears a word');
  assert.equal(stuckAbove(3, 3), null);
});

test('the numbers can be exported as a table with one row per day', () => {
  let s = rec(emptyStats(), '2026-11-15', 'ipad', { texts: 2, readS: 600 }, { snapshot: SNAP });
  s = rec(s, '2026-11-16', 'phone', { skipped: 1 });
  const lines = toCsv(s).trim().split('\n');
  assert.equal(lines.length, 3);
  const head = lines[0].split(',');
  assert.deepEqual(head.slice(0, 3), ['day', 'texts', 'skipped']);
  assert.deepEqual(head.slice(-5), ['words_hard', 'words_learning', 'words_known', 'words_new', 'words_due']);
  const first = lines[1].split(',');
  assert.equal(first.length, head.length);
  assert.deepEqual([first[0], first[1], first[head.indexOf('readS')], first.at(-5)], ['2026-11-15', '2', '600', '5']);
  assert.ok(
    lines[2].startsWith('2026-11-16,0,1,') && lines[2].endsWith(',,,,,'),
    'no word counts on a day without them',
  );
  assert.equal(toCsv(emptyStats()).trim().split('\n').length, 1);
});

test('texts are filed by level and length, and devices get a short name', () => {
  assert.equal(textKey('A2', 'long'), 'A2:long');
  assert.equal(textKey('B1', 'short'), 'B1:short');
  assert.equal(textKey(undefined, undefined), 'A2:medium');
  assert.equal(textKey('<script>', 'x y'), 'A2:medium');
  const id = newDeviceId();
  assert.match(id, /^[a-z0-9]{8}$/);
  assert.notEqual(newDeviceId(), id);
});

test('the stopwatch counts time while running and stops when nothing happens', () => {
  let t = 1_000;
  const w = createStopwatch({ idle: 180_000, clock: () => t });
  assert.equal(w.ms(), 0);
  assert.equal(w.running(), false);
  t += 5_000;
  w.touch();
  assert.equal(w.ms(), 0, 'nothing counts before it is started');

  w.start();
  t += 60_000;
  assert.equal(w.ms(), 60_000);
  w.touch();
  t += 400_000; // the learner walked away
  assert.equal(w.ms(), 60_000 + 180_000, 'at most the idle time after the last sign of life');
  w.touch(); // and came back
  t += 30_000;
  assert.equal(w.ms(), 60_000 + 180_000 + 30_000);

  w.pause();
  t += 600_000;
  assert.equal(w.ms(), 270_000, 'paused time does not count');
  assert.equal(w.running(), false);
  w.start();
  t += 10_000;
  w.pause();
  assert.equal(w.ms(), 280_000);
  w.pause();
  assert.equal(w.ms(), 280_000, 'pausing twice changes nothing');

  const resumed = createStopwatch({ clock: () => t, elapsed: 280_000 });
  resumed.start();
  t += 1_000;
  assert.equal(resumed.ms(), 281_000, 'a text reopened later carries its time');
});
