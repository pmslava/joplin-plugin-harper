/**
 * THREE-WAY DICTIONARY MERGE (v1.3.0) — the pure core of dictionary reconciliation.
 *
 * v1.2.0 reconciled the dictionary sources by UNION (note ∪ file ∪ pending). A union can only ever
 * grow, so deleting a word from the dictionary note resurrected it from the external file on the
 * next poll (and vice versa) — the user-reported bug this module fixes.
 *
 * The fix is a classic three-way merge against a persisted BASE: the word set as it stood at the end
 * of the last successful reconcile (`syncBase`, a private settings value — settings writes are safe
 * on both platforms, L4). A word missing from a side that the base still remembers is a DELETION on
 * that side; a word present on a side the base does not know is an ADDITION.
 *
 * The algebra, with base B, note N (null when no dictionary note is configured or it is unreadable),
 * file F (null on mobile, when no external file is configured, or when it is unreadable this pass)
 * and the pending add-to-dictionary buffer P:
 *
 *     added   = (N \ B) ∪ (F \ B) ∪ P                       (P counts unconditionally)
 *     deleted = (B \ N)|N present  ∪  (B \ F)|F present
 *     result  = (B \ (deleted \ added)) ∪ added
 *
 * CONFLICT RULE — **addition wins**: `deleted \ added` is what actually gets dropped, so a word that
 * is being added anywhere (a fresh word on either side, or an explicit local add-to-dictionary in P)
 * survives a concurrent deletion of the same word on the other side. Deletions therefore need
 * agreement-by-silence; additions need only one voice.
 *
 * EXPLICIT REMOVALS (v1.4.0, the dictionary editor's remove half) are the one exception, and the
 * mirror image of P: `result` has R subtracted last, so a stated deletion beats a concurrent
 * addition and applies even on a first run. Everything else here infers intent from what the sides
 * look like; R *is* the intent, so it does not get out-voted by an inference.
 *
 *     result  = ((B \ (deleted \ added)) ∪ added) \ R      with added already R-free
 *
 * ABSENT SIDES infer NO deletions: the side is passed as `null`, contributes nothing to `deleted`, and
 * the whole base survives this pass. An *empty but readable* side is NOT absent — it is passed as `[]`
 * and its deletions are honoured, because emptying the dictionary note is a legitimate user action.
 *
 * Absence is only half the safety story, and the half that lives here. This function has no idea
 * whether the pass will be committed, and an absent side must ALSO stop the caller from advancing the
 * base: otherwise the present side's additions land in a base the absent side never saw, and read as
 * deletions when it returns. That gate is the caller's (`runReconcile`'s presence check); this
 * function only guarantees that an absent side cannot delete anything *now*.
 *
 * FIRST RUN (no base persisted yet — every install upgrading from ≤1.2.0): the base is DEFINED as
 * the current union of all present sides plus pending, and deletion detection is SKIPPED entirely,
 * so `result` is exactly the old v1.2.0 union. Skipping is not a formality: the union base is a
 * superset of each individual side, so the deletion rule would read every word one side happens to
 * lack as a deletion and wipe it. Migration therefore cannot infer a single deletion; deletions only
 * become detectable from the second reconcile onwards, against a base this device actually observed
 * the sides agreeing on.
 *
 * This file is deliberately dependency-free (no `joplin`, no `fs`, no harper.js) so the harness can
 * transpile and unit-test it directly.
 */

export interface MergeInput {
	/** The last reconciled word set, or null when none has been persisted yet (first run). */
	base: readonly string[] | null;
	/** The dictionary note's words, or null when there is no readable note side this pass. */
	note: readonly string[] | null;
	/** The external file's words, or null when there is no readable file side this pass. */
	file: readonly string[] | null;
	/** Words added via add-to-dictionary and not yet folded into a durable side. */
	pending: readonly string[];
	/**
	 * Words the user EXPLICITLY deleted (the dictionary editor's remove half), not yet folded into a
	 * durable side. The exact mirror of `pending`, and the only way to express a deletion that no side
	 * has performed yet. Optional: omitting it is the pre-v1.4.0 behaviour exactly.
	 *
	 * An explicit removal is not an inference from a side's silence, so — unlike the `B \ N` rule — it
	 * applies on a FIRST RUN too, and it BEATS a concurrent addition of the same word (the reverse of
	 * the normal conflict rule). Both follow from the same principle: the rules below guess at intent
	 * from what the sides look like, whereas this is the user's intent, stated.
	 */
	removals?: readonly string[];
}

export interface MergeOutput {
	/** The reconciled word set: deduped, blank-free, code-unit sorted (byte-stable across devices). */
	result: string[];
	/** Words in `result` that the base did not have (sorted). */
	added: string[];
	/** Words the base had that `result` drops (sorted). */
	deleted: string[];
	/** True when a note side is present and differs from `result` — the note must be rewritten. */
	noteChanged: boolean;
	/** True when a file side is present and differs from `result` — the file must be rewritten. */
	fileChanged: boolean;
	/** True when no base was supplied: the union was adopted as the base and nothing was deleted. */
	firstRun: boolean;
}

/** Trimmed, blank-free set of words. */
function toSet(words: readonly string[] | null | undefined): Set<string> {
	const out = new Set<string>();
	for (const raw of words || []) {
		if (typeof raw !== 'string') continue;
		const w = raw.trim();
		if (w) out.add(w);
	}
	return out;
}

/** Code-unit sort (not locale-aware) so the same set always yields byte-identical output. */
function sortWords(words: Iterable<string>): string[] {
	return [...words].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const w of a) if (!b.has(w)) return false;
	return true;
}

/** The pure three-way merge. See the module header for the algebra and the conflict rule. */
export function mergeDictionary(input: MergeInput): MergeOutput {
	const note = input.note == null ? null : toSet(input.note);
	const file = input.file == null ? null : toSet(input.file);
	const pending = toSet(input.pending);
	const removals = toSet(input.removals);
	const sides: Set<string>[] = [];
	if (note) sides.push(note);
	if (file) sides.push(file);

	const firstRun = input.base == null;
	let base: Set<string>;
	if (firstRun) {
		// Adopt the union as the base: `deleted` is then empty by construction (see header).
		base = new Set<string>();
		for (const side of sides) for (const w of side) base.add(w);
		for (const w of pending) base.add(w);
	} else {
		base = toSet(input.base);
	}

	// added = (N \ B) ∪ (F \ B) ∪ P — pending counts unconditionally, so an explicit local
	// add-to-dictionary of a word the base already knows still wins against a remote deletion.
	const added = new Set<string>(pending);
	for (const side of sides) for (const w of side) if (!base.has(w)) added.add(w);
	// An explicit removal cancels the word's additions BEFORE the conflict rule below reads `added`,
	// so "addition wins over deletion" cannot resurrect a word the user just deleted in the editor.
	for (const w of removals) added.delete(w);

	// deleted = (B \ N) ∪ (B \ F), over PRESENT sides only; additions win over deletions.
	// SKIPPED on a first run: the base is then the UNION of the sides, so a word only one side holds
	// would read as a deletion by the other and the whole migration would eat the dictionary.
	const dropped = new Set<string>();
	if (!firstRun) {
		for (const w of base) {
			if (added.has(w)) continue; // addition wins over a concurrent deletion
			for (const side of sides) {
				if (!side.has(w)) {
					dropped.add(w);
					break;
				}
			}
		}
	}

	const result = new Set<string>();
	for (const w of base) if (!dropped.has(w)) result.add(w);
	for (const w of added) result.add(w);
	// Applied last and unconditionally — including on a first run, where deletion INFERENCE is
	// skipped but a stated deletion still stands. `deleted` (base \ result) picks these up for free,
	// and `noteChanged`/`fileChanged` go true for any side that still lists the word, which is what
	// makes the reconcile rewrite that side.
	for (const w of removals) result.delete(w);

	return {
		result: sortWords(result),
		added: sortWords([...result].filter((w) => !base.has(w))),
		deleted: sortWords([...base].filter((w) => !result.has(w))),
		noteChanged: note !== null && !sameSet(note, result),
		fileChanged: file !== null && !sameSet(file, result),
		firstRun,
	};
}
