/**
 * HARPER SETTINGS DIALOG — the webview half.
 *
 * Plain ES5-ish JavaScript on purpose. Webpack's CopyPlugin copies every non-TS file under src/ into
 * dist/ VERBATIM, so this file ships as-is and `dialogs.addScript(handle, 'settingsDialog.js')` loads
 * it as a classic script. It must NOT go through plugin.config.json's extraScripts: that pipeline
 * emits a commonjs bundle, and `module.exports = ...` in a webview throws before a line of ours runs.
 *
 * Everything here is client-side rendering off ONE JSON snapshot. The main process never re-renders
 * us: `setHtml` does not re-run scripts, so a server-side re-render would paint dead HTML. The shell
 * in index.ts is a single empty root; this script builds all four sections into it.
 *
 * Four rules this file lives by:
 *
 *   1. VALUES NEVER COME FROM `structured`. That tree is grouping/order/labels only — its `Bool.state`
 *      is `flatConfig[name] ?? false`, so reading it would render ~814 default-on rules as "off" on a
 *      fresh install. A rule's tri-state is `flatConfig[name]` if the key EXISTS, else "Default", and
 *      what Default resolves to is `defaults[name]`.
 *   2. "DEFAULT" IS THE ABSENCE OF A KEY, not a null. The UI keeps a sparse override map and posts it
 *      whole; the service drops non-booleans and writes the sparse result.
 *   3. USER-DERIVED TEXT IS NEVER innerHTML. Dismissed problem text and dictionary words go in via
 *      textContent. The single exception is harper's own rule descriptions (trusted p/code HTML).
 *   4. NO JOPLIN ICON FONTS. They exist in desktop webviews only, so every glyph here is a text
 *      character or inline SVG, and every var() carries a fallback (mobile injects fewer variables).
 */
(function () {
	'use strict';

	// =============================================================================
	// Transport.
	// =============================================================================

	/**
	 * One round-trip to the plugin. index.ts wraps the service dispatcher so a THROWN error comes back
	 * as `{__error}` rather than a silently-pending promise — `updateSetting` rejects by design (bad
	 * dialect, dictionaryPath on mobile, non-allowlisted key), and the caller has to be able to see it.
	 */
	function send(message) {
		// Wrapped so a MISSING webviewApi becomes a rejection rather than a synchronous ReferenceError.
		// Thrown synchronously it would escape load()'s .catch entirely and leave a blank white dialog
		// with nothing to explain it; as a rejection the user gets the "Could not load settings" screen.
		try {
			return webviewApi.postMessage(message).then(function (reply) {
				if (reply && reply.__error) throw new Error(reply.__error);
				return reply;
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// =============================================================================
	// Tiny DOM helpers.
	// =============================================================================

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = String(text);
		return node;
	}

	function clear(node) {
		while (node.firstChild) node.removeChild(node.firstChild);
	}

	/** A <select> from [[value, label], ...]; `value` selects the current one. */
	function makeSelect(options, value, className) {
		var select = el('select', className || 'hs-select');
		for (var i = 0; i < options.length; i++) {
			var option = el('option', null, options[i][1]);
			option.value = options[i][0];
			select.appendChild(option);
		}
		select.value = value;
		return select;
	}

	// =============================================================================
	// Rule labels.
	// =============================================================================

	/**
	 * "AmazonNames" -> "Amazon Names".
	 *
	 * MIRRORS `ruleDisplayLabel` in src/settingsService.ts, which cannot be imported here (that is
	 * TypeScript compiled into the plugin bundle; this file is copied verbatim into the webview). The
	 * unit suite asserts the two implementations agree character-for-character over a corpus, so the
	 * copy cannot drift silently. Needed at all because harper 2.7.0 returns `label: null` for all 823
	 * Bool nodes, leaving the PascalCase name as the only thing to show.
	 */
	function ruleDisplayLabel(name) {
		if (!name) return '';
		return name
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
			.replace(/([A-Za-z])(\d)/g, '$1 $2')
			.trim();
	}

	// =============================================================================
	// State.
	// =============================================================================

	var state = {
		loaded: false,
		settings: null, // PrimarySettings
		defaults: {}, // rule -> boolean (concrete, all ~823)
		overrides: {}, // rule -> boolean (SPARSE; a missing key means "Default")
		groups: [], // [{ id, label, description, rules: [ruleName, ...] }]
		descriptions: null, // rule -> HTML, or null until the lazy fetch lands
		// PROTOTYPE-FREE lookup maps. These are keyed by RULE NAME, and a plain `{}` answers truthily
		// for "constructor", "toString", "valueOf" and friends without anything ever being stored — so
		// a rule with such a name would read as already-seen / already-expanded. harper's names are
		// PascalCase today, but a lookup table keyed by external strings has no business inheriting.
		descriptionText: Object.create(null), // rule -> plain text, for search
		dictionaryWords: [],
		dismissed: { entries: [], legacyCount: 0 },
		search: '',
		tab: 'general',
		expandedGroups: Object.create(null), // group id -> true
		// Per-SEARCH expansion overrides. A search force-opens the groups it matched, which would make
		// the disclosure arrow a dead control; this map records the groups the user collapsed while
		// that search was active, and is thrown away whenever the query changes — so clearing the
		// search still restores exactly what was open before it, which expandedGroups alone holds.
		searchExpanded: Object.create(null), // group id -> false (collapsed during this search)
		expandedRules: Object.create(null), // rule name -> true
	};

	var ADDITIONAL_GROUP_ID = '__additional__';

	// =============================================================================
	// Building the rules model from harper's structured tree.
	// =============================================================================

	/**
	 * Flatten `structured` into a list of display groups.
	 *
	 * harper 2.7.0 emits a flat 15 x Group -> Bool[] shape, but `Group.child` is typed as a full
	 * StructuredLintConfig, so nesting is handled here rather than assumed away: a nested Group becomes
	 * its own entry with a breadcrumb label ("Parent > Child"), and Bools sitting directly beside it
	 * stay with the parent. Bools at the very top level (no enclosing Group) land in "Other Rules".
	 *
	 * OneOfMany is expanded into its member names as ordinary tri-state rows. harper emits none today;
	 * this keeps a future release visible and editable rather than invisible, which is the safer
	 * degradation for a settings screen (the alternative — silently dropping the node — would hide
	 * rules from the user with no clue anything was missing).
	 */
	function buildGroups(structured, defaults, overrides) {
		var groups = [];
		var seen = Object.create(null); // see the note on descriptionText above

		function addGroup(id, label, description, rules) {
			if (!rules.length) return;
			groups.push({ id: id, label: label, description: description || '', rules: rules });
		}

		function walk(node, trail) {
			if (!node || !node.settings || !node.settings.length) return;

			// PASS 1 — this node's OWN rules, emitted before recursing, so a parent group always appears
			// ahead of the nested groups that belong to it. (Collecting and recursing in one loop would
			// list "Parent > Child" above "Parent", which reads as though the child owns the parent.)
			var ownRules = [];
			var i;
			var entry;
			for (i = 0; i < node.settings.length; i++) {
				entry = node.settings[i];
				if (!entry || typeof entry !== 'object') continue;
				if (entry.Bool && entry.Bool.name) {
					ownRules.push(entry.Bool.name);
					seen[entry.Bool.name] = true;
				} else if (entry.OneOfMany && entry.OneOfMany.names && entry.OneOfMany.names.length) {
					for (var j = 0; j < entry.OneOfMany.names.length; j++) {
						var member = entry.OneOfMany.names[j];
						if (!member) continue;
						ownRules.push(member);
						seen[member] = true;
					}
				}
			}
			if (ownRules.length) {
				addGroup(
					trail.length ? trail.join('/') : '__root__',
					trail.length ? trail.join(' > ') : 'Other Rules',
					'',
					ownRules,
				);
			}

			// PASS 2 — nested groups, depth-first. Each one's description is attached afterwards, in
			// applyDescriptions, where an emitted group can be matched back to its source node by id.
			for (i = 0; i < node.settings.length; i++) {
				entry = node.settings[i];
				if (!entry || typeof entry !== 'object' || !entry.Group) continue;
				walk(entry.Group.child, trail.concat([entry.Group.label || 'Rules']));
			}
		}

		walk(structured, []);

		// Descriptions come off the Group node itself, so a second pass is simpler than threading them
		// through the recursion: match each emitted group back to its source label.
		function applyDescriptions(node, trail) {
			if (!node || !node.settings) return;
			for (var i = 0; i < node.settings.length; i++) {
				var entry = node.settings[i];
				if (!entry || !entry.Group) continue;
				var label = entry.Group.label || 'Rules';
				var childTrail = trail.concat([label]);
				var id = childTrail.join('/');
				for (var g = 0; g < groups.length; g++) {
					if (groups[g].id === id && entry.Group.description) {
						groups[g].description = entry.Group.description;
					}
				}
				applyDescriptions(entry.Group.child, childTrail);
			}
		}
		applyDescriptions(structured, []);

		// ADDITIONAL RULES: anything the flat config or the defaults know about that the tree does not
		// mention. Without this bucket a rule the user had already overridden by hand (the ruleOverrides
		// JSON setting has existed since v1.0) could be invisible AND still in force.
		var extras = [];
		var names = Object.keys(defaults || {});
		var overrideNames = Object.keys(overrides || {});
		for (var n = 0; n < overrideNames.length; n++) {
			if (names.indexOf(overrideNames[n]) === -1) names.push(overrideNames[n]);
		}
		for (var m = 0; m < names.length; m++) {
			if (!seen[names[m]]) extras.push(names[m]);
		}
		extras.sort();
		if (extras.length) {
			addGroup(ADDITIONAL_GROUP_ID, 'Additional Rules', 'Rules Harper reports outside its grouped list.', extras);
		}

		return groups;
	}

	// =============================================================================
	// Tri-state derivation.
	// =============================================================================

	/** 'on' | 'off' | 'default' for one rule. ABSENCE of the key is what "default" means. */
	function ruleState(name) {
		if (!Object.prototype.hasOwnProperty.call(state.overrides, name)) return 'default';
		return state.overrides[name] ? 'on' : 'off';
	}

	/** 'on' | 'off' | 'default' | 'mixed' for a group, derived from its children. */
	function groupState(group) {
		var sawDefault = false;
		var sawOn = false;
		var sawOff = false;
		for (var i = 0; i < group.rules.length; i++) {
			var s = ruleState(group.rules[i]);
			if (s === 'default') sawDefault = true;
			else if (s === 'on') sawOn = true;
			else sawOff = true;
		}
		if (sawDefault && !sawOn && !sawOff) return 'default';
		if (sawOn && !sawDefault && !sawOff) return 'on';
		if (sawOff && !sawDefault && !sawOn) return 'off';
		return 'mixed';
	}

	function defaultLabelFor(name) {
		var value = state.defaults[name];
		if (value === true) return 'Default (on)';
		if (value === false) return 'Default (off)';
		return 'Default';
	}

	// =============================================================================
	// Applying rule changes.
	// =============================================================================

	/**
	 * Serialize override writes. Flipping a whole group is one message, but a user clicking several
	 * rows fast would otherwise have two applyRuleOverrides in flight, and the second could be built
	 * from a map the first had not finished persisting.
	 */
	var applyChain = Promise.resolve();
	var applyPending = 0;

	/**
	 * The user's rule edits that no completed write has confirmed yet, in the order they were made.
	 * Each entry is { rule: name, value: true | false | null }, where null means "Default" (delete
	 * the key — absence is what Default means, see rule 2 in the header).
	 *
	 * SERIALIZING THE SENDS IS NOT ENOUGH ON ITS OWN. `settings:applyRuleOverrides` REPLACES the
	 * stored map wholesale, and every reply carries the authoritative map the service stored — so two
	 * things have to be true, and neither was:
	 *
	 *   1. a payload must be built at SEND time, from whatever the map is by then. A payload
	 *      snapshotted at CLICK time predates the earlier write's reply, so sending it overwrites that
	 *      write: one rule toggled during a slow "Disable All Rules" used to persist a single-key map
	 *      and silently put all 822 other rules back on.
	 *   2. adopting a reply must not drop the edits made after ITS payload was built. `state.overrides
	 *      = reply.overrides` alone loses them, and since the repaint is gated on the last write in a
	 *      burst, they vanish from the UI as well as from the setting.
	 *
	 * So each write records how many queued edits its payload carried; when its reply lands, exactly
	 * those are retired and every later one is re-applied on top of the authoritative map. A bulk
	 * Reset / Disable All carries none of its own, which is right: it deliberately supersedes
	 * everything queued before it, and only edits made after it was sent survive it.
	 */
	var queuedEdits = [];

	function setRuleState(name, next) {
		if (next === 'default') delete state.overrides[name];
		else state.overrides[name] = next === 'on';
		queuedEdits.push({ rule: name, value: next === 'default' ? null : next === 'on' });
	}

	/** A plain, boolean-only copy of the override map — what a write actually sends. */
	function copyOverrides(source) {
		var out = {};
		var keys = Object.keys(source || {});
		for (var i = 0; i < keys.length; i++) {
			if (typeof source[keys[i]] === 'boolean') out[keys[i]] = source[keys[i]];
		}
		return out;
	}

	/** The authoritative map from a reply, with every still-unconfirmed edit replayed on top. */
	function withQueuedEdits(authoritative) {
		var out = copyOverrides(authoritative);
		for (var i = 0; i < queuedEdits.length; i++) {
			var edit = queuedEdits[i];
			if (edit.value === null) delete out[edit.rule];
			else out[edit.rule] = edit.value;
		}
		return out;
	}

	function errorText(error) {
		return (error && error.message) || String(error);
	}

	/**
	 * Queue ONE rule-config write behind every write already in flight.
	 *
	 * Every path that changes the rule config goes through here — single toggles, whole-group flips,
	 * Reset and Disable All alike. Letting any of them skip the queue would let a slower earlier write
	 * land last and undo it: clicking a rule and then Reset could re-persist the pre-reset map, leaving
	 * the engine holding overrides while the dialog showed "all defaults".
	 *
	 * `build` returns the message to send; `adopt` takes the reply's authoritative override map.
	 */
	function queueRuleWrite(build, pendingStatus) {
		applyPending++;
		setRulesStatus(pendingStatus || 'Saving…');
		applyChain = applyChain.then(
			function () {
				// Built HERE, when it is this write's turn to go out — never at click time. See the note
				// on queuedEdits: a payload frozen at click time predates the previous write's reply and
				// would overwrite it wholesale.
				var message = build();
				// Everything the user has edited so far rides along in that payload (or, for a bulk
				// action, is deliberately superseded by it). Edits made from now on do not, so they are
				// what has to be replayed when this write's reply lands.
				var carried = queuedEdits.length;
				return send(message).then(
					function (reply) {
						applyPending--;
						queuedEdits = queuedEdits.slice(carried);
						// The service returns the sparse map it actually stored, so the UI adopts that
						// rather than trusting its own optimistic copy — plus the edits it could not know
						// about, which are still unsaved and still on screen.
						if (reply && reply.overrides) state.overrides = withQueuedEdits(reply.overrides);
						// Only the LAST write in a burst repaints the status, so an intermediate "Saved"
						// cannot flash over a still-running save.
						if (applyPending === 0) {
							renderRules();
							setRulesStatus(describeOverrides(state.overrides));
						}
						return reply;
					},
					function (error) {
						applyPending--;
						// Retired even though the write failed: `state.overrides` still holds these edits, so
						// the next write's payload carries them again. Replaying them a second time on top of
						// a later reply would be a no-op at best and could resurrect an edit the user has
						// since undone.
						queuedEdits = queuedEdits.slice(carried);
						setRulesStatus('Could not save: ' + errorText(error), true);
					},
				);
			},
			// The chain itself must never stay rejected: `applyChain.then(...)` on a rejected chain
			// would SKIP the send entirely, silently breaking every later toggle for the session.
			function () {
				applyPending--;
			},
		);
		return applyChain;
	}

	function pushOverrides() {
		return queueRuleWrite(function () {
			return { type: 'settings:applyRuleOverrides', overrides: copyOverrides(state.overrides) };
		});
	}

	function describeOverrides(overrides) {
		var count = overrides ? Object.keys(overrides).length : 0;
		if (!count) return 'Saved. No rules overridden — all defaults.';
		return 'Saved. ' + count + (count === 1 ? ' rule overridden.' : ' rules overridden.');
	}

	function setRulesStatus(text, isError) {
		var node = document.getElementById('hs-rules-status');
		if (!node) return;
		node.textContent = text || '';
		node.className = 'hs-status' + (isError ? ' hs-status-error' : '');
	}

	// =============================================================================
	// Search.
	// =============================================================================

	function stripHtml(html) {
		var tmp = document.createElement('div');
		tmp.innerHTML = html || '';
		return (tmp.textContent || '').toLowerCase();
	}

	/** Rule name, display label, group label and (once loaded) the rule description all match. */
	function ruleMatches(name, group, needle) {
		if (!needle) return true;
		if (name.toLowerCase().indexOf(needle) !== -1) return true;
		if (ruleDisplayLabel(name).toLowerCase().indexOf(needle) !== -1) return true;
		if (group.label.toLowerCase().indexOf(needle) !== -1) return true;
		var text = state.descriptionText[name];
		if (text && text.indexOf(needle) !== -1) return true;
		return false;
	}

	function matchingRules(group, needle) {
		if (!needle) return group.rules;
		var out = [];
		for (var i = 0; i < group.rules.length; i++) {
			if (ruleMatches(group.rules[i], group, needle)) out.push(group.rules[i]);
		}
		return out;
	}

	// =============================================================================
	// Section: General.
	// =============================================================================

	function field(labelText, control, help) {
		var row = el('div', 'hs-field');
		var label = el('label', 'hs-field-label', labelText);
		row.appendChild(label);
		var body = el('div', 'hs-field-body');
		body.appendChild(control);
		if (help) body.appendChild(el('div', 'hs-help', help));
		row.appendChild(body);
		return row;
	}

	/**
	 * Stop Enter inside a plain text input from closing the whole dialog.
	 *
	 * Joplin's webview bootstrap installs a document-level keydown listener that treats Enter in an
	 * `INPUT[type=text]` as a form submit; the dialog's `onSubmit` then matches the first button whose
	 * id is one of ok/yes/submit/confirm and calls it. This dialog registers exactly one button,
	 * `{id:'ok', title:'Close'}` — so pressing Enter to commit a note id or a file path dismissed the
	 * entire settings screen, 100% of the time. There is no form here and nothing to submit (every
	 * change is already saved on `change`), so the key is stopped at the input, before it can bubble
	 * to that listener. The rules search box dodges this for free with `type='search'`; these two
	 * fields need the text type.
	 *
	 * stopPropagation only — NOT preventDefault: the `change` event that actually saves the value
	 * still has to fire.
	 */
	function stopEnterFromClosingTheDialog(input) {
		input.addEventListener('keydown', function (event) {
			if (event.key === 'Enter') event.stopPropagation();
		});
	}

	function setGeneralStatus(text, isError) {
		var node = document.getElementById('hs-general-status');
		if (!node) return;
		node.textContent = text || '';
		node.className = 'hs-status' + (isError ? ' hs-status-error' : '');
	}

	/** Write one primary setting, reverting the control if the service refuses the value. */
	function updateSetting(key, value, revert) {
		setGeneralStatus('Saving…');
		return send({ type: 'settings:updateSetting', key: key, value: value })
			.then(function () {
				state.settings[key] = value;
				setGeneralStatus('Saved.');
			})
			.catch(function (error) {
				setGeneralStatus('Could not save ' + key + ': ' + error.message, true);
				if (revert) revert();
			});
	}

	function renderGeneral(root) {
		var section = el('div', 'hs-section');
		section.appendChild(el('p', 'hs-section-intro', 'How Harper checks your notes.'));

		var s = state.settings;

		// Enable Harper
		var enabled = el('input');
		enabled.type = 'checkbox';
		enabled.checked = s.enabled === true;
		enabled.id = 'hs-enabled';
		enabled.addEventListener('change', function () {
			var value = enabled.checked;
			updateSetting('enabled', value, function () {
				enabled.checked = !value;
			});
		});
		var enabledWrap = el('div', 'hs-checkbox');
		enabledWrap.appendChild(enabled);
		enabledWrap.appendChild(el('span', null, 'Check grammar and spelling'));
		section.appendChild(field('Enable Harper', enabledWrap, 'When off, no underlines are shown.'));

		// Dialect
		var dialect = makeSelect(
			[
				['American', 'American'],
				['British', 'British'],
				['Australian', 'Australian'],
				['Canadian', 'Canadian'],
				['Indian', 'Indian'],
			],
			s.dialect || 'American',
		);
		dialect.id = 'hs-dialect';
		var dialectBefore = dialect.value;
		dialect.addEventListener('change', function () {
			var value = dialect.value;
			updateSetting('dialect', value, function () {
				dialect.value = dialectBefore;
			}).then(function () {
				dialectBefore = dialect.value;
			});
		});
		section.appendChild(field('English dialect', dialect, 'Changes which spellings Harper accepts.'));

		// Debounce
		var debounce = el('input', 'hs-input');
		debounce.type = 'number';
		debounce.min = '0';
		debounce.max = '10000';
		debounce.step = '50';
		debounce.id = 'hs-debounce';
		// `0` is a real value (lint immediately), so this cannot use `|| 500`.
		debounce.value = String(typeof s.debounceMs === 'number' ? s.debounceMs : 500);
		var debounceBefore = debounce.value;
		debounce.addEventListener('change', function () {
			// A number input enforces min/max only on FORM validation, and there is no form here — so
			// "99999" arrives untouched. The service clamps it to 10000 and reports plain {ok:true},
			// which would leave the field showing a value that was never stored. Clamp to the same
			// bounds here and write the clamped number back, so what is on screen is what was saved.
			var raw = debounce.value.trim();
			// An empty box is not "0" (a real, meaningful value: lint immediately) — it is an unfinished
			// edit, so revert rather than silently disabling the delay.
			if (!raw) {
				debounce.value = debounceBefore;
				return;
			}
			var value = Number(raw);
			if (!isFinite(value)) {
				debounce.value = debounceBefore;
				return;
			}
			value = Math.min(10000, Math.max(0, Math.round(value)));
			debounce.value = String(value);
			updateSetting('debounceMs', value, function () {
				debounce.value = debounceBefore;
			}).then(function () {
				debounceBefore = debounce.value;
			});
		});
		section.appendChild(field('Lint debounce (ms)', debounce, 'Idle delay after typing before Harper re-checks. 0 to 10000.'));

		// Underline style
		var underline = makeSelect(
			[
				['squiggly', 'Squiggly (default)'],
				['solid', 'Solid line'],
			],
			s.underlineStyle === 'solid' ? 'solid' : 'squiggly',
		);
		underline.id = 'hs-underline';
		var underlineBefore = underline.value;
		underline.addEventListener('change', function () {
			var value = underline.value;
			updateSetting('underlineStyle', value, function () {
				underline.value = underlineBefore;
			}).then(function () {
				underlineBefore = underline.value;
			});
		});
		section.appendChild(field('Underline style', underline, 'How findings are marked in the editor.'));

		// Ignore non-English
		var ignore = el('input');
		ignore.type = 'checkbox';
		ignore.id = 'hs-ignore-non-english';
		ignore.checked = s.ignoreNonEnglish === true;
		ignore.addEventListener('change', function () {
			var value = ignore.checked;
			updateSetting('ignoreNonEnglish', value, function () {
				ignore.checked = !value;
			});
		});
		var ignoreWrap = el('div', 'hs-checkbox');
		ignoreWrap.appendChild(ignore);
		ignoreWrap.appendChild(el('span', null, 'Skip text that is not English'));
		section.appendChild(field('Ignore non-English text', ignoreWrap, 'Useful for multilingual notes.'));

		// Dictionary note id
		var noteId = el('input', 'hs-input hs-input-wide');
		noteId.type = 'text';
		noteId.id = 'hs-dictionary-note-id';
		noteId.value = s.dictionaryNoteId || '';
		stopEnterFromClosingTheDialog(noteId);
		var noteIdBefore = noteId.value;
		noteId.addEventListener('change', function () {
			var value = noteId.value.trim();
			updateSetting('dictionaryNoteId', value, function () {
				noteId.value = noteIdBefore;
			}).then(function () {
				noteIdBefore = noteId.value;
			});
		});
		section.appendChild(
			field(
				'Dictionary note id',
				noteId,
				'A Joplin note used as your dictionary, one word per line. It syncs across devices. ' +
					'Run "Harper: Create dictionary note" to make one. Leave empty to turn it off.',
			),
		);

		// External dictionary file — DESKTOP ONLY. The setting is not registered on mobile, so the
		// snapshot simply omits the key there and the row must not appear at all.
		if (Object.prototype.hasOwnProperty.call(s, 'dictionaryPath')) {
			var dictPath = el('input', 'hs-input hs-input-wide');
			dictPath.type = 'text';
			dictPath.id = 'hs-dictionary-path';
			dictPath.value = s.dictionaryPath || '';
			stopEnterFromClosingTheDialog(dictPath);
			var dictPathBefore = dictPath.value;
			dictPath.addEventListener('change', function () {
				var value = dictPath.value;
				updateSetting('dictionaryPath', value, function () {
					dictPath.value = dictPathBefore;
				}).then(function () {
					dictPathBefore = dictPath.value;
				});
			});
			section.appendChild(
				field(
					'External dictionary file',
					dictPath,
					'Absolute path to a plain-text dictionary, one word per line. Leave empty to skip it.',
				),
			);
		}

		var status = el('div', 'hs-status');
		status.id = 'hs-general-status';
		section.appendChild(status);
		root.appendChild(section);
	}

	// =============================================================================
	// Section: Rules.
	// =============================================================================

	function renderRuleRow(name, group) {
		var row = el('div', 'hs-rule');
		row.setAttribute('data-rule', name);

		var toggle = el('button', 'hs-disclosure', state.expandedRules[name] ? '\u25BE' : '\u25B8');
		toggle.type = 'button';
		toggle.title = 'Show what this rule does';
		toggle.setAttribute('aria-label', 'Show what this rule does');
		toggle.addEventListener('click', function () {
			state.expandedRules[name] = !state.expandedRules[name];
			renderRules();
			ensureDescriptions();
		});
		row.appendChild(toggle);

		var main = el('div', 'hs-rule-main');
		var nameWrap = el('div', 'hs-rule-name');
		nameWrap.appendChild(el('span', 'hs-rule-label', ruleDisplayLabel(name)));
		nameWrap.appendChild(el('code', 'hs-rule-id', name));
		main.appendChild(nameWrap);

		if (state.expandedRules[name]) {
			var desc = el('div', 'hs-rule-desc');
			if (state.descriptions && state.descriptions[name]) {
				// TRUSTED HTML: harper's own rule descriptions (simple p/code markup). This is the ONLY
				// innerHTML in this file — everything user-derived goes in via textContent.
				desc.innerHTML = state.descriptions[name];
			} else if (state.descriptions) {
				desc.textContent = 'No description for this rule.';
			} else {
				desc.textContent = 'Loading description…';
			}
			main.appendChild(desc);
		}
		row.appendChild(main);

		var select = makeSelect(
			[
				['default', defaultLabelFor(name)],
				['on', 'On'],
				['off', 'Off'],
			],
			ruleState(name),
			'hs-select hs-rule-select',
		);
		select.setAttribute('data-rule-select', name);
		select.addEventListener('change', function () {
			setRuleState(name, select.value);
			pushOverrides();
			// The group header's derived state and the roster summary both moved. Repaint just those
			// two rather than the whole (potentially 800-row) list — leaving the summary alone would
			// have it disagree with the status line right below it until the next full render.
			refreshGroupHeader(group);
			refreshRulesSummary();
		});
		row.appendChild(select);
		return row;
	}

	function refreshGroupHeader(group) {
		var header = document.querySelector('[data-group-select="' + cssEscape(group.id) + '"]');
		if (!header) return;
		var value = groupState(group);
		var mixed = header.querySelector('option[value="mixed"]');
		if (value === 'mixed' && !mixed) {
			var option = el('option', null, 'Default (mixed)');
			option.value = 'mixed';
			header.insertBefore(option, header.firstChild);
		} else if (value !== 'mixed' && mixed) {
			mixed.parentNode.removeChild(mixed);
		}
		header.value = value;
	}

	/** Minimal attribute-selector escaping — group ids are label paths, so they can hold spaces. */
	function cssEscape(value) {
		return String(value).replace(/["\\]/g, '\\$&');
	}

	/**
	 * Is this group's rule list shown right now?
	 *
	 * A search auto-opens the groups that matched: with a needle typed, hiding the hits behind a
	 * second click would make the search useless. That is a DISPLAY override only \u2014 the stored
	 * expansion state (`expandedGroups`) is left alone, so clearing the search restores exactly what
	 * the user had open.
	 *
	 * The override used to be unconditional, which made the arrow a DEAD CONTROL during a search while
	 * still flipping the stored value underneath: nothing moved on screen, and the group turned out to
	 * have silently collapsed once the search was cleared \u2014 by a click count the UI gave no feedback
	 * for. So a collapse made DURING a search is recorded separately, in `searchExpanded`, and is
	 * honoured over the force-open while that search lasts.
	 */
	function groupExpanded(groupId, needle) {
		if (!needle) return !!state.expandedGroups[groupId];
		if (Object.prototype.hasOwnProperty.call(state.searchExpanded, groupId)) {
			return !!state.searchExpanded[groupId];
		}
		return true;
	}

	/** Flip the state `groupExpanded` reads \u2014 the per-search one during a search, the stored one otherwise. */
	function toggleGroupExpanded(groupId, needle) {
		if (needle) state.searchExpanded[groupId] = !groupExpanded(groupId, needle);
		else state.expandedGroups[groupId] = !state.expandedGroups[groupId];
	}

	function renderGroup(group, needle) {
		var rules = matchingRules(group, needle);
		if (needle && !rules.length) return null;

		var box = el('div', 'hs-group');
		box.setAttribute('data-group', group.id);

		var header = el('div', 'hs-group-header');
		var expanded = groupExpanded(group.id, needle);

		function toggleExpanded() {
			toggleGroupExpanded(group.id, needle);
			renderRules();
		}

		var toggle = el('button', 'hs-disclosure', expanded ? '\u25BE' : '\u25B8');
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		toggle.addEventListener('click', toggleExpanded);
		header.appendChild(toggle);

		var titleWrap = el('div', 'hs-group-title-wrap');
		var title = el('div', 'hs-group-title');
		title.appendChild(el('span', 'hs-group-label', group.label));
		var count = needle
			? rules.length + ' of ' + group.rules.length
			: String(group.rules.length);
		title.appendChild(el('span', 'hs-group-count', count));
		titleWrap.appendChild(title);
		if (group.description) titleWrap.appendChild(el('div', 'hs-group-desc', group.description));
		// Clicking the title is the same as clicking the arrow — a bigger tap target, which matters on
		// mobile where the arrow alone is well under 44 px.
		titleWrap.addEventListener('click', toggleExpanded);
		header.appendChild(titleWrap);

		var value = groupState(group);
		var options = [
			['default', 'Default'],
			['on', 'On'],
			['off', 'Off'],
		];
		if (value === 'mixed') options.unshift(['mixed', 'Default (mixed)']);
		var select = makeSelect(options, value, 'hs-select hs-group-select');
		select.setAttribute('data-group-select', group.id);
		// The group selector always writes to the WHOLE group, never to just the rows a search left
		// visible. That is the useful behaviour, but beside a header reading "3 of 121" it would be a
		// nasty surprise, so during a search the tooltip says plainly how many rules it will touch.
		select.title =
			needle && rules.length !== group.rules.length
				? 'Set all ' + group.rules.length + ' rules in this group, including the ones the search is hiding'
				: 'Set every rule in this group';
		select.addEventListener('change', function () {
			if (select.value === 'mixed') return; // "mixed" is a readout, not a command
			for (var i = 0; i < group.rules.length; i++) setRuleState(group.rules[i], select.value);
			pushOverrides();
			renderRules();
		});
		header.appendChild(select);
		box.appendChild(header);

		if (expanded) {
			var list = el('div', 'hs-rule-list');
			for (var i = 0; i < rules.length; i++) list.appendChild(renderRuleRow(rules[i], group));
			box.appendChild(list);
		}
		return box;
	}

	function renderRules() {
		var host = document.getElementById('hs-rules-groups');
		if (!host) return;
		clear(host);
		var needle = state.search.trim().toLowerCase();
		var shown = 0;
		for (var i = 0; i < state.groups.length; i++) {
			var node = renderGroup(state.groups[i], needle);
			if (node) {
				host.appendChild(node);
				shown++;
			}
		}
		if (!shown) host.appendChild(el('div', 'hs-empty', 'No rules match "' + state.search.trim() + '".'));
		refreshRulesSummary();
	}

	function refreshRulesSummary() {
		var summary = document.getElementById('hs-rules-summary');
		if (summary) summary.textContent = rulesSummaryText();
	}

	function totalRuleCount() {
		var total = 0;
		for (var i = 0; i < state.groups.length; i++) total += state.groups[i].rules.length;
		return total;
	}

	function rulesSummaryText() {
		var overridden = Object.keys(state.overrides).length;
		return (
			totalRuleCount() +
			' rules in ' +
			state.groups.length +
			' groups. ' +
			(overridden ? overridden + ' overridden.' : 'All at their defaults.')
		);
	}

	var searchTimer = null;

	function renderRulesSection(root) {
		var section = el('div', 'hs-section');
		section.appendChild(
			el(
				'p',
				'hs-section-intro',
				'Turn individual checks on or off. "Default" leaves the choice to Harper. Changes apply straight away.',
			),
		);

		var toolbar = el('div', 'hs-toolbar');
		var search = el('input', 'hs-input hs-search');
		search.type = 'search';
		search.id = 'hs-rule-search';
		search.placeholder = 'Search rules…';
		search.value = state.search;
		search.addEventListener('input', function () {
			state.search = search.value;
			// A new query is a new set of matches, so the collapses the user made against the OLD one no
			// longer describe anything. Dropping them here is what keeps `expandedGroups` — the state a
			// cleared search restores — untouched by anything that happened during a search.
			state.searchExpanded = Object.create(null);
			// Debounced: a one-letter query can match hundreds of rules, and re-rendering on every
			// keystroke would stutter on mobile.
			if (searchTimer) clearTimeout(searchTimer);
			searchTimer = setTimeout(function () {
				searchTimer = null;
				renderRules();
			}, 140);
		});
		toolbar.appendChild(search);

		var reset = el('button', 'hs-button', 'Reset to Default Rules');
		reset.type = 'button';
		reset.id = 'hs-reset-rules';
		reset.addEventListener('click', function () {
			queueRuleWrite(function () {
				return { type: 'settings:resetRules' };
			}, 'Resetting…');
		});
		toolbar.appendChild(reset);

		var disableAll = el('button', 'hs-button', 'Disable All Rules');
		disableAll.type = 'button';
		disableAll.id = 'hs-disable-all-rules';
		disableAll.addEventListener('click', function () {
			queueRuleWrite(function () {
				return { type: 'settings:disableAllRules' };
			}, 'Disabling…');
		});
		toolbar.appendChild(disableAll);
		section.appendChild(toolbar);

		var summary = el('div', 'hs-summary');
		summary.id = 'hs-rules-summary';
		summary.textContent = rulesSummaryText();
		section.appendChild(summary);

		var status = el('div', 'hs-status');
		status.id = 'hs-rules-status';
		section.appendChild(status);

		var groups = el('div', 'hs-groups');
		groups.id = 'hs-rules-groups';
		section.appendChild(groups);

		root.appendChild(section);
		renderRules();
	}

	// =============================================================================
	// Section: Dictionary.
	// =============================================================================

	function setDictionaryStatus(text, isError) {
		var node = document.getElementById('hs-dictionary-status');
		if (!node) return;
		node.textContent = text || '';
		node.className = 'hs-status' + (isError ? ' hs-status-error' : '');
	}

	/**
	 * Repaint the dictionary section from `state.dictionaryWords`, BY ID.
	 *
	 * A save is a seconds-scale round trip (a note read, an L3-gated note write, an atomic external
	 * file rewrite), and nothing stops the user switching tabs inside it. Writing the reply into the
	 * `area` / `count` / `save` nodes the save handler closed over put it into DETACHED nodes: the
	 * re-entered tab still showed the pre-save list, the old count and a blank status, so the word
	 * looked like it had vanished — and saving again from that stale textarea deleted it for real.
	 * Every other async writer in this file already re-resolves by id (setRulesStatus,
	 * setGeneralStatus, setDismissedStatus); this one now does too, so it lands on whatever nodes are
	 * currently on screen, and harmlessly on none when the tab is elsewhere.
	 */
	function paintDictionary() {
		var area = document.getElementById('hs-dictionary');
		if (area) area.value = state.dictionaryWords.join('\n');
		var count = document.getElementById('hs-dictionary-count');
		if (count) count.textContent = state.dictionaryWords.length + ' words';
		var save = document.getElementById('hs-save-dictionary');
		if (save) save.disabled = false;
	}

	function renderDictionary(root) {
		var section = el('div', 'hs-section');
		section.appendChild(
			el('p', 'hs-section-intro', 'Words Harper should always accept. One word per line.'),
		);

		var area = el('textarea', 'hs-textarea');
		area.id = 'hs-dictionary';
		area.spellcheck = false;
		// textContent, not innerHTML: these are user words.
		area.value = state.dictionaryWords.join('\n');
		section.appendChild(area);

		var status = el('div', 'hs-status');
		status.id = 'hs-dictionary-status';

		var bar = el('div', 'hs-toolbar');
		var save = el('button', 'hs-button hs-button-primary', 'Save dictionary');
		save.type = 'button';
		save.id = 'hs-save-dictionary';
		save.addEventListener('click', function () {
			// Split, trim, drop empties — and drop repeats. The service normalizes its side anyway, so
			// leaving duplicates in would not corrupt anything; it would just mean the textarea we
			// re-render and the word count beside it describe a list the plugin never stored. '# '
			// lines are comments in both dictionary formats and can never be stored as words, so they
			// are dropped here too rather than reported back as an add that then quietly disappears.
			var words = [];
			var lines = area.value.split('\n');
			for (var i = 0; i < lines.length; i++) {
				var word = lines[i].trim();
				if (!word || word.indexOf('# ') === 0) continue;
				if (words.indexOf(word) === -1) words.push(word);
			}
			// THE BASELINE: the list this textarea was seeded from, sent with the save so the service
			// can tell "the user deleted this" from "the dialog never saw it". Without it, a save posts
			// what is effectively a wholesale replace, and anything that entered the dictionary since
			// the dialog loaded — a word synced from another device, the 500 words in an external file
			// just configured on the General tab — reads as an explicit deletion.
			var baseline = state.dictionaryWords.slice();
			setDictionaryStatus('Saving…');
			save.disabled = true;
			send({ type: 'settings:saveDictionary', words: words, baseline: baseline })
				.then(function (reply) {
					var adds = (reply && reply.adds) || [];
					var removes = (reply && reply.removes) || [];
					// The reply carries the reconciled truth, not an echo of what was posted, so the
					// editor shows what the dictionary actually holds — and the next save's baseline is
					// that same truth rather than a list already out of date.
					state.dictionaryWords =
						reply && reply.words ? reply.words.slice() : words.slice().sort();
					paintDictionary();
					if (!adds.length && !removes.length) {
						setDictionaryStatus('Saved. Nothing changed.');
					} else {
						setDictionaryStatus('Saved. ' + adds.length + ' added, ' + removes.length + ' removed.');
					}
				})
				.catch(function (error) {
					var current = document.getElementById('hs-save-dictionary');
					if (current) current.disabled = false;
					setDictionaryStatus('Could not save: ' + error.message, true);
				});
		});
		bar.appendChild(save);

		var count = el('span', 'hs-summary');
		count.id = 'hs-dictionary-count';
		count.textContent = state.dictionaryWords.length + ' words';
		bar.appendChild(count);
		section.appendChild(bar);
		section.appendChild(status);
		root.appendChild(section);
	}

	// =============================================================================
	// Section: Dismissed findings.
	// =============================================================================

	function formatDate(iso) {
		if (!iso) return '';
		var date = new Date(iso);
		if (isNaN(date.getTime())) return String(iso);
		return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
	}

	function setDismissedStatus(text, isError) {
		var node = document.getElementById('hs-dismissed-status');
		if (!node) return;
		node.textContent = text || '';
		node.className = 'hs-status' + (isError ? ' hs-status-error' : '');
	}

	function renderDismissedList() {
		var host = document.getElementById('hs-dismissed-list');
		if (!host) return;
		clear(host);

		var entries = state.dismissed.entries || [];
		if (!entries.length && !state.dismissed.legacyCount) {
			host.appendChild(el('div', 'hs-empty', 'Nothing dismissed yet.'));
			return;
		}

		for (var i = 0; i < entries.length; i++) {
			(function (entry) {
				var row = el('div', 'hs-dismissed');
				row.setAttribute('data-dismissed-id', entry.id);
				var text = el('div', 'hs-dismissed-text');
				// EVERY piece below is textContent: ruleName and problemText come from the user's note.
				text.appendChild(el('span', 'hs-dismissed-rule', entry.ruleName || 'Unknown rule'));
				text.appendChild(el('span', 'hs-dismissed-sep', ': '));
				text.appendChild(el('span', 'hs-dismissed-quote', '\u2018' + (entry.problemText || '') + '\u2019'));
				text.appendChild(el('span', 'hs-dismissed-date', ' \u2014 ' + formatDate(entry.dismissedAt)));
				row.appendChild(text);

				var restore = el('button', 'hs-button hs-button-small', 'Restore');
				restore.type = 'button';
				restore.setAttribute('data-restore', entry.id);
				restore.addEventListener('click', function () {
					restore.disabled = true;
					setDismissedStatus('Restoring…');
					send({ type: 'settings:restoreDismissed', id: entry.id })
						.then(function (reply) {
							if (reply && reply.ok) {
								state.dismissed.entries = state.dismissed.entries.filter(function (candidate) {
									return candidate.id !== entry.id;
								});
								renderDismissedList();
								setDismissedStatus('Restored. The finding is underlined again.');
							} else {
								restore.disabled = false;
								setDismissedStatus('That dismissal is no longer there.', true);
							}
						})
						.catch(function (error) {
							restore.disabled = false;
							setDismissedStatus('Could not restore: ' + error.message, true);
						});
				});
				row.appendChild(restore);
				host.appendChild(row);
			})(entries[i]);
		}

		// LEGACY ROW: hashes with no side-table entry, dismissed before the index existed. There is
		// nothing readable to name them by and no way to map one back to a finding, so the only action
		// offered is clearing them.
		if (state.dismissed.legacyCount > 0) {
			var legacy = el('div', 'hs-dismissed hs-dismissed-legacy');
			legacy.id = 'hs-legacy-row';
			var legacyText = el('div', 'hs-dismissed-text');
			// "findings", not "dismissals": this is a count of harper ignore hashes, and one Dismiss
			// routinely produces several of them (the multi-pass loop exists because harper surfaces
			// overlapping findings on a span one at a time). Unattributed hashes carry no record of how
			// many dismissals produced them, so the honest unit is the one thing each hash IS — an
			// ignored finding.
			legacyText.appendChild(
				el('span', 'hs-dismissed-rule', state.dismissed.legacyCount + ' legacy findings'),
			);
			legacyText.appendChild(
				el('div', 'hs-help', 'Dismissed before Harper started recording what they were. They can only be cleared.'),
			);
			legacy.appendChild(legacyText);

			var clearLegacy = el('button', 'hs-button hs-button-small', 'Clear');
			clearLegacy.type = 'button';
			clearLegacy.id = 'hs-clear-legacy';
			clearLegacy.addEventListener('click', function () {
				clearLegacy.disabled = true;
				setDismissedStatus('Clearing…');
				send({ type: 'settings:clearDismissed', scope: 'legacy' })
					.then(function (reply) {
						state.dismissed.legacyCount = 0;
						renderDismissedList();
						setDismissedStatus('Cleared ' + ((reply && reply.cleared) || 0) + ' legacy findings.');
					})
					.catch(function (error) {
						clearLegacy.disabled = false;
						setDismissedStatus('Could not clear: ' + error.message, true);
					});
			});
			legacy.appendChild(clearLegacy);
			host.appendChild(legacy);
		}
	}

	function renderDismissed(root) {
		var section = el('div', 'hs-section');
		section.appendChild(
			el(
				'p',
				'hs-section-intro',
				'Findings you dismissed from the suggestion card. Restore one to have Harper flag it again.',
			),
		);

		var bar = el('div', 'hs-toolbar');
		var clearAll = el('button', 'hs-button', 'Clear all');
		clearAll.type = 'button';
		clearAll.id = 'hs-clear-all';
		clearAll.addEventListener('click', function () {
			// Inline confirm: the button becomes the question, so there is no modal-inside-a-modal (which
			// Joplin dialogs handle badly) and no second click needed for the reversible actions.
			//
			// ARMED-NESS LIVES ON THE NODE, never in `state`. This button is rebuilt from scratch — with
			// the unarmed label and the plain class — by every render: a tab switch, and the load() that
			// index.ts triggers before each reopen. A flag in `state` survived that rebuild, so a button
			// reading "Clear all" could be one click away from destroying every dismissal with no
			// confirmation ever shown. Worse, navigating away was the ONLY way to back out of the armed
			// state, so changing your mind was exactly what planted the trap. On the node, arming dies
			// with the node it was shown on, which makes leaving the tab a real cancel.
			if (clearAll.getAttribute('data-armed') !== 'true') {
				clearAll.setAttribute('data-armed', 'true');
				clearAll.textContent = 'Really clear all?';
				clearAll.className = 'hs-button hs-button-danger';
				return;
			}
			clearAll.setAttribute('data-armed', 'false');
			clearAll.textContent = 'Clear all';
			clearAll.className = 'hs-button';
			setDismissedStatus('Clearing…');
			send({ type: 'settings:clearDismissed', scope: 'all' })
				.then(function (reply) {
					state.dismissed = { entries: [], legacyCount: 0 };
					renderDismissedList();
					setDismissedStatus('Cleared ' + ((reply && reply.cleared) || 0) + ' dismissals.');
				})
				.catch(function (error) {
					setDismissedStatus('Could not clear: ' + error.message, true);
				});
		});
		bar.appendChild(clearAll);
		section.appendChild(bar);

		var status = el('div', 'hs-status');
		status.id = 'hs-dismissed-status';
		section.appendChild(status);

		var list = el('div', 'hs-dismissed-list');
		list.id = 'hs-dismissed-list';
		section.appendChild(list);

		root.appendChild(section);
		renderDismissedList();
	}

	// =============================================================================
	// Shell.
	// =============================================================================

	var TABS = [
		['general', 'General'],
		['rules', 'Rules'],
		['dictionary', 'Dictionary'],
		['dismissed', 'Dismissed'],
	];

	function renderTabBody() {
		var body = document.getElementById('hs-body');
		if (!body) return;
		clear(body);
		if (state.tab === 'general') renderGeneral(body);
		else if (state.tab === 'rules') renderRulesSection(body);
		else if (state.tab === 'dictionary') renderDictionary(body);
		else renderDismissed(body);
	}

	function render() {
		var root = document.getElementById('harper-settings');
		if (!root) return;
		clear(root);

		var scroll = el('div', 'hs-scroll');

		var head = el('div', 'hs-head');
		head.appendChild(el('h1', 'hs-title', 'Harper settings'));
		scroll.appendChild(head);

		var tabs = el('div', 'hs-tabs');
		tabs.id = 'hs-tabs';
		for (var i = 0; i < TABS.length; i++) {
			(function (id, label) {
				var button = el('button', 'hs-tab' + (state.tab === id ? ' hs-tab-active' : ''), label);
				button.type = 'button';
				button.setAttribute('data-tab', id);
				button.addEventListener('click', function () {
					if (state.tab === id) return;
					state.tab = id;
					render();
					if (id === 'rules') ensureDescriptions();
				});
				tabs.appendChild(button);
			})(TABS[i][0], TABS[i][1]);
		}
		scroll.appendChild(tabs);

		var body = el('div', 'hs-body');
		body.id = 'hs-body';
		scroll.appendChild(body);
		root.appendChild(scroll);

		renderTabBody();
	}

	// =============================================================================
	// Loading.
	// =============================================================================

	var descriptionsRequested = false;

	/**
	 * Pull the ~823 description strings ONCE, in the background.
	 *
	 * Deliberately not part of the first snapshot: that payload would roughly triple in size and delay
	 * the first paint of a screen whose whole job is to feel instant. Anything already rendered picks
	 * the text up on the next render pass.
	 */
	function ensureDescriptions() {
		if (descriptionsRequested || state.descriptions) return;
		descriptionsRequested = true;
		send({ type: 'settings:descriptions' })
			.then(function (map) {
				state.descriptions = map || {};
				var names = Object.keys(state.descriptions);
				for (var i = 0; i < names.length; i++) {
					state.descriptionText[names[i]] = stripHtml(state.descriptions[names[i]]);
				}
				if (state.tab === 'rules') renderRules();
			})
			.catch(function () {
				// Descriptions are a nicety; the browser stays fully usable without them.
				state.descriptions = {};
				if (state.tab === 'rules') renderRules();
			});
	}

	function showFatal(message) {
		var root = document.getElementById('harper-settings');
		if (!root) return;
		clear(root);
		var box = el('div', 'hs-scroll');
		box.appendChild(el('h1', 'hs-title', 'Harper settings'));
		box.appendChild(el('p', 'hs-status hs-status-error', 'Could not load settings: ' + message));
		root.appendChild(box);
	}

	function load() {
		// includeDescriptions:false — fast first paint. ensureDescriptions() fetches them right after.
		return send({ type: 'settings:snapshot', includeDescriptions: false })
			.then(function (snapshot) {
				if (!snapshot) throw new Error('no snapshot');
				state.settings = snapshot.settings || {};
				state.defaults = snapshot.defaults || {};
				state.overrides = {};
				// The snapshot IS the truth, so nothing queued before it is still unconfirmed: replaying
				// those edits on top of a later reply would resurrect state this load just superseded.
				queuedEdits = [];
				// Copy, not alias: the reply object is a one-shot structured clone and this map is edited
				// in place on every toggle.
				var flat = snapshot.flatConfig || {};
				var keys = Object.keys(flat);
				for (var i = 0; i < keys.length; i++) {
					if (typeof flat[keys[i]] === 'boolean') state.overrides[keys[i]] = flat[keys[i]];
				}
				state.groups = buildGroups(snapshot.structured, state.defaults, state.overrides);
				state.dictionaryWords = snapshot.dictionaryWords || [];
				state.dismissed = snapshot.dismissed || { entries: [], legacyCount: 0 };
				state.loaded = true;
				render();
				ensureDescriptions();
			})
			.catch(function (error) {
				showFatal(error.message);
			});
	}

	// A reopened dialog may reuse a still-mounted webview, in which case none of the above re-runs and
	// the user would be looking at the state from the previous open. index.ts posts this right before
	// every open(); when the webview really was torn down the message is dropped and the fresh script
	// load below covers it instead. Reloading twice is harmless — it is the same idempotent fetch.
	if (typeof webviewApi !== 'undefined' && webviewApi.onMessage) {
		webviewApi.onMessage(function (event) {
			// NOTE the wrapper: the payload arrives as `{ message }`, not as the message itself.
			var message = event && event.message;
			if (message && message.type === 'settings:refresh') load();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', load);
	} else {
		load();
	}
})();
