// Joplin CM6 content script: registers a stock @codemirror/lint linter that delegates
// the actual grammar checking to the plugin main process (where harper.js/WASM runs).
//
// IMPORTANT: @codemirror/* modules are consumed as webpack EXTERNALS (see webpack.config.js).
// Joplin injects its own copies of these into the editor at runtime; bundling ours would
// duplicate CodeMirror and break the editor. The emitted bundle must keep
// `require('@codemirror/lint')` (and '@codemirror/view') as external references.

import { linter, setDiagnostics, Diagnostic, Action } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';

interface PlainSuggestion {
	kind: 'Replace' | 'Remove' | 'InsertAfter';
	replacementText: string;
}
interface PlainLint {
	start: number;
	end: number;
	kind: string;
	ruleName: string;
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
	editor?: EditorView;
	addExtension: (extension: unknown | unknown[]) => void;
	registerCommand: (name: string, callback: (...args: unknown[]) => unknown) => void;
}

// Fallback debounce if the config handshake fails (ms).
const DEFAULT_DELAY_MS = 500;

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

function buildSuggestionAction(suggestion: PlainSuggestion): Action {
	return {
		name: suggestionLabel(suggestion),
		apply: (view: EditorView, from: number, to: number) => {
			if (suggestion.kind === 'Remove') {
				view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
			} else if (suggestion.kind === 'InsertAfter') {
				const text = suggestion.replacementText;
				view.dispatch({ changes: { from: to, to, insert: text }, selection: { anchor: to + text.length } });
			} else {
				const text = suggestion.replacementText;
				view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
			}
		},
	};
}

/**
 * Post a message to the plugin main process, then recompute + apply diagnostics so the UI updates.
 *
 * We deliberately do NOT use `forceLinting(view)` here: in Joplin's bundled `@codemirror/lint`,
 * `forceLinting` returns without re-invoking the lint source (verified empirically — the source is
 * never re-queried after the call), so a stale underline would linger for actions that don't change
 * the document (Add to dictionary / Ignore / Disable rule change no text). Instead `relint` queries
 * the plugin for fresh lints and dispatches them via `setDiagnostics`, which deterministically
 * replaces the diagnostic set without depending on the lint plugin's internal scheduling.
 */
function postThenRelint(
	context: ContentScriptContext,
	view: EditorView,
	message: unknown,
	relint: (view: EditorView) => void,
): void {
	void context.postMessage(message).then(
		() => relint(view),
		() => {
			/* main handler failed; nothing we can re-lint against */
		},
	);
}

function toDiagnostic(
	context: ContentScriptContext,
	docText: string,
	lint: PlainLint,
	relint: (view: EditorView) => void,
): Diagnostic {
	// Severity mapping: spelling => error, everything else => warning.
	const severity: Diagnostic['severity'] = lint.kind === 'Spelling' ? 'error' : 'warning';

	const actions: Action[] = lint.suggestions.map(buildSuggestionAction);

	// 'Add to dictionary' — Spelling lints only.
	if (lint.kind === 'Spelling') {
		const word = lint.problemText;
		actions.push({
			name: 'Add to dictionary',
			apply: (view: EditorView) => {
				postThenRelint(context, view, { type: 'addWord', word }, relint);
			},
		});
	}

	// 'Ignore' — any lint. Carries the source text + span + rule so main can match the finding.
	actions.push({
		name: 'Ignore',
		apply: (view: EditorView) => {
			postThenRelint(
				context,
				view,
				{
					type: 'ignoreLint',
					text: docText,
					start: lint.start,
					end: lint.end,
					ruleName: lint.ruleName,
				},
				relint,
			);
		},
	});

	// 'Disable rule <name>' — any lint.
	if (lint.ruleName) {
		actions.push({
			name: `Disable rule ${lint.ruleName}`,
			apply: (view: EditorView) => {
				postThenRelint(context, view, { type: 'disableRule', ruleName: lint.ruleName }, relint);
			},
		});
	}

	return {
		from: lint.start,
		to: lint.end,
		severity,
		source: 'Harper',
		message: lint.message,
		actions,
	};
}

export default (context: ContentScriptContext) => {
	return {
		plugin: (editorControl: CodeMirrorControl) => {
			// Only wire up on CodeMirror 6; the legacy CM5 emulation lacks `cm6`/addExtension.
			if (!editorControl.cm6) return;

			// Query the plugin main process for lints of the current document and map them to
			// @codemirror/lint diagnostics. Used both as the `linter()` source (debounced, on
			// docChanged) and by `relint` (immediate, after a tooltip action / main-process poke).
			const runLint = async (view: EditorView): Promise<Diagnostic[]> => {
				const text = view.state.doc.toString();
				const response = (await context.postMessage({ type: 'lint', text })) as
					| PlainLint[]
					| null;
				if (!Array.isArray(response)) return [];
				return response.map((lint) => toDiagnostic(context, text, lint, relint));
			};

			// Recompute diagnostics now and apply them via `setDiagnostics` — see postThenRelint for
			// why we don't use `forceLinting`. Safe to call with no editor/view.
			const relint = (view: EditorView): void => {
				if (!view) return;
				void runLint(view).then(
					(diagnostics) => {
						try {
							view.dispatch(setDiagnostics(view.state, diagnostics));
						} catch {
							/* view may have been torn down */
						}
					},
					() => {
						/* lint request failed; leave existing diagnostics in place */
					},
				);
			};

			// Ask the plugin main process for the configured debounce before building the linter.
			// (Changing debounceMs later requires reopening the note; documented tradeoff.)
			void (async () => {
				let delay = DEFAULT_DELAY_MS;
				try {
					const config = (await context.postMessage({ type: 'getConfig' })) as
						| { enabled: boolean; debounceMs: number }
						| null;
					if (config && typeof config.debounceMs === 'number') delay = config.debounceMs;
				} catch {
					/* keep the default */
				}

				editorControl.addExtension(linter(runLint, { delay }));

				// Register the command the plugin main process pokes after settings/dictionary changes.
				// We read `editorControl.editor` freshly on each invocation so a note switch (new view)
				// is handled, and re-lint via `relint` (setDiagnostics) rather than the no-op
				// `forceLinting`. `harper.forceLint` therefore genuinely refreshes the underlines.
				try {
					editorControl.registerCommand('harper.forceLint', () => {
						const current = editorControl.editor;
						if (current) relint(current);
					});
				} catch {
					/* registerCommand unavailable — main's poke will simply no-op */
				}
			})();
		},
	};
};
