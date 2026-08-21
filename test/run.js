// Harper walking-skeleton harness suite.
//
// Runner + assertion frame follow joplin-plugin-cockpit's test/run.js (a tiny homemade test()
// runner with a failures counter; process.exit(failures ? 1 : 0)). The fixtures and assertions are
// Harper's: they drive the REAL harper.js linter (LocalLinter works in Node) through the compiled
// dist/index.js bundle via the stubbed joplin global, and they pin the version quadruple.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { run } = require('./harness');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

// index.ts does not call joplin.require(); a throwing stub proves that.
const noRequire = (name) => { throw new Error(`Unexpected joplin.require(${name})`); };

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

	// installationDir points at the built dist/, where the .wasm was copied, so the plugin's
	// file:// loader finds the real binary — exactly as it will inside a real Joplin install.
	const state = await run({
		dataDir: path.join(DIST_DIR),
		installationDir: DIST_DIR,
		require: noRequire,
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

	// ---- lint round-trip (real harper.js) -----------------------------------
	const handler = state.contentScriptMessageHandlers['harperCm'];
	const sampleText = 'This is an test of the plugin. I beleive it works.';

	// Measure linter init: the FIRST lint call pays the binary load + setup cost.
	const initStart = Date.now();
	const response = await handler({ type: 'lint', text: sampleText });
	const initMs = Date.now() - initStart;

	await test('lint response is a plain-JSON array (no WASM handles leak across IPC)', () => {
		assert.ok(Array.isArray(response), 'response is an array');
		// A round-trip through JSON must be a deep-equal no-op: WASM Lint/Suggestion handles would
		// either throw or serialize to {} and fail this. Plain objects survive unchanged.
		assert.deepStrictEqual(JSON.parse(JSON.stringify(response)), response, 'response is plain JSON');
	});

	await test('lint found at least one issue with at least one suggestion', () => {
		assert.ok(response.length >= 1, `expected >=1 lint, got ${response.length}`);
		const withSuggestion = response.filter((l) => l.suggestions && l.suggestions.length >= 1);
		assert.ok(withSuggestion.length >= 1, 'at least one lint carries a suggestion');
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
	await test('version: package.json, manifest, and both package-lock fields are all 0.1.0', () => {
		const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...rel), 'utf8'));
		const pkg = readJSON('package.json');
		const manifest = readJSON('src', 'manifest.json');
		const lock = readJSON('package-lock.json');
		const expected = '0.1.0';
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
