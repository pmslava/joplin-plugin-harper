// Harper Mobile Spike — instrumented staged probe (plugin main process / mobile background WebView).
//
// GOAL: measure, on-device, whether harper.js's WASM engine instantiates and performs inside the
// Joplin mobile plugin background (a sandboxed WebView with NO Node). Everything below uses ONLY
// plain browser + joplin.data APIs — no require('fs'), no joplin.require, no file paths, no Node
// globals. The SAME code runs on desktop Joplin (Electron), which is what the pre-flight E2E drives.
//
// OUTPUT DISCIPLINE: all output goes to a single note ('Harper Mobile Spike Results'). We ANNOUNCE
// each stage (append a "Sx START" line) BEFORE running it, then append its result AFTER — so if the
// WebView dies mid-stage the note tells us exactly where. Every append re-reads the note body from
// joplin.data (never caches it across stages) so a crash can't lose earlier lines.

import joplin from 'api';
import { ContentScriptType } from 'api/types';
import { LocalLinter } from 'harper.js';
import { slimBinaryInlined } from 'harper.js/slimBinaryInlined';

const RESULTS_TITLE = 'Harper Mobile Spike Results';
const SPIKE_FOLDER = 'Spike';
const CONTENT_SCRIPT_ID = 'harperSpikeCm';
const SPIKE_VERSION = '0.0.4'; // engine variant of v0.0.4 (built only with SPIKE_VARIANT=engine)

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

function fmt(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

function median(nums: number[]): number {
	if (!nums.length) return 0;
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
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

// Serialize every append through one promise chain. The probe's own appends and the content script's
// flush can arrive concurrently; without serialization two read-modify-write cycles could interleave and
// lose a line. Each caller still `await`s and gets its line(s) committed in order.
let appendChain: Promise<void> = Promise.resolve();
function appendLine(line: string): Promise<void> {
	const next = appendChain.then(() => appendLineRaw(line));
	appendChain = next.catch(() => {
		/* keep the chain alive even if one append rejects */
	});
	return next;
}

/** Append a BATCH of lines with a SINGLE read-modify-write (one data.put) — used for the flush. */
async function appendLinesRaw(lines: string[]): Promise<void> {
	if (!resultsNoteId || lines.length === 0) return;
	try {
		const note = await joplin.data.get(['notes', resultsNoteId], { fields: ['body'] });
		const body: string = (note && note.body) || '';
		const sep = body === '' || body.endsWith('\n') ? '' : '\n';
		await joplin.data.put(['notes', resultsNoteId], null, { body: `${body}${sep}${lines.join('\n')}\n` });
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error(`[harper-spike] appendLines failed (${lines.length} lines):`, error);
	}
}
function appendLines(lines: string[]): Promise<void> {
	const next = appendChain.then(() => appendLinesRaw(lines));
	appendChain = next.catch(() => {
		/* keep the chain alive even if one write rejects */
	});
	return next;
}

function short(stack: unknown): string {
	const s = typeof stack === 'string' ? stack : String(stack ?? '');
	return s.slice(0, 300).replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Test documents.
// ---------------------------------------------------------------------------
function buildDoc(targetBytes: number): string {
	// A sentence carrying the known errors the spec sanity-checks against.
	const unit =
		'I beleive teh feature works, but this is an test and we should of shipped it definately. ';
	let doc = '# Spike sample\n\n';
	while (doc.length < targetBytes) doc += unit;
	return doc;
}

// ---------------------------------------------------------------------------
// The staged probe. Each stage announces itself, runs in its own try/catch, and records timing +
// memory. A failed S1 precludes S2/S3/S4 (no engine); everything else continues best-effort.
// ---------------------------------------------------------------------------
async function runProbe(): Promise<void> {
	await ensureResultsNote();
	await appendLine(`===== SPIKE RUN v${SPIKE_VERSION} ${new Date().toISOString()} =====`);

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

	// --- S1 TRIVIAL WASM -----------------------------------------------------
	let s1ok = false;
	await appendLine('S1 START trivial wasm instantiate...');
	try {
		const t = nowMs();
		// The 8-byte WASM header alone is a valid (empty) module.
		await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
		s1ok = true;
		await appendLine(`S1 OK ${fmt(nowMs() - t)}`);
	} catch (error) {
		await appendLine(`S1 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`);
	}

	if (!s1ok) {
		await appendLine('S1 FAILED — precludes S2/S3/S4 (no WASM engine). Stopping.');
		await appendLine('SPIKE COMPLETE');
		return;
	}

	// --- S2 HARPER INIT ------------------------------------------------------
	let linter: LocalLinter | null = null;
	await appendLine('S2 START harper init (LocalLinter + slimBinaryInlined)...');
	try {
		const t = nowMs();
		linter = new LocalLinter({ binary: slimBinaryInlined });
		await linter.setup();
		await appendLine(`S2 OK init ${fmt(nowMs() - t)} | mem ${memSnapshot()}`);
	} catch (error) {
		await appendLine(`S2 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`);
	}

	// --- S3 LINT (5x on a ~5 KB doc) ----------------------------------------
	if (linter) {
		await appendLine('S3 START lint x5 (~5 KB doc)...');
		try {
			const doc = buildDoc(5 * 1024);
			const times: number[] = [];
			let lastCount = -1;
			for (let i = 0; i < 5; i++) {
				const t = nowMs();
				const lints = await linter.lint(doc, { language: 'markdown' });
				times.push(nowMs() - t);
				lastCount = lints.length;
			}
			const timesStr = times.map((x) => x.toFixed(1)).join(',');
			await appendLine(
				`S3 OK docBytes=${doc.length} times=[${timesStr}]ms median=${fmt(median(times))} ` +
					`lastLintCount=${lastCount} | mem ${memSnapshot()}`,
			);
			if (lastCount <= 0) await appendLine('S3 WARN: lint count is not > 0 (expected known errors)');
		} catch (error) {
			await appendLine(
				`S3 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`,
			);
		}

		// --- S4 SECOND DOC (~1 KB warm path) ---------------------------------
		await appendLine('S4 START second doc (~1 KB warm path)...');
		try {
			const doc2 = buildDoc(1 * 1024);
			const t = nowMs();
			const lints2 = await linter.lint(doc2, { language: 'markdown' });
			await appendLine(
				`S4 OK docBytes=${doc2.length} ${fmt(nowMs() - t)} lints=${lints2.length} | final mem ${memSnapshot()}`,
			);
		} catch (error) {
			await appendLine(
				`S4 FAIL: ${short((error as Error).message)} | ${short((error as Error).stack)}`,
			);
		}
	} else {
		await appendLine('S3/S4 SKIPPED — S2 produced no linter.');
	}

	await appendLine('SPIKE COMPLETE');
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

		// Register the S5 content script FIRST so it can load (and report) as soon as an editor opens,
		// independently of the WASM probe below.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, async (message: unknown) => {
			const msg = message as { type?: string; id?: string; flush?: number; reason?: string; lines?: unknown } | null;
			// v0.0.4 SILENT protocol (shared contentScript.ts): the content script buffers its trail and
			// posts a single batched {type:'flushTrail'} at t=45 s (then t=90 s). Append each flush with ONE
			// data.put; the per-line ISO timestamps were captured on the editor side at record time.
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

		// Run the staged WASM probe. Guarded end-to-end so a failure still leaves the note diagnosable.
		try {
			await runProbe();
		} catch (error) {
			await appendLine(
				`PROBE FATAL: ${short((error as Error).message)} | ${short((error as Error).stack)}`,
			);
		}
	},
});
