// Harper harness suite (Phase 1 MVP).
//
// Runner + assertion frame follow joplin-plugin-cockpit's test/run.js (a tiny homemade test()
// runner with a failures counter; process.exit(failures ? 1 : 0)). The fixtures drive the REAL
// harper.js linter (LocalLinter works in Node) through the compiled dist/index.js bundle via the
// stubbed joplin global. Dictionary/ignore-state IO goes through joplin.require('fs-extra'), which
// we back with the real fs-extra wrapped in a readFileSync counter so budget claims are testable.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fsExtra = require('fs-extra');
const ts = require('typescript');
const { run } = require('./harness');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

/**
 * Load a dependency-free TypeScript module from src/ directly (transpile + evaluate), so the pure
 * merge core can be unit-tested as a FUNCTION rather than only through the bundle's side effects.
 * It is the very same source webpack compiles into dist/index.js — no second copy to drift.
 */
function loadTsModule(relPath, requireShim) {
	const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
	const js = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
	}).outputText;
	const mod = { exports: {} };
	// `requireShim` lets a module with a sibling src/ import be loaded here too: the transpiled code
	// asks for './dismissedLog', which plain require() would resolve relative to test/ (and to a .ts
	// file at that). The caller hands back the already-loaded module instead. Type-only imports (e.g.
	// harper.js) are elided by the transpile, so they never reach this.
	// eslint-disable-next-line no-new-func
	new Function('exports', 'module', 'require', js)(mod.exports, mod, requireShim || require);
	return mod.exports;
}
const { mergeDictionary } = loadTsModule('src/dictionaryMerge.ts');

// Wrap the real fs-extra so a test can count how many readFileSync calls a given operation makes
// (used to prove the 60s dictionary poll does ZERO file reads when the mtime is unchanged).
let fsReadCount = 0;
const countingFsExtra = new Proxy(fsExtra, {
	get(target, prop) {
		if (prop === 'readFileSync') {
			return (...args) => {
				fsReadCount++;
				return target.readFileSync(...args);
			};
		}
		return target[prop];
	},
});
const requireStub = (name) => {
	if (name === 'fs-extra') return countingFsExtra;
	throw new Error(`Unexpected joplin.require(${name})`);
};

let failures = 0;
async function test(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
	} catch (error) {
		failures++;
		console.log(`  FAIL  ${name}\n        ${error.stack || error.message}`);
	}
}

// A representative ~5 KB markdown document with a sprinkling of real errors, for latency timing.
function makeMarkdownDoc(targetBytes) {
	const para = [
		'## Meeting notes',
		'',
		'This is an test of the plugin. I beleive it works well enough for now.',
		'We should of tested this earlier, but their was not enough time.',
		'The team are going to review teh results and definately follow up.',
		'',
		'- Ship the walking skeleton',
		'- Measure the lint latency',
		'',
	].join('\n');
	let doc = '';
	while (Buffer.byteLength(doc, 'utf8') < targetBytes) doc += para + '\n';
	return doc;
}

function median(nums) {
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
	if (!fs.existsSync(path.join(DIST_DIR, 'index.js'))) {
		throw new Error('dist/index.js not found — run `npm run dist` first (npm test does this).');
	}

	// =========================================================================
	// v1.3.0 PURE MERGE CORE — mergeDictionary(), exhaustively.
	// =========================================================================
	// The whole deletion story reduces to this one pure function; everything else in the plugin is
	// plumbing that reads the sides, writes what it says to write, and stores the new base. Base B,
	// note N, file F, pending P:
	//     added = (N-B) ∪ (F-B) ∪ P     deleted = (B-N)|N present ∪ (B-F)|F present
	//     result = (B - (deleted - added)) ∪ added        [addition beats a concurrent deletion]
	// A side passed as null is ABSENT (no deletions inferred); a side passed as [] is EMPTY (its
	// deletions count).
	{
		const merge = (o) =>
			mergeDictionary({ base: null, note: null, file: null, pending: [], ...o });

		await test('merge: a word added on the NOTE side survives and is pushed to the file', () => {
			const m = merge({ base: ['a'], note: ['a', 'new'], file: ['a'], pending: [] });
			assert.deepStrictEqual(m.result, ['a', 'new']);
			assert.deepStrictEqual(m.added, ['new']);
			assert.deepStrictEqual(m.deleted, []);
			assert.strictEqual(m.noteChanged, false, 'the note already has it — no note write');
			assert.strictEqual(m.fileChanged, true, 'the file is missing it — rewrite the file');
		});

		await test('merge: a word added on the FILE side survives and is pushed to the note', () => {
			const m = merge({ base: ['a'], note: ['a'], file: ['a', 'new'], pending: [] });
			assert.deepStrictEqual(m.result, ['a', 'new']);
			assert.deepStrictEqual(m.added, ['new']);
			assert.strictEqual(m.noteChanged, true, 'the note is missing it — write the note');
			assert.strictEqual(m.fileChanged, false, 'the file already has it — no rewrite');
		});

		await test('merge: a word deleted on the NOTE side is deleted everywhere (the reported bug)', () => {
			const m = merge({ base: ['keep', 'gone'], note: ['keep'], file: ['keep', 'gone'], pending: [] });
			assert.deepStrictEqual(m.result, ['keep'], 'the union would have resurrected "gone"');
			assert.deepStrictEqual(m.deleted, ['gone']);
			assert.strictEqual(m.noteChanged, false, 'the note already reflects the deletion');
			assert.strictEqual(m.fileChanged, true, 'the file still carries it — rewrite it');
		});

		await test('merge: a word deleted on the FILE side is deleted everywhere', () => {
			const m = merge({ base: ['keep', 'gone'], note: ['keep', 'gone'], file: ['keep'], pending: [] });
			assert.deepStrictEqual(m.result, ['keep']);
			assert.deepStrictEqual(m.deleted, ['gone']);
			assert.strictEqual(m.noteChanged, true, 'the note still carries it — write it');
			assert.strictEqual(m.fileChanged, false);
		});

		await test('merge: a word deleted on BOTH sides is deleted, with zero writes', () => {
			const m = merge({ base: ['keep', 'gone'], note: ['keep'], file: ['keep'], pending: [] });
			assert.deepStrictEqual(m.result, ['keep']);
			assert.deepStrictEqual(m.deleted, ['gone']);
			assert.strictEqual(m.noteChanged, false);
			assert.strictEqual(m.fileChanged, false, 'both sides already agree — nothing to write');
		});

		await test('merge: CONFLICT — a local add-to-dictionary beats a concurrent remote deletion', () => {
			// The word was deleted from the note on another device; on this one the user just added it
			// back via the card. Addition wins: it stays, and the note is rewritten to carry it again.
			const m = merge({ base: ['w'], note: [], file: ['w'], pending: ['w'] });
			assert.deepStrictEqual(m.result, ['w'], 'addition wins over the concurrent deletion');
			assert.deepStrictEqual(m.deleted, []);
			assert.strictEqual(m.noteChanged, true, 'the note gets the re-added word back');
			assert.strictEqual(m.fileChanged, false);
		});

		await test('merge: CONFLICT — a fresh word on one side beats a deletion on the other', () => {
			// "fresh" is unknown to the base, so it can only be an addition, never a deletion.
			const m = merge({ base: ['old'], note: ['old', 'fresh'], file: [], pending: [] });
			assert.deepStrictEqual(m.result, ['fresh'], '"old" deleted from the file, "fresh" added in the note');
			assert.deepStrictEqual(m.added, ['fresh']);
			assert.deepStrictEqual(m.deleted, ['old']);
			assert.ok(m.noteChanged && m.fileChanged, 'both sides differ from the result');
		});

		await test('merge: FIXED POINT — everything already agrees means zero writes and zero churn', () => {
			const m = merge({ base: ['a', 'b'], note: ['b', 'a'], file: ['a', 'b'], pending: [] });
			assert.deepStrictEqual(m.result, ['a', 'b']);
			assert.deepStrictEqual(m.added, []);
			assert.deepStrictEqual(m.deleted, []);
			assert.strictEqual(m.noteChanged, false, 'no note write at the fixed point (order is irrelevant)');
			assert.strictEqual(m.fileChanged, false, 'no file write at the fixed point');
			assert.strictEqual(m.firstRun, false);
		});

		await test('merge: FIRST RUN (base=null) adopts the union and infers NO deletion', () => {
			const m = merge({ base: null, note: ['n'], file: ['f'], pending: ['p'] });
			assert.strictEqual(m.firstRun, true);
			assert.deepStrictEqual(m.result, ['f', 'n', 'p'], 'exactly the v1.2.0 union');
			assert.deepStrictEqual(m.deleted, [], 'a first run can never delete anything');
			assert.deepStrictEqual(m.added, [], 'the union IS the base, so nothing counts as new');
			assert.ok(m.noteChanged && m.fileChanged, 'both sides are still missing union words');
		});

		await test('merge: an ABSENT side (null: unreadable file / unsynced note) infers no deletions', () => {
			// The file could not be read this pass (rclone moved it aside). Its "missing" words must NOT
			// be treated as deletions, and it must not be rewritten from a merge it did not take part in.
			const m = merge({ base: ['a', 'b'], note: ['a', 'b'], file: null, pending: [] });
			assert.deepStrictEqual(m.result, ['a', 'b']);
			assert.deepStrictEqual(m.deleted, []);
			assert.strictEqual(m.fileChanged, false, 'an absent side is never written');
		});

		await test('merge: an EMPTY BUT READABLE side deletes what the base remembered', () => {
			const m = merge({ base: ['a', 'b'], note: [], file: ['a', 'b'], pending: [] });
			assert.deepStrictEqual(m.result, [], 'emptying the dictionary note is a legitimate deletion');
			assert.deepStrictEqual(m.deleted, ['a', 'b']);
			assert.strictEqual(m.fileChanged, true);
		});

		await test('merge: MOBILE shape (file absent) still propagates a note-side deletion', () => {
			const m = merge({ base: ['keep', 'gone'], note: ['keep'], file: null, pending: [] });
			assert.deepStrictEqual(m.result, ['keep']);
			assert.deepStrictEqual(m.deleted, ['gone']);
			assert.strictEqual(m.noteChanged, false, 'the note is already correct — no data.put needed');
			assert.strictEqual(m.fileChanged, false, 'there is no file side on mobile');
		});

		await test('merge: NO SIDES at all (no note, no file) keeps the base and folds in pending', () => {
			const m = merge({ base: ['a'], note: null, file: null, pending: ['b'] });
			assert.deepStrictEqual(m.result, ['a', 'b']);
			assert.deepStrictEqual(m.deleted, []);
		});

		await test('merge: output is deduped, trimmed, blank-free and code-unit sorted', () => {
			const m = merge({ base: null, note: [' b ', 'a', '', '  ', 'b'], file: ['C', 'a'], pending: [] });
			assert.deepStrictEqual(m.result, ['C', 'a', 'b'], 'code-unit order puts uppercase first');
		});

		await test('merge: IDEMPOTENT — feeding the result back as base+sides is a fixed point', () => {
			const first = merge({ base: ['keep', 'gone'], note: ['keep'], file: ['keep', 'gone'], pending: [] });
			const second = mergeDictionary({
				base: first.result,
				note: first.result,
				file: first.result,
				pending: [],
			});
			assert.deepStrictEqual(second.result, first.result);
			assert.strictEqual(second.noteChanged, false, 'no ping-pong: the second pass writes nothing');
			assert.strictEqual(second.fileChanged, false);
			assert.deepStrictEqual(second.deleted, [], 'the deletion is not re-derived from the old base');
		});
	}

	// A throwaway per-run data dir so the plugin can write userWords.txt / ignoredLints.json.
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-test-data-'));

	// installationDir points at the built dist/, where the .wasm was copied, so the plugin's
	// data:-URL loader finds the real binary — exactly as it will inside a real Joplin install.
	const state = await run({
		dataDir,
		installationDir: DIST_DIR,
		require: requireStub,
		versionInfo: { version: '3.6.14', platform: 'desktop' },
	});

	// ---- registration -------------------------------------------------------
	await test('onStart completed and registered exactly one content script', () => {
		assert.strictEqual(state.contentScripts.length, 1, 'one content script registered');
	});

	await test('content script registered with the codeMirrorPlugin type, id and path', () => {
		const cs = state.contentScripts[0];
		assert.strictEqual(cs.type, 'codeMirrorPlugin', 'content script type');
		assert.strictEqual(cs.id, 'harperCm', 'content script id');
		assert.strictEqual(cs.path, './contentScript.js', 'content script path');
	});

	await test('an onMessage handler was registered for the content script', () => {
		assert.ok(
			typeof state.contentScriptMessageHandlers['harperCm'] === 'function',
			'onMessage handler captured for harperCm',
		);
	});

	// ---- settings registration ----------------------------------------------
	await test("settings section 'harper' + all 5 keys registered with correct defaults", () => {
		const defs = state.registeredSettings;
		assert.ok(defs, 'registerSettings was called');
		const keys = ['enabled', 'dialect', 'debounceMs', 'dictionaryPath', 'ruleOverrides'];
		for (const k of keys) assert.ok(defs[k], `setting "${k}" is registered`);
		assert.strictEqual(defs.enabled.value, true, 'enabled default true');
		assert.strictEqual(defs.dialect.value, 'American', 'dialect default American');
		assert.strictEqual(defs.debounceMs.value, 500, 'debounceMs default 500');
		assert.strictEqual(defs.dictionaryPath.value, '', 'dictionaryPath default empty');
		assert.strictEqual(defs.ruleOverrides.value, '', 'ruleOverrides default empty');
		for (const k of keys) assert.strictEqual(defs[k].section, 'harper', `${k} in section harper`);
		for (const k of keys) assert.strictEqual(defs[k].public, true, `${k} is public`);
		assert.strictEqual(defs.dialect.isEnum, true, 'dialect isEnum');
		assert.ok(defs.dialect.options && defs.dialect.options.British, 'dialect exposes British option');
		assert.strictEqual(defs.ruleOverrides.advanced, true, 'ruleOverrides is advanced');
	});

	// ---- underlineStyle registration (v1.2.0) --------------------------------
	// Harper issue #1710 ("Prefer solid line to squiggly"). The setting is a public enum on BOTH
	// platforms (the mobile half is asserted inside the mobile run below), defaulting to the squiggle
	// so every existing install keeps the look it has.
	await test("setting 'underlineStyle' is a public enum in section harper, default 'squiggly', with both options", () => {
		const def = state.registeredSettings.underlineStyle;
		assert.ok(def, 'underlineStyle is registered');
		assert.strictEqual(def.value, 'squiggly', "underlineStyle default is 'squiggly'");
		// Same SettingItemType as the other String enum (dialect) — compared by reference rather than a
		// magic number so the assertion can't drift from Joplin's enum.
		assert.strictEqual(def.type, state.registeredSettings.dialect.type, 'underlineStyle is a String setting');
		assert.strictEqual(def.public, true, 'underlineStyle is public');
		assert.strictEqual(def.isEnum, true, 'underlineStyle isEnum');
		assert.strictEqual(def.section, 'harper', 'underlineStyle in section harper');
		assert.deepStrictEqual(
			Object.keys(def.options).sort(),
			['solid', 'squiggly'],
			'underlineStyle exposes exactly the squiggly + solid options',
		);
		assert.ok(/squiggly/i.test(def.options.squiggly), 'the squiggly option has a squiggly label');
		assert.ok(/solid/i.test(def.options.solid), 'the solid option has a solid label');
	});

	// ---- config handshake ---------------------------------------------------
	const handler = state.contentScriptMessageHandlers['harperCm'];
	await test('getConfig returns {enabled, debounceMs, underlineStyle, platform, generation} for the content script', async () => {
		const config = await handler({ type: 'getConfig' });
		// The generation counter moves with every poke (warm-up, settings, dictionary), so assert its
		// TYPE here and its exact behavior in the waitForRefresh tests below.
		const { generation, ...rest } = config;
		assert.deepStrictEqual(rest, {
			enabled: true,
			debounceMs: 500,
			underlineStyle: 'squiggly',
			platform: 'desktop',
		});
		assert.strictEqual(typeof generation, 'number', 'getConfig carries the config generation (multi-window refresh)');
	});

	// ---- live underline-style apply (v1.2.0) --------------------------------
	// Same shape as the live-debounce test below: the content script re-queries getConfig when the main
	// process pokes `harper.forceLint` after a settings change, and (v1.2.0) relints INSIDE that reply,
	// so the new markClass repaints without reopening the note. The class-swap itself lives in the CM6
	// content script; the two halves the harness can observe are (a) the change is a poke, and (b)
	// getConfig immediately serves the new value.
	await test('changing underlineStyle pokes harper.forceLint and getConfig serves the new style live', async () => {
		const before = state.commandExecutions.length;
		await state.setSetting('underlineStyle', 'solid');
		const pokes = state.commandExecutions
			.slice(before)
			.filter((e) => e.name === 'editor.execCommand' && e.args[0] && e.args[0].name === 'harper.forceLint');
		assert.ok(pokes.length >= 1, 'an underlineStyle change pokes editor.execCommand{harper.forceLint}');
		const config = await handler({ type: 'getConfig' });
		assert.strictEqual(config.underlineStyle, 'solid', 'getConfig returns the just-changed style (live, no reopen)');
		// And back again — the round-trip must work in both directions.
		await state.setSetting('underlineStyle', 'squiggly');
		const back = await handler({ type: 'getConfig' });
		assert.strictEqual(back.underlineStyle, 'squiggly', 'switching back to squiggly is served live too');
	});

	// ---- live debounce apply (v1.0.1) ---------------------------------------
	// The content script owns a MUTABLE debounce delay that it refreshes by re-querying `getConfig`
	// when the plugin main process pokes the `harper.forceLint` editor command after a settings
	// change. Timing behavior lives in the CM6 content script (not driven by this harness), so we
	// prove the two halves the harness CAN observe: (a) a debounceMs change is a poke, and (b)
	// getConfig immediately reflects the new value — i.e. the live-refresh reads the fresh delay.
	await test('changing debounceMs pokes harper.forceLint and getConfig reflects the new value live', async () => {
		const before = state.commandExecutions.length;
		await state.setSetting('debounceMs', 1234);
		const pokes = state.commandExecutions
			.slice(before)
			.filter((e) => e.name === 'editor.execCommand' && e.args[0] && e.args[0].name === 'harper.forceLint');
		assert.ok(pokes.length >= 1, 'a debounceMs change pokes editor.execCommand{harper.forceLint}');
		const config = await handler({ type: 'getConfig' });
		assert.strictEqual(config.debounceMs, 1234, 'getConfig returns the just-changed debounceMs (live, no reopen)');
		await state.setSetting('debounceMs', 500); // restore default for later measurements
	});

	// ---- lint round-trip (real harper.js) -----------------------------------
	const sampleText = 'This is an test of the plugin. I beleive it works.';

	// Measure linter init: the FIRST lint call pays the binary load + setup cost.
	const initStart = Date.now();
	const response = await handler({ type: 'lint', text: sampleText });
	const initMs = Date.now() - initStart;

	await test('lint response is a plain-JSON array (no WASM handles leak across IPC)', () => {
		assert.ok(Array.isArray(response), 'response is an array');
		assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), response, 'response is plain JSON');
	});

	await test('lint found at least one issue with at least one suggestion', () => {
		assert.ok(response.length >= 1, `expected >=1 lint, got ${response.length}`);
		const withSuggestion = response.filter((l) => l.suggestions && l.suggestions.length >= 1);
		assert.ok(withSuggestion.length >= 1, 'at least one lint carries a suggestion');
	});

	await test('every lint carries a non-empty ruleName (organizedLints key)', () => {
		for (const lint of response) {
			assert.strictEqual(typeof lint.ruleName, 'string', 'ruleName is a string');
			assert.ok(lint.ruleName.length >= 1, `ruleName present for "${lint.problemText}"`);
		}
	});

	// ---- Phase-2 payload fields (card UI) -----------------------------------
	// The card needs a pretty kind label and Harper's rendered message markup. Both must ride the
	// same plain-JSON channel as the rest of the lint (no WASM handles), so the content script can
	// build the title + the <code> word chip without touching harper.js.
	await test('every lint carries plain-JSON kindPretty + messageHtml for the card', () => {
		for (const lint of response) {
			assert.strictEqual(typeof lint.kindPretty, 'string', 'kindPretty is a string');
			assert.ok(lint.kindPretty.length >= 1, `kindPretty present for "${lint.problemText}"`);
			assert.strictEqual(typeof lint.messageHtml, 'string', 'messageHtml is a string');
			assert.ok(lint.messageHtml.length >= 1, `messageHtml present for "${lint.problemText}"`);
		}
		// Whole payload survives a JSON round-trip unchanged (no non-serializable handles leaked).
		assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), response, 'still plain JSON');
	});

	await test('the "beleive" Spelling lint has kindPretty "Spelling" and a <code> chip in messageHtml', () => {
		const spelling = response.find((l) => l.problemText === 'beleive');
		assert.ok(spelling, 'a lint whose problemText is "beleive"');
		assert.strictEqual(spelling.kindPretty, 'Spelling', 'kindPretty is the human label "Spelling"');
		assert.ok(
			/<code>[^<]*<\/code>/.test(spelling.messageHtml),
			`messageHtml wraps the word in <code>: ${JSON.stringify(spelling.messageHtml)}`,
		);
	});

	await test('every span indexes its own problemText in the source string', () => {
		for (const lint of response) {
			assert.strictEqual(
				sampleText.slice(lint.start, lint.end),
				lint.problemText,
				`span [${lint.start},${lint.end}) must slice to problemText "${lint.problemText}"`,
			);
		}
	});

	await test('the misspelling "beleive" is flagged as a Spelling lint spanning the word', () => {
		const expectedStart = sampleText.indexOf('beleive');
		const spelling = response.find((l) => l.problemText === 'beleive');
		assert.ok(spelling, 'a lint whose problemText is "beleive"');
		assert.strictEqual(spelling.kind, 'Spelling', 'kind is Spelling');
		assert.strictEqual(spelling.start, expectedStart, 'span start at the word');
		assert.strictEqual(spelling.end, expectedStart + 'beleive'.length, 'span end at the word');
		assert.ok(spelling.suggestions.length >= 1, 'spelling lint offers a correction');
	});

	await test('suggestion shape is {kind, replacementText} with a known kind', () => {
		const kinds = new Set(['Replace', 'Remove', 'InsertAfter']);
		for (const lint of response) {
			for (const sug of lint.suggestions) {
				assert.ok(kinds.has(sug.kind), `suggestion kind "${sug.kind}" is known`);
				assert.strictEqual(typeof sug.replacementText, 'string', 'replacementText is a string');
			}
		}
	});

	// ---- multi-window refresh subscription --------------------------
	// `editor.execCommand` reaches only the FOCUSED window's editor (Joplin executes exactly one
	// highest-priority per-editor runtime), so every other window's content script keeps a
	// 'waitForRefresh' long-poll parked in the main process: the reply parks while the client is up
	// to date and resolves the instant the config generation bumps (any pokeForceLint). These tests
	// drive the main half of that contract through the real message handler. They run AFTER the
	// first lint above, so the background warm-up's own one-shot poke has already landed and cannot
	// release a parked reply mid-test.
	await test('waitForRefresh parks while current and resolves on the next settings-change poke', async () => {
		await new Promise((r) => setTimeout(r, 200)); // let any warm-up straggler poke settle
		const pokesBefore = state.commandExecutions.length;
		const gen = (await handler({ type: 'getConfig' })).generation;
		const parked = handler({ type: 'waitForRefresh', generation: gen });
		let settled = false;
		void parked.then(() => { settled = true; });
		// DETERMINISTIC pending check (no timing sleep): the immediate-answer path is Promise.resolve,
		// so flushing the microtask queue is enough to observe it; and the generation only moves via
		// pokes, all visible in commandExecutions — an unchanged count proves the park precondition
		// held between reading `gen` and parking.
		await new Promise((r) => setImmediate(r));
		assert.strictEqual(
			state.commandExecutions.length,
			pokesBefore,
			'no poke landed between reading the generation and parking',
		);
		assert.strictEqual(settled, false, 'an up-to-date waitForRefresh parks (no immediate reply)');
		// Any settings change pokes; writing the current value back keeps every later test untouched.
		await state.setSetting('debounceMs', 500);
		const released = await parked;
		assert.ok(
			released.generation > gen,
			`the parked reply resolves with a bumped generation (${released.generation} > ${gen})`,
		);
	});

	await test('waitForRefresh answers a stale client immediately with the current generation', async () => {
		const gen = (await handler({ type: 'getConfig' })).generation;
		const replyPromise = handler({ type: 'waitForRefresh', generation: gen - 1 });
		// The immediate-answer path is pure microtask (Promise.resolve), so a setImmediate flush must
		// observe it settled — a regression to PARKING would fail HERE rather than silently passing
		// 25s later off the heartbeat (which resolves with the very same generation).
		let settled = false;
		void replyPromise.then(() => { settled = true; });
		await new Promise((r) => setImmediate(r));
		assert.strictEqual(settled, true, 'a stale generation is answered immediately, not by the heartbeat');
		const reply = await replyPromise;
		assert.strictEqual(reply.generation, gen, 'answered with the current generation');
	});

	// ---- external dictionary + poll budget ----------------------------------
	const dictFile = path.join(dataDir, 'external-dict.txt');
	fs.writeFileSync(dictFile, 'Sxope\nZlorp\n', 'utf8');
	await state.setSetting('dictionaryPath', dictFile);

	await test('words in the external dictionary are not flagged; an unknown word is', async () => {
		const r = await handler({ type: 'lint', text: 'Sxope and Zlorp but not Qwertyxz.' });
		const spelled = r.filter((l) => l.kind === 'Spelling').map((l) => l.problemText);
		assert.ok(!spelled.includes('Sxope'), '"Sxope" (in dict) is not a Spelling lint');
		assert.ok(!spelled.includes('Zlorp'), '"Zlorp" (in dict) is not a Spelling lint');
		assert.ok(spelled.includes('Qwertyxz'), '"Qwertyxz" (not in dict) IS a Spelling lint');
	});

	await test('dictionary poll with unchanged mtime does ZERO file reads', async () => {
		const pollTimer = state.intervals.find((i) => i.ms === 60000 && !i.cleared);
		assert.ok(pollTimer, 'a 60s dictionary poll interval was armed');
		const before = fsReadCount;
		await pollTimer.fn();
		assert.strictEqual(fsReadCount, before, 'no readFileSync during an unchanged poll tick');
	});

	// ---- add-to-dictionary flow ---------------------------------------------
	await test('addWord appends exactly "word\\n" to the external file and stops flagging it', async () => {
		assert.ok(
			(await handler({ type: 'lint', text: 'Qwertyxz alone.' })).some(
				(l) => l.problemText === 'Qwertyxz' && l.kind === 'Spelling',
			),
			'precondition: Qwertyxz is flagged before adding',
		);
		const before = fs.readFileSync(dictFile, 'utf8');
		await handler({ type: 'addWord', word: 'Qwertyxz' });
		const after = fs.readFileSync(dictFile, 'utf8');
		assert.strictEqual(after, `${before}Qwertyxz\n`, 'appended exactly "Qwertyxz\\n"');
		const r = await handler({ type: 'lint', text: 'Qwertyxz alone.' });
		assert.ok(
			!r.some((l) => l.problemText === 'Qwertyxz' && l.kind === 'Spelling'),
			'Qwertyxz no longer flagged after addWord',
		);
	});

	// ---- disable-rule flow --------------------------------------------------
	await test('disableRule removes the rule from subsequent lints and persists {rule:false}', async () => {
		const anBefore = (await handler({ type: 'lint', text: 'This is an test.' })).filter(
			(l) => l.ruleName === 'AnA',
		);
		assert.ok(anBefore.length >= 1, 'precondition: AnA fires on "an test"');
		await handler({ type: 'disableRule', ruleName: 'AnA' });
		const anAfter = (await handler({ type: 'lint', text: 'This is an test.' })).filter(
			(l) => l.ruleName === 'AnA',
		);
		assert.strictEqual(anAfter.length, 0, 'AnA no longer fires after disableRule');
		const overrides = JSON.parse(await state.settings.ruleOverrides);
		assert.strictEqual(overrides.AnA, false, 'ruleOverrides setting contains {AnA:false}');
		// reset so later assertions are unaffected
		await state.setSetting('ruleOverrides', '');
	});

	// ---- ignore-lint flow ---------------------------------------------------
	await test('ignoreLint drops that finding and persists an ignore-state file in dataDir', async () => {
		const text = 'I saw teh cat.';
		const before = await handler({ type: 'lint', text });
		const teh = before.find((l) => l.problemText === 'teh');
		assert.ok(teh, 'precondition: "teh" is flagged');
		await handler({
			type: 'ignoreLint',
			text,
			start: teh.start,
			end: teh.end,
			ruleName: teh.ruleName,
		});
		const after = await handler({ type: 'lint', text });
		assert.ok(!after.some((l) => l.problemText === 'teh'), '"teh" finding is gone after ignoreLint');
		assert.ok(
			fs.existsSync(path.join(dataDir, 'ignoredLints.json')),
			'ignoredLints.json persisted in dataDir',
		);
	});

	// ---- enabled=false returns [] -------------------------------------------
	await test('enabled=false makes lint requests return []', async () => {
		await state.setSetting('enabled', false);
		const r = await handler({ type: 'lint', text: 'This is an test with beleive.' });
		assert.deepStrictEqual(r, [], 'no lints while disabled');
		await state.setSetting('enabled', true);
	});

	// ---- dialect change -----------------------------------------------------
	await test('dialect: "colour" flagged under American, not under British', async () => {
		await state.setSetting('dialect', 'American');
		const us = await handler({ type: 'lint', text: 'I like the colour red.' });
		assert.ok(
			us.some((l) => l.problemText === 'colour' && l.kind === 'Spelling'),
			'"colour" is a Spelling lint under American',
		);
		await state.setSetting('dialect', 'British');
		const gb = await handler({ type: 'lint', text: 'I like the colour red.' });
		assert.ok(!gb.some((l) => l.problemText === 'colour'), '"colour" not flagged under British');
		await state.setSetting('dialect', 'American');
	});

	// ---- invalid ruleOverrides JSON never throws ----------------------------
	await test('invalid ruleOverrides JSON is ignored and never throws', async () => {
		await state.setSetting('ruleOverrides', 'this is { not json');
		const r = await handler({ type: 'lint', text: 'This is an test.' });
		assert.ok(Array.isArray(r), 'lint still returns an array with invalid ruleOverrides');
		await state.setSetting('ruleOverrides', '');
	});

	// ---- latency on a ~5 KB doc, median of 5 --------------------------------
	const doc = makeMarkdownDoc(5 * 1024);
	const docBytes = Buffer.byteLength(doc, 'utf8');
	const latencies = [];
	for (let i = 0; i < 5; i++) {
		const t0 = Date.now();
		await handler({ type: 'lint', text: doc });
		latencies.push(Date.now() - t0);
	}
	const medianMs = median(latencies);

	await test('a ~5 KB document lints and returns issues', async () => {
		const r = await handler({ type: 'lint', text: doc });
		assert.ok(Array.isArray(r) && r.length >= 1, 'array with >=1 lint for the sample doc');
	});

	// =========================================================================
	// v1.1.0 MOBILE + UNIFIED DICTIONARY
	// =========================================================================

	// A tiny "wait until" helper: the dictionary polls kick off async work without returning a promise,
	// so tests drive the timer then wait for the observable effect (a note put / file write) to land.
	const drain = () => new Promise((r) => setTimeout(r, 30));
	async function waitFor(cond, timeoutMs = 4000) {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (await cond()) return true;
			await drain();
		}
		return false;
	}

	// ---- loader: inlined WASM, no separate .wasm ----------------------------
	await test('loader: dist/index.js embeds the inlined WASM (data:application/wasm) and dist ships no separate .wasm', () => {
		const idx = fs.readFileSync(path.join(DIST_DIR, 'index.js'), 'utf8');
		assert.ok(idx.includes('data:application/wasm'), 'index.js contains the inlined base64 WASM data URL');
		const wasmFiles = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.wasm'));
		assert.strictEqual(wasmFiles.length, 0, `no separate .wasm in dist, found: ${JSON.stringify(wasmFiles)}`);
	});

	// ---- manifest platform declaration --------------------------------------
	await test('manifest declares platforms [desktop, mobile] + app_min_version_mobile 3.3', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'manifest.json'), 'utf8'));
		assert.deepStrictEqual(manifest.platforms, ['desktop', 'mobile'], 'platforms declares both');
		assert.strictEqual(manifest.app_min_version_mobile, '3.3', 'app_min_version_mobile is 3.3');
	});

	// ---- MOBILE run: zero fs, zero data.put while editor open ---------------
	// Drives the SAME compiled bundle with versionInfo.platform='mobile' and a require() stub that FAILS
	// on any call — proving the mobile path never touches the filesystem (L1: no Node on mobile) — and a
	// note store, proving no data.put lands while the editor-open flag is set (L3: a note write mid-edit
	// evicts the mobile editor). The editor-open flag is driven exactly as the real content script does:
	// a getConfig handshake opens it; a note-selection change closes it (and flushes).
	{
		const mobileFsCalls = [];
		const mobileRequire = (name) => {
			mobileFsCalls.push(name);
			throw new Error(`[mobile] joplin.require(${name}) must NEVER run on the mobile path (no Node)`);
		};
		const mobileDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-mobile-'));
		const mnotes = {
			'dict-note-1': {
				id: 'dict-note-1',
				title: 'Harper Dictionary',
				body: `${'# Harper Dictionary — comment'}\n\nAlpha\n`,
				updated_time: 1000,
			},
		};
		const mstate = await run({
			dataDir: mobileDataDir,
			installationDir: DIST_DIR,
			require: mobileRequire,
			versionInfo: { version: '3.7.2', platform: 'mobile' },
			// Start WITHOUT a dictionary note so the test can set it mid-edit (a flush trigger) and prove
			// the write is deferred while the editor is open.
			initialSettings: {},
			notes: mnotes,
			folders: [{ id: 'f1', title: 'Notes' }],
			selectedFolder: { id: 'f1' },
		});
		const mh = mstate.contentScriptMessageHandlers['harperCm'];

		await test('mobile: getConfig reports platform "mobile"', async () => {
			const c = await mh({ type: 'getConfig' }); // also opens the editor-open flag
			assert.strictEqual(c.platform, 'mobile', 'platform is mobile');
		});

		// v1.2.0: the underline style is a pure CSS-class choice, so unlike dictionaryPath it IS
		// registered on mobile — with the same default and the same two options as on desktop.
		await test("mobile: underlineStyle IS registered (default 'squiggly', both options) and getConfig carries it", async () => {
			const def = mstate.registeredSettings.underlineStyle;
			assert.ok(def, 'underlineStyle registered on the mobile run too');
			assert.strictEqual(def.value, 'squiggly', "mobile default is 'squiggly'");
			assert.strictEqual(def.public, true, 'public on mobile');
			assert.strictEqual(def.isEnum, true, 'isEnum on mobile');
			assert.deepStrictEqual(
				Object.keys(def.options).sort(),
				['solid', 'squiggly'],
				'both options offered on mobile',
			);
			const c = await mh({ type: 'getConfig' });
			assert.strictEqual(c.underlineStyle, 'squiggly', 'mobile getConfig carries underlineStyle');
			assert.strictEqual(mobileFsCalls.length, 0, 'reading underlineStyle touched no filesystem');
		});

		await test('mobile: switching to solid is served live by getConfig (no note write, no fs)', async () => {
			const putsBefore = mstate.notePuts.length;
			await mstate.setSetting('underlineStyle', 'solid');
			const c = await mh({ type: 'getConfig' });
			assert.strictEqual(c.underlineStyle, 'solid', 'mobile getConfig serves the new style live');
			// L3: a settings change must never trigger a note write while the editor is open.
			assert.strictEqual(mstate.notePuts.length, putsBefore, 'an underlineStyle change writes NO note');
			assert.strictEqual(mobileFsCalls.length, 0, 'still zero filesystem access on mobile');
			await mstate.setSetting('underlineStyle', 'squiggly'); // restore for the later mobile tests
		});

		await test('mobile: externalDictionaryPath is NOT registered; dictionaryNoteId + pendingWords ARE', () => {
			assert.ok(!mstate.registeredSettings.dictionaryPath, 'dictionaryPath absent on mobile');
			assert.ok(mstate.registeredSettings.dictionaryNoteId, 'dictionaryNoteId present on mobile');
			assert.ok(mstate.registeredSettings.pendingWords, 'pendingWords buffer present on mobile');
		});

		await test('mobile: a lint round-trip works and touches ZERO filesystem (no joplin.require)', async () => {
			const r = await mh({ type: 'lint', text: 'This is an test with beleive.' });
			assert.ok(Array.isArray(r) && r.length >= 1, 'mobile lint returns issues');
			assert.strictEqual(mobileFsCalls.length, 0, `no joplin.require on mobile, saw: ${JSON.stringify(mobileFsCalls)}`);
		});

		await test('mobile: add-to-dictionary buffers into pendingWords and writes NO note (deferred, editor open)', async () => {
			const putsBefore = mstate.notePuts.length;
			await mh({ type: 'addWord', word: 'Zzblort' });
			assert.deepStrictEqual(mstate.settings.pendingWords, ['Zzblort'], 'pendingWords buffered the word');
			assert.strictEqual(mstate.notePuts.length, putsBefore, 'addWord itself writes no note');
			// Setting the dictionary note id mid-edit is a flush TRIGGER, but the editor is open, so the
			// L3 guard must defer it: still ZERO note puts.
			await mstate.setSetting('dictionaryNoteId', 'dict-note-1');
			assert.strictEqual(mstate.notePuts.length, putsBefore, 'flush deferred while editor-open flag is set — ZERO data.put');
			assert.strictEqual(mobileFsCalls.length, 0, 'still no fs access on the mobile path');
		});

		await test('mobile: leaving the note (selection change) closes the editor and flushes pendingWords to the note', async () => {
			const putsBefore = mstate.notePuts.length;
			assert.ok(typeof mstate.noteSelectionChangeHandler === 'function', 'onNoteSelectionChange was registered');
			await mstate.noteSelectionChangeHandler();
			const ok = await waitFor(() => mstate.notePuts.length > putsBefore);
			assert.ok(ok, 'a single note write happened after the editor closed');
			const put = mstate.notePuts[mstate.notePuts.length - 1];
			assert.strictEqual(put.id, 'dict-note-1', 'wrote the dictionary note');
			assert.ok(/(^|\n)Alpha(\n|$)/.test(put.body), 'note keeps existing word Alpha');
			assert.ok(/(^|\n)Zzblort(\n|$)/.test(put.body), 'note now contains the added word Zzblort');
			assert.ok(put.body.startsWith('# '), 'note body starts with the canonical "# " header line');
			assert.deepStrictEqual(mstate.settings.pendingWords, [], 'pendingWords cleared after a successful flush');
			assert.strictEqual(mobileFsCalls.length, 0, 'the whole mobile flow touched ZERO filesystem');
		});

		// v1.3.0: deletions reach mobile too. A word removed from the dictionary note on ANY device
		// arrives here by sync; the 60 s poll notices the note's updated_time and reconciles it into the
		// engine. There is no file side on mobile, so the merge is base-vs-note-vs-pending — and because
		// the note already reflects the deletion there is nothing to write: ZERO data.put, ZERO fs.
		await test('mobile: a word deleted from the dictionary note reaches the engine (zero fs, zero note writes)', async () => {
			assert.deepStrictEqual(
				JSON.parse(mstate.settings.syncBase || 'null'),
				['Alpha', 'Zzblort'],
				'precondition: the flush recorded a merge base',
			);
			const known = await mh({ type: 'lint', text: 'Zzblort alone.' });
			assert.ok(
				!known.some((l) => l.problemText === 'Zzblort'),
				'precondition: Zzblort is currently accepted',
			);
			const putsBefore = mstate.notePuts.length;
			// The deletion syncs in from another device: the note loses the word.
			mstate.notes['dict-note-1'].body = '# Harper Dictionary — comment\n\nAlpha\n';
			mstate.notes['dict-note-1'].updated_time = 5000;
			const pollTimer = mstate.intervals.find((i) => i.ms === 60000 && !i.cleared);
			assert.ok(pollTimer, 'a 60s dictionary poll interval was armed on mobile too');
			pollTimer.fn();
			const forgotten = await waitFor(async () => {
				const r = await mh({ type: 'lint', text: 'Zzblort alone.' });
				return r.some((l) => l.problemText === 'Zzblort' && l.kind === 'Spelling');
			});
			assert.ok(forgotten, 'the deleted word is flagged again on mobile');
			assert.ok(
				!(await mh({ type: 'lint', text: 'Alpha alone.' })).some((l) => l.problemText === 'Alpha'),
				'the surviving word is still accepted',
			);
			assert.strictEqual(mstate.notePuts.length, putsBefore, 'the note already reflects it — ZERO data.put');
			assert.deepStrictEqual(JSON.parse(mstate.settings.syncBase || 'null'), ['Alpha'], 'the base advanced');
			assert.strictEqual(mobileFsCalls.length, 0, 'still ZERO filesystem access on the mobile path');
		});
	}

	// ---- dictionary-note PARSE: header + blank lines skipped ----------------
	{
		const pnotes = {
			'parse-note': {
				id: 'parse-note',
				title: 'Harper Dictionary',
				// A '# ' comment line carrying a made-up word (must be skipped, so it stays flagged) and a
				// blank line, then a real body word (must be imported, so it stops being flagged).
				body: '# Qxheaderword — this entire comment line must be skipped\n\n\nZmorblexx\n\n',
				updated_time: 42,
			},
		};
		const pstate = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-parse-')),
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'parse-note' },
			notes: pnotes,
		});
		const ph = pstate.contentScriptMessageHandlers['harperCm'];
		await test('dictionary note parse: body words import; blank + "# " comment lines are skipped', async () => {
			const r = await ph({ type: 'lint', text: 'Zorbxyz and Zmorblexx and Qxheaderword end.' });
			const spelled = r.filter((l) => l.kind === 'Spelling').map((l) => l.problemText);
			assert.ok(!spelled.includes('Zmorblexx'), '"Zmorblexx" (a body word) is imported → not flagged');
			assert.ok(spelled.includes('Zorbxyz'), '"Zorbxyz" (not in note) IS flagged');
			assert.ok(spelled.includes('Qxheaderword'), '"Qxheaderword" (inside a "# " comment line) is NOT imported → still flagged');
		});
	}

	// ---- pendingWords buffer + dedup ----------------------------------------
	{
		const dnotes = { 'd2': { id: 'd2', body: '# h\n\n', updated_time: 7 } };
		const dstate = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-pending-')),
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'd2' },
			notes: dnotes,
		});
		const dh = dstate.contentScriptMessageHandlers['harperCm'];
		await test('pendingWords: repeated add-to-dictionary of the same word dedups in the buffer', async () => {
			await dh({ type: 'getConfig' }); // open the editor so the buffer is not flushed away
			await dh({ type: 'addWord', word: 'Wibblet' });
			await dh({ type: 'addWord', word: 'Wibblet' });
			await dh({ type: 'addWord', word: 'Grobnar' });
			assert.deepStrictEqual(
				dstate.settings.pendingWords,
				['Wibblet', 'Grobnar'],
				'buffer holds each word once, in insertion order',
			);
		});
	}

	// ---- desktop NOTE<->FILE MIRROR convergence, no ping-pong ----------------
	{
		const mirrorDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-mirror-'));
		const mirrorFile = path.join(mirrorDataDir, 'dict.txt');
		fs.writeFileSync(mirrorFile, 'Zqxfile\n', 'utf8');
		const nnotes = { 'mnote': { id: 'mnote', body: '# h\n\nZqxnote\n', updated_time: 500 } };
		const nstate = await run({
			dataDir: mirrorDataDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			// Both a file AND a note configured => the desktop mirror is active. Editor stays closed
			// (no getConfig), so the start flush + polls may write freely.
			initialSettings: { dictionaryPath: mirrorFile, dictionaryNoteId: 'mnote' },
			notes: nnotes,
		});

		await test('waitForRefresh is NOT the editor-open handshake (the start flush below still writes the note)', async () => {
			// Sent BEFORE the start flush lands: getConfig marks the editor open (L3) and would defer
			// every note write, so if waitForRefresh wrongly did the same, the mirror convergence test
			// below could never see its note write. The settled-flag + setImmediate flush makes the
			// "answered immediately" half falsifiable too (a regression to parking would otherwise
			// pass 25s later off the heartbeat).
			const replyPromise = nstate.contentScriptMessageHandlers['harperCm']({
				type: 'waitForRefresh',
				generation: -1,
			});
			let settled = false;
			void replyPromise.then(() => { settled = true; });
			await new Promise((r) => setImmediate(r));
			assert.strictEqual(settled, true, 'stale waitForRefresh answered immediately, not parked');
			const reply = await replyPromise;
			assert.strictEqual(typeof reply.generation, 'number', 'reply carries the current generation');
		});

		await test('mirror: file word lands in the note and note word lands in the file (both directions)', async () => {
			// The plugin-start flush already runs file->note; wait for the note to carry both words.
			const converged = await waitFor(() => {
				const b = nstate.notes['mnote'].body;
				return b.includes('Zqxfile') && b.includes('Zqxnote');
			});
			assert.ok(converged, 'the note body contains BOTH the file word and the note word');
			const fileText = fs.readFileSync(mirrorFile, 'utf8');
			assert.ok(fileText.includes('Zqxfile'), 'file still has its own word');
			assert.ok(fileText.includes('Zqxnote'), 'the note word was mirrored into the file');
		});

		await test('mirror: repeated polls after convergence do NOT ping-pong (no further note writes / file growth)', async () => {
			const putsBefore = nstate.notePuts.length;
			const fileBefore = fs.readFileSync(mirrorFile, 'utf8');
			const pollTimer = nstate.intervals.find((i) => i.ms === 60000 && !i.cleared);
			assert.ok(pollTimer, 'a 60s dictionary poll interval was armed');
			pollTimer.fn();
			await drain();
			pollTimer.fn();
			await waitFor(() => false, 200); // let any async poll work settle
			assert.strictEqual(nstate.notePuts.length, putsBefore, 'no extra note writes after convergence');
			assert.strictEqual(fs.readFileSync(mirrorFile, 'utf8'), fileBefore, 'file unchanged after convergence');
		});
	}

	// =========================================================================
	// v1.3.0 DELETION PROPAGATION — the user-reported bug, end to end.
	// =========================================================================
	// "Deleting a word from the dictionary note resurrects it after the next poll." Under v1.2.0 the
	// note and the file were reconciled by UNION, so the surviving copy in the file put the word
	// straight back. These tests drive the real bundle through the whole cycle: converge, delete,
	// poll, and assert the word is gone from the note, from the file AND from the engine — and stays
	// gone. The external file is deliberately UNSORTED and carries a comment, so the same tests also
	// pin the "minimal diff" promise: surviving lines keep their order, comments survive, new words
	// are appended at the end.
	{
		const delDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-delete-'));
		const delFile = path.join(delDataDir, 'dict.txt');
		const INITIAL_FILE = '# my own words\nZuluqx\nAlphaqx\nBetaqx\n';
		fs.writeFileSync(delFile, INITIAL_FILE, 'utf8');
		const delNotes = {
			dnote: { id: 'dnote', body: '# h\n\nAlphaqx\nBetaqx\nZuluqx\n', updated_time: 100 },
		};
		const dstate = await run({
			dataDir: delDataDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: delFile, dictionaryNoteId: 'dnote' },
			notes: delNotes,
		});
		const dh = dstate.contentScriptMessageHandlers['harperCm'];
		const readDelFile = () => fs.readFileSync(delFile, 'utf8');
		const delPoll = () => {
			const t = dstate.intervals.find((i) => i.ms === 60000 && !i.cleared);
			assert.ok(t, 'a 60s dictionary poll interval was armed');
			t.fn();
		};
		/** Change a note body as another device's sync would, and bump its updated_time so the poll sees it. */
		const editNote = (body) => {
			dstate.notes.dnote.body = body;
			dstate.notes.dnote.updated_time = (dstate.notes.dnote.updated_time || 0) + 100;
		};
		/** Rewrite the external file as rclone/Zed would, guaranteeing an mtime the poll must notice. */
		const editFile = (content) => {
			fs.writeFileSync(delFile, content, 'utf8');
			const future = new Date(Date.now() + 2000);
			fs.utimesSync(delFile, future, future);
		};
		const spellingIn = async (text) =>
			(await dh({ type: 'lint', text })).filter((l) => l.kind === 'Spelling').map((l) => l.problemText);
		const syncBase = () => JSON.parse(dstate.settings.syncBase || 'null');

		await test('deletion: baseline — the first reconcile records a syncBase and writes NOTHING (sides already agree)', async () => {
			const based = await waitFor(() => Array.isArray(syncBase()));
			assert.ok(based, 'a syncBase was persisted by the first reconcile');
			assert.deepStrictEqual(syncBase(), ['Alphaqx', 'Betaqx', 'Zuluqx'], 'base = the reconciled set');
			assert.strictEqual(dstate.notePuts.length, 0, 'nothing to add anywhere — no note write');
			assert.strictEqual(readDelFile(), INITIAL_FILE, 'the file is untouched, order and comment intact');
			const spelled = await spellingIn('Alphaqx Betaqx Zuluqx are known.');
			assert.deepStrictEqual(spelled, [], 'all three words are known to the engine');
		});

		await test('deletion: a word ADDED in the note is appended at the END of the file, order preserved', async () => {
			editNote('# h\n\nAlphaqx\nBetaqx\nMikeqx\nZuluqx\n');
			delPoll();
			const landed = await waitFor(() => readDelFile().includes('Mikeqx'));
			assert.ok(landed, 'the new note word reached the file');
			assert.strictEqual(
				readDelFile(),
				'# my own words\nZuluqx\nAlphaqx\nBetaqx\nMikeqx\n',
				'surviving lines keep their original (unsorted) order; the new word is appended last',
			);
		});

		await test('deletion: THE BUG — deleting a word from the note removes it from the file AND the engine', async () => {
			assert.deepStrictEqual(await spellingIn('Betaqx alone.'), [], 'precondition: Betaqx is accepted');
			editNote('# h\n\nAlphaqx\nMikeqx\nZuluqx\n'); // the user deletes "Betaqx" from the dictionary note
			delPoll();
			const removed = await waitFor(() => !readDelFile().includes('Betaqx'));
			assert.ok(removed, 'the external file no longer contains the deleted word');
			assert.strictEqual(
				readDelFile(),
				'# my own words\nZuluqx\nAlphaqx\nMikeqx\n',
				'ONLY the deleted line was dropped — comment, order and the other words are untouched',
			);
			assert.ok(!dstate.notes.dnote.body.includes('Betaqx'), 'the note does not get it back');
			assert.deepStrictEqual(
				await spellingIn('Betaqx alone.'),
				['Betaqx'],
				'the engine forgot the word: it is flagged as a misspelling again',
			);
			assert.deepStrictEqual(syncBase(), ['Alphaqx', 'Mikeqx', 'Zuluqx'], 'the base advanced past the deletion');
		});

		await test('deletion: it STAYS gone across further poll cycles (no resurrection, no writes)', async () => {
			const putsBefore = dstate.notePuts.length;
			const fileBefore = readDelFile();
			delPoll();
			await drain();
			delPoll();
			await waitFor(() => false, 300); // let any async poll work settle
			assert.strictEqual(readDelFile(), fileBefore, 'file unchanged at the new fixed point');
			assert.strictEqual(dstate.notePuts.length, putsBefore, 'no note writes at the new fixed point');
			assert.ok(!dstate.notes.dnote.body.includes('Betaqx'), 'still absent from the note');
			assert.deepStrictEqual(await spellingIn('Betaqx alone.'), ['Betaqx'], 'still unknown to the engine');
		});

		await test('deletion: the REVERSE direction — deleting from the FILE rewrites the note and the engine', async () => {
			editFile('# my own words\nZuluqx\nMikeqx\n'); // "Alphaqx" deleted from the file (Zed / rclone)
			const putsBefore = dstate.notePuts.length;
			delPoll();
			const written = await waitFor(
				() => dstate.notePuts.length > putsBefore && !dstate.notes.dnote.body.includes('Alphaqx'),
			);
			assert.ok(written, 'the note was rewritten without the word deleted from the file');
			assert.ok(dstate.notes.dnote.body.includes('Zuluqx'), 'the surviving words stay in the note');
			assert.deepStrictEqual(
				await spellingIn('Alphaqx alone.'),
				['Alphaqx'],
				'the engine forgot the file-deleted word too',
			);
			assert.deepStrictEqual(syncBase(), ['Mikeqx', 'Zuluqx']);
		});

		await test('deletion: CONFLICT — a local add-to-dictionary beats a concurrent note-side deletion', async () => {
			// The user deletes the word in the note on another device while, on this one, they add the
			// very same word via the card. The addition must win — losing a word the user just asked for
			// is far worse than keeping one they meant to drop.
			editNote('# h\n\nZuluqx\n'); // "Mikeqx" deleted remotely
			await dh({ type: 'addWord', word: 'Mikeqx' }); // ...and re-added locally (buffered in pendingWords)
			delPoll();
			const restored = await waitFor(() => dstate.notes.dnote.body.includes('Mikeqx'));
			assert.ok(restored, 'the note carries the re-added word again');
			assert.ok(readDelFile().includes('Mikeqx'), 'the file keeps it too');
			assert.deepStrictEqual(await spellingIn('Mikeqx alone.'), [], 'the engine still accepts it');
			assert.deepStrictEqual(syncBase(), ['Mikeqx', 'Zuluqx'], 'the base keeps the word that won');
			assert.deepStrictEqual(dstate.settings.pendingWords, [], 'the pending buffer was flushed');
		});
	}

	// ---- v1.3.0 FILE-REWRITE SAFETY: a concurrent writer (rclone) must never be clobbered ----
	// The rewrite reads the file, merges, writes a sibling temp file and renames it into place. If the
	// file changes between the read and the rename — rclone landing a synced copy, Zed saving — the
	// rewrite is ABORTED (the temp file removed, the merge base left alone) and retried next tick, so
	// the other writer's content survives and is merged rather than overwritten. This test sabotages
	// the write exactly in that window through the fs stub.
	{
		const raceDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-race-'));
		const raceFile = path.join(raceDataDir, 'dict.txt');
		fs.writeFileSync(raceFile, 'Alpharc\nBetarc\n', 'utf8');
		let sabotage = false;
		// Stands in for rclone writing the file while our temp file is being written.
		const sabotagingFsExtra = new Proxy(fsExtra, {
			get(target, prop) {
				if (prop === 'writeFileSync') {
					return (file, data, opts) => {
						const result = target.writeFileSync(file, data, opts);
						if (sabotage && String(file).endsWith('.harper-tmp')) {
							// The temp file is a DOT-PREFIXED sibling: "<dir>/.<basename>.harper-tmp".
							const real = path.join(path.dirname(String(file)), path.basename(String(file)).slice(1, -'.harper-tmp'.length));
							target.appendFileSync(real, 'Gammarc\n');
							const future = new Date(Date.now() + 4000);
							target.utimesSync(real, future, future);
						}
						return result;
					};
				}
				return target[prop];
			},
		});
		const rstate = await run({
			dataDir: raceDataDir,
			installationDir: DIST_DIR,
			require: (name) => {
				if (name === 'fs-extra') return sabotagingFsExtra;
				throw new Error(`Unexpected joplin.require(${name})`);
			},
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: raceFile, dictionaryNoteId: 'rnote' },
			notes: { rnote: { id: 'rnote', body: '# h\n\nAlpharc\nBetarc\n', updated_time: 10 } },
		});
		const racePoll = () => rstate.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();
		const rh = rstate.contentScriptMessageHandlers['harperCm'];

		await test('file safety: a write that races a concurrent file change is ABORTED, keeping the other writer\'s content', async () => {
			const based = await waitFor(() => Array.isArray(JSON.parse(rstate.settings.syncBase || 'null')));
			assert.ok(based, 'precondition: converged with a base');
			// Awaiting a lint also awaits the engine warm-up, so every startup reconcile is done before
			// the sabotage is armed and exactly ONE rewrite attempt races the concurrent writer.
			const known = await rh({ type: 'lint', text: 'Alpharc and Betarc.' });
			assert.strictEqual(known.filter((l) => l.kind === 'Spelling').length, 0, 'precondition: both words known');
			sabotage = true;
			// A word is deleted from the note, so the file needs rewriting — and rclone lands mid-write.
			rstate.notes.rnote.body = '# h\n\nAlpharc\n';
			rstate.notes.rnote.updated_time = 20;
			racePoll();
			const raced = await waitFor(() => fs.readFileSync(raceFile, 'utf8').includes('Gammarc'));
			assert.ok(raced, 'the concurrent writer got its word in');
			assert.strictEqual(
				fs.readFileSync(raceFile, 'utf8'),
				'Alpharc\nBetarc\nGammarc\n',
				'the concurrent write survived intact — our stale rewrite did NOT land',
			);
			const raceTmp = path.join(path.dirname(raceFile), `.${path.basename(raceFile)}.harper-tmp`);
			assert.ok(!fs.existsSync(raceTmp), 'the abandoned temp file was cleaned up');
			assert.ok(
				!fs.readdirSync(raceDataDir).some((f) => f.endsWith('.harper-tmp') && !f.startsWith('.')),
				'the temp file is dot-prefixed, so rclone-style sync is less likely to pick it up mid-write',
			);
			assert.deepStrictEqual(
				JSON.parse(rstate.settings.syncBase),
				['Alpharc', 'Betarc'],
				'a partial pass does NOT advance the merge base — the deletion is retried, not lost',
			);
		});

		await test('file safety: the next tick converges — the deletion lands and the raced-in word is kept', async () => {
			sabotage = false;
			racePoll();
			const settled = await waitFor(() => !fs.readFileSync(raceFile, 'utf8').includes('Betarc'));
			assert.ok(settled, 'the retried rewrite dropped the deleted word');
			assert.strictEqual(
				fs.readFileSync(raceFile, 'utf8'),
				'Alpharc\nGammarc\n',
				'deleted word gone, concurrently-added word kept, order preserved',
			);
			const noteHasIt = await waitFor(() => rstate.notes.rnote.body.includes('Gammarc'));
			assert.ok(noteHasIt, 'the raced-in file word reached the note');
			assert.ok(!rstate.notes.rnote.body.includes('Betarc'), 'the note stays free of the deleted word');
			assert.deepStrictEqual(JSON.parse(rstate.settings.syncBase), ['Alpharc', 'Gammarc']);
		});
	}

	// =========================================================================
	// v1.3.0 ABSENT-SIDE DATA LOSS — the presence gate on the commit (regression suite).
	// =========================================================================
	// An absent side infers no deletions, which keeps ONE pass safe. It does not keep TWO passes safe:
	// if the base is still advanced on a pass where a configured side was missing, that side comes back
	// holding older content and the other side's additions read as deletions on it — and are destroyed,
	// silently and permanently, then synced everywhere. The commit therefore also requires every
	// configured side to have been PRESENT. These three sequences are the exact ones that lost words
	// before that gate existed; each ends with "nothing was wiped and the sides converge".
	{
		// ---- H1: the FILE goes absent (rclone moves it aside), then returns with stale content ----
		const h1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-absent-file-'));
		const h1File = path.join(h1Dir, 'dict.txt');
		fs.writeFileSync(h1File, 'Alphaqx\n', 'utf8');
		const h1state = await run({
			dataDir: h1Dir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: h1File, dictionaryNoteId: 'h1note' },
			notes: { h1note: { id: 'h1note', body: '# h\n\nAlphaqx\n', updated_time: 100 } },
		});
		const h1h = h1state.contentScriptMessageHandlers['harperCm'];
		const h1poll = () => h1state.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();
		const h1base = () => JSON.parse(h1state.settings.syncBase || 'null');
		const h1spell = async (t) =>
			(await h1h({ type: 'lint', text: t })).filter((l) => l.kind === 'Spelling').map((l) => l.problemText);

		await test('absent file: a note-side add is served to the engine but does NOT advance the base', async () => {
			assert.ok(await waitFor(() => Array.isArray(h1base())), 'precondition: converged with a base');
			assert.deepStrictEqual(h1base(), ['Alphaqx'], 'precondition: base = the agreed word');
			// rclone moves the file aside while another device adds a word to the note.
			fs.renameSync(h1File, `${h1File}.moved`);
			h1state.notes.h1note.body = '# h\n\nAlphaqx\nCharlieqx\n';
			h1state.notes.h1note.updated_time += 100;
			h1poll();
			await waitFor(() => false, 300);
			assert.deepStrictEqual(
				await h1spell('Charlieqx alone.'),
				[],
				'the engine accepts the new word straight away — an absent side still serves additively',
			);
			assert.deepStrictEqual(
				h1base(),
				['Alphaqx'],
				'the base did NOT absorb a word the absent file has never seen',
			);
		});

		await test('absent file: when it returns stale, the note-side word SURVIVES and is pushed into the file', async () => {
			fs.renameSync(`${h1File}.moved`, h1File);
			const future = new Date(Date.now() + 3000);
			fs.utimesSync(h1File, future, future);
			h1poll();
			const landed = await waitFor(() => fs.readFileSync(h1File, 'utf8').includes('Charlieqx'));
			assert.ok(landed, 'the returning file receives the word it missed');
			assert.ok(h1state.notes.h1note.body.includes('Charlieqx'), 'the note kept it — nothing was wiped');
			assert.deepStrictEqual(await h1spell('Charlieqx alone.'), [], 'and the engine still accepts it');
			assert.deepStrictEqual(h1base(), ['Alphaqx', 'Charlieqx'], 'only now does the base advance');
		});

		// ---- H1b: the NOTE goes absent (deleted / not yet synced), then returns with stale content ----
		const h1bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-absent-note-'));
		const h1bFile = path.join(h1bDir, 'dict.txt');
		fs.writeFileSync(h1bFile, 'Alphaqx\n', 'utf8');
		const h1bstate = await run({
			dataDir: h1bDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: h1bFile, dictionaryNoteId: 'h1bnote' },
			notes: { h1bnote: { id: 'h1bnote', body: '# h\n\nAlphaqx\n', updated_time: 100 } },
		});
		const h1bpoll = () => h1bstate.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();
		const h1bbase = () => JSON.parse(h1bstate.settings.syncBase || 'null');
		let h1bSavedNote = null;

		await test('absent note: a file-side add does NOT advance the base while the note is unreadable', async () => {
			assert.ok(await waitFor(() => Array.isArray(h1bbase())), 'precondition: converged with a base');
			// The note becomes unreadable (deleted on another device, or not yet synced here) while Zed
			// adds a word to the external file.
			h1bSavedNote = h1bstate.notes.h1bnote;
			delete h1bstate.notes.h1bnote;
			fs.writeFileSync(h1bFile, 'Alphaqx\nDeltaqx\n', 'utf8');
			const future = new Date(Date.now() + 3000);
			fs.utimesSync(h1bFile, future, future);
			h1bpoll();
			await waitFor(() => false, 300);
			assert.deepStrictEqual(h1bbase(), ['Alphaqx'], 'the base stayed put with the note side missing');
		});

		await test('absent note: when it returns stale, the file-side word SURVIVES and reaches the note', async () => {
			h1bstate.notes.h1bnote = h1bSavedNote;
			h1bstate.notes.h1bnote.updated_time += 100;
			h1bpoll();
			const reached = await waitFor(() => h1bstate.notes.h1bnote.body.includes('Deltaqx'));
			assert.ok(reached, 'the returning note receives the word it missed');
			assert.ok(
				fs.readFileSync(h1bFile, 'utf8').includes('Deltaqx'),
				'the file kept it — the stale note did not read it as a deletion',
			);
			assert.deepStrictEqual(h1bbase(), ['Alphaqx', 'Deltaqx'], 'only now does the base advance');
		});

		// ---- H1c: FIRST RUN with the file absent (Joplin launched before the drive was mounted) ----
		// The one that needs no race at all, and the worst: the first run would adopt the note as the
		// base, commit it, and then delete every note-only word the moment the drive appeared.
		const h1cDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-absent-first-'));
		const h1cFile = path.join(h1cDir, 'dict.txt'); // deliberately NOT created yet
		const h1cstate = await run({
			dataDir: h1cDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: h1cFile, dictionaryNoteId: 'h1cnote' },
			notes: { h1cnote: { id: 'h1cnote', body: '# h\n\nAlphaqx\nBetaqx\nGammaqx\n', updated_time: 100 } },
		});
		const h1ch = h1cstate.contentScriptMessageHandlers['harperCm'];
		const h1cpoll = () => h1cstate.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();
		const h1cbase = () => JSON.parse(h1cstate.settings.syncBase || 'null');
		const h1cspell = async (t) =>
			(await h1ch({ type: 'lint', text: t })).filter((l) => l.kind === 'Spelling').map((l) => l.problemText);

		await test('first run with the drive unmounted: the note words load but NO base is recorded', async () => {
			// Awaiting a lint awaits the engine warm-up, hence the whole startup reconcile.
			assert.deepStrictEqual(
				await h1cspell('Alphaqx Betaqx Gammaqx here.'),
				[],
				'all three note words are known to the engine even with no file side',
			);
			assert.strictEqual(h1cbase(), null, 'no base was committed: the configured file side was never seen');
		});

		await test('first run: when the drive mounts, NOTHING is wiped — all three words survive and converge', async () => {
			fs.writeFileSync(h1cFile, 'Alphaqx\n', 'utf8'); // the drive appears, holding only its own word
			h1cpoll();
			const converged = await waitFor(() => fs.readFileSync(h1cFile, 'utf8').includes('Gammaqx'));
			assert.ok(converged, 'the mounted file receives the note words');
			assert.strictEqual(
				fs.readFileSync(h1cFile, 'utf8'),
				'Alphaqx\nBetaqx\nGammaqx\n',
				'its own word is kept first, the note-only words are appended — no deletion inferred',
			);
			assert.ok(h1cstate.notes.h1cnote.body.includes('Betaqx'), 'the note kept Betaqx');
			assert.ok(h1cstate.notes.h1cnote.body.includes('Gammaqx'), 'the note kept Gammaqx');
			assert.deepStrictEqual(await h1cspell('Betaqx Gammaqx here.'), [], 'the engine still accepts both');
			assert.deepStrictEqual(
				h1cbase(),
				['Alphaqx', 'Betaqx', 'Gammaqx'],
				'the base is committed on the first pass that saw BOTH sides',
			);
		});
	}

	// =========================================================================
	// v1.3.0 NO DUPLICATE LINES in the external file.
	// =========================================================================
	// The order-preserving rewrite keeps every line whose word is still wanted, so a duplicate line is
	// permanent once it exists. Two ways one could appear, both closed here: add-to-dictionary
	// appending a word the file already lists, and a duplicate the user (or another tool) left behind.
	{
		const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-dup-'));
		const dupFile = path.join(dupDir, 'dict.txt');
		fs.writeFileSync(dupFile, '# c\nAlphadd\nBetadd\nAlphadd\n', 'utf8');
		const dupstate = await run({
			dataDir: dupDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: dupFile, dictionaryNoteId: 'dupnote' },
			notes: { dupnote: { id: 'dupnote', body: '# h\n\nAlphadd\nBetadd\n', updated_time: 100 } },
		});
		const duph = dupstate.contentScriptMessageHandlers['harperCm'];
		const duppoll = () => dupstate.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();

		await test('no duplicates: add-to-dictionary of a word the file already lists appends NOTHING', async () => {
			assert.ok(
				await waitFor(() => Array.isArray(JSON.parse(dupstate.settings.syncBase || 'null'))),
				'precondition: converged with a base',
			);
			const before = fs.readFileSync(dupFile, 'utf8');
			await duph({ type: 'addWord', word: 'Betadd' });
			assert.strictEqual(fs.readFileSync(dupFile, 'utf8'), before, 'the file is byte-identical: no second line');
		});

		await test('no duplicates: a rewrite collapses a repeated word to its FIRST line, order otherwise intact', async () => {
			dupstate.notes.dupnote.body = '# h\n\nAlphadd\nBetadd\nMikedd\n'; // a new word forces a rewrite
			dupstate.notes.dupnote.updated_time += 100;
			duppoll();
			const rewritten = await waitFor(() => fs.readFileSync(dupFile, 'utf8').includes('Mikedd'));
			assert.ok(rewritten, 'the new word reached the file');
			assert.strictEqual(
				fs.readFileSync(dupFile, 'utf8'),
				'# c\nAlphadd\nBetadd\nMikedd\n',
				'the second "Alphadd" is gone; the comment, the first copy and the order all survive',
			);
		});
	}

	// =========================================================================
	// v1.1.1 COLD-START BUDGET — onStart returns fast; engine + I/O warm in the background.
	// =========================================================================
	// Restructure claim: onStart wires only the cheap registrations (settings, content script, command,
	// change/selection hooks, poll-timer arming) and AWAITS none of the heavy work. The engine build
	// (LocalLinter.setup()), the initial dictionary reads + importWords, and the start-of-session flush
	// are all fire-and-forget AFTER onStart resolves. This budget block instruments that boundary:
	//   (a) onStart's own handler time is tiny AND, at the instant it resolves, ZERO joplin.data.get,
	//       ZERO joplin.data.put and ZERO fs reads have been awaited — while the content script, settings
	//       and poll timer ARE already wired (fast path);
	//   (b) the background then warms the engine + imports the dictionary WITHOUT any lint request, a
	//       subsequent lint is served warm and reflects the imported words, and the deferred start flush
	//       persists the previous-session pending word into the note (editor never open, L3-safe).
	let budgetOnStartMs = -1;
	{
		const budgetNotes = {
			'budget-note': { id: 'budget-note', title: 'Harper Dictionary', body: '# hdr\n\nAlreadyknown\n', updated_time: 10 },
		};
		const fsBefore = fsReadCount;
		const bstate = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-budget-')),
			installationDir: DIST_DIR,
			require: requireStub, // counting fs-extra: proves fs reads are deferred, not awaited in onStart
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			// A configured dictionary note + a word buffered from a "previous session" (editor NOT open),
			// so there is a real dictionary import AND a real start flush to defer.
			initialSettings: { dictionaryNoteId: 'budget-note', pendingWords: ['Zbudgetword'] },
			notes: budgetNotes,
		});
		budgetOnStartMs = bstate.onStartMs;
		// Snapshot the counters at the instant onStart resolved (before draining any background macrotask).
		const getsAtReturn = bstate.gets.length;
		const putsAtReturn = bstate.notePuts.length;
		const fsAtReturn = fsReadCount - fsBefore;

		await test('budget: onStart returns fast having AWAITED zero engine build, zero data.get/put, zero fs reads', () => {
			assert.ok(
				bstate.onStartMs < 500,
				`onStart handler took ${bstate.onStartMs} ms — must be < 500 ms (engine build + I/O are deferred, not awaited)`,
			);
			assert.strictEqual(getsAtReturn, 0, `no joplin.data.get awaited in onStart, saw ${getsAtReturn}`);
			assert.strictEqual(putsAtReturn, 0, `no joplin.data.put awaited in onStart, saw ${putsAtReturn}`);
			assert.strictEqual(fsAtReturn, 0, `no fs read awaited in onStart, saw ${fsAtReturn}`);
			// ...yet the fast path IS fully wired the instant onStart returns:
			assert.strictEqual(bstate.contentScripts.length, 1, 'content script registered eagerly');
			assert.ok(bstate.contentScriptMessageHandlers['harperCm'], 'onMessage handler wired eagerly');
			assert.ok(bstate.registeredSettings, 'settings registered eagerly');
			assert.ok(bstate.commands.find((c) => c.name === 'harper.createDictionaryNote'), 'command registered eagerly');
			assert.ok(bstate.intervals.find((i) => i.ms === 60000 && !i.cleared), 'poll timer armed eagerly (harness-captured)');
		});

		await test('budget: the background init issues the deferred dictionary read WITHOUT any lint request', async () => {
			// No lint was ever requested; the data.get can only come from the background warm-up /
			// start-flush that onStart kicked off after returning.
			const ran = await waitFor(() => bstate.gets.length > 0);
			assert.ok(ran, 'a background joplin.data.get ran on its own (deferred dictionary read)');
		});

		const bh = bstate.contentScriptMessageHandlers['harperCm'];
		await test('budget: a lint served after warm-up works and reflects the background-imported dictionary word', async () => {
			const r = await bh({ type: 'lint', text: 'Alreadyknown but Qwertyxz is not.' });
			assert.ok(Array.isArray(r) && r.length >= 1, 'lint returns issues once the engine is warm');
			const spelled = r.filter((l) => l.kind === 'Spelling').map((l) => l.problemText);
			assert.ok(!spelled.includes('Alreadyknown'), '"Alreadyknown" (a note word) was imported → not flagged');
			assert.ok(spelled.includes('Qwertyxz'), '"Qwertyxz" (unknown) IS still flagged');
		});

		await test('budget: the deferred start flush persisted the previous-session pending word into the note (editor never open)', async () => {
			const flushed = await waitFor(() =>
				bstate.notePuts.some((p) => p.id === 'budget-note' && /(^|\n)Zbudgetword(\n|$)/.test(p.body || '')),
			);
			assert.ok(flushed, 'the start flush folded the buffered pending word into the dictionary note');
			const put = bstate.notePuts[bstate.notePuts.length - 1];
			assert.ok(/(^|\n)Alreadyknown(\n|$)/.test(put.body), 'the note keeps its existing word');
			assert.deepStrictEqual(bstate.settings.pendingWords, [], 'pendingWords cleared after the deferred flush');
		});
	}

	// =========================================================================
	// v1.4.0 SETTINGS OVERHAUL — dismissed-findings side table + service layer
	// =========================================================================

	const dismissedLog = loadTsModule('src/dismissedLog.ts');
	// settingsService.ts imports './dismissedLog' for real (not just types), so hand it the copy we
	// just loaded rather than letting require() resolve it relative to test/.
	const settingsSvc = loadTsModule('src/settingsService.ts', (id) =>
		id === './dismissedLog' ? dismissedLog : require(id),
	);

	// ---- pure: the u64 hash discipline --------------------------------------
	// These two real hashes came out of harper 2.7.0's contextHash() for "teh" and "beleive". Both
	// are 20-digit u64s, i.e. FAR past Number.MAX_SAFE_INTEGER (9007199254740991) — which is the
	// entire reason src/dismissedLog.ts refuses to let a hash become a JS number.
	const REAL_HASH_A = '11940613493308079398';
	const REAL_HASH_B = '9722060015410969502';
	const REAL_PAYLOAD = `{"context_hashes":[${REAL_HASH_A},${REAL_HASH_B}]}`;

	await test('u64: extractHashes lifts context hashes out as EXACT decimal strings', () => {
		const hashes = dismissedLog.extractHashes(REAL_PAYLOAD);
		assert.deepStrictEqual(hashes, [REAL_HASH_A, REAL_HASH_B], 'both hashes recovered verbatim');
		assert.ok(
			hashes.every((h) => typeof h === 'string'),
			'hashes are strings, never numbers',
		);
	});

	await test('u64: the naive JSON.parse route DOES corrupt these hashes (the trap being avoided)', () => {
		// This is the bug the regex exists to prevent, asserted rather than described: parsing the
		// payload as JSON silently rounds the u64s, and re-stringifying writes a DIFFERENT integer, so
		// harper's ignores stop matching and every dismissed finding quietly comes back.
		const naive = JSON.parse(REAL_PAYLOAD).context_hashes.map((n) => String(n));
		assert.notStrictEqual(naive[0], REAL_HASH_A, 'JSON.parse changes the first hash');
		assert.notStrictEqual(naive[1], REAL_HASH_B, 'JSON.parse changes the second hash');
		// ...and the safe path does not.
		assert.deepStrictEqual(
			dismissedLog.extractHashes(REAL_PAYLOAD),
			[REAL_HASH_A, REAL_HASH_B],
			'the regex path is lossless where JSON.parse is not',
		);
	});

	await test('u64: buildIgnoredLintsPayload rebuilds harper\'s payload BYTE-IDENTICALLY', () => {
		const rebuilt = dismissedLog.buildIgnoredLintsPayload(dismissedLog.extractHashes(REAL_PAYLOAD));
		assert.strictEqual(rebuilt, REAL_PAYLOAD, 'round trip is byte-exact');
		assert.strictEqual(
			dismissedLog.buildIgnoredLintsPayload([]),
			'{"context_hashes":[]}',
			'an empty keep-set is still a well-formed (no-op) payload',
		);
		assert.strictEqual(
			dismissedLog.buildIgnoredLintsPayload(['12', 'not-a-hash', '12']),
			'{"context_hashes":[12]}',
			'junk is dropped and duplicates collapse, so the payload can never be malformed JSON',
		);
	});

	await test('legacyCount counts only the hashes no side-table entry accounts for', () => {
		const entries = [
			{ id: REAL_HASH_A, hashes: [REAL_HASH_A], ruleName: 'The', problemText: 'teh', dismissedAt: '' },
		];
		assert.strictEqual(dismissedLog.legacyCount(REAL_PAYLOAD, entries), 1, 'B is legacy, A is not');
		assert.deepStrictEqual(dismissedLog.legacyHashes(REAL_PAYLOAD, entries), [REAL_HASH_B], 'B named');
		assert.strictEqual(dismissedLog.legacyCount(REAL_PAYLOAD, []), 2, 'no entries => everything legacy');
		assert.strictEqual(dismissedLog.legacyCount('', entries), 0, 'no ignore state => nothing legacy');
	});

	await test('hashesWithoutEntry yields the keep-set for un-ignoring exactly one entry', () => {
		const entry = { id: REAL_HASH_A, hashes: [REAL_HASH_A], ruleName: 'The', problemText: 'teh', dismissedAt: '' };
		assert.deepStrictEqual(
			dismissedLog.hashesWithoutEntry(REAL_PAYLOAD, entry),
			[REAL_HASH_B],
			'the restored entry\'s hash is dropped and every other survives',
		);
	});

	await test('parseEntries tolerates corrupt state and drops rows that could never be restored', () => {
		assert.deepStrictEqual(dismissedLog.parseEntries('not json at all'), [], 'corrupt => empty');
		assert.deepStrictEqual(dismissedLog.parseEntries(''), [], 'empty => empty');
		const parsed = dismissedLog.parseEntries(
			JSON.stringify({
				version: 1,
				entries: [
					{ id: REAL_HASH_A, hashes: [REAL_HASH_A], ruleName: 'The', problemText: 'teh', dismissedAt: 'x' },
					{ id: 'orphan', hashes: [], ruleName: 'X', problemText: 'y', dismissedAt: 'z' },
				],
			}),
		);
		assert.strictEqual(parsed.length, 1, 'the hash-less row is dropped (un-restorable, un-matchable)');
		assert.strictEqual(parsed[0].id, REAL_HASH_A, 'the usable row survives intact');
	});

	// ---- pure: settings-service helpers -------------------------------------
	await test('normalizeRuleOverrides keeps explicit booleans and DROPS null (sparse = only what the user set)', () => {
		assert.deepStrictEqual(
			settingsSvc.normalizeRuleOverrides({ A: true, B: false, C: null, D: undefined }),
			{ A: true, B: false },
			'null/undefined mean "Default", which is expressed by ABSENCE',
		);
		assert.deepStrictEqual(settingsSvc.normalizeRuleOverrides({}), {}, 'empty stays empty');
	});

	await test('diffWords computes the dictionary editor\'s add/remove sets against the current list', () => {
		const diff = settingsSvc.diffWords(['alpha', 'beta'], ['beta', 'gamma']);
		assert.deepStrictEqual(diff.adds, ['gamma'], 'gamma is new');
		assert.deepStrictEqual(diff.removes, ['alpha'], 'alpha was deleted');
		const noop = settingsSvc.diffWords(['a', 'b'], ['b', 'a']);
		assert.deepStrictEqual(noop, { adds: [], removes: [] }, 'reordering is not an edit');
	});

	await test('ruleDisplayLabel derives a label from the rule name (harper returns label:null for all 823)', () => {
		assert.strictEqual(settingsSvc.ruleDisplayLabel('AmazonNames'), 'Amazon Names');
		assert.strictEqual(settingsSvc.ruleDisplayLabel('HTMLTags'), 'HTML Tags');
		assert.strictEqual(settingsSvc.ruleDisplayLabel('SpelledNumbers'), 'Spelled Numbers');
	});

	// ---- pure: explicit removals in the three-way merge ----------------------
	await test('merge removals: a STATED deletion beats a concurrent addition (reverse of the normal rule)', () => {
		// "alpha" is being added by the pending buffer AND removed by the editor. Normally addition
		// wins; an explicit removal is the user's stated intent, so it wins instead.
		const out = mergeDictionary({
			base: ['alpha', 'beta'],
			note: ['alpha', 'beta'],
			file: null,
			pending: ['alpha'],
			removals: ['alpha'],
		});
		assert.deepStrictEqual(out.result, ['beta'], 'alpha is gone despite being pending');
		assert.ok(out.deleted.includes('alpha'), 'reported as a deletion');
		assert.strictEqual(out.noteChanged, true, 'the note still lists it, so the note must be rewritten');
	});

	await test('merge removals: a stated deletion applies even on a FIRST RUN, where inference is skipped', () => {
		const out = mergeDictionary({
			base: null, // first run: deletion INFERENCE is skipped entirely
			note: ['alpha', 'beta'],
			file: null,
			pending: [],
			removals: ['alpha'],
		});
		assert.deepStrictEqual(out.result, ['beta'], 'the stated removal still lands');
		assert.strictEqual(out.firstRun, true, 'and it really was a first run');
	});

	await test('merge removals: omitting the field is exactly the pre-v1.4.0 behaviour', () => {
		const without = mergeDictionary({ base: ['a'], note: ['a', 'b'], file: null, pending: [] });
		const empty = mergeDictionary({ base: ['a'], note: ['a', 'b'], file: null, pending: [], removals: [] });
		assert.deepStrictEqual(without, empty, 'absent and empty removals agree');
		assert.deepStrictEqual(without.result, ['a', 'b'], 'and the result is the plain merge');
	});

	// ---- integration: dismiss -> record -> restore, against the REAL linter --
	// Own fixture: a fresh dataDir and a fresh engine, with NO dictionary note and NO external file,
	// so nothing here interacts with the reconcile machinery the blocks above exercise.
	{
		const sdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-settings-'));
		const sdState = await run({
			dataDir: sdDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
		});
		const sh = sdState.contentScriptMessageHandlers['harperCm'];
		const metaPath = path.join(sdDir, 'dismissedMeta.json');
		const ignorePath = path.join(sdDir, 'ignoredLints.json');
		const readEntries = () => {
			try {
				return JSON.parse(fs.readFileSync(metaPath, 'utf8')).entries;
			} catch {
				return [];
			}
		};
		const readIgnoreRaw = () => {
			try {
				return fs.readFileSync(ignorePath, 'utf8');
			} catch {
				return '';
			}
		};

		const TEXT_A = 'I saw teh cat.';
		const TEXT_B = 'I beleive it.';
		let entryA = null;
		let entryB = null;
		let hashesBeforeRestore = [];

		await test('dismiss records a side-table entry with the rule, the flagged text, a date and >=1 hash STRING', async () => {
			const lint = (await sh({ type: 'lint', text: TEXT_A })).find((l) => l.problemText === 'teh');
			assert.ok(lint, 'precondition: "teh" is flagged');
			await sh({ type: 'ignoreLint', text: TEXT_A, start: lint.start, end: lint.end, ruleName: lint.ruleName });

			const entries = readEntries();
			assert.strictEqual(entries.length, 1, 'exactly one entry per user-visible Dismiss');
			const entry = entries[0];
			assert.ok(entry.hashes.length >= 1, 'at least one context hash captured');
			assert.ok(
				entry.hashes.every((h) => typeof h === 'string' && /^\d+$/.test(h)),
				'every hash is a decimal STRING, never a number',
			);
			assert.strictEqual(entry.id, entry.hashes[0], 'id is the first hash (stable)');
			assert.strictEqual(entry.problemText, 'teh', 'the flagged span is recorded');
			assert.ok(entry.ruleName.length > 0, 'the rule name is recorded');
			assert.ok(!Number.isNaN(Date.parse(entry.dismissedAt)), 'dismissedAt is a parseable ISO date');
			// The privacy-scoped field list: nothing beyond these five is stored.
			assert.deepStrictEqual(
				Object.keys(entry).sort(),
				['dismissedAt', 'hashes', 'id', 'problemText', 'ruleName'],
				'no field beyond the agreed privacy-scoped set is persisted',
			);
		});

		await test('a second dismiss adds a second entry, and the real hashes exceed Number.MAX_SAFE_INTEGER', async () => {
			const lint = (await sh({ type: 'lint', text: TEXT_B })).find((l) => l.problemText === 'beleive');
			assert.ok(lint, 'precondition: "beleive" is flagged');
			await sh({ type: 'ignoreLint', text: TEXT_B, start: lint.start, end: lint.end, ruleName: lint.ruleName });

			const entries = readEntries();
			assert.strictEqual(entries.length, 2, 'both dismissals are indexed');
			entryA = entries.find((e) => e.problemText === 'teh');
			entryB = entries.find((e) => e.problemText === 'beleive');
			assert.ok(entryA && entryB, 'both entries are identifiable by their flagged text');

			hashesBeforeRestore = dismissedLog.extractHashes(readIgnoreRaw());
			// A single user-visible Dismiss can ignore SEVERAL overlapping findings on the same span
			// (that is what the 20-pass loop is for), so the count is not two — but the side table must
			// account for every hash harper holds, which is the invariant that actually matters.
			assert.strictEqual(
				hashesBeforeRestore.length,
				entryA.hashes.length + entryB.hashes.length,
				'the two entries account for exactly the hashes harper is holding',
			);
			assert.strictEqual(
				dismissedLog.legacyCount(readIgnoreRaw(), entries),
				0,
				'nothing is orphaned: a freshly recorded dismissal is never "legacy"',
			);
			// The precondition that makes the u64 test below meaningful: if harper ever started
			// emitting small hashes this would fail loudly rather than silently testing nothing.
			const unsafe = hashesBeforeRestore.filter((h) => String(Number(h)) !== h);
			assert.ok(unsafe.length > 0, `at least one hash is past 2^53 (got ${hashesBeforeRestore.join(', ')})`);
		});

		await test('restoreDismissed makes the finding reappear on re-lint and shrinks ignoredLints', async () => {
			const res = await sh({ type: 'settings:restoreDismissed', id: entryA.id });
			assert.strictEqual(res.ok, true, 'the restore reports success');

			const againA = (await sh({ type: 'lint', text: TEXT_A })).filter((l) => l.problemText === 'teh');
			assert.ok(againA.length >= 1, 'the restored finding is flagged again');
			const stillB = (await sh({ type: 'lint', text: TEXT_B })).filter((l) => l.problemText === 'beleive');
			assert.strictEqual(stillB.length, 0, 'the OTHER dismissal is untouched and still suppressed');

			const after = dismissedLog.extractHashes(readIgnoreRaw());
			assert.strictEqual(
				after.length,
				hashesBeforeRestore.length - entryA.hashes.length,
				'ignoredLints shrank by exactly the restored entry\'s hashes',
			);
			assert.deepStrictEqual(readEntries().map((e) => e.id), [entryB.id], 'only the restored row is gone');
		});

		await test('u64 regression: an untouched hash survives a record+restore cycle BYTE-IDENTICALLY', async () => {
			const raw = readIgnoreRaw();
			// The whole point: entry B's hash was rewritten by the clear-then-reimport that the restore
			// performs, and it must come back out of that cycle as the exact same digits. A JSON.parse
			// round trip anywhere on this path would have rounded it.
			for (const hash of entryB.hashes) {
				assert.ok(raw.includes(hash), `hash ${hash} is still present verbatim in the persisted payload`);
			}
			assert.deepStrictEqual(
				dismissedLog.extractHashes(raw),
				entryB.hashes,
				'the surviving ignore state is exactly the untouched entry\'s hashes, undamaged',
			);
			// And the file is still harper's own shape, so importIgnoredLints will accept it on restart.
			assert.ok(/^\{"context_hashes":\[.*\]\}$/.test(raw.trim()), `payload keeps harper's shape: ${raw}`);
		});

		await test('settings snapshot carries the structured tree, concrete defaults and the sparse overrides', async () => {
			const snap = await sh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.ok(snap.structured && Array.isArray(snap.structured.settings), 'structured tree present');
			const groups = snap.structured.settings.filter((s) => s.Group);
			assert.ok(groups.length >= 10, `the structured config exposes group nodes (got ${groups.length})`);
			const defaultKeys = Object.keys(snap.defaults);
			assert.ok(defaultKeys.length > 500, `defaults enumerate the whole rule roster (got ${defaultKeys.length})`);
			assert.ok(
				defaultKeys.every((k) => typeof snap.defaults[k] === 'boolean'),
				'every default is a CONCRETE boolean (this, not Bool.state, is what "Default" resolves to)',
			);
			assert.strictEqual(snap.descriptionsHtml, null, 'descriptions omitted when not requested (lazy-capable)');
			assert.strictEqual(snap.settings.dialect, 'American', 'primitive settings ride along');
			assert.strictEqual(snap.settings.ignoreNonEnglish, false, 'including the new ignoreNonEnglish');
			assert.ok('dictionaryPath' in snap.settings, 'dictionaryPath is present on desktop');
			assert.ok(Array.isArray(snap.dictionaryWords), 'the effective word list rides along');
		});

		await test('rule descriptions are served on demand, one HTML entry per rule', async () => {
			const descriptions = await sh({ type: 'settings:descriptions' });
			const keys = Object.keys(descriptions);
			assert.ok(keys.length > 500, `descriptions cover the roster (got ${keys.length})`);
			assert.ok(
				keys.every((k) => typeof descriptions[k] === 'string' && descriptions[k].length > 0),
				'every description is a non-empty string',
			);
		});

		await test('legacy count: ignore hashes with no side-table entry are counted as legacy', async () => {
			// Simulate dismissals made BEFORE this feature existed: harper still holds the ignores, but
			// nothing readable describes them, so the UI can only offer a bulk clear.
			fs.writeFileSync(metaPath, '', 'utf8');
			const live = dismissedLog.extractHashes(readIgnoreRaw());
			assert.ok(live.length >= 1, 'precondition: harper still holds at least one ignore');
			const snap = await sh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.strictEqual(snap.dismissed.entries.length, 0, 'no readable entries remain');
			assert.strictEqual(snap.dismissed.legacyCount, live.length, 'every unaccounted hash counts as legacy');
		});

		await test('clearDismissed("all") wipes harper\'s ignore state and the side table together', async () => {
			const res = await sh({ type: 'settings:clearDismissed', scope: 'all' });
			assert.strictEqual(res.ok, true, 'the clear reports success');
			assert.deepStrictEqual(dismissedLog.extractHashes(readIgnoreRaw()), [], 'no ignore hashes left');
			assert.deepStrictEqual(readEntries(), [], 'no side-table rows left');
			const back = (await sh({ type: 'lint', text: TEXT_B })).filter((l) => l.problemText === 'beleive');
			assert.ok(back.length >= 1, 'the previously suppressed finding is flagged again');
		});

		await test('applyRuleOverrides round-trip: sparse write, ruleOverrides setting content, reset restores defaults', async () => {
			const before = (await sh({ type: 'lint', text: 'This is an test.' })).filter((l) => l.ruleName === 'AnA');
			assert.ok(before.length >= 1, 'precondition: AnA fires on "an test"');

			const applied = await sh({
				type: 'settings:applyRuleOverrides',
				overrides: { AnA: false, SomeRuleLeftOnDefault: null },
			});
			assert.deepStrictEqual(applied.overrides, { AnA: false }, 'null keys are dropped — the map stays sparse');
			assert.strictEqual(
				sdState.settings.ruleOverrides,
				'{"AnA":false}',
				'persisted in the same hand-editable JSON format users already have',
			);
			const after = (await sh({ type: 'lint', text: 'This is an test.' })).filter((l) => l.ruleName === 'AnA');
			assert.strictEqual(after.length, 0, 'AnA no longer fires');

			const snap = await sh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.deepStrictEqual(snap.flatConfig, { AnA: false }, 'the snapshot echoes the sparse map back');

			await sh({ type: 'settings:resetRules' });
			assert.strictEqual(sdState.settings.ruleOverrides, '', 'reset returns the setting to its pristine default');
			const reset = (await sh({ type: 'lint', text: 'This is an test.' })).filter((l) => l.ruleName === 'AnA');
			assert.ok(reset.length >= 1, 'AnA fires again once the override is reset');
		});

		await test('updateSetting writes allowlisted keys through joplin.settings and REJECTS anything else', async () => {
			await sh({ type: 'settings:updateSetting', key: 'ignoreNonEnglish', value: true });
			assert.strictEqual(sdState.settings.ignoreNonEnglish, true, 'ignoreNonEnglish written');
			await sh({ type: 'settings:updateSetting', key: 'debounceMs', value: 99999 });
			assert.strictEqual(sdState.settings.debounceMs, 10000, 'out-of-range values are clamped to the declared max');

			let rejected = false;
			try {
				await sh({ type: 'settings:updateSetting', key: 'syncBase', value: 'tampered' });
			} catch {
				rejected = true;
			}
			assert.ok(rejected, 'an internal, non-allowlisted key cannot be written from the dialog');

			let badDialect = false;
			try {
				await sh({ type: 'settings:updateSetting', key: 'dialect', value: 'Klingon' });
			} catch {
				badDialect = true;
			}
			assert.ok(badDialect, 'an unknown dialect is rejected rather than stored');

			await sh({ type: 'settings:updateSetting', key: 'ignoreNonEnglish', value: false });
			await sh({ type: 'settings:updateSetting', key: 'debounceMs', value: 500 });
		});

		await test('Indian is an accepted dialect end to end (harper 2.7.0 Dialect.Indian = 4)', async () => {
			await sh({ type: 'settings:updateSetting', key: 'dialect', value: 'Indian' });
			assert.strictEqual(sdState.settings.dialect, 'Indian', 'the Indian dialect is stored');
			// setDialect rebuilds the engine; the plugin's onChange re-applies configuration right
			// after, so a lint must still work rather than throwing or returning nothing.
			const lints = await sh({ type: 'lint', text: 'I beleive this is teh answer.' });
			assert.ok(Array.isArray(lints) && lints.length >= 1, 'linting still works under the Indian dialect');
			await sh({ type: 'settings:updateSetting', key: 'dialect', value: 'American' });
		});
	}

	// ---- integration: the MOBILE side-table path (settings-backed, zero fs) --
	{
		const mobileDismissDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-mobile-dismiss-'));
		const mdState = await run({
			dataDir: mobileDismissDir,
			installationDir: DIST_DIR,
			// Any joplin.require() on mobile is a bug — the plugin iframe has no Node.
			require: (name) => {
				throw new Error(`mobile must not require(${name})`);
			},
			versionInfo: { version: '3.7.2', platform: 'mobile' },
		});
		const mh = mdState.contentScriptMessageHandlers['harperCm'];

		await test('mobile: the dismissed side table lives in a private setting, writes NO file, and does not loop', async () => {
			assert.ok(mdState.registeredSettings.dismissedMeta, 'dismissedMeta is registered on mobile');
			assert.strictEqual(mdState.registeredSettings.dismissedMeta.public, false, 'and it is private');

			const text = 'I saw teh cat.';
			const lint = (await mh({ type: 'lint', text })).find((l) => l.problemText === 'teh');
			assert.ok(lint, 'precondition: "teh" is flagged');
			await mh({ type: 'ignoreLint', text, start: lint.start, end: lint.end, ruleName: lint.ruleName });

			const entries = dismissedLog.parseEntries(mdState.settings.dismissedMeta);
			assert.strictEqual(entries.length, 1, 'the entry landed in the settings value, not a file');
			assert.strictEqual(entries[0].problemText, 'teh', 'with the flagged span recorded');
			assert.ok(
				dismissedLog.extractHashes(mdState.settings.ignoredLints).length >= 1,
				'harper\'s own ignore payload is persisted alongside it',
			);
			assert.deepStrictEqual(fs.readdirSync(mobileDismissDir), [], 'the mobile run wrote no files at all');

			// The internal keys must be excluded from the settings onChange reconfigure, or writing the
			// side table would trigger a reconfigure that writes it again.
			const rewrites = mdState.settingWrites.filter((w) => w.key === 'dismissedMeta');
			assert.strictEqual(rewrites.length, 1, 'one dismiss => exactly one side-table write (no feedback loop)');

			const after = (await mh({ type: 'lint', text })).filter((l) => l.problemText === 'teh');
			assert.strictEqual(after.length, 0, 'and the dismissal actually suppresses the finding');
		});

		await test('mobile: restoreDismissed works off the settings-backed store too', async () => {
			const entry = dismissedLog.parseEntries(mdState.settings.dismissedMeta)[0];
			const res = await mh({ type: 'settings:restoreDismissed', id: entry.id });
			assert.strictEqual(res.ok, true, 'restore succeeds on mobile');
			assert.deepStrictEqual(
				dismissedLog.parseEntries(mdState.settings.dismissedMeta),
				[],
				'the row is gone from the settings-backed table',
			);
			const back = (await mh({ type: 'lint', text: 'I saw teh cat.' })).filter((l) => l.problemText === 'teh');
			assert.ok(back.length >= 1, 'the finding is flagged again');
			assert.deepStrictEqual(fs.readdirSync(mobileDismissDir), [], 'still zero filesystem writes');
		});
	}

	// ---- version quadruple --------------------------------------------------
	// The four version fields (package.json, src/manifest.json, and BOTH package-lock fields) must
	// stay pinned together; a stale lockfile drifted them once in the sibling project. Bump all four
	// on every release, or the harness (and thus the publish gate) fails.
	await test('version: package.json, manifest, and both package-lock fields agree', () => {
		const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...rel), 'utf8'));
		const pkg = readJSON('package.json');
		const manifest = readJSON('src', 'manifest.json');
		const lock = readJSON('package-lock.json');
		const expected = '1.3.2';
		assert.strictEqual(pkg.version, expected, 'package.json version');
		assert.strictEqual(manifest.version, expected, 'src/manifest.json version');
		assert.strictEqual(lock.version, expected, 'package-lock.json top-level version');
		assert.strictEqual(lock.packages[''].version, expected, 'package-lock.json root package entry version');
	});

	// ---- measurements (printed, not asserted) -------------------------------
	console.log('');
	console.log('  MEASUREMENTS');
	console.log(`    onStart handler time (eager path only; engine + I/O deferred): ${budgetOnStartMs} ms`);
	console.log(`    linter init (first lint: binary load + setup + prime): ${initMs} ms`);
	console.log(`    lint latency, ~${docBytes} B doc, median of 5: ${medianMs} ms  (runs: ${latencies.join(', ')})`);
	console.log('');

	if (failures) {
		console.log(`FAILED: ${failures} test(s)`);
		process.exit(1);
	} else {
		console.log('All tests passed.');
		process.exit(0);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
