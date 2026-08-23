import joplin from 'api';
import { ContentScriptType, SettingItemType, SettingStorage } from 'api/types';
import {
	LocalLinter,
	Dialect,
	Lint,
	LintConfig,
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

const CONTENT_SCRIPT_ID = 'harperCm';
const SECTION = 'harper';
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
type IncomingMessage =
	| GetConfigMessage
	| LintMessage
	| AddWordMessage
	| IgnoreLintMessage
	| DisableRuleMessage;

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
	dictionaryPath: string;
	dictionaryNoteId: string;
	ruleOverrides: string;
}
const cfg: HarperConfig = {
	enabled: true,
	dialect: 'American',
	debounceMs: 500,
	underlineStyle: 'squiggly',
	dictionaryPath: '',
	dictionaryNoteId: '',
	ruleOverrides: '',
};

const DIALECT_BY_NAME: Record<string, Dialect> = {
	American: Dialect.American,
	British: Dialect.British,
	Australian: Dialect.Australian,
	Canadian: Dialect.Canadian,
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
 * The null-vs-empty distinction is load-bearing for v1.3.0: an ABSENT side infers no deletions, so a
 * file that rclone has momentarily moved aside cannot wipe the dictionary, while a genuinely empty
 * (but readable) file correctly deletes everything the base remembered.
 */
function readExternalFile(): FileSnapshot | null {
	if (isMobile()) return null;
	const p = expandTilde(cfg.dictionaryPath);
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
async function readDictionaryNote(): Promise<string[] | null> {
	if (!cfg.dictionaryNoteId) return null;
	try {
		const note = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
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

async function addPendingWord(word: string): Promise<void> {
	const current = await readPendingWords();
	if (current.includes(word)) return;
	current.push(word);
	// L4: settings writes are safe mid-edit on mobile (device-proven). This never touches a note.
	await joplin.settings.setValue('pendingWords', current);
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

/** Persist the base. Writes nothing when the serialized value is unchanged (no settings churn). */
async function writeSyncBase(words: string[]): Promise<void> {
	const next = JSON.stringify(words);
	try {
		const current = await joplin.settings.value(SYNC_BASE_KEY);
		if (current === next) return;
	} catch {
		/* fall through and write */
	}
	await joplin.settings.setValue(SYNC_BASE_KEY, next);
}

/** Forget the base, so the NEXT reconcile is a first run (adopt the union, infer no deletions). */
async function resetSyncBase(): Promise<void> {
	try {
		const current = await joplin.settings.value(SYNC_BASE_KEY);
		if (current === '') return;
	} catch {
		/* fall through and write */
	}
	await joplin.settings.setValue(SYNC_BASE_KEY, '');
}

// -----------------------------------------------------------------------------
// Rule overrides (advanced JSON setting).
// -----------------------------------------------------------------------------
let lastInvalidOverridesRaw: string | null = null;

function parseRuleOverrides(): LintConfig {
	const raw = (cfg.ruleOverrides || '').trim();
	if (!raw) return {};
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as LintConfig;
	} catch {
		/* fall through to warn */
	}
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

/** (Re)apply dictionary words, rule overrides and ignored lints to a linter instance. */
async function applyConfiguration(linter: LocalLinter, reason = 'apply-configuration'): Promise<void> {
	if (!isMobile()) cachedLocalWordsPath = await localWordsPath();

	// Dictionary: reconcile the sources (three-way merge, incl. deletions) and clear-then-import the
	// result, so a word deleted on any side stops being accepted by the engine immediately.
	await importWordsIntoLinter(linter, await reconcileDictionary(reason));

	// Rule overrides on top of defaults.
	await linter.setLintConfig(parseRuleOverrides());

	// Ignored lints (persisted between sessions). harper filters these internally on every subsequent
	// lint once imported, so no host-side filtering is needed.
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
// Main -> editor re-lint poke.
// -----------------------------------------------------------------------------
async function pokeForceLint(): Promise<void> {
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
//   persist the new base -> clear the flushed pending buffer -> hand the result to the engine.
//
// WRITE DISCIPLINE (unchanged from v1.2.0, and still the only note-write path in the plugin):
//   * the note is written with `joplin.data.put` ONLY when `editorOpen === false` (L3 — a plugin note
//     write while an editor is open evicts the mobile editor). A needed note write that arrives while
//     an editor is open is simply not performed; the reconcile is idempotent, so the next trigger
//     (selection change, poll, settings change) does it.
//   * the file is rewritten in place, atomically, and only when its content actually changes.
//   * `syncBase` is advanced ONLY when every side that needed writing was written. A partial pass
//     leaves the base alone, so nothing is ever "forgotten" between two halves of a reconcile.
//
// Concurrent callers join the in-flight pass instead of racing it, and `lastEngineWords` keeps the
// last good result so a failed pass leaves the engine's word set alone rather than emptying it.
let reconcilePromise: Promise<string[]> | null = null;
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
 * settings this writes (`syncBase`, `pendingWords`) are filtered out of the settings onChange
 * handler, so a write from inside a reconcile can never call back into one.
 */
function reconcileDictionary(reason: string): Promise<string[]> {
	if (reconcilePromise) return reconcilePromise;
	reconcilePromise = runReconcile(reason).finally(() => {
		reconcilePromise = null;
	});
	return reconcilePromise;
}

async function runReconcile(reason: string): Promise<string[]> {
	try {
		if (!isMobile() && !cachedLocalWordsPath) cachedLocalWordsPath = await localWordsPath();
		// The desktop plugin-local list (userWords.txt) is written ONLY when neither an external file
		// nor a dictionary note is configured, and it has never been mirrored into either side. It stays
		// exactly what it was in v1.2.0: an additive-only local fallback, outside the merge.
		const local = readLocalWords();

		const note = await readDictionaryNote(); // null when there is no readable note side
		const file = readExternalFile(); // null on mobile / no path / unreadable
		if (note === null && file === null) {
			// Nothing durable to reconcile against: keep buffering (exactly as v1.2.0 did) and feed the
			// engine the local fallback plus whatever is in the pending buffer.
			const pendingOnly = await readPendingWords();
			lastEngineWords = [...new Set([...pendingOnly, ...local])];
			return lastEngineWords;
		}

		const pending = await readPendingWords();
		const base = await readSyncBase();
		const merged = mergeDictionary({ base, note, file: file ? file.words : null, pending });

		// --- NOTE side (L3-guarded; the plugin's only data.put) ---------------------------------
		let noteWritten = true;
		if (merged.noteChanged) {
			if (editorOpen) {
				noteWritten = false; // deferred: an editor is open, so a note write is forbidden
			} else {
				await joplin.data.put(['notes', cfg.dictionaryNoteId], null, {
					body: canonicalDictionaryBody(merged.result),
				});
				try {
					const after = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
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
		if (merged.fileChanged && file) fileWritten = rewriteExternalFile(file, merged.result);

		// --- COMMIT: only when every side that needed writing actually got written --------------
		if (noteWritten && fileWritten) {
			await writeSyncBase(merged.result);
			if (pending.length) await joplin.settings.setValue('pendingWords', []);
		}

		if (merged.deleted.length || merged.added.length) {
			// eslint-disable-next-line no-console
			console.info(
				`[harper] dictionary reconcile (${reason}): +${merged.added.length} -${merged.deleted.length}` +
					`${noteWritten && fileWritten ? '' : ' (partial — will retry)'}`,
			);
		}

		lastEngineWords = [...new Set([...merged.result, ...local])];
		return lastEngineWords;
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn(`[harper] dictionary reconcile (${reason}) failed:`, error);
		return lastEngineWords;
	}
}

/** Reconcile, then push the result into the live engine and poke any open editor to re-lint. */
async function reconcileAndApply(reason: string): Promise<void> {
	const words = await reconcileDictionary(reason);
	if (!linterPromise) return; // engine not built yet; its own init will reconcile
	let changed = false;
	try {
		changed = await importWordsIntoLinter(await linterPromise, words);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn('[harper] could not refresh the engine dictionary:', error);
		return;
	}
	// Only poke the editor when the word set actually moved: a selection change or an unchanged poll
	// must not cost an extra full re-lint.
	if (changed) await pokeForceLint();
}

/**
 * DESKTOP: rewrite the external dictionary file so its words are exactly `target`.
 *
 * MINIMAL DIFFS — the file is the user's own, edited by harper-ls/Zed and synced by rclone, so:
 *   * every surviving line is kept verbatim, in its original order (comments and blank lines too);
 *   * only the lines whose word is no longer in `target` are dropped;
 *   * genuinely new words are appended at the end, sorted, using the file's dominant line ending.
 *
 * RCLONE SAFETY — `snapshot` carries the mtime observed when the content was read. If the file has
 * changed since (someone else wrote it while we were merging) the rewrite is ABORTED and retried on
 * the next tick, so a concurrent writer's content is never clobbered by a stale computation. The
 * write itself is atomic: a sibling temp file in the same directory, then `rename`.
 *
 * Returns true when the file now matches `target` (written, or already identical), false when the
 * rewrite was skipped and must be retried.
 */
function rewriteExternalFile(snapshot: FileSnapshot, target: string[]): boolean {
	if (isMobile()) return false;
	const fs = getFs();
	const p = snapshot.path;
	const tmp = `${p}.harper-tmp`;
	const keep = new Set(target);
	const eol = snapshot.raw.includes('\r\n') ? '\r\n' : '\n';

	// Split into lines WITHOUT the trailing empty piece a final newline produces, so the file's
	// original trailing-newline shape is reproduced exactly rather than doubled.
	const hadTrailingNewline = snapshot.raw.endsWith('\n');
	const body = hadTrailingNewline ? snapshot.raw.slice(0, -1) : snapshot.raw;
	const lines = body.length ? body.split('\n') : [];

	const kept: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const word = line.replace(/\r$/, '').trim();
		const isWordLine = word.length > 0 && !word.startsWith('# ');
		if (isWordLine && !keep.has(word)) continue; // deleted elsewhere — drop this line
		if (isWordLine) seen.add(word);
		kept.push(line); // comments, blank lines and surviving words stay byte-identical
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
	const organized = await linter.organizedLints(text, { language: 'markdown' });
	const out: PlainLint[] = [];
	for (const [ruleName, lints] of Object.entries(organized)) {
		for (const lint of lints) out.push(lintToPlain(lint, ruleName));
	}
	return out;
}

// -----------------------------------------------------------------------------
// Tooltip-action handlers.
// -----------------------------------------------------------------------------
async function addWord(rawWord: string): Promise<void> {
	const word = (rawWord || '').trim();
	if (!word) return;

	// 1) Immediate UX (both platforms): into the in-memory set now, so the underline clears at once.
	const linter = await getLinter();
	await linter.importWords([word]);
	importedWordsKey = null; // the engine now holds more than the last reconciled list

	// 2) Settings buffer (both platforms): the deferred flush folds this into the dictionary note when
	//    no editor is open (L4-safe settings write; never a note write here).
	await addPendingWord(word);

	// 3) Desktop keeps its existing external-file / plugin-local append (unchanged, always safe).
	if (!isMobile()) {
		const fs = getFs();
		const external = expandTilde(cfg.dictionaryPath);
		if (external) {
			try {
				fs.appendFileSync(external, `${word}\n`);
				try {
					lastExternalMtimeMs = fs.statSync(external).mtimeMs;
				} catch {
					/* ignore */
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

	await pokeForceLint();
}

async function ignoreFinding(
	text: string,
	start: number,
	end: number,
	ruleName: string,
): Promise<void> {
	const linter = await getLinter();
	// harper stores an ignored lint by a context hash and filters it out of every SUBSEQUENT lint
	// itself. It surfaces overlapping findings one at a time, so to make "Ignore" actually clear the
	// span the user pointed at we ignore every finding on that exact span, re-linting after each until
	// the span is clear (bounded so a pathological doc can't spin forever).
	const matchSpan = (lint: Lint) => {
		const s = lint.span();
		return s.start === start && s.end === end;
	};
	let ignoredAny = false;
	for (let i = 0; i < 20; i++) {
		const organized = await linter.organizedLints(text, { language: 'markdown' });
		let target: Lint | undefined = (organized[ruleName] || []).find(matchSpan);
		if (!target) {
			for (const lints of Object.values(organized)) {
				const m = lints.find(matchSpan);
				if (m) {
					target = m;
					break;
				}
			}
		}
		if (!target) break;
		await linter.ignoreLint(text, target);
		ignoredAny = true;
	}
	if (ignoredAny) {
		try {
			const json = await linter.exportIgnoredLints();
			await saveIgnoredLintsJson(json);
		} catch {
			// eslint-disable-next-line no-console
			console.warn('[harper] could not persist ignored lints');
		}
	}
	await pokeForceLint();
}

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
			};
		}
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
// -----------------------------------------------------------------------------
async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SECTION, {
		label: 'Harper',
		description: 'Harper grammar checker settings.',
		iconName: 'fas fa-spell-check',
	});

	const defs: Record<string, any> = {
		enabled: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION,
			label: 'Enable Harper grammar checking',
			description: 'When off, no grammar/spelling underlines are shown.',
			storage: SettingStorage.File,
		},
		dialect: {
			value: 'American',
			type: SettingItemType.String,
			public: true,
			isEnum: true,
			section: SECTION,
			label: 'English dialect',
			description: 'Changing the dialect reconfigures the linter.',
			options: {
				American: 'American',
				British: 'British',
				Australian: 'Australian',
				Canadian: 'Canadian',
			},
			storage: SettingStorage.File,
		},
		debounceMs: {
			value: 500,
			type: SettingItemType.Int,
			public: true,
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
			public: true,
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
		dictionaryNoteId: {
			value: '',
			type: SettingItemType.String,
			public: true,
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
			public: true,
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
		ignoredLints: {
			value: '',
			type: SettingItemType.String,
			public: false,
			section: SECTION,
			label: 'Ignored lints (internal)',
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
			public: true,
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

		// Reconfigure + re-lint whenever settings change.
		await joplin.settings.onChange(async ({ keys }) => {
			// INTERNAL bookkeeping keys are written BY the reconcile itself. Reacting to them would make
			// a reconcile call itself back (and, in the worst case, deadlock on its own in-flight
			// promise), so they are filtered out here — nothing user-visible changed.
			const external = (keys || []).filter(
				(k) => k !== 'pendingWords' && k !== 'ignoredLints' && k !== SYNC_BASE_KEY,
			);
			if (!external.length) return;

			const before = cfg.dialect;
			const noteIdBefore = cfg.dictionaryNoteId;
			const pathBefore = cfg.dictionaryPath;
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
			// from; against a different note or a different file its "missing" words are not deletions
			// at all. Dropping it makes the next reconcile a first run: adopt the union, delete nothing.
			if (
				(external.includes('dictionaryNoteId') && cfg.dictionaryNoteId !== noteIdBefore) ||
				(!isMobile() && external.includes('dictionaryPath') && cfg.dictionaryPath !== pathBefore)
			) {
				await resetSyncBase();
			}
			if (linterPromise) {
				const linter = await linterPromise;
				if (external.includes('dialect') && cfg.dialect !== before) {
					await linter.setDialect(dialectEnum());
				}
				await applyConfiguration(linter, 'settings-change');
			} else {
				// No engine yet (warm-up still running): still reconcile, so a repointed note/file is
				// merged and persisted rather than waiting for the first lint.
				await reconcileDictionary('settings-change');
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
