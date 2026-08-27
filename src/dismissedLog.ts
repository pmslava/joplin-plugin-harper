/**
 * DISMISSED-FINDINGS SIDE TABLE — a readable index over harper's opaque ignore hashes.
 *
 * harper persists a dismissal as a context hash and nothing else: `exportIgnoredLints()` returns
 * `{"context_hashes":[<u64>,…]}`. That is deliberately privacy-respecting, and it is also useless to
 * a settings UI — you cannot show a user a list of 64-bit integers and ask which one to restore.
 *
 * So we keep a SIDE TABLE next to it: one entry per dismissal, carrying the hashes it produced plus
 * just enough to name it in a list. The recorded fields are a deliberate privacy-scoped decision —
 * rule name, the flagged span, a date. No surrounding sentence, no note id, no note title.
 *
 * ── THE u64 TRAP (the reason this module exists as its own file) ─────────────────────────────────
 * The context hashes are unsigned 64-bit and routinely exceed Number.MAX_SAFE_INTEGER. `JSON.parse`
 * turns them into doubles, and re-stringifying then writes a DIFFERENT integer — the ignores stop
 * matching and every dismissed finding silently comes back. There is no error, just quiet breakage.
 *
 * The rule, enforced by every function here: harper's payload is only ever read with a regex that
 * lifts the digits out as STRINGS, and only ever rebuilt by string concatenation. A context hash is
 * a `string` throughout this module and in `DismissedEntry.hashes` — never a `number`. The plugin
 * separately persists harper's own payload VERBATIM, so the bytes harper produced are the bytes it
 * gets back. (This file's own JSON is safe to JSON.parse precisely because the hashes in it are
 * already strings.)
 *
 * ── THE REMOVAL TRAP ─────────────────────────────────────────────────────────────────────────────
 * `importIgnoredLints` MERGES (union + dedupe); it cannot remove. The only removal primitive harper
 * offers is `clearIgnoredLints()`. Un-ignoring one entry is therefore always: compute the keep-set,
 * clear, re-import the keep-set. `buildIgnoredLintsPayload` builds that re-import payload.
 *
 * Dependency-free on purpose (no `joplin`, no `fs`, no harper.js) — storage is injected as a
 * `DismissedStore`, so the harness can transpile and unit-test this module directly, exactly as it
 * does for dictionaryMerge.ts.
 */

/** One dismissal, as shown in the "dismissed findings" manager. */
export interface DismissedEntry {
	/** Stable identity: the first context hash this dismissal produced (a decimal u64 STRING). */
	id: string;
	/**
	 * Every context hash this dismissal produced, as decimal strings. One user-visible "Dismiss"
	 * can ignore several overlapping findings on the same span, so this is a list, not a scalar.
	 */
	hashes: string[];
	/** The harper rule that produced the finding, e.g. "SpelledNumbers". */
	ruleName: string;
	/** The flagged source span itself, e.g. "should of". */
	problemText: string;
	/** ISO-8601 timestamp of the dismissal. */
	dismissedAt: string;
}

/** Injected persistence: desktop backs this with a file, mobile with a private settings value. */
export interface DismissedStore {
	/** The stored JSON, or '' when nothing has been stored yet. Must never throw. */
	read(): Promise<string>;
	write(json: string): Promise<void>;
}

// =============================================================================
// Pure helpers over harper's ignore payload. All hash-shaped values are STRINGS.
// =============================================================================

/** A decimal u64 as harper emits it: digits only. Anything else is not a hash we will re-emit. */
function isHashString(value: unknown): value is string {
	return typeof value === 'string' && /^\d+$/.test(value);
}

/**
 * Canonical form of a decimal hash string: leading zeros stripped (but "0" preserved), so two
 * spellings of the same u64 compare equal as set members. harper does not emit leading zeros; this
 * only guards hand-edited or migrated state.
 */
function normalizeHash(hash: string): string {
	const trimmed = hash.replace(/^0+(?=\d)/, '');
	return trimmed.length ? trimmed : '0';
}

/**
 * Lift the context hashes out of harper's `{"context_hashes":[…]}` payload as decimal STRINGS,
 * deduped and in payload order.
 *
 * Deliberately a regex and NOT `JSON.parse`: parsing would coerce every u64 to a double and destroy
 * the ones above 2^53. Nothing in this codebase may parse that array as JSON numbers.
 */
export function extractHashes(rawIgnoredLints: string): string[] {
	if (!rawIgnoredLints) return [];
	const array = /"context_hashes"\s*:\s*\[([^\]]*)\]/.exec(rawIgnoredLints);
	if (!array) return [];
	const digits = array[1].match(/\d+/g);
	if (!digits) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of digits) {
		const hash = normalizeHash(raw);
		if (seen.has(hash)) continue;
		seen.add(hash);
		out.push(hash);
	}
	return out;
}

/**
 * Rebuild a harper import payload from decimal hash STRINGS, by concatenation.
 *
 * Non-digit entries are dropped rather than interpolated: a stray value would otherwise produce
 * malformed JSON that `importIgnoredLints` rejects, losing the whole keep-set. An empty result is
 * still a well-formed payload, and importing it is a documented no-op.
 */
export function buildIgnoredLintsPayload(hashes: readonly string[]): string {
	const seen = new Set<string>();
	const clean: string[] = [];
	for (const raw of hashes || []) {
		if (!isHashString(raw)) continue;
		const hash = normalizeHash(raw);
		if (seen.has(hash)) continue;
		seen.add(hash);
		clean.push(hash);
	}
	return `{"context_hashes":[${clean.join(',')}]}`;
}

/** Every hash covered by the side table — i.e. every dismissal we can name and restore. */
export function coveredHashes(entries: readonly DismissedEntry[]): Set<string> {
	const out = new Set<string>();
	for (const entry of entries || []) {
		for (const hash of entry.hashes || []) {
			if (isHashString(hash)) out.add(normalizeHash(hash));
		}
	}
	return out;
}

/**
 * Hashes present in harper's ignore state that NO side-table entry accounts for.
 *
 * These are dismissals made before this feature existed (or ones whose contextHash call failed).
 * They are real ignores and still suppress findings, but there is nothing readable to show for
 * them, so the UI offers only a bulk clear — never a per-item Restore.
 */
export function legacyHashes(
	rawIgnoredLints: string,
	entries: readonly DismissedEntry[],
): string[] {
	const covered = coveredHashes(entries);
	return extractHashes(rawIgnoredLints).filter((hash) => !covered.has(hash));
}

/** How many ignore hashes predate / escape the side table. Drives the "N legacy dismissals" row. */
export function legacyCount(rawIgnoredLints: string, entries: readonly DismissedEntry[]): number {
	return legacyHashes(rawIgnoredLints, entries).length;
}

/**
 * The keep-set for un-ignoring `entry`: every currently-ignored hash except that entry's own.
 * Feed it to `buildIgnoredLintsPayload` after `clearIgnoredLints()`.
 */
export function hashesWithoutEntry(rawIgnoredLints: string, entry: DismissedEntry): string[] {
	const drop = coveredHashes([entry]);
	return extractHashes(rawIgnoredLints).filter((hash) => !drop.has(hash));
}

/** The id a dismissal gets: its first context hash. Stable, and already unique per finding. */
export function makeEntryId(hashes: readonly string[]): string {
	for (const hash of hashes || []) {
		if (isHashString(hash)) return normalizeHash(hash);
	}
	return '';
}

// =============================================================================
// Entry-list shaping (pure) — tolerant of anything already on disk.
// =============================================================================

/** Coerce one stored record into a well-formed entry, or null when it is unusable. */
function sanitizeEntry(raw: unknown): DismissedEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const value = raw as Partial<DismissedEntry>;
	const hashes: string[] = [];
	const seen = new Set<string>();
	for (const hash of Array.isArray(value.hashes) ? value.hashes : []) {
		if (!isHashString(hash)) continue;
		const normalized = normalizeHash(hash);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		hashes.push(normalized);
	}
	// An entry with no hashes can neither be restored nor matched against harper's state — it would
	// be a permanently un-actionable row in the UI, so it is dropped rather than shown.
	if (!hashes.length) return null;
	const id = isHashString(value.id) ? normalizeHash(value.id) : makeEntryId(hashes);
	return {
		id,
		hashes,
		ruleName: typeof value.ruleName === 'string' ? value.ruleName : '',
		problemText: typeof value.problemText === 'string' ? value.problemText : '',
		dismissedAt: typeof value.dismissedAt === 'string' ? value.dismissedAt : '',
	};
}

/**
 * Parse the side table. Safe to JSON.parse: every hash in OUR file is a string, so no u64 is ever
 * a JSON number here. Corrupt or unreadable content yields an empty table rather than throwing —
 * losing the readable index is recoverable (the entries degrade to legacy hashes), crashing is not.
 */
export function parseEntries(json: string): DismissedEntry[] {
	if (!json || !json.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === 'object' && Array.isArray((parsed as any).entries)
			? (parsed as any).entries
			: null;
	if (!list) return [];
	const out: DismissedEntry[] = [];
	for (const raw of list) {
		const entry = sanitizeEntry(raw);
		if (entry) out.push(entry);
	}
	return out;
}

/** Serialize the side table. Object-wrapped so a future version can add fields alongside. */
export function serializeEntries(entries: readonly DismissedEntry[]): string {
	return JSON.stringify({ version: 1, entries });
}

/**
 * Add `entry` to `entries`, newest first.
 *
 * A repeat id (the same finding dismissed twice — possible if harper's state was cleared out from
 * under the side table) UNIONs the hash lists rather than duplicating the row, so a restore still
 * un-ignores everything that dismissal produced.
 */
export function withEntryAppended(
	entries: readonly DismissedEntry[],
	entry: DismissedEntry,
): DismissedEntry[] {
	const existing = entries.find((candidate) => candidate.id === entry.id);
	if (!existing) return [entry, ...entries];
	const merged: DismissedEntry = {
		...entry,
		hashes: [...new Set([...existing.hashes, ...entry.hashes])],
	};
	return [merged, ...entries.filter((candidate) => candidate.id !== entry.id)];
}

// =============================================================================
// Store-backed operations.
// =============================================================================

/**
 * ONE WRITER AT A TIME, per store.
 *
 * Every mutation below is a read-modify-write, and its critical section straddles real suspension
 * points: on desktop both halves await `joplin.plugins.dataDir()` (which falls through to an
 * `fs.pathExists` on the threadpool in steady state) and on mobile both are settings-bridge round
 * trips. Nothing upstream serializes them — Joplin invokes the content-script message handler
 * directly, with no queue, and the suggestion card fires Dismiss without waiting for the previous one
 * — so two dismissals close together interleave as "A reads [], B reads [], A writes [A], B writes
 * [B]". The lost row's hash is still in harper's ignore set, so that dismissal degrades into an
 * unnameable "legacy" entry that only the destructive bulk clear can remove, and nothing ever heals
 * it.
 *
 * The lock is per store object (a WeakMap, so a store handed out per test run is not kept alive) and
 * covers the whole read-modify-write, not the individual reads and writes. `loadDismissed` stays
 * lock-free on purpose: a stale read is harmless, and taking the lock for it would serialize the
 * snapshot path behind every dismissal for no benefit.
 */
const storeLocks = new WeakMap<DismissedStore, Promise<unknown>>();

function withStoreLock<T>(store: DismissedStore, fn: () => Promise<T>): Promise<T> {
	const previous = storeLocks.get(store) ?? Promise.resolve();
	// `.then(fn, fn)` rather than `.then(fn)`: a rejected predecessor must not skip this operation and
	// silently break every later write for the session.
	const next = previous.then(fn, fn);
	// The chain itself never stays rejected, for the same reason.
	storeLocks.set(
		store,
		next.catch(() => undefined),
	);
	return next;
}

export async function loadDismissed(store: DismissedStore): Promise<DismissedEntry[]> {
	let raw = '';
	try {
		raw = await store.read();
	} catch {
		return [];
	}
	return parseEntries(raw);
}

export async function saveDismissed(
	store: DismissedStore,
	entries: readonly DismissedEntry[],
): Promise<void> {
	await store.write(serializeEntries(entries));
}

/** Record one dismissal. Returns the new table. Serialized against every other store mutation. */
export async function appendDismissed(
	store: DismissedStore,
	entry: DismissedEntry,
): Promise<DismissedEntry[]> {
	return withStoreLock(store, async () => {
		const next = withEntryAppended(await loadDismissed(store), entry);
		await saveDismissed(store, next);
		return next;
	});
}

/**
 * Drop one entry by id. Returns the entry that was removed (so the caller can compute the harper
 * keep-set from its hashes) plus the resulting table, or `removed: null` when the id was unknown.
 */
export async function removeDismissed(
	store: DismissedStore,
	id: string,
): Promise<{ entries: DismissedEntry[]; removed: DismissedEntry | null }> {
	return withStoreLock(store, async () => {
		const entries = await loadDismissed(store);
		const removed = entries.find((entry) => entry.id === id) ?? null;
		if (!removed) return { entries, removed: null };
		const next = entries.filter((entry) => entry.id !== id);
		await saveDismissed(store, next);
		return { entries: next, removed };
	});
}

/** Forget the whole side table. Does NOT touch harper's own ignore state — the caller does that. */
export async function clearDismissed(store: DismissedStore): Promise<void> {
	// Under the lock too: otherwise a dismissal that read the table before the clear would write its
	// row back out afterwards, leaving a row whose ignore hashes the clear has already destroyed.
	await withStoreLock(store, () => saveDismissed(store, []));
}
