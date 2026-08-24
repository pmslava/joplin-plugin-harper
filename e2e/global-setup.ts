import { acquireLock, sweepOrphans, checkRamGate, releaseLock } from './guard';

/**
 * Playwright globalSetup: enforce single-run resource discipline before ANY Joplin spawns.
 *
 *   1. Acquire the machine-wide lock, queueing behind another live run until it finishes (the
 *      sibling repos share this lock, so a cockpit/ridgeline run is waited out, not raced).
 *   2. Deterministic orphan sweep — reap leftovers from previous dead runs.
 *   3. Soft RAM gate — abort locally if memory is too low (warn-only under CI).
 *
 * On CI each repo runs in its own isolated VM, so the lock trivially acquires, the sweep finds
 * nothing, and the RAM gate only warns.
 */
export default async function globalSetup(): Promise<void> {
  // Waits out a live run (E2E_LOCK_WAIT_MS, default 10 min); throws only if it never gets the lock.
  await acquireLock();
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
