#!/usr/bin/env node
/**
 * Verify the protected-branch guard is actually installed.
 *
 * `.githooks/reference-transaction` refuses updates to main from a worker
 * session, but git only runs it when `core.hooksPath` points at `.githooks` —
 * and that is LOCAL config, not something a commit can carry. A fresh clone has
 * it unset, which silently disarms the guard with no other symptom.
 *
 * A guard that can quietly uninstall itself is not a guard, so the gate checks
 * for it. Fix with:
 *
 *     git config core.hooksPath .githooks
 *
 * The guard is SlayZone orchestration, not code health. A public tree (which
 * drops the `.slayzone/` directory) has no use for it, and a stranger cloning
 * that tree should not see a failure about a worker-branch guard they do not
 * have. So this check is a no-op when `.slayzone/` is absent, and stays armed
 * when it is present — keeping the guard live on the private main tree where
 * workers must not merge to main.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const slayzoneDir = join(repoRoot, '.slayzone');
const hook = join(repoRoot, '.githooks', 'reference-transaction');

if (!existsSync(slayzoneDir)) {
	console.log('hooks ok: .slayzone absent, guard is a no-op (public tree)');
	process.exit(0);
}

function fail(message) {
	console.error(`hooks check failed: ${message}`);
	console.error('  Fix: git config core.hooksPath .githooks');
	process.exit(1);
}

let configured;
try {
	configured = execFileSync('git', ['config', 'core.hooksPath'], {
		cwd: repoRoot,
		encoding: 'utf8'
	}).trim();
} catch {
	fail('core.hooksPath is not set, so .githooks never runs');
}

if (configured !== '.githooks') fail(`core.hooksPath is "${configured}", expected ".githooks"`);

try {
	accessSync(hook, constants.X_OK);
} catch {
	fail('.githooks/reference-transaction is missing or not executable');
}

console.log('hooks ok: protected-branch guard installed');
