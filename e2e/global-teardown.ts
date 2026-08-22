import { releaseLock } from './guard';

/**
 * Playwright globalTeardown: release the machine-wide lock at the end of a clean run. Signal/crash
 * paths are covered separately by the fatal handlers installed in guard.ts.
 */
export default async function globalTeardown(): Promise<void> {
  releaseLock();
}
