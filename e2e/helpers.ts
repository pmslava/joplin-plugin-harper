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

/** Create a new plain note in the currently selected notebook, then leave focus in the title. */
export async function createNote(win: Page, title: string): Promise<void> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);
}

/** Whether the CodeMirror 6 markdown editor is present in the main window. */
export async function editorIsPresent(win: Page): Promise<boolean> {
  return (await win.locator('.cm-content').count()) > 0;
}

/**
 * Replace the body of the currently open note with `text`, typed into the CodeMirror editor.
 * Clicks into `.cm-content`, selects all, deletes, then types — real key events, so CM6 processes
 * the input exactly as a user's would and the plugin's debounced linter fires.
 */
export async function setEditorBody(win: Page, text: string): Promise<void> {
  const content = win.locator('.cm-content').first();
  await content.click();
  await win.waitForTimeout(300);
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.waitForTimeout(200);
  await win.keyboard.type(text);
  await win.waitForTimeout(300);
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

/** True if the plugin's hidden background page is running (its URL carries ?pluginId=<id>). */
export function pluginBackgroundPageRunning(win: Page): boolean {
  const urls: string[] = [];
  for (const ctx of win.context().browser()!.contexts()) {
    for (const p of ctx.pages()) urls.push(p.url());
  }
  return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
}
