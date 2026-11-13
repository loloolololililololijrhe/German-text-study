import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceStream, segmentSentence } from '../src/lib/textparse.js';
import { FORMS, LENGTHS, TEXT_SCHEMA, TOPICS, buildUserPrompt } from '../src/lib/prompt.js';

const DOC = {
  title: 'Am Bahnhof',
  sentences: [
    {
      de: 'Anna steht früh auf.',
      en: 'Anna gets up early.',
      br: true,
      words: [
        { w: 'Anna', l: 'Anna', g: '(name)' },
        { w: 'steht', l: 'aufstehen', g: 'gets up' },
        { w: 'früh', l: 'früh', g: 'early' },
        { w: 'auf', l: 'aufstehen', g: 'gets up' },
      ],
    },
    {
      de: 'Sie sagt: „Der Zug {kommt} um \\"acht\\"!“',
      en: 'She says: "The train comes at eight!"',
      br: false,
      words: [
        { w: 'Sie', l: 'sie', g: 'she' },
        { w: 'sagt', l: 'sagen', g: 'says' },
        { w: 'Der', l: 'der', g: 'the' },
        { w: 'Zug', l: 'der Zug', g: 'train' },
        { w: 'kommt', l: 'kommen', g: 'comes' },
        { w: 'um', l: 'um', g: 'at' },
        { w: 'acht', l: 'acht', g: 'eight' },
      ],
    },
  ],
};

test('sentences are emitted as soon as each one is complete, whatever the chunking', () => {
  const json = JSON.stringify(DOC);
  for (const size of [1, 2, 7, 33, json.length]) {
    const stream = new SentenceStream();
    const got = [];
    for (let i = 0; i < json.length; i += size) got.push(...stream.push(json.slice(i, i + size)));
    assert.equal(stream.title, 'Am Bahnhof', `chunk ${size}`);
    assert.deepEqual(got, DOC.sentences, `chunk ${size}`);
    assert.ok(stream.ended);
  }
});

test('the first sentence is available before the second has finished streaming', () => {
  const json = JSON.stringify(DOC);
  const cut = json.indexOf('Sie sagt');
  const stream = new SentenceStream();
  const early = stream.push(json.slice(0, cut));
  assert.equal(early.length, 1);
  assert.equal(early[0].de, 'Anna steht früh auf.');
  assert.equal(stream.push(json.slice(cut)).length, 1);
});

test('a truncated stream keeps the sentences that completed', () => {
  const json = JSON.stringify(DOC);
  const stream = new SentenceStream();
  const got = stream.push(json.slice(0, json.length - 40));
  assert.equal(got.length, 1);
  assert.equal(stream.ended, false);
});

test('malformed or empty sentences are skipped', () => {
  const stream = new SentenceStream();
  const got = stream.push(
    '{"title":"T","sentences":[{"de":"","en":"x","br":false,"words":[]},{"de":"Hallo.","en":"Hello.","br":true,"words":[{"w":"Hallo","l":"hallo","g":"hello"},{"w":"","l":"","g":""}]}]}',
  );
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].words, [{ w: 'Hallo', l: 'hallo', g: 'hello' }]);
});

test('segmentSentence rebuilds the sentence exactly and marks each word', () => {
  for (const s of DOC.sentences) {
    const segs = segmentSentence(s.de, s.words);
    assert.equal(segs.map((x) => x.text).join(''), s.de);
    assert.deepEqual(
      segs.filter((x) => x.wi != null).map((x) => x.text),
      s.words.map((w) => w.w),
    );
  }
});

test('segmentSentence matches whole words only, in order', () => {
  // "in" must not match inside "eine" or "Berlin", and the second "in" is its own word.
  const de = 'Sie wohnt in einer kleinen Wohnung in Berlin.';
  const words = ['Sie', 'wohnt', 'in', 'einer', 'kleinen', 'Wohnung', 'in', 'Berlin'].map((w) => ({ w, l: w, g: '' }));
  const segs = segmentSentence(de, words);
  assert.equal(segs.map((x) => x.text).join(''), de);
  assert.equal(segs.filter((x) => x.wi != null).length, 8);

  const skipped = segmentSentence('Eine Frau wohnt in Berlin.', [{ w: 'in', l: 'in', g: 'in' }]);
  assert.deepEqual(skipped, [{ text: 'Eine Frau wohnt ' }, { text: 'in', wi: 0 }, { text: ' Berlin.' }]);
});

test('segmentSentence tolerates words the model spelled differently or invented', () => {
  const segs = segmentSentence('Der Hund schläft.', [
    { w: 'der', l: 'der', g: 'the' },
    { w: 'Katze', l: 'die Katze', g: 'cat' },
    { w: 'schläft', l: 'schlafen', g: 'sleeps' },
  ]);
  assert.equal(segs.map((x) => x.text).join(''), 'Der Hund schläft.');
  assert.deepEqual(
    segs.filter((x) => x.wi != null).map((x) => [x.text, x.wi]),
    [
      ['Der', 0],
      ['schläft', 2],
    ],
  );
});

test('the prompt lists every target word and flags the hard ones', () => {
  const targets = [
    { entry: { de: 'der Bahnhof', en: 'train station' }, hard: true },
    { entry: { de: 'gehen', en: 'to go' }, hard: false },
  ];
  const prompt = buildUserPrompt({ level: 'A2', length: 'short', topic: 'travel', targets, recentTitles: ['Im Park'] });
  assert.match(prompt, /^Level: A2/);
  assert.ok(prompt.includes(`Length: ${LENGTHS.short.words} words`));
  assert.ok(prompt.includes('- der Bahnhof (train station) [hard]'));
  assert.ok(
    prompt.includes('- gehen (to go)\n') || prompt.endsWith('- gehen (to go)') || prompt.includes('- gehen (to go)'),
  );
  assert.ok(!prompt.includes('- gehen (to go) [hard]'));
  assert.ok(prompt.includes('- Im Park'));
  assert.ok(prompt.includes(TOPICS.find((t) => t.id === 'travel').brief));
});

test('a typed topic is passed through, and "surprise" picks a concrete idea', () => {
  const base = { level: 'A2', length: 'medium', targets: [] };
  assert.ok(buildUserPrompt({ ...base, topic: 'my cat Minka' }).includes('Topic: my cat Minka'));
  const surprise = buildUserPrompt({ ...base, topic: 'surprise', rng: () => 0 });
  assert.match(surprise, /Topic: \S+/);
  assert.ok(!surprise.includes('Topic: surprise'));
});

test('the output schema satisfies the structured-output rules', () => {
  const check = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(check);
    } else if (node.type === 'array') check(node.items);
  };
  check(TEXT_SCHEMA);
});

// ---- plays -----------------------------------------------------------------------

test('the form is part of the request: prose unless a play is asked for', () => {
  const base = { level: 'A2', length: 'short', topic: 'travel', targets: [] };
  assert.deepEqual(Object.keys(FORMS), ['prose', 'play']);
  assert.ok(buildUserPrompt(base).includes(`Form: ${FORMS.prose.brief}`));
  assert.ok(buildUserPrompt({ ...base, form: 'nonsense' }).includes(`Form: ${FORMS.prose.brief}`));
  const play = buildUserPrompt({ ...base, form: 'play' });
  assert.ok(play.includes('Form: a short play to be read aloud'));
  assert.ok(play.includes('Topic: travelling'), 'a play still has its topic');
  assert.ok(!TOPICS.some((t) => t.id === 'dialogue'), 'the old Dialogue topic gave way to the form');
});

test('a play keeps the speaker of each sentence; other texts carry none', () => {
  const doc = {
    title: 'Im Café',
    sentences: [
      { de: 'Im Café.', en: 'In the café.', br: true, who: '', words: [{ w: 'Café', l: 'das Café', g: 'café' }] },
      {
        de: 'Hallo, Tom!',
        en: 'Hello, Tom!',
        br: true,
        who: ' Anna ',
        words: [{ w: 'Hallo', l: 'hallo', g: 'hello' }],
      },
      { de: 'Hallo!', en: 'Hello!', br: true, who: 'Tom', words: [{ w: 'Hallo', l: 'hallo', g: 'hello' }] },
    ],
  };
  const got = new SentenceStream().push(JSON.stringify(doc));
  assert.deepEqual(
    got.map((s) => s.who),
    [undefined, 'Anna', 'Tom'],
  );
  assert.ok(!('who' in got[0]), 'a stage direction has no speaker');
  assert.equal(TEXT_SCHEMA.properties.sentences.items.properties.who.type, 'string');
});

test('texts carry 10, 18 or 30 study words, and optional review words follow the targets', () => {
  assert.deepEqual(
    Object.values(LENGTHS).map((l) => l.targets),
    [10, 18, 30],
  );
  const targets = [{ entry: { de: 'gehen', en: 'to go' }, hard: false }];
  const extras = [
    { de: 'der Zug', en: 'train' },
    { de: 'kaufen', en: 'to buy' },
  ];
  const prompt = buildUserPrompt({
    level: 'A2',
    length: 'long',
    topic: 'travel',
    targets,
    extras,
    recentTitles: ['Im Park'],
  });
  assert.ok(prompt.includes(`Length: ${LENGTHS.long.words} words`));
  const [required, optional] = prompt.split('None of these is required');
  assert.ok(required.includes('- gehen (to go)') && !required.includes('der Zug'));
  assert.ok(optional.includes('- der Zug (train)') && optional.includes('- kaufen (to buy)'));
  assert.ok(optional.indexOf('- kaufen') < optional.indexOf('- Im Park'), 'before the recent titles');
  assert.ok(
    !buildUserPrompt({ level: 'A2', length: 'long', topic: 'travel', targets }).includes('None of these is required'),
  );
});
