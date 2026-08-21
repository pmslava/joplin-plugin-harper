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

/**
 * Open the stock @codemirror/lint hover tooltip for the lint mark underlining `word` and return the
 * tooltip locator. The `linter()` extension registers a hoverTooltip (300 ms hover), so we hover the
 * `.cm-lintRange` and wait for `.cm-tooltip-lint` to appear. The tooltip stays open while the pointer
 * moves into it, which is what lets a follow-up click land on an action button.
 */
export async function openLintTooltip(win: Page, word: string) {
  const range = win
    .locator('.cm-lintRange')
    .filter({ hasText: word })
    .first();
  await range.scrollIntoViewIfNeeded();
  const tooltip = win.locator('.cm-tooltip-lint');
  for (let attempt = 0; attempt < 5; attempt++) {
    await range.hover({ force: true });
    await win.waitForTimeout(500);
    if (await tooltip.count()) return tooltip.first();
  }
  throw new Error(`Lint tooltip for "${word}" never appeared`);
}

/**
 * Click a diagnostic action button (`.cm-diagnosticAction`) in an open lint tooltip whose label
 * contains `labelSubstring`. Pass an already-opened tooltip locator (from openLintTooltip).
 */
export async function clickDiagnosticAction(
  win: Page,
  tooltip: ReturnType<Page['locator']>,
  labelSubstring: string,
): Promise<void> {
  const action = tooltip
    .locator('.cm-diagnosticAction')
    .filter({ hasText: labelSubstring })
    .first();
  await action.click();
  await win.waitForTimeout(300);
}

/**
 * Click the FIRST diagnostic action in an open lint tooltip. The plugin renders one action per
 * harper suggestion first (Replace/Remove/Insert), before the Add-to-dictionary / Ignore / Disable
 * actions, so the first button is always the top suggested fix. Returns its label for assertions.
 */
export async function clickFirstDiagnosticAction(
  win: Page,
  tooltip: ReturnType<Page['locator']>,
): Promise<string> {
  const first = tooltip.locator('.cm-diagnosticAction').first();
  const label = (await first.textContent()) ?? '';
  await first.click();
  await win.waitForTimeout(300);
  return label;
}

/** True if the plugin's hidden background page is running (its URL carries ?pluginId=<id>). */
export function pluginBackgroundPageRunning(win: Page): boolean {
  const urls: string[] = [];
  for (const ctx of win.context().browser()!.contexts()) {
    for (const p of ctx.pages()) urls.push(p.url());
  }
  return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
}
