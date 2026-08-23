// Cached platform detection (Cockpit's proven pattern — docs/research/mobile-product-design.md §3).
//
// The whole desktop/mobile fork keys off `isMobile()`. Platform is resolved ONCE, lazily, from
// `joplin.versionInfo().platform` ('desktop' | 'mobile' — populated on both apps at runtime; the
// bundled api/types.ts predates the field, so we read it through an `any` cast). We resolve it at the
// very top of onStart (before registerSettings), so conditional settings registration and every other
// branch can call the synchronous `isMobile()` afterwards.
//
// Fallback for old desktop builds that predate the `platform` field: probe whether a real Node module
// loads. On desktop the plugin main process is Electron/Node, so `require('fs')` resolves; on mobile
// the sandboxed iframe has no Node and it throws. This mirrors Cockpit's requireNodeModule fallback.

import joplin from 'api';

// webpack rewrites bare `require(...)`; __non_webpack_require__ emits a raw runtime require resolved by
// Node/Electron. Present on desktop, throws inside the mobile plugin iframe (no Node).
declare const __non_webpack_require__: (id: string) => any;

export type Platform = 'desktop' | 'mobile';

let cachedPlatform: Platform | null = null;

/** Resolve and cache the platform. Safe to call repeatedly; only the first call does any work. */
export async function resolvePlatform(): Promise<Platform> {
	if (cachedPlatform) return cachedPlatform;
	try {
		const vi = (await joplin.versionInfo()) as unknown as { platform?: string };
		if (vi && (vi.platform === 'mobile' || vi.platform === 'desktop')) {
			cachedPlatform = vi.platform;
			return cachedPlatform;
		}
	} catch {
		/* versionInfo unavailable — fall through to the node-module probe */
	}
	// Fallback: a real Node module loads on desktop only.
	try {
		__non_webpack_require__('fs');
		cachedPlatform = 'desktop';
	} catch {
		cachedPlatform = 'mobile';
	}
	return cachedPlatform;
}

/** Synchronous accessor — valid only AFTER resolvePlatform() has been awaited once (in onStart). */
export function getPlatform(): Platform {
	// Default to 'desktop' if somehow read before resolution: desktop is the pre-existing, safe path
	// (it never triggers the mobile-only note-write discipline), and onStart always resolves first.
	return cachedPlatform ?? 'desktop';
}

export function isMobile(): boolean {
	return getPlatform() === 'mobile';
}

/** Test seam: reset the cache between harness runs (the bundle is re-required per run config). */
export function __resetPlatformCacheForTests(): void {
	cachedPlatform = null;
}
