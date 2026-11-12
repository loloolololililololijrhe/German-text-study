// The History tab: texts that were read, kept so they can be read again.

import { store } from '../store.js';
import { fill, h, plural } from './dom.js';
import { unpackSentences } from '../lib/merge.js';
import { createTextView } from './textview.js';

let root;
let view;
let openId = null; // the past text being read, or null for the list
let visible = false;

export function mountHistory(el, options) {
  root = el;
  view = createTextView({ sheet: options.sheet });
  store.subscribe((what) => {
    if (!visible) return;
    if (what === 'history' && !openId) render();
    if ((what === 'progress' || what === 'words') && openId) view.repaint();
  });
}

export function showHistory() {
  visible = true;
  render();
}

export function leaveHistory() {
  visible = false;
  view.stopListening();
}

const dateOf = (at) => new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function render() {
  const entry = openId && store.history.texts.find((t) => t.id === openId);
  if (!entry) openId = null;
  fill(root, entry ? renderText(entry) : renderList());
}

function renderList() {
  const texts = store.history.texts;
  if (!texts.length) {
    return h(
      'section',
      null,
      h('h1', { class: 'page-title' }, 'History'),
      h('p', { class: 'empty' }, 'Texts you finish with “Done reading” are kept here, so you can read them again.'),
    );
  }
  return h(
    'section',
    null,
    h('h1', { class: 'page-title' }, 'History'),
    h('p', { class: 'gen-info' }, `The last ${plural(texts.length, 'text')} you read, newest first.`),
    h(
      'ul',
      { class: 'rows history-rows' },
      texts.map((t) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              class: 'row',
              type: 'button',
              onclick: () => {
                openId = t.id;
                render();
                window.scrollTo(0, 0);
              },
            },
            h(
              'span',
              { class: 'row-text' },
              h('span', { class: 'row-de', lang: 'de' }, t.title || 'Ohne Titel'),
              h(
                'span',
                { class: 'row-en' },
                [dateOf(t.at), t.level, t.hard ? `${plural(t.hard, 'word')} marked hard` : '']
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn-quiet more',
        type: 'button',
        onclick: () => {
          if (confirm('Remove all past texts? This also applies to your other synced devices.')) store.clearHistory();
        },
      },
      'Clear history',
    ),
  );
}

function renderText(entry) {
  const back = () => {
    view.stopListening();
    openId = null;
    render();
    window.scrollTo(0, 0);
  };
  // Marks made while re-reading belong to this sitting only.
  const body = view.mount({ sentences: unpackSentences(entry), hard: {}, tapped: {}, surfaces: {} });
  return h(
    'article',
    { class: 'text' },
    h(
      'header',
      { class: 'text-head' },
      h('button', { class: 'btn btn-quiet back', type: 'button', onclick: back }, '‹ All texts'),
      h('p', { class: 'text-meta' }, [dateOf(entry.at), entry.level].filter(Boolean).join(' · ')),
      h('h1', { class: 'text-title', lang: 'de' }, entry.title || 'Ohne Titel'),
      h(
        'div',
        { class: 'text-tools' },
        view.listenButton(),
        h('span', { class: 'text-hint' }, 'Tap any word you do not know'),
      ),
    ),
    body,
    h(
      'footer',
      { class: 'text-foot' },
      h('button', { class: 'btn btn-big', type: 'button', onclick: back }, 'Back to the list'),
      h(
        'p',
        { class: 'foot-hint' },
        'Reading a text again does not reschedule its words. Marking a word hard still counts.',
      ),
    ),
  );
}
