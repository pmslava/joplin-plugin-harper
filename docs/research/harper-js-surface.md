I now have everything needed. Compiling the report.

---

# RESEARCH REPORT: Harper JS/WASM integration surface + Obsidian CM6 reference

Scope note: All code citations are from a `--depth 1` clone of `github.com/Automattic/harper` (default branch, cloned 2026-08-21) at local path `/tmp/claude-1000/-home-mrsir-Lab-joplin-plugin-harper/f70ff77f-1ceb-407e-9024-9da9993b0b91/scratchpad/research-harper/harper`. Paths below are repo-relative. Harper is a monorepo (Rust core + JS packages + editor plugins all in one repo); the Obsidian plugin, harper.js, and the WASM crate all live here.

Version caveat up front: npm `latest` is **2.7.0** (published ~3 weeks before 2026-08-21). The cloned `main` branch is ahead at **2.8.0** (unreleased) — `packages/harper.js/package.json:3` and `packages/obsidian-plugin/package.json:5` both say `2.8.0`. Some APIs I cite from source (e.g. structured config, `importWeirpack`, Indian dialect) may be 2.8.0-only. Verify against the exact version you install.

---

## 1. harper.js package name, version, public API

**Package:** `harper.js` on npm. Latest published `2.7.0`, Apache-2.0, single runtime dependency `fflate@^0.8.2`, maintainer `elijahpotter`, homepage writewithharper.com. Unpacked size **73.8 MB** (it ships full + slim WASM, each also as an inlined base64 JS variant). (npm registry metadata; `packages/harper.js/package.json`.)

**Two Linter implementations, one shared interface** (`packages/harper.js/src/main.ts:10-12` re-exports `LocalLinter`, `WorkerLinter`, and the `Linter` interface type):

- `LocalLinter` (`src/LocalLinter.ts`): runs WASM synchronously in the current JS context — it *will block the event loop* on large docs. Works in Node.
- `WorkerLinter` (`src/WorkerLinter/index.ts`): spins up a dedicated inlined web worker so linting is off the main thread. Class doc comment: "This class will not work properly in Node. In that case, just use `LocalLinter`." (`src/WorkerLinter/index.ts:17-20`).

Both implement the same `Linter` interface (`src/Linter.ts:14-151`). Both take `LinterInit = { binary: BinaryModule; dialect?: Dialect }` (`src/Linter.ts:153-159`).

**Calling lint():** `lint(text, options?) => Promise<Lint[]>` (`src/Linter.ts:21`). `LocalLinter.lint` (`src/LocalLinter.ts:64-67`) forwards to the WASM `inner.lint(...)`. `LintOptions` (`src/main.ts:75-89`):
- `language?: 'plaintext' | 'markdown' | 'typst'` — **defaults to `markdown`** (`src/LocalLinter.ts:17-18`).
- `regex_mask?: string`, `forceAllHeadings?: boolean`, `dedup?: boolean` (default true), `isolateEnglish?: boolean` (default false).

There is also `organizedLints(text, options?) => Promise<Record<string, Lint[]>>` (`src/Linter.ts:24`) which keys lints by the source rule name — this is what the Obsidian plugin actually uses.

**Lint result shape** — a `Lint` is a WASM-backed object (a class instance, NOT a plain JSON object); you call methods on it. Defined in `harper-wasm/src/lib.rs:643-700`:
- `lint.span() => Span` where `Span { start: number; end: number }` (`harper-wasm/src/lib.rs:731-735`). **Critical: these are UTF-16 code-unit indices into the JS string** — the Rust side explicitly converts Harper's internal char indices to JS string indices via `char_idx_to_js_str_idx` / `to_js_indices` (`harper-wasm/src/lib.rs:560-566, 573, 752-758`). This means `span.start`/`span.end` drop straight into CodeMirror `from`/`to` with no offset conversion.
- `lint.message() => string` (plain), `lint.message_html() => string` (HTML) (`lib.rs:692-699`).
- `lint.lint_kind() => string` (machine key, e.g. `"Spelling"`) and `lint.lint_kind_pretty() => string` (display) (`lib.rs:663-670`). The full kind enumeration is in `src/main.ts:19-40` (`LintKind`: Agreement, BoundaryError, Capitalization, Eggcorn, Enhancement, Formatting, Grammar, Malapropism, Miscellaneous, Nonstandard, Punctuation, Readability, Redundancy, Regionalism, Repetition, Spelling, Style, Typo, Usage, WordChoice, WordOrder).
- `lint.get_problem_text() => string` — the offending source substring (`lib.rs:659-661`).
- `lint.suggestions() => Suggestion[]` and `lint.suggestion_count() => number` (`lib.rs:673-686`).

**Suggestion shape** (`harper-wasm/src/lib.rs:585-627`):
- `sug.kind() => SuggestionKind` enum: `Replace = 0`, `Remove = 1`, `InsertAfter = 2` (`lib.rs:593-600`; exported from `src/main.ts:2`).
- `sug.get_replacement_text() => string` (empty string for `Remove`) (`lib.rs:611-617`).

**Applying suggestions** — two ways:
1. `linter.applySuggestion(text, lint, suggestion) => Promise<string>` returns the whole edited text (`src/Linter.ts:27`, impl `src/LocalLinter.ts:83-86`, WASM `lib.rs:492-513`).
2. Apply the span+replacement yourself in the editor (what the Obsidian plugin does — see §5). Given the UTF-16 spans, this is a direct CM `changes: {from, to, insert}`.

Because `Lint`/`Suggestion` are WASM handles, they hold memory. `LocalLinter.organizedLints` calls `group.free()` on group wrappers (`src/LocalLinter.ts:77`); over the worker boundary they are serialized (see `src/Serializer.ts`).

---

## 2. WASM loading, bundling, Node, web worker

**WASM is not auto-fetched from a fixed URL — the loading strategy is a first-class choice via subpath exports.** `packages/harper.js/package.json:38-64` exposes five entry points: `.` (the linters/types), `./binary`, `./slimBinary`, `./binaryInlined`, `./slimBinaryInlined`. You import a `binary` object and pass it as `LinterInit.binary`.

- `harper.js/binary` and `harper.js/slimBinary` → the WASM is a **separate `.wasm` asset** referenced by URL (`src/binaries/binary.ts:1` imports `harper-wasm/harper_wasm_bg.wasm?no-inline`). Your bundler must emit and serve that `.wasm` file; it is fetched at runtime.
- `harper.js/binaryInlined` and `harper.js/slimBinaryInlined` → the WASM is **inlined as a base64 `data:` URL inside the JS** (`src/binaries/binaryInlined.ts:1` uses `?inline`; `src/binaries/slimBinaryInlined.ts`). No separate asset, no runtime fetch, no path resolution.
- You can also build a module from an arbitrary URL: `createBinaryModuleFromUrl(url, glueFlavor?)` (`src/BinaryModule.ts:110-112`).

The actual instantiation (`src/BinaryModule.ts:53-86`) calls the wasm-bindgen glue's `default({ module_or_path })`. Notably, when the binary is a `file://` URL under Node it reads the file via `fs` (`src/BinaryModule.ts:53-67`) — a `/* webpackIgnore: true */` hint is present, showing webpack is an anticipated consumer.

**Measured sizes** (from the published `harper.js-2.7.0.tgz` I downloaded):
| dist file | bytes | ~size |
|---|---|---|
| `harper_wasm_bg.wasm` (full) | 15,848,134 | 15.1 MiB |
| `harper_wasm_slim_bg.wasm` (slim) | 15,634,488 | 14.9 MiB |
| `binaryInlined.js` (full, base64) | 21,131,086 | 20.2 MiB |
| `slimBinaryInlined.js` (slim, base64) | 20,846,244 | 19.9 MiB |
| `index.js` (linters) | 152,404 | 149 KiB |

Note "slim" is only marginally smaller than "full" — the split is about which wasm-bindgen glue/features load, not a big size win (`src/BinaryModule.ts:11-51`).

**Bundling into webpack → Electron webview implications:**
- The Obsidian plugin (which runs in exactly this environment — Electron/CM6) uses `slimBinaryInlined` + `WorkerLinter` and bundles to a single CommonJS `main.js` with the worker inlined (`inlineDynamicImports: true`) — see `packages/obsidian-plugin/src/State.ts:4,50` and `packages/obsidian-plugin/vite.config.ts:53-66`. **The inlined-binary path is the proven pattern for a self-contained plugin bundle**: no `.wasm` asset to locate at runtime, no CSP/`file://` fetch issues inside the webview. Cost: a ~20 MB base64 blob in your bundle and the base64→bytes decode at startup.
- If you instead use the non-inlined `binary`/`slimBinary`, you must configure webpack to emit the `.wasm` as an asset and make it reachable by URL from inside the Electron renderer — trickier under Joplin's plugin sandbox. The inlined route sidesteps that.
- The `WorkerLinter` worker is imported as `./worker.ts?worker&inline` (`src/WorkerLinter/index.ts:8`), i.e. Vite-specific inline-worker syntax. Under webpack you'd need the equivalent worker-inlining (`new Worker(new URL(...))` handling) or you may have to fall back to `LocalLinter`. This is a concrete porting risk (see UNKNOWNS).

**Node:** Yes, `LocalLinter` works in plain Node (no browser APIs) — the official `commonjs-simple` example uses `new LocalLinter({ binary })` and notes "We cannot use `WorkerLinter` on Node.js since it relies on web-specific APIs" (`packages/harper.js/examples/commonjs-simple/index.js:1-11`). `WorkerLinter` requires a browser/worker environment.

**Web worker:** Yes — `WorkerLinter` *is* the web-worker implementation; it runs the WASM in a `Worker` and marshals calls over `postMessage` with a custom `Serializer` (`src/WorkerLinter/index.ts:30-75`).

---

## 3. Custom dictionary / user words

API on the `Linter` interface (`src/Linter.ts:110-118`):
- `importWords(words: string[]) => Promise<void>` — add a plain array of strings to the user dictionary. Comment: "This is a significant operation, so try to batch words." (WASM impl `harper-wasm/src/lib.rs:456-476` extends a `MutableDictionary` and re-synchronizes the lint dictionary.)
- `exportWords() => Promise<string[]>` — returns only words previously added via `importWords` (never the curated dictionary) (`lib.rs:478-484`).
- `clearWords() => Promise<void>` — clears added words, leaves the curated dictionary (`lib.rs:450-454`).

So yes: user words are supplied as a plain list of strings.

**Persistence: none built in — the host must re-supply words on startup.** The dictionary lives in the WASM instance's memory. The Obsidian plugin persists the list itself in plugin settings (`Settings.userDictionary?: string[]`, `packages/obsidian-plugin/src/State.ts:15`) and on every initialize does `clearWords()` then `importWords(settings.userDictionary)` (`State.ts:96-101`), reading them back out with `exportWords()` when saving (`State.ts:267-268`). Adopt the same pattern for Joplin (store the array in `joplin.settings` / plugin data).

Separately, there's a **lint-ignore** mechanism (distinct from the dictionary) for dismissing specific findings: `ignoreLint`/`ignoreLints`/`ignoreLintHash`, plus `exportIgnoredLints()`/`importIgnoredLints(json)` which serialize to privacy-respecting hashes for persistence (`src/Linter.ts:88-108`; WASM `lib.rs:432-448`). "Add word to dictionary" (spelling) and "ignore this finding" (any rule) are two different flows.

---

## 4. Configuration: rules, dialects, markdown-awareness

**Rule toggling at runtime.** Config is a flat record `LintConfig = Record<string, boolean | null>` where the key is a rule name and value `true`/`false`/`null` (null = use default) (`src/main.ts:15-17`). Methods (`src/Linter.ts:37-79`):
- `getDefaultLintConfig()` / `getLintConfig()` / `setLintConfig(config)` — the primary runtime toggle path (WASM `set_lint_config_from_object`, `lib.rs:276`).
- JSON variants: `getLintConfigAsJSON()` / `setLintConfigWithJSON(json)`.
- `getStructuredLintConfig()` → `StructuredLintConfig` (settings grouped as Bool / OneOfMany / Group nodes, `src/main.ts:42-73`) — intended purely for rendering a settings UI; you still persist through the flat `setLintConfig`.
- `getLintDescriptions()` / `getLintDescriptionsHTML()` → per-rule human descriptions (Markdown/HTML) for a settings screen (`src/Linter.ts:67-79`).

The Obsidian plugin toggles a single rule by mutating the flat config and re-applying (`State.ts:232-234`: `lintConfig[linterName] = false; setLintConfig(...)`), and has bulk "enable/disable all" and "reset to defaults (null)" helpers (`State.ts:288-306`).

**Dialects.** `Dialect` enum exported from harper.js (`src/main.ts:2`), backing values in `harper-wasm/src/lib.rs:90-96`: **American, British, Australian, Canadian, Indian** (Indian is present on `main`/2.8.0; the Obsidian UI historically exposed US/GB/AU/CA — `packages/obsidian-plugin/src/index.ts:105-110`). Set at construction (`LinterInit.dialect`) or at runtime via `setDialect(dialect)` — note `setDialect` rebuilds the underlying linter (`src/LocalLinter.ts:218-227`), and defaults to American if omitted (`src/Linter.ts:157-158`).

**Markdown-awareness: yes, native.** The WASM defaults to a CommonMark parser (`Language.Markdown`, `harper-wasm/src/lib.rs:64-72`), backed by `pulldown_cmark`. The parser doc states "Will ignore code blocks and tables" (`harper-core/src/parsers/markdown.rs:11`); fenced/inline code and math are emitted as `TokenKind::Unlintable` so they're skipped (`markdown.rs:213-235`), and there's an `ignore_link_title` option for link handling (`markdown.rs:18-20, 231-235`). So you pass raw Markdown straight to `lint()` — Harper understands the syntax; you do not need to strip code blocks yourself. (Confirm inline `[text](url)` link-target handling against your desired behavior — link *titles* are only skipped when `ignore_link_title` is set, which harper.js does not currently expose through `LintOptions`.)

---

## 5. Official Obsidian plugin — CM6 integration (the reference)

Location: `packages/obsidian-plugin/` in the monorepo (the standalone repo `github.com/Automattic/harper-obsidian-plugin` is referenced by `packages/obsidian-plugin/README.md` but the source lives here). CM6 packages are peer deps (`@codemirror/state`, `/view`, `/lint`, etc. — `packages/obsidian-plugin/package.json:24-36`).

**It does NOT use `@codemirror/lint`'s `linter()`/`lintGutter()`.** Instead `packages/obsidian-plugin/src/lint.ts` is a **vendored fork of `@codemirror/lint`** (~1100 lines) customized for Harper. It re-implements the full mechanism using core CM6 primitives:
- A `StateField<LintState>` holding a `DecorationSet` of diagnostics, provided as `EditorView.decorations` (`lint.ts:205-228`).
- A `ViewPlugin` (`lintPlugin`, `lint.ts:300-365`) that debounces and runs the async lint source, then dispatches `setDiagnosticsEffect` (`lint.ts:322-335`).
- `Decoration.mark` with class `cm-lintRange cm-lintRange-<severity>` + a per-lint-kind `markClass` for underline color; zero-length ranges become a `Decoration.widget` (`lint.ts:125-141`, `DiagnosticWidget` at `504-519`).
- Tooltips via `hoverTooltip(lintTooltip, ...)` plus a `commandTooltipField` using `showTooltip` for keyboard-driven tooltips (`lint.ts:807-836, 775-805`). Suggestion buttons are rendered as DOM in `renderDiagnostic` (`lint.ts:423-502`).
- Styling via `EditorView.baseTheme` — two visual styles (`harper-web-style` solid underline vs `harper-squiggly-style` wavy SVG), colored per lint kind (`lint.ts:532-566, 568-773`).

**The Harper→diagnostics glue** is `packages/obsidian-plugin/src/State.ts`:
- `constructEditorLinter()` (`State.ts:122-248`) builds the CM extension by calling the forked `linter(async (view) => Diagnostic[], { delay })`.
- Re-lint scheduling: the forked `lintPlugin` re-runs on `docChanged` after a debounce `delay` (`lint.ts:339-352, 313-337`). Default `delay` combine value is 750 ms (`lint.ts:377`), **but the plugin passes `delay: this.delay` where `DEFAULT_DELAY = -1`** (`State.ts:23, 106, 245`) → effectively lint ASAP after each change. `forceLinting(view)` exists to force a run (`lint.ts:401-404`).
- Whole-document linting: it reads the entire doc `view.state.doc.sliceString(-1)` and calls `this.harper.organizedLints(text, { regex_mask })` (`State.ts:141-142`). **No visible-range-only optimization** — the full document is linted every time.
- Mapping each `Lint` → `Diagnostic` (`State.ts:144-242`): `from = span.start`, `to = span.end` (direct, thanks to UTF-16 spans), `title = lint.lint_kind_pretty()`, `renderMessage` sets `innerHTML = lint.message_html()`, `markClass` from lint kind + style.
- Applying a fix (`State.ts:148-195`): each suggestion becomes an `action` whose `apply(view, from, to)` dispatches a CM transaction. `Remove` → `changes:{from,to,insert:''}`; `Replace` → insert `get_replacement_text()` and move cursor; `InsertAfter` → insert at `to`. It applies edits directly rather than via `linter.applySuggestion`.
- "Add to dictionary" (`State.ts:197-214`): only for `lint_kind() === 'Spelling'`; action calls `this.harper.importWords([word])` then `reinitialize()`. "Ignore" and "Disable rule" actions map to `ignoreLints` and `setLintConfig` (`State.ts:228-237`).

**Harper instance choice & bundling:** `new WorkerLinter({ binary: slimBinaryInlined })` by default, switchable to `LocalLinter` via a `useWebWorker` setting (`State.ts:50, 81-87`). The inlined slim WASM + inlined worker means the whole plugin ships as one self-contained `main.js` (CJS, `externals: obsidian, electron`) — `vite.config.ts:53-66`. There's a guard requiring a modern Electron (`typeof Response`) before loading (`index.ts:29-32`).

**Wiring into Obsidian's editor:** `this.registerEditorExtension(this.state.getCMEditorExtensions())` registers a live array of extensions; toggling lint on/off mutates that array and calls `app.workspace.updateOptions()` to reconfigure CM (`index.ts:43`, `State.ts:353-377, 39`). It gets the raw `EditorView` from Obsidian via `(view.editor as any).cm` (`index.ts:287-291`) — the equivalent hook in Joplin's CM6 will differ (Joplin exposes CM via its own editor API / `codeMirrorWrapper`).

**Settings mapping:** `HarperSettingTab.ts` (637 lines) renders dialect, per-rule toggles (from `getStructuredLintConfig` + `getLintDescriptionsHTML`), the user dictionary, ignored-lints reset, delay, ignored-file globs, and web-vs-squiggly style — all persisted into the `Settings` object (`State.ts:10-21`) and re-applied through `initializeFromSettings` (`State.ts:59-119`).

---

## 6. Reusable CM6 integration package?

**No.** There is no published, reusable CodeMirror-6 integration package in the monorepo. The only CM6 integration is the Obsidian plugin's *private, vendored fork* of `@codemirror/lint` (`packages/obsidian-plugin` is `"private": true`, `package.json:4`; its `lint.ts` is not exported as a library). Two adjacent packages are NOT CM6:
- `packages/lint-framework` — a DOM/`contenteditable`/`textarea` linting framework (uses `virtual-dom`, targets the website demo, Chrome/Firefox extensions, Google Docs). It has zero CodeMirror imports (grep of `packages/lint-framework/src` for `codemirror` returns nothing). README: it reads/writes text editors "on a web page" and renders its own underlines/UI (`packages/lint-framework/README.md`).
- `packages/harper-editor` — "Reusable Svelte editor components powered by Harper" (`package.json` description); depends on `svelte`, not `@codemirror/*`. It's a Svelte widget, not a CM6 extension.

**What the docs recommend for third-party editors:** the official docs (writewithharper.com/docs/harperjs/…) document the raw harper.js API (`LocalLinter`/`WorkerLinter`, `lint`, `BinaryModule`, `importWords`, `setLintConfig`) but I found **no dedicated "CodeMirror integration" guide**. The introduction page is thin and flags harper.js as "early access… API not yet stable." Practical takeaway: for a Joplin CM6 plugin you will **re-implement the integration**, using either stock `@codemirror/lint` (`linter()` + `lintGutter()`) or by porting the Obsidian plugin's forked `lint.ts` + the `State.ts` Lint→Diagnostic mapping. The Obsidian plugin is the canonical reference; the forked `lint.ts` gives you Harper-specific tooltips/colors/dictionary actions that stock `@codemirror/lint` does not.

---

## 7. Performance characteristics

- **WASM size / startup:** 15.6–15.8 MB `.wasm` (≈20 MB as inlined base64) — see §2 table. Startup cost = download/decode + wasm-bindgen instantiate + a priming lint. The plugins hide this behind a lazy, memoized load (`p-lazy` + `p-memoize`, `src/BinaryModule.ts:88-95, 126`) and a `setup()` that runs a throwaway `lint('')` to warm caches (`src/LocalLinter.ts:57-62`).
- **Lint latency for a few-KB doc:** not documented as a number anywhere I could find. The only bench in the repo (`packages/harper.js/src/Linter.bench.ts`) measures config get/set and ignore-state, **not `lint()` latency**. So I cannot cite a latency figure. Empirically Harper markets itself as real-time/on-keystroke, and the Obsidian plugin lints on every change with ~0 ms debounce (`State.ts:23,245`), which implies whole-document linting of typical notes is fast enough to feel live — but treat this as inference, not a measured number.
- **Main-thread blocking:** `LocalLinter` blocks the event loop; `WorkerLinter` does not (moves WASM to a worker) — the documented reason to prefer `WorkerLinter` in a UI (`src/WorkerLinter/index.ts:17-20`, `LocalLinter.ts:37-38`).
- **Debounce / scope, as implemented in Obsidian:** debounce is configurable via `delay` but ships at `-1` (immediate) (`State.ts:23,106,245`; combine default 750 ms at `lint.ts:377`). It lints the **entire document**, not just the viewport (`State.ts:141-142`) — no visible-range optimization. For very large notes in Joplin you may want to raise `delay` and/or consider chunking, since cost scales with document size.
- **Memory:** each `Linter`/`Lint`/`Suggestion` is a WASM handle; the API provides `dispose()`/`free()` and the Obsidian plugin disposes and rebuilds the linter on settings changes (`State.ts:82-86`, `LocalLinter.ts:272-280`). No documented memory footprint number.

---

## UNKNOWNS AND RISKS

- **Version drift:** I read source from the `2.8.0` (unreleased) `main` branch, but npm `latest` is `2.7.0`. `getStructuredLintConfig`, `StructuredLintConfig`, `importWeirpack`/Weirpack loading, and the Indian dialect may not exist in `2.7.0`. Pin your version and re-verify the exact `Linter` interface against `node_modules/harper.js/dist/index.d.ts` after install.
- **Lint latency has no cited figure.** No `lint()` benchmark exists in the repo and the docs give no numbers. The "feels real-time" claim is inference from how the Obsidian plugin schedules linting, not a measurement. If latency matters, benchmark harper.js on representative Joplin notes yourself.
- **WorkerLinter under webpack/Joplin is unverified.** harper.js's worker import uses Vite-only `?worker&inline` syntax (`src/WorkerLinter/index.ts:8`), and the Obsidian plugin builds with Vite. Joplin plugins build with **webpack**. Whether `WorkerLinter` bundles and runs correctly under Joplin's webpack + Electron sandbox is unconfirmed; you may need `LocalLinter` (simpler, no worker) as a fallback, accepting main-thread blocking. This is the single biggest porting risk — prototype it early.
- **Joplin CM6 access path differs from Obsidian.** Obsidian exposes the raw `EditorView` via `(editor as any).cm` and `registerEditorExtension`; Joplin uses its own content-script / `codeMirrorWrapper.addExtension` API. The Lint→Diagnostic logic ports cleanly (UTF-16 spans → CM `from`/`to`), but the registration/host glue must be rewritten. I did not research Joplin's CM6 plugin API in this task.
- **`@codemirror/lint` vs vendored fork decision unresolved.** Stock `@codemirror/lint` is simpler but won't reproduce Harper's per-kind colored underlines, HTML tooltips, and dictionary/ignore actions without work; the Obsidian fork gives those but is ~1100 lines to carry and maintain. Trade-off not yet decided.
- **Inline-worker + inline-WASM bundle size:** using `slimBinaryInlined` + `WorkerLinter` embeds ~20 MB of base64 in the plugin bundle. Acceptable for Obsidian; confirm Joplin has no plugin-size limits and that startup decode time is acceptable on lower-end machines.
- **Link/inline-markup linting behavior** (`ignore_link_title`) is not exposed through harper.js `LintOptions`; whether link text/URLs get linted the way you want is unverified beyond the code comment.
- **Docs are sparse / "early access, API not stable"** per the official introduction page — expect breaking changes across minor versions.

Sources (web): [harper.js API ref index](https://writewithharper.com/docs/harperjs/ref/harper.js.html), [WorkerLinter](https://writewithharper.com/docs/harperjs/ref/harper.js.workerlinter.html), [WorkerLinter.lint](https://writewithharper.com/docs/harperjs/ref/harper.js.workerlinter.lint.html), [WorkerLinter.importWords](https://writewithharper.com/docs/harperjs/ref/harper.js.workerlinter.importwords.html), [LocalLinter.setLintConfig](https://writewithharper.com/docs/harperjs/ref/harper.js.locallinter.setlintconfig.html), [LocalLinter.exportWords](https://writewithharper.com/docs/harperjs/ref/harper.js.locallinter.exportwords.html), [BinaryModule](https://writewithharper.com/docs/harperjs/ref/harper.js.binarymodule.html), [harper.js introduction](https://writewithharper.com/docs/harperjs/introduction), [npm harper.js](https://www.npmjs.com/package/harper.js). All code claims: `github.com/Automattic/harper` monorepo at file:line as cited above (clone at the scratch path noted at the top).