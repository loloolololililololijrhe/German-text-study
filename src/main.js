import './styles.css';
import { store } from './store.js';
import { createSheet, h, icon, timeAgo } from './ui/dom.js';
import { leaveReader, mountReader, showReader } from './ui/reader.js';
import { leaveWords, mountWords, showWords } from './ui/wordlist.js';
import { mountSettings, showSettings } from './ui/settings.js';
import { tts } from './tts.js';

const TABS = [
  { id: 'read', label: 'Read', icon: 'book', show: showReader, leave: leaveReader },
  { id: 'words', label: 'Words', icon: 'list', show: showWords, leave: leaveWords },
  { id: 'settings', label: 'Settings', icon: 'sliders', show: showSettings },
];

const sheet = createSheet();
const views = Object.fromEntries(
  TABS.map((t) => [t.id, h('main', { class: 'view', id: `view-${t.id}`, hidden: true })]),
);
const tabButtons = {};
let current = null;

const scrollAt = {};

function go(id) {
  if (id === current) return;
  const prev = TABS.find((t) => t.id === current);
  prev?.leave?.();
  // Remember where each tab was, so looking something up does not lose your place in a text.
  if (current) scrollAt[current] = window.scrollY;
  sheet.close();
  tts.stop();
  current = id;
  for (const t of TABS) {
    views[t.id].hidden = t.id !== id;
    tabButtons[t.id].setAttribute('aria-current', t.id === id ? 'page' : 'false');
  }
  TABS.find((t) => t.id === id).show?.();
  window.scrollTo(0, scrollAt[id] || 0);
}

const syncChip = h('button', { class: 'sync-chip', type: 'button', onclick: () => go('settings') });

function paintSync() {
  const { status, message } = store.sync;
  const on = !!store.local.ghToken;
  syncChip.className = `sync-chip is-${on ? status : 'off'}`;
  const label = !on ? 'Sync off' : status === 'syncing' ? 'Syncing' : status === 'error' ? 'Sync problem' : 'Synced';
  syncChip.title = !on
    ? 'Set up sync in Settings'
    : status === 'error'
      ? message
      : `Last synced ${timeAgo(store.local.lastSync)}`;
  syncChip.replaceChildren(icon(status === 'error' && on ? 'alert' : 'cloud', 16), label);
}

document.getElementById('app').replaceChildren(
  h(
    'header',
    { class: 'topbar' },
    h('span', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'ß'), 'German Text Study'),
    syncChip,
  ),
  ...Object.values(views),
  sheet.el,
  h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Sections' },
    TABS.map((t) => {
      const b = h('button', { type: 'button', onclick: () => go(t.id) }, icon(t.icon, 22), h('span', null, t.label));
      tabButtons[t.id] = b;
      return b;
    }),
  ),
);

mountReader(views.read, { sheet, openSettings: () => go('settings') });
mountWords(views.words, { sheet });
mountSettings(views.settings);

store.subscribe((what) => {
  if (what === 'sync' || what === 'local') paintSync();
});
paintSync();
go('read');

// Close the detail sheet when the learner taps empty space or presses Escape.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sheet.close();
});
document.addEventListener('click', (e) => {
  if (!sheet.isOpen()) return;
  // composedPath, not closest(): a sheet button may redraw the sheet and detach
  // itself before this handler runs.
  const keep = '.sheet, .w, .sent-tr, .row, .dialog, .tabbar';
  if (e.composedPath().some((n) => n instanceof Element && n.matches(keep))) return;
  sheet.close();
});

// Pull the latest progress when the app opens and whenever it comes back into view.
store.syncNow();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - store.local.lastSync > 60_000) store.syncNow();
});
