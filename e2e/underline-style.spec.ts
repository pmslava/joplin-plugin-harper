import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNote,
  editorIsPresent,
  setEditorBody,
  lintRangeCountForWord,
  openHarperCardByClick,
  underlinePaintForWord,
} from './helpers';

/**
 * E2E — UNDERLINE STYLE (v1.2.0, Harper issue #1710 "Prefer solid line to squiggly").
 *
 * The plugin ships BOTH of Harper's underline rule-sets (harper-ui-spec §1.3) in one stylesheet and
 * picks between them per decoration via the `underlineStyle` setting. This spec proves the two ends
 * of that choice in the real app, on the same sentence and the same lint kind:
 *
 *   (a) DEFAULT (no setting written) -> `harper-squiggly-style`: the squiggle SVG data-URI IS the
 *       painted background-image, and NOTHING draws a bottom border.
 *   (b) PRE-SEEDED `underlineStyle: 'solid'` -> `harper-web-style`: a 2px solid bottom border in the
 *       kind's exact palette hex, a visible background tint, and NO squiggle background-image.
 *
 * (b) is booted the `dialect.spec.ts` way — `launchJoplin({ harperSettings })` writes
 * `plugin-<id>.underlineStyle` into the fresh profile's settings.json, which our File-storage setting
 * reads at startup — so no settings UI driving is needed.
 *
 * Both runs also click an underline and assert the suggestion card still opens: the style choice must
 * not disturb the click hit-testing (the card is anchored off the diagnostic range, not the paint).
 *
 * WORD/KIND under test: "beleive" -> Spelling -> #EE4266 (the canonical palette, same hex the
 * ui-conformance spec asserts through the squiggle stroke).
 */

const WORD = 'beleive';
const KIND_HEX = '#EE4266'; // Spelling
const BODY = 'I beleive teh cat is fine.';

/** Type the fixture sentence into a fresh note and wait for the WORD underline to appear. */
async function seedNote(joplin: JoplinInstance, nbName: string): Promise<void> {
  const { win } = joplin;
  await createNotebook(win, nbName);
  await createNote(win, `${nbName} ${Date.now()}`);
  await expect.poll(() => editorIsPresent(win), { timeout: 20_000 }).toBe(true);
  await setEditorBody(win, BODY);
  await expect.poll(() => lintRangeCountForWord(win, WORD), { timeout: 60_000 }).toBeGreaterThan(0);
}

test.describe('Harper underline style — default (squiggly)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    // No harperSettings at all: this is exactly what an existing install looks like after upgrading,
    // so it doubles as the regression guard that v1.2.0 does not change the default look.
    joplin = await launchJoplin();
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('decorations are squiggly: SVG background-image, no bottom border; card still opens', async () => {
    const { win } = joplin;
    await seedNote(joplin, 'Harper Underline Squiggly NB');

    const paint = await underlinePaintForWord(win, WORD);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] squiggly paint = ${JSON.stringify(paint)}`);

    expect(paint.styleClass).toBe('harper-squiggly-style');

    // The squiggle IS painted, and it is the per-kind SVG (its stroke carries the palette hex).
    expect(paint.backgroundImage).not.toBe('none');
    expect(paint.backgroundImage).toContain('data:image/svg+xml');
    const strokeHex = (() => {
      let decoded = paint.backgroundImage;
      try {
        decoded = decodeURIComponent(paint.backgroundImage);
      } catch {
        /* keep raw */
      }
      const m = decoded.match(/stroke="(#[0-9A-Fa-f]{6})"/);
      return m ? m[1].toUpperCase() : null;
    })();
    expect(strokeHex).toBe(KIND_HEX);

    // …and NOTHING draws the solid-style bottom border.
    expect(paint.borderBottomStyle).toBe('none');
    expect(paint.borderBottomWidth).toBe('0px');

    // The card still opens on a click on the underline.
    const card = await openHarperCardByClick(win, WORD);
    await expect(card.locator('.harper-title')).toHaveText('Spelling');
  });
});

test.describe("Harper underline style — pre-seeded 'solid'", () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ harperSettings: { underlineStyle: 'solid' } });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('decorations are solid: 2px palette-colored border + tint, no squiggle; card still opens', async () => {
    const { win } = joplin;
    await seedNote(joplin, 'Harper Underline Solid NB');

    const paint = await underlinePaintForWord(win, WORD);
    // eslint-disable-next-line no-console
    console.log(`[harper-e2e] solid paint = ${JSON.stringify(paint)}`);

    expect(paint.styleClass).toBe('harper-web-style');

    // border-bottom: 2px solid <kind color> — the color now lives here, not in an SVG stroke.
    expect(paint.borderBottomStyle).toBe('solid');
    expect(paint.borderBottomWidth).toBe('2px');
    expect(paint.borderBottomColorHex).toBe(KIND_HEX);

    // A background tint is applied (spec: `<color>22`, i.e. the kind color at ~13% alpha). Asserted
    // as "translucent, non-transparent, and the kind's RGB" rather than an exact alpha string, since
    // browsers round the 0x22/255 alpha when serialising rgba().
    const tint = paint.backgroundColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
    expect(tint, `background-color was "${paint.backgroundColor}"`).not.toBeNull();
    const [, r, g, b, a] = tint!;
    expect([Number(r), Number(g), Number(b)]).toEqual([0xee, 0x42, 0x66]);
    const alpha = a === undefined ? 1 : Number(a);
    expect(alpha).toBeGreaterThan(0); // a real tint, not fully transparent
    expect(alpha).toBeLessThan(0.5); // …but a light one, not a solid fill

    // NO squiggle: neither ours nor the bundled @codemirror/lint severity squiggle
    // (`.cm-lintRange-error{background-image:underline("#f11")}`), which the solid rule resets.
    expect(paint.backgroundImage).toBe('none');

    // The card still opens on a click on the underline.
    const card = await openHarperCardByClick(win, WORD);
    await expect(card.locator('.harper-title')).toHaveText('Spelling');
  });
});
