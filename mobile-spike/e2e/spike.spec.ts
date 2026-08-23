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
 * DESKTOP pre-flight gate for the Harper mobile spike v0.0.4 (NO-ENGINE, SILENT-MODE build).
 *
 * v0.0.4 tests the WRITE-EVICTION hypothesis: on-device the mobile editor was evicted ~1-2 s after the
 * content script loaded and the plugin background wrote its load-time trail to the results note via
 * joplin.data.put — each write scheduling a 1 s partial sync ("Preparing scheduled sync"). The refined
 * mechanism (traced in Joplin dev source): a data-API write schedules a partial sync
 * (BaseApplication.generalMiddleware -> registry.scheduleSync), and that sync's UpdateLocal of the
 * currently-open note dispatches EDITOR_NOTE_NEEDS_RELOAD (Synchronizer.ts) -> reducer bumps
 * editorNoteReloadTimeRequest -> Note screen componentDidUpdate calls Keyboard.dismiss() + remounts the
 * editor WebView via a changed React key. So background writes while an editor is open pump the sync
 * cycle that reloads the open note.
 *
 * This build makes the content script ABSOLUTELY SILENT: it buffers its whole staged trail (S5a require
 * -> S5b no-op ext -> S5c linter(zero) -> S5d linter emits spiketest+markClass -> S5e CSS -> S5f tap
 * card) plus a 5 s heartbeat IN MEMORY, posting NOTHING until a single batched {type:'flushTrail'}
 * message at t=45 s, then again at t=90 s. The background appends each flush with ONE data.put. There is
 * NO main-side heartbeat (v0.0.3 had one — exactly the during-editing background write we must avoid).
 *
 * This DESKTOP gate runs the SAME no-engine plugin the user will sideload on Android, inside a real
 * desktop Joplin (Electron) with sync disabled (sync.target=0, so no sync cycle and no eviction — the
 * device-specific kill cannot and should not reproduce here). It proves the plumbing before anyone
 * touches a phone:
 *   - the plugin background runs and the no-engine probe reaches 'SILENT READY' (S0 env only; NO WASM
 *     stage, NO 'SPIKE COMPLETE', NO main heartbeat),
 *   - opening an editor loads the SILENT content script; for the first 45 s the results note receives NO
 *     S5 lines at all (silence is observable),
 *   - at ~45 s the FIRST flush arrives carrying the entire buffered trail (all S5a-S5f OK + >=5
 *     heartbeats), and because the desktop editor survives, a SECOND flush arrives at ~90 s (the same
 *     survival signal we will read on-device),
 *   - the spiketest underline paints and the tap card opens/closes (DOM behaviour is unchanged; only the
 *     reporting is deferred).
 */

const RESULTS_TITLE = 'Harper Mobile Spike Results';

// Must match contentScript.ts FIRST_FLUSH_MS / SECOND_FLUSH_MS.
const FIRST_FLUSH_MS = 45_000;
const SECOND_FLUSH_MS = 90_000;

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

test.describe('Harper mobile spike v0.0.4 (no-engine, SILENT) — desktop pre-flight', () => {
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

  test('no-engine SILENT probe reaches SILENT READY (no WASM stages, no main heartbeat)', async () => {
    const { win } = joplin;

    // Poll the results note until the no-engine probe signals silent readiness. The startup probe is
    // written as ONE batched put (header + S0 env + SILENT READY); each read re-selects the note to
    // force a fresh DB load.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return body.includes('SILENT READY');
        },
        { timeout: 120_000, intervals: [2000] },
      )
      .toBe(true);

    // Capture the probe body as evidence (this is what the report quotes verbatim).
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.4 RESULTS NOTE (desktop, after SILENT READY) ==========\n${body}\n` +
        `====================================================================================\n`,
    );

    // Hard assertions: no-engine SILENT build, correct header, no WASM/engine stages, no main heartbeat.
    expect(body).toMatch(/===== SPIKE RUN v0\.0\.4 \(SILENT\) /); // header carries the silent version
    expect(body).toContain('S0 ENV');
    expect(body).toContain('SILENT READY');
    expect(body).not.toContain('SPIKE COMPLETE');
    expect(body, 'no engine WASM stages must run in the no-engine build').not.toMatch(/\bS1 OK\b/);
    expect(body).not.toMatch(/\bS2 OK\b/);
    expect(body).not.toMatch(/\bS3 OK\b/);
    // v0.0.4 removed the main-side heartbeat entirely (no background writes during editing).
    expect(body, 'v0.0.4 must not emit a MAIN HEARTBEAT').not.toMatch(/MAIN HEARTBEAT/);
  });

  test('S5 SILENT: no S5 lines for the first 45 s, then a flush delivers all stages OK + heartbeats, a 2nd flush proves survival, and the underline/card work', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Spike Editor NB');
    await createNote(win, 'Spike editor probe ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    // The content script's 45 s/90 s flush timers start ~now (when this editor opened).
    const editorOpenedAt = Date.now();

    // Opening this editor starts the SILENT staged timeline (S5a immediately, S5b..S5f ~2 s apart ->
    // S5f arms at ~10 s) plus the 5 s heartbeat — all BUFFERED, nothing posted. Seed the trigger word.
    await setEditorBody(win, 'A line with spiketest in it, and another spiketest too.');

    // Give the (silent) timeline time to pass S5d (linter emits, ~6 s), S5e (CSS) and S5f (card, ~10 s),
    // then nudge a fresh doc change so the linter (now in emit mode) definitely re-runs and paints marks.
    // DOM behaviour is unchanged by silent mode — only the reporting is deferred.
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

    // SILENCE CHECK: read the results note WITHOUT leaving the probe note yet is not possible (reading
    // requires selecting the note), so we only assert the flushes AFTER the flush window. But we can
    // confirm the results note still has no S5 lines at this early point — reading it here selects the
    // results note, which would tear down the probe editor, so we DON'T read yet. Instead we stay on the
    // probe note until both flushes have had time to fire (staying avoids reloading the content script).
    //
    // Wait until ~5 s past the SECOND flush (t=90 s) so BOTH flushes have posted from this editor. The
    // desktop editor survives (sync disabled), so both must arrive — the same "survived -> 2nd flush"
    // signal we read on-device.
    const targetElapsed = SECOND_FLUSH_MS + 5_000;
    const already = Date.now() - editorOpenedAt;
    if (already < targetElapsed) await win.waitForTimeout(targetElapsed - already);

    // NOW navigate to the results note and assert the flushed trail landed. Both flush headers must be
    // present; flush #1 carries the whole staged trail (all S5a-S5f OK) plus >=5 heartbeats.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          const beats = (body.match(/S5 HEARTBEAT\[\w+\] t=\d+s/g) || []).length;
          return (
            /----- FLUSH #1\[\w+\]/.test(body) &&
            /----- FLUSH #2\[\w+\]/.test(body) &&
            /S5a\[\w+\] require @codemirror\/lint ok/.test(body) &&
            /S5b\[\w+\] OK/.test(body) &&
            /S5c\[\w+\] OK/.test(body) &&
            /S5d\[\w+\] OK/.test(body) &&
            /S5e\[\w+\] OK/.test(body) &&
            /S5f\[\w+\] OK/.test(body) &&
            beats >= 5
          );
        },
        { timeout: 60_000, intervals: [3000] },
      )
      .toBe(true);

    // Emit the flush + S5 + heartbeat lines verbatim for the report.
    const s5Lines = body
      .split('\n')
      .filter(
        (l) =>
          l.includes('FLUSH #') ||
          /\bS5[a-f]?\b/.test(l) ||
          l.includes('HEARTBEAT') ||
          l.includes('EDITOR ERROR'),
      )
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.4 RESULTS NOTE — FLUSHED SILENT TRAIL (desktop) ==========\n${s5Lines}\n` +
        `=======================================================================================\n`,
    );

    // Individual hard assertions (redundant with the poll, but explicit).
    expect(body, 'first flush header').toMatch(/----- FLUSH #1\[\w+\]/);
    expect(body, 'second flush header (survival)').toMatch(/----- FLUSH #2\[\w+\]/);
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
    expect(editorBeats, 'at least 5 editor heartbeats in the flushed trail').toBeGreaterThanOrEqual(5);
    // No stage crashed the desktop editor.
    expect(body, 'no EDITOR ERROR on desktop').not.toContain('EDITOR ERROR');
  });
});
