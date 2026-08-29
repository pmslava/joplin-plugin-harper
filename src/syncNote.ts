/**
 * THE SYNC NOTE (v1.5.0) — one Joplin note carrying ALL synced Harper state, as machine-readable JSON.
 *
 * The note is a MAILBOX, not a document. The plugin writes the whole thing when local state changes
 * and reads the whole thing when it finds a body it did not write; there is no merging, no per-field
 * reconciliation, and no repair. Whole-note last-writer-wins, and a concurrent edit on two devices is
 * resolved by Joplin's own conflict handling, which the user resolves by hand.
 *
 * The body is: one human sentence (so a person who stumbles on the note knows what it is and leaves
 * it alone), then a fenced ```json block holding the payload. Nothing else is read; nothing else is
 * preserved.
 *
 * ── THE u64 RULE, restated ───────────────────────────────────────────────────────────────────────
 * harper's ignore payload is `{"context_hashes":[<u64>,…]}` and those integers routinely exceed
 * Number.MAX_SAFE_INTEGER. `JSON.parse` would turn them into doubles and re-stringifying would write
 * DIFFERENT integers, silently un-ignoring every dismissed finding. So the payload crosses this note
 * as `dismissed.ignoredLintsRaw`, a JSON **string** — `JSON.stringify` escapes it, `JSON.parse` hands
 * the same characters back, and no digit in it is ever a JSON number. It is fed to
 * `importIgnoredLints` untouched. The side-table entry hashes travel as decimal STRINGS for the same
 * reason. See src/dismissedLog.ts for the full account.
 *
 * WHAT SYNCS: rule overrides, dismissed findings, dictionary words. WHAT DOES NOT: the dialect and
 * "ignore non-English text" — both are per-device choices (a user reads British on one machine and
 * American on another), so they are deliberately left out.
 *
 * Dependency-free on purpose (no `joplin`, no `fs`, no harper.js), exactly like dictionaryMerge.ts
 * and dismissedLog.ts, so the harness can transpile and unit-test it directly.
 */

/** The title the "Harper: Create sync note" command gives the note it creates. */
export const SYNC_NOTE_TITLE = 'Harper Sync';

/** The one human sentence at the top of the body. Approved copy — change it nowhere else. */
export const SYNC_NOTE_SENTENCE =
	'This note is used by the Harper plugin to sync settings between devices. ' +
	'Do not edit it. Change settings in Harper settings.';

/** The payload's schema version. Bumped only if the shape ever changes incompatibly. */
export const SYNC_NOTE_VERSION = 1;

/** One dismissed finding, in the note's own field names. */
export interface SyncDismissedEntry {
	/** Every harper context hash this dismissal produced, as decimal STRINGS. Never numbers. */
	hashes: string[];
	/** The harper rule that produced the finding, e.g. "SpelledNumbers". */
	rule: string;
	/** The flagged source span itself, e.g. "should of". */
	text: string;
	/** ISO-8601 timestamp of the dismissal. */
	date: string;
}

export interface SyncDismissed {
	/**
	 * `exportIgnoredLints()`'s output, VERBATIM. Carried as a string and fed straight back to
	 * `importIgnoredLints`. Never parsed, never rebuilt, never inspected as JSON.
	 */
	ignoredLintsRaw: string;
	entries: SyncDismissedEntry[];
}

/** Everything that syncs. The part of the payload that decides whether a write/apply is needed. */
export interface SyncContent {
	ruleOverrides: Record<string, boolean>;
	dismissed: SyncDismissed;
	words: string[];
}

/** The full JSON object in the note's fenced block. */
export interface SyncPayload extends SyncContent {
	version: number;
	updatedAt: string;
}

// =============================================================================
// Normalization — the same rules on both sides, so two devices holding the same
// state produce the same bytes and the same content key.
// =============================================================================

/** A decimal u64 as harper emits it: digits only. */
function isHashString(value: unknown): value is string {
	return typeof value === 'string' && /^\d+$/.test(value);
}

/** Leading zeros stripped (but "0" preserved), so two spellings of one u64 compare equal. */
function normalizeHash(hash: string): string {
	const trimmed = hash.replace(/^0+(?=\d)/, '');
	return trimmed.length ? trimmed : '0';
}

function sortStrings(values: Iterable<string>): string[] {
	return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sparse rule map: boolean values only, keys sorted. Anything else is dropped (= "Default"). */
export function normalizeSyncRules(raw: unknown): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	const map = raw as Record<string, unknown>;
	for (const key of sortStrings(Object.keys(map))) {
		if (!key) continue;
		if (typeof map[key] !== 'boolean') continue;
		out[key] = map[key] as boolean;
	}
	return out;
}

/**
 * Trimmed, deduped, blank-free, code-unit sorted — and '# ' comment lines dropped, exactly as
 * `parseWords` in index.ts drops them, so a comment pasted into a dictionary can never become a word.
 */
export function normalizeSyncWords(raw: unknown): string[] {
	const set = new Set<string>();
	for (const value of Array.isArray(raw) ? raw : []) {
		if (typeof value !== 'string') continue;
		const word = value.trim();
		if (!word || word.startsWith('# ')) continue;
		set.add(word);
	}
	return sortStrings(set);
}

/**
 * One entry, coerced into a usable shape, or null when it is not.
 *
 * An entry with NO hashes is dropped: it can neither be restored nor matched against harper's ignore
 * state, so it would be a permanently un-actionable row in the dismissed manager.
 */
function normalizeSyncEntry(raw: unknown): SyncDismissedEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const value = raw as Record<string, unknown>;
	const hashes: string[] = [];
	const seen = new Set<string>();
	for (const hash of Array.isArray(value.hashes) ? value.hashes : []) {
		if (!isHashString(hash)) continue;
		const normalized = normalizeHash(hash);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		hashes.push(normalized);
	}
	if (!hashes.length) return null;
	return {
		hashes,
		rule: typeof value.rule === 'string' ? value.rule : '',
		text: typeof value.text === 'string' ? value.text : '',
		date: typeof value.date === 'string' ? value.date : '',
	};
}

/** The dismissed half, normalized. Duplicated ids collapse to the first occurrence. */
export function normalizeSyncDismissed(raw: unknown): SyncDismissed {
	const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const entries: SyncDismissedEntry[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(value.entries) ? value.entries : []) {
		const entry = normalizeSyncEntry(item);
		if (!entry) continue;
		if (seen.has(entry.hashes[0])) continue;
		seen.add(entry.hashes[0]);
		entries.push(entry);
	}
	return {
		// VERBATIM: the one field in this file that is deliberately not inspected. A non-string is the
		// only thing rejected, and it degrades to "nothing ignored" rather than to a corrupt payload.
		ignoredLintsRaw: typeof value.ignoredLintsRaw === 'string' ? value.ignoredLintsRaw : '',
		entries,
	};
}

export function normalizeSyncContent(raw: Partial<SyncContent> | unknown): SyncContent {
	const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return {
		ruleOverrides: normalizeSyncRules(value.ruleOverrides),
		dismissed: normalizeSyncDismissed(value.dismissed),
		words: normalizeSyncWords(value.words),
	};
}

/**
 * THE LOOP-PREVENTION TOKEN: a canonical string for the SYNCED CONTENT, with `updatedAt` and
 * `version` deliberately excluded.
 *
 * The device remembers this for the note body it last wrote OR last applied, and refuses to do
 * either again for the same value. Excluding the timestamp is what makes that work at all: applying
 * a remote body writes settings, which pokes the plugin's refresh path, which schedules a write — and
 * a body key that included `updatedAt` would differ from the one just applied, so the two devices
 * would rewrite the note at each other every few seconds, forever, with the content never changing.
 *
 * The entries are sorted here (not in the body) so that two devices holding the same dismissals
 * agree on the key even though their side tables list them newest-first in different orders.
 *
 * It is the CANONICAL STRING ITSELF, not a digest of it. A 32-bit hash would be a few bytes cheaper
 * and would carry a collision risk whose failure mode is silent: a dropped remote update that never
 * arrives and never errors. Keeping the string costs a few kB of memory (it is never persisted) and
 * removes that risk entirely.
 */
export function syncContentKey(content: SyncContent | unknown): string {
	const normalized = normalizeSyncContent(content);
	const entries = [...normalized.dismissed.entries].sort((a, b) =>
		a.hashes[0] < b.hashes[0] ? -1 : a.hashes[0] > b.hashes[0] ? 1 : 0,
	);
	return JSON.stringify({
		ruleOverrides: normalized.ruleOverrides,
		ignoredLintsRaw: normalized.dismissed.ignoredLintsRaw,
		entries: entries.map((entry) => [sortStrings(entry.hashes), entry.rule, entry.text]),
		words: normalized.words,
	});
}

// =============================================================================
// The body: build and parse.
// =============================================================================

/**
 * The fenced block, located by its opening ```json marker.
 *
 * NON-GREEDY to the first closing fence, so trailing text a user (or a Joplin conflict marker) left
 * behind cannot swallow the payload. The whole body is otherwise ignored — the human sentence is
 * for people, and nothing reads it back.
 */
const JSON_FENCE = /```json[^\S\n]*\n([\s\S]*?)\n?```/;

/** The exact bytes of the note body for this content, stamped with `updatedAt`. */
export function buildSyncNoteBody(content: SyncContent, updatedAt: string): string {
	const normalized = normalizeSyncContent(content);
	const payload: SyncPayload = {
		version: SYNC_NOTE_VERSION,
		updatedAt,
		ruleOverrides: normalized.ruleOverrides,
		dismissed: normalized.dismissed,
		words: normalized.words,
	};
	return `${SYNC_NOTE_SENTENCE}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

/**
 * The payload in a note body, or NULL when there is not one we can soundly interpret.
 *
 * Null is the whole error channel: no fence, malformed JSON, a non-object, or a future `version` we
 * do not understand. The caller logs once and keeps working from local state — a body it cannot read
 * is never a reason to crash, to pause, or to destroy anything.
 */
export function parseSyncNoteBody(body: string): SyncPayload | null {
	const match = JSON_FENCE.exec(body || '');
	if (!match) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	// An unknown FUTURE version is refused rather than half-read: a device running an older build
	// must not apply a payload whose fields it cannot see, and must not then write its truncated
	// understanding back over the note. Missing/older versions are read as v1, which is all there is.
	const version = typeof value.version === 'number' ? value.version : SYNC_NOTE_VERSION;
	if (version > SYNC_NOTE_VERSION) return null;
	const normalized = normalizeSyncContent(value);
	return {
		version: SYNC_NOTE_VERSION,
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
		ruleOverrides: normalized.ruleOverrides,
		dismissed: normalized.dismissed,
		words: normalized.words,
	};
}
