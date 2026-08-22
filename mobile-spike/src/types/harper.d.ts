// Minimal ambient declaration for the slice of the harper.js 2.7.0 runtime the spike consumes.
//
// We deliberately do NOT lean on harper.js's own bundled .d.ts: that package is ESM with an
// "exports" map and its declarations use `Symbol.dispose` computed members that trip older TS libs.
// Webpack resolves and bundles the real runtime via the package "exports" map at build time (see
// webpack.config.js conditionNames); this shim only feeds the type-checker the shapes we touch.

declare module 'harper.js' {
	export enum Dialect {
		American = 0,
		British = 1,
		Australian = 2,
		Canadian = 3,
		Indian = 4,
	}

	/** Opaque binary module handle (the inlined-WASM data-URL wrapper). */
	export interface BinaryModule {
		setup(): Promise<void>;
	}

	export interface LinterInit {
		binary: BinaryModule;
		dialect?: Dialect;
	}

	export interface LintOptions {
		language?: 'plaintext' | 'markdown' | 'typst';
	}

	/** A single lint finding. We only ever count them in the spike, so the surface is opaque. */
	export interface Lint {
		lint_kind?(): string;
		message?(): string;
	}

	export class LocalLinter {
		constructor(init: LinterInit);
		setup(): Promise<void>;
		lint(text: string, options?: LintOptions): Promise<Lint[]>;
	}
}

declare module 'harper.js/slimBinaryInlined' {
	import { BinaryModule } from 'harper.js';
	/** The slimmed-down Harper WebAssembly binary stored inline as a base64 data: URL. */
	export const slimBinaryInlined: BinaryModule;
}
