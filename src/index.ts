import joplin from 'api';
import { ContentScriptType } from 'api/types';
import { LocalLinter, createBinaryModuleFromUrl, Dialect, Lint, SuggestionKind } from 'harper.js';

const CONTENT_SCRIPT_ID = 'harperCm';

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
	message: string;
	problemText: string;
	suggestions: PlainSuggestion[];
}

interface LintMessage {
	type: 'lint';
	text: string;
}

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

function lintToPlain(lint: Lint): PlainLint {
	const span = lint.span();
	const suggestions: PlainSuggestion[] = lint.suggestions().map((sug) => ({
		kind: suggestionKindToString(sug.kind()),
		replacementText: sug.get_replacement_text(),
	}));
	return {
		start: span.start,
		end: span.end,
		kind: lint.lint_kind(),
		message: lint.message(),
		problemText: lint.get_problem_text(),
		suggestions,
	};
}

// webpack rewrites bare `require(...)` inside the bundle; __non_webpack_require__ emits a raw
// runtime `require` resolved by Node/Electron instead. The plugin main process runs with Node
// integration, so this gives us the real `fs`.
declare const __non_webpack_require__: (id: string) => any;

// Lazily-initialised singleton linter. The WASM binary + dictionary load is heavy
// (~15 MB), so we defer it to the first lint request and memoise the promise.
let linterPromise: Promise<LocalLinter> | null = null;

async function getLinter(): Promise<LocalLinter> {
	if (!linterPromise) {
		linterPromise = (async () => {
			// We ship the .wasm inside dist/ (webpack CopyPlugin). We do NOT hand harper.js a file://
			// URL: its file:// code path does a native `import('fs')`, which the Electron editor/plugin
			// renderer's Blink module loader cannot resolve ("Failed to resolve module specifier 'fs'").
			// Instead we read the bytes ourselves via Node's `require('fs')` (available in the plugin
			// main process) and hand harper a data: URL, which `fetch()` supports in both Node (undici)
			// and the Electron renderer — no CSP, no fs module resolution in Blink.
			const installDir = await joplin.plugins.installationDir();
			const sep = installDir.endsWith('/') ? '' : '/';
			const wasmPath = `${installDir}${sep}harper_wasm_bg.wasm`;
			const fs = __non_webpack_require__('fs');
			const bytes: Buffer = fs.readFileSync(wasmPath);
			const dataUrl = `data:application/wasm;base64,${bytes.toString('base64')}`;
			const binary = createBinaryModuleFromUrl(dataUrl, 'full');
			const linter = new LocalLinter({ binary, dialect: Dialect.American });
			await linter.setup();
			return linter;
		})();
	}
	return linterPromise;
}

async function handleMessage(message: LintMessage | unknown): Promise<PlainLint[] | null> {
	if (!message || typeof message !== 'object' || (message as LintMessage).type !== 'lint') {
		return null;
	}
	const text = (message as LintMessage).text ?? '';
	const linter = await getLinter();
	const lints = await linter.lint(text, { language: 'markdown' });
	return lints.map(lintToPlain);
}

joplin.plugins.register({
	onStart: async () => {
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, handleMessage);
	},
});
