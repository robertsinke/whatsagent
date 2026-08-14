import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	mcpRuntimePath,
	readMcpRuntimeFile,
	removeMcpRuntimeFile,
	writeMcpRuntimeFile,
	type McpRuntimeFile
} from './runtime.js';

const sample = (dataDir: string): Omit<McpRuntimeFile, 'version'> => ({
	pid: 4242,
	startedAt: 1_700_000_000_000,
	host: '127.0.0.1',
	port: 8787,
	url: 'http://127.0.0.1:8787/mcp',
	token: 'a'.repeat(64),
	dataDir
});

let dataDir: string | undefined;

afterEach(() => {
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('mcp runtime discovery file', () => {
	it('round-trips and writes 0600', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		const value = sample(dataDir);
		const path = writeMcpRuntimeFile(dataDir, value);
		expect(path).toBe(mcpRuntimePath(dataDir));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readMcpRuntimeFile(dataDir)).toEqual({ version: 1, ...value });
	});

	it('forces 0600 on an existing world-readable file', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		const path = writeMcpRuntimeFile(dataDir, sample(dataDir));
		chmodSync(path, 0o644);
		writeMcpRuntimeFile(dataDir, sample(dataDir));
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('returns null on a missing file and never throws', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		expect(readMcpRuntimeFile(dataDir)).toBeNull();
		expect(readMcpRuntimeFile(join(dataDir, 'no-such-dir'))).toBeNull();
	});

	it('returns null on corrupt JSON and never throws', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		writeFileSync(mcpRuntimePath(dataDir), '{not json', 'utf8');
		expect(readMcpRuntimeFile(dataDir)).toBeNull();
	});

	it('returns null when required fields are missing or mistyped', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		writeFileSync(mcpRuntimePath(dataDir), JSON.stringify({ version: 1, port: 1 }), 'utf8');
		expect(readMcpRuntimeFile(dataDir)).toBeNull();
		writeFileSync(
			mcpRuntimePath(dataDir),
			JSON.stringify({ ...sample(dataDir), version: 1, port: '8787' }),
			'utf8'
		);
		expect(readMcpRuntimeFile(dataDir)).toBeNull();
		writeFileSync(
			mcpRuntimePath(dataDir),
			JSON.stringify({ ...sample(dataDir), version: 2 }),
			'utf8'
		);
		expect(readMcpRuntimeFile(dataDir)).toBeNull();
	});

	it('remove is a no-op when the file is already gone', () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-runtime-'));
		writeMcpRuntimeFile(dataDir, sample(dataDir));
		removeMcpRuntimeFile(dataDir);
		expect(existsSync(mcpRuntimePath(dataDir))).toBe(false);
		removeMcpRuntimeFile(dataDir);
	});
});
