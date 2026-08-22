import { Page } from '@playwright/test';
import { PLUGIN_ID } from './launch';

/**
 * Real-app interaction helpers for the Harper e2e suite.
 *
 * Unlike the sibling Cockpit plugin (whose surface is a panel iframe), Harper's output is CodeMirror
 * lint decorations painted INSIDE the main editor DOM — there is no iframe to scan. Every helper
 * therefore drives, and reads from, the main renderer `Page` (`win`) directly:
 *   - `.cm-content`   — the CodeMirror 6 editable area (the markdown editor body).
 *   - `.cm-lintRange` — the mark class stock @codemirror/lint emits for each diagnostic underline.
 *
 * Notebook/note creation selectors are the ones verified against a real Joplin 3.6 build in Cockpit.
 */

const SETTLE = 1500;

/** Create a new notebook with the given name. It becomes the active/selected notebook. */
export async function createNotebook(win: Page, name: string): Promise<void> {
  await win.click('.sidebar-header-button.-newfolder');
  await win.waitForTimeout(1200);
  await win.locator('input[type="text"]:visible').first().fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
}

/**
 * Create a new plain note in the currently selected notebook and give it a title.
 *
 * The title is typed into the title input explicitly (the input is focused right after "New note"),
 * so it can never be confused with the body: Joplin only derives a title from the first body line
 * when the title is still empty, and here it isn't. `setEditorBody` then does its own focus handoff
 * into the editor, so this leaves the note ready for a clean body edit.
 */
export async function createNote(win: Page, title: string): Promise<void> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  // Type into the title input directly rather than relying on ambient focus, then commit it.
  const titleInput = win.locator('input.title-input, .note-title-wrapper input').first();
  if (await titleInput.count()) {
    await titleInput.fill(title);
  } else {
    // Fallback: the title field carries focus immediately after "New note".
    await win.keyboard.type(title);
  }
  await win.waitForTimeout(SETTLE);
}

/** Whether the CodeMirror 6 markdown editor is present in the main window. */
export async function editorIsPresent(win: Page): Promise<boolean> {
  return (await win.locator('.cm-content').count()) > 0;
}

/** True once keyboard focus is actually inside the CodeMirror editor (not the title input). */
export async function editorHasFocus(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const el = document.activeElement;
    return !!el && !!el.closest('.cm-editor');
  });
}

/**
 * Move keyboard focus into the CodeMirror body editor and confirm it landed there.
 *
 * Phase 0 saw typed body text leak into the note title when the click-to-focus hadn't settled. We
 * therefore click `.cm-content` and then poll `document.activeElement` until it is inside the CM
 * editor (re-clicking if needed) before returning, so callers can type without racing the handoff.
 */
export async function focusEditor(win: Page): Promise<void> {
  const content = win.locator('.cm-content').first();
  for (let attempt = 0; attempt < 10; attempt++) {
    await content.click();
    await win.waitForTimeout(150);
    if (await editorHasFocus(win)) return;
  }
  throw new Error('Could not move focus into the CodeMirror editor');
}

/**
 * Replace the body of the currently open note with `text`, typed into the CodeMirror editor.
 * Ensures focus is inside `.cm-content` first (see focusEditor), selects all, deletes, then types —
 * real key events, so CM6 processes the input exactly as a user's would and the debounced linter fires.
 */
export async function setEditorBody(win: Page, text: string): Promise<void> {
  await focusEditor(win);
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.waitForTimeout(200);
  await win.keyboard.type(text);
  await win.waitForTimeout(300);
}

/** The current text content of the CodeMirror editor body. */
export async function getEditorBody(win: Page): Promise<string> {
  return win.locator('.cm-content').first().evaluate((el) => (el as HTMLElement).innerText);
}

/** How many lint decoration marks are currently painted in the editor. */
export async function lintRangeCount(win: Page): Promise<number> {
  return win.locator('.cm-lintRange').count();
}

/** The outerHTML of every lint decoration mark — logged as evidence in the spec. */
export async function lintRangeHtml(win: Page): Promise<string[]> {
  return win.locator('.cm-lintRange').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).outerHTML),
  );
}

/** How many lint decoration marks currently underline exactly `word`. */
export async function lintRangeCountForWord(win: Page, word: string): Promise<number> {
  return win
    .locator('.cm-lintRange')
    .evaluateAll((els, w) => els.filter((el) => (el as HTMLElement).textContent === w).length, word);
}

/** How many Harper suggestion cards (`.harper-container`) are currently in the DOM. */
export async function harperCardCount(win: Page): Promise<number> {
  return win.locator('.harper-container').count();
}

/**
 * Move the real pointer over the lint underline for `word` and dwell there (generous wait). Used by
 * the interaction spec to PROVE that hovering opens NO card (v1.0.2 suppressed the stock hover
 * tooltip). Does not assert — the caller inspects `harperCardCount`.
 */
export async function hoverLintRange(win: Page, word: string): Promise<void> {
  const range = win.locator('.cm-lintRange').filter({ hasText: word }).first();
  await range.scrollIntoViewIfNeeded();
  await range.hover({ force: true });
  // Well past the old hover-tooltip open latency (bundled default 300–750 ms): if a hover tooltip
  // were still wired, the card would have appeared within this window.
  await win.waitForTimeout(1200);
}

/**
 * Open the Harper card by CLICKING the lint underline for `word` (click-to-open; the ONLY trigger as
 * of v1.0.2). Returns the click-tooltip's `.harper-container` locator.
 *
 * Since v1.0.2 fully suppresses the stock hover tooltip, no pointer-parking gymnastics are needed to
 * distinguish the click path — a card can only come from this click. We click the `.cm-lintRange` and
 * wait for the click tooltip's card, retrying the click a few times to absorb the debounced re-lint.
 */
export async function openHarperCardByClick(win: Page, word: string) {
  const range = win.locator('.cm-lintRange').filter({ hasText: word }).first();
  await range.scrollIntoViewIfNeeded();
  await range.click({ force: true });
  await win.waitForTimeout(400);
  const card = win.locator('.cm-tooltip.harper-click-tooltip .harper-container');
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await card.count()) return card.first();
    await range.click({ force: true });
    await win.waitForTimeout(400);
  }
  throw new Error(`Harper click-to-open card for "${word}" never appeared`);
}

/**
 * Click the FIRST suggestion pill in an open card. Suggestion pills live in the LEFT footer cluster
 * (`.harper-footer > .harper-child-cont:first-child > .harper-btn`), so the first pill is the top
 * suggested fix. Returns its label for assertions.
 */
export async function clickFirstSuggestionPill(
  win: Page,
  card: ReturnType<Page['locator']>,
): Promise<string> {
  const first = card.locator('.harper-footer .harper-child-cont').first().locator('.harper-btn').first();
  const label = (await first.textContent()) ?? '';
  await first.click({ force: true, timeout: 15000 });
  await win.waitForTimeout(300);
  return label;
}

/** Click the add-to-dictionary icon button (`.harper-dict-btn`, Spelling cards only). */
export async function clickAddToDictionary(
  win: Page,
  card: ReturnType<Page['locator']>,
): Promise<void> {
  await card.locator('.harper-dict-btn').first().click({ force: true, timeout: 15000 });
  await win.waitForTimeout(300);
}

/** Click the "Dismiss" grey pill (our Ignore action) in an open card. */
export async function clickDismiss(win: Page, card: ReturnType<Page['locator']>): Promise<void> {
  await card.locator('.harper-btn', { hasText: 'Dismiss' }).first().click({ force: true, timeout: 15000 });
  await win.waitForTimeout(300);
}

/** Click the header disable-rule toggle icon (`.harper-disable-btn`) in an open card. */
export async function clickDisableRule(win: Page, card: ReturnType<Page['locator']>): Promise<void> {
  await card.locator('.harper-disable-btn').first().click({ force: true, timeout: 15000 });
  await win.waitForTimeout(300);
}

/**
 * The computed squiggle underline color (hex) for the lint mark underlining `word`. The per-kind
 * squiggle is a `background-image` SVG data-URI whose `stroke="#RRGGBB"` is the kind color, so we
 * read the computed `background-image` and pull the stroke hex back out.
 */
export async function underlineColorForWord(win: Page, word: string): Promise<string | null> {
  return win
    .locator('.cm-lintRange')
    .filter({ hasText: word })
    .first()
    .evaluate((el) => {
      const bg = getComputedStyle(el as HTMLElement).backgroundImage;
      let decoded = bg;
      try {
        decoded = decodeURIComponent(bg);
      } catch {
        /* keep raw */
      }
      // Match the SVG stroke color in either the decoded (stroke="#RRGGBB") or the still-encoded
      // (stroke%3D%22%23RRGGBB) form of the background-image data-URI.
      const m =
        decoded.match(/stroke="(#[0-9A-Fa-f]{6})"/) ||
        bg.match(/stroke%3D%22(%23[0-9A-Fa-f]{6})/);
      if (!m) return null;
      return m[1].replace('%23', '#').toUpperCase();
    });
}

/**
 * Screenshot an open Harper card to `filePath`. Uses a bounding-box-clipped PAGE screenshot (not an
 * element screenshot): the card is a hover tooltip with a `fade-in` opacity/scale animation, and an
 * isolated element screenshot can capture it mid-fade (blank). A short settle + page-level clip goes
 * through the real compositor and reliably captures the painted card. Falls back to a full-page shot.
 */
export async function screenshotCard(
  win: Page,
  card: ReturnType<Page['locator']>,
  filePath: string,
): Promise<void> {
  await win.waitForTimeout(500); // let fade-in + tooltip positioning settle
  // Freeze the fade-in (opacity/scale) so the capture can't catch a mid-animation frame, and pin the
  // card at a fixed on-screen spot so it can't be repositioned/clipped out of a page screenshot.
  await card.evaluate((el) => {
    const c = el as HTMLElement;
    c.style.animation = 'none';
    c.style.opacity = '1';
    c.style.transform = 'none';
    const tip = c.closest('.cm-tooltip') as HTMLElement | null;
    if (tip) {
      tip.style.transform = 'none';
      tip.style.inset = 'auto';
      tip.style.left = '20px';
      tip.style.top = '20px';
    }
  });
  await win.waitForTimeout(150);
  // Full-page screenshot: captures the card wherever it is painted (no bounding-box clip math that a
  // CM tooltip transform can defeat).
  await win.screenshot({ path: filePath });
}

/** The `harper-lintRange-<Kind>` class suffix on the lint mark underlining `word`. */
export async function underlineKindForWord(win: Page, word: string): Promise<string | null> {
  return win
    .locator('.cm-lintRange')
    .filter({ hasText: word })
    .first()
    .evaluate((el) => {
      const cls = Array.from((el as HTMLElement).classList).find((c) => c.startsWith('harper-lintRange-'));
      return cls ? cls.replace('harper-lintRange-', '') : null;
    });
}

/** True if the plugin's hidden background page is running (its URL carries ?pluginId=<id>). */
export function pluginBackgroundPageRunning(win: Page): boolean {
  const urls: string[] = [];
  for (const ctx of win.context().browser()!.contexts()) {
    for (const p of ctx.pages()) urls.push(p.url());
  }
  return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
}
