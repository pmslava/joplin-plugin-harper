I have everything needed. Writing the report.

---

# SCAFFOLD BLUEPRINT — joplin-plugin-harper (extracted from joplin-plugin-cockpit)

Repo cloned (shallow, HEAD `dc47ff6`) to `.../scratchpad/research-cockpit/joplin-plugin-cockpit`. All file:line refs below are inside that clone. Cockpit is at version 1.9.3, plugin id `io.github.pmslava.cockpit`, npm name `joplin-plugin-cockpit`.

## Headline finding
Cockpit contains **NO CodeMirror content script of any kind**. `grep -rni "codemirror\|contentScript" src` returns nothing in `src/`; the only hits are inside the generated `api/*.d.ts` / `api/types.ts` type defs (`api/JoplinContentScripts.d.ts`, `api/types.ts:536` `ContentScriptType` enum). Cockpit's entire UI surface is **panels + dialogs + webviews** (`src/ui/panel`, `src/ui/editor`, `src/ui/alarm`, `src/ui/styler`, `src/ui/toolbar`, `src/ui/menu`), driven from `src/index.ts` which calls a series of `setupX()` functions (`src/index.ts:23-40`). There is also **no `plugin.config.json`** in the repo (webpack defaults `extraScripts: []`, `webpack.config.js:28`), so Cockpit builds zero "extra scripts." Harper's editor-decoration surface (a CM6 content script) is therefore the single biggest thing the scaffold does **not** already cover — see section (d).

---

## 1. Project layout & build

- `package.json` (`package.json:1-62`): name `joplin-plugin-cockpit`, `version` 1.9.3, `keywords` includes `joplin-plugin` (required by Joplin's repo bot), `publishConfig.access: public`, `files: ["publish"]` (only the built dir is packed to npm). Scripts:
  - `dist` (`:13`): `webpack --env joplin-plugin-config=buildMain && ... buildExtraScripts && ... createArchive` — three sequential webpack invocations.
  - `test` (`:14`): `npm run dist && node test/run.js` (builds first, then runs the harness against the compiled bundle).
  - `setup:e2e` (`:15`), `test:e2e` (`:16`): `npm run dist && npm run setup:e2e && xvfb-run -a --server-args="-screen 0 1920x1080x24" playwright test`.
  - `prepare` (`:17`): `npm run dist` (so `npm ci`/publish rebuild).
  - `updateVersion` (`:19`): `webpack --env joplin-plugin-config=updateVersion`.
- This is the **stock Joplin generator (`yo joplin`) webpack config**, unmodified (`webpack.config.js:1-7` says so). Mechanics:
  - Reads `src/manifest.json`, validates categories/screenshots (`webpack.config.js:85-123`).
  - `buildMain` (`:184-216`, `:335-339`): entry `./src/index.ts` → `dist/index.js` via `ts-loader`; a `CopyPlugin` copies everything under `src/` **except `*.ts/*.tsx`** into `dist/` (`:199-215`) — this is how the webview `*.js`, `*.css`, and `manifest.json` reach `dist/`. First step wipes `dist/` and `publish/`.
  - `buildExtraScripts` (`:265-277`, driven by `plugin.config.json` `extraScripts`): compiles each named extra script to `dist/<name>.js` with `libraryTarget: commonjs`, `libraryExport: default` (`:253-262`). **Empty for Cockpit.**
  - `createArchive` (`:226-241`, `:158-167`): tars `dist/` into `publish/<id>.jpl` and writes `publish/<id>.json` (the manifest + `_publish_hash` sha256 + `_publish_commit`). The `.jpl` **is** the tarball of `dist/`.
  - `moduleFallback` (`:37-45`) sets all Node builtins to `false` (plugins run in Electron's Node).
  - `updateVersion` (`:279-303`) bumps the last version segment in both `package.json` and `src/manifest.json`.
- `tsconfig.json` (`tsconfig.json:1-20`): `outDir ./dist`, `module commonjs`, `target es2015`, `jsx react`, `allowJs true`, `baseUrl .`; includes `src` + `api`; excludes build/e2e output dirs.
- `src/manifest.json` (`src/manifest.json:1-46`): `manifest_version 1`, `id io.github.pmslava.cockpit`, `app_min_version 2.9`, `app_min_version_mobile 3.3`, `platforms [desktop, mobile]`, `version 1.9.3`, plus name/description/keywords/categories/screenshots.

## 2. Test harness (`test/harness.js`, `test/run.js`) — the "fast checks"

- `test/harness.js` (257 lines) exports `run(options)` (`:234-255`). It:
  - Builds a fake `joplin` global object (`:92-224`) stubbing `plugins`, `settings`, `commands`, `views.{panels,dialogs,toolbarButtons,menus}`, `workspace.on*`, and `data.{get,put,post,delete}`.
  - Sets `global.joplin = joplin`, busts the require cache and `require()`s the **compiled bundle** `../dist/index.js` (`:6`, `:237-238`) — it drives real built code, not source.
  - Captures `onStart` from `plugins.register` (`:94`) and invokes it (`:249`).
  - **Instruments everything** into a `state` object (`:10-52`): arrays for `notePuts`, `dataPosts`, `gets` (each `{path, query}`), `callLog` (ordered sequence of `setHtml` paints vs `bodyFetch` reads), `setHtmlCalls` counter, `settingWrites`, etc.
  - **Fake clocks**: `setInterval`/`clearInterval` captured at startup (`:244-247`); `setTimeout`/`clearTimeout` captured per-handler via `withTimerCapture` (`:60-88`) so tests drive refresh "lanes" by hand (`state.fireTimeout`, `state.pendingTimeouts`).
  - A `searchGate` one-shot (`:172-178`) lets a test freeze an in-flight search to test out-of-order paints.
- `test/run.js` (2818 lines): a tiny homemade runner — `test(name, fn)` (`:17-26`) with a `failures` counter, `main()` (`:28`) runs everything and `process.exit(failures?1:0)` (`:2814`). It calls `run(...)` twice up front for a **mobile** and **desktop** configuration (`:31-38`, differing by the injected `require` and `versionInfo.platform`).
- **API-call counting / performance budgets** (`test/run.js:261-265, 572-583, 616-623, 656-671, 688-979`): asserts like "a toggle triggers exactly one PUT and **no** search round-trip" (`:577,583`), "exactly one folder request per tick" (`:660`), "a switch paints from cache then does exactly one background refresh" (`:790`), "note change costs one targeted GET, one debounced overview pass, at most five bounded searches — not a 4× cascade" (`:895-911`). All implemented by diffing `state.gets.filter(...)` / `state.setHtmlCalls` / `state.callLog` before and after an action. This budget-assertion pattern is the harness's signature and is **highly reusable**.
- The version-lockstep test lives here (`test/run.js:2752-2765`) — see section 5.
- **Generic vs Cockpit-specific**: the harness *mechanism* (fake `joplin`, load compiled bundle, captured timers, `gets`/`callLog` instrumentation, `test()` runner, budget-diffing) is fully generic and copyable. Cockpit-specific: every fixture (`todos` array `:8-11`), the `sqlite3`/`fs-extra` desktop `require` (`:14-15`), and all assertions keyed to Cockpit's panel HTML/CSS (the huge CSS-string checks at the tail, e.g. `:2735-2818` about `--cockpit-*` variables and progress rings). Harper keeps the frame, replaces all fixtures and assertions.

## 3. E2E infrastructure (`e2e/`, `scripts/setup-e2e.sh`, `playwright.config.ts`)

- **AppImage download/cache** (`scripts/setup-e2e.sh:1-51`): idempotent bash. Version from `JOPLIN_E2E_VERSION` env, default **3.6.14** (`:10`). Downloads `Joplin-<v>.AppImage` from `github.com/laurent22/joplin/releases` into `.e2e-cache/Joplin.AppImage` (`curl -fSL --retry 3`), sanity-checks size >10 MB, then `--appimage-extract` into `.e2e-cache/squashfs-root/` (`:44`) — **no FUSE needed**. Skips if `squashfs-root/joplin` already exists (`:19-22`).
- **Launch over CDP under xvfb** (`e2e/launch.ts:1-254`): the crucial trick (`:8-21`) — Playwright's `_electron.launch` injects `--inspect=0`, which Joplin's strict flag allow-list rejects. So Cockpit spawns the Joplin binary **itself** with only Chromium-consumed flags (`--no-sandbox --disable-gpu --remote-debugging-port=<freeport>`, `:156-165`), waits for the CDP `/json/version` endpoint (`:91-107`), then `chromium.connectOverCDP` (`:179`) and finds the `index.html` renderer page across contexts (`:197-208`). `LD_LIBRARY_PATH` points at the extracted dir (`:169`). Start is retried 3× (`:139-148`) because a just-released profile lock can bounce the relaunch.
- **Throwaway profiles** (`e2e/launch.ts:57-77`): `createProfile()` makes `e2e/.profiles/profile-XXXX` via `mkdtempSync`, writes a `settings.json` with `welcome.enabled:false`, `autoUpdateEnabled:false`, `sync.target:0`, and crucially **`plugins.devPluginPaths: <repo>/dist`** (`:70`). **Correction to the brief: no `.jpl` is installed.** The plugin is loaded straight from the built `dist/` directory via `devPluginPaths`; `assertE2EReady` only checks `dist/manifest.json` and the Joplin binary exist (`:44-54`). `closeJoplin` SIGKILLs, waits for exit to release the lock, and `rm -rf`s the profile unless `keepProfile` (`:228-252`).
- **Finding/driving the plugin UI** (`e2e/helpers.ts:1-464`): the panel iframe is located **by content, not id** — it scans `win.frames()` for one containing `#profileControls` (`:34-42`), because the plugin-id-based iframe id (`plugin-view-<id>-panel`, `:60`) contains dots that break CSS id selectors. Helpers expose `agendaPanel`, `panelIsPresent/Visible`, `panelTodoTitles`, `createTodo`, `createNotebook`, etc. A representative spec (`e2e/plugin-loads.spec.ts:1-97`) proves: the plugin background webview page exists over CDP (`?pluginId=<id>` URL, `:32-45`), the panel renders, the toolbar button registers, toggling shows/hides. Note the CI workaround (`:82-96`): buttons are `dispatchEvent('click')`ed rather than really clicked because under xvfb the panel iframe overlaps the toolbar and Playwright refuses the hit-test.
- `playwright.config.ts:13-35`: `testDir ./e2e`, serial (`fullyParallel:false, workers:1`), generous timeouts (`timeout 240s`, `globalTimeout 18min` deliberately under the CI 20-min cap), `retries:1`, trace/screenshot on failure.
- **Generic vs Cockpit-specific**: `setup-e2e.sh`, the whole CDP launch/profile machinery in `launch.ts`, `playwright.config.ts`, and the CI e2e job are **generic** (only `PLUGIN_ID` at `launch.ts:32` is Cockpit-specific). The 11 spec files (`calendar/multi-drag/overview-note/panel-todos/profiles/row-click-open/search-commit/selection-crossing/themes/showcase/plugin-loads.spec.ts`) and all of `helpers.ts`'s panel-driving logic are Cockpit-specific.
- **Estimate for Harper (editor decorations, not a panel/dialog)**: The download/cache/launch/profile layer is reused essentially verbatim. What must change is *how tests locate the plugin surface*. Cockpit finds a panel **iframe** and reads its DOM; Harper has **no iframe** — its output is CM6 decorations (underlines/marks) painted **inside the main editor DOM** (`.cm-editor` in the main renderer page, not a sub-frame). So `helpers.ts` gets rewritten to: type text into the CodeMirror editor, then assert on decoration DOM (e.g. `.cm-lintRange`, custom-classed spans, or the tooltip/gutter Harper renders) directly on `win`, no `frames()` scan. The `plugin-loads` proof-of-life changes from "background webview `?pluginId=` page exists + panel renders" to "content script registered + a known grammar error gets decorated." Keep: `launch.ts`, `setup-e2e.sh`, `playwright.config.ts`, the profile/`devPluginPaths` mechanism, CDP attach.

## 4. CI (`.github/workflows/`)

- `tests.yml` (`.github/workflows/tests.yml:1-76`): triggers on push to main/master, all PRs, manual. Two jobs:
  - `harness` (`:11-21`): `ubuntu-24.04`, Node 20, `npm ci`, `npm test` (build + fast checks, both platforms).
  - `e2e` (`:24-75`): `needs: harness`, `timeout-minutes: 20`, env `JOPLIN_E2E_VERSION: 3.6.14` (`:34`, "keep in sync with setup-e2e.sh"). Installs Chromium host deps via `sudo npx playwright install-deps chromium` + `apt-get install -y xvfb` (`:47-50`), caches `.e2e-cache/Joplin.AppImage` keyed on the version (`:54-58`), runs `npm run test:e2e`, always-uploads `playwright-report/` + `test-results/` (`:65-75`).
- `publish.yml` (`.github/workflows/publish.yml:1-178`): triggers on GitHub **Release published** (or manual). Uses **npm trusted publishing (OIDC), no NPM_TOKEN** (`:5-30`). Job declares `environment: npm` and `permissions: id-token: write` (`:41-45`). Steps: resolve version from the release tag `vX.Y.Z → X.Y.Z` and write it into **both** `package.json` and `src/manifest.json` (`:58-71`); `npm ci` (scripts left ON, needed for sqlite3 native binding, `:73-76`); `npm test`; `npm run dist`; assert `publish/<id>.jpl` and `publish/<id>.json` exist and non-empty (`:89-99`); switch to Node 24 + npm ≥11.5.1 for the OIDC-capable runtime (`:104-115`); a diagnostic step that prints the OIDC claims (`:125-161`); `npm publish --ignore-scripts --loglevel=verbose` (`:163-178`). The header comment (`:7-19`) documents the one-time npmjs.com trusted-publisher setup (Provider GitHub Actions, Owner `pmslava`, Repo `joplin-plugin-cockpit`, Workflow `publish.yml`, Environment `npm`).
- **Must adapt for Harper**: (a) In `publish.yml:11-14` header the trusted-publisher **Owner/Repository** must be reconfigured on npmjs.com for the new repo, and the doc comment updated. (b) The `.jpl`/`.json` existence check keys off `src/manifest.json` `id` at runtime (`:91`), so it auto-follows the new plugin id — no edit needed. (c) `JOPLIN_E2E_VERSION` in both `tests.yml:34` and `setup-e2e.sh:10` must be ≥ Harper's `app_min_version` (Harper needs CM6 ⇒ desktop min likely ≥3.x, so probably **raise** this). (d) The sqlite3-driven install-scripts rationale (`publish.yml:73-76`) is Cockpit-specific (Cockpit depends on `sqlite3`/`typeorm`); Harper won't need it and can use `--ignore-scripts` on `npm ci` unless it pulls native deps.

## 5. The version-quadruple check

Enforced in the **harness suite**, `test/run.js:2752-2765`. The test reads `package.json.version`, `src/manifest.json.version`, `package-lock.json.version` (top-level) and `package-lock.json.packages[""].version`, and asserts all four `=== '1.9.3'` (the expected value is hard-coded, `:2758`; the last commit `dc47ff6` "Pin the version-lockstep test to 1.9.3" did exactly this). Comment (`:2749-2751`) notes the four drifted once when the lockfile went stale. Because it runs inside `npm test`, it gates both CI `harness` and the pre-publish `npm test` in `publish.yml:81`. For Harper: copy verbatim, change the hard-coded `expected` string to Harper's version (and remember to bump it on every release, or the publish will fail — publish.yml rewrites package.json + manifest from the tag but does **not** touch package-lock, so the lockfile must be committed already in sync).

## 6. Other playbook infrastructure worth copying

- `scripts/setup-e2e.sh` — generic (section 3).
- `.gitignore` (`.gitignore:1-10`): ignores `dist/ node_modules/ publish/ .e2e-cache/ e2e/.profiles/ test-results/ playwright-report/ .vscode/`. Generic; copy verbatim.
- The `api/` directory (25 `.d.ts`/`.ts` files, generated by `yo joplin`) is the Joplin plugin API typings the build aliases as `api` (`webpack.config.js:187`, `tsconfig.json` include). Copyable, but regenerate/update via `npm run update` (`package.json:18`) to a version new enough for the CM6 content-script API.
- **No lint config exists** (no `.eslintrc*`, `.prettierrc`, `.editorconfig`; `package.json` has no lint script). The `github/array-foreach` / `eslint-disable` comments in `webpack.config.js` are dead leftovers from the generator. Nothing to copy here.
- README.md / LICENSE (MIT) / `docs/` — project-specific.

---

## THE BLUEPRINT (ordered)

**(a) Copy essentially verbatim**
1. `webpack.config.js` — stock generator config (only touch if adding WASM handling, see (d)).
2. `tsconfig.json` — adjust nothing except possibly `target`/`lib` if CM6 needs it.
3. `.gitignore`.
4. `scripts/setup-e2e.sh` — bump the default Joplin version.
5. `playwright.config.ts`.
6. `e2e/launch.ts` — the CDP-spawn + throwaway-profile + `devPluginPaths` machinery (change only `PLUGIN_ID`, `launch.ts:32`).
7. `.github/workflows/tests.yml` — bump `JOPLIN_E2E_VERSION`.
8. `test/harness.js` — the fake-`joplin` + captured-timers + `gets`/`callLog`/`setHtmlCalls` instrumentation and `run()` loader.
9. The version-quadruple test block (`test/run.js:2752-2765`).
10. `api/` typings (then `npm run update` to a CM6-capable version).

**(b) Copy-and-adapt**
1. `package.json` — new `name` (`joplin-plugin-harper`), keep `keywords:[joplin-plugin,…]`, `publishConfig.access:public`, `files:["publish"]`, the `dist`/`test`/`setup:e2e`/`test:e2e`/`prepare`/`updateVersion` scripts. Drop Cockpit deps (`sqlite3`, `typeorm`, `date-fns`, `browserify`, `stream-browserify`, `reflect-metadata`, `yo`); add Harper's (`harper.js`/`harper-wasm` or the CM6 lint integration + `@codemirror/*` types).
2. `src/manifest.json` — new `id` (e.g. `io.github.<you>.harper`), name/description, **raise `app_min_version`** to a CM6 build (drop mobile or keep per Harper's capabilities), new keywords/categories.
3. `.github/workflows/publish.yml` — reconfigure the trusted-publisher block (Owner/Repo/env) on npmjs.com and in the header comment; drop the sqlite3/install-scripts rationale.
4. `test/run.js` — keep the `test()` runner, the twin `run()` bootstraps, the budget-diffing *pattern*; replace all fixtures and assertions with Harper's (see (d)).
5. `e2e/helpers.ts` + spec files — rewrite to type into `.cm-editor` and assert on decoration DOM in the main window (no iframe scan); keep a `plugin-loads`-style proof-of-life.

**(c) Cockpit-specific — skip entirely**
- All of `src/` (`index.ts`, `src/core/*`, `src/ui/{panel,editor,alarm,styler,toolbar,menu}/*`) — panels/dialogs/webviews/sqlite/typeorm/calendar logic Harper doesn't have.
- `docs/`, Cockpit README, Cockpit screenshots.
- The Cockpit e2e specs (`calendar`, `multi-drag`, `overview-note`, `panel-todos`, `profiles`, `row-click-open`, `search-commit`, `selection-crossing`, `themes`, `showcase`).
- Cockpit's panel-CSS/progress-ring assertions in `test/run.js` tail.

**(d) New things Harper needs that Cockpit has no equivalent for**
1. **A CodeMirror 6 content script** — the core surface. Register via `joplin.contentScripts.register(ContentScriptType.CodeMirrorPlugin, 'harper-cm6', './contentScript/index.js')` (enum in `api/types.ts:536`; Cockpit never calls this). Cockpit has **zero** content scripts, so there is no template in-repo to copy.
2. **An "extra script" build entry** — Cockpit has no `plugin.config.json` (webpack defaults `extraScripts:[]`). Harper must add `plugin.config.json` with `{"extraScripts":["contentScript/index.ts"]}` so `buildExtraScripts` (`webpack.config.js:265-277`) compiles the CM6 script to `dist/contentScript/index.js` with `libraryTarget:commonjs`, `libraryExport:default`. (Alternatively bundle it as its own webpack entry.)
3. **WASM asset handling** — Harper's engine is a Rust/WASM blob. The stock webpack config has no WASM/`asset/resource` rule and its `CopyPlugin` (`webpack.config.js:199-215`) copies non-`.ts` files 1:1 but won't fingerprint or wire a `.wasm` for `WebAssembly.instantiate`. Options: run Harper in the **plugin background context** (Node/Electron, can `fs.readFile` the `.wasm` from `installationDir`) vs. inside the **CM6 content-script iframe** (needs the `.wasm` served as a plugin asset). Add a webpack rule (`experiments.asyncWebAssembly` or `type:'asset/resource'`) and ensure the `.wasm` lands in `dist/` so it's tarred into the `.jpl`. This is genuinely new engineering with no Cockpit precedent.
4. **Harness stubs for the content-script/editor API** — `test/harness.js` stubs `views.panels`/`dialogs` but **not** `joplin.contentScripts.register`/`onMessage`. Add those stubs so the compiled bundle's `onStart` doesn't throw, and add budget checks meaningful for Harper (e.g. "one lint pass per debounce, not per keystroke") reusing the captured-timer pattern.
5. **E2E decoration assertions** — new helpers that read CM6 decoration DOM (underlines, tooltip, suggestion menu) instead of panel HTML.

## UNKNOWNS AND RISKS
- **Harper WASM placement is unverified.** I did not fetch the Harper repo; whether `harper.js` runs in the CM6 sandboxed iframe, the plugin background page, or needs a Web Worker — and thus exactly which webpack/WASM wiring is required — is unconfirmed. The section (d) guidance is inferred from Joplin's plugin architecture + the stock webpack config, not from a working Harper example.
- **CM6 content-script API surface / min version.** I confirmed `ContentScriptType.CodeMirrorPlugin` exists in Cockpit's bundled `api/types.ts`, but Cockpit's `api/` predates newer CM6 additions (its manifest targets app_min 2.9). The precise Joplin desktop version at which the CM6 `codeMirrorWrapper`/`ContentScriptContext` for editor decorations is stable was not verified against Joplin docs — set `app_min_version` from Joplin's official CM6 plugin docs before release.
- **Whether CM6 decorations render in a sub-frame or the main DOM in the shipped Joplin build** was not empirically confirmed (I only read Cockpit's iframe-based helpers). The e2e-rewrite estimate assumes decorations live in the main renderer's `.cm-editor`; verify by launching a real Joplin with a trivial content script.
- **Trusted-publishing first-run** always requires manual npmjs.com config for the new package/owner; this cannot be done from the repo and will fail with `ENEEDAUTH` until set (documented, not a code change).
- I read `test/run.js` only at head/tail and via targeted greps (2818 lines); there may be additional reusable harness patterns in the middle I did not fully enumerate.
- `package-lock.json` (794 KB) was not inspected line-by-line; the quadruple-check reads only its two `version` fields, which I confirmed via the test source, not by opening the lockfile.