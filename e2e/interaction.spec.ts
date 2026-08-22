import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  harperCardCount,
  hoverLintRange,
  openHarperCardByClick,
} from './helpers';

/**
 * E2E — CARD TRIGGER INTERACTION (v1.0.2).
 *
 * v1.0.1 shipped a bug where the stock @codemirror/lint HOVER tooltip and the v1.0.1 CLICK card both
 * fired, stacking two identical cards. The isolated-path specs missed it because each exercised a
 * single trigger. This spec deliberately exercises the COMBINED interactions that expose stacking:
 *
 *   (i)   hovering an underline opens NO card (the hover tooltip is fully suppressed);
 *   (ii)  hover-then-click yields EXACTLY ONE card (never two stacked);
 *   (iii) click-then-type closes the card on the first doc edit, with no other interaction.
 *
 * All three share one note; each resets the body fresh and waits for the "beleive" spelling underline.
 */
test.describe('Harper card trigger interaction (v1.0.2 click-only)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test.beforeEach(async () => {
    const { win } = joplin;
    await createNotebook(win, 'Harper Interaction NB ' + Date.now());
    await createNote(win, 'Harper interaction ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, 'I beleive it works.');
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);
  });

  test('(i) hovering an underline opens NO card', async () => {
    const { win } = joplin;

    // Real pointer hover with a generous dwell — well past the bundled hover-tooltip open latency.
    await hoverLintRange(win, 'beleive');

    // The stock hover tooltip is suppressed at source, so no card exists in the DOM.
    expect(await harperCardCount(win)).toBe(0);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] hover produced card count =', await harperCardCount(win));
  });

  test('(ii) hover-then-click yields EXACTLY ONE card', async () => {
    const { win } = joplin;

    // First hover (would, pre-fix, have opened a hover tooltip)...
    await hoverLintRange(win, 'beleive');
    expect(await harperCardCount(win)).toBe(0);

    // ...then click the SAME underline. Exactly one card must exist — never a hover card + click card.
    const range = win.locator('.cm-lintRange').filter({ hasText: 'beleive' }).first();
    await range.click({ force: true });
    await expect.poll(() => harperCardCount(win), { timeout: 10_000 }).toBe(1);

    // Hold: dwell again over the underline; still exactly one (no second card materialises on hover).
    await win.waitForTimeout(1000);
    expect(await harperCardCount(win)).toBe(1);
    // And it is specifically the click tooltip's card.
    expect(
      await win.locator('.cm-tooltip.harper-click-tooltip .harper-container').count(),
    ).toBe(1);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] hover-then-click card count =', await harperCardCount(win));
  });

  test('(iii) click-then-type closes the card on the first edit', async () => {
    const { win } = joplin;

    // Open by click; clicking the underline also focuses the editor and places the caret in the word.
    const card = await openHarperCardByClick(win, 'beleive');
    await expect(card).toBeVisible();
    expect(await harperCardCount(win)).toBe(1);

    // Type a single character — a document edit — WITHOUT clicking anywhere else.
    await win.keyboard.type('x');

    // The card self-closes on the first docChanged transaction.
    await expect.poll(() => harperCardCount(win), { timeout: 10_000 }).toBe(0);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] click-then-type card count after edit =', await harperCardCount(win));
  });
});
