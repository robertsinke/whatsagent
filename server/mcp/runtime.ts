import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Relative to the app data dir — same directory as `mcp.token`. */
export const MCP_RUNTIME_FILENAME = 'mcp-runtime.json';
export const MCP_RUNTIME_VERSION = 1;

export type McpRuntimeFile = {
	version: number;
	pid: number;
	startedAt: number;
	host: string;
	port: number;
	/** Full MCP URL, including `MCP_PATH`, so no caller re-derives it. */
	url: string;
	token: string;
	dataDir: string;
};

export function mcpRuntimePath(dataDir: string): string {
	return join(dataDir, MCP_RUNTIME_FILENAME);
}

/**
 * Write the discovery file with 0600 perms. Creates parent dirs if needed.
 * The file carries the bearer token — never log it, never put it in an error.
 */
export function writeMcpRuntimeFile(
	dataDir: string,
	value: Omit<McpRuntimeFile, 'version'>
): string {
	const path = mcpRuntimePath(dataDir);
	mkdirSync(dirname(path), { recursive: true });
	const body: McpRuntimeFile = { version: MCP_RUNTIME_VERSION, ...value };
	writeFileSync(path, `${JSON.stringify(body, null, '\t')}\n`, {
		encoding: 'utf8',
		mode: 0o600
	});
	// mode in writeFileSync is only applied on create; force on existing files.
	chmodSync(path, 0o600);
	return path;
}

/**
 * Missing or corrupt → `null`. Never throws: a bad discovery file must not
 * take down a reader (Unit D falls back to headless).
 */
export function readMcpRuntimeFile(dataDir: string): McpRuntimeFile | null {
	const path = mcpRuntimePath(dataDir);
	try {
		if (!existsSync(path)) return null;
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return parseMcpRuntimeFile(parsed);
	} catch {
		return null;
	}
}

export function removeMcpRuntimeFile(dataDir: string): void {
	rmSync(mcpRuntimePath(dataDir), { force: true });
}

function parseMcpRuntimeFile(value: unknown): McpRuntimeFile | null {
	if (value === null || typeof value !== 'object') return null;
	const rec = value as Record<string, unknown>;
	if (rec.version !== MCP_RUNTIME_VERSION) return null;
	if (!isFiniteNumber(rec.pid) || !isFiniteNumber(rec.startedAt) || !isFiniteNumber(rec.port)) {
		return null;
	}
	if (
		typeof rec.host !== 'string' ||
		typeof rec.url !== 'string' ||
		typeof rec.token !== 'string' ||
		typeof rec.dataDir !== 'string'
	) {
		return null;
	}
	if (rec.token.length === 0 || rec.url.length === 0 || rec.host.length === 0) return null;
	return {
		version: MCP_RUNTIME_VERSION,
		pid: rec.pid,
		startedAt: rec.startedAt,
		host: rec.host,
		port: rec.port,
		url: rec.url,
		token: rec.token,
		dataDir: rec.dataDir
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
