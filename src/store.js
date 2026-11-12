// App state: what is synced (progress, custom words, preferences), what stays
// on this device (keys, tokens), and the sync loop that reconciles the two.

import { buildWordIndex, listNames, normKey, parseWordList, withoutLists } from './lib/words.js';
import {
  emptyState,
  mergeHistories,
  mergeStates,
  packText,
  sanitizeHistory,
  sanitizeState,
  stableStringify,
} from './lib/merge.js';
import { capHardness, maxHardOf } from './lib/scoring.js';
import { dayKey, newPerDayOf } from './lib/srs.js';
import { GIST_FILE, TEXTS_FILE, createGist, findGist, readGist, writeGist } from './gist.js';
import common1 from './data/common-1.txt?raw';
import common2 from './data/common-2.txt?raw';
import common3 from './data/common-3.txt?raw';
import common4 from './data/common-4.txt?raw';
import defaultDeck from './data/deck.json';

const STATE_KEY = 'gts.state';
const LOCAL_KEY = 'gts.local';
const TEXTS_KEY = 'gts.texts';
export const BUILTIN_SRC = 'Common words';
// deck.json is either a plain list of words or { name, words }.
const deckWords = Array.isArray(defaultDeck) ? defaultDeck : defaultDeck.words || [];
export const DECK_SRC = (!Array.isArray(defaultDeck) && defaultDeck.name) || 'Default deck';

const builtin = parseWordList([common1, common2, common3, common4].join('\n'), BUILTIN_SRC);
const deck = deckWords.map((d) => ({ de: d.de, en: d.en, src: DECK_SRC }));

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app keeps working for this session */
  }
}

const listeners = new Set();

export const store = {
  state: sanitizeState(read(STATE_KEY)),
  // Device-only: never leaves this browser.
  local: { apiKey: '', ghToken: '', gistId: '', voice: '', lastSync: 0, ...(read(LOCAL_KEY) || {}) },
  // Finished texts, newest first, kept for re-reading.
  history: sanitizeHistory(read(TEXTS_KEY)),
  index: null,
  sync: { status: 'off', message: '' },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** `what` tells views how much to redraw: 'progress', 'words', 'prefs', 'local', 'sync'. */
  emit(what) {
    for (const fn of listeners) fn(what);
  },

  progressOf(id) {
    return this.state.progress[id];
  },

  setProgress(id, p) {
    this.setProgressMany({ [id]: p });
  },

  setProgressMany(updates) {
    Object.assign(this.state.progress, updates);
    persist();
    this.emit('progress');
    this.syncSoon();
  },

  updatePrefs(patch) {
    this.state.prefs = { ...this.state.prefs, ...patch, u: Date.now() };
    // A lower limit on hardness also eases the words that were already beyond it.
    if ('maxHard' in patch)
      Object.assign(this.state.progress, capHardness(this.state.progress, maxHardOf(this.state.prefs), Date.now()));
    if ('listsOff' in patch) rebuildIndex();
    persist();
    this.emit('prefs');
    if ('listsOff' in patch) this.emit('words');
    this.syncSoon();
  },

  /** Every word list with whether it is on and how many words it adds to the list. */
  lists() {
    const off = new Set(this.state.prefs.listsOff);
    const counts = new Map();
    for (const e of this.index.list) counts.set(e.src, (counts.get(e.src) || 0) + 1);
    return listNames({ builtin, deck, custom: this.state.custom }).map((name) => ({
      name,
      on: !off.has(name),
      count: counts.get(name) || 0,
    }));
  },

  isListOff(name) {
    return this.state.prefs.listsOff.includes(name);
  },

  /** Turn a word list on or off. Its words and their progress are kept either way. */
  setListOn(name, on) {
    const off = new Set(this.state.prefs.listsOff);
    if (on) off.delete(name);
    else off.add(name);
    this.updatePrefs({ listsOff: [...off].sort() });
  },

  setLocal(patch) {
    Object.assign(this.local, patch);
    write(LOCAL_KEY, this.local);
    this.emit('local');
  },

  /**
   * Add or replace words. Each item: { de, en, src, rank? }. Returns how many
   * were stored. Without a rank, a word keeps the position it already had.
   * Existing progress for a word is kept.
   */
  addCustom(items) {
    const now = Date.now();
    let count = 0;
    items.forEach((it) => {
      const id = normKey(it.de);
      if (!id || !it.en) return;
      const old = this.state.custom[id];
      const known = this.index.byId.get(id);
      this.state.custom[id] = {
        de: it.de,
        en: it.en,
        src: it.src || 'custom',
        r: it.rank ?? old?.r ?? known?.rank ?? 2000,
        a: now,
        u: now,
      };
      count++;
    });
    rebuildIndex();
    persist();
    this.emit('words');
    this.syncSoon();
    return count;
  },

  /** Remove every imported, edited and added word, on all synced devices. */
  clearCustom() {
    this.state.custom = {};
    this.state.clearedAt = Date.now();
    rebuildIndex();
    persist();
    this.emit('words');
    this.syncSoon();
  },

  /** Forget all scores, on all synced devices. */
  resetProgress() {
    this.state.progress = {};
    this.state.resetAt = Date.now();
    persist();
    this.emit('progress');
    this.syncSoon();
  },

  /** How many more new words may be started today. */
  newLeft() {
    const { day, n } = this.state.intro;
    return Math.max(0, newPerDayOf(this.state.prefs) - (day === dayKey(Date.now()) ? n : 0));
  },

  /** Record that `count` new words were started today. */
  addIntroduced(count) {
    if (!count) return;
    const today = dayKey(Date.now());
    const { day, n } = this.state.intro;
    this.state.intro = { day: today, n: (day === today ? n : 0) + count };
    persist();
    this.syncSoon();
  },

  /** Keep a finished text so it can be read again. */
  addText({ title, level, sentences, hard }) {
    const at = Date.now();
    const entry = packText({
      id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      title,
      level,
      hard,
      sentences,
    });
    this.history = mergeHistories({ clearedAt: this.history.clearedAt, texts: [entry] }, this.history);
    write(TEXTS_KEY, this.history);
    this.emit('history');
    this.syncSoon();
  },

  /** Forget all past texts, on all synced devices. */
  clearHistory() {
    this.history = { clearedAt: Date.now(), texts: [] };
    write(TEXTS_KEY, this.history);
    this.emit('history');
    this.syncSoon();
  },

  customCount() {
    return Object.keys(this.state.custom).length;
  },

  // ---- sync -------------------------------------------------------------

  syncSoon() {
    if (!this.local.ghToken) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => this.syncNow(), 4000);
  },

  async syncNow() {
    if (!this.local.ghToken) return false;
    clearTimeout(syncTimer);
    if (syncing) {
      syncAgain = true;
      return false;
    }
    syncing = true;
    setSync('syncing');
    const token = this.local.ghToken;
    try {
      let id = this.local.gistId || (await findGist(token));
      if (!id) {
        id = await createGist(token, { [GIST_FILE]: this.state, [TEXTS_FILE]: this.history });
        this.setLocal({ gistId: id, lastSync: Date.now() });
      } else {
        if (id !== this.local.gistId) this.setLocal({ gistId: id });
        const files = await readGist(token, id);
        const changed = {};

        const remote = files[GIST_FILE] ? sanitizeState(files[GIST_FILE]) : emptyState();
        const merged = mergeStates(this.state, remote);
        // Another device may still have had a higher limit on hardness.
        Object.assign(merged.progress, capHardness(merged.progress, maxHardOf(merged.prefs), Date.now()));
        const mergedText = stableStringify(merged);
        if (mergedText !== stableStringify(this.state)) {
          this.state = merged;
          rebuildIndex();
          persist();
          this.emit('words');
        }
        if (!files[GIST_FILE] || mergedText !== stableStringify(remote)) changed[GIST_FILE] = merged;

        // Past texts: the union of both sides.
        const remoteTexts = sanitizeHistory(files[TEXTS_FILE]);
        const mergedTexts = mergeHistories(this.history, remoteTexts);
        const textsText = stableStringify(mergedTexts);
        if (textsText !== stableStringify(this.history)) {
          this.history = mergedTexts;
          write(TEXTS_KEY, this.history);
          this.emit('history');
        }
        const nothingYet = !files[TEXTS_FILE] && !mergedTexts.texts.length && !mergedTexts.clearedAt;
        if (!nothingYet && (!files[TEXTS_FILE] || textsText !== stableStringify(remoteTexts))) {
          changed[TEXTS_FILE] = mergedTexts;
        }

        if (Object.keys(changed).length) await writeGist(token, id, changed);
        this.setLocal({ lastSync: Date.now() });
      }
      setSync('idle');
      return true;
    } catch (err) {
      // A deleted gist is recreated on the next attempt.
      if (err.status === 404 && this.local.gistId) this.setLocal({ gistId: '' });
      setSync('error', err.message || 'Sync failed.');
      return false;
    } finally {
      syncing = false;
      if (syncAgain) {
        syncAgain = false;
        this.syncSoon();
      }
    }
  },

  async connectSync(token) {
    this.setLocal({ ghToken: token.trim(), gistId: '' });
    const ok = await this.syncNow();
    if (!ok && this.sync.status === 'error') {
      const message = this.sync.message;
      this.setLocal({ ghToken: '', gistId: '' });
      setSync('off');
      throw new Error(message);
    }
  },

  disconnectSync() {
    clearTimeout(syncTimer);
    this.setLocal({ ghToken: '', gistId: '', lastSync: 0 });
    setSync('off');
  },
};

let syncTimer = 0;
let syncing = false;
let syncAgain = false;

function setSync(status, message = '') {
  store.sync = { status, message };
  store.emit('sync');
}

function persist() {
  write(STATE_KEY, store.state);
}

function rebuildIndex() {
  const sources = { builtin, deck, custom: store.state.custom };
  store.index = buildWordIndex(withoutLists(sources, store.state.prefs.listsOff));
}

rebuildIndex();
if (store.local.ghToken) store.sync = { status: 'idle', message: '' };
