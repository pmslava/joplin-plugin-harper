# Harper UI Spec — Phase 2 (joplin-plugin-harper)

Reference material mined from the Harper source (local clone, branch `master` @ commit
`3486414` — no `2.8.0` tag exists in this clone; treat as current main). Every value below is
cited `path:line` relative to the clone root
`…/scratchpad/research-harper/harper/`. Self-contained: an implementer never needs to reopen
the clone.

Two source designs exist and are **byte-identical in their color map**:
- `packages/lint-framework/` — the browser-extension card (virtual-dom + inline `<style>`). This
  is the UI the user's Firefox screenshot shows and the visual target.
- `packages/obsidian-plugin/src/lint.ts` + `State.ts` — a CM6-native fork of stock
  `@codemirror/lint` with per-kind underline colors. This is the closest structural template for
  our Joplin CM6 content script.

Our harper.js 2.7.0 (`node_modules/harper.js/dist/index.d.ts:47-88`) already exposes every method
used below: `get_problem_text()`, `lint_kind()`, `lint_kind_pretty()`, `message()`,
`message_html()`, `span()`, `suggestions()`. `Suggestion` has `kind()` +
`get_replacement_text()`. **No new WASM surface is required.**

---

## 1. PER-KIND UNDERLINES

### 1.1 The canonical LintKind → color map

Identical in both files:
- `packages/lint-framework/src/lint/lintKindColor.ts:7-28`
- `packages/obsidian-plugin/src/lintKindColor.ts:3-24`

There is **one color per kind**, used in **both light and dark themes** (Harper does NOT define
separate dark-theme underline colors — see §1.4). Comments are Harper's own.

| LintKind        | Hex       | Comment (Harper's) |
|-----------------|-----------|--------------------|
| Agreement       | `#228B22` | Forest green |
| BoundaryError   | `#8B4513` | Saddle brown |
| Capitalization  | `#540D6E` | Deep purple |
| Eggcorn         | `#FF8C00` | Dark orange |
| Enhancement     | `#0EAD69` | Green |
| Formatting      | `#7D3C98` | Amethyst purple |
| Grammar         | `#9B59B6` | Medium purple |
| Malapropism     | `#C71585` | Medium violet red |
| Miscellaneous   | `#3BCEAC` | Turquoise |
| Nonstandard     | `#008B8B` | Dark cyan |
| Punctuation     | `#D4850F` | Dark orange |
| Readability     | `#2E8B57` | Sea green |
| Redundancy      | `#4682B4` | Steel blue |
| Regionalism     | `#C061CB` | Vibrant purple |
| Repetition      | `#00A67C` | Green-cyan |
| Spelling        | `#EE4266` | Pink-red |
| Style           | `#FFD23F` | Yellow |
| Typo            | `#FF6B35` | Vibrant orange-red |
| Usage           | `#1E90FF` | Dodger blue |
| WordChoice      | `#228B22` | Forest green |
| WordOrder       | `#4D4DFF` | Royal blue |

**Shared colors:** `Agreement` and `WordChoice` are both `#228B22` (the only collision). All
others are distinct. This is the complete set of 21 kinds (mission listed 21; this map has all 21).

Fallback for an unknown kind: Obsidian returns `#d11` (`lintKindColor.ts:1,27`
`FALLBACK_LINT_COLOR = '#d11'`); the lint-framework `throw`s instead
(`lint-framework/.../lintKindColor.ts:34-38`). **Use the Obsidian fallback** so an unexpected kind
never breaks rendering.

### 1.2 Pill / chip text color helper

`getContrastingTextColor` (`lint-framework/src/lint/utils.ts:4-13`) picks black vs white by
luminance:
```
new Color(color).luminance > 0.5 ? 'black' : 'white'
```
Uses `colorjs.io` — **do not bundle it.** Precompute a static `LINT_KIND_TEXT_COLOR` map by hand.
By the >0.5 rule, only the two light fills read black text: **Style `#FFD23F` → black**,
**Miscellaneous `#3BCEAC` → black** (luminance ≈0.51). Every other kind → white. (Verify the two
borderline greens `#0EAD69`/`#3BCEAC` if you want exactness, but white is safe for all except Style
and Miscellaneous.)

### 1.3 The two underline styles (exact SVG/CSS)

Obsidian offers a per-user toggle "straight underline w/ background" vs "squiggly"
(`State.ts:37` default `useWebStyleLints = false` → **squiggly is the default**;
`HarperSettingTab.ts:129-133`). Class applied per range:
`harper-lintRange-<Kind>` + (`harper-web-style` | `harper-squiggly-style`)
(`State.ts:221`, `lintKindColor.ts:31` `lintKindClass`).

The SVG squiggle data-URI generator (`lint.ts:521-531`):
```js
function svg(content, attrs = 'viewBox="0 0 40 40"') {
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${encodeURIComponent(content)}</svg>')`;
}
function underline(color) {
  return svg(
    `<path d="m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0" stroke="${color}" fill="none" stroke-width="1"/>`,
    `width="6" height="3"`,
  );
}
```

**Straight (web) style** per kind (`lint.ts:532-541`):
```css
.cm-lintRange.harper-lintRange-<Kind>.harper-web-style {
  border-bottom: 2px solid <color>;
  background-color: <color>22;   /* i.e. color at ~13% alpha (hex 0x22) */
}
```

**Squiggly style** per kind (`lint.ts:543-552`):
```css
.cm-lintRange.harper-lintRange-<Kind>.harper-squiggly-style {
  background-image: <underline(color)>;   /* the SVG data-URI above */
  background-position: left bottom;
  background-repeat: repeat-x;
  padding-bottom: 0.7px;
}
```
Base `.cm-lintRange { padding-bottom: 0.7px }` (`lint.ts:685-687`).
Active/hovered range highlight: `.cm-lintRange-active { background-color:#ffdd9980 }`
(`lint.ts:709`).

Severity-based fallbacks (used when no kind class present) also exist for both styles
(`lint.ts:690-706`): error `#dd1111`/`#d11`, warning `orange`/`#ffa500`, info `#999`, hint `#66d`.
Harper always sets `severity:'error'` for every lint (`State.ts:218`), so kind classes drive
everything; the severity fallback only matters if you omit the kind class.

### 1.4 Dark theme

**Underlines:** Harper uses the **same per-kind hex in dark mode** — there is no dark override for
range colors. The colors are chosen to read on both backgrounds. (The `@media dark` block in the
card `<style>` only restyles the *card chrome*, not underline colors — see §2.7.)
**Recommendation for our plugin:** ship the colors as-is for both Joplin light and dark themes.
The two dark-fill purples (`Capitalization #540D6E`, `Formatting #7D3C98`) are the weakest on a
dark editor background; acceptable, but note as a possible future tweak (see UNKNOWNS).

---

## 2. THE CARD (browser-extension design)

Source: `packages/lint-framework/src/lint/SuggestionBox.ts` (whole file, 1-568). Built with
`virtual-dom`'s `h()`. It renders inside a **shadow-DOM host** (`RenderBox`) so the inline
`<style>` is fully scoped and cannot leak into / be leaked into by the page. **We cannot bundle
virtual-dom** — reproduce the identical DOM tree with hand-written `document.createElement`, and
the identical CSS string.

### 2.1 Overall tree (`SuggestionBox.ts:529-566`)

```
div.harper-container.fade-in                 (position:fixed, see §3)
├─ <style id="harper-suggestion-style">      (the whole stylesheet, §2.7)
├─ div.harper-header  (borderBottom: 2px solid <kindColor>)   ← §2.2
│   ├─ span.harper-title            = lint_kind_pretty()
│   └─ div.harper-controls          [disableRuleBtn?, gearBtn?, closeBtn]
├─ div.harper-body                  innerHTML = message_html()  ← §2.3
├─ div.harper-footer                                             ← §2.4/2.5
│   ├─ div.harper-child-cont (left)   = suggestion pills
│   └─ div.harper-child-cont (right)  = [addToDictionary? (Spelling only), Dismiss]
├─ div.harper-hint-drawer?          (10% random tip; OMIT for us — see §4)
└─ button.harper-report-link?       = "Report"                  ← §2.6
```

### 2.2 Header (`SuggestionBox.ts:108-176`)

- Container `div.harper-header`, inline style `borderBottom: 2px solid <kindColor>` — **this is the
  "colored kind title underline"** the user described. `.harper-header` CSS also has
  `padding-bottom:4px; margin-bottom:4px; font-weight:600; font-size:14px; line-height:20px`.
- `span.harper-title` — text is `box.lint.lint_kind_pretty()` (e.g. `"Spelling"`). Flex row,
  `gap:6px`.
- `div.harper-controls` — right-aligned cluster (`gap:3px`), containing up to three buttons in this
  order: **disable-rule**, **gear (settings)**, **close (×)**.
  - **close** `button.harper-close-btn` text `"×"`, `font-size:20px`, calls `refocusClose` →
    closes popup + restores editor cursor. Always present.
  - **gear** `button.harper-gear-btn`, `innerHTML = settingsIconSvg` (FontAwesome `faSliders`,
    `SuggestionBox.ts:2-3,17`). Present only if an `openOptions` action is supplied. In the
    extension it opens the extension options page. **Not applicable to us** (we have no options
    page) — omit, OR repurpose (see §4).
  - **disable-rule** `button.harper-disable-btn`, `innerHTML = disableIconSvg` (FontAwesome
    `faToggleOff`), CSS `transform: scaleX(-1)` (mirrored). Present only if `setRuleEnabled` +
    `rule` supplied. On click: `setRuleEnabled(rule, false)` then close. **This is where the
    extension hides rule-disabling** — behind the toggle icon in the header, NOT a footer button.

FontAwesome SVGs are generated at runtime via `icon(faSliders).html.join('')`. **We must not bundle
FontAwesome.** Substitute hand-written inline SVGs (see §4 for suggested replacements, e.g. Lucide
`sliders`/`toggle-left` paths, or plain Unicode `⚙` / a small SVG).

### 2.3 Body / the word chip (`SuggestionBox.ts:178-180`)

```js
function body(message_html) {
  return h('div', { className: 'harper-body', innerHTML: message_html }, []);
}
```
`message_html` = `lint.message_html()`. In Harper core this is
`render_markdown(self.message)` (`harper-core/src/linting/lint.rs:46-49`). **Harper rule messages
put the problem/target word in Markdown backticks**, so `render_markdown` emits
`<code>word</code>`. That `<code>` element **IS the highlighted chip** — there is no separate chip
component. It is styled by the stylesheet's `code{}` rule, colored per kind:
```css
code {
  text-decoration: underline solid <kindColor> 2px;
  padding: 0.125rem;
  border-radius: 0.25rem;
}
```
(`SuggestionBox.ts:294-300`; and dark mode adds `code{background-color:#1f2d3d;color:#c9d1d9}` at
`:439`). So "Did you mean to spell `CLAUDE` this way?" comes verbatim from `message_html()` with
`CLAUDE` wrapped in a per-kind-underlined, rounded `<code>`.
`.harper-body` itself: `font-size:14px; line-height:20px; color:#57606a` (dark `#8b949e`).

> **Security note for our plugin:** `message_html()` output is Harper-generated (trusted, from the
> WASM), but it still crosses postMessage as a plain-JSON string. Inject via `innerHTML` exactly as
> Harper does — Harper's own renderer only ever emits `<code>`/`<em>`/text. If paranoid, sanitize to
> an allowlist of `code`,`em`,`strong`. Do NOT hand-build the chip yourself; use `message_html()`.

### 2.4 Suggestion pills (`SuggestionBox.ts:243-261`, `button` 182-203`)

For each suggestion, a `button.harper-btn` whose **background = the kind color**, text color =
`lintKindTextColor(kind)` (§1.2):
```js
button(label, { background: lintKindColor(kind), color: lintKindTextColor(kind) }, () => apply(s), desc)
```
- `label` = `s.replacement_text` if non-empty, else the kind-label string from
  `suggestionKindToLabel` (`Replace`|`Remove`|`Insert After`, `:263-272`).
- `desc` (title/aria) = `Replace with "<label>"`.
- First pill gets a `FocusHook` → it is auto-focused when the card opens (`:252`).
- `.harper-btn` CSS (`:338-354`): `inline-flex; align-items:center; justify-content:center;
  gap:4px; border:none; border-radius:6px; padding:3px 6px; min-height:28px; font-size:13px;
  font-weight:600; line-height:20px; transition:background 120ms ease, transform 80ms ease`.
  Hover `filter:brightness(0.92)`; active `transform:scale(0.97)`.
- Dark mode: default `.harper-btn` background becomes `#21262d`/`color #c9d1d9`, hover
  `brightness(1.15)` (`:447-451`) — **but** the per-kind inline `background`/`color` styles win over
  these defaults (inline > stylesheet), so colored pills stay colored in dark mode; only
  uncolored buttons (Dismiss) pick up the dark defaults.

Apply behavior (`SuggestionBox.ts:548-551`): `box.applySuggestion(v); close();`.

### 2.5 Footer right cluster: dictionary icon + Dismiss (`SuggestionBox.ts:547-560`)

Right `div.harper-child-cont` (`justify-content:flex-end; gap:8px`) contains, in order:

**(a) Add-to-dictionary icon button** — only when `lint_kind === 'Spelling'` AND an
`addToUserDictionary` action exists (`:553-555`). `addToDictionary` (`:224-241`):
`button.harper-btn`, `innerHTML = bookDownSvg`, title/aria `"Add word to user dictionary"`, on
click `addToUserDictionary([box.lint.problem_text])`. **Exact SVG** (`assets/bookDownSvg.ts`,
Lucide `book-down`):
```html
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
 stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"
 class="lucide lucide-book-down-icon lucide-book-down">
  <path d="M12 13V7"/>
  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>
  <path d="m9 10 3 3 3-3"/>
</svg>
```
(This icon button is a `.harper-btn` with no inline background → uses the default grey pill styling,
light `transparent`? No — `.harper-btn` has no default `background` in light CSS, so it inherits
none; the SVG `currentColor` follows the surrounding text color. In dark mode it gets `#21262d`.)

**(b) Dismiss button** — only when `box.ignoreLint` exists (`:556-558`). `ignoreLint` (`:486-493`):
```js
button('Dismiss', { background:'#e5e5e5', color:'#000000', fontWeight:'lighter' }, onIgnore, 'Ignore this lint')
```
Grey pill, always black text, lighter weight. Dark mode remaps it via attribute selector:
`.harper-btn[style*="background: #e5e5e5"] { background:#4b4b4b; color:#ffffff }` (`:459-462`).
**Behavior:** calls the framework's `ignoreLint(hash)` (in the extension → persists an ignore of
that lint's spanless hash). This is exactly our existing **"Ignore"** action.

### 2.6 Report link (`SuggestionBox.ts:274-292`, mounted `:562-564`)

`button.harper-report-link` text `"Report"`, present only if a `reportError` action exists. Styled
as a text link (`:467-482`): `background:none; border:none; padding:0; color:#0969da;
font-size:13px; font-weight:600`; hover underline; dark `color:#58a6ff`. `margin-top:8px;
align-self:flex-start`.
**What it actually does (extension):** `reportError(lint, ruleId)` →
`ProtocolClient.openReportError(<±15-char context>, ruleId, '')`
(`chrome-plugin/src/contentScript/index.ts:27-32`) → background posts to the Harper feedback
backend **`https://writewithharper.com/api/problematic-lints`**
(`chrome-plugin/src/popup/ReportProblematicLint.svelte:20`). It is **NOT** a GitHub issue URL. For
our plugin there is no equivalent backend → **omit Report by default**, or make it open the Harper
GitHub repo `https://github.com/Automattic/harper` in the external browser (proposal, §4).

### 2.7 Full stylesheet (`SuggestionBox.ts:294-483`) — reproduce verbatim

Container:
```css
.harper-container {
  max-width:420px; max-height:400px; overflow-y:auto;
  background:#ffffff; border:1px solid #d0d7de; border-radius:8px;
  box-shadow:0 4px 12px rgba(140,149,159,0.3);
  padding:8px; display:flex; flex-direction:column; z-index:5000;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  pointer-events:auto;
}
```
Header/title/body: see §2.2/§2.3. Controls/close/gear/disable buttons: `:355-381`
(`.harper-close-btn` `font-size:20px color:#57606a`; `.harper-gear-btn`/`.harper-disable-btn`
`font-size:18px color:#57606a`, svg `18×18`; `.harper-disable-btn{transform:scaleX(-1)}`;
`.harper-controls{gap:3px}`).
Footer layout: `.harper-footer{display:flex; flex-wrap:wrap; justify-content:space-between;
padding:2px; gap:16px}`; `.harper-child-cont{display:flex; flex-wrap:wrap;
justify-content:flex-end; gap:8px}` (`:382-394`).
Animation (`:423-436`): `.fade-in{animation:fadeIn 100ms ease-in-out forwards}` from
`opacity:0;scale(0.95)` to `opacity:1;scale(1)`.

**Dark theme block** (`@media (prefers-color-scheme:dark)`, `:438-466`):
```css
code { background-color:#1f2d3d; color:#c9d1d9; }
.harper-container { background:#0d1117; border-color:#30363d; box-shadow:0 4px 12px rgba(1,4,9,0.85); }
.harper-header { color:#e6edf3; }
.harper-body { color:#8b949e; }
.harper-btn { background:#21262d; color:#c9d1d9; }
.harper-btn:hover { filter:brightness(1.15); }
.harper-close-btn, .harper-gear-btn, .harper-disable-btn { color:#8b949e; }
  (hover → #e6edf3)
.harper-btn[style*="background: #2DA44E"] { background:#238636; }   /* legacy accept-green, unused here */
.harper-btn[style*="background: #e5e5e5"] { background:#4b4b4b; color:#ffffff; }  /* Dismiss */
.harper-hint-drawer{…}  .harper-hint-icon{…}  .harper-hint-title{…}
```
Plus `.harper-report-link{color:#58a6ff}` in a second dark block (`:480-482`).

> **Joplin theming caveat:** Harper's card keys off `prefers-color-scheme`. Joplin's editor theme
> is NOT necessarily tied to the OS scheme (user can force light/dark inside Joplin). **Do not rely
> on `prefers-color-scheme`.** Instead derive light/dark from Joplin's editor CSS variables or the
> `theme` we already read in Phase 1, and toggle a class (e.g. `.harper-dark`) on the card root, OR
> replace hardcoded hexes with Joplin CSS vars (`--joplin-background-color`,
> `--joplin-color`, `--joplin-divider-color`, `--joplin-background-color-hover`). See §5.

---

## 3. BEHAVIOR (open / position / close)

Source: `packages/lint-framework/src/lint/PopupHandler.ts`.

- **Open trigger: click, not hover.** Each lint's source element gets a `pointerdown` listener
  (`PopupHandler.ts:171-176`); on pointerdown inside a lint box the card for that lint opens
  (`:100-113`). There is **also** an optional keyboard activation: double-tap of an "activation key"
  (shift/control, configurable, default off) opens the card nearest the caret
  (`:16-28, 71-96`). **No hover-open in the extension.**
- **Positioning** (`SuggestionBox.ts:506-520`): `position:fixed`. Default anchor is **below** the
  underline: `top = box.y + box.height + 3`, `left = box.x`. If `top + 400 > innerHeight` it flips
  to open **upward**: sets `bottom = innerHeight - box.y - 3` and `transformOrigin: bottom left`
  (else `top left`). Width capped 420px, height 400px w/ internal scroll.
- **Close:**
  - `×` close button → `refocusClose` (`:524-527`): restore editor cursor/selection then close.
  - **Escape** key → `CloseOnEscapeHook` (`:86-106`) window keydown listener → `refocusClose`.
  - Pointerdown **outside** any lint box → `popupLint = undefined` → hide (`:100-113`).
  - Applying a suggestion or Dismiss closes the card.
  - Focus management: opening steals focus to the first pill (`FocusHook`, `:68-84`) after saving
    the editor's cursor (`saveCursorState`), and restores it on close (`restoreCursorState`,
    `:20-66`). Popover uses the native `popover="manual"` API on the shadow host
    (`PopupHandler.ts:60`).
- **Transitions:** `fade-in` 100ms scale/opacity on open (§2.7). No exit animation.

The Obsidian CM6 variant instead uses `hoverTooltip(lintTooltip, { hideOn })` **plus** a
keyboard-command tooltip (`lint.ts:833` `hoverTooltip(...)`, `:772-802` `commandTooltipField`
via `showTooltip`). So **Obsidian = hover-to-open**; **extension = click-to-open**. We choose
below (§5).

---

## 4. MAPPING TABLE — Harper card → our existing Phase-1 actions

Our Phase-1 stock tooltip currently exposes: `Replace with "X"`, `Add to dictionary`, `Ignore`,
`Disable rule Y`. Map onto the card as:

| Our Phase-1 action        | Card affordance | Source of truth | Notes |
|---------------------------|-----------------|-----------------|-------|
| `Replace with "X"` (each suggestion) | **Suggestion pill** (`.harper-btn`, background=kind color) | `SuggestionBox.ts:243-261` | label = replacement text; first pill autofocused; on click apply + close |
| `Add to dictionary` (Spelling only) | **book-down icon button** in footer-right | `:224-241,553-555` | gated on `lint_kind==='Spelling'`; passes `problem_text`. Wire to our external-dictionary writer |
| `Ignore` | **Dismiss** grey pill (footer-right) | `:486-493,556-558` | wire to our existing ignore-persist |
| `Disable rule Y` | **disable-rule toggle icon** in header controls | `:143-160` | extension hides rule-toggling behind the header toggle icon, not a footer button. **Proposal:** keep it as a header icon button `title="Disable rule <ruleId>"`; wire to our `ruleOverrides` setting. If a header icon feels too hidden, a secondary acceptable option is a small text button next to Dismiss — but the faithful Harper placement is the header. |
| (n/a) Settings **gear** | header gear icon | `:127-141` | extension-only (opens options page). **We have no options page → omit.** Optional repurpose: open Joplin's plugin settings screen if reachable. |
| (n/a) **Report** | text link bottom-left | `:274-292` | extension posts to Harper's backend. **Omit by default.** Proposal if wanted: open `https://github.com/Automattic/harper` externally (requires user-gated external-link open). |
| (n/a) **Hint drawer** | 10%-random tip | `:211-222,561` | Cosmetic, pulls `assets/hints.json`. **Omit** — extension-specific flavor. |

Icon substitutions (no FontAwesome bundling):
- gear → omit, or hand-write Lucide `sliders-horizontal`, or Unicode `⚙`.
- disable-rule (mirrored toggle-off) → hand-write Lucide `toggle-left`:
  `<svg …><rect width="20" height="12" x="2" y="6" rx="6"/><circle cx="8" cy="12" r="2"/></svg>`
  (proposal; verify visually).
- add-to-dictionary → use the exact `bookDownSvg` in §2.5 (it's plain inline SVG, safe to inline).

---

## 5. IMPLEMENTATION NOTES for our CM6 content script

**What Obsidian renders differently from the extension card:**
- Obsidian does **not** render the fancy card at all — it uses a fork of stock `@codemirror/lint`'s
  diagnostic renderer (`renderDiagnostic`, `lint.ts:422-499`): a `<li.cm-diagnostic>` with
  `.cm-diagnosticTitle` (kind name, `box-shadow: inset 0 -2px <kindColor>` = the colored underline,
  `:553-560`), `.cm-diagnosticText` (`innerHTML = message_html()` via `renderMessage`,
  `State.ts:223-227`), a flat row of `.cm-diagnosticAction` buttons for suggestions, and separate
  `Ignore Diagnostic` / `Disable Rule` text rows (`:471-498`). This is essentially our current
  Phase-1 UI. **Obsidian gives us the per-kind underline coloring + `message_html` wiring; the
  extension gives us the pretty card.** We want the extension's *visual* card with the CM6
  *plumbing*.
- Obsidian opens via `hoverTooltip`; the extension opens via click. **Recommendation for Joplin:**
  build a custom `hoverTooltip` (Joplin provides `@codemirror/view`'s `hoverTooltip` — declared as
  an external, never bundled) whose `create(view, pos)` builds the card DOM by hand. Hover matches
  Joplin/CM idioms and avoids stealing the editor selection. If hover proves fiddly with our
  postMessage-delivered diagnostics, fall back to a click handler mirroring `PopupHandler`.

**Direct-mapping building blocks from `lint.ts` we can reuse (reimplemented, not imported):**
- `underline(color)` + `svg()` (`:521-531`) — the squiggly data-URI generator: copy verbatim into a
  `baseTheme` (via `EditorView.baseTheme`, `@codemirror/view` is external). Generate
  `harper-lintRange-<Kind>.harper-squiggly-style` and `.harper-web-style` rules from our hand-copied
  color map exactly as `lintKindRangeThemeStraight`/`Squiggly` do (`:532-552`).
- Range decoration class assembly (`lint.ts:133-137`, `State.ts:221`):
  `cm-lintRange harper-lintRange-<Kind> <harper-squiggly-style|harper-web-style>`. We attach these
  via our existing `@codemirror/lint` diagnostics' `markClass`, OR via our own
  `Decoration.mark` set. **Note:** stock Joplin `@codemirror/lint` `Diagnostic` supports
  `markClass` (confirmed in the fork's interface, `lint.ts:36-56`) — so we can keep using Joplin's
  `linter()`/`setDiagnostics` and just set `markClass` per lint to get per-kind underlines, then
  layer our custom hoverTooltip for the card. This is the least-invasive path and keeps the Phase-1
  relint pipeline intact (remember: `forceLinting()` is a no-op in Joplin — never rely on it).
- The card itself: hand-write the `SuggestionBox` DOM tree (§2.1) with `document.createElement`,
  and inject the §2.7 stylesheet once (scoped by a wrapper class or a `<style>` in the tooltip
  DOM). Because a CM6 hoverTooltip lives in the normal editor DOM (not a shadow root), **prefix all
  card selectors** (they already are `.harper-*`) and be careful the `code{}` global rule is scoped
  to `.harper-body code` so it doesn't restyle editor code spans.
- **Theme detection:** replace the card's `@media (prefers-color-scheme:dark)` with a Joplin-driven
  toggle. Options: (a) read Joplin's editor background/color CSS custom properties and swap a
  `harper-dark` class; (b) rewrite the hardcoded card hexes to Joplin CSS vars
  (`--joplin-background-color`, `--joplin-color`, `--joplin-divider-color`,
  `--joplin-background-color-hover`, `--joplin-url-color` for the Report link). Per-kind underline
  colors stay literal (they're theme-independent by design).

**Data flow (unchanged invariants):** all of `lint_kind`, `lint_kind_pretty`, `message_html`,
`problem_text`, `span`, and each suggestion's `kind`/`replacement_text` are computed in the main
process (`src/index.ts`) and shipped as plain JSON over postMessage. The content script only reads
those fields to build DOM + choose a color from the hand-copied map. `applySuggestion` /
add-to-dictionary / ignore / disable stay as the existing postMessage round-trips to the main
process (harper.js + `@codemirror/*` never enter the content-script bundle).

---

## UNKNOWNS / to verify during implementation

1. **Exact `message_html()` markup.** Confirmed it is `render_markdown(message)`
   (`harper-core/.../lint.rs:47-48`) and that Harper wraps target words in backticks → `<code>`.
   I did not enumerate every rule's message to prove `<code>` is always present or that no other
   tags (`<em>`, links) appear. Verify by logging `message_html()` for a few real lints; sanitize to
   an allowlist (`code`, `em`, `strong`) before `innerHTML` to be safe.
2. **`lintKindTextColor` borderline greens.** I asserted white text for all kinds except Style and
   Miscellaneous (`#3BCEAC` luminance ≈0.51 → black). Recompute `colorjs.io` luminance for
   `Enhancement #0EAD69`, `Repetition #00A67C`, `Miscellaneous #3BCEAC` if pixel-exact parity with
   the extension matters; otherwise white is visually safe.
3. **Clone version.** Branch is `master`@`3486414`, not a `2.8.0` tag. The color map, card, and
   Obsidian lint.ts are current-main; if Harper cut 2.8.0 after this commit, re-diff
   `lintKindColor.ts` and `SuggestionBox.ts`. harper.js in our repo is pinned 2.7.0 and already has
   every method used — no drift risk on the API surface.
4. **Report affordance.** No Joplin-appropriate target exists (extension uses
   `writewithharper.com/api/problematic-lints`). Decision needed: omit vs. open the GitHub repo
   externally (the latter needs a user-gated external-link action).
5. **Gear/settings + disable-rule icons.** Exact replacement SVGs (Lucide `sliders`/`toggle-left`)
   are proposals; confirm they read correctly at 18px in both Joplin themes. FontAwesome must not be
   bundled.
6. **Open trigger for Joplin.** Recommendation is hover (`hoverTooltip`), diverging from the
   extension's click. Confirm hover interplays cleanly with Joplin's postMessage-delivered
   diagnostics and doesn't fight the stock lint gutter tooltip; else fall back to click.
