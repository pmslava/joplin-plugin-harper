import joplin from 'api';
import { ContentScriptType, SettingItemType, SettingStorage } from 'api/types';
import {
	LocalLinter,
	createBinaryModuleFromUrl,
	Dialect,
	Lint,
	LintConfig,
	SuggestionKind,
} from 'harper.js';

const CONTENT_SCRIPT_ID = 'harperCm';
const SECTION = 'harper';

/**
 * The plain-JSON shape sent back to the content script. WASM `Lint`/`Suggestion`
 * handles are NOT serializable across the plugin<->editor IPC boundary, so we flatten
 * them to plain objects here. Spans are already UTF-16 code-unit indices, so `start`/`end`
 * map straight onto CodeMirror `from`/`to`.
 */
export interface PlainSuggestion {
	kind: 'Replace' | 'Remove' | 'InsertAfter';
	replacementText: string;
}
export interface PlainLint {
	start: number;
	end: number;
	kind: string;
	/** Human-friendly kind label for the card title, e.g. "Spelling" (lint_kind_pretty()). */
	kindPretty: string;
	/** The harper rule name (organizedLints key) that produced this finding. */
	ruleName: string;
	message: string;
	/**
	 * Harper's markdown-rendered message (message_html()), e.g. `Did you mean to spell
	 * <code>CLAUDE</code> this way?`. Crosses postMessage as a plain-JSON string; the content
	 * script sanitizes it to an allowlist before innerHTML. This is what draws the word "chip".
	 */
	messageHtml: string;
	problemText: string;
	suggestions: PlainSuggestion[];
}

// ---- messages from the content script --------------------------------------
interface GetConfigMessage { type: 'getConfig'; }
interface LintMessage { type: 'lint'; text: string; }
interface AddWordMessage { type: 'addWord'; word: string; }
interface IgnoreLintMessage { type: 'ignoreLint'; text: string; start: number; end: number; ruleName: string; }
interface DisableRuleMessage { type: 'disableRule'; ruleName: string; }
type IncomingMessage =
	| GetConfigMessage
	| LintMessage
	| AddWordMessage
	| IgnoreLintMessage
	| DisableRuleMessage;

// webpack rewrites bare `require(...)` inside the bundle; __non_webpack_require__ emits a raw
// runtime `require` resolved by Node/Electron instead. The plugin main process runs with Node
// integration, so this gives us the real `fs`/`os`/`path` on desktop.
declare const __non_webpack_require__: (id: string) => any;

// -----------------------------------------------------------------------------
// Settings snapshot (kept fresh on start + on every settings change).
// -----------------------------------------------------------------------------
interface HarperConfig {
	enabled: boolean;
	dialect: string;
	debounceMs: number;
	dictionaryPath: string;
	ruleOverrides: string;
}
const cfg: HarperConfig = {
	enabled: true,
	dialect: 'American',
	debounceMs: 500,
	dictionaryPath: '',
	ruleOverrides: '',
};

const DIALECT_BY_NAME: Record<string, Dialect> = {
	American: Dialect.American,
	British: Dialect.British,
	Australian: Dialect.Australian,
	Canadian: Dialect.Canadian,
};

function dialectEnum(): Dialect {
	return DIALECT_BY_NAME[cfg.dialect] ?? Dialect.American;
}

async function loadSettings(): Promise<void> {
	const read = async (key: string, fallback: any) => {
		const v = await joplin.settings.value(key);
		return v === undefined || v === null ? fallback : v;
	};
	cfg.enabled = await read('enabled', true);
	cfg.dialect = await read('dialect', 'American');
	cfg.debounceMs = await read('debounceMs', 500);
	cfg.dictionaryPath = await read('dictionaryPath', '');
	cfg.ruleOverrides = await read('ruleOverrides', '');
}

// -----------------------------------------------------------------------------
// Filesystem helpers. Dictionary/ignore-state IO goes through the sanctioned
// `joplin.require('fs-extra')` bridge (works in the plugin main process, and is
// stubbable by the harness). Home-dir/path helpers use the raw Node modules
// (desktop-only, same constraint as the WASM loader).
// -----------------------------------------------------------------------------
function getFs(): any {
	return joplin.require('fs-extra');
}

function expandTilde(p: string): string {
	if (!p) return '';
	if (p === '~' || p.startsWith('~/')) {
		let home = '';
		try {
			home = __non_webpack_require__('os').homedir();
		} catch {
			home = process.env.HOME || process.env.USERPROFILE || '';
		}
		return p === '~' ? home : `${home}/${p.slice(2)}`;
	}
	return p;
}

function joinPath(dir: string, file: string): string {
	try {
		return __non_webpack_require__('path').join(dir, file);
	} catch {
		const sep = dir.endsWith('/') ? '' : '/';
		return `${dir}${sep}${file}`;
	}
}

async function localWordsPath(): Promise<string> {
	return joinPath(await joplin.plugins.dataDir(), 'userWords.txt');
}

async function ignoredLintsPath(): Promise<string> {
	return joinPath(await joplin.plugins.dataDir(), 'ignoredLints.json');
}

function parseWords(content: string): string[] {
	return content
		.split('\n')
		.map((line) => line.replace(/\r$/, '').trim())
		.filter((line) => line.length > 0);
}

// Last-seen mtime of the external dictionary; the 60s poll compares against it and
// only re-reads when it changes (so an unchanged file costs ZERO reads).
let lastExternalMtimeMs: number | null = null;
let warnedMissingDict = false;

function readExternalWords(): string[] {
	const p = expandTilde(cfg.dictionaryPath);
	if (!p) return [];
	const fs = getFs();
	try {
		const st = fs.statSync(p);
		lastExternalMtimeMs = st.mtimeMs;
		const content = fs.readFileSync(p, 'utf8');
		warnedMissingDict = false;
		return parseWords(content);
	} catch {
		if (!warnedMissingDict) {
			// eslint-disable-next-line no-console
			console.warn(`[harper] external dictionary not readable (yet): ${p} — treating as empty.`);
			warnedMissingDict = true;
		}
		return [];
	}
}

function readLocalWords(): string[] {
	const fs = getFs();
	try {
		// localWordsPath is async; read it eagerly via a cached value set in applyConfiguration.
		if (!cachedLocalWordsPath) return [];
		const content = fs.readFileSync(cachedLocalWordsPath, 'utf8');
		return parseWords(content);
	} catch {
		return [];
	}
}

let cachedLocalWordsPath = '';

function collectDictionaryWords(): string[] {
	const words = new Set<string>();
	for (const w of readExternalWords()) words.add(w);
	for (const w of readLocalWords()) words.add(w);
	return [...words];
}

// -----------------------------------------------------------------------------
// Rule overrides (advanced JSON setting).
// -----------------------------------------------------------------------------
let lastInvalidOverridesRaw: string | null = null;

function parseRuleOverrides(): LintConfig {
	const raw = (cfg.ruleOverrides || '').trim();
	if (!raw) return {};
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as LintConfig;
	} catch {
		/* fall through to warn */
	}
	if (raw !== lastInvalidOverridesRaw) {
		// eslint-disable-next-line no-console
		console.warn(`[harper] ruleOverrides is not a valid JSON object; ignoring: ${raw}`);
		lastInvalidOverridesRaw = raw;
	}
	return {};
}

// -----------------------------------------------------------------------------
// Linter lifecycle.
// -----------------------------------------------------------------------------
let linterPromise: Promise<LocalLinter> | null = null;

async function buildLinter(): Promise<LocalLinter> {
	// We ship the .wasm inside dist/ (webpack CopyPlugin). We do NOT hand harper.js a file://
	// URL: its file:// code path does a native `import('fs')`, which the Electron editor/plugin
	// renderer's Blink module loader cannot resolve. Instead we read the bytes ourselves via
	// Node's `require('fs')` and hand harper a data: URL, which `fetch()` supports in both Node
	// (undici) and the Electron renderer. See docs/research/phase0-spike-*.md.
	const installDir = await joplin.plugins.installationDir();
	const sep = installDir.endsWith('/') ? '' : '/';
	const wasmPath = `${installDir}${sep}harper_wasm_bg.wasm`;
	const fs = __non_webpack_require__('fs');
	const bytes: Buffer = fs.readFileSync(wasmPath);
	const dataUrl = `data:application/wasm;base64,${bytes.toString('base64')}`;
	const binary = createBinaryModuleFromUrl(dataUrl, 'full');
	const linter = new LocalLinter({ binary, dialect: dialectEnum() });
	await linter.setup();
	return linter;
}

/** (Re)apply dictionary words, rule overrides and ignored lints to a linter instance. */
async function applyConfiguration(linter: LocalLinter): Promise<void> {
	cachedLocalWordsPath = await localWordsPath();

	// Dictionary: clear-then-import handles deletions from the synced file.
	await linter.clearWords();
	const words = collectDictionaryWords();
	if (words.length) await linter.importWords(words);

	// Rule overrides on top of defaults.
	await linter.setLintConfig(parseRuleOverrides());

	// Ignored lints (persisted between sessions in dataDir). harper filters these internally on
	// every subsequent lint once imported, so no host-side filtering is needed.
	await linter.clearIgnoredLints();
	try {
		const fs = getFs();
		const ignored = fs.readFileSync(await ignoredLintsPath(), 'utf8');
		if (ignored && ignored.trim()) await linter.importIgnoredLints(ignored);
	} catch {
		/* no persisted ignore-state yet */
	}
}

async function getLinter(): Promise<LocalLinter> {
	if (!linterPromise) {
		linterPromise = (async () => {
			const linter = await buildLinter();
			await applyConfiguration(linter);
			return linter;
		})();
	}
	return linterPromise;
}

// -----------------------------------------------------------------------------
// Main -> editor re-lint poke.
// -----------------------------------------------------------------------------
async function pokeForceLint(): Promise<void> {
	try {
		await joplin.commands.execute('editor.execCommand', { name: 'harper.forceLint' });
	} catch {
		// No editor open (or the command is not registered yet) is fine.
	}
}

// -----------------------------------------------------------------------------
// Lint serialization.
// -----------------------------------------------------------------------------
function suggestionKindToString(kind: SuggestionKind): PlainSuggestion['kind'] {
	switch (kind) {
		case SuggestionKind.Remove:
			return 'Remove';
		case SuggestionKind.InsertAfter:
			return 'InsertAfter';
		case SuggestionKind.Replace:
		default:
			return 'Replace';
	}
}

function lintToPlain(lint: Lint, ruleName: string): PlainLint {
	const span = lint.span();
	const suggestions: PlainSuggestion[] = lint.suggestions().map((sug) => ({
		kind: suggestionKindToString(sug.kind()),
		replacementText: sug.get_replacement_text(),
	}));
	return {
		start: span.start,
		end: span.end,
		kind: lint.lint_kind(),
		kindPretty: lint.lint_kind_pretty(),
		ruleName,
		message: lint.message(),
		messageHtml: lint.message_html(),
		problemText: lint.get_problem_text(),
		suggestions,
	};
}

async function lintText(text: string): Promise<PlainLint[]> {
	const enabled = await joplin.settings.value('enabled');
	if (enabled === false) return [];
	const linter = await getLinter();
	const organized = await linter.organizedLints(text, { language: 'markdown' });
	const out: PlainLint[] = [];
	for (const [ruleName, lints] of Object.entries(organized)) {
		for (const lint of lints) out.push(lintToPlain(lint, ruleName));
	}
	return out;
}

// -----------------------------------------------------------------------------
// Tooltip-action handlers.
// -----------------------------------------------------------------------------
async function addWord(rawWord: string): Promise<void> {
	const word = (rawWord || '').trim();
	if (!word) return;
	const fs = getFs();
	const external = expandTilde(cfg.dictionaryPath);
	if (external) {
		try {
			fs.appendFileSync(external, `${word}\n`);
			// Record our own write so the poll doesn't treat it as an external change.
			try {
				lastExternalMtimeMs = fs.statSync(external).mtimeMs;
			} catch {
				/* ignore */
			}
		} catch {
			// eslint-disable-next-line no-console
			console.warn(`[harper] could not append to external dictionary: ${external}`);
		}
	} else {
		try {
			fs.appendFileSync(await localWordsPath(), `${word}\n`);
		} catch {
			// eslint-disable-next-line no-console
			console.warn('[harper] could not write plugin-local userWords.txt');
		}
	}
	const linter = await getLinter();
	await linter.importWords([word]);
	await pokeForceLint();
}

async function ignoreFinding(
	text: string,
	start: number,
	end: number,
	ruleName: string,
): Promise<void> {
	const linter = await getLinter();
	// harper stores an ignored lint by a context hash and filters it out of every SUBSEQUENT lint
	// itself — so we do not filter host-side. BUT: harper de-duplicates overlapping findings and
	// surfaces them one at a time (e.g. once the "The" typo lint on "teh" is ignored, a SpellCheck
	// lint on the exact same span appears). Ignoring the single clicked finding would therefore
	// leave the underline in place, just from a different rule. To make "Ignore" actually clear the
	// span the user pointed at, we ignore every finding on that exact span, re-linting after each
	// until the span is clear (bounded so a pathological doc can't spin forever). Tradeoff: two
	// genuinely distinct findings that share an identical span get ignored together — acceptable and
	// matches user intent ("make this underline go away").
	const matchSpan = (lint: Lint) => {
		const s = lint.span();
		return s.start === start && s.end === end;
	};
	let ignoredAny = false;
	for (let i = 0; i < 20; i++) {
		const organized = await linter.organizedLints(text, { language: 'markdown' });
		// Prefer the rule the user actually clicked, then any other rule on the same span.
		let target: Lint | undefined = (organized[ruleName] || []).find(matchSpan);
		if (!target) {
			for (const lints of Object.values(organized)) {
				const m = lints.find(matchSpan);
				if (m) {
					target = m;
					break;
				}
			}
		}
		if (!target) break;
		await linter.ignoreLint(text, target);
		ignoredAny = true;
	}
	if (ignoredAny) {
		try {
			const json = await linter.exportIgnoredLints();
			getFs().writeFileSync(await ignoredLintsPath(), json, 'utf8');
		} catch {
			// eslint-disable-next-line no-console
			console.warn('[harper] could not persist ignored lints');
		}
	}
	await pokeForceLint();
}

async function disableRule(ruleName: string): Promise<void> {
	if (!ruleName) return;
	const overrides = parseRuleOverrides();
	overrides[ruleName] = false;
	// Persist into the user-visible setting; this fires onChange, which reconfigures + pokes.
	await joplin.settings.setValue('ruleOverrides', JSON.stringify(overrides));
	// Apply directly too, so it takes effect even if onChange is debounced.
	const linter = await getLinter();
	await linter.setLintConfig(overrides);
	await pokeForceLint();
}

// -----------------------------------------------------------------------------
// Dictionary polling (60s): stat mtime; re-import only when it changed.
// -----------------------------------------------------------------------------
function pollDictionaryTick(): void {
	const p = expandTilde(cfg.dictionaryPath);
	if (!p) return;
	let st: any;
	try {
		st = getFs().statSync(p);
	} catch {
		// Still missing — keep polling; it may appear later (first rclone sync).
		return;
	}
	if (lastExternalMtimeMs !== null && st.mtimeMs === lastExternalMtimeMs) return; // ZERO reads
	// Changed (or first observation): re-import and force a re-lint.
	void (async () => {
		if (!linterPromise) return;
		const linter = await linterPromise;
		await applyConfiguration(linter);
		await pokeForceLint();
	})();
}

// -----------------------------------------------------------------------------
// Message handler.
// -----------------------------------------------------------------------------
async function handleMessage(message: IncomingMessage | unknown): Promise<unknown> {
	if (!message || typeof message !== 'object') return null;
	const msg = message as IncomingMessage;
	switch (msg.type) {
		case 'getConfig': {
			const enabled = await joplin.settings.value('enabled');
			const debounceMs = await joplin.settings.value('debounceMs');
			return {
				enabled: enabled !== false,
				debounceMs: typeof debounceMs === 'number' ? debounceMs : 500,
			};
		}
		case 'lint':
			return lintText(msg.text ?? '');
		case 'addWord':
			await addWord(msg.word);
			return { ok: true };
		case 'ignoreLint':
			await ignoreFinding(msg.text ?? '', msg.start, msg.end, msg.ruleName);
			return { ok: true };
		case 'disableRule':
			await disableRule(msg.ruleName);
			return { ok: true };
		default:
			return null;
	}
}

// -----------------------------------------------------------------------------
// Settings registration.
// -----------------------------------------------------------------------------
async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SECTION, {
		label: 'Harper',
		description: 'Harper grammar checker settings.',
		iconName: 'fas fa-spell-check',
	});
	await joplin.settings.registerSettings({
		enabled: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION,
			label: 'Enable Harper grammar checking',
			description: 'When off, no grammar/spelling underlines are shown.',
			storage: SettingStorage.File,
		},
		dialect: {
			value: 'American',
			type: SettingItemType.String,
			public: true,
			isEnum: true,
			section: SECTION,
			label: 'English dialect',
			description: 'Changing the dialect reconfigures the linter.',
			options: {
				American: 'American',
				British: 'British',
				Australian: 'Australian',
				Canadian: 'Canadian',
			},
			storage: SettingStorage.File,
		},
		debounceMs: {
			value: 500,
			type: SettingItemType.Int,
			public: true,
			section: SECTION,
			minimum: 0,
			maximum: 10000,
			step: 50,
			label: 'Lint debounce (ms)',
			description: 'Idle delay after typing before re-linting. Changes apply immediately.',
			storage: SettingStorage.File,
		},
		dictionaryPath: {
			value: '',
			type: SettingItemType.String,
			public: true,
			section: SECTION,
			label: 'External dictionary file',
			description:
				'Absolute path to a plain-text dictionary (one word per line), e.g. ' +
				'~/.local/share/harper-dictionary/dictionary.txt. Leave empty to use the plugin-local list. ' +
				'Words added via "Add to dictionary" are appended here when set. Re-read every 60s.',
			storage: SettingStorage.File,
		},
		ruleOverrides: {
			value: '',
			type: SettingItemType.String,
			public: true,
			advanced: true,
			section: SECTION,
			label: 'Rule overrides (JSON)',
			description:
				'A JSON object of {"RuleName": true|false} applied on top of the defaults, e.g. ' +
				'{"SpelledNumbers": false}. Invalid JSON is ignored.',
			storage: SettingStorage.File,
		},
	});
}

joplin.plugins.register({
	onStart: async () => {
		await registerSettings();
		await loadSettings();

		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			CONTENT_SCRIPT_ID,
			'./contentScript.js',
		);
		await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, handleMessage);

		// Reconfigure + re-lint whenever settings change.
		await joplin.settings.onChange(async ({ keys }) => {
			const before = cfg.dialect;
			await loadSettings();
			if (cfg.dictionaryPath === '' || keys.includes('dictionaryPath')) {
				// A changed path invalidates the cached mtime / missing-file warning.
				lastExternalMtimeMs = null;
				warnedMissingDict = false;
			}
			if (linterPromise) {
				const linter = await linterPromise;
				if (keys.includes('dialect') && cfg.dialect !== before) {
					await linter.setDialect(dialectEnum());
				}
				await applyConfiguration(linter);
			}
			await pokeForceLint();
		});

		// Poll the external dictionary for out-of-band (rclone) changes.
		setInterval(pollDictionaryTick, 60_000);
	},
});
