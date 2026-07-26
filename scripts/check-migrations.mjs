#!/usr/bin/env node
/**
 * Migration sanity check, run as part of `npm run check`.
 *
 * `migrate()` records a single high-water version and skips anything numbered at
 * or below it, so merge ORDER is load-bearing: a lower-numbered migration merged
 * after a higher one is skipped **silently and permanently** on any database
 * that already recorded the higher number. The failure surfaces much later as a
 * missing column.
 *
 * Two parallel workers cannot see each other's migration file, so this is a
 * realistic collision, not a theoretical one — which is why the orchestrator
 * assigns numbers at dispatch. This check means a mistake fails the gate instead
 * of waiting to be noticed.
 *
 * Checks: no duplicate numbers, no gaps, and numbering starts at 1.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'store', 'migrations');
const files = readdirSync(dir).filter((n) => /^\d+.*\.sql$/.test(n)).sort();

if (files.length === 0) {
	console.error('migrations: none found in', dir);
	process.exit(1);
}

const seen = new Map();
const problems = [];

for (const file of files) {
	const version = Number.parseInt(file, 10);
	if (!Number.isFinite(version)) {
		problems.push(`${file}: filename does not start with a version number`);
		continue;
	}
	if (seen.has(version)) {
		problems.push(
			`duplicate version ${version}: ${seen.get(version)} and ${file}\n` +
				'    Two migrations claiming one number means one of them never runs on a\n' +
				'    database that already recorded it. Renumber the newer one.'
		);
		continue;
	}
	seen.set(version, file);
}

const versions = [...seen.keys()].sort((a, b) => a - b);
if (versions.length > 0 && versions[0] !== 1) {
	problems.push(`numbering starts at ${versions[0]}, expected 1`);
}
for (let i = 1; i < versions.length; i++) {
	const gap = versions[i] - versions[i - 1];
	if (gap !== 1) {
		problems.push(
			`gap between ${versions[i - 1]} (${seen.get(versions[i - 1])}) and ${versions[i]} (${seen.get(versions[i])})\n` +
				'    A gap usually means a migration was dropped or numbered past a\n' +
				'    sibling still in flight. Close it before merging.'
		);
	}
}

if (problems.length > 0) {
	console.error('migration check failed:\n');
	for (const p of problems) console.error('  * ' + p);
	console.error('');
	console.error('  See docs/solutions/2026-07-26-migration-numbering-and-high-water-mark.md');
	process.exit(1);
}

console.log(`migrations ok: ${versions.length} contiguous (001-${String(versions.at(-1)).padStart(3, '0')})`);
