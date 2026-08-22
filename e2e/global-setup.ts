import { acquireLock, sweepOrphans, checkRamGate, releaseLock } from './guard';

/**
 * Playwright globalSetup: enforce single-run resource discipline before ANY Joplin spawns.
 *
 *   1. Acquire the machine-wide lock (fail fast if another run is active).
 *   2. Deterministic orphan sweep — reap leftovers from previous dead runs.
 *   3. Soft RAM gate — abort locally if memory is too low (warn-only under CI).
 *
 * On CI each repo runs in its own isolated VM, so the lock trivially acquires, the sweep finds
 * nothing, and the RAM gate only warns.
 */
export default async function globalSetup(): Promise<void> {
  acquireLock(); // throws immediately if another run holds the lock
  try {
    await sweepOrphans();
    checkRamGate();
  } catch (err) {
    // A throw here aborts the run and skips globalTeardown, so release the lock we just took
    // (the process 'exit' handler is a further backstop).
    releaseLock();
    throw err;
  }
}
