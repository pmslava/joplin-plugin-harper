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
the editor.** Chain (file:line in Joplin dev @ 94911a8, see v0.0.4 report):
`NOTE_UPDATE_ONE` → BaseApplication middleware schedules a **1 s partial sync**
(`BaseApplication.ts:491-493`, `registry.ts:72-78`) → sync `UpdateLocal`s the *open* note
("remote is more recent than local", `Synchronizer.ts:1018-1027`) → sole dispatcher of
`EDITOR_NOTE_NEEDS_RELOAD` (`Synchronizer.ts:1115-1121`) → `Note.tsx:709-721`
`Keyboard.dismiss()` + refreshKey rotation → editor WebView remount.

Empirical proof (v0.0.4 silent probe): 45 s of zero writes = perfectly stable editor;
the single flush write at t=45 s evicted the editor within seconds — in both sessions;
flush #2 (t=90 s) never arrived. v0.0.1–v0.0.3 died instantly only because they wrote
their own arrival messages on every editor open.

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

## Not blockers, for the record

- No CSP anywhere in the mobile plugin path (WASM allowed — opposite of desktop's editor).
- No app crashes, no renderer OOM, no memory wall on this device; the earlier
  shared-renderer/OOM theory was refuted by the v0.0.3/v0.0.4 evidence.
- `platforms:["desktop","mobile"]` + `app_min_version_mobile:"3.3"` required in the manifest.
