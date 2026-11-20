// "Tune my settings": sends the learner's numbers to Claude, shows what it
// would change and why, and applies the changes as a saved set of settings,
// with the earlier settings saved alongside to go back to.

import { store } from '../store.js';
import { fill, h, plural, toast } from './dom.js';
import { firstDay, totalsOf } from '../lib/metrics.js';
import { dayKey } from '../lib/srs.js';
import {
  TUNABLE,
  TUNE_SCHEMA,
  TUNE_SYSTEM,
  buildTuneRequest,
  makePreset,
  readAdvice,
  showValue,
  tuningInUse,
  withPreset,
} from '../lib/tune.js';

/** With fewer finished texts than this, the learner is told the advice is a rough guess. */
const FEW_TEXTS = 10;

let el = null; // the card on screen
let phase = 'idle'; // 'idle', 'asking', 'proposal' or 'error'
let advice = null; // Claude's answer while it is shown
let error = '';
let abort = null;

/** The card for the Stats tab. Its content redraws itself as the request goes along. */
export function tuneCard() {
  el = h('section', { class: 'card tune' });
  draw();
  return el;
}

function draw() {
  if (!el) return;
  const screens = { idle, asking, proposal, error: idle };
  fill(el, h('h2', { class: 'card-title' }, 'Tune my settings'), screens[phase]());
}

/** The ten words looked up most, for Claude to see what kind of word gives trouble. */
function leeches() {
  const rows = [];
  for (const e of store.index.list) {
    const p = store.progressOf(e.id);
    if (p && p.l > 0) rows.push({ de: e.de, en: e.en, lookups: p.l, seen: p.n });
  }
  return rows.sort((a, b) => b.lookups - a.lookups || b.seen - a.seen).slice(0, 10);
}

async function ask() {
  if (abort) return;
  phase = 'asking';
  advice = null;
  error = '';
  abort = new AbortController();
  draw();
  const current = store.settings();
  try {
    // The Claude SDK is most of the app's size, so it is fetched on first use.
    const { askJson } = await import('../claude.js').catch(() => {
      throw new Error('Could not load the connection to Claude. Check your internet connection and try again.');
    });
    const { answer } = await askJson({
      apiKey: store.local.apiKey,
      model: store.state.prefs.model,
      system: TUNE_SYSTEM,
      prompt: buildTuneRequest({
        stats: store.stats,
        prefs: store.state.prefs,
        today: dayKey(Date.now()),
        words: store.snapshot(),
        tests: store.state.tests,
        leeches: leeches(),
      }),
      schema: TUNE_SCHEMA,
      signal: abort.signal,
    });
    advice = readAdvice(answer, current);
    phase = 'proposal';
  } catch (err) {
    phase = err.aborted ? 'idle' : 'error';
    error = err.aborted ? '' : err.message;
  }
  abort = null;
  draw();
}

/** Use Claude's settings. The settings in use until now and the new ones are both saved as sets. */
function apply() {
  const now = Date.now();
  const before = makePreset({ label: 'Before AI tuning', by: 'before', settings: store.settings(), now });
  const ai = makePreset({
    label: 'AI tuning',
    by: 'ai',
    settings: advice.settings,
    now: now + 1,
    why: advice.summary,
    prev: before.id,
  });
  const presets = withPreset(withPreset(store.state.prefs.presets, before), ai);
  phase = 'idle';
  advice = null;
  store.updatePrefs({ ...ai.settings, presets });
  toast('Your settings were changed. You can go back at any time.');
  draw();
}

function dismiss() {
  phase = 'idle';
  advice = null;
  error = '';
  draw();
}

// ---- screens ---------------------------------------------------------------

function idle() {
  const hasKey = !!store.local.apiKey;
  const first = firstDay(store.stats);
  const texts = first ? totalsOf(store.stats, Object.keys(store.stats.days)).counts.texts : 0;
  const inUse = tuningInUse(store.state.prefs.presets, store.settings());
  return [
    h(
      'p',
      { class: 'help' },
      'Claude looks at every number on this tab and at your settings, and suggests what to change, with a reason for each change. Nothing changes until you apply it, and the settings you have now are saved so that you can go back.',
    ),
    inUse &&
      h(
        'div',
        { class: 'notice has-action is-good' },
        h('p', null, `You are using “${inUse.ai.name}”.`, inUse.ai.why && ` ${inUse.ai.why}`),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              store.applySettings(inUse.before.settings);
              toast('You are back on your earlier settings');
              draw();
            },
          },
          'Go back to my earlier settings',
        ),
      ),
    phase === 'error' && h('p', { class: 'notice is-error', role: 'alert' }, error),
    !hasKey && h('p', { class: 'notice' }, 'Add your Claude API key in Settings to use this.'),
    hasKey &&
      texts > 0 &&
      texts < FEW_TEXTS &&
      h(
        'p',
        { class: 'help' },
        `You have finished ${plural(texts, 'text')} so far. With fewer than ${FEW_TEXTS}, the suggestions are a rough guess.`,
      ),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', disabled: !hasKey || !texts, onclick: ask },
        inUse ? 'Ask Claude again' : 'Ask Claude to tune my settings',
      ),
    ),
    h(
      'p',
      { class: 'help' },
      'This sends your numbers, your settings, your level-test results and the ten words you look up most to Claude, with your API key. Your texts are not sent.',
    ),
  ];
}

function asking() {
  return [
    h(
      'p',
      { class: 'writing', role: 'status' },
      h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
      'Claude is reading your numbers',
    ),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => abort?.abort() }, 'Cancel'),
    ),
  ];
}

function proposal() {
  const { summary, caution, changes } = advice;
  const label = (key) => TUNABLE.find((t) => t.key === key).label;
  const eases = changes.some((c) => c.key === 'maxHard' && c.to < c.from);
  if (!changes.length) {
    return [
      summary && h('p', { class: 'tune-summary' }, summary),
      h('p', { class: 'notice is-good' }, 'Claude suggests keeping your settings as they are.'),
      caution && h('p', { class: 'help' }, caution),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: dismiss }, 'OK')),
    ];
  }
  return [
    summary && h('p', { class: 'tune-summary' }, summary),
    h(
      'ul',
      { class: 'tune-changes' },
      changes.map((c) =>
        h(
          'li',
          null,
          h('span', { class: 'tune-what' }, label(c.key)),
          h(
            'span',
            { class: 'tune-values' },
            h('span', { class: 'tune-from' }, showValue(c.key, c.from)),
            ' → ',
            h('b', null, showValue(c.key, c.to)),
          ),
          c.reason && h('p', { class: 'help' }, c.reason),
        ),
      ),
    ),
    caution && h('p', { class: 'help' }, caution),
    eases &&
      h(
        'p',
        { class: 'help' },
        'Lowering “The hardest a word can get” also eases words that are already harder. Going back restores the setting, but not those words.',
      ),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', onclick: apply },
        changes.length === 1 ? 'Apply this change' : `Apply these ${changes.length} changes`,
      ),
      h('button', { class: 'btn', type: 'button', onclick: dismiss }, 'Not now'),
    ),
    h(
      'p',
      { class: 'help' },
      'Applying saves two sets under “Saved settings” in Settings: the new settings, and the ones you have now. One tap here or there takes you back.',
    ),
  ];
}
