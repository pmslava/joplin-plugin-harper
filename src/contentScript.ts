// Joplin CM6 content script: registers a stock @codemirror/lint linter that delegates the actual
// grammar checking to the plugin main process (where harper.js/WASM runs), and renders Harper's
// browser-extension card UI (per-kind colored underlines + a suggestion card) using ONLY hand-written
// DOM + CSS.
//
// IMPORTANT: @codemirror/* modules are consumed as webpack EXTERNALS (see webpack.config.js).
// Joplin injects its own copies of these into the editor at runtime; bundling ours would duplicate
// CodeMirror and break the editor. We NEVER bundle harper.js, virtual-dom, colorjs.io or FontAwesome
// here — every color/icon/luminance value below is precomputed and every DOM node is built by hand.
//
// MECHANISM (Phase 2): we keep Joplin's stock `linter()` + `setDiagnostics` relint pipeline from
// Phase 1 (forceLinting() is a no-op in Joplin — never rely on it) and layer the card on top of it:
//   - per-kind underline: each Diagnostic carries `markClass = "harper-lintRange-<Kind>
//     <harper-squiggly-style|harper-web-style>"`. Joplin's bundled @codemirror/lint applies markClass
//     to the range decoration (verified: the bundle builds
//     `class:"cm-lintRange cm-lintRange-<sev> <markClass>"`), and our injected stylesheet paints the
//     per-kind underline for that class. WHICH of the two style classes is used comes from the
//     `underlineStyle` setting via the getConfig handshake (v1.2.0) — see `underlineStyleClass`.
//   - the card: each Diagnostic sets `renderMessage(view)` to a hand-built Harper card. The card is
//     built by that same `renderMessage`/renderCard path on the CLICK trigger below.
//   - CLICK is the ONLY trigger (v1.0.2): a `click` on a lint underline opens the card via our own
//     `showTooltip` StateField — see the `clickCardField` / `buildClickTooltip` block.
//   - NO HOVER (v1.0.2): the @codemirror/lint hover tooltip is fully suppressed at its source by
//     passing `tooltipFilter: () => null` to `linter()`. The bundled hover source (`lintTooltip`)
//     does `if (found && filter) found = filter(found, state); if (!found) return null;`, so a
//     null return makes the hover source return null and CM6 never creates the `.cm-tooltip-lint`
//     element at all — suppression at the source, not a CSS hide. See the `linter()` call for the
//     full rationale. Matches Harper's own browser extension, which is click-only on prose.

import { linter, setDiagnostics, forEachDiagnostic, Diagnostic } from '@codemirror/lint';
import { EditorView, showTooltip, Tooltip } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface PlainSuggestion {
	kind: 'Replace' | 'Remove' | 'InsertAfter';
	replacementText: string;
}
interface PlainLint {
	start: number;
	end: number;
	kind: string;
	kindPretty: string;
	ruleName: string;
	message: string;
	messageHtml: string;
	problemText: string;
	suggestions: PlainSuggestion[];
}

// Joplin's ContentScriptContext (typed loosely to avoid coupling to a specific api version).
interface ContentScriptContext {
	postMessage: (message: unknown) => Promise<unknown>;
	pluginId: string;
	contentScriptId: string;
}

// The CodeMirror wrapper Joplin passes to `plugin()`. Only the bits we use are typed.
interface CodeMirrorControl {
	cm6?: unknown;
	editor?: EditorView;
	addExtension: (extension: unknown | unknown[]) => void;
	registerCommand: (name: string, callback: (...args: unknown[]) => unknown) => void;
}

// Fallback debounce if the config handshake fails (ms).
const DEFAULT_DELAY_MS = 500;

// -----------------------------------------------------------------------------
// L5 IDEMPOTENCY GUARD. Joplin mobile double-mounts content scripts (joplin#12891): the same editor's
// `plugin()` gets called twice, which without a guard doubles the linter extension + click handler
// (the v0.0.4 device symptom: two squiggles, two cards). We record activated editors in a registry
// kept on `window` (SHARED across both content-script module evaluations in the same editor WebView —
// a module-level set would NOT be, since a re-mount re-evaluates the module) keyed by the EditorView
// instance, and make the second activation on the same editor a no-op.
function alreadyActivated(view: unknown | undefined): boolean {
	// Only dedupe when we have a concrete editor instance to key on. If the view is somehow absent we
	// proceed (a false "already activated" would wrongly leave a real second editor with no linter).
	if (!view || typeof view !== 'object') return false;
	try {
		const w = window as unknown as { __harperActivatedEditors?: WeakSet<object> };
		if (!w.__harperActivatedEditors) w.__harperActivatedEditors = new WeakSet<object>();
		const key = view as object;
		if (w.__harperActivatedEditors.has(key)) return true;
		w.__harperActivatedEditors.add(key);
		return false;
	} catch {
		return false; // no window (non-browser harness) — activation proceeds
	}
}

// -----------------------------------------------------------------------------
// PER-WINDOW DOCUMENT. Joplin's "Open in new window" renders the SAME React editor into a SECOND
// Electron window (window.open('about:blank') + createPortal, gui/NewWindowOrIFrame.tsx) while this
// content script keeps running in the MAIN renderer's JS realm — so the bare global `document` is
// ALWAYS the main window's, no matter which window the editor is painted in. Joplin replicates its own
// theme/chrome stylesheets into each secondary document but has no mechanism to replicate a plugin's
// appended <style>, so every stylesheet injection and every node we create must go through the
// EDITOR'S own document instead. `view.dom.ownerDocument` is that document (CM6 adopts the view's DOM
// into the portal target on mount); the fallback keeps the DOM-less Node harness a no-op.
// -----------------------------------------------------------------------------
function documentOf(view: EditorView | undefined): Document | undefined {
	try {
		const dom = view ? (view.dom as HTMLElement) : null;
		if (dom && dom.ownerDocument) return dom.ownerDocument;
	} catch {
		/* fall through to the global document */
	}
	return typeof document === 'undefined' ? undefined : document;
}

/** The window that owns `el` — the secondary window when the editor is painted there. */
function windowOf(el: HTMLElement): Window {
	const doc = el.ownerDocument;
	return (doc && doc.defaultView) || window;
}

// Mobile tap-target CSS (Material ~48 dp / Apple HIG ~44 pt). Injected only when the platform handshake
// reports 'mobile'; it bumps every card button to >=44 px min-height with roomier spacing so pills,
// add-to-dictionary and dismiss are comfortable to tap (mobile-product-design.md §2). Desktop is
// untouched — the class is never added there.
const MOBILE_STYLE_ELEMENT_ID = 'harper-plugin-mobile-styles';
const MOBILE_CSS = `
.harper-container.harper-mobile{max-width:92vw;padding:12px;}
.harper-container.harper-mobile .harper-btn{min-height:44px;padding:8px 14px;font-size:15px;}
.harper-container.harper-mobile .harper-footer{gap:12px;padding:6px;}
.harper-container.harper-mobile .harper-child-cont{gap:12px;}
.harper-container.harper-mobile .harper-close-btn{min-width:44px;min-height:44px;font-size:24px;}
.harper-container.harper-mobile .harper-disable-btn{min-width:44px;min-height:44px;}
.harper-container.harper-mobile .harper-dict-btn{min-width:44px;min-height:44px;}
`;
function ensureMobileStyles(doc: Document): void {
	if (!doc) return;
	if (doc.getElementById(MOBILE_STYLE_ELEMENT_ID)) return;
	const style = doc.createElement('style');
	style.id = MOBILE_STYLE_ELEMENT_ID;
	style.textContent = MOBILE_CSS;
	(doc.head || doc.documentElement).appendChild(style);
}

// Platform reported by the plugin main process via the getConfig handshake; 'mobile' enlarges tap
// targets. Set before the first card can open (the handshake runs at activation).
let isMobilePlatform = false;

// -----------------------------------------------------------------------------
// UNDERLINE STYLE (v1.2.0 — Harper issue #1710 "Prefer solid line to squiggly").
// Both rule-sets are ALWAYS in the injected stylesheet (buildKindCss below); this mutable value only
// decides which of the two classes each diagnostic's markClass carries, so switching styles is a pure
// re-decoration on the next relint. Refreshed live from getConfig at activation and on every
// `harper.forceLint` poke (which the plugin main process fires after any settings change).
// -----------------------------------------------------------------------------
const SQUIGGLY_STYLE_CLASS = 'harper-squiggly-style';
const WEB_STYLE_CLASS = 'harper-web-style';
let underlineStyleClass: string = SQUIGGLY_STYLE_CLASS;

/** Map a getConfig `underlineStyle` value onto the decoration class. Unknown values => squiggly. */
function applyUnderlineStyle(style: unknown): void {
	underlineStyleClass = style === 'solid' ? WEB_STYLE_CLASS : SQUIGGLY_STYLE_CLASS;
}

// -----------------------------------------------------------------------------
// Click-to-open card (v1.0.1; the ONLY trigger as of v1.0.2). A StateField holds at most one Tooltip
// and feeds it to `showTooltip`; a `click` domEventHandler (see the `plugin()` body) hit-tests the
// diagnostic ranges at the click position and dispatches `setClickCard` with a tooltip whose body is
// built by `diagnostic.renderMessage()` (renderCard). The stock @codemirror/lint hover tooltip that
// used to open the identical card is fully suppressed in v1.0.2 (see the linter() tooltipFilter), so
// this click path is now the sole way the card opens. The field self-closes on any document edit
// (map-through is unnecessary because the card is transient); Escape, an outside click, and every
// in-card action dispatch `setClickCard.of(null)`.
const setClickCard = StateEffect.define<Tooltip | null>();
const clickCardField = StateField.define<Tooltip | null>({
	create: () => null,
	update(value, tr) {
		if (tr.docChanged) return null; // close on any doc change
		for (const e of tr.effects) if (e.is(setClickCard)) value = e.value;
		return value;
	},
	provide: (f) => showTooltip.from(f),
});

// -----------------------------------------------------------------------------
// Harper's canonical LintKind -> color map (byte-identical to
// packages/lint-framework/src/lint/lintKindColor.ts and
// packages/obsidian-plugin/src/lintKindColor.ts in the Harper source). One color per kind, used in
// BOTH light and dark themes — Harper defines no dark override for range/pill colors.
// -----------------------------------------------------------------------------
const LINT_KIND_COLORS: Record<string, string> = {
	Agreement: '#228B22',
	BoundaryError: '#8B4513',
	Capitalization: '#540D6E',
	Eggcorn: '#FF8C00',
	Enhancement: '#0EAD69',
	Formatting: '#7D3C98',
	Grammar: '#9B59B6',
	Malapropism: '#C71585',
	Miscellaneous: '#3BCEAC',
	Nonstandard: '#008B8B',
	Punctuation: '#D4850F',
	Readability: '#2E8B57',
	Redundancy: '#4682B4',
	Regionalism: '#C061CB',
	Repetition: '#00A67C',
	Spelling: '#EE4266',
	Style: '#FFD23F',
	Typo: '#FF6B35',
	Usage: '#1E90FF',
	WordChoice: '#228B22',
	WordOrder: '#4D4DFF',
};
// Obsidian's fallback (the lint-framework throws instead; we never want a throw to break rendering).
const FALLBACK_LINT_COLOR = '#d11';

function lintKindColor(kind: string): string {
	return LINT_KIND_COLORS[kind] ?? FALLBACK_LINT_COLOR;
}

// Precomputed getContrastingTextColor (colorjs.io luminance > 0.5 ? black : white). By that rule only
// the two light fills read black text: Style #FFD23F and Miscellaneous #3BCEAC; all others white.
const BLACK_TEXT_KINDS = new Set(['Style', 'Miscellaneous']);
function lintKindTextColor(kind: string): 'black' | 'white' {
	return BLACK_TEXT_KINDS.has(kind) ? 'black' : 'white';
}

// -----------------------------------------------------------------------------
// Squiggle SVG data-URI generator — copied verbatim from
// packages/obsidian-plugin/src/lint.ts (svg()/underline(), lines 521-531).
// -----------------------------------------------------------------------------
function svg(content: string, attrs = 'viewBox="0 0 40 40"'): string {
	return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${encodeURIComponent(
		content,
	)}</svg>')`;
}
function underline(color: string): string {
	return svg(
		`<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width="1"/>`,
		'width="6" height="3"',
	);
}

const STYLE_ELEMENT_ID = 'harper-plugin-styles';

/**
 * Build the per-kind underline + code-chip rules from the color map (BOTH underline styles).
 *
 * Both rule-sets are always emitted; `underlineStyleClass` picks which one a given decoration opts
 * into (see toDiagnostic). Selector specificity is 0,3,0 — above Joplin's bundled @codemirror/lint
 * base theme (`.cm-lintRange-error` etc., 0,1,0), so ours wins for every declaration it makes.
 */
function buildKindCss(): string {
	let css = '';
	for (const [kind, color] of Object.entries(LINT_KIND_COLORS)) {
		// Straight ("web") style: solid 2px border + ~13% alpha fill (hex 0x22). lint.ts:532-541.
		//
		// `background-image:none` is OUR addition, not Harper's. Harper's Obsidian fork replaces the
		// whole @codemirror/lint module, so nothing else paints a squiggle there. We ride on JOPLIN's
		// BUNDLED @codemirror/lint, whose base theme sets an UNCONDITIONAL severity squiggle
		// (`.cm-lintRange-error{background-image:underline("#f11")}`, dist/index.js:678-681). Without
		// this reset that red/orange squiggle would still paint underneath the solid line, so "solid"
		// would in fact be "solid + squiggle". Everything else is the spec's exact values.
		css += `.cm-lintRange.harper-lintRange-${kind}.harper-web-style{border-bottom:2px solid ${color};background-color:${color}22;background-image:none;}\n`;
		// Squiggly style (Harper/Obsidian default). lint.ts:543-552.
		css += `.cm-lintRange.harper-lintRange-${kind}.harper-squiggly-style{background-image:${underline(
			color,
		)};background-position:left bottom;background-repeat:repeat-x;padding-bottom:0.7px;}\n`;
	}
	return css;
}

// The card stylesheet (Harper SuggestionBox.ts:294-483) reproduced verbatim in spirit, with three
// Joplin adaptations documented in the phase-2 report:
//   1. dark mode is a `.harper-container.harper-dark` class (we detect the editor's theme by
//      background luminance) instead of `@media (prefers-color-scheme:dark)` — Joplin's editor theme
//      is independent of the OS scheme.
//   2. the global `code{}` rule is scoped to `.harper-body code` so it never restyles editor code
//      spans (the card is NOT in a shadow root — a CM hoverTooltip lives in the normal editor DOM).
//   3. the lint tooltip chrome is neutralized so the card supplies its own border/shadow.
const CARD_CSS = `
.cm-tooltip.cm-tooltip-lint{background:transparent;border:none;padding:0;}
.cm-tooltip-lint ul{margin:0;padding:0;list-style:none;}
.cm-tooltip-lint .cm-diagnostic{padding:0;margin:0;border:none;background:transparent;}
.cm-tooltip-lint .cm-diagnosticText{display:block;margin:0;}
.cm-tooltip-lint .cm-diagnosticSource{display:none;}
/* Click-to-open (v1.0.1): our own showTooltip wrapper is a plain .cm-tooltip (NOT .cm-tooltip-lint),
   so neutralize the default tooltip chrome — the .harper-container supplies its own border/shadow. */
.cm-tooltip.harper-click-tooltip{background:transparent;border:none;padding:0;}
.harper-container{max-width:420px;max-height:400px;overflow-y:auto;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 12px rgba(140,149,159,0.3);padding:8px;display:flex;flex-direction:column;z-index:5000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;pointer-events:auto;}
/* Joplin's CM editor injects a generated-theme rule ".ͼ1g div,span,a{font-family:inherit}"
   (specificity 0,1,1) that beats ".harper-container" (0,1,0), so the card inherited the editor's
   MONOSPACE font. Re-apply the spec's sans stack to the container's div/span/a descendants at higher
   specificity (0,2,1) so the card renders sans-serif like Harper's extension; <code> stays monospace. */
.harper-container,.harper-container div,.harper-container span,.harper-container a{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
.harper-container button{font-family:inherit;}
.harper-header{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:14px;line-height:20px;color:#1f2328;padding-bottom:4px;margin-bottom:4px;user-select:none;}
.harper-title{display:flex;align-items:center;gap:6px;}
/* Spec (§2.3) pins font-size/line-height/color but is SILENT on body margins, and §2.7's footer has
   no margin-top, so the message line sat 4px below the header and 0px above the pills — cramped vs the
   extension. Judgment call: add modest vertical margins (top 4px -> 8px total header gap given the
   header's spec'd margin-bottom:4px; bottom 8px -> 8px pill gap) for the extension's roomier rhythm. */
.harper-body{font-size:14px;line-height:20px;color:#57606a;margin-top:4px;margin-bottom:8px;}
.harper-body code{text-decoration:underline solid var(--harper-kind-color) 2px;padding:0.125rem;border-radius:0.25rem;}
.harper-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;cursor:pointer;border:none;border-radius:6px;padding:3px 6px;min-height:28px;font-size:13px;font-weight:600;line-height:20px;transition:background 120ms ease,transform 80ms ease;}
.harper-btn:hover{filter:brightness(0.92);}
.harper-btn:active{transform:scale(0.97);}
.harper-close-btn{background:transparent;border:none;cursor:pointer;font-size:20px;line-height:1;color:#57606a;padding:0 4px;}
.harper-close-btn:hover{color:#1f2328;}
.harper-disable-btn{background:transparent;border:none;cursor:pointer;font-size:18px;line-height:1;color:#57606a;padding:0 4px;display:inline-flex;align-items:center;justify-content:center;}
.harper-disable-btn:hover{color:#1f2328;}
.harper-disable-btn svg{width:18px;height:18px;display:block;}
.harper-controls{display:flex;align-items:center;gap:3px;}
.harper-child-cont{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:center;}
.harper-footer{display:flex;flex-wrap:wrap;justify-content:space-between;padding:2px;gap:16px;}
.harper-dict-btn svg{width:20px;height:20px;display:block;}
.fade-in{animation:harperFadeIn 100ms ease-in-out forwards;}
@keyframes harperFadeIn{from{opacity:0;transform:scale(0.95);}to{opacity:1;transform:scale(1);}}
.harper-container.harper-dark .harper-body code{background-color:#1f2d3d;color:#c9d1d9;}
.harper-container.harper-dark{background:#0d1117;border-color:#30363d;box-shadow:0 4px 12px rgba(1,4,9,0.85);}
.harper-container.harper-dark .harper-header{color:#e6edf3;}
.harper-container.harper-dark .harper-body{color:#8b949e;}
.harper-container.harper-dark .harper-btn{background:#21262d;color:#c9d1d9;}
.harper-container.harper-dark .harper-btn:hover{filter:brightness(1.15);}
.harper-container.harper-dark .harper-close-btn,.harper-container.harper-dark .harper-disable-btn{color:#8b949e;}
.harper-container.harper-dark .harper-close-btn:hover,.harper-container.harper-dark .harper-disable-btn:hover{color:#e6edf3;}
.harper-container.harper-dark .harper-btn[style*="background: #e5e5e5"]{background:#4b4b4b;color:#ffffff;}
`;

/**
 * Inject the underline + card stylesheet once into `doc`'s head (idempotent PER DOCUMENT — a
 * secondary window gets its own copy; see documentOf).
 */
function ensureStyles(doc: Document): void {
	if (!doc) return;
	if (doc.getElementById(STYLE_ELEMENT_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = buildKindCss() + CARD_CSS;
	(doc.head || doc.documentElement).appendChild(style);
}

// -----------------------------------------------------------------------------
// Theme detection: Joplin's editor theme is independent of the OS color scheme, so we do NOT use
// `prefers-color-scheme`. We read the editor's own background color and treat a dark background as
// dark mode, toggling a `.harper-dark` class on the card (per-kind underline/pill colors stay
// literal — they are theme-independent by Harper's design).
// -----------------------------------------------------------------------------
function parseRgb(bg: string): { r: number; g: number; b: number; a: number } | null {
	const m = bg.match(/rgba?\(([^)]+)\)/);
	if (!m) return null;
	const p = m[1].split(',').map((n) => parseFloat(n));
	if (p.length < 3) return null;
	return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function isDark(rgb: { r: number; g: number; b: number }): boolean {
	// Perceived luminance (Rec. 601), 0..1. < 0.5 => dark background.
	return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 < 0.5;
}

/**
 * Whether the editor is in a dark theme. The `.cm-editor` element's own background is often
 * transparent (the solid themed background sits on a parent, or is expressed via Joplin's
 * `--joplin-background-color`), so we walk up from the content DOM to the first element with an
 * OPAQUE background and judge its luminance; failing that we fall back to Joplin's CSS variable.
 */
function isDarkEditor(view: EditorView): boolean {
	try {
		let el: HTMLElement | null = (view.contentDOM as HTMLElement) || (view.dom as HTMLElement);
		for (let i = 0; el && i < 12; i++) {
			const rgb = parseRgb(windowOf(el).getComputedStyle(el).backgroundColor);
			if (rgb && rgb.a > 0) return isDark(rgb);
			el = el.parentElement;
		}
	} catch {
		/* fall through */
	}
	try {
		const dom = view.dom as HTMLElement;
		const varBg = windowOf(dom).getComputedStyle(dom).getPropertyValue('--joplin-background-color').trim();
		if (varBg) {
			if (varBg.startsWith('#')) {
				const hex = varBg.slice(1);
				const n = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
				return isDark({
					r: parseInt(n.slice(0, 2), 16),
					g: parseInt(n.slice(2, 4), 16),
					b: parseInt(n.slice(4, 6), 16),
				});
			}
			const rgb = parseRgb(varBg);
			if (rgb) return isDark(rgb);
		}
	} catch {
		/* ignore */
	}
	return false;
}

// -----------------------------------------------------------------------------
// message_html() sanitizer. The markup is Harper-generated (trusted) but crosses postMessage as a
// plain-JSON string, so we still parse it and rebuild a node tree from an allowlist of inline tags
// (dropping every attribute), exactly matching what Harper's renderer emits (<code>/<em>/<strong>).
// -----------------------------------------------------------------------------
const ALLOWED_TAGS = new Set(['CODE', 'EM', 'STRONG', 'B', 'I']);
function sanitizeInto(doc: Document, target: HTMLElement, html: string): void {
	const template = doc.createElement('template');
	template.innerHTML = html;
	const walk = (src: Node, dst: Node): void => {
		src.childNodes.forEach((child) => {
			if (child.nodeType === Node.TEXT_NODE) {
				dst.appendChild(doc.createTextNode(child.textContent || ''));
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const el = child as HTMLElement;
				if (ALLOWED_TAGS.has(el.tagName)) {
					const clean = doc.createElement(el.tagName.toLowerCase());
					walk(el, clean); // no attributes copied
					dst.appendChild(clean);
				} else {
					// Disallowed element: keep its text content (unwrap).
					walk(el, dst);
				}
			}
		});
	};
	walk(template.content, target);
}

// -----------------------------------------------------------------------------
// Icons (hand-written inline SVG substitutes — no FontAwesome). book-down is the exact Lucide glyph
// Harper ships (assets/bookDownSvg.ts); toggle-left is the Lucide proposal from the UI spec §4.
// -----------------------------------------------------------------------------
const BOOK_DOWN_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-down-icon lucide-book-down"><path d="M12 13V7"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="m9 10 3 3 3-3"/></svg>';
const TOGGLE_LEFT_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-toggle-left"><rect width="20" height="12" x="2" y="6" rx="6" ry="6"/><circle cx="8" cy="12" r="2"/></svg>';

function suggestionPillLabel(suggestion: PlainSuggestion): string {
	if (suggestion.replacementText !== '') return suggestion.replacementText;
	switch (suggestion.kind) {
		case 'Remove':
			return 'Remove';
		case 'InsertAfter':
			return 'Insert After';
		case 'Replace':
		default:
			return 'Replace';
	}
}

/** Apply a suggestion to the document exactly as Phase 1 did (the span is [from,to)). */
function applySuggestion(view: EditorView, from: number, to: number, suggestion: PlainSuggestion): void {
	if (suggestion.kind === 'Remove') {
		view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
	} else if (suggestion.kind === 'InsertAfter') {
		const text = suggestion.replacementText;
		view.dispatch({ changes: { from: to, to, insert: text }, selection: { anchor: to + text.length } });
	} else {
		const text = suggestion.replacementText;
		view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
	}
}

/** Hide the enclosing lint tooltip and return focus to the editor. */
function closeCard(container: HTMLElement, view: EditorView): void {
	const tooltip = container.closest('.cm-tooltip') as HTMLElement | null;
	if (tooltip) tooltip.style.display = 'none';
	else container.style.display = 'none';
	// The card is opened via click-to-open, so clear the StateField too so the tooltip is fully
	// torn down (not merely hidden). The `field(...false)` guard also keeps this a no-op if the field
	// is somehow absent. Guarded because `view` may be mid-teardown.
	try {
		if (view.state.field(clickCardField, false)) {
			view.dispatch({ effects: setClickCard.of(null) });
		}
	} catch {
		/* ignore */
	}
	try {
		view.focus();
	} catch {
		/* ignore */
	}
}

// -----------------------------------------------------------------------------
// The card. Reproduces Harper's SuggestionBox tree (header / body / footer) with createElement.
// Mapping (UI spec §4): suggestion -> colored pill; Add to dictionary (Spelling) -> book-down icon;
// Ignore -> "Dismiss" grey pill; Disable rule -> header toggle icon. Gear/Report/Hint omitted.
// -----------------------------------------------------------------------------
function renderCard(
	context: ContentScriptContext,
	view: EditorView,
	docText: string,
	lint: PlainLint,
	relint: (view: EditorView) => void,
): HTMLElement {
	// The card is built for THIS view's window (documentOf), so it is styled and painted correctly
	// whether the editor lives in the main window or in a secondary "Open in new window" one.
	const doc = documentOf(view);
	ensureStyles(doc);
	const color = lintKindColor(lint.kind);

	const container = doc.createElement('div');
	container.className = 'harper-container fade-in';
	container.style.setProperty('--harper-kind-color', color);
	if (isDarkEditor(view)) container.classList.add('harper-dark');
	if (isMobilePlatform) {
		ensureMobileStyles(doc);
		container.classList.add('harper-mobile');
	}

	// --- header: kind title (colored underline) + controls (disable-rule, close) ----------------
	const header = doc.createElement('div');
	header.className = 'harper-header';
	header.style.borderBottom = `2px solid ${color}`;

	const title = doc.createElement('span');
	title.className = 'harper-title';
	title.textContent = lint.kindPretty || lint.kind;
	header.appendChild(title);

	const controls = doc.createElement('div');
	controls.className = 'harper-controls';

	if (lint.ruleName) {
		const disableBtn = doc.createElement('button');
		disableBtn.type = 'button';
		disableBtn.className = 'harper-disable-btn';
		disableBtn.title = `Disable rule ${lint.ruleName}`;
		disableBtn.setAttribute('aria-label', `Disable rule ${lint.ruleName}`);
		disableBtn.innerHTML = TOGGLE_LEFT_SVG;
		disableBtn.addEventListener('click', () => {
			postThenRelint(context, view, { type: 'disableRule', ruleName: lint.ruleName }, relint);
			closeCard(container, view);
		});
		controls.appendChild(disableBtn);
	}

	const closeBtn = doc.createElement('button');
	closeBtn.type = 'button';
	closeBtn.className = 'harper-close-btn';
	closeBtn.title = 'Close';
	closeBtn.setAttribute('aria-label', 'Close');
	closeBtn.textContent = '×';
	closeBtn.addEventListener('click', () => closeCard(container, view));
	controls.appendChild(closeBtn);

	header.appendChild(controls);
	container.appendChild(header);

	// --- body: message_html with the per-kind-underlined <code> word chip -----------------------
	const body = doc.createElement('div');
	body.className = 'harper-body';
	sanitizeInto(doc, body, lint.messageHtml || lint.message || '');
	container.appendChild(body);

	// --- footer: suggestion pills (left), dictionary icon + Dismiss (right) ---------------------
	const footer = doc.createElement('div');
	footer.className = 'harper-footer';

	const left = doc.createElement('div');
	left.className = 'harper-child-cont';
	for (const suggestion of lint.suggestions) {
		const label = suggestionPillLabel(suggestion);
		const pill = doc.createElement('button');
		pill.type = 'button';
		pill.className = 'harper-btn';
		pill.style.background = color;
		pill.style.color = lintKindTextColor(lint.kind);
		pill.title = `Replace with "${label}"`;
		pill.setAttribute('aria-label', `Replace with "${label}"`);
		pill.textContent = label;
		pill.addEventListener('click', () => {
			applySuggestion(view, lint.start, lint.end, suggestion);
			closeCard(container, view);
			relint(view);
		});
		left.appendChild(pill);
	}
	footer.appendChild(left);

	const right = doc.createElement('div');
	right.className = 'harper-child-cont';

	// Add-to-dictionary — Spelling lints only (UI spec §2.5a).
	if (lint.kind === 'Spelling') {
		const dictBtn = doc.createElement('button');
		dictBtn.type = 'button';
		dictBtn.className = 'harper-btn harper-dict-btn';
		dictBtn.title = 'Add word to user dictionary';
		dictBtn.setAttribute('aria-label', 'Add word to user dictionary');
		dictBtn.innerHTML = BOOK_DOWN_SVG;
		const word = lint.problemText;
		dictBtn.addEventListener('click', () => {
			postThenRelint(context, view, { type: 'addWord', word }, relint);
			closeCard(container, view);
		});
		right.appendChild(dictBtn);
	}

	// Dismiss (= our Phase-1 "Ignore") — grey pill, always present (UI spec §2.5b).
	const dismissBtn = doc.createElement('button');
	dismissBtn.type = 'button';
	dismissBtn.className = 'harper-btn';
	dismissBtn.style.background = '#e5e5e5';
	dismissBtn.style.color = '#000000';
	dismissBtn.style.fontWeight = 'lighter';
	dismissBtn.title = 'Ignore this lint';
	dismissBtn.setAttribute('aria-label', 'Ignore this lint');
	dismissBtn.textContent = 'Dismiss';
	dismissBtn.addEventListener('click', () => {
		postThenRelint(
			context,
			view,
			{
				type: 'ignoreLint',
				text: docText,
				start: lint.start,
				end: lint.end,
				ruleName: lint.ruleName,
			},
			relint,
		);
		closeCard(container, view);
	});
	right.appendChild(dismissBtn);

	footer.appendChild(right);
	container.appendChild(footer);

	return container;
}

/**
 * Post a message to the plugin main process, then recompute + apply diagnostics so the UI updates.
 *
 * We deliberately do NOT use `forceLinting(view)` here: in Joplin's bundled `@codemirror/lint`,
 * `forceLinting` returns without re-invoking the lint source, so a stale underline would linger for
 * actions that don't change the document (Add to dictionary / Ignore / Disable rule change no text).
 * Instead `relint` queries the plugin for fresh lints and dispatches them via `setDiagnostics`.
 */
function postThenRelint(
	context: ContentScriptContext,
	view: EditorView,
	message: unknown,
	relint: (view: EditorView) => void,
): void {
	void context.postMessage(message).then(
		() => relint(view),
		() => {
			/* main handler failed; nothing we can re-lint against */
		},
	);
}

function toDiagnostic(
	context: ContentScriptContext,
	docText: string,
	lint: PlainLint,
	relint: (view: EditorView) => void,
): Diagnostic {
	// Severity mapping: spelling => error, everything else => warning. The per-kind markClass drives
	// the visible underline color regardless (higher CSS specificity than the severity fallback).
	const severity: Diagnostic['severity'] = lint.kind === 'Spelling' ? 'error' : 'warning';

	return {
		from: lint.start,
		to: lint.end,
		severity,
		source: 'Harper',
		message: lint.message,
		// Per-kind underline: Joplin's bundled @codemirror/lint applies markClass to the range mark.
		// The style half is read at DIAGNOSTIC-BUILD time, so the next relint after a settings change
		// repaints every range in the newly chosen style (v1.2.0).
		markClass: `harper-lintRange-${lint.kind} ${underlineStyleClass}`,
		// The whole Harper card. No stock `actions` — the card carries every affordance itself. This
		// builder is invoked only by the CLICK path (buildClickTooltip); the hover tooltip that would
		// otherwise also call it is suppressed via linter()'s tooltipFilter (v1.0.2).
		renderMessage: (view: EditorView) => renderCard(context, view, docText, lint, relint),
	};
}

/**
 * Build the `showTooltip` Tooltip for a click-opened card. Anchors to the diagnostic span [from,to)
 * and renders the card via `diagnostic.renderMessage(view)` — the single card builder in this file
 * (renderCard), so the card DOM is exactly what the diagnostic describes.
 *
 * CM6 adds the `cm-tooltip` class DIRECTLY to the TooltipView's `dom` (it does not interpose its own
 * wrapper). If we returned the `.harper-container` as `dom`, CM's `.cm-tooltip` base-theme chrome
 * would land on the card itself and fight its own border/background/padding. So we return a thin
 * WRAPPER div (which becomes `.cm-tooltip.harper-click-tooltip`, neutralized by CARD_CSS) and nest
 * the real card inside it: `.cm-tooltip.harper-click-tooltip > .harper-container`.
 */
function buildClickTooltip(from: number, to: number, diagnostic: Diagnostic): Tooltip {
	return {
		pos: from,
		end: to,
		above: false,
		create: (view: EditorView) => {
			const doc = documentOf(view);
			const card = diagnostic.renderMessage
				? (diagnostic.renderMessage(view) as HTMLElement)
				: doc.createElement('div');
			const dom = doc.createElement('div');
			dom.className = 'harper-click-tooltip';
			dom.appendChild(card);
			return { dom };
		},
	};
}

export default (context: ContentScriptContext) => {
	return {
		plugin: (editorControl: CodeMirrorControl) => {
			// Only wire up on CodeMirror 6; the legacy CM5 emulation lacks `cm6`/addExtension.
			if (!editorControl.cm6) return;

			// L5: make a second activation on the SAME editor a no-op (mobile double-mounts content
			// scripts — joplin#12891). Without this the linter extension + click handler double up.
			if (alreadyActivated(editorControl.editor)) return;

			// Query the plugin main process for lints of the current document and map them to
			// @codemirror/lint diagnostics. Used both as the `linter()` source (debounced, on
			// docChanged) and by `relint` (immediate, after a card action / main-process poke).
			const runLint = async (view: EditorView): Promise<Diagnostic[]> => {
				const text = view.state.doc.toString();
				const response = (await context.postMessage({ type: 'lint', text })) as
					| PlainLint[]
					| null;
				if (!Array.isArray(response)) return [];
				return response.map((lint) => toDiagnostic(context, text, lint, relint));
			};

			// Recompute diagnostics now and apply them via `setDiagnostics` — see postThenRelint for
			// why we don't use `forceLinting`. Safe to call with no editor/view.
			const relint = (view: EditorView): void => {
				if (!view) return;
				void runLint(view).then(
					(diagnostics) => {
						try {
							view.dispatch(setDiagnostics(view.state, diagnostics));
						} catch {
							/* view may have been torn down */
						}
					},
					() => {
						/* lint request failed; leave existing diagnostics in place */
					},
				);
			};

			// LIVE DEBOUNCE (v1.0.1). The @codemirror/lint `linter()` delay is fixed at creation, so a
			// debounceMs change used to require reopening the note. Instead we run the linter with delay
			// 0 and do our OWN debouncing here against a MUTABLE `currentDelay`: every doc-changed call
			// clears the previous timer and arms a new one, so only the last settles into a `runLint`
			// (one lint per idle window). `currentDelay` is refreshed live by the `harper.forceLint`
			// command below, which the plugin main process pokes after any settings change.
			let currentDelay = DEFAULT_DELAY_MS;
			let debounceTimer: ReturnType<typeof setTimeout> | null = null;
			const debouncedLint = (view: EditorView): Promise<Diagnostic[]> =>
				new Promise<Diagnostic[]>((resolve) => {
					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						debounceTimer = null;
						void runLint(view).then(resolve, () => resolve([]));
					}, currentDelay);
				});

			// Click-to-open: hit-test the diagnostic ranges at the click position and (if a lint is hit)
			// open the SAME card anchored to that diagnostic; Escape / an outside click close it.
			const clickExtension = [
				clickCardField,
				EditorView.domEventHandlers({
					mousedown: (event: MouseEvent, view: EditorView): boolean => {
						// Only react to a primary-button click that lands ON a lint underline; otherwise,
						// if a card is open, an "outside" click closes it. Return false so we never
						// interfere with cursor placement / selection.
						if (event.button !== 0) return false;
						const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
						if (pos == null) return false;
						let hit: { from: number; to: number; d: Diagnostic } | null = null;
						forEachDiagnostic(view.state, (d, from, to) => {
							if (!hit && from <= pos && pos <= to) hit = { from, to, d };
						});
						if (hit) {
							const h = hit as { from: number; to: number; d: Diagnostic };
							view.dispatch({ effects: setClickCard.of(buildClickTooltip(h.from, h.to, h.d)) });
						} else if (view.state.field(clickCardField, false)) {
							view.dispatch({ effects: setClickCard.of(null) });
						}
						return false;
					},
					keydown: (event: KeyboardEvent, view: EditorView): boolean => {
						if (event.key === 'Escape' && view.state.field(clickCardField, false)) {
							view.dispatch({ effects: setClickCard.of(null) });
						}
						return false;
					},
				}),
			];
			editorControl.addExtension(clickExtension);

			// Ask the plugin main process for the configured debounce before building the linter, then
			// keep it live via the `harper.forceLint` poke.
			void (async () => {
				try {
					const config = (await context.postMessage({ type: 'getConfig' })) as
						| { enabled: boolean; debounceMs: number; underlineStyle?: string; platform?: string }
						| null;
					if (config && typeof config.debounceMs === 'number') currentDelay = config.debounceMs;
					if (config) applyUnderlineStyle(config.underlineStyle);
					if (config && config.platform === 'mobile') {
						isMobilePlatform = true;
						ensureMobileStyles(documentOf(editorControl.editor));
					}
				} catch {
					/* keep the default */
				}

				// Inject styles eagerly so the first underline paints with the per-kind color — into THIS
				// editor's own document, which is the secondary window's when the note was opened there.
				ensureStyles(documentOf(editorControl.editor));

				// linter delay 0: our `debouncedLint` owns the idle-delay against the mutable value.
				// tooltipFilter: () => null FULLY SUPPRESSES the stock hover tooltip (v1.0.2). The
				// bundled @codemirror/lint hover source (lintTooltip) applies this filter to the
				// diagnostics found under the pointer and then does `if (!found) return null`, so a null
				// return makes the hover-tooltip source return null and CM6 never creates the
				// `.cm-tooltip-lint` DOM node — the card can only ever be opened by CLICK (clickExtension
				// above). The DiagnosticFilter type declares a Diagnostic[] return, but the runtime
				// honors the null return; we cast to satisfy the type without lying at runtime. Verified
				// against Joplin's bundled build (6.8-era: exposes tooltipFilter / needsRefresh / hideOn)
				// and the devDep @codemirror/lint 6.9.7 — both share the exact
				// `if (found && filter) found = filter(...); if (!found) return null` hover source.
				const suppressHoverTooltip = (() => null) as unknown as (
					diagnostics: readonly Diagnostic[],
				) => Diagnostic[];
				editorControl.addExtension(
					linter(debouncedLint, { delay: 0, tooltipFilter: suppressHoverTooltip }),
				);

				// Register the command the plugin main process pokes after settings/dictionary changes.
				// We read `editorControl.editor` freshly on each invocation so a note switch (new view)
				// is handled, and re-lint via `relint` (setDiagnostics) rather than the no-op
				// `forceLinting`. `harper.forceLint` therefore genuinely refreshes the underlines AND
				// re-reads debounceMs + underlineStyle (via getConfig), so both apply live — no reopen.
				//
				// ORDERING (v1.2.0): the relint now runs INSIDE the getConfig continuation. debounceMs
				// only affects the NEXT typing burst, so the old code could fire it in parallel; the
				// underline style is baked into each Diagnostic's markClass by `toDiagnostic`, so a
				// relint that races ahead of the config reply would repaint in the OLD style and the
				// user would see no change until they typed again. Awaiting the config first makes the
				// poke itself the repaint. The rejection path still relints (with the current values),
				// so a failed handshake can never leave the underlines stale.
				try {
					editorControl.registerCommand('harper.forceLint', () => {
						const relintNow = (): void => {
							const current = editorControl.editor;
							if (current) relint(current);
						};
						void context.postMessage({ type: 'getConfig' }).then(
							(config) => {
								const c = config as { debounceMs?: number; underlineStyle?: string } | null;
								if (c && typeof c.debounceMs === 'number') currentDelay = c.debounceMs;
								if (c) applyUnderlineStyle(c.underlineStyle);
								relintNow();
							},
							() => {
								/* handshake failed — keep the current delay/style, but still refresh */
								relintNow();
							},
						);
					});
				} catch {
					/* registerCommand unavailable — main's poke will simply no-op */
				}
			})();
		},
	};
};
