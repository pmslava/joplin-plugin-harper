// Harper Mobile Spike v0.0.3 — NO-ENGINE ISOLATION BUILD (plugin main process / mobile background WebView).
//
// WHY THIS EXISTS. v0.0.1/v0.0.2 proved the ENGINE side (S0-S4, ~130 MB Harper WASM in the plugin
// background WebView) is flawless on-device, but the EDITOR side dies ~4 s after entering edit mode:
// the keyboard closes, Joplin falls back to the viewer, and the content script reloads
// (ExtendedWebView crash-recovery remount). v0.0.2 showed the S5 trail stops during the IDLE WAIT
// between stages — the death is TIME-correlated, not action-correlated. Our CM6 code is not the trigger.
//
// PRIME HYPOTHESIS. On Android an app's WebViews share ONE sandboxed renderer process. The plugin
// background WebView holds the ~130 MB engine; when the editor WebView joins that same renderer it
// pushes the process over budget -> renderer OOM-killed -> onRenderProcessGone remount -> keyboard
// closes / viewer returns.
//
// THIS BUILD ISOLATES THE SINGLE VARIABLE "engine residency" by REMOVING HARPER ENTIRELY. There is NO
// harper.js import anywhere reachable from this entry, so the emitted bundle is tiny (tens of KB, no
// inlined WASM) and the plugin background WebView holds ~no engine memory. If the editor now SURVIVES
// with the same content script (S5a-S5f + heartbeats), engine residency is confirmed as the killer.
//
// OUTPUT DISCIPLINE (identical to v0.0.2). All output goes to a single note ('Harper Mobile Spike
// Results'). Every append re-reads the note body from joplin.data (never caches it across stages), and
// all appends are serialized through one promise chain so concurrent editor-side (S5) messages and the
// main-side heartbeat can never interleave a read-modify-write and lose a line. ISO timestamps prefix
// every forwarded S5 line so a crash between stages is placeable in time.

import joplin from 'api';
import { ContentScriptType } from 'api/types';

// NOTE: intentionally NO `import ... from 'harper.js'` and NO './slimBinaryInlined' anywhere. Keeping
// this entry harper-free is the whole point — the webpack build for this variant must emit a bundle
// with NO 'data:application/wasm' string.

const RESULTS_TITLE = 'Harper Mobile Spike Results';
const SPIKE_FOLDER = 'Spike';
const CONTENT_SCRIPT_ID = 'harperSpikeCm';
const SPIKE_VERSION = '0.0.3';

// Main-side heartbeat cadence: every 10 s for 3 minutes. This proves whether the PLUGIN background
// WebView itself stays alive (independently of the editor WebView).
const MAIN_HEARTBEAT_INTERVAL_MS = 10_000;
const MAIN_HEARTBEAT_DURATION_MS = 3 * 60_000;

// ---------------------------------------------------------------------------
// Tiny instrumentation helpers (all guarded — every primitive here is non-standard on some runtime).
// ---------------------------------------------------------------------------
function nowMs(): number {
	try {
		return performance.now();
	} catch {
		return Date.now();
	}
}

/** performance.memory is non-standard but present in Chromium WebViews; 'n/a' where absent. */
function memSnapshot(): string {
	try {
		const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
		if (m && typeof m.usedJSHeapSize === 'number') {
			const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
			return `used=${mb(m.usedJSHeapSize)}MB total=${mb(m.totalJSHeapSize)}MB`;
		}
	} catch {
		/* fall through */
	}
	return 'n/a';
}

function short(stack: unknown): string {
	const s = typeof stack === 'string' ? stack : String(stack ?? '');
	return s.slice(0, 300).replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Results note: create (or reuse by EXACT title). All output is appended here.
// ---------------------------------------------------------------------------
let resultsNoteId: string | null = null;

async function ensureResultsNote(): Promise<void> {
	// Reuse by exact title if one already exists (repeated on-device runs append to the same note).
	try {
		const found = await joplin.data.get(['search'], { query: RESULTS_TITLE, fields: ['id', 'title'] });
		const items: Array<{ id: string; title: string }> = (found && found.items) || [];
		const exact = items.find((n) => n.title === RESULTS_TITLE);
		if (exact) {
			resultsNoteId = exact.id;
			return;
		}
	} catch {
		/* search may be unavailable very early; fall through to create */
	}

	// Put it in the first available folder; create a 'Spike' folder if there are none.
	let folderId = '';
	try {
		const folders = await joplin.data.get(['folders']);
		const items: Array<{ id: string }> = (folders && folders.items) || [];
		if (items.length) folderId = items[0].id;
	} catch {
		/* ignore — will create a folder below */
	}
	if (!folderId) {
		const folder = await joplin.data.post(['folders'], null, { title: SPIKE_FOLDER });
		folderId = folder.id;
	}
	const note = await joplin.data.post(['notes'], null, {
		title: RESULTS_TITLE,
		body: '',
		parent_id: folderId,
	});
	resultsNoteId = note.id;
}

/** Append one line to the results note. Re-reads the body every time (never cached across stages). */
async function appendLineRaw(line: string): Promise<void> {
	if (!resultsNoteId) return;
	try {
		const note = await joplin.data.get(['notes', resultsNoteId], { fields: ['body'] });
		const body: string = (note && note.body) || '';
		const sep = body === '' || body.endsWith('\n') ? '' : '\n';
		await joplin.data.put(['notes', resultsNoteId], null, { body: `${body}${sep}${line}\n` });
	} catch (error) {
		// The reporting channel itself failed — last resort so we don't silently lose the failure.
		// eslint-disable-next-line no-console
		console.error(`[harper-spike] appendLine failed for "${line}":`, error);
	}
}

// Serialize every append through one promise chain. The heartbeat and the forwarded S5 messages arrive
// concurrently with each other; without serialization two read-modify-write cycles could interleave and
// lose a line. Each caller still `await`s and gets its line committed in order.
let appendChain: Promise<void> = Promise.resolve();
function appendLine(line: string): Promise<void> {
	const next = appendChain.then(() => appendLineRaw(line));
	appendChain = next.catch(() => {
		/* keep the chain alive even if one append rejects */
	});
	return next;
}

// ---------------------------------------------------------------------------
// The no-engine probe: S0 env only, then 'NOENGINE READY'. There is deliberately NO WASM stage and no
// 'SPIKE COMPLETE' — this variant measures editor survival with an empty (engine-free) plugin webview,
// not engine behaviour.
// ---------------------------------------------------------------------------
async function runProbe(): Promise<void> {
	await ensureResultsNote();
	await appendLine(`===== SPIKE RUN v${SPIKE_VERSION} (NO ENGINE) ${new Date().toISOString()} =====`);

	// --- S0 ENV --------------------------------------------------------------
	await appendLine('S0 START env...');
	try {
		let versionInfo = 'n/a';
		try {
			const vi = await joplin.versionInfo();
			versionInfo = `version=${vi && (vi as { version?: string }).version} platform=${
				vi && (vi as { platform?: string }).platform
			}`;
		} catch (e) {
			versionInfo = `versionInfo() threw: ${short((e as Error).message)}`;
		}
		const ua = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : 'n/a';
		const caps =
			`WebAssembly=${typeof WebAssembly} fetch=${typeof fetch} ` +
			`Worker=${typeof Worker} atob=${typeof atob}`;
		await appendLine(`S0 ENV ${versionInfo}`);
		await appendLine(`S0 UA ${ua}`);
		await appendLine(`S0 CAPS ${caps} | mem ${memSnapshot()}`);
	} catch (error) {
		await appendLine(`S0 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`);
	}

	// No engine is loaded. Announce readiness — the editor probe (S5, content script) carries the rest.
	await appendLine('NOENGINE READY');
}

// ---------------------------------------------------------------------------
// MAIN-side heartbeat: every 10 s for 3 minutes, append 'MAIN HEARTBEAT t=<n>s mem=<...>'. If the PLUGIN
// background WebView is itself killed (not just the editor), these lines stop — pinning the time of death
// of the main process independently of the editor's S5 heartbeat.
// ---------------------------------------------------------------------------
function startMainHeartbeat(): void {
	const startedAt = nowMs();
	const timer = setInterval(() => {
		const elapsedS = Math.round((nowMs() - startedAt) / 1000);
		void appendLine(`MAIN HEARTBEAT t=${elapsedS}s mem=${memSnapshot()}`);
		if (nowMs() - startedAt >= MAIN_HEARTBEAT_DURATION_MS) {
			clearInterval(timer);
			void appendLine(`MAIN HEARTBEAT DONE (${elapsedS}s elapsed)`);
		}
	}, MAIN_HEARTBEAT_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Global error handlers — capture anything the try/catch net misses.
// ---------------------------------------------------------------------------
function installGlobalErrorHandlers(): void {
	const g: unknown = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null;
	const target = g as {
		addEventListener?: (t: string, cb: (e: unknown) => void) => void;
	} | null;
	if (!target || typeof target.addEventListener !== 'function') return;
	target.addEventListener('error', (e: unknown) => {
		const ev = e as { message?: string; filename?: string; lineno?: number };
		void appendLine(`GLOBAL ERROR: ${ev.message ?? String(e)} @ ${ev.filename ?? '?'}:${ev.lineno ?? '?'}`);
	});
	target.addEventListener('unhandledrejection', (e: unknown) => {
		const ev = e as { reason?: unknown };
		const reason = ev && ev.reason;
		const msg = reason instanceof Error ? `${reason.message} | ${short(reason.stack)}` : String(reason);
		void appendLine(`GLOBAL ERROR (unhandledrejection): ${msg}`);
	});
}

joplin.plugins.register({
	onStart: async () => {
		installGlobalErrorHandlers();

		// Register the S5 content script FIRST so it can load (and report) as soon as an editor opens.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, async (message: unknown) => {
			const msg = message as { type?: string; line?: string } | null;
			// Forward the content script's line verbatim, prefixed with a timestamp so a crash between
			// stages is placeable in time (the line already carries a per-load id).
			if (msg && msg.type === 's5' && typeof msg.line === 'string') {
				await appendLine(`[${new Date().toISOString()}] ${msg.line}`);
				return { ok: true };
			}
			// Backward-compatible with the old single-line signal.
			if (msg && msg.type === 's5log') {
				await appendLine(`[${new Date().toISOString()}] S5 content script loaded in editor`);
				return { ok: true };
			}
			return null;
		});

		// Run the no-engine probe (S0 + NOENGINE READY), then start the main-side heartbeat. Guarded
		// end-to-end so a failure still leaves the note diagnosable.
		try {
			await runProbe();
		} catch (error) {
			await appendLine(
				`PROBE FATAL: ${short((error as Error).message)} | ${short((error as Error).stack)}`,
			);
		}
		startMainHeartbeat();
	},
});
