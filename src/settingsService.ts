/**
 * SETTINGS SERVICE — everything the Phase-2 settings dialog needs, as plain main-process functions.
 *
 * The dialog (rules browser, dictionary editor, dismissed-findings manager) is a webview and cannot
 * touch harper, the filesystem or Joplin settings directly. This module is the whole surface between
 * the two, and it deliberately knows NOTHING about webviews: no `joplin.views.*`, no postMessage, no
 * DOM. Phase 2 registers its own dialog `onMessage` and forwards straight to `handleMessage` below.
 *
 * Everything it needs from the plugin arrives through `SettingsServiceDeps`, so each function is
 * individually testable against fakes, and — more importantly — so the service can never quietly
 * fork the plugin's existing machinery. Three rules the deps enforce:
 *
 *   1. SETTINGS go through `joplin.settings.setValue`, never straight into `cfg`, so the existing
 *      `settings.onChange` handler does the reconfigure + multi-window poke it already does.
 *   2. DICTIONARY edits go through `applyWordEdits`, which routes into the same pending buffers and
 *      the same reconcile that add-to-dictionary uses — note/file mirroring and deletion propagation
 *      keep working, and nothing here re-implements them.
 *   3. Every mutation ends in `pokeForceLint()`, the existing generation-bump + execCommand pair, so
 *      unfocused note windows refresh too.
 *
 * See src/dismissedLog.ts for the u64 hash rules that the dismissed-findings half obeys.
 */

import { LintConfig, LocalLinter, StructuredLintConfig } from 'harper.js';
import {
	DismissedEntry,
	DismissedStore,
	buildIgnoredLintsPayload,
	clearDismissed,
	coveredHashes,
	extractHashes,
	hashesWithoutEntry,
	legacyCount,
	loadDismissed,
	removeDismissed,
} from './dismissedLog';

// =============================================================================
// Payload shapes (the dialog's contract).
// =============================================================================

/** The primitive settings the dialog renders directly. `dictionaryPath` is desktop-only. */
export interface PrimarySettings {
	enabled: boolean;
	dialect: string;
	debounceMs: number;
	underlineStyle: string;
	ignoreNonEnglish: boolean;
	dictionaryNoteId: string;
	/** Present on desktop only — the setting is not registered on mobile. */
	dictionaryPath?: string;
}

export interface DismissedSnapshot {
	entries: DismissedEntry[];
	/**
	 * Ignore hashes with no side-table entry — dismissals made before the side table existed. The UI
	 * shows them as a single "N legacy dismissals" row with a clear-only action (there is nothing
	 * readable to name them by, and no per-item restore is possible).
	 */
	legacyCount: number;
}

export interface SettingsSnapshot {
	/**
	 * harper's structured lint config: the GROUPING/ORDER/LABEL tree for the rules browser
	 * (15 groups in 2.7.0). Never read values from it — `Bool.state` is not the effective value.
	 */
	structured: StructuredLintConfig | null;
	/** The user's explicit overrides only (sparse). Absent key = "Default" in the tri-state UI. */
	flatConfig: LintConfig;
	/** Concrete booleans for all ~823 rules — what "Default" actually resolves to. */
	defaults: LintConfig;
	/** Rule name -> HTML description. Omitted (null) when the caller asked to skip it. */
	descriptionsHtml: Record<string, string> | null;
	settings: PrimarySettings;
	dictionaryWords: string[];
	dismissed: DismissedSnapshot;
}

export interface SettingsServiceDeps {
	getLinter(): Promise<LocalLinter>;
	/** The existing multi-window refresh: bump the config generation, then poke the focused editor. */
	pokeForceLint(): Promise<void>;
	getSetting(key: string): Promise<any>;
	setSetting(key: string, value: any): Promise<void>;
	isMobile(): boolean;
	/** harper's ignore payload, read/written VERBATIM (u64s — never re-serialize it). */
	loadIgnoredLintsRaw(): Promise<string>;
	saveIgnoredLintsRaw(json: string): Promise<void>;
	dismissedStore: DismissedStore;
	/** The reconciled word set the engine currently holds. */
	getEffectiveWords(): Promise<string[]>;
	/** Route adds/removes through the plugin's existing dictionary buffers + reconcile. */
	applyWordEdits(adds: string[], removes: string[]): Promise<void>;
	/** Accepted `dialect` values, so validation cannot drift from DIALECT_BY_NAME. */
	dialectNames: string[];
}

// =============================================================================
// Pure helpers (exported: index.ts reuses the parse so the two cannot diverge).
// =============================================================================

/**
 * Parse the `ruleOverrides` setting — the JSON object users have been hand-editing since v1.0.
 * Anything that is not a JSON object returns null so the caller can warn; `''` is a valid empty.
 */
export function parseRuleOverridesJson(raw: string): LintConfig | null {
	const text = (raw || '').trim();
	if (!text) return {};
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as LintConfig;
	} catch {
		/* fall through */
	}
	return null;
}

/**
 * Normalize a tri-state map from the UI into the SPARSE map harper and the setting both want.
 *
 * The rules browser models each rule as on / off / Default. "Default" is expressed by ABSENCE, not
 * by a null: `setLintConfig` replaces its map wholesale and treats every omitted key as default, and
 * the persisted setting has always meant "only what the user explicitly changed". So null/undefined
 * (and any non-boolean that reaches us) are DROPPED rather than stored.
 */
export function normalizeRuleOverrides(map: Record<string, boolean | null | undefined>): LintConfig {
	const out: LintConfig = {};
	for (const key of Object.keys(map || {})) {
		const value = map[key];
		if (typeof value !== 'boolean') continue;
		if (!key) continue;
		out[key] = value;
	}
	return out;
}

/** Sorted, deduped, blank-free — the canonical form for a word list coming out of the editor. */
export function normalizeWords(words: readonly string[]): string[] {
	const set = new Set<string>();
	for (const raw of words || []) {
		if (typeof raw !== 'string') continue;
		const word = raw.trim();
		if (word) set.add(word);
	}
	return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The add/remove diff a dictionary-editor save implies, against the current effective list. */
export function diffWords(
	current: readonly string[],
	next: readonly string[],
): { adds: string[]; removes: string[] } {
	const before = new Set(normalizeWords(current));
	const after = new Set(normalizeWords(next));
	return {
		adds: [...after].filter((w) => !before.has(w)),
		removes: [...before].filter((w) => !after.has(w)),
	};
}

/**
 * Display label for a rule name: "AmazonNames" -> "Amazon Names".
 *
 * Needed because harper 2.7.0 returns `label: null` for all 823 Bool nodes, so the rules browser has
 * nothing but the PascalCase name to show. Runs of capitals are kept together ("HTMLTags" ->
 * "HTML Tags") and digits are split off ("Covid19" -> "Covid 19").
 */
export function ruleDisplayLabel(name: string): string {
	if (!name) return '';
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.trim();
}

/** The settings `updateSetting` will write, and how each value is validated. */
const SETTING_VALIDATORS: Record<string, (value: unknown, deps: SettingsServiceDeps) => any> = {
	enabled: (v) => v === true,
	ignoreNonEnglish: (v) => v === true,
	dialect: (v, deps) => {
		if (typeof v !== 'string' || !deps.dialectNames.includes(v)) {
			throw new Error(`invalid dialect: ${String(v)}`);
		}
		return v;
	},
	debounceMs: (v) => {
		const n = typeof v === 'number' ? v : Number(v);
		if (!Number.isFinite(n)) throw new Error(`invalid debounceMs: ${String(v)}`);
		// Same bounds the registered setting declares, so the dialog cannot store an out-of-range
		// value the native settings page would refuse.
		return Math.min(10_000, Math.max(0, Math.round(n)));
	},
	underlineStyle: (v) => {
		if (v !== 'squiggly' && v !== 'solid') throw new Error(`invalid underlineStyle: ${String(v)}`);
		return v;
	},
	dictionaryNoteId: (v) => (typeof v === 'string' ? v.trim() : ''),
	dictionaryPath: (v, deps) => {
		// Not registered on mobile — writing it there throws "Unknown key" in real Joplin.
		if (deps.isMobile()) throw new Error('dictionaryPath is desktop-only');
		return typeof v === 'string' ? v : '';
	},
	ruleOverrides: (v) => {
		if (typeof v !== 'string') throw new Error('ruleOverrides must be a JSON string');
		if (parseRuleOverridesJson(v) === null) throw new Error('ruleOverrides is not a JSON object');
		return v;
	},
};

/** The keys `updateSetting` accepts. Anything else is rejected rather than written. */
export const UPDATABLE_SETTING_KEYS = Object.keys(SETTING_VALIDATORS);

// =============================================================================
// The service.
// =============================================================================

export interface SettingsService {
	getSettingsSnapshot(opts?: { includeDescriptions?: boolean }): Promise<SettingsSnapshot>;
	getRuleDescriptions(): Promise<Record<string, string>>;
	applyRuleOverrides(map: Record<string, boolean | null | undefined>): Promise<LintConfig>;
	resetRules(): Promise<LintConfig>;
	disableAllRules(): Promise<LintConfig>;
	updateSetting(key: string, value: unknown): Promise<void>;
	saveDictionaryWords(words: string[]): Promise<{ adds: string[]; removes: string[] }>;
	restoreDismissed(id: string): Promise<boolean>;
	clearDismissedFindings(scope: 'all' | 'legacy'): Promise<number>;
	/** One dispatcher for the Phase-2 dialog to forward its webview messages into. */
	handleMessage(message: unknown): Promise<unknown>;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
	/** Re-persist harper's ignore payload VERBATIM after a rebuild, and refresh every window. */
	async function persistIgnoreStateAndPoke(linter: LocalLinter): Promise<void> {
		await deps.saveIgnoredLintsRaw(await linter.exportIgnoredLints());
		await deps.pokeForceLint();
	}

	/**
	 * Rebuild harper's ignore set to exactly `keep`.
	 *
	 * `importIgnoredLints` merges and cannot remove, so the ONLY way to drop a hash is to clear
	 * everything and re-import what should survive. An empty keep-set skips the import (importing an
	 * empty payload is a documented no-op anyway).
	 */
	async function rebuildIgnoreState(linter: LocalLinter, keep: readonly string[]): Promise<void> {
		await linter.clearIgnoredLints();
		if (keep.length) await linter.importIgnoredLints(buildIgnoredLintsPayload(keep));
	}

	async function readPrimarySettings(): Promise<PrimarySettings> {
		// `0` is a legitimate debounce (lint immediately), so this cannot use `|| 500` — that would
		// show the dialog 500 for a user who deliberately set no delay, and saving would undo it.
		const rawDebounce = Number(await deps.getSetting('debounceMs'));
		const settings: PrimarySettings = {
			enabled: (await deps.getSetting('enabled')) !== false,
			dialect: (await deps.getSetting('dialect')) || 'American',
			debounceMs: Number.isFinite(rawDebounce) ? rawDebounce : 500,
			underlineStyle: (await deps.getSetting('underlineStyle')) === 'solid' ? 'solid' : 'squiggly',
			ignoreNonEnglish: (await deps.getSetting('ignoreNonEnglish')) === true,
			dictionaryNoteId: (await deps.getSetting('dictionaryNoteId')) || '',
		};
		// Reading an unregistered key throws in real Joplin, so mobile must not even ask.
		if (!deps.isMobile()) settings.dictionaryPath = (await deps.getSetting('dictionaryPath')) || '';
		return settings;
	}

	/** Persist a sparse override map to the setting AND to the live engine, then refresh windows. */
	async function writeRuleOverrides(sparse: LintConfig): Promise<LintConfig> {
		const keys = Object.keys(sparse);
		// An empty map is written as '' — the setting's pristine default, and what the description
		// means by "leave empty". It parses back to {} exactly as '{}' would, but leaves the native
		// settings page showing an empty field rather than a stray literal.
		await deps.setSetting('ruleOverrides', keys.length ? JSON.stringify(sparse) : '');
		// Apply directly too: the setSetting above fires onChange (which reconfigures), but applying
		// here means the engine is correct even if that handler is debounced or absent. This mirrors
		// what disableRule has always done for the single-rule case.
		const linter = await deps.getLinter();
		await linter.setLintConfig(sparse);
		await deps.pokeForceLint();
		return sparse;
	}

	const service: SettingsService = {
		async getSettingsSnapshot(opts = {}): Promise<SettingsSnapshot> {
			const includeDescriptions = opts.includeDescriptions !== false;
			const linter = await deps.getLinter();

			let structured: StructuredLintConfig | null = null;
			try {
				// The JSON variant, parsed here: it is the same tree and it keeps the WASM object
				// graph from crossing into our snapshot. Safe to JSON.parse — no u64s in it.
				structured = JSON.parse(await linter.getStructuredLintConfigJSON()) as StructuredLintConfig;
			} catch {
				try {
					structured = await linter.getStructuredLintConfig();
				} catch {
					structured = null; // the browser degrades to a flat list off `defaults`
				}
			}

			const overridesRaw = (await deps.getSetting('ruleOverrides')) || '';
			const flatConfig = parseRuleOverridesJson(String(overridesRaw)) ?? {};
			const defaults = await linter.getDefaultLintConfig();

			// ~823 HTML strings. Optional so the dialog can drop it from the initial payload later and
			// pull it via getRuleDescriptions() on demand — the shape does not change either way.
			let descriptionsHtml: Record<string, string> | null = null;
			if (includeDescriptions) {
				try {
					descriptionsHtml = await linter.getLintDescriptionsHTML();
				} catch {
					descriptionsHtml = null;
				}
			}

			const raw = await deps.loadIgnoredLintsRaw();
			const entries = await loadDismissed(deps.dismissedStore);

			return {
				structured,
				flatConfig,
				defaults,
				descriptionsHtml,
				settings: await readPrimarySettings(),
				dictionaryWords: normalizeWords(await deps.getEffectiveWords()),
				dismissed: { entries, legacyCount: legacyCount(raw, entries) },
			};
		},

		async getRuleDescriptions(): Promise<Record<string, string>> {
			const linter = await deps.getLinter();
			try {
				return await linter.getLintDescriptionsHTML();
			} catch {
				return {};
			}
		},

		async applyRuleOverrides(map): Promise<LintConfig> {
			return writeRuleOverrides(normalizeRuleOverrides(map));
		},

		async resetRules(): Promise<LintConfig> {
			return writeRuleOverrides({});
		},

		async disableAllRules(): Promise<LintConfig> {
			// The authoritative roster is the DEFAULT config (concrete booleans for every rule) —
			// getLintConfig() only echoes back whatever was last set, which may be nothing at all.
			const linter = await deps.getLinter();
			const defaults = await linter.getDefaultLintConfig();
			const all: LintConfig = {};
			for (const name of Object.keys(defaults)) all[name] = false;
			return writeRuleOverrides(all);
		},

		async updateSetting(key, value): Promise<void> {
			const validate = Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)
				? SETTING_VALIDATORS[key]
				: null;
			if (!validate) throw new Error(`setting "${key}" is not updatable from the settings dialog`);
			// Straight to joplin.settings: the plugin's existing onChange handler owns the reconfigure
			// and the poke, so routing through it keeps one code path for UI and native-page edits.
			await deps.setSetting(key, validate(value, deps));
		},

		async saveDictionaryWords(words): Promise<{ adds: string[]; removes: string[] }> {
			// Editor semantics as a DIFF, not a wholesale replace: the adds and removes are then fed
			// into the same buffers add-to-dictionary uses, so the note/file mirror and its deletion
			// propagation behave exactly as they do for a single word.
			const current = await deps.getEffectiveWords();
			const diff = diffWords(current, words);
			if (diff.adds.length || diff.removes.length) {
				await deps.applyWordEdits(diff.adds, diff.removes);
			}
			return diff;
		},

		async restoreDismissed(id): Promise<boolean> {
			const entries = await loadDismissed(deps.dismissedStore);
			const entry = entries.find((candidate) => candidate.id === id);
			if (!entry) return false;

			const linter = await deps.getLinter();
			const raw = await deps.loadIgnoredLintsRaw();
			// Everything still ignored, minus this entry's hashes. Every value here is a decimal
			// string lifted out by regex — no u64 is ever a JS number on this path.
			await rebuildIgnoreState(linter, hashesWithoutEntry(raw, entry));
			await persistIgnoreStateAndPoke(linter);
			// Only drop the row once harper's own state actually moved.
			await removeDismissed(deps.dismissedStore, id);
			return true;
		},

		async clearDismissedFindings(scope): Promise<number> {
			const linter = await deps.getLinter();
			const raw = await deps.loadIgnoredLintsRaw();
			const before = extractHashes(raw).length;

			if (scope === 'all') {
				await linter.clearIgnoredLints();
				await persistIgnoreStateAndPoke(linter);
				await clearDismissed(deps.dismissedStore);
				return before;
			}

			// 'legacy': keep every hash the side table accounts for, drop the rest. The entries
			// themselves are untouched — they still describe live ignores.
			const entries = await loadDismissed(deps.dismissedStore);
			const covered = coveredHashes(entries);
			const keep = extractHashes(raw).filter((hash) => covered.has(hash));
			await rebuildIgnoreState(linter, keep);
			await persistIgnoreStateAndPoke(linter);
			return before - keep.length;
		},

		async handleMessage(message): Promise<unknown> {
			if (!message || typeof message !== 'object') return null;
			const msg = message as { type?: string; [key: string]: any };
			switch (msg.type) {
				case 'settings:snapshot':
					return service.getSettingsSnapshot({ includeDescriptions: msg.includeDescriptions !== false });
				case 'settings:descriptions':
					return service.getRuleDescriptions();
				case 'settings:applyRuleOverrides':
					return { ok: true, overrides: await service.applyRuleOverrides(msg.overrides || {}) };
				case 'settings:resetRules':
					return { ok: true, overrides: await service.resetRules() };
				case 'settings:disableAllRules':
					return { ok: true, overrides: await service.disableAllRules() };
				case 'settings:updateSetting':
					await service.updateSetting(String(msg.key), msg.value);
					return { ok: true };
				case 'settings:saveDictionary':
					return { ok: true, ...(await service.saveDictionaryWords(msg.words || [])) };
				case 'settings:restoreDismissed':
					return { ok: await service.restoreDismissed(String(msg.id)) };
				case 'settings:clearDismissed':
					return { ok: true, cleared: await service.clearDismissedFindings(msg.scope === 'legacy' ? 'legacy' : 'all') };
				default:
					return null;
			}
		},
	};

	return service;
}
