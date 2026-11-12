// The Settings tab: API key, reading preferences, word lists, sync.

import { BUILTIN_SRC, store } from '../store.js';
import { fill, h, icon, plural, timeAgo, toast } from './dom.js';
import { MODELS } from '../lib/models.js';
import { LEVELS } from '../lib/prompt.js';
import { HARD_SHARE, MAX_HARD_CHOICES, hardStepChoices, hardStepOf, maxHardOf } from '../lib/scoring.js';
import { NEW_PER_DAY_CHOICES, RETENTION_CHOICES, newPerDayOf, retentionOf } from '../lib/srs.js';
import { tts } from '../tts.js';
import { pickDeckFile, updateFromAnki } from './import.js';

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=German%20Text%20Study%20sync';
const KEY_URL = 'https://platform.claude.com/settings/keys';

let root;
let sourcesEl;
let syncEl;
let voiceEl;
let rulesEl;
let hardEl;
let ankiEl;

export function mountSettings(el) {
  root = el;
  render();
  store.subscribe((what) => {
    if (what === 'words') drawSources();
    if (what === 'prefs') drawAnki();
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
  ankiEl = h('div');

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
      ankiEl,
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: pickDeckFile }, icon('upload', 18), 'Import Anki deck'),
      ),
      h(
        'p',
        { class: 'help' },
        'For a first import or another deck: choose an Anki .apkg or .colpkg file, or a “Notes in Plain Text” export, and confirm the fields. Words that are also in the built-in list are merged, so nothing appears twice.',
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
  drawAnki();
}

/** Once a deck has been read from an Anki file, offer to bring it up to date in one step. */
function drawAnki() {
  if (!ankiEl) return;
  const anki = store.state.prefs.anki;
  if (!anki) return fill(ankiEl);
  fill(
    ankiEl,
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', onclick: updateFromAnki },
        icon('upload', 18),
        'Update from Anki',
      ),
    ),
    h(
      'p',
      { class: 'help' },
      `Export your collection from Anki (a .colpkg file) and choose it here. The app reads “${anki.name}” the same way as last time and takes over every word Anki has reviewed since, without asking again. Last updated ${timeAgo(anki.at)}.`,
    ),
  );
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
  const choice = (choices, current, write, onPick, ariaLabel) =>
    h(
      'select',
      { class: 'input', 'aria-label': ariaLabel, onchange: (e) => onPick(Number(e.target.value)) },
      // A value set elsewhere that is not one of the choices is still shown.
      [...new Set([...choices, current])]
        .sort((a, b) => a - b)
        .map((n) => h('option', { value: String(n), selected: n === current }, write(n))),
    );
  fill(
    hardEl,
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'New words a day'),
      choice(
        NEW_PER_DAY_CHOICES,
        newPerDayOf(prefs),
        (n) => (n ? `${n} new words` : 'No new words'),
        (n) => {
          store.updatePrefs({ newPerDay: n });
          drawRules();
        },
        'New words a day',
      ),
      h(
        'span',
        { class: 'help' },
        'How many words from your deck may be started each day. Every new word comes back for review over the following days, so a higher number means more to read later.',
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'Bring a word back when the chance of knowing it is'),
      choice(
        RETENTION_CHOICES,
        retentionOf(prefs),
        (r) => `${Math.round(r * 100)}%`,
        (r) => {
          store.updatePrefs({ retention: r });
          drawRules();
        },
        'Chance of recall at which a word is due',
      ),
      h(
        'span',
        { class: 'help' },
        'Anki calls this desired retention. Higher brings words back sooner and more often; lower spaces them further apart. Applies from each word’s next review.',
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'label' }, 'A hard word is back on the schedule after'),
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
        'A word you mark hard has to be read this many times without tapping, in the texts that follow, before it returns to the schedule. A higher number repeats each hard word more, but fewer other words fit in. Applies to words you mark from now on.',
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
  const prefs = store.state.prefs;
  const step = hardStepOf(prefs);
  const max = maxHardOf(prefs);
  const percent = Math.round(retentionOf(prefs) * 100);
  fill(
    rulesEl,
    h(
      'li',
      null,
      `Words are scheduled the way Anki does it. Every word has a memory strength; each time you read it without tapping, the strength grows and the word is put further into the future. It becomes due when your chance of still knowing it has fallen to ${percent}%.`,
    ),
    h(
      'li',
      null,
      'Finishing a text reviews every word in it at once: untapped words count as remembered, looked-up words as hesitant, so they come back sooner.',
    ),
    h(
      'li',
      null,
      `Marking a word hard is Anki’s “Again”: its memory strength drops and it needs ${reads(step)} in the coming texts before it goes back on the schedule (marking it again adds more, up to ${max}).`,
    ),
    h(
      'li',
      null,
      `Each text is built from: new words from your deck, in deck order (about a quarter of the places, up to ${newPerDayOf(prefs)} a day); hard words (up to ${Math.round(HARD_SHARE * 100)}% of the places); then the due words you are most likely to have forgotten.`,
    ),
    h(
      'li',
      null,
      'When nothing is due, the text practises the words that are due soonest. The built-in common words are only chosen when your deck has nothing left to offer; they are still rescheduled whenever they appear.',
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
  const added = store.customCount();
  fill(
    sourcesEl,
    h(
      'ul',
      { class: 'sources' },
      store.lists().map((list) =>
        h(
          'li',
          null,
          h(
            'label',
            { class: 'source' },
            h('span', { class: 'source-name' }, list.name),
            h('span', { class: 'sources-n' }, list.on ? plural(list.count, 'word') : 'off'),
            h('input', {
              class: 'switch',
              type: 'checkbox',
              role: 'switch',
              'aria-label': `Use the list “${list.name}”`,
              checked: list.on,
              onchange: (e) => store.setListOn(list.name, e.target.checked),
            }),
          ),
        ),
      ),
    ),
    h(
      'p',
      { class: 'help' },
      'Turn a list off to leave its words out of your word list and your texts. Nothing is deleted: the words and their progress come back when you turn it on again.',
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
