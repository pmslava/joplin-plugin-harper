import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * E2E (a) — UNIFIED LOADER artifact smoke.
 *
 * The v1.1.0 loader change is exercised implicitly by every OTHER spec in this suite: they all boot
 * the real plugin, which now instantiates harper.js from the inlined WASM binary (no fs read, no
 * separate .wasm file). This spec adds the artifact-level assertions that the *shape* of the build is
 * the unified one: the shipped `dist/index.js` embeds the `data:application/wasm;base64,` module, and
 * there is NO separate `.wasm` file left in `dist/` (the old CopyPlugin rule is gone).
 */
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

test.describe('Harper unified inlined-WASM loader (artifacts)', () => {
  test('dist/index.js embeds the inlined WASM data URL', () => {
    const idx = fs.readFileSync(path.join(DIST_DIR, 'index.js'), 'utf8');
    expect(idx.includes('data:application/wasm')).toBe(true);
  });

  test('dist ships no separate .wasm file (loader no longer reads the binary off disk)', () => {
    const wasmFiles = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith('.wasm'));
    expect(wasmFiles).toEqual([]);
  });
});
