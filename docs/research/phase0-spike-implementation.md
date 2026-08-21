Working tree clean; the stray `397.index.js` chunk I noted earlier is gone (only appears transiently). All gates pass. Here is the report.

---

# PHASE 0 REPORT — joplin-plugin-harper walking skeleton

## 1) Commit + branch
- Branch: `spike/walking-skeleton` (branched from `main` @ `860ad33`)
- Full commit hash: **`8ac4be10014a1da0c301cca94c1db3b7741522be`**
- One commit only. `main` untouched (still `860ad33`). Nothing pushed.

## 2) File inventory (all paths absolute under /home/mrsir/Lab/joplin-plugin-harper)
Copied verbatim from Cockpit blueprint:
- `webpack.config.js` — stock generator config, then two deliberate edits (see §3/§6)
- `tsconfig.json` — + `skipLibCheck: true` (see §6)
- `.gitignore`, `LICENSE`, `playwright.config.ts`
- `scripts/setup-e2e.sh` — Joplin 3.6.14 (unchanged; already ≥ app_min 3.1)
- `.github/workflows/tests.yml` — unchanged (JOPLIN_E2E_VERSION 3.6.14)
- `api/` — 25 Joplin typing files (already contain CM6 `ContentScriptContext`/`ContentScriptType.CodeMirrorPlugin`/`installationDir`; no regeneration needed)
- `test/harness.js` — Cockpit frame + added `contentScripts.register`/`onMessage` stubs

Copy-and-adapt:
- `package.json` — name `joplin-plugin-harper`, v0.1.0, keyword `joplin-plugin`; only dep `harper.js@2.7.0`; devDeps add `@codemirror/{lint,state,view}` (type-only) + TypeScript 5.4; Cockpit's sqlite3/typeorm/etc dropped
- `src/manifest.json` — id `io.github.pmslava.harper`, manifest_version 1, app_min_version 3.1, platforms [desktop], v0.1.0
- `e2e/launch.ts` — `PLUGIN_ID = 'io.github.pmslava.harper'` (only change)

New:
- `plugin.config.json` — `extraScripts: ["contentScript.ts"]`
- `src/index.ts` — plugin main: registers CM6 content script + lint onMessage handler; lazy harper.js LocalLinter; flattens WASM Lint/Suggestion handles to plain JSON
- `src/contentScript.ts` — CM6 stock `@codemirror/lint` `linter()` extension, whole-doc, delay 500ms, severity map + suggestion→Action apply
- `src/types/harper.d.ts` — minimal ambient `declare module 'harper.js'` (see §6)
- `test/run.js` — Harper harness suite (registration, lint round-trip against REAL harper.js in Node, version quadruple, measurements)
- `e2e/helpers.ts` — editor-DOM helpers (`.cm-content` typing, `.cm-lintRange` counting); no iframe scan
- `e2e/plugin-loads.spec.ts` — background-page proof + type-errors→decorations proof

## 3) Fork decisions (with evidence)
- **Local vs Worker linter: LocalLinter.** As briefed. It works in Node (harness) and in the plugin main process. Not re-litigated.
- **WASM loading path: SHIP the .wasm in dist/ (CopyPlugin), but load it via a `data:` URL built from bytes read with a runtime `require('fs')` — NOT the briefed `file://` + `createBinaryModuleFromUrl` path.** This is the one forced deviation and I flag it loudly. Evidence: with the file:// URL, the real Electron plugin renderer threw `[PLUGIN pageerror] Failed to resolve module specifier 'fs'`, and zero decorations rendered. Root cause: harper.js 2.7.0's `getInitInput` does a native dynamic `import('fs')` for `file://` binaries (`BinaryModule glue …getInitInput`), which Blink's module loader in the Electron renderer cannot resolve (only `require('fs')` works there). Fix in `src/index.ts`: `__non_webpack_require__('fs').readFileSync(<installDir>/harper_wasm_bg.wasm)` → base64 → `data:application/wasm;base64,…` → `createBinaryModuleFromUrl(dataUrl,'full')`. A `data:` URL is not the `file://` branch, so harper does `fetch(dataUrl)`, which is supported by both Node's undici fetch (harness) and Blink (renderer). This keeps the .wasm shipped as a file (main bundle stays ~160 KB, not the ~20 MB `binaryInlined` blob) and works in both environments. Re-verified: 3 decorations (debug) then 5 decorations (spec) in real Joplin.
- **@codemirror/* as webpack externals — confirmed in the emitted bundle.** `dist/contentScript.js` (1491 bytes) contains `require("@codemirror/lint")` and zero bundled CodeMirror/harper code; `dist/index.js` contains zero `@codemirror` references. (`@codemirror/view` appears only as an erased type import, so only `@codemirror/lint` is required at runtime — that is the external the brief asked to verify.)
- **Severity map** Spelling→error, else→warning: confirmed live — `beleive`/`definately` got `cm-lintRange-error`, `an`/`teh`/`should of` got `cm-lintRange-warning`.
- **harper.js is ESM-only** (exports map exposes only `import`). Required adding `resolve.conditionNames: ['require','node','import','default']` to the main webpack config or the build fails with `"." is not exported`.

## 4) Measurements
- Linter init (first lint = binary load + setup + prime, includes base64 decode of 15.8 MB): **~1.4–2.2 s** across runs (harness, Node 26).
- lint() latency, ~5282 B markdown doc, **median of 5: 65–93 ms** (representative run `170,75,79,72,57` → 75 ms; another `190,142,78,93,91` → 93 ms). First run of each batch is warm-cache-affected (~170 ms), steady-state ~60–90 ms.
- E2E text→decoration: on the cold first lint, decorations appear within a few seconds (dominated by the ~2 s WASM init); the spec's poll resolved with test-2 total duration 16.6 s (includes notebook+note creation and typing). Steady-state repaints are sub-100 ms. I did not instrument a precise millisecond text→paint figure in-app; treat "a few seconds cold, <100 ms warm" as the honest bound.
- Sizes: `dist/` total **16,013,027 B (16 MB)**; `.jpl` **16,017,408 B**; main bundle `dist/index.js` **162,847 B**; content-script `dist/contentScript.js` **1,491 B**; wasm `dist/harper_wasm_bg.wasm` **15,848,134 B**.
- Env: Node **v26.7.0**, npm **12.0.2**, Arch Linux, xvfb-run present. (Note: CI `tests.yml` pins Node 20; I ran Node 26 locally — see §7.)

## 5) Gate outputs (verbatim tails)

Gate 2 — `npm test`:
```
  PASS  onStart completed and registered exactly one content script
  PASS  content script registered with the codeMirrorPlugin type, id and path
  PASS  an onMessage handler was registered for the content script
  PASS  lint response is a plain-JSON array (no WASM handles leak across IPC)
  PASS  lint found at least one issue with at least one suggestion
  PASS  every span indexes its own problemText in the source string
  PASS  the misspelling "beleive" is flagged as a Spelling lint spanning the word
  PASS  suggestion shape is {kind, replacementText} with a known kind
  PASS  a ~5 KB document lints and returns issues
  PASS  version: package.json, manifest, and both package-lock fields are all 0.1.0
  MEASUREMENTS
    linter init (first lint: binary load + setup + prime): 1998 ms
    lint latency, ~5282 B doc, median of 5: 93 ms  (runs: 190, 142, 78, 93, 91)
All tests passed.
```

Gate 3 — `npm run test:e2e` (under xvfb, at this commit's code):
```
Running 2 tests using 1 worker
  ✓  1 e2e/plugin-loads.spec.ts:31:7 › Harper plugin loads and lints › plugin background page is running (CDP) (16ms)
[harper-e2e] lint decoration count = 5
[harper-e2e] lint decorations:
<span class="cm-lintRange cm-lintRange-warning">an</span>
<span class="cm-lintRange cm-lintRange-error">beleive</span>
<span class="cm-lintRange cm-lintRange-warning">teh</span>
<span class="cm-lintRange cm-lintRange-warning">should of</span>
<span class="cm-lintRange cm-lintRange-error">definately</span>
  ✓  2 e2e/plugin-loads.spec.ts:37:7 › Harper plugin loads and lints › typing text with errors paints lint decorations in the editor (16.6s)
  2 passed (33.4s)
```

Gate 4 — `npm run dist` + `ls -la publish/`:
```
Plugin archive has been created in /home/mrsir/Lab/joplin-plugin-harper/publish/io.github.pmslava.harper.jpl
total 15648
-rw-r--r-- 1 mrsir mrsir 16017408 ... io.github.pmslava.harper.jpl
-rw-r--r-- 1 mrsir mrsir      734 ... io.github.pmslava.harper.json
```
`.jpl` tar contains exactly: `contentScript.js`, `harper_wasm_bg.wasm`, `index.js`, `manifest.json`.

## 6) Deviations from the brief + reasons
1. **WASM loading mechanism** — brief's preferred path (1) file:// + `createBinaryModuleFromUrl` does NOT work in the Electron renderer (§3). Used a data:-URL-from-shipped-file approach that preserves the intent of option (1) ("ship the .wasm in dist/, don't inline 20 MB") while actually working. Fallback `binaryInlined` was not needed.
2. **`resolve.conditionNames` added to `webpack.config.js`** — mandatory; harper.js is ESM-only and the stock node config can't resolve it otherwise.
3. **CopyPlugin pattern + `externals` added to `webpack.config.js`** — the briefed CopyPlugin (wasm→dist) and the externals for @codemirror; the stock config had neither. Both clearly commented as HARPER edits.
4. **`skipLibCheck: true` in tsconfig + `src/types/harper.d.ts` ambient module** — I deliberately do NOT let TS resolve harper.js's own .d.ts: it's ESM with an exports map (unreadable by `moduleResolution: node`) and its declarations use `Symbol.dispose`. Webpack resolves the real runtime via the exports map; the shim only feeds the type-checker the shapes used. This avoids bumping the whole tsconfig to node16/bundler resolution.
5. **manifest** — dropped `app_min_version_mobile` and `mobile` platform (Harper spike is desktop-only); dropped `screenshots` (none exist yet — the webpack screenshot validator would otherwise fail).

## 7) PROBLEMS / SURPRISES for the verifier/manager to scrutinize
- **The data-URL WASM loader is the load-bearing non-obvious decision.** If a future harper.js version changes its binary loader, re-test in the REAL renderer, not just the harness — the harness (Node) would have passed even with the broken file:// path (Node resolves `import('fs')`; only the Electron renderer exposed the bug). The harness alone is NOT sufficient to validate WASM loading; the E2E is what caught it. Keep both gates.
- **`__non_webpack_require__('fs')`** relies on the plugin main process having Node integration (true on desktop; confirmed by the passing E2E). This will NOT work on mobile (no Node) — consistent with desktop-only scope, but a Phase-1+ mobile effort needs a different loader (likely `binaryInlined` + fetch(data:)).
- **base64 of 15.8 MB at every cold start**: init cost ~1.4–2.2 s includes this decode. Acceptable for a spike; if it bites, switch to reading bytes once and caching, or reconsider `binaryInlined`.
- **Node version mismatch**: I ran locally on Node 26; CI `tests.yml` pins Node 20 (unchanged from Cockpit). harper.js needs a fetch that supports `data:` URLs — Node 20's global fetch (undici) does support data: URLs, so it should be fine, but this was NOT exercised on Node 20 here. Worth a CI run to confirm.
- **E2E `pgrep -f e2e-cache` self-match**: the guard command's own shell command line contains the string `e2e-cache`, so `pgrep -f e2e-cache` matches itself and prints a PID even when no Joplin/Playwright is live. I verified by PID inspection that no real run was live. If this guard is scripted in CI, use a more specific pattern (e.g. `squashfs-root/joplin`) to avoid a false "live" reading.
- **Default bundled plugins in the throwaway profile**: the E2E profile loaded Joplin's built-in `backup` and `js-draw` plugins alongside ours (visible in console). Harmless, but it means the profile is not perfectly minimal.
- **Title-vs-body focus quirk**: in the E2E, the typed error text landed in both the note title and body (Joplin derives title from first body line). The decoration assertion targets the editor `.cm-content`, so this doesn't affect correctness, but the `createNote`→`setEditorBody` focus handoff is a little loose and could be tightened in Phase 1.
- **Suggestion-apply is built but not asserted end-to-end in E2E.** The spec asserts decoration presence + classes and logs innerHTML evidence (as the brief allowed as the minimum); it does not click a tooltip to apply a fix. The apply logic IS implemented in `contentScript.ts` and the suggestion shape is unit-checked in the harness. A real apply-fix E2E is a Phase-1 item.
- **`publish/` transient chunk**: the `createArchive` webpack pass momentarily emits a `NNN.index.js` split chunk (from harper's `import('fs')`), which `onBuildCompleted` doesn't delete; it's in gitignored `publish/` and not in the `.jpl`, so harmless.