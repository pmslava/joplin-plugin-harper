import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Harper mobile-spike DESKTOP pre-flight gate.
 *
 * It reuses the PARENT repo's resource-discipline machinery verbatim — the same machine-wide lock,
 * orphan sweep and RAM gate (../e2e/global-setup, ../e2e/global-teardown) anchored on the parent's
 * ../.e2e-cache/squashfs-root AppImage — and the parent's launchJoplin(), which loads whichever built
 * plugin JOPLIN_E2E_PLUGIN_DIST points at. The spike's npm/run command sets:
 *
 *   JOPLIN_E2E_PLUGIN_ID=io.github.pmslava.harperspike
 *   JOPLIN_E2E_PLUGIN_DIST=<repo>/mobile-spike/dist
 *
 * so this run loads the spike from mobile-spike/dist while every existing parent spec (which sets
 * neither var) keeps loading ../dist under the real id. The user's real Joplin at ~/.joplin is never
 * touched — a throwaway profile is created per run under ../e2e/.profiles.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: '../e2e/global-setup.ts',
  globalTeardown: '../e2e/global-teardown.ts',
  timeout: 300_000,
  globalTimeout: 18 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
