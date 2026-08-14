import { describe, expect, it } from 'vitest';
import {
	buildClaudeMcpAddCommand,
	buildExternalMcpConfig,
	quoteShellArg
} from './mcp-config-snippet.js';

const SPACED = {
	command: '/Applications/WhatsAgent.app/Contents/MacOS/WhatsAgent',
	entryPath:
		'/Applications/WhatsAgent.app/Contents/Resources/app.asar/dist/server/server/mcp/stdio.js',
	dataDir: '/Users/example/Library/Application Support/whatsagent-desktop'
};

const SECRETISH = 'Bearer deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function assertNoCredential(text: string): void {
	expect(text).not.toMatch(/Bearer/);
	expect(text).not.toMatch(/[0-9a-fA-F]{32,}/);
}

describe('mcp-config-snippet', () => {
	it('quotes data-dir paths that contain spaces in both outputs', () => {
		const json = buildExternalMcpConfig(SPACED);
		const cli = buildClaudeMcpAddCommand(SPACED);
		expect(json).toContain('"--data-dir"');
		expect(json).toContain(`"${SPACED.dataDir}"`);
		expect(cli).toContain(`--data-dir '${SPACED.dataDir}'`);
		expect(quoteShellArg(SPACED.dataDir)).toBe(`'${SPACED.dataDir}'`);
	});

	it('sets ELECTRON_RUN_AS_NODE on both the JSON env and the claude add command', () => {
		const json = buildExternalMcpConfig(SPACED);
		const cli = buildClaudeMcpAddCommand(SPACED);
		expect(json).toMatch(/"ELECTRON_RUN_AS_NODE": "1"/);
		expect(cli).toContain('ELECTRON_RUN_AS_NODE=1');
	});

	it('never emits a Bearer header or a 32+ hex run, even if one is nearby in the input paths', () => {
		const poisoned = {
			...SPACED,
			// A caller stuffing the token into a path would still be a bug elsewhere;
			// the builders themselves must not introduce Authorization material.
			command: SPACED.command
		};
		const json = buildExternalMcpConfig(poisoned);
		const cli = buildClaudeMcpAddCommand(poisoned);
		assertNoCredential(json);
		assertNoCredential(cli);
		expect(json).not.toContain(SECRETISH);
		expect(cli).not.toContain(SECRETISH);
		expect(json).not.toMatch(/Authorization/i);
		expect(cli).not.toMatch(/Authorization/i);
	});

	it('launches the app binary as Node, with the stdio entry and an explicit data dir', () => {
		const parsed = JSON.parse(buildExternalMcpConfig(SPACED)) as {
			mcpServers: { whatsagent: { command: string; args: string[] } };
		};
		const server = parsed.mcpServers.whatsagent;
		expect(server.command).toBe(SPACED.command);
		expect(server.args).toEqual([SPACED.entryPath, '--data-dir', SPACED.dataDir]);
	});
});
