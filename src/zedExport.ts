/**
 * THE ZED BRIDGE — a ready-to-paste `harper-ls` settings block, written next to the dictionary file.
 *
 * The dictionary already crosses over: the desktop plugin mirrors the Harper note into the user's
 * external word-list file, and harper-ls (in Zed, Neovim, Helix, VS Code) reads that same file. Rule
 * overrides and the dialect had no such bridge — a user who turned SentenceCapitalization off in
 * Joplin still got it in their editor.
 *
 * This module closes that half, and it deliberately stops short of the obvious next step: it writes
 * a FILE the user copies from, and NEVER splices anything into Zed's own `settings.json`. That file
 * is the user's, hand-maintained, comment-bearing JSONC that no JSON round-trip can preserve — and a
 * plugin that rewrites another application's configuration behind the user's back is the kind of
 * thing this project does not do. Copy-and-paste is a smaller promise that is always true.
 *
 * WHAT DOES NOT CROSS. Dismissed findings cannot: harper's ignore hashes are u64s computed over the
 * lint's own span and context, and the plugin's and harper-ls's are not interchangeable (verified
 * during the v1.5.0 research). Exporting them would produce a file that silently ignores nothing.
 *
 * THE SHAPE IS VERIFIED, not inferred. Zed nests the server's own config root INSIDE its LSP block,
 * so the key `harper-ls` appears TWICE — once as Zed's language-server id, once as harper-ls's own
 * configuration root — and the Zed extension's README states outright that "both of the two nested
 * layers of `harper-ls` are required". Getting this wrong yields a block that pastes cleanly and
 * does nothing at all.
 */

/** Rule name -> explicit boolean. Structurally `LintConfig`, restated so this module imports nothing. */
export type RuleMap = Record<string, boolean>;

/** The file written beside the external dictionary. */
export const ZED_EXPORT_FILENAME = 'zed-harper-ls.json';

/**
 * harper-ls's `dialect` values, exactly as its Rust enum deserializes them.
 *
 * CASE-SENSITIVE, and an unrecognised value is not merely ignored: `Config::from_lsp_config` runs
 * the whole object through one `serde_json::from_value`, so a bad dialect fails the ENTIRE harper-ls
 * config parse and silently reverts every other key in the block. Hence the allowlist rather than a
 * pass-through, and hence the American fallback rather than an omission.
 */
export const HARPER_LS_DIALECTS: readonly string[] = [
	'American',
	'British',
	'Australian',
	'Canadian',
	'Indian',
];

/**
 * Map the plugin's dialect setting onto harper-ls's.
 *
 * The two vocabularies are identical today (both come from harper's own `Dialect` enum), so this is
 * an identity map — but it is written as a MAPPING rather than assumed to be one, because the
 * plugin's setting is a free string that a hand-edited settings.json can hold anything in, and
 * because the two projects are free to diverge. Anything unrecognised falls back to harper-ls's own
 * default rather than being emitted and poisoning the parse.
 */
export function zedDialect(dialect: string): string {
	return HARPER_LS_DIALECTS.includes(dialect) ? dialect : 'American';
}

/**
 * The `linters` map: SPARSE — only rules whose value actually differs from harper's default.
 *
 * The plugin's `ruleOverrides` is already sparse in the sense of "only keys the user touched", but a
 * user can explicitly set a rule to the value it already had (toggle off, toggle back on leaves
 * `{"X": true}` behind when true is the default). Emitting those would make the block noisy and,
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
 * The settings object, as a plain value.
 *
 * `statsPath` IS NEVER EMITTED, and the reason is worth recording because it is not obvious. It
 * looks like the key that would redirect harper-ls's stats file, and it is undocumented; in
 * harper-ls's own `config.rs` the branch that reads it assigns `base.file_dict_path` — not
 * `stats_path` — so setting it silently relocates the file-local DICTIONARY directory. Emitting it
 * would move a user's dictionaries somewhere they never asked for, to achieve nothing.
 *
 * Nothing else is emitted either. The block carries exactly what the plugin actually knows about:
 * the rules the user changed and the dialect they chose. Paths in particular are left alone —
 * they are per-device, and a generated absolute path is the one thing a shared, pasteable block
 * must not contain.
 */
export function buildZedSettings(args: {
	overrides: RuleMap;
	defaults: RuleMap;
	dialect: string;
}): Record<string, unknown> {
	const linters = sparseLinters(args.overrides, args.defaults);
	// The inner object's key order is fixed rather than incidental: this file is regenerated on every
	// rule change, and a key order that wandered would rewrite the file (and dirty the user's sync)
	// with no change in meaning.
	const harperLs: Record<string, unknown> = { dialect: zedDialect(args.dialect) };
	if (Object.keys(linters).length) harperLs.linters = linters;
	return { lsp: { 'harper-ls': { settings: { 'harper-ls': harperLs } } } };
}

/**
 * The file's exact bytes: pretty-printed with a tab indent and one trailing newline.
 *
 * DETERMINISTIC BY CONSTRUCTION — `sparseLinters` sorts its keys and the wrapper's are literal — so
 * "write only when the content changed" is a real no-op rather than a coin flip, exactly as the
 * dictionary file's own rewrite guard needs it to be.
 */
export function buildZedSettingsFile(args: {
	overrides: RuleMap;
	defaults: RuleMap;
	dialect: string;
}): string {
	return `${JSON.stringify(buildZedSettings(args), null, '\t')}\n`;
}

/**
 * The block the dialog offers to copy — the same bytes as the file, minus the trailing newline.
 *
 * ONE BUILDER for both surfaces. Two would drift, and the drift would be invisible: the user would
 * paste something subtly different from the file the plugin maintains, and neither of them would be
 * wrong enough to notice.
 */
export function buildZedSettingsBlock(args: {
	overrides: RuleMap;
	defaults: RuleMap;
	dialect: string;
}): string {
	return buildZedSettingsFile(args).trimEnd();
}

/**
 * `<dir of p>/<file>` — the export sits beside the dictionary, wherever that is.
 *
 * Returns `''` when `p` names no directory at all. "Beside" is the whole contract, and a bare
 * filename has no beside: the write would land in the process's working directory, which for a
 * desktop plugin is Joplin's own installation directory rather than anywhere the user asked for. A
 * dictionary path with no directory is unusual but perfectly typeable, and the honest answer to it
 * is to decline rather than to guess a location.
 */
export function siblingPath(p: string, file: string): string {
	const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return cut >= 0 ? `${p.slice(0, cut + 1)}${file}` : '';
}

/** Where the export goes for a given dictionary path, or `''` when there is nowhere to put it. */
export function zedExportPath(dictionaryPath: string): string {
	const p = (dictionaryPath || '').trim();
	return p ? siblingPath(p, ZED_EXPORT_FILENAME) : '';
}
