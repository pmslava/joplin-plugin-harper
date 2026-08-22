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
 * DESKTOP pre-flight gate for the Harper mobile spike (v0.0.2, self-diagnosing staged S5).
 *
 * Runs the SAME spike plugin the user will sideload on Android, but inside a real desktop Joplin
 * (Electron) — it uses no Node APIs, so it behaves identically to the mobile background WebView for
 * the purposes of these assertions. Proves, before anyone touches a phone:
 *   - the plugin background runs (WASM probe host is alive),
 *   - the staged probe reaches 'SPIKE COMPLETE' and S3 reports a positive lint count (harper.js
 *     instantiated, initialised and linted end to end),
 *   - S5: the content script's STAGED activation (S5a require → S5b no-op ext → S5c linter(zero) →
 *     S5d linter emits spiketest+markClass → S5e CSS → S5f tap card) all report OK on desktop, the
 *     spiketest underline paints, and the tap card opens/closes. Any device failure is therefore
 *     device-specific, and the note's last S5x line will finger the stage that kills the mobile editor.
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
      `\n========== HARPER SPIKE RESULTS NOTE (desktop, after SPIKE COMPLETE) ==========\n${body}\n` +
        `==============================================================================\n`,
    );

    // Hard assertions.
    expect(body).toContain('S1 OK');
    expect(body).toContain('S2 OK');
    expect(body).toContain('S3 OK');
    expect(body).toMatch(/===== SPIKE RUN v0\.0\.2 /); // header carries the spike version
    const m = body.match(/lastLintCount=(\d+)/);
    expect(m, 'S3 must report a lastLintCount').not.toBeNull();
    const lintCount = m ? parseInt(m[1], 10) : 0;
    // eslint-disable-next-line no-console
    console.log(`[spike-e2e] S3 lastLintCount = ${lintCount}`);
    expect(lintCount).toBeGreaterThan(0);
  });

  test('S5 staged: all stages report OK, the spiketest underline paints, and the tap card opens/closes', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Spike Editor NB');
    await createNote(win, 'Spike editor probe ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Opening this editor starts the content script's staged timeline (S5a immediately, then S5b..S5f
    // ~3 s apart → S5f arms at ~15 s). Seed the body with the trigger word up front.
    await setEditorBody(win, 'A line with spiketest in it, and another spiketest too.');

    // Give the timeline time to pass S5d (linter emits, ~9 s), S5e (CSS) and S5f (card, ~15 s), then
    // nudge a fresh doc change so the linter (now in emit mode) definitely re-runs and paints marks.
    await win.waitForTimeout(17_000);
    await setEditorBody(win, 'A line with spiketest in it, and yet another spiketest here.');

    // The spike underline decoration must paint (S5d flipped the linter into emit mode + markClass).
    const underline = win.locator('.cm-lintRange.spike-underline').filter({ hasText: 'spiketest' });
    await expect.poll(() => underline.count(), { timeout: 30_000 }).toBeGreaterThan(0);

    // Tap/click the underline -> the dummy card opens (S5f armed the mousedown + showTooltip machinery).
    await underline.first().click({ force: true });
    const card = win.locator('.spike-click-tooltip .spike-card');
    for (let attempt = 0; attempt < 12 && !(await card.count()); attempt++) {
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

    // Now assert the STAGED evidence landed in the results note: every stage reported OK on desktop.
    // (These lines are produced by the probe-note editor's timeline while the results note itself is
    // NOT the open editor, so they persist cleanly.)
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return (
            /S5a\[\w+\] require @codemirror\/lint ok/.test(body) &&
            /S5b\[\w+\] OK/.test(body) &&
            /S5c\[\w+\] OK/.test(body) &&
            /S5d\[\w+\] OK/.test(body) &&
            /S5e\[\w+\] OK/.test(body) &&
            /S5f\[\w+\] OK/.test(body)
          );
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toBe(true);

    // Emit only the S5-related lines verbatim for the report.
    const s5Lines = body
      .split('\n')
      .filter((l) => /\bS5[a-f]?\b/.test(l) || l.includes('EDITOR ERROR'))
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE RESULTS NOTE — S5 STAGED LINES (desktop) ==========\n${s5Lines}\n` +
        `==========================================================================\n`,
    );

    // Individual hard assertions (redundant with the poll, but explicit per stage).
    expect(body, 'S5a view').toMatch(/S5a\[\w+\] require @codemirror\/view ok/);
    expect(body, 'S5a lint').toMatch(/S5a\[\w+\] require @codemirror\/lint ok/);
    expect(body, 'S5a state').toMatch(/S5a\[\w+\] require @codemirror\/state ok/);
    expect(body, 'S5b').toMatch(/S5b\[\w+\] OK/);
    expect(body, 'S5c').toMatch(/S5c\[\w+\] OK/);
    expect(body, 'S5d').toMatch(/S5d\[\w+\] OK/);
    expect(body, 'S5e').toMatch(/S5e\[\w+\] OK/);
    expect(body, 'S5f').toMatch(/S5f\[\w+\] OK/);
    // No stage crashed the desktop editor.
    expect(body, 'no EDITOR ERROR on desktop').not.toContain('EDITOR ERROR');
  });
});
