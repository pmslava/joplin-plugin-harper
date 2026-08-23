import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  focusEditor,
  runCommand,
  openNoteFromList,
  readNoteBodyFresh,
} from './helpers';

/**
 * E2E (c) — desktop NOTE <-> FILE MIRROR.
 *
 * With BOTH an external dictionary file AND a dictionary note configured, words must flow both ways:
 *  - FILE -> NOTE: a word seeded in the file lands in the dictionary note (the deferred flush merges
 *    file words into the note on a selection change).
 *  - NOTE -> FILE: a word added to the dictionary note lands in the file (the flush's note->file mirror
 *    appends note words the file is missing).
 *
 * Reads that target a note go through `readNoteBodyFresh` under `expect.poll`, which navigates away and
 * back each attempt — so the retry naturally absorbs the "flush writes the note on the same selection
 * change that opened it, so the just-opened editor shows the pre-flush body" race.
 */
test.describe('Harper dictionary note<->file mirror', () => {
  let joplin: JoplinInstance;
  let dictFile: string;

  const FILE_WORD = 'Zqxfile';
  const NOTE_WORD = 'Zqxnote';

  test.beforeAll(async () => {
    // Seed the external file with FILE_WORD before launch, and point the plugin at it.
    const profileDir = createProfile(true, {});
    dictFile = path.join(profileDir, 'mirror-dict.txt');
    fs.writeFileSync(dictFile, `${FILE_WORD}\n`, 'utf8');
    const settingsFile = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings[pluginSettingKey('dictionaryPath')] = dictFile;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('file word reaches the note and note word reaches the file', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Mirror NB');
    await createNote(win, 'MScratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Create the dictionary note; this sets dictionaryNoteId (the mirror is now live).
    await runCommand(win, 'Harper Create dictionary note');
    await openNoteFromList(win, 'MScratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // FILE -> NOTE: the seeded file word must appear in the dictionary note after a flush.
    await expect
      .poll(async () => readNoteBodyFresh(win, 'Harper Dictionary', 'MScratch'), { timeout: 90_000 })
      .toContain(FILE_WORD);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] mirror FILE->NOTE ok: file word present in the dictionary note');

    // NOTE -> FILE: add a new word directly into the dictionary note, then leave so the flush mirrors
    // it into the file. We are currently on the dictionary note (from the read above).
    await focusEditor(win);
    await win.keyboard.press('Control+End');
    await win.keyboard.press('Enter');
    await win.keyboard.type(NOTE_WORD);
    await win.waitForTimeout(2500); // let Joplin persist the edited note body before we leave it
    await openNoteFromList(win, 'MScratch'); // selection change -> flush reads the note + mirrors to the file

    await expect
      .poll(() => (fs.existsSync(dictFile) ? fs.readFileSync(dictFile, 'utf8') : ''), {
        timeout: 90_000,
      })
      .toContain(NOTE_WORD);

    const fileText = fs.readFileSync(dictFile, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] mirror NOTE->FILE ok: file now = ${JSON.stringify(fileText)}`);
    expect(fileText).toContain(FILE_WORD); // the original file word is preserved
    expect(fileText).toContain(NOTE_WORD); // the note word was mirrored in
  });
});
