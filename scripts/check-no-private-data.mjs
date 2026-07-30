#!/usr/bin/env node
/**
 * Durable leak gate: every 11–15 digit run in the tree must be declared in
 * `shared/test-fixtures.ts`. That file is the single allowlist home — add a
 * named export there when a new synthetic identifier is needed; do not weaken
 * this script to silence a finding.
 *
 * Optional local substring blocklist: if `scripts/private-patterns.local`
 * exists (gitignored — see `.gitignore`), each non-empty, non-`#` line is a
 * literal substring that must not appear anywhere in the scanned tree. Use it
 * for machine-specific names that must never ship (MCP server names from a
 * personal opencode config, client project codenames, etc.). Do NOT put those
 * values in this tracked script — that re-ships the disclosure. Copy
 * `scripts/private-patterns.local.example` to start. Patterns that are also
 * ordinary English words (UI copy like "pencil") will false-positive; scope
 * them carefully (e.g. `"pencil":` for a JSON key) or omit them.
 *
 * Excludes: node_modules, .git, build, and the fixtures file itself (its digit
 * runs *are* the allowlist).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesPath = join(repoRoot, 'shared', 'test-fixtures.ts');
const localPatternsPath = join(repoRoot, 'scripts', 'private-patterns.local');
const DIGITS = /[0-9]{11,15}/g;
// `release` and `dist` are packaging output. Scanning them made `npm run check`
// fail after any `dist:mac`, on a build number inside the app bundle's own
// Info.plist — a gate that cannot be run once a build exists is worse than no
// gate, because the reflex is to stop running it. They are gitignored and never
// published, so nothing in them can leak through the export.
//
// `.remember` is the same shape: gitignored local agent-session logs, which
// accumulate timestamps and ids and will eventually trip the digit rule by
// chance. It failed exactly that way on 2026-07-30. The gate's question is what
// *ships*, and the export takes tracked files only, so a gitignored working
// directory can never answer it — it can only produce a failure nobody can fix.
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'build',
	'.svelte-kit',
	'coverage',
	'release',
	'dist',
	'.remember'
]);

const fixturesSource = readFileSync(fixturesPath, 'utf8');
const allow = new Set(fixturesSource.match(DIGITS) ?? []);

if (allow.size === 0) {
	console.error('private-data check failed: shared/test-fixtures.ts exports no 11–15 digit runs');
	process.exit(1);
}

/** @type {string[]} */
const localPatterns = [];
if (existsSync(localPatternsPath)) {
	for (const raw of readFileSync(localPatternsPath, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		localPatterns.push(line);
	}
}

/** @type {{ file: string, line: number, value: string }[]} */
const findings = [];
/** @type {{ file: string, line: number, pattern: string }[]} */
const patternFindings = [];

/**
 * @param {string} dir
 */
function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full);
			continue;
		}
		if (!st.isFile()) continue;
		if (full === fixturesPath) continue;
		if (full === localPatternsPath) continue;
		// Skip binaries / lockfiles / maps — digit runs there are not identifiers.
		if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map|lock|db|sqlite3?)$/i.test(name)) continue;
		if (name === 'package-lock.json') continue;

		let text;
		try {
			text = readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		// Skip obviously-binary buffers misread as utf8.
		if (text.includes('\u0000')) continue;

		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			DIGITS.lastIndex = 0;
			let m;
			while ((m = DIGITS.exec(line)) !== null) {
				if (allow.has(m[0])) continue;
				findings.push({
					file: relative(repoRoot, full) || full,
					line: i + 1,
					value: m[0]
				});
			}
			for (const pattern of localPatterns) {
				if (line.includes(pattern)) {
					patternFindings.push({
						file: relative(repoRoot, full) || full,
						line: i + 1,
						pattern
					});
				}
			}
		}
	}
}

walk(repoRoot);

let failed = false;

if (findings.length > 0) {
	failed = true;
	console.error('private-data check failed: 11–15 digit runs not in shared/test-fixtures.ts:');
	for (const f of findings) {
		console.error(`  ${f.file}:${f.line}: ${f.value}`);
	}
	console.error(
		'  Fix: replace with a synthetic from shared/test-fixtures.ts (or export a new one there).'
	);
}

if (patternFindings.length > 0) {
	failed = true;
	console.error(
		'private-data check failed: substring from scripts/private-patterns.local found in tree:'
	);
	for (const f of patternFindings) {
		console.error(`  ${f.file}:${f.line}: matched ${JSON.stringify(f.pattern)}`);
	}
	console.error(
		'  Fix: scrub the match, or remove/narrow the pattern in the local (untracked) file.'
	);
}

if (failed) process.exit(1);

const patternNote =
	localPatterns.length > 0
		? `, ${localPatterns.length} local private-pattern${localPatterns.length === 1 ? '' : 's'}`
		: '';
console.log(
	`private-data ok: ${allow.size} allowlisted digit runs${patternNote}, no undeclared 11–15 digit identifiers`
);
