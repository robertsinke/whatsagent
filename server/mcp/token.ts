import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Relative to the app data dir — same discipline as WhatsApp auth blobs. */
export const MCP_TOKEN_FILENAME = 'mcp.token';

export function mcpTokenPath(dataDir: string): string {
	return join(dataDir, MCP_TOKEN_FILENAME);
}

/** 32 CSPRNG bytes as hex — never log, never put in error messages. */
export function generateMcpToken(): string {
	return randomBytes(32).toString('hex');
}

/**
 * Write the token with 0600 perms. Creates parent dirs if needed. Does not
 * log the token.
 */
export function writeMcpTokenFile(dataDir: string, token: string): string {
	const path = mcpTokenPath(dataDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
	// mode in writeFileSync is only applied on create; force on existing files.
	chmodSync(path, 0o600);
	return path;
}

export function readMcpTokenFile(dataDir: string): string | null {
	const path = mcpTokenPath(dataDir);
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, 'utf8').trim();
	return raw.length > 0 ? raw : null;
}

/**
 * Mint a fresh token into the data dir when MCP is enabled. Never call this
 * while the surface is disabled — an unused token file is attack surface.
 */
export function ensureMcpToken(dataDir: string, override?: string): { token: string; path: string } {
	const token = override ?? generateMcpToken();
	const path = writeMcpTokenFile(dataDir, token);
	return { token, path };
}
