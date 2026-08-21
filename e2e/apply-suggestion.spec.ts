import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  getEditorBody,
  lintRangeCount,
  lintRangeCountForWord,
  openLintTooltip,
  clickFirstDiagnosticAction,
} from './helpers';

/**
 * E2E (b) — APPLY SUGGESTION (the Phase-0 gap).
 *
 * Types a misspelling into the real CM6 editor, waits for Harper's underline, opens the stock
 * @codemirror/lint hover tooltip, clicks the first suggestion action, and asserts the document text
 * was corrected AND the underline for the old word disappeared. This exercises the full apply path:
 * suggestion -> CM transaction -> re-lint.
 */
test.describe('Harper apply-suggestion', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('clicking the first suggestion corrects the word and clears the underline', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Apply NB');
    await createNote(win, 'Harper apply ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // A single, unambiguous misspelling. Harper's top suggestion for "beleive" is "believe".
    await setEditorBody(win, 'I beleive it works.');

    // Wait for the spelling underline on "beleive".
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const tooltip = await openLintTooltip(win, 'beleive');
    const label = await clickFirstDiagnosticAction(win, tooltip);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] applied suggestion action: "${label}"`);

    // The document text is now corrected...
    await expect.poll(() => getEditorBody(win), { timeout: 20_000 }).toContain('believe');
    const body = await getEditorBody(win);
    expect(body).not.toContain('beleive');

    // ...and the underline for the old misspelling is gone.
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 20_000 })
      .toBe(0);

    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] body after apply = ${JSON.stringify(body)}, total ranges = ${await lintRangeCount(win)}`);
  });
});
