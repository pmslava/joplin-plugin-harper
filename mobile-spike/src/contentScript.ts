// Harper Mobile Spike v0.0.3 — SELF-DIAGNOSING CM6 content script (S5, staged activation + heartbeat).
//
// SHARED by both v0.0.3 variants (engine and no-engine) — this script never imports harper.js, so it
// is byte-identical regardless of which main-process entry ships. v0.0.3 changes vs v0.0.2:
//   - STAGE_GAP_MS tightened 3000 -> 2000 (stages land sooner; a crash between reports is still
//     attributable to exactly one stage).
//   - an EDITOR-SIDE HEARTBEAT: every 5 s for 2 minutes we post 'S5 HEARTBEAT[id] t=<n>s', so the
//     results note time-stamps precisely WHEN the editor webview dies even BETWEEN stages (v0.0.2's
//     device evidence showed the death happens during the idle wait, not inside a stage's action).
//
// WHY THIS EXISTS. On the Android device the ENGINE side (S0-S4, WASM in the plugin background
// WebView) succeeded completely, but the EDITOR side died: opening a note to edit "immediately closes
// the keyboard and switches to the viewer", and the results note showed 'S5 content script loaded'
// appended once per attempt. From the Joplin source (dev @ 94911a8):
//   - @codemirror/lint / view / state ARE bundled into the mobile editor (they are statically imported
//     into the shared @joplin/editor codeMirrorRequire whitelist), and since the old content script
//     posted its 's5log' AFTER addExtension AND that line appeared, module resolution + addExtension
//     already work on-device. So the killer is something the script does AFTER load.
//   - A plain JS exception in the content script is NOT fatal: the mobile MarkdownEditor webview installs
//     its own window.onerror / onunhandledrejection (MarkdownEditor.tsx:137-147) that just postMessage →
//     logs (onMessage :165-168). The ONLY automatic teardown that drops the keyboard and reloads the
//     content script is a RENDERER-PROCESS crash → ExtendedWebView.refreshWebViewAfterCrash
//     (index.tsx:92-100,144-145), which remounts the editor WebView. That reload is the user-visible
//     "keyboard closes / back to viewer" and the repeated 'S5 loaded' lines.
//
// STRATEGY. Instead of doing everything at once, we activate the old content script's machinery in TIMED
// SUB-STAGES (~3 s apart), each individually try/caught and reported to the results note via
// context.postMessage (the plugin main process forwards it, prefixing a timestamp). If a stage's report
// never arrives — or an error handler fires — the note's last S5x line fingers the killer.
//   S5a  each @codemirror module resolved (view / lint / state), reported individually
//   S5b  a no-op ViewPlugin added via addExtension            (proves addExtension alone is safe)
//   S5c  the stock linter() added, source returns ZERO diagnostics (proves lint plumbing alone is safe)
//   S5d  the linter source starts emitting the 'spiketest' diagnostic + markClass (proves decorations)
//   S5e  the squiggle CSS injected                            (proves style injection)
//   S5f  the mousedown + showTooltip tap card armed           (proves the card machinery)
// FIRST THING (before any of the above) we install ADDITIVE global error handlers in the editor webview
// — addEventListener, NOT window.onerror=, so we do not clobber Joplin's own handlers — reporting
// 'S5 EDITOR ERROR: <msg> | <stack>' so a caught throw still yields a stack.
//
// Every report line carries a per-LOAD random 4-char id (e.g. 'S5a[k3f9] ...') so interleaved loads
// (mobile reloads the content script per editor open) are distinguishable in the note.

import type { EditorView as EditorViewT, Tooltip as TooltipT } from '@codemirror/view';

// These namespace imports compile (via webpack `externals`) to require('@codemirror/...') against
// Joplin's OWN injected copies — the SAME modules the editor uses, so there is no duplicate CodeMirror
// (duplicate copies break extensions on mobile: laurent22/joplin#9473). On mobile these are provided by
// @joplin/editor's codeMirrorRequire whitelist, which includes lint / view / state.
import * as viewMod from '@codemirror/view';
import * as lintMod from '@codemirror/lint';
import * as stateMod from '@codemirror/state';

interface ContentScriptContext {
	postMessage: (message: unknown) => Promise<unknown>;
	pluginId: string;
	contentScriptId: string;
}

interface CodeMirrorControl {
	cm6?: unknown;
	editor?: EditorViewT;
	addExtension: (extension: unknown | unknown[]) => void;
}

const SPIKE_WORD = 'spiketest';
const STYLE_ELEMENT_ID = 'harper-spike-styles';
const STAGE_GAP_MS = 2000; // ~2 s between stages: a crash between reports is attributable to one stage.

// Editor-side heartbeat: post 'S5 HEARTBEAT[id] t=<n>s' every 5 s for 2 minutes so the note pins the
// exact time the editor webview dies, even during the idle waits between staged actions.
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_DURATION_MS = 2 * 60_000;

/** 4-char base36 id, distinguishes interleaved content-script loads (mobile reloads it per editor open). */
function rid(): string {
	return (Math.random().toString(36) + '0000').slice(2, 6);
}

/** Trim + single-line a message/stack so a report line stays compact in the note. */
function short(v: unknown): string {
	const s = typeof v === 'string' ? v : String((v as { stack?: unknown })?.stack ?? v ?? '');
	return s.slice(0, 300).replace(/\s+/g, ' ').trim();
}

/**
 * FIRST THING: additive error handlers in the EDITOR webview. Guarded so only the first content-script
 * load per webview installs them (a renderer crash-reload creates a fresh window and installs anew).
 */
function installEditorErrorHandlers(post: (line: string) => void, id: string): void {
	const w = (typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null) as
		| (Window & { __harperSpikeErr?: boolean })
		| null;
	if (!w || typeof w.addEventListener !== 'function') return;
	if (w.__harperSpikeErr) return;
	w.__harperSpikeErr = true;
	w.addEventListener('error', (e: unknown) => {
		const ev = e as { message?: string; error?: { message?: string; stack?: unknown }; filename?: string; lineno?: number };
		const msg = ev.message ?? ev.error?.message ?? String(e);
		post(`S5 EDITOR ERROR[${id}]: ${short(msg)} @ ${ev.filename ?? '?'}:${ev.lineno ?? '?'} | ${short(ev.error?.stack)}`);
	});
	w.addEventListener('unhandledrejection', (e: unknown) => {
		const reason = (e as { reason?: unknown })?.reason;
		const msg = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error ? reason.stack : '';
		post(`S5 EDITOR ERROR[${id}] (unhandledrejection): ${short(msg)} | ${short(stack)}`);
	});
}

export default (context: ContentScriptContext) => {
	const post = (line: string): void => {
		try {
			void context.postMessage({ type: 's5', line });
		} catch {
			/* the reporting channel itself may be gone mid-teardown */
		}
	};

	return {
		plugin: (editorControl: CodeMirrorControl) => {
			const id = rid();

			// (0) Error handlers BEFORE anything else touches CodeMirror.
			installEditorErrorHandlers(post, id);
			post(`S5[${id}] content script loaded in editor`); // parity with the old single line

			// (0b) Editor-side heartbeat: independent of the staged timeline, it keeps posting until the
			// editor webview is torn down. The last heartbeat's t=<n>s pins the death time; a gap in the
			// heartbeat sequence between two stages localises the crash to that idle interval.
			const heartbeatStart = Date.now();
			const heartbeatTimer = setInterval(() => {
				const t = Math.round((Date.now() - heartbeatStart) / 1000);
				post(`S5 HEARTBEAT[${id}] t=${t}s`);
				if (Date.now() - heartbeatStart >= HEARTBEAT_DURATION_MS) clearInterval(heartbeatTimer);
			}, HEARTBEAT_INTERVAL_MS);

			if (!editorControl.cm6) {
				post(`S5[${id}] no cm6 on editorControl — not a CM6 editor, bailing`);
				return;
			}
			const view = editorControl.editor ?? null;

			// --- S5a: module resolution, reported one by one ---------------------------------------
			// The namespace imports above already ran require('@codemirror/...') at module-eval; here we
			// confirm each resolved to a usable object and report individually. (If a require had thrown,
			// the whole script would have failed to load and NO S5 line would appear — itself diagnostic.)
			try {
				const okView = typeof (viewMod as { EditorView?: unknown }).EditorView === 'function';
				const okLint = typeof (lintMod as { linter?: unknown }).linter === 'function';
				const okState = typeof (stateMod as { StateField?: unknown }).StateField === 'function';
				post(`S5a[${id}] require @codemirror/view ${okView ? 'ok' : 'FAIL'}`);
				post(`S5a[${id}] require @codemirror/lint ${okLint ? 'ok' : 'FAIL'}`);
				post(`S5a[${id}] require @codemirror/state ${okState ? 'ok' : 'FAIL'}`);
			} catch (e) {
				post(`S5a[${id}] FAIL ${short(e)}`);
			}

			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic CM6 surfaces
			const { EditorView, showTooltip, ViewPlugin } = viewMod as any;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const { linter, forceLinting, forEachDiagnostic } = lintMod as any;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const { StateField, StateEffect } = stateMod as any;

			// 0 = source returns [] (S5c); 1 = source emits the spiketest diagnostic + markClass (S5d).
			let lintMode = 0;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const spikeLintSource = (v: any): any[] => {
				if (lintMode === 0) return [];
				const text: string = v.state.doc.toString();
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const out: any[] = [];
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
				// Fallback: paint ONE decoration even on a note lacking the literal word (real device notes
				// won't contain 'spiketest'), so S5d genuinely exercises the markClass render path on-device.
				if (out.length === 0 && text.length > 0) {
					out.push({
						from: 0,
						to: Math.min(8, text.length),
						severity: 'warning',
						source: 'HarperSpike',
						message: 'spiketest-fallback (spike decoration)',
						markClass: 'spike-underline',
					});
				}
				return out;
			};

			// --- click-to-open card (thin showTooltip StateField), armed only at S5f ----------------
			const setClickCard = StateEffect.define();
			const clickCardField = StateField.define({
				create: () => null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				update(value: TooltipT | null, tr: any) {
					if (tr.docChanged) return null; // self-close on any edit
					for (const e of tr.effects) if (e.is(setClickCard)) value = e.value;
					return value;
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				provide: (f: any) => showTooltip.from(f),
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

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			function buildCard(v: any): HTMLElement {
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
						v.dispatch({ effects: setClickCard.of(null) });
					} catch {
						/* view may be mid-teardown */
					}
				});
				card.appendChild(btn);
				return card;
			}

			function buildClickTooltip(from: number, to: number): TooltipT {
				return {
					pos: from,
					end: to,
					above: false,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					create: (v: any) => {
						const dom = document.createElement('div');
						dom.className = 'spike-click-tooltip';
						dom.appendChild(buildCard(v));
						return { dom };
					},
				} as unknown as TooltipT;
			}

			// --- the staged timeline ----------------------------------------------------------------
			const stages: Array<{ name: string; desc: string; run: () => void }> = [
				{
					name: 'S5b',
					desc: 'addExtension no-op ViewPlugin',
					run: () => {
						const noop = ViewPlugin.fromClass(
							class {
								public update() {
									/* no-op */
								}
							},
						);
						editorControl.addExtension(noop);
					},
				},
				{
					name: 'S5c',
					desc: 'addExtension linter() returning ZERO diagnostics',
					run: () => {
						editorControl.addExtension(linter(spikeLintSource, { delay: 100 }));
					},
				},
				{
					name: 'S5d',
					desc: 'linter now emits spiketest diagnostic + markClass (forceLinting)',
					run: () => {
						lintMode = 1;
						if (view && typeof forceLinting === 'function') forceLinting(view);
					},
				},
				{
					name: 'S5e',
					desc: 'inject squiggle CSS',
					run: () => {
						ensureStyles();
					},
				},
				{
					name: 'S5f',
					desc: 'arm mousedown + showTooltip tap card',
					run: () => {
						editorControl.addExtension([
							clickCardField,
							EditorView.domEventHandlers({
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								mousedown: (event: MouseEvent, v: any): boolean => {
									if (event.button !== 0) return false;
									const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
									if (pos == null) return false;
									let hit: { from: number; to: number } | null = null;
									forEachDiagnostic(v.state, (_d: unknown, from: number, to: number) => {
										if (!hit && from <= pos && pos <= to) hit = { from, to };
									});
									if (hit) {
										const h = hit as { from: number; to: number };
										v.dispatch({ effects: setClickCard.of(buildClickTooltip(h.from, h.to)) });
									} else if (v.state.field(clickCardField, false)) {
										v.dispatch({ effects: setClickCard.of(null) });
									}
									return false;
								},
							}),
						]);
					},
				},
			];

			let i = 0;
			const runNext = (): void => {
				if (i >= stages.length) {
					post(`S5 DONE[${id}] all stages reported`);
					return;
				}
				const stage = stages[i++];
				post(`${stage.name}[${id}] START ${stage.desc}`);
				try {
					stage.run();
					post(`${stage.name}[${id}] OK`);
				} catch (e) {
					post(`${stage.name}[${id}] FAIL ${short(e)}`);
				}
				setTimeout(runNext, STAGE_GAP_MS);
			};

			// Kick the chain after one beat so the S5a lines land before S5b starts.
			setTimeout(runNext, STAGE_GAP_MS);
		},
	};
};
