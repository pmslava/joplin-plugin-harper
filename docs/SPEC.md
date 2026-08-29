# joplin-plugin-harper — Specification

Harper grammar checker integrated into Joplin desktop's Markdown editor.
Plugin id: `io.github.pmslava.harper` · npm: `joplin-plugin-harper`.
Desktop only when this spec was written; mobile (Android) shipped in v1.1.0, so "desktop only" below
is historical — the platform decisions that changed are recorded in the dated update blocks.

Research grounding: three reports (harper.js surface, Joplin plugin API, Cockpit scaffold blueprint),
2026-08-21. Source-of-truth citations live in the reports; this file records the decisions.

## Architecture (decided)

- **Linter host: plugin main process.** Joplin's main renderer CSP (`script-src` without
  `wasm-unsafe-eval`) blocks WASM in the editor context. The plugin main process is a hidden
  BrowserWindow (Node enabled, no CSP) — harper.js runs there. `LocalLinter` unless `WorkerLinter`
  bundles cleanly under webpack (its worker import uses Vite-only syntax).
- **harper.js pinned to 2.7.0** (latest published). WASM ~15 MB. Loading: prefer shipping the
  `.wasm` file in `dist/` and loading via `createBinaryModuleFromUrl(file://…installationDir)`;
  fallback `harper.js/binaryInlined` (~20 MB base64 in bundle). Spike decides empirically.
- **Editor surface: CM6 content script** (`ContentScriptType.CodeMirrorPlugin`,
  `app_min_version: 3.1`). Uses Joplin-PROVIDED `@codemirror/lint` / `state` / `view` as webpack
  externals — never bundle `@codemirror/*`. Stock `linter()` extension, debounced; whole-document
  lint per pass (Obsidian precedent; revisit only if latency demands).
- **Protocol:** content script `context.postMessage({type:'lint', text})` → main lints → returns
  plain JSON `[{start, end, kind, message, problemText, suggestions:[{kind, replacementText}]}]`
  (WASM `Lint` handles converted before serialization; spans are UTF-16 → direct CM `from`/`to`).
  Suggestions applied in the content script as CM transactions (Replace / Remove / InsertAfter).
- **Rich Text editor: out of scope** (no plugin hook for TinyMCE decorations).

## Dictionary integration

- Setting `externalDictionaryPath` (default: empty = off). When set, plugin main reads the file
  (`joplin.require('fs-extra')`), feeds words via `importWords()` (batched), re-reads on change
  (poll ~60 s — the user's file syncs via rclone every 10 min).
- **"Add to dictionary"** action (Spelling lints): appends to the external file when configured
  (so it syncs to Zed/harper-ls via the user's existing Nextcloud setup), else persists in plugin
  data. Verify harper-ls `dictionary.txt` line format compatibility before writing (Phase 1 item).
- Ignored lints: `exportIgnoredLints()` hashes persisted in plugin data.

**Updated in v1.3.0 — the dictionary is a three-way merge, not a union. Updated again in v1.5.0 — there is one durable side, not two.** The word sources are the external file (desktop only) and a pending buffer of add-to-dictionary words that have not been folded into it yet. Until v1.4.x a synced Joplin *dictionary note* was a second durable side, and was how the word list reached the phone; v1.5.0 removed it in favour of the sync note, which carries words together with rules and dismissed findings and delivers them through that same pending buffer rather than as a merge side of its own. Up to v1.2.0 they were reconciled by UNION, which can only grow, so deleting a word from one source let another put it straight back. v1.3.0 reconciles them against a BASE instead: the word set this device last saw the sides agree on, persisted per device in a private setting (settings writes are the one write that is safe on both platforms at any time). A word the base remembers and a present side has dropped is a deletion and propagates everywhere; a word the base does not know is an addition. When the same word is deleted on one side and added on the other, the ADDITION wins - losing a word the user just asked for is worse than keeping one they meant to drop. A side that is absent this pass (an unreadable file — a drive not yet mounted, rclone moving it aside) infers no deletions AND does not advance the base, so a drive that is briefly unreachable can never be read as "the user deleted everything". The external file keeps its own order: only the lines for deleted words are dropped, new words are appended at the end, and comments and blank lines stay where they were.

## Settings (v1)

enabled · dialect (American default / British / Australian / Canadian) · lint debounce ms ·
externalDictionaryPath · rule overrides as advanced JSON (`LintConfig` flat record) — plus
tooltip actions "ignore this" and "disable this rule" writing into the same stores.

## Phases

**Phase 0 — walking skeleton (de-risk spike).** Branch `spike/walking-skeleton`. Full scaffold from
Cockpit blueprint + thinnest end-to-end thread: typo typed in editor → underline appears → action
applies first suggestion. Harness (contentScripts stubs, version-quadruple test) + E2E
proof-of-life against AppImage 3.6.14 under xvfb. Measures: linter init ms, lint ms for ~5 KB doc,
text→decoration latency, bundle/.jpl sizes. Settles: WASM loading path, Local vs Worker linter.

**Phase 1 — MVP.** Settings above; dictionary file integration + add-to-dictionary;
ignore-lint; suggestion UI polish (all suggestions, per-kind severity); harness budgets
("one lint per debounce, not per keystroke"; "apply-fix triggers exactly one re-lint");
E2E: suggestion apply, add-to-dictionary, dialect switch. User smoke-test gate.

**Phase 2 — polish + release.** Per-kind underline styling; large-note behavior; README +
screenshots; npm trusted-publisher setup for the new repo; v1.0.0 release (release-triggered
OIDC publish; registry pickup).

## Process

Cockpit playbook applies verbatim (see "Joplin" note): spec-first, Opus implementer +
adversarial verifier pairs, one commit per worker + hash gate, no pushes by workers, harness
green → E2E green → user smoke-tests a local `.jpl` → batch releases. Version lockstep in four
places, pinned by a harness test.

## Open items / assumptions (veto or confirm)

- User's Joplin desktop is ≥ 3.1 (CM6 default) — assumed, not verified.
- Whole-document lint per pass is acceptable for typical note sizes — spike measures.
- `.jpl` will be ~15–20 MB due to WASM — no known Joplin size limit, unverified.
- Dialect default American.
