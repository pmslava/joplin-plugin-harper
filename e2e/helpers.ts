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

/**
 * Open Joplin's "Goto Anything" dialog (Ctrl+P) and return its text input. The dialog is the same
 * component used for both note-jump and the command palette (verified against the 3.6 bundle: wrapper
 * `.go-to-anything-dialog`, a single autofocused `input[type=text]`; typing `:` switches it to command
 * search — the app's own help text says "type : to search for commands").
 */
/** Dismiss the Goto Anything dialog if it is open (Escape), and wait for it to detach. */
async function closeGotoAnything(win: Page): Promise<void> {
  const dialog = win.locator('.go-to-anything-dialog');
  if (await dialog.count()) {
    await win.keyboard.press('Escape');
    await dialog.first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
      /* leave it; the next open() closes it anyway */
    });
  }
}

async function openGotoAnything(win: Page) {
  await closeGotoAnything(win); // never reuse a stale/half-open dialog across helper calls
  const input = win.locator('.go-to-anything-dialog input[type="text"]');
  // Joplin's KeymapService suppresses app shortcuts while a text <input> (e.g. the note title field,
  // focused right after "New note") holds focus. Move focus into the CodeMirror body first — Goto
  // Anything is meant to work mid-edit, so the editor does not suppress it. Then press Ctrl+P. A `:`
  // prefix on the query later switches the (note-mode) dialog to command search.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await input.count()) return input.first();
    // Only click into the editor when no modal is up, so we never fight the dialog overlay.
    if ((await win.locator('.go-to-anything-dialog').count()) === 0) {
      try {
        await win.locator('.cm-content').first().click({ timeout: 2000 });
      } catch {
        /* editor not clickable this attempt */
      }
    }
    await win.keyboard.press('Control+p');
    try {
      await input.waitFor({ state: 'visible', timeout: 3000 });
      return input.first();
    } catch {
      /* not open yet — retry */
    }
  }
  throw new Error('Goto Anything dialog did not open (Ctrl+P)');
}

/** Type `text` into Goto Anything, run the top result (Enter), and wait for the dialog to close. */
async function submitGotoAnything(win: Page, text: string): Promise<void> {
  const input = await openGotoAnything(win);
  await input.fill(text);
  await win.waitForTimeout(1200); // let the result list populate + rank
  await win.keyboard.press('Enter');
  await win
    .locator('.go-to-anything-dialog')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => closeGotoAnything(win));
  await win.waitForTimeout(1000);
}

/**
 * Run a Joplin command by fuzzy-matching its label in the command palette (Goto Anything, `:` mode).
 * Used to invoke the plugin command `harper.createDictionaryNote` (label "Harper: Create dictionary
 * note") the way a user would.
 */
export async function runCommand(win: Page, labelQuery: string): Promise<void> {
  await submitGotoAnything(win, `:${labelQuery}`);
}

/**
 * Jump to (open) a note by title via Goto Anything. Opening a different note fires
 * `workspace.onNoteSelectionChange`, the plugin's deferred-flush trigger, so this doubles as "leave the
 * current note so its buffered dictionary words flush".
 */
export async function gotoNote(win: Page, titleQuery: string): Promise<void> {
  await submitGotoAnything(win, titleQuery);
}

/**
 * Open a note by clicking its row in the note list (middle panel). More reliable than Goto Anything
 * for a JUST-created note, whose title may not be in Joplin's async search index yet — the note list
 * renders straight from the notebook's notes. Selecting a different note fires
 * `workspace.onNoteSelectionChange` (the plugin's deferred-flush trigger).
 */
export async function openNoteFromList(win: Page, title: string): Promise<void> {
  const item = win
    .locator('.note-list-item-wrapper, .note-list-item')
    .filter({ hasText: title })
    .first();
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await win.waitForTimeout(1200);
}

/**
 * Read a note's CURRENT saved body by opening it fresh: click away to `viaTitle`, then back to
 * `title`, so the editor reloads the note from the database rather than showing a stale in-editor copy
 * (a plugin `data.put` to an already-open note does not necessarily live-refresh the desktop editor).
 */
export async function readNoteBodyFresh(win: Page, title: string, viaTitle: string): Promise<string> {
  await openNoteFromList(win, viaTitle);
  await openNoteFromList(win, title);
  return getEditorBody(win);
}

/** True if the plugin's hidden background page is running (its URL carries ?pluginId=<id>). */
export function pluginBackgroundPageRunning(win: Page): boolean {
  const urls: string[] = [];
  for (const ctx of win.context().browser()!.contexts()) {
    for (const p of ctx.pages()) urls.push(p.url());
  }
  return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
}
