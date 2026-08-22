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
 * DESKTOP pre-flight gate for the Harper mobile spike v0.0.3 (NO-ENGINE isolation build).
 *
 * v0.0.3 ships a harper-free plugin bundle (no WASM) to isolate the single variable "engine residency"
 * as the suspected cause of the mobile-editor death (a shared-renderer OOM kill — see
 * docs/research/mobile-plugin-runtime.md, Addendum v0.0.3). This desktop gate runs the SAME no-engine
 * plugin the user will sideload on Android, inside a real desktop Joplin (Electron), and proves before
 * anyone touches a phone:
 *   - the plugin background runs (S5 host is alive),
 *   - the no-engine probe reaches 'NOENGINE READY' (S0 env only; there is deliberately NO WASM stage
 *     and NO 'SPIKE COMPLETE' — this build measures editor survival, not engine behaviour),
 *   - the MAIN-side heartbeat ticks (the plugin background WebView stays alive),
 *   - S5: the content script's STAGED activation (S5a require -> S5b no-op ext -> S5c linter(zero) ->
 *     S5d linter emits spiketest+markClass -> S5e CSS -> S5f tap card) all report OK on desktop, the
 *     spiketest underline paints, the tap card opens/closes, and the editor-side heartbeat posts at
 *     least two ticks. Any device failure is therefore device-specific, and the note's last S5x /
 *     heartbeat line will finger the moment the mobile editor dies.
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

test.describe('Harper mobile spike v0.0.3 (no-engine) — desktop pre-flight', () => {
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

  test('no-engine probe reaches NOENGINE READY (no WASM stages) and the main heartbeat ticks', async () => {
    const { win } = joplin;

    // Poll the results note until the no-engine probe signals readiness. The body is written
    // incrementally by the plugin, and each read re-selects the note to force a fresh DB load.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return body.includes('NOENGINE READY');
        },
        { timeout: 120_000, intervals: [2000] },
      )
      .toBe(true);

    // Wait for the MAIN-side heartbeat to tick at least twice (every 10 s), proving the plugin
    // background WebView stays alive with no engine resident.
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return (body.match(/MAIN HEARTBEAT t=\d+s mem=/g) || []).length;
        },
        { timeout: 60_000, intervals: [3000] },
      )
      .toBeGreaterThanOrEqual(2);

    // Capture the full results-note body as evidence (this is what the report quotes verbatim).
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.3 RESULTS NOTE (desktop, after NOENGINE READY) ==========\n${body}\n` +
        `======================================================================================\n`,
    );

    // Hard assertions: no-engine build, correct header, no WASM/engine stages, no SPIKE COMPLETE.
    expect(body).toMatch(/===== SPIKE RUN v0\.0\.3 \(NO ENGINE\) /); // header carries the no-engine version
    expect(body).toContain('S0 ENV');
    expect(body).toContain('NOENGINE READY');
    expect(body).not.toContain('SPIKE COMPLETE');
    expect(body, 'no engine WASM stages must run in the no-engine build').not.toMatch(/\bS1 OK\b/);
    expect(body).not.toMatch(/\bS2 OK\b/);
    expect(body).not.toMatch(/\bS3 OK\b/);
    const mainBeats = (body.match(/MAIN HEARTBEAT t=\d+s mem=/g) || []).length;
    // eslint-disable-next-line no-console
    console.log(`[spike-e2e] MAIN HEARTBEAT count = ${mainBeats}`);
    expect(mainBeats).toBeGreaterThanOrEqual(2);
  });

  test('S5 staged: all stages report OK, the underline paints, the tap card opens/closes, and the editor heartbeat ticks', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Spike Editor NB');
    await createNote(win, 'Spike editor probe ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Opening this editor starts the content script's staged timeline (S5a immediately, then S5b..S5f
    // ~2 s apart -> S5f arms at ~10 s) plus the editor-side heartbeat (every 5 s). Seed the trigger word.
    await setEditorBody(win, 'A line with spiketest in it, and another spiketest too.');

    // Give the timeline time to pass S5d (linter emits, ~6 s), S5e (CSS) and S5f (card, ~10 s), then
    // nudge a fresh doc change so the linter (now in emit mode) definitely re-runs and paints marks.
    await win.waitForTimeout(14_000);
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

    // Now assert the STAGED evidence landed in the results note: every stage reported OK on desktop, and
    // the editor-side heartbeat ticked at least twice (so on-device a gap/last-tick pins the death time).
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          const beats = (body.match(/S5 HEARTBEAT\[\w+\] t=\d+s/g) || []).length;
          return (
            /S5a\[\w+\] require @codemirror\/lint ok/.test(body) &&
            /S5b\[\w+\] OK/.test(body) &&
            /S5c\[\w+\] OK/.test(body) &&
            /S5d\[\w+\] OK/.test(body) &&
            /S5e\[\w+\] OK/.test(body) &&
            /S5f\[\w+\] OK/.test(body) &&
            beats >= 2
          );
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toBe(true);

    // Emit only the S5-related lines verbatim for the report.
    const s5Lines = body
      .split('\n')
      .filter((l) => /\bS5[a-f]?\b/.test(l) || l.includes('HEARTBEAT') || l.includes('EDITOR ERROR'))
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.3 RESULTS NOTE — S5 STAGED + HEARTBEAT LINES (desktop) ==========\n${s5Lines}\n` +
        `=============================================================================================\n`,
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
    const editorBeats = (body.match(/S5 HEARTBEAT\[\w+\] t=\d+s/g) || []).length;
    // eslint-disable-next-line no-console
    console.log(`[spike-e2e] editor S5 HEARTBEAT count = ${editorBeats}`);
    expect(editorBeats, 'at least 2 editor heartbeats').toBeGreaterThanOrEqual(2);
    // No stage crashed the desktop editor.
    expect(body, 'no EDITOR ERROR on desktop').not.toContain('EDITOR ERROR');
  });
});
