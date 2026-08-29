/**
 * THE SETTINGS EXPORT (v1.5.0) — Harper's current dialect and rule overrides, as a plain JSON file
 * the plugin owns outright.
 *
 * The dictionary already crosses over: the desktop plugin mirrors the Harper word list into the
 * user's external dictionary file, and harper-ls (in Zed, Neovim, Helix, VS Code) reads that same
 * file. Rule overrides and the dialect had no such bridge — a user who turned SentenceCapitalization
 * off in Joplin still got it in their editor.
 *
 * ── THE FILE IS OURS, AND ONLY OURS ──────────────────────────────────────────────────────────────
 * v1.5.0 went through two worse designs before this one, and both failures are worth recording.
 *
 * A "Copy Zed settings block" BUTTON put a block on screen for the user to paste by hand. It is
 * regenerated on every rule change, so the pasted copy starts drifting from the real one immediately
 * — which is the exact problem a bridge exists to solve.
 *
 * SPLICING THE BLOCK INTO ZED'S OWN settings.json fixed the drift and bought a much worse problem:
 * the plugin would be editing another application's configuration in place, needing a JSONC parser to
 * survive the user's comments, a backup file in case it got it wrong, and a fail-closed path for
 * every config it could not parse. All of that machinery existed to make an intrusion safe rather
 * than to avoid it. And the block's shape is Zed-specific (`lsp.harper-ls.settings.harper-ls`, with
 * the doubled key Zed requires), so a VS Code user pointing the setting at their own settings.json
 * would have got a modified file and no working harper-ls — silent, plausible, and wrong.
 *
 * So: ONE FILE, AT A PATH THE USER NAMES, WRITTEN WHOLESALE, CONTAINING NOTHING BUT HARPER'S OWN
 * STATE. No other program's format, no other program's file, nothing to preserve, nothing to back up,
 * and no parser that can be defeated by a comment. Whoever wants the data — a Zed config generator, a
 * dotfiles script, harper-ls via a symlink — reads it from there and decides for themselves what to
 * do with it. The plugin's promise is small enough to always be true.
 *
 * ── THE VOCABULARY IS HARPER'S ───────────────────────────────────────────────────────────────────
 * `{"dialect": "...", "linters": {...}}` — the names harper-ls itself uses, so a consumer needs no
 * translation table. It is deliberately FLAT: any nesting would be some particular editor's, and this
 * file belongs to none of them.
 *
 * WHAT IS NOT EXPORTED. Dismissed findings cannot be: harper's ignore hashes are u64s computed over
 * the lint's own span and context, and the plugin's and harper-ls's are not interchangeable (verified
 * during the v1.5.0 research). Exporting them would produce a file that silently ignores nothing.
 * Paths are left out too — they are per-device, and this file may well be synced between machines.
 *
 * Dependency-free on purpose (no `joplin`, no `fs`, no harper.js), like dictionaryMerge.ts and
 * syncNote.ts, so the harness can transpile and unit-test it directly.
 */

/** Rule name -> explicit boolean. Structurally `LintConfig`, restated so this module imports nothing. */
export type RuleMap = Record<string, boolean>;

/**
 * The dialect names, exactly as harper's own `Dialect` enum spells them.
 *
 * CASE-SENSITIVE, and an unrecognised value is not merely ignored downstream: harper-ls's
 * `Config::from_lsp_config` runs its whole object through one `serde_json::from_value`, so a bad
 * dialect fails the ENTIRE parse and silently reverts every other key with it. Hence the allowlist
 * rather than a pass-through, and hence the American fallback rather than an omission — a consumer
 * that inherits this file's value should never be handed something that poisons its own config.
 */
export const EXPORT_DIALECTS: readonly string[] = [
	'American',
	'British',
	'Australian',
	'Canadian',
	'Indian',
];

/**
 * The dialect to write.
 *
 * Written as a MAPPING rather than assumed to be an identity, because the plugin's setting is a free
 * string that a hand-edited settings.json can hold anything in. Anything unrecognised falls back to
 * harper's own default rather than being emitted verbatim.
 */
export function exportDialect(dialect: string): string {
	return EXPORT_DIALECTS.includes(dialect) ? dialect : 'American';
}

/**
 * The `linters` map: SPARSE — only rules whose value actually differs from harper's default.
 *
 * The plugin's `ruleOverrides` is already sparse in the sense of "only keys the user touched", but a
 * user can explicitly set a rule to the value it already had (toggle off, toggle back on leaves
 * `{"X": true}` behind when true is the default). Emitting those would make the file noisy and,
 * worse, would pin a rule to a value harper may later change its mind about — the whole point of
 * "Default" being the absence of a key.
 *
 * A key the local harper build has NO default for is KEPT rather than dropped. It is an override
 * adopted from a device running a newer harper.js, and D-9-a's rule holds here too: this build
 * cannot evaluate it, so it must not destroy it. harper-ls deserializes unknown linter keys into its
 * map without error and simply never consults them, so keeping one is free.
 */
export function sparseLinters(overrides: RuleMap, defaults: RuleMap): RuleMap {
	const out: RuleMap = {};
	for (const name of Object.keys(overrides || {}).sort()) {
		const value = overrides[name];
		if (typeof value !== 'boolean') continue;
		const fallback = (defaults || {})[name];
		if (typeof fallback === 'boolean' && fallback === value) continue; // already the default
		out[name] = value;
	}
	return out;
}

/**
 * The exported settings as a plain value: `{ dialect, linters? }`.
 *
 * `linters` is OMITTED rather than written as `{}` when the user has overridden nothing. An empty map
 * and an absent key mean the same thing to every reader, and the absent one says it without inviting
 * anyone to wonder whether Harper meant "disable all the linters".
 */
export function buildSettingsExport(args: {
	overrides: RuleMap;
	defaults: RuleMap;
	dialect: string;
}): Record<string, unknown> {
	const linters = sparseLinters(args.overrides, args.defaults);
	// The key order is fixed rather than incidental — see buildSettingsExportFile on why that matters.
	const out: Record<string, unknown> = { dialect: exportDialect(args.dialect) };
	if (Object.keys(linters).length) out.linters = linters;
	return out;
}

/**
 * The file's exact bytes: pretty-printed with a tab indent and one trailing newline.
 *
 * DETERMINISTIC BY CONSTRUCTION — `sparseLinters` sorts its keys and the wrapper's are literal — so
 * "write only when the content changed" is a real no-op rather than a coin flip. That is what keeps
 * the plugin from rewriting (and re-syncing, and dirtying the git status of) a dotfile on every
 * warm-up and every settings change that had nothing to do with it.
 */
export function buildSettingsExportFile(args: {
	overrides: RuleMap;
	defaults: RuleMap;
	dialect: string;
}): string {
	return `${JSON.stringify(buildSettingsExport(args), null, '\t')}\n`;
}
