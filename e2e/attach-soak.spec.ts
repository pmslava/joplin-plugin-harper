import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import { createNotebook, createNote, editorIsPresent, setEditorBody, lintRangeCount } from './helpers';

/**
 * ATTACH SOAK (investigation harness, not a product spec).
 *
 * Launches Joplin `HARPER_SOAK_CYCLES` times (default 15) and, on each launch, types text with known
 * errors and waits for a lint underline. Every `[harper-trace]` console line from EVERY page (the
 * main renderer, where the content script runs, and the plugin's own webview) is captured per cycle,
 * so a launch where the content script never attaches leaves a trace of exactly how far it got.
 *
 * Results are appended to $HARPER_SOAK_LOG (default e2e/.soak/soak.log).
 */

const CYCLES = Number(process.env.HARPER_SOAK_CYCLES ?? 15);
/**
 * 'fresh'   — a new profile per cycle: the editor mounts several seconds AFTER the plugin started.
 * 'restart' — one profile, relaunched every cycle with a note already open, so Joplin restores that
 *             note and the CodeMirror editor mounts DURING plugin startup. This is what a real user's
 *             every launch looks like, and it is the shape that races.
 */
const MODE = process.env.HARPER_SOAK_MODE ?? 'fresh';
const LOG_PATH =
  process.env.HARPER_SOAK_LOG ?? path.join(__dirname, '.soak', `soak-${Date.now()}.log`);
const LINT_TIMEOUT_MS = Number(process.env.HARPER_SOAK_LINT_TIMEOUT_MS ?? 45_000);

function append(line: string): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Subscribe to console output of every page in the browser, now and as new ones appear. */
function captureTraces(instance: JoplinInstance, sink: string[]): void {
  const browser = instance.win.context().browser()!;
  const wire = (page: import('@playwright/test').Page): void => {
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[harper')) sink.push(`${Date.now()} ${shortUrl(page.url())} ${text}`);
    });
    page.on('pageerror', (err) => sink.push(`${Date.now()} ${shortUrl(page.url())} PAGEERROR ${err.message}`));
  };
  const shortUrl = (url: string): string =>
    url.includes('pluginId=') ? 'plugin-webview' : url.includes('index.html') ? 'renderer' : url.slice(0, 40);
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) wire(p);
    ctx.on('page', wire);
  }
}

/**
 * Read the DURABLE trace buffers off the pages themselves.
 *
 * The console listener can only be attached once Joplin is already up, which in restart mode is
 * strictly too late — the content script activates DURING startup. Both sides therefore also push
 * their trace lines into a window-level array, and this reads those arrays back.
 */
async function readDurableTraces(instance: JoplinInstance): Promise<string[]> {
  const out: string[] = [];
  const browser = instance.win.context().browser()!;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.isClosed()) continue;
      const lines = await p
        .evaluate(() => {
          const w = window as unknown as { __harperTrace?: string[]; __harperTraceMain?: string[] };
          return [...(w.__harperTrace ?? []), ...(w.__harperTraceMain ?? [])];
        })
        .catch(() => [] as string[]);
      out.push(...lines);
    }
  }
  return out.sort();
}

test.describe('attach soak', () => {
  test('content script attaches on every launch', async () => {
    test.setTimeout(0);
    append(
      `=== soak start ${new Date().toISOString()} mode=${MODE} cycles=${CYCLES} DISPLAY=${process.env.DISPLAY}`,
    );

    // restart mode: one profile, seeded once with a note that already contains errors, so every
    // subsequent launch restores that note and mounts the editor during plugin startup.
    let sharedProfile: string | undefined;
    if (MODE === 'restart') {
      sharedProfile = createProfile(true);
      const seed = await launchJoplin({ profileDir: sharedProfile });
      await createNotebook(seed.win, 'Soak NB');
      await createNote(seed.win, `Soak seed ${Date.now()}`);
      await expect.poll(() => editorIsPresent(seed.win), { timeout: 20_000 }).toBe(true);
      await setEditorBody(
        seed.win,
        'This is an test of the plugin. I beleive teh feature works, and we should of shipped it definately.',
      );
      await expect.poll(() => lintRangeCount(seed.win), { timeout: 60_000 }).toBeGreaterThan(0);
      await closeJoplin(seed, { keepProfile: true });
      append(`--- seeded profile ${sharedProfile}`);
    }

    const failures: number[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const traces: string[] = [];
      let joplin: JoplinInstance | undefined;
      let ok = false;
      let detail = '';
      const startedAt = Date.now();
      try {
        joplin = await launchJoplin(sharedProfile ? { profileDir: sharedProfile } : {});
        captureTraces(joplin, traces);
        const { win } = joplin;
        if (MODE === 'fresh') {
          await createNotebook(win, 'Soak NB');
          await createNote(win, `Soak ${cycle} ${Date.now()}`);
        }
        await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
        await setEditorBody(
          win,
          'This is an test of the plugin. I beleive teh feature works, and we should of shipped it definately.',
        );
        const deadline = Date.now() + LINT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if ((await lintRangeCount(win)) > 0) {
            ok = true;
            break;
          }
          await win.waitForTimeout(1000);
        }
        if (!ok) detail = `no lint decorations within ${LINT_TIMEOUT_MS} ms`;
      } catch (error) {
        detail = `EXCEPTION ${(error as Error).message}`;
      } finally {
        if (joplin) {
          traces.push(...(await readDurableTraces(joplin).catch(() => [])));
          await closeJoplin(joplin, { keepProfile: !!sharedProfile }).catch(() => undefined);
        }
      }
      const secs = Math.round((Date.now() - startedAt) / 1000);
      append(`--- cycle ${cycle}/${CYCLES}: ${ok ? 'ATTACHED' : 'DEAD'} (${secs}s) ${detail}`);
      if (!ok) {
        failures.push(cycle);
        append(`    trace (${traces.length} lines):`);
        for (const line of traces) append(`    ${line}`);
      } else {
        // Keep the happy-path trace short but present, for timing comparison.
        for (const line of traces.filter((l) => !l.includes('lint <-') && !l.includes('lint ->'))) {
          append(`    ${line}`);
        }
      }
    }

    append(`=== soak done: ${CYCLES - failures.length}/${CYCLES} attached; dead cycles: ${failures.join(', ') || 'none'}`);
    expect(failures, `dead sessions in cycles ${failures.join(', ')}`).toEqual([]);
  });
});
