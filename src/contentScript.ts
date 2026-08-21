// Joplin CM6 content script: registers a stock @codemirror/lint linter that delegates
// the actual grammar checking to the plugin main process (where harper.js/WASM runs).
//
// IMPORTANT: @codemirror/* modules are consumed as webpack EXTERNALS (see webpack.config.js).
// Joplin injects its own copies of these into the editor at runtime; bundling ours would
// duplicate CodeMirror and break the editor. The emitted bundle must keep
// `require('@codemirror/lint')` as an external reference.

import { linter, Diagnostic, Action } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';

interface PlainSuggestion {
	kind: 'Replace' | 'Remove' | 'InsertAfter';
	replacementText: string;
}
interface PlainLint {
	start: number;
	end: number;
	kind: string;
	message: string;
	problemText: string;
	suggestions: PlainSuggestion[];
}

// Joplin's ContentScriptContext (typed loosely to avoid coupling to a specific api version).
interface ContentScriptContext {
	postMessage: (message: unknown) => Promise<unknown>;
	pluginId: string;
	contentScriptId: string;
}

// The CodeMirror wrapper Joplin passes to `plugin()`. Only the bits we use are typed.
interface CodeMirrorControl {
	cm6?: unknown;
	addExtension: (extension: unknown | unknown[]) => void;
}

// Debounce between the last edit and a lint pass (ms). Spike-level fixed default.
const LINT_DELAY_MS = 500;

function suggestionLabel(suggestion: PlainSuggestion): string {
	switch (suggestion.kind) {
		case 'Remove':
			return 'Remove';
		case 'InsertAfter':
			return `Insert "${suggestion.replacementText}"`;
		case 'Replace':
		default:
			return `Replace with "${suggestion.replacementText}"`;
	}
}

function buildAction(suggestion: PlainSuggestion): Action {
	return {
		name: suggestionLabel(suggestion),
		apply: (view: EditorView, from: number, to: number) => {
			if (suggestion.kind === 'Remove') {
				view.dispatch({ changes: { from, to, insert: '' } });
			} else if (suggestion.kind === 'InsertAfter') {
				view.dispatch({ changes: { from: to, to, insert: suggestion.replacementText } });
			} else {
				view.dispatch({ changes: { from, to, insert: suggestion.replacementText } });
			}
		},
	};
}

function toDiagnostic(lint: PlainLint): Diagnostic {
	// Spike-level severity mapping: spelling => error, everything else => warning.
	const severity: Diagnostic['severity'] = lint.kind === 'Spelling' ? 'error' : 'warning';
	return {
		from: lint.start,
		to: lint.end,
		severity,
		source: 'Harper',
		message: lint.message,
		actions: lint.suggestions.map(buildAction),
	};
}

export default (context: ContentScriptContext) => {
	return {
		plugin: (editorControl: CodeMirrorControl) => {
			// Only wire up on CodeMirror 6; the legacy CM5 emulation lacks `cm6`/addExtension.
			if (!editorControl.cm6) return;

			const harperLinter = linter(
				async (view: EditorView): Promise<Diagnostic[]> => {
					const text = view.state.doc.toString();
					const response = (await context.postMessage({ type: 'lint', text })) as
						| PlainLint[]
						| null;
					if (!Array.isArray(response)) return [];
					return response.map(toDiagnostic);
				},
				{ delay: LINT_DELAY_MS },
			);

			editorControl.addExtension(harperLinter);
		},
	};
};
