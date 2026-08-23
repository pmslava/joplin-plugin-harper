// Harper Mobile Spike v0.0.4 — NO-ENGINE + SILENT BACKGROUND (plugin main process / mobile background).
//
// WHY THIS EXISTS (v0.0.4 pivot). The v0.0.3 no-engine run STILL evicted the mobile editor even with
// harper.js removed — so engine residency was NOT the killer. The device trail always ended the same
// way: the content script loads, immediately posts its 4 load-time messages (S5 loaded + 3× S5a), the
// background appends them to the results note via joplin.data.put, the app log shows each append batch
// IMMEDIATELY FOLLOWED BY 'Preparing scheduled sync', and the editor is evicted before S5b (+2 s). The
// plugin background itself stayed healthy (its own heartbeats kept ticking). That fingers the BACKGROUND
// NOTE-WRITES themselves — each data.put schedules a sync / emits a note-change the mobile Note screen
// reacts to — as the mechanism tearing down the open editor. Every editor open was self-evicting via its
// OWN load-time report writes.
//
// v0.0.4 tests exactly that by REMOVING every background write that happens while an editor is open:
//   - NO main-side heartbeat (v0.0.3 had one writing every 10 s — precisely the kind of during-editing
//     background write we must eliminate). It is GONE.
//   - The content script is now SILENT: it buffers its entire trail in memory and posts NOTHING until a
//     single {type:'flushTrail'} message at t=45 s (then again at t=90 s). See contentScript.ts.
//   - On receiving a flush, this background appends the WHOLE batch with ONE data.put (one write, not N).
// So during an editor session the ONLY background note-writes are: one put at t≈45 s and one at t≈90 s.
// If the editor survives to the first flush and is evicted AT it, the write is confirmed as the killer.
//
// The only writes this build performs at startup (before any editor is open, so they cannot evict an
// editor) are: create/reuse the results note and ONE batched probe write (header + S0 env + SILENT READY).

import joplin from 'api';
import { ContentScriptType } from 'api/types';

// NOTE: intentionally NO `import ... from 'harper.js'` and NO './slimBinaryInlined' anywhere. Keeping
// this entry harper-free keeps the emitted bundle tiny (no inlined WASM); engine residency is already
// ruled out, so v0.0.4 stays engine-free and focuses purely on the write-eviction hypothesis.

const RESULTS_TITLE = 'Harper Mobile Spike Results';
const SPIKE_FOLDER = 'Spike';
const CONTENT_SCRIPT_ID = 'harperSpikeCm';
const SPIKE_VERSION = '0.0.4';

// ---------------------------------------------------------------------------
// Tiny instrumentation helpers (all guarded — every primitive here is non-standard on some runtime).
// ---------------------------------------------------------------------------
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

/**
 * Append a BATCH of lines to the results note with a SINGLE read-modify-write (one data.put). This is
 * the whole point of v0.0.4: a flush of N buffered lines must cost exactly ONE background write, so the
 * count of editor-evicting writes during a session is minimised (one per flush, not one per line).
 */
async function appendLinesRaw(lines: string[]): Promise<void> {
	if (!resultsNoteId || lines.length === 0) return;
	try {
		const note = await joplin.data.get(['notes', resultsNoteId], { fields: ['body'] });
		const body: string = (note && note.body) || '';
		const sep = body === '' || body.endsWith('\n') ? '' : '\n';
		const block = lines.join('\n');
		await joplin.data.put(['notes', resultsNoteId], null, { body: `${body}${sep}${block}\n` });
	} catch (error) {
		// The reporting channel itself failed — last resort so we don't silently lose the failure.
		// eslint-disable-next-line no-console
		console.error(`[harper-spike] appendLines failed (${lines.length} lines):`, error);
	}
}

// Serialize every write through one promise chain so two flushes arriving close together can't interleave
// a read-modify-write and lose lines. Each caller still awaits its batch committed in order.
let appendChain: Promise<void> = Promise.resolve();
function appendLines(lines: string[]): Promise<void> {
	const next = appendChain.then(() => appendLinesRaw(lines));
	appendChain = next.catch(() => {
		/* keep the chain alive even if one write rejects */
	});
	return next;
}

// ---------------------------------------------------------------------------
// The no-engine SILENT probe: S0 env only, then 'SILENT READY', written as ONE batched put at startup
// (before any editor is open). There is deliberately NO WASM stage, NO 'SPIKE COMPLETE', and — unlike
// v0.0.3 — NO main-side heartbeat. The editor-survival signal now comes entirely from the content
// script's two deferred flushes.
// ---------------------------------------------------------------------------
async function runProbe(): Promise<void> {
	await ensureResultsNote();

	const out: string[] = [];
	out.push(`===== SPIKE RUN v${SPIKE_VERSION} (SILENT) ${new Date().toISOString()} =====`);
	out.push('S0 START env...');
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
		out.push(`S0 ENV ${versionInfo}`);
		out.push(`S0 UA ${ua}`);
		out.push(`S0 CAPS ${caps} | mem ${memSnapshot()}`);
	} catch (error) {
		out.push(`S0 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`);
	}

	// No engine is loaded, and there is no main heartbeat. Announce silent readiness — the editor probe
	// (S5, content script) now carries everything else and speaks only via its deferred flushes.
	out.push('SILENT READY');

	// ONE batched write for the entire startup probe.
	await appendLines(out);
}

// ---------------------------------------------------------------------------
// Global error handlers — capture anything the try/catch net misses. These may fire in the background at
// any time; a background error is worth recording regardless (it is not a during-editing "gratuitous"
// write — it only fires on an actual fault).
// ---------------------------------------------------------------------------
function installGlobalErrorHandlers(): void {
	const g: unknown = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null;
	const target = g as {
		addEventListener?: (t: string, cb: (e: unknown) => void) => void;
	} | null;
	if (!target || typeof target.addEventListener !== 'function') return;
	target.addEventListener('error', (e: unknown) => {
		const ev = e as { message?: string; filename?: string; lineno?: number };
		void appendLines([`GLOBAL ERROR: ${ev.message ?? String(e)} @ ${ev.filename ?? '?'}:${ev.lineno ?? '?'}`]);
	});
	target.addEventListener('unhandledrejection', (e: unknown) => {
		const ev = e as { reason?: unknown };
		const reason = ev && ev.reason;
		const msg = reason instanceof Error ? `${reason.message} | ${short(reason.stack)}` : String(reason);
		void appendLines([`GLOBAL ERROR (unhandledrejection): ${msg}`]);
	});
}

joplin.plugins.register({
	onStart: async () => {
		installGlobalErrorHandlers();

		// Register the S5 content script FIRST so it can load (and start buffering) as soon as an editor
		// opens. It is SILENT until it flushes.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, async (message: unknown) => {
			const msg = message as { type?: string; id?: string; flush?: number; reason?: string; lines?: unknown } | null;
			// The ONLY message the v0.0.4 content script sends: a batched flush of buffered lines. Append
			// the whole batch with ONE data.put, prefaced by a flush header so the note shows flush
			// boundaries. The per-line ISO timestamps were captured on the EDITOR side at record time.
			if (msg && msg.type === 'flushTrail' && Array.isArray(msg.lines)) {
				const flushNo = typeof msg.flush === 'number' ? msg.flush : '?';
				const idStr = typeof msg.id === 'string' ? msg.id : '?';
				const reason = typeof msg.reason === 'string' ? msg.reason : '';
				const header =
					`----- FLUSH #${flushNo}[${idStr}] received ${new Date().toISOString()} ` +
					`(${msg.lines.length} lines) ${reason} -----`;
				await appendLines([header, ...(msg.lines as string[])]);
				return { ok: true, flush: flushNo };
			}
			return null;
		});

		// Run the no-engine SILENT probe (S0 + SILENT READY in one batched write). Guarded end-to-end so a
		// failure still leaves the note diagnosable. NOTE: no heartbeat is started — background writes
		// during editing are exactly what we must avoid.
		try {
			await runProbe();
		} catch (error) {
			await appendLines([
				`PROBE FATAL: ${short((error as Error).message)} | ${short((error as Error).stack)}`,
			]);
		}
	},
});
