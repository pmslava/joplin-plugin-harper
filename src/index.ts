import joplin from 'api';
import {
	ContentScriptType,
	MenuItemLocation,
	SettingItemType,
	SettingStorage,
	ToolbarButtonLocation,
} from 'api/types';
import {
	LocalLinter,
	Dialect,
	Lint,
	LintConfig,
	LintOptions,
	SuggestionKind,
} from 'harper.js';
// UNIFIED WASM LOADER (v1.1.0): both desktop and mobile now use the SAME inlined-binary path. The WASM
// is base64-embedded in this bundle (harper.js/slimBinaryInlined ships a `data:application/wasm;base64,`
// module), so there is NO filesystem read and NO separate dist .wasm to ship. This replaces desktop's
// old fs-read + createBinaryModuleFromUrl(data:) loader — it is the identical runtime path minus the fs
// read, which is exactly why it works unchanged inside the mobile plugin iframe (no Node there). The
// .jpl grows to ~21 MB. Device-proven in mobile-spike/ (init ~1.5 s, lint ~37 ms). See L1/L2 + verdict.
import { slimBinaryInlined } from 'harper.js/slimBinaryInlined';
import { resolvePlatform, isMobile } from './platform';
import { mergeDictionary } from './dictionaryMerge';
import {
	DismissedStore,
	appendDismissedInTransaction,
	buildIgnoredLintsPayload,
	extractHashes,
	makeEntryId,
	withDismissalTransaction,
} from './dismissedLog';
import { SettingsService, createSettingsService, parseRuleOverridesJson } from './settingsService';

const CONTENT_SCRIPT_ID = 'harperCm';
const SECTION = 'harper';
/**
 * THE SURFACE SWITCH (v1.4.0). Which of the two editing surfaces owns the BASIC settings.
 *
 * The plugin has two of them — Joplin's native Options → Harper page, and the custom "Harper:
 * Settings…" window — and showing the same eight fields twice is the confusing part, not a feature.
 * This one Bool decides which is live:
 *
 *   ON  (default): the basic settings register `public:false`, so the native page shows only this
 *                  switch; the Harper window owns them, and its entry point is created (the Tools
 *                  menu item on desktop, the note-toolbar button on mobile).
 *   OFF:           the basic settings register `public:true` exactly as before, and NO entry point
 *                  is created on either platform.
 *
 * `public:false` is a PURE VISIBILITY change — the values persist, every internal read still works,
 * and the dialog keeps editing them — so nothing below this line in the file has to know about it.
 * The COMMAND stays registered in both modes; only the entry point moves. See
 * registerSettingsDialogCommand for what that costs on each platform.
 */
const MANAGE_IN_DIALOG_KEY = 'manageInDialog';
/**
 * The switch's value AS OF STARTUP. Deliberately NOT part of `cfg` and never re-read: registration
 * is a startup-time act with no Joplin API to undo it, so a flip mid-session cannot move a field or
 * a menu item either way. The setting's own description says "Restart Joplin to apply", and the
 * onChange handler skips this key rather than pretending otherwise with a reconfigure that changes
 * nothing. Defaults to true so a read that never happened still means "the Harper window owns them".
 */
let manageInDialog = true;
const DICTIONARY_NOTE_TITLE = 'Harper Dictionary';
// Canonical dictionary-note header. Lines starting with '# ' (hash + space) are comments and are
// skipped on parse; every other non-blank line is one word. Written verbatim as the first body line.
const DICTIONARY_NOTE_HEADER =
	'# Harper Dictionary — one word per line. Lines starting with "# " are comments. ' +
	'Managed by the Harper Joplin plugin; edits here sync to every device.';

/**
 * The plain-JSON shape sent back to the content script. WASM `Lint`/`Suggestion`
 * handles are NOT serializable across the plugin<->editor IPC boundary, so we flatten
 * them to plain objects here. Spans are already UTF-16 code-unit indices, so `start`/`end`
 * map straight onto CodeMirror `from`/`to`.
 */
export interface PlainSuggestion {
	kind: 'Replace' | 'Remove' | 'InsertAfter';
	replacementText: string;
}
export interface PlainLint {
	start: number;
	end: number;
	kind: string;
	/** Human-friendly kind label for the card title, e.g. "Spelling" (lint_kind_pretty()). */
	kindPretty: string;
	/** The harper rule name (organizedLints key) that produced this finding. */
	ruleName: string;
	message: string;
	/**
	 * Harper's markdown-rendered message (message_html()), e.g. `Did you mean to spell
	 * <code>CLAUDE</code> this way?`. Crosses postMessage as a plain-JSON string; the content
	 * script sanitizes it to an allowlist before innerHTML. This is what draws the word "chip".
	 */
	messageHtml: string;
	problemText: string;
	suggestions: PlainSuggestion[];
}

// ---- messages from the content script --------------------------------------
interface GetConfigMessage { type: 'getConfig'; }
interface LintMessage { type: 'lint'; text: string; }
interface AddWordMessage { type: 'addWord'; word: string; }
interface IgnoreLintMessage { type: 'ignoreLint'; text: string; start: number; end: number; ruleName: string; }
interface DisableRuleMessage { type: 'disableRule'; ruleName: string; }
/** The multi-window refresh long-poll (see the pokeForceLint block for the full design). */
interface WaitForRefreshMessage { type: 'waitForRefresh'; generation: number; }
type IncomingMessage =
	| GetConfigMessage
	| LintMessage
	| AddWordMessage
	| IgnoreLintMessage
	| DisableRuleMessage
	| WaitForRefreshMessage;

// webpack rewrites bare `require(...)` inside the bundle; __non_webpack_require__ emits a raw
// runtime `require` resolved by Node/Electron instead. The plugin main process runs with Node
// integration ON DESKTOP ONLY, so this gives us the real `fs`/`os`/`path` there. NEVER called on
// mobile (every use is behind an isMobile() guard) — the mobile iframe has no Node and it throws.
declare const __non_webpack_require__: (id: string) => any;

// -----------------------------------------------------------------------------
// Settings snapshot (kept fresh on start + on every settings change).
// -----------------------------------------------------------------------------
interface HarperConfig {
	enabled: boolean;
	dialect: string;
	debounceMs: number;
	/** 'squiggly' (Harper's default wavy SVG underline) | 'solid' (straight line + tint). */
	underlineStyle: string;
	/** Feeds harper's `isolateEnglish` LintOption: skip spans that do not look like English. */
	ignoreNonEnglish: boolean;
	dictionaryPath: string;
	dictionaryNoteId: string;
	ruleOverrides: string;
}
const cfg: HarperConfig = {
	enabled: true,
	dialect: 'American',
	debounceMs: 500,
	underlineStyle: 'squiggly',
	ignoreNonEnglish: false,
	dictionaryPath: '',
	dictionaryNoteId: '',
	ruleOverrides: '',
};

export const DIALECT_BY_NAME: Record<string, Dialect> = {
	American: Dialect.American,
	British: Dialect.British,
	Australian: Dialect.Australian,
	Canadian: Dialect.Canadian,
	Indian: Dialect.Indian,
};

function dialectEnum(): Dialect {
	return DIALECT_BY_NAME[cfg.dialect] ?? Dialect.American;
}

async function loadSettings(): Promise<void> {
	const read = async (key: string, fallback: any) => {
		const v = await joplin.settings.value(key);
		return v === undefined || v === null ? fallback : v;
	};
	cfg.enabled = await read('enabled', true);
	cfg.dialect = await read('dialect', 'American');
	cfg.debounceMs = await read('debounceMs', 500);
	// Registered on BOTH platforms (pure CSS class choice in the content script — no fs, no note write).
	cfg.underlineStyle = await read('underlineStyle', 'squiggly');
	// Registered on BOTH platforms: it only toggles a harper LintOption (no fs, no note write).
	cfg.ignoreNonEnglish = (await read('ignoreNonEnglish', false)) === true;
	// dictionaryPath is registered on DESKTOP ONLY (its FilePath UX + fs read are desktop-only; see
	// registerSettings). Reading an UNREGISTERED key throws 'Unknown key' in real Joplin, so on mobile we
	// must never call value('dictionaryPath') — skip the read entirely and default to ''. (The old
	// unconditional read escaped onStart on mobile and killed the whole plugin.)
	cfg.dictionaryPath = isMobile() ? '' : await read('dictionaryPath', '');
	cfg.dictionaryNoteId = await read('dictionaryNoteId', '');
	cfg.ruleOverrides = await read('ruleOverrides', '');
}

// =============================================================================
// EDITOR-OPEN TRACKING (the L3 flush guard).
// =============================================================================
// L3: a plugin `joplin.data.put` note-write while ANY editor is open EVICTS the mobile editor. So the
// dictionary-note write (the ONLY note-write this plugin ever does) must never land during an active
// editing session. We track `editorOpen`:
//   - set TRUE by the content script's `getConfig` handshake — a CM6 content script only loads when a
//     markdown editor is mounted, so a handshake means "an editor is now open".
//   - set FALSE by `workspace.onNoteSelectionChange` — the previously-open editor is being torn down /
//     navigated away; the newly-selected note (if any) has no in-progress edits yet.
// The reconcile issues its data.put ONLY when `editorOpen === false`. Selection-change sets the flag
// false and THEN reconciles, so words persist to the note the instant the user leaves a note; start
// reconciles before any editor mounts. A note write needed while an editor is open (e.g. the
// dictionaryNoteId setting changed mid-edit) is deferred to the next trigger. This makes it structurally
// impossible for our note-write to reload an active editing session — the mobile eviction (L3) can't
// fire, and desktop's open editor is likewise never disturbed (documented by the eviction-safety E2E).
let editorOpen = false;

// -----------------------------------------------------------------------------
// Filesystem helpers (DESKTOP ONLY). Every function here is called behind an isMobile() guard; on
// mobile the plugin iframe has no Node, so touching these would throw. The harness fs stub FAILS the
// mobile run if any of them is reached, proving the guards hold.
// -----------------------------------------------------------------------------
function getFs(): any {
	return joplin.require('fs-extra');
}

function expandTilde(p: string): string {
	if (!p) return '';
	if (p === '~' || p.startsWith('~/')) {
		let home = '';
		try {
			home = __non_webpack_require__('os').homedir();
		} catch {
			home = process.env.HOME || process.env.USERPROFILE || '';
		}
		return p === '~' ? home : `${home}/${p.slice(2)}`;
	}
	return p;
}

/**
 * The temp path the atomic rewrite writes before renaming over `p`. It MUST be a sibling (rename is
 * only atomic within a filesystem) and it is DOT-PREFIXED — the directory is typically rclone-synced,
 * and sync tools ignore dotfiles far more often than they ignore an unknown suffix, so a mid-write
 * temp file is less likely to be picked up and shipped to other devices.
 */
function tempSiblingPath(p: string): string {
	const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	const dir = cut >= 0 ? p.slice(0, cut + 1) : '';
	const base = cut >= 0 ? p.slice(cut + 1) : p;
	return `${dir}.${base}.harper-tmp`;
}

function joinPath(dir: string, file: string): string {
	try {
		return __non_webpack_require__('path').join(dir, file);
	} catch {
		const sep = dir.endsWith('/') ? '' : '/';
		return `${dir}${sep}${file}`;
	}
}

async function localWordsPath(): Promise<string> {
	return joinPath(await joplin.plugins.dataDir(), 'userWords.txt');
}

async function ignoredLintsPath(): Promise<string> {
	return joinPath(await joplin.plugins.dataDir(), 'ignoredLints.json');
}

function parseWords(content: string): string[] {
	return content
		.split('\n')
		.map((line) => line.replace(/\r$/, '').trim())
		// Skip blank lines and '# ' comment lines (the dictionary-note header format).
		.filter((line) => line.length > 0 && !line.startsWith('# '));
}

/** Canonical dictionary body: header, blank line, then the words deduped + deterministically sorted. */
function canonicalDictionaryBody(words: Iterable<string>): string {
	const set = new Set<string>();
	for (const w of words) {
		const t = (w || '').trim();
		if (t) set.add(t);
	}
	// Code-unit sort (not locale-aware) so two devices produce byte-identical bodies from the same set
	// — the design's ping-pong / conflict mitigation (mobile-product-design.md §1b).
	const sorted = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return `${DICTIONARY_NOTE_HEADER}\n\n${sorted.join('\n')}\n`;
}

// Last-seen mtime of the external dictionary; the 60s poll compares against it and
// only re-reads when it changes (so an unchanged file costs ZERO reads). Desktop only.
let lastExternalMtimeMs: number | null = null;
let warnedMissingDict = false;

/**
 * One consistent read of the external dictionary file: its raw text, its parsed words, and the mtime
 * observed for that exact content (the token the atomic rewrite later re-checks).
 */
interface FileSnapshot {
	path: string;
	raw: string;
	words: string[];
	mtimeMs: number;
}

/**
 * DESKTOP: read the external dictionary file, or return null when there is NO file side this pass
 * (mobile, no path configured, or the file is not readable right now).
 *
 * The null-vs-empty distinction is load-bearing for v1.3.0: an ABSENT side infers no deletions, while
 * a genuinely empty (but readable) file correctly deletes everything the base remembered.
 *
 * That protects a SINGLE pass only. Returning null stops this pass from reading the missing file as
 * "the user deleted everything", but on its own it would not stop the damage across two passes: the
 * base would still advance to absorb the other side's additions, and the file would look like it had
 * deleted them the moment rclone put it back. What actually makes a momentarily-absent file unable to
 * wipe the dictionary is the PRESENCE GATE on the commit in runReconcile — a pass that did not see a
 * configured side does not advance the base at all.
 */
function readExternalFile(configuredPath: string = cfg.dictionaryPath): FileSnapshot | null {
	if (isMobile()) return null;
	const p = expandTilde(configuredPath);
	if (!p) return null;
	const fs = getFs();
	try {
		const st = fs.statSync(p);
		const raw: string = fs.readFileSync(p, 'utf8');
		lastExternalMtimeMs = st.mtimeMs;
		warnedMissingDict = false;
		return { path: p, raw, words: parseWords(raw), mtimeMs: st.mtimeMs };
	} catch {
		if (!warnedMissingDict) {
			// eslint-disable-next-line no-console
			console.warn(`[harper] external dictionary not readable (yet): ${p} — no file side this pass.`);
			warnedMissingDict = true;
		}
		return null;
	}
}

let cachedLocalWordsPath = '';

function readLocalWords(): string[] {
	if (isMobile()) return [];
	const fs = getFs();
	try {
		if (!cachedLocalWordsPath) return [];
		const content = fs.readFileSync(cachedLocalWordsPath, 'utf8');
		return parseWords(content);
	} catch {
		return [];
	}
}

// =============================================================================
// DICTIONARY NOTE (both platforms) — the synced source of truth for the word list.
// =============================================================================
// Words come from up to three sources merged into the linter's in-memory set:
//   1. external FILE   — desktop only (unchanged), read via fs.
//   2. dictionary NOTE — both platforms (new), read via joplin.data (READS are always safe, L3).
//   3. pendingWords    — both platforms (new), a settings buffer of add-to-dictionary words not yet
//                        flushed to the note (settings writes are safe mid-edit, L4).
let lastNoteUpdatedTime: number | null = null;

/**
 * Read the dictionary note's words (both platforms), or null when there is NO note side this pass
 * (no note configured, or the note is not readable right now — deleted, or not yet synced).
 *
 * Same null-vs-empty rule as the file (see readExternalFile): an unreadable note infers no
 * deletions, an empty-but-readable note deletes what the base remembered.
 */
async function readDictionaryNote(noteId: string = cfg.dictionaryNoteId): Promise<string[] | null> {
	if (!noteId) return null;
	try {
		const note = await joplin.data.get(['notes', noteId], {
			fields: ['body', 'updated_time'],
		});
		const body: string = (note && note.body) || '';
		lastNoteUpdatedTime = (note && note.updated_time) || null;
		return parseWords(body);
	} catch {
		// Note deleted or not yet synced — no note side; the id stays set so it recovers on sync.
		return null;
	}
}

/** The pendingWords settings buffer (words added but not yet flushed to the note). Both platforms. */
async function readPendingWords(): Promise<string[]> {
	try {
		const v = await joplin.settings.value('pendingWords');
		if (Array.isArray(v)) return v.filter((w) => typeof w === 'string' && w.trim().length > 0);
	} catch {
		/* unreadable — treat as empty */
	}
	return [];
}

/**
 * The pendingRemovals buffer (v1.4.0) — the exact mirror of pendingWords for the dictionary
 * editor's DELETE half. A removal has to survive until a durable side actually absorbs it, because
 * the note write is L3-deferred whenever an editor is open; without a buffer, deleting a word while
 * editing would be silently forgotten and the note would put the word straight back.
 */
const PENDING_REMOVALS_KEY = 'pendingRemovals';

async function readPendingRemovals(): Promise<string[]> {
	try {
		const v = await joplin.settings.value(PENDING_REMOVALS_KEY);
		if (Array.isArray(v)) return v.filter((w) => typeof w === 'string' && w.trim().length > 0);
	} catch {
		/* unreadable — treat as empty */
	}
	return [];
}

/**
 * ONE MUTATOR AT A TIME, across BOTH pending buffers.
 *
 * Every mutation of `pendingWords` / `pendingRemovals` is a read-modify-write — `addPendingWord`,
 * `addPendingRemoval` and `retirePendingEntries` — and each one straddles real suspension points:
 * `joplin.settings.value`/`setValue` are plugin IPC on desktop and a WebView bridge round trip on
 * mobile. Nothing upstream serializes them. The plugin's own event loop interleaves the editor's
 * "Add to dictionary", the settings dialog's per-word save loop and a reconcile's commit freely, so
 * these are ordinary interleavings rather than exotic ones, and each loses a word outright:
 *
 *   * a retire reads ['A'], an add appends B and writes ['A','B'], the retire writes [] — B is gone
 *     from the buffer, was never in that pass's merge, and never reached the note or the file. Its
 *     only record was the buffer that just got wiped;
 *   * two adds both read [], then each writes its own single-element result;
 *   * an add and a removal of DIFFERENT words cross, and one of the two is dropped.
 *
 * THE GATE COVERS BOTH KEYS AS ONE UNIT, not a lock per key, because the invariant it protects spans
 * them: adding a word cancels a pending removal of it and vice versa, so one logical edit writes
 * both. Per-key locks would have to be held across the pair (a lock-ordering hazard) or would let
 * the pair go non-disjoint between the two halves of a single edit.
 *
 * Critical sections are SHORT by construction — settings I/O only, never a note read, a note write
 * or a file rewrite, and nothing inside ever re-enters the gate. In particular a reconcile does NOT
 * hold it across the pass: it takes it only for the commit's retire. The pass's own snapshot of the
 * two buffers is deliberately left OUTSIDE the gate as well, for two reasons — it is a read, and a
 * torn pair is already resolved safely there (in favour of the addition, with the removal left
 * buffered for the next pass); and taking it would couple every seconds-long reconcile to the gate
 * its own commit later needs.
 */
let pendingBufferChain: Promise<unknown> = Promise.resolve();

function withPendingBuffers<T>(fn: () => Promise<T>): Promise<T> {
	// `.then(fn, fn)`, not `.then(fn)`: a rejected predecessor must never SKIP the next mutation,
	// which would silently break every buffered word for the rest of the session. The stored chain is
	// likewise kept un-rejected, so one failed settings write cannot wedge the gate.
	const next = pendingBufferChain.then(fn, fn);
	pendingBufferChain = next.catch(() => undefined);
	return next;
}

// The two buffers are kept DISJOINT by construction: adding a word cancels a pending removal of it
// and vice versa. That makes "the user re-added a word whose removal has not landed yet" (and the
// reverse) resolve to the last thing they actually did, rather than to whichever precedence rule
// mergeDictionary happens to apply. Both halves run under the gate above, so the cancel and the
// enqueue land as one step and no concurrent mutation can be interleaved between them.
async function addPendingWord(word: string): Promise<void> {
	return withPendingBuffers(async () => {
		const removals = await readPendingRemovals();
		if (removals.includes(word)) {
			await joplin.settings.setValue(
				PENDING_REMOVALS_KEY,
				removals.filter((w) => w !== word),
			);
		}
		const current = await readPendingWords();
		if (current.includes(word)) return;
		current.push(word);
		// L4: settings writes are safe mid-edit on mobile (device-proven). This never touches a note.
		await joplin.settings.setValue('pendingWords', current);
	});
}

async function addPendingRemoval(word: string): Promise<void> {
	return withPendingBuffers(async () => {
		const pending = await readPendingWords();
		if (pending.includes(word)) {
			await joplin.settings.setValue(
				'pendingWords',
				pending.filter((w) => w !== word),
			);
		}
		const current = await readPendingRemovals();
		if (current.includes(word)) return;
		current.push(word);
		await joplin.settings.setValue(PENDING_REMOVALS_KEY, current);
	});
}

/**
 * RETIRE the entries a reconcile pass actually consumed — never the whole buffer.
 *
 * A pass SNAPSHOTS a buffer near its start and only reaches its commit several awaits later (the
 * note `data.get`, the L3-gated `data.put`, the atomic file rewrite, the base write). Every one of
 * those awaits is a point where the plugin's own event loop can run `addPendingWord` /
 * `addPendingRemoval` for a word the user just acted on — the editor's "Add to dictionary", or the
 * settings dialog's word editor. Writing `[]` at the end would throw those away: the word was never
 * in the merge (it arrived after the snapshot), never reached the note or the file, and its only
 * record was the buffer that just got wiped. Silent data loss, and the narrower the window the
 * harder it is to ever notice.
 *
 * So the commit re-reads the buffer and keeps `current − consumed`, which leaves exactly the
 * entries that arrived mid-pass. They are picked up whole by the next pass, which is idempotent.
 *
 * SET semantics, deliberately: `addPendingWord`/`addPendingRemoval` already refuse to enqueue a word
 * the buffer holds, so a duplicate can only come from a hand-edited setting or an older build, and
 * it carries no information the pass did not already consume. Removing every copy is therefore
 * right; removing one copy per snapshotted occurrence would strand the survivor in the buffer
 * forever, since each later pass would consume and re-strand it.
 *
 * No consumed entries, or nothing of them left to drop, means no settings write at all.
 *
 * THE RE-READ AND THE WRITE ARE ONE STEP, under the buffer gate. Re-reading is what keeps a mid-pass
 * edit, but on its own it only narrowed the window rather than closing it: the re-read is itself an
 * await, so an add landing between it and the `setValue` was computed away by a survivor list that
 * predates it and written straight over — the same permanent loss this function exists to prevent,
 * just through a smaller door.
 */
async function retirePendingEntries(
	key: string,
	consumed: string[],
	read: () => Promise<string[]>,
): Promise<void> {
	// Nothing to retire needs no gate at all — no read, no write, nothing to race with.
	if (!consumed.length) return;
	return withPendingBuffers(async () => {
		const current = await read();
		const done = new Set(consumed);
		const survivors = current.filter((w) => !done.has(w));
		if (survivors.length === current.length) return; // nothing this pass consumed is still queued
		await joplin.settings.setValue(key, survivors);
	});
}

// -----------------------------------------------------------------------------
// syncBase (v1.3.0): the last successfully reconciled word set, persisted as a JSON array in a
// PRIVATE String setting. Settings writes are safe on both platforms at any time (L4), including
// mid-edit on mobile, which is why the merge base lives here and not in a note or a file.
//
// It is per-device on purpose: Joplin does not sync plugin settings, and the base means "what THIS
// device last saw the two sides agree on". A device that was offline while a word was deleted
// elsewhere still has that word in its base, sees it missing from the synced note, and therefore
// correctly infers the deletion the first time it looks.
// -----------------------------------------------------------------------------
const SYNC_BASE_KEY = 'syncBase';

// =============================================================================
// INV-A — DICTIONARY EPOCH: no durable write may outlive the configuration it was computed from.
// =============================================================================
// Three pieces of state decide what a reconcile pass MEANS: the dictionary note id, the external
// file path, and the merge base. A repoint changes all three, and a pass that computed its result
// from the old ones must not write with them — it would put the old note's words into the newly
// pointed note, truncate the newly pointed file, or commit a base over the `''` that `resetSyncBase`
// writes precisely so the next pass adopts the new side instead of inferring deletions from it.
//
// Rounds of point-fixes taught the shape this has to take. Capturing the identity at pass start was
// not enough (the base was still read live). Re-checking the identity ONCE before the write block was
// not enough either — it is a check-then-act: four suspension points follow it before the commit, and
// a repoint landing in any of them was never re-checked.
//
// So: ONE monotonic counter, bumped by EVERY mutation of dictionary identity or base; a pass captures
// it atomically with the identity at pass start; and every durable write asserts it IMMEDIATELY
// before mutating, with no await in between. A stale pass writes nothing at all. It is idempotent and
// the repoint schedules its own reconcile, so the next pass simply redoes the work correctly.
let dictionaryEpoch = 0;

function bumpDictionaryEpoch(): void {
	dictionaryEpoch++;
}

/**
 * How many dictionary-identity / base mutations are in progress. See captureDictionaryEpoch.
 */
let dictionaryMutationDepth = 0;

/**
 * BRACKET a mutation of dictionary identity or base.
 *
 * Three things, and every one of them is load-bearing:
 *
 *   * the bump BEFORE invalidates every pass that already read the old value;
 *   * the bump AFTER invalidates every pass that read while the mutation was landing;
 *   * the DEPTH marks the whole span as a transition. Bumps alone cannot cover it, because these
 *     mutations are several awaits long and an entire reconcile can begin AND finish inside one. Such
 *     a pass sees a genuinely inconsistent world — the identity has already flipped to the new note
 *     while the base still describes the old one — and no comparison of epochs before and after can
 *     detect that, since nothing changed for the duration of the pass. It merges the new note against
 *     the old base, turning every word the new side lacks into an inferred deletion and truncating
 *     the user's own dictionary file.
 *
 * So a pass that STARTS inside a transition is born stale and may never write. The `finally` is
 * deliberate: a mutation that threw part-way still leaves state no pass should trust.
 */
async function withDictionaryEpochBump<T>(mutate: () => Promise<T>): Promise<T> {
	dictionaryMutationDepth++;
	bumpDictionaryEpoch();
	try {
		return await mutate();
	} finally {
		bumpDictionaryEpoch();
		dictionaryMutationDepth--;
	}
}

/**
 * The epoch a starting pass should carry — or a value that can never match, when the configuration is
 * mid-transition and there is no consistent world to snapshot.
 */
function captureDictionaryEpoch(): number {
	return dictionaryMutationDepth > 0 ? -1 : dictionaryEpoch;
}

/** What a pass is reconciling against: captured once, asserted at every durable write. */
interface PassSnapshot {
	epoch: number;
	noteId: string;
	dictPath: string;
	reason: string;
}

let warnedStalePass: string | null = null;

/**
 * THE WRITE GATE. `true` means this pass no longer describes the live configuration and must not
 * write. Called immediately before each durable write — never once for the whole block.
 */
function passIsStale(pass: PassSnapshot, what: string): boolean {
	if (
		dictionaryEpoch === pass.epoch &&
		cfg.dictionaryNoteId === pass.noteId &&
		(isMobile() || cfg.dictionaryPath === pass.dictPath)
	) {
		return false;
	}
	// Say what actually happened. "Repointed mid-pass" was printed for every abandon, including ones
	// where the identity never moved at all, which sent anyone reading the log after the wrong cause.
	let why: string;
	if (pass.epoch < 0) why = 'it started while the dictionary was being repointed';
	else if (cfg.dictionaryNoteId !== pass.noteId) why = 'the dictionary note was repointed mid-pass';
	else if (!isMobile() && cfg.dictionaryPath !== pass.dictPath) {
		why = 'the external dictionary file was repointed mid-pass';
	} else why = 'the dictionary configuration changed mid-pass';
	const key = `${pass.reason}:${pass.epoch}:${why}`;
	if (warnedStalePass !== key) {
		warnedStalePass = key;
		// eslint-disable-next-line no-console
		console.info(`[harper] dictionary reconcile (${pass.reason}) abandoned before ${what}: ${why}`);
	}
	return true;
}

/** The persisted base, or null when none has been stored yet (fresh install / first run after upgrade). */
async function readSyncBase(): Promise<string[] | null> {
	try {
		const raw = await joplin.settings.value(SYNC_BASE_KEY);
		if (typeof raw !== 'string' || !raw.trim()) return null;
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((w) => typeof w === 'string');
	} catch {
		// Unreadable or corrupt base: treat as "no base" — the merge then adopts the current union and
		// infers no deletions, which is the safe direction.
		return null;
	}
}

/**
 * Persist the base. Writes nothing when the serialized value is unchanged (no settings churn).
 *
 * The staleness assert is INSIDE, immediately before the write: the unchanged-value read above is
 * itself a suspension point, so checking in the caller would leave exactly the check-then-act window
 * this gate exists to close.
 */
async function writeSyncBase(words: string[], pass: PassSnapshot): Promise<void> {
	const next = JSON.stringify(words);
	try {
		const current = await joplin.settings.value(SYNC_BASE_KEY);
		if (current === next) return;
	} catch {
		/* fall through and write */
	}
	if (passIsStale(pass, 'the merge-base commit')) return;
	await joplin.settings.setValue(SYNC_BASE_KEY, next);
}

/** Forget the base, so the NEXT reconcile is a first run (adopt the union, infer no deletions). */
async function resetSyncBase(): Promise<void> {
	// Bracketed: this mutates state every in-flight pass computed against, and it spans two awaits a
	// new pass can start inside. See withDictionaryEpochBump.
	await withDictionaryEpochBump(async () => {
		try {
			const current = await joplin.settings.value(SYNC_BASE_KEY);
			if (current === '') return;
		} catch {
			/* fall through and write */
		}
		await joplin.settings.setValue(SYNC_BASE_KEY, '');
	});
}

// -----------------------------------------------------------------------------
// Rule overrides (advanced JSON setting).
// -----------------------------------------------------------------------------
let lastInvalidOverridesRaw: string | null = null;

function parseRuleOverrides(): LintConfig {
	const raw = (cfg.ruleOverrides || '').trim();
	// One shared parse with the settings service, so what the dialog reads back and what the engine
	// is configured with can never diverge. The warn-once is this caller's own concern.
	const parsed = parseRuleOverridesJson(raw);
	if (parsed) return parsed;
	if (raw !== lastInvalidOverridesRaw) {
		// eslint-disable-next-line no-console
		console.warn(`[harper] ruleOverrides is not a valid JSON object; ignoring: ${raw}`);
		lastInvalidOverridesRaw = raw;
	}
	return {};
}

// -----------------------------------------------------------------------------
// Ignored-lint persistence. Desktop: a JSON file in dataDir (unchanged). Mobile: a private settings
// value (no fs; L4-safe). harper filters ignored lints internally on every subsequent lint.
// -----------------------------------------------------------------------------
async function loadIgnoredLintsJson(): Promise<string> {
	if (isMobile()) {
		try {
			const v = await joplin.settings.value('ignoredLints');
			return typeof v === 'string' ? v : '';
		} catch {
			return '';
		}
	}
	try {
		return getFs().readFileSync(await ignoredLintsPath(), 'utf8');
	} catch {
		return '';
	}
}

async function saveIgnoredLintsJson(json: string): Promise<void> {
	if (isMobile()) {
		await joplin.settings.setValue('ignoredLints', json);
		return;
	}
	try {
		getFs().writeFileSync(await ignoredLintsPath(), json, 'utf8');
	} catch {
		// eslint-disable-next-line no-console
		console.warn('[harper] could not persist ignored lints');
	}
}

// -----------------------------------------------------------------------------
// Dismissed-findings side table (v1.4.0) — the readable index over the hashes above.
// -----------------------------------------------------------------------------
// Storage mirrors the ignoredLints convention exactly: desktop writes a JSON file in dataDir, mobile
// uses a private String setting (no fs there; settings writes are L4-safe). Plain JSON is safe for
// THIS file — unlike harper's payload, every hash in it is already a string.
const DISMISSED_META_KEY = 'dismissedMeta';

async function dismissedMetaPath(): Promise<string> {
	return joinPath(await joplin.plugins.dataDir(), 'dismissedMeta.json');
}

const dismissedStore: DismissedStore = {
	async read(): Promise<string> {
		if (isMobile()) {
			try {
				const v = await joplin.settings.value(DISMISSED_META_KEY);
				return typeof v === 'string' ? v : '';
			} catch {
				return '';
			}
		}
		try {
			return getFs().readFileSync(await dismissedMetaPath(), 'utf8');
		} catch {
			return '';
		}
	},
	async write(json: string): Promise<void> {
		if (isMobile()) {
			await joplin.settings.setValue(DISMISSED_META_KEY, json);
			return;
		}
		try {
			getFs().writeFileSync(await dismissedMetaPath(), json, 'utf8');
		} catch {
			// eslint-disable-next-line no-console
			console.warn('[harper] could not persist the dismissed-findings side table');
		}
	},
};

// -----------------------------------------------------------------------------
// Linter lifecycle.
// -----------------------------------------------------------------------------
let linterPromise: Promise<LocalLinter> | null = null;

async function buildLinter(): Promise<LocalLinter> {
	// Unified inlined-binary loader (see the top-of-file import note). Identical on desktop and mobile:
	// no fs read, no data-URL construction, no separate .wasm — the binary rides inside the bundle.
	const linter = new LocalLinter({ binary: slimBinaryInlined, dialect: dialectEnum() });
	await linter.setup();
	importedWordsKey = null; // a brand-new engine holds no words, whatever the last import was
	return linter;
}

/**
 * Make the engine's ignore set exactly the persisted payload. CALLER MUST HOLD the dismissal
 * transaction — this both destroys and rebuilds the state that transaction protects.
 *
 * Shared by engine (re)configuration and by the dialect switch, so there is exactly one description
 * of "re-hydrate the ignore set" and no path that destroys it without immediately restoring it.
 */
async function rehydrateIgnoredLints(linter: LocalLinter): Promise<void> {
	await linter.clearIgnoredLints();
	const ignored = await loadIgnoredLintsJson();
	if (ignored && ignored.trim()) {
		try {
			await linter.importIgnoredLints(ignored);
		} catch {
			/* corrupt persisted ignore-state — skip */
		}
	}
}

/**
 * (Re)apply dictionary words, rule overrides and ignored lints to a linter instance.
 *
 * `fresh` carries the same contract as `reconcileAndApply`'s: a caller that has just CHANGED state
 * the reconcile reads — the settings onChange handler, which rewrites `cfg` and resets the merge
 * base before it gets here — must not be answered by a pass that snapshotted the old state. See
 * reconcileFresh. The engine-init caller has written nothing, so joining is right for it.
 */
async function applyConfiguration(
	linter: LocalLinter,
	reason = 'apply-configuration',
	fresh = false,
): Promise<void> {
	if (!isMobile()) cachedLocalWordsPath = await localWordsPath();

	// Dictionary: reconcile the sources (three-way merge, incl. deletions) and clear-then-import the
	// result, so a word deleted on any side stops being accepted by the engine immediately.
	//
	// A STALE PASS PUBLISHES NOTHING, HERE TOO. This is the second of exactly two callers of
	// importWordsIntoLinter, and it used to take the `.words`-only wrapper and import unconditionally —
	// so an abandoned pass reached through the settings-change path still clear-then-imported, wiping a
	// word `addWord` had just imported into the engine directly. The dialect branch makes that
	// deterministic rather than lucky, since it nulls `importedWordsKey` immediately beforehand and the
	// memo can no longer skip the clobbering import.
	//
	// SKIPPING IS THE RIGHT ANSWER FOR THE INIT CALLER TOO (getLinter, fresh=false, brand-new empty
	// engine). Leaving the engine's word set alone can never delete anything, whereas importing a list
	// computed against a configuration that no longer exists can; and an abandon is only ever caused by
	// the settings onChange handler, which finishes by awaiting `linterPromise` and running its own
	// fresh `applyConfiguration`. So the words arrive a moment later by the same path that displaced
	// them. On a genuinely empty engine the two behaviours also coincide, because an abandoned pass
	// returns the last published list — which at init is empty.
	const dictionary = fresh ? await reconcileFreshResult(reason) : await reconcileDictionaryResult(reason);
	if (dictionary.published) await importWordsIntoLinter(linter, dictionary.words);

	// Rule overrides on top of defaults. GUARDED, like the ignored-lints import below: this runs
	// inside the memoized `linterPromise`, so a throw here is cached for the whole session — every
	// lint AND every settings-dialog snapshot would reject forever, with the dialog showing only the
	// raw harper error and no way to reach the setting that caused it. `parseRuleOverridesJson` now
	// drops the non-boolean values harper rejects, so this should be unreachable; it stays because
	// "the engine is unconfigurable" must never mean "the plugin is dead".
	try {
		await linter.setLintConfig(parseRuleOverrides());
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn('[harper] ruleOverrides rejected by the engine; running with defaults:', error);
		await linter.setLintConfig({});
	}

	// Ignored lints (persisted between sessions). harper filters these internally on every subsequent
	// lint once imported, so no host-side filtering is needed.
	//
	// UNDER THE DISMISSAL TRANSACTION: this is a clear-then-import of the very state a dismissal or a
	// restore is rebuilding, read from the very payload they are rewriting. Run against a restore in
	// flight it would re-import the pre-restore payload into the engine, leaving the engine ignoring a
	// hash the persisted mirror no longer lists — a divergence nothing heals until the next restart.
	await withDismissalTransaction(dismissedStore, () => rehydrateIgnoredLints(linter));
}

async function getLinter(): Promise<LocalLinter> {
	if (!linterPromise) {
		linterPromise = (async () => {
			const linter = await buildLinter();
			await applyConfiguration(linter);
			return linter;
		})();
	}
	return linterPromise;
}

// -----------------------------------------------------------------------------
// Main -> editor re-lint poke (MULTI-WINDOW).
// -----------------------------------------------------------------------------
// `editor.execCommand` cannot reach an unfocused window: Joplin registers that command's runtime
// once PER EDITOR with a priority that is 0 whenever the editor's document lacks focus, and
// CommandService executes exactly ONE highest-priority runtime (useWindowCommandHandler +
// getWindowCommandPriority in the app bundle). So with several note windows open, an execCommand
// poke alone refreshes only the focused editor and leaves every other window stale — old
// underline style, old debounce, old dictionary/rule state. The poke therefore has two halves:
//
//   1. CONFIG-GENERATION LONG-POLL — every open desktop editor keeps one 'waitForRefresh'
//      message parked here (holding a reply promise open is safe: the desktop plugin IPC keys
//      replies by callbackId with NO timeout). Bumping the generation resolves them ALL, so every
//      window refreshes, focused or not. A parked reply is bounded by a heartbeat: after
//      REFRESH_HEARTBEAT_MS it resolves with the current (unchanged) generation and the content
//      script immediately re-parks, so the scheme stays live even across a bridge that will not
//      hold a reply open indefinitely.
//   2. the execCommand poke (unchanged) — the focused window's path, and the ONLY path on mobile
//      (a single window; the content script does not subscribe there).
let configGeneration = 0;

interface RefreshWaiter {
	resolve: (reply: { generation: number }) => void;
	timer: ReturnType<typeof setTimeout>;
}
let refreshWaiters: RefreshWaiter[] = [];

const REFRESH_HEARTBEAT_MS = 25_000;

function bumpConfigGeneration(): void {
	configGeneration++;
	const waiters = refreshWaiters;
	refreshWaiters = [];
	for (const waiter of waiters) {
		clearTimeout(waiter.timer);
		waiter.resolve({ generation: configGeneration });
	}
}

/**
 * The 'waitForRefresh' long-poll: an up-to-date editor's request parks until the next
 * bumpConfigGeneration (or the heartbeat); a stale editor's request is answered immediately, so a
 * bump that landed while that editor was between polls is never lost. Deliberately does NOT touch
 * `editorOpen`: these requests arrive continuously from every open editor, so treating one as the
 * getConfig handshake would pin the L3 note-write deferral open forever.
 */
function waitForRefresh(clientGeneration: number): Promise<{ generation: number }> {
	if (clientGeneration !== configGeneration) {
		return Promise.resolve({ generation: configGeneration });
	}
	return new Promise((resolve) => {
		const waiter: RefreshWaiter = {
			resolve,
			timer: setTimeout(() => {
				refreshWaiters = refreshWaiters.filter((w) => w !== waiter);
				resolve({ generation: configGeneration });
			}, REFRESH_HEARTBEAT_MS),
		};
		refreshWaiters.push(waiter);
	});
}

async function pokeForceLint(): Promise<void> {
	// Resolve every parked subscription FIRST (all windows), then poke the focused editor.
	bumpConfigGeneration();
	try {
		await joplin.commands.execute('editor.execCommand', { name: 'harper.forceLint' });
	} catch {
		// No editor open (or the command is not registered yet) is fine.
	}
}

// =============================================================================
// RECONCILE (v1.3.0) — three-way merge of note / file / pending against the persisted base.
// =============================================================================
// This replaces v1.2.0's additive flush+mirror. ONE function owns the whole dictionary round trip:
//
//   read sides -> mergeDictionary(base, note, file, pending) -> write the sides that differ ->
//   persist the new base -> retire the pending entries this pass flushed (NOT the whole buffer —
//   see retirePendingEntries) -> hand the result to the engine.
//
// WRITE DISCIPLINE (unchanged from v1.2.0, and still the only note-write path in the plugin):
//   * the note is written with `joplin.data.put` ONLY when `editorOpen === false` (L3 — a plugin note
//     write while an editor is open evicts the mobile editor). A needed note write that arrives while
//     an editor is open is simply not performed; the reconcile is idempotent, so the next trigger
//     (selection change, poll, settings change) does it.
//   * the file is rewritten in place, atomically, and only when its content actually changes.
//   * `syncBase` is advanced ONLY when every side that needed writing was written AND every
//     configured side was actually PRESENT this pass. A partial pass leaves the base alone, so
//     nothing is ever "forgotten" between two halves of a reconcile; an absent-side pass likewise
//     leaves it alone, so the side that was missing cannot look like it deleted the other side's
//     additions when it comes back. See the COMMIT block in runReconcile.
//
// Concurrent callers join the in-flight pass instead of racing it, and `lastEngineWords` keeps the
// last good result so a failed pass leaves the engine's word set alone rather than emptying it.
/**
 * What a pass produced, and whether it is ENTITLED TO BE APPLIED.
 *
 * A stale pass publishes nothing — the live engine included. Returning only the word list was not
 * enough to express that: `reconcileAndApply` clear-then-imports whatever it is handed, so an
 * abandoned pass still reshaped the engine (dropping a word `addWord` had just imported directly).
 * `published: false` means "this pass changed nothing; leave the engine exactly as it is".
 */
interface ReconcileResult {
	words: string[];
	published: boolean;
}

let reconcilePromise: Promise<ReconcileResult> | null = null;
let lastEngineWords: string[] = [];

/**
 * Clear-then-import: the engine's word set becomes exactly `words` (which is how a DELETED word
 * stops being accepted — harper has no "forget one word" call).
 *
 * A no-op when the engine already holds exactly this list. That matters for more than tidiness:
 * between `clearWords()` and `importWords()` the engine's dictionary is momentarily EMPTY, so a lint
 * that lands in that window would flag every custom word. Skipping unchanged imports keeps that
 * window from ever opening on the common path (polls, selection changes, settings changes that do
 * not touch the dictionary). `importedWordsKey` is invalidated whenever the engine is rebuilt or
 * poked directly (see addWord).
 */
let importedWordsKey: string | null = null;

async function importWordsIntoLinter(linter: LocalLinter, words: string[]): Promise<boolean> {
	const key = JSON.stringify(words);
	if (key === importedWordsKey) return false;
	await linter.clearWords();
	if (words.length) await linter.importWords(words);
	importedWordsKey = key;
	return true;
}

/**
 * Reconcile every dictionary source and return the word set the engine should hold
 * (the merge result plus the desktop plugin-local list, which is additive-only — see below).
 *
 * Concurrent callers join the in-flight pass. Reentrancy is impossible by construction: the only
 * settings this writes (`syncBase`, `pendingWords`, `pendingRemovals`) are filtered out of the
 * settings onChange handler, so a write from inside a reconcile can never call back into one.
 */
function reconcileDictionaryResult(reason: string): Promise<ReconcileResult> {
	if (reconcilePromise) return reconcilePromise;
	reconcilePromise = runReconcile(reason).finally(() => {
		reconcilePromise = null;
	});
	return reconcilePromise;
}

/** The reconciled word set. Callers that only want the list, not whether it may be applied. */
function reconcileDictionary(reason: string): Promise<string[]> {
	return reconcileDictionaryResult(reason).then((result) => result.words);
}

/**
 * Reconcile in a pass that is guaranteed to have seen everything written BEFORE this call.
 *
 * Joining an in-flight pass is right for a POLL or a selection change — they only ask "what is the
 * dictionary now?". It is wrong for a caller that has just written to the pending buffers, because
 * that pass snapshotted them before those writes existed: the dictionary editor's save would land in
 * the buffers, the joined pass would return the pre-save word set, the note would never be written,
 * and `importWordsIntoLinter` would clear-then-import that stale list — undoing the `importWords` the
 * save had just done, so the words the dialog reported as saved come straight back as underlines.
 * Nothing retries it either: the poll returns early unless a side moved.
 *
 * So: drain whatever is in flight, then reconcile. A pass that starts while we wait began strictly
 * after this caller's writes, so joining THAT one is correct.
 */
async function reconcileFreshResult(reason: string): Promise<ReconcileResult> {
	const inFlight = reconcilePromise;
	if (inFlight) {
		// runReconcile catches its own errors and never rejects; the guard is belt-and-braces so a
		// future change there cannot turn a stale-pass wait into a failed save.
		try {
			await inFlight;
		} catch {
			/* the pass logged it itself */
		}
	}
	// Anything that started while we waited began AFTER this caller's writes, so joining it is correct.
	return reconcileDictionaryResult(reason);
}

/** As reconcileFreshResult, for callers that only want the list. */
async function reconcileFresh(reason: string): Promise<string[]> {
	return (await reconcileFreshResult(reason)).words;
}

async function runReconcile(reason: string): Promise<ReconcileResult> {
	try {
		if (!isMobile() && !cachedLocalWordsPath) cachedLocalWordsPath = await localWordsPath();
		// The desktop plugin-local list (userWords.txt) is written ONLY when neither an external file
		// nor a dictionary note is configured, and it has never been mirrored into either side. It stays
		// exactly what it was in v1.2.0: an additive-only local fallback, outside the merge.
		const local = readLocalWords();

		// THE SNAPSHOT THIS PASS IS RECONCILING AGAINST — identity AND epoch, captured together, with no
		// await between them, before anything is read. See INV-A at bumpDictionaryEpoch: the epoch
		// covers the merge base too, which is read further down and is not something identity alone can
		// describe. Every durable write below asserts this snapshot immediately before mutating.
		const pass: PassSnapshot = {
			epoch: captureDictionaryEpoch(),
			noteId: cfg.dictionaryNoteId,
			dictPath: isMobile() ? '' : cfg.dictionaryPath,
			reason,
		};
		const noteId = pass.noteId;
		const dictPath = pass.dictPath;

		const note = await readDictionaryNote(noteId); // null when there is no readable note side
		const file = readExternalFile(dictPath); // null on mobile / no path / unreadable

		// BOTH PENDING BUFFERS ARE SNAPSHOTTED HERE, TOGETHER, and the pair is made disjoint before
		// anything reads it.
		//
		// `addPendingWord`/`addPendingRemoval` keep the two buffers disjoint at WRITE time — but that is
		// a write-time invariant only. A pass that reads them at two different instants (this one used
		// to take `removals` two awaits earlier, with the note `data.get` in between) can observe a pair
		// that was never simultaneously true, and mergeDictionary then applies removals-beat-additions
		// to it: a word re-added by "Add to dictionary" mid-pass was cancelled by the very removal it
		// had just superseded, left out of the note, and then retired from BOTH buffers — permanent loss
		// of a word whose underline the user had just watched clear.
		//
		// An overlap is resolved in favour of the ADDITION, and the removal stays in its buffer: this
		// pass does not consume it, so `retirePendingEntries` cannot drop it and the next pass — reading
		// a pair that has settled — applies it. This direction costs at worst one deferred deletion;
		// the other direction is unrecoverable.
		const pending = await readPendingWords();
		const removalsRaw = await readPendingRemovals();
		const pendingSet = new Set(pending);
		const removals = removalsRaw.filter((w) => !pendingSet.has(w));

		if (note === null && file === null) {
			// Nothing durable to reconcile against: keep buffering (exactly as v1.2.0 did) and feed the
			// engine the local fallback plus whatever is in the pending buffer.
			// A STALE PASS PUBLISHES NOTHING — engine state included. The durable-write gates alone do
			// not cover this: they are all on writes this branch never reaches, so a born-stale pass
			// used to fall straight through and hand its merge to the live engine anyway.
			if (passIsStale(pass, 'publishing the word set to the engine')) {
				return { words: lastEngineWords, published: false };
			}
			const removed = new Set(removals);
			lastEngineWords = [...new Set([...pending, ...local])].filter((w) => !removed.has(w));
			// A removal is only DONE once the sides that could resurrect the word have absorbed it.
			// With no durable side CONFIGURED there is nothing left to absorb it — persistRemovedWord
			// already pruned the desktop-local fallback — so the buffer can be retired here. But when a
			// side IS configured and merely unreadable this pass (unsynced note, offline drive), the
			// buffer must survive: clearing it would let that side put the word back when it returns.
			const anyDurableSideConfigured = !!noteId || (!isMobile() && !!dictPath);
			if (!anyDurableSideConfigured && !passIsStale(pass, 'retiring the removals buffer')) {
				// Only the removals THIS pass consumed are retired: a removal queued since the snapshot,
				// or one this pass set aside as superseded by a pending add, has not been applied to
				// anything yet and must survive.
				await retirePendingEntries(PENDING_REMOVALS_KEY, removals, readPendingRemovals);
			}
			return { words: lastEngineWords, published: true };
		}

		const base = await readSyncBase();
		const merged = mergeDictionary({
			base,
			note,
			file: file ? file.words : null,
			pending,
			removals,
		});

		// PRESENCE GATE (v1.3.0 fix) — the other half of the commit condition, see the COMMIT block.
		// A side is "present" when it is not configured at all (nothing to be absent) or it read back
		// non-null this pass. On mobile there is no file side by construction, so it is never missing.
		const noteSidePresent = !noteId || note !== null;
		const fileSidePresent = isMobile() || !dictPath || file !== null;
		const allSidesPresent = noteSidePresent && fileSidePresent;

		// --- DURABLE WRITES: each one asserts the pass snapshot IMMEDIATELY before mutating -----
		//
		// Not once for the whole block. Everything above describes the note, the file and the base this
		// pass started against, and each write below would do real damage with a configuration that has
		// since moved: the note put writes the OLD note's body over the NEWLY-POINTED note; the file
		// rewrite reshapes a file that is no longer configured; the base commit overwrites the `''` that
		// `resetSyncBase()` wrote, which is the entire reason a repoint is safe. Between these writes
		// lie four suspension points (the put, its updated_time get, the file rewrite, and the base
		// read), so a single check up front is a check-then-act with a window in every one of them.
		//
		// An abandoned pass has written nothing. It is idempotent and the repoint schedules its own
		// reconcile, so the next pass redoes this correctly against the new configuration.

		// --- NOTE side (L3-guarded; the plugin's only data.put) ---------------------------------
		let noteWritten = true;
		if (merged.noteChanged) {
			if (editorOpen) {
				noteWritten = false; // deferred: an editor is open, so a note write is forbidden
			} else {
				if (passIsStale(pass, 'the dictionary-note write')) return { words: lastEngineWords, published: false };
				await joplin.data.put(['notes', noteId], null, {
					body: canonicalDictionaryBody(merged.result),
				});
				try {
					const after = await joplin.data.get(['notes', noteId], {
						fields: ['updated_time'],
					});
					lastNoteUpdatedTime = (after && after.updated_time) || lastNoteUpdatedTime;
				} catch {
					/* best-effort updated_time refresh */
				}
			}
		}

		// --- FILE side (desktop; order-preserving atomic rewrite) -------------------------------
		let fileWritten = true;
		if (merged.fileChanged && file) {
			if (passIsStale(pass, 'the external-file rewrite')) return { words: lastEngineWords, published: false };
			fileWritten = rewriteExternalFile(file, merged.result);
		}

		// --- COMMIT: advance the base ONLY on a pass that saw the whole picture -----------------
		//
		// Two independent conditions, and BOTH are required:
		//
		//   (a) every side that needed writing actually got written — otherwise the base would move
		//       past a change that never landed, and the retry would read it as a deletion;
		//   (b) every CONFIGURED side was PRESENT this pass — this is the data-loss gate. An absent
		//       side infers no deletions, but it also contributes nothing to the base, so committing
		//       would fold the *present* side's additions into a base the absent side has never seen.
		//       When it comes back with its older content, those additions read as deletions on that
		//       side and are destroyed: word loss nobody asked for, synced to every device. It is not
		//       an exotic race — "Joplin launched before the rclone/network drive was reachable" is
		//       enough, and on a first run it would wipe every note-only word on mount.
		//
		// An uncommitted pass is still useful and still safe: the merge result is fed to the engine
		// (additively, since no deletion can be inferred from a side that was not there), the pending
		// buffer is kept rather than flushed, and the whole thing is recomputed next tick. It is a
		// stable fixed point, not a write loop — with the base frozen, the same inputs keep producing
		// the same result, so nothing is rewritten twice.
		const committed = noteWritten && fileWritten && allSidesPresent;
		if (committed) {
			// writeSyncBase asserts the snapshot inside itself, right before its setValue — its own
			// unchanged-value read is a suspension point, so a check out here would not be "at the write".
			await writeSyncBase(merged.result, pass);
			// Retire only what THIS pass merged and wrote — see retirePendingEntries. Anything enqueued
			// while the pass was in flight (the note read, the note write, the file rewrite are all
			// awaits the user's "Add to dictionary" can land inside) is kept for the next pass, which
			// is idempotent and will merge it exactly as if it had arrived a tick later.
			if (passIsStale(pass, 'retiring the pending buffers')) return { words: lastEngineWords, published: false };
			await retirePendingEntries('pendingWords', pending, readPendingWords);
			// Removals retire on exactly the same condition as pending additions: every side that
			// needed writing was written, and every configured side was present. Until then the buffer
			// is what stops a not-yet-rewritten side from resurrecting the word on the next pass.
			await retirePendingEntries(PENDING_REMOVALS_KEY, removals, readPendingRemovals);
		}

		if (merged.deleted.length || merged.added.length) {
			// eslint-disable-next-line no-console
			console.info(
				`[harper] dictionary reconcile (${reason}): +${merged.added.length} -${merged.deleted.length}` +
					`${committed ? '' : ' (partial — will retry)'}`,
			);
		}

		// The desktop-local fallback is unioned in, so an explicit removal is subtracted again here:
		// persistRemovedWord already prunes userWords.txt, and this keeps the engine correct even if
		// that prune could not be written (read-only dir, missing file).
		// A STALE PASS PUBLISHES NOTHING — engine state included, which the durable-write gates above
		// do not reach. With the note write L3-deferred (an editor is open: the normal state) and no
		// file side changing, none of those gates is evaluated, and the pass fell through to here and
		// clear-then-imported a merge computed against a configuration that no longer exists — so a
		// lint landing in that window flagged words nothing had deleted, and `getEffectiveWords`
		// handed the same phantom list to the settings dialog. Keeping the previous good list costs
		// nothing: the repoint runs its own fresh reconcile immediately afterwards.
		if (passIsStale(pass, 'publishing the word set to the engine')) {
			return { words: lastEngineWords, published: false };
		}
		const removed = new Set(removals);
		lastEngineWords = [...new Set([...merged.result, ...local])].filter((w) => !removed.has(w));
		return { words: lastEngineWords, published: true };
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn(`[harper] dictionary reconcile (${reason}) failed:`, error);
		// A failed pass computed nothing, so it may not reshape the engine either.
		return { words: lastEngineWords, published: false };
	}
}

/**
 * Reconcile, then push the result into the live engine and poke any open editor to re-lint.
 *
 * `fresh` is for callers that have just written to the pending buffers and need their own writes
 * reflected — see reconcileFresh. Returns the reconciled word set so such a caller can report it.
 */
async function reconcileAndApply(reason: string, fresh = false): Promise<string[]> {
	const result = fresh ? await reconcileFreshResult(reason) : await reconcileDictionaryResult(reason);
	const words = result.words;
	if (!linterPromise) return words; // engine not built yet; its own init will reconcile
	// A stale pass publishes NOTHING, and the engine is state like any other. Importing its list
	// anyway would clear-then-import a word set computed against a configuration that no longer
	// exists — dropping, among other things, a word `addWord` had just imported directly.
	if (!result.published) return words;
	let changed = false;
	try {
		changed = await importWordsIntoLinter(await linterPromise, words);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn('[harper] could not refresh the engine dictionary:', error);
		return words;
	}
	// Only poke the editor when the word set actually moved: a selection change or an unchanged poll
	// must not cost an extra full re-lint.
	if (changed) await pokeForceLint();
	return words;
}

/**
 * DESKTOP: rewrite the external dictionary file so its words are exactly `target`.
 *
 * MINIMAL DIFFS — the file is the user's own, edited by harper-ls/Zed and synced by rclone, so:
 *   * every surviving line is kept verbatim, in its original order (comments and blank lines too);
 *   * only the lines whose word is no longer in `target` are dropped;
 *   * a word repeated on several lines collapses to its FIRST line (the file is a set of words);
 *   * genuinely new words are appended at the end, sorted, using the file's dominant line ending.
 *
 * RCLONE SAFETY — `snapshot` carries the mtime observed when the content was read. If the file has
 * changed since (someone else wrote it while we were merging) the rewrite is ABORTED and retried on
 * the next tick, so a concurrent writer's content is never clobbered by a stale computation. The
 * write itself is atomic: a dot-prefixed sibling temp file in the same directory, fsync'd, then
 * `rename`d over the original.
 *
 * Returns true when the file now matches `target` (written, or already identical), false when the
 * rewrite was skipped and must be retried.
 */
function rewriteExternalFile(snapshot: FileSnapshot, target: string[]): boolean {
	if (isMobile()) return false;
	const fs = getFs();
	const p = snapshot.path;
	const tmp = tempSiblingPath(p);
	const keep = new Set(target);
	const eol = snapshot.raw.includes('\r\n') ? '\r\n' : '\n';

	// Split into lines WITHOUT the trailing empty piece a final newline produces, so the file's
	// original trailing-newline shape is reproduced exactly rather than doubled.
	const hadTrailingNewline = snapshot.raw.endsWith('\n');
	const body = hadTrailingNewline ? snapshot.raw.slice(0, -1) : snapshot.raw;
	// The CR of a CRLF file belongs to the line TERMINATOR, not to the line, and `out.join(eol)` puts
	// a full terminator back — so a kept line that still carried its own CR would end up with two, and
	// with one more on every later rewrite (`line.replace(/\r$/, '')` strips exactly one). The words
	// still parse, so nothing surfaces it: the user's own dictionary file, shared with harper-ls and
	// synced by rclone, just accretes stray CRs and diffs dirty on every device. Stripping here also
	// revives the `content === snapshot.raw` no-op guard below, which was dead for CRLF files.
	const lines = body.length ? body.split('\n').map((line) => line.replace(/\r$/, '')) : [];

	const kept: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const word = line.trim();
		const isWordLine = word.length > 0 && !word.startsWith('# ');
		if (isWordLine) {
			if (!keep.has(word)) continue; // deleted elsewhere — drop this line
			// Exact duplicate of a word already kept: drop it and keep only the FIRST line. The file is
			// a set of words, so a repeated line is noise; without this the rewrite would preserve it
			// forever (both copies are in `keep`), making an accidental duplicate permanent.
			if (seen.has(word)) continue;
			seen.add(word);
		}
		kept.push(line); // comments, blank lines and surviving words keep their content byte-identically
	}
	const appended = target.filter((w) => !seen.has(w));
	const out = [...kept, ...appended];
	let content = out.join(eol);
	if (content.length && (hadTrailingNewline || appended.length)) content += eol;
	if (content === snapshot.raw) return true; // nothing to do — never rewrite an unchanged file

	try {
		// Re-check the mtime: if the file moved under us between the read and now, abort and retry.
		const before = fs.statSync(p);
		if (before.mtimeMs !== snapshot.mtimeMs) {
			// eslint-disable-next-line no-console
			console.warn('[harper] external dictionary changed mid-merge; deferring the rewrite one tick');
			return false;
		}
		fs.writeFileSync(tmp, content, 'utf8');
		try {
			// Flush the temp file to disk BEFORE the rename. rename() is atomic with respect to other
			// readers, but not with respect to a crash: on several filesystems the metadata operation can
			// hit the disk while the data behind it is still in the page cache, and the user would find
			// their dictionary truncated to zero length. One fsync on the user's own small file is cheap.
			const fd = fs.openSync(tmp, 'r+');
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			/* best effort: an un-fsynced write is still correct, just less crash-durable */
		}
		try {
			fs.chmodSync(tmp, before.mode & 0o777); // keep the user's permissions across the rename
		} catch {
			/* best effort */
		}
		// Re-check immediately before the swap: writing the temp file is the slow part of this
		// function, so this is where a concurrent rclone/harper-ls write is most likely to have landed.
		if (fs.statSync(p).mtimeMs !== snapshot.mtimeMs) {
			fs.removeSync(tmp);
			// eslint-disable-next-line no-console
			console.warn('[harper] external dictionary changed mid-write; deferring the rewrite one tick');
			return false;
		}
		fs.renameSync(tmp, p); // atomic within the directory: readers see old or new, never partial
		try {
			lastExternalMtimeMs = fs.statSync(p).mtimeMs;
		} catch {
			lastExternalMtimeMs = null;
		}
		return true;
	} catch (error) {
		try {
			fs.removeSync(tmp);
		} catch {
			/* ignore */
		}
		// eslint-disable-next-line no-console
		console.warn(`[harper] could not rewrite the external dictionary file: ${p}`, error);
		return false;
	}
}

// -----------------------------------------------------------------------------
// Lint serialization.
// -----------------------------------------------------------------------------
/**
 * The LintOptions every lint call in this plugin uses. SINGLE SOURCE — `ignoreLint`'s re-lint loop
 * must see exactly the same finding set as `lintText`, or the span the user pointed at would not be
 * found and "Dismiss" would silently do nothing whenever `ignoreNonEnglish` is on.
 */
function lintOptions(): LintOptions {
	return { language: 'markdown', isolateEnglish: cfg.ignoreNonEnglish };
}

function suggestionKindToString(kind: SuggestionKind): PlainSuggestion['kind'] {
	switch (kind) {
		case SuggestionKind.Remove:
			return 'Remove';
		case SuggestionKind.InsertAfter:
			return 'InsertAfter';
		case SuggestionKind.Replace:
		default:
			return 'Replace';
	}
}

function lintToPlain(lint: Lint, ruleName: string): PlainLint {
	const span = lint.span();
	const suggestions: PlainSuggestion[] = lint.suggestions().map((sug) => ({
		kind: suggestionKindToString(sug.kind()),
		replacementText: sug.get_replacement_text(),
	}));
	return {
		start: span.start,
		end: span.end,
		kind: lint.lint_kind(),
		kindPretty: lint.lint_kind_pretty(),
		ruleName,
		message: lint.message(),
		messageHtml: lint.message_html(),
		problemText: lint.get_problem_text(),
		suggestions,
	};
}

async function lintText(text: string): Promise<PlainLint[]> {
	const enabled = await joplin.settings.value('enabled');
	if (enabled === false) return [];
	const linter = await getLinter();
	const organized = await linter.organizedLints(text, lintOptions());
	const out: PlainLint[] = [];
	for (const [ruleName, lints] of Object.entries(organized)) {
		for (const lint of lints) out.push(lintToPlain(lint, ruleName));
	}
	return out;
}

// -----------------------------------------------------------------------------
// Tooltip-action handlers.
// -----------------------------------------------------------------------------
/**
 * PERSIST ONE ADDED WORD — steps 2 and 3 of addWord, factored out so the dictionary editor's bulk
 * save (settingsService.saveDictionaryWords) goes through the SAME buffer + file handling instead of
 * reimplementing it. Deliberately does NOT touch the engine or poke: the caller batches those.
 */
async function persistAddedWord(word: string): Promise<void> {
	// 2) Settings buffer (both platforms): the deferred flush folds this into the dictionary note when
	//    no editor is open (L4-safe settings write; never a note write here).
	await addPendingWord(word);

	// 3) Desktop keeps its existing external-file / plugin-local append (unchanged, always safe).
	if (!isMobile()) {
		const fs = getFs();
		const external = expandTilde(cfg.dictionaryPath);
		if (external) {
			try {
				// Never append a word the file already lists: the rewrite keeps every line whose word is
				// still wanted, so a duplicate appended here would survive every future rewrite instead of
				// being transient. An unreadable/absent file falls through to the append, which creates it.
				let alreadyThere = false;
				// The file's dominant line ending, so a word appended to a CRLF dictionary does not
				// arrive LF-terminated (the rewrite would normalize it later, but a dictionary that only
				// ever grows never gets rewritten). Defaults to '\n' for a new or unreadable file.
				let eol = '\n';
				try {
					const raw: string = fs.readFileSync(external, 'utf8');
					alreadyThere = parseWords(raw).includes(word);
					if (raw.includes('\r\n')) eol = '\r\n';
				} catch {
					alreadyThere = false;
				}
				if (!alreadyThere) {
					fs.appendFileSync(external, `${word}${eol}`);
					try {
						lastExternalMtimeMs = fs.statSync(external).mtimeMs;
					} catch {
						/* ignore */
					}
				}
			} catch {
				// eslint-disable-next-line no-console
				console.warn(`[harper] could not append to external dictionary: ${external}`);
			}
		} else if (!cfg.dictionaryNoteId) {
			// No external file AND no dictionary note: fall back to the plugin-local list so the word
			// still persists across desktop sessions.
			try {
				fs.appendFileSync(await localWordsPath(), `${word}\n`);
			} catch {
				// eslint-disable-next-line no-console
				console.warn('[harper] could not write plugin-local userWords.txt');
			}
		}
	}
}

/**
 * PERSIST ONE REMOVED WORD — the mirror of persistAddedWord.
 *
 * The durable sides (note, external file) are NOT touched here: runReconcile already owns writing
 * them, with the L3 note-write gate, the mtime-checked atomic file rewrite and the presence gate.
 * Feeding the removal into the buffer and letting that machinery run is the whole point — the only
 * thing this has to handle itself is `userWords.txt`, the desktop-local additive fallback, which
 * sits OUTSIDE the merge and would otherwise keep re-supplying the word forever.
 */
async function persistRemovedWord(word: string): Promise<void> {
	await addPendingRemoval(word);
	if (isMobile()) return;
	try {
		const path = cachedLocalWordsPath || (await localWordsPath());
		const fs = getFs();
		const raw: string = fs.readFileSync(path, 'utf8');
		const kept = raw
			.split('\n')
			.filter((line) => line.replace(/\r$/, '').trim() !== word);
		const next = kept.join('\n');
		if (next !== raw) fs.writeFileSync(path, next, 'utf8');
	} catch {
		// No plugin-local list (the common case once a note or file is configured) — nothing to prune.
	}
}

async function addWord(rawWord: string): Promise<void> {
	const word = (rawWord || '').trim();
	if (!word) return;

	// 1) Immediate UX (both platforms): into the in-memory set now, so the underline clears at once.
	const linter = await getLinter();
	await linter.importWords([word]);
	importedWordsKey = null; // the engine now holds more than the last reconciled list

	await persistAddedWord(word);

	await pokeForceLint();
}

/**
 * Dismiss the finding on this exact span.
 *
 * ONE TRANSACTION over all three pieces of a dismissal — harper's in-engine ignore set, the
 * persisted payload mirroring it, and the side table naming the row. This is the CONTENT-SCRIPT
 * channel writing the very same payload the settings dialog's Restore and Clear write from theirs,
 * so the lock has to span both channels: otherwise a dismissal landing inside a restore's
 * read-modify-write leaves its brand-new hash destroyed, or the restore's stale copy puts a
 * just-restored hash back with no row left to name it.
 *
 * The linter is resolved BEFORE entering, because getLinter() runs applyConfiguration, which takes
 * this same lock to re-hydrate the ignore state.
 */
async function ignoreFinding(
	text: string,
	start: number,
	end: number,
	ruleName: string,
): Promise<void> {
	const linter = await getLinter();
	await withDismissalTransaction(dismissedStore, () =>
		ignoreFindingInTransaction(linter, text, start, end, ruleName),
	);
	await pokeForceLint();
}

async function ignoreFindingInTransaction(
	linter: LocalLinter,
	text: string,
	start: number,
	end: number,
	ruleName: string,
): Promise<void> {
	// harper stores an ignored lint by a context hash and filters it out of every SUBSEQUENT lint
	// itself. It surfaces overlapping findings one at a time, so to make "Ignore" actually clear the
	// span the user pointed at we ignore every finding on that exact span, re-linting after each until
	// the span is clear (bounded so a pathological doc can't spin forever).
	const matchSpan = (lint: Lint) => {
		const s = lint.span();
		return s.start === start && s.end === end;
	};
	// SIDE-TABLE CAPTURE (v1.4.0): harper only ever stores an opaque context hash, so the readable
	// record for the "dismissed findings" manager has to be taken HERE, while the Lint handle that
	// produced it is still alive. Every hash is kept as a decimal STRING — see src/dismissedLog.ts for
	// why a u64 must never become a JS number. Capturing changes nothing about the loop below: the
	// same findings are ignored, in the same order, under the same bound.
	const hashes: string[] = [];
	let recordedRule = '';
	let recordedText = '';
	let ignoredAny = false;
	for (let i = 0; i < 20; i++) {
		const organized = await linter.organizedLints(text, lintOptions());
		let target: Lint | undefined = (organized[ruleName] || []).find(matchSpan);
		let targetRule = ruleName;
		if (!target) {
			for (const [key, lints] of Object.entries(organized)) {
				const m = lints.find(matchSpan);
				if (m) {
					target = m;
					targetRule = key;
					break;
				}
			}
		}
		if (!target) break;
		// Before ignoring: the hash identifying this exact finding, and (first pass only) the labels
		// the manager will list it under — the first target is the finding the user actually clicked.
		try {
			hashes.push(String(await linter.contextHash(text, target)));
		} catch {
			// No hash for this one: it degrades to a "legacy" dismissal (still ignored, just not
			// individually restorable). Never a reason to skip the ignore the user asked for.
		}
		if (!recordedRule) {
			recordedRule = targetRule;
			recordedText = target.get_problem_text();
		}
		await linter.ignoreLint(text, target);
		ignoredAny = true;
	}
	if (ignoredAny) {
		try {
			// ADDITIVE, NEVER A MIRROR. Dismissing only ever ADDS an ignore, so persisting must be a
			// union of what is already stored with what this dismissal produced — not a wholesale copy
			// of the engine. Mirroring the engine made this the one destructive writer of the payload:
			// any moment the engine's ignore set was empty or partial (a dialect switch frees and
			// rebuilds the WASM instance; a failed re-configure leaves it bare) turned the next Dismiss
			// into a wipe of every earlier dismissal. Removal has exactly one owner — the dismissed
			// manager's restore/clear, which rebuilds from the persisted payload — and this is not it.
			//
			// Both sides are lifted with `extractHashes` and rebuilt with `buildIgnoredLintsPayload`,
			// the regex/string pair that exists because these are u64s a JSON round trip would corrupt.
			const exported = await linter.exportIgnoredLints();
			const stored = await loadIgnoredLintsJson();
			const union = [...new Set([...extractHashes(stored), ...extractHashes(exported)])];
			await saveIgnoredLintsJson(buildIgnoredLintsPayload(union));
		} catch {
			// eslint-disable-next-line no-console
			console.warn('[harper] could not persist ignored lints');
		}
		// One entry per user-visible "Dismiss", carrying every hash that dismiss produced. Skipped when
		// no hash could be computed: an entry with no hashes is neither restorable nor matchable.
		const id = makeEntryId(hashes);
		if (id) {
			try {
				await appendDismissedInTransaction(dismissedStore, {
					id,
					hashes,
					ruleName: recordedRule || ruleName,
					problemText: recordedText,
					dismissedAt: new Date().toISOString(),
				});
			} catch {
				// eslint-disable-next-line no-console
				console.warn('[harper] could not record the dismissed-findings entry');
			}
		}
	}
}

/**
 * BULK DICTIONARY EDIT — the primitive the settings dialog's word editor saves through.
 *
 * It is exactly addWord's persistence, batched, plus its mirror for deletions: both halves land in
 * the pending buffers and the desktop-local list, and then ONE reconcile writes the durable sides.
 * Nothing about the note/file mirroring, the L3 note-write gate or the deletion propagation is
 * re-implemented here — runReconcile still owns all of it.
 */
async function applyWordEdits(adds: string[], removes: string[]): Promise<string[]> {
	for (const word of adds) {
		const trimmed = (word || '').trim();
		if (trimmed) await persistAddedWord(trimmed);
	}
	for (const word of removes) {
		const trimmed = (word || '').trim();
		if (trimmed) await persistRemovedWord(trimmed);
	}
	// Import the additions into the live engine right away so their underlines clear immediately;
	// removals need the full clear-then-import that reconcileAndApply performs below.
	if (adds.length && linterPromise) {
		try {
			await (await linterPromise).importWords(adds);
			importedWordsKey = null; // the engine now holds more than the last reconciled list
		} catch {
			/* the reconcile below still applies them */
		}
	}
	// One reconcile for the whole batch: merges, writes the sides, and pushes the result to the
	// engine (clear-then-import, which is how a DELETED word stops being accepted).
	//
	// FRESH, not joined: the writes above happened after any pass already in flight took its snapshot
	// of the pending buffers, so joining that pass would return a word set this save is not in — the
	// note would go unwritten and the stale clear-then-import would take the just-added words back out
	// of the engine, while the dialog reported them saved.
	const words = await reconcileAndApply('dictionary-editor', true);
	await pokeForceLint();
	return words;
}

const settingsService: SettingsService = createSettingsService({
	getLinter,
	pokeForceLint,
	getSetting: (key: string) => joplin.settings.value(key),
	setSetting: (key: string, value: any) => joplin.settings.setValue(key, value),
	isMobile,
	loadIgnoredLintsRaw: loadIgnoredLintsJson,
	saveIgnoredLintsRaw: saveIgnoredLintsJson,
	dismissedStore,
	getEffectiveWords: () => reconcileDictionary('settings-snapshot'),
	applyWordEdits,
	dialectNames: Object.keys(DIALECT_BY_NAME),
});

async function disableRule(ruleName: string): Promise<void> {
	if (!ruleName) return;
	const overrides = parseRuleOverrides();
	overrides[ruleName] = false;
	// Persist into the user-visible setting; this fires onChange, which reconfigures + pokes.
	await joplin.settings.setValue('ruleOverrides', JSON.stringify(overrides));
	// Apply directly too, so it takes effect even if onChange is debounced.
	const linter = await getLinter();
	await linter.setLintConfig(overrides);
	await pokeForceLint();
}

// =============================================================================
// SETTINGS DIALOG (Phase 2) — the webview half lives in src/settingsDialog.{js,css}.
// =============================================================================
// The whole screen (general options, the ~823-rule browser, the dictionary editor and the dismissed
// findings) is ONE dialog driven entirely by postMessage. Four things about this are non-obvious and
// each one is load-bearing:
//
//   1. MESSAGING GOES THROUGH `views.panels`. `joplin.views.dialogs` has no onMessage/postMessage at
//      all, but a dialog handle and a panel handle are the same WebviewController underneath, so
//      `panels.onMessage(dialogHandle, cb)` is the supported way to talk to a dialog webview (the
//      pattern Freehand Drawing, Jarvis and the Tagging plugin all use).
//   2. THE WEBVIEW RENDERS ITSELF. `setHtml` does not re-run scripts, so a server-side re-render
//      would paint HTML with no behaviour attached. The shell below is a single empty root; the
//      script asks for `settings:snapshot` and builds everything client-side.
//   3. `setFitToContent(false)` IS REQUIRED for the dialog to get a real viewport (90vw x 90vh on
//      desktop), and the CSS then has to supply its own scroll box because desktop dialog documents
//      set `html { overflow: hidden }`.
//   4. THE DIALOG IS BUILT LAZILY. onStart's budget is guarded by a test; creating a view, setting
//      its HTML and loading two assets is cheap but pointless until someone opens the thing.

const SETTINGS_DIALOG_HTML = '<div id="harper-settings"></div>';

/**
 * The dialog's message endpoint.
 *
 * `settingsService.handleMessage` REJECTS for a bad value (unknown setting key, invalid dialect,
 * dictionaryPath on mobile). A rejection here would leave the webview's `postMessage` promise pending
 * forever with no way to tell the user why, so failures are converted into a value the webview can
 * read and show: `{__error}`.
 */
async function handleSettingsDialogMessage(message: unknown): Promise<unknown> {
	try {
		return await settingsService.handleMessage(message);
	} catch (error) {
		return { __error: String((error as Error)?.message || error) };
	}
}

let settingsDialogPromise: Promise<string> | null = null;

async function buildSettingsDialog(): Promise<string> {
	const handle = await joplin.views.dialogs.create('harperSettingsDialog');
	await joplin.views.dialogs.setHtml(handle, SETTINGS_DIALOG_HTML);
	await joplin.views.dialogs.addScript(handle, './settingsDialog.css');
	await joplin.views.dialogs.addScript(handle, './settingsDialog.js');
	// ONE button. There is no form and no formData round-trip — every change has already been saved by
	// the time the user gets here, so "Close" is the only honest label.
	await joplin.views.dialogs.setButtons(handle, [{ id: 'ok', title: 'Close' }]);
	await joplin.views.dialogs.setFitToContent(handle, false);
	await joplin.views.panels.onMessage(handle, handleSettingsDialogMessage);
	return handle;
}

/**
 * Build once, reuse forever. Concurrent opens await the same in-flight construction (the assignment
 * happens before any await, so a second caller cannot start a second build).
 *
 * A FAILED build must not be memoized: holding on to the rejected promise would make every later
 * open re-throw the original error, leaving the command permanently dead until Joplin restarts. One
 * transient failure during startup would cost the user the whole settings screen for the session.
 */
function getSettingsDialog(): Promise<string> {
	if (!settingsDialogPromise) {
		settingsDialogPromise = buildSettingsDialog().catch((error) => {
			settingsDialogPromise = null; // let the next open try again
			throw error;
		});
	}
	return settingsDialogPromise;
}

async function openSettingsDialog(): Promise<void> {
	const handle = await getSettingsDialog();
	// A REOPEN may reuse a webview that was never torn down, in which case the script does not re-run
	// and the user would be shown the state from the previous open. This nudge makes it re-fetch. When
	// the webview really was unmounted the message is simply dropped and the script's own load covers
	// it — reloading twice is the same idempotent fetch, so both paths are safe.
	try {
		joplin.views.panels.postMessage(handle, { type: 'settings:refresh' });
	} catch {
		/* older API without postMessage on a dialog handle — the script's own load still runs */
	}
	await joplin.views.dialogs.open(handle);
}

/**
 * Wire the command and its two platform-specific entry points.
 *
 * DESKTOP gets a Tools menu item (and the command palette for free). MOBILE has no menus at all, so
 * the note toolbar — which surfaces plugin buttons in the note's "..." overflow menu — is the only
 * place a plugin can put a top-level action there.
 *
 * THE COMMAND IS REGISTERED UNCONDITIONALLY, in every mode and on both platforms. Only the visible
 * ENTRY POINT answers to the surface switch, and it does so identically on the two platforms: with
 * the switch off the native page carries the basic settings, and an entry beside it is exactly the
 * duplication the switch exists to remove.
 *
 * The two platforms are NOT equally forgiving about that, which is why the switch's description
 * differs. On desktop the command palette still opens the window, so nothing is ever unreachable. On
 * mobile the toolbar button is the only way in — no menus, no palette — so switching off really does
 * put the rule browser, the dictionary editor and the dismissed findings out of reach until the
 * switch is turned back on from this same native page. That is the user's explicit choice, made per
 * device (the setting is File storage, so it does not travel), and the mobile copy states it.
 */
async function registerSettingsDialogCommand(): Promise<void> {
	await joplin.commands.register({
		name: 'harper.openSettings',
		label: 'Harper: Settings…',
		iconName: 'fas fa-spell-check',
		execute: async () => {
			await openSettingsDialog();
		},
	});

	if (!manageInDialog) return; // the native page owns the settings this session — no second entry

	if (isMobile()) {
		await joplin.views.toolbarButtons.create(
			'harperSettingsButton',
			'harper.openSettings',
			ToolbarButtonLocation.NoteToolbar,
		);
	} else {
		await joplin.views.menuItems.create(
			'harperSettingsMenuItem',
			'harper.openSettings',
			MenuItemLocation.Tools,
		);
	}
}

// -----------------------------------------------------------------------------
// Create-dictionary-note command (both platforms).
// -----------------------------------------------------------------------------
async function createDictionaryNote(): Promise<void> {
	// Reuse an existing configured note if it is still readable, so the command is idempotent.
	if (cfg.dictionaryNoteId) {
		try {
			await joplin.data.get(['notes', cfg.dictionaryNoteId], { fields: ['id'] });
			return; // already have a live dictionary note
		} catch {
			/* stale id — fall through and create a fresh one */
		}
	}
	// Place it in the currently selected folder if we can, else the first folder, else create one.
	let folderId = '';
	try {
		const selected = await joplin.workspace.selectedFolder();
		if (selected && selected.id) folderId = selected.id;
	} catch {
		/* no selected folder */
	}
	if (!folderId) {
		try {
			const folders = await joplin.data.get(['folders']);
			const items: Array<{ id: string }> = (folders && folders.items) || [];
			if (items.length) folderId = items[0].id;
		} catch {
			/* ignore */
		}
	}
	if (!folderId) {
		const folder = await joplin.data.post(['folders'], null, { title: 'Harper' });
		folderId = folder.id;
	}
	// Seed with any words already known to the linter session (pending buffer) so nothing is lost.
	const seed = await readPendingWords();
	const body = canonicalDictionaryBody(seed);
	const note = await joplin.data.post(['notes'], null, {
		title: DICTIONARY_NOTE_TITLE,
		body,
		parent_id: folderId,
	});
	// Persist the id (settings write — safe). onChange reacts: resets the merge base and reconciles.
	await joplin.settings.setValue('dictionaryNoteId', note.id);
}

// -----------------------------------------------------------------------------
// Dictionary polling (60s): desktop file mtime + dictionary-note updated_time.
// -----------------------------------------------------------------------------
function pollDictionaryTick(): void {
	// CHEAP CHANGE DETECTION FIRST: a `statSync` for the file (no read) and an `updated_time`-only
	// GET for the note. When neither moved, the tick costs ZERO file reads and does no work at all.
	// When either moved, ONE reconcile handles both sides (additions AND deletions) and refreshes the
	// engine — that is how a word deleted on another device stops being accepted here.
	let fileMoved = false;
	if (!isMobile()) {
		const p = expandTilde(cfg.dictionaryPath);
		if (p) {
			let st: any;
			try {
				st = getFs().statSync(p);
			} catch {
				st = null;
			}
			if (st && (lastExternalMtimeMs === null || st.mtimeMs !== lastExternalMtimeMs)) fileMoved = true;
			// A file that vanished is NOT a change to act on: readExternalFile would report "no file
			// side", so reconciling now could only churn. It is picked up when the file comes back.
		}
	}

	void (async () => {
		let noteMoved = false;
		if (cfg.dictionaryNoteId) {
			try {
				const note = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
					fields: ['updated_time'],
				});
				const ut = (note && note.updated_time) || null;
				noteMoved = lastNoteUpdatedTime === null || ut !== lastNoteUpdatedTime;
			} catch {
				noteMoved = false; // note unreadable this tick
			}
		}
		if (!fileMoved && !noteMoved) return; // ZERO extra work when nothing changed
		await reconcileAndApply(fileMoved && noteMoved ? 'poll' : fileMoved ? 'file-poll' : 'note-poll');
	})();
}

// -----------------------------------------------------------------------------
// Message handler.
// -----------------------------------------------------------------------------
async function handleMessage(message: IncomingMessage | unknown): Promise<unknown> {
	if (!message || typeof message !== 'object') return null;
	// SETTINGS-SERVICE CHANNEL (Phase 1). The 'settings:*' namespace is the whole surface the Phase-2
	// settings dialog drives. It is answered here as well as (eventually) on the dialog's own
	// onMessage because the service is deliberately transport-agnostic: one implementation, reachable
	// from either side, and testable today without any UI.
	const type = (message as { type?: unknown }).type;
	if (typeof type === 'string' && type.startsWith('settings:')) {
		return settingsService.handleMessage(message);
	}
	const msg = message as IncomingMessage;
	switch (msg.type) {
		case 'getConfig': {
			// A content-script handshake means an editor is open (L3 tracking).
			editorOpen = true;
			const enabled = await joplin.settings.value('enabled');
			const debounceMs = await joplin.settings.value('debounceMs');
			// Read live (not from `cfg`) exactly like the other two, so the value the content script
			// gets after a `harper.forceLint` poke is always the just-saved one — this is what makes
			// an underline-style change apply without reopening the note.
			const underlineStyle = await joplin.settings.value('underlineStyle');
			return {
				enabled: enabled !== false,
				debounceMs: typeof debounceMs === 'number' ? debounceMs : 500,
				underlineStyle: underlineStyle === 'solid' ? 'solid' : 'squiggly',
				// The content script sizes its tap targets off this (>=44 px on mobile).
				platform: isMobile() ? 'mobile' : 'desktop',
				// The multi-window refresh dedupe token: the content script records which generation a
				// getConfig-driven refresh served, keeping a poke-plus-subscription overlap in the
				// focused window to AT MOST one redundant relint (the two getConfigs race, so the
				// second usually still sees a not-yet-updated token) — and never a missed one.
				generation: configGeneration,
			};
		}
		case 'waitForRefresh':
			return waitForRefresh(typeof msg.generation === 'number' ? msg.generation : -1);
		case 'lint':
			return lintText(msg.text ?? '');
		case 'addWord':
			await addWord(msg.word);
			return { ok: true };
		case 'ignoreLint':
			await ignoreFinding(msg.text ?? '', msg.start, msg.end, msg.ruleName);
			return { ok: true };
		case 'disableRule':
			await disableRule(msg.ruleName);
			return { ok: true };
		default:
			return null;
	}
}

// -----------------------------------------------------------------------------
// Settings registration. Platform is resolved BEFORE this runs, so externalDictionaryPath (a
// FilePath-style setting unsupported on mobile) is registered on DESKTOP ONLY; everything else on both.
//
// TWO registerSettings CALLS, in this order, and the order is the whole design:
//   1. the surface switch ALONE — it must exist before it can be read, and reading an unregistered
//      key throws "Unknown key" in real Joplin;
//   2. read it;
//   3. everything else, with `public:` derived from what step 2 returned.
// registerSettings is additive in Joplin, so two calls register one combined set.
// -----------------------------------------------------------------------------

/**
 * The switch's own description, per platform — because the entry point it names differs. Desktop
 * opens the window from the Tools menu; mobile has no menus at all and reaches it from the note
 * toolbar, so naming a Tools menu there would describe nothing the user can find.
 *
 * The copy argues the default rather than merely stating it: the window holds all four things, this
 * screen can only ever hold one of them, and THAT asymmetry is the reason the window wins by
 * default. Then it says exactly what turning the switch off trades — the basic settings come here,
 * the entry point goes away. It stops there; a draft that also offered the command palette as
 * consolation for the missing menu item buried the actual choice, and it is not true on mobile.
 */
function manageInDialogDescription(): string {
	// Written out in full per platform rather than assembled from shared fragments: this is approved
	// copy, and the three places the two versions diverge (how the window is opened, what Joplin calls
	// this screen, what the entry point disappears from) are exactly the places a clever template
	// would quietly get wrong.
	if (isMobile()) {
		return (
			'Harper\'s settings live in their own window — open a note and choose Harper: Settings… ' +
			'from the toolbar menu. The window holds everything: the basic settings, the rule browser, ' +
			'the dictionary editor, and the dismissed findings. This Joplin configuration screen can ' +
			'show only the basic settings — that is why this switch is on by default. Turn it off and ' +
			'the basic settings appear here instead, while Harper: Settings… disappears from the ' +
			'toolbar menu. Restart Joplin to apply.'
		);
	}
	return (
		'Harper\'s settings live in their own window — open it with Tools → Harper: Settings…. The ' +
		'window holds everything: the basic settings, the rule browser, the dictionary editor, and ' +
		'the dismissed findings. This Joplin options page can show only the basic settings — that is ' +
		'why this switch is on by default. Turn it off and the basic settings appear here instead, ' +
		'while Harper: Settings… disappears from the Tools menu. Restart Joplin to apply.'
	);
}

/**
 * The SECTION banner, matched to the mode that is actually active.
 *
 * PLAIN TEXT ONLY — Joplin renders a section description as literal text, so a link here would show
 * up as raw markup. It is one line in every case, because the switch's own description sits a few
 * pixels below it and makes the full argument; a second paragraph here would be the same text twice.
 *
 * ON: the page is otherwise empty, so the banner's whole job is to say where the settings went and
 * how to get there — spelled out as the real path, per platform, since this is the one line a user
 * who cannot find the fields will actually read.
 *
 * OFF: the fields are right here and the banner has nothing left to route anyone to, so it says only
 * what the section is. (The window is then reachable from the command palette on desktop; nothing on
 * this screen advertises that, which is the approved trade for a page that no longer needs a banner.)
 */
function sectionDescription(): string {
	if (!manageInDialog) return 'Harper grammar checker settings.';
	if (isMobile()) {
		return (
			'Harper grammar checker. Settings are managed in the Harper window: open a note and ' +
			'choose Harper: Settings… from the toolbar menu.'
		);
	}
	return 'Harper grammar checker. Settings are managed in the Harper window: Tools → Harper: Settings….';
}

async function registerSettings(): Promise<void> {
	// STEP 1 + 2 — the switch, registered alone and FIRST, then read. Always `public: true`: it is the
	// one control that must stay reachable on the native page in either mode, or a user who turned the
	// basic settings off would have no way to turn them back on.
	//
	// This runs BEFORE registerSection deliberately: the section's own wording depends on the answer.
	// Joplin resolves a setting's `section` when the settings SCREEN is built, long after onStart, and
	// registerSetting itself never looks the section up, so registering into a section that is
	// declared a few lines below is safe. It is also self-policing in practice: if this order threw,
	// onStart would throw with it and the plugin would not load at all — which is exactly what the
	// e2e suite boots a real Joplin to check, on every spec.
	await joplin.settings.registerSettings({
		[MANAGE_IN_DIALOG_KEY]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION,
			label: 'Manage settings in the Harper window',
			description: manageInDialogDescription(),
			storage: SettingStorage.File,
		},
	});
	// Default TRUE, so anything that is not an explicit `false` means "the Harper window owns them".
	manageInDialog = (await joplin.settings.value(MANAGE_IN_DIALOG_KEY)) !== false;

	await joplin.settings.registerSection(SECTION, {
		label: 'Harper',
		description: sectionDescription(),
		iconName: 'fas fa-spell-check',
	});

	// STEP 3 — the rest. `basicPublic` is the ONLY thing the switch changes here: same keys, same
	// defaults, same types, same section, same storage, registered unconditionally in both modes.
	const basicPublic = !manageInDialog;

	const defs: Record<string, any> = {
		enabled: {
			value: true,
			type: SettingItemType.Bool,
			public: basicPublic,
			section: SECTION,
			label: 'Enable Harper grammar checking',
			description: 'When off, no grammar/spelling underlines are shown.',
			storage: SettingStorage.File,
		},
		dialect: {
			value: 'American',
			type: SettingItemType.String,
			public: basicPublic,
			isEnum: true,
			section: SECTION,
			label: 'English dialect',
			description: 'Changing the dialect reconfigures the linter.',
			options: {
				American: 'American',
				British: 'British',
				Australian: 'Australian',
				Canadian: 'Canadian',
				Indian: 'Indian',
			},
			storage: SettingStorage.File,
		},
		debounceMs: {
			value: 500,
			type: SettingItemType.Int,
			public: basicPublic,
			section: SECTION,
			minimum: 0,
			maximum: 10000,
			step: 50,
			label: 'Lint debounce (ms)',
			description: 'Idle delay after typing before re-linting. Changes apply immediately.',
			storage: SettingStorage.File,
		},
		// BOTH platforms: this only selects which CSS class the content script puts on each lint
		// decoration, so there is nothing desktop-specific about it (no fs, no note write — mobile-safe).
		underlineStyle: {
			value: 'squiggly',
			type: SettingItemType.String,
			public: basicPublic,
			isEnum: true,
			section: SECTION,
			label: 'Underline style',
			description:
				'How findings are underlined: Harper\'s wavy squiggle, or a straight solid line with a ' +
				'light tint. Changes apply immediately.',
			options: {
				squiggly: 'Squiggly (default)',
				solid: 'Solid line',
			},
			storage: SettingStorage.File,
		},
		// BOTH platforms: this only flips a harper LintOption on each lint call — no fs, no note write.
		ignoreNonEnglish: {
			value: false,
			type: SettingItemType.Bool,
			public: basicPublic,
			section: SECTION,
			label: 'Ignore non-English text',
			description:
				'Skip text that Harper detects as not English. Useful for multilingual notes. ' +
				'Off by default.',
			storage: SettingStorage.File,
		},
		dictionaryNoteId: {
			value: '',
			type: SettingItemType.String,
			public: basicPublic,
			section: SECTION,
			label: 'Dictionary note id',
			description:
				'The id of a Joplin note used as your Harper dictionary (one word per line). It syncs ' +
				'across all your devices. Use the "Harper: Create dictionary note" command to make one, ' +
				'or paste an existing note id here. Leave empty to disable the dictionary note.',
			storage: SettingStorage.File,
		},
		ruleOverrides: {
			value: '',
			type: SettingItemType.String,
			public: basicPublic,
			advanced: true,
			section: SECTION,
			label: 'Rule overrides (JSON)',
			description:
				'A JSON object of {"RuleName": true|false} applied on top of the defaults, e.g. ' +
				'{"SpelledNumbers": false}. Invalid JSON is ignored.',
			storage: SettingStorage.File,
		},
		// Private (public:false) buffers — invisible in the settings UI on both platforms.
		pendingWords: {
			value: [],
			type: SettingItemType.Array,
			public: false,
			section: SECTION,
			label: 'Pending dictionary words (internal)',
			storage: SettingStorage.File,
		},
		// v1.4.0: the mirror of pendingWords for the dictionary editor's delete half.
		[PENDING_REMOVALS_KEY]: {
			value: [],
			type: SettingItemType.Array,
			public: false,
			section: SECTION,
			label: 'Pending dictionary removals (internal)',
			storage: SettingStorage.File,
		},
		ignoredLints: {
			value: '',
			type: SettingItemType.String,
			public: false,
			section: SECTION,
			label: 'Ignored lints (internal)',
			storage: SettingStorage.File,
		},
		// v1.4.0: the readable side table over the ignore hashes above (mobile's backing store; on
		// desktop the same JSON lives in dataDir/dismissedMeta.json). Registered on BOTH platforms so
		// the key always reads back cleanly, and excluded from the onChange reconfigure below.
		[DISMISSED_META_KEY]: {
			value: '',
			type: SettingItemType.String,
			public: false,
			section: SECTION,
			label: 'Dismissed findings index (internal)',
			storage: SettingStorage.File,
		},
		// v1.3.0: the three-way merge base — the word set as it stood after the last successful
		// reconcile, as a JSON array. A String (not an Array) setting so it round-trips byte-exactly
		// and an empty string can mean "no base yet" (first run => adopt the union, infer no deletions).
		// Registered on BOTH platforms: settings writes are L4-safe everywhere, including mid-edit.
		[SYNC_BASE_KEY]: {
			value: '',
			type: SettingItemType.String,
			public: false,
			section: SECTION,
			label: 'Dictionary sync base (internal)',
			storage: SettingStorage.File,
		},
	};

	// DESKTOP ONLY: the external dictionary file. Its path relies on a real filesystem (fs read + the
	// FilePath UX), neither of which exists on mobile — so we do not register it there at all. Platform
	// is already resolved when this runs, so this conditional is decided correctly on both apps.
	if (!isMobile()) {
		defs.dictionaryPath = {
			value: '',
			type: SettingItemType.String,
			public: basicPublic,
			section: SECTION,
			label: 'External dictionary file (desktop)',
			description:
				'Absolute path to a plain-text dictionary (one word per line), e.g. ' +
				'~/.local/share/harper-dictionary/dictionary.txt. Leave empty to use the plugin-local list ' +
				'or the dictionary note. Words added via "Add to dictionary" are appended here when set. ' +
				'Re-read every 60s. When a dictionary note is ALSO set, the file and note mirror each other, ' +
				'deletions included: removing a word from either one removes it from the other.',
			storage: SettingStorage.File,
		};
	}

	await joplin.settings.registerSettings(defs);
}

// =============================================================================
// COLD-START: background warm-up (v1.1.1).
// =============================================================================
// onStart must return FAST — it wires only the cheap registrations (see the onStart handler below).
// Everything heavy is kicked off HERE, AFTER onStart returns, so it overlaps the user opening/reading a
// note instead of blocking the plugin's onStart handler (device-measured cold start was ~7.7 s):
//   1. ENGINE WARM-UP — build the LocalLinter + apply the dictionary/overrides/ignored-lints config
//      (LocalLinter.setup() is ~1.5-2 s on mobile). Started immediately so the FIRST lint is served warm.
//      A lint request that arrives before warm-up finishes just awaits the SAME in-flight linterPromise
//      (getLinter is idempotent via its `if (!linterPromise)` guard) — never a rebuild, never an error;
//      the underlines simply appear a moment later, warm.
//   2. START RECONCILE — merge the dictionary sources (persisting any words buffered by a previous
//      session, and propagating anything deleted elsewhere while this device was closed). Still
//      L3-guarded (the note write is skipped while an editor is open) and serialized.
// Both are fire-and-forget and independently error-caught, so onStart is unblocked and neither task can
// take the other (or the plugin) down. Guarded so a mobile double-mount cannot warm twice.
let backgroundInitStarted = false;

async function warmUpEngine(): Promise<void> {
	try {
		// getLinter() builds the linter AND applies configuration in one shared promise; concurrent
		// callers (an early lint, a double-mount) await the same instance — no second buildLinter.
		await getLinter();
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn('[harper] background engine warm-up failed:', error);
		return;
	}
	// Reconcile: if the dictionary words finished importing only now, poke any open editor to re-lint so
	// late-arriving words clear their underlines. A no-op when no editor is open.
	await pokeForceLint();
}

function startBackgroundInit(): void {
	if (backgroundInitStarted) return; // idempotent — a mobile double-mount must not warm twice
	backgroundInitStarted = true;
	void warmUpEngine();
	// Reconcile only — no engine push. The warm-up's own applyConfiguration is the single startup
	// import (it joins THIS reconcile when the two overlap, so the sources are read once), and a
	// second concurrent clear-then-import would race it. reconcileDictionary never rejects.
	void reconcileDictionary('plugin-start');
}

joplin.plugins.register({
	onStart: async () => {
		// ---------------------------------------------------------------------------------------------
		// EAGER — the cheap, fast registrations ONLY. Target: well under 500 ms of handler time, with
		// ZERO engine build, ZERO joplin.data.get/put and ZERO fs reads. Anything heavier is deferred to
		// startBackgroundInit() AFTER this handler returns (see the cold-start note above). The harness
		// budget test asserts exactly this: onStart awaits none of that work.
		// ---------------------------------------------------------------------------------------------

		// Resolve platform FIRST — every branch below (settings registration, fs guards, flush
		// discipline) keys off it, and it must be known before registerSettings runs.
		await resolvePlatform();

		await registerSettings();
		await loadSettings();

		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, handleMessage);

		// Command to create the dictionary note (both platforms; appears in the command palette).
		await joplin.commands.register({
			name: 'harper.createDictionaryNote',
			label: 'Harper: Create dictionary note',
			execute: async () => {
				await createDictionaryNote();
			},
		});

		// The settings dialog: command + Tools menu item (desktop) or note-toolbar button (mobile).
		// Registration only — the dialog itself is built on first open, so onStart stays cheap. Guarded
		// because a host without menuItems/toolbarButtons must not take the whole plugin down with it.
		try {
			await registerSettingsDialogCommand();
		} catch (error) {
			// eslint-disable-next-line no-console
			console.warn('[harper] settings dialog registration failed:', error);
		}

		// Reconfigure + re-lint whenever settings change.
		await joplin.settings.onChange(async ({ keys }) => {
			// INTERNAL bookkeeping keys are written BY the reconcile itself. Reacting to them would make
			// a reconcile call itself back (and, in the worst case, deadlock on its own in-flight
			// promise), so they are filtered out here — nothing user-visible changed.
			//
			// MANAGE_IN_DIALOG_KEY is filtered for a different reason: it changes NOTHING at runtime.
			// It is read once, during registration, and there is no Joplin API to re-register a setting
			// or a menu item — so a flip takes effect at the next start, exactly as its description
			// says. Reacting would run a full reconfigure (loadSettings, an engine reconcile, a relint)
			// to arrive at the identical state, which is churn at best and, since a reconcile is a real
			// dictionary pass, needless risk at worst. A batch that ALSO carries a real key is
			// unaffected: that key survives this filter and drives the reconfigure as usual.
			const external = (keys || []).filter(
				(k) =>
					k !== 'pendingWords' &&
					k !== 'ignoredLints' &&
					k !== SYNC_BASE_KEY &&
					k !== PENDING_REMOVALS_KEY &&
					k !== DISMISSED_META_KEY &&
					k !== MANAGE_IN_DIALOG_KEY,
			);
			if (!external.length) return;

			const before = cfg.dialect;
			const noteIdBefore = cfg.dictionaryNoteId;
			const pathBefore = cfg.dictionaryPath;
			// INV-A: the identity flip and the base reset are ONE transition, bracketed together.
			//
			// Bracketing them separately is not enough. Between the two, `cfg` already names the new
			// note while `syncBase` still describes the old one, and a reconcile that starts there reads
			// that inconsistent pair without anything changing for its duration — so no epoch
			// comparison can catch it. Held as a single transition, any pass beginning anywhere inside
			// is born stale and writes nothing.
			//
			// ONLY FOR KEYS THAT ACTUALLY MOVE IDENTITY OR BASE, though. The epoch exists to protect one
			// thing: a pass's answer is computed from {note, file, base}, and it must not write once any
			// of those has moved. Bracketing every settings write instead abandoned in-flight passes on
			// changes that touch none of them — a dictionary save racing an `underlineStyle` toggle came
			// back reporting success with the new word missing from its own reply, and the dialog then
			// re-seeded the editor from that. `dialect` is deliberately NOT here: it resets ENGINE state
			// (the WASM instance, its words and its ignore set) but moves no side and no base, so a pass
			// in flight across it is still computing the right answer from the right sources. Its own
			// hazards have their own guards — `importedWordsKey = null` forces the word re-import, and
			// INV-B keeps the ignore-set rebuild inside the dismissal transaction.
			const movesDictionaryIdentity =
				external.includes('dictionaryNoteId') ||
				(!isMobile() && external.includes('dictionaryPath'));
			const applySettingsChange = async () => {
				await loadSettings();
				if (!isMobile() && (cfg.dictionaryPath === '' || external.includes('dictionaryPath'))) {
					// A changed path invalidates the cached mtime / missing-file warning.
					lastExternalMtimeMs = null;
					warnedMissingDict = false;
				}
				if (external.includes('dictionaryNoteId') && cfg.dictionaryNoteId !== noteIdBefore) {
					// New/changed dictionary note: force a fresh read next time.
					lastNoteUpdatedTime = null;
				}
				// REPOINTING A SIDE RESETS THE MERGE BASE. A base describes the two sides it was computed
				// from; against a different note or a different file its "missing" words are not
				// deletions at all. Dropping it makes the next reconcile a first run: adopt the union,
				// delete nothing.
				if (
					(external.includes('dictionaryNoteId') && cfg.dictionaryNoteId !== noteIdBefore) ||
					(!isMobile() && external.includes('dictionaryPath') && cfg.dictionaryPath !== pathBefore)
				) {
					await resetSyncBase();
				}
			};
			// Every key that can reach `resetSyncBase` above is inside `movesDictionaryIdentity`, so the
			// flip and the reset are still one bracketed transition whenever either can happen.
			if (movesDictionaryIdentity) await withDictionaryEpochBump(applySettingsChange);
			else await applySettingsChange();
			if (linterPromise) {
				const linter = await linterPromise;
				if (external.includes('dialect') && cfg.dialect !== before) {
					// INV-B: setDialect FREES the WASM instance and builds a new one, so it destroys the
					// engine's IGNORE SET as well as its words — and `applyConfiguration` only re-hydrates
					// the ignore set at the very end of its body, after a full reconcile. For that whole
					// stretch the engine ignores nothing while the persisted payload is full, and a Dismiss
					// arriving from the content-script channel mirrors that empty engine back over the
					// payload, wiping every earlier dismissal.
					//
					// So the destroy and the re-hydration are ONE step, inside the dismissal transaction,
					// which is what makes a concurrent Dismiss queue behind them instead of observing the
					// gap. The linter is already resolved here, so the documented lock-ordering rule
					// (resolve the linter before entering) holds.
					await withDismissalTransaction(dismissedStore, async () => {
						await linter.setDialect(dialectEnum());
						// The memo that skips an unchanged word re-import must be invalidated too, or
						// `applyConfiguration` would find the reconciled list unchanged, skip the import, and
						// leave the engine with an EMPTY custom dictionary for the rest of the session.
						importedWordsKey = null;
						await rehydrateIgnoredLints(linter);
					});
				}
				// FRESH: this handler has just rewritten `cfg` and, on a repoint, reset the merge base.
				// A pass already in flight snapshotted the state before all of that, so joining it would
				// answer the change with a view of the world that predates it.
				await applyConfiguration(linter, 'settings-change', true);
			} else {
				// No engine yet (warm-up still running): still reconcile, so a repointed note/file is
				// merged and persisted rather than waiting for the first lint.
				await reconcileFresh('settings-change'); // same freshness contract as the branch above
			}
			await pokeForceLint();
		});

		// EDITOR-OPEN tracking + deferred reconcile trigger. A note-selection change means the previously
		// open editor was torn down; mark the editor closed and reconcile (L3-safe because editorOpen is
		// now false and the newly-selected note has no in-progress edits yet), which persists buffered
		// words to the note and propagates any deletion made since the last pass.
		try {
			await joplin.workspace.onNoteSelectionChange(async () => {
				editorOpen = false;
				await reconcileAndApply('note-selection-change');
			});
		} catch {
			// Older API without onNoteSelectionChange — the start reconcile + poll still persist words.
		}

		// Poll for out-of-band dictionary changes (desktop file via rclone; the note via sync). Armed here
		// (synchronously) so it is wired the instant onStart returns — arming a timer touches no engine,
		// data or fs, and its first tick is 60 s out; the tick's own work stays deferred. (The test
		// harness captures setInterval only for the synchronous span of onStart, so this must stay eager.)
		setInterval(pollDictionaryTick, 60_000);

		// ---------------------------------------------------------------------------------------------
		// BACKGROUND — kick off the engine warm-up + the initial dictionary reconcile, both
		// fire-and-forget. Deferred to a fresh macrotask so it starts strictly AFTER onStart's promise
		// resolves: the host records onStart as "done" (fast handler time), THEN the heavy work runs and
		// overlaps the user opening a note. Started last, so every handler above is wired first.
		// ---------------------------------------------------------------------------------------------
		setTimeout(startBackgroundInit, 0);
	},
});
