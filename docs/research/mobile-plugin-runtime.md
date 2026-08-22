I now have everything needed. Here is the report.

---

# RESEARCH REPORT — The Joplin MOBILE plugin runtime (what our Harper plugin main process + content script actually run inside)

**Scope / provenance.** All "code" citations are to a shallow sparse clone of `laurent22/joplin`, **default branch `dev`, HEAD commit `0fa387b` ("Plugin Repo CLI v3.7.3")**, cloned 2026-08-22 into `/tmp/claude-1000/-home-mrsir-Lab-joplin-plugin-harper/f70ff77f-1ceb-407e-9024-9da9993b0b91/scratchpad/research-mobile-runtime/joplin/`. I abbreviate that path prefix as `<J>/`. Line numbers are from that commit. Read-only research; nothing was launched. This is a peer to the desktop-focused report in `docs/research/joplin-plugin-api.md` §7 and extends/corrects it with the actual mobile source.

The headline correction to that earlier report: its §7 said the mobile plugin process is "a sandboxed WebView." It's more specific and more favorable than that — it is a **`sandbox="allow-scripts allow-modals"` srcdoc iframe running inside a hidden react-native-webview, and neither layer applies any CSP.** That materially changes the WASM story versus desktop.

---

## 1. Where the plugin main bundle executes on mobile, and what globals exist

**Execution context (three nested layers):**

1. **A hidden `react-native-webview`** (`WebView` from `react-native-webview`, `useWebKit` on iOS / Android System WebView on Android). Joplin renders one 1×1, `opacity:0`, off-screen `ExtendedWebView` as the plugin host: `<J>/packages/app-mobile/components/plugins/PluginRunnerWebView.tsx:104-111` (`hiddenStyle`), `:182-194` (the `ExtendedWebView` with `webviewInstanceId='PluginRunner2'`, `hasPluginScripts`, `allowFileAccessFromJs`). The underlying RN WebView props: `<J>/packages/app-mobile/components/ExtendedWebView/index.tsx:115-148`.
2. **The WebView document** is written to disk as an HTML file and loaded over `file://` (`<J>/packages/app-mobile/components/ExtendedWebView/index.tsx:56-69`, `originWhitelist` includes `about:srcdoc`, `:134`). The HTML body is empty; the runner code (`pluginBackgroundPage`) is injected via `injectedJavaScript` (`PluginRunnerWebView.tsx:159-180`).
3. **The plugin's own code runs one level deeper, inside a `srcdoc` sandboxed iframe** created per-plugin by `makeSandboxedIframe` — `<J>/packages/app-mobile/components/plugins/backgroundPage/startStopPlugin.ts:68` calls `makeSandboxedIframe(...)`, defined at `<J>/packages/lib/utils/dom/makeSandboxedIframe.ts:11-14` with `sandbox="allow-scripts allow-modals"` (no `allow-same-origin` → **opaque/null origin**). The plugin bundle text is injected into that iframe as a `<script>` textNode (`makeSandboxedIframe.ts:45-49`). This matches the forum statement "on mobile, all plugins run in iframes within a WebView."

So: **it is a WebView + WebKit/Chromium JS engine — NOT Hermes/JSC, and NOT Node.** React Native's own JS engine (Hermes/JSC) runs the app; the plugin runs in the WebView's browser engine. Communication from plugin→app is a message chain: iframe `WindowMessenger` → `WebViewToRNMessenger`/`RNToWebViewMessenger` over the RN bridge → `PluginRunner.onWebviewMessage` (`<J>/packages/app-mobile/components/plugins/PluginRunner.ts:36-64, 80-85`; `startStopPlugin.ts:81-94`).

**How the bundle is delivered to that context:** On **native** mobile the bundle is **not** shipped over the RN bridge. `PluginRunner.run` computes `scriptFilePath = ${plugin.baseDir}/index.js` and injects a call that reads it **from disk via `XMLHttpRequest('GET','file://'+path)`** (fetch can't do `file://` on Android WebView) — `PluginRunner.ts:49-62` and `startStopPlugin.ts:41-50` (with the explicit comment "we use XMLHttpRequest because fetch() doesn't support file:// URLs on Android WebView"). On **web** builds the script text is passed inline instead. Corroborating: `PluginService.loadPluginFromPath` skips reading `index.js` into memory on native mobile — `<J>/packages/lib/services/plugins/PluginService.ts:407-416` (`loadMainScript = !shim.mobilePlatform() || shim.mobilePlatform()==='web'`).

**Globals present** (standard modern WebKit/Chromium browser globals — this is a full browser context, not RN):
- `WebAssembly` — **yes** (see §2).
- `fetch` — yes, **but blocked for `file://`** (hence the XHR workaround above). `fetch` of `data:`/`blob:` URLs works.
- `XMLHttpRequest` — yes (actively used, `startStopPlugin.ts:44`).
- `Worker` — yes in principle (Chromium/WebKit); but a WorkerLinter's Vite worker-import syntax won't webpack-bundle (already flagged in SPEC.md:13-14), so **LocalLinter is the only viable path** — see §2/Risks.
- `atob`/`btoa`, `crypto`/`crypto.subtle`, `TextEncoder`/`TextDecoder`, `URL`, `postMessage` — yes (standard browser globals; `file://` and `about:srcdoc` are treated as potentially-trustworthy secure contexts in Chromium, so `crypto.subtle` is available — though Harper doesn't need it).
- **`window.require` is a stub**, not Node's require. It's replaced by `pluginBackgroundPage.requireModule(module, pluginId)` (`startStopPlugin.ts:58-60`), which throws for everything except `'path'` (and, only for three hard-coded legacy plugin ids, a **non-functional fs mock**) — `<J>/packages/app-mobile/components/plugins/backgroundPage/pluginRunnerBackgroundPage.ts:13-44`. **`require('fs')`/`require('os')`/`joplin.require('fs-extra')` all throw or return a no-op mock on mobile.** This is the single biggest break for our plugin.

---

## 2. CSP / WASM: is `WebAssembly.instantiate` permitted?

**Answer from source: almost certainly YES — no CSP is applied at any layer, which is the opposite of the desktop editor situation.**

- The plugin-runner WebView document is a 5-line HTML string with **no `<meta http-equiv="Content-Security-Policy">`** — `PluginRunnerWebView.tsx:159-168`.
- `ExtendedWebView` sets **no** `Content-Security-Policy` and no injected CSP; a repo-wide grep for CSP tokens across `packages/app-mobile` returns **only** `packages/app-mobile/web/public/index.html` (the PWA/web build, irrelevant to native). There is no `wasm-unsafe-eval`/`unsafe-eval`/`script-src` anywhere in the native mobile plugin path.
- The plugin iframe's srcdoc (`makeSandboxedIframe.ts:26-56`) has **no CSP meta** either, and a child frame with no CSP inherits none from a parent that has none.
- The HTML `sandbox` attribute does **not** disable WebAssembly (sandbox gates origin/navigation/forms/popups, not the WASM compile pipeline). WASM is gated only by CSP `wasm-unsafe-eval`, and there is no CSP here. The opaque (null) origin from omitting `allow-same-origin` does not block `WebAssembly.compile/instantiate`.

Contrast desktop, where WASM in the editor is blocked by the main-window `script-src` lacking `wasm-unsafe-eval` (`docs/research/joplin-plugin-api.md:47-49`). **On mobile that blocker does not exist** — both the plugin-runner iframe *and* the markdown-editor WebView (§3, `MarkdownEditor.tsx:92-112`, also no CSP meta) permit WASM.

**Corroboration outside source:** the Firefox-Android Harper extension proves Harper's WASM runs on Android hardware/Gecko; and Android System WebView (Chromium) has supported WebAssembly since Chromium 57 (2017). Confidence: **high on "no CSP blocks it"; medium-high on "it runs correctly at 15.8 MB"** — see the settling experiment.

**Exact on-device experiment that settles it (source can't prove runtime behavior of the specific System WebView build + memory):** Build a trivial plugin, `platforms:["mobile","desktop"]`, whose `onStart` runs
```js
const ok = await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));
```
then progressively (a) instantiate the real ~11.8 MB Harper module decoded from inlined base64, (b) run one `LocalLinter.lint()` on a 5 KB doc, logging timings and any `CompileError`/`RangeError`/OOM. Read results via **Config > Plugins > Advanced > enable plugin WebView debugging → Chrome `chrome://inspect`** (per the official debugging doc, §6). A pass on a mid-range Android device is the go/no-go gate for the whole mobile port.

**WASM-loading path is forced to change on mobile.** Desktop reads the `.wasm` from disk via `fs` and feeds a base64 `data:` URL to `createBinaryModuleFromUrl`. On mobile there is **no `fs`** to read the shipped `.wasm`, and `fetch('file://…wasm')` is blocked. So the only path is **`harper.js/binaryInlined`** (WASM base64-embedded in the JS bundle; ~20 MB base64 → ~21 MB bundle) — exactly the fallback SPEC.md:16-17 named, but on mobile it is mandatory, not a fallback.

---

## 3. CM6 content scripts on mobile

**Confirmed: the CM6 content-script mechanism is the SAME code as desktop** — the loader and the CodeMirror-library bridge live in the shared `@joplin/editor` package used by both apps.

- **Registration → load:** mobile enumerates `ContentScriptType.CodeMirrorPlugin` scripts in `<J>/packages/app-mobile/contentScripts/markdownEditorBundle/utils/useCodeMirrorPlugins.ts:18-56`. Each script's JS is produced by `contentScriptJs` as **inline `sourceJs`**: it reads the file off disk with `shim.fsDriver().readFile(contentScript.path)` and concatenates `context.contentScriptStartJs + <file> + context.contentScriptEndJs` (`:36-44`). `postMessageHandler` is wired to `plugin.emitContentScriptMessage(contentScriptId, message)` (`:51-54`) — same bridge name as desktop.
- **Actual injection + require bridge are shared code:** `<J>/packages/editor/CodeMirror/pluginApi/PluginLoader.ts` builds a `<script>` textNode from `sourceJs` (`:98-106`), wraps it with a `require`/`joplin.require` shim (`:78-90`), and calls `exports.default(context)` where `context = { postMessage, pluginId, contentScriptId }` (`:142-147`) then `loadedPlugin.plugin(this.editor)` (`:149`). This is the identical file desktop uses.
- **Same Joplin-provided `@codemirror/*` modules are `require()`-able:** the whitelist is `<J>/packages/editor/CodeMirror/pluginApi/codeMirrorRequire.ts:22-37`, and it explicitly includes **`@codemirror/lint`, `@codemirror/view`, `@codemirror/state`**, `@codemirror/language`, `@codemirror/autocomplete`, `@codemirror/commands`, `@codemirror/search`, lang-markdown/html, language-data, and the lezer packages. Because this module is in `@joplin/editor` (shared), the set is **byte-identical on mobile and desktop**. So our stock `linter()`/`Diagnostic`/`setDiagnostics` underline approach and `editorControl.addExtension(...)` port unchanged.
- **`editorControl` API identical:** `plugin(editorControl)` receives the same `CodeMirrorControl`; `addExtension` (`StateEffect.appendConfig`), `registerCommand`, `execCommand`, `cm6`, `joplinExtensions`, `addStyles` are all in the shared `@joplin/editor` package — nothing platform-forks them. `context.postMessage` round-trips through `emitContentScriptMessage` on both platforms.

**What differs on mobile (all minor for us):**
- **Loading is always inline `sourceJs`** (script text read from disk and inlined), never the desktop `joplin-plugin://` `<script src>` served over a custom protocol. Practically this means the **content-script file is inlined into the editor WebView's JS** each load. Our CM6 content script is small (underline renderer + card + postMessage), so size is a non-issue *here* — the heavy WASM lives in the plugin main process, not the content script.
- CSS assets: only `text/css` inline/asset are accepted (`PluginLoader.ts:157-187`) — same as desktop; our per-kind underline CSS is fine.
- Legacy CM5 fields (`codeMirrorResources`, `codeMirrorOptions`) are ignored on mobile (`types.ts:910`) — we don't use them.
- The markdown editor itself is a **separate** WebView from the plugin-runner WebView; the two talk only via `postMessage`/`emitContentScriptMessage`. Same two-hop async model as desktop, so keep lint payloads JSON and debounced.

---

## 4. Bundle / size constraints

- **No size limit exists in code.** Grep for `maxSize`/`too large`/`sizeLimit`/`fileSize` across `packages/lib/services/plugins` and `packages/app-mobile/components/plugins` → **nothing**. No cap on `.jpl` or on `index.js`.
- **Delivery to the runtime:** the `.jpl` is a ZIP that Joplin **unpacks to disk** on first load — `PluginService.loadPluginFromPackage` extracts to `${cacheDir}/<name>/` via `shim.fsDriver()` (RNFS on mobile), producing `${unpackDir}/index.js` (`<J>/packages/lib/services/plugins/PluginService.ts:321-336`). At run time the WebView reads that `index.js` **from disk via XHR `file://`** (`PluginRunner.ts:53`, `startStopPlugin.ts:41-50`). **The 21 MB never crosses the React Native bridge** — good, that avoids the classic RN-bridge string-size cliff.
- **Would ~21 MB load? Likely yes, but with real cost.** The path is: 21 MB `index.js` on disk → XHR into a JS **string** (~21 MB) → injected as a `<script>` textNode → parsed/compiled by the WebView JS engine → inside it a ~20 MB base64 literal is `atob`-decoded to a ~11.8 MB `Uint8Array` → `WebAssembly.instantiate`. On a mid-range phone expect: **multi-second cold parse/compile of a 21 MB script, a transient memory spike holding (string 21 MB + parsed source + base64 20 MB + decoded 11.8 MB + WASM instance) simultaneously — easily 80–150 MB peak.** Android System WebView renderers are memory-limited and can be killed OOM; note Joplin already wires crash-reload handlers (`ExtendedWebView/index.tsx:92-100`, `onRenderProcessGone`/`onContentProcessDidTerminate`) precisely because plugin WebViews can be lost to OOM. This is the **top feasibility risk** and is exactly what the on-device spike (§2) must measure. Mitigations to consider: strip base64 to a raw-binary asset loaded another way (blocked — no `fs`, no `file://` fetch), or accept the inlined cost and lint lazily (instantiate WASM only after first edit, not at `onStart`).
- **Evidence from existing large mobile plugins:** the largest well-known mobile-enabled plugins (Rich Markdown, Kanban, function-plot, revealjs-integration — all in the mobile allowlist, §5/§6) are **hundreds of KB to low single-digit MB**, none WASM-heavy. I found **no precedent for a ~20 MB WASM plugin on Joplin mobile.** The closest external proof point is the Harper Firefox-Android extension (same engine, runs on Android), but that's Gecko, not System WebView, and not inlined-in-one-JS-file. So the size behavior is genuinely **unproven for our case** and must be spiked.

---

## 5. Plugin APIs on mobile — which of OUR touchpoints work vs. break

The plugin API object is the **shared** `Global` class, constructed identically on both platforms: `PluginService.ts:652` `new Global(this.platformImplementation_, plugin, this.store_)` then `runner_.run(plugin, pluginApi)` (`:654`), with mobile's `PlatformImplementation` at `<J>/packages/app-mobile/services/plugins/PlatformImplementation.ts`. So most `joplin.*` calls execute on the RN side via the messenger and behave the same. Per-touchpoint:

| Touchpoint | Mobile status | Evidence |
|---|---|---|
| `joplin.settings.registerSettings` / `value` / `setValue` / `onChange` | **Works** — DB-backed, platform-agnostic Global/JoplinSettings. Bool, String, Int, Array, Object, `isEnum`+`options` all fine. | Shared `JoplinSettings.ts`; Global wired at `PluginService.ts:652`. |
| Settings `subType: FilePath` / `DirectoryPath` (our `externalDictionaryPath` picker) | **BREAKS / unsupported** — explicitly "Not supported on mobile!" | `<J>/packages/lib/services/plugins/api/types.ts:504-505`. A plain `String` field still stores, but there's no native picker and, more importantly, no `fs` to read the path. |
| `joplin.plugins.dataDir()` | **Returns a real on-device path** (created via `shim.fsDriver().mkdir`, RNFS-backed) — `Plugin.createAndGetDataDir` at `<J>/packages/lib/services/plugins/Plugin.ts:100-108`. **BUT the plugin cannot read/write it** — the iframe has no `fs` and `file://` fetch is blocked. So `dataDir` is effectively **useless for our persistence on mobile.** | `Plugin.ts:100-108`; no-fs at `pluginRunnerBackgroundPage.ts:23-44`. |
| `joplin.data` (notes CRUD/search) | **Works** — runs on RN side via Global; not editor/fs dependent. | Shared `JoplinData.ts` via Global. |
| `joplin.commands.execute('editor.execCommand', …)` | **Works** (shared JoplinCommands/Global). **But we don't need it** — our plugin applies suggestions as CM transactions **inside the content script** via `editorControl` (which is `@joplin/editor`, §3), so this path is unaffected regardless. | Shared `JoplinCommands.ts`; suggestion apply per SPEC.md:24. |
| `joplin.require('fs-extra')` / `require('fs')` / `require('os')` (dictionary file read, add-to-dictionary append) | **BREAKS** — throws (or returns a no-op mock only for 3 legacy ids). | `pluginRunnerBackgroundPage.ts:13-44`. |
| `joplin.fs.archiveExtract` (`JoplinFs`) | Desktop-only, and irrelevant to us. | `<J>/packages/lib/services/plugins/api/JoplinFs.ts:12-16` (`platform-desktop`). |

**Net for our plugin:** the editor/underline/card/postMessage/settings/data touchpoints all port. **What breaks on mobile is the entire filesystem-dependent dictionary feature:** `externalDictionaryPath` (FilePath subtype + fs read), the ~60 s file poll, and the "add to dictionary appends to the external file" behavior. The **portable replacement** is to persist the custom-dictionary words and ignored-lint hashes in **`joplin.settings` (an `Object`/`Array` setting, DB-backed)** instead of a file — which then also syncs across devices via Joplin's own sync rather than the user's rclone/Nextcloud file. This is a settings-store swap, not an architecture change to the linter.

---

## 6. Install / dev loop, target version, and how Rich Markdown ships mobile

**Installing plugins on mobile — both paths exist:**
- **Marketplace/repo search:** `<J>/packages/app-mobile/components/screens/ConfigScreen/plugins/SearchPlugins.tsx` + `utils/useRepoApi.ts` + `buttons/InstallButton.tsx` (same plugin repository the desktop uses).
- **Install from file (`.jpl`):** `<J>/packages/app-mobile/components/screens/ConfigScreen/plugins/PluginUploadButton.tsx`.
- **Plugin support is off by default and must be enabled** by the user: `EnablePluginSupportPage.tsx:119` ("Enable plugin support" button), gated on `plugins.pluginSupportEnabled` (`PluginRunnerWebView.tsx:147, 214`). Still in **Beta** per the Joplin forum/changelog.

**Manifest requirement (mandatory change for us):** a plugin that does **not** declare `platforms` defaults to **`['desktop']` only**, unless its id is in a hard-coded allowlist. Our id `io.github.pmslava.harper` is **not** in that list, so mobile would refuse it with "This plugin doesn't support Joplin Mobile." We must add **`"platforms": ["desktop","mobile"]`** to the manifest. Evidence: default resolution `<J>/packages/lib/services/plugins/utils/isCompatible/getDefaultPlatforms.ts:7-45` (the `defaultSupportMobile` allowlist — note it **includes `plugin.calebjohn.rich-markdown`** but not us); compatibility gate `PluginService.ts:586-615` and `isCompatible/index.ts`; min-version resolution `isCompatible/minVersionForPlatform.ts:17-22`. `app_min_version_mobile` is parsed at `manifestFromObject.ts:60-62` and **falls back to `app_min_version` when omitted**.

**Which `app_min_version_mobile` to target:** mobile plugin support and CM6 content scripts landed with the **Joplin 3.0** mobile line (July 2024). The user's own **Cockpit plugin declares `app_min_version_mobile: 3.3`** — a sensible, field-proven floor for stable CM6 content scripts + plugin API. Recommend **`app_min_version_mobile: "3.3"`** (or higher after the on-device spike identifies the earliest build where the 21 MB WASM load is reliable). Keep desktop `app_min_version: 3.1` unchanged.

**Developer testing loop** (official doc: https://joplinapp.org/help/api/references/mobile_plugin_debugging/):
- **Fastest:** the **web build** supports "add a development plugin" (pick a folder with `publish/dist/src`) with **auto-reload on disk change** — but only in Chrome/Chromium. Mirrors mobile closely enough for API/CM6 work; **does not** prove native Android WASM/memory.
- **Native Android (emulator or device):** enable **Config > Plugins > Advanced > plugin WebView debugging**, restart, then attach **Chrome DevTools `chrome://inspect`** (standard Android WebView remote debugging). Console output also lands in Joplin's own logs (Config > Tools > Logs), filterable by plugin id; `console.log` shows only in dev mode. Dev plugins can also be loaded from a path on device via `plugins.devPluginPaths` (`PluginRunnerWebView.tsx:215`, `useOnDevPluginsUpdated`).
- Because our real risk is WASM size/memory on **native System WebView**, the loop must end on a **physical mid-range Android device**, not just the emulator/web.

**How Rich Markdown (`plugin.calebjohn.rich-markdown`) ships mobile support:** Its `manifest.json` (fetched from `CalebJohn/joplin-rich-markdown@master`) declares **`app_min_version: "3.5.9"`, version `0.17.1`, and NO `platforms` and NO `app_min_version_mobile` fields.** It runs on mobile **only because its id is hard-coded in Joplin core's `defaultSupportMobile` allowlist** (`getDefaultPlatforms.ts`) — a grandfather list for plugins that predate the `platforms` field. **We cannot rely on that mechanism** (new id, not in the list) — hence the explicit `platforms` declaration above. Rich Markdown is a pure-CM6, no-WASM, no-fs decoration plugin, so it needed **no platform-specific code** to work on mobile; reported mobile friction is UX-level ("control-less", editor-transition rough edges), not runtime-capability failures — i.e., it's *precedent that a CM6 decoration content script runs on mobile*, but **not** precedent for the WASM/size dimension that is unique to Harper.

---

## UNKNOWNS AND RISKS

- **WASM-runs-at-15.8 MB is inferred, not measured.** Source proves "no CSP blocks WASM" (high confidence) and Chromium/WebKit support WASM generally, but the specific behavior of the **Android System WebView build + renderer memory budget** with a ~21 MB inlined bundle decoding an ~11.8 MB module is **unproven**. Peak memory could OOM-kill the renderer (Joplin has crash-reload handlers precisely for this). **This is the make-or-break item** — settle with the §2 device spike before any build work.
- **21 MB single-file bundle cost** (multi-second parse + large transient memory) is estimated from the pipeline, not benchmarked. No precedent among existing mobile plugins (all ≪ that, none WASM-heavy). Lazy WASM init (on first edit, not `onStart`) may be needed.
- **No `fs`, no `file://` fetch** means the whole external-dictionary-file feature is dead on mobile; must be re-homed to `joplin.settings` (Object/Array, DB-backed). `dataDir()` returns a path but is unusable without an fs bridge — none exists in the plugin iframe.
- **`WorkerLinter` is out on mobile** (its worker import is Vite-only and won't webpack-bundle — same reason as desktop). `LocalLinter` runs WASM on the plugin *iframe's* main thread; that iframe is a hidden background page so it won't freeze the editor UI, but a slow lint will serialize against other plugin work in that iframe. Debounce + viewport-slice linting still apply.
- **Mobile plugin support is officially Beta**; APIs/versions can shift. `app_min_version_mobile: 3.3` is a reasonable floor (proven by Cockpit) but the real floor for reliable 21 MB WASM loading is unknown until the device spike.
- I did not exhaustively audit every `session`/`webRequest` layer or any Android-manifest-level WebView flag that could disable WASM in a hardened build; low risk given the extension precedent, but only the device experiment closes it.
- Rich Markdown's mobile enablement rides a core allowlist we can't use; our required `platforms:["desktop","mobile"]` change is confirmed necessary but its interaction with the plugin **repository's** publish/vetting for mobile (marketplace listing) wasn't examined here.

## BOTTOM LINE

**Feasible-with-changes** (for the runtime slice). The mobile plugin runtime is a CSP-free WebKit/Chromium WebView-plus-sandboxed-iframe that, unlike the desktop editor, **permits WebAssembly** — and the CM6 content-script layer (`@codemirror/lint`/`view`/`state`, `addExtension`, `postMessage`, the `PluginLoader`/`codeMirrorRequire` bridge) is **literally the same shared `@joplin/editor` code as desktop**, so the underline/card/messaging half of the plugin ports essentially unchanged. The mandatory changes are: declare `platforms:["desktop","mobile"]` + `app_min_version_mobile:"3.3"`; switch WASM loading to the **inlined-base64 (`harper.js/binaryInlined`)** path since there's no `fs`/`file://`-fetch; and **replace the entire filesystem dictionary feature** with `joplin.settings`-backed storage. The one genuine gating unknown is whether a ~21 MB inlined-WASM bundle instantiates and lints within Android System WebView's memory budget on a mid-range phone — provable only by the on-device spike in §2, which should be the first mobile task before committing to the port.