// The Settings tab: API key, reading preferences, word lists, sync.

import { BUILTIN_SRC, store } from '../store.js';
import { fill, h, icon, plural, timeAgo, toast } from './dom.js';
import { MODELS } from '../lib/models.js';
import { LEVELS } from '../lib/prompt.js';
import { HARD_SHARE, MAX_HARD_CHOICES, hardStepChoices, hardStepOf, maxHardOf } from '../lib/scoring.js';
import { tts } from '../tts.js';
import { pickDeckFile } from './import.js';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=German%20Text%20Study%20sync';
const KEY_URL = 'https://platform.claude.com/settings/keys';

let root;
let sourcesEl;
let syncEl;
let voiceEl;
let rulesEl;
let hardEl;

export function mountSettings(el) {
  root = el;
  render();
  store.subscribe((what) => {
    if (what === 'words') drawSources();
    if (what === 'sync' || what === 'local') drawSync();
  });
  tts.onVoices(drawVoices);
}

/** Called when the tab becomes visible, to pick up changes made elsewhere. */
export function showSettings() {
  render();
}

function card(title, ...children) {
  return h('section', { class: 'card' }, h('h2', { class: 'card-title' }, title), ...children);
}

function render() {
  const prefs = store.state.prefs;
  sourcesEl = h('div');
  syncEl = h('div');
  voiceEl = h('div');
  rulesEl = h('ul', { class: 'help-list' });
  hardEl = h('div');

  const keyInput = h('input', {
    class: 'input',
    type: 'password',
    value: store.local.apiKey,
    placeholder: 'sk-ant-…',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Claude API key',
    oninput: (e) => store.setLocal({ apiKey: e.target.value.trim() }),
  });

  const rateOut = h('output', { class: 'range-value' }, `${prefs.rate.toFixed(2)}×`);

  fill(
    root,
    h('h1', { class: 'page-title' }, 'Settings'),

    card(
      'Claude API key',
      h(
        'p',
        { class: 'help' },
        'Texts are written by Claude using your own API key. The key is kept in this browser only and is sent to nobody but Anthropic. ',
        h('a', { href: KEY_URL, target: '_blank', rel: 'noopener' }, 'Create a key'),
      ),
      h(
        'div',
        { class: 'edit-row' },
        keyInput,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: (e) => {
              const show = keyInput.type === 'password';
              keyInput.type = show ? 'text' : 'password';
              e.currentTarget.textContent = show ? 'Hide' : 'Show';
            },
          },
          'Show',
        ),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'label' }, 'Model'),
        h(
          'select',
          { class: 'input', onchange: (e) => store.updatePrefs({ model: e.target.value }) },
          MODELS.map((m) => h('option', { value: m.id, selected: m.id === prefs.model }, m.label)),
        ),
      ),
    ),

    card(
      'Reading',
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'label' }, 'Level'),
        h(
          'select',
          { class: 'input', onchange: (e) => store.updatePrefs({ level: e.target.value }) },
          Object.entries(LEVELS).map(([id, text]) =>
            h('option', { value: id, selected: id === prefs.level }, text.split(':')[0]),
          ),
        ),
      ),
      h(
        'label',
        { class: 'switch-row' },
        h(
          'span',
          null,
          h('span', { class: 'switch-title' }, 'Mark tapped words as hard'),
          h(
            'span',
            { class: 'help' },
            'On: every word you tap for a translation is marked hard straight away. Off: tapping only shows the translation, and you press “Mark as hard” yourself.',
          ),
        ),
        h('input', {
          class: 'switch',
          type: 'checkbox',
          role: 'switch',
          checked: prefs.autoHard,
          onchange: (e) => store.updatePrefs({ autoHard: e.target.checked }),
        }),
      ),
      hardEl,
      h(
        'label',
        { class: 'switch-row' },
        h(
          'span',
          null,
          h('span', { class: 'switch-title' }, 'Underline hard words'),
          h(
            'span',
            { class: 'help' },
            'On: a hard word from an earlier text is underlined when it comes back. Off: it looks like any other word, so you find out for yourself whether you remember it.',
          ),
        ),
        h('input', {
          class: 'switch',
          type: 'checkbox',
          role: 'switch',
          checked: prefs.underlineHard !== false,
          onchange: (e) => store.updatePrefs({ underlineHard: e.target.checked }),
        }),
      ),
      tts.supported
        ? [
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'label' }, 'Read-aloud speed ', rateOut),
              h('input', {
                type: 'range',
                min: '0.6',
                max: '1.2',
                step: '0.05',
                value: String(prefs.rate),
                oninput: (e) => {
                  rateOut.textContent = `${Number(e.target.value).toFixed(2)}×`;
                },
                onchange: (e) => store.updatePrefs({ rate: Number(e.target.value) }),
              }),
            ),
            voiceEl,
          ]
        : h('p', { class: 'help' }, 'This browser has no speech engine, so read-aloud is unavailable.'),
    ),

    card(
      'Word lists',
      sourcesEl,
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: pickDeckFile }, icon('upload', 18), 'Import Anki deck'),
      ),
      h(
        'p',
        { class: 'help' },
        'Choose an Anki .apkg or .colpkg file, or a “Notes in Plain Text” export. Words that are also in the built-in list are merged, so nothing appears twice.',
      ),
    ),

    card('Sync between devices', syncEl),

    card('How words are chosen', rulesEl),

    card(
      'Start over',
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn-danger',
            type: 'button',
            onclick: () => {
              if (confirm('Reset the score of every word? This also applies to your other synced devices.')) {
                store.resetProgress();
                toast('All scores reset');
              }
            },
          },
          'Reset all scores',
        ),
      ),
    ),
  );

  drawSources();
  drawSync();
  drawVoices();
  drawHardness();
  drawRules();
}

const reads = (n) => `${n} clean ${n === 1 ? 'read' : 'reads'}`;

/** The two hardness settings. The step can never be larger than the limit. */
function drawHardness() {
  if (!hardEl) return;
  const prefs = store.state.prefs;
  const step = hardStepOf(prefs);
  const max = maxHardOf(prefs);
  const select = (choices, current, onPick, label) =>
    h(
      'select',
      { class: 'input', 'aria-label': label, onchange: (e) => onPick(Number(e.target.value)) },
      choices.map((n) => h('option', { value: String(n), selected: n === current }, reads(n))),
    );
  fill(
    hardEl,
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'A hard word is normal again after'),
      select(
        hardStepChoices(prefs),
        step,
        (n) => {
          store.updatePrefs({ hardStep: n });
          drawRules();
        },
        'Clean reads for a hard word',
      ),
      h(
        'span',
        { class: 'help' },
        'Marking a word hard lowers its score by this much, and every text you read it in without tapping raises it by 1. A higher number repeats each hard word more, but fewer new words fit in. Applies to words you mark from now on.',
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'The hardest a word can get'),
      select(
        MAX_HARD_CHOICES,
        max,
        (n) => {
          store.updatePrefs({ maxHard: n, hardStep: Math.min(step, n) });
          drawHardness();
          drawRules();
        },
        'Most clean reads a word can need',
      ),
      h(
        'span',
        { class: 'help' },
        'Marking a hard word again makes it harder, but it never needs more clean reads than this. Lowering it also eases words that are already harder.',
      ),
    ),
  );
}

function drawRules() {
  if (!rulesEl) return;
  const step = hardStepOf(store.state.prefs);
  const max = maxHardOf(store.state.prefs);
  fill(
    rulesEl,
    h('li', null, 'Every word has a score. New words start at 0.'),
    h(
      'li',
      null,
      `Marking a word hard drops its score by ${step}, and marking it again drops it further, but never below −${max}. Hard words get up to ${Math.round(HARD_SHARE * 100)}% of the places in each new text.`,
    ),
    h(
      'li',
      null,
      `Each time you finish a text, every word in it that you did not tap goes up by 1. So a hard word needs ${reads(step)} to become normal again, and never more than ${max}.`,
    ),
    h(
      'li',
      null,
      'The other places go to words from your Anki deck that you do not know yet. Each point of score halves a word’s chance of being picked.',
    ),
    h(
      'li',
      null,
      'The built-in common words are not chosen while deck words are left to learn. They still appear whenever a text needs them, and you can tap and mark them like any other word.',
    ),
  );
}

function drawVoices() {
  if (!voiceEl) return;
  const voices = tts.voices();
  if (!voices.length) {
    fill(
      voiceEl,
      h(
        'p',
        { class: 'help' },
        'No German voice is installed on this device yet. Add one in your system’s speech settings for better read-aloud.',
      ),
    );
    return;
  }
  fill(
    voiceEl,
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'Voice'),
      h(
        'select',
        { class: 'input', onchange: (e) => store.setLocal({ voice: e.target.value }) },
        h('option', { value: '', selected: !store.local.voice }, 'Automatic'),
        voices.map((v) =>
          h('option', { value: v.voiceURI, selected: v.voiceURI === store.local.voice }, `${v.name} (${v.lang})`),
        ),
      ),
    ),
  );
}

function drawSources() {
  if (!sourcesEl) return;
  const counts = new Map();
  for (const e of store.index.list) counts.set(e.src, (counts.get(e.src) || 0) + 1);
  const added = store.customCount();
  fill(
    sourcesEl,
    h(
      'ul',
      { class: 'sources' },
      [...counts.entries()].map(([src, n]) =>
        h('li', null, h('span', null, src), h('span', { class: 'sources-n' }, plural(n, 'word'))),
      ),
    ),
    added > 0 &&
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          {
            class: 'btn btn-quiet',
            type: 'button',
            onclick: () => {
              if (confirm(`Remove all ${added} imported and edited words? The built-in “${BUILTIN_SRC}” list stays.`)) {
                store.clearCustom();
                toast('Imported words removed');
              }
            },
          },
          'Remove imported words',
        ),
      ),
  );
}

function drawSync() {
  if (!syncEl) return;
  const { ghToken, gistId, lastSync } = store.local;
  const { status, message } = store.sync;

  if (!ghToken) {
    const input = h('input', {
      class: 'input',
      type: 'password',
      placeholder: 'ghp_…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'GitHub token',
    });
    const errorEl = h('p', { class: 'notice is-error', role: 'alert', hidden: true });
    const connect = async (e) => {
      const token = input.value.trim();
      if (!token) return input.focus();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      try {
        await store.connectSync(token);
        toast('Sync is on');
      } catch (err) {
        // connectSync has already redrawn this card; show the reason in it.
        const fresh = syncEl.querySelector('.notice.is-error');
        if (fresh) {
          fresh.textContent = err.message;
          fresh.hidden = false;
        }
      }
    };
    fill(
      syncEl,
      h(
        'p',
        { class: 'help' },
        'Keep the same scores on your phone and computer. Progress is saved to a private gist on your GitHub account.',
      ),
      h(
        'ol',
        { class: 'help-list' },
        h(
          'li',
          null,
          h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'Create a GitHub token'),
          ' with only the “gist” box ticked, and copy it.',
        ),
        h('li', null, 'Paste it below. Do the same on each device, with the same or a new token.'),
      ),
      h(
        'div',
        { class: 'edit-row' },
        input,
        h('button', { class: 'btn btn-primary', type: 'button', onclick: connect }, 'Connect'),
      ),
      errorEl,
      h('p', { class: 'help' }, 'Your Claude API key is never synced. Enter it once on each device.'),
    );
    return;
  }

  const line =
    status === 'syncing' ? 'Syncing…' : status === 'error' ? message : `Sync is on · last synced ${timeAgo(lastSync)}`;
  fill(
    syncEl,
    h(
      'p',
      { class: status === 'error' ? 'notice is-error' : 'notice is-good', role: 'status' },
      icon(status === 'error' ? 'alert' : 'cloud', 18),
      line,
    ),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        { class: 'btn', type: 'button', disabled: status === 'syncing', onclick: () => store.syncNow() },
        'Sync now',
      ),
      gistId &&
        h(
          'a',
          { class: 'btn btn-quiet', href: `https://gist.github.com/${gistId}`, target: '_blank', rel: 'noopener' },
          'View the gist',
        ),
      h(
        'button',
        {
          class: 'btn btn-quiet',
          type: 'button',
          onclick: () => {
            if (confirm('Stop syncing on this device? Your scores stay here and in the gist.')) store.disconnectSync();
          },
        },
        'Disconnect',
      ),
    ),
    h('p', { class: 'help' }, 'Your Claude API key is never synced. Enter it once on each device.'),
  );
}
