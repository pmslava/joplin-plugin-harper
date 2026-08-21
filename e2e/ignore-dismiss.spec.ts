import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCard,
  clickDismiss,
  screenshotCard,
} from './helpers';

const SHOTS_DIR =
  '/tmp/claude-1000/-home-mrsir-Lab-joplin-plugin-harper/f70ff77f-1ceb-407e-9024-9da9993b0b91/scratchpad/ui-screens';

/** Recursively search under `dir` for a file named `name`; returns its path or null. */
function findFile(dir: string, name: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

/**
 * E2E (b) — IGNORE / DISMISS (Phase-2 card affordance).
 *
 * Dismisses a lint via the card's grey "Dismiss" pill and asserts BOTH that its underline clears
 * while a different lint's underline survives, AND that `ignoredLints.json` now exists in the
 * profile's plugin data dir. Also captures the LIGHT-theme card + underline screenshots (the
 * ui-conformance spec captures the dark-theme pair).
 */
test.describe('Harper ignore/dismiss (card)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('dismissing a lint clears only its underline and persists ignoredLints.json', async () => {
    const { win, profileDir } = joplin;

    await createNotebook(win, 'Harper Ignore NB');
    await createNote(win, 'Harper ignore ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // "should of" (WordChoice) is the one we dismiss; "beleive" (Spelling) must survive.
    await setEditorBody(win, 'I beleive we should of gone.');

    await expect
      .poll(() => lintRangeCountForWord(win, 'should of'), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // Light-theme evidence for the manager: the multi-kind underlines, then the open card.
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await win.locator('.cm-content').first().screenshot({
      path: path.join(SHOTS_DIR, 'underlines-light.png'),
    });
    const cardForShot = await openHarperCard(win, 'should of');
    await screenshotCard(win, cardForShot, path.join(SHOTS_DIR, 'card-light.png'));

    // Re-open the card fresh right before acting: the screenshot's settle wait can let the hover
    // tooltip close, so we don't rely on the just-captured card still being open.
    const card = await openHarperCard(win, 'should of');
    await clickDismiss(win, card);

    // The dismissed lint's underline clears...
    await expect
      .poll(() => lintRangeCountForWord(win, 'should of'), { timeout: 20_000 })
      .toBe(0);
    // ...while the other underline survives.
    expect(await lintRangeCountForWord(win, 'beleive')).toBeGreaterThan(0);

    // ignoredLints.json was persisted in the profile's plugin data dir.
    await expect
      .poll(() => (findFile(profileDir, 'ignoredLints.json') ? 'found' : ''), { timeout: 20_000 })
      .toBe('found');
    const ignorePath = findFile(profileDir, 'ignoredLints.json');
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ignoredLints.json at ${ignorePath}`);
    expect(ignorePath).toBeTruthy();
  });
});
