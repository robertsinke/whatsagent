import path from 'node:path';

export type PathSource = 'env-path' | 'known-location' | 'login-shell' | 'where';

export interface PathResolverDeps {
	fileExists: (path: string) => boolean | Promise<boolean>;
	readTextFile: (path: string) => Promise<string>;
	/** Required for nvm node version bin directories. Defaults to empty on failure. */
	readdir?: (path: string) => Promise<string[]>;
	env: NodeJS.ProcessEnv;
	homedir: () => string;
	platform: NodeJS.Platform;
}

function pathFor(platform: NodeJS.Platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

export function pathDelimiter(platform: NodeJS.Platform): string {
	return pathFor(platform).delimiter;
}

export function splitPathEnv(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
	if (!pathEnv) return [];
	return pathEnv
		.split(pathDelimiter(platform))
		.map((entry) => entry.trim())
		.filter(Boolean);
}

const POSIX_HOME_BINS = [
	'.local/bin',
	'.npm-global/bin',
	'.bun/bin',
	'.deno/bin',
	'.cargo/bin',
	'.opencode/bin',
	'.volta/bin',
	'.yarn/bin',
	'Library/pnpm'
] as const;

const POSIX_SYSTEM_BINS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] as const;

const WIN32_EXTENSIONS = ['', '.cmd', '.exe', '.ps1'] as const;

async function readNpmPrefix(deps: PathResolverDeps): Promise<string | null> {
	const { join } = pathFor(deps.platform);
	const npmrc = join(deps.homedir(), '.npmrc');
	try {
		const text = await deps.readTextFile(npmrc);
		for (const line of text.split(/\r?\n/)) {
			const match = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
			if (!match) continue;
			const raw = match[1]!.replace(/^["']|["']$/g, '');
			if (!raw) continue;
			if (raw.startsWith('~')) {
				return join(deps.homedir(), raw.slice(1).replace(/^[\\/]/, ''));
			}
			return raw;
		}
	} catch {
		// Missing or unreadable .npmrc is fine.
	}
	return null;
}

async function nvmBinDirs(deps: PathResolverDeps): Promise<string[]> {
	const readdir = deps.readdir;
	if (!readdir) return [];
	const { join } = pathFor(deps.platform);
	const versionsRoot = join(deps.homedir(), '.nvm', 'versions', 'node');
	try {
		const entries = await readdir(versionsRoot);
		return entries.map((entry) => join(versionsRoot, entry, 'bin'));
	} catch {
		return [];
	}
}

/** Home-relative and well-known install locations, all expanded from deps.homedir(). */
export async function buildKnownLocationDirs(deps: PathResolverDeps): Promise<string[]> {
	const { join } = pathFor(deps.platform);
	const home = deps.homedir();
	const dirs: string[] = [];

	if (deps.platform === 'win32') {
		const appData = deps.env.APPDATA;
		const localAppData = deps.env.LOCALAPPDATA;
		if (appData) dirs.push(join(appData, 'npm'));
		if (localAppData) {
			dirs.push(join(localAppData, 'Programs'));
			dirs.push(join(localAppData, 'Programs', 'Ollama'));
		}
	} else {
		for (const rel of POSIX_HOME_BINS) {
			dirs.push(join(home, rel));
		}
		dirs.push(...POSIX_SYSTEM_BINS);
		dirs.push(...(await nvmBinDirs(deps)));
	}

	const npmPrefix = await readNpmPrefix(deps);
	if (npmPrefix) {
		// npm prefix is the root; binaries live in its `bin` (posix) or at the
		// prefix itself / `bin` depending on how it was configured.
		dirs.push(npmPrefix);
		dirs.push(join(npmPrefix, 'bin'));
	}

	return uniquePreserveOrder(dirs);
}

/** Full search path: env PATH dirs first, then known locations (deduped). */
export async function buildSearchPath(deps: PathResolverDeps): Promise<string[]> {
	return uniquePreserveOrder([
		...splitPathEnv(deps.env.PATH, deps.platform),
		...(await buildKnownLocationDirs(deps))
	]);
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

async function isExecutable(filePath: string, deps: PathResolverDeps): Promise<boolean> {
	return Boolean(await deps.fileExists(filePath));
}

function candidatesFor(dir: string, name: string, platform: NodeJS.Platform): string[] {
	const base = pathFor(platform).join(dir, name);
	if (platform === 'win32') {
		return WIN32_EXTENSIONS.map((ext) => (ext ? `${base}${ext}` : base));
	}
	return [base];
}

/** Resolve `name` against an ordered list of directories. Returns the first hit. */
export async function resolveBinary(
	name: string,
	searchPath: readonly string[],
	deps: PathResolverDeps
): Promise<string | null> {
	for (const dir of searchPath) {
		for (const candidate of candidatesFor(dir, name, deps.platform)) {
			if (await isExecutable(candidate, deps)) return candidate;
		}
	}
	return null;
}

export function resolveSourceForDir(
	dir: string,
	envDirs: readonly string[],
	knownDirs: readonly string[],
	loginDirs: readonly string[]
): PathSource {
	if (envDirs.includes(dir)) return 'env-path';
	if (knownDirs.includes(dir)) return 'known-location';
	if (loginDirs.includes(dir)) return 'login-shell';
	return 'known-location';
}

/** Find which search-path bucket produced a resolved absolute path. */
export function sourceForResolvedPath(
	resolved: string,
	envDirs: readonly string[],
	knownDirs: readonly string[],
	loginDirs: readonly string[],
	platform: NodeJS.Platform
): PathSource {
	const dir = pathFor(platform).dirname(resolved);
	if (envDirs.includes(dir)) return 'env-path';
	if (knownDirs.includes(dir)) return 'known-location';
	if (loginDirs.includes(dir)) return 'login-shell';
	if (platform === 'win32') return 'where';
	return 'known-location';
}
