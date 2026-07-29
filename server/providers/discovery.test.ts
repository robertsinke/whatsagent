import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	createProviderDiscovery,
	parseVersionLine,
	providerFactoryOptionsFromDiscovery,
	type ProviderDiscoveryDeps
} from './discovery.js';
import { FakeChild, fakeSpawnHandler } from './fake-spawn.js';
import { PROVIDER_SECRET_ENV_KEYS } from './provider.js';

const HOME = '/home/owner';
const CLAUDE_ENV = '/usr/local/bin/claude';
const CLAUDE_LOCAL = join(HOME, '.local/bin/claude');
const OPENCODE_BIN = join(HOME, '.opencode/bin/opencode');
const OLLAMA_USR = '/usr/local/bin/ollama';
const LOGIN_BIN = join(HOME, 'login-path/bin');

function provider(snapshot: Awaited<ReturnType<ReturnType<typeof createProviderDiscovery>['snapshot']>>, name: string) {
	return snapshot.providers.find((entry) => entry.name === name)!;
}

function createDeps(overrides: Partial<ProviderDiscoveryDeps> & {
	existing?: Set<string>;
	files?: Map<string, string>;
	dirs?: Map<string, string[]>;
	clock?: { now: number };
}): ProviderDiscoveryDeps & { clock: { now: number }; existing: Set<string> } {
	const existing = overrides.existing ?? new Set<string>();
	const files = overrides.files ?? new Map<string, string>();
	const dirs = overrides.dirs ?? new Map<string, string[]>();
	const clock = overrides.clock ?? { now: 1_000_000 };
	const spawn =
		overrides.spawn ??
		fakeSpawnHandler(() => {
			throw new Error('unexpected spawn');
		}).spawn;

	return {
		spawn,
		fetch: overrides.fetch ?? (async () => new Response('fail', { status: 500 })),
		fileExists: overrides.fileExists ?? (async (path) => existing.has(path)),
		readTextFile:
			overrides.readTextFile ??
			(async (path) => {
				if (!files.has(path)) throw new Error(`missing file ${path}`);
				return files.get(path)!;
			}),
		readdir:
			overrides.readdir ??
			(async (path) => {
				if (!dirs.has(path)) throw new Error(`missing dir ${path}`);
				return dirs.get(path)!;
			}),
		env: overrides.env ?? { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' },
		homedir: overrides.homedir ?? (() => HOME),
		platform: overrides.platform ?? 'darwin',
		now: overrides.now ?? (() => clock.now),
		ollamaBaseUrl: overrides.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
		loginShellTimeoutMs: overrides.loginShellTimeoutMs ?? 50,
		versionProbeTimeoutMs: overrides.versionProbeTimeoutMs ?? 50,
		ollamaTimeoutMs: overrides.ollamaTimeoutMs ?? 50,
		killGraceMs: overrides.killGraceMs ?? 5,
		clock,
		existing
	};
}

function versionHandler(versions: Record<string, { stdout?: string; exitCode?: number | null; autoClose?: boolean }>) {
	return fakeSpawnHandler((command, args) => {
		if (args[0] === '-ilc') {
			return {
				stdout: `Welcome\n${'__WA_PATH_BEGIN__'}${LOGIN_BIN}${'__WA_PATH_END__'}\n`,
				exitCode: 0
			};
		}
		if (args[0] === '--version') {
			const entry = versions[command];
			if (!entry) return { stdout: '', exitCode: 1 };
			return entry;
		}
		if (command === 'where.exe') {
			const entry = versions[`where:${args[0]}`];
			return entry ?? { stdout: '', exitCode: 1 };
		}
		throw new Error(`unexpected command ${command} ${args.join(' ')}`);
	});
}

describe('parseVersionLine', () => {
	it('parses real Claude and OpenCode version strings', () => {
		expect(parseVersionLine('2.1.220 (Claude Code)')).toBe('2.1.220');
		expect(parseVersionLine('1.18.9')).toBe('1.18.9');
	});

	it('returns null for unparseable output', () => {
		expect(parseVersionLine('not a version')).toBeNull();
	});
});

describe('provider discovery', () => {
	it('resolves from env PATH with source env-path and never spawns a login shell', async () => {
		const existing = new Set([CLAUDE_ENV, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_ENV]: { stdout: '2.1.220 (Claude Code)\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: 'ollama version is 0.32.4\n' }
		});
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ name: 'qwen3', size: 4_000_000_000 }] }), {
					status: 200
				})
		);
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch,
			env: {
				PATH: `/usr/local/bin:${join(HOME, '.opencode/bin')}:/usr/bin`,
				HOME,
				SHELL: '/bin/zsh'
			}
		});
		// Put opencode on PATH via its install dir listed in PATH (env-path source).
		existing.add(OPENCODE_BIN);

		const discovery = createProviderDiscovery(deps);
		const snapshot = await discovery.snapshot();

		expect(provider(snapshot, 'claude')).toMatchObject({
			installed: true,
			path: CLAUDE_ENV,
			pathSource: 'env-path',
			version: '2.1.220'
		});
		expect(provider(snapshot, 'codex')).toMatchObject({
			installed: true,
			path: OPENCODE_BIN,
			pathSource: 'env-path',
			version: '1.18.9'
		});
		expect(process.calls.every((call) => call.args[0] !== '-ilc')).toBe(true);
	});

	it('resolves GUI-minimal PATH binaries from home-relative known locations', async () => {
		const existing = new Set([CLAUDE_LOCAL, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220 (Claude Code)\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: 'ollama version is 0.32.4\n' }
		});
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ name: 'llama3.2', size: 2_048_000_000 }] }), {
					status: 200
				})
		);
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch,
			env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME, SHELL: '/bin/zsh' }
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();

		expect(provider(snapshot, 'claude')).toMatchObject({
			installed: true,
			path: CLAUDE_LOCAL,
			pathSource: 'known-location',
			version: '2.1.220'
		});
		expect(provider(snapshot, 'codex')).toMatchObject({
			installed: true,
			path: OPENCODE_BIN,
			pathSource: 'known-location'
		});
		expect(provider(snapshot, 'ollama')).toMatchObject({
			installed: true,
			path: OLLAMA_USR,
			pathSource: 'known-location',
			modelsLive: true
		});
		expect(process.calls.every((call) => call.args[0] !== '-ilc')).toBe(true);
	});

	it('reads the npm prefix from .npmrc and never spawns npm', async () => {
		const prefix = join(HOME, 'custom-npm');
		const opencodePath = join(prefix, 'bin', 'opencode');
		const existing = new Set([CLAUDE_LOCAL, opencodePath, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220\n' },
			[opencodePath]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			files: new Map([[join(HOME, '.npmrc'), 'fund=false\nprefix=/home/owner/custom-npm\n']]),
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'codex').path).toBe(opencodePath);
		expect(provider(snapshot, 'codex').pathSource).toBe('known-location');
		expect(process.calls.every((call) => call.command !== 'npm')).toBe(true);
	});

	it('uses a sentinel-wrapped login-shell PATH exactly once when known locations miss', async () => {
		const loginClaude = join(LOGIN_BIN, 'claude');
		const existing = new Set([loginClaude, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[loginClaude]: { stdout: '2.1.220\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'claude')).toMatchObject({
			path: loginClaude,
			pathSource: 'login-shell',
			installed: true
		});
		expect(process.calls.filter((call) => call.args[0] === '-ilc')).toHaveLength(1);
	});

	it('login-shell timeout resolves the snapshot and kills the child', async () => {
		const existing = new Set([OPENCODE_BIN, OLLAMA_USR]);
		const children: FakeChild[] = [];
		const process = fakeSpawnHandler((command, args) => {
			if (args[0] === '-ilc') {
				const child = new FakeChild('', 0, '', false);
				children.push(child);
				return child;
			}
			if (args[0] === '--version') {
				return { stdout: '0.1.0\n', exitCode: 0 };
			}
			throw new Error(`unexpected ${command}`);
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' },
			loginShellTimeoutMs: 20,
			killGraceMs: 5
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(snapshot.providers).toHaveLength(3);
		expect(provider(snapshot, 'claude').installed).toBe(false);
		expect(children.every((child) => child.killed)).toBe(true);
	});

	it('treats login-shell output without sentinels as failure without throwing', async () => {
		const existing = new Set([OPENCODE_BIN, OLLAMA_USR]);
		const process = fakeSpawnHandler((command, args) => {
			if (args[0] === '-ilc') {
				return { stdout: 'direnv: loading\n/home/owner/login-path/bin\n', exitCode: 0 };
			}
			if (args[0] === '--version') return { stdout: '0.1.0\n', exitCode: 0 };
			throw new Error(`unexpected ${command}`);
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'claude').installed).toBe(false);
		expect(provider(snapshot, 'claude').unavailableReason).toBe('not_found');
	});

	it('strips provider API secrets from the version-probe environment', async () => {
		const existing = new Set([CLAUDE_LOCAL, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			env: {
				PATH: '/usr/bin:/bin',
				HOME,
				SHELL: '/bin/zsh',
				ANTHROPIC_API_KEY: 'api-secret',
				ANTHROPIC_AUTH_TOKEN: 'auth-secret',
				OPENAI_API_KEY: 'openai-secret',
				CODEX_API_KEY: 'codex-secret'
			}
		});

		await createProviderDiscovery(deps).snapshot();
		const versionCalls = process.calls.filter((call) => call.args[0] === '--version');
		expect(versionCalls.length).toBeGreaterThan(0);
		for (const call of versionCalls) {
			for (const key of PROVIDER_SECRET_ENV_KEYS) {
				expect(call.env[key]).toBeUndefined();
			}
		}
	});

	it('classifies version probe outcomes across exit codes and parseability', async () => {
		const good = join(HOME, '.local/bin/claude');
		const garbage = join(HOME, '.opencode/bin/opencode');
		const bad = '/usr/local/bin/ollama';
		// Only exercise claude/opencode version rules; ollama installedness is daemon-based.
		const existing = new Set([good, garbage]);
		const process = versionHandler({
			[good]: { stdout: '2.1.220 (Claude Code)\n', exitCode: 0 },
			[garbage]: { stdout: 'something weird\n', exitCode: 0 }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => {
				throw new Error('down');
			},
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});
		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'claude')).toMatchObject({
			installed: true,
			version: '2.1.220'
		});
		expect(provider(snapshot, 'codex')).toMatchObject({
			installed: true,
			version: null
		});

		const failing = versionHandler({
			[good]: { stdout: '', exitCode: 2 }
		});
		const failDeps = createDeps({
			existing: new Set([good]),
			spawn: failing.spawn,
			fetch: async () => {
				throw new Error('down');
			},
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});
		const failed = await createProviderDiscovery(failDeps).snapshot();
		expect(provider(failed, 'claude')).toMatchObject({
			installed: false,
			unavailableReason: 'probe_failed',
			path: good
		});
		void bad;
	});

	it('enumerates live Ollama models from an injected fetch', async () => {
		const existing = new Set([CLAUDE_LOCAL, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{ name: 'qwen3:latest', size: 5_000_000_000 },
							{ name: 'llama3.2', size: 2_000_000_000 }
						]
					}),
					{ status: 200 }
				)
		);
		const deps = createDeps({ existing, spawn: process.spawn, fetch });
		const snapshot = await createProviderDiscovery(deps).snapshot();
		const ollama = provider(snapshot, 'ollama');
		expect(ollama.installed).toBe(true);
		expect(ollama.modelsLive).toBe(true);
		expect(ollama.models).toEqual([
			expect.objectContaining({ value: 'qwen3:latest', source: 'live', note: expect.stringContaining('GB') }),
			expect.objectContaining({ value: 'llama3.2', source: 'live' })
		]);
	});

	it('reports ollama not_running with empty models when the daemon is down', async () => {
		const existing = new Set([CLAUDE_LOCAL, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => {
				throw new Error('ECONNREFUSED');
			}
		});
		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'ollama')).toMatchObject({
			installed: false,
			path: OLLAMA_USR,
			modelsLive: false,
			models: [],
			unavailableReason: 'not_running',
			unavailableDetail: expect.stringContaining('http://127.0.0.1:11434')
		});
		expect(provider(snapshot, 'claude').installed).toBe(true);
		expect(provider(snapshot, 'codex').installed).toBe(true);
	});

	it('single-flights concurrent snapshot calls into one spawn per binary', async () => {
		const existing = new Set([CLAUDE_LOCAL, OPENCODE_BIN, OLLAMA_USR]);
		const process = versionHandler({
			[CLAUDE_LOCAL]: { stdout: '2.1.220\n' },
			[OPENCODE_BIN]: { stdout: '1.18.9\n' },
			[OLLAMA_USR]: { stdout: '0.32.4\n' }
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
		});
		const discovery = createProviderDiscovery(deps);
		const [a, b] = await Promise.all([discovery.snapshot(), discovery.snapshot()]);
		expect(a).toEqual(b);
		const versionCalls = process.calls.filter((call) => call.args[0] === '--version');
		expect(versionCalls).toHaveLength(3);
	});

	it('honours positive TTL, negative TTL, and refresh bypass', async () => {
		const failingClaude = CLAUDE_LOCAL;
		const existing = new Set([failingClaude]);
		const process = versionHandler({
			[failingClaude]: { stdout: '', exitCode: 2 }
		});
		const clock = { now: 1_000_000 };
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			clock,
			fetch: async () => {
				throw new Error('down');
			},
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});
		const discovery = createProviderDiscovery(deps);

		// Negative probe (probe_failed): cached 30s.
		await discovery.snapshot();
		expect(process.calls.filter((c) => c.command === failingClaude)).toHaveLength(1);
		clock.now += 10_000;
		await discovery.snapshot();
		expect(process.calls.filter((c) => c.command === failingClaude)).toHaveLength(1);
		clock.now += 30_000;
		await discovery.snapshot();
		expect(process.calls.filter((c) => c.command === failingClaude)).toHaveLength(2);

		// Flip to a successful probe to exercise positive TTL + refresh.
		discovery.invalidate();
		const okProcess = versionHandler({
			[failingClaude]: { stdout: '2.1.220\n', exitCode: 0 }
		});
		const okDeps = createDeps({
			existing,
			spawn: okProcess.spawn,
			clock,
			fetch: async () => {
				throw new Error('down');
			},
			env: { PATH: '/usr/bin:/bin', HOME, SHELL: '/bin/zsh' }
		});
		const okDiscovery = createProviderDiscovery(okDeps);
		await okDiscovery.snapshot();
		expect(okProcess.calls.filter((c) => c.command === failingClaude)).toHaveLength(1);
		clock.now += 60_000;
		await okDiscovery.snapshot();
		expect(okProcess.calls.filter((c) => c.command === failingClaude)).toHaveLength(1);
		clock.now += 10 * 60_000;
		await okDiscovery.snapshot();
		expect(okProcess.calls.filter((c) => c.command === failingClaude)).toHaveLength(2);
		await okDiscovery.snapshot({ refresh: true });
		expect(okProcess.calls.filter((c) => c.command === failingClaude)).toHaveLength(3);
	});

	it('on win32 uses where.exe, tries extensions, and never spawns a login shell', async () => {
		const { win32 } = await import('node:path');
		const claudeCmd = win32.join('C:\\Users\\owner\\AppData\\Roaming', 'npm', 'claude.cmd');
		const existing = new Set([claudeCmd]);
		const process = fakeSpawnHandler((command, args) => {
			if (command === 'where.exe') {
				if (args[0] === 'opencode') return { stdout: 'C:\\Tools\\opencode.exe\n', exitCode: 0 };
				return { stdout: '', exitCode: 1 };
			}
			if (args[0] === '--version') {
				return { stdout: '1.18.9\n', exitCode: 0 };
			}
			if (args[0] === '-ilc') {
				throw new Error('login shell must not run on win32');
			}
			throw new Error(`unexpected ${command}`);
		});
		const deps = createDeps({
			existing,
			spawn: process.spawn,
			platform: 'win32',
			env: {
				PATH: 'C:\\Windows\\System32',
				APPDATA: 'C:\\Users\\owner\\AppData\\Roaming',
				LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
				HOME
			},
			homedir: () => 'C:\\Users\\owner',
			fetch: async () => {
				throw new Error('down');
			}
		});

		const snapshot = await createProviderDiscovery(deps).snapshot();
		expect(provider(snapshot, 'claude')).toMatchObject({
			path: claudeCmd,
			pathSource: 'known-location',
			installed: true
		});
		expect(provider(snapshot, 'codex')).toMatchObject({
			path: 'C:\\Tools\\opencode.exe',
			pathSource: 'where',
			installed: true
		});
		expect(process.calls.every((call) => call.args[0] !== '-ilc')).toBe(true);
	});

	it('providerFactoryOptionsFromDiscovery emits absolute command paths and omits unresolved keys', () => {
		const snapshot = {
			probedAt: 1,
			searchPath: [],
			providers: [
				{
					name: 'claude' as const,
					label: 'Claude',
					kind: 'cli' as const,
					installed: true,
					path: '/tmp/bin/claude',
					pathSource: 'known-location' as const,
					version: '2.1.220',
					auth: 'unknown' as const,
					unavailableReason: null,
					unavailableDetail: null,
					models: [],
					modelsLive: false,
					defaultModel: null,
					allowsCustomModel: true as const,
					probedAt: 1
				},
				{
					name: 'codex' as const,
					label: 'OpenCode',
					kind: 'cli' as const,
					installed: false,
					path: null,
					pathSource: null,
					version: null,
					auth: 'unknown' as const,
					unavailableReason: 'not_found' as const,
					unavailableDetail: 'missing',
					models: [],
					modelsLive: false,
					defaultModel: null,
					allowsCustomModel: true as const,
					probedAt: 1
				},
				{
					name: 'ollama' as const,
					label: 'Ollama',
					kind: 'http' as const,
					installed: true,
					path: '/usr/local/bin/ollama',
					pathSource: 'known-location' as const,
					version: '0.32.4',
					auth: 'unknown' as const,
					unavailableReason: null,
					unavailableDetail: null,
					models: [],
					modelsLive: true,
					defaultModel: null,
					allowsCustomModel: true as const,
					probedAt: 1
				}
			]
		};

		expect(providerFactoryOptionsFromDiscovery(snapshot)).toEqual({
			claude: { command: '/tmp/bin/claude' },
			ollama: { baseUrl: 'http://127.0.0.1:11434' }
		});
	});
});
