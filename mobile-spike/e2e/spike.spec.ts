import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, PLUGIN_ID } from '../../e2e/launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  getEditorBody,
  pluginBackgroundPageRunning,
} from '../../e2e/helpers';

/**
 * DESKTOP pre-flight gate for the Harper mobile spike.
 *
 * Runs the SAME spike plugin the user will sideload on Android, but inside a real desktop Joplin
 * (Electron) — it uses no Node APIs, so it behaves identically to the mobile background WebView for
 * the purposes of these assertions. Proves, before anyone touches a phone:
 *   - the plugin background runs (WASM probe host is alive),
 *   - the staged probe reaches 'SPIKE COMPLETE' and S3 reports a positive lint count (harper.js
 *     instantiated, initialised and linted end to end),
 *   - S5: a CM6 content script paints the 'spiketest' underline and the tap card opens/closes.
 */

const RESULTS_TITLE = 'Harper Mobile Spike Results';

/** Re-select the Spike folder then the results note (forces a fresh DB read of its body) and return it. */
async function readResultsNoteBody(win: Page): Promise<string> {
  try {
    await win.getByText('Spike', { exact: true }).first().click({ timeout: 5000 });
    await win.waitForTimeout(400);
  } catch {
    /* folder may not be rendered yet */
  }
  try {
    await win.getByText(RESULTS_TITLE, { exact: true }).first().click({ timeout: 5000 });
    await win.waitForTimeout(600);
  } catch {
    /* note may not be rendered yet */
  }
  if (!(await editorIsPresent(win))) return '';
  return getEditorBody(win);
}

test.describe('Harper mobile spike — desktop pre-flight', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('spike id is the isolated spike id (not the real plugin)', async () => {
    expect(PLUGIN_ID).toBe('io.github.pmslava.harperspike');
  });

  test('plugin background page is running (CDP)', async () => {
    await expect
      .poll(() => pluginBackgroundPageRunning(joplin.win), { timeout: 30_000 })
      .toBe(true);
  });

  test('staged probe reaches SPIKE COMPLETE with a positive S3 lint count', async () => {
    const { win } = joplin;

    // Poll the results note until the probe signals completion. The body is written incrementally by
    // the plugin (append-per-stage), and each read re-selects the note to force a fresh DB load.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return body.includes('SPIKE COMPLETE');
        },
        { timeout: 240_000, intervals: [3000] },
      )
      .toBe(true);

    // Capture the full results-note body as evidence (this is what the report quotes verbatim).
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE RESULTS NOTE (desktop) ==========\n${body}\n` +
        `========================================================\n`,
    );

    // Hard assertions.
    expect(body).toContain('S1 OK');
    expect(body).toContain('S2 OK');
    expect(body).toContain('S3 OK');
    const m = body.match(/lastLintCount=(\d+)/);
    expect(m, 'S3 must report a lastLintCount').not.toBeNull();
    const lintCount = m ? parseInt(m[1], 10) : 0;
    // eslint-disable-next-line no-console
    console.log(`[spike-e2e] S3 lastLintCount = ${lintCount}`);
    expect(lintCount).toBeGreaterThan(0);
  });

  test('S5: content script paints the spiketest underline and the tap card opens/closes', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Spike Editor NB');
    await createNote(win, 'Spike editor probe ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    await setEditorBody(win, 'A line with spiketest in it, and another spiketest too.');

    // The spike underline decoration must paint (linter delay 100 ms + relint).
    const underline = win.locator('.cm-lintRange.spike-underline').filter({ hasText: 'spiketest' });
    await expect.poll(() => underline.count(), { timeout: 30_000 }).toBeGreaterThan(0);

    // Tap/click the underline -> the dummy card opens.
    await underline.first().click({ force: true });
    const card = win.locator('.spike-click-tooltip .spike-card');
    for (let attempt = 0; attempt < 6 && !(await card.count()); attempt++) {
      await underline.first().click({ force: true });
      await win.waitForTimeout(400);
    }
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Spike card');
    const itWorks = card.locator('button', { hasText: 'It works' });
    await expect(itWorks).toHaveCount(1);

    // The 'It works' button closes the card.
    await itWorks.click({ force: true });
    await expect.poll(() => card.count(), { timeout: 10_000 }).toBe(0);

    // Opening an editor also made the content script post its S5 line back to the results note.
    await expect
      .poll(async () => (await readResultsNoteBody(win)).includes('S5 content script loaded in editor'), {
        timeout: 30_000,
        intervals: [2000],
      })
      .toBe(true);
  });
});
