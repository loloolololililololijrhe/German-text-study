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
4. Tap a word to see what it means. Tap the small `EN` after a sentence to
   translate the whole sentence. `Listen` reads the text aloud.
5. Press **Done reading** when you finish.

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
Words Anki is still teaching you come in as hard words. Importing again later
takes over the words Anki has reviewed since; words you reviewed more recently
in the app are left alone. (The app cannot write back to Anki.)

The built-in deck is `src/data/deck.json`:
`{ "name": "...", "words": [{ "de": "der Hund", "en": "dog" }, ...] }`.
Only put a list there that you are free to publish: the repository and the
site are public.

### Sync between devices

**Settings → Sync between devices**: create a GitHub token with only the `gist`
permission and paste it in on each device. Scores, imported words and
preferences are stored in a private gist on your account and merged every time
the app opens or you finish a text. The Claude API key is never synced.

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

Each new text is written around a handful of target words (8, 12 or 18,
depending on length), chosen in this order:

1. About a quarter of the places are kept for new words from your deck, in deck
   order, until the day's allowance (15) is used up.
2. Hard words take up to 60% of the places.
3. Due words take the rest, the ones you are most likely to have forgotten
   first.
4. Free places go to more new words within the allowance, then to early
   practice of the words due soonest.

The built-in common words are only chosen when your deck has nothing left to
offer, though a word you marked hard always comes back. They are still
rescheduled whenever they appear in a text.

**Settings → Reading** has the numbers:

- **New words a day** and **Bring a word back when the chance of knowing it
  is** are Anki's "new cards/day" and "desired retention".
- **A hard word is back on the schedule after** sets how many clean reads a
  hard word needs (Anki's relearning steps), and **The hardest a word can get**
  limits how far repeated marking can push that.
- **Underline hard words** can be turned off, so a hard word coming back looks
  like any other word.

The **Words** tab shows every word with its status, when it is due, and its
memory strength.

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
  stream parsing (`textparse.js`), Anki import (`anki.js`) and sync merging
  (`merge.js`). `tests/` covers all of it.
- `src/ui/` holds the three screens, `src/claude.js` the Claude API call and
  `src/gist.js` the sync storage.
- `src/data/common-*.txt` is the built-in word list, one `German = English`
  per line, most frequent first.
