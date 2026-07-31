#!/usr/bin/env node
/**
 * Durable leak gate over the *tracked* tree (what a publish can ship):
 *
 * 1. Every 11–15 digit run must be declared in `shared/test-fixtures.ts`.
 * 2. The runtime home-directory prefix must not appear in file contents or
 *    symlink target strings, except on paths listed in
 *    `PRIVATE_DATA_HOME_PATH_ALLOWLIST` in that same fixtures file.
 * 3. Optional local substring blocklist via `scripts/private-patterns.local`
 *    (gitignored) — machine-specific names that must never ship.
 *
 * Symlinks are inspected via lstat + readlink: git publishes the link target
 * *string* (mode 120000), not the file it points at. Following the link would
 * scan bytes that never leave the machine and miss the path that does.
 *
 * THE PASS LINE NAMES EVERY CHECK AND WHETHER IT RAN, including how many
 * symlink entries were inspected. A skipped optional half says so on stderr.
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	realpathSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIGITS = /[0-9]{11,15}/g;

const BINARY_NAME =
	/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map|lock|db|sqlite3?)$/i;

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function listTrackedFiles(repoRoot) {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: repoRoot,
		encoding: 'buffer',
		maxBuffer: 64 * 1024 * 1024
	});
	const paths = [];
	let start = 0;
	for (let i = 0; i < out.length; i++) {
		if (out[i] === 0) {
			if (i > start) paths.push(out.subarray(start, i).toString('utf8'));
			start = i + 1;
		}
	}
	if (start < out.length) paths.push(out.subarray(start).toString('utf8'));
	return paths;
}

/**
 * Home prefix used for the leak check. Derived at runtime — never hardcode a
 * username into this script (that would make the guard an instance of the
 * thing it blocks).
 * @param {() => string} [homeFn]
 */
export function homePathPrefix(homeFn = homedir) {
	const raw = homeFn();
	if (!raw || typeof raw !== 'string') {
		throw new Error('homePathPrefix: homedir() returned empty');
	}
	// Strip trailing separators so "/Users/x" and "/Users/x/" are one pattern.
	return raw.replace(/[/\\]+$/, '');
}

/**
 * Parse `PRIVATE_DATA_HOME_PATH_ALLOWLIST = [ ... ]` string literals from the
 * fixtures source. Paths only — never values that equal the home prefix.
 * @param {string} fixturesSource
 * @returns {Set<string>}
 */
export function parseHomePathAllowlist(fixturesSource) {
	const match =
		fixturesSource.match(
			/PRIVATE_DATA_HOME_PATH_ALLOWLIST\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
		) ??
		fixturesSource.match(/PRIVATE_DATA_HOME_PATH_ALLOWLIST\s*=\s*\[([\s\S]*?)\]/);
	if (!match) return new Set();
	/** @type {Set<string>} */
	const paths = new Set();
	// Line-oriented: only quoted path entries. A whole-block quote scan breaks
	// on apostrophes in comments (e.g. "unit's scope").
	for (const line of match[1].split(/\r?\n/)) {
		const entry = line.trim().match(/^['"]([^'"]+)['"]\s*,?\s*(?:\/\/.*)?$/);
		if (entry) paths.add(entry[1]);
	}
	return paths;
}

/**
 * @param {string} name
 */
export function isSkippedBinaryName(name) {
	if (BINARY_NAME.test(name)) return true;
	if (name === 'package-lock.json') return true;
	return false;
}

/**
 * @typedef {{ file: string, line: number, value: string }} DigitFinding
 * @typedef {{ file: string, line: number, pattern: string }} PatternFinding
 * @typedef {{ file: string, line: number, value: string }} HomeFinding
 * @typedef {{ file: string, reason: string }} SymlinkFinding
 *
 * @typedef {{
 *   digitFindings: DigitFinding[],
 *   homeFindings: HomeFinding[],
 *   patternFindings: PatternFinding[],
 *   symlinkFindings: SymlinkFinding[],
 *   scanned: number,
 *   symlinksInspected: number,
 * }} ScanResult
 */

/**
 * Scan one path's text (file body or symlink target string) for leaks.
 * @param {object} opts
 * @param {string} opts.relPath
 * @param {string} opts.text
 * @param {Set<string>} opts.allowDigits
 * @param {Set<string>} opts.allowHomePaths
 * @param {string} opts.homePrefix
 * @param {string[]} opts.localPatterns
 * @param {boolean} opts.skipDigitCheck
 * @param {ScanResult} opts.into
 */
export function scanText({
	relPath,
	text,
	allowDigits,
	allowHomePaths,
	homePrefix,
	localPatterns,
	skipDigitCheck,
	into
}) {
	if (text.includes('\u0000')) return;

	into.scanned += 1;
	const homeAllowed = allowHomePaths.has(relPath);
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!skipDigitCheck) {
			DIGITS.lastIndex = 0;
			let m;
			while ((m = DIGITS.exec(line)) !== null) {
				if (allowDigits.has(m[0])) continue;
				into.digitFindings.push({
					file: relPath,
					line: i + 1,
					value: m[0]
				});
			}
		}
		if (!homeAllowed && homePrefix && line.includes(homePrefix)) {
			into.homeFindings.push({
				file: relPath,
				line: i + 1,
				value: homePrefix
			});
		}
		for (const pattern of localPatterns) {
			if (line.includes(pattern)) {
				into.patternFindings.push({
					file: relPath,
					line: i + 1,
					pattern
				});
			}
		}
	}
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} [opts.trackedFiles]
 * @param {Set<string>} opts.allowDigits
 * @param {Set<string>} opts.allowHomePaths
 * @param {string} opts.homePrefix
 * @param {string[]} opts.localPatterns
 * @param {string} opts.fixturesRelPath
 * @param {string} [opts.localPatternsRelPath]
 * @returns {ScanResult}
 */
export function scanTrackedTree({
	repoRoot,
	trackedFiles,
	allowDigits,
	allowHomePaths,
	homePrefix,
	localPatterns,
	fixturesRelPath,
	localPatternsRelPath = join('scripts', 'private-patterns.local')
}) {
	/** @type {ScanResult} */
	const into = {
		digitFindings: [],
		homeFindings: [],
		patternFindings: [],
		symlinkFindings: [],
		scanned: 0,
		symlinksInspected: 0
	};

	const files = trackedFiles ?? listTrackedFiles(repoRoot);
	const fixturesPosix = fixturesRelPath.split(sep).join('/');
	const localPosix = localPatternsRelPath.split(sep).join('/');

	for (const relRaw of files) {
		const relPath = relRaw.split(sep).join('/');
		if (relPath === fixturesPosix) {
			// Digit runs here *are* the allowlist; still check home / substrings.
			const full = join(repoRoot, relRaw);
			let text;
			try {
				text = readFileSync(full, 'utf8');
			} catch {
				into.symlinkFindings.push({
					file: relPath,
					reason: 'tracked fixtures file unreadable'
				});
				continue;
			}
			scanText({
				relPath,
				text,
				allowDigits,
				allowHomePaths,
				homePrefix,
				localPatterns,
				skipDigitCheck: true,
				into
			});
			continue;
		}
		if (relPath === localPosix) continue;

		const base = relPath.includes('/')
			? relPath.slice(relPath.lastIndexOf('/') + 1)
			: relPath;
		if (isSkippedBinaryName(base)) continue;

		const full = join(repoRoot, relRaw);
		let st;
		try {
			st = lstatSync(full);
		} catch {
			into.symlinkFindings.push({
				file: relPath,
				reason: 'tracked path missing from working tree'
			});
			continue;
		}

		if (st.isSymbolicLink()) {
			into.symlinksInspected += 1;
			let target;
			try {
				target = readlinkSync(full);
			} catch (err) {
				into.symlinkFindings.push({
					file: relPath,
					reason: `readlink failed: ${err instanceof Error ? err.message : String(err)}`
				});
				continue;
			}
			// Scan the link target string — that is the git blob content.
			scanText({
				relPath,
				text: target,
				allowDigits,
				allowHomePaths,
				homePrefix,
				localPatterns,
				skipDigitCheck: false,
				into
			});
			// Dangling absolute/relative targets: report, do not follow.
			try {
				realpathSync(full);
			} catch {
				into.symlinkFindings.push({
					file: relPath,
					reason: `dangling symlink -> ${JSON.stringify(target)}`
				});
			}
			continue;
		}

		if (!st.isFile()) continue;

		let text;
		try {
			text = readFileSync(full, 'utf8');
		} catch {
			continue;
		}
		scanText({
			relPath,
			text,
			allowDigits,
			allowHomePaths,
			homePrefix,
			localPatterns,
			skipDigitCheck: false,
			into
		});
	}

	return into;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {() => string} [opts.homeFn]
 * @param {{ log?: (...a: unknown[]) => void, error?: (...a: unknown[]) => void }} [opts.console]
 * @returns {number} exit code
 */
export function runCheck(opts = {}) {
	const repoRoot =
		opts.repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..');
	const out = opts.console ?? console;
	const fixturesPath = join(repoRoot, 'shared', 'test-fixtures.ts');
	const localPatternsPath = join(repoRoot, 'scripts', 'private-patterns.local');

	const fixturesSource = readFileSync(fixturesPath, 'utf8');
	const allowDigits = new Set(fixturesSource.match(DIGITS) ?? []);
	if (allowDigits.size === 0) {
		out.error(
			'private-data check failed: shared/test-fixtures.ts exports no 11–15 digit runs'
		);
		return 1;
	}

	const allowHomePaths = parseHomePathAllowlist(fixturesSource);
	const homePrefix = homePathPrefix(opts.homeFn);

	/** @type {string[]} */
	const localPatterns = [];
	if (existsSync(localPatternsPath)) {
		for (const raw of readFileSync(localPatternsPath, 'utf8').split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith('#')) continue;
			localPatterns.push(line);
		}
	}

	const result = scanTrackedTree({
		repoRoot,
		allowDigits,
		allowHomePaths,
		homePrefix,
		localPatterns,
		fixturesRelPath: join('shared', 'test-fixtures.ts')
	});

	let failed = false;

	if (result.digitFindings.length > 0) {
		failed = true;
		out.error(
			'private-data check failed: 11–15 digit runs not in shared/test-fixtures.ts:'
		);
		for (const f of result.digitFindings) {
			out.error(`  ${f.file}:${f.line}: ${f.value}`);
		}
		out.error(
			'  Fix: replace with a synthetic from shared/test-fixtures.ts (or export a new one there).'
		);
	}

	if (result.homeFindings.length > 0) {
		failed = true;
		out.error(
			'private-data check failed: runtime home-directory path found in tracked tree:'
		);
		for (const f of result.homeFindings) {
			out.error(`  ${f.file}:${f.line}: matched home prefix`);
		}
		out.error(
			'  Fix: scrub the path, or add the relative path to PRIVATE_DATA_HOME_PATH_ALLOWLIST in shared/test-fixtures.ts with a recorded reason.'
		);
	}

	if (result.patternFindings.length > 0) {
		failed = true;
		out.error(
			'private-data check failed: substring from scripts/private-patterns.local found in tree:'
		);
		for (const f of result.patternFindings) {
			out.error(`  ${f.file}:${f.line}: matched ${JSON.stringify(f.pattern)}`);
		}
		out.error(
			'  Fix: scrub the match, or remove/narrow the pattern in the local (untracked) file.'
		);
	}

	if (result.symlinkFindings.length > 0) {
		failed = true;
		out.error('private-data check failed: symlink / tracked-path problems:');
		for (const f of result.symlinkFindings) {
			out.error(`  ${f.file}: ${f.reason}`);
		}
	}

	if (failed) return 1;

	if (result.scanned === 0) {
		out.error(
			'private-data check failed: scanned 0 files — the walk found nothing to check'
		);
		return 1;
	}

	const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
	out.log(
		`private-data ok: scanned ${plural(result.scanned, 'file')} (${result.symlinksInspected} symlink${result.symlinksInspected === 1 ? '' : 's'} inspected)`
	);
	out.log(
		`  digit-run check      RAN — ${plural(allowDigits.size, 'allowlisted run')}, no undeclared 11–15 digit identifiers`
	);
	out.log(
		`  home-path check      RAN — prefix from runtime homedir(), ${plural(allowHomePaths.size, 'allowlisted path')}, no undeclared matches`
	);
	if (localPatterns.length > 0) {
		out.log(
			`  private-substring    RAN — ${plural(localPatterns.length, 'pattern')}, no matches`
		);
	} else {
		out.error(
			`  private-substring    SKIPPED — scripts/private-patterns.local absent, so MCP server names and codenames were NOT checked (copy scripts/private-patterns.local.example to enable)`
		);
	}
	return 0;
}

function isExecutedDirectly() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(resolve(entry)).href;
	} catch {
		return false;
	}
}

if (isExecutedDirectly()) {
	process.exit(runCheck());
}
