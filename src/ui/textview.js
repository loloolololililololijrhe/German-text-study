// A German text on screen: tappable words, the word and sentence sheet,
// marking words hard, and read-aloud. Used for the text being read and for
// past texts in the History tab.

import { store } from '../store.js';
import { fill, h, icon } from './dom.js';
import { normKey } from '../lib/words.js';
import { clearHard, lookedUp, markHard, resetWord, rulesOf } from '../lib/scoring.js';
import { segmentSentence } from '../lib/textparse.js';
import { tts } from '../tts.js';

export const FROM_TEXT = 'Added while reading';

/** Names and numbers can be tapped for a translation but are never scored. */
function isUnscored(word) {
  return /^\(?\s*(name|proper noun)\s*\)?$/i.test(word.g) || /^[\d.,:]+$/.test(word.w);
}

/** The list id for a word of the text, whether or not the list has it yet. */
function idOf(word) {
  return store.index.find(word.l)?.id || normKey(word.l) || normKey(word.w);
}

/**
 * @param {object} o
 * @param {object} o.sheet       the shared bottom sheet
 * @param {() => void} [o.onChange]  called when the reader's marks on the text change
 *
 * `mount(text)` returns the text's element. `text` needs `sentences`, and the
 * reader's marks for this sitting: `hard` (word id -> its progress before it
 * was marked), `tapped` (word ids looked up) and `surfaces` (spellings tapped).
 */
export function createTextView({ sheet, onChange = () => {} }) {
  let text = null;
  let bodyEl = null;
  let paraEl = null;
  let activeEl = null;
  let listenBtn = null;
  let speaking = false;

  function mount(next) {
    stopListening();
    text = next;
    activeEl = null;
    paraEl = null;
    bodyEl = h('div', { class: 'text-body', lang: 'de', onclick: onBodyClick, onkeydown: onBodyKey });
    paintUnderline();
    text.sentences.forEach((_, i) => appendSentence(i));
    listenBtn = tts.supported
      ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: toggleListening })
      : null;
    paintListenBtn();
    return bodyEl;
  }

  /** Hard words returning from earlier texts are underlined, unless the learner turned that off. */
  function paintUnderline() {
    bodyEl?.classList.toggle('no-hard-underline', store.state.prefs.underlineHard === false);
  }

  function appendSentence(si) {
    const s = text.sentences[si];
    // A play: each speaker's lines form a paragraph headed by the name, and
    // anything nobody says is a stage direction.
    const play = text.form === 'play' || text.sentences.some((x) => x.who);
    const who = s.who || '';
    const changed = si > 0 && who !== (text.sentences[si - 1].who || '');
    if (!paraEl || (s.br && si > 0) || (play && changed)) {
      paraEl = h('p', { class: play ? (who ? 'line' : 'stage') : null });
      if (who) paraEl.append(h('span', { class: 'who', lang: 'de' }, who), ' ');
      bodyEl.append(paraEl);
    }
    const sent = h('span', { class: 'sent', 'data-si': String(si) });
    for (const seg of segmentSentence(s.de, s.words)) {
      if (seg.wi == null) {
        sent.append(seg.text);
      } else {
        const el = h('span', { class: 'w', role: 'button', tabindex: '0', 'data-wi': String(seg.wi) }, seg.text);
        paintWord(el, s.words[seg.wi]);
        sent.append(el);
      }
    }
    // Glued to the sentence's last character so it never wraps onto a line alone.
    sent.append(
      '⁠',
      h(
        'button',
        {
          class: 'sent-tr',
          type: 'button',
          lang: 'en',
          'data-tr': String(si),
          'aria-label': 'Translate this sentence',
        },
        'EN',
      ),
    );
    paraEl.append(sent, ' ');
  }

  function paintWord(el, word) {
    const id = idOf(word);
    const marked = id in text.hard;
    el.classList.toggle('is-marked', marked);
    el.classList.toggle('is-hard', !marked && (store.progressOf(id)?.s ?? 0) < 0);
    el.classList.toggle('is-looked', !marked && !!text.tapped[id]);
  }

  function repaint() {
    if (!bodyEl || !text) return;
    for (const el of bodyEl.querySelectorAll('.w')) {
      const si = Number(el.parentElement.dataset.si);
      paintWord(el, text.sentences[si].words[Number(el.dataset.wi)]);
    }
  }

  function setActive(el) {
    activeEl?.classList.remove('is-active');
    activeEl = el;
    activeEl?.classList.add('is-active');
  }

  function onBodyClick(e) {
    const tr = e.target.closest('.sent-tr');
    if (tr) return openSentence(Number(tr.dataset.tr));
    const w = e.target.closest('.w');
    if (w) openWord(w);
  }

  function onBodyKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('w')) {
      e.preventDefault();
      openWord(e.target);
    }
  }

  function openWord(el) {
    const si = Number(el.parentElement.dataset.si);
    const word = text.sentences[si].words[Number(el.dataset.wi)];
    const id = idOf(word);
    text.surfaces[word.w.toLowerCase()] = true;
    if (!text.tapped[id]) {
      text.tapped[id] = true;
      if (!isUnscored(word)) {
        if (store.state.prefs.autoHard) flag(word);
        else if (store.index.byId.has(id)) store.setProgress(id, lookedUp(store.progressOf(id), Date.now()));
      }
    }
    onChange();
    repaint();
    setActive(el);
    sheet.open(wordSheet(word, si), () => setActive(null));
  }

  /** Mark a word hard. A word the list does not have yet is added to it first. */
  function flag(word) {
    let entry = store.index.find(word.l);
    if (!entry) {
      // With the "Added while reading" list turned off, words outside the lists are left alone.
      if (store.isListOff(FROM_TEXT)) return;
      store.addCustom([{ de: word.l || word.w, en: word.g || '?', src: FROM_TEXT }]);
      entry = store.index.find(word.l);
      if (!entry) return;
    }
    if (entry.id in text.hard) return;
    const before = store.progressOf(entry.id) || null;
    text.hard[entry.id] = before;
    text.tapped[entry.id] = true;
    store.setProgress(entry.id, markHard(before, Date.now(), rulesOf(store.state.prefs)));
    onChange();
  }

  function unflag(id) {
    const before = text.hard[id];
    delete text.hard[id];
    store.setProgress(id, before ? { ...before, u: Date.now() } : resetWord(Date.now()));
    onChange();
  }

  function speakButton(phrase) {
    if (!tts.supported) return null;
    return h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Listen',
        onclick: () => {
          stopListening();
          tts.speak([phrase], { rate: store.state.prefs.rate, voice: store.local.voice });
        },
      },
      icon('speaker'),
    );
  }

  function wordSheet(word, si) {
    const wrap = h('div', { class: 'ws' });
    const draw = () => {
      const entry = store.index.find(word.l);
      const id = entry?.id || idOf(word);
      const p = store.progressOf(id);
      const marked = id in text.hard;
      const hard = (p?.s ?? 0) < 0;
      const scored = !isUnscored(word) && (!!entry || !store.isListOff(FROM_TEXT));
      const base = entry?.de || word.l;
      const showBase = base && (base.toLowerCase() !== word.w.toLowerCase() || (entry && entry.en !== word.g));

      fill(
        wrap,
        h('div', { class: 'ws-head' }, h('span', { class: 'ws-word', lang: 'de' }, word.w), speakButton(word.w)),
        h('p', { class: 'ws-gloss' }, word.g || 'No translation available'),
        showBase &&
          h('p', { class: 'ws-base' }, h('span', { lang: 'de' }, base), entry && entry.en ? ` · ${entry.en}` : ''),
        h(
          'div',
          { class: 'ws-actions' },
          scored &&
            (marked
              ? h(
                  'button',
                  { class: 'btn btn-hard is-on', type: 'button', onclick: () => (unflag(id), draw()) },
                  icon('flag', 18),
                  'Marked hard · Undo',
                )
              : h(
                  'button',
                  { class: 'btn btn-hard', type: 'button', onclick: () => (flag(word), draw()) },
                  icon('flag', 18),
                  hard ? 'Mark hard again' : 'Mark as hard',
                )),
          scored &&
            hard &&
            !marked &&
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => (store.setProgress(id, clearHard(p, Date.now(), rulesOf(store.state.prefs))), draw()),
              },
              icon('check', 18),
              'I know this now',
            ),
          h('button', { class: 'btn', type: 'button', onclick: () => openSentence(si) }, 'Whole sentence'),
        ),
      );
    };
    draw();
    return wrap;
  }

  function openSentence(si) {
    const s = text.sentences[si];
    setActive(bodyEl.querySelector(`.sent[data-si="${si}"]`));
    sheet.open(
      h(
        'div',
        { class: 'ws' },
        h('div', { class: 'ws-head' }, h('span', { class: 'ws-kicker' }, 'Sentence'), speakButton(s.de)),
        h('p', { class: 'ss-de', lang: 'de' }, s.de),
        h('p', { class: 'ss-en' }, s.en || 'No translation available'),
      ),
      () => setActive(null),
    );
  }

  // ---- listening -----------------------------------------------------------

  function paintListenBtn() {
    if (!listenBtn) return;
    fill(listenBtn, icon(speaking ? 'stop' : 'play', 18), speaking ? 'Stop' : 'Listen');
  }

  function markSpeaking(si) {
    bodyEl?.querySelector('.sent.is-speaking')?.classList.remove('is-speaking');
    if (si >= 0) bodyEl?.querySelector(`.sent[data-si="${si}"]`)?.classList.add('is-speaking');
  }

  function stopListening() {
    if (!speaking) return;
    speaking = false;
    tts.stop();
    markSpeaking(-1);
    paintListenBtn();
  }

  function toggleListening() {
    if (speaking) return stopListening();
    if (!text?.sentences.length) return;
    speaking = true;
    paintListenBtn();
    tts.speak(
      text.sentences.map((s) => s.de),
      {
        rate: store.state.prefs.rate,
        voice: store.local.voice,
        onPiece: markSpeaking,
        onDone: () => {
          speaking = false;
          markSpeaking(-1);
          paintListenBtn();
        },
      },
    );
  }

  return {
    mount,
    appendSentence,
    repaint,
    paintUnderline,
    stopListening,
    /** The Listen button for the mounted text, or null where speech is unavailable. */
    listenButton: () => listenBtn,
  };
}
