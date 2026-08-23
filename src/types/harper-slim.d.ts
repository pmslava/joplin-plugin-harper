// Ambient declaration for the `harper.js/slimBinaryInlined` subpath ONLY.
//
// The rest of harper.js's types resolve normally from the package's own bundled .d.ts (main entry).
// But this project's tsconfig uses classic node module resolution, which does not read a package's
// "exports" map, so the subpath export `harper.js/slimBinaryInlined` is invisible to the type-checker
// even though webpack resolves the real module at build time (webpack.config.js conditionNames).
//
// We declare just that one subpath, typed as harper.js's own `BinaryModule` (exactly what
// `LinterInit.binary` expects), so `new LocalLinter({ binary: slimBinaryInlined })` type-checks with
// no `any`. The runtime value is the real inlined-WASM `data:application/wasm;base64,` module.
declare module 'harper.js/slimBinaryInlined' {
	import { BinaryModule } from 'harper.js';
	export const slimBinaryInlined: BinaryModule;
}
