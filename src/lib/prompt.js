// The request sent to Claude for each reading text. Pure functions, no DOM.

export const LEVELS = {
  A1: 'A1 (beginner): very short main clauses, present tense, the most basic everyday vocabulary.',
  A2: 'A2 (elementary): short, clear sentences; present tense and Perfekt; modal verbs; simple clauses with weil, dass, wenn.',
  B1: 'B1 (intermediate): connected paragraphs; Präteritum where natural; relative clauses and a wider range of connectors.',
  B2: 'B2 (upper intermediate): natural, varied prose, including passive and Konjunktiv II where they fit.',
};

export const LENGTHS = {
  short: { label: 'Short', words: '60 to 80', targets: 8 },
  medium: { label: 'Medium', words: '120 to 150', targets: 12 },
  long: { label: 'Long', words: '220 to 260', targets: 18 },
};

export const TOPICS = [
  { id: 'surprise', label: 'Surprise me', brief: '' },
  { id: 'daily', label: 'Daily life', brief: 'an everyday situation at home or around town' },
  { id: 'travel', label: 'Travel', brief: 'travelling: transport, a trip, or finding your way somewhere' },
  { id: 'food', label: 'Food', brief: 'food: cooking, eating out, or shopping for groceries' },
  { id: 'work', label: 'Work & school', brief: 'work, study, or school life' },
  { id: 'nature', label: 'Nature', brief: 'nature, weather, animals, or the outdoors' },
  { id: 'story', label: 'Story', brief: 'a short fictional story with a small twist at the end' },
  {
    id: 'dialogue',
    label: 'Dialogue',
    brief: 'a conversation between two people, written as dialogue with a line or two of narration',
  },
  { id: 'news', label: 'News', brief: 'a short, friendly news-style report about an invented local event' },
];

const SURPRISES = [
  'a small misunderstanding that gets resolved',
  'a letter or message to a friend',
  'a day when something unexpected happens',
  'someone learning a new skill',
  'a visit to a market, museum, or festival',
  'two neighbours who finally talk to each other',
  'a diary entry about an ordinary but memorable day',
  'a lost object and how it is found',
  'planning a celebration',
  'a short portrait of a person and their routine',
  'a journey that does not go to plan',
  'a scene at a train station, café, or park',
];

export const SYSTEM_PROMPT = `You write short German reading texts for a language learner and annotate every word, so the learner can tap any word in their reading app to see what it means.

The app chooses a set of target words the learner needs to practise. Write a natural, coherent text that is pleasant to read and uses every target word at least once. Target words marked "hard" are ones the learner keeps forgetting: use each of those twice if you can, in different sentences, in contexts that make the meaning easy to infer. Inflect target words as the grammar requires. Keep everything else in the text comfortably within the stated level, so the target words are the only real challenge. If a target word is a multi-word expression, use the whole expression.

Annotation rules, which the app relies on to make words tappable:
- "de" is the sentence exactly as it should be displayed. "en" is a natural English translation of that sentence.
- "br" is true when the sentence starts a new paragraph. In dialogue, each change of speaker starts a new paragraph.
- "words" lists every word of the sentence in order, leaving out punctuation. Each "w" must be spelled exactly as it appears in "de".
- "l" is the dictionary form: nouns in the nominative singular with their article ("der Bahnhof"), verbs in the infinitive, adjectives uninflected. For a separable verb, give the joined infinitive for both parts ("steht" and "auf" in "Er steht früh auf" both get "aufstehen"). For contractions give the preposition ("zum" gets "zu"). Names of people and places stay as they are.
- "g" is a short English gloss of the word as it is used in this sentence, one to three words. For a part that has no meaning alone, such as a separable prefix or a reflexive pronoun, give the meaning of the whole verb. For a name of a person, write exactly "(name)", so the app does not treat it as vocabulary.`;

export const TEXT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short German title for the text.' },
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          de: { type: 'string' },
          en: { type: 'string' },
          br: { type: 'boolean' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                w: { type: 'string' },
                l: { type: 'string' },
                g: { type: 'string' },
              },
              required: ['w', 'l', 'g'],
              additionalProperties: false,
            },
          },
        },
        required: ['de', 'en', 'br', 'words'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'sentences'],
  additionalProperties: false,
};

/**
 * @param {object} o
 * @param {string} o.level       key of LEVELS
 * @param {string} o.length      key of LENGTHS
 * @param {string} o.topic       id of TOPICS, or free text typed by the learner
 * @param {{entry:{de:string,en:string}, hard:boolean}[]} o.targets
 * @param {string[]} [o.recentTitles]
 * @param {() => number} [o.rng]
 */
export function buildUserPrompt({ level, length, topic, targets, recentTitles = [], rng = Math.random }) {
  const preset = TOPICS.find((t) => t.id === topic);
  let brief;
  if (preset && preset.id !== 'surprise') brief = preset.brief;
  else if (preset || !topic) brief = SURPRISES[Math.floor(rng() * SURPRISES.length)];
  else brief = topic;

  const lines = [
    `Level: ${LEVELS[level] || LEVELS.A2}`,
    `Length: ${(LENGTHS[length] || LENGTHS.medium).words} words`,
    `Topic: ${brief}`,
    '',
    'Target words:',
    ...targets.map((t) => `- ${t.entry.de} (${t.entry.en})${t.hard ? ' [hard]' : ''}`),
  ];
  if (recentTitles.length) {
    lines.push('', 'The learner has recently read texts with these titles. Write something different:');
    lines.push(...recentTitles.map((t) => `- ${t}`));
  }
  return lines.join('\n');
}
