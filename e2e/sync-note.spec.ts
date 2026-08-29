import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  clickDisableRule,
  clickDismiss,
  executeCommand,
  openNoteFromList,
  readNoteBodyViaApi,
  writeNoteBodyViaApi,
  readPluginSetting,
} from './helpers';

/**
 * E2E — THE SYNC NOTE (v1.5.0), in a real Joplin.
 *
 * The mailbox, both directions, through the real UI and the real note store:
 *
 *   1. "Harper: Create sync note" makes a note whose body is the human sentence plus a fenced JSON
 *      block, and points the setting at it.
 *   2. Disabling a rule from a suggestion card puts that override into the note.
 *   3. A SECOND DEVICE — simulated by writing the note's body through the data API, which is
 *      precisely what a Joplin sync delivers and nothing more — has its state applied here: the
 *      override goes away and the underline comes back.
 *   4. Dismissing a finding puts harper's own ignore payload into the note, verbatim.
 *
 * Serial: one Joplin instance, each test building on the last, because launching Joplin is by far
 * the most expensive thing this suite does.
 *
 * THE NOTE IS ONLY EVER READ THROUGH THE DATA API, never off the rendered editor: `innerText` drops
 * a fenced block's own backticks, so a body that renders "correctly" can still be unparseable JSON.
 */

const RULE = 'ModalOf'; // the rule behind "should of" — the same one disable-rule.spec.ts pins
const PHRASE = 'should of';
const SENTENCE = 'This note is used by the Harper plugin to sync settings between devices.';

/** The payload out of the note's fenced block, or null when the body does not carry one. */
function parseSyncBody(body: string): any {
  const match = /```json[^\S\n]*\n([\s\S]*?)\n?```/.exec(body || '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Leave the current note and come back.
 *
 * This is the plugin's own drain point, not a test convenience: a plugin note write while an editor
 * is open evicts the mobile editor (the L3 rule the dictionary note has always obeyed), so the sync
 * note's write is deferred exactly the same way and lands on the next selection change. It is also
 * where the plugin reads the note back.
 */
async function bounceNotes(win: Page, away: string, back: string): Promise<void> {
  await openNoteFromList(win, away);
  await win.waitForTimeout(1200);
  await openNoteFromList(win, back);
  await win.waitForTimeout(1200);
}

test.describe.configure({ mode: 'serial' });

test.describe('Harper sync note', () => {
  let joplin: JoplinInstance;
  let syncNoteId = '';

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the create command makes a machine-readable note and stores its id', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Sync NB');
    await createNote(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, `I ${PHRASE} gone.`);

    // BY ID, not through the command palette: the palette's `:` mode is a fuzzy match over a shared
    // namespace, and this plugin now registers three commands whose labels start "Harper: ".
    await executeCommand(win, 'harper.createSyncNote');

    await expect
      .poll(async () => String((await readPluginSetting(win, 'syncNoteId')) ?? ''), { timeout: 60_000 })
      .not.toBe('');
    syncNoteId = String(await readPluginSetting(win, 'syncNoteId'));

    const body = await readNoteBodyViaApi(win, syncNoteId);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] fresh sync note body =\n${body}`);
    expect(body).toContain(SENTENCE);
    expect(body).toContain('Do not edit it.');
    const payload = parseSyncBody(body);
    expect(payload, `the body carries a parseable json fence:\n${body}`).not.toBeNull();
    expect(payload.version).toBe(1);
    expect(typeof payload.updatedAt).toBe('string');
    expect(payload.dismissed).toBeTruthy();
    expect(Array.isArray(payload.words)).toBe(true);
  });

  test('disabling a rule from a card writes that override into the note', async () => {
    const { win } = joplin;

    await openNoteFromList(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCardByClick(win, PHRASE);
    await clickDisableRule(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 20_000 }).toBe(0);

    // The write is L3-deferred while an editor is open; leaving the note is the drain point.
    await bounceNotes(win, 'Harper Sync', 'Scratch');

    await expect
      .poll(
        async () => {
          const payload = parseSyncBody(await readNoteBodyViaApi(win, syncNoteId));
          return payload?.ruleOverrides?.[RULE];
        },
        { timeout: 90_000 },
      )
      .toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] note after the rule toggle =\n${await readNoteBodyViaApi(win, syncNoteId)}`);
  });

  test('a remote edit to the note is applied here: the rule comes back and so does the underline', async () => {
    const { win } = joplin;

    // A SECOND DEVICE'S WRITE. Same content, minus the override — which is exactly what "the other
    // device turned the rule back on" looks like once Joplin has synced it here.
    const before = parseSyncBody(await readNoteBodyViaApi(win, syncNoteId));
    expect(before.ruleOverrides[RULE]).toBe(false);
    const remote = { ...before, updatedAt: new Date().toISOString(), ruleOverrides: {} };
    const remoteBody =
      `${SENTENCE} Do not edit it. Change settings in Harper settings.\n\n` +
      `\`\`\`json\n${JSON.stringify(remote, null, 2)}\n\`\`\`\n`;
    await writeNoteBodyViaApi(win, syncNoteId, remoteBody);

    // The plugin reads the note on a selection change (and on its 60 s poll).
    await bounceNotes(win, 'Harper Sync', 'Scratch');

    // THE VISIBLE CONSEQUENCE: the rule is live again, so the underline is painted again. This is
    // the assertion that a settings write alone could not fake.
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 90_000 })
      .toBeGreaterThan(0);

    // ...and the override really was dropped from this device's own setting, not just from the engine.
    await expect
      .poll(async () => String((await readPluginSetting(win, 'ruleOverrides')) ?? ''), { timeout: 30_000 })
      .not.toContain(RULE);

    // LOOP PREVENTION: applying wrote settings, which schedules a write. That write must recognise
    // itself as redundant, or the two devices rewrite the note at each other forever.
    const settled = await readNoteBodyViaApi(win, syncNoteId);
    await bounceNotes(win, 'Harper Sync', 'Scratch');
    await win.waitForTimeout(6000); // longer than the write debounce
    expect(await readNoteBodyViaApi(win, syncNoteId)).toBe(settled);
  });

  test('dismissing a finding carries harper\'s ignore payload into the note', async () => {
    const { win } = joplin;

    await openNoteFromList(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCardByClick(win, PHRASE);
    await clickDismiss(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 20_000 }).toBe(0);

    await bounceNotes(win, 'Harper Sync', 'Scratch');

    const payload = await (async () => {
      await expect
        .poll(
          async () => {
            const p = parseSyncBody(await readNoteBodyViaApi(win, syncNoteId));
            return p?.dismissed?.entries?.length ?? 0;
          },
          { timeout: 90_000 },
        )
        .toBeGreaterThan(0);
      return parseSyncBody(await readNoteBodyViaApi(win, syncNoteId));
    })();

    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] dismissed half of the note = ${JSON.stringify(payload.dismissed)}`);
    // harper's payload crossed as a STRING, so the u64 context hashes are still exact digits. A
    // number here would mean the note had round-tripped them through a JSON double.
    expect(typeof payload.dismissed.ignoredLintsRaw).toBe('string');
    expect(payload.dismissed.ignoredLintsRaw).toContain('context_hashes');
    for (const entry of payload.dismissed.entries) {
      expect(Array.isArray(entry.hashes)).toBe(true);
      for (const hash of entry.hashes) {
        expect(typeof hash).toBe('string');
        expect(hash).toMatch(/^\d+$/);
      }
    }
    expect(payload.dismissed.entries[0].rule).toBeTruthy();
  });
});
