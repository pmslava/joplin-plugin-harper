import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
} from './helpers';

/**
 * E2E (d) — DIALECT.
 *
 * Boots Joplin with `dialect = British` preset. British spelling "colour" must NOT be flagged. To
 * prove that absence is meaningful (i.e. linting actually ran and simply didn't flag "colour"), the
 * same sentence also contains an unconditional typo ("teh"), which MUST be underlined. The American
 * side of this contrast is covered by the harness (`colour` flagged under American, not British).
 */
test.describe('Harper dialect (British)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ harperSettings: { dialect: 'British' } });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('"colour" is not flagged under British, but a real typo still is', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Dialect NB');
    await createNote(win, 'Harper dialect ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    await setEditorBody(win, 'I like the colour red and teh cat.');

    // Proof that Harper linted the document at all: the typo "teh" is underlined.
    await expect
      .poll(() => lintRangeCountForWord(win, 'teh'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Under British, "colour" is a correct spelling and must not be underlined. Give the linter a
    // moment beyond the "teh" appearing to be sure no late "colour" decoration shows up.
    await win.waitForTimeout(1500);
    expect(await lintRangeCountForWord(win, 'colour')).toBe(0);

    // eslint-disable-next-line no-console
    console.log(
      `[harper-e2e] British: teh ranges = ${await lintRangeCountForWord(win, 'teh')}, ` +
        `colour ranges = ${await lintRangeCountForWord(win, 'colour')}`,
    );
  });
});
