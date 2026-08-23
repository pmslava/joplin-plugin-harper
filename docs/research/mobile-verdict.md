# Mobile feasibility verdict — PROVEN FEASIBLE, with one platform rule

Investigation 2026-08-22/23, spikes v0.0.1–v0.0.4 on the user's real device
(Android 10, Chrome 152 System WebView, Joplin mobile 3.7.2, ~15 other plugins installed).
Full trails in the "Harper Mobile Spike Results" note; spike source in `mobile-spike/`;
background in the other `mobile-*.md` docs in this directory.

## Proven on device

- **Engine**: harper.js 2.7.0 WASM (`slimBinaryInlined`, LocalLinter, no Node) runs in the
  mobile plugin background iframe. Init **1.44–1.65 s**, lint median **34–40 ms** on a 5 KB
  error-dense doc (desktop-equivalent), memory ~125–133 MB stable, 21 MB bundle loads fine.
- **Editor integration**: the CM6 content-script stack works unchanged — provided
  `@codemirror/lint|view|state`, `addExtension`, linter() plumbing, decorations + markClass,
  injected squiggle CSS, and the mousedown+showTooltip tap card all ran green for 45 s
  sessions (twice), with the squiggle visible and the card opening on tap.

## The one platform rule (the entire "bug", fully diagnosed)

**A plugin background `joplin.data.put` note-write while the mobile editor is open evicts
the editor — via a LOCAL mechanism, sync-independent.** Empirical law, fully characterized
on device (v0.0.4 silent probe + user controls):
- 45 s of zero writes = perfectly stable editor; the single flush write at t=45 s evicted
  the editor within seconds — both sessions; flush #2 (t=90 s) never arrived.
  v0.0.1–v0.0.3 died instantly only because they wrote their own arrival messages on
  every editor open.
- User controls: own typing + routine sync during editing → no eviction (5 min stable);
  remote changes to OTHER notes syncing in mid-edit → no eviction; **airplane mode
  (sync attempts fail, nothing downloadable) → eviction identical.**
The earlier sync-mediated explanation (diagnosed against the `dev` branch) was refuted by
the airplane-mode control. The TRUE path, identified in the 3.7.2 source the device runs
(tag android-v3.7.2 @ a0bed69a7) and consistent with every observation: the data-API note
PUT route dispatches `EDITOR_NOTE_NEEDS_RELOAD` **unconditionally** after `Note.save`
(`packages/lib/services/rest/routes/notes.ts:553`), with no note id — so the reducer
(`reducer.ts:1596`) bumps the reload for whatever note is OPEN, even when the plugin wrote
a different note → `Note.tsx:705-711` → refreshKey remount. User edits and sync do not
pass through that route, which is why only plugin writes evict.

**Settings are SAFE — device-proven (v0.0.5, outcome A):** two `joplin.settings.setValue`
writes at t=45 s and t=90 s during active editing caused nothing; the deliberate
`data.put` at t=135 s evicted on schedule in the same session. Source agrees:
`Setting.setValue` dispatches only `SETTING_UPDATE_ONE`, which no Note-screen prop watches.

## Port design consequences

1. **Never write notes while an editor is open on mobile.** Buffer dictionary/ignore
   mutations; flush on editor blur/close. `joplin.settings` writes bypass the
   `NOTE_UPDATE_ONE`→scheduleSync path and are safe at any time.
2. Dictionary-note design (see mobile-product-design.md): the add-to-dictionary write is
   the worst case (happens mid-edit) — defer it. Ignore/disable state → settings.
3. Guard content-script activation for idempotency: v0.0.4 showed doubled
   squiggle/card from double script activation in one editor (known Joplin mobile
   double-mount behavior, cf. joplin#12891).
4. This is arguably an upstream Joplin issue ("background plugin note-write evicts the
   mobile editor via sync") — `mobile-spike/` is a minimal repro if we file it.

## Cold start (v1.1.1 + v0.0.6 probe, 2026-08-23)

- v1.1.1 defers all startup I/O out of onStart (handler ~1 ms; budget-tested) and warms the
  engine in the background at launch — user-assessed "a little faster... can use with this
  speed" on device.
- The remaining fixed cost is parsing the ~21 MB inlined-WASM bundle at app start. The
  v0.0.6 device probe CLOSED the separate-.wasm alternative on Android: from the plugin
  iframe, `XHR file://` fails (status=0, onerror) and `fetch file://` fails — the
  null-origin sandbox cannot read installationDir files (desktop can: both return 200).
  `indexedDB` exists by typeof but compiled-Module caching is not a viable path in modern
  Chromium. Verdict: the inlined bundle is the Android floor unless Joplin core ever
  exposes plugin assets over a fetchable scheme.

## Not blockers, for the record

- No CSP anywhere in the mobile plugin path (WASM allowed — opposite of desktop's editor).
- No app crashes, no renderer OOM, no memory wall on this device; the earlier
  shared-renderer/OOM theory was refuted by the v0.0.3/v0.0.4 evidence.
- `platforms:["desktop","mobile"]` + `app_min_version_mobile:"3.3"` required in the manifest.
