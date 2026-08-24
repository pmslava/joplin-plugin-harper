import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resource-discipline guard for the real-app Joplin E2E harness.
 *
 * The harness launches a real Joplin desktop (Electron) under Xvfb. Two failure modes threaten the
 * developer's live desktop session (16 GB laptop, real Joplin already running):
 *
 *   1. A SIGKILLed / crashed run skips Playwright's per-spec `afterAll`, leaking the Joplin process
 *      tree, the Xvfb server, `/tmp/.X<n>-lock` files and `e2e/.profiles/profile-*` dirs.
 *   2. Two repos / worktrees / sessions can each start a run and stack multiple Joplin instances,
 *      exhausting RAM (this contributed to two desktop collapses on 2026-08-21).
 *
 * This module provides, wired from `playwright.config.ts` (globalSetup/globalTeardown) and from
 * `launch.ts` (spawn tracking):
 *
 *   - a machine-wide lock shared by ALL joplin-plugin E2E repos, so only one run happens at a time
 *     (a run that finds the lock held queues behind the holder instead of failing on the spot);
 *   - a deterministic pre-run orphan sweep that reaps leftovers from previous dead runs;
 *   - a soft RAM gate that aborts locally when memory is too low (warn-only under CI);
 *   - best-effort in-process teardown on SIGINT/SIGTERM/uncaughtException/exit.
 *
 * SAFETY: every process match is anchored on THIS repo's absolute `.e2e-cache/squashfs-root` path.
 * The developer's real desktop Joplin runs from `/tmp/.mount_XXXXXX/joplin` and can NEVER match, nor
 * a sibling repo's `.e2e-cache` path — the guard only ever touches this repo's own E2E processes.
 *
 * Kept in lockstep across the three forked harnesses (cockpit / harper / ridgeline): the hardening
 * logic is byte-identical; only the self-contained repo paths below differ by location.
 */

// --- Self-contained repo paths (guard.ts lives in <repo>/e2e/). ---------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.e2e-cache');
/** Absolute path of the extracted Joplin binary tree — the ONLY anchor used to match processes. */
const EXTRACT_DIR = path.join(CACHE_DIR, 'squashfs-root');
const PROFILES_ROOT = path.join(REPO_ROOT, 'e2e', '.profiles');

// --- Machine-wide lock (shared by every joplin-plugin E2E repo on this machine). -----------------
// PROTOCOL — must stay identical in every sibling repo, or the repos stop excluding each other:
//   * the lock is the DIRECTORY below (mkdir is an atomic test-and-set on every filesystem);
//   * the holder writes its pid into `<lock>/pid`; a lock whose pid is not alive is stale and may be
//     reclaimed; `<lock>/owner` is an advisory extra (repo path + start time) a waiter reports and a
//     sibling repo that does not write it is still fully compatible;
//   * the holder removes the directory to release.
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_OWNER_FILE = path.join(LOCK_DIR, 'owner');

/**
 * How long to queue behind a live run before giving up (`E2E_LOCK_WAIT_MS` overrides; 0 = fail fast).
 * Two sibling repos are routinely driven from two sessions, and a run that simply waits its turn is
 * worth far more than one that aborts and leaves a human to poll by hand. The budget is added to the
 * suite's globalTimeout locally (see playwright.config.ts), so waiting never eats the suite's time.
 */
export const LOCK_WAIT_MS = resolveLockWaitMs();
const LOCK_POLL_MS = 2_000;
const LOCK_PROGRESS_MS = 30_000;
/**
 * A lock whose `pid` file has not appeared yet is presumed LIVE for this long. The holder writes its
 * pid microseconds after the mkdir, so a pid-less lock is almost always a run that has just this
 * instant taken it — reading that as "stale" would let a second run break a live lock (observed with
 * five acquirers polling in lockstep). Only a pid-less lock older than this is debris.
 */
const LOCK_PID_GRACE_MS = 30_000;

function resolveLockWaitMs(): number {
  const raw = process.env.E2E_LOCK_WAIT_MS;
  if (raw === undefined || raw.trim() === '') return 10 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10 * 60_000;
}

/** The screen geometry the harness passes to Xvfb via `xvfb-run --server-args` — a run signature. */
const XVFB_SIGNATURE = '-screen 0 1920x1080x24';

/** Soft RAM floor: below this MemAvailable a fresh Joplin launch risks an OOM/desktop collapse. */
const RAM_FLOOR_KB = 3 * 1024 * 1024; // 3 GiB

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[e2e-guard] ${msg}`);
}
function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[e2e-guard] ${msg}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True if a process with this pid currently exists (EPERM still means it exists). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ================================================================================================
// /proc scanning (Linux). On any platform without /proc the sweep is simply a no-op.
// ================================================================================================
interface ProcInfo {
  pid: number;
  ppid: number;
  /** Raw NUL-separated argv (safe for substring matching; split on \0 for exact args). */
  cmdline: string;
}

function readProc(): ProcInfo[] {
  const out: ProcInfo[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out; // no /proc — nothing to sweep
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
    } catch {
      continue; // process vanished / not readable
    }
    if (cmdline.length === 0) continue; // kernel threads have empty cmdline
    let ppid = -1;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens — parse the fields after the last ')'.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ppid = Number(afterComm[1]); // [0]=state, [1]=ppid
    } catch {
      ppid = -1;
    }
    out.push({ pid, ppid, cmdline });
  }
  return out;
}

// ================================================================================================
// Pre-run orphan sweep (the deterministic half of the hardening).
// ================================================================================================

/** (a) Kill every leftover process whose cmdline references THIS repo's extracted Joplin tree. */
function sweepJoplinProcesses(selfPids: Set<number>): number {
  let killed = 0;
  for (const p of readProc()) {
    if (selfPids.has(p.pid)) continue;
    // Path-anchored: matches this repo's main Joplin AND its renderer/gpu/zygote children (all exec
    // the same binary under EXTRACT_DIR). Cannot match the real desktop Joplin (/tmp/.mount_XXXXXX)
    // nor a sibling repo's .e2e-cache tree.
    if (!p.cmdline.includes(EXTRACT_DIR)) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      killed++;
      log(`swept leftover Joplin process pid ${p.pid}`);
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** (b) Kill orphaned (PPID 1) Xvfb servers matching the harness signature; clear their stale locks. */
async function sweepOrphanXvfb(selfPids: Set<number>): Promise<void> {
  for (const p of readProc()) {
    if (selfPids.has(p.pid)) continue;
    if (p.ppid !== 1) continue; // only orphans reparented to init; a live run's Xvfb has a live parent
    if (!p.cmdline.includes('Xvfb')) continue;
    if (!p.cmdline.includes(XVFB_SIGNATURE)) continue;

    const args = p.cmdline.split('\0').filter(Boolean);
    const display = args.find((a) => /^:\d+$/.test(a)) ?? null;
    const dispNum = display ? display.slice(1) : null;
    // Never touch the real X display (:0): it is Xorg, not Xvfb, but guard defensively anyway.
    if (dispNum === '0') continue;

    try {
      process.kill(p.pid, 'SIGKILL');
      log(`swept orphaned Xvfb pid ${p.pid} (display ${display ?? '?'})`);
    } catch {
      continue;
    }
    if (dispNum === null) continue;

    // Only remove a display's lock once its Xvfb is confirmed dead.
    for (let i = 0; i < 20 && pidAlive(p.pid); i++) await sleep(50);
    if (pidAlive(p.pid)) {
      warn(`Xvfb pid ${p.pid} did not exit; leaving /tmp/.X${dispNum}-lock in place`);
      continue;
    }
    for (const stale of [`/tmp/.X${dispNum}-lock`, `/tmp/.X11-unix/X${dispNum}`]) {
      try {
        if (fs.existsSync(stale)) {
          fs.rmSync(stale, { force: true });
          log(`removed stale ${stale}`);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

/** (c) Remove stale throwaway profile dirs left by dead runs. */
function sweepStaleProfiles(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(PROFILES_ROOT);
  } catch {
    return; // no profiles dir yet
  }
  for (const name of entries) {
    if (!name.startsWith('profile-')) continue;
    const dir = path.join(PROFILES_ROOT, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`removed stale profile dir ${dir}`);
    } catch (err) {
      warn(`could not remove stale profile ${dir}: ${(err as Error).message}`);
    }
  }
}

/** Run the full deterministic sweep. Call AFTER acquiring the lock (sole owner of these resources). */
export async function sweepOrphans(): Promise<void> {
  const selfPids = new Set<number>(
    [process.pid, process.ppid].filter((n) => Number.isInteger(n) && n > 0)
  );
  const killed = sweepJoplinProcesses(selfPids);
  if (killed > 0) {
    log(`swept ${killed} leftover Joplin process(es); waiting for profile locks to release`);
    await sleep(500);
  }
  await sweepOrphanXvfb(selfPids);
  sweepStaleProfiles();
}

// ================================================================================================
// Machine-wide lock.
// ================================================================================================
let weOwnLock = false;

function readLockPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(LOCK_PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** How long the lock directory has existed, or Infinity when it cannot be stat'ed. */
function lockAgeMs(): number {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** The holder's advisory description ("<repo> since <time>"), or null when it wrote none. */
function readLockOwner(): string | null {
  try {
    const owner = fs.readFileSync(LOCK_OWNER_FILE, 'utf8').trim();
    return owner.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

function describeHolder(pid: number | null, owner: string | null): string {
  const who = pid === null ? 'unknown pid' : `pid ${pid}`;
  return owner ? `${who}, ${owner}` : who;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`;
}

type LockAttempt =
  | { status: 'acquired' }
  /** A live run holds the lock; the caller decides whether to wait. */
  | { status: 'held'; pid: number | null; owner: string | null }
  /** A stale lock was broken, or another process won a race — retry immediately. */
  | { status: 'retry' };

/** One atomic attempt at the lock. Never blocks: the waiting policy lives in acquireLock(). */
function tryTakeLock(): LockAttempt {
  try {
    fs.mkdirSync(LOCK_DIR); // atomic test-and-set: throws EEXIST if the lock is held
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = readLockPid();
    if (holder !== null && pidAlive(holder)) {
      return { status: 'held', pid: holder, owner: readLockOwner() };
    }
    if (holder === null && lockAgeMs() < LOCK_PID_GRACE_MS) {
      // The lock exists but names no pid yet: whoever won the mkdir a moment ago is about to write
      // it. Treat that as held — breaking it here is exactly how two runs both end up "owning" it.
      return { status: 'held', pid: null, owner: null };
    }
    // Stale: the holder is gone (crashed / SIGKILLed before its teardown). Break it by RENAMING the
    // directory aside rather than removing it in place — rename(2) succeeds for exactly one process,
    // so two reclaimers racing cannot both conclude they own the lock (the loser gets ENOENT, sees
    // 'retry' and comes back round to a plain mkdir).
    warn(`reclaiming stale E2E lock at ${LOCK_DIR} (owner pid ${holder ?? 'unknown'} is not alive)`);
    const aside = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(LOCK_DIR, aside);
    } catch {
      return { status: 'retry' }; // another process broke it first
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      /* the lock is already gone as far as the protocol is concerned */
    }
    return { status: 'retry' };
  }

  weOwnLock = true;
  try {
    fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8'); // first: a pid-less lock is ambiguous
    fs.writeFileSync(LOCK_OWNER_FILE, `${REPO_ROOT} since ${new Date().toISOString()}`, 'utf8');
  } catch {
    /* both files are advisory; the directory itself is the lock */
  }
  installFatalHandlers();
  return { status: 'acquired' };
}

/**
 * Acquire the machine-wide lock, queueing behind a live run rather than failing on the spot: two
 * sibling repos are routinely driven from two sessions, and the point of the lock is to serialise
 * them, not to make a human poll. A stale lock left by a dead run is reclaimed at once. Gives up
 * after LOCK_WAIT_MS with an error that names the holder. Must be called before anything spawns.
 */
export async function acquireLock(): Promise<void> {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const startedAt = Date.now();
  const deadline = startedAt + LOCK_WAIT_MS;
  let announced = false;
  let lastProgress = startedAt;
  let breaks = 0;

  for (;;) {
    const attempt = tryTakeLock();
    if (attempt.status === 'acquired') {
      const waited = Date.now() - startedAt;
      log(
        `acquired machine-wide E2E lock (pid ${process.pid}) at ${LOCK_DIR}` +
          (announced ? ` after waiting ${formatDuration(waited)}` : '')
      );
      return;
    }
    if (attempt.status === 'retry') {
      // Each retry means someone (us or another acquirer) just broke a stale lock, so the loop makes
      // progress; the cap only guarantees termination if the lock directory is somehow pathological.
      if (++breaks > 100) {
        throw new Error(`Could not settle the E2E lock at ${LOCK_DIR}: it keeps reappearing stale.`);
      }
      await sleep(50);
      continue;
    }

    const holder = describeHolder(attempt.pid, attempt.owner);
    if (LOCK_WAIT_MS === 0) {
      throw new Error(
        `Another Joplin E2E run is active (${holder}); one run machine-wide — resource ` +
          `discipline.\nLock: ${LOCK_DIR}\nUnset E2E_LOCK_WAIT_MS=0 to queue behind it instead.`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another Joplin E2E run is STILL active after waiting ` +
          `${formatDuration(Date.now() - startedAt)} (${holder}); one run machine-wide — resource ` +
          `discipline.\nLock: ${LOCK_DIR}\nRetry once that run finishes, raise the budget with ` +
          `E2E_LOCK_WAIT_MS=<ms>, or — only if you are certain no run is active — remove that ` +
          `directory.`
      );
    }
    if (!announced) {
      announced = true;
      lastProgress = Date.now();
      log(
        `machine-wide E2E lock is held by a live run (${holder}); one run machine-wide — waiting ` +
          `up to ${formatDuration(LOCK_WAIT_MS)} for it to finish (E2E_LOCK_WAIT_MS to change).`
      );
    } else if (Date.now() - lastProgress >= LOCK_PROGRESS_MS) {
      lastProgress = Date.now();
      log(
        `still waiting for the E2E lock — ${formatDuration(Date.now() - startedAt)} elapsed, ` +
          `${formatDuration(deadline - Date.now())} left (holder ${holder} is alive)`
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

/** Release the machine-wide lock, but only if this process owns it. Safe to call repeatedly. */
export function releaseLock(): void {
  if (!weOwnLock) return;
  weOwnLock = false;
  // Never remove a directory that is no longer ours: if a stale-lock reclaim elsewhere ever took it
  // from us, deleting it would hand a third run the lock a live run is holding.
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) {
    warn(`E2E lock at ${LOCK_DIR} is now held by pid ${holder}; leaving it alone`);
    return;
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    log(`released machine-wide E2E lock at ${LOCK_DIR}`);
  } catch {
    /* ignore */
  }
}

// ================================================================================================
// Soft RAM gate.
// ================================================================================================
function readMemAvailableKb(): number | null {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s*kB/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Abort locally when free memory is dangerously low; warn (never abort) under CI or when
 * E2E_IGNORE_RAM is set, so isolated CI VMs and deliberate overrides stay green.
 */
export function checkRamGate(): void {
  const availKb = readMemAvailableKb();
  if (availKb === null) {
    warn('could not read MemAvailable from /proc/meminfo; skipping RAM gate');
    return;
  }
  const availGiB = (availKb / (1024 * 1024)).toFixed(2);
  if (availKb >= RAM_FLOOR_KB) {
    log(`MemAvailable ${availGiB} GiB — OK for one Joplin E2E run`);
    return;
  }
  const msg =
    `Low memory: MemAvailable ${availGiB} GiB (< 3 GiB). Launching Joplin E2E on top of this ` +
    `risks an OOM/desktop collapse — resource discipline.`;
  if (process.env.CI || process.env.E2E_IGNORE_RAM) {
    warn(`${msg} Continuing (CI or E2E_IGNORE_RAM set).`);
    return;
  }
  throw new Error(`${msg}\nClose apps to free memory, or set E2E_IGNORE_RAM=1 to override.`);
}

// ================================================================================================
// Best-effort in-process teardown: track live Joplin instances and reap them on fatal exit.
// ================================================================================================
interface TrackedInstance {
  pid: number;
  profileDir: string;
}
const liveInstances = new Map<number, TrackedInstance>();
let fatalHandlersInstalled = false;

/**
 * Register a spawned Joplin instance so a fatal signal / crash reaps its process group and profile.
 * The child MUST have been spawned with `detached: true` so `pid` is its own process-group leader.
 */
export function trackInstance(child: ChildProcess, profileDir: string): void {
  if (typeof child.pid !== 'number') return;
  liveInstances.set(child.pid, { pid: child.pid, profileDir });
  installFatalHandlers();
}

/** Stop tracking an instance the happy path has already closed and cleaned up. */
export function untrackInstance(child: ChildProcess): void {
  if (typeof child.pid === 'number') liveInstances.delete(child.pid);
}

function killInstance(inst: TrackedInstance): void {
  // Negative pid targets the whole process group (renderers, GPU, zygote) — possible because the
  // child was spawned detached. A positive-pid kill is a harmless fallback.
  try {
    process.kill(-inst.pid, 'SIGKILL');
  } catch {
    /* group already gone */
  }
  try {
    process.kill(inst.pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
  try {
    fs.rmSync(inst.profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Synchronous, idempotent: reap all tracked instances and release the lock if we own it. */
function fatalCleanup(): void {
  for (const inst of liveInstances.values()) {
    try {
      killInstance(inst);
    } catch {
      /* ignore */
    }
  }
  liveInstances.clear();
  releaseLock();
}

/**
 * Install process-wide fatal handlers once. Idempotent and shared: whichever side of the harness
 * runs first (globalSetup owning the lock, or launch.ts tracking an instance) installs them; the
 * cleanup is a no-op for whichever resource this process does not hold.
 */
function installFatalHandlers(): void {
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  process.once('exit', fatalCleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.once(sig, () => {
      fatalCleanup();
      // Re-raise with our (once) handler removed so Playwright's own handling / the default
      // terminate action can proceed normally.
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
    });
  }
  process.once('uncaughtException', (err) => {
    warn(`uncaughtException: ${(err as Error)?.stack ?? String(err)}`);
    fatalCleanup();
    process.exit(1);
  });
}
