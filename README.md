# Harper for Joplin

Grammar and spell checking for [Joplin](https://joplinapp.org)'s Markdown editor, powered by
[Harper](https://writewithharper.com) — the fast, private grammar checker from Automattic.

Harper runs **entirely on your machine**. There is no cloud service, no account, and no network
request: your notes never leave your computer. The whole checker (a compiled WebAssembly engine)
ships inside the plugin, so it works fully offline.

As you type in the Markdown editor, Harper underlines spelling and grammar issues with a coloured
squiggle, and clicking an underline opens a small card with the problem,
one-click fixes, and follow-up actions.

![The Harper suggestion card and coloured underlines in the Joplin Markdown editor](https://raw.githubusercontent.com/pmslava/joplin-plugin-harper/main/docs/screenshots/card-light.png)

![The suggestion card in Joplin's dark theme](https://raw.githubusercontent.com/pmslava/joplin-plugin-harper/main/docs/screenshots/card-dark.png)

Per-kind coloured underlines — a red spelling squiggle, an orange typo, a green word-choice
suggestion:

![Close-up of the per-kind coloured underlines](https://raw.githubusercontent.com/pmslava/joplin-plugin-harper/main/docs/screenshots/underlines-dark.png)

## Features

- **Coloured underlines, one colour per issue type.** Harper sorts every finding into one of its
  lint kinds — Spelling, Grammar, Punctuation, Word Choice, Repetition, Redundancy, Style, and more
  (21 in all) — and each kind gets its own squiggle colour, so you can tell a misspelling from a
  style nudge at a glance. The colours are Harper's own and work in both light and dark themes.
- **Solid or squiggly underlines — your choice.** Prefer a straight line to a wavy one? Switch
  **Underline style** to *Solid line* for a clean 2 px underline with a light tint, in the same
  per-kind colour. The change applies straight away, no restart or note reopen.
- **A suggestion card.** Click an underline to open a card that shows the issue
  type, Harper's explanation with the flagged word highlighted, and the available fixes.
- **Apply a fix in one click.** Each suggestion is a pill; clicking it rewrites the text (replace,
  remove, or insert) directly in the editor.
- **Add to dictionary.** Spelling cards include an add-to-dictionary button, so a name or term you
  use often stops being flagged (see [External dictionary](#external-dictionary) below).
- **Ignore a single finding.** *Dismiss* hides just that one underline and remembers the choice
  between sessions, without disabling the rule everywhere.
- **Disable a rule.** The toggle in the card header turns off the rule that produced the finding,
  everywhere, from then on.
- **Dialects.** Check against American, British, Australian, or Canadian English.

## External dictionary

By default, words you add via *Add to dictionary* are stored in the plugin's own private word list.

You can instead point Harper at a **plain-text dictionary file of your own** — one word per line —
by setting **External dictionary file** to its absolute path. When that path is set:

- Every word in the file is treated as correctly spelled.
- *Add to dictionary* **appends** the new word to that same file (one word per line).
- The file is re-read automatically about every 60 seconds, so changes made outside Joplin are
  picked up without a restart.
- **Removals are picked up too.** Delete a word from the file (or from the dictionary note, if you
  use one) and the plugin removes it everywhere else as well, so it starts being flagged again.

Deleting a word is the one case where the plugin writes more than a new line, so it does as little
as it can: it drops only the lines for words you removed, appends genuinely new words at the end,
and leaves every other line, comments included, exactly where it was. Surviving lines are never
reordered or rewritten, and the file is left completely untouched when nothing changed. Writes go
through a temporary file in the same directory and an atomic rename, and if the file changes while
the plugin is working on it, the write is abandoned and retried on the next pass, so a sync client
writing at the same moment is never clobbered.

This is deliberately just a flat text file with no special format. That makes it easy to keep the
file wherever you like and sync it between machines with your own tooling (a synced folder, a
version-controlled dotfile, `rsync`/`rclone`, and so on) — or to share the same word list with
another tool that reads a plain word-per-line dictionary.

## Settings

Open **Tools → Options → Harper** (desktop).

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Harper grammar checking** | On | Master switch. When off, no underlines are shown. |
| **English dialect** | American | Which English variety Harper checks against: American, British, Australian, or Canadian. |
| **Lint debounce (ms)** | `500` | How long the editor waits after you stop typing before re-checking, in milliseconds (0–10000). Changes apply immediately. |
| **Underline style** | Squiggly | How findings are underlined: *Squiggly (default)* for Harper's wavy underline, or *Solid line* for a straight 2 px line with a light tint. Either way the colour is the issue type's. Changes apply immediately. |
| **External dictionary file** | *(empty)* | Absolute path to a plain-text dictionary (one word per line). Empty means the plugin uses its own private word list. See [External dictionary](#external-dictionary). |
| **Rule overrides (JSON)** | *(empty)* | *Advanced.* A JSON object of `{"RuleName": true \| false}` applied on top of the defaults, e.g. `{"SpelledNumbers": false}`. Invalid JSON is ignored. |

## Installation

### From the Joplin plugin marketplace

Once the plugin is listed: in Joplin desktop, go to **Tools → Options → Plugins**, search for
**Harper**, and click **Install**. Restart Joplin when prompted.

### Manually (.jpl from GitHub releases)

1. Download `io.github.pmslava.harper.jpl` from the
   [latest release](https://github.com/pmslava/joplin-plugin-harper/releases).
2. In Joplin desktop, go to **Tools → Options → Plugins**.
3. Under **Manage your plugins**, use the gear/⋮ menu → **Install from file**, and select the
   downloaded `.jpl`.
4. Restart Joplin when prompted.

## Requirements and limits

- **Joplin desktop, version 3.1 or newer.** The plugin uses Joplin's CodeMirror 6 editor
  integration, which requires 3.1+.
- **Markdown editor only.** Harper checks the Markdown (CodeMirror) editor. It does **not** work in
  the Rich Text (WYSIWYG) editor, which offers no hook for this kind of decoration.
- **Desktop only.** There is no mobile build.
- **About 16 MB.** The plugin bundles Harper's WebAssembly engine so it can run offline, which makes
  the `.jpl` roughly 16 MB — larger than a typical plugin, but that is the whole checker, downloaded
  once.
- **Startup warm-up.** The first check after you open a note takes a second or two while the engine
  loads and warms up. After that, re-checking a typical note is fast — on the order of ~50 ms for a
  few kilobytes of text.

## Privacy

Harper runs locally and makes **no network calls**. Your note text is passed to the bundled
WebAssembly engine inside Joplin and nowhere else — nothing is uploaded, and there is no telemetry.
The external dictionary, if you use one, is a file on your own disk.

## Development

```bash
npm install
npm test          # builds the plugin and runs the harness suite (incl. performance budgets)
npm run test:e2e  # full end-to-end suite: launches a real Joplin desktop under Xvfb (Linux)
npm run dist      # build only -> publish/io.github.pmslava.harper.jpl
```

**Architecture in one line:** the grammar checker (harper.js `LocalLinter`, WASM) runs in the
plugin main process, and a CodeMirror 6 content script draws the underlines and the suggestion card,
talking to it over Joplin's `postMessage` bridge.

For the full design, the WASM loading approach, the UI spec, and the research behind the plugin, see
[`docs/`](docs/) — in particular [`docs/SPEC.md`](docs/SPEC.md).

## License

The plugin is licensed under the [MIT License](LICENSE).

It embeds and is powered by [Harper](https://github.com/automattic/harper) (via the
[`harper.js`](https://www.npmjs.com/package/harper.js) package), which is developed by **Automattic**
and licensed under the **Apache License 2.0**. All credit for the grammar-checking engine goes to the
Harper project — this plugin only integrates it into Joplin.
