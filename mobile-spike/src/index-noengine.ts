// Harper Mobile Spike v0.0.5 — NO-ENGINE + SETTINGS-PROBE background (plugin main process / mobile bg).
//
// ESTABLISHED LAW (device: Android 10, Joplin mobile 3.7.2, proven through v0.0.4 + user controls): a
// plugin BACKGROUND joplin.data.put NOTE-write while the mobile editor is open evicts the editor within
// seconds, via a LOCAL (sync-independent) mechanism — identical eviction in airplane mode, so the earlier
// sync/UpdateLocal diagnosis is refuted. User typing and remote sync of OTHER notes do NOT evict.
//
// OPEN QUESTION v0.0.5 ANSWERS: is joplin.settings.setValue during mobile editing ALSO lethal, or safe?
// The mobile v1 design wants to persist ignore-state + buffer dictionary words to settings mid-edit; that
// safety claim is currently only inference from the refuted-diagnosis era and MUST be measured. This build
// separates the two write kinds during an editor session (see contentScript.ts for the editor side):
//
//   FLUSH #1 (t=45 s)  {type:'flushToSettings'} -> stored ONLY via joplin.settings.setValue('trailBuffer')
//   FLUSH #2 (t=90 s)  {type:'flushToSettings'} -> APPENDED to the same setting (settings write #2)
//   FLUSH #3 (t=135 s) {type:'flushToNote'}     -> the ONE known-lethal joplin.data.put of the whole
//                                                   settings buffer + the tail carried in the message
//
// So an on-device run reads: editor survives both settings writes (heartbeats continue past t=90 s) but
// dies at the note write (~t=135 s) => settings.setValue is SAFE, note-write law re-confirmed. If instead
// the editor dies at ~t=45 s, settings.setValue is ALSO lethal.
//
// The ONLY note-writes this build performs while an editor could be open are the ONE at t=135 s (flush #3)
// and any STARTUP RECOVERY write (which runs at plugin start, before any editor opens — the safe window).
// The startup writes (create/reuse the results note; header + S0 env + 'SETTINGS PROBE READY') also happen
// before any editor opens.
//
// TRAIL-LOSS SAFETY: if the user closes the editor before t=135 s, flush #3 never fires and whatever
// flush #1/#2 pushed to 'trailBuffer' would be stranded. So at EVERY plugin start we recover any leftover
// buffer to the results note under a distinct '----- STARTUP RECOVERY -----' label and clear it. The label
// (NOTE FLUSH vs STARTUP RECOVERY) tells a reader whether flush #3 fired live (editor open at t=135 s) or
// the editor had already been closed.

import joplin from 'api';
import { ContentScriptType, SettingItemType, SettingStorage } from 'api/types';

// NOTE: intentionally NO `import ... from 'harper.js'` and NO './slimBinaryInlined' anywhere. Engine
// residency was ruled out in v0.0.3/v0.0.4, so this stays engine-free and focuses purely on the
// write-eviction question (now: note-write vs settings-write).

const RESULTS_TITLE = 'Harper Mobile Spike Results';
const SPIKE_FOLDER = 'Spike';
const CONTENT_SCRIPT_ID = 'harperSpikeCm';
const SPIKE_VERSION = '0.0.5';
// The internal (non-public) String setting the content script's flushes are staged into. The whole point
// of v0.0.5 is that flush #1/#2 write HERE (settings) and only flush #3 writes to a note.
const TRAIL_BUFFER_KEY = 'trailBuffer';

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
// Results note: create (or reuse by EXACT title). All NOTE output is appended here.
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
 * Append a BATCH of lines to the results note with a SINGLE read-modify-write (one data.put). This IS a
 * note-write, so it is only ever called at startup (safe window) or by flush #3 (deliberately, the one
 * lethal write). Never call it for flush #1/#2 — those go to settings.
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

// ---------------------------------------------------------------------------
// Serialize EVERY background mutation (note appends AND settings mutations) through one promise chain so
// a flushToNote's read-buffer -> write-note -> clear-buffer sequence cannot interleave with a concurrent
// flushToSettings and lose or double lines.
// ---------------------------------------------------------------------------
let opChain: Promise<void> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const run = opChain.then(fn);
	opChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** appendLines: serialized note-write. */
function appendLines(lines: string[]): Promise<void> {
	return serialize(() => appendLinesRaw(lines));
}

// --- the 'trailBuffer' setting: a JSON array of already-formatted lines --------------------------------
async function getBuffer(): Promise<string[]> {
	try {
		const raw = await joplin.settings.value(TRAIL_BUFFER_KEY);
		if (typeof raw === 'string' && raw.trim() !== '') {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr)) return arr.map((x) => String(x));
		}
	} catch {
		/* corrupt/absent -> treat as empty */
	}
	return [];
}
async function setBuffer(arr: string[]): Promise<void> {
	await joplin.settings.setValue(TRAIL_BUFFER_KEY, JSON.stringify(arr));
}

/**
 * flushToSettings: store a batch into the 'trailBuffer' SETTING (settings write, NO data.put). This is
 * the write whose safety we are measuring — if it evicts the editor, the on-device run dies here.
 */
function storeFlushToSettings(header: string, lines: string[]): Promise<void> {
	return serialize(async () => {
		const prev = await getBuffer();
		await setBuffer([...prev, header, ...lines]);
	});
}

/**
 * flushToNote: the ONE deliberate note-write. Reads the whole settings buffer (flush #1 + #2), appends the
 * tail carried in flush #3's message, writes it all to the results note under a NOTE FLUSH label, then
 * CLEARS the buffer (it is now delivered — so the next startup recovery finds nothing).
 */
function writeBufferToNote(label: string, tailHeader: string, tail: string[]): Promise<void> {
	return serialize(async () => {
		const buffered = await getBuffer();
		await appendLinesRaw([label, ...buffered, tailHeader, ...tail]);
		await setBuffer([]);
	});
}

/**
 * Startup recovery: if a prior editor was closed before flush #3, its flush #1/#2 lines are stranded in
 * 'trailBuffer'. Deliver them to the results note under a STARTUP RECOVERY label (distinct from NOTE
 * FLUSH, so a reader can tell flush #3 never fired) and clear the buffer. Runs at plugin start, before any
 * editor opens — the safe window.
 */
function recoverStrandedBuffer(): Promise<void> {
	return serialize(async () => {
		const buffered = await getBuffer();
		if (buffered.length === 0) return;
		const label =
			`----- STARTUP RECOVERY (undelivered settings buffer from an editor closed before the ` +
			`t=135s note flush) ${new Date().toISOString()} (${buffered.length} lines) -----`;
		await appendLinesRaw([label, ...buffered]);
		await setBuffer([]);
	});
}

// ---------------------------------------------------------------------------
// The no-engine SETTINGS-PROBE startup: S0 env, then 'SETTINGS PROBE READY', written as ONE batched put
// at startup (before any editor is open). NO WASM stage, NO 'SPIKE COMPLETE', NO main-side heartbeat.
// ---------------------------------------------------------------------------
async function runProbe(): Promise<void> {
	await ensureResultsNote();

	const out: string[] = [];
	out.push(`===== SPIKE RUN v${SPIKE_VERSION} (SETTINGS PROBE) ${new Date().toISOString()} =====`);
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

	// No engine, no heartbeat. Announce settings-probe readiness — the editor probe (S5, content script)
	// carries everything else and speaks only via its three deferred flushes.
	out.push('SETTINGS PROBE READY');

	// ONE batched write for the entire startup probe.
	await appendLines(out);
}

// ---------------------------------------------------------------------------
// Global error handlers — capture anything the try/catch net misses. A background error is worth recording
// regardless (it only fires on an actual fault, not as a during-editing gratuitous write).
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

async function registerSpikeSettings(): Promise<void> {
	// A NON-public internal String setting. Storage: File so the buffer survives a full app restart (needed
	// for startup recovery) and mirrors how the real plugin persists ignore-state/dictionary. This is the
	// exact API surface (settings.setValue on a File-backed string) the v1 design would use mid-edit.
	await joplin.settings.registerSettings({
		[TRAIL_BUFFER_KEY]: {
			value: '',
			type: SettingItemType.String,
			public: false,
			label: 'Harper spike trail buffer (internal)',
			storage: SettingStorage.File,
		},
	});
}

joplin.plugins.register({
	onStart: async () => {
		installGlobalErrorHandlers();

		// Register the internal trailBuffer setting FIRST so getBuffer/setBuffer are usable.
		await registerSpikeSettings();

		// Register the S5 content script so it loads (and starts buffering) as soon as an editor opens. It
		// is SILENT until it flushes: settings at t=45/90 s, note at t=135 s.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, async (message: unknown) => {
			const msg = message as
				| { type?: string; id?: string; flush?: number; reason?: string; lines?: unknown }
				| null;
			if (!msg) return null;
			const flushNo = typeof msg.flush === 'number' ? msg.flush : '?';
			const idStr = typeof msg.id === 'string' ? msg.id : '?';
			const reason = typeof msg.reason === 'string' ? msg.reason : '';
			const lines: string[] = Array.isArray(msg.lines) ? (msg.lines as string[]) : [];

			// FLUSH #1/#2: settings write ONLY. NO data.put. This is the write under test.
			if (msg.type === 'flushToSettings') {
				const header =
					`----- SETTINGS FLUSH #${flushNo}[${idStr}] stored ${new Date().toISOString()} ` +
					`(${lines.length} lines) ${reason} -----`;
				await storeFlushToSettings(header, lines);
				return { ok: true, storedToSettings: flushNo };
			}

			// FLUSH #3: the ONE deliberate, known-lethal note-write of the whole settings buffer + the tail.
			if (msg.type === 'flushToNote') {
				const label =
					`----- NOTE FLUSH (expected to evict if editor still open) #${flushNo}[${idStr}] ` +
					`${new Date().toISOString()} ${reason} -----`;
				const tailHeader =
					`----- (tail: ${lines.length} lines recorded 90-135s, carried in the flushToNote message) -----`;
				await writeBufferToNote(label, tailHeader, lines);
				return { ok: true, wroteNote: flushNo };
			}

			return null;
		});

		// Startup recovery BEFORE the probe write, so any stranded buffer from a prior closed editor is
		// delivered first (and cleared) — runs at plugin start, before any editor opens.
		try {
			await recoverStrandedBuffer();
		} catch (error) {
			await appendLines([`RECOVERY FATAL: ${short((error as Error).message)} | ${short((error as Error).stack)}`]);
		}

		// Run the no-engine SETTINGS-PROBE (S0 + 'SETTINGS PROBE READY' in one batched write). No heartbeat.
		try {
			await runProbe();
		} catch (error) {
			await appendLines([`PROBE FATAL: ${short((error as Error).message)} | ${short((error as Error).stack)}`]);
		}
	},
});
