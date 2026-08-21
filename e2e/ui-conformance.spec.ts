import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCard,
  underlineColorForWord,
  screenshotCard,
} from './helpers';

const SHOTS_DIR =
  '/tmp/claude-1000/-home-mrsir-Lab-joplin-plugin-harper/f70ff77f-1ceb-407e-9024-9da9993b0b91/scratchpad/ui-screens';

// Harper's canonical per-kind palette (the three kinds this doc produces).
const EXPECTED = {
  beleive: '#EE4266', // Spelling
  teh: '#FF6B35', // Typo
  'should of': '#228B22', // WordChoice
};

/**
 * E2E (c) — UI CONFORMANCE (Phase-2 card + per-kind colors), in Joplin's DARK theme.
 *
 * Asserts (1) three different lint kinds get three different computed underline colors matching the
 * spec palette, and (2) the open card's DOM structure: a colored kind title, the problem-word chip
 * (`.harper-body code`), at least one suggestion pill, the add-to-dictionary icon (Spelling), and the
 * Dismiss pill. Captures the dark-theme card + underline screenshots for the manager.
 */
test.describe('Harper UI conformance (dark theme)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    // Boot Joplin in its Dark theme (setting `theme: 2`) so the card's luminance-based dark detection
    // is exercised and the dark screenshots are captured.
    const profileDir = createProfile(true, {});
    const settingsFile = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings['theme'] = 2; // Joplin: 2 = Dark
    // themeAutoDetect defaults ON and would follow the (light) xvfb environment, overriding `theme`.
    settings['themeAutoDetect'] = false;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('three kinds -> three palette colors, and the card has the Harper structure', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper UI NB');
    await createNote(win, 'Harper ui ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    await setEditorBody(win, 'I beleive teh cat and we should of gone.');

    // All three underlines present.
    for (const word of Object.keys(EXPECTED)) {
      await expect
        .poll(() => lintRangeCountForWord(win, word), { timeout: 60_000 })
        .toBeGreaterThan(0);
    }

    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await win.locator('.cm-content').first().screenshot({
      path: path.join(SHOTS_DIR, 'underlines-dark.png'),
    });

    // Each kind's squiggle stroke color equals the canonical palette hex, and all three differ.
    const colors: Record<string, string | null> = {};
    for (const word of Object.keys(EXPECTED)) {
      colors[word] = await underlineColorForWord(win, word);
    }
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] underline colors = ${JSON.stringify(colors)}`);
    for (const [word, hex] of Object.entries(EXPECTED)) {
      expect(colors[word]).toBe(hex);
    }
    const distinct = new Set(Object.values(colors));
    expect(distinct.size).toBe(3);

    // --- card structure (open on the Spelling lint "beleive") --------------------------------
    // Assertions run FIRST, while the freshly-opened card is guaranteed open; the screenshot (whose
    // settle wait can let the hover tooltip close) is taken LAST so it can't invalidate assertions.
    const card = await openHarperCard(win, 'beleive');

    // dark detection actually fired.
    await expect(card).toHaveClass(/harper-dark/);

    // colored kind title.
    await expect(card.locator('.harper-title')).toHaveText('Spelling');

    // problem-word chip.
    const chip = card.locator('.harper-body code').first();
    await expect(chip).toHaveText('beleive');

    // at least one suggestion pill in the left footer cluster.
    const pills = card.locator('.harper-footer .harper-child-cont').first().locator('.harper-btn');
    expect(await pills.count()).toBeGreaterThanOrEqual(1);

    // Spelling card => add-to-dictionary icon present.
    await expect(card.locator('.harper-dict-btn')).toHaveCount(1);

    // Dismiss pill present.
    await expect(card.locator('.harper-btn', { hasText: 'Dismiss' })).toHaveCount(1);

    // header disable-rule toggle present (rule = SpellCheck).
    await expect(card.locator('.harper-disable-btn')).toHaveCount(1);

    // Dark-theme card screenshot for the manager (re-open in case the assertions' timing closed it).
    const cardForShot = await openHarperCard(win, 'beleive');
    await screenshotCard(win, cardForShot, path.join(SHOTS_DIR, 'card-dark.png'));
  });
});
