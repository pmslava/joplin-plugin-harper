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
	dictionaryPath: string;
	dictionaryNoteId: string;
	ruleOverrides: string;
}
const cfg: HarperConfig = {
	enabled: true,
	dialect: 'American',
	debounceMs: 500,
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
// The note-write flush issues its data.put ONLY when `editorOpen === false`. Selection-change sets the
// flag false and THEN flushes, so words persist to the note the instant the user leaves a note; start
// flushes before any editor mounts. A flush requested while an editor is open (e.g. the dictionaryNoteId
// setting changed mid-edit) is deferred to the next selection-change. This makes it structurally
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

function readExternalWords(): string[] {
	if (isMobile()) return [];
	const p = expandTilde(cfg.dictionaryPath);
	if (!p) return [];
	const fs = getFs();
	try {
		const st = fs.statSync(p);
		lastExternalMtimeMs = st.mtimeMs;
		const content = fs.readFileSync(p, 'utf8');
		warnedMissingDict = false;
		return parseWords(content);
	} catch {
		if (!warnedMissingDict) {
			// eslint-disable-next-line no-console
			console.warn(`[harper] external dictionary not readable (yet): ${p} — treating as empty.`);
			warnedMissingDict = true;
		}
		return [];
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
// Words we know are already in the dictionary note body (parsed on the last read). Used by the desktop
// mirror to compute "new note words" without re-reading, and to avoid redundant note writes.
let knownNoteWords = new Set<string>();

/** Read the dictionary note body's words (both platforms). Empty when unset/unreadable. */
async function readDictionaryNoteWords(): Promise<string[]> {
	if (!cfg.dictionaryNoteId) return [];
	try {
		const note = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
			fields: ['body', 'updated_time'],
		});
		const body: string = (note && note.body) || '';
		lastNoteUpdatedTime = (note && note.updated_time) || null;
		const words = parseWords(body);
		knownNoteWords = new Set(words);
		return words;
	} catch {
		// Note deleted or not yet synced — treat as empty; the id stays set so it recovers on sync.
		return [];
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
// The merged in-memory word set that feeds importWords().
// -----------------------------------------------------------------------------
async function collectDictionaryWords(): Promise<string[]> {
	const words = new Set<string>();
	for (const w of readExternalWords()) words.add(w); // desktop file
	for (const w of readLocalWords()) words.add(w); // desktop plugin-local list
	for (const w of await readDictionaryNoteWords()) words.add(w); // dictionary note (both)
	for (const w of await readPendingWords()) words.add(w); // settings buffer (both)
	return [...words];
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
	return linter;
}

/** (Re)apply dictionary words, rule overrides and ignored lints to a linter instance. */
async function applyConfiguration(linter: LocalLinter): Promise<void> {
	if (!isMobile()) cachedLocalWordsPath = await localWordsPath();

	// Dictionary: clear-then-import handles deletions from the synced sources.
	await linter.clearWords();
	const words = await collectDictionaryWords();
	if (words.length) await linter.importWords(words);

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
// DEFERRED NOTE FLUSH + DESKTOP NOTE<->FILE MIRROR (L3-compliant write discipline).
// =============================================================================
// The ONLY note-write path. It runs `read note -> merge (note words + pendingWords + desktop file
// words) -> dedupe -> sort -> write canonical body` and clears the flushed pendingWords, but ONLY when
// `editorOpen === false`. Writing the note is skipped entirely (no data.put) when an editor is open or
// when there is nothing new to persist — so on mobile a data.put can never race an active edit (L3),
// and repeated triggers converge without churn.
let flushInFlight = false;

async function flushDictionaryNote(reason: string): Promise<void> {
	if (!cfg.dictionaryNoteId) return; // no note configured yet
	if (editorOpen) return; // L3 guard: never write a note while an editor is open
	if (flushInFlight) return; // serialize; a concurrent trigger will re-run if needed
	flushInFlight = true;
	try {
		const noteWords = await readDictionaryNoteWords(); // also refreshes knownNoteWords + updated_time
		const pending = await readPendingWords();
		const fileWords = readExternalWords(); // desktop-only mirror source (mobile returns [])

		const union = new Set<string>(noteWords);
		let changed = false;
		for (const w of pending) if (!union.has(w)) { union.add(w); changed = true; }
		for (const w of fileWords) if (!union.has(w)) { union.add(w); changed = true; }

		// Only write when the note is actually missing words — this is what makes the mirror converge
		// (once the note holds the union, `changed` stays false and no data.put fires: no ping-pong).
		if (changed) {
			const body = canonicalDictionaryBody(union);
			await joplin.data.put(['notes', cfg.dictionaryNoteId], null, { body });
			knownNoteWords = new Set(union);
			try {
				const after = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
					fields: ['updated_time'],
				});
				lastNoteUpdatedTime = (after && after.updated_time) || lastNoteUpdatedTime;
			} catch {
				/* best-effort mtime refresh */
			}
		}

		// The pending buffer has now been folded into the note (or was already present) — clear it so
		// it isn't re-flushed forever. Settings write is L4-safe.
		if (pending.length) await joplin.settings.setValue('pendingWords', []);

		// DESKTOP MIRROR (note -> file): append any note/pending words the file is missing. File writes
		// are always safe (they never route through Joplin's note-reload dispatch). Dedupe against the
		// file's current words so repeated polls don't re-append (convergence, no ping-pong).
		if (!isMobile() && cfg.dictionaryNoteId && expandTilde(cfg.dictionaryPath)) {
			mirrorUnionToFile(union);
		}
	} catch (error) {
		// eslint-disable-next-line no-console
		console.warn(`[harper] dictionary-note flush (${reason}) failed:`, error);
	} finally {
		flushInFlight = false;
	}
}

/** DESKTOP: append to the external file any words in `union` it does not already contain. */
function mirrorUnionToFile(union: Set<string>): void {
	if (isMobile()) return;
	const p = expandTilde(cfg.dictionaryPath);
	if (!p) return;
	const fs = getFs();
	let existing: Set<string>;
	try {
		existing = new Set(parseWords(fs.readFileSync(p, 'utf8')));
	} catch {
		existing = new Set();
	}
	const missing = [...union].filter((w) => !existing.has(w));
	if (!missing.length) return;
	try {
		// Append-only keeps the user's own file ordering/comments intact; the note is the canonical form.
		let prefix = '';
		try {
			const cur = fs.readFileSync(p, 'utf8');
			prefix = cur.length && !cur.endsWith('\n') ? '\n' : '';
		} catch {
			prefix = '';
		}
		fs.appendFileSync(p, `${prefix}${missing.join('\n')}\n`);
		try {
			lastExternalMtimeMs = fs.statSync(p).mtimeMs;
		} catch {
			/* ignore */
		}
	} catch {
		// eslint-disable-next-line no-console
		console.warn(`[harper] could not mirror words to external dictionary file: ${p}`);
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
	// Persist the id (settings write — safe). onChange reacts: re-reads the note + flush.
	await joplin.settings.setValue('dictionaryNoteId', note.id);
}

// -----------------------------------------------------------------------------
// Dictionary polling (60s): desktop file mtime + dictionary-note updated_time.
// -----------------------------------------------------------------------------
function pollDictionaryTick(): void {
	// FILE poll (desktop only): stat mtime; re-import only when it changed.
	if (!isMobile()) {
		const p = expandTilde(cfg.dictionaryPath);
		if (p) {
			let st: any;
			try {
				st = getFs().statSync(p);
			} catch {
				st = null;
			}
			if (st && (lastExternalMtimeMs === null || st.mtimeMs !== lastExternalMtimeMs)) {
				void (async () => {
					if (!linterPromise) return;
					const linter = await linterPromise;
					await applyConfiguration(linter);
					await pokeForceLint();
					// MIRROR (file -> note): fold new file words into the note, deferred per L3 discipline
					// (only when no editor is open). flushDictionaryNote handles the editorOpen guard.
					await flushDictionaryNote('file-poll');
				})();
			}
		}
	}

	// NOTE poll (both platforms): re-read on updated_time change (READS are always safe, L3).
	if (cfg.dictionaryNoteId) {
		void (async () => {
			let changed = false;
			try {
				const note = await joplin.data.get(['notes', cfg.dictionaryNoteId], {
					fields: ['updated_time'],
				});
				const ut = (note && note.updated_time) || null;
				changed = lastNoteUpdatedTime === null || ut !== lastNoteUpdatedTime;
			} catch {
				return; // note unreadable this tick
			}
			if (!changed) return; // ZERO extra work when the note is unchanged
			if (!linterPromise) return;
			const linter = await linterPromise;
			await applyConfiguration(linter); // re-reads note words into the linter
			await pokeForceLint();
			// MIRROR (note -> file): append new note words to the desktop file (file writes always safe).
			if (!isMobile() && expandTilde(cfg.dictionaryPath)) {
				mirrorUnionToFile(new Set(await collectDictionaryWords()));
			}
		})();
	}
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
			return {
				enabled: enabled !== false,
				debounceMs: typeof debounceMs === 'number' ? debounceMs : 500,
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
				'Re-read every 60s. When a dictionary note is ALSO set, the file and note mirror each other.',
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
//   2. START FLUSH — persist any words buffered from a previous session to the dictionary note. Still
//      L3-guarded (flushDictionaryNote no-ops while an editor is open) and serialized (flushInFlight).
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
	// flushDictionaryNote never rejects (it try/catches internally), so no extra .catch is needed.
	void flushDictionaryNote('plugin-start');
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
			const before = cfg.dialect;
			const noteIdBefore = cfg.dictionaryNoteId;
			await loadSettings();
			if (!isMobile() && (cfg.dictionaryPath === '' || keys.includes('dictionaryPath'))) {
				// A changed path invalidates the cached mtime / missing-file warning.
				lastExternalMtimeMs = null;
				warnedMissingDict = false;
			}
			if (keys.includes('dictionaryNoteId') && cfg.dictionaryNoteId !== noteIdBefore) {
				// New/changed dictionary note: force a fresh read next time.
				lastNoteUpdatedTime = null;
				knownNoteWords = new Set();
			}
			if (linterPromise) {
				const linter = await linterPromise;
				if (keys.includes('dialect') && cfg.dialect !== before) {
					await linter.setDialect(dialectEnum());
				}
				await applyConfiguration(linter);
			}
			await pokeForceLint();
			// A dictionaryNoteId change is a flush trigger (guarded by editorOpen — deferred if an
			// editor is open, which is why on mobile this cannot evict; see flushDictionaryNote).
			if (keys.includes('dictionaryNoteId') && cfg.dictionaryNoteId !== noteIdBefore) {
				await flushDictionaryNote('dictionaryNoteId-change');
			}
		});

		// EDITOR-OPEN tracking + deferred flush trigger. A note-selection change means the previously
		// open editor was torn down; mark the editor closed and flush pending words to the note (L3-safe
		// because editorOpen is now false and the newly-selected note has no in-progress edits yet).
		try {
			await joplin.workspace.onNoteSelectionChange(async () => {
				editorOpen = false;
				await flushDictionaryNote('note-selection-change');
			});
		} catch {
			// Older API without onNoteSelectionChange — the start flush + poll still persist words.
		}

		// Poll for out-of-band dictionary changes (desktop file via rclone; the note via sync). Armed here
		// (synchronously) so it is wired the instant onStart returns — arming a timer touches no engine,
		// data or fs, and its first tick is 60 s out; the tick's own work stays deferred. (The test
		// harness captures setInterval only for the synchronous span of onStart, so this must stay eager.)
		setInterval(pollDictionaryTick, 60_000);

		// ---------------------------------------------------------------------------------------------
		// BACKGROUND — kick off the engine warm-up + initial dictionary import + start flush, all
		// fire-and-forget. Deferred to a fresh macrotask so it starts strictly AFTER onStart's promise
		// resolves: the host records onStart as "done" (fast handler time), THEN the heavy work runs and
		// overlaps the user opening a note. Started last, so every handler above is wired first.
		// ---------------------------------------------------------------------------------------------
		setTimeout(startBackgroundInit, 0);
	},
});
