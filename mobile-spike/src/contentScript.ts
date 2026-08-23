// Harper Mobile Spike v0.0.5 — SETTINGS-PROBE CM6 content script (S5, staged activation + heartbeat,
// silent buffering EXACTLY as v0.0.4, but a THREE-FLUSH protocol that separates settings-writes from
// the note-write to measure whether joplin.settings.setValue is safe mid-edit).
//
// ESTABLISHED LAW (device: Android 10, Joplin mobile 3.7.2, proven through v0.0.4 + user controls): a
// plugin BACKGROUND joplin.data.put NOTE-write while the mobile editor is open evicts the editor within
// seconds, via a LOCAL (sync-independent) mechanism. User typing and remote sync of OTHER notes do NOT
// evict. The whole editor stack (require -> ext -> linter -> markClass -> CSS -> tap card) is proven
// safe during silent operation.
//
// OPEN QUESTION v0.0.5 ANSWERS: is joplin.settings.setValue during mobile editing ALSO lethal, or safe?
// The mobile v1 design wants to persist ignore-state + buffer dictionary words to settings mid-edit; the
// safety of that is currently only inference and MUST be measured. This build isolates it:
//
//   - Silent buffering is UNCHANGED from v0.0.4: the SAME staged activation (S5a require -> S5b no-op ext
//     -> S5c linter(zero) -> S5d linter emits spiketest+markClass -> S5e CSS -> S5f tap card, 2 s apart)
//     and the SAME 5 s editor heartbeat, all BUFFERED IN MEMORY — no postMessage during any of it.
//   - FLUSH #1 at t=45 s posts {type:'flushToSettings', lines:[...]} — the background stores it ONLY via
//     joplin.settings.setValue('trailBuffer', ...). NO data.put. (settings write #1)
//   - FLUSH #2 at t=90 s posts {type:'flushToSettings', lines:[...]} — background APPENDS to the same
//     setting. NO data.put. (settings write #2)
//   - FLUSH #3 at t=135 s posts {type:'flushToNote', lines:[...tail]} — the background THEN does the
//     (known-lethal) joplin.data.put of everything buffered in settings PLUS the tail carried here,
//     under a '----- NOTE FLUSH -----' label. (the one note write)
//
// So the timeline discriminates cleanly:
//   * editor alive past t=90 s (two settings writes survived) then evicted at ~t=135 s (note write)
//       => settings.setValue is SAFE, and the note-write law is re-confirmed in the SAME session;
//   * editor evicted at ~t=45 s (first settings write)
//       => settings.setValue is ALSO lethal (nothing but the first buffer survives, recovered at the
//          next plugin start — see below).
//
// WHY flush #3 carries a `lines` tail (a deliberate refinement over a bare {type:'flushToNote'}): it lets
// the single note write deliver the COMPLETE trail — including the 90–135 s heartbeats that were never
// pushed to settings — so (a) the note flush unambiguously contains heartbeats past 90 s and (b) no trail
// is silently lost. It changes neither the message type nor the experiment: still exactly two settings
// writes (t=45 s, t=90 s) followed by one note write (t=135 s).
//
// TRAIL-LOSS SAFETY: if the user closes the editor before t=135 s, flush #3 never fires, so whatever
// flush #1/#2 pushed to settings would be stranded. The background therefore RECOVERS any leftover
// 'trailBuffer' to the results note at plugin start (before any editor opens) under a distinct
// '----- STARTUP RECOVERY -----' label, then clears it — so no trail is ever lost, and the label tells
// a reader whether a block was a live NOTE FLUSH or a recovered-after-close buffer.
//
// Every line carries the per-LOAD 4-char id and an ISO timestamp captured AT RECORD TIME (not flush
// time), so the buffered trail preserves the real on-editor timing even though it is delivered late.

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
const STAGE_GAP_MS = 2000; // ~2 s between stages (unchanged from v0.0.3 — same staged timeline).

// Editor-side heartbeat: record 'S5 HEARTBEAT[id] t=<n>s' every 5 s. Duration spans ALL THREE flushes
// with margin so the t=135 s note flush carries heartbeats past 90 s (survival evidence for BOTH settings
// writes) — every 5 s from t=5 s up to ~t=140 s.
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_DURATION_MS = 140_000;

// The three deferred, batched flushes. NOTHING is posted before FIRST_FLUSH_MS.
//   #1 (t=45 s)  -> flushToSettings (settings write #1)
//   #2 (t=90 s)  -> flushToSettings (settings write #2)
//   #3 (t=135 s) -> flushToNote     (the one, known-lethal, note write)
const FIRST_FLUSH_MS = 45_000;
const SECOND_FLUSH_MS = 90_000;
const THIRD_FLUSH_MS = 135_000;

/** 4-char base36 id, distinguishes interleaved content-script loads (mobile reloads it per editor open). */
function rid(): string {
	return (Math.random().toString(36) + '0000').slice(2, 6);
}

/** Trim + single-line a message/stack so a report line stays compact in the note. */
function short(v: unknown): string {
	const s = typeof v === 'string' ? v : String((v as { stack?: unknown })?.stack ?? v ?? '');
	return s.slice(0, 300).replace(/\s+/g, ' ').trim();
}

export default (context: ContentScriptContext) => {
	return {
		plugin: (editorControl: CodeMirrorControl) => {
			const id = rid();

			// --- SILENT trail buffer -------------------------------------------------------------------
			// Every diagnostic line lands here with an ISO timestamp captured NOW (record time), never
			// sent immediately. `flushedUpTo` marks how much has already been shipped so each flush sends
			// only the newly-buffered lines.
			const trail: string[] = [];
			let flushedUpTo = 0;
			let flushCount = 0;
			const record = (line: string): void => {
				trail.push(`[${new Date().toISOString()}] ${line}`);
			};

			// The ONLY code that ever calls context.postMessage. Ships the lines buffered since the last
			// flush. `type` selects the background's storage path:
			//   'flushToSettings' -> background stores via joplin.settings.setValue (NO data.put)
			//   'flushToNote'     -> background does the one joplin.data.put of the whole settings buffer
			//                        PLUS the tail carried here.
			const flush = (type: 'flushToSettings' | 'flushToNote', reason: string): void => {
				flushCount += 1;
				const lines = trail.slice(flushedUpTo);
				flushedUpTo = trail.length;
				try {
					void context.postMessage({ type, id, flush: flushCount, reason, lines });
				} catch {
					/* the reporting channel itself may be gone mid-teardown */
				}
			};

			// (0) Additive error handlers BEFORE anything else touches CodeMirror. They RECORD (buffer) —
			// they must not post, or the editor could be evicted by an error-triggered write before the
			// deferred flush. Guarded so only the first content-script load per webview installs them.
			(function installEditorErrorHandlers(): void {
				const w = (typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null) as
					| (Window & { __harperSpikeErr?: boolean })
					| null;
				if (!w || typeof w.addEventListener !== 'function') return;
				if (w.__harperSpikeErr) return;
				w.__harperSpikeErr = true;
				w.addEventListener('error', (e: unknown) => {
					const ev = e as { message?: string; error?: { message?: string; stack?: unknown }; filename?: string; lineno?: number };
					const msg = ev.message ?? ev.error?.message ?? String(e);
					record(`S5 EDITOR ERROR[${id}]: ${short(msg)} @ ${ev.filename ?? '?'}:${ev.lineno ?? '?'} | ${short(ev.error?.stack)}`);
				});
				w.addEventListener('unhandledrejection', (e: unknown) => {
					const reason = (e as { reason?: unknown })?.reason;
					const msg = reason instanceof Error ? reason.message : String(reason);
					const stack = reason instanceof Error ? reason.stack : '';
					record(`S5 EDITOR ERROR[${id}] (unhandledrejection): ${short(msg)} | ${short(stack)}`);
				});
			})();

			record(`S5[${id}] content script loaded in editor (SILENT MODE — buffering, no postMessage yet)`);

			// (0b) Editor-side heartbeat: buffered, not posted. Its last recorded t=<n>s pins the death
			// time within a flush; a gap between two stages localises the crash to that idle interval.
			const heartbeatStart = Date.now();
			const heartbeatTimer = setInterval(() => {
				const t = Math.round((Date.now() - heartbeatStart) / 1000);
				record(`S5 HEARTBEAT[${id}] t=${t}s`);
				if (Date.now() - heartbeatStart >= HEARTBEAT_DURATION_MS) clearInterval(heartbeatTimer);
			}, HEARTBEAT_INTERVAL_MS);

			// (0c) Schedule the three deferred flushes. These are the ONLY postMessage calls in the whole
			// content script. Everything above/below merely records into `trail`.
			//   #1/#2 -> settings writes (must NOT evict if the v1 design is viable)
			//   #3    -> the one note write (expected to evict if the editor is still open)
			setTimeout(
				() => flush('flushToSettings', 't=45s (settings write #1 — buffered trail so far)'),
				FIRST_FLUSH_MS,
			);
			setTimeout(
				() => flush('flushToSettings', 't=90s (settings write #2 — survival proof past write #1)'),
				SECOND_FLUSH_MS,
			);
			setTimeout(
				() => flush('flushToNote', 't=135s (NOTE write — known-lethal; carries the 90-135s tail)'),
				THIRD_FLUSH_MS,
			);

			if (!editorControl.cm6) {
				record(`S5[${id}] no cm6 on editorControl — not a CM6 editor, bailing`);
				return;
			}
			const view = editorControl.editor ?? null;

			// --- S5a: module resolution, recorded one by one -------------------------------------------
			// The namespace imports above already ran require('@codemirror/...') at module-eval; here we
			// confirm each resolved to a usable object and record individually. (If a require had thrown,
			// the whole script would have failed to load and NO S5 line would appear — itself diagnostic.)
			try {
				const okView = typeof (viewMod as { EditorView?: unknown }).EditorView === 'function';
				const okLint = typeof (lintMod as { linter?: unknown }).linter === 'function';
				const okState = typeof (stateMod as { StateField?: unknown }).StateField === 'function';
				record(`S5a[${id}] require @codemirror/view ${okView ? 'ok' : 'FAIL'}`);
				record(`S5a[${id}] require @codemirror/lint ${okLint ? 'ok' : 'FAIL'}`);
				record(`S5a[${id}] require @codemirror/state ${okState ? 'ok' : 'FAIL'}`);
			} catch (e) {
				record(`S5a[${id}] FAIL ${short(e)}`);
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

			// --- click-to-open card (thin showTooltip StateField), armed only at S5f --------------------
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

			// --- the staged timeline (identical actions to v0.0.3; only the reporting is now buffered) ---
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
					record(`S5 DONE[${id}] all stages recorded`);
					return;
				}
				const stage = stages[i++];
				record(`${stage.name}[${id}] START ${stage.desc}`);
				try {
					stage.run();
					record(`${stage.name}[${id}] OK`);
				} catch (e) {
					record(`${stage.name}[${id}] FAIL ${short(e)}`);
				}
				setTimeout(runNext, STAGE_GAP_MS);
			};

			// Kick the chain after one beat so the S5a lines are buffered before S5b starts.
			setTimeout(runNext, STAGE_GAP_MS);
		},
	};
};
