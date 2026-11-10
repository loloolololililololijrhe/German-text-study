// App state: what is synced (progress, custom words, preferences), what stays
// on this device (keys, tokens), and the sync loop that reconciles the two.

import { buildWordIndex, normKey, parseWordList } from './lib/words.js';
import { emptyState, mergeStates, sanitizeState, stableStringify } from './lib/merge.js';
import { createGist, findGist, readGist, writeGist } from './gist.js';
import common1 from './data/common-1.txt?raw';
import common2 from './data/common-2.txt?raw';
import common3 from './data/common-3.txt?raw';
import common4 from './data/common-4.txt?raw';
import defaultDeck from './data/deck.json';

const STATE_KEY = 'gts.state';
const LOCAL_KEY = 'gts.local';
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
    persist();
    this.emit('prefs');
    this.syncSoon();
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
        id = await createGist(token, this.state);
        this.setLocal({ gistId: id, lastSync: Date.now() });
      } else {
        if (id !== this.local.gistId) this.setLocal({ gistId: id });
        const remoteRaw = await readGist(token, id);
        const remote = remoteRaw ? sanitizeState(remoteRaw) : emptyState();
        const merged = mergeStates(this.state, remote);
        const mergedText = stableStringify(merged);
        if (mergedText !== stableStringify(this.state)) {
          this.state = merged;
          rebuildIndex();
          persist();
          this.emit('words');
        }
        if (!remoteRaw || mergedText !== stableStringify(remote)) await writeGist(token, id, merged);
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
  store.index = buildWordIndex({ builtin, deck, custom: store.state.custom });
}

rebuildIndex();
if (store.local.ghToken) store.sync = { status: 'idle', message: '' };
