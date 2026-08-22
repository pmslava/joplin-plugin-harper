I have all the evidence. Writing the report.

---

# RESEARCH REPORT: Running harper.js WASM without Node — loading strategies & mobile-class performance

**Slice:** Getting harper.js's WASM engine running in a Node-less WebView (Joplin mobile plugin background), and whether it performs on Android-class hardware.

**Primary sources:** installed package `node_modules/harper.js` v2.7.0 (abbrev `<H>/dist/`); Harper monorepo shallow clone at HEAD (harper.js `2.8.0`) under `.../research-harper/harper/` (abbrev `<M>/`); GitHub/web (URLs inline). Code line numbers from the installed 2.7.0 dist.

---

## 1. No-fs loading paths in harper.js 2.7.0

The entire WASM load funnels through one function, `getInitInput`, and it is the single place Node is (optionally) used:

```
<H>/dist/BinaryModule-Aj1vLnwf.js:3029-3045
function getInitInput(binary) {
  if (typeof process !== "undefined" && binary.startsWith("file://")) {
    return import("fs").then(fs => ...fs.readFile(new URL(binary).pathname...));
  }
  return binary;  // <-- everything else: pass the URL/string straight through
}
```

The fs branch is taken **only when BOTH `process` is defined AND the URL is `file://`**. In a mobile WebView there is no Node, so `typeof process === "undefined"` → the fs branch is never reached even for a `file://` URL. `getInitInput` returns the URL/string unchanged, which flows to `__wbg_init$1` → `if (string | URL | Request) module_or_path = fetch(module_or_path)` (`<H>/…:1428-1429`) → `__wbg_load$1`, which uses `WebAssembly.instantiateStreaming(Response)` or falls back to `Response.arrayBuffer()` + `WebAssembly.instantiate(bytes)` (`<H>/…:1365-1384`). **The load is 100% `fetch`/`Response`/`WebAssembly.instantiate` — standard WebView APIs, zero Node.**

**(a) `import { slimBinaryInlined } from 'harper.js/slimBinaryInlined'` (and `binaryInlined`).** Confirmed no-Node. `slimBinaryInlined.js` is three lines: it builds `const slimBinaryInlinedUrl = "data:application/wasm;base64,AGFzbQ…"` and calls `BinaryModuleImpl.create(url, "slim")` (read directly; `binaryInlined.js` is identical with a full-binary data URL). At setup the data URL goes through `getInitInput` → returns the string → `fetch("data:application/wasm;base64,…")` → `instantiate`. `fetch()` of a `data:` URL is supported in all Chromium/WebKit WebViews; no `atob` is even called by harper (the browser decodes the data URL). **This needs only `fetch` + `WebAssembly` — exactly what a WebView provides.** This is the config the mobile-proven Obsidian plugin uses (see §3).

**(b) `createBinaryModuleFromUrl(url)` with a non-`file:` URL.** `createBinaryModuleFromUrl` → `BinaryModuleImpl.create` (`<H>/…:3068-3086`); the URL is stored and later `fetch`ed. Any scheme the WebView's `fetch` accepts works:
- **`data:`** — works (the inlined path above; also what the WorkerLinter fallback uses for its worker, §3).
- **`blob:`** — works; `fetch(URL.createObjectURL(new Blob([wasmBytes], {type:'application/wasm'})))` is a valid Response. Useful if you hold the bytes in memory.
- **`http(s)://`** served by the app — works if such an origin exists and CSP `connect-src` permits it. `instantiateStreaming` even warns-and-falls-back if the server MIME isn't `application/wasm` (`<H>/…:1372-1373`), so a wrong content-type is non-fatal.
- **`chrome-extension://`-style privileged asset URLs** — this is what the Harper browser extension uses (`chrome.runtime.getURL('./wasm/harper_wasm_bg.wasm')`, `<M>/packages/chrome-plugin/src/background/index.ts:726`). Joplin mobile has no documented equivalent per-plugin asset URL for the background — an unknown handed to the WebView-environment researcher.

**(c) Passing raw bytes/ArrayBuffer directly.** No first-class public API takes an `ArrayBuffer` — `create()` only accepts `string | URL` (`binary.d.ts`). The internal glue's `initSync({module})` accepts a `WebAssembly.Module`/bytes (`<H>/…:1400-1413`), but it's not exposed through `BinaryModuleImpl`. **The practical "raw bytes" path is `blob:` or `data:`**: wrap your `Uint8Array` in a Blob and pass its object-URL, or base64 it into a data URL. Both are fetch-decoded, no Node.

**Mapping to the mobile plugin background (a WebView, per the sibling researchers):** the WebView provides `fetch`, `Blob`, `URL.createObjectURL`, `WebAssembly.*`. Therefore paths (a) inlined `data:` and (c) `blob:` are fully self-contained and need nothing from the host beyond the WebView itself. Path (b) `http(s)`/asset-URL depends on Joplin mobile actually serving plugin assets at a fetchable URL — unverified in my slice.

---

## 2. Bundle mechanics: inlined-base64 vs separate `.wasm` file

Sizes (measured, `<H>/dist/`): slim binary `harper_wasm_slim_bg.wasm` = **15,634,488 B**; full `harper_wasm_bg.wasm` = **15,848,134 B** (the "slim" binary is only ~1.3% smaller — "slim" is a glue-flavor distinction, not a meaningful size cut). Base64 inflates ~1.33×: `slimBinaryInlined.js` = **20,846,244 B**, `binaryInlined.js` = **21,131,086 B**.

**Option A — inline base64 into the bundle** (`import … from 'harper.js/slimBinaryInlined'`): the plugin `main.js` becomes ~21 MB. Load = `fetch(data:)` inside the WebView, **no external asset fetch, no URL scheme assumptions, no CSP `connect-src` question.** This is the most portable and the one with an existence proof on mobile.

**Option B — ship `.wasm` in the `.jpl`, fetch at runtime** (current desktop webpack behavior): smaller JS (~150 KB) + a 15.6 MB sibling `.wasm`. Requires (1) Joplin mobile to serve that asset at a `fetch`-able URL and (2) the WebView CSP to allow it. Both unknown for the mobile background → strictly riskier than A.

**Loading-flavor gotcha that affects bundling:** when a **full-flavor file URL** is loaded (`glueFlavor:"full"` and the URL literally contains `harper_wasm_bg.wasm`), `getDefaultGlueBinary` rewrites the path to the slim sibling and attempts to init the slim binary *too* before the full one (`<H>/…:3020-3058`) — i.e. it tries to fetch **both** files. The data-URL inlined variants and the slim flavor avoid this (the data URL doesn't contain the literal `harper_wasm_bg.wasm`, so `getDefaultGlueBinary` returns null → single binary). Another reason to prefer `slimBinaryInlined` on mobile: guaranteed single-binary instantiation.

**What the browser extension teaches** (`<M>/packages/chrome-plugin/`, the one that runs on Firefox Android): it does **not** inline. It ships the `.wasm` in the extension package and loads it with `createBinaryModuleFromUrl(chrome.runtime.getURL('./wasm/harper_wasm_bg.wasm'))` inside a **`LocalLinter`** in the background script (`background/index.ts:720-727`). Lesson: on constrained Android the WASM engine runs fine, and a separate-file fetch works **when the runtime gives you a privileged asset-URL scheme** (`chrome-extension://`). Because Joplin plugins may lack such a scheme in the mobile background, the extension's separate-file approach is the *desirable* model but its enabling primitive (a stable asset URL) is exactly the unknown — so inlining (Obsidian's choice) is the safer default for us.

---

## 3. WorkerLinter vs LocalLinter in a WebView — and the Obsidian mobile existence proof

**How WorkerLinter builds its worker** (`<H>/dist/index.js:322-346`): the entire wasm-bindgen glue is inlined as a JS string `jsContent`; the worker is created from `URL.createObjectURL(new Blob([jsContent], {type:'text/javascript'}))` as a **`type:"module"` worker**, with a fallback to `new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent), {type:"module"})` (`index.js:329,338-343`). It is **self-contained** — no separate worker file, no `new Worker(new URL(...))`, no dynamic `import()` (grep of `jsContent`: `import( → 0`, `require( → 0`; its own copy of `getInitInput` is present but the fs branch is dead when `process` is undefined). So WorkerLinter **bundles cleanly under webpack** (this contradicts the SPEC's older worry about "Vite-only worker syntax" — that concern does not apply to 2.7.0's inlined-blob worker). Its requirements in a WebView: `Worker`, `Blob`, `URL.createObjectURL`, and **module-worker support** (Chromium ≥80 / Android System WebView; WebKit ≥15). The blob-worker may be gated by CSP `worker-src`/`child-src` — a WebView-environment question outside my slice; the `data:` fallback exists but `worker-src` typically must allow `blob:`/`data:`.

**LocalLinter** (`index.js:30-52`) instantiates the WASM on the calling event loop and lints synchronously-ish (`await inner.lint(...)`). It needs nothing beyond `fetch`+`WebAssembly` — the smallest dependency surface. Main-thread blocking: **acceptable here** because the plugin background is *not* the editor UI thread on mobile (the CM6 content script that paints underlines runs in the editor; the linter host is a separate WebView that talks to it via `postMessage`). The browser extension confirms this pattern — it runs `LocalLinter` in its **background** context on Android and accepts the blocking (`background/index.ts:726`).

**Obsidian = direct existence proof.** `<M>/packages/obsidian-plugin/src/State.ts:50` defaults to `new WorkerLinter({ binary: slimBinaryInlined })`, with a `useWebWorker:false` path to `new LocalLinter({ binary: slimBinaryInlined })` (`State.ts:83-86`); binary imported as `slimBinaryInlined` (`State.ts:4`), and the Vite build sets `inlineDynamicImports: true` (`packages/obsidian-plugin/vite.config.ts:19`) → single inlined `main.js`. Crucially the **published manifest declares `"isDesktopOnly": false`, `minAppVersion:"1.7.7"`, version `2.8.0`** (raw manifest, github.com/Automattic/harper-obsidian-plugin/manifest.json). Obsidian mobile is a Capacitor WebView app with no Node — so a `false` desktop-only flag means Obsidian ships this exact WASM-in-WebView config to Android/iOS. Plugin has ~109k downloads (obsidianstats.com/plugins/harper). **This is the strongest evidence our architecture is viable: same engine, same `slimBinaryInlined`, same WorkerLinter/LocalLinter, running in a mobile WebView.** Caveat: mobile-specific bug reports exist (§4) — it *loads and runs*, but resource pressure is real.

**Recommendation for our mobile background:** default to **LocalLinter + `slimBinaryInlined`** (smallest primitive surface, no `worker-src` CSP dependency, blocking is fine off the UI thread), and treat WorkerLinter as an optimization to try only if the mobile WebView proves to allow blob/data module workers.

---

## 4. Performance & memory on Android-class hardware

No official phone benchmarks are published; harper.js docs only claim it's "noticeably faster than alternatives … no network latency" (writewithharper.com/docs/integrations/obsidian). What the issue tracker shows (Automattic/harper):

- **Init cost is real:** "Obsidian plugin delays app startup by 2,500 ms" (#2601) — WASM compile+instantiate+dictionary load is a multi-second one-time cost even on desktop; expect worse on a phone CPU.
- **Large-doc latency:** the worker "takes over 30 seconds to process large files (over 1k lines)" and #1142 "Terrible performance problem … on a large md file" — full-document lint does not scale; **debouncing + viewport/paragraph-scoped linting is mandatory on mobile.** Related: #3258 flags the default `delay:-1` (no debounce) as a perf problem.
- **Memory is the headline risk.** #3354 (desktop, Windows, Obsidian 1.12.7): baseline ~335–340 MB → **~840 MB with Harper enabled**, ~1 GB with other plugins, and memory not released after disable until restart (reporter suspects a leak). That's a **~500 MB delta** for the instantiated engine + FST dictionary, well beyond the 15.6 MB binary itself (the binary decompresses/expands in memory, plus the dictionary FST and working buffers).
- **Mobile reports:** #2730 "Reporting a bug on Android … Obsidian kept crashing … disabling Harper fixed it" (closed, no root-cause posted); #2847 "Issue on mobile … installing Harper would make Obsidian stop … can't enable." Both are consistent with **OOM/instantiation pressure on a constrained WebView**, though neither has a maintainer diagnosis.

**Against a 250–500 MB WebView budget:** the desktop steady-state (~500 MB delta) **would not comfortably fit** the low end and is marginal at the high end. Two mitigating unknowns: (1) #3354 may be partly a leak that 2.8.0's "avoid memory leak in JS products" + "remove redundant copy of dictionary in `FstDictionary`" fixes address, lowering steady-state; (2) desktop Electron may retain more than a lean mobile WebView. But as it stands, **memory is the single biggest feasibility risk for our slice**, not the loading mechanism.

---

## 5. Does harper.js 2.8+ change the mobile story?

- **npm registry (queried during this research): latest published `harper.js` = `2.7.0`** (`npm view harper.js version` → 2.7.0; versions end …2.4.0, 2.7.0). **However** the monorepo dev HEAD has `harper.js` at **`2.8.0`** and the Obsidian plugin already ships a `2.8.0`-labeled build — so 2.8.0 exists in-repo/released on GitHub but **may not yet be on the npm tag this machine sees** (possibly a stale mirror or an unpublished-to-npm state; the verifier should re-check `npm view harper.js versions` against network).
- **2.8.0's mobile-relevant deltas** (from the releases page and monorepo history): "fix: avoid memory leak in JS products"; "fix(core): remove redundant copy of dictionary in `FstDictionary`"; "feat(bench): add WASM benchmark harness and native allocation profiler." These are **exactly the memory levers that matter for mobile** (§4) — they target the ~500 MB footprint, not the load path. No evidence yet of a dramatically smaller binary, lazy/curated dictionary splitting, or a new no-fs loading API in 2.8.0 (loading mechanics are unchanged: same `getInitInput`/`slimBinaryInlined`).
- **Verdict on upgrading:** the *loading* story is identical in 2.7.0 and 2.8.0, so upgrading is not required to get WASM running Node-free. But because **memory is our gating risk**, the 2.8.0 leak/dictionary fixes are worth adopting for mobile **if** 2.8.0 is actually installable from npm; pin only after confirming the published version and re-running the memory picture.

---

## UNKNOWNS AND RISKS

- **Memory footprint vs a 250–500 MB WebView budget is the top risk.** The only hard number is desktop (~+500 MB, #3354) and it's possibly inflated by a leak that 2.8.0 targets. No measured mobile steady-state figure exists. Needs on-device measurement before committing.
- **Whether the Joplin mobile plugin background WebView allows `blob:`/`data:` module workers** (for WorkerLinter) and **whether it can `fetch` a plugin asset URL** (for the separate-`.wasm` option) — both are WebView-environment/CSP questions owned by the sibling researcher. LocalLinter + `slimBinaryInlined` sidesteps both.
- **npm vs GitHub version mismatch:** this machine's npm shows 2.7.0 as latest while GitHub/Obsidian show 2.8.0 released. Confirm the actually-installable published version before pinning 2.8.0.
- **Obsidian mobile reports (#2730, #2847) are unresolved/undiagnosed** — they prove Harper *targets* mobile (`isDesktopOnly:false`) and often works, but also that crashes happen on some Android devices; root cause (OOM vs sync vs enable-flow) is not maintainer-confirmed.
- **Full-flavor double-binary load** (`getDefaultGlueBinary`, ~31 MB) is a footgun if a full file URL is used; not a risk with `slimBinaryInlined`.
- **iOS not investigated** (brief is Android-primary); Obsidian's `isDesktopOnly:false` covers iOS too but with WebKit's stricter WASM/worker behavior — separate verification needed.

## BOTTOM LINE

**Feasible-with-changes** for my slice (getting the WASM engine running Node-free and performing on a phone). The loading problem is *solved and low-risk*: harper.js loads its WASM entirely via `fetch`/`WebAssembly.instantiate` with no Node, and the `import { slimBinaryInlined } from 'harper.js/slimBinaryInlined'` path bundles a self-contained ~21 MB `main.js` that needs nothing from the host beyond a standard WebView — the exact configuration the Harper **Obsidian** plugin ships to mobile today (`isDesktopOnly:false`), which is a direct existence proof, reinforced by the Harper **browser extension** running the same engine on Firefox Android. The required *change* from our current desktop build is to stop reading the `.wasm` off disk via `fs`/`file://` and instead inline it (`slimBinaryInlined`) with a `LocalLinter` in the background WebView (WorkerLinter only if the WebView permits blob/data module workers). The genuine risk is **not** loading but **memory**: the instantiated engine + dictionary costs on the order of hundreds of MB (desktop ~+500 MB), which is tight-to-over a 250–500 MB WebView budget — this must be measured on-device, and harper.js 2.8.0's memory-leak/dictionary fixes should be adopted (once its true published version is confirmed) to improve the odds.