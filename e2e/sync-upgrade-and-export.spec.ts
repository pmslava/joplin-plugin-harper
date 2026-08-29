import { test, expect, Frame, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  clickDisableRule,
  executeCommand,
  openNoteFromList,
  runCommand,
} from './helpers';

/**
 * E2E — THE UPGRADE NOTICE and THE SETTINGS EXPORT (v1.5.0).
 *
 * Two v1.5.0 surfaces that have nothing to do with each other except that they can share one Joplin
 * launch, which in this suite is the expensive part:
 *
 *   * THE NOTICE. A v1.4.x user has a dictionary note and no sync note. The old note is a plain word
 *     list and the new one is machine-readable JSON carrying rules and dismissals as well, so there
 *     is no honest migration — the Harper window says so, in one line, and names the command. It is
 *     a BANNER and never a popup, which is what "appears in the window, unprompted nowhere else"
 *     means and what the second half of this spec checks by watching it disappear.
 *   * THE SETTINGS EXPORT. The file named by the `settingsPath` setting, which Harper owns outright
 *     and rewrites wholesale whenever the dialect or a rule override changes. Asserted on disk, in
 *     the real filesystem the real plugin wrote to.
 *
 * This used to be "the Zed bridge": a `zed-harper-ls.json` sidecar written beside the dictionary
 * file, carrying Zed's own nested `lsp.harper-ls.settings.harper-ls` block. That shipped one editor's
 * config format from a plugin that has no business knowing it, so it was replaced by one flat file at
 * a path the user names. Both the sidecar and the "Copy Zed settings block" button are gone, and so
 * is every assertion about them.
 */

const RULE = 'ModalOf';
const PHRASE = 'should of';
const NOTICE =
  'Your dictionary note is no longer used. Create a sync note with the command Harper: Create ' +
  'sync note, and delete the old dictionary note if you like.';

/**
 * A legacy `dictionaryNoteId`, seeded straight into settings.json (see beforeAll).
 *
 * It does NOT have to resolve to a real note: the notice fires on "a dictionaryNoteId is set and a
 * syncNoteId is not", and the only thing that ever reads the note behind it is the one-time word fold
 * inside "Harper: Create sync note", which treats an unreadable id as "no words" by design.
 */
const LEGACY_NOTE_ID = '0123456789abcdef0123456789abcdef';

// -----------------------------------------------------------------------------
// Dialog plumbing. Deliberately local rather than shared with settings-dialog.spec.ts: that file is
// a passing v1.4.1 spec and this feature is not a reason to edit it.
// -----------------------------------------------------------------------------

async function findSettingsFrame(win: Page): Promise<Frame | null> {
  for (const frame of win.frames()) {
    try {
      if (await frame.locator('#harper-settings .hs-scroll').count()) return frame;
    } catch {
      // The frame detached mid-scan (Joplin tears webviews down eagerly) — just skip it.
    }
  }
  return null;
}

/** Open the Harper window and hand back its frame, once the snapshot has actually rendered. */
async function openSettings(win: Page): Promise<Frame> {
  await runCommand(win, 'harper.openSettings');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const frame = await findSettingsFrame(win);
    if (frame) {
      await frame.locator('.hs-tab[data-tab="rules"]').waitFor({ state: 'visible', timeout: 60_000 });
      return frame;
    }
    await win.waitForTimeout(400);
  }
  throw new Error(`the Harper window never appeared; frames were:\n${win.frames().map((f) => f.url()).join('\n')}`);
}

async function closeSettings(win: Page): Promise<void> {
  const button = win.locator('button', { hasText: /^Close$/ }).last();
  if (await button.count()) await button.click({ timeout: 10_000 }).catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await findSettingsFrame(win))) {
      await win.waitForTimeout(800);
      return;
    }
    await win.keyboard.press('Escape').catch(() => undefined);
    await win.waitForTimeout(400);
  }
  throw new Error('the Harper window would not close');
}

test.describe.configure({ mode: 'serial' });

test.describe('Harper sync upgrade notice and settings export', () => {
  let joplin: JoplinInstance;
  let workDir = '';
  let dictPath = '';
  let settingsPath = '';

  test.beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-e2e-export-'));
    // A real external dictionary, so the plugin has a configured file side as a v1.4.x user would.
    dictPath = path.join(workDir, 'dictionary.txt');
    fs.writeFileSync(dictPath, 'Alreadythere\n', 'utf8');
    // Deliberately NOT pre-created: "the file appears" is half of what the export test proves.
    settingsPath = path.join(workDir, 'harper-settings.json');
    // The legacy state is SEEDED, not driven.
    //
    // It used to be produced by running `harper.createDictionaryNote`. That command is gone, and
    // `executeCommand` throws hard on a command Joplin does not know — so the only honest way to be
    // a v1.4.x install is to boot with the v1.4.x value already in settings.json, which is exactly
    // what `harperSettings` writes (launch.ts pluginSettingKey; the same route dialect.spec.ts and
    // the dictionaryPath specs take). The key is private now, but private is a visibility flag: the
    // value still lives in settings.json and the plugin still reads it on startup.
    joplin = await launchJoplin({
      harperSettings: {
        dictionaryPath: dictPath,
        settingsPath,
        dictionaryNoteId: LEGACY_NOTE_ID,
      },
    });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('a v1.4.x dictionary note with no sync note shows the notice in the Harper window', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Upgrade NB');
    await createNote(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Exactly the state a v1.4.1 user upgrades from — a dictionaryNoteId and no syncNoteId — is
    // already in place from beforeAll's seed, so there is nothing to drive here.
    const frame = await openSettings(win);
    const notice = frame.locator('#hs-sync-notice');
    await notice.waitFor({ state: 'visible', timeout: 30_000 });
    const text = ((await notice.textContent()) ?? '').trim();
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] sync notice = ${text}`);
    expect(text).toBe(NOTICE);
    // It names the command, because that is the only thing the user can act on.
    expect(text).toContain('Harper: Create sync note');
    // Above the tabs, not inside one: a stale sync setup is a property of the window.
    const aboveTabs = await frame.evaluate(() => {
      const el = document.getElementById('hs-sync-notice');
      const tabs = document.getElementById('hs-tabs');
      if (!el || !tabs) return false;
      // eslint-disable-next-line no-bitwise
      return !!(el.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(aboveTabs, 'the notice sits above the tab bar').toBe(true);

    await closeSettings(win);
  });

  /**
   * The Zed test this replaces asserted a sidecar file, at a path the plugin chose, in Zed's nested
   * block format. All three of those are gone. What is left to prove is the whole of the new
   * promise: the file at the user's `settingsPath` APPEARS, and it UPDATES when a rule is toggled.
   */
  test('disabling a rule writes that rule into the external settings file', async () => {
    const { win } = joplin;

    const readExport = () => {
      try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        return null;
      }
    };

    // THE FILE APPEARS. beforeAll pointed `settingsPath` at a path with nothing on it; warm-up alone
    // is enough to create it. Nothing has been overridden yet, so `linters` is absent rather than
    // empty — an absent key and `{}` say the same thing, and the absent one does not invite anyone to
    // read it as "Harper disabled every linter".
    await expect.poll(() => readExport()?.dialect, { timeout: 60_000 }).toBe('American');
    expect(readExport().linters, 'no overrides yet, so no linters key').toBeUndefined();

    await openNoteFromList(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, `I ${PHRASE} gone.`);
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCardByClick(win, PHRASE);
    await clickDisableRule(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 20_000 }).toBe(0);

    // ...AND IT UPDATES. The toggle went through the suggestion card, not the settings file.
    await expect
      .poll(() => readExport()?.linters?.[RULE], { timeout: 60_000 })
      .toBe(false);

    const raw = fs.readFileSync(settingsPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ${settingsPath} =\n${raw}`);
    const exported = readExport();
    // FLAT, in harper's own vocabulary: `{dialect, linters}` at the top level and no editor's
    // wrapper around it. American is the default dialect this profile booted with.
    expect(exported.dialect).toBe('American');
    expect(exported.linters[RULE]).toBe(false);
    expect(exported.lsp, 'no editor-specific nesting').toBeUndefined();
    // SPARSE: the file must not be a dump of all ~823 rules.
    expect(Object.keys(exported.linters).length).toBeLessThan(10);
    // The exact bytes matter to whoever diffs or version-controls this file: tab indent, one
    // trailing newline, and nothing else after it.
    expect(raw).toContain('\n\t"linters"');
    expect(raw.endsWith('}\n')).toBe(true);
  });

  test('creating the sync note silences the notice', async () => {
    const { win } = joplin;

    await executeCommand(win, 'harper.createSyncNote');
    await openNoteFromList(win, 'Scratch');

    const frame = await openSettings(win);
    // The window has rendered (the tabs are up); the notice must simply not be there.
    await expect(frame.locator('#hs-sync-notice')).toHaveCount(0);
    await closeSettings(win);
  });
});
