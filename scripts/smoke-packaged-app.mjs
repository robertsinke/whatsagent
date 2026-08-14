#!/usr/bin/env node
/**
 * Packaging smoke test: prove the shipped .app can actually start.
 *
 * Usage:
 *   node scripts/smoke-packaged-app.mjs [path/to/WhatsAgent.app]
 *   node scripts/smoke-packaged-app.mjs --self-test   (proves the gate can fail)
 *
 * Defaults to release/mac-arm64/WhatsAgent.app, falling back to the installed
 * /Applications/WhatsAgent.app.
 *
 * ## Why this exists, and why no existing check could have caught it
 *
 * On 2026-07-30 a build shipped with `@modelcontextprotocol/sdk` — a declared
 * runtime dependency, imported at the top of `server/index.ts` — completely
 * absent from the bundle. The app would have failed on launch. Every gate was
 * green: `npm run check`, 870 tests, `tsc`, and the build itself all exited 0.
 *
 * The dependency was missing from `node_modules` in the working copy too (a
 * merged manifest change with no reinstall). Node's module resolution walks
 * *upward*, so an unrelated `~/node_modules` on the developer's machine
 * satisfied every import — for tsc, for vitest, for everything running from the
 * repo. Only electron-builder looked strictly inside the project, and all it
 * did was log `cannot find path for dependency` and exit 0.
 *
 * The general shape: **a check that resolves modules from the repo can never
 * see what the bundle contains.** `smoke-compiled-server.mjs` runs against
 * `dist/` with the repo's `node_modules` on the resolution path, so it is
 * structurally blind to this class — it is not a weaker version of this script,
 * it is a different question. This one runs *inside the shipped bundle*, using
 * the bundle's own Electron binary via `ELECTRON_RUN_AS_NODE=1`, which is the
 * only runtime that reads the asar and resolves the way the real app does.
 *
 * ## Why it does not launch the app
 *
 * Booting the real bundle would open a WhatsApp socket and a window. Importing
 * the compiled entry point instead exercises the entire static import graph —
 * which is exactly what breaks when a dependency is missing — with no socket,
 * no window, and no data directory touched. A missing module fails at import,
 * before any of this app's own code runs, so import is where to catch it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const selfTest = args.includes('--self-test');
const explicit = args.find((a) => !a.startsWith('--'));

// An explicit path is an assertion about which artifact to check, so a missing
// one is an error rather than a reason to fall back — silently checking a
// *different* bundle than the one named would report PASS about the wrong thing,
// which is the failure mode this whole script exists to prevent.
if (explicit && !existsSync(resolve(explicit))) {
	console.error(`smoke:packaged FAIL — no bundle at ${resolve(explicit)}`);
	process.exit(1);
}

const CANDIDATES = explicit
	? [resolve(explicit)]
	: [join(repoRoot, 'release', 'mac-arm64', 'WhatsAgent.app'), '/Applications/WhatsAgent.app'];

const appPath = CANDIDATES.find((p) => existsSync(p));
if (!appPath) {
	console.error('smoke:packaged FAIL — no .app found. Looked in:');
	for (const c of CANDIDATES) console.error(`  ${c}`);
	console.error('  Run `npm run dist:mac` first, or pass a path.');
	process.exit(1);
}

const electron = join(appPath, 'Contents', 'MacOS', 'WhatsAgent');
const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');

for (const required of [electron, asar]) {
	if (!existsSync(required)) {
		console.error(`smoke:packaged FAIL — ${appPath} is not a whatsagent bundle (missing ${required})`);
		process.exit(1);
	}
}

console.log(`smoke:packaged: checking ${appPath}`);

// The manifest is read from INSIDE the bundle, not from the repo. The script can
// be pointed at an installed app older than the checkout, and comparing that
// bundle's modules against the checkout's manifest would report a failure that
// says nothing about the artifact under test.
//
// `--self-test` appends a name no bundle can contain, which is how the failing
// branch stays exercised instead of merely written. A gate nobody has watched
// fail is a gate nobody has tested.
const probe = `
const fs = require('fs');
const asar = ${JSON.stringify(asar)};
const unpacked = ${JSON.stringify(unpacked)};
const manifest = require(asar + '/package.json');
const deps = Object.keys(manifest.dependencies || {});
${selfTest ? "deps.push('@whatsagent/deliberately-absent-self-test');" : ''}

const present = (d) =>
	fs.existsSync(asar + '/node_modules/' + d + '/package.json') ||
	fs.existsSync(unpacked + '/node_modules/' + d + '/package.json');
const missing = deps.filter((d) => !present(d));

const spa = fs.existsSync(asar + '/build/index.html');
const entry = asar + '/dist/server/server/index.js';
const hasEntry = fs.existsSync(entry);

const report = (extra) =>
	console.log(JSON.stringify({ version: manifest.version, total: deps.length, missing, spa, hasEntry, ...extra }));

if (missing.length > 0 || !hasEntry) {
	// Do not attempt the import when a dependency is already known missing: the
	// import error would be a confusing second symptom of the same cause.
	report({ imported: false });
	process.exit(0);
}

import('file://' + entry).then(
	(m) => report({ imported: typeof m.createApp === 'function' }),
	(err) => report({ imported: false, importError: String(err && err.message).slice(0, 300) })
);
`;

let raw;
try {
	raw = execFileSync(electron, ['-e', probe], {
		encoding: 'utf8',
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120_000
	});
} catch (err) {
	console.error('smoke:packaged FAIL — the bundle could not run its own probe:');
	console.error(`  ${String(err.message).slice(0, 300)}`);
	if (err.stderr) console.error(`  ${String(err.stderr).slice(0, 500)}`);
	process.exit(1);
}

let result;
try {
	result = JSON.parse(raw.trim().split('\n').pop());
} catch {
	console.error('smoke:packaged FAIL — probe produced no readable result:');
	console.error(raw.slice(0, 500));
	process.exit(1);
}

const failures = [];

if (result.missing.length > 0) {
	failures.push(
		`${result.missing.length} declared dependenc${result.missing.length === 1 ? 'y is' : 'ies are'} not in the bundle: ${result.missing.join(', ')}\n` +
			'    The app imports these at startup and will fail to launch.\n' +
			'    Usual cause: a merged manifest change with no `npm install` here, so\n' +
			'    electron-builder could not resolve it (it logs `cannot find path for\n' +
			'    dependency` and still exits 0). Run `npm install`, then rebuild.'
	);
}
if (!result.hasEntry) failures.push('the compiled server entry is missing from the bundle');
if (!result.spa) failures.push('the built SPA (build/index.html) is missing from the bundle');
if (!result.imported && result.missing.length === 0 && result.hasEntry) {
	failures.push(
		`the compiled server entry did not import inside the bundle: ${result.importError ?? 'createApp was not exported'}`
	);
}

if (failures.length > 0) {
	console.error(`smoke:packaged FAIL — ${appPath} (v${result.version})`);
	for (const f of failures) console.error(`  - ${f}`);
	if (selfTest) {
		console.error('');
		console.error('  (--self-test: this failure is the point — the gate can fail.)');
	}
	process.exit(1);
}

// MCPX-4 — the stdio MCP entry point, exercised the way the owner's MCP client
// actually launches it: the bundle's own binary as Node, the hardcoded asar
// path, a scratch data dir. This is the ONLY place that path is really run.
// `npm test` spawns the TypeScript source, which cannot tell us whether
// better-sqlite3 and the MCP SDK resolve *inside the asar* — the exact class of
// failure this whole script exists for.
const stdioEntry = join(asar, 'dist', 'server', 'server', 'mcp', 'stdio.js');
const scratch = mkdtempSync(join(tmpdir(), 'whatsagent-smoke-mcp-'));
try {
	// Migrate the scratch dir with the BUNDLE's own migrations and arm the same
	// `mcp_enabled` row the Settings toggle writes, so the entry point is asked
	// the real question rather than a startup refusal.
	execFileSync(
		electron,
		[
			'-e',
			`
			const { openDatabase } = require(${JSON.stringify(join(asar, 'dist', 'server', 'server', 'store', 'db.js'))});
			const db = openDatabase({ dataDir: ${JSON.stringify(scratch)} });
			db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('mcp_enabled', 'true');
			db.close();
			`
		],
		{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 60_000 }
	);

	const initialize = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'smoke:packaged', version: '0' }
		}
	});
	// Spawned rather than `execFileSync`, and killed once the frame arrives: a
	// healthy MCP server does NOT exit after answering, so waiting for exit
	// would turn a pass into a timeout.
	const answer = await new Promise((resolveFrame, rejectFrame) => {
		const child = spawn(electron, [stdioEntry, '--data-dir', scratch], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		const done = (value) => {
			clearTimeout(timer);
			child.kill('SIGKILL');
			resolveFrame(value);
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			rejectFrame(new Error(`no initialize response in 60s. stderr: ${stderr.slice(0, 400)}`));
		}, 60_000);
		child.stderr.on('data', (c) => {
			stderr += c.toString();
		});
		child.stdout.on('data', (c) => {
			stdout += c.toString();
			// stdout is newline-delimited JSON-RPC and nothing else — the entry
			// point redirects every stdout console method to stderr so this holds.
			for (const line of stdout.split('\n')) {
				if (!line.trim().startsWith('{')) continue;
				try {
					const frame = JSON.parse(line);
					if (frame.id === 1) done(frame);
				} catch {
					// Partial line; wait for the rest.
				}
			}
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			rejectFrame(err);
		});
		child.stdin.write(`${initialize}\n`);
	});
	if (answer?.result?.serverInfo?.name !== 'whatsagent') {
		console.error('smoke:packaged FAIL — the stdio MCP entry point did not answer initialize:');
		console.error(`  ${JSON.stringify(answer).slice(0, 500)}`);
		process.exit(1);
	}
} catch (err) {
	console.error('smoke:packaged FAIL — the stdio MCP entry point did not run inside the bundle:');
	console.error(`  ${String(err.message).slice(0, 300)}`);
	if (err.stderr) console.error(`  ${String(err.stderr).slice(0, 500)}`);
	process.exit(1);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

if (selfTest) {
	console.error('smoke:packaged FAIL — --self-test passed, which means the check is not checking.');
	process.exit(1);
}

console.log(
	`smoke:packaged PASS — v${result.version}: ${result.total} dependencies present, SPA bundled, ` +
		'compiled server imports inside the bundle, stdio MCP entry answers initialize'
);
