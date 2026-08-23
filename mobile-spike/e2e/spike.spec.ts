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
 * DESKTOP pre-flight gate for the Harper mobile spike v0.0.5 (NO-ENGINE, SETTINGS-PROBE build).
 *
 * ESTABLISHED LAW (on device): a plugin BACKGROUND joplin.data.put note-write while the mobile editor is
 * open evicts the editor within seconds, via a LOCAL (sync-independent) mechanism. The whole editor stack
 * (require -> ext -> linter -> markClass -> CSS -> tap card) is proven safe during silent operation.
 *
 * OPEN QUESTION v0.0.5 ANSWERS: is joplin.settings.setValue during mobile editing ALSO lethal, or safe?
 * The content script buffers its whole staged trail (S5a..S5f + 5 s heartbeat) silently, then:
 *   FLUSH #1 (t=45 s)  {type:'flushToSettings'} -> background stores via joplin.settings.setValue only
 *   FLUSH #2 (t=90 s)  {type:'flushToSettings'} -> background appends to the same setting
 *   FLUSH #3 (t=135 s) {type:'flushToNote'}     -> background does the ONE data.put of the whole settings
 *                                                  buffer + the tail carried in flush #3, under a
 *                                                  '----- NOTE FLUSH -----' label, then clears the buffer.
 * On device: editor alive past t=90 s then evicted at ~t=135 s => settings.setValue SAFE + note-write law
 * reconfirmed; editor dead at ~t=45 s => settings.setValue ALSO lethal.
 *
 * This DESKTOP gate runs the SAME no-engine plugin inside a real desktop Joplin (Electron) with sync
 * disabled (sync.target=0) — so the device-specific eviction cannot and should not reproduce here (the
 * desktop editor survives every write). It proves the PLUMBING before anyone touches a phone:
 *   - the background reaches 'SETTINGS PROBE READY' (S0 env only; NO WASM stage, NO 'SPIKE COMPLETE',
 *     NO main heartbeat),
 *   - during a >=140 s editor session NOTHING is written to the results note until ~t=135 s (flush #1/#2
 *     go to a settings value, not the note): proven by the NOTE FLUSH block's received-timestamp landing
 *     >=130 s after the editor opened, and by the absence of any earlier block,
 *   - at ~t=135 s the single NOTE FLUSH delivers the whole trail: both SETTINGS FLUSH sub-headers, all
 *     S5a-S5f OK, and heartbeats spanning well past 90 s (from the flush #3 tail),
 *   - the spiketest underline paints and the tap card opens/closes (DOM behaviour unchanged).
 */

const RESULTS_TITLE = 'Harper Mobile Spike Results';

// Must match contentScript.ts FIRST_FLUSH_MS / SECOND_FLUSH_MS / THIRD_FLUSH_MS.
const FIRST_FLUSH_MS = 45_000;
const SECOND_FLUSH_MS = 90_000;
const THIRD_FLUSH_MS = 135_000;

/** Re-select the Spike folder then the results note (forces a fresh DB read of its body). */
async function selectResultsNote(win: Page): Promise<boolean> {
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
  return editorIsPresent(win);
}

/** The SHORT read: innerText of the visible CM6 viewport. Fine only for a small (fully-rendered) note. */
async function readResultsNoteBody(win: Page): Promise<string> {
  if (!(await selectResultsNote(win))) return '';
  return getEditorBody(win);
}

/**
 * The FULL read. CodeMirror 6 VIRTUALIZES long documents — only lines near the viewport live in the DOM,
 * so `.cm-content` innerText returns just the visible slice. Once the results note grows past ~one screen
 * (it does after a NOTE FLUSH), a single innerText read never sees the lines lower down. So we select the
 * note, then step `.cm-scroller` from top to bottom, unioning the innerText rendered at each window into a
 * document-ordered, de-duplicated whole. Returns the complete note body regardless of length.
 */
async function readResultsNoteBodyFull(win: Page): Promise<string> {
  if (!(await selectResultsNote(win))) return '';
  return win.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const content = document.querySelector('.cm-content') as HTMLElement | null;
    const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
    if (!content) return '';
    // Small note fully rendered, or no scroller: one read suffices.
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 2) return content.innerText;

    const seen = new Set<string>();
    const out: string[] = [];
    const collect = () => {
      for (const line of content.innerText.split('\n')) {
        if (!seen.has(line)) {
          seen.add(line);
          out.push(line);
        }
      }
    };
    const step = Math.max(120, Math.floor(scroller.clientHeight * 0.6));
    scroller.scrollTop = 0;
    await sleep(150);
    collect();
    // Step down with overlap so CM6's render margin never leaves a gap, collecting each new window.
    while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) {
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
      if (scroller.scrollTop === before) break; // no progress guard
      await sleep(150);
      collect();
    }
    scroller.scrollTop = scroller.scrollHeight; // final bottom window
    await sleep(150);
    collect();
    return out.join('\n');
  });
}

test.describe('Harper mobile spike v0.0.5 (no-engine, SETTINGS PROBE) — desktop pre-flight', () => {
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

  test('no-engine SETTINGS PROBE reaches SETTINGS PROBE READY (no WASM stages, no main heartbeat)', async () => {
    const { win } = joplin;

    // Poll the results note until the no-engine probe signals settings-probe readiness. The startup probe
    // is written as ONE batched put (header + S0 env + SETTINGS PROBE READY); each read re-selects the
    // note to force a fresh DB load.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBody(win);
          return body.includes('SETTINGS PROBE READY');
        },
        { timeout: 120_000, intervals: [2000] },
      )
      .toBe(true);

    // Capture the probe body as evidence (this is what the report quotes verbatim).
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.5 RESULTS NOTE (desktop, after SETTINGS PROBE READY) ==========\n${body}\n` +
        `============================================================================================\n`,
    );

    // Hard assertions: no-engine SETTINGS-PROBE build, correct header, no WASM/engine stages, no heartbeat.
    expect(body).toMatch(/===== SPIKE RUN v0\.0\.5 \(SETTINGS PROBE\) /); // header carries the version + mode
    expect(body).toContain('S0 ENV');
    expect(body).toContain('SETTINGS PROBE READY');
    expect(body).not.toContain('SPIKE COMPLETE');
    expect(body, 'no engine WASM stages must run in the no-engine build').not.toMatch(/\bS1 OK\b/);
    expect(body).not.toMatch(/\bS2 OK\b/);
    expect(body).not.toMatch(/\bS3 OK\b/);
    expect(body, 'v0.0.5 must not emit a MAIN HEARTBEAT').not.toMatch(/MAIN HEARTBEAT/);
    // Fresh profile: nothing was stranded, so no recovery block at startup.
    expect(body, 'fresh profile has nothing to recover at startup').not.toContain('STARTUP RECOVERY');
    // Silence so far: opening an editor has not yet happened, so no flush of any kind has landed.
    expect(body, 'no NOTE FLUSH before any editor session').not.toContain('NOTE FLUSH');
    expect(body, 'no SETTINGS FLUSH ever reaches the note directly').not.toContain('SETTINGS FLUSH');
  });

  test('S5 SETTINGS PROBE: two settings writes (t=45/90 s) touch the NOTE not at all; only the t=135 s NOTE FLUSH delivers the whole trail (all stages OK + heartbeats past 90 s); underline/card work', async () => {
    const { win } = joplin;

    await createNotebook(win, 'Spike Editor NB');
    await createNote(win, 'Spike editor probe ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    // The content script's 45 s / 90 s / 135 s flush timers start ~now (when this editor opened). Timers
    // never fire EARLY, so the note write can only happen at editorOpenedAt + (load delay) + 135 s.
    const editorOpenedAt = Date.now();

    // Opening this editor starts the SILENT staged timeline (S5a immediately, S5b..S5f ~2 s apart -> S5f
    // arms at ~10 s) plus the 5 s heartbeat — all BUFFERED, nothing posted. Seed the trigger word.
    await setEditorBody(win, 'A line with spiketest in it, and another spiketest too.');

    // Give the (silent) timeline time to pass S5d (linter emits, ~6 s), S5e (CSS) and S5f (card, ~10 s),
    // then nudge a fresh doc change so the linter (now in emit mode) re-runs and paints marks. DOM
    // behaviour is unchanged by the settings-probe protocol — only the reporting path is deferred.
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

    // We must NOT read the results note mid-session — selecting it would tear down the probe editor and
    // restart the content-script timers on a new load. So we stay on the probe note until ~5 s past the
    // THIRD flush (the note write) at t=135 s, letting flush #1/#2 (settings) and flush #3 (note) all fire
    // from THIS editor. On desktop (sync disabled) the editor survives every write, so flush #3's note
    // write actually lands and we can read it afterwards.
    const targetElapsed = THIRD_FLUSH_MS + 5_000; // 140 s
    const already = Date.now() - editorOpenedAt;
    if (already < targetElapsed) await win.waitForTimeout(targetElapsed - already);

    // NOW navigate to the results note and assert the single NOTE FLUSH landed with the whole trail.
    let body = '';
    await expect
      .poll(
        async () => {
          body = await readResultsNoteBodyFull(win);
          const beats = (body.match(/S5 HEARTBEAT\[\w+\] t=\d+s/g) || []).length;
          return (
            /----- NOTE FLUSH \(expected to evict if editor still open\) #3\[\w+\]/.test(body) &&
            /----- SETTINGS FLUSH #1\[\w+\]/.test(body) &&
            /----- SETTINGS FLUSH #2\[\w+\]/.test(body) &&
            /S5a\[\w+\] require @codemirror\/lint ok/.test(body) &&
            /S5b\[\w+\] OK/.test(body) &&
            /S5c\[\w+\] OK/.test(body) &&
            /S5d\[\w+\] OK/.test(body) &&
            /S5e\[\w+\] OK/.test(body) &&
            /S5f\[\w+\] OK/.test(body) &&
            beats >= 18
          );
        },
        { timeout: 60_000, intervals: [3000] },
      )
      .toBe(true);

    // Emit the settings-flush + NOTE FLUSH + S5 + heartbeat lines verbatim for the report.
    const s5Lines = body
      .split('\n')
      .filter(
        (l) =>
          l.includes('SETTINGS FLUSH') ||
          l.includes('NOTE FLUSH') ||
          l.includes('STARTUP RECOVERY') ||
          l.includes('(tail:') ||
          /\bS5[a-f]?\b/.test(l) ||
          l.includes('HEARTBEAT') ||
          l.includes('EDITOR ERROR'),
      )
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(
      `\n========== HARPER SPIKE v0.0.5 RESULTS NOTE — NOTE-FLUSH TRAIL (desktop) ==========\n${s5Lines}\n` +
        `===================================================================================\n`,
    );

    // --- SILENCE: nothing reached the note before ~t=135 s --------------------------------------------
    // The NOTE FLUSH block is the ONLY thing written to the note during the session. The cleanest,
    // skew-independent proof that flush #1/#2 (settings writes) NEVER touched the note is to compare, for
    // ONE content-script instance, its NOTE FLUSH received time against its OWN SETTINGS FLUSH #2 stored
    // time: both are plugin-side timestamps of setTimeout(...) from the SAME load, so the gap must be
    // ~45 s (135 s note flush minus 90 s settings flush #2). If either settings write had reached the note,
    // the note's first write would be at ~t=45 s, not ~45 s AFTER the t=90 s settings write.
    const noteFlushMatch = body.match(
      /----- NOTE FLUSH \(expected to evict if editor still open\) #3\[(\w+)\] (\S+) /,
    );
    expect(noteFlushMatch, 'NOTE FLUSH header with an id + received timestamp').not.toBeNull();
    const nf = noteFlushMatch as RegExpMatchArray;
    const nfId = nf[1];
    const nfReceivedMs = Date.parse(nf[2]);
    const sf2Match = body.match(new RegExp(`----- SETTINGS FLUSH #2\\[${nfId}\\] stored (\\S+) `));
    expect(sf2Match, `same-instance (${nfId}) SETTINGS FLUSH #2 present`).not.toBeNull();
    const sf2StoredMs = Date.parse((sf2Match as RegExpMatchArray)[1]);
    const noteMinusSettings2 = nfReceivedMs - sf2StoredMs;
    // Corroborating (skew-affected, logged not gated): how long after the editor opened the note write hit.
    const sinceOpen = nfReceivedMs - editorOpenedAt;
    // eslint-disable-next-line no-console
    console.log(
      `[spike-e2e] instance ${nfId}: NOTE FLUSH landed ${Math.round(noteMinusSettings2 / 1000)}s after its ` +
        `own SETTINGS FLUSH #2, and ${Math.round(sinceOpen / 1000)}s after the editor opened`,
    );
    expect(
      noteMinusSettings2,
      'the note write is the t=135 s flush, ~45 s after the t=90 s settings write => settings writes never touched the note',
    ).toBeGreaterThanOrEqual(40_000);
    // The note write is unambiguously LATE (well past the t=90 s second settings write), even allowing for
    // the several-second skew between content-script load and editorOpenedAt.
    expect(sinceOpen, 'the only note write landed well past t=90 s').toBeGreaterThanOrEqual(110_000);

    // Fresh profile + surviving editor: flush #3 fired live, so exactly a NOTE FLUSH (no STARTUP RECOVERY).
    expect(body, 'flush #3 fired live; no recovery path was needed').not.toContain('STARTUP RECOVERY');

    // Individual hard assertions (redundant with the poll, but explicit).
    expect(body, 'NOTE FLUSH #3 label').toMatch(
      /----- NOTE FLUSH \(expected to evict if editor still open\) #3\[\w+\]/,
    );
    expect(body, 'SETTINGS FLUSH #1 sub-header (settings write #1)').toMatch(/----- SETTINGS FLUSH #1\[\w+\]/);
    expect(body, 'SETTINGS FLUSH #2 sub-header (settings write #2)').toMatch(/----- SETTINGS FLUSH #2\[\w+\]/);
    expect(body, 'S5a view').toMatch(/S5a\[\w+\] require @codemirror\/view ok/);
    expect(body, 'S5a lint').toMatch(/S5a\[\w+\] require @codemirror\/lint ok/);
    expect(body, 'S5a state').toMatch(/S5a\[\w+\] require @codemirror\/state ok/);
    expect(body, 'S5b').toMatch(/S5b\[\w+\] OK/);
    expect(body, 'S5c').toMatch(/S5c\[\w+\] OK/);
    expect(body, 'S5d').toMatch(/S5d\[\w+\] OK/);
    expect(body, 'S5e').toMatch(/S5e\[\w+\] OK/);
    expect(body, 'S5f').toMatch(/S5f\[\w+\] OK/);

    // Heartbeats must span WELL PAST 90 s (delivered via flush #3's tail), proving the editor survived
    // both settings writes on desktop and kept beating up to the note write.
    const beatTs = (body.match(/S5 HEARTBEAT\[\w+\] t=(\d+)s/g) || []).map((l) =>
      parseInt((l.match(/t=(\d+)s/) as RegExpMatchArray)[1], 10),
    );
    const maxBeat = beatTs.length ? Math.max(...beatTs) : 0;
    // eslint-disable-next-line no-console
    console.log(`[spike-e2e] editor S5 HEARTBEAT count = ${beatTs.length}, max t = ${maxBeat}s`);
    expect(beatTs.length, 'at least 18 editor heartbeats in the delivered trail').toBeGreaterThanOrEqual(18);
    expect(maxBeat, 'heartbeats span past 90 s (flush #3 tail delivered 90-135 s)').toBeGreaterThanOrEqual(95);

    // No stage crashed the desktop editor.
    expect(body, 'no EDITOR ERROR on desktop').not.toContain('EDITOR ERROR');
  });
});
