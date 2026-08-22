// Minimal, self-contained webpack build for the Harper mobile spike.
//
// Modelled on the parent plugin's generator webpack.config.js but trimmed to the essentials:
//   buildMain          -> src/index.ts        -> dist/index.js   (the ~21 MB inlined-WASM bundle)
//   buildExtraScripts  -> src/contentScript.ts -> dist/contentScript.js (CM6 script; @codemirror externals)
//   createArchive      -> tar dist/**         -> publish/<id>.jpl
//
// A .jpl is simply a portable TAR of the dist/ tree — the same archive step the parent uses.

/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const CopyPlugin = require('copy-webpack-plugin');
const tar = require('tar');
const { builtinModules } = require('node:module');

const rootDir = path.resolve(__dirname);
const srcDir = path.resolve(rootDir, 'src');
const distDir = path.resolve(rootDir, 'dist');
const publishDir = path.resolve(rootDir, 'publish');
const apiDir = path.resolve(rootDir, '..', 'api'); // reuse the parent repo's Joplin API type surface

const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
const pluginArchiveFilePath = path.resolve(publishDir, `${manifest.id}.jpl`);

// Webpack5 doesn't polyfill node builtins; set them false so guarded require()/import('fs') inside
// harper's glue (dead on mobile where `process` is undefined) doesn't drag in a polyfill.
const moduleFallback = {};
for (const m of builtinModules) moduleFallback[m] = false;

function createPluginArchive(sourceDir, destPath) {
	const distFiles = fs
		.readdirSync(sourceDir, { withFileTypes: true, recursive: true })
		.filter((d) => d.isFile())
		.map((d) => path.relative(sourceDir, path.join(d.parentPath || d.path, d.name)));
	if (!distFiles.length) throw new Error('Plugin archive not created: dist/ is empty');
	fs.rmSync(destPath, { force: true });
	tar.create({ strict: true, portable: true, file: destPath, cwd: sourceDir, sync: true }, distFiles);
	console.log(`[spike] plugin archive created: ${destPath}`);
}

const baseConfig = {
	mode: 'production',
	target: 'node',
	stats: 'errors-only',
	module: {
		rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }],
	},
};

const pluginConfig = {
	...baseConfig,
	entry: './src/index.ts',
	resolve: {
		alias: { api: apiDir },
		fallback: moduleFallback,
		extensions: ['.js', '.tsx', '.ts', '.json'],
		// harper.js is ESM-only: its "exports" map exposes only the "import" condition. target:node
		// otherwise resolves ["node","require"] and fails with '"." is not exported'. "require" stays
		// first so ordinary dual CJS/ESM deps still pick their CJS build.
		conditionNames: ['require', 'node', 'import', 'default'],
	},
	output: { filename: 'index.js', path: distDir },
	plugins: [
		new CopyPlugin({
			patterns: [
				{
					from: '**/*',
					context: srcDir,
					to: distDir,
					globOptions: { ignore: ['**/*.ts', '**/*.tsx'] },
				},
			],
		}),
	],
};

const extraScriptConfig = {
	...baseConfig,
	entry: './src/contentScript.ts',
	resolve: {
		alias: { api: apiDir },
		fallback: moduleFallback,
		extensions: ['.js', '.tsx', '.ts', '.json'],
	},
	// The CM6 content script must consume Joplin's OWN copies of these modules (injected at runtime on
	// both desktop and mobile). Marking them commonjs externals keeps require('@codemirror/...') in the
	// emitted bundle instead of bundling a duplicate CodeMirror.
	externals: {
		'@codemirror/view': 'commonjs @codemirror/view',
		'@codemirror/state': 'commonjs @codemirror/state',
		'@codemirror/lint': 'commonjs @codemirror/lint',
	},
	output: {
		filename: 'contentScript.js',
		path: distDir,
		library: 'default',
		libraryTarget: 'commonjs',
		libraryExport: 'default',
	},
};

const createArchiveConfig = {
	stats: 'errors-only',
	entry: './dist/index.js',
	resolve: { fallback: moduleFallback },
	output: { filename: 'index.js', path: publishDir },
	plugins: [
		{
			apply(compiler) {
				compiler.hooks.done.tap('archiveOnBuild', () => {
					try {
						fs.rmSync(path.resolve(publishDir, 'index.js'), { force: true });
						createPluginArchive(distDir, pluginArchiveFilePath);
					} catch (error) {
						console.error(`[spike] ${error.message}`);
						process.exit(1);
					}
				});
			},
		},
	],
};

module.exports = (env) => {
	const configName = env['joplin-plugin-config'];
	if (!configName) throw new Error('A config must be specified via --env joplin-plugin-config=');

	if (configName === 'buildMain') {
		fs.rmSync(distDir, { recursive: true, force: true });
		fs.rmSync(publishDir, { recursive: true, force: true });
		fs.mkdirSync(publishDir, { recursive: true });
		return [pluginConfig];
	}
	if (configName === 'buildExtraScripts') return [extraScriptConfig];
	if (configName === 'createArchive') return [createArchiveConfig];
	throw new Error(`Unknown config: ${configName}`);
};
