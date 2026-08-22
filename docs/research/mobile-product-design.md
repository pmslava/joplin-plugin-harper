I have enough evidence across all four questions. Writing the report.

---

# RESEARCH REPORT: Mobile product design for joplin-plugin-harper

Scope: dictionary-without-fs, touch UX, desktop/mobile packaging split, and a minimal-viable mobile v1. This is the "product design" slice; WASM-loader feasibility and harper.js mobile init are a sibling worker's slice — I touch them only where they gate scope.

Evidence base: shallow clone of `laurent22/joplin` branch `dev` (cloned 2026-08-22) under `<J>/`; `pmslava/joplin-plugin-cockpit` under `<CK>/`; `CalebJohn/joplin-rich-markdown` under `<RM>/`; the existing plugin at `/home/mrsir/Lab/joplin-plugin-harper/` (`<H>/`); plus the prior `docs/research/joplin-plugin-api.md`.

Foundational facts established up front (they decide everything else):

- **The mobile Markdown editor is the same CodeMirror 6 engine as desktop.** Mobile builds its editor from `createEditor` in `@joplin/editor/CodeMirror` (`<J>/packages/app-mobile/contentScripts/markdownEditorBundle/contentScript.ts:1`), and it loads `ContentScriptType.CodeMirrorPlugin` scripts by reading the file and wrapping them with start/end shims (`<J>/packages/app-mobile/contentScripts/markdownEditorBundle/utils/useCodeMirrorPlugins.ts:35-58`). The `postMessage` bridge is the same `emitContentScriptMessage` round-trip (`ibid:52-55`). So `<H>/src/contentScript.ts` — the decorations, the `showTooltip` card, the click handler — runs on mobile essentially unchanged.
- **The plugin "main process" on mobile is an iframe inside a React-Native WebView, not Node.** Plugins run in an iframe within a WebView (`<J>/packages/app-mobile/components/plugins/PluginRunnerWebView.tsx:154-190`; the background iframe messenger at `.../backgroundPage/initializePluginBackgroundIframe.ts:7-15`); corroborated by Joplin's own docs ("On mobile, all plugins run in iframes within a WebView", https://joplinapp.org/help/api/references/mobile_plugin_debugging/). No `require('fs')`, no `joplin.require('fs-extra')` (the whitelist bridge is desktop-only), no Node.
- **`joplin.plugins.dataDir()` DOES exist on mobile.** It resolves through `shim.fsDriver()` (`<J>/packages/lib/services/plugins/Plugin.ts:96-98`, `JoplinPlugins.ts:70-72`), which on mobile is backed by react-native-fs (app-sandbox storage). So the plugin has a private, persistent, writable directory on mobile — but it is **per-device and never synced**.

---

## 1. Dictionary without a filesystem

Today (desktop) the dictionary is a plain-text file the user syncs via rclone to Nextcloud, shared with harper-ls/Zed; the plugin reads it and `add-to-dictionary` appends to it (`<H>/docs/SPEC.md:29-36`). None of that exists on mobile.

### 1a. Plugin-local (settings or dataDir)

Both work on mobile and both trap words per-device:

- `joplin.settings` values are stored in the Joplin **profile database**, which is per-device and **not** part of note sync — so a word added on the phone never reaches the laptop. A large word list in a single `String`/`Array` setting is also awkward.
- `dataDir()` is writable on mobile (established above) but equally per-device and unsynced.

Verdict: fine as a **local cache / write buffer**, unacceptable as the **source of truth** — it silently fragments the dictionary across devices, the exact opposite of the desktop file's whole point (one list shared with Zed/harper-ls).

### 1b. A designated Joplin **note** as the dictionary — RECOMMENDED

Store the dictionary as the body of one ordinary note (one word per line), located by a stable marker. This rides Joplin's own end-to-end-encrypted sync to **every** device automatically — phone, laptop, and (via the desktop plugin's file bridge) Zed/harper-ls.

**Locating the note.** The data API is available on both platforms (`joplin.data.*`). Prefer a **plugin settings key holding the note id** (set once, on first run or via a "create dictionary note" command), with a **tag** (e.g. `harper-dictionary`) as the human-discoverable fallback. Resolving by title is brittle (titles change, collisions); resolving by a saved id is O(1) and unambiguous. Reading: `joplin.data.get(['notes', id], { fields: ['body','updated_time'] })`. Appending: read body, append a line, `joplin.data.put(['notes', id], null, { body })`.

**Data-API cost per change.** A single `get` of one note body + a single `put` — two SQLite-backed calls over the RN bridge. This is cheap **as long as it is event-driven, not polled**: read once on plugin start (feed via harper's `importWords()`), then only on an explicit `add-to-dictionary` tap, plus a lightweight refresh when `updated_time` changes (piggy-back on the note-change event / an existing periodic tick rather than a tight poll). Do **not** re-read the note per lint pass. For reference, Cockpit found per-refresh full search/get/body cycles over the RN bridge expensive enough to *double* its default mobile interval (`<CK>/src/core/timer.ts:30-35,184-189`) — the lesson is "don't put note I/O on a fast timer," which this design respects.

**Conflict risk.** Joplin has no field-level merge for note bodies. If the same dictionary note's body is edited on two devices between syncs, sync creates a **duplicate "conflict" note** preserving the local version and takes the remote as the winner (`<J>/packages/lib/services/synchronizer/utils/handleConflictAction.ts:44-79`, `Note.createConflictNote`; only genuine title/body divergence triggers it via `Note.mustHandleConflict`). For a dictionary this is low-severity (worst case: a couple of added words land in a conflict copy the user can merge back), but to minimize it: (1) keep writes append-only and small; (2) **sort/normalize deterministically** so independent additions on two devices produce the same canonical body and often collapse to no real conflict; (3) treat the note as a set (dedupe on read) so an accidental duplicate line is harmless. Add-to-dictionary is rare and interactive, so the collision window is tiny in practice.

**Desktop ↔ file topology (keep Zed/harper-ls in the loop).** Make the **note the single source of truth**, and have the *desktop* plugin do a bidirectional note↔file mirror so the existing rclone→Nextcloud→Zed pipeline still works:

- Mobile: reads/writes the note only. Simple, no fs.
- Desktop: on the note-changed event → write new words into the external file (dedupe); on file-poll (the existing ~60 s poll, SPEC:32) → append new file words into the note. Both directions dedupe against a canonical sorted set, so the mirror converges and doesn't ping-pong.
- Net: the note is authoritative and universal; the file becomes a *desktop-maintained projection* for the CLI tools. This is the least-surprising topology — mobile users get sync "for free," desktop users keep their Zed workflow, and there is exactly one conceptual owner (the note).

### 1c. Alternatives (brief)

- **Plugin-issued WebDAV to Nextcloud** (the plugin fetching the shared file directly): rejected. It duplicates credentials the user already gave Joplin, is a second sync system to reconcile, needs network permission and error handling, and leaks the user's Nextcloud into the plugin. The note approach reuses Joplin's own encrypted sync — strictly less surprising and less to secure.
- **Joplin resources (attachments):** a resource could hold the file, but resources are opaque blobs addressed by id, awkward to read/append as text and not user-editable in the note list. A note is strictly better ergonomically.

### Recommendation

**Ship the "dictionary note" (1b): note = source of truth, resolved by a saved note-id (+ `harper-dictionary` tag fallback), event-driven read/append, desktop mirrors note↔file for Zed/harper-ls.** It is the only option that keeps the dictionary unified across devices without a second sync channel, works identically on mobile and desktop, and degrades gracefully under conflict.

---

## 2. Touch UX

**Our card is already tap-native and, crucially, is not a native tooltip — it is a CM6 `showTooltip` StateField** driven by a `click` DOM handler (`<H>/src/contentScript.ts:19-24,67-83`; imports `showTooltip, Tooltip` from `@codemirror/view` at :29). Because it is a plain CM6 tooltip and the mobile editor is the same CM6, positioning uses the identical CM6 tooltip machinery on both platforms. That is the single biggest de-risking fact: no separate mobile popup code is needed for the card to appear.

Specific mobile concerns:

- **Position vs. the virtual keyboard.** This is the real risk. CM6 flips a tooltip above/below based on space *in the editor's scroll rect*, but it is not inherently aware of the Android soft-keyboard occluding the lower half of the WebView. A card anchored just below a lint near the bottom of the screen can render behind the keyboard. Joplin's own mobile UI mitigates comparable float placement with `window.visualViewport` (see the ProseMirror floating-button plugin: `viewportTop/Bottom = window.visualViewport.pageTop/height`, `<J>/packages/editor/ProseMirror/plugins/utils/createFloatingButtonPlugin.ts:101-108`). Our CM6 card doesn't get that for free. **Spike must verify on a real device**, and if occlusion happens, options are: prefer `above` placement (CM6 `Tooltip.above = true`), or clamp against `visualViewport.height` in a custom mount, or (heaviest) render the card as a Joplin plugin panel/dialog instead of a tooltip.
- **Tap-to-place-cursor vs. tap-to-open-card conflict.** This was contentious on desktop (SPEC/commit history: v1.0.2 dropped hover, click-only). On mobile it is *sharper*: every tap in the editor both places the cursor AND (if on an underline) should open the card. The current handler hit-tests diagnostic ranges at the click position (`<H>/src/contentScript.ts:68-72`). On mobile the same tap also triggers Joplin's `window.onclick → scrollAllowed` keyboard/scroll logic (`<J>/packages/app-mobile/contentScripts/markdownEditorBundle/useWebViewSetup.ts:83-102`), which may scroll the selection into view as the keyboard opens — potentially moving the anchor out from under a just-opened card. Net: the card can open, then the viewport shifts. Needs on-device validation; a small open-delay or re-anchor-on-resize may be required. Also weigh whether tapping a word to open the card *and* dropping the cursor there is desirable or annoying on a small screen — a deliberate double-tap or a long-press could disambiguate, at the cost of discoverability.
- **Tap-target size.** Our suggestion pills are ~28 px (brief). Both major mobile guidelines put the minimum comfortably above that — Material Design ~48×48 dp, Apple HIG ~44×44 pt. **28 px is too small for a primary action on touch.** Recommend ≥44–48 px min height and generous horizontal padding/spacing for pills, add-to-dictionary, and dismiss when on mobile (a platform-branched stylesheet — see §3). Cramped pills next to each other invite mis-taps that apply the wrong correction.
- **Editor viewport / zoom quirks.** The mobile editor lives in an `ExtendedWebView`; the app manages scroll-into-view on keyboard open with a 1 s window after tap (`useWebViewSetup.ts:88-101`). Cards should avoid fighting that (don't force-scroll). Font-size/zoom is user-controlled in mobile settings; use relative units in the card so it tracks the editor's font scale.

**Prior art:** Rich Markdown is a pure CM6 decoration plugin that runs on mobile with **no platform branching at all** — its only runtime OS check is a Mac-keyboard test (`<RM>/src/richMarkdown.ts:28`); it declares no `platforms`/mobile popups because it decorates rather than popping UI. That confirms decoration-only CM6 works cross-platform untouched, but gives us **no precedent for a tooltip/card on mobile** — so our card is the part that genuinely must be proven on-device. (No other bundled Joplin plugin was found doing a CM6 `showTooltip`-style interactive popup on mobile; treat this as unproven territory, not a solved problem.)

---

## 3. Packaging / the desktop-mobile split

**One plugin can serve both platforms with runtime branching — this is the intended model, and it is what Cockpit does.** Two manifest facts are decisive:

1. **You MUST explicitly opt into mobile.** When `platforms` is omitted, Joplin defaults it to `['desktop']` **unless the plugin id is in a hardcoded core allowlist** (`<J>/packages/lib/services/plugins/utils/isCompatible/getDefaultPlatforms.ts:6-40`). Rich Markdown works on mobile only because `plugin.calebjohn.rich-markdown` is *in that allowlist* (`ibid:31`). Our id `io.github.pmslava.harper` is **not** — so the manifest must set `"platforms": ["desktop","mobile"]` (exactly as Cockpit does, `<CK>/src/manifest.json:6-9`). Compatibility is then gated by `minVersionForPlatform` (`<J>/.../isCompatible/minVersionForPlatform.ts:6-22`) and `app_min_version_mobile` (which **defaults to `app_min_version`** if omitted — `<J>/packages/lib/services/plugins/utils/manifestFromObject.ts:61`; set it explicitly, Cockpit uses `"3.3"`).
2. **Runtime platform detection is a first-class API.** `joplin.versionInfo()` returns `{ platform: 'desktop'|'mobile', ... }` — populated `'desktop'` on desktop (`<J>/packages/app-desktop/services/plugins/PlatformImplementation.ts:33-40`) and `'mobile'` on mobile (`<J>/packages/app-mobile/services/plugins/PlatformImplementation.ts:30-37`). The type is `VersionInfo.platform: 'desktop'|'mobile'` (`<J>/packages/lib/services/plugins/api/types.ts:232-238`).

**Cockpit's pattern is the blueprint** (`<CK>/src/core/platform.ts`): a cached `getPlatform()`/`isMobile()` that reads `versionInfo().platform`, with a fallback for old desktop builds that predate the field ("does a real node module load?" via `requireNodeModule('fs-extra','readFile')`, lines 34-63). Cockpit then branches: desktop-only menus early-return on mobile (`<CK>/src/ui/menu/menu.ts:15`), CSS that used a plugin-dir file on desktop moves to a settings-stored string on mobile (`<CK>/src/ui/styler/styler.ts:3,11,34`), timers slow down on mobile (`timer.ts`). Same single `.jpl`, one codebase, runtime forks.

**A separate mobile build is NOT cleaner** and adds real cost: two `.jpl`s to release in lockstep, two registry listings, duplicated content-script code, and user confusion over which to install. The only argument for splitting is bundle size (the ~15.8 MB WASM), and that is better handled by *loading* the WASM differently per platform than by shipping two artifacts.

**What OUR branching looks like** (all keyed off one cached `isMobile()`):

- **Loader selection (the hard one, sibling worker's slice — flagged here for the split).** Desktop reads the `.wasm` off disk via `fs` and feeds a base64 `data:` URL (SPEC:16-17). That path is dead on mobile (no fs). Mobile must load harper.js's WASM inside the plugin *iframe* WebView — via the bundled/inlined binary module (`harper.js/binaryInlined`) or a WebView-served asset, and the iframe has **no CSP meta** (`PluginRunnerWebView.tsx:159-167`), so WASM instantiation is plausibly permitted (Android System WebView is modern Chromium; the Harper Firefox-Android extension proves the engine runs on Android hardware). *This is unverified and is the top spike item* — but it is a loader fork, not a reason to split the plugin.
- **Dictionary backend selection.** Desktop: external file + note-mirror. Mobile: dictionary-note only (§1). Both share the same in-memory "feed words to harper via `importWords()`" core; only the persistence backend forks.
- **Settings visibility.** The `externalDictionaryPath` setting uses `subType: DirectoryPath`/`FilePath`, which is explicitly **desktop-only / unsupported on mobile** (joplin-plugin-api.md §5; `types.ts` SettingItem docs). Hide/ignore it on mobile; expose a "dictionary note" command/setting instead. Desktop-only menu registrations must early-return on mobile (Cockpit precedent). Debounce/interval defaults may want to be gentler on mobile (Cockpit precedent).

---

## 4. Scope recommendation — minimal viable mobile v1

**Ships in mobile v1 (the core value: offline grammar/spell underlines + tap-to-fix on Android):**
- CM6 content script: per-kind underlines + the click-to-open `showTooltip` card (already portable), with **mobile-sized tap targets** (≥44–48 px pills, branched CSS).
- harper.js linting in the plugin iframe (WASM via inlined/bundled binary module) — **gated on the loader spike**.
- Dictionary as a **synced note** (read on start, append on add-to-dictionary), resolved by saved note-id + tag.
- Settings: enabled, dialect, debounce. `platforms:["desktop","mobile"]`, explicit `app_min_version_mobile` (candidate `3.3`, matching Cockpit's proven floor; confirm the CM6-plugin-on-mobile minimum empirically).
- Ignore-lint (persisted in `dataDir`/settings, per-device is acceptable for ignores).

**Stays desktop-only:**
- External **dictionary file** path + the note↔file mirror for Zed/harper-ls (fs-dependent). Mobile just uses the note.
- The `DirectoryPath`/`FilePath` picker setting (unsupported on mobile).
- Any menu/toolbar registrations that lack mobile equivalents (early-return via `isMobile()`).

**Spike plan — what must be proven on a real Android device, in order (each gates the next):**
1. **WASM in the plugin iframe.** Instantiate a trivial `WebAssembly.Module` in the mobile plugin background iframe, then actually init harper.js `LocalLinter` and lint a sentence. *If this fails, mobile v1 is infeasible and stops here.* (Highest risk, lowest sunk cost — do it first.)
2. **Lint round-trip latency & memory.** Measure init ms, lint ms on a ~2–5 KB note over the RN `postMessage` bridge, and peak memory (15.8 MB WASM on low-RAM phones is a real risk — watch for WebView OOM/reload).
3. **Card rendering & keyboard occlusion.** Confirm the `showTooltip` card appears on tap, is not hidden behind the soft keyboard near the bottom of the screen (test `above` placement / `visualViewport` clamp), and that tap-to-place-cursor + the app's scroll-on-resize don't yank the anchor away.
4. **Tap ergonomics.** Validate ≥44 px pills are comfortable, that applying a suggestion fires exactly one re-lint, and add-to-dictionary works.
5. **Dictionary-note sync loop.** Add a word on the phone, sync, confirm it appears on desktop (and, with the mirror, in the file); force a two-device edit to observe conflict behavior is benign.

Order rationale: (1) is a hard yes/no on the whole endeavor; (2) decides whether it's *usable* not just *possible*; (3)-(4) are UX polish that only matter if (1)-(2) pass; (5) is independent of the editor and can proceed in parallel once (1) passes.

---

## UNKNOWNS AND RISKS

- **WASM-in-mobile-iframe is unverified** (sibling worker's slice, but it gates my scope). Evidence is encouraging — no CSP meta on the plugin WebView (`PluginRunnerWebView.tsx:159-167`), Harper's engine demonstrably runs on Firefox Android, community interest in WASM plugins exists (https://discourse.joplinapp.org/t/plugin-with-webassembly-module/20748) — but not proven inside Joplin's Android WebView. Top spike item.
- **15.8 MB WASM on low-RAM Android** may cause WebView OOM/reload; not measured. React Native WebView can also re-run injected JS without reload (`PluginRunnerWebView.tsx:170-179`) — init must be idempotent.
- **Keyboard occlusion of the CM6 card** is unproven; CM6 tooltips aren't inherently `visualViewport`-aware. May need custom anchoring.
- **Tap-to-cursor vs. tap-to-card interaction** with Joplin's scroll-on-resize (`useWebViewSetup.ts:83-102`) is untested; the card may open then get scrolled off-anchor.
- **Note-body sync conflicts** are low-severity but real (`handleConflictAction.ts:44-79`); the canonicalize-and-dedupe mitigation is a design assumption, not yet validated on two live devices.
- **`app_min_version_mobile` exact floor** for interactive CM6 tooltip content scripts is unconfirmed; `3.3` is Cockpit's proven value but Cockpit uses panels, not editor tooltips. Confirm empirically.
- **Data-API cost of note read/append on mobile** is inferred cheap-if-event-driven from Cockpit's timer experience, not directly benchmarked for this workload.
- No existing bundled plugin demonstrates a **CM6 `showTooltip` interactive card on mobile** — this specific UX is unproven territory.

## BOTTOM LINE

**Feasible-with-changes** for my slice (dictionary, touch UX, packaging). The packaging split is a solved, low-risk problem: one plugin, `platforms:["desktop","mobile"]` + explicit `app_min_version_mobile`, runtime `isMobile()` branching exactly as Cockpit already does in production — no separate build. The dictionary problem has a clean, least-surprising answer: a synced **dictionary note** as source of truth with a desktop-side note↔file mirror keeping Zed/harper-ls in the loop, all on Joplin's own encrypted sync with no second sync channel. The touch UX inherits a card that is already tap-native and built on the same CM6 engine mobile uses, so it should render with little change — but the two genuinely unproven UX risks (soft-keyboard occlusion of the card, and tap-to-cursor/tap-to-card interplay) plus undersized 28 px pills mean UX needs on-device tuning, not redesign. The whole mobile effort is ultimately gated by one external unknown outside my slice — whether harper's 15.8 MB WASM instantiates and performs acceptably in the mobile plugin iframe — which the spike plan front-loads as step 1.

Key file references: `/home/mrsir/Lab/joplin-plugin-harper/src/contentScript.ts` (the portable card), `/home/mrsir/Lab/joplin-plugin-harper/src/manifest.json` (needs `platforms`+`app_min_version_mobile`), and the Cockpit blueprint at `.../research-cockpit/joplin-plugin-cockpit/src/core/platform.ts`.

Sources: [Joplin mobile plugin debugging](https://joplinapp.org/help/api/references/mobile_plugin_debugging/), [Mobile: Plugin support](https://discourse.joplinapp.org/t/mobile-plugin-support/35262), [Plugin with WebAssembly module](https://discourse.joplinapp.org/t/plugin-with-webassembly-module/20748).