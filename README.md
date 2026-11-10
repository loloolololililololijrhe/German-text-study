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
4. Tap a word to see what it means. Tap the small `EN` after a sentence to
   translate the whole sentence. `Listen` reads the text aloud.
5. Press **Done reading** when you finish.

### Your Anki deck

**Settings → Word lists → Import Anki deck** accepts an `.apkg` deck, a
`.colpkg` collection, or a "Notes in Plain Text" export. The app suggests which
deck to take (a collection can hold several), which field is the German word
and which field or fields hold the English meaning; check the preview, change
them if needed, and the words are added to the list.

The app also ships with about 1,600 common German words, cognates included, so
words your deck leaves out are still covered. A word that is in both appears
once, with your deck's wording.

To make a deck the built-in default for everyone who opens the site, put its
words in `src/data/deck.json` as `[{ "de": "der Hund", "en": "dog" }, ...]`.
Only do this with a list you are free to publish: the repository and the site
are public. A deck you bought belongs in the import instead, where it stays in
your browser and your own sync gist.

### Sync between devices

**Settings → Sync between devices**: create a GitHub token with only the `gist`
permission and paste it in on each device. Scores, imported words and
preferences are stored in a private gist on your account and merged every time
the app opens or you finish a text. The Claude API key is never synced.

## How words are chosen

Every word has a score, starting at 0.

| What happens | Effect on the word |
| --- | --- |
| You mark it hard (or tap it, with "Mark tapped words as hard" on) | Score drops by 3, down to −6 at most |
| It appears in a text you finish and you did not tap it | Score rises by 1, up to +6 |
| You tap it without marking it hard | Counted as seen, score unchanged |
| "I know this now" | A hard word goes straight back to normal |

Each new text is written around a handful of target words (8, 12 or 18,
depending on length). Hard words get up to 60% of those places. The rest are
drawn from every other word, where each point of score halves a word's chance
and more common words are slightly preferred. No word's chance ever reaches
zero, and well-known words still turn up whenever a text needs them.

So a word you marked hard needs three clean reads to become normal again, and
the **Words** tab shows every word with its score.

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
  (`words.js`), scoring and selection (`scoring.js`), the prompt (`prompt.js`),
  stream parsing (`textparse.js`), Anki import (`anki.js`) and sync merging
  (`merge.js`). `tests/` covers all of it.
- `src/ui/` holds the three screens, `src/claude.js` the Claude API call and
  `src/gist.js` the sync storage.
- `src/data/common-*.txt` is the built-in word list, one `German = English`
  per line, most frequent first.
