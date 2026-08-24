import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  launchJoplin,
  closeJoplin,
  createProfile,
  findSecondaryWindow,
  JoplinInstance,
} from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  openNoteInNewWindow,
  underlineColorForWord,
} from './helpers';

/**
 * E2E — SECONDARY WINDOW ("Open in new window").
 *
 * Joplin can paint the note editor into a SECOND Electron window: `window.open('about:blank')` from
 * the main renderer plus a React portal (gui/NewWindowOrIFrame.tsx). The plugin's content script keeps
 * running in the MAIN renderer's JS realm, so a stylesheet appended to the bare global `document` lands
 * in the main window and never reaches the secondary one — Joplin replicates its own theme/chrome CSS
 * into each secondary document but has no mechanism to replicate a plugin's `<style>`. The symptom was
 * a card with the right content and NO chrome (raw buttons) plus underlines falling back to
 * @codemirror/lint's default squiggle.
 *
 * This spec therefore asserts PAINT, not presence: every expectation below is a computed value that
 * only the plugin's own stylesheet can produce, so it fails on a build that injects into the main
 * document. The card structure itself is covered by ui-conformance.spec.ts (which is where these
 * dark-theme values come from) and is deliberately not re-asserted here.
 */

// Harper's canonical Spelling color, as asserted by ui-conformance.spec.ts.
const SPELLING_COLOR = '#EE4266';

interface CardPaint {
  display: string;
  flexDirection: string;
  maxWidth: string;
  padding: string;
  borderRadius: string;
  borderTopWidth: string;
  borderTopStyle: string;
  backgroundColor: string;
  headerDisplay: string;
  chipBackgroundColor: string;
  pillDisplay: string;
  pillBorderRadius: string;
  pillFontWeight: string;
}

/** Read the computed paint of an open card (container + its header, word chip and first pill). */
async function cardPaint(card: ReturnType<Page['locator']>): Promise<CardPaint> {
  return card.evaluate((el) => {
    const container = el as HTMLElement;
    const cs = getComputedStyle(container);
    const header = container.querySelector('.harper-header') as HTMLElement;
    const chip = container.querySelector('.harper-body code') as HTMLElement;
    const pill = container.querySelector(
      '.harper-footer .harper-child-cont .harper-btn',
    ) as HTMLElement;
    const pillCs = getComputedStyle(pill);
    return {
      display: cs.display,
      flexDirection: cs.flexDirection,
      maxWidth: cs.maxWidth,
      padding: cs.padding,
      borderRadius: cs.borderRadius,
      borderTopWidth: cs.borderTopWidth,
      borderTopStyle: cs.borderTopStyle,
      backgroundColor: cs.backgroundColor,
      headerDisplay: getComputedStyle(header).display,
      chipBackgroundColor: getComputedStyle(chip).backgroundColor,
      pillDisplay: pillCs.display,
      pillBorderRadius: pillCs.borderRadius,
      pillFontWeight: pillCs.fontWeight,
    };
  });
}

test.describe('Harper in a secondary Joplin window', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    // Same dark-theme boot as ui-conformance.spec.ts, so the expected computed values below are that
    // spec's values verbatim (and the luminance-based dark detection is exercised across windows).
    const profileDir = createProfile(true, {});
    const settingsFile = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings['theme'] = 2; // Joplin: 2 = Dark
    settings['themeAutoDetect'] = false;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the card clicked open in a secondary window is fully styled', async () => {
    const { win, browser } = joplin;

    await createNotebook(win, 'Harper Window NB');
    await createNote(win, 'Harper window ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // One unambiguous Spelling lint, seeded through the main window's editor.
    await setEditorBody(win, 'I beleive it works.');
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // "Open in new window" -> a second Electron window with its own document.
    await openNoteInNewWindow(win);
    const second = await findSecondaryWindow(browser, 60_000);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] secondary window url = ${second.url()}`);

    // Harper lints the secondary editor too (the content script activates per EditorView).
    await expect
      .poll(() => lintRangeCountForWord(second, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // (1) The plugin's stylesheet reached the SECONDARY document, not just the main one.
    await expect
      .poll(
        () => second.evaluate(() => !!document.getElementById('harper-plugin-styles')),
        { timeout: 20_000 },
      )
      .toBe(true);

    // (2) The underline in the secondary window is painted in Harper's per-kind color. Without the
    // plugin stylesheet the mark falls back to @codemirror/lint's own severity squiggle.
    await expect
      .poll(() => underlineColorForWord(second, 'beleive'), { timeout: 30_000 })
      .toBe(SPELLING_COLOR);

    // (3) The card CLICKED OPEN IN THE SECONDARY WINDOW is styled: every value below comes from the
    // plugin's stylesheet, so an unstyled fallback card (raw <div>/<button> chrome) fails each one.
    const card = await openHarperCardByClick(second, 'beleive');
    await expect(card).toBeVisible();

    const paint = await cardPaint(card);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] secondary-window card paint = ${JSON.stringify(paint)}`);

    // .harper-container chrome (CARD_CSS + its .harper-dark override).
    expect(paint.display).toBe('flex');
    expect(paint.flexDirection).toBe('column');
    expect(paint.maxWidth).toBe('420px');
    expect(paint.padding).toBe('8px');
    expect(paint.borderRadius).toBe('8px');
    expect(paint.borderTopWidth).toBe('1px');
    expect(paint.borderTopStyle).toBe('solid');
    expect(paint.backgroundColor).toBe('rgb(13, 17, 23)'); // #0d1117, the dark card background
    // .harper-header is a flex row, and the dark word-chip fill is painted (#1f2d3d).
    expect(paint.headerDisplay).toBe('flex');
    expect(paint.chipBackgroundColor).toBe('rgb(31, 45, 61)');
    // .harper-btn pill chrome (its background is an inline style, so it proves nothing — these do).
    // The rule says `display:inline-flex`; the pill is a flex item of `.harper-child-cont`, so the
    // computed value is blockified to `flex`. An unstyled <button> computes `inline-block`.
    expect(paint.pillDisplay).toBe('flex');
    expect(paint.pillBorderRadius).toBe('6px');
    expect(paint.pillFontWeight).toBe('600');
  });
});
