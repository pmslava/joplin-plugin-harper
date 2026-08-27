// Minimal ambient declaration for the harper.js runtime surface we consume.
//
// We deliberately do NOT rely on TypeScript resolving harper.js's own bundled
// .d.ts: that package is ESM with an "exports" map (which the stock commonjs
// `moduleResolution: node` cannot read) and its declarations use `Symbol.dispose`
// computed members that trip older TS libs. Webpack resolves and bundles the real
// runtime via the package "exports" map at build time; this shim only feeds the
// type-checker the shapes this plugin actually touches. Pinned against harper.js 2.7.0.

declare module 'harper.js' {
	export enum Dialect {
		American = 0,
		British = 1,
		Australian = 2,
		Canadian = 3,
		Indian = 4,
	}

	/** Tags the variant of a Suggestion. */
	export enum SuggestionKind {
		Replace = 0,
		Remove = 1,
		InsertAfter = 2,
	}

	export interface BinaryModule {
		setup(): Promise<void>;
	}

	/** Build a BinaryModule from a URL (file:// under Node reads via fs). */
	export function createBinaryModuleFromUrl(url: string, glueFlavor?: 'full' | 'slim'): BinaryModule;

	/** A source span in UTF-16 code units (drop straight into CodeMirror from/to). */
	export class Span {
		start: number;
		end: number;
	}

	export class Suggestion {
		/** Replacement text; empty string for a Remove suggestion. */
		get_replacement_text(): string;
		/** 0 = Replace, 1 = Remove, 2 = InsertAfter. */
		kind(): SuggestionKind;
	}

	export class Lint {
		/** The offending source substring. */
		get_problem_text(): string;
		/** Machine key for the rule category, e.g. "Spelling". */
		lint_kind(): string;
		lint_kind_pretty(): string;
		message(): string;
		message_html(): string;
		span(): Span;
		suggestion_count(): number;
		suggestions(): Suggestion[];
	}

	export interface LintOptions {
		language?: 'plaintext' | 'markdown' | 'typst';
		regex_mask?: string;
		forceAllHeadings?: boolean;
		dedup?: boolean;
		isolateEnglish?: boolean;
	}

	export interface LinterInit {
		binary: BinaryModule;
		dialect?: Dialect;
	}

	/** A flat map of rule name -> enabled (true/false) or null (use default). */
	export type LintConfig = Record<string, boolean | null>;

	// --- structured (presentation-only) lint config --------------------------
	//
	// getStructuredLintConfig() is a TREE for rendering a settings UI: groups, ordering and labels.
	// It is NOT a source of values. In 2.7.0 `Bool.state` is literally `flatConfig[name] ?? false`,
	// so an unset rule reports `false` even when its DEFAULT is `true` — reading values from here
	// would silently disable ~814 rules in the UI. Values come from getLintConfig() (sparse, only
	// what was last set) resolved against getDefaultLintConfig() (always concrete booleans).
	//
	// `Bool.label` is null for every rule in 2.7.0, so display labels have to be derived from `name`.
	// 2.7.0 emits 15 Group nodes and 823 Bool nodes and no OneOfMany node, but OneOfMany is part of
	// the type and is declared here so a future harper release cannot break the exhaustive handling.

	export interface StructuredLintBoolSetting {
		Bool: {
			name: string;
			/** NOT the effective value — see the note above. Presentation only. */
			state: boolean;
			label?: string | null;
		};
	}

	export interface StructuredLintOneOfManySetting {
		OneOfMany: {
			names: string[];
			name?: string | null;
			labels?: string[] | null;
		};
	}

	export interface StructuredLintGroupSetting {
		Group: {
			label: string;
			description: string;
			child: StructuredLintConfig;
		};
	}

	export type StructuredLintSetting =
		| StructuredLintBoolSetting
		| StructuredLintOneOfManySetting
		| StructuredLintGroupSetting;

	/** Recursive: a Group's `child` is itself a StructuredLintConfig. */
	export interface StructuredLintConfig {
		settings: StructuredLintSetting[];
	}

	export class LocalLinter {
		constructor(init: LinterInit);
		setup(): Promise<void>;
		lint(text: string, options?: LintOptions): Promise<Lint[]>;
		/** Lint, keeping each Lint grouped under the source rule name. */
		organizedLints(text: string, options?: LintOptions): Promise<Record<string, Lint[]>>;

		// --- dialect -----------------------------------------------------------
		getDialect(): Promise<Dialect>;
		/** Rebuilds the underlying linter for the new dialect. */
		setDialect(dialect: Dialect): Promise<void>;

		// --- language detection ------------------------------------------------
		/** Heuristic ("proof of concept" per upstream) English check. */
		isLikelyEnglish(text: string): Promise<boolean>;
		/** Return only the parts of `text` that look like English. */
		isolateEnglish(text: string): Promise<string>;

		// --- rule config -------------------------------------------------------
		/**
		 * The default config: ALWAYS concrete booleans for every rule (814 true / 9 false in 2.7.0).
		 * This — not getLintConfig() — is the authoritative rule roster, because getLintConfig()
		 * echoes back only what was last passed to setLintConfig().
		 */
		getDefaultLintConfig(): Promise<LintConfig>;
		/** The SPARSE map last given to setLintConfig(); omitted keys mean "use the default". */
		getLintConfig(): Promise<LintConfig>;
		/** REPLACES the stored map wholesale — omitted keys revert to their default. */
		setLintConfig(config: LintConfig): Promise<void>;

		// --- structured config + descriptions (settings-UI surface) ------------
		/** Tree/labels/order for rendering a settings UI. Not a source of values — see the type. */
		getStructuredLintConfig(): Promise<StructuredLintConfig>;
		getStructuredLintConfigJSON(): Promise<string>;
		/** Rule name -> description, formatted in Markdown (823 complete entries in 2.7.0). */
		getLintDescriptions(): Promise<Record<string, string>>;
		getLintDescriptionsAsJSON(): Promise<string>;
		/** Rule name -> description, formatted in HTML. */
		getLintDescriptionsHTML(): Promise<Record<string, string>>;
		getLintDescriptionsHTMLAsJSON(): Promise<string>;

		// --- user dictionary ---------------------------------------------------
		/** Add words to the user dictionary. Batch where possible. */
		importWords(words: string[]): Promise<void>;
		/** Clear words added via importWords (leaves the curated dictionary). */
		clearWords(): Promise<void>;
		exportWords(): Promise<string[]>;

		// --- ignored lints -----------------------------------------------------
		ignoreLint(source: string, lint: Lint): Promise<void>;
		ignoreLints(source: string, lints: Lint[]): Promise<void>;
		/** Ignore a finding by a hash previously obtained from contextHash(). */
		ignoreLintHash(hash: bigint): Promise<void>;
		/**
		 * The context-sensitive hash identifying a finding — the same u64 that shows up in
		 * exportIgnoredLints()'s `context_hashes` array. These EXCEED Number.MAX_SAFE_INTEGER, so
		 * never route one through a JS number; stringify the bigint instead.
		 */
		contextHash(source: string, lint: Lint): Promise<bigint>;
		/**
		 * Serialize ignored lints to `{"context_hashes":[<u64>,…]}`.
		 *
		 * The u64s overflow Number.MAX_SAFE_INTEGER, so a JSON.parse -> JSON.stringify round trip
		 * CORRUPTS them and the ignores silently stop matching. Persist the returned string verbatim
		 * and extract hashes as decimal STRINGS (see src/dismissedLog.ts).
		 */
		exportIgnoredLints(): Promise<string>;
		/**
		 * MERGES (union + dedupe) into the existing set — it is not a replace. An empty
		 * `context_hashes` array is a no-op, and a bare JSON array (rather than the wrapper object)
		 * throws. The ONLY removal primitive is clearIgnoredLints().
		 */
		importIgnoredLints(json: string): Promise<void>;
		clearIgnoredLints(): Promise<void>;
	}
}
