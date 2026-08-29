import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  getEditorBody,
  focusEditor,
  setEditorBody,
  lintRangeCountForWord,
} from './helpers';

/**
 * E2E (d) — EVICTION SAFETY (documents the desktop safety of the L3-deferral discipline).
 *
 * On mobile, a plugin note-write while an editor is open evicts that editor (L3). Our design forbids
 * note writes while an editor is open on EITHER platform: the write is deferred until a note
 * selection change or plugin start. This spec proves the discipline holds on desktop: while the user is
 * actively editing note A, a background dictionary reconcile (a word dropped into the external file,
 * then picked up by the 60s poll) must NOT disturb the open editor of note A.
 *
 * The reconcile used to have a note side as well as a file side, and this spec used to create that
 * note so the flush had a write target. The dictionary note is gone: the reconcile's only durable
 * side is the external FILE, so there is nothing left to create and the poll below is the whole
 * background cycle.
 *
 * It also confirms the cycle genuinely RAN (not that nothing happened): after the poll, the file word
 * is already imported into the linter, so typing it into A produces no underline — while A's body was
 * never reloaded and its existing underlines stayed put.
 */
test.describe('Harper eviction safety (desktop deferral discipline)', () => {
  let joplin: JoplinInstance;
  let dictFile: string;

  const FILE_WORD = 'Zqxfileword';

  test.beforeAll(async () => {
    const profileDir = createProfile(true, {});
    dictFile = path.join(profileDir, 'evict-dict.txt');
    fs.writeFileSync(dictFile, '', 'utf8'); // exists but empty, so the poll has a baseline
    const settingsFile = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings[pluginSettingKey('dictionaryPath')] = dictFile;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // Titled for what it now proves. It used to say "a background file->note mirror cycle", which
  // named a mechanism that no longer exists — the assertions were always about the external file and
  // an undisturbed editor, and those are all that is left.
  test('a background dictionary reconcile does not disturb the note being edited', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Evict NB');
    await createNote(win, 'NoteA');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Start an editing session with some lints.
    await setEditorBody(win, 'I beleive teh cat sat.');
    await expect
      .poll(() => lintRangeCountForWord(win, 'beleive'), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const bodyBefore = await getEditorBody(win);

    // Drop a word into the external file mid-edit — the 60s poll will re-import it and run a full
    // reconcile pass while NoteA's editor is open.
    fs.appendFileSync(dictFile, `${FILE_WORD}\n`);

    // Wait past one poll interval (60s) so the reconcile definitely runs while NoteA is open.
    await win.waitForTimeout(65_000);

    // NoteA's editor is intact: still present, same body, existing underline still there.
    expect(await editorIsPresent(win)).toBe(true);
    expect(await getEditorBody(win)).toBe(bodyBefore);
    expect(await lintRangeCountForWord(win, 'beleive')).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('[harper-e2e] eviction-safety: NoteA undisturbed after the background reconcile');

    // Evidence the cycle actually ran: the file word is now in the linter, so typing it is NOT flagged.
    await focusEditor(win);
    await win.keyboard.press('Control+End');
    await win.keyboard.type(` ${FILE_WORD}`);
    await win.waitForTimeout(1500);
    await expect
      .poll(() => lintRangeCountForWord(win, FILE_WORD), { timeout: 20_000 })
      .toBe(0);
  });
});
