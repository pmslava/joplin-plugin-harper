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

		// --- rule config -------------------------------------------------------
		getDefaultLintConfig(): Promise<LintConfig>;
		getLintConfig(): Promise<LintConfig>;
		setLintConfig(config: LintConfig): Promise<void>;

		// --- user dictionary ---------------------------------------------------
		/** Add words to the user dictionary. Batch where possible. */
		importWords(words: string[]): Promise<void>;
		/** Clear words added via importWords (leaves the curated dictionary). */
		clearWords(): Promise<void>;
		exportWords(): Promise<string[]>;

		// --- ignored lints -----------------------------------------------------
		ignoreLint(source: string, lint: Lint): Promise<void>;
		ignoreLints(source: string, lints: Lint[]): Promise<void>;
		/** Serialize ignored lints to a JSON list of privacy-respecting hashes. */
		exportIgnoredLints(): Promise<string>;
		/** Append ignored lints from a previously exported JSON list. */
		importIgnoredLints(json: string): Promise<void>;
		clearIgnoredLints(): Promise<void>;
	}
}
