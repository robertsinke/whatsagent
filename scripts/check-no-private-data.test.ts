import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Plain-node .mjs gate (publish-oss runs it without a TS toolchain). Types are
// asserted here rather than via a .d.ts — server tsc does not resolve ambient
// types for explicit `.mjs` imports under this tsconfig.
type ScanResult = {
	digitFindings: { file: string; line: number; value: string }[];
	homeFindings: { file: string; line: number; value: string }[];
	patternFindings: { file: string; line: number; pattern: string }[];
	symlinkFindings: { file: string; reason: string }[];
	scanned: number;
	symlinksInspected: number;
};

type PrivateDataGate = {
	homePathPrefix: (homeFn?: () => string) => string;
	parseHomePathAllowlist: (fixturesSource: string) => Set<string>;
	scanText: (opts: {
		relPath: string;
		text: string;
		allowDigits: Set<string>;
		allowHomePaths: Set<string>;
		homePrefix: string;
		localPatterns: string[];
		skipDigitCheck: boolean;
		into: ScanResult;
	}) => void;
	scanTrackedTree: (opts: {
		repoRoot: string;
		trackedFiles?: string[];
		allowDigits: Set<string>;
		allowHomePaths: Set<string>;
		homePrefix: string;
		localPatterns: string[];
		fixturesRelPath: string;
		localPatternsRelPath?: string;
	}) => ScanResult;
	runCheck: (opts?: {
		repoRoot?: string;
		homeFn?: () => string;
		console?: {
			log?: (...a: unknown[]) => void;
			error?: (...a: unknown[]) => void;
		};
	}) => number;
};

// @ts-expect-error -- no declaration for the plain .mjs entry (see note above)
import * as gateMod from './check-no-private-data.mjs';
const {
	homePathPrefix,
	parseHomePathAllowlist,
	runCheck,
	scanText,
	scanTrackedTree
} = gateMod as PrivateDataGate;

const temps: string[] = [];

afterEach(() => {
	while (temps.length > 0) {
		const dir = temps.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'private-data-scan-'));
	temps.push(dir);
	execFileSync('git', ['init', '-q'], { cwd: dir });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
	return dir;
}

function writeTracked(repo: string, rel: string, body: string) {
	const full = join(repo, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	writeFileSync(full, body);
	execFileSync('git', ['add', '--', rel], { cwd: repo });
}

function writeTrackedSymlink(repo: string, rel: string, target: string) {
	const full = join(repo, rel);
	mkdirSync(join(full, '..'), { recursive: true });
	symlinkSync(target, full);
	execFileSync('git', ['add', '--', rel], { cwd: repo });
}

const fixturesStub = `
export const PRIVATE_DATA_HOME_PATH_ALLOWLIST = [
	'allowed/symlink'
] as const;
export const FIXTURE_PHONE = '31612345678';
`;

describe('homePathPrefix', () => {
	it('derives from the provided homedir and strips trailing separators', () => {
		expect(homePathPrefix(() => '/Users/someone/')).toBe('/Users/someone');
		expect(homePathPrefix(() => '/Users/someone')).toBe('/Users/someone');
	});

	it('does not embed a username — empty homedir is an error', () => {
		expect(() => homePathPrefix(() => '')).toThrow(/empty/);
	});
});

describe('parseHomePathAllowlist', () => {
	it('extracts path literals without requiring the home string itself', () => {
		const set = parseHomePathAllowlist(fixturesStub);
		expect([...set]).toEqual(['allowed/symlink']);
	});

	it('does not break on apostrophes inside comments in the allowlist block', () => {
		const src = `
export const PRIVATE_DATA_HOME_PATH_ALLOWLIST = [
	// keep this unit's scope narrow
	'docs/evidence/example.md',
] as const;
`;
		expect([...parseHomePathAllowlist(src)]).toEqual(['docs/evidence/example.md']);
	});
});

describe('scanText home-path hole', () => {
	it('flags a home prefix in file content with file and line', () => {
		const into = {
			digitFindings: [],
			homeFindings: [],
			patternFindings: [],
			symlinkFindings: [],
			scanned: 0,
			symlinksInspected: 0
		};
		scanText({
			relPath: 'leak.txt',
			text: 'ok\nsecret /Users/someone/dev/x\n',
			allowDigits: new Set(['31612345678']),
			allowHomePaths: new Set(),
			homePrefix: '/Users/someone',
			localPatterns: [],
			skipDigitCheck: false,
			into
		});
		expect(into.homeFindings).toEqual([
			{ file: 'leak.txt', line: 2, value: '/Users/someone' }
		]);
	});

	it('respects the path allowlist for deliberate exceptions', () => {
		const into = {
			digitFindings: [],
			homeFindings: [],
			patternFindings: [],
			symlinkFindings: [],
			scanned: 0,
			symlinksInspected: 0
		};
		scanText({
			relPath: 'allowed/symlink',
			text: '/Users/someone/.agents/hook',
			allowDigits: new Set(),
			allowHomePaths: new Set(['allowed/symlink']),
			homePrefix: '/Users/someone',
			localPatterns: [],
			skipDigitCheck: false,
			into
		});
		expect(into.homeFindings).toEqual([]);
	});
});

describe('symlink target string hole', () => {
	it('scans the link target string, not the file it points at', () => {
		const repo = tempRepo();
		mkdirSync(join(repo, 'shared'), { recursive: true });
		writeFileSync(join(repo, 'shared', 'test-fixtures.ts'), fixturesStub);
		execFileSync('git', ['add', 'shared/test-fixtures.ts'], { cwd: repo });

		// Fake home under tmp — do not write into a real /Users/... path.
		const home = mkdtempSync(join(tmpdir(), 'fixture-home-'));
		temps.push(home);
		mkdirSync(join(home, '.agents'), { recursive: true });
		const linkTarget = join(home, '.agents', 'hook.sh');
		// Body is clean; only the link *string* carries the home prefix.
		writeFileSync(linkTarget, '#!/bin/sh\necho clean body without home path\n');
		writeTrackedSymlink(repo, 'hooks/pre-commit', linkTarget);

		const result = scanTrackedTree({
			repoRoot: repo,
			allowDigits: new Set(['31612345678']),
			allowHomePaths: new Set(),
			homePrefix: home,
			localPatterns: [],
			fixturesRelPath: join('shared', 'test-fixtures.ts')
		});

		expect(result.symlinksInspected).toBe(1);
		expect(result.symlinkFindings).toEqual([]);
		expect(result.homeFindings).toEqual([
			{ file: 'hooks/pre-commit', line: 1, value: home }
		]);
	});

	it('reports a dangling symlink instead of silently skipping it', () => {
		const repo = tempRepo();
		mkdirSync(join(repo, 'shared'), { recursive: true });
		writeFileSync(join(repo, 'shared', 'test-fixtures.ts'), fixturesStub);
		execFileSync('git', ['add', 'shared/test-fixtures.ts'], { cwd: repo });
		writeTrackedSymlink(repo, 'hooks/missing', '/no/such/target/anywhere');

		const result = scanTrackedTree({
			repoRoot: repo,
			allowDigits: new Set(['31612345678']),
			allowHomePaths: new Set(),
			homePrefix: '/Users/other',
			localPatterns: [],
			fixturesRelPath: join('shared', 'test-fixtures.ts')
		});

		expect(result.symlinksInspected).toBe(1);
		expect(result.symlinkFindings.some((f) => f.file === 'hooks/missing')).toBe(
			true
		);
		expect(result.symlinkFindings[0]?.reason).toMatch(/dangling/);
	});
});

describe('tracked-tree hole', () => {
	it('ignores untracked files that a working-directory walk would see', () => {
		const repo = tempRepo();
		mkdirSync(join(repo, 'shared'), { recursive: true });
		writeFileSync(join(repo, 'shared', 'test-fixtures.ts'), fixturesStub);
		execFileSync('git', ['add', 'shared/test-fixtures.ts'], { cwd: repo });
		writeTracked(repo, 'tracked.txt', 'clean\n');

		// Untracked: would fail a cwd walk on digits / home, must not be scanned.
		writeFileSync(
			join(repo, 'untracked-leak.txt'),
			`/Users/fixture-home/secret\n99988877766655\n`
		);

		const result = scanTrackedTree({
			repoRoot: repo,
			allowDigits: new Set(['31612345678']),
			allowHomePaths: new Set(),
			homePrefix: '/Users/fixture-home',
			localPatterns: [],
			fixturesRelPath: join('shared', 'test-fixtures.ts')
		});

		expect(result.homeFindings).toEqual([]);
		expect(result.digitFindings).toEqual([]);
		expect(result.scanned).toBe(2); // fixtures + tracked.txt
	});
});

describe('runCheck integration', () => {
	it('fails naming file and line when a tracked file holds the home prefix', () => {
		const repo = tempRepo();
		mkdirSync(join(repo, 'shared'), { recursive: true });
		writeFileSync(join(repo, 'shared', 'test-fixtures.ts'), fixturesStub);
		execFileSync('git', ['add', 'shared/test-fixtures.ts'], { cwd: repo });
		writeTracked(repo, 'leak.txt', 'path /Users/fixture-home/x\n');

		const errors: string[] = [];
		const code = runCheck({
			repoRoot: repo,
			homeFn: () => '/Users/fixture-home',
			console: {
				log: () => undefined,
				error: (...a: unknown[]) => errors.push(a.map(String).join(' '))
			}
		});
		expect(code).toBe(1);
		expect(errors.join('\n')).toMatch(/leak\.txt:1/);
		expect(errors.join('\n')).toMatch(/home-directory path/);
	});

	it('passes and names the home-path check plus symlink count on a clean tree', () => {
		const repo = tempRepo();
		mkdirSync(join(repo, 'shared'), { recursive: true });
		writeFileSync(join(repo, 'shared', 'test-fixtures.ts'), fixturesStub);
		execFileSync('git', ['add', 'shared/test-fixtures.ts'], { cwd: repo });
		writeTracked(repo, 'ok.txt', 'hello\n');

		const home = mkdtempSync(join(tmpdir(), 'fixture-home-'));
		temps.push(home);
		mkdirSync(join(home, '.agents'), { recursive: true });
		const target = join(home, '.agents', 'x');
		writeFileSync(target, 'hook\n');
		writeTrackedSymlink(repo, 'allowed/symlink', target);

		const logs: string[] = [];
		const errors: string[] = [];
		const code = runCheck({
			repoRoot: repo,
			homeFn: () => home,
			console: {
				log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
				error: (...a: unknown[]) => errors.push(a.map(String).join(' '))
			}
		});
		expect(code).toBe(0);
		expect(logs.join('\n')).toMatch(/home-path check\s+RAN/);
		expect(logs.join('\n')).toMatch(/1 symlink/);
		expect(errors.join('\n')).toMatch(/private-substring\s+SKIPPED/);
	});
});
