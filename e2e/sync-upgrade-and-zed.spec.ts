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
 * E2E — THE UPGRADE NOTICE and THE ZED BRIDGE (v1.5.0).
 *
 * Two v1.5.0 surfaces that have nothing to do with each other except that they can share one Joplin
 * launch, which in this suite is the expensive part:
 *
 *   * THE NOTICE. A v1.4.x user has a dictionary note and no sync note. The old note is a plain word
 *     list and the new one is machine-readable JSON carrying rules and dismissals as well, so there
 *     is no honest migration — the Harper window says so, in one line, and names the command. It is
 *     a BANNER and never a popup, which is what "appears in the window, unprompted nowhere else"
 *     means and what the second half of this spec checks by watching it disappear.
 *   * THE ZED EXPORT. A file beside the configured dictionary holding the harper-ls settings block,
 *     regenerated whenever the rules change. Asserted on disk, in the real filesystem the real
 *     plugin wrote to.
 */

const RULE = 'ModalOf';
const PHRASE = 'should of';
const NOTICE =
  'Your dictionary note cannot be used for the new settings sync, so make a new one with the ' +
  'command Harper: Create sync note.';

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

test.describe('Harper sync upgrade notice and Zed export', () => {
  let joplin: JoplinInstance;
  let dictDir = '';
  let dictPath = '';

  test.beforeAll(async () => {
    // A real external dictionary, so the Zed export has a real "beside" to be written to.
    dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-e2e-zed-'));
    dictPath = path.join(dictDir, 'dictionary.txt');
    fs.writeFileSync(dictPath, 'Alreadythere\n', 'utf8');
    joplin = await launchJoplin({ harperSettings: { dictionaryPath: dictPath } });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    try {
      fs.rmSync(dictDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('a v1.4.x dictionary note with no sync note shows the notice in the Harper window', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper Upgrade NB');
    await createNote(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Exactly the state a v1.4.1 user upgrades from: the OLD note, and nothing else.
    await executeCommand(win, 'harper.createDictionaryNote');
    await openNoteFromList(win, 'Scratch');

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

  test('disabling a rule regenerates the Zed settings block beside the dictionary file', async () => {
    const { win } = joplin;
    const zedPath = path.join(dictDir, 'zed-harper-ls.json');

    await openNoteFromList(win, 'Scratch');
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, `I ${PHRASE} gone.`);
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 60_000 })
      .toBeGreaterThan(0);

    const card = await openHarperCardByClick(win, PHRASE);
    await clickDisableRule(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 20_000 }).toBe(0);

    const readZed = () => {
      try {
        return JSON.parse(fs.readFileSync(zedPath, 'utf8'));
      } catch {
        return null;
      }
    };
    await expect
      .poll(() => readZed()?.lsp?.['harper-ls']?.settings?.['harper-ls']?.linters?.[RULE], {
        timeout: 60_000,
      })
      .toBe(false);

    const raw = fs.readFileSync(zedPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ${zedPath} =\n${raw}`);
    const inner = readZed().lsp['harper-ls'].settings['harper-ls'];
    // Zed nests harper-ls's own config root INSIDE its LSP block, so the key appears twice. A block
    // with only one layer pastes cleanly and does nothing at all.
    expect(inner.dialect).toBe('American');
    expect(inner.linters[RULE]).toBe(false);
    // SPARSE: the file must not be a dump of all ~823 rules.
    expect(Object.keys(inner.linters).length).toBeLessThan(10);
    // statsPath silently relocates harper-ls's file-local dictionary directory. Never emitted.
    expect(raw).not.toContain('statsPath');
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
