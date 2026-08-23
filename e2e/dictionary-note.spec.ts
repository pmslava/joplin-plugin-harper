import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  getEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  clickAddToDictionary,
  runCommand,
  openNoteFromList,
  readNoteBodyFresh,
} from './helpers';

/**
 * E2E (b) — DICTIONARY NOTE flow (the v1.1.0 centerpiece, on the desktop app).
 *
 * 1. Create the dictionary note via the plugin command `harper.createDictionaryNote`.
 * 2. In a scratch note, type an unknown word and add it via the card's add-to-dictionary action —
 *    which buffers it into the pendingWords setting (no note write yet: deferred per L3 discipline).
 * 3. Switch notes (a selection change) — the deferred flush now writes the buffered word into the
 *    dictionary note.
 * 4. Open the dictionary note fresh and assert its body contains the word on its own line, under the
 *    canonical "# " header — proving the whole buffer -> deferred-flush -> canonical-note path.
 */
test.describe('Harper dictionary note', () => {
  let joplin: JoplinInstance;
  const UNKNOWN_WORD = 'Xqzzy';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('create-note command + add-to-dictionary + note switch writes the word into the dictionary note', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper DictNote NB');
    await createNote(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // 1) Create the dictionary note via the command (label "Harper: Create dictionary note").
    await runCommand(win, 'Harper Create dictionary note');

    // Re-open the scratch note from the list (the command adds "Harper Dictionary" to the list) and
    // type the unknown word.
    await openNoteFromList(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, `${UNKNOWN_WORD} is a made-up word.`);

    await expect
      .poll(() => lintRangeCountForWord(win, UNKNOWN_WORD), { timeout: 60_000 })
      .toBeGreaterThan(0);

    // 2) Add to dictionary — buffers into pendingWords; the underline clears immediately (in-memory).
    const card = await openHarperCardByClick(win, UNKNOWN_WORD);
    await clickAddToDictionary(win, card);
    await expect
      .poll(() => lintRangeCountForWord(win, UNKNOWN_WORD), { timeout: 20_000 })
      .toBe(0);

    // 3+4) Switch notes (flush trigger) then read the dictionary note fresh. The poll navigates away
    // and back each attempt, absorbing the "flush writes the note on the same selection change that
    // opened it, so the just-opened editor shows the pre-flush body" race.
    await expect
      .poll(async () => readNoteBodyFresh(win, 'Harper Dictionary', 'Scratch'), { timeout: 60_000 })
      .toContain(UNKNOWN_WORD);

    const body = await getEditorBody(win); // now on the dictionary note, post-flush
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] dictionary note body =\n${body}`);
    // Canonical: the "# " comment header is present, and the word stands alone on a line.
    expect(body).toContain('#');
    expect(new RegExp(`(^|\\n)${UNKNOWN_WORD}(\\n|$)`).test(body)).toBe(true);
  });
});
