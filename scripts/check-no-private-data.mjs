#!/usr/bin/env node
/**
 * Durable leak gate: every 11–15 digit run in the tree must be declared in
 * `shared/test-fixtures.ts`. That file is the single allowlist home — add a
 * named export there when a new synthetic identifier is needed; do not weaken
 * this script to silence a finding.
 *
 * Excludes: node_modules, .git, build, and the fixtures file itself (its digit
 * runs *are* the allowlist).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesPath = join(repoRoot, 'shared', 'test-fixtures.ts');
const DIGITS = /[0-9]{11,15}/g;
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.svelte-kit', 'coverage']);

const fixturesSource = readFileSync(fixturesPath, 'utf8');
const allow = new Set(fixturesSource.match(DIGITS) ?? []);

if (allow.size === 0) {
	console.error('private-data check failed: shared/test-fixtures.ts exports no 11–15 digit runs');
	process.exit(1);
}

/** @type {{ file: string, line: number, value: string }[]} */
const findings = [];

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
		}
	}
}

walk(repoRoot);

if (findings.length > 0) {
	console.error('private-data check failed: 11–15 digit runs not in shared/test-fixtures.ts:');
	for (const f of findings) {
		console.error(`  ${f.file}:${f.line}: ${f.value}`);
	}
	console.error(
		'  Fix: replace with a synthetic from shared/test-fixtures.ts (or export a new one there).'
	);
	process.exit(1);
}

console.log(
	`private-data ok: ${allow.size} allowlisted digit runs, no undeclared 11–15 digit identifiers`
);
