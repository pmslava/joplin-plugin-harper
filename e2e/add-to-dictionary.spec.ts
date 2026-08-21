import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCard,
  clickAddToDictionary,
} from './helpers';

/**
 * E2E (c) — ADD TO DICTIONARY.
 *
 * Boots Joplin with `dictionaryPath` preset (in settings.json under the plugin namespace) to a temp
 * file inside the profile dir. Types an unknown word, confirms the Spelling underline, triggers the
 * "Add to dictionary" tooltip action, then asserts BOTH that the underline disappears and that the
 * external dictionary file now contains the word (proving the plugin appended + re-imported it).
 */
test.describe('Harper add-to-dictionary', () => {
  let joplin: JoplinInstance;
  let dictPath: string;

  const UNKNOWN_WORD = 'Sxope';

  test.beforeAll(async () => {
    // The dictionary file lives inside the (throwaway) profile dir, so it is cleaned up with it. Its
    // absolute path must be baked into settings.json before launch, so we create the profile first
    // (to learn its dir), inject `plugin-<id>.dictionaryPath`, then launch against that profile. We
    // do NOT create the file up front — the plugin's addWord must create it via appendFile.
    const profileDir = createProfile(true, {});
    dictPath = path.join(profileDir, 'harper-dict.txt');
    const settingsFile = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings[pluginSettingKey('dictionaryPath')] = dictPath;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('adding an unknown word writes the dictionary file and clears its underline', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Dict NB');
    await createNote(win, 'Harper dict ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    await setEditorBody(win, `${UNKNOWN_WORD} is a made-up word.`);

    // The unknown word is underlined as a spelling error.
    await expect
      .poll(() => lintRangeCountForWord(win, UNKNOWN_WORD), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCard(win, UNKNOWN_WORD);
    await clickAddToDictionary(win, card);

    // The underline disappears (importWords + forced re-lint).
    await expect
      .poll(() => lintRangeCountForWord(win, UNKNOWN_WORD), { timeout: 20_000 })
      .toBe(0);

    // The external dictionary file now exists and contains the word on its own line.
    await expect
      .poll(() => (fs.existsSync(dictPath) ? fs.readFileSync(dictPath, 'utf8') : ''), {
        timeout: 20_000,
      })
      .toContain(`${UNKNOWN_WORD}\n`);

    // eslint-disable-next-line no-console
    console.log(
      `[harper-e2e] dictionary file ${dictPath} = ${JSON.stringify(
        fs.readFileSync(dictPath, 'utf8'),
      )}`,
    );
  });
});
