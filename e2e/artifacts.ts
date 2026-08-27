import * as fs from 'fs';
import * as path from 'path';

/**
 * Where e2e specs put the PNGs they capture for a human to look at.
 *
 * These are evidence, never assertions — nothing in the suite compares against a baseline. They used
 * to go to a hardcoded absolute path under a long-dead session's scratchpad directory, which meant a
 * run on any other machine (or any later session) silently wrote screenshots into a directory nobody
 * would ever look in. Repo-relative and gitignored instead, with an env override for CI, which wants
 * them collected somewhere else.
 */
export const ARTIFACTS_DIR =
	process.env.HARPER_E2E_ARTIFACTS ?? path.join(__dirname, '.artifacts');

/** Ensure the directory exists and return the full path for `name` inside it. */
export function artifactPath(name: string): string {
	fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
	return path.join(ARTIFACTS_DIR, name);
}
