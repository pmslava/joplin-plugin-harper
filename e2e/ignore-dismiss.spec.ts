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
 * while a different lint's underline survives, AND that `ignoredLints.json` is actually MUTATED by
 * the dismiss: captured before (absent here, fresh profile) and after, it must now be valid JSON of
 * harper's export shape (`{"context_hashes":[<u64>,…]}`) with strictly MORE persisted entries than
 * before. Also captures the LIGHT-theme card + underline screenshots (ui-conformance does the dark pair).
 */

/** Count harper's persisted ignore entries from an exportIgnoredLints() JSON string (or null). */
function countIgnoredEntries(content: string | null): number {
  if (!content || !content.trim()) return 0;
  const parsed = JSON.parse(content) as { context_hashes?: unknown[] };
  if (!parsed || !Array.isArray(parsed.context_hashes)) {
    throw new Error(`ignoredLints.json is not harper's {context_hashes:[…]} shape: ${content}`);
  }
  return parsed.context_hashes.length;
}
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

    // Capture the ignore-state file BEFORE dismissing (fresh profile => normally absent, count 0).
    const readIgnoreFile = (): string | null => {
      const p = findFile(profileDir, 'ignoredLints.json');
      if (!p) return null;
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    };
    const beforeContent = readIgnoreFile();
    const beforeCount = countIgnoredEntries(beforeContent);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ignoredLints.json before dismiss: ${JSON.stringify(beforeContent)} (count ${beforeCount})`);

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

    // The dismiss must MUTATE ignoredLints.json: the file now exists AND its content changed AND it
    // holds strictly more persisted entries than before, in harper's {context_hashes:[…]} shape.
    await expect
      .poll(
        () => {
          const c = readIgnoreFile();
          if (c === null || c === beforeContent) return -1;
          try {
            return countIgnoredEntries(c);
          } catch {
            return -1;
          }
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(beforeCount);

    const ignorePath = findFile(profileDir, 'ignoredLints.json');
    const afterContent = readIgnoreFile();
    const afterCount = countIgnoredEntries(afterContent);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ignoredLints.json at ${ignorePath} after dismiss: ${JSON.stringify(afterContent)} (count ${afterCount})`);

    // Explicit shape + growth assertions on the final content (the poll already guaranteed change).
    expect(ignorePath).toBeTruthy();
    expect(afterContent).not.toBe(beforeContent);
    expect(afterCount).toBeGreaterThan(beforeCount);
    const parsed = JSON.parse(afterContent as string);
    expect(Array.isArray(parsed.context_hashes)).toBe(true);
    expect(parsed.context_hashes.length).toBe(afterCount);
    // The dismissed "should of" finding is now persisted as at least one ignore entry.
    expect(afterCount).toBeGreaterThanOrEqual(1);
  });
});
