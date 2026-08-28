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
	// NOTE ON `public:` THROUGHOUT THIS RUN — this is the DEFAULT profile, so the `manageInDialog`
	// surface switch is ON and the basic settings are registered public:FALSE (hidden from Joplin's
	// native Options page; the Harper window owns them). Everything else about them — key, default,
	// type, section, enum options — is identical in both modes, which is what these assertions pin.
	// The two-mode matrix itself lives in its own block further down.
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
		assert.strictEqual(defs.dialect.isEnum, true, 'dialect isEnum');
		assert.ok(defs.dialect.options && defs.dialect.options.British, 'dialect exposes British option');
		assert.strictEqual(defs.ruleOverrides.advanced, true, 'ruleOverrides is advanced');
	});

	// ---- underlineStyle registration (v1.2.0) --------------------------------
	// Harper issue #1710 ("Prefer solid line to squiggly"). The setting is a public enum on BOTH
	// platforms (the mobile half is asserted inside the mobile run below), defaulting to the squiggle
	// so every existing install keeps the look it has.
	await test("setting 'underlineStyle' is an enum in section harper, default 'squiggly', with both options", () => {
		const def = state.registeredSettings.underlineStyle;
		assert.ok(def, 'underlineStyle is registered');
		assert.strictEqual(def.value, 'squiggly', "underlineStyle default is 'squiggly'");
		// Same SettingItemType as the other String enum (dialect) — compared by reference rather than a
		// magic number so the assertion can't drift from Joplin's enum.
		assert.strictEqual(def.type, state.registeredSettings.dialect.type, 'underlineStyle is a String setting');
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

	// ---- settings DIALOG registration (v1.4.0, Phase 2) ----------------------
	// The dialog is the plugin's only real settings surface for rules/dictionary/dismissals, and it is
	// entirely postMessage-driven. These checks pin the four things that make it work at all — the
	// command, the platform-correct entry point, the construction (assets + Close + fit-to-content),
	// and a live round-trip over the DIALOG's own message channel rather than the content script's.
	await test("command 'harper.openSettings' is registered with the Settings label and icon", () => {
		const command = state.commands.find((c) => c.name === 'harper.openSettings');
		assert.ok(command, 'harper.openSettings is registered');
		assert.strictEqual(command.label, 'Harper: Settings…', 'label matches the documented command name');
		assert.strictEqual(command.iconName, 'fas fa-spell-check', 'command carries the Harper icon');
		assert.strictEqual(typeof command.execute, 'function', 'the command is executable');
	});

	await test('desktop: the settings command is put in the Tools menu (and NOT on the note toolbar)', () => {
		const item = state.menuItems.find((m) => m.command === 'harper.openSettings');
		assert.ok(item, 'a menu item was created for harper.openSettings');
		assert.strictEqual(item.location, 'tools', 'it lives in the Tools menu');
		assert.ok(
			!state.toolbarButtons.some((b) => b.command === 'harper.openSettings'),
			'desktop does not also add the mobile note-toolbar button',
		);
	});

	await test('the settings section description points the user at the command (plain text, no markup)', () => {
		// Joplin renders a section description as LITERAL text, so a link here would show as raw markup.
		const description = state.sectionDescription;
		assert.ok(description, 'the harper section registered a description');
		assert.ok(description.includes('Harper: Settings…'), 'it names the command');
		assert.ok(!/[<>]|\]\(/.test(description), `plain text only, got: ${description}`);
	});

	// =========================================================================
	// v1.4.0 THE SURFACE SWITCH — `manageInDialog`, both modes x both platforms.
	// =========================================================================
	// One Bool decides which of the two editing surfaces is live: Joplin's native Options → Harper
	// page, or the custom "Harper: Settings…" window. The whole feature is two consequences of one
	// value read at registration time, and this block is the matrix for both of them:
	//
	//                    | basic settings on the native page | dialog entry point
	//   ------------------------------------------------------------------------
	//   ON  (default)    | public:false  (hidden)            | created
	//   OFF              | public:true   (shown)             | NOT created
	//
	// ...on desktop (Tools menu item) and on mobile (note-toolbar button) alike. The COMMAND is
	// registered in all four cells — on desktop the command palette is the fallback that keeps the
	// rule browser reachable with no menu item, and a command that vanished would strand it.
	//
	// The mechanism that makes this possible is the REGISTRATION ORDER, which the first test pins:
	// the switch has to be registered before it can be read, and read before the keys whose `public:`
	// flag depends on it. Reading an unregistered key throws "Unknown key" in real Joplin (the strict
	// harness stub mirrors that), so getting this order wrong is a startup crash, not a cosmetic slip.
	{
		/** The eight settings whose visibility the switch moves. */
		const BASIC_KEYS = [
			'enabled',
			'dialect',
			'debounceMs',
			'underlineStyle',
			'ignoreNonEnglish',
			'dictionaryNoteId',
			'dictionaryPath',
			'ruleOverrides',
		];
		/** The private bookkeeping keys, which are public:false in BOTH modes and must stay that way. */
		const INTERNAL_KEYS = ['pendingWords', 'pendingRemovals', 'ignoredLints', 'dismissedMeta', 'syncBase'];

		const bootMode = (platform, manageInDialog) =>
			run({
				dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `harper-surface-${platform}-`)),
				installationDir: DIST_DIR,
				require:
					platform === 'mobile'
						? (name) => {
								throw new Error(`[mobile] joplin.require(${name}) must never run`);
							}
						: requireStub,
				versionInfo:
					platform === 'mobile'
						? { version: '3.7.2', platform: 'mobile' }
						: { version: '3.6.14', platform: 'desktop' },
				// `undefined` means "leave it unset", which is how the DEFAULT (ON) is exercised as a
				// real user's fresh profile would exercise it — via the registered default, not a
				// pre-seeded value that would hide a wrong default.
				initialSettings: manageInDialog === undefined ? {} : { manageInDialog },
			});

		await test('registration ORDER: the switch is registered first and alone, then read, then the rest', async () => {
			const s = await bootMode('desktop', undefined);
			const calls = s.registerSettingsCalls;
			assert.strictEqual(calls.length, 2, `exactly two registerSettings passes, got ${calls.length}`);
			assert.deepStrictEqual(
				calls[0],
				['manageInDialog'],
				'the FIRST pass registers the surface switch and nothing else — it must exist to be read',
			);
			for (const key of BASIC_KEYS) {
				assert.ok(calls[1].includes(key), `"${key}" is registered in the second pass, after the read`);
			}
			assert.ok(
				!calls[1].includes('manageInDialog'),
				'the switch is not registered twice (a re-register would reset its stored value)',
			);
		});

		await test('the switch itself: public Bool in section harper, default TRUE, File storage', async () => {
			const s = await bootMode('desktop', undefined);
			const def = s.registeredSettings.manageInDialog;
			assert.ok(def, 'manageInDialog is registered');
			assert.strictEqual(def.value, true, 'it defaults to ON — the Harper window owns the settings');
			assert.strictEqual(def.type, s.registeredSettings.enabled.type, 'it is a Bool, like `enabled`');
			assert.strictEqual(def.section, 'harper', 'in section harper');
			assert.strictEqual(
				def.storage,
				s.registeredSettings.enabled.storage,
				'File storage, like the rest — so it lives in settings.json and does NOT sync between devices',
			);
			assert.strictEqual(def.label, 'Manage settings in the Harper window', 'the agreed label');
			// ALWAYS public, in both modes: it is the only way back once the basic settings are hidden.
			assert.strictEqual(def.public, true, 'public with the switch ON');
			const off = await bootMode('desktop', false);
			assert.strictEqual(
				off.registeredSettings.manageInDialog.public,
				true,
				'and public with the switch OFF — a user who turned the fields on must still find the switch',
			);
		});

		// THE APPROVED COPY, VERBATIM. These five strings were signed off word for word, so they are
		// pinned as exact literals rather than probed with regexes: a "harmless" rewording is the one
		// kind of drift a behavioural assertion would wave through. The regex checks below still run —
		// they say WHY each sentence is there, so a future deliberate rewrite fails with a reason
		// attached rather than just a diff.
		const APPROVED = {
			switchDesktop:
				"Harper's settings live in their own window — open it with Tools → Harper: Settings…. The window holds everything: the basic settings, the rule browser, the dictionary editor, and the dismissed findings. This Joplin options page can show only the basic settings — that is why this switch is on by default. Turn it off and the basic settings appear here instead, while Harper: Settings… disappears from the Tools menu. Restart Joplin to apply.",
			switchMobile:
				"Harper's settings live in their own window — open a note and choose Harper: Settings… from the toolbar menu. The window holds everything: the basic settings, the rule browser, the dictionary editor, and the dismissed findings. This Joplin configuration screen can show only the basic settings — that is why this switch is on by default. Turn it off and the basic settings appear here instead, while Harper: Settings… disappears from the toolbar menu. Restart Joplin to apply.",
			bannerOnDesktop:
				'Harper grammar checker. Settings are managed in the Harper window: Tools → Harper: Settings….',
			bannerOnMobile:
				'Harper grammar checker. Settings are managed in the Harper window: open a note and choose Harper: Settings… from the toolbar menu.',
			bannerOff: 'Harper grammar checker settings.',
		};

		await test('the approved copy is delivered VERBATIM — switch description and section banner', async () => {
			// The punctuation is the trap. This copy carries an em dash, a right arrow and an ellipsis,
			// each of which has a lookalike ASCII spelling ("-", "->", "...") that reads the same in a
			// diff while shipping different text — so the literals above hold the real characters and
			// these comparisons are exact. (The apostrophe is deliberately the ASCII one, matching the
			// approved text and the rest of this codebase's copy.)
			const dOn = await bootMode('desktop', undefined);
			const mOn = await bootMode('mobile', undefined);
			assert.strictEqual(
				dOn.registeredSettings.manageInDialog.description,
				APPROVED.switchDesktop,
				'desktop switch description matches the approved copy character for character',
			);
			assert.strictEqual(
				mOn.registeredSettings.manageInDialog.description,
				APPROVED.switchMobile,
				'mobile switch description matches the approved copy character for character',
			);
			assert.strictEqual(dOn.sectionDescription, APPROVED.bannerOnDesktop, 'desktop ON banner');
			assert.strictEqual(mOn.sectionDescription, APPROVED.bannerOnMobile, 'mobile ON banner');
			assert.strictEqual(
				(await bootMode('desktop', false)).sectionDescription,
				APPROVED.bannerOff,
				'desktop OFF banner',
			);
			assert.strictEqual(
				(await bootMode('mobile', false)).sectionDescription,
				APPROVED.bannerOff,
				'mobile OFF banner (the same line on both platforms — it routes nowhere)',
			);
		});

		await test('the switch description names a real entry point on each platform, and says restart', async () => {
			const desktop = (await bootMode('desktop', undefined)).registeredSettings.manageInDialog.description;
			const mobile = (await bootMode('mobile', undefined)).registeredSettings.manageInDialog.description;
			// The entry point it NAMES has to be the one that platform actually has — both where the
			// window is opened from, and where "Harper: Settings…" disappears from when it is off.
			assert.ok(
				/open it with Tools → Harper: Settings…/.test(desktop),
				`desktop copy opens the window from the Tools menu: ${desktop}`,
			);
			assert.ok(
				/disappears from the Tools menu/.test(desktop),
				`desktop copy says what turning it off removes: ${desktop}`,
			);
			// Mobile has NO Tools menu — promising one would describe nothing that exists on the device
			// the user is holding.
			assert.ok(!/Tools/.test(mobile), `mobile copy must not promise a Tools menu: ${mobile}`);
			assert.ok(
				/choose Harper: Settings… from the toolbar menu/.test(mobile),
				`mobile copy opens the window from the note toolbar: ${mobile}`,
			);
			assert.ok(
				/disappears from the toolbar menu/.test(mobile),
				`mobile copy says what turning it off removes: ${mobile}`,
			);
			// Each platform names the screen the way Joplin itself names it: desktop has an "options
			// page", mobile a "configuration screen". Calling both by one name would send half the
			// users looking for something their app does not have.
			assert.ok(/This Joplin options page/.test(desktop), `desktop copy: ${desktop}`);
			assert.ok(/This Joplin configuration screen/.test(mobile), `mobile copy: ${mobile}`);
			for (const [label, text] of [['desktop', desktop], ['mobile', mobile]]) {
				// The ARGUMENT for the default, not just the fact of it: the window holds all four
				// things, this screen can hold only one of them, and that is the reason.
				assert.ok(
					/The window holds everything: the basic settings, the rule browser, the dictionary editor, and the dismissed findings\./.test(
						text,
					),
					`${label} copy says what the window holds`,
				);
				assert.ok(
					/can show only the basic settings — that is why this switch is on by default/.test(text),
					`${label} copy gives the reason the switch is on by default`,
				);
				assert.ok(
					/Turn it off and the basic settings appear here instead/.test(text),
					`${label} copy says what turning it off gains`,
				);
				assert.ok(/Restart Joplin to apply/.test(text), `${label} copy says a restart is needed`);
				// Joplin renders setting descriptions as literal text — markup would show up raw.
				assert.ok(!/[<>]|\]\(/.test(text), `${label} copy is plain text, got: ${text}`);
			}
		});

		// ---- THE MATRIX: four cells, one loop --------------------------------
		for (const platform of ['desktop', 'mobile']) {
			const entryPoint = platform === 'mobile' ? 'note-toolbar button' : 'Tools menu item';
			const hasEntryPoint = (s) =>
				platform === 'mobile'
					? s.toolbarButtons.some((b) => b.command === 'harper.openSettings')
					: s.menuItems.some((m) => m.command === 'harper.openSettings');
			// The OTHER platform's entry point must never appear — mobile has no menus at all, and a
			// desktop note-toolbar button would be a second, duplicate Harper entry.
			const hasForeignEntryPoint = (s) =>
				platform === 'mobile'
					? s.menuItems.some((m) => m.command === 'harper.openSettings')
					: s.toolbarButtons.some((b) => b.command === 'harper.openSettings');
			// dictionaryPath is DESKTOP-ONLY (its fs read and FilePath UX do not exist on mobile), so
			// the mobile cells assert on the seven keys that are actually registered there.
			const keysHere = BASIC_KEYS.filter((k) => platform === 'desktop' || k !== 'dictionaryPath');

			await test(`${platform} + switch ON (default): basics are public:false, and the ${entryPoint} IS created`, async () => {
				const s = await bootMode(platform, undefined);
				for (const key of keysHere) {
					const def = s.registeredSettings[key];
					assert.ok(def, `"${key}" is still REGISTERED — hiding is not unregistering`);
					assert.strictEqual(def.public, false, `"${key}" is hidden from the native page`);
				}
				if (platform === 'mobile') {
					assert.ok(
						!s.registeredSettings.dictionaryPath,
						'dictionaryPath stays desktop-only regardless of the switch',
					);
				}
				assert.ok(hasEntryPoint(s), `the ${entryPoint} is created`);
				assert.ok(!hasForeignEntryPoint(s), `and not the other platform's entry point`);
				assert.ok(
					s.commands.some((c) => c.name === 'harper.openSettings'),
					'the command is registered',
				);
			});

			await test(`${platform} + switch OFF: basics are public:true, and NO ${entryPoint} is created`, async () => {
				const s = await bootMode(platform, false);
				for (const key of keysHere) {
					const def = s.registeredSettings[key];
					assert.ok(def, `"${key}" is registered`);
					assert.strictEqual(def.public, true, `"${key}" is shown on the native page, exactly as before`);
				}
				assert.ok(!hasEntryPoint(s), `no ${entryPoint} — the native page owns the settings this session`);
				assert.ok(!hasForeignEntryPoint(s), `and no entry point from the other platform either`);
				// THE COMMAND SURVIVES. On desktop that is the command palette keeping the rule browser,
				// the dictionary editor and the dismissed findings reachable with no menu item. On mobile
				// there is no palette, so this is only the registration — the description says plainly
				// that the window goes out of reach there until the switch is turned back on.
				assert.ok(
					s.commands.some((c) => c.name === 'harper.openSettings'),
					'the command is STILL registered — no mode may unregister the only route to the rules UI',
				);
			});

			await test(`${platform}: the switch is a pure visibility change — values and internals are untouched`, async () => {
				const on = await bootMode(platform, undefined);
				const off = await bootMode(platform, false);
				// Same keys, same defaults, same types, same section: `public` is the ONLY field that moves.
				assert.deepStrictEqual(
					Object.keys(on.registeredSettings).sort(),
					Object.keys(off.registeredSettings).sort(),
					'both modes register exactly the same key set',
				);
				for (const key of Object.keys(on.registeredSettings)) {
					const a = Object.assign({}, on.registeredSettings[key], { public: null });
					const b = Object.assign({}, off.registeredSettings[key], { public: null });
					assert.deepStrictEqual(a, b, `"${key}" differs only in its public flag between the modes`);
				}
				// The private bookkeeping keys stay private in BOTH modes — the switch must not leak
				// pendingWords or the dismissed index onto the settings page in either direction.
				for (const s of [on, off]) {
					for (const key of INTERNAL_KEYS) {
						assert.strictEqual(
							s.registeredSettings[key].public,
							false,
							`"${key}" is internal and stays public:false`,
						);
					}
				}
				// And the plugin still WORKS with the fields hidden: a hidden setting is readable,
				// writable, and drives the engine exactly as a public one does.
				const h = on.contentScriptMessageHandlers['harperCm'];
				const config = await h({ type: 'getConfig' });
				assert.strictEqual(config.enabled, true, 'a public:false `enabled` still reads back');
				await on.setSetting('debounceMs', 900);
				assert.strictEqual(
					(await h({ type: 'getConfig' })).debounceMs,
					900,
					'and a public:false `debounceMs` still round-trips through a write',
				);
			});

			await test(`${platform}: the section description matches the mode that is actually active`, async () => {
				const on = (await bootMode(platform, undefined)).sectionDescription;
				const off = (await bootMode(platform, false)).sectionDescription;
				for (const [mode, text] of [['ON', on], ['OFF', off]]) {
					assert.ok(text, `${mode}: the harper section registered a description`);
					assert.ok(!/[<>]|\]\(/.test(text), `${mode}: plain text only, got: ${text}`);
					// One line, always: the switch's own description sits directly below and makes the
					// full argument, so a second paragraph here would be the same text twice.
					assert.ok(text.length < 160, `${mode}: the banner stays to one line (${text.length} chars)`);
				}
				assert.notStrictEqual(on, off, 'the two modes do not describe the page the same way');

				// ON — the page is otherwise EMPTY, so the banner's whole job is to route: it names the
				// window and spells out the real path to it, per platform.
				assert.ok(
					/Settings are managed in the Harper window/.test(on),
					`ON: the banner says where the settings went, got: ${on}`,
				);
				assert.ok(on.includes('Harper: Settings…'), 'ON: and names the command that opens it');
				if (platform === 'mobile') {
					assert.ok(/toolbar menu/.test(on), `ON mobile: the banner gives the toolbar path, got: ${on}`);
					assert.ok(!/Tools/.test(on), `ON mobile: no Tools menu exists to point at, got: ${on}`);
				} else {
					assert.ok(/Tools → Harper: Settings…/.test(on), `ON desktop: the banner gives the menu path, got: ${on}`);
				}

				// OFF — the fields are on this page, so the banner has nothing left to route anyone to
				// and says only what the section is. It deliberately does NOT name the command: with the
				// entry point gone, the window lives in the command palette on desktop and is out of
				// reach on mobile until the switch goes back on, and the SWITCH's description (right
				// below) is where that is explained.
				assert.strictEqual(off, 'Harper grammar checker settings.', 'OFF: the plain section line');
			});
		}

		await test('flipping the switch changes nothing at runtime — no reconfigure, no relint, no writes', async () => {
			// Registration is a startup-time act and Joplin has no API to undo it, so the setting takes
			// effect on the next start (its description says so). Reacting to the change would run a full
			// reconfigure — loadSettings, an engine reconcile, a relint — to arrive at the identical
			// state, which is churn at best and a needless dictionary pass at worst.
			const s = await bootMode('desktop', undefined);
			const h = s.contentScriptMessageHandlers['harperCm'];
			await h({ type: 'getConfig' });
			const pokesBefore = s.commandExecutions.length;
			const putsBefore = s.notePuts.length;
			const writesBefore = s.settingWrites.length;

			await s.setSetting('manageInDialog', false);

			assert.strictEqual(
				s.commandExecutions.length,
				pokesBefore,
				'no editor poke: nothing about the running session changed',
			);
			assert.strictEqual(s.notePuts.length, putsBefore, 'and no dictionary note write');
			assert.strictEqual(
				s.settingWrites.length,
				writesBefore + 1,
				'the only write is the switch itself — no reconcile bookkeeping followed it',
			);
			// A batch that ALSO carries a real key must still reconfigure: the filter drops one key, it
			// does not disarm the handler.
			const before = s.commandExecutions.length;
			await s.setSetting('dialect', 'British');
			assert.ok(
				s.commandExecutions.length > before,
				'a real settings change still pokes the editor — the filter is per-key, not a kill switch',
			);
		});

		await test('the switch is NOT writable from the settings dialog (it is a native-page concern)', () => {
			// Surfacing it inside the dialog would be circular — changing where the native page shows
			// its fields, from the window that exists because they are not shown there. The allowlist is
			// derived from the validator table, so this is the one place that has to stay honest.
			const { UPDATABLE_SETTING_KEYS } = loadTsModule('src/settingsService.ts', (id) =>
				id === './dismissedLog' ? loadTsModule('src/dismissedLog.ts') : require(id),
			);
			assert.ok(
				Array.isArray(UPDATABLE_SETTING_KEYS) && UPDATABLE_SETTING_KEYS.length > 0,
				'the allowlist loaded',
			);
			assert.ok(
				!UPDATABLE_SETTING_KEYS.includes('manageInDialog'),
				`updateSetting's allowlist must not carry the switch, got: ${JSON.stringify(UPDATABLE_SETTING_KEYS)}`,
			);
			// ...while the eight it SHOULD carry are still there, so this cannot pass by the allowlist
			// having collapsed to nothing.
			for (const key of ['enabled', 'dialect', 'debounceMs', 'underlineStyle', 'ruleOverrides']) {
				assert.ok(UPDATABLE_SETTING_KEYS.includes(key), `"${key}" is still writable from the dialog`);
			}
		});
	}

	await test('opening the dialog builds it once: CSS + JS assets, a single Close button, fit-to-content off', async () => {
		const command = state.commands.find((c) => c.name === 'harper.openSettings');
		const dialogsBefore = state.dialogs.length;
		await command.execute();

		assert.strictEqual(state.dialogs.length, dialogsBefore + 1, 'exactly one dialog was created');
		const handle = `dialog-${state.dialogs[state.dialogs.length - 1]}`;
		const scripts = state.dialogScripts.filter((s) => s.handle === handle).map((s) => s.script);
		assert.ok(scripts.includes('./settingsDialog.js'), `the webview script is loaded, got ${JSON.stringify(scripts)}`);
		assert.ok(scripts.includes('./settingsDialog.css'), `the webview stylesheet is loaded, got ${JSON.stringify(scripts)}`);
		// setFitToContent(false) is what gives the dialog a real 90vw x 90vh viewport. Without it the
		// dialog shrinks to its (empty) initial HTML and the whole browser is invisible.
		assert.strictEqual(state.dialogFitToContent[handle], false, 'fit-to-content is explicitly turned OFF');
		assert.deepStrictEqual(
			state.dialogButtons[handle],
			[{ id: 'ok', title: 'Close' }],
			'exactly one button, labelled Close (there is no form and no formData round-trip)',
		);
		// The shell is deliberately an EMPTY root: setHtml does not re-run scripts, so everything is
		// rendered client-side from the snapshot.
		assert.ok(/id="harper-settings"/.test(state.dialogHtml[handle] || ''), 'the shell exposes the render root');

		// REOPENING must not build a second dialog, and must nudge a possibly-still-mounted webview to
		// re-fetch rather than show the state from the previous open.
		const postedBefore = state.viewPostedMessages.length;
		await command.execute();
		assert.strictEqual(state.dialogs.length, dialogsBefore + 1, 'a reopen reuses the same dialog');
		const posted = state.viewPostedMessages.slice(postedBefore);
		assert.ok(
			posted.some((p) => p.handle === handle && p.message && p.message.type === 'settings:refresh'),
			`the reopen posted a refresh nudge, saw ${JSON.stringify(posted)}`,
		);
	});

	await test('the dialog channel answers settings:* over panels.onMessage (registered on a DIALOG handle)', async () => {
		// joplin.views.dialogs has NO onMessage; panels.onMessage accepts a dialog handle because both
		// are the same WebviewController underneath. If that ever stops being true, this test is where
		// it shows up rather than in a silently dead settings screen.
		const handle = `dialog-${state.dialogs[state.dialogs.length - 1]}`;
		const dialogHandler = state.viewMessageHandlers[handle];
		assert.strictEqual(typeof dialogHandler, 'function', 'a message handler is bound to the dialog handle');

		const snapshot = await dialogHandler({ type: 'settings:snapshot', includeDescriptions: false });
		assert.ok(snapshot && snapshot.settings, 'the dialog gets a settings snapshot');
		assert.ok(snapshot.defaults && Object.keys(snapshot.defaults).length > 500, 'defaults cover the whole rule roster');
		assert.strictEqual(snapshot.descriptionsHtml, null, 'includeDescriptions:false keeps the first paint small');
		assert.ok(snapshot.structured && Array.isArray(snapshot.structured.settings), 'the grouping tree came through');

		// A REJECTED write must arrive as a readable value, not as a promise that never settles: the
		// webview has no other way to tell the user why nothing happened.
		const refused = await dialogHandler({ type: 'settings:updateSetting', key: 'notARealKey', value: 1 });
		assert.ok(refused && typeof refused.__error === 'string', `a rejected write returns {__error}, got ${JSON.stringify(refused)}`);
		assert.ok(/not updatable/.test(refused.__error), `the reason is carried through: ${refused.__error}`);
	});

	// The webview is plain JS copied verbatim into dist/, so it cannot import the service's helper and
	// keeps its own copy. This is the guard against the two drifting: same input, same output, or the
	// rule browser starts labelling rules differently from everything else in the plugin.
	await test('settingsDialog.js ruleDisplayLabel matches the settingsService implementation exactly', async () => {
		// settingsService.ts imports './dismissedLog' for real, so hand it a loaded copy rather than
		// letting require() try to resolve a .ts path relative to test/.
		const { ruleDisplayLabel } = loadTsModule('src/settingsService.ts', (id) =>
			id === './dismissedLog' ? loadTsModule('src/dismissedLog.ts') : require(id),
		);
		const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settingsDialog.js'), 'utf8');
		const match = source.match(/function ruleDisplayLabel\(name\)\s*\{[\s\S]*?\n\t\}/);
		assert.ok(match, 'found ruleDisplayLabel in src/settingsDialog.js');
		// eslint-disable-next-line no-new-func
		const webviewLabel = new Function(`${match[0]}\nreturn ruleDisplayLabel;`)();

		// Hand-picked edge cases (capital runs, digits, empties)...
		const corpus = [
			'AmazonNames', 'HTMLTags', 'Covid19', 'SpelledNumbers', 'ModalOf', 'A', '', 'lowercase',
			'Iso8601Dates', 'OxfordComma', 'UNESCOWorldHeritage', 'Wordpress2Word', 'X9Y',
		];
		// ...plus every REAL rule name harper ships, so the guard is not limited to cases we imagined.
		const handle = `dialog-${state.dialogs[state.dialogs.length - 1]}`;
		const snapshot = await state.viewMessageHandlers[handle]({
			type: 'settings:snapshot',
			includeDescriptions: false,
		});
		const names = corpus.concat(Object.keys(snapshot.defaults || {}));
		assert.ok(names.length > 500, `checking the whole roster, got ${names.length} names`);
		for (const name of names) {
			assert.strictEqual(
				webviewLabel(name),
				ruleDisplayLabel(name),
				`ruleDisplayLabel drifted for "${name}"`,
			);
		}
	});

	// ---- the dialog's pure rendering core -----------------------------------
	// buildGroups() and the tri-state derivation decide what the whole rules browser shows, and they
	// live in a webview IIFE that cannot be imported. Rather than leave them covered only by e2e (which
	// can exercise the ONE shape harper 2.7.0 happens to emit), the functions are lifted out by source
	// and driven against the shapes harper's own types permit but its current release never produces:
	// nested groups, OneOfMany, and rules missing from the tree.
	// `args` are passed straight through to the generated function, so a preamble can reach them as
	// arguments[0], arguments[1], ... — how a test injects its own `document` / `send` / promise gate
	// into the lifted code without the source knowing anything about tests.
	// `optional` names are lifted when present and silently skipped when not. That is what lets a
	// regression test for a fix that INTRODUCED a helper still run against the pre-fix source and fail
	// on its own assertion — the thing it is meant to prove — rather than on "function not found".
	function extractDialogFunctions(names, preamble, extraExports, args, optional) {
		const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settingsDialog.js'), 'utf8');
		const parts = [];
		// Top-level functions in the IIFE are indented one tab, so their closing brace is the first
		// "\n\t}" — nested helpers close at "\n\t\t}" and cannot terminate the match early.
		const lift = (name) => {
			const match = source.match(new RegExp(`\\n\\tfunction ${name}\\([\\s\\S]*?\\n\\t\\}`));
			if (!match) return false;
			parts.push(match[0]);
			return true;
		};
		for (const name of names) assert.ok(lift(name), `found ${name}() in src/settingsDialog.js`);
		const alsoFound = (optional || []).filter(lift);
		const exported = names.concat(alsoFound, extraExports || []);
		// eslint-disable-next-line no-new-func
		const build = new Function(
			`${preamble || ''}\n${parts.join('\n')}\nreturn { ${exported.join(', ')} };`,
		);
		return build(...(args || []));
	}

	await test('buildGroups: flat harper shape -> one display group per Group node, rules in tree order', () => {
		const { buildGroups } = extractDialogFunctions(
			['buildGroups'],
			"var ADDITIONAL_GROUP_ID = '__additional__';",
		);
		const structured = {
			settings: [
				{
					Group: {
						label: 'Proper Nouns',
						description: 'Names that keep their capitalisation.',
						child: { settings: [{ Bool: { name: 'Bravo' } }, { Bool: { name: 'Alpha' } }] },
					},
				},
				{ Group: { label: 'Initialisms', description: '', child: { settings: [{ Bool: { name: 'Charlie' } }] } } },
			],
		};
		const groups = buildGroups(structured, { Alpha: true, Bravo: true, Charlie: false }, {});
		assert.strictEqual(groups.length, 2, 'one group per Group node, no extras bucket');
		assert.strictEqual(groups[0].label, 'Proper Nouns');
		assert.strictEqual(groups[0].description, 'Names that keep their capitalisation.', 'the Group description is attached');
		// harper's own order is preserved — NOT sorted. The tree is the presentation contract.
		assert.deepStrictEqual(groups[0].rules, ['Bravo', 'Alpha'], 'rules keep tree order');
		assert.deepStrictEqual(groups[1].rules, ['Charlie']);
	});

	await test('buildGroups: a nested Group becomes its own breadcrumb group, listed AFTER its parent', () => {
		const { buildGroups } = extractDialogFunctions(
			['buildGroups'],
			"var ADDITIONAL_GROUP_ID = '__additional__';",
		);
		// harper 2.7.0 never nests, but Group.child is typed as a full StructuredLintConfig, so a future
		// release could. The parent's own rules must come first: listing "Parent > Child" above "Parent"
		// reads as though the child owned the parent.
		const structured = {
			settings: [
				{
					Group: {
						label: 'Parent',
						description: 'outer',
						child: {
							settings: [
								{ Bool: { name: 'OwnRule' } },
								{ Group: { label: 'Child', description: 'inner', child: { settings: [{ Bool: { name: 'NestedRule' } }] } } },
							],
						},
					},
				},
			],
		};
		const groups = buildGroups(structured, { OwnRule: true, NestedRule: true }, {});
		assert.strictEqual(groups.length, 2);
		assert.strictEqual(groups[0].label, 'Parent', 'the parent is listed first');
		assert.deepStrictEqual(groups[0].rules, ['OwnRule']);
		assert.strictEqual(groups[0].description, 'outer');
		assert.strictEqual(groups[1].label, 'Parent > Child', 'the nested group gets a breadcrumb label');
		assert.deepStrictEqual(groups[1].rules, ['NestedRule']);
		assert.strictEqual(groups[1].description, 'inner', 'descriptions pair by id, not by position');
	});

	await test('buildGroups: OneOfMany members become ordinary rows, and top-level Bools get their own bucket', () => {
		const { buildGroups } = extractDialogFunctions(
			['buildGroups'],
			"var ADDITIONAL_GROUP_ID = '__additional__';",
		);
		const structured = {
			settings: [
				{ Bool: { name: 'Loose' } },
				{ OneOfMany: { names: ['PickA', 'PickB'], name: 'PickA' } },
			],
		};
		const groups = buildGroups(structured, { Loose: true, PickA: true, PickB: false }, {});
		assert.strictEqual(groups.length, 1, 'ungrouped rules collapse into a single bucket');
		assert.strictEqual(groups[0].label, 'Other Rules');
		// Rendering a OneOfMany as individual rows loses its mutual exclusion, but the alternative is
		// dropping the node — which would hide rules with nothing on screen to say so.
		assert.deepStrictEqual(groups[0].rules, ['Loose', 'PickA', 'PickB']);
	});

	await test('buildGroups: rules the tree omits land in "Additional Rules", prototype-named ones included', () => {
		const { buildGroups } = extractDialogFunctions(
			['buildGroups'],
			"var ADDITIONAL_GROUP_ID = '__additional__';",
		);
		const structured = {
			settings: [{ Group: { label: 'Known', description: '', child: { settings: [{ Bool: { name: 'InTree' } }] } } }],
		};
		// `constructor` is the trap: a plain-object `seen` map answers truthily for it without anything
		// ever being stored, which would silently drop the rule from the UI while it stayed in force.
		const defaults = { InTree: true, Orphan: true, constructor: false, toString: true };
		// A hand-edited ruleOverrides entry for a rule in NEITHER the tree nor the defaults must still
		// surface — it is active, so it has to be visible and editable.
		const groups = buildGroups(structured, defaults, { HandEdited: false });
		const extras = groups.find((g) => g.label === 'Additional Rules');
		assert.ok(extras, 'an Additional Rules bucket was emitted');
		assert.deepStrictEqual(
			extras.rules.slice().sort(),
			['HandEdited', 'Orphan', 'constructor', 'toString'].sort(),
			'every rule missing from the tree is listed exactly once',
		);
		assert.ok(!extras.rules.includes('InTree'), 'a rule already in the tree is NOT duplicated into extras');
	});

	await test('tri-state derivation: absence is Default, and a group reports on/off/default/mixed', () => {
		const lifted = extractDialogFunctions(
			['ruleState', 'groupState'],
			'var state = { overrides: Object.create(null) };',
			['state'],
		);
		const { ruleState, groupState, state: fake } = lifted;
		const group = { rules: ['A', 'B'] };

		// ABSENCE — not null — is what "Default" means. This is the whole tri-state contract.
		assert.strictEqual(ruleState('A'), 'default', 'a missing key is Default');
		assert.strictEqual(groupState(group), 'default', 'all-absent => Default');

		fake.overrides.A = true;
		assert.strictEqual(ruleState('A'), 'on');
		assert.strictEqual(groupState(group), 'mixed', 'one set, one absent => mixed');

		fake.overrides.B = true;
		assert.strictEqual(groupState(group), 'on', 'all-true => On');

		fake.overrides.A = false;
		fake.overrides.B = false;
		assert.strictEqual(ruleState('A'), 'off');
		assert.strictEqual(groupState(group), 'off', 'all-false => Off');

		fake.overrides.B = true;
		assert.strictEqual(groupState(group), 'mixed', 'disagreeing children => mixed');
	});

	// ---- the dialog's async writers -----------------------------------------
	// Three of the dialog's bugs were about WHERE state lives across an await: a confirm flag in the
	// module state that outlived the button it armed, a save that wrote its reply into nodes a tab
	// switch had detached, and rule payloads frozen before the reply that superseded them. None of
	// that is reachable through buildGroups-style pure lifting, and all of it is a few hundred
	// milliseconds of real user behaviour — so the render functions are lifted the same way and run
	// against a tiny DOM stand-in. Enough of a DOM to be honest about node identity and event
	// dispatch; deliberately no more.
	function makeFakeDom() {
		function createElement(tag) {
			return {
				tagName: String(tag).toUpperCase(),
				className: '',
				textContent: '',
				value: '',
				id: '',
				type: '',
				title: '',
				disabled: false,
				spellcheck: true,
				children: [],
				parentNode: null,
				attributes: {},
				listeners: {},
				get firstChild() {
					return this.children[0] || null;
				},
				appendChild(child) {
					child.parentNode = this;
					this.children.push(child);
					return child;
				},
				removeChild(child) {
					this.children = this.children.filter((c) => c !== child);
					child.parentNode = null;
					return child;
				},
				insertBefore(child, before) {
					const at = this.children.indexOf(before);
					this.children.splice(at < 0 ? 0 : at, 0, child);
					child.parentNode = this;
					return child;
				},
				setAttribute(name, value) {
					this.attributes[name] = String(value);
				},
				getAttribute(name) {
					return Object.prototype.hasOwnProperty.call(this.attributes, name)
						? this.attributes[name]
						: null;
				},
				addEventListener(type, fn) {
					(this.listeners[type] = this.listeners[type] || []).push(fn);
				},
				querySelector() {
					return null;
				},
				/** Dispatch to this node's own listeners — no bubbling; nothing here relies on it. */
				fire(type, event) {
					for (const fn of this.listeners[type] || []) fn(event || {});
				},
			};
		}
		function walk(node, visit) {
			if (!node) return null;
			if (visit(node)) return node;
			for (const child of node.children) {
				const hit = walk(child, visit);
				if (hit) return hit;
			}
			return null;
		}
		const document = {
			root: null, // the test sets this to whatever it is rendering into
			createElement,
			getElementById(id) {
				return walk(document.root, (n) => n.id === id);
			},
			/** Test convenience: every node carrying a class, for counting rendered rows. */
			byClass(className) {
				const out = [];
				walk(document.root, (n) => {
					if (String(n.className).split(' ').includes(className)) out.push(n);
					return false;
				});
				return out;
			},
		};
		return document;
	}

	/** Resolve every already-queued microtask/turn, so a lifted async handler can run to its next await. */
	const settle = async (turns = 6) => {
		for (let i = 0; i < turns; i++) await Promise.resolve();
	};

	await test('"Clear all" arming lives on the BUTTON, so a tab switch cannot leave it armed and invisible', async () => {
		const document = makeFakeDom();
		const sent = [];
		const lifted = extractDialogFunctions(
			['el', 'clear', 'formatDate', 'setDismissedStatus', 'renderDismissedList', 'renderDismissed'],
			`var document = arguments[0];
			 var sent = arguments[1];
			 var state = { dismissed: { entries: [], legacyCount: 0 } };
			 function send(message) { sent.push(message); return Promise.resolve({ ok: true, dismissals: 1, legacy: 0 }); }`,
			['state'],
			[document, sent],
			['describeCleared'],
		);
		lifted.state.dismissed = {
			entries: [
				{ id: '7', hashes: ['7'], ruleName: 'ModalOf', problemText: 'should of', dismissedAt: '2026-01-01T10:00:00.000Z' },
			],
			legacyCount: 0,
		};

		const root = document.createElement('div');
		document.root = root;
		lifted.renderDismissed(root);

		// One click ARMS — it must not clear anything.
		const armed = document.getElementById('hs-clear-all');
		armed.fire('click');
		assert.strictEqual(armed.textContent, 'Really clear all?', 'the first click asks for confirmation');
		assert.deepStrictEqual(sent, [], 'and sends nothing');

		// The user changes their mind and leaves the tab, which is the ONLY way to back out (clicking
		// the armed button again confirms). renderTabBody discards the section and rebuilds it.
		lifted.clear(root);
		lifted.renderDismissed(root);

		const rebuilt = document.getElementById('hs-clear-all');
		assert.notStrictEqual(rebuilt, armed, 'the section really was rebuilt from scratch');
		assert.strictEqual(rebuilt.textContent, 'Clear all', 'and the fresh button looks unarmed');

		// ...so it must BE unarmed. With the flag in module state this single click fell straight through
		// to clearDismissed(scope:'all') — harper's whole ignore set and the entire side table
		// destroyed, irreversibly, with no confirmation ever shown.
		rebuilt.fire('click');
		assert.deepStrictEqual(sent, [], 'a click on a button that reads "Clear all" never clears');
		assert.strictEqual(rebuilt.textContent, 'Really clear all?', 'it arms, exactly as the first one did');

		// And confirming still works.
		rebuilt.fire('click');
		assert.deepStrictEqual(
			sent,
			[{ type: 'settings:clearDismissed', scope: 'all' }],
			'the second click on the armed button does clear',
		);
		await settle();
		assert.strictEqual(
			document.getElementById('hs-dismissed-status').textContent,
			'Cleared 1 dismissal.',
			'and reports the count the service returned, in dismissal units',
		);
	});

	/** Type into a lifted textarea the way a user does: set the value AND fire `input`. */
	function type(area, value) {
		area.value = value;
		area.fire('input');
	}

	// Seeds the lifted dialog's dictionary state. Uses seedDictionary when it exists (INV-C), and
	// falls back to writing the fields by hand so the same test also runs against the pre-fix source.
	function seed(lifted, words) {
		if (lifted.seedDictionary) {
			lifted.seedDictionary(words);
			return;
		}
		lifted.state.dictionaryWords = words.slice();
		lifted.state.dictionaryBaseline = words.slice();
		lifted.state.dictionaryText = words.join('\n');
	}

	await test('a dictionary save lands on the CURRENT nodes, not the ones the save started on', async () => {
		const document = makeFakeDom();
		const sent = [];
		let resolveSave = null;
		const lifted = extractDialogFunctions(
			['el', 'clear', 'renderDictionary'],
			`var document = arguments[0];
			 var sent = arguments[1];
			 var hold = arguments[2];
			 var state = { dictionaryWords: [], dictionaryBaseline: [], dictionaryText: '' };
			 function send(message) { sent.push(message); return hold(); }`,
			['state'],
			[document, sent, () => new Promise((resolve) => { resolveSave = resolve; })],
			['setDictionaryStatus', 'paintDictionary', 'seedDictionary'],
		);
		seed(lifted, ['alpha']);

		const root = document.createElement('div');
		document.root = root;
		lifted.renderDictionary(root);

		const firstArea = document.getElementById('hs-dictionary');
		type(firstArea, 'alpha\nbeta');
		document.getElementById('hs-save-dictionary').fire('click');

		// The save posts the BASELINE it was rendered from, so the service can tell a deletion from a
		// word the editor never saw.
		assert.deepStrictEqual(
			sent,
			[{ type: 'settings:saveDictionary', words: ['alpha', 'beta'], baseline: ['alpha'] }],
			'the posted list and the list the textarea was seeded with both go up',
		);

		// The round trip is a note read, an L3-gated note write and a file rewrite — seconds, not
		// milliseconds — and nothing stops an impatient user switching tabs inside it.
		lifted.clear(root);
		lifted.renderDictionary(root);
		const currentArea = document.getElementById('hs-dictionary');
		assert.notStrictEqual(currentArea, firstArea, 'the re-entered tab built a new textarea');

		resolveSave({ ok: true, adds: ['beta'], removes: [], words: ['alpha', 'beta'] });
		await settle();

		// Writing into the detached nodes left the re-entered tab showing the PRE-save list, a wrong
		// count and a blank status — so the word looked like it had vanished, and saving again from
		// that stale textarea deleted it for real.
		assert.strictEqual(currentArea.value, 'alpha\nbeta', 'the visible textarea shows the saved list');
		assert.strictEqual(document.getElementById('hs-dictionary-count').textContent, '2 words');
		assert.strictEqual(
			document.getElementById('hs-dictionary-status').textContent,
			'Saved. 1 added, 0 removed.',
			'and the visible status says what happened',
		);
		assert.strictEqual(
			document.getElementById('hs-save-dictionary').disabled,
			false,
			'the visible Save button is usable again',
		);
		assert.deepStrictEqual(
			lifted.state.dictionaryWords,
			['alpha', 'beta'],
			'the next baseline is the service\'s reconciled truth, not an echo of what was posted',
		);
	});

	/** The rules-write machinery, with `send` under the test's control. No DOM needed. */
	function liftRuleWrites() {
		const sent = [];
		const resolvers = [];
		const lifted = extractDialogFunctions(
			[
				'setRuleState',
				'errorText',
				'queueRuleWrite',
				'pushOverrides',
				'describeOverrides',
				'setRulesStatus',
			],
			`var sent = arguments[0];
			 var resolvers = arguments[1];
			 var state = { overrides: {} };
			 var applyChain = Promise.resolve();
			 var applyPending = 0;
			 var queuedEdits = [];
			 var editSeq = 0;
			 var renders = 0;
			 var document = { getElementById: function () { return null; } };
			 function send(message) {
				sent.push(message);
				return new Promise(function (resolve, reject) { resolvers.push({ resolve: resolve, reject: reject }); });
			 }
			 function renderRules() { renders++; }`,
			['state'],
			[sent, resolvers],
			['copyOverrides', 'withQueuedEdits', 'retireEditsThrough'],
		);
		return { ...lifted, sent, resolvers };
	}

	await test('rule writes: a toggle made during a slow bulk action does not undo the bulk action', async () => {
		const rules = liftRuleWrites();

		// 1) "Disable All Rules" — one message, and a slow one: 823 keys stringified, a ~20 KB
		//    setSetting, an 823-key WASM setLintConfig and a poke.
		rules.queueRuleWrite(() => ({ type: 'settings:disableAllRules' }), 'Disabling…');
		await settle();
		assert.deepStrictEqual(rules.sent, [{ type: 'settings:disableAllRules' }], 'the bulk write went out');

		// 2) The user sets one rule while it is still in flight. The list still reads "Default" for
		//    everything (nothing repaints until the bulk reply lands), so this is a natural thing to do.
		rules.setRuleState('Cee', 'on');
		rules.pushOverrides();

		// 3) The bulk write lands with the authoritative all-false roster.
		rules.resolvers[0].resolve({ ok: true, overrides: { Aye: false, Bee: false, Cee: false } });
		await settle();

		// 4) The queued write now goes out. Built from a snapshot taken at CLICK time it carried
		//    {Cee:true} alone — and since the service REPLACES the stored map wholesale, that silently
		//    put the other 822 rules back on. It must carry the post-bulk map with the toggle applied.
		assert.strictEqual(rules.sent.length, 2, 'the queued write followed the bulk one');
		assert.deepStrictEqual(
			rules.sent[1],
			{ type: 'settings:applyRuleOverrides', overrides: { Aye: false, Bee: false, Cee: true } },
			'the bulk action survives, with the user\'s later toggle on top of it',
		);
		assert.deepStrictEqual(
			rules.state.overrides,
			{ Aye: false, Bee: false, Cee: true },
			'and the UI shows exactly that',
		);
	});

	await test('rule writes: a toggle made while an earlier toggle is in flight is not dropped', async () => {
		const rules = liftRuleWrites();

		// Toggle A, then toggle B before A's reply lands — a burst faster than one round trip.
		rules.setRuleState('Aye', 'off');
		rules.pushOverrides();
		await settle();
		rules.setRuleState('Bee', 'off');
		rules.pushOverrides();

		// A's reply carries the authoritative map, which cannot know about B.
		rules.resolvers[0].resolve({ ok: true, overrides: { Aye: false } });
		await settle();

		// Adopting it wholesale dropped B from the model AND from the UI, so the next payload no longer
		// carried it and it never reached the setting at all.
		assert.deepStrictEqual(rules.state.overrides, { Aye: false, Bee: false }, 'B survives A\'s reply');
		assert.deepStrictEqual(
			rules.sent[1],
			{ type: 'settings:applyRuleOverrides', overrides: { Aye: false, Bee: false } },
			'and B\'s own write carries both',
		);

		// A third toggle after A's reply has landed keeps everything.
		rules.setRuleState('Cee', 'on');
		rules.pushOverrides();
		rules.resolvers[1].resolve({ ok: true, overrides: { Aye: false, Bee: false } });
		await settle();
		assert.deepStrictEqual(
			rules.sent[2],
			{ type: 'settings:applyRuleOverrides', overrides: { Aye: false, Bee: false, Cee: true } },
			'nothing is lost across a burst of writes',
		);
		rules.resolvers[2].resolve({ ok: true, overrides: { Aye: false, Bee: false, Cee: true } });
		await settle();
		assert.deepStrictEqual(rules.state.overrides, { Aye: false, Bee: false, Cee: true });
	});

	await test('rule writes: a bulk action queued behind a slow write keeps the toggles made after it', async () => {
		const rules = liftRuleWrites();

		// 1) An ordinary toggle goes out first and is slow. This is the only difference from the test
		//    above, and it is what puts the bulk action in the QUEUE rather than on the wire.
		rules.setRuleState('Aye', 'off');
		rules.pushOverrides();
		await settle();
		assert.strictEqual(rules.sent.length, 1, 'the toggle is in flight');

		// 2) The user clicks "Disable All Rules". It cannot dispatch yet — the chain is busy.
		rules.queueRuleWrite(() => ({ type: 'settings:disableAllRules' }), 'Disabling…', true);
		await settle();
		assert.strictEqual(rules.sent.length, 1, 'the bulk write is queued, not sent');

		// 3) While it waits its turn — a full round trip, behind a status line that just reads
		//    "Disabling…" — the user turns one rule back On.
		rules.setRuleState('Cee', 'on');
		rules.pushOverrides();

		// 4) The first toggle lands, then the bulk write finally goes out and replies.
		rules.resolvers[0].resolve({ ok: true, overrides: { Aye: false } });
		await settle();
		rules.resolvers[1].resolve({ ok: true, overrides: { Aye: false, Bee: false, Cee: false } });
		await settle();

		// Retiring by SEND-time position discarded Cee here: the bulk write had waited a whole round
		// trip, so the edit made during that wait looked like one it had carried. The user's explicit
		// re-enable vanished from the model and from every later payload, and the row flipped back.
		assert.strictEqual(
			rules.state.overrides.Cee,
			true,
			'a toggle made after the bulk was CLICKED survives it',
		);
		assert.strictEqual(rules.state.overrides.Bee, false, 'and the bulk action itself still applied');
		assert.deepStrictEqual(
			rules.sent[2],
			{ type: 'settings:applyRuleOverrides', overrides: { Aye: false, Bee: false, Cee: true } },
			'the toggle\'s own write carries the bulk roster with the toggle on top',
		);
	});

	await test('rule writes: a bulk action still supersedes the edits made BEFORE it was clicked', async () => {
		const rules = liftRuleWrites();

		// The other direction of the same linearization: everything queued before the click is the
		// user asking for a clean slate, and the bulk action is entitled to overwrite it.
		rules.setRuleState('Aye', 'off');
		rules.pushOverrides();
		await settle();
		rules.queueRuleWrite(() => ({ type: 'settings:resetRules' }), 'Resetting…', true);
		rules.resolvers[0].resolve({ ok: true, overrides: { Aye: false } });
		await settle();
		rules.resolvers[1].resolve({ ok: true, overrides: {} });
		await settle();

		assert.deepStrictEqual(rules.state.overrides, {}, 'the reset wins over the toggle that preceded it');
	});

	await test('a dictionary save keeps words typed while it was in flight', async () => {
		const document = makeFakeDom();
		const sent = [];
		let resolveSave = null;
		const lifted = extractDialogFunctions(
			['el', 'clear', 'renderDictionary'],
			`var document = arguments[0];
			 var sent = arguments[1];
			 var hold = arguments[2];
			 var state = { dictionaryWords: [], dictionaryBaseline: [], dictionaryText: '' };
			 function send(message) { sent.push(message); return hold(); }`,
			['state'],
			[document, sent, () => new Promise((resolve) => { resolveSave = resolve; })],
			['setDictionaryStatus', 'paintDictionary', 'seedDictionary'],
		);
		seed(lifted, ['alpha']);

		const root = document.createElement('div');
		document.root = root;
		lifted.renderDictionary(root);
		type(document.getElementById('hs-dictionary'), 'alpha\nbeta');
		document.getElementById('hs-save-dictionary').fire('click');

		// The round trip is seconds long. The Save button is disabled but the TEXTAREA never is, and a
		// tab switch even brings back an enabled button over a box that looks completely idle.
		lifted.clear(root);
		lifted.renderDictionary(root);
		const area = document.getElementById('hs-dictionary');
		type(area, 'alpha\ngamma\ndelta'); // the user keeps typing

		resolveSave({ ok: true, adds: ['beta'], removes: [], words: ['alpha', 'beta'] });
		await settle();

		// Repainting unconditionally threw the typing away under a cheerful "Saved.", with nothing to
		// say anything had been dropped.
		assert.strictEqual(area.value, 'alpha\ngamma\ndelta', 'the words typed during the save are still there');
		assert.strictEqual(
			document.getElementById('hs-dictionary-status').textContent,
			'Saved. 1 added, 0 removed. Your unsaved edits were kept.',
			'and the status says so, instead of implying everything is stored',
		);
		// The stored truth still advanced, so the next save diffs against the right baseline.
		assert.deepStrictEqual(lifted.state.dictionaryWords, ['alpha', 'beta']);
		assert.strictEqual(document.getElementById('hs-dictionary-count').textContent, '2 words');
	});

	await test('a dictionary save DOES repaint a box the user has not touched', async () => {
		const document = makeFakeDom();
		const sent = [];
		let resolveSave = null;
		const lifted = extractDialogFunctions(
			['el', 'clear', 'renderDictionary'],
			`var document = arguments[0];
			 var sent = arguments[1];
			 var hold = arguments[2];
			 var state = { dictionaryWords: [], dictionaryBaseline: [], dictionaryText: '' };
			 function send(message) { sent.push(message); return hold(); }`,
			['state'],
			[document, sent, () => new Promise((resolve) => { resolveSave = resolve; })],
			['setDictionaryStatus', 'paintDictionary', 'seedDictionary'],
		);
		seed(lifted, ['alpha']);
		const root = document.createElement('div');
		document.root = root;
		lifted.renderDictionary(root);
		type(document.getElementById('hs-dictionary'), 'alpha\nbeta');
		document.getElementById('hs-save-dictionary').fire('click');

		// Re-entered tab, seeded from the still-stale list, and NOT typed into. The guard has to
		// recognise both this value and the send-time one as "still ours", or it would reintroduce the
		// staleness the by-id repaint was added to fix.
		lifted.clear(root);
		lifted.renderDictionary(root);
		resolveSave({ ok: true, adds: ['beta'], removes: [], words: ['alpha', 'beta'] });
		await settle();
		assert.strictEqual(document.getElementById('hs-dictionary').value, 'alpha\nbeta', 'repainted');
		assert.strictEqual(
			document.getElementById('hs-dictionary-status').textContent,
			'Saved. 1 added, 0 removed.',
			'with no "edits were kept" note, because there were none',
		);
	});

	await test('clear-status copy keeps dismissals and legacy findings in their own units', () => {
		const { describeCleared } = extractDialogFunctions(['describeCleared'], '');
		// One Dismiss makes several ignore hashes, so summing rows and legacy hashes and calling the
		// total "dismissals" tells a pre-v1.4.0 user who dismissed 3 things that 7 were cleared.
		assert.strictEqual(
			describeCleared({ dismissals: 2, legacy: 5 }),
			'Cleared 2 dismissals and 5 legacy findings.',
		);
		assert.strictEqual(describeCleared({ dismissals: 0, legacy: 7 }), 'Cleared 7 legacy findings.');
		assert.strictEqual(describeCleared({ dismissals: 3, legacy: 0 }), 'Cleared 3 dismissals.');
		assert.strictEqual(describeCleared({ dismissals: 1, legacy: 1 }), 'Cleared 1 dismissal and 1 legacy finding.');
		assert.strictEqual(describeCleared({ dismissals: 0, legacy: 0 }), 'Nothing to clear.');
	});

	await test('a refused repaint never hands the next save a baseline the box has not shown', async () => {
		// INV-C. The baseline is what the service is ALLOWED TO DELETE, so it must always describe the
		// words the textarea actually showed. Advancing it to the reconciled truth while a refused
		// repaint left the user's own text on screen made the next save ask for the difference to be
		// deleted — words that only ever existed off-screen, wiped from the note, the user's external
		// file and every synced device.
		const document = makeFakeDom();
		const sent = [];
		let resolveSave = null;
		const lifted = extractDialogFunctions(
			['el', 'clear', 'renderDictionary'],
			`var document = arguments[0];
			 var sent = arguments[1];
			 var hold = arguments[2];
			 var state = { dictionaryWords: [], dictionaryBaseline: [], dictionaryText: '' };
			 function send(message) { sent.push(message); return hold(); }`,
			['state'],
			[document, sent, () => new Promise((resolve) => { resolveSave = resolve; })],
			['setDictionaryStatus', 'paintDictionary', 'seedDictionary'],
		);
		seed(lifted, ['alpha']);
		const root = document.createElement('div');
		document.root = root;
		lifted.renderDictionary(root);

		type(document.getElementById('hs-dictionary'), 'alpha\nbeta');
		document.getElementById('hs-save-dictionary').fire('click');
		assert.deepStrictEqual(sent[0].baseline, ['alpha'], 'first save sends the seeded list');

		// The user keeps typing during the round trip, so the repaint will be refused...
		type(document.getElementById('hs-dictionary'), 'alpha\ngamma');
		// ...and the reply carries a word that arrived from somewhere else entirely (a sync, or the
		// external file the user just configured on the General tab).
		resolveSave({ ok: true, adds: ['beta'], removes: [], words: ['alpha', 'beta', 'zebra'] });
		await settle();

		assert.strictEqual(document.getElementById('hs-dictionary').value, 'alpha\ngamma', 'typing kept');

		// The second save. Its baseline must still be the list the box was seeded from.
		document.getElementById('hs-save-dictionary').fire('click');
		const second = sent[1];
		assert.deepStrictEqual(second.words, ['alpha', 'gamma'], 'it posts what the box shows');
		assert.ok(
			second.baseline.indexOf('zebra') === -1,
			`the baseline never names a word the box has not shown: ${JSON.stringify(second.baseline)}`,
		);

		// And prove the consequence with the REAL diff the service runs: nothing gets deleted.
		const svc = loadTsModule('src/settingsService.ts', (id) =>
			id === './dismissedLog' ? loadTsModule('src/dismissedLog.ts') : require(id),
		);
		const diff = svc.diffWords(['alpha', 'beta', 'zebra'], second.words, second.baseline);
		assert.deepStrictEqual(diff.removes, [], 'so the save asks for no deletions at all');
		assert.deepStrictEqual(diff.adds, ['gamma'], 'only the word the user typed is added');
	});

	await test('switching tabs keeps the unsaved dictionary draft', () => {
		// INV-C. The Dictionary textarea is the dialog's only unsaved buffer — every other control
		// commits on change or on click — and re-seeding it from the reconciled list meant one click on
		// "Rules" destroyed everything typed into it, with no prompt and no way back.
		const document = makeFakeDom();
		const lifted = extractDialogFunctions(
			['el', 'clear', 'renderDictionary'],
			`var document = arguments[0];
			 var state = { dictionaryWords: [], dictionaryBaseline: [], dictionaryText: '' };
			 function send() { return Promise.resolve({ ok: true, adds: [], removes: [], words: [] }); }`,
			['state'],
			[document],
			['setDictionaryStatus', 'paintDictionary', 'seedDictionary'],
		);
		seed(lifted, ['alpha']);
		const root = document.createElement('div');
		document.root = root;
		lifted.renderDictionary(root);

		type(document.getElementById('hs-dictionary'), 'alpha\nbeta\ngamma\ndelta');

		// The tab bounce: render() clears the root and rebuilds the section from scratch.
		lifted.clear(root);
		lifted.renderDictionary(root);

		assert.strictEqual(
			document.getElementById('hs-dictionary').value,
			'alpha\nbeta\ngamma\ndelta',
			'the draft survives a trip to another tab and back',
		);
		// ...and the baseline still describes the SEED, not the draft, so a save from here can only
		// delete what was actually displayed to begin with.
		assert.deepStrictEqual(lifted.state.dictionaryBaseline, ['alpha']);
	});

	// ---- v1.4.0: rule descriptions are ALWAYS visible ------------------------
	// The per-rule disclosure arrow is gone. It made the one thing that says what a rule DOES cost a
	// click, 823 times over, while the group rows above it had shown label + description inline all
	// along. These three tests pin the replacement: the description renders with no interaction at
	// all, the lazy fetch still fills rows that were painted before it landed, and the only
	// disclosure left in the list is the group's.
	{
		const RULES_PREAMBLE = `var document = arguments[0];
			 var state = {
				overrides: Object.create(null),
				defaults: { ModalOf: true, Spaces: true },
				descriptionText: Object.create(null),
				descriptions: null,
				search: '',
				expandedGroups: Object.create(null),
				searchExpanded: Object.create(null),
			 };
			 var searchTimer = null;
			 function renderRules() {}
			 function setRuleState() {}
			 function pushOverrides() {}
			 function refreshGroupHeader() {}
			 function refreshRulesSummary() {}`;
		const RULES_FNS = [
			'el',
			'clear',
			'makeSelect',
			'ruleDisplayLabel',
			'ruleMatches',
			'matchingRules',
			'ruleState',
			'groupState',
			'defaultLabelFor',
			'cssEscape',
			'renderRuleRow',
			'renderGroup',
		];
		const GROUP = {
			id: 'Misc',
			label: 'Miscellaneous',
			description: 'A group description, which has always been inline.',
			rules: ['ModalOf', 'Spaces'],
		};
		const liftRules = (document) =>
			extractDialogFunctions(RULES_FNS, RULES_PREAMBLE, ['state'], [document], [
				'groupExpanded',
				'toggleGroupExpanded',
				'currentNeedle',
			]);

		await test('a rule row shows its description with NO interaction — no arrow, no click', () => {
			const document = makeFakeDom();
			const lifted = liftRules(document);
			lifted.state.descriptions = {
				ModalOf: '<p>Corrects <code>modal of</code> to <code>modal have</code>.</p>',
				Spaces: '<p>Flags runs of repeated spaces.</p>',
			};
			lifted.state.expandedGroups.Misc = true;

			const root = document.createElement('div');
			document.root = root;
			root.appendChild(lifted.renderGroup(GROUP, ''));

			const rows = document.byClass('hs-rule');
			assert.strictEqual(rows.length, 2, 'both rules rendered');
			const descs = document.byClass('hs-rule-desc');
			assert.strictEqual(descs.length, 2, 'EVERY row carries a description node, unprompted');
			// TRUSTED harper HTML goes in via innerHTML (the one exception to the textContent rule).
			assert.strictEqual(
				descs[0].innerHTML,
				'<p>Corrects <code>modal of</code> to <code>modal have</code>.</p>',
				"the first row shows harper's own description for ModalOf",
			);
			assert.strictEqual(descs[1].innerHTML, '<p>Flags runs of repeated spaces.</p>');

			// THE ARROW IS GONE from the rows. The group header still has exactly one — that disclosure
			// is unchanged, and this is what keeps "removed the per-rule fold" from quietly meaning
			// "removed the group fold too".
			for (const row of rows) {
				const arrowsInRow = [];
				const walk = (n) => {
					if (String(n.className).split(' ').includes('hs-disclosure')) arrowsInRow.push(n);
					n.children.forEach(walk);
				};
				walk(row);
				assert.strictEqual(arrowsInRow.length, 0, 'a rule row has no disclosure control at all');
			}
			assert.strictEqual(
				document.byClass('hs-disclosure').length,
				1,
				'exactly one disclosure survives in the list: the group header\'s',
			);
			// The selector still works — the row lost its fold, not its control.
			assert.strictEqual(document.byClass('hs-rule-select').length, 2, 'both tri-state selectors render');
		});

		await test('descriptions arrive late: the row reserves the line, then fills it on the repaint', () => {
			// They are fetched lazily (~823 HTML strings would roughly triple the first payload), so a
			// row can be painted before its text exists. The node is rendered EMPTY rather than omitted
			// so the stylesheet can hold its height, and the repaint on arrival fills it in.
			const document = makeFakeDom();
			const lifted = liftRules(document);
			lifted.state.expandedGroups.Misc = true;
			const root = document.createElement('div');
			document.root = root;

			// BEFORE the fetch lands: state.descriptions is null.
			root.appendChild(lifted.renderGroup(GROUP, ''));
			let descs = document.byClass('hs-rule-desc');
			assert.strictEqual(descs.length, 2, 'the description line is RESERVED, not omitted');
			assert.ok(!descs[0].innerHTML, 'and it is empty while the fetch is in flight');
			assert.strictEqual(descs[0].textContent, '', 'no "Loading…" placeholder text to flash away');

			// The fetch lands and the list repaints (what ensureDescriptions does).
			lifted.state.descriptions = { ModalOf: '<p>Late arrival.</p>' };
			lifted.clear(root);
			root.appendChild(lifted.renderGroup(GROUP, ''));
			descs = document.byClass('hs-rule-desc');
			assert.strictEqual(descs[0].innerHTML, '<p>Late arrival.</p>', 'the row picked the text up');
			// A rule harper has no description for keeps the same empty reserved line rather than
			// announcing its absence on every row forever.
			assert.strictEqual(descs.length, 2, 'the describe-less row still reserves its line');
			assert.ok(!descs[1].innerHTML, 'and says nothing rather than "No description for this rule."');
		});

		await test('search still matches on description text, with the fold gone', () => {
			// Description text has always been part of the search corpus (via state.descriptionText, the
			// stripped-to-plain-text mirror). Deleting the per-rule fold must not touch that: the corpus
			// was never keyed on what was expanded.
			const document = makeFakeDom();
			const lifted = liftRules(document);
			lifted.state.descriptions = { ModalOf: '<p>zzuniquezz</p>', Spaces: '<p>nope</p>' };
			lifted.state.descriptionText.ModalOf = 'zzuniquezz';
			lifted.state.descriptionText.Spaces = 'nope';

			assert.deepStrictEqual(
				lifted.matchingRules(GROUP, 'zzuniquezz'),
				['ModalOf'],
				'a needle found only in the description still selects its rule',
			);
			// And it renders — a search force-opens the groups it matched.
			const root = document.createElement('div');
			document.root = root;
			lifted.state.search = 'zzuniquezz';
			root.appendChild(lifted.renderGroup(GROUP, 'zzuniquezz'));
			const rows = document.byClass('hs-rule');
			assert.strictEqual(rows.length, 1, 'only the matching rule is listed');
			assert.strictEqual(rows[0].getAttribute('data-rule'), 'ModalOf');
			assert.strictEqual(
				document.byClass('hs-rule-desc')[0].innerHTML,
				'<p>zzuniquezz</p>',
				'and the description that matched is visible in the result, not hidden behind a click',
			);
		});
	}

	await test('a group arrow collapses what is on screen, whatever the needle has since become', () => {
		// INV-D. The toggle used to derive its new value from the CURRENT needle rather than from what
		// was painted, so in the 140 ms debounce window the two disagreed and the arrow fired the wrong
		// way: a group force-opened by a search, clicked after the search was cleared, computed
		// `!undefined === true` and stayed open — leaving a stored expansion nobody asked for.
		const document = makeFakeDom();
		const lifted = extractDialogFunctions(
			[
				'el',
				'clear',
				'makeSelect',
				'ruleDisplayLabel',
				'ruleMatches',
				'matchingRules',
				'ruleState',
				'groupState',
				'defaultLabelFor',
				'cssEscape',
				'renderRuleRow',
				'renderGroup',
			],
			`var document = arguments[0];
			 var state = {
				overrides: Object.create(null),
				defaults: { ModalOf: true, Spaces: true },
				descriptionText: Object.create(null),
				descriptions: null,
				search: '',
				expandedGroups: Object.create(null),
				searchExpanded: Object.create(null),
			 };
			 var searchTimer = null;
			 function renderRules() {}
			 function setRuleState() {}
			 function pushOverrides() {}
			 function refreshGroupHeader() {}
			 function refreshRulesSummary() {}`,
			['state'],
			[document],
			['groupExpanded', 'toggleGroupExpanded', 'currentNeedle'],
		);
		const group = { id: 'Misc', label: 'Miscellaneous', description: '', rules: ['ModalOf', 'Spaces'] };
		const root = document.createElement('div');
		document.root = root;
		const paint = (needle) => {
			lifted.state.search = needle;
			lifted.clear(root);
			root.appendChild(lifted.renderGroup(group, needle));
			return {
				listed: document.byClass('hs-rule-list').length > 0,
				arrow: document.byClass('hs-disclosure')[0],
			};
		};

		// The group was NEVER opened by the user; only the search is holding it open.
		const searching = paint('modal');
		assert.strictEqual(searching.listed, true, 'the search force-opened it');

		// The user clears the box. `state.search` updates at once; the repaint is 140 ms out, so the
		// arrow on screen still belongs to the searched painting.
		lifted.state.search = '';
		searching.arrow.fire('click');

		assert.strictEqual(
			lifted.state.expandedGroups.Misc,
			false,
			'a collapse arrow stores a COLLAPSE, not an expansion nobody asked for',
		);
		lifted.clear(root);
		root.appendChild(lifted.renderGroup(group, ''));
		assert.strictEqual(
			document.byClass('hs-rule-list').length > 0,
			false,
			'and the group really is collapsed after the click',
		);

		// The mirror: painted collapsed with no needle, clicked once a needle exists, must EXPAND.
		lifted.state.expandedGroups = Object.create(null);
		lifted.state.searchExpanded = Object.create(null);
		const plain = paint('');
		assert.strictEqual(plain.listed, false, 'precondition: collapsed, no search');
		lifted.state.search = 'modal';
		plain.arrow.fire('click');
		lifted.clear(root);
		root.appendChild(lifted.renderGroup(group, 'modal'));
		assert.strictEqual(
			document.byClass('hs-rule-list').length > 0,
			true,
			'an expand arrow expands, in the other direction too',
		);
	});

	await test('a search edit that leaves the needle unchanged keeps the groups collapsed during it', () => {
		// INV-D. `currentNeedle()` trims and lowercases, so a trailing space typed while composing a
		// two-word query fires `input` without changing a single match — and wiping the per-search
		// collapses there sprang every group the user had just collapsed back open under a result list
		// that had not moved.
		const lifted = extractDialogFunctions(
			['currentNeedle', 'setSearchValue', 'groupExpanded'],
			'var state = { search: \'\', expandedGroups: Object.create(null), searchExpanded: Object.create(null) };',
			['state'],
		);
		lifted.setSearchValue('modal');
		lifted.state.searchExpanded.Misc = false; // the user collapsed a noisy group during the search
		lifted.state.searchExpanded.Other = false;

		assert.strictEqual(lifted.setSearchValue('modal '), false, 'a trailing space is not a new query');
		assert.strictEqual(lifted.groupExpanded('Misc', 'modal'), false, 'the collapse survives it');
		assert.strictEqual(lifted.setSearchValue('  MODAL  '), false, 'nor is padding or case');
		assert.strictEqual(lifted.groupExpanded('Other', 'modal'), false, 'still collapsed');

		// A genuinely different query IS a new set of matches, so the collapses stop describing
		// anything and are dropped — the behaviour searchExpanded exists for.
		assert.strictEqual(lifted.setSearchValue('modality'), true, 'a real edit is a new query');
		assert.strictEqual(lifted.groupExpanded('Misc', 'modality'), true, 'and re-opens the matches');
	});

	await test('a group disclosure stays live during a search, and a search never rewrites the stored state', () => {
		const document = makeFakeDom();
		const lifted = extractDialogFunctions(
			[
				'el',
				'clear',
				'makeSelect',
				'ruleDisplayLabel',
				'ruleMatches',
				'matchingRules',
				'ruleState',
				'groupState',
				'defaultLabelFor',
				'cssEscape',
				'renderRuleRow',
				'renderGroup',
			],
			`var document = arguments[0];
			 var state = {
				overrides: Object.create(null),
				defaults: { ModalOf: true, Spaces: true },
				descriptionText: Object.create(null),
				descriptions: null,
				search: '',
				expandedGroups: Object.create(null),
				searchExpanded: Object.create(null),
			 };
			 var searchTimer = null;
			 function renderRules() {}
			 function setRuleState() {}
			 function pushOverrides() {}
			 function refreshGroupHeader() {}
			 function refreshRulesSummary() {}`,
			['state'],
			[document],
			['groupExpanded', 'toggleGroupExpanded', 'currentNeedle'],
		);
		const group = { id: 'Misc', label: 'Miscellaneous', description: '', rules: ['ModalOf', 'Spaces'] };
		const root = document.createElement('div');
		document.root = root;
		// Renders the way renderRules() does — off `state.search`, the one source of truth — so the
		// closures a click later runs against carry whatever needle was live at RENDER time.
		const paint = (needle) => {
			lifted.state.search = needle;
			lifted.clear(root);
			root.appendChild(lifted.renderGroup(group, needle));
			return {
				listed: document.byClass('hs-rule-list').length > 0,
				arrow: document.byClass('hs-disclosure')[0],
			};
		};

		lifted.state.expandedGroups.Misc = true; // the user opened "Miscellaneous" before searching

		// A search force-opens the groups it matched: hiding the hits behind another click would make
		// the search useless.
		const searching = paint('modal');
		assert.strictEqual(searching.listed, true, 'the search force-opened the group');

		// Clicking the arrow during that search must DO something. It used to flip only the STORED
		// value, which the force-open then ignored: nothing moved on screen, while the group silently
		// became collapsed for after the search — by a click count the UI gave no feedback for.
		searching.arrow.fire('click');
		assert.strictEqual(paint('modal').listed, false, 'the arrow collapses the group, visibly');
		assert.strictEqual(lifted.state.expandedGroups.Misc, true, 'and the STORED state is untouched');
		document.byClass('hs-disclosure')[0].fire('click');
		assert.strictEqual(paint('modal').listed, true, 'clicking again re-opens it');

		// Collapse it once more, then clear the search: what comes back is what the user had open
		// BEFORE the search, not whatever they did to it during one.
		document.byClass('hs-disclosure')[0].fire('click');
		lifted.state.searchExpanded = Object.create(null); // what a new query does to the per-search map
		assert.strictEqual(paint('').listed, true, 'the pre-search expansion is what comes back');

		// And with no search the arrow writes to the stored state, exactly as it always did.
		document.byClass('hs-disclosure')[0].fire('click');
		assert.strictEqual(lifted.state.expandedGroups.Misc, false, 'no search => the stored value flips');
		assert.strictEqual(paint('').listed, false);

		// THE DEBOUNCE WINDOW. The search box updates `state.search` synchronously but defers the
		// re-render by 140 ms, so for that whole window the rows on screen were painted with the
		// PREVIOUS needle. A click routed by that stale needle went into the wrong map: it flipped the
		// STORED expansion, the immediate repaint force-opened the group anyway so nothing moved, and
		// the collapse only surfaced once the search was cleared — the invisible side effect that
		// searchExpanded exists to remove, back again through a different door.
		lifted.state.expandedGroups.Misc = true;
		lifted.state.searchExpanded = Object.create(null);
		const stale = paint(''); // painted with no search: the closures hold ''
		assert.strictEqual(stale.listed, true, 'precondition: open, unfiltered');
		lifted.state.search = 'modal'; // the user types; renderRules() is 140 ms away
		stale.arrow.fire('click');

		assert.strictEqual(
			lifted.state.expandedGroups.Misc,
			true,
			'a click during the debounce window must not touch the STORED expansion',
		);
		lifted.clear(root);
		root.appendChild(lifted.renderGroup(group, 'modal'));
		assert.strictEqual(
			document.byClass('hs-rule-list').length > 0,
			false,
			'and it collapses the group visibly, instead of doing nothing on screen',
		);
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

		// v1.4.0: mobile Joplin has NO menus at all, so the note toolbar (which surfaces plugin buttons
		// in the note's "..." overflow menu) is the only place the settings command can be reached from.
		await test('mobile: the settings command is a note-toolbar button, not a menu item', () => {
			const button = mstate.toolbarButtons.find((b) => b.command === 'harper.openSettings');
			assert.ok(button, 'a toolbar button was created for harper.openSettings');
			assert.strictEqual(button.location, 'noteToolbar', 'it sits on the note toolbar');
			assert.ok(
				!mstate.menuItems.some((m) => m.command === 'harper.openSettings'),
				'mobile does not try to create a menu item (there are no menus there)',
			);
		});

		await test('mobile: the settings dialog opens and its snapshot omits the desktop-only dictionaryPath', async () => {
			const command = mstate.commands.find((c) => c.name === 'harper.openSettings');
			assert.ok(command, 'the command is registered on mobile too');
			await command.execute();
			const handle = `dialog-${mstate.dialogs[mstate.dialogs.length - 1]}`;
			const dialogHandler = mstate.viewMessageHandlers[handle];
			assert.strictEqual(typeof dialogHandler, 'function', 'the dialog channel is wired on mobile');
			const snapshot = await dialogHandler({ type: 'settings:snapshot', includeDescriptions: false });
			// The setting is not REGISTERED on mobile, so reading it would throw "Unknown key" in real
			// Joplin — the snapshot must simply not carry the key, and the dialog hides the whole row.
			assert.ok(
				!Object.prototype.hasOwnProperty.call(snapshot.settings, 'dictionaryPath'),
				'the mobile snapshot has no dictionaryPath key at all',
			);
			// And a dialog that tried to write it anyway is refused with a readable reason.
			const refused = await dialogHandler({ type: 'settings:updateSetting', key: 'dictionaryPath', value: '/tmp/x' });
			assert.ok(refused && /desktop-only/.test(refused.__error || ''), `refused on mobile: ${JSON.stringify(refused)}`);
			assert.strictEqual(mobileFsCalls.length, 0, 'opening the settings dialog touched ZERO filesystem');
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

	// ---- RECONCILE RACE: entries enqueued MID-PASS must survive the commit ---
	//
	// A pass SNAPSHOTS pendingWords / pendingRemovals near its start and only commits several awaits
	// later (the note read, the L3-gated note write, the file rewrite, the base write). Retiring the
	// buffers with `setValue(key, [])` at that point — what the code did before — threw away anything
	// the user queued in between: it was never in the merge, never reached the note or the file, and
	// its only record was the buffer that just got wiped.
	//
	// `beforeNotePut` puts the test INSIDE that window: the hook runs while the reconcile is suspended
	// on its own data.put, which is strictly after both snapshots and strictly before the commit.
	{
		const rnotes = {
			'race-note': {
				id: 'race-note',
				body: '# h\n\nKeepme\nDropme\nDropmelater\n',
				updated_time: 3,
			},
		};
		const rstate = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-race-')),
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			// Note only (no file side), so every pass sees the whole picture and commits.
			initialSettings: { dictionaryNoteId: 'race-note' },
			notes: rnotes,
		});
		const rh = rstate.contentScriptMessageHandlers['harperCm'];
		// Let the start reconcile finish: a pass that is still in flight would be JOINED rather than
		// re-run, and the buffers must start from a committed, quiet state.
		await waitFor(() => (rstate.settings.syncBase || '').includes('Keepme'));

		await test('reconcile race: a word added DURING a pass survives the commit (pendingWords)', async () => {
			await rh({ type: 'getConfig' }); // editor open => the add is buffered, never written
			await rh({ type: 'addWord', word: 'Zfirstword' });
			assert.deepStrictEqual(rstate.settings.pendingWords, ['Zfirstword'], 'precondition: one word queued');

			// One-shot, fired from inside the pass's own note write.
			let injected = false;
			rstate.beforeNotePut = async () => {
				if (injected) return;
				injected = true;
				await rh({ type: 'addWord', word: 'Zsecondword' });
			};
			const putsBefore = rstate.notePuts.length;
			await rstate.noteSelectionChangeHandler(); // closes the editor, then reconciles
			assert.ok(await waitFor(() => rstate.notePuts.length > putsBefore), 'the pass wrote the note');
			assert.ok(injected, 'the concurrent add really landed inside the pass');
			rstate.beforeNotePut = null;

			const put = rstate.notePuts[rstate.notePuts.length - 1];
			assert.ok(/(^|\n)Zfirstword(\n|$)/.test(put.body), 'the snapshotted word reached the note');
			assert.ok(
				!/(^|\n)Zsecondword(\n|$)/.test(put.body),
				'the mid-pass word was not part of THIS merge (it arrived after the snapshot)',
			);
			assert.deepStrictEqual(
				rstate.settings.pendingWords,
				['Zsecondword'],
				'the mid-pass word SURVIVED the commit — a clear-all here would have dropped it silently',
			);
		});

		await test('reconcile race: the surviving word is merged by the NEXT pass', async () => {
			const putsBefore = rstate.notePuts.length;
			await rstate.noteSelectionChangeHandler();
			assert.ok(await waitFor(() => rstate.notePuts.length > putsBefore), 'the next pass wrote the note');
			const put = rstate.notePuts[rstate.notePuts.length - 1];
			assert.ok(/(^|\n)Zsecondword(\n|$)/.test(put.body), 'the survivor reached the note one pass later');
			assert.ok(/(^|\n)Zfirstword(\n|$)/.test(put.body), 'and the earlier word is still there');
			assert.deepStrictEqual(rstate.settings.pendingWords, [], 'the buffer is empty once nothing is left queued');
		});

		await test('reconcile race: a removal queued DURING a pass survives the commit (pendingRemovals)', async () => {
			// How the dictionary editor's delete half reaches the reconcile (applyWordEdits ->
			// persistRemovedWord -> addPendingRemoval); written directly here because the settings
			// dialog is a webview the harness does not mount.
			await rstate.setSetting('pendingRemovals', ['Dropme']);

			let injected = false;
			rstate.beforeNotePut = async () => {
				if (injected) return;
				injected = true;
				const queued = rstate.settings.pendingRemovals || [];
				await rstate.setSetting('pendingRemovals', [...queued, 'Dropmelater']);
			};
			const putsBefore = rstate.notePuts.length;
			await rstate.noteSelectionChangeHandler();
			assert.ok(await waitFor(() => rstate.notePuts.length > putsBefore), 'the pass wrote the note');
			assert.ok(injected, 'the concurrent removal really landed inside the pass');
			rstate.beforeNotePut = null;

			const put = rstate.notePuts[rstate.notePuts.length - 1];
			assert.ok(!/(^|\n)Dropme(\n|$)/.test(put.body), 'the snapshotted removal was applied to the note');
			assert.ok(
				/(^|\n)Dropmelater(\n|$)/.test(put.body),
				'the mid-pass removal was not part of THIS merge (it arrived after the snapshot)',
			);
			assert.deepStrictEqual(
				rstate.settings.pendingRemovals,
				['Dropmelater'],
				'the mid-pass removal SURVIVED the commit',
			);
		});

		await test('reconcile race: the surviving removal is applied by the NEXT pass', async () => {
			const putsBefore = rstate.notePuts.length;
			await rstate.noteSelectionChangeHandler();
			assert.ok(await waitFor(() => rstate.notePuts.length > putsBefore), 'the next pass wrote the note');
			const put = rstate.notePuts[rstate.notePuts.length - 1];
			assert.ok(!/(^|\n)Dropmelater(\n|$)/.test(put.body), 'the survivor was applied one pass later');
			assert.deepStrictEqual(rstate.settings.pendingRemovals, [], 'the removals buffer is empty again');
		});

		await test('reconcile: with nothing enqueued mid-pass, both buffers are emptied exactly as before', async () => {
			await rh({ type: 'getConfig' });
			await rh({ type: 'addWord', word: 'Zthirdword' });
			await rstate.setSetting('pendingRemovals', ['Keepme']);
			const putsBefore = rstate.notePuts.length;
			const writesBefore = rstate.settingWrites.length;

			await rstate.noteSelectionChangeHandler();
			assert.ok(await waitFor(() => rstate.notePuts.length > putsBefore), 'the pass wrote the note');

			const put = rstate.notePuts[rstate.notePuts.length - 1];
			assert.ok(/(^|\n)Zthirdword(\n|$)/.test(put.body), 'the queued addition landed');
			assert.ok(!/(^|\n)Keepme(\n|$)/.test(put.body), 'the queued removal landed');
			assert.deepStrictEqual(rstate.settings.pendingWords, [], 'pendingWords fully retired');
			assert.deepStrictEqual(rstate.settings.pendingRemovals, [], 'pendingRemovals fully retired');
			// Still ONE settings write per buffer: retiring re-reads the buffer, it does not re-write it
			// per entry, and an unchanged buffer is not written at all.
			const writes = rstate.settingWrites.slice(writesBefore);
			assert.strictEqual(
				writes.filter((w) => w.key === 'pendingWords').length,
				1,
				'exactly one pendingWords write on the commit path',
			);
			assert.strictEqual(
				writes.filter((w) => w.key === 'pendingRemovals').length,
				1,
				'exactly one pendingRemovals write on the commit path',
			);
		});

		await test('reconcile: a pass that cannot commit leaves both buffers untouched', async () => {
			// The abort path: an editor is open, so the note write is deferred (L3) and the pass does not
			// commit. Nothing may be retired — the entries have reached no durable side.
			await rh({ type: 'getConfig' }); // editorOpen = true
			await rh({ type: 'addWord', word: 'Zfourthword' });
			await rstate.setSetting('pendingRemovals', ['Zthirdword']);
			const putsBefore = rstate.notePuts.length;
			const baseBefore = rstate.settings.syncBase;

			await rh({ type: 'lint', text: 'Zfourthword alone.' }); // any activity; no reconcile trigger
			const pollTimer = rstate.intervals.find((i) => i.ms === 60000 && !i.cleared);
			assert.ok(pollTimer, 'the 60s dictionary poll is armed');
			rstate.notes['race-note'].updated_time = 9999; // force the poll to reconcile
			await pollTimer.fn();
			await waitFor(() => false, 200); // let the async pass settle

			assert.strictEqual(rstate.notePuts.length, putsBefore, 'L3: no note write while the editor is open');
			assert.strictEqual(rstate.settings.syncBase, baseBefore, 'an uncommitted pass does not advance the base');
			assert.deepStrictEqual(rstate.settings.pendingWords, ['Zfourthword'], 'pendingWords untouched');
			assert.deepStrictEqual(rstate.settings.pendingRemovals, ['Zthirdword'], 'pendingRemovals untouched');
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
	// v1.4.0 DICTIONARY EDITOR — a save may only ever delete what the editor SHOWED.
	// =========================================================================
	// The editor posts the words it is displaying while the service reads the LIVE effective list, so
	// the two can differ by anything that arrived in between: a word synced from another device by the
	// 60 s poll, or — with no race at all — the whole content of an external file the user has just
	// pointed the plugin at from the General tab, since nothing reloads the dialog's snapshot when a
	// setting changes. Diffing those two lists directly turns every such word into an explicit
	// removal, and an explicit removal beats every concurrent addition by design, rewrites the user's
	// own file (shared with harper-ls, synced by rclone) and propagates to every device. The baseline
	// the dialog now sends is what separates "the user deleted this" from "the dialog never saw it".
	{
		const edDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-editor-'));
		const edFile = path.join(edDir, 'dict.txt');
		// The user's own dictionary file: a header comment and 500 words the dialog will never see.
		const unseen = [];
		for (let i = 0; i < 500; i++) unseen.push(`Unseenqx${i}`);
		fs.writeFileSync(edFile, `# my own words\n${unseen.join('\n')}\n`, 'utf8');
		const edState = await run({
			dataDir: edDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			// The note side holds the two words the dialog WAS seeded with, and the file side is
			// configured — exactly the state after "set External dictionary file" on the General tab.
			initialSettings: { dictionaryPath: edFile, dictionaryNoteId: 'ednote' },
			notes: { ednote: { id: 'ednote', body: '# h\n\nAlphaqx\nBetaqx\n', updated_time: 100 } },
		});
		const edh = edState.contentScriptMessageHandlers['harperCm'];
		// What the dialog cached at load(), BEFORE the external file was configured: two words.
		const staleBaseline = ['Alphaqx', 'Betaqx'];

		await test('dictionary editor: saving a stale two-word snapshot does NOT delete 500 unseen words', async () => {
			assert.ok(
				await waitFor(() => (edState.settings.syncBase || '').includes('Unseenqx0')),
				'precondition: the file and note sides converged, so the effective list is 502 words',
			);
			const snap = await edh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.strictEqual(snap.dictionaryWords.length, 502, 'the live list really is 502 words');

			// The user opens the Dictionary tab (rendered from the stale cache) and presses Save without
			// touching anything. This used to report "0 added, 500 removed".
			const res = await edh({
				type: 'settings:saveDictionary',
				words: staleBaseline,
				baseline: staleBaseline,
			});
			assert.deepStrictEqual(res.removes, [], 'nothing the editor never saw is deleted');
			assert.deepStrictEqual(res.adds, [], 'and nothing is added');

			const onDisk = fs.readFileSync(edFile, 'utf8');
			for (const word of ['Unseenqx0', 'Unseenqx250', 'Unseenqx499']) {
				assert.ok(onDisk.includes(word), `the user's own file still holds ${word}`);
			}
			assert.ok(onDisk.startsWith('# my own words'), 'and its header comment is untouched');
			assert.ok(edState.notes.ednote.body.includes('Unseenqx0'), 'the synced note keeps them too');

			// The reply carries the reconciled TRUTH, so the dialog re-seeds from it and the next save's
			// baseline is no longer stale — which is what stops this repeating.
			assert.strictEqual(res.words.length, 502, 'the save reports the real word list back');
			assert.ok(res.words.includes('Unseenqx0'));
		});

		await test('dictionary editor: a word the editor DID show is still deletable, and only that word', async () => {
			const baseline = (await edh({ type: 'settings:snapshot', includeDescriptions: false })).dictionaryWords;
			assert.ok(baseline.includes('Betaqx'), 'precondition: the fresh snapshot shows Betaqx');
			const next = baseline.filter((w) => w !== 'Betaqx');

			const res = await edh({ type: 'settings:saveDictionary', words: next, baseline: baseline });
			assert.deepStrictEqual(res.removes, ['Betaqx'], 'exactly the word the user deleted');
			assert.deepStrictEqual(res.adds, [], 'nothing else moved');

			assert.ok(await waitFor(() => !fs.readFileSync(edFile, 'utf8').includes('Betaqx')));
			assert.ok(fs.readFileSync(edFile, 'utf8').includes('Unseenqx0'), 'the other 500 are untouched');
			const flagged = (await edh({ type: 'lint', text: 'I said Betaqx and Unseenqx0.' })).map((l) => l.problemText);
			assert.ok(flagged.includes('Betaqx'), 'the deleted word is flagged again');
			assert.ok(!flagged.includes('Unseenqx0'), 'a word that was never deleted still is not');
		});

		await test('dictionary editor: a "# " comment line pasted in is not stored and does not pollute the file', async () => {
			const baseline = (await edh({ type: 'settings:snapshot', includeDescriptions: false })).dictionaryWords;
			const before = fs.readFileSync(edFile, 'utf8');
			// The realistic trigger: pasting an existing dictionary file, whose canonical first line is
			// exactly a "# " comment.
			const res = await edh({
				type: 'settings:saveDictionary',
				words: baseline.concat(['# proper nouns', 'Mikeqx']),
				baseline: baseline,
			});
			assert.deepStrictEqual(res.adds, ['Mikeqx'], 'the comment is not an addition; the real word is');
			assert.ok(!res.words.includes('# proper nouns'), 'and it is not in the resulting list');

			assert.ok(await waitFor(() => fs.readFileSync(edFile, 'utf8').includes('Mikeqx')));
			const after = fs.readFileSync(edFile, 'utf8');
			// It used to be appended by persistAddedWord AND a second time by the rewrite (a non-word
			// line never enters that function's `seen` set), then dropped on the next read — so the
			// "added" word silently vanished while two junk lines stayed in the user's file forever.
			assert.strictEqual(
				after.split('\n').filter((l) => l.startsWith('# ')).length,
				before.split('\n').filter((l) => l.startsWith('# ')).length,
				'the file gained no comment lines at all',
			);
			assert.ok(!edState.notes.ednote.body.includes('# proper nouns'), 'and the synced note gained none');
		});
	}

	// ---- CRLF dictionaries: a rewrite must not accrete carriage returns ------
	{
		const crDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-crlf-'));
		const crFile = path.join(crDir, 'dict.txt');
		// A dictionary hand-authored on Windows, which is where Joplin desktop meets CRLF.
		fs.writeFileSync(crFile, '# words\r\nAlphacr\r\nBetacr\r\n', 'utf8');
		const crState = await run({
			dataDir: crDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: crFile },
		});
		const crh = crState.contentScriptMessageHandlers['harperCm'];

		await test('CRLF dictionary: a rewrite keeps exactly one CR per line instead of doubling it', async () => {
			assert.ok(
				await waitFor(() => (crState.settings.syncBase || '').includes('Alphacr')),
				'precondition: the file side converged',
			);
			// The v1.4.0 removals path makes a rewrite an ordinary, user-initiated operation.
			const res = await crh({
				type: 'settings:saveDictionary',
				words: ['Alphacr'],
				baseline: ['Alphacr', 'Betacr'],
			});
			assert.deepStrictEqual(res.removes, ['Betacr'], 'precondition: the delete really happened');
			assert.ok(await waitFor(() => !fs.readFileSync(crFile, 'utf8').includes('Betacr')));

			const after = fs.readFileSync(crFile, 'utf8');
			// `split('\n')` left each line's CR in place and `join('\r\n')` then added a second one, with
			// one more on every later rewrite. Nothing surfaced it — parseWords trims them all off — so
			// the user's own rclone-synced file just diffed dirty on every device, forever.
			assert.ok(!after.includes('\r\r'), `no doubled CR: ${JSON.stringify(after)}`);
			assert.strictEqual(after, '# words\r\nAlphacr\r\n', 'the surviving lines are byte-exact CRLF');

			// A second rewrite is where the accretion used to compound.
			await crh({ type: 'addWord', word: 'Gammacr' });
			assert.ok(await waitFor(() => fs.readFileSync(crFile, 'utf8').includes('Gammacr')));
			const grown = fs.readFileSync(crFile, 'utf8');
			assert.ok(!grown.includes('\r\r'), `still no doubled CR after an append: ${JSON.stringify(grown)}`);
			assert.strictEqual(grown, '# words\r\nAlphacr\r\nGammacr\r\n', 'and the appended word is CRLF too');
		});
	}

	// ---- a dictionary save must not be answered by a pass that predates it ---
	{
		const jnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-join-'));
		const jnState = await run({
			dataDir: jnDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'jnote' },
			notes: { jnote: { id: 'jnote', body: '# h\n\nKeepmeqx\n', updated_time: 100 } },
		});
		const jnh = jnState.contentScriptMessageHandlers['harperCm'];

		await test('dictionary editor: a save is not satisfied by a reconcile that started before it', async () => {
			assert.ok(
				await waitFor(() => (jnState.settings.syncBase || '').includes('Keepmeqx')),
				'precondition: converged',
			);
			await jnh({ type: 'lint', text: 'warm the engine' }); // so nothing below builds the linter

			// A competing pass — the 60 s poll firing because sync moved the note, or a rule write from
			// the dialog's own Rules tab reaching applyConfiguration — is started PARTWAY through the
			// save's per-word loop, so it snapshots the pending buffers holding the first word but not
			// the second. It is then parked on its note write, which is where a save that merely JOINS
			// the pass in flight ends up waiting for a result that cannot contain its own edits.
			let openGate = null;
			let gateEntered = null;
			const parked = new Promise((resolve) => {
				gateEntered = resolve;
			});
			const gate = new Promise((resolve) => {
				openGate = resolve;
			});
			jnState.beforeNotePut = async () => {
				jnState.beforeNotePut = null; // park the competing pass only
				gateEntered();
				await gate;
			};
			jnState.afterSettingWrite = async (key) => {
				if (key !== 'pendingWords') return;
				jnState.afterSettingWrite = null;
				// Synchronous up to its first await, so the pass IS in flight from here on.
				void jnState.noteSelectionChangeHandler();
				await parked;
			};
			// Release it shortly after, so the save is not blocked forever either way.
			setTimeout(() => openGate(), 60);

			const res = await jnh({
				type: 'settings:saveDictionary',
				words: ['Keepmeqx', 'Zalphaqx', 'Zbetaqx'],
				baseline: ['Keepmeqx'],
			});
			assert.deepStrictEqual(res.adds, ['Zalphaqx', 'Zbetaqx'], 'the dialog was told both words were saved');

			// Joining the in-flight pass returned a word set the later edits were not in: the note was
			// written WITHOUT them, the buffer was left holding them with nothing scheduled to retry
			// (the poll returns early unless a side moved, and the user cannot change note while a modal
			// dialog is open), and the stale clear-then-import took them back OUT of the live engine —
			// so the dialog said "Saved. 2 added." while the words were underlined again.
			assert.ok(
				jnState.notes.jnote.body.includes('Zbetaqx'),
				`the note actually holds every saved word: ${JSON.stringify(jnState.notes.jnote.body)}`,
			);
			assert.deepStrictEqual(jnState.settings.pendingWords, [], 'and the buffer was retired, not stranded');
			const flagged = (await jnh({ type: 'lint', text: 'Zbetaqx and Zalphaqx are fine.' })).map((l) => l.problemText);
			assert.ok(!flagged.includes('Zbetaqx'), 'the live engine still accepts the words it just saved');
		});
	}

	// ---- the pending buffers must be read as ONE consistent pair -------------
	{
		const pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-pair-'));
		const pbState = await run({
			dataDir: pbDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'pbnote' },
			notes: { pbnote: { id: 'pbnote', body: '# h\n\nAlphapb\nKubernetes\n', updated_time: 100 } },
		});
		const pbh = pbState.contentScriptMessageHandlers['harperCm'];

		await test('reconcile: re-adding a word mid-pass does not cancel it against its own stale removal', async () => {
			assert.ok(
				await waitFor(() => (pbState.settings.syncBase || '').includes('Kubernetes')),
				'precondition: converged with a base',
			);
			await pbh({ type: 'lint', text: 'warm the engine' });

			// A removal is queued and still uncommitted — normal, since the note write is deferred while
			// an editor is open and the buffer is what carries it until a pass can land it.
			await pbState.setSetting('pendingRemovals', ['Kubernetes']);

			// The user changes their mind and re-adds the word WHILE a pass is suspended on the note
			// read. addPendingWord cancels the pending removal and queues the addition — so the two
			// buffers are disjoint in storage at every instant, but a pass that read them either side of
			// this window saw the word in BOTH.
			let injected = false;
			pbState.beforeNoteGet = async () => {
				if (injected) return;
				injected = true;
				await pbh({ type: 'addWord', word: 'Kubernetes' });
			};
			await pbState.noteSelectionChangeHandler();
			pbState.beforeNoteGet = null;

			// Removals beat additions by design, so reading a non-disjoint pair dropped the word from the
			// merge, rewrote the note without it, and then retired it from BOTH buffers — gone from the
			// note, the file, the base and the engine, with the underline the user had just cleared back.
			assert.ok(
				pbState.notes.pbnote.body.includes('Kubernetes'),
				`the note still lists the re-added word: ${JSON.stringify(pbState.notes.pbnote.body)}`,
			);
			const snap = await pbh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.ok(snap.dictionaryWords.includes('Kubernetes'), 'and it is still in the effective list');
			const flagged = (await pbh({ type: 'lint', text: 'We run Kubernetes here.' })).map((l) => l.problemText);
			assert.ok(!flagged.includes('Kubernetes'), 'so the engine still accepts it');
		});
	}

	// ---- every buffer mutation is serialized against every other one ---------
	// Re-reading the buffer at commit time keeps a word enqueued mid-pass, but the re-read is itself
	// an await: an add landing between it and the setValue is computed away by a survivor list that
	// predates it and written straight over. Same for two adds, and for an add crossing a removal of a
	// different word. Each is a permanent loss of a word the user watched their underline clear for.
	//
	// Both tests park one writer between its read and its write — the only way to hold that window
	// open — and then let a second writer at it. Against a correct implementation the second writer is
	// made to queue, which is exactly what the assertions check.
	{
		const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-retire-'));
		const rtState = await run({
			dataDir: rtDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'rtnote' },
			notes: { rtnote: { id: 'rtnote', body: '# h\n\nAqx\nKeepqx\n', updated_time: 100 } },
		});
		const rth = rtState.contentScriptMessageHandlers['harperCm'];

		/** Park the next `pendingWords` write whose payload is not the one we are watching for. */
		function parkPendingWrite(unless) {
			let release = null;
			let onParked = null;
			const parked = new Promise((resolve) => {
				onParked = resolve;
			});
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			rtState.beforeSettingWrite = async (key, value) => {
				if (key !== 'pendingWords') return;
				if (Array.isArray(value) && value.includes(unless)) return;
				rtState.beforeSettingWrite = null; // park exactly one write
				onParked();
				await gate;
			};
			return { parked, release: () => release() };
		}

		await test('a word added while a commit is retiring the buffer is not written over', async () => {
			assert.ok(
				await waitFor(() => (rtState.settings.syncBase || '').includes('Aqx')),
				'precondition: converged with a base',
			);
			await rth({ type: 'lint', text: 'warm the engine' }); // so addWord below builds nothing

			// A word buffered but not yet retired — the ordinary state between an "Add to dictionary"
			// and the pass that folds it into the note.
			await rtState.setSetting('pendingWords', ['Aqx']);

			// A reconcile commits and retires ['Aqx']. Park it with its survivor list already computed
			// (`[]`) but not yet written.
			const retire = parkPendingWrite('Bqx');
			const pass = rtState.noteSelectionChangeHandler();
			await retire.parked;

			// The user adds a word right then. Not awaited: against a correct implementation it CANNOT
			// finish here, because it has to queue behind the retire holding the gate.
			const add = rth({ type: 'addWord', word: 'Bqx' });
			const raced = await waitFor(() => (rtState.settings.pendingWords || []).includes('Bqx'), 300);

			retire.release();
			await Promise.all([pass, add]);

			// Un-serialized, the add wrote ['Aqx','Bqx'] and the retire then wrote its stale `[]` over
			// the top: Bqx was gone from the buffer, had never been in that pass's merge, and had never
			// reached the note or the file — its only record was what just got wiped.
			assert.deepStrictEqual(
				rtState.settings.pendingWords,
				['Bqx'],
				'the retire drops only what it consumed; the new word survives',
			);

			// ...and it is durable, not just buffered: the next pass folds it into the synced note.
			await rtState.noteSelectionChangeHandler();
			assert.ok(
				rtState.notes.rtnote.body.includes('Bqx'),
				`the word reaches the dictionary note: ${JSON.stringify(rtState.notes.rtnote.body)}`,
			);
			assert.deepStrictEqual(rtState.settings.pendingWords, [], 'and is retired once it is durable');

			// Asserted last, so the failure this test reports is the lost word rather than the mechanism
			// that lost it: the add must have been made to WAIT rather than run inside the retire's
			// read-write window.
			assert.strictEqual(raced, false, 'the add queued behind the retire instead of racing into it');
		});

		await test('two words added at once both survive (neither add overwrites the other)', async () => {
			await rtState.setSetting('pendingWords', []);

			// Park the first add with its own list computed but unwritten.
			const first = parkPendingWrite('Csecondqx');
			const addOne = rth({ type: 'addWord', word: 'Cfirstqx' });
			await first.parked;

			const addTwo = rth({ type: 'addWord', word: 'Csecondqx' });
			const raced = await waitFor(() => (rtState.settings.pendingWords || []).includes('Csecondqx'), 300);

			first.release();
			await Promise.all([addOne, addTwo]);

			// Both read the same empty buffer and each wrote its own single-element result, so whichever
			// landed first was simply erased.
			assert.deepStrictEqual(
				(rtState.settings.pendingWords || []).slice().sort(),
				['Cfirstqx', 'Csecondqx'],
				'both words are queued',
			);

			await rtState.noteSelectionChangeHandler();
			const body = rtState.notes.rtnote.body;
			assert.ok(body.includes('Cfirstqx') && body.includes('Csecondqx'), `both reach the note: ${JSON.stringify(body)}`);
			assert.strictEqual(raced, false, 'the second add queued behind the first instead of racing it');
		});
	}

	// ---- the dialect switch rebuilds the engine, taking the dictionary with it
	{
		const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-dialect-'));
		const dlFile = path.join(dlDir, 'dict.txt');
		fs.writeFileSync(dlFile, 'Zorblaxqx\n', 'utf8');
		const dlState = await run({
			dataDir: dlDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryPath: dlFile },
		});
		const dlh = dlState.contentScriptMessageHandlers['harperCm'];

		await test('changing the dialect does not empty the engine dictionary for the rest of the session', async () => {
			const before = (await dlh({ type: 'lint', text: 'I like Zorblaxqx a lot.' })).map((l) => l.problemText);
			assert.ok(!before.includes('Zorblaxqx'), 'precondition: the custom word is accepted');

			// Exactly what the General tab's dialect dropdown sends.
			await dlh({ type: 'settings:updateSetting', key: 'dialect', value: 'British' });

			// setDialect FREES the WASM instance and builds a new one, so every imported word went with
			// it. applyConfiguration re-hydrates through a memo keyed on the reconciled word list — which
			// did not change — so the import was skipped and the engine was left holding NOTHING. One
			// click on a dropdown made every custom word underline as a misspelling in every note.
			const after = (await dlh({ type: 'lint', text: 'I like Zorblaxqx a lot.' })).map((l) => l.problemText);
			assert.ok(!after.includes('Zorblaxqx'), 'the custom word is still accepted after the switch');
			// ...and the engine really was rebuilt, so the test is not passing vacuously.
			const british = (await dlh({ type: 'lint', text: 'The colour is nice.' })).map((l) => l.problemText);
			assert.ok(!british.includes('colour'), 'the British dialect really is in force');

			// It stays fixed across later reconciles, which is where the memo used to re-skip the import.
			await dlh({ type: 'settings:updateSetting', key: 'debounceMs', value: 400 });
			const later = (await dlh({ type: 'lint', text: 'I like Zorblaxqx a lot.' })).map((l) => l.problemText);
			assert.ok(!later.includes('Zorblaxqx'), 'and after a further settings change');
		});
	}

	// ---- a non-boolean ruleOverrides value must not brick the session --------
	{
		const roState = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-overrides-')),
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			// Valid JSON, so "invalid JSON is ignored" never applied — but harper's setLintConfig throws
			// on a non-boolean value, inside the memoized linter promise.
			initialSettings: { ruleOverrides: '{"Spaces": 0, "AnA": false}' },
		});
		const roh = roState.contentScriptMessageHandlers['harperCm'];

		await test('a non-boolean ruleOverrides value is dropped, not left to kill every lint for the session', async () => {
			const lints = await roh({ type: 'lint', text: 'This is an test.' });
			assert.ok(Array.isArray(lints), 'linting works at all — the rejection is no longer memoized');
			assert.strictEqual(
				lints.filter((l) => l.ruleName === 'AnA').length,
				0,
				'the VALID override beside it is still honoured',
			);
			// The settings dialog awaits the same linter, so it used to show only the raw harper error
			// with no way to reach the setting that caused it.
			const snap = await roh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.deepStrictEqual(snap.flatConfig, { AnA: false }, 'the dialog reads back only the usable overrides');
			assert.ok(Object.keys(snap.defaults).length > 500, 'and the rules browser has its roster');
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

	await test('two dismissals landing together both reach the side table (the store serializes them)', async () => {
		// Every mutation of the table is a read-modify-write whose critical section straddles real
		// suspension points — `joplin.plugins.dataDir()` falls through to an fs.pathExists on desktop,
		// and both halves are settings-bridge round trips on mobile. Nothing upstream serializes them:
		// Joplin calls the content-script message handler directly with no queue, and the suggestion
		// card fires Dismiss without waiting for the previous one. So they interleave as "A reads [],
		// B reads [], A writes [A], B writes [B]".
		const settle = () => new Promise((resolve) => setTimeout(resolve, 2));
		let raw = '';
		const slowStore = {
			async read() {
				await settle();
				return raw;
			},
			async write(json) {
				await settle();
				raw = json;
			},
		};
		const entry = (id) => ({
			id,
			hashes: [id],
			ruleName: 'Spell',
			problemText: `w${id}`,
			dismissedAt: '2026-01-01T00:00:00.000Z',
		});

		await Promise.all([
			dismissedLog.appendDismissed(slowStore, entry(REAL_HASH_A)),
			dismissedLog.appendDismissed(slowStore, entry(REAL_HASH_B)),
		]);

		// The loser's hash is still in harper's ignore set, so a dropped row does not un-dismiss
		// anything — it degrades the dismissal into an unnameable "legacy" entry that only the
		// destructive bulk clear can ever remove, and nothing reconciles it back.
		assert.deepStrictEqual(
			dismissedLog.parseEntries(raw).map((e) => e.id).sort(),
			[REAL_HASH_A, REAL_HASH_B].sort(),
			'both rows survive a concurrent pair of dismissals',
		);

		// A clear racing a dismissal must not leave a row describing an ignore that is already gone.
		await Promise.all([
			dismissedLog.appendDismissed(slowStore, entry(REAL_HASH_A)),
			dismissedLog.clearDismissed(slowStore),
		]);
		const after = dismissedLog.parseEntries(raw);
		assert.ok(after.length === 0 || after.length === 1, `one ordering or the other, never a torn table: ${raw}`);
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
		const baseline = ['alpha', 'beta'];
		const diff = settingsSvc.diffWords(['alpha', 'beta'], ['beta', 'gamma'], baseline);
		assert.deepStrictEqual(diff.adds, ['gamma'], 'gamma is new');
		assert.deepStrictEqual(diff.removes, ['alpha'], 'alpha was deleted');
		const noop = settingsSvc.diffWords(['a', 'b'], ['b', 'a'], ['a', 'b']);
		assert.deepStrictEqual(noop, { adds: [], removes: [] }, 'reordering is not an edit');
	});

	// The CRITICAL one. The editor posts the words it is showing, and the service reads the live
	// effective list — so anything that entered the dictionary since the editor was seeded is in the
	// live list but not in the post. Diffing those two directly turns every such word into an explicit
	// removal, and a stated removal beats every concurrent addition by design and propagates to every
	// synced device. The baseline is what separates "the user deleted this" from "the dialog never
	// saw it".
	await test('diffWords: a word the editor never saw is NEVER a removal (stale-snapshot data loss)', () => {
		// The dialog was seeded with two words; 500 more arrived afterwards (an external file the user
		// pointed the plugin at from the General tab, or a sync while the dialog sat open).
		const baseline = ['alpha', 'beta'];
		const current = ['alpha', 'beta'];
		for (let i = 0; i < 500; i++) current.push(`unseen${i}`);

		// Saving the unchanged textarea must be a no-op, not a 500-word deletion.
		const untouched = settingsSvc.diffWords(current, ['alpha', 'beta'], baseline);
		assert.deepStrictEqual(untouched.removes, [], 'the 500 unseen words are not removals');
		assert.deepStrictEqual(untouched.adds, [], 'and nothing is added');

		// Editing one word the user CAN see still deletes exactly that one.
		const edited = settingsSvc.diffWords(current, ['alpha'], baseline);
		assert.deepStrictEqual(edited.removes, ['beta'], 'a word the editor showed is still deletable');
		assert.deepStrictEqual(edited.adds, [], 'nothing else moved');

		// No baseline at all => no removals. A caller that cannot say what it was looking at cannot
		// claim a deletion; adds still work, because an add can never destroy anything.
		const blind = settingsSvc.diffWords(current, ['alpha', 'zeta'], null);
		assert.deepStrictEqual(blind.removes, [], 'a baseline-less save can never delete');
		assert.deepStrictEqual(blind.adds, ['zeta'], 'but it can still add');

		// A baseline word the dictionary no longer holds needs no removal — queueing one could only
		// cancel someone else's concurrent re-add of it.
		const gone = settingsSvc.diffWords(['alpha'], ['alpha'], ['alpha', 'beta']);
		assert.deepStrictEqual(gone.removes, [], 'nothing to remove when it is already absent');
	});

	await test('normalizeWords drops "# " comment lines, which can never be stored as words', () => {
		// Trim first, THEN test the prefix — exactly what parseWords (src/index.ts) does on the way in,
		// so the two ends of the round trip agree on what a comment is. (A lone "# " trims to "#",
		// which parseWords keeps as a word; matching that is the point.)
		assert.deepStrictEqual(
			settingsSvc.normalizeWords(['Alpha', '# proper nouns', '  Beta  ', '#hashtag', '', '# ']),
			['#', '#hashtag', 'Alpha', 'Beta'],
			'"# " comments go; a bare "#word" is a legitimate word and stays',
		);
		// ...so pasting a dictionary file (whose canonical header IS a "# " line) reports no phantom add.
		const diff = settingsSvc.diffWords(['Alpha'], ['Alpha', '# proper nouns'], ['Alpha']);
		assert.deepStrictEqual(diff.adds, [], 'a comment line is not an addition');
		assert.deepStrictEqual(diff.removes, [], 'and it does not disturb anything else');
	});

	await test('parseRuleOverridesJson DROPS non-boolean values (harper rejects them and the linter is memoized)', () => {
		// `{"Spaces": 0}` is valid JSON, so the "invalid JSON is ignored" promise did not cover it —
		// but harper's setLintConfig throws on it, inside the memoized linter promise, killing every
		// lint AND the settings dialog for the whole session.
		assert.deepStrictEqual(
			settingsSvc.parseRuleOverridesJson('{"Spaces": 0, "AnA": false, "Nope": "yes", "Null": null}'),
			{ AnA: false },
			'only real booleans survive; the rest fall back to Default (absence)',
		);
		assert.deepStrictEqual(settingsSvc.parseRuleOverridesJson(''), {}, 'empty is still a valid empty map');
		assert.strictEqual(settingsSvc.parseRuleOverridesJson('this is { not json'), null, 'malformed still reports null');
		assert.strictEqual(settingsSvc.parseRuleOverridesJson('[1,2]'), null, 'an array is still not an object');
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

		await test('snapshot reports a debounce of 0 as 0 (a falsy-but-valid value must survive the round trip)', async () => {
			// `0` means "lint immediately" and is inside the setting's declared range. A `|| 500`
			// fallback would report 500 back to the dialog, and saving that would silently undo the
			// user's choice — so the round trip is asserted rather than assumed.
			await sh({ type: 'settings:updateSetting', key: 'debounceMs', value: 0 });
			assert.strictEqual(sdState.settings.debounceMs, 0, 'zero is stored, not coerced');
			const snap = await sh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.strictEqual(snap.settings.debounceMs, 0, 'and zero is what the dialog reads back');
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

	// ---- integration: MIXED dismissed state (named rows + unaccounted hashes) --
	// The two clear scopes only differ when both kinds are present at once, which is exactly the state
	// of every user upgrading from a build that had no side table. Its own fixture, because the block
	// above ends with everything wiped.
	{
		const mixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-mixed-'));
		const mixState = await run({
			dataDir: mixDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
		});
		const mixh = mixState.contentScriptMessageHandlers['harperCm'];
		const mixMeta = path.join(mixDir, 'dismissedMeta.json');
		const mixIgnore = path.join(mixDir, 'ignoredLints.json');
		const mixEntries = () => {
			try {
				return JSON.parse(fs.readFileSync(mixMeta, 'utf8')).entries;
			} catch {
				return [];
			}
		};
		const mixRaw = () => {
			try {
				return fs.readFileSync(mixIgnore, 'utf8');
			} catch {
				return '';
			}
		};
		const TEH = 'I saw teh cat.';
		const MODAL = 'We should of gone.';
		const dismiss = async (text, problemText) => {
			const lint = (await mixh({ type: 'lint', text })).find((l) => l.problemText === problemText);
			assert.ok(lint, `precondition: "${problemText}" is flagged`);
			await mixh({ type: 'ignoreLint', text, start: lint.start, end: lint.end, ruleName: lint.ruleName });
		};

		await test('clearDismissed("legacy") drops ONLY the unaccounted hashes, keeping every named one ignored', async () => {
			await dismiss(TEH, 'teh');
			await dismiss(MODAL, 'should of');
			const rows = mixEntries();
			assert.strictEqual(rows.length, 2, 'precondition: two named dismissals');
			const orphaned = rows.find((e) => e.problemText === 'teh');
			const named = rows.find((e) => e.problemText === 'should of');

			// A dismissal made before the side table existed: harper still holds its hashes, but nothing
			// readable names them, so the UI can only offer a bulk clear for them.
			fs.writeFileSync(mixMeta, dismissedLog.serializeEntries([named]), 'utf8');
			const snap = await mixh({ type: 'settings:snapshot', includeDescriptions: false });
			assert.strictEqual(snap.dismissed.entries.length, 1, 'one row still names its hashes');
			assert.strictEqual(snap.dismissed.legacyCount, orphaned.hashes.length, 'the rest count as legacy');

			const res = await mixh({ type: 'settings:clearDismissed', scope: 'legacy' });
			assert.strictEqual(res.legacy, orphaned.hashes.length, 'exactly the unaccounted hashes are dropped');
			assert.strictEqual(res.dismissals, 0, 'and no named dismissal is counted');

			// The direction is the whole point: inverting the keep-filter would un-suppress every
			// dismissal the user can see and name, while leaving the un-nameable ones in force forever.
			assert.ok(
				(await mixh({ type: 'lint', text: TEH })).some((l) => l.problemText === 'teh'),
				'the legacy dismissal is gone, so its finding is flagged again',
			);
			assert.strictEqual(
				(await mixh({ type: 'lint', text: MODAL })).filter((l) => l.problemText === 'should of').length,
				0,
				'and the NAMED dismissal is still suppressed',
			);
			assert.deepStrictEqual(
				dismissedLog.extractHashes(mixRaw()).slice().sort(),
				named.hashes.slice().sort(),
				'harper is holding exactly the named row\'s hashes, byte-identically',
			);
			assert.deepStrictEqual(mixEntries().map((e) => e.id), [named.id], 'the row itself is untouched');
			assert.strictEqual(
				(await mixh({ type: 'settings:restoreDismissed', id: named.id })).ok,
				true,
				'and it is still individually restorable',
			);
		});

		await test('clearDismissed("all") reports DISMISSALS, not the several ignore hashes each one made', async () => {
			await dismiss(TEH, 'teh');
			await dismiss(MODAL, 'should of');
			const rows = mixEntries();
			const legacy = dismissedLog.legacyCount(mixRaw(), rows);
			const hashes = dismissedLog.extractHashes(mixRaw());
			// A single user-visible Dismiss ignores every finding on the span, one at a time — that is
			// what the 20-pass loop is for — so the two units genuinely differ. If harper ever stopped
			// producing several hashes per dismissal this would fail loudly rather than test nothing.
			assert.ok(
				hashes.length > rows.length + legacy,
				`precondition: at least one dismissal produced several hashes (${hashes.length} hashes for ${rows.length} rows)`,
			);

			const res = await mixh({ type: 'settings:clearDismissed', scope: 'all' });
			// TWO units, reported separately — no invented total. A row is one Dismiss; a legacy hash is
			// one ignored finding, and several of them can come from a single Dismiss.
			assert.strictEqual(res.dismissals, rows.length, 'rows are counted as dismissals');
			assert.strictEqual(res.legacy, legacy, 'unattributed hashes are counted as legacy findings');
			assert.deepStrictEqual(dismissedLog.extractHashes(mixRaw()), [], 'and everything really was cleared');
			assert.deepStrictEqual(mixEntries(), [], 'side table included');
		});
	}

	// ---- integration: repointing the dictionary mid-pass must not corrupt the new note ----
	// `cfg` is a mutable module singleton the settings onChange handler rewrites in place. A pass used
	// to read the note id at READ time and again at WRITE time, so a repoint landing in between put the
	// OLD note's merged body straight over the NEWLY-POINTED note — and then committed a merge base
	// over the `''` that resetSyncBase had just written, which is the one thing making a repoint safe.
	{
		const rpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-repoint-'));
		const rpState = await run({
			dataDir: rpDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'note1' },
			notes: {
				note1: { id: 'note1', body: '# h\n\nAlpharp\nBetarp\n', updated_time: 100 },
				// The user's OTHER note, which they are about to point the setting at. Its body is
				// ordinary prose — this is the content the old pass used to destroy.
				note2: {
					id: 'note2',
					body: '# My other dictionary note\n\nMyveryownwordrp\nSecondownwordrp\n',
					updated_time: 200,
				},
			},
		});
		const rph = rpState.contentScriptMessageHandlers['harperCm'];

		await test('repointing the dictionary note mid-pass writes nothing to the newly-pointed note', async () => {
			assert.ok(
				await waitFor(() => (rpState.settings.syncBase || '').includes('Alpharp')),
				'precondition: converged against note1',
			);
			await rph({ type: 'lint', text: 'warm the engine' });
			const note2Before = rpState.notes.note2.body;

			// A word buffered but not yet folded in, so the pass in flight has a note write to perform.
			await rpState.setSetting('pendingWords', ['Buffrp']);

			// Park a pass at its dictionary-note read — a real suspension point, and the one the whole
			// window hangs off. It has already resolved note1 as its side; everything after this is the
			// user repointing the setting underneath it.
			let release = null;
			let onParked = null;
			const parked = new Promise((resolve) => {
				onParked = resolve;
			});
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			rpState.beforeNoteGet = async (noteId) => {
				if (noteId !== 'note1') return;
				rpState.beforeNoteGet = null;
				onParked();
				await gate;
			};
			const pass = rpState.noteSelectionChangeHandler();
			await parked;

			// The user pastes the new note id on the General tab. This fires the plugin's own onChange:
			// cfg flips to note2 and resetSyncBase() writes '' so the next pass adopts note2's words
			// instead of reading them as deletions.
			const repoint = rpState.setSetting('dictionaryNoteId', 'note2');
			await settle();
			release();
			await Promise.all([pass, repoint]);
			await waitFor(() => false, 60); // let any follow-up pass settle

			// The parked pass was reconciling against note1, so none of ITS writes may land on note2.
			// (note2 legitimately gets rewritten afterwards by the repoint's own fresh pass, which
			// adopts note2's words as a first run — that pass is correct and expected. What must never
			// happen is note1's content arriving here.)
			assert.ok(
				rpState.notes.note2.body.includes('Myveryownwordrp') &&
					rpState.notes.note2.body.includes('Secondownwordrp'),
				'the newly-pointed note keeps its OWN words: ' + JSON.stringify(rpState.notes.note2.body),
			);
			assert.ok(
				!rpState.notes.note2.body.includes('Alpharp') && !rpState.notes.note2.body.includes('Betarp'),
				'and note1\'s words were never written over it: ' + JSON.stringify(rpState.notes.note2.body),
			);
			assert.ok(note2Before.includes('Myveryownwordrp'), 'sanity: the fixture had its own content');

			// The base is the other half of the damage. `resetSyncBase()` writes '' on a repoint so the
			// next pass is a FIRST RUN that adopts the new side's words instead of inferring deletions
			// from them; an abandoned pass committing its note1 base over that would make every word
			// note2 lacks look deleted on the very next reconcile.
			const base = rpState.settings.syncBase || '';
			assert.ok(
				!base.includes('Alpharp') && !base.includes('Betarp'),
				'the merge base describes the new note, never the old one: ' + JSON.stringify(base),
			);
			// And the buffered word was not silently retired by a pass that never landed it.
			assert.ok(
				(rpState.settings.pendingWords || []).includes('Buffrp') ||
					rpState.notes.note2.body.includes('Buffrp'),
				'the buffered word is still queued (or was legitimately folded into the new note)',
			);
		});

	}

	// ---- integration: INV-A, no durable write may outlive its configuration ----
	// The identity guard that shipped was a check-then-act: evaluated once, with four suspension points
	// (the note put, its updated_time get, the file rewrite, the base read) between it and the commit.
	// These two tests park a pass on either side of that guard.
	{
		const mkRepoint = async (name) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harper-${name}-`));
			const dictFile = path.join(dir, 'dict.txt');
			fs.writeFileSync(dictFile, 'Alpharp\nBetarp\n', 'utf8');
			const st = await run({
				dataDir: dir,
				installationDir: DIST_DIR,
				require: requireStub,
				versionInfo: { version: '3.6.14', platform: 'desktop' },
				initialSettings: { dictionaryNoteId: 'note1', dictionaryPath: dictFile },
				notes: {
					note1: { id: 'note1', body: '# h\n\nAlpharp\nBetarp\n', updated_time: 100 },
					note2: { id: 'note2', body: '# other\n\nMyveryownwordrp\n', updated_time: 200 },
				},
			});
			assert.ok(
				await waitFor(() => (st.settings.syncBase || '').includes('Alpharp')),
				'precondition: converged',
			);
			await st.contentScriptMessageHandlers['harperCm']({ type: 'lint', text: 'warm' });
			return { st, dictFile };
		};
		const gate = () => {
			let release = null;
			let onParked = null;
			const parked = new Promise((r) => {
				onParked = r;
			});
			const open = new Promise((r) => {
				release = r;
			});
			return { parked, open, onParked, release: () => release() };
		};

		await test('a pass repointed AFTER its guard still writes nothing (the check is at each write)', async () => {
			const { st, dictFile } = await mkRepoint('postguard');
			// Give the pass a note write to perform, then park it AT that write — i.e. already past any
			// up-front guard, with the file rewrite and the base commit still ahead of it.
			await st.setSetting('pendingWords', ['Buffrp']);
			const g = gate();
			st.beforeNotePut = async (noteId) => {
				if (noteId !== 'note1') return;
				st.beforeNotePut = null;
				g.onParked();
				await g.open;
			};
			const pass = st.noteSelectionChangeHandler();
			await g.parked;

			// The user repoints the dictionary note while the pass sits on its write. Given real time to
			// land, so the pass really is resumed into a world that has already moved.
			const repoint = st.setSetting('dictionaryNoteId', 'note2');
			await waitFor(() => false, 60);
			g.release();
			await Promise.all([pass, repoint]);
			await waitFor(() => false, 300);

			// Un-gated, the pass sailed on: it rewrote the user's external file to the new note's single
			// word and committed its stale base over the '' resetSyncBase had just written, so the next
			// reconcile read every missing word as a deletion.
			const fileNow = fs.readFileSync(dictFile, 'utf8');
			assert.ok(
				fileNow.includes('Alpharp') && fileNow.includes('Betarp'),
				`the external dictionary file keeps its words: ${JSON.stringify(fileNow)}`,
			);
			assert.ok(fileNow.includes('Myveryownwordrp'), 'and gains the newly-pointed note\'s word');
			const base = st.settings.syncBase || '';
			assert.ok(base.includes('Alpharp') && base.includes('Myveryownwordrp'), `base is the union: ${base}`);
		});

		await test('a pass that STARTS mid-repoint is born stale and writes nothing', async () => {
			const { st, dictFile } = await mkRepoint('basewindow');
			// Park the repoint INSIDE resetSyncBase, right before it writes ''. `cfg` already names
			// note2 while the base on disk still describes note1 — a world no snapshot can be
			// consistent with, and one no epoch comparison can detect, because nothing changes for the
			// duration of a pass that both starts and finishes inside it.
			const g = gate();
			st.beforeSettingWrite = async (key, value) => {
				if (key !== 'syncBase' || value !== '') return;
				st.beforeSettingWrite = null;
				g.onParked();
				await g.open;
			};
			const repoint = st.setSetting('dictionaryNoteId', 'note2');
			await g.parked;

			// Anything can start a reconcile here: the 60 s poll, or — as here — a note selection change.
			const pass = st.noteSelectionChangeHandler();
			await waitFor(() => false, 60); // let it run to completion inside the window
			g.release();
			await Promise.all([pass, repoint]);
			await waitFor(() => false, 300);

			const fileNow = fs.readFileSync(dictFile, 'utf8');
			assert.ok(
				fileNow.includes('Alpharp') && fileNow.includes('Betarp'),
				`the external dictionary file keeps its words: ${JSON.stringify(fileNow)}`,
			);
		});
	}

	// ---- integration: the epoch covers identity and base, and NOTHING else ----
	{
		const nrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-narrow-'));
		const nrFile = path.join(nrDir, 'dict.txt');
		fs.writeFileSync(nrFile, 'Zorbulon\nQuixnar\n', 'utf8');
		const nrState = await run({
			dataDir: nrDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'nrnote', dictionaryPath: nrFile },
			notes: { nrnote: { id: 'nrnote', body: '# h\n\nZorbulon\nQuixnar\n', updated_time: 100 } },
		});
		const nrh = nrState.contentScriptMessageHandlers['harperCm'];

		await test('a settings change that moves neither the dictionary nor the base does not abandon a pass', async () => {
			assert.ok(
				await waitFor(() => (nrState.settings.syncBase || '').includes('Zorbulon')),
				'precondition: converged',
			);
			await nrh({ type: 'lint', text: 'warm' });

			// The dictionary editor saves a new word; park its reconcile at the note read — one of the
			// suspension points the write gates exist for.
			let release = null;
			let onParked = null;
			const parked = new Promise((r) => {
				onParked = r;
			});
			const open = new Promise((r) => {
				release = r;
			});
			// A save reconciles TWICE: once to read the current list for the diff, then again inside
			// applyWordEdits to land the edit. It is the SECOND one that reaches the write gates, so
			// that is the one to park. Counting note reads is exact — nothing else reads this note
			// while the save is running.
			let noteReads = 0;
			nrState.beforeNoteGet = async (noteId) => {
				if (noteId !== 'nrnote') return;
				noteReads += 1;
				if (noteReads < 2) return;
				nrState.beforeNoteGet = null;
				onParked();
				await open;
			};
			const save = nrh({
				type: 'settings:saveDictionary',
				words: ['Zorbulon', 'Quixnar', 'Newword'],
				baseline: ['Quixnar', 'Zorbulon'],
			});
			await parked;

			// Joplin's debounced onChange for an unrelated General-tab toggle lands in that window. It
			// moves no dictionary side and no merge base, so it has no business invalidating anything —
			// but the epoch bracket used to wrap every settings key, so the pass was abandoned and the
			// save replied with a word list missing the word it had just added. The dialog then re-seeded
			// its textarea AND its baseline from that reply, under "Saved. 1 added, 0 removed."
			// Fire the unrelated change and wait for its handler to actually REACH `loadSettings` —
			// deterministically, off the first settings read that function makes. A wall-clock sleep
			// here made this test flaky: too short and the handler had not run at all, so the test
			// proved nothing either way. In the pre-fix build the epoch bump happens BEFORE
			// loadSettings, so this signal guarantees the bump has landed by the time we release.
			let onHandlerRunning = null;
			const handlerRunning = new Promise((r) => {
				onHandlerRunning = r;
			});
			nrState.beforeSettingRead = async (key) => {
				if (key !== 'enabled') return;
				nrState.beforeSettingRead = null;
				onHandlerRunning();
			};
			const unrelated = nrState.setSetting('ignoreNonEnglish', true);
			await handlerRunning;
			release();
			const reply = await save;
			await unrelated;

			assert.deepStrictEqual(reply.adds, ['Newword'], 'the save reports the addition');
			assert.ok(
				reply.words.includes('Newword'),
				`and its word list contains it: ${JSON.stringify(reply.words)}`,
			);
			assert.ok(nrState.notes.nrnote.body.includes('Newword'), 'the note really has it');
			assert.ok(fs.readFileSync(nrFile, 'utf8').includes('Newword'), 'and so does the file');

			await nrState.setSetting('ignoreNonEnglish', false);
		});

		await test('a reconcile started inside the loadSettings window writes nothing', async () => {
			// THE DIRECTION THE NARROWING COULD BREAK. `loadSettings` rewrites cfg through eight
			// sequential reads, and the dictionary identity flips partway through — so between that
			// flip and `resetSyncBase` the configuration names the NEW note while the merge base still
			// describes the old one. A pass starting there reads a pair that was never simultaneously
			// true, and nothing changes for its duration, so no epoch COMPARISON can catch it: only the
			// bracket marking the whole span as a transition does. Parking at a durable write instead
			// would prove nothing, because the identity comparison in passIsStale catches a repoint
			// there whether or not the epoch is involved at all.
			nrState.notes.nrwindow = { id: 'nrwindow', body: '# other\n\nWindowwordnr\n', updated_time: 400 };
			assert.ok(
				await waitFor(() => (nrState.settings.syncBase || '').includes('Newword')),
				'precondition: settled on the current note',
			);
			const fileBefore = fs.readFileSync(nrFile, 'utf8');
			assert.ok(fileBefore.includes('Zorbulon') && fileBefore.includes('Quixnar'));

			// Park inside loadSettings, on the read that follows dictionaryNoteId.
			let release2 = null;
			let onParked2 = null;
			const parked2 = new Promise((r) => {
				onParked2 = r;
			});
			const open2 = new Promise((r) => {
				release2 = r;
			});
			nrState.beforeSettingRead = async (key) => {
				if (key !== 'ruleOverrides') return;
				nrState.beforeSettingRead = null; // park once; the competing pass must run freely
				onParked2();
				await open2;
			};
			const repoint = nrState.setSetting('dictionaryNoteId', 'nrwindow');
			await parked2;

			// A reconcile starting in that window — the 60 s poll, or a note selection change.
			await nrState.noteSelectionChangeHandler();

			release2();
			await repoint;
			await waitFor(() => false, 200);

			// Without the bracket the pass merges the NEW note against the OLD base, reads every word
			// the new note lacks as a deletion, and truncates the user's external dictionary file.
			const fileAfter = fs.readFileSync(nrFile, 'utf8');
			assert.ok(
				fileAfter.includes('Zorbulon') && fileAfter.includes('Quixnar'),
				`the external dictionary file keeps its words: ${JSON.stringify(fileAfter)}`,
			);
			// ...and the base ends up describing the union the repoint's own fresh pass adopts, never
			// the shrunken set the abandoned pass computed.
			const baseAfter = nrState.settings.syncBase || '';
			assert.ok(
				baseAfter.includes('Zorbulon') && baseAfter.includes('Windowwordnr'),
				`the merge base is the first-run union: ${baseAfter}`,
			);
		});
	}

	// ---- integration: a stale pass publishes NOTHING, engine state included ----
	{
		const spDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-stalepub-'));
		const spFile = path.join(spDir, 'dict.txt');
		fs.writeFileSync(spFile, 'Alphasp\nBetasp\n', 'utf8');
		const spState = await run({
			dataDir: spDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'spnote', dictionaryPath: spFile },
			notes: { spnote: { id: 'spnote', body: '# h\n\nAlphasp\nBetasp\n', updated_time: 100 } },
		});
		const sph = spState.contentScriptMessageHandlers['harperCm'];

		await test('applyConfiguration does not publish a stale pass into the engine either', async () => {
			// THE SECOND ENGINE-PUBLISH SITE. `reconcileAndApply` is not the only caller of
			// importWordsIntoLinter — `applyConfiguration` is the other, and it is the one the settings
			// onChange handler uses for every key. Guarding only the first left the exact failure the
			// flag exists for still reachable: a stale pass clear-then-importing over a word `addWord`
			// had just put into the engine directly.
			const acDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-applyconf-'));
			const acFile = path.join(acDir, 'dict.txt');
			fs.writeFileSync(acFile, 'Alphaac\nBetaac\n', 'utf8');
			const acState = await run({
				dataDir: acDir,
				installationDir: DIST_DIR,
				require: requireStub,
				versionInfo: { version: '3.6.14', platform: 'desktop' },
				initialSettings: { dictionaryNoteId: 'acnote', dictionaryPath: acFile },
				notes: {
					acnote: { id: 'acnote', body: '# h\n\nAlphaac\nBetaac\n', updated_time: 100 },
					acother: { id: 'acother', body: '# other\n\nOtherac\n', updated_time: 200 },
				},
			});
			const ach = acState.contentScriptMessageHandlers['harperCm'];
			assert.ok(
				await waitFor(() => (acState.settings.syncBase || '').includes('Alphaac')),
				'precondition: converged',
			);
			// An editor is open, so the note write is L3-deferred and no durable-write gate is reached —
			// the pass falls all the way through to the engine publish.
			await ach({ type: 'getConfig' });
			await ach({ type: 'addWord', word: 'Gammaac' });
			assert.strictEqual(
				(await ach({ type: 'lint', text: 'Gammaac is fine.' })).length,
				0,
				'precondition: the freshly added word is accepted',
			);

			// An UNRELATED key change routes through applyConfiguration too, and `addWord` has already
			// nulled importedWordsKey, so the clobbering import cannot be skipped by the memo. A
			// dialect change would also reach here, but it rebuilds the WASM instance and empties the
			// engine outright, which would mask the thing under test. Park the pass it starts.
			let releasePass = null;
			let onPassParked = null;
			const passParked = new Promise((r) => {
				onPassParked = r;
			});
			const passOpen = new Promise((r) => {
				releasePass = r;
			});
			acState.beforeNoteGet = async (noteId) => {
				if (noteId !== 'acnote') return;
				acState.beforeNoteGet = null;
				onPassParked();
				await passOpen;
			};
			const unrelated = acState.setSetting('underlineStyle', 'solid');
			await passParked;

			// Repoint the dictionary while that pass is parked, so it comes back stale. Parked inside
			// resetSyncBase so the two handler invocations genuinely overlap.
			let releaseRepoint = null;
			let onRepointParked = null;
			const repointParked = new Promise((r) => {
				onRepointParked = r;
			});
			const repointOpen = new Promise((r) => {
				releaseRepoint = r;
			});
			acState.beforeSettingWrite = async (key, value) => {
				if (key !== 'syncBase' || value !== '') return;
				acState.beforeSettingWrite = null;
				onRepointParked();
				await repointOpen;
			};
			const repoint = acState.setSetting('dictionaryNoteId', 'acother');
			await repointParked;

			// The stale pass now resolves and applyConfiguration decides whether to publish it. Awaiting
			// the settings write itself is the deterministic signal that its handler has finished.
			releasePass();
			await unrelated;
			const flagged = (await ach({ type: 'lint', text: 'Gammaac is fine.' })).map((l) => l.problemText);
			assert.deepStrictEqual(
				flagged,
				[],
				`the engine still holds the word addWord imported directly: ${JSON.stringify(flagged)}`,
			);

			releaseRepoint();
			await repoint;
		});

		await test('a born-stale pass does not push its phantom word set into the live engine', async () => {
			assert.ok(
				await waitFor(() => (spState.settings.syncBase || '').includes('Alphasp')),
				'precondition: converged',
			);
			// An editor is open — the normal state, and what makes the note write L3-deferred so that
			// NONE of the durable-write gates is reached. The pass then used to fall straight through
			// and clear-then-import a merge computed against a configuration that no longer exists.
			await sph({ type: 'getConfig' });
			assert.strictEqual(
				(await sph({ type: 'lint', text: 'Alphasp and Betasp are fine.' })).length,
				0,
				'precondition: both custom words are accepted',
			);

			// A word imported STRAIGHT into the engine by add-to-dictionary, which also nulls the
			// re-import memo. This is what makes the test discriminate the `published` flag rather than
			// just the phantom list: with the flag gone, the abandoned pass's `.words` (the previous
			// good list, which predates this add) is clear-then-imported and takes the word back out.
			await sph({ type: 'addWord', word: 'Deltasp' });
			assert.strictEqual(
				(await sph({ type: 'lint', text: 'Deltasp is fine.' })).length,
				0,
				'precondition: the freshly added word is accepted',
			);

			// Repoint the external file to one holding only Alphasp, parked inside resetSyncBase — the
			// documented born-stale window.
			const otherFile = path.join(spDir, 'other.txt');
			fs.writeFileSync(otherFile, 'Alphasp\n', 'utf8');
			let release = null;
			let onParked = null;
			const parked = new Promise((r) => {
				onParked = r;
			});
			const open = new Promise((r) => {
				release = r;
			});
			spState.beforeSettingWrite = async (key, value) => {
				if (key !== 'syncBase' || value !== '') return;
				spState.beforeSettingWrite = null;
				onParked();
				await open;
			};
			const repoint = spState.setSetting('dictionaryPath', otherFile);
			await parked;

			// The 60 s poll ticks inside the window and reconciles.
			const tick = spState.intervals.find((i) => i.ms === 60000 && !i.cleared);
			tick.fn();
			await waitFor(() => false, 80);

			// The phantom: a deletion inferred from a base belonging to the configuration that has just
			// gone away. Nothing durable moved — but the engine used to be handed it anyway, so a lint
			// landing here flagged a word nobody had deleted.
			const flagged = (await sph({
				type: 'lint',
				text: 'Alphasp and Betasp and Deltasp are fine.',
			})).map((l) => l.problemText);
			assert.deepStrictEqual(
				flagged,
				[],
				`the engine still accepts every word it did before the window: ${JSON.stringify(flagged)}`,
			);

			release();
			await repoint;
			await waitFor(() => false, 300);
			assert.strictEqual(spState.notePuts.length, 0, 'and the stale pass wrote nothing durable either');
		});
	}

	// ---- integration: INV-B, destroying the engine's ignore set is transactional ----
	{
		const dlDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-dialectwipe-'));
		const dwState = await run({
			dataDir: dlDir2,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'dwnote' },
			notes: { dwnote: { id: 'dwnote', body: '# h\n\nKeepdw\n', updated_time: 100 } },
		});
		const dwh = dwState.contentScriptMessageHandlers['harperCm'];
		const dwIgnore = path.join(dlDir2, 'ignoredLints.json');
		const dwRaw = () => {
			try {
				return fs.readFileSync(dwIgnore, 'utf8');
			} catch {
				return '';
			}
		};

		await test('a Dismiss during a dialect change cannot wipe the dismissals already persisted', async () => {
			const TEXT_A = 'I saw teh cat.';
			const TEXT_B = 'We should of gone.';
			const first = (await dwh({ type: 'lint', text: TEXT_A })).find((l) => l.problemText === 'teh');
			assert.ok(first, 'precondition: "teh" is flagged');
			await dwh({ type: 'ignoreLint', text: TEXT_A, start: first.start, end: first.end, ruleName: first.ruleName });
			const before = dismissedLog.extractHashes(dwRaw());
			assert.ok(before.length >= 1, 'precondition: the first dismissal is persisted');

			const second = (await dwh({ type: 'lint', text: TEXT_B })).find((l) => l.problemText === 'should of');
			assert.ok(second, 'precondition: "should of" is flagged');

			// setDialect frees the WASM instance and builds a new one, so it destroys the engine's
			// IGNORE SET too. Park the reconcile that follows it, which is where applyConfiguration used
			// to re-hydrate — leaving a long window with an empty engine and a full payload.
			let release = null;
			let onParked = null;
			const parked = new Promise((r) => {
				onParked = r;
			});
			const open = new Promise((r) => {
				release = r;
			});
			dwState.beforeNoteGet = async (noteId) => {
				if (noteId !== 'dwnote') return;
				dwState.beforeNoteGet = null;
				onParked();
				await open;
			};
			const dialect = dwState.setSetting('dialect', 'British');
			await parked;

			// A Dismiss from the content-script channel, in that window.
			const dismiss = dwh({
				type: 'ignoreLint',
				text: TEXT_B,
				start: second.start,
				end: second.end,
				ruleName: second.ruleName,
			});
			await waitFor(() => false, 60);
			release();
			await Promise.all([dialect, dismiss]);
			await waitFor(() => false, 200);

			// Persisting used to MIRROR the engine, so a Dismiss meeting a gutted engine wrote back only
			// its own hash and destroyed every earlier dismissal — permanently, across restarts, while
			// the side table went on listing rows for findings harper no longer ignores.
			const after = new Set(dismissedLog.extractHashes(dwRaw()));
			for (const hash of before) {
				assert.ok(hash && after.has(hash), `the earlier dismissal's hash ${hash} is still persisted`);
			}
			assert.strictEqual(
				dismissedLog.legacyCount(dwRaw(), dismissedLog.parseEntries(fs.readFileSync(path.join(dlDir2, 'dismissedMeta.json'), 'utf8'))),
				0,
				'and the side table and the payload still agree',
			);
			assert.strictEqual(
				(await dwh({ type: 'lint', text: TEXT_A })).filter((l) => l.problemText === 'teh').length,
				0,
				'the first dismissal is still in force',
			);
		});
	}

	// ---- integration: a dismissal is ONE transaction over all three of its pieces ----
	// harper's in-engine ignore set, the persisted payload mirroring it, and the side table only mean
	// anything together. Locking just the side table left the payload half racing, which reproduced the
	// very failure the lock was added to stop.
	{
		const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-tx-'));
		const txState = await run({
			dataDir: txDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
		});
		const txh = txState.contentScriptMessageHandlers['harperCm'];
		const txMeta = path.join(txDir, 'dismissedMeta.json');
		const txIgnore = path.join(txDir, 'ignoredLints.json');
		const txEntries = () => {
			try {
				return JSON.parse(fs.readFileSync(txMeta, 'utf8')).entries;
			} catch {
				return [];
			}
		};
		const txRaw = () => {
			try {
				return fs.readFileSync(txIgnore, 'utf8');
			} catch {
				return '';
			}
		};
		const TX_A = 'I saw teh cat.';
		const TX_B = 'We should of gone.';
		const txDismiss = async (text, problem) => {
			const lint = (await txh({ type: 'lint', text })).find((l) => l.problemText === problem);
			assert.ok(lint, 'precondition: "' + problem + '" is flagged');
			await txh({ type: 'ignoreLint', text, start: lint.start, end: lint.end, ruleName: lint.ruleName });
			return lint;
		};

		await test('two Restores at once both land: neither leaves an orphaned, un-restorable hash', async () => {
			await txDismiss(TX_A, 'teh');
			await txDismiss(TX_B, 'should of');
			const rows = txEntries();
			assert.strictEqual(rows.length, 2, 'precondition: two named dismissals');

			// Each Restore button disables only ITSELF, so two rows really are independently clickable —
			// and nothing upstream serializes the dialog channel.
			const replies = await Promise.all([
				txh({ type: 'settings:restoreDismissed', id: rows[0].id }),
				txh({ type: 'settings:restoreDismissed', id: rows[1].id }),
			]);
			assert.ok(replies[0].ok && replies[1].ok, 'both restores report success');

			// Both read the payload before either persisted, so the second rebuilt the ignore set from
			// ITS stale copy and put the first entry's hash back — while both rows were correctly removed
			// under the side-table lock. The finding stayed suppressed forever, no longer restorable, and
			// resurfaced as an unnameable "legacy" entry only the destructive bulk clear can remove.
			assert.deepStrictEqual(
				dismissedLog.extractHashes(txRaw()),
				[],
				'no hash survives a restore that reported success',
			);
			assert.deepStrictEqual(txEntries(), [], 'and both rows are gone');
			assert.strictEqual(
				dismissedLog.legacyCount(txRaw(), txEntries()),
				0,
				'nothing was orphaned into an un-restorable legacy entry',
			);
			assert.ok(
				(await txh({ type: 'lint', text: TX_A })).some((l) => l.problemText === 'teh'),
				'"teh" is flagged again, as its restore promised',
			);
			assert.ok(
				(await txh({ type: 'lint', text: TX_B })).some((l) => l.problemText === 'should of'),
				'"should of" is flagged again too',
			);
		});

		await test('a dismissal racing a Restore does not lose its brand-new hash', async () => {
			// CROSS-CHANNEL. `ignoreFinding` writes the very payload the dialog's Restore rewrites, but
			// from the content-script channel, so a lock that covered only the dialog's own sends would
			// not touch this. The mobile fixture is used because there the payload lives in a SETTING,
			// which lets the restore be parked between reading it and writing it back — the window the
			// whole failure lives in.
			const xDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-xchan-'));
			const xState = await run({
				dataDir: xDir,
				installationDir: DIST_DIR,
				require: (name) => {
					throw new Error(`mobile must not require(${name})`);
				},
				versionInfo: { version: '3.7.2', platform: 'mobile' },
			});
			const xh = xState.contentScriptMessageHandlers['harperCm'];
			const TEXT_A = 'I saw teh cat.';
			const TEXT_B = 'We should of gone.';

			const first = (await xh({ type: 'lint', text: TEXT_A })).find((l) => l.problemText === 'teh');
			assert.ok(first, 'precondition: "teh" is flagged');
			await xh({ type: 'ignoreLint', text: TEXT_A, start: first.start, end: first.end, ruleName: first.ruleName });
			const row = dismissedLog.parseEntries(xState.settings.dismissedMeta)[0];
			assert.ok(row, 'precondition: the dismissal was recorded');

			const second = (await xh({ type: 'lint', text: TEXT_B })).find((l) => l.problemText === 'should of');
			assert.ok(second, 'precondition: "should of" is flagged');

			// Park the Restore with its keep-set already computed but not yet written back.
			let release = null;
			let onParked = null;
			const parked = new Promise((resolve) => {
				onParked = resolve;
			});
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			xState.beforeSettingWrite = async (key) => {
				if (key !== 'ignoredLints') return;
				xState.beforeSettingWrite = null;
				onParked();
				await gate;
			};
			const restore = xh({ type: 'settings:restoreDismissed', id: row.id });
			await parked;

			// The user dismisses something else right then. Against a correct implementation it CANNOT
			// complete here — it has to queue behind the restore's transaction.
			// A single Dismiss can produce SEVERAL hashes, so this watches for a hash that was not
			// there before rather than for a count.
			const beforeHashes = new Set(dismissedLog.extractHashes(xState.settings.ignoredLints || ''));
			const dismiss = xh({
				type: 'ignoreLint',
				text: TEXT_B,
				start: second.start,
				end: second.end,
				ruleName: second.ruleName,
			});
			const raced = await waitFor(
				() =>
					dismissedLog
						.extractHashes(xState.settings.ignoredLints || '')
						.some((h) => !beforeHashes.has(h)),
				300,
			);

			release();
			await Promise.all([restore, dismiss]);

			// Un-serialized, the restore exported harper's state BEFORE the park and wrote that stale
			// string afterwards, straight over the payload the dismissal had just persisted. The engine
			// still holds the hash for the rest of the session, so nothing looks wrong until the next
			// start — when the dismissal simply is not there any more. So the invariant to assert is
			// that the side table and the PERSISTED payload still agree.
			const persisted = new Set(dismissedLog.extractHashes(xState.settings.ignoredLints || ''));
			for (const entry of dismissedLog.parseEntries(xState.settings.dismissedMeta)) {
				for (const hash of entry.hashes) {
					assert.ok(
						persisted.has(hash),
						`the row for "${entry.problemText}" still has its hash in the persisted payload ` +
							`(it would be silently un-dismissed on the next start)`,
					);
				}
			}

			assert.strictEqual(
				(await xh({ type: 'lint', text: TEXT_B })).filter((l) => l.problemText === 'should of').length,
				0,
				'the dismissal made during the restore actually took effect',
			);
			assert.ok(
				(await xh({ type: 'lint', text: TEXT_A })).some((l) => l.problemText === 'teh'),
				'and the restore did too',
			);
			assert.strictEqual(
				dismissedLog.legacyCount(
					xState.settings.ignoredLints || '',
					dismissedLog.parseEntries(xState.settings.dismissedMeta),
				),
				0,
				'every surviving hash is still named by a row, and every row still has its hash',
			);
			// Asserted last, so the reported failure is the lost dismissal rather than the mechanism.
			assert.strictEqual(raced, false, 'the dismissal queued behind the restore instead of racing it');
		});
	}

	// ---- integration: a stale dialog cannot resurrect a word deleted elsewhere ----
	{
		const rsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-resurrect-'));
		const rsState = await run({
			dataDir: rsDir,
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
			initialSettings: { dictionaryNoteId: 'rsnote' },
			notes: { rsnote: { id: 'rsnote', body: '# h\n\nAlpharx\nBetarx\nCharlirx\n', updated_time: 100 } },
		});
		const rsh = rsState.contentScriptMessageHandlers['harperCm'];
		const rspoll = () => rsState.intervals.find((i) => i.ms === 60000 && !i.cleared).fn();

		await test('dictionary editor: a save does not re-add a word deleted elsewhere since the editor was seeded', async () => {
			assert.ok(
				await waitFor(() => (rsState.settings.syncBase || '').includes('Charlirx')),
				'precondition: converged',
			);
			// What the dialog cached when it loaded. Nothing pushes dictionary changes into an open
			// dialog, so this stays on screen for as long as the dialog is open.
			const baseline = (await rsh({ type: 'settings:snapshot', includeDescriptions: false })).dictionaryWords;
			assert.ok(baseline.includes('Charlirx'), 'precondition: the editor was seeded with Charlirx');

			// Another device deletes Charlirx; the 60 s poll folds the sync in. No race, just an open
			// dialog and wall-clock time.
			rsState.notes.rsnote.body = '# h\n\nAlpharx\nBetarx\n';
			rsState.notes.rsnote.updated_time += 100;
			rspoll();
			assert.ok(await waitFor(() => !(rsState.settings.syncBase || '').includes('Charlirx')));

			// The user types one new word into the still-stale textarea and saves.
			const res = await rsh({
				type: 'settings:saveDictionary',
				words: baseline.concat(['Deltarx']),
				baseline: baseline,
			});

			// An add is NOT the harmless direction: a pendingWords entry outranks an inferred deletion
			// by design and cancels a queued removal outright, so Charlirx would be written back into
			// the note and synced to every device — silently undoing the deletion.
			assert.deepStrictEqual(res.adds, ['Deltarx'], 'only the word the user actually typed is added');
			assert.ok(!res.words.includes('Charlirx'), 'the deleted word stays deleted');
			assert.ok(!rsState.notes.rsnote.body.includes('Charlirx'), 'and is not written back into the note');
			assert.ok(rsState.notes.rsnote.body.includes('Deltarx'), 'while the real addition lands');
			assert.ok(
				(await rsh({ type: 'lint', text: 'I said Charlirx today.' })).some((l) => l.problemText === 'Charlirx'),
				'the engine flags it again, as the deletion asked',
			);
		});
	}

	// ---- integration: ignoreNonEnglish actually suppresses non-English text ---
	{
		const neState = await run({
			dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harper-nonenglish-')),
			installationDir: DIST_DIR,
			require: requireStub,
			versionInfo: { version: '3.6.14', platform: 'desktop' },
		});
		const neh = neState.contentScriptMessageHandlers['harperCm'];
		// A multilingual note: a French paragraph that harper's English rules have plenty to say about,
		// and an English one with two genuine errors that must survive the isolation. The paragraph
		// break matters — harper isolates by span, and a one-clause English tail inside a French
		// paragraph is (correctly) isolated away along with it.
		const MIXED =
			'Nous avons decide de partir tres tot ce matin, car la route est longue.\n\n' +
			'The report is finished and I beleive that we should of gone earlier than planned today.';

		await test('ignoreNonEnglish suppresses findings in non-English text (and is not merely a stored value)', async () => {
			const before = await neh({ type: 'lint', text: MIXED });
			assert.ok(before.length > 1, `precondition: the mixed note is flagged with the setting off (${before.length})`);

			await neh({ type: 'settings:updateSetting', key: 'ignoreNonEnglish', value: true });
			const after = await neh({ type: 'lint', text: MIXED });
			// The setting's ONLY effect is `isolateEnglish` in lintOptions(). Dropping that one property
			// left the value writing, reading back and echoing in the snapshot perfectly — the feature
			// simply did nothing, with the whole suite green.
			assert.ok(
				after.length < before.length,
				`the flag has to change what is reported: ${before.length} -> ${after.length}`,
			);
			assert.ok(
				after.some((l) => l.problemText === 'beleive') && after.some((l) => l.problemText === 'should of'),
				`the English errors are still caught — this isolates, it does not disable: ${JSON.stringify(after.map((l) => l.problemText))}`,
			);
			assert.ok(
				!after.some((l) => l.problemText === 'longue'),
				'while the French words are no longer reported as misspellings',
			);

			// The dismiss path must use the SAME options, or the span the user pointed at is not in the
			// finding set that loop searches and Dismiss silently does nothing while the flag is on.
			const target = after.find((l) => l.problemText === 'beleive');
			await neh({ type: 'ignoreLint', text: MIXED, start: target.start, end: target.end, ruleName: target.ruleName });
			assert.strictEqual(
				(await neh({ type: 'lint', text: MIXED })).filter((l) => l.problemText === 'beleive').length,
				0,
				'dismissing a finding works with ignoreNonEnglish on',
			);

			await neh({ type: 'settings:updateSetting', key: 'ignoreNonEnglish', value: false });
			const restored = await neh({ type: 'lint', text: MIXED });
			assert.ok(restored.length > after.length, 'turning it back off restores the non-English findings');
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
	//
	// Deliberately NO literal version here: package.json is the reference and the other three are
	// compared against it, so cutting a release never means editing this test. The shape guard below
	// keeps that strict -- without it, a version field that went missing everywhere would read as
	// undefined === undefined and pass vacuously.
	await test('version: package.json, manifest, and both package-lock fields agree', () => {
		const readJSON = (...rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...rel), 'utf8'));
		const pkg = readJSON('package.json');
		const manifest = readJSON('src', 'manifest.json');
		const lock = readJSON('package-lock.json');

		const expected = pkg.version;
		assert.match(
			String(expected),
			/^\d+\.\d+\.\d+$/,
			`package.json version is the reference and must be a semver triple, got ${JSON.stringify(expected)}`,
		);

		const sources = [
			['src/manifest.json version', manifest.version],
			['package-lock.json top-level version', lock.version],
			['package-lock.json root package entry version', lock.packages[''].version],
		];
		for (const [label, actual] of sources) {
			assert.strictEqual(actual, expected, `${label} must match package.json version ${expected}`);
		}
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
