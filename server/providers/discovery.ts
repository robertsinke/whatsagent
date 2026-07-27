import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
	buildKnownLocationDirs,
	resolveBinary,
	splitPathEnv,
	type PathResolverDeps,
	type PathSource
} from './path-resolver.js';
import type { ClaudeProviderOptions } from './claude.js';
import type { CodexProviderOptions } from './codex.js';
import type { OllamaProviderOptions } from './ollama.js';
import {
	PROVIDER_SECRET_ENV_KEYS,
	runCapturedProcess,
	sanitizedEnv,
	spawnProcess,
	type SpawnProcess
} from './provider.js';

export type DraftProviderName = 'claude' | 'codex' | 'ollama';

export type ProviderAuthState = 'unknown' | 'logged_in' | 'logged_out';

export type ProviderUnavailableReason = 'not_found' | 'probe_failed' | 'not_running';

export interface DiscoveredModelOption {
	value: string;
	label: string;
	note?: string;
	source: 'live';
}

export interface DiscoveredProvider {
	name: DraftProviderName;
	label: string;
	kind: 'cli' | 'http';
	installed: boolean;
	path: string | null;
	pathSource: PathSource | null;
	version: string | null;
	auth: ProviderAuthState;
	unavailableReason: ProviderUnavailableReason | null;
	unavailableDetail: string | null;
	models: DiscoveredModelOption[];
	modelsLive: boolean;
	defaultModel: string | null;
	allowsCustomModel: true;
	probedAt: number;
}

export interface ProviderDiscoverySnapshot {
	providers: DiscoveredProvider[];
	searchPath: string[];
	probedAt: number;
}

export interface ProviderDiscoveryDeps {
	spawn: SpawnProcess;
	fetch: typeof fetch;
	fileExists: PathResolverDeps['fileExists'];
	readTextFile: PathResolverDeps['readTextFile'];
	readdir?: PathResolverDeps['readdir'];
	env: NodeJS.ProcessEnv;
	homedir: () => string;
	platform: NodeJS.Platform;
	now: () => number;
	ollamaBaseUrl?: string;
	loginShellTimeoutMs?: number;
	versionProbeTimeoutMs?: number;
	ollamaTimeoutMs?: number;
	killGraceMs?: number;
}

export interface SnapshotOptions {
	refresh?: boolean;
}

export interface ProviderDiscovery {
	snapshot(options?: SnapshotOptions): Promise<ProviderDiscoverySnapshot>;
	invalidate(): void;
}

const BINARY_NAMES: Record<DraftProviderName, string> = {
	claude: 'claude',
	codex: 'codex',
	ollama: 'ollama'
};

const LABELS: Record<DraftProviderName, string> = {
	claude: 'Claude',
	codex: 'Codex',
	ollama: 'Ollama'
};

const POSITIVE_BINARY_TTL_MS = 10 * 60_000;
const NEGATIVE_BINARY_TTL_MS = 30_000;
const OLLAMA_TAGS_TTL_MS = 15_000;
const SEARCH_PATH_TTL_MS = 10 * 60_000;

const PATH_BEGIN = '__WA_PATH_BEGIN__';
const PATH_END = '__WA_PATH_END__';

const SEMVER_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

interface BinaryProbeResult {
	path: string | null;
	pathSource: PathSource | null;
	version: string | null;
	installed: boolean;
	unavailableReason: ProviderUnavailableReason | null;
	unavailableDetail: string | null;
	probedAt: number;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

function pathResolverDeps(deps: ProviderDiscoveryDeps): PathResolverDeps {
	return {
		fileExists: deps.fileExists,
		readTextFile: deps.readTextFile,
		readdir: deps.readdir,
		env: deps.env,
		homedir: deps.homedir,
		platform: deps.platform
	};
}

export function parseVersionLine(text: string): string | null {
	const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? '';
	const match = SEMVER_RE.exec(firstLine);
	return match?.[1] ?? null;
}

function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size <= 0) return '';
	const gib = size / 1024 ** 3;
	if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
	const mib = size / 1024 ** 2;
	return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

/**
 * Map a discovery snapshot into factory options. Omits keys when unresolved so
 * callers keep today's bare-name / default-URL fallback.
 */
export function providerFactoryOptionsFromDiscovery(
	snapshot: ProviderDiscoverySnapshot,
	ollamaBaseUrl = 'http://127.0.0.1:11434'
): {
	claude?: ClaudeProviderOptions;
	codex?: CodexProviderOptions;
	ollama?: Omit<OllamaProviderOptions, 'model'>;
} {
	const options: {
		claude?: ClaudeProviderOptions;
		codex?: CodexProviderOptions;
		ollama?: Omit<OllamaProviderOptions, 'model'>;
	} = {};
	for (const provider of snapshot.providers) {
		if (provider.name === 'claude' && provider.path) {
			options.claude = { command: provider.path };
		} else if (provider.name === 'codex' && provider.path) {
			options.codex = { command: provider.path };
		} else if (provider.name === 'ollama' && provider.installed) {
			options.ollama = { baseUrl: ollamaBaseUrl };
		}
	}
	return options;
}

/**
 * Production discovery deps: real spawn, filesystem execute-bit checks, and the
 * process environment. Boot and later the settings API both call this.
 */
export function createDefaultProviderDiscovery(
	overrides: Partial<ProviderDiscoveryDeps> = {}
): ProviderDiscovery {
	return createProviderDiscovery({
		spawn: spawnProcess,
		fetch: globalThis.fetch.bind(globalThis),
		fileExists: (filePath) => {
			try {
				accessSync(filePath, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
		readTextFile: async (filePath) => readFileSync(filePath, 'utf8'),
		readdir: async (dirPath) => readdirSync(dirPath),
		env: process.env,
		homedir,
		platform: process.platform,
		now: Date.now,
		...overrides
	});
}

export function createProviderDiscovery(deps: ProviderDiscoveryDeps): ProviderDiscovery {
	const ollamaBaseUrl = (deps.ollamaBaseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
	const loginShellTimeoutMs = deps.loginShellTimeoutMs ?? 2_500;
	const versionProbeTimeoutMs = deps.versionProbeTimeoutMs ?? 3_000;
	const ollamaTimeoutMs = deps.ollamaTimeoutMs ?? 1_500;
	const killGraceMs = deps.killGraceMs ?? 1_000;

	let binaryCache = new Map<DraftProviderName, CacheEntry<BinaryProbeResult>>();
	let ollamaTagsCache: CacheEntry<{
		models: DiscoveredModelOption[];
		modelsLive: boolean;
		unavailableReason: ProviderUnavailableReason | null;
		unavailableDetail: string | null;
	}> | null = null;
	let searchPathCache: CacheEntry<{
		envDirs: string[];
		knownDirs: string[];
		loginDirs: string[];
		loginShellFetched: boolean;
		merged: string[];
	}> | null = null;
	let inflight: Promise<ProviderDiscoverySnapshot> | null = null;

	const invalidate = () => {
		binaryCache = new Map();
		ollamaTagsCache = null;
		searchPathCache = null;
	};

	async function readLoginShellPath(): Promise<string[]> {
		if (deps.platform === 'win32') return [];
		const shell = deps.env.SHELL;
		if (!shell) return [];

		try {
			const result = await runCapturedProcess({
				command: shell,
				args: ['-ilc', `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`],
				env: sanitizedEnv(deps.env, PROVIDER_SECRET_ENV_KEYS),
				timeoutMs: loginShellTimeoutMs,
				killGraceMs,
				spawn: deps.spawn
			});
			const begin = result.stdout.indexOf(PATH_BEGIN);
			const end = result.stdout.indexOf(PATH_END);
			if (begin < 0 || end < 0 || end <= begin) return [];
			const extracted = result.stdout.slice(begin + PATH_BEGIN.length, end);
			return splitPathEnv(extracted, deps.platform);
		} catch {
			// Login-shell step must never throw.
			return [];
		}
	}

	async function resolveViaWhere(name: string): Promise<string | null> {
		if (deps.platform !== 'win32') return null;
		try {
			const result = await runCapturedProcess({
				command: 'where.exe',
				args: [name],
				env: sanitizedEnv(deps.env, PROVIDER_SECRET_ENV_KEYS),
				timeoutMs: versionProbeTimeoutMs,
				killGraceMs,
				spawn: deps.spawn
			});
			if (result.code !== 0) return null;
			const first = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find(Boolean);
			return first ?? null;
		} catch {
			return null;
		}
	}

	async function buildMergedSearchPath(needsLoginShell: boolean, refresh: boolean): Promise<{
		envDirs: string[];
		knownDirs: string[];
		loginDirs: string[];
		loginShellFetched: boolean;
		merged: string[];
	}> {
		const now = deps.now();
		const cached = !refresh && searchPathCache && searchPathCache.expiresAt > now ? searchPathCache.value : null;

		const resolver = pathResolverDeps(deps);
		const envDirs = cached?.envDirs ?? splitPathEnv(deps.env.PATH, deps.platform);
		const knownDirs = cached?.knownDirs ?? (await buildKnownLocationDirs(resolver));
		let loginDirs = cached?.loginDirs ?? [];
		let loginShellFetched = cached?.loginShellFetched ?? false;

		if (needsLoginShell && !loginShellFetched) {
			loginDirs = await readLoginShellPath();
			loginShellFetched = true;
		}

		const merged = uniquePreserveOrder([...envDirs, ...knownDirs, ...loginDirs]);
		const value = { envDirs, knownDirs, loginDirs, loginShellFetched, merged };
		searchPathCache = { value, expiresAt: now + SEARCH_PATH_TTL_MS };
		return value;
	}

	async function probeVersion(absolutePath: string): Promise<{
		ok: boolean;
		version: string | null;
		probeFailed: boolean;
	}> {
		const result = await runCapturedProcess({
			command: absolutePath,
			args: ['--version'],
			env: sanitizedEnv(deps.env, PROVIDER_SECRET_ENV_KEYS),
			timeoutMs: versionProbeTimeoutMs,
			killGraceMs,
			spawn: deps.spawn
		});
		if (result.code !== 0) {
			return { ok: false, version: null, probeFailed: true };
		}
		return { ok: true, version: parseVersionLine(result.stdout), probeFailed: false };
	}

	async function resolveOneBinary(
		name: DraftProviderName,
		paths: {
			envDirs: string[];
			knownDirs: string[];
			loginDirs: string[];
		}
	): Promise<{ path: string | null; pathSource: PathSource | null }> {
		const binary = BINARY_NAMES[name];
		const resolver = pathResolverDeps(deps);

		const fromEnv = await resolveBinary(binary, paths.envDirs, resolver);
		if (fromEnv) return { path: fromEnv, pathSource: 'env-path' };

		const fromKnown = await resolveBinary(binary, paths.knownDirs, resolver);
		if (fromKnown) return { path: fromKnown, pathSource: 'known-location' };

		if (paths.loginDirs.length > 0) {
			const fromLogin = await resolveBinary(binary, paths.loginDirs, resolver);
			if (fromLogin) return { path: fromLogin, pathSource: 'login-shell' };
		}

		const fromWhere = await resolveViaWhere(binary);
		if (fromWhere) return { path: fromWhere, pathSource: 'where' };

		return { path: null, pathSource: null };
	}

	async function probeBinary(
		name: DraftProviderName,
		paths: {
			envDirs: string[];
			knownDirs: string[];
			loginDirs: string[];
		},
		refresh: boolean
	): Promise<BinaryProbeResult> {
		const now = deps.now();
		if (!refresh) {
			const cached = binaryCache.get(name);
			if (cached && cached.expiresAt > now) return cached.value;
		}

		const resolved = await resolveOneBinary(name, paths);
		let result: BinaryProbeResult;

		if (!resolved.path) {
			result = {
				path: null,
				pathSource: null,
				version: null,
				installed: false,
				unavailableReason: 'not_found',
				unavailableDetail: `${LABELS[name]} binary not found on PATH or known install locations`,
				probedAt: now
			};
		} else if (name === 'ollama') {
			// Ollama "installed" is decided by the daemon probe, not --version.
			// Still record the path; version comes from --version when possible.
			const versionProbe = await probeVersion(resolved.path);
			result = {
				path: resolved.path,
				pathSource: resolved.pathSource,
				version: versionProbe.ok ? versionProbe.version : null,
				installed: false, // filled in after tags probe
				unavailableReason: null,
				unavailableDetail: null,
				probedAt: now
			};
		} else {
			const versionProbe = await probeVersion(resolved.path);
			if (versionProbe.probeFailed) {
				result = {
					path: resolved.path,
					pathSource: resolved.pathSource,
					version: null,
					installed: false,
					unavailableReason: 'probe_failed',
					unavailableDetail: `${LABELS[name]} at ${resolved.path} failed --version`,
					probedAt: now
				};
			} else {
				result = {
					path: resolved.path,
					pathSource: resolved.pathSource,
					version: versionProbe.version,
					installed: true,
					unavailableReason: null,
					unavailableDetail: null,
					probedAt: now
				};
			}
		}

		const ttl =
			result.path && (name === 'ollama' || result.installed)
				? POSITIVE_BINARY_TTL_MS
				: NEGATIVE_BINARY_TTL_MS;
		binaryCache.set(name, {
			value: result,
			expiresAt: now + ttl
		});
		return result;
	}

	async function probeOllamaTags(refresh: boolean): Promise<{
		models: DiscoveredModelOption[];
		modelsLive: boolean;
		unavailableReason: ProviderUnavailableReason | null;
		unavailableDetail: string | null;
	}> {
		const now = deps.now();
		if (!refresh && ollamaTagsCache && ollamaTagsCache.expiresAt > now) {
			return ollamaTagsCache.value;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs);
		try {
			const response = await deps.fetch(`${ollamaBaseUrl}/api/tags`, {
				signal: controller.signal
			});
			if (!response.ok) {
				const value = {
					models: [] as DiscoveredModelOption[],
					modelsLive: false,
					unavailableReason: 'not_running' as const,
					unavailableDetail: `Ollama daemon did not respond at ${ollamaBaseUrl}`
				};
				ollamaTagsCache = { value, expiresAt: now + OLLAMA_TAGS_TTL_MS };
				return value;
			}
			const payload = (await response.json()) as {
				models?: Array<{ name?: string; model?: string; size?: number }>;
			};
			const models: DiscoveredModelOption[] = (payload.models ?? [])
				.map((entry) => {
					const value = entry.name ?? entry.model;
					if (!value) return null;
					const note = typeof entry.size === 'number' ? formatBytes(entry.size) : undefined;
					return {
						value,
						label: value,
						...(note ? { note } : {}),
						source: 'live' as const
					};
				})
				.filter((entry): entry is DiscoveredModelOption => entry !== null);
			const value = {
				models,
				modelsLive: true,
				unavailableReason: null,
				unavailableDetail: null
			};
			ollamaTagsCache = { value, expiresAt: now + OLLAMA_TAGS_TTL_MS };
			return value;
		} catch {
			const value = {
				models: [] as DiscoveredModelOption[],
				modelsLive: false,
				unavailableReason: 'not_running' as const,
				unavailableDetail: `Ollama daemon did not respond at ${ollamaBaseUrl}`
			};
			ollamaTagsCache = { value, expiresAt: now + OLLAMA_TAGS_TTL_MS };
			return value;
		} finally {
			clearTimeout(timer);
		}
	}

	async function doSnapshot(refresh: boolean): Promise<ProviderDiscoverySnapshot> {
		const now = deps.now();
		const resolver = pathResolverDeps(deps);

		// Pass 1: env + known locations (no login shell yet).
		let paths = await buildMergedSearchPath(false, refresh);
		const names: DraftProviderName[] = ['claude', 'codex', 'ollama'];

		const firstPass = await Promise.all(
			names.map(async (name) => {
				const binary = BINARY_NAMES[name];
				const fromEnv = await resolveBinary(binary, paths.envDirs, resolver);
				if (fromEnv) return { name, resolved: true };
				const fromKnown = await resolveBinary(binary, paths.knownDirs, resolver);
				return { name, resolved: Boolean(fromKnown) };
			})
		);

		const needsLoginShell =
			deps.platform !== 'win32' && firstPass.some((entry) => !entry.resolved);

		if (needsLoginShell) {
			paths = await buildMergedSearchPath(true, refresh);
		}

		const binaryResults = await Promise.allSettled(
			names.map((name) => probeBinary(name, paths, refresh))
		);

		const tags = await probeOllamaTags(refresh);

		const providers: DiscoveredProvider[] = names.map((name, index) => {
			const settled = binaryResults[index]!;
			const binary: BinaryProbeResult =
				settled.status === 'fulfilled'
					? settled.value
					: {
							path: null,
							pathSource: null,
							version: null,
							installed: false,
							unavailableReason: 'not_found',
							unavailableDetail: `${LABELS[name]} discovery failed`,
							probedAt: now
						};

			if (name === 'ollama') {
				const installed = tags.modelsLive;
				return {
					name,
					label: LABELS[name],
					kind: 'http' as const,
					installed,
					path: binary.path,
					pathSource: binary.pathSource,
					version: binary.version,
					auth: 'unknown' as const,
					unavailableReason: installed ? null : (tags.unavailableReason ?? 'not_running'),
					unavailableDetail: installed ? null : tags.unavailableDetail,
					models: tags.models,
					modelsLive: tags.modelsLive,
					defaultModel: null,
					allowsCustomModel: true as const,
					probedAt: now
				};
			}

			return {
				name,
				label: LABELS[name],
				kind: 'cli' as const,
				installed: binary.installed,
				path: binary.path,
				pathSource: binary.pathSource,
				version: binary.version,
				auth: 'unknown' as const,
				unavailableReason: binary.unavailableReason,
				unavailableDetail: binary.unavailableDetail,
				models: [],
				modelsLive: false,
				defaultModel: null,
				allowsCustomModel: true as const,
				probedAt: binary.probedAt
			};
		});

		return {
			providers,
			searchPath: paths.merged,
			probedAt: now
		};
	}

	return {
		invalidate,
		snapshot(options: SnapshotOptions = {}) {
			const refresh = Boolean(options.refresh);
			if (inflight) return inflight;
			inflight = doSnapshot(refresh).finally(() => {
				inflight = null;
			});
			return inflight;
		}
	};
}

function uniquePreserveOrder(dirs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dir of dirs) {
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		out.push(dir);
	}
	return out;
}

// Re-export for tests that assemble PATH strings.
export { pathDelimiter } from './path-resolver.js';
