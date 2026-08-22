import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  getEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  clickFirstSuggestionPill,
} from './helpers';

/**
 * E2E — CLICK-TO-OPEN CARD (v1.0.1; the sole trigger as of v1.0.2).
 *
 * Proves the click affordance end-to-end: types a misspelling, waits for Harper's underline, CLICKS
 * the underline, asserts the card DOM opened inside our `.harper-click-tooltip` wrapper, then applies
 * the first suggestion pill from that clicked card and asserts the document text was corrected. Since
 * v1.0.2 suppresses the stock hover tooltip entirely, no pointer-parking is needed to attribute the
 * card to the click path — a card can only ever be a click card.
 */
test.describe('Harper click-to-open card', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('clicking a lint underline opens the card and its suggestion applies', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Click NB');
    await createNote(win, 'Harper click ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // A single, unambiguous misspelling; Harper's top suggestion for "beleive" is "believe".
    await setEditorBody(win, 'I beleive it works.');

    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Open by CLICK — the only trigger as of v1.0.2.
    const card = await openHarperCardByClick(win, 'beleive');
    await expect(card).toBeVisible();
    // The card lives inside our click tooltip specifically.
    expect(await win.locator('.cm-tooltip.harper-click-tooltip .harper-container').count()).toBeGreaterThan(0);

    // Apply the first suggestion from the CLICK-opened card.
    const label = await clickFirstSuggestionPill(win, card);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] click-opened card applied suggestion pill: "${label}"`);

    // The document text is now corrected...
    await expect.poll(() => getEditorBody(win), { timeout: 20_000 }).toContain('believe');
    const body = await getEditorBody(win);
    expect(body).not.toContain('beleive');

    // ...and the underline for the old misspelling is gone.
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 20_000 })
      .toBe(0);
  });
});
