import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS_KEPT,
  TUNABLE,
  TUNE_SCHEMA,
  TUNE_SYSTEM,
  buildTuneRequest,
  changedKeys,
  cleanSettings,
  describeSettings,
  makePreset,
  readAdvice,
  sameSettings,
  sanitizePresets,
  settingsOf,
  showValue,
  tuningInUse,
  withPreset,
  withoutPreset,
} from '../src/lib/tune.js';
import { DEFAULT_PREFS, emptyState, mergeStates, sanitizeState } from '../src/lib/merge.js';
import { addRecord, emptyStats } from '../src/lib/metrics.js';
import { levelResult } from '../src/lib/leveltest.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const BASE = settingsOf(DEFAULT_PREFS);

// ---- the settings that can be tuned --------------------------------------------

test('the tunable settings are read from the preferences, with the defaults for anything missing', () => {
  assert.deepEqual(BASE, {
    level: 'A2',
    length: 'medium',
    newPerDay: 15,
    retention: 0.88,
    hardStep: 2,
    maxHard: 4,
    earlyMax: 5,
    autoHard: true,
    textsPerDay: 0,
  });
  assert.deepEqual(settingsOf({}), BASE);
  assert.deepEqual(settingsOf(undefined), BASE);
  assert.deepEqual(
    TUNABLE.map((t) => t.key),
    Object.keys(BASE),
  );
  const mine = settingsOf({
    level: 'B1',
    length: 'long',
    newPerDay: 5,
    earlyMax: -1,
    autoHard: false,
    hardStep: 9,
    maxHard: 2,
  });
  assert.equal(mine.level, 'B1');
  assert.equal(mine.earlyMax, -1, 'no limit is kept as -1');
  assert.equal(mine.autoHard, false);
  assert.equal(mine.hardStep, 2, 'the step never exceeds the limit');
  assert.equal(settingsOf({ level: 'Z9', length: 'huge' }).level, 'A2');
});

test('every setting has allowed values that include its default', () => {
  for (const t of TUNABLE) {
    assert.ok(t.choices.includes(BASE[t.key]), t.key);
    assert.ok(t.label && typeof t.show(BASE[t.key]) === 'string', t.key);
  }
});

test('values are written the way the Settings tab writes them', () => {
  assert.equal(showValue('retention', 0.88), '88%');
  assert.equal(showValue('length', 'long'), 'Long');
  assert.equal(showValue('newPerDay', 0), 'none');
  assert.equal(showValue('hardStep', 1), '1 clean read');
  assert.equal(showValue('maxHard', 4), '4 clean reads');
  assert.equal(showValue('earlyMax', -1), 'no limit');
  assert.equal(showValue('earlyMax', 0), 'none');
  assert.equal(showValue('autoHard', false), 'off');
  assert.equal(showValue('textsPerDay', 0), 'no goal');
  assert.equal(showValue('textsPerDay', 1), '1 text a day');
  assert.equal(
    describeSettings(BASE),
    'A2 · Medium · 15 new a day · 88% · hard words 2/4 · 5 early · taps mark hard · no goal',
  );
});

test('a set of settings from outside is held to the allowed values', () => {
  const got = cleanSettings(
    {
      level: 'B1',
      length: 'enormous',
      newPerDay: '10',
      retention: '0.9',
      hardStep: '3',
      maxHard: '2',
      earlyMax: '-1',
      autoHard: 'false',
      textsPerDay: 4,
      extra: 'ignored',
    },
    BASE,
  );
  assert.deepEqual(got, {
    level: 'B1',
    length: 'medium', // not a length: the base value stays
    newPerDay: 10,
    retention: 0.9,
    hardStep: 2, // brought down to the limit
    maxHard: 2,
    earlyMax: -1,
    autoHard: false,
    textsPerDay: 3, // the nearest allowed goal
  });
  assert.deepEqual(cleanSettings(null, BASE), BASE);
  assert.deepEqual(cleanSettings('nonsense', BASE), BASE);
  assert.deepEqual(cleanSettings({ newPerDay: 'lots', retention: null, autoHard: 'maybe', earlyMax: '' }, BASE), BASE);
  assert.equal(cleanSettings({ newPerDay: 1000 }, BASE).newPerDay, 50, 'the nearest allowed number');
  assert.equal(cleanSettings({ retention: 0.5 }, BASE).retention, 0.8);
  assert.equal(cleanSettings({ earlyMax: 7 }, BASE).earlyMax, 5);
  assert.equal(cleanSettings({ earlyMax: -40 }, BASE).earlyMax, -1);
});

test('two sets are compared setting by setting', () => {
  const other = { ...BASE, newPerDay: 10, hardStep: 1 };
  assert.deepEqual(changedKeys(BASE, other), ['newPerDay', 'hardStep']);
  assert.equal(sameSettings(BASE, { ...BASE }), true);
  assert.equal(sameSettings(BASE, other), false);
});

// ---- saved sets ------------------------------------------------------------------

test('a saved set has a name with the time, and keeps only valid settings', () => {
  const p = makePreset({
    label: 'AI tuning',
    by: 'ai',
    settings: { ...BASE, newPerDay: 10 },
    now: NOW,
    why: 'Because.',
    prev: 'x1',
  });
  assert.match(p.name, /^AI tuning · 20 Nov, \d\d:\d\d$/);
  assert.equal(p.at, NOW);
  assert.equal(p.by, 'ai');
  assert.equal(p.settings.newPerDay, 10);
  assert.deepEqual([p.why, p.prev], ['Because.', 'x1']);
  assert.notEqual(makePreset({ label: 'x', by: 'you', settings: BASE, now: NOW }).id, p.id);
  assert.equal(
    makePreset({ label: 'x', by: 'you', settings: BASE, now: NOW, prev: 'x1' }).prev,
    '',
    'only a set from Claude points back',
  );
});

test('sets are listed newest first, can be removed, and only so many are kept', () => {
  const a = makePreset({ label: 'A', by: 'you', settings: BASE, now: NOW });
  const b = makePreset({ label: 'B', by: 'before', settings: BASE, now: NOW + 5 });
  let list = withPreset(withPreset([], a), b);
  assert.deepEqual(
    list.map((p) => p.id),
    [b.id, a.id],
  );
  assert.deepEqual(withPreset(list, a), list, 'the same set is not added twice');
  assert.deepEqual(
    withoutPreset(list, b.id).map((p) => p.id),
    [a.id],
  );
  for (let i = 0; i < PRESETS_KEPT + 4; i++) {
    list = withPreset(list, makePreset({ label: `N${i}`, by: 'you', settings: BASE, now: NOW + 10 + i }));
  }
  assert.equal(list.length, PRESETS_KEPT);
  assert.ok(!list.some((p) => p.id === a.id), 'the oldest go first');
});

test('saved sets survive missing, partial and hostile input', () => {
  for (const bad of [undefined, null, 'x', 7, {}, [null, 'x', {}, { id: '' }, { name: 'no id' }]]) {
    assert.deepEqual(sanitizePresets(bad), []);
  }
  const [got] = sanitizePresets([
    { id: 'p1', name: 5, at: 'x', by: 'robot', settings: { level: 'B1', newPerDay: 'many' }, why: 9, prev: 'q' },
  ]);
  assert.deepEqual(got, {
    id: 'p1',
    name: 'Saved settings',
    at: 0,
    by: 'you',
    settings: { ...BASE, level: 'B1' },
    why: '',
    prev: '',
  });
  const p = makePreset({ label: 'AI tuning', by: 'ai', settings: BASE, now: NOW, why: 'w', prev: 'z' });
  assert.deepEqual(sanitizePresets(JSON.parse(JSON.stringify([p]))), [p], 'what is stored loads back unchanged');
});

test('saved sets travel with the preferences when devices sync', () => {
  assert.deepEqual(DEFAULT_PREFS.presets, []);
  assert.deepEqual(sanitizeState({ prefs: {} }).prefs.presets, []);
  assert.deepEqual(sanitizeState({ prefs: { presets: 'x' } }).prefs.presets, []);
  const p = makePreset({ label: 'My settings', by: 'you', settings: BASE, now: NOW });
  const a = { ...emptyState(), prefs: { ...DEFAULT_PREFS, presets: [p], u: 5 } };
  const b = { ...emptyState(), prefs: { ...DEFAULT_PREFS, u: 1 } };
  assert.deepEqual(mergeStates(a, b).prefs.presets, [p], 'the newer preferences win, sets included');
  assert.deepEqual(sanitizeState(JSON.parse(JSON.stringify(mergeStates(a, b)))).prefs.presets, [p]);
  const deleted = { ...emptyState(), prefs: { ...DEFAULT_PREFS, presets: [], u: 9 } };
  assert.deepEqual(mergeStates(a, deleted).prefs.presets, [], 'so a set deleted on one device is gone on the other');
});

test('the set from Claude that is in use can be traced back to the settings before it', () => {
  const before = makePreset({ label: 'Before AI tuning', by: 'before', settings: BASE, now: NOW });
  const tuned = { ...BASE, newPerDay: 10 };
  const ai = makePreset({ label: 'AI tuning', by: 'ai', settings: tuned, now: NOW + 1, prev: before.id });
  const list = withPreset(withPreset([], before), ai);
  assert.deepEqual(tuningInUse(list, tuned), { ai: list[0], before: list[1] });
  assert.equal(tuningInUse(list, BASE), null, 'not while other settings are in use');
  assert.equal(tuningInUse(withoutPreset(list, before.id), tuned), null, 'nor when the earlier set was deleted');
  assert.equal(tuningInUse([], tuned), null);
});

// ---- the request ------------------------------------------------------------------

function someStats() {
  let s = emptyStats();
  const day = (d, counts, snapshot) => {
    s = addRecord(s, { day: d, device: 'ipad', key: 'A2:long', counts, snapshot, now: NOW });
  };
  day(
    '2026-11-18',
    {
      texts: 2,
      readS: 1200,
      words: 540,
      seenNew: 10,
      tapNew: 6,
      seenHard: 20,
      tapHard: 9,
      seenDue: 30,
      tapDue: 6,
      seenOther: 80,
      tapOther: 2,
      started: 10,
      marked: 20,
      cleared: 4,
      targets: 60,
      targetsUsed: 58,
      extras: 60,
      extrasUsed: 30,
    },
    { hard: 230, learning: 380, known: 150, new: 340, due: 120 },
  );
  day(
    '2026-11-20',
    {
      texts: 3,
      skipped: 1,
      readS: 1500,
      words: 800,
      seenNew: 15,
      tapNew: 9,
      seenHard: 30,
      tapHard: 15,
      seenDue: 40,
      tapDue: 4,
      seenOther: 100,
      tapOther: 3,
      tapOut: 2,
      started: 15,
      marked: 28,
      cleared: 5,
      targets: 90,
      targetsUsed: 90,
      extras: 90,
      extrasUsed: 40,
      timed: 4,
      waitS: 28,
      inTok: 5000,
      outTok: 40000,
    },
    { hard: 250, learning: 390, known: 160, new: 325, due: 90 },
  );
  return s;
}

test('the request carries the settings, every number and the day-by-day table', () => {
  const prompt = buildTuneRequest({
    stats: someStats(),
    prefs: { ...DEFAULT_PREFS, length: 'long', textsPerDay: 3 },
    today: '2026-11-20',
    words: { hard: 250, learning: 390, known: 160, new: 325, due: 90 },
    tests: [levelResult('B1', 7, 12, NOW)],
    leeches: [{ de: 'leider', en: 'unfortunately', lookups: 6, seen: 9 }],
  });
  // The settings, each with its allowed values.
  assert.ok(prompt.includes('- newPerDay = 15   (New words a day; allowed: 0, 5, 10, 15, 20, 30, 50)'));
  assert.ok(prompt.includes('- length = long'));
  assert.ok(prompt.includes('- earlyMax = 5') && prompt.includes('-1 means no limit'));
  assert.ok(prompt.includes('- textsPerDay = 3') && prompt.includes('0 means no goal'));
  for (const t of TUNABLE) assert.ok(prompt.includes(`- ${t.key} = `), t.key);
  // The figures that matter, worked out.
  const report = JSON.parse(prompt.slice(prompt.indexOf('NUMBERS\n') + 8, prompt.indexOf('\n\nDAY BY DAY')));
  assert.equal(report.today, '2026-11-20');
  assert.equal(report.first_day_with_numbers, '2026-11-18');
  assert.deepEqual(report.words_right_now, { hard: 250, learning: 390, known: 160, new: 325, due: 90 });
  assert.equal(report.hard_words_get_stuck_above, '33% looked up again, with the current hard-word settings');
  assert.equal(report.retention_target, '88% of due words still known');
  const all = report.all_time;
  assert.equal(all.days, 3);
  assert.equal(all.days_with_reading, 2);
  assert.equal(all.texts_finished, 5);
  assert.equal(all.texts_skipped, 1);
  assert.equal(all.minutes_of_reading, 45);
  assert.equal(all.minutes_per_text, 9);
  assert.equal(all.texts_per_reading_day, 2.5);
  assert.equal(all.hard_words_looked_up_again, '48% (24 of 50)');
  assert.equal(all.due_words_looked_up, '14% (10 of 70)');
  assert.equal(all.new_words_looked_up_on_first_sight, '60% (15 of 25)');
  assert.equal(all.lookups, 56);
  assert.equal(all.required_words_used_by_the_text, '99% (148 of 150)');
  assert.equal(report.last_7_days.texts_finished, 5);
  assert.deepEqual(report.by_kind_of_text_all_time[0].kind, 'A2:long');
  assert.deepEqual(report.level_test_results, [
    { day: '2026-11-20', test: 'single level B1', result: 'not passed', scores: 'B1 7/12' },
  ]);
  assert.deepEqual(report.words_looked_up_most, ['leider (unfortunately): 6 lookups in 9 texts']);
  // And the table of days.
  const table = prompt.slice(prompt.indexOf('DAY BY DAY')).split('\n');
  assert.match(table[0], /^DAY BY DAY \(the 2 most recent days with numbers/);
  assert.ok(table[1].startsWith('day,texts,skipped,readS') && table[1].endsWith('words_due'));
  assert.ok(table[2].startsWith('2026-11-18,2,0,1200,') && table[2].endsWith(',230,380,150,340,120'));
  assert.ok(table[3].startsWith('2026-11-20,3,1,1500,'));
  assert.equal(table.length, 4);
});

test('the request still works with no numbers at all, and says where hard words cannot get stuck', () => {
  const prompt = buildTuneRequest({
    stats: emptyStats(),
    prefs: { hardStep: 1, maxHard: 1 },
    today: '2026-11-20',
    words: { hard: 0, learning: 0, known: 0, new: 10, due: 0 },
  });
  const report = JSON.parse(prompt.slice(prompt.indexOf('NUMBERS\n') + 8, prompt.indexOf('\n\nDAY BY DAY')));
  assert.equal(report.first_day_with_numbers, 'none');
  assert.match(report.hard_words_get_stuck_above, /^never/);
  assert.equal(report.all_time.hard_words_looked_up_again, 'no words yet');
  assert.equal(report.all_time.texts_finished, 0);
  assert.deepEqual(report.level_test_results, []);
});

test('the instructions name every setting and the answer must follow a fixed shape', () => {
  for (const key of ['autoHard', 'hardStep', 'maxHard', 'newPerDay', 'earlyMax', 'level', 'length', 'textsPerDay']) {
    assert.ok(TUNE_SYSTEM.includes(key), key);
  }
  assert.ok(/retention/.test(TUNE_SYSTEM));
  // The structured-output rules: every object closed, every property required.
  const check = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(check);
    } else if (node.type === 'array') check(node.items);
  };
  check(TUNE_SCHEMA);
  const props = TUNE_SCHEMA.properties.settings.properties;
  assert.deepEqual(Object.keys(props), Object.keys(BASE));
  assert.deepEqual(props.newPerDay.enum, ['0', '5', '10', '15', '20', '30', '50']);
  assert.deepEqual(props.earlyMax.enum, ['0', '3', '5', '10', '15', '-1']);
  assert.equal(props.autoHard.type, 'boolean');
});

// ---- the answer -------------------------------------------------------------------

test('an answer becomes a valid set of settings and a list of changes with their reasons', () => {
  const answer = {
    summary: ' Your hard words are piling up. ',
    settings: {
      level: 'A2',
      length: 'medium',
      newPerDay: '10',
      retention: '0.88',
      hardStep: '1',
      maxHard: '2',
      earlyMax: '5',
      autoHard: true,
      textsPerDay: '0',
    },
    reasons: [
      { setting: 'newPerDay', reason: 'Fewer new words give the hard ones room.' },
      { setting: 'hardStep', reason: 'You look up 48% of hard words again.' },
      { setting: 'level', reason: 'Not changed, so this is ignored.' },
    ],
    caution: 'Only five texts so far.',
  };
  const got = readAdvice(answer, BASE);
  assert.equal(got.summary, 'Your hard words are piling up.');
  assert.equal(got.caution, 'Only five texts so far.');
  assert.deepEqual(got.settings, { ...BASE, newPerDay: 10, hardStep: 1, maxHard: 2 });
  assert.deepEqual(got.changes, [
    { key: 'newPerDay', from: 15, to: 10, reason: 'Fewer new words give the hard ones room.' },
    { key: 'hardStep', from: 2, to: 1, reason: 'You look up 48% of hard words again.' },
    { key: 'maxHard', from: 4, to: 2, reason: '' },
  ]);
});

test('an answer that changes nothing, or asks for something not allowed, is handled', () => {
  const same = readAdvice(
    {
      summary: 'All fine.',
      settings: Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)])),
      reasons: [],
      caution: '',
    },
    BASE,
  );
  assert.deepEqual(same.changes, []);
  assert.deepEqual(same.settings, BASE);
  const odd = readAdvice(
    { summary: 5, settings: { level: 'C2', hardStep: '6', maxHard: '3', newPerDay: '12' }, reasons: 'x' },
    BASE,
  );
  assert.equal(odd.settings.level, 'A2', 'a level the app cannot write is not taken');
  assert.deepEqual([odd.settings.hardStep, odd.settings.maxHard], [3, 3]);
  assert.equal(odd.settings.newPerDay, 10);
  assert.equal(odd.summary, '');
  for (const bad of [null, 'x', {}, { settings: 'x' }]) assert.throws(() => readAdvice(bad, BASE), /could not be read/);
});
