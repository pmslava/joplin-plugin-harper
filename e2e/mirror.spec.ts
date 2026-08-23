import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  focusEditor,
  getEditorBody,
  setEditorBody,
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

  /**
   * v1.3.0 — DELETION propagates (the user-reported bug: a word deleted from the dictionary note came
   * back on the next poll, resurrected by the union with the external file).
   *
   * Runs against whatever state the app is in: it reuses the dictionary note the previous test made
   * when it is there, and creates its own notebook + scratch note + dictionary note when it is not.
   * That matters because a Playwright retry restarts the worker, so `beforeAll` hands this test a
   * FRESH profile with no notebook, no scratch note and no dictionary note at all. Either way both
   * notes end up in the SAME notebook, which is what `openNoteFromList` (a note-list click) needs.
   */
  test('a word deleted from the dictionary note is removed from the file and stays gone', async () => {
    const { win } = joplin;
    const DEL_WORD = 'Zqxdelete';
    const readDict = () => (fs.existsSync(dictFile) ? fs.readFileSync(dictFile, 'utf8') : '');
    /** The file's words, in file order, with comment and blank lines skipped (the plugin's own parse). */
    const dictWords = () =>
      readDict()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('# '));
    const noteIsListed = async (title: string) =>
      (await win.locator('.note-list-item-wrapper, .note-list-item').filter({ hasText: title }).count()) > 0;

    let scratch = 'MScratch';
    if (!(await noteIsListed('Harper Dictionary'))) {
      // Fresh profile (a retry): build the whole fixture, dictionary note included. The create command
      // puts it in the selected notebook, so it lands next to the scratch note in the note list.
      scratch = 'DScratch';
      await createNotebook(win, 'Harper Delete NB');
      await createNote(win, scratch);
      await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
      await runCommand(win, 'Harper Create dictionary note');
    }
    await openNoteFromList(win, scratch);
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // 1) Add the word by hand at the end of the dictionary note, then leave the note so the plugin
    //    reconciles: the word must reach the external file (v1.2.0 behaviour, still expected).
    await openNoteFromList(win, 'Harper Dictionary');
    await focusEditor(win);
    await win.keyboard.press('Control+End');
    await win.keyboard.press('Enter');
    await win.keyboard.type(DEL_WORD);
    await win.waitForTimeout(2500); // let Joplin persist the edited body before we navigate away
    await openNoteFromList(win, scratch); // selection change -> reconcile
    await expect.poll(readDict, { timeout: 90_000 }).toContain(DEL_WORD);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] deletion setup ok: file = ${JSON.stringify(readDict())}`);

    // 2) Now DELETE that word from the note, as a user editing their dictionary note would: select
    //    the body and retype it without that line.
    //    The keep-list comes from the FILE, not from the editor: the Markdown editor hides the "# "
    //    of a heading, so retyping what `getEditorBody` reports would silently turn the note's own
    //    comment header into a dictionary word.
    const keep = dictWords().filter((w) => w !== DEL_WORD);
    expect(keep.length).toBeGreaterThan(0);
    await openNoteFromList(win, 'Harper Dictionary');
    await setEditorBody(win, `# harper dictionary\n\n${keep.join('\n')}`);
    const typed = await getEditorBody(win);
    expect(typed).not.toContain(DEL_WORD); // the word really is out of the note body now
    await win.waitForTimeout(2500);
    await openNoteFromList(win, scratch); // selection change -> reconcile

    // 3) The file must lose the word (v1.2.0 kept it, and put it straight back into the note).
    await expect.poll(readDict, { timeout: 90_000 }).not.toContain(DEL_WORD);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] deletion ok: the word is gone from the external file');

    // 4) …and it must not be resurrected by a further reconcile cycle, on either side.
    await openNoteFromList(win, 'Harper Dictionary');
    await win.waitForTimeout(1500);
    await openNoteFromList(win, scratch);
    await win.waitForTimeout(5000);
    const fileAfter = readDict();
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] file after a further cycle = ${JSON.stringify(fileAfter)}`);
    expect(fileAfter).not.toContain(DEL_WORD);
    for (const word of keep) expect(fileAfter).toContain(word); // survivors are untouched
    const noteAfter = await readNoteBodyFresh(win, 'Harper Dictionary', scratch);
    expect(noteAfter).not.toContain(DEL_WORD);
  });
});
