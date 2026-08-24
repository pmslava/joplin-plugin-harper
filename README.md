# Harper for Joplin

Grammar and spell checking for [Joplin](https://joplinapp.org)'s Markdown editor, on desktop and
Android, powered by [Harper](https://writewithharper.com) — the fast, private grammar checker
from Automattic.

Harper runs **entirely on your machine**. There is no cloud service, no account, and no network
request: your notes never leave your computer. The whole checker (a compiled WebAssembly engine)
ships inside the plugin, so it works fully offline.

As you type in the Markdown editor, Harper underlines spelling and grammar issues with a coloured
squiggle, and clicking (or tapping) an underline opens a small card with the problem,
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
  use often stops being flagged — on every device (see [Your dictionary](#your-dictionary) below).
- **Ignore a single finding.** *Dismiss* hides just that one underline and remembers the choice
  between sessions, without disabling the rule everywhere.
- **Disable a rule.** The toggle in the card header turns off the rule that produced the finding,
  everywhere, from then on.
- **Dialects.** Check against American, British, Australian, or Canadian English.

## Your dictionary

By default, words you add via *Add to dictionary* are stored in the plugin's own private word list
on that device. Two settings turn it into one dictionary shared everywhere:

**Dictionary note (desktop and mobile).** Run the command **Harper: Create dictionary note** and the
plugin creates a regular Joplin note called "Harper Dictionary" — one word per line — and remembers
it in the **Dictionary note** setting. From then on, added words go into that note, and because it
is an ordinary note it syncs to every device through your normal Joplin sync. This is also the only
dictionary mechanism on mobile. You can edit the note by hand; deleting a line removes the word
everywhere.

**External dictionary file (desktop only).** Point **External dictionary file** at a
**plain-text dictionary file of your own** — one word per line. When that path is set:

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
another tool that reads a plain word-per-line dictionary, such as `harper-ls` in Zed, Neovim, or
VS Code.

**Using both together** is the full setup: with the note and the file both configured on desktop,
the plugin keeps them in sync with each other. A word added on your phone reaches the note through
Joplin sync, then the file — and from there any external tool that reads it. Deletions travel the
same way, in every direction.

## Settings

Open **Tools → Options → Harper** on desktop, or **Configuration → Plugins → Harper** on mobile.

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Harper grammar checking** | On | Master switch. When off, no underlines are shown. |
| **Dictionary note** | *(empty)* | The Joplin note that holds your shared word list. Set automatically by the **Harper: Create dictionary note** command. See [Your dictionary](#your-dictionary). |
| **English dialect** | American | Which English variety Harper checks against: American, British, Australian, or Canadian. |
| **Lint debounce (ms)** | `500` | How long the editor waits after you stop typing before re-checking, in milliseconds (0–10000). Changes apply immediately. |
| **Underline style** | Squiggly | How findings are underlined: *Squiggly (default)* for Harper's wavy underline, or *Solid line* for a straight 2 px line with a light tint. Either way the colour is the issue type's. Changes apply immediately. |
| **External dictionary file** | *(empty)* | *Desktop only.* Absolute path to a plain-text dictionary (one word per line). See [Your dictionary](#your-dictionary). |
| **Rule overrides (JSON)** | *(empty)* | *Advanced.* A JSON object of `{"RuleName": true \| false}` applied on top of the defaults, e.g. `{"SpelledNumbers": false}`. Invalid JSON is ignored. |

## Installation

### From the Joplin plugin marketplace

In Joplin desktop, go to **Tools → Options → Plugins**, search for **Harper**, and click
**Install**. Restart Joplin when prompted.

### On Android

Joplin mobile's plugin support is marked Beta and is off by default. In **Configuration →
Plugins**, enable plugin support first, then search for **Harper** and install — or use
**Install from file** with the `.jpl` from the releases page. Restart the app when prompted.

### Manually (.jpl from GitHub releases)

1. Download `io.github.pmslava.harper.jpl` from the
   [latest release](https://github.com/pmslava/joplin-plugin-harper/releases).
2. In Joplin desktop, go to **Tools → Options → Plugins**.
3. Under **Manage your plugins**, use the gear/⋮ menu → **Install from file**, and select the
   downloaded `.jpl`.
4. Restart Joplin when prompted.

## Requirements and limits

- **Joplin 3.1 or newer on desktop, 3.3 or newer on mobile.** The plugin uses Joplin's CodeMirror 6 editor integration, which is what sets both minimums.
- **Markdown editor only.** Harper checks the Markdown (CodeMirror) editor. It does **not** work in
  the Rich Text (WYSIWYG) editor, which offers no hook for this kind of decoration.
- **Desktop and Android.** The same plugin runs on Joplin desktop and on Joplin for Android. Plugin support on Joplin mobile is still Beta, so the phone side is newer and less proven than the desktop side. Only Android has been tested. There is no external dictionary *file* on mobile (the plugin has no filesystem access there) — the dictionary note covers mobile instead.
- **About 21 MB.** The plugin bundles Harper's WebAssembly engine so it can run offline, which makes the `.jpl` roughly 21 MB. That is large for a plugin, but it is the whole checker, downloaded once.
- **Startup warm-up.** The engine warms up in the background when Joplin starts, so the first check
  is usually instant; if you start typing right away it can take a second or two. After that,
  re-checking a typical note is fast — on the order of ~50 ms for a few kilobytes of text.

## Privacy

Harper runs locally and makes **no network calls**. Your note text is passed to the bundled
WebAssembly engine inside Joplin and nowhere else — nothing is uploaded, and there is no telemetry.
The external dictionary, if you use one, is a file on your own disk; the dictionary note is an
ordinary Joplin note that travels only through your own Joplin sync, like every other note.

## Development

```bash
npm install
npm test          # builds the plugin and runs the harness suite (incl. performance budgets)
npm run test:e2e  # full end-to-end suite: launches a real Joplin desktop under Xvfb (Linux)
npm run dist      # build only -> publish/io.github.pmslava.harper.jpl
```

`test:e2e` starts a real Joplin, so it first takes a machine-wide lock
(`~/.cache/joplin-plugin-e2e.lock`) shared with the author's sibling Joplin plugin repos: exactly one
E2E run exists at a time, and a run that finds the lock held waits its turn rather than piling a
second Joplin onto the machine (`E2E_LOCK_WAIT_MS` sets the budget, default 10 minutes; `0` fails
fast). The rest of the resource discipline — orphan sweep, RAM gate, signal teardown — lives in
[`e2e/guard.ts`](e2e/guard.ts).

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
