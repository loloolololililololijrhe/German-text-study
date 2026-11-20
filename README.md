# German Text Study

Practise German by reading. The app writes a short text around the words you
most need to see, you tap any word you do not know to translate it, and the
words you find hard come back more often until they stick.

## Using it

1. Open the site (see [Publishing](#publishing)) on your phone or computer. On a
   phone, use "Add to Home Screen" to install it like an app.
2. **Settings → Claude API key**: paste a key from
   [platform.claude.com](https://platform.claude.com/settings/keys). Texts are
   written by Claude and billed to your own key. The key stays in your browser.
3. **Read → Generate text**. Pick a topic, a length and a level first if you like.
   With the topic **Fit the words**, Claude chooses whatever topic suits that
   text's words best.
   With the form **Play**, the text is written as lines spoken between named
   characters, like a script, on whichever topic you chose.
4. Tap a word to see what it means. Tap the small `EN` after a sentence to
   translate the whole sentence. `Listen` reads the text aloud.
5. Press **Done reading** when you finish.

The **History** tab keeps the last 30 texts you finished, so you can read them
again. Reading a past text does not reschedule its words; marking a word hard
there still counts.

### Your Anki deck

The app ships with the Refold DE1K deck built in (997 words, in the deck's
order) and about 1,600 common German words, cognates included, to cover what
the deck leaves out. A word that is in both appears once, with the deck's
wording.

**Settings → Word lists → Import Anki deck** accepts an `.apkg` deck, a
`.colpkg` collection, or a "Notes in Plain Text" export. The app suggests which
deck to take (a collection can hold several), which field is the German word
and which field or fields hold the English meaning; check the preview, change
them if needed, and the words are added to the list.

Importing your own collection also brings your Anki progress with it. With
**Use my Anki progress** on, every word you have studied in Anki carries on
from where Anki left it: the same memory strength, last review and due date.
Words Anki is still teaching you come in as hard words.

After the first import, **Update from Anki** brings the app up to date in one
step: export your collection from Anki again, choose the file, and the app
reads the same deck and fields as before and takes over every word Anki has
reviewed since. Words you reviewed more recently in the app are left alone.

This file is the only link to Anki. A website cannot sign in to AnkiWeb, and
the AnkiConnect add-on only works with Anki open on a computer, so there is no
automatic sync, and the app cannot write back to Anki.

Every list under **Settings → Word lists** has a switch. Turning a list off
leaves its words out of your word list and your texts, for example the common
words if you only want your deck. Nothing is deleted: the words and their
progress come back when you turn the list on again.

The built-in deck is `src/data/deck.json`:
`{ "name": "...", "words": [{ "de": "der Hund", "en": "dog" }, ...] }`.
Only put a list there that you are free to publish: the repository and the
site are public.

### Sync between devices

**Settings → Sync between devices**: create a GitHub token with only the `gist`
permission and paste it in on each device. Your schedule, imported words,
preferences, past texts and the numbers of the Stats tab are stored in a
private gist on your account and merged every time the app opens or you finish
a text. The Claude API key is
never synced.

## How words come back

Words are scheduled the way Anki schedules cards, with the same algorithm
(FSRS). Every word has a memory strength: the number of days after which the
chance of still knowing it falls to 90%. A word is due when that chance has
fallen to your target (88% unless you change it).

| What happens | Anki's button | Effect on the word |
| --- | --- | --- |
| It appears in a text you finish and you did not tap it | Good | Memory strength grows; the next due date moves further out (about 3 days the first time, then weeks, then months) |
| You look it up without marking it hard | Hard | Grows less; it comes back sooner |
| You mark it hard (or tap it, with "Mark tapped words as hard" on) | Again | Memory strength drops, and it needs 2 clean reads in the following texts before it is back on the schedule |
| "I know this now" on a hard word | | Straight back on the schedule |
| "Mark as known" | Easy | Not due again for months |

Finishing a text reviews every word in it at once, so the common words soon
have long intervals and stop taking up places.

Each new text must contain a set of your study words (10, 18 or 30, depending
on length), chosen in this order:

1. About a sixth of the places are kept for new words from your deck, in deck
   order, until the day's allowance (15) is used up.
2. Hard words take up to 40% of the places.
3. Due words take the rest, the ones you are most likely to have forgotten
   first.
4. Free places go to more new words within the allowance.
5. Places still free then go to more hard words, apart from a few (5) for
   early practice of the words due soonest. So once nothing is due and the
   day's new words are used up, a text is made of your hard words and those
   few early ones; with only a handful of hard words it asks for fewer words
   instead of padding. With no hard words left, the words due soonest fill
   the text.

On top of those, Claude is given more of your due words (12, 20 or 30) and
asked to work in as many as fit naturally. None of them is required, so the
text stays readable, but every one that makes it in is reviewed like any other
word. A long text can therefore clear several dozen due words in one read, and
the summary after "Done reading" says how many it cleared.

The built-in common words are only chosen when your deck has nothing left to
offer, though a word you marked hard always comes back. They are still
rescheduled whenever they appear in a text.

**Settings → Reading** has the numbers:

- **New words a day** and **Bring a word back when the chance of knowing it
  is** are Anki's "new cards/day" and "desired retention".
- **Daily goal** is how many texts you want to finish each day. With a goal
  set, the Read tab shows today's count and a progress bar. A text counts when
  you press "Done reading", and texts read on your other devices count too.
- **Hard words** offers three presets for the two options that follow:
  **Thorough** (2 clean reads, up to 4), **Balanced** (1, up to 2) and
  **Quick** (1, never more). The quicker the preset, the sooner the pile of
  hard words empties; a word that did not stick comes back through the normal
  schedule.
- **A hard word is back on the schedule after** sets how many clean reads a
  hard word needs (Anki's relearning steps), and **The hardest a word can get**
  limits how far repeated marking can push that.
- **Early words when only hard words are left** is the number in step 5:
  none, 3, 5, 10 or 15, or "No limit", which keeps hard words to 40% and
  fills the rest of the text with early words.
- **Underline hard words** can be turned off, so a hard word coming back looks
  like any other word.

The **Words** tab shows every word with its status, when it is due, and its
memory strength.

## Stats

The **Stats** tab keeps count of what happens in every text you finish, so you
can tune the settings from numbers instead of guesses. Pick Today, 7 days, 30
days or All at the top; everything below follows.

- **Tiles**: texts read, reading time, words reviewed, words looked up, new
  words started and hard words cleared, each with the figure per text.
- **How often you looked a word up**, by what the word was when the text
  began: new (first sight), hard (looked up again), due, and not due yet. The
  rate for hard words is the one that decides whether the pile of hard words
  shrinks; the card says where the limit lies with your hard-word settings.
  The rate for due words is your real retention, to compare with the target.
- **Your words**: hard, learning and known words over time, and the new words
  still to come.
- **Day by day**: texts (with your daily goal), minutes of reading, and lookups
  per text.
- **By kind of text**: the same figures per level and length, including words
  reviewed per minute.
- **The texts Claude wrote**: how many of the required words and of the
  optional due words made it into the text, how long you waited, and the
  tokens used.
- **Words you look up most**, and every day as a table, with a CSV download.

Reading time counts while a text is on screen and stops after three minutes
without a tap or scroll. The numbers start from the first text you finish after
this tab was added; they cannot be reconstructed for earlier texts. Each device
keeps its own record of a day, and syncing adds them up.

## Level test

**Settings → Level test** checks your German from A1 to C2 with multiple-choice
questions on grammar, vocabulary and reading.

- **Find my level** starts at A1 with 8 questions and moves up one level at a
  time for as long as you pass (6 of 8). A near miss (5 of 8) is forgiven if
  you pass the level after it. The result is the highest level you passed, and
  one tap sets the level of your texts to match.
- **Test one level** asks 12 questions of the level you pick; 9 right is a
  pass.

Each answer is marked straight away with a short explanation, "I don't know"
is always an option, and at the end you can look through every answer. A test
prefers questions you have not seen yet, so a second attempt differs from the
first. Results are kept and synced.

The 120 questions (20 per level) are in `src/data/leveltest.js`. They follow
the usual textbook progression but have not been calibrated on learners, and
the test cannot judge listening, speaking or writing, so the result is a guide
and not a certificate.

## Publishing

The repository deploys itself to GitHub Pages. Switch it on once: repository
**Settings → Pages → Source: GitHub Actions**. Every push to the default branch
then tests, builds and publishes the site at
`https://<user>.github.io/<repository>/`.

## Development

```sh
npm install
npm run dev      # local server with live reload
npm test         # unit tests
npm run build    # production build in dist/
```

The code is plain JavaScript modules built with Vite.

- `src/lib/` holds the logic with no browser dependencies: word matching
  (`words.js`), the schedule (`srs.js`, FSRS via the `ts-fsrs` library, checked
  against Anki's own results), marking and selection (`scoring.js`), the prompt
  (`prompt.js`),
  stream parsing (`textparse.js`), Anki import (`anki.js`), the daily goal
  (`goal.js`), the numbers of the Stats tab (`metrics.js`), the level test
  (`leveltest.js`) and sync merging
  (`merge.js`). `tests/` covers all of it.
- `src/ui/` holds the five screens, the shared text view and the charts
  (`chart.js`), `src/claude.js` the Claude API call and `src/gist.js` the sync
  storage.
- `src/data/common-*.txt` is the built-in word list, one `German = English`
  per line, most frequent first.
