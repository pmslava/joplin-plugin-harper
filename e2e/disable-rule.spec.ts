import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCard,
  clickDisableRule,
} from './helpers';

/**
 * E2E (a) — DISABLE RULE (Phase-2 card affordance).
 *
 * Triggers "Disable rule" from the card's header toggle icon on a NON-spelling lint ("should of",
 * kind WordChoice, rule ModalOf), then asserts BOTH that its underline clears while a different
 * lint's underline ("beleive", Spelling) survives, AND that the `ruleOverrides` setting persisted
 * `{"ModalOf":false}` to the profile's settings.json (File storage).
 */
test.describe('Harper disable-rule (card)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('disabling a rule from the card clears only that underline and persists {rule:false}', async () => {
    const { win, profileDir } = joplin;

    await createNotebook(win, 'Harper Disable NB');
    await createNote(win, 'Harper disable ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // "should of" -> WordChoice/ModalOf (non-spelling); "beleive" -> Spelling (the survivor).
    await setEditorBody(win, 'I beleive we should of gone.');

    await expect
      .poll(() => lintRangeCountForWord(win, 'should of'), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCard(win, 'should of');
    await clickDisableRule(win, card);

    // The disabled rule's underline clears...
    await expect
      .poll(() => lintRangeCountForWord(win, 'should of'), { timeout: 20_000 })
      .toBe(0);
    // ...while the unrelated Spelling underline survives.
    expect(await lintRangeCountForWord(win, 'beleive')).toBeGreaterThan(0);

    // The ruleOverrides setting persisted {"ModalOf":false} to settings.json.
    const settingsFile = path.join(profileDir, 'settings.json');
    const key = pluginSettingKey('ruleOverrides');
    await expect
      .poll(
        () => {
          try {
            const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            return s[key] ?? '';
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain('ModalOf');

    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))[key];
    const overrides = JSON.parse(raw);
    expect(overrides.ModalOf).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ruleOverrides persisted = ${raw}`);
  });
});
