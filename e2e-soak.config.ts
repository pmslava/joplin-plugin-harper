import { defineConfig } from '@playwright/test';

/**
 * Config for the attach soak (e2e/attach-soak.spec.ts) ONLY.
 *
 * Same resource discipline as the real suite (the machine-wide lock + orphan sweep in
 * e2e/global-setup.ts), but no per-test or global timeout: the soak deliberately runs many Joplin
 * launches back to back, and it must not be cut off mid-run. No retries — a dead session IS the
 * result being measured.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /attach-soak\.spec\.ts/,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 0,
  globalTimeout: 0,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
