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
- **Dialects.** Check against American, British, Australian, Canadian, or Indian English.
- **Sync your settings between devices.** One note carries your rules, your dictionary and your
  dismissed findings to every device through your normal Joplin sync (see
  [Sync your settings](#sync-your-settings) below).
- **A settings screen for everything else.** **Harper: Settings…** opens a searchable browser for all
  823 rules — each with its description shown inline — a dictionary editor, and the list of findings
  you dismissed, with a Restore button on each. Desktop and mobile (see
  [The settings dialog](#the-settings-dialog) below).

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

## Sync your settings

The dictionary note above carries words. The **sync note** carries everything: your rule choices,
your dictionary, and the findings you dismissed.

Run the command **Harper: Create sync note** once, on any device. The plugin creates a note called
"Harper Sync", seeds it with what that device already has, and remembers it in the **Sync note**
setting. On your other devices, open the same note, copy its id, and paste it into their **Sync
note** setting. From then on the plugin writes the note whenever you change something and reads it
back on the other devices, through your normal Joplin sync.

The note holds machine-readable data, so do not edit it by hand. It says so at the top.

A few things are worth knowing:

- **The dialect and "Ignore non-English text" do not sync.** They are per-device on purpose: you may
  well want British on one machine and American on another.
- **The whole note is replaced on each write, and the last write wins.** Change settings on two
  devices at the same moment and Joplin will make a conflict copy, which you resolve yourself like
  any other note conflict. The plugin always uses the note at the configured id and never touches
  conflict copies.
- **The old dictionary note keeps working.** If you have one and no sync note, nothing changes at
  all. Once a sync note is set it takes over the word list and the old note is left alone, exactly
  as you last saw it. The two formats are different, so there is no automatic migration: the Harper
  window shows a one-line notice telling you to make a sync note.
- **Nothing is written while you are typing.** Like the dictionary note, the sync note is only
  written once you leave the note you are editing.

## Use your rules in Zed

`harper-ls` powers Harper in Zed, Neovim, Helix, and VS Code, and it reads its rules from that
editor's own settings file. When you set an **External dictionary file**, the plugin keeps a
`zed-harper-ls.json` next to it holding the matching `harper-ls` settings block, regenerated
whenever you change a rule or the dialect. Copy the block into Zed's `settings.json` and your two
editors agree.

The Harper window also has a **Copy Zed settings block** button on the Rules tab, which gives you
the same text without going near the file.

The block lists only the rules you actually changed, so it stays short and Harper's own defaults
keep applying to everything else. Dismissed findings are not included: `harper-ls` computes its
ignore hashes differently, so exporting them would produce a file that silently ignores nothing.

## The settings dialog

Run the command **Harper: Settings…** for the full settings screen. On desktop it is in
**Tools → Harper: Settings…**, or type it into the command palette (`Ctrl+P`, then `:`). On mobile
it is in the note's **…** menu. It works the same on both.

It has four sections:

- **General.** The everyday options — the master switch, dialect, debounce, underline style, and the
  two dictionary sources. By default this is the only place they are edited; see
  [Settings](#settings) below for the switch that moves them to Joplin's own options page instead.
- **Rules.** All 823 of Harper's checks, in the 15 groups Harper ships them in. Every rule shows what
  it does right under its name — no clicking to find out. Search by rule name or by that description,
  expand a group to see its rules, and set any rule to **On**, **Off**, or **Default**. Set a whole
  group at once from the selector in its header. **Reset to Default Rules** and **Disable All Rules**
  do what they say. Changes apply straight away — there is nothing to save.
- **Dictionary.** Your whole word list in one text box, one word per line. Edit it, press **Save
  dictionary**, and the changes go wherever your dictionary lives — the note, the file, or both.
- **Dismissed.** Every finding you dismissed from a suggestion card, with the rule, the flagged text
  and the date. **Restore** puts one back. **Clear all** clears the lot.

## Settings

Open **Tools → Options → Harper** on desktop, or **Configuration → Plugins → Harper** on mobile.

**Where the settings live is itself a setting.** Out of the box the Harper window owns all of them,
and this page holds a single switch:

| Setting | Default | What it does |
| --- | --- | --- |
| **Manage settings in the Harper window** | On | Where the basic settings are edited. **On:** they live in the Harper window and this page stays minimal. **Off:** they appear on this page instead, and **Harper: Settings…** leaves the Tools menu (desktop) or the note toolbar (mobile). Either way the rule browser, the dictionary editor and the dismissed findings exist *only* in the Harper window — on desktop it stays reachable from the command palette. Takes effect after a Joplin restart, and applies per device (it does not sync). |

The settings below are the ones that switch moves. With it **on** they are edited in the Harper
window's **General** tab; with it **off** they appear on this page. Their values and behaviour are
identical either way, and the two surfaces stay in step — change something in either and the other
reflects it.

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Harper grammar checking** | On | Master switch. When off, no underlines are shown. |
| **Dictionary note** | *(empty)* | The Joplin note that holds your shared word list. Set automatically by the **Harper: Create dictionary note** command. See [Your dictionary](#your-dictionary). The sync note supersedes this note, so when a sync note is set this note is left alone. |
| **Sync note** | *(empty)* | The Joplin note that syncs your rules, your dictionary and your dismissed findings between devices. Set automatically by the **Harper: Create sync note** command. See [Sync your settings](#sync-your-settings). |
| **English dialect** | American | Which English variety Harper checks against: American, British, Australian, Canadian, or Indian. |
| **Lint debounce (ms)** | `500` | How long the editor waits after you stop typing before re-checking, in milliseconds (0–10000). Changes apply immediately. |
| **Underline style** | Squiggly | How findings are underlined: *Squiggly (default)* for Harper's wavy underline, or *Solid line* for a straight 2 px line with a light tint. Either way the colour is the issue type's. Changes apply immediately. |
| **Ignore non-English text** | Off | Skip text that Harper detects as not English. Useful for multilingual notes. |
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
