// Harper Mobile Spike — CM6 content script (S5).
//
// Independent of the WASM probe. Proves, on-device, that: a Joplin content script LOADS in the mobile
// editor, the Joplin-provided @codemirror/* modules resolve (they are webpack externals), a decoration
// PAINTS, and a tap/click card OPENS. It flags every literal occurrence of the word 'spiketest' with a
// diagnostic (markClass 'spike-underline' + injected red squiggle CSS) and opens a one-button dummy
// card on click. On registration it posts an 'S5 content script loaded in editor' line to the results
// note (the plugin main process forwards it via contentScripts.onMessage).
//
// The click-to-open mechanism (showTooltip StateField + mousedown hit-test) is the thin version of the
// parent plugin's card trigger, stripped to a single dummy card.

import { linter, forEachDiagnostic, Diagnostic } from '@codemirror/lint';
import { EditorView, showTooltip, Tooltip } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface ContentScriptContext {
	postMessage: (message: unknown) => Promise<unknown>;
	pluginId: string;
	contentScriptId: string;
}

interface CodeMirrorControl {
	cm6?: unknown;
	editor?: EditorView;
	addExtension: (extension: unknown | unknown[]) => void;
}

const SPIKE_WORD = 'spiketest';
const STYLE_ELEMENT_ID = 'harper-spike-styles';

// --- click-to-open card (thin showTooltip StateField) -----------------------
const setClickCard = StateEffect.define<Tooltip | null>();
const clickCardField = StateField.define<Tooltip | null>({
	create: () => null,
	update(value, tr) {
		if (tr.docChanged) return null; // self-close on any edit
		for (const e of tr.effects) if (e.is(setClickCard)) value = e.value;
		return value;
	},
	provide: (f) => showTooltip.from(f),
});

function ensureStyles(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ELEMENT_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = `
.cm-lintRange.spike-underline{
  text-decoration: underline wavy #e11d48;
  text-decoration-skip-ink: none;
  background-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="6" height="3"><path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="%23e11d48" fill="none" stroke-width="1"/></svg>');
  background-position:left bottom;background-repeat:repeat-x;padding-bottom:0.7px;
}
.cm-tooltip.spike-click-tooltip{background:transparent;border:none;padding:0;}
.spike-card{max-width:280px;background:#ffffff;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 12px rgba(140,149,159,0.3);padding:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;z-index:5000;}
.spike-card .spike-title{font-weight:600;margin-bottom:8px;}
.spike-card button{cursor:pointer;border:none;border-radius:6px;padding:4px 10px;font-size:13px;font-weight:600;background:#2563eb;color:#fff;}
`;
	(document.head || document.documentElement).appendChild(style);
}

/** Build the dummy card: title 'Spike card' + one 'It works' button that closes it. */
function buildCard(view: EditorView): HTMLElement {
	ensureStyles();
	const card = document.createElement('div');
	card.className = 'spike-card';

	const title = document.createElement('div');
	title.className = 'spike-title';
	title.textContent = 'Spike card';
	card.appendChild(title);

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.textContent = 'It works';
	btn.addEventListener('click', () => {
		try {
			view.dispatch({ effects: setClickCard.of(null) });
		} catch {
			/* view may be mid-teardown */
		}
	});
	card.appendChild(btn);
	return card;
}

function buildClickTooltip(from: number, to: number): Tooltip {
	return {
		pos: from,
		end: to,
		above: false,
		create: (view: EditorView) => {
			const dom = document.createElement('div');
			dom.className = 'spike-click-tooltip';
			dom.appendChild(buildCard(view));
			return { dom };
		},
	};
}

/** Flag every literal occurrence of SPIKE_WORD in the document. */
function spikeLintSource(view: EditorView): Diagnostic[] {
	const text = view.state.doc.toString();
	const out: Diagnostic[] = [];
	let idx = text.indexOf(SPIKE_WORD);
	while (idx !== -1) {
		out.push({
			from: idx,
			to: idx + SPIKE_WORD.length,
			severity: 'warning',
			source: 'HarperSpike',
			message: 'spiketest (spike decoration)',
			markClass: 'spike-underline',
		});
		idx = text.indexOf(SPIKE_WORD, idx + SPIKE_WORD.length);
	}
	return out;
}

export default (context: ContentScriptContext) => {
	return {
		plugin: (editorControl: CodeMirrorControl) => {
			if (!editorControl.cm6) return;
			ensureStyles();

			editorControl.addExtension([
				linter(spikeLintSource, { delay: 100 }),
				clickCardField,
				EditorView.domEventHandlers({
					mousedown: (event: MouseEvent, view: EditorView): boolean => {
						if (event.button !== 0) return false;
						const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
						if (pos == null) return false;
						let hit: { from: number; to: number } | null = null;
						forEachDiagnostic(view.state, (_d, from, to) => {
							if (!hit && from <= pos && pos <= to) hit = { from, to };
						});
						if (hit) {
							const h = hit as { from: number; to: number };
							view.dispatch({ effects: setClickCard.of(buildClickTooltip(h.from, h.to)) });
						} else if (view.state.field(clickCardField, false)) {
							view.dispatch({ effects: setClickCard.of(null) });
						}
						return false;
					},
				}),
			]);

			// Report that the content script loaded in a real editor (proves module resolution + load).
			void context.postMessage({ type: 's5log' });
		},
	};
};
