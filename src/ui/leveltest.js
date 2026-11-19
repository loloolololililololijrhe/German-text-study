// The level test: its card on the Settings tab, and the test itself, which
// takes over the tab while it runs.

import { store } from '../store.js';
import { fill, h, icon, segmented, toast } from './dom.js';
import { LEVELS } from '../lib/prompt.js';
import {
  LEVEL_PASS,
  LEVEL_SIZE,
  STAGE_PASS,
  STAGE_SIZE,
  TEST_LEVELS,
  drawItems,
  findResult,
  gradeStage,
  levelPassed,
  levelResult,
  markSeen,
  placement,
  present,
  textLevelFor,
} from '../lib/leveltest.js';

/**
 * The test being taken, or null:
 * { mode, level, bank, scores, log, stage: { level, items, i, picked, correct }, screen, result }
 */
let session = null;
let chosen = 'B1'; // the level picked on the card for a single-level test
let host = null; // { root, onExit } while the test is on screen

export const testRunning = () => !!session;

const shortDate = (at) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const levelName = (level) => level || 'before A1';

/** One line for a past result. */
function resultLine(t) {
  if (t.mode === 'find') return `${shortDate(t.at)} · Find my level · ${levelName(t.level)}`;
  const [, correct, total] = t.scores[0];
  return `${shortDate(t.at)} · ${t.level} test · ${correct} of ${total} · ${t.pass ? 'passed' : 'not passed'}`;
}

// ---- the card on the Settings tab ------------------------------------------

/**
 * @param {object} o
 * @param {() => void} o.redraw   draw the card again
 * @param {() => void} o.started  the test has begun and should be put on screen
 */
export function levelTestCard({ redraw, started }) {
  const tests = store.state.tests || [];
  const begin = async (mode, level) => {
    if (await startTest(mode, level)) started();
  };
  return [
    h(
      'p',
      { class: 'help' },
      'Multiple-choice questions on grammar, vocabulary and reading, from A1 to C2. It is a rough guide, not a certificate: it cannot hear you speak or read what you write.',
    ),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => begin('find') }, 'Find my level'),
    ),
    h(
      'p',
      { class: 'help' },
      `Starts at A1 with ${STAGE_SIZE} questions a level and goes on to the next level for as long as you pass (${STAGE_PASS} of ${STAGE_SIZE}). It takes 5 to 25 minutes, depending on how far you get.`,
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'label' }, 'Or test one level'),
      segmented(
        TEST_LEVELS.map((id) => ({ id, label: id })),
        chosen,
        (id) => {
          chosen = id;
          redraw();
        },
        'Level to test',
      ),
      h(
        'div',
        { class: 'btn-row' },
        h(
          'button',
          { class: 'btn', type: 'button', onclick: () => begin('level', chosen) },
          `Start the ${chosen} test`,
        ),
      ),
      h('span', { class: 'help' }, `${LEVEL_SIZE} questions of that level; ${LEVEL_PASS} right is a pass.`),
    ),
    tests.length > 0 &&
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, 'Your results'),
        h(
          'ul',
          { class: 'lt-past' },
          tests.slice(0, 5).map((t) => h('li', null, resultLine(t))),
        ),
      ),
  ];
}

// ---- running a test --------------------------------------------------------

/** Load the questions and begin. Resolves to whether the test started. */
async function startTest(mode, level) {
  let bank;
  try {
    // The questions are fetched when a test starts, not with the rest of the app.
    ({ BANK: bank } = await import('../data/leveltest.js'));
  } catch {
    toast('Could not load the test. Check your internet connection and try again.');
    return false;
  }
  session = {
    mode,
    level: mode === 'level' ? level : '',
    bank,
    scores: [],
    log: [],
    stage: null,
    screen: '',
    result: null,
  };
  beginStage(mode === 'level' ? level : TEST_LEVELS[0]);
  return true;
}

function beginStage(level) {
  const seen = store.local.testSeen || {};
  const items = drawItems(session.bank, level, session.mode === 'find' ? STAGE_SIZE : LEVEL_SIZE, seen);
  store.setLocal({ testSeen: markSeen(seen, items) });
  session.stage = { level, items: items.map((it) => present(it)), i: 0, picked: null, correct: 0 };
  session.screen = 'question';
}

/** Put the running test on screen; `onExit` is called when it is left. */
export function mountTest(root, onExit) {
  host = { root, onExit };
  draw();
}

function draw() {
  if (!host || !session) return;
  const screens = { question, between, result, review };
  fill(host.root, screens[session.screen]());
}

function leave() {
  session = null;
  const { onExit } = host;
  host = null;
  onExit();
}

function pick(index) {
  const { stage } = session;
  if (stage.picked != null) return;
  const q = stage.items[stage.i];
  stage.picked = index;
  if (index === q.answer) stage.correct++;
  session.log.push({ q, picked: index });
  draw();
  host.root.querySelector('.lt-next')?.focus({ preventScroll: true });
}

function next() {
  const { stage } = session;
  stage.i++;
  stage.picked = null;
  if (stage.i >= stage.items.length) endStage();
  draw();
  window.scrollTo(0, 0);
}

function endStage() {
  const { stage } = session;
  session.scores.push({ level: stage.level, correct: stage.correct, total: stage.items.length });
  if (session.mode === 'find' && placement(session.scores).next) session.screen = 'between';
  else finish();
}

function finish() {
  const { mode, scores } = session;
  session.result =
    mode === 'find'
      ? findResult(scores, Date.now())
      : levelResult(scores[0].level, scores[0].correct, scores[0].total, Date.now());
  store.addTest(session.result);
  session.screen = 'result';
}

function goTo(screen) {
  session.screen = screen;
  draw();
  window.scrollTo(0, 0);
}

// ---- screens ---------------------------------------------------------------

function progress(done, of, label) {
  return h(
    'div',
    {
      class: 'goal-bar',
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': String(of),
      'aria-valuenow': String(done),
    },
    h('span', { style: `width: ${(done / of) * 100}%` }),
  );
}

function question() {
  const { stage, mode } = session;
  const q = stage.items[stage.i];
  const answered = stage.picked != null;
  const right = stage.picked === q.answer;
  const last = stage.i === stage.items.length - 1;
  const german = q.kind === 'gap' || q.kind === 'meaning';

  const options = q.options.map((text, i) => {
    const state = !answered ? '' : i === q.answer ? ' is-right' : i === stage.picked ? ' is-wrong' : ' is-off';
    return h(
      'button',
      { class: `lt-option${state}`, type: 'button', disabled: answered, onclick: () => pick(i) },
      h('span', null, text),
      answered && i === q.answer && icon('check', 18),
      answered && i === stage.picked && !right && icon('close', 18),
    );
  });

  const verdict = right ? 'Right.' : stage.picked === -1 ? 'The answer is' : 'Not quite. The answer is';
  const solution = q.options[q.answer];
  return h(
    'section',
    { class: 'lt' },
    h(
      'div',
      { class: 'lt-head' },
      h('span', { class: 'lt-where' }, mode === 'find' ? `Find my level · ${stage.level}` : `${stage.level} test`),
      h('span', { class: 'lt-count' }, `Question ${stage.i + 1} of ${stage.items.length}`),
    ),
    progress(stage.i + (answered ? 1 : 0), stage.items.length, 'Questions answered at this level'),
    q.text && h('blockquote', { class: 'lt-text', lang: 'de' }, q.text),
    h('p', { class: 'lt-ask' }, q.ask),
    q.q && h('p', { class: 'lt-q', lang: german ? 'de' : null }, q.q),
    h('div', { class: 'lt-options', role: 'group', 'aria-label': 'Answers' }, options),
    !answered &&
      h('button', { class: 'btn btn-quiet lt-skip', type: 'button', onclick: () => pick(-1) }, 'I don’t know'),
    answered &&
      h(
        'p',
        { class: `notice lt-feedback${right ? ' is-good' : ''}`, role: 'status' },
        h(
          'span',
          null,
          h('b', null, right ? verdict : `${verdict} „${solution}“${/[.!?]$/.test(solution) ? '' : '.'}`),
          ' ',
          q.why,
        ),
      ),
    answered &&
      h(
        'button',
        { class: 'btn btn-primary btn-big lt-next', type: 'button', onclick: next },
        !last ? 'Next question' : mode === 'find' ? 'Finish this level' : 'See my result',
      ),
    h(
      'button',
      {
        class: 'btn btn-quiet lt-stop',
        type: 'button',
        onclick: () => {
          if (confirm('Stop the test? Nothing is saved for a test you do not finish.')) leave();
        },
      },
      'Stop the test',
    ),
  );
}

/** The levels taken so far, each with its score as a bar. */
function scoreList(scores, grade) {
  return h(
    'ul',
    { class: 'ratios lt-scores' },
    scores.map(([level, correct, total]) =>
      h(
        'li',
        { class: 'ratio' },
        h('span', { class: 'ratio-name' }, level),
        h('span', { class: 'ratio-figure' }, `${correct} of ${total} · ${grade(correct, total)}`),
        h(
          'span',
          {
            class: 'ratio-bar',
            role: 'meter',
            'aria-label': `${level} score`,
            'aria-valuemin': '0',
            'aria-valuemax': String(total),
            'aria-valuenow': String(correct),
          },
          h('span', { style: `width:${(correct / total) * 100}%` }),
        ),
      ),
    ),
  );
}

const STAGE_WORDS = { pass: 'passed', near: 'one short of a pass', fail: 'not passed' };
const stageWords = (correct, total) => STAGE_WORDS[gradeStage(correct, total)];

/** Between two levels of "Find my level". */
function between() {
  const { scores } = session;
  const done = scores.at(-1);
  const upNext = placement(scores).next;
  const passed = gradeStage(done.correct, done.total) === 'pass';
  return h(
    'section',
    { class: 'lt' },
    h('h1', { class: 'page-title' }, `${done.level}: ${done.correct} of ${done.total}`),
    h(
      'p',
      { class: 'lt-lead' },
      passed
        ? `Passed. Next comes ${upNext}, with ${STAGE_SIZE} more questions.`
        : `One short of a pass (${STAGE_PASS} are needed). If you pass ${upNext}, that makes up for it.`,
    ),
    scoreList(
      scores.map((s) => [s.level, s.correct, s.total]),
      stageWords,
    ),
    h(
      'button',
      {
        class: 'btn btn-primary btn-big',
        type: 'button',
        onclick: () => {
          beginStage(upNext);
          draw();
          window.scrollTo(0, 0);
        },
      },
      `Continue with ${upNext}`,
    ),
    h(
      'button',
      {
        class: 'btn btn-quiet lt-stop',
        type: 'button',
        onclick: () => {
          finish();
          draw();
          window.scrollTo(0, 0);
        },
      },
      'Finish here',
    ),
  );
}

function result() {
  const r = session.result;
  const find = r.mode === 'find';
  const [, correct, total] = r.scores[0];
  const offered = Object.keys(LEVELS);
  const textLevel = textLevelFor(r.level, offered);
  const current = store.state.prefs.level;

  const title = find ? `Your level: ${r.level || 'beginner'}` : `${r.level} test: ${correct} of ${total}`;
  let lead;
  if (!find) {
    lead = r.pass
      ? `Passed. ${LEVEL_PASS} of ${LEVEL_SIZE} are needed.`
      : `Not passed yet: ${LEVEL_PASS} of ${LEVEL_SIZE} are needed.`;
  } else if (r.level === TEST_LEVELS.at(-1)) lead = 'You passed all six levels.';
  else if (r.level) lead = `${r.level} is the highest level you passed.`;
  else lead = `You did not reach the pass mark for A1 this time (${STAGE_PASS} of ${STAGE_SIZE}).`;

  return h(
    'section',
    { class: 'lt' },
    h('h1', { class: 'page-title' }, title),
    h('p', { class: 'lt-lead' }, lead),
    scoreList(r.scores, find ? stageWords : (c, t) => (levelPassed(c, t) ? 'passed' : 'not passed')),
    find &&
      h(
        'div',
        { class: 'notice has-action' },
        h(
          'p',
          null,
          offered.includes(r.level) || !r.level
            ? `For the texts in this app, ${textLevel} is the level to choose.`
            : `The app writes texts up to ${offered.at(-1)}, so that is the level to choose.`,
          current === textLevel ? ' That is what you have now.' : ` You have ${current} now.`,
        ),
        current !== textLevel &&
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                store.updatePrefs({ level: textLevel });
                toast(`Your texts are now written at ${textLevel}`);
                draw();
              },
            },
            `Use ${textLevel} for my texts`,
          ),
      ),
    h(
      'p',
      { class: 'help' },
      'The result rests on grammar, vocabulary and reading only, and on a small number of questions, so take it as a guide. It is kept under “Your results” in Settings.',
    ),
    h('button', { class: 'btn btn-big', type: 'button', onclick: () => goTo('review') }, 'Look through my answers'),
    h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: leave }, 'Back to Settings'),
  );
}

/** Every question of the test with the answer given, the right answer and the reason. */
function review() {
  return h(
    'section',
    { class: 'lt' },
    h('h1', { class: 'page-title' }, 'Your answers'),
    h(
      'ol',
      { class: 'lt-review' },
      session.log.map(({ q, picked }, n) => {
        const right = picked === q.answer;
        return h(
          'li',
          { class: 'card' },
          h(
            'p',
            { class: 'lt-rev-head' },
            `${n + 1} · ${q.level} · `,
            h('b', null, right ? 'Right' : picked === -1 ? 'Not answered' : 'Wrong'),
          ),
          q.text && h('blockquote', { class: 'lt-text', lang: 'de' }, q.text),
          h('p', { class: 'lt-ask' }, q.ask),
          q.q && h('p', { class: 'lt-q is-small' }, q.q),
          h(
            'ul',
            { class: 'lt-rev-options' },
            q.options.map((text, i) =>
              h(
                'li',
                { class: i === q.answer ? 'is-right' : i === picked ? 'is-wrong' : null },
                i === q.answer ? icon('check', 16) : i === picked ? icon('close', 16) : h('span', { class: 'icon' }),
                h('span', null, text, i === picked && ' (your answer)'),
              ),
            ),
          ),
          h('p', { class: 'help' }, q.why),
        );
      }),
    ),
    h(
      'button',
      { class: 'btn btn-primary btn-big', type: 'button', onclick: () => goTo('result') },
      'Back to my result',
    ),
  );
}
