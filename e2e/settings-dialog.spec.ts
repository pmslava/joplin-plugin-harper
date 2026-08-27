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

/** The `ruleOverrides` setting as the plugin persisted it (a JSON string inside settings.json). */
function readRuleOverrides(profileDir: string): string {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8'));
    return settings[pluginSettingKey('ruleOverrides')] ?? '';
  } catch {
    return '';
  }
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
});
