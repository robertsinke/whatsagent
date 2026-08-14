import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	asarContainsStdio,
	mcpStdioExists,
	resolveMcpLaunchPaths
} from './entry-path.js';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveMcpLaunchPaths', () => {
	it('uses the Electron resources path when present', () => {
		const paths = resolveMcpLaunchPaths({
			execPath: '/tmp/WhatsAgent.app/Contents/MacOS/WhatsAgent',
			resourcesPath: '/tmp/WhatsAgent.app/Contents/Resources'
		} as NodeJS.Process & { resourcesPath: string });
		expect(paths.command).toBe('/tmp/WhatsAgent.app/Contents/MacOS/WhatsAgent');
		expect(paths.entryPath).toBe(
			'/tmp/WhatsAgent.app/Contents/Resources/app.asar/dist/server/server/mcp/stdio.js'
		);
		expect(paths.entryReady).toBe(false);
	});

	it('falls back to /Applications when unpackaged', () => {
		const paths = resolveMcpLaunchPaths({ execPath: '/usr/local/bin/node' } as NodeJS.Process);
		expect(paths.command).toBe('/Applications/WhatsAgent.app/Contents/MacOS/WhatsAgent');
		expect(paths.entryPath).toContain('app.asar/dist/server/server/mcp/stdio.js');
	});
});

describe('mcpStdioExists', () => {
	it('is true for a real file on disk', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mcp-entry-'));
		dirs.push(dir);
		const file = join(dir, 'stdio.js');
		writeFileSync(file, 'export {}\n');
		expect(mcpStdioExists(file)).toBe(true);
	});

	it('does not treat SDK stdio.js names as the app entry', () => {
		expect(asarContainsStdio('/no/such.asar')).toBe(false);
	});
});
