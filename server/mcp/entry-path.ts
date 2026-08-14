import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MCPX-5 — where the owner's MCP client should launch the stdio entry point.
 *
 * Inside a packaged app this is `process.resourcesPath` + the asar-relative
 * path, with `process.execPath` as the command (the app binary run as Node via
 * `ELECTRON_RUN_AS_NODE`). Unpackaged (tests, `npm run preview:ui`) there is no
 * asar, so we report the conventional `/Applications` layout — that is the
 * config the owner will paste after they install a build that includes this
 * entry. `entryReady` says whether that bundle actually contains `stdio.js`.
 */
export const DEFAULT_MCP_APP = '/Applications/WhatsAgent.app';
export const MCP_STDIO_INSIDE_ASAR = 'dist/server/server/mcp/stdio.js';

type ProcessWithResources = NodeJS.Process & { resourcesPath?: string };

export type McpLaunchPaths = {
	command: string;
	entryPath: string;
	/** True when the file the snippet points at is actually in that bundle. */
	entryReady: boolean;
};

export function resolveMcpLaunchPaths(proc: ProcessWithResources = process): McpLaunchPaths {
	const resourcesPath = proc.resourcesPath;
	const command = resourcesPath
		? proc.execPath
		: join(DEFAULT_MCP_APP, 'Contents', 'MacOS', 'WhatsAgent');
	const entryPath = resourcesPath
		? join(resourcesPath, 'app.asar', MCP_STDIO_INSIDE_ASAR)
		: join(DEFAULT_MCP_APP, 'Contents', 'Resources', 'app.asar', MCP_STDIO_INSIDE_ASAR);
	return { command, entryPath, entryReady: mcpStdioExists(entryPath) };
}

export function mcpStdioExists(entryPath: string): boolean {
	if (existsSync(entryPath)) return true;
	const asarAndInner = splitAsarPath(entryPath);
	if (!asarAndInner) return false;
	return asarContainsStdio(asarAndInner.asarFile);
}

function splitAsarPath(entryPath: string): { asarFile: string } | null {
	const posix = entryPath.replaceAll('\\', '/');
	const idx = posix.indexOf('/app.asar/');
	if (idx === -1) return null;
	return { asarFile: posix.slice(0, idx + '/app.asar'.length) };
}

/**
 * Electron's asar header is a nested `{ files: { name: { files: ... } } }`
 * tree. A substring search for `stdio.js` false-positives on the SDK copies
 * inside `node_modules`; we walk to *our* `dist/server/server/mcp` directory.
 */
export function asarContainsStdio(asarFile: string): boolean {
	if (!existsSync(asarFile)) return false;
	const tree = readAsarFilesTree(asarFile);
	if (!tree) return false;
	const mcp = tree.files?.dist?.files?.server?.files?.server?.files?.mcp?.files;
	return Boolean(mcp && 'stdio.js' in mcp);
}

type AsarDir = { files?: Record<string, AsarDir> };

function readAsarFilesTree(asarFile: string): AsarDir | null {
	let fd: number | undefined;
	try {
		const size = Math.min(statSync(asarFile).size, 4_000_000);
		const buf = Buffer.alloc(size);
		fd = openSync(asarFile, 'r');
		readSync(fd, buf, 0, size, 0);
		const start = buf.indexOf('{"files":');
		if (start < 4) return null;
		const len = buf.readUInt32LE(start - 4);
		if (len <= 0 || start + len > buf.length) return null;
		return JSON.parse(buf.subarray(start, start + len).toString('utf8')) as AsarDir;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
