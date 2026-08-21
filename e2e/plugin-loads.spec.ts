import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, PLUGIN_ID } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCount,
  lintRangeHtml,
  pluginBackgroundPageRunning,
} from './helpers';

/**
 * Walking-skeleton proof of life for Harper in a real Joplin desktop instance:
 *  - the plugin background page is running (proves the plugin main process + harper.js loaded),
 *  - text with known grammar/spelling errors typed into the CM6 editor produces at least one lint
 *    decoration (`.cm-lintRange`) in the editor DOM — i.e. the whole thread works end to end:
 *    content script -> postMessage -> harper.js lint in the plugin process -> diagnostics -> paint.
 */
test.describe('Harper plugin loads and lints', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('plugin background page is running (CDP)', async () => {
    await expect
      .poll(() => pluginBackgroundPageRunning(joplin.win), { timeout: 30_000 })
      .toBe(true);
  });

  test('typing text with errors paints lint decorations in the editor', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Harper NB');
    await createNote(win, 'Harper proof of life ' + Date.now());

    // The CM6 markdown editor must be present (not the rich-text editor).
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // Known errors: "an test" (article), "beleive"/"teh"/"definately" (spelling), "should of".
    await setEditorBody(
      win,
      'This is an test of the plugin. I beleive teh feature works, and we should of shipped it definately.',
    );

    // Debounced lint (500 ms) + IPC round-trip + WASM lint; allow generous time on a cold binary.
    await expect.poll(() => lintRangeCount(win), { timeout: 60_000 }).toBeGreaterThan(0);

    const count = await lintRangeCount(win);
    const html = await lintRangeHtml(win);
    // Evidence in the test log: the actual decoration elements Harper produced.
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] lint decoration count = ${count}`);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] lint decorations:\n${html.join('\n')}`);

    expect(count).toBeGreaterThan(0);
    // Sanity: the plugin id is the one this fork ships under.
    expect(PLUGIN_ID).toBe('io.github.pmslava.harper');
  });
});
