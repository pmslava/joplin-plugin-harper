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
const { run } = require('./harness');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

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
	if (!fs.existsSync(path.join(DIST_DIR, 'harper_wasm_bg.wasm'))) {
		throw new Error('dist/harper_wasm_bg.wasm not found — the WASM copy step did not run.');
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

	// ---- config handshake ---------------------------------------------------
	const handler = state.contentScriptMessageHandlers['harperCm'];
	await test('getConfig returns {enabled, debounceMs} for the content script', async () => {
		const config = await handler({ type: 'getConfig' });
		assert.deepStrictEqual(config, { enabled: true, debounceMs: 500 });
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

	// ---- version quadruple --------------------------------------------------
	// The four version fields (package.json, src/manifest.json, and BOTH package-lock fields) must
	// stay pinned together; a stale lockfile drifted them once in the sibling project. Bump all four
	// on every release, or the harness (and thus the publish gate) fails.
	await test('version: package.json, manifest, and both package-lock fields are all 1.0.1', () => {
		const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...rel), 'utf8'));
		const pkg = readJSON('package.json');
		const manifest = readJSON('src', 'manifest.json');
		const lock = readJSON('package-lock.json');
		const expected = '1.0.1';
		assert.strictEqual(pkg.version, expected, 'package.json version');
		assert.strictEqual(manifest.version, expected, 'src/manifest.json version');
		assert.strictEqual(lock.version, expected, 'package-lock.json top-level version');
		assert.strictEqual(lock.packages[''].version, expected, 'package-lock.json root package entry version');
	});

	// ---- measurements (printed, not asserted) -------------------------------
	console.log('');
	console.log('  MEASUREMENTS');
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
