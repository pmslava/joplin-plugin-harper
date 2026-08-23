// Harper Mobile Spike v0.0.4 — SILENT-MODE CM6 content script (S5, staged activation + heartbeat,
// but ZERO postMessage traffic until a single batched flush).
//
// WHY THIS EXISTS (v0.0.4 pivot). v0.0.1/v0.0.2/v0.0.3 all reached the SAME wall on-device: the moment
// the content script loads it posts its trail (S5 loaded + S5a x3) back to the plugin background, the
// background appends those lines to the results note via joplin.data.put, and within ~1 s of that
// batch of note-writes the mobile Markdown editor is evicted (keyboard drops, viewer returns) — BEFORE
// S5b (+2 s) ever runs. The plugin background stayed healthy throughout (its heartbeats kept ticking).
// The refined hypothesis is therefore NOT "our CM6 code is the killer" and NOT "engine residency" — it
// is that the BACKGROUND data-API note-writes THEMSELVES (each `put` schedules a sync / emits a
// note-change the mobile Note screen reacts to) tear down the open editor. Every editor open has been
// self-evicting through its OWN load-time report messages.
//
// v0.0.4 ISOLATES THAT by making the content script ABSOLUTELY SILENT until one deferred flush:
//   - It does the SAME staged activation (S5a require -> S5b no-op ext -> S5c linter(zero) ->
//     S5d linter emits spiketest+markClass -> S5e CSS -> S5f tap card, 2 s apart) and the SAME 5 s
//     editor heartbeat, but every line is BUFFERED IN MEMORY — there is NO context.postMessage during
//     any of it. So for the first 45 s the plugin background performs NO note-writes at all.
//   - At t=45 s it posts ONE message {type:'flushTrail', lines:[...]} carrying the entire buffered
//     trail; the background writes it with a SINGLE data.put. If the editor is evicted AT that first
//     write, we will see the trail arrive once and then nothing — proving the WRITE is the killer.
//   - It KEEPS buffering (heartbeats continue) and flushes AGAIN at t=90 s. A second flush arriving
//     with heartbeats spanning 45–90 s proves the first flush's write did NOT evict the editor (so the
//     theory needs refinement); a missing second flush proves it did.
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

// Editor-side heartbeat: record 'S5 HEARTBEAT[id] t=<n>s' every 5 s. Duration spans BOTH flushes with
// margin so the t=90 s flush carries several heartbeats from the 45–90 s window (survival evidence).
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_DURATION_MS = 95_000;

// The two deferred, batched flushes. NOTHING is posted before FIRST_FLUSH_MS.
const FIRST_FLUSH_MS = 45_000;
const SECOND_FLUSH_MS = 90_000;

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
			// flush as a single {type:'flushTrail'} message; the background writes them with ONE data.put.
			const flush = (reason: string): void => {
				flushCount += 1;
				const lines = trail.slice(flushedUpTo);
				flushedUpTo = trail.length;
				try {
					void context.postMessage({ type: 'flushTrail', id, flush: flushCount, reason, lines });
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

			// (0c) Schedule the two deferred flushes. These are the ONLY postMessage calls in the whole
			// content script. Everything above/below merely records into `trail`.
			setTimeout(() => flush('t=45s scheduled (first flush — entire buffered trail)'), FIRST_FLUSH_MS);
			setTimeout(() => flush('t=90s scheduled (second flush — survival proof past first write)'), SECOND_FLUSH_MS);

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
