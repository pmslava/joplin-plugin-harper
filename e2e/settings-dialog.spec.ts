import { test, expect, Frame, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { artifactPath } from './artifacts';
import { launchJoplin, closeJoplin, pluginSettingKey, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  clickDismiss,
  runCommand,
} from './helpers';

/**
 * E2E — THE SETTINGS DIALOG (Phase 2).
 *
 * Drives the real dialog inside a real Joplin: the rules browser, its search, the tri-state selects,
 * Reset to Default Rules, and the dismissed-findings restore. Every assertion is made through the
 * dialog's own DOM and then confirmed OUTSIDE it — in the editor's underlines and in the profile's
 * settings.json — so a test cannot pass on a dialog that renders correctly but wires up to nothing.
 *
 * The dialog is a plugin webview iframe inside Joplin's main renderer document, so the specs work
 * against a Playwright `Frame` rather than the page. It is located by CONTENT (`#harper-settings`)
 * rather than by URL: Joplin's webview iframe URL is an internal detail that has changed between
 * releases, while the render root is ours.
 *
 * Serial: the group shares one Joplin instance and each test builds on the state the last one left
 * (a rule is disabled, then reset, then a finding is dismissed and restored).
 */

const RULE = 'ModalOf'; // the rule behind "should of" — the same one disable-rule.spec.ts pins
const PHRASE = 'should of';
const SURVIVOR = 'beleive'; // a Spelling finding that must be unaffected throughout

// -----------------------------------------------------------------------------
// Dialog plumbing.
// -----------------------------------------------------------------------------

/** The dialog's iframe, found by its render root. Null while the dialog is closed. */
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

async function waitForSettingsFrame(win: Page, timeoutMs = 60_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  let last: Frame | null = null;
  while (Date.now() < deadline) {
    last = await findSettingsFrame(win);
    if (last) return last;
    await win.waitForTimeout(400);
  }
  const urls = win.frames().map((f) => f.url());
  throw new Error(`settings dialog frame never appeared; frames were:\n${urls.join('\n')}`);
}

/** Run `harper.openSettings` the way a user would, and hand back the dialog's frame. */
async function openSettings(win: Page): Promise<Frame> {
  await runCommand(win, 'harper.openSettings');
  const frame = await waitForSettingsFrame(win);
  // The script renders from a snapshot it has to fetch first, so wait for real content, not just the
  // root element.
  await frame.locator('.hs-tab[data-tab="rules"]').waitFor({ state: 'visible', timeout: 60_000 });
  return frame;
}

/**
 * Close the dialog via its own Close button.
 *
 * The button row belongs to the PARENT document (Joplin renders dialog buttons outside the webview),
 * so it is clicked on `win`, not on the frame. Escape is the fallback: Joplin's dialog handles it,
 * and a stuck-open modal would poison every later test in the group.
 */
async function closeSettings(win: Page): Promise<void> {
  const button = win.locator('button', { hasText: /^Close$/ }).last();
  if (await button.count()) {
    await button.click({ timeout: 10_000 }).catch(() => undefined);
  }
  const gone = await waitForFrameGone(win, 8_000);
  if (!gone) {
    await win.keyboard.press('Escape');
    expect(await waitForFrameGone(win, 15_000)).toBe(true);
  }
  // Joplin restores editor focus asynchronously after a modal closes; the next command palette open
  // needs that to have settled.
  await win.waitForTimeout(800);
}

async function waitForFrameGone(win: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findSettingsFrame(win))) return true;
    await win.waitForTimeout(300);
  }
  return false;
}

/** Switch to one of the four sections. */
async function openTab(frame: Frame, tab: string): Promise<void> {
  await frame.locator(`.hs-tab[data-tab="${tab}"]`).click();
  await frame.locator(`.hs-tab[data-tab="${tab}"].hs-tab-active`).waitFor({ timeout: 15_000 });
}

/** Type into the rules search box and let its 140 ms debounce fire. */
async function searchRules(frame: Frame, needle: string): Promise<void> {
  await frame.locator('#hs-rule-search').fill(needle);
  await frame.waitForTimeout(500);
}

/** One of this plugin's settings, as the app persisted it into the profile's settings.json. */
function readHarperSetting(profileDir: string, key: string): unknown {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'));
    return settings[pluginSettingKey(key)];
  } catch {
    return undefined;
  }
}

/** The `ruleOverrides` setting as the plugin persisted it (a JSON string inside settings.json). */
function readRuleOverrides(profileDir: string): string {
  return (readHarperSetting(profileDir, 'ruleOverrides') as string) ?? '';
}

// -----------------------------------------------------------------------------

test.describe.serial('Harper settings dialog', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    const { win } = joplin;
    await createNotebook(win, 'Harper Settings NB');
    await createNote(win, 'Harper settings ' + Date.now());
    await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
    await setEditorBody(win, 'I beleive we should of gone.');
    // Both underlines must exist before anything below means anything.
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => lintRangeCountForWord(win, SURVIVOR), { timeout: 60_000 })
      .toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('opens from the command and renders the whole rule roster with correct default tri-states', async () => {
    const { win } = joplin;
    const frame = await openSettings(win);

    // General is the landing section.
    await expect(frame.locator('.hs-tab[data-tab="general"].hs-tab-active')).toHaveCount(1);
    await expect(frame.locator('#hs-dialect')).toHaveValue('American');
    // Desktop registers dictionaryPath, so its row is present here (it must NOT be on mobile).
    await expect(frame.locator('#hs-dictionary-path')).toHaveCount(1);
    await frame
      .locator('#harper-settings')
      .screenshot({ path: artifactPath('settings-general.png') })
      .catch(() => win.screenshot({ path: artifactPath('settings-general.png') }));

    await openTab(frame, 'rules');

    const groups = frame.locator('#hs-rules-groups .hs-group');
    await expect.poll(() => groups.count(), { timeout: 30_000 }).toBeGreaterThan(10);
    const groupCount = await groups.count();

    // The summary line is rendered from the model, so it is the cheapest true count of the roster.
    const summary = (await frame.locator('#hs-rules-summary').textContent()) || '';
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] rules summary = ${JSON.stringify(summary)} across ${groupCount} groups`);
    const total = Number((summary.match(/^(\d+) rules/) || [])[1] || 0);
    expect(total).toBeGreaterThan(800);
    expect(groupCount).toBeGreaterThanOrEqual(12);
    expect(groupCount).toBeLessThanOrEqual(25);
    expect(summary).toContain('All at their defaults.');

    // FRESH PROFILE => every rule is at "Default". This is the assertion that catches the
    // structured-tree trap: Bool.state is `flatConfig[name] ?? false`, so a UI that read values from
    // the tree would render ~814 default-ON rules as "off" right here.
    await frame.locator('#hs-rules-groups .hs-group').first().locator('.hs-disclosure').first().click();
    const selects = frame.locator('#hs-rules-groups .hs-rule-select');
    await expect.poll(() => selects.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    const values = await selects.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLSelectElement).value),
    );
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === 'default')).toBe(true);

    // ...and "Default" is shown resolved, so the user can see what it actually means. At least one
    // rule in the group must report Default (on) — proof the defaults map reached the UI.
    const defaultLabels = await selects.evaluateAll((nodes) =>
      nodes.map((n) => ((n as HTMLSelectElement).options[0] || { text: '' }).text),
    );
    expect(defaultLabels.some((t) => t === 'Default (on)')).toBe(true);
    expect(defaultLabels.every((t) => /^Default \((on|off)\)$/.test(t))).toBe(true);

    // The group selector derives its own state from its children: all-absent => Default.
    await expect(frame.locator('#hs-rules-groups .hs-group-select').first()).toHaveValue('default');

    // Evidence shot: the rules section with a group expanded.
    await frame
      .locator('#harper-settings')
      .screenshot({ path: artifactPath('settings-rules.png') })
      .catch(() => win.screenshot({ path: artifactPath('settings-rules.png') }));

    await closeSettings(win);
  });

  test('search filters the rules list down to a named rule', async () => {
    const { win } = joplin;
    const frame = await openSettings(win);
    await openTab(frame, 'rules');

    const allGroups = await frame.locator('#hs-rules-groups .hs-group').count();
    await searchRules(frame, RULE);

    // Only groups holding a match survive, and the match itself is rendered (a search auto-expands
    // its hits — hiding them behind another click would make the search pointless).
    const shownGroups = await frame.locator('#hs-rules-groups .hs-group').count();
    expect(shownGroups).toBeGreaterThan(0);
    expect(shownGroups).toBeLessThan(allGroups);
    await expect(frame.locator(`.hs-rule[data-rule="${RULE}"]`)).toHaveCount(1);

    // Expanding a rule shows harper's own description for it. These ~823 HTML strings are fetched
    // lazily AFTER the first paint (they would roughly triple the snapshot), so this also proves the
    // background fetch lands and re-renders.
    const row = frame.locator(`.hs-rule[data-rule="${RULE}"]`);
    await row.locator('.hs-disclosure').click();
    const description = row.locator('.hs-rule-desc');
    await expect(description).toHaveCount(1);
    await expect
      .poll(async () => ((await description.textContent()) || '').trim(), { timeout: 30_000 })
      .not.toMatch(/^(Loading description…)?$/);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ${RULE} description = ${JSON.stringify(await description.textContent())}`);

    // A nonsense query filters everything out rather than silently showing all rules.
    await searchRules(frame, 'zzzznotarulezzzz');
    await expect(frame.locator('#hs-rules-groups .hs-group')).toHaveCount(0);
    await expect(frame.locator('#hs-rules-groups .hs-empty')).toHaveCount(1);

    await searchRules(frame, '');
    await expect.poll(() => frame.locator('#hs-rules-groups .hs-group').count()).toBe(allGroups);

    await closeSettings(win);
  });

  test('setting a rule to Off removes its underline and persists the override', async () => {
    const { win, profileDir } = joplin;
    expect(readRuleOverrides(profileDir)).toBe('');

    const frame = await openSettings(win);
    await openTab(frame, 'rules');
    await searchRules(frame, RULE);

    await frame.locator(`[data-rule-select="${RULE}"]`).selectOption('off');
    // The dialog reports its own save, so we do not race the write.
    await expect(frame.locator('#hs-rules-status')).toContainText('Saved.', { timeout: 30_000 });
    await expect(frame.locator('#hs-rules-status')).toContainText('1 rule overridden.');
    // The group header re-derives from its children: one Off among Defaults is "mixed".
    await expect(frame.locator('.hs-group-select').first()).toHaveValue('mixed');

    await closeSettings(win);

    // OUTSIDE the dialog: the underline is gone and the unrelated one survives.
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 }).toBe(0);
    expect(await lintRangeCountForWord(win, SURVIVOR)).toBeGreaterThan(0);

    // ...and it is persisted as the sparse map the setting has always held.
    await expect
      .poll(() => readRuleOverrides(profileDir), { timeout: 20_000 })
      .toContain(RULE);
    const overrides = JSON.parse(readRuleOverrides(profileDir));
    expect(overrides[RULE]).toBe(false);
    expect(Object.keys(overrides)).toEqual([RULE]);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] ruleOverrides after Off = ${readRuleOverrides(profileDir)}`);
  });

  test('Reset to Default Rules clears every override and brings the underline back', async () => {
    const { win, profileDir } = joplin;
    expect(readRuleOverrides(profileDir)).toContain(RULE);

    const frame = await openSettings(win);
    await openTab(frame, 'rules');

    // REOPEN FRESHNESS: this is a brand-new open of the dialog, and it must show the override the
    // previous open made. A webview that was reused without re-fetching would still be showing the
    // all-defaults state from before.
    await expect(frame.locator('#hs-rules-summary')).toContainText('1 overridden.');
    await searchRules(frame, RULE);
    await expect(frame.locator(`[data-rule-select="${RULE}"]`)).toHaveValue('off');
    await searchRules(frame, '');

    // Disable All Rules writes an explicit `false` for every rule in the roster. The count comes off
    // getDefaultLintConfig(), so it is asserted as "the whole roster" rather than a literal that a
    // harper bump would invalidate.
    await frame.locator('#hs-disable-all-rules').click();
    await expect(frame.locator('#hs-rules-status')).toHaveText(/Saved\. [89]\d\d rules overridden\./, {
      timeout: 30_000,
    });
    await expect(frame.locator('.hs-group-select').first()).toHaveValue('off');

    // ...and Reset drops the lot, back to an empty map.
    await frame.locator('#hs-reset-rules').click();
    await expect(frame.locator('#hs-rules-status')).toContainText('No rules overridden', {
      timeout: 30_000,
    });
    await expect(frame.locator('#hs-rules-summary')).toContainText('All at their defaults.');

    await closeSettings(win);

    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // An empty map is stored as '' — the setting's pristine default, not a stray "{}" literal.
    await expect.poll(() => readRuleOverrides(profileDir), { timeout: 20_000 }).toBe('');
  });

  test('a dismissed finding is listed and Restore brings its underline back', async () => {
    const { win } = joplin;

    // Dismiss "should of" through the card, exactly as ignore-dismiss.spec.ts does.
    const card = await openHarperCardByClick(win, PHRASE);
    await clickDismiss(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 }).toBe(0);

    const frame = await openSettings(win);
    await openTab(frame, 'dismissed');

    const rows = frame.locator('#hs-dismissed-list .hs-dismissed').filter({ hasText: PHRASE });
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    const rowText = (await rows.first().textContent()) || '';
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] dismissed row = ${JSON.stringify(rowText)}`);
    // "RuleName: 'flagged text' — date"
    expect(rowText).toContain(RULE);
    expect(rowText).toContain(PHRASE);
    expect(rowText).toMatch(/\d{4}|\d{1,2}[/.]\d{1,2}/); // a rendered date, in whatever locale form

    // Evidence shot: the dismissed section with a real entry in it.
    await frame
      .locator('#harper-settings')
      .screenshot({ path: artifactPath('settings-dismissed.png') })
      .catch(() => win.screenshot({ path: artifactPath('settings-dismissed.png') }));

    await rows.first().locator('button[data-restore]').click();
    await expect(frame.locator('#hs-dismissed-status')).toContainText('Restored', { timeout: 30_000 });
    await expect(frame.locator('#hs-dismissed-list .hs-dismissed').filter({ hasText: PHRASE })).toHaveCount(0);

    await closeSettings(win);

    // The restored finding is underlined again.
    await expect
      .poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  test('the dictionary editor saves a word and Harper stops flagging it', async () => {
    const { win } = joplin;
    const word = 'Zqxblorp';

    await setEditorBody(win, 'I beleive we should of gone with Zqxblorp.');
    await expect.poll(() => lintRangeCountForWord(win, word), { timeout: 60_000 }).toBeGreaterThan(0);

    const frame = await openSettings(win);
    await openTab(frame, 'dictionary');

    const area = frame.locator('#hs-dictionary');
    const before = (await area.inputValue()) || '';
    // Deliberately messy input: the save must trim and drop the blank line.
    await area.fill(`${before}\n  ${word}  \n\n`);
    await frame.locator('#hs-save-dictionary').click();
    await expect(frame.locator('#hs-dictionary-status')).toContainText('1 added', { timeout: 30_000 });
    // Re-rendered sorted, one word per line, with nothing empty left behind.
    const after = (await area.inputValue()).split('\n');
    expect(after).toContain(word);
    expect(after.every((line) => line === line.trim() && line.length > 0)).toBe(true);

    await closeSettings(win);

    await expect.poll(() => lintRangeCountForWord(win, word), { timeout: 30_000 }).toBe(0);
    expect(await lintRangeCountForWord(win, SURVIVOR)).toBeGreaterThan(0);
  });

  /**
   * The General tab was rendered by one test and CHANGED by none, so each of its seven controls
   * could have been wired to the wrong setting key and both suites would still have passed green:
   * the service rejects an unknown key, the dialog quietly reverts the control and shows "Could not
   * save …", and nothing anywhere looked. Every control is driven here and confirmed OUTSIDE the
   * dialog, in the profile's settings.json — the promise this spec's header makes.
   *
   * Last in the group, and every write is reverted, so nothing it touches can leak into a rerun.
   */
  test('every General-tab control writes its own setting, confirmed in settings.json', async () => {
    const { win, profileDir } = joplin;
    const frame = await openSettings(win);
    // General is the landing tab, so no navigation is needed to reach it.
    await expect(frame.locator('.hs-tab[data-tab="general"].hs-tab-active')).toHaveCount(1);

    const saved = async (key: string, value: unknown, what: string) => {
      await expect(frame.locator('#hs-general-status')).not.toContainText('Could not save', {
        timeout: 20_000,
      });
      await expect
        .poll(() => readHarperSetting(profileDir, key), { timeout: 20_000 })
        .toEqual(value);
      // eslint-disable-next-line no-console
      console.log(`[harper-e2e] ${what}: ${key} = ${JSON.stringify(value)}`);
    };

    // 1. Underline style.
    await frame.locator('#hs-underline').selectOption('solid');
    await saved('underlineStyle', 'solid', 'underline select');
    await frame.locator('#hs-underline').selectOption('squiggly');
    await saved('underlineStyle', 'squiggly', 'underline revert');

    // 2. Dialect. (dialect.spec.ts pre-seeds this into settings.json; nothing drove the control.)
    await frame.locator('#hs-dialect').selectOption('British');
    await saved('dialect', 'British', 'dialect select');
    await frame.locator('#hs-dialect').selectOption('American');
    await saved('dialect', 'American', 'dialect revert');

    // 3. Debounce, including the client-side clamp: a number input enforces min/max only on FORM
    //    validation and there is no form here, so an out-of-range value arrives untouched. The field
    //    must show what was actually stored rather than the number the user typed.
    await frame.locator('#hs-debounce').fill('250');
    await frame.locator('#hs-debounce').blur();
    await saved('debounceMs', 250, 'debounce');
    await frame.locator('#hs-debounce').fill('99999');
    await frame.locator('#hs-debounce').blur();
    await expect(frame.locator('#hs-debounce')).toHaveValue('10000');
    await saved('debounceMs', 10000, 'debounce clamp');
    await frame.locator('#hs-debounce').fill('500');
    await frame.locator('#hs-debounce').blur();
    await saved('debounceMs', 500, 'debounce revert');

    // 4. Ignore non-English.
    await frame.locator('#hs-ignore-non-english').check();
    await saved('ignoreNonEnglish', true, 'ignore-non-english check');
    await frame.locator('#hs-ignore-non-english').uncheck();
    await saved('ignoreNonEnglish', false, 'ignore-non-english uncheck');

    // 5. Dictionary note id (an id that resolves to no note is harmless — there is simply no note
    //    side — and it is cleared again immediately).
    await frame.locator('#hs-dictionary-note-id').fill('0123456789abcdef0123456789abcdef');
    await frame.locator('#hs-dictionary-note-id').blur();
    await saved('dictionaryNoteId', '0123456789abcdef0123456789abcdef', 'dictionary note id');
    await frame.locator('#hs-dictionary-note-id').fill('');
    await frame.locator('#hs-dictionary-note-id').blur();
    await saved('dictionaryNoteId', '', 'dictionary note id cleared');

    // 6. External dictionary file — desktop only, so the row exists here.
    const dictPath = path.join(joplin.profileDir, 'e2e-dictionary.txt');
    await frame.locator('#hs-dictionary-path').fill(dictPath);
    await frame.locator('#hs-dictionary-path').blur();
    await saved('dictionaryPath', dictPath, 'dictionary path');
    await frame.locator('#hs-dictionary-path').fill('');
    await frame.locator('#hs-dictionary-path').blur();
    await saved('dictionaryPath', '', 'dictionary path cleared');

    // 7. Enable Harper — reverted immediately, then confirmed in the editor rather than only in the
    //    file, since this is the one control whose whole job is outside the dialog.
    await frame.locator('#hs-enabled').uncheck();
    await saved('enabled', false, 'enabled off');
    await frame.locator('#hs-enabled').check();
    await saved('enabled', true, 'enabled on');

    await closeSettings(win);
    await expect.poll(() => lintRangeCountForWord(win, SURVIVOR), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  /**
   * Joplin's webview bootstrap turns Enter in an `INPUT[type=text]` into a form submit, and the
   * dialog's onSubmit clicks the first button whose id is one of ok/yes/submit/confirm — which is
   * this dialog's only button. So pressing Enter to commit a note id dismissed the whole settings
   * screen, every time. Only reproducible inside real Joplin, since the listener is the app's.
   */
  test('Enter in a text field commits the value instead of closing the settings screen', async () => {
    const { win, profileDir } = joplin;
    const frame = await openSettings(win);

    const noteId = frame.locator('#hs-dictionary-note-id');
    await noteId.fill('fedcba9876543210fedcba9876543210');
    await noteId.press('Enter');
    await win.waitForTimeout(1500);

    expect(await findSettingsFrame(win)).not.toBeNull(); // the dialog is still there
    // ...and Enter still did what the user pressed it for: the `change` event fired and saved.
    await expect
      .poll(() => readHarperSetting(profileDir, 'dictionaryNoteId'), { timeout: 20_000 })
      .toBe('fedcba9876543210fedcba9876543210');

    // The desktop-only path field is the other `type=text` input, and behaves the same.
    await frame.locator('#hs-dictionary-path').press('Enter');
    await win.waitForTimeout(1000);
    expect(await findSettingsFrame(win)).not.toBeNull();

    // Leave the profile as we found it.
    await noteId.fill('');
    await noteId.press('Enter');
    await expect.poll(() => readHarperSetting(profileDir, 'dictionaryNoteId'), { timeout: 20_000 }).toBe('');

    await closeSettings(win);
  });

  /**
   * The dismissed manager's only destructive action. Its confirmation used to be armed in module
   * state while the button showing it was rebuilt by every render — so leaving the tab, the natural
   * way to back out, left a button reading "Clear all" one click from wiping every dismissal.
   */
  test('"Clear all" re-arms after a tab switch instead of firing unconfirmed', async () => {
    const { win } = joplin;

    // Something to lose.
    const card = await openHarperCardByClick(win, PHRASE);
    await clickDismiss(win, card);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 }).toBe(0);

    const frame = await openSettings(win);
    await openTab(frame, 'dismissed');
    const rows = frame.locator('#hs-dismissed-list .hs-dismissed').filter({ hasText: PHRASE });
    await expect(rows).toHaveCount(1, { timeout: 30_000 });

    // Arm it, then change your mind and navigate away.
    await frame.locator('#hs-clear-all').click();
    await expect(frame.locator('#hs-clear-all')).toHaveText('Really clear all?');
    await openTab(frame, 'general');
    await openTab(frame, 'dismissed');

    // The rebuilt button looks unarmed, so it must BE unarmed.
    await expect(frame.locator('#hs-clear-all')).toHaveText('Clear all');
    await frame.locator('#hs-clear-all').click();
    await expect(frame.locator('#hs-clear-all')).toHaveText('Really clear all?');
    await expect(frame.locator('#hs-dismissed-status')).not.toContainText('Cleared');
    await expect(rows).toHaveCount(1); // nothing was cleared by that click

    // Confirming still works, and really does clear.
    await frame.locator('#hs-clear-all').click();
    await expect(frame.locator('#hs-dismissed-status')).toContainText('Cleared', { timeout: 30_000 });
    await expect(frame.locator('#hs-dismissed-list .hs-dismissed')).toHaveCount(0);

    await closeSettings(win);
    await expect.poll(() => lintRangeCountForWord(win, PHRASE), { timeout: 30_000 }).toBeGreaterThan(0);
  });
});
