import { test, expect, Page } from '@playwright/test';
import {
  launchJoplin,
  closeJoplin,
  findSecondaryWindow,
  JoplinInstance,
} from './launch';
import {
  clickAddToDictionary,
  clickDisableRule,
  createNotebook,
  createNote,
  editorIsPresent,
  lintRangeCountForWord,
  openNoteInNewWindow,
  setEditorBody,
  underlineColorForWord,
} from './helpers';

/**
 * E2E — MULTI-WINDOW STALENESS (the parked-reply refresh subscription, end to end).
 *
 * `editor.execCommand` reaches exactly ONE editor: Joplin registers the command's runtime once per
 * editor with a priority that is 0 whenever that editor's document lacks focus, and CommandService
 * executes the single highest-priority runtime. So before the fix, a plugin-triggered re-lint poke
 * (add-to-dictionary, disable-rule, any settings change) refreshed one window and left every other
 * window's underlines STALE. The fix parks one 'waitForRefresh' long-poll per open desktop editor in
 * the plugin main process and resolves them all on every poke — and THIS spec is the only place that
 * contract crosses the real plugin IPC bridge (the unit harness calls the message handler directly),
 * so it is the release gate for the parked-reply assumption.
 *
 * ACTOR vs WATCHED. Each propagation leg performs the card action in the `actor` window and asserts
 * the `watched` window catches up. For the leg to be meaningful the poke must go to the actor, so the
 * watched window can only be refreshed by the subscription. The dispatch rule (getWindowCommandPriority
 * + CommandService's `>=` max-scan) is: priority 2 = document focused AND activeElement inside the
 * editor, 1 = focused only, 0 = unfocused; ties go to the LAST-registered runtime — the SECONDARY
 * window's editor, mounted after the main window's. Under Xvfb, Electron windows can BOTH report
 * document.hasFocus() === true (measured — there is no WM to withdraw focus), so "the watched window
 * is unfocused" is not an assertable precondition here. What IS guaranteed by construction:
 *   - the actor's card click has just placed activeElement inside the actor's editor, so the actor
 *     holds priority 2 whenever its document has focus;
 *   - the watched window can only STRICTLY outrank the actor when it alone reports focus — and
 *     pickActorWatched flips the roles in exactly that configuration (actor = main only when main is
 *     focused and the secondary is not; otherwise actor = secondary, the tie-break winner).
 * Hence the poke always lands on the actor; each leg asserts the roles are not inverted (the watched
 * window never solely holds focus) and logs both focus states into the trace.
 */

// Harper's canonical Spelling color (per-kind, theme-independent), as pinned by ui-conformance.
const SPELLING_COLOR = '#EE4266';

// Letters-only run tag so every attempt (and every retried worker) uses fresh dictionary words —
// SpellCheck flags any unknown all-letter token, while a digit inside a token can suppress the lint.
const TAG = Date.now()
  .toString(36)
  .replace(/[0-9]/g, (c) => 'qwertyuiop'[Number(c)])
  .slice(-5);
const DICT_WORD = `Zorbly${TAG}`; // leg 2: add-to-dictionary propagation
const REOPEN_WORD = `Vexqit${TAG}`; // leg 4: propagation after close-and-reopen

async function pageHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => document.hasFocus()).catch(() => false);
}

/**
 * Open the Harper card by clicking the lint mark whose text is EXACTLY `word`. The shared
 * openHarperCardByClick filters with `hasText` (SUBSTRING matching), so asking it for the
 * one-letter 'i' mark lands on the first mark merely CONTAINING an i — 'beleive' — and the leg
 * then disables the wrong rule. Same retry shape as the shared helper, exact-match locator.
 */
async function openCardByExactWord(win: Page, word: string) {
  const range = win
    .locator('.cm-lintRange')
    .filter({ hasText: new RegExp(`^${word}$`) })
    .first();
  await range.scrollIntoViewIfNeeded();
  await range.click({ force: true });
  await win.waitForTimeout(400);
  const card = win.locator('.cm-tooltip.harper-click-tooltip .harper-container');
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await card.count()) return card.first();
    await range.click({ force: true });
    await win.waitForTimeout(400);
  }
  throw new Error(`Harper click-to-open card for exact word "${word}" never appeared`);
}

/**
 * The solely-focused window acts, the other is watched; otherwise the SECONDARY acts (it wins every
 * remaining dispatch configuration — see the header). Returns the raw focus flags so a leg can assert
 * the roles were not inverted.
 */
async function pickActorWatched(
  main: Page,
  second: Page,
): Promise<{ actor: Page; watched: Page; actorFocused: boolean; watchedFocused: boolean; label: string }> {
  const mainFocused = await pageHasFocus(main);
  const secondFocused = await pageHasFocus(second);
  const actor = mainFocused && !secondFocused ? main : second;
  const watched = actor === main ? second : main;
  const actorFocused = actor === main ? mainFocused : secondFocused;
  const watchedFocused = watched === main ? mainFocused : secondFocused;
  const label = `focus(main=${mainFocused}, second=${secondFocused}) -> actor=${
    actor === main ? 'main' : 'second'
  }`;
  return { actor, watched, actorFocused, watchedFocused, label };
}

test.describe.serial('Harper multi-window staleness', () => {
  let joplin: JoplinInstance;
  let second: Page;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('setup: the seeded note lints in BOTH windows', async () => {
    const { win, browser } = joplin;

    await createNotebook(win, 'Harper MW NB');
    await createNote(win, 'Harper multiwindow ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);

    // 'beleive' (Spelling) is the untouched control; DICT_WORD (Spelling) feeds the dictionary leg;
    // 'should of' (WordChoice/ModalOf) feeds the disable-rule leg — all probed against the real
    // engine so each leg acts on a distinct rule AND none of the targets hides a masked overlapping
    // finding (harper surfaces overlapping findings one at a time, so e.g. a lowercase sentence-start
    // 'i' stays underlined after CapitalizePersonalPronouns is disabled — SentenceCapitalization
    // surfaces on the same span; 'should of' clears completely when ModalOf is disabled).
    await setEditorBody(win, `I beleive that ${DICT_WORD} is here. We should of gone.`);
    await expect
      .poll(() => lintRangeCountForWord(win, DICT_WORD), { timeout: 60_000 })
      .toBeGreaterThan(0);

    await openNoteInNewWindow(win);
    second = await findSecondaryWindow(browser, 60_000);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] secondary window url = ${second.url()}`);

    await expect
      .poll(() => lintRangeCountForWord(second, DICT_WORD), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => lintRangeCountForWord(second, 'beleive'), { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test('add-to-dictionary in the acting window clears the WATCHED window', async () => {
    const { actor, watched, actorFocused, watchedFocused, label } = await pickActorWatched(
      joplin.win,
      second,
    );
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] dictionary leg: ${label}`);
    // The precondition that makes this leg meaningful: the watched window never SOLELY holds focus
    // (that configuration flips the roles), so the execCommand poke lands on the actor and only the
    // parked-reply subscription can refresh the watched window. Both-focused is normal under Xvfb.
    expect(watchedFocused && !actorFocused).toBe(false);

    const card = await openCardByExactWord(actor, DICT_WORD);
    await expect(card).toBeVisible();
    await clickAddToDictionary(actor, card);

    // THE fix's assertion: the unfocused window's underline for the added word disappears. Without
    // the subscription this stays stale forever (the poke went to the actor).
    await expect
      .poll(() => lintRangeCountForWord(watched, DICT_WORD), { timeout: 30_000 })
      .toBe(0);
    // The actor cleared through its own card-action relint.
    await expect
      .poll(() => lintRangeCountForWord(actor, DICT_WORD), { timeout: 30_000 })
      .toBe(0);
    // And only that word was cleared — the control lint survives in the watched window.
    expect(await lintRangeCountForWord(watched, 'beleive')).toBeGreaterThan(0);
  });

  test('disable-rule (a runtime settings write) repaints the WATCHED window', async () => {
    // Substitutes for a Settings-screen underlineStyle drive (no existing pattern runs the Options
    // UI): disableRule persists {rule:false} via joplin.settings.setValue at RUNTIME, so the poke
    // travels the settings-onChange path — the same one an underlineStyle change takes.
    const { actor, watched, actorFocused, watchedFocused, label } = await pickActorWatched(
      joplin.win,
      second,
    );
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] disable-rule leg: ${label}`);
    expect(watchedFocused && !actorFocused).toBe(false);

    await expect
      .poll(() => lintRangeCountForWord(watched, 'should of'), { timeout: 20_000 })
      .toBeGreaterThan(0);

    const card = await openCardByExactWord(actor, 'should of');
    await expect(card).toBeVisible();
    // Pin the card identity BEFORE acting: the header must be the WordChoice card, and the disable
    // toggle must name the probed rule — otherwise we are about to disable the wrong rule.
    await expect(card.locator('.harper-header .harper-title')).toHaveText('Word Choice');
    expect(await card.locator('.harper-disable-btn').first().getAttribute('title')).toBe(
      'Disable rule ModalOf',
    );
    await clickDisableRule(actor, card);

    // ACTOR first (its own card-action relint — did the disable take effect at all?), then watched
    // (the cross-window propagation this leg exists for).
    await expect.poll(() => lintRangeCountForWord(actor, 'should of'), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => lintRangeCountForWord(watched, 'should of'), { timeout: 30_000 }).toBe(0);
    expect(await lintRangeCountForWord(watched, 'beleive')).toBeGreaterThan(0);
  });

  test('close and reopen the secondary window: fresh document is styled, propagation still works', async () => {
    const { win, browser } = joplin;

    // Seed the reopen leg's word through the MAIN editor and wait for it to reach the still-open
    // secondary editor (the two windows edit the same note), so the pre-close state is settled.
    await setEditorBody(win, `I beleive it. ${REOPEN_WORD} too.`);
    await expect
      .poll(() => lintRangeCountForWord(second, REOPEN_WORD), { timeout: 45_000 })
      .toBeGreaterThan(0);

    // A REAL window close: window.close() is allowed for a script-opened window (Joplin created it
    // with window.open), and drives Joplin's own teardown of the portal. Page.close is the fallback.
    await second.evaluate(() => window.close()).catch(() => {
      /* the navigation destroys the execution context — expected */
    });
    try {
      await expect.poll(() => second.isClosed(), { timeout: 10_000 }).toBe(true);
    } catch {
      await second.close().catch(() => {});
      await expect.poll(() => second.isClosed(), { timeout: 10_000 }).toBe(true);
    }

    // Joplin notices a script-closed secondary window by POLLING `window.closed` every 2s
    // (gui/NewWindowOrIFrame.tsx: "onbeforeunload and onclose events don't seem to fire ... rely on
    // polling") and only then dispatches WINDOW_CLOSE, which retargets activeWindowId back to the
    // main window. A Ctrl+P before that lands makes Joplin open Goto Anything's <dialog> inside the
    // DEAD window's document — showModal throws and the whole app falls to its fatal-error page
    // (observed). Wait the poll interval out, with margin, before driving the main window again.
    await win.waitForTimeout(5_000);

    await openNoteInNewWindow(win);
    second = await findSecondaryWindow(browser, 45_000);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] reopened secondary window url = ${second.url()}`);

    // BEFORE any card is opened: the reopened window is a FRESH document, so this only passes if the
    // plugin re-injected its stylesheet there (per-document injection) and the new editor linted.
    // (Poll budgets in this leg are trimmed a few seconds below the 240s per-test cap in worst-case
    // sum, so a genuine last-poll failure reports its own assertion instead of an opaque timeout.)
    await expect
      .poll(() => underlineColorForWord(second, 'beleive'), { timeout: 25_000 })
      .toBe(SPELLING_COLOR);
    await expect
      .poll(() => lintRangeCountForWord(second, REOPEN_WORD), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // And the refresh machinery survived the close/reopen: one more cross-window propagation. With
    // the reopened window as actor this also proves closing a sibling window did not kill the MAIN
    // window's subscription loop.
    const { actor, watched, actorFocused, watchedFocused, label } = await pickActorWatched(
      win,
      second,
    );
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] reopen leg: ${label}`);
    expect(watchedFocused && !actorFocused).toBe(false);
    // ROLE PIN: this leg's claim ("the MAIN window's loop survived the sibling close") only holds
    // with the REOPENED window acting and the main window watched. Under the both-focused Xvfb
    // regime pickActorWatched always yields actor=second; if the focus regime ever changes, fail
    // loudly here instead of silently proving something else.
    expect(actor).toBe(second);

    const card = await openCardByExactWord(actor, REOPEN_WORD);
    await expect(card).toBeVisible();
    await clickAddToDictionary(actor, card);

    await expect
      .poll(() => lintRangeCountForWord(watched, REOPEN_WORD), { timeout: 30_000 })
      .toBe(0);
    expect(await lintRangeCountForWord(watched, 'beleive')).toBeGreaterThan(0);
  });
});
