import { describe, expect, it } from 'vitest';
import {
	disabledInheritedMcp,
	OPENCODE_BUILTIN_TOOLS_OFF,
	readUserOpenCodeMcpNames
} from './opencode-config.js';
import { buildOpenCodeEmptyToolsConfig } from './opencode.js';

/**
 * `readFile` is injected in every case here. Reading the developer's real
 * `~/.config/opencode` would make this suite pass or fail depending on whose
 * machine it ran on.
 */
function fakeFs(files: Record<string, string>) {
	return (path: string): string => {
		const content = files[path];
		if (content === undefined) throw new Error(`ENOENT: ${path}`);
		return content;
	};
}

describe('readUserOpenCodeMcpNames', () => {
	it('reads every path opencode itself merges a user config from', () => {
		// The five paths were read off `--print-logs --log-level DEBUG`; missing one
		// means a server gets injected that we thought we had disabled.
		const names = readUserOpenCodeMcpNames({
			env: {},
			home: '/home/test',
			readFile: fakeFs({
				'/home/test/.config/opencode/config.json': JSON.stringify({ mcp: { a: {} } }),
				'/home/test/.config/opencode/opencode.json': JSON.stringify({ mcp: { b: {} } }),
				'/home/test/.config/opencode/opencode.jsonc': JSON.stringify({ mcp: { c: {} } }),
				'/home/test/.opencode/opencode.json': JSON.stringify({ mcp: { d: {} } }),
				'/home/test/.opencode/opencode.jsonc': JSON.stringify({ mcp: { e: {} } })
			})
		});
		expect(names).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('honours XDG_CONFIG_HOME', () => {
		const names = readUserOpenCodeMcpNames({
			env: { XDG_CONFIG_HOME: '/xdg' },
			home: '/home/test',
			readFile: fakeFs({ '/xdg/opencode/opencode.json': JSON.stringify({ mcp: { x: {} } }) })
		});
		expect(names).toEqual(['x']);
	});

	it('parses a .jsonc file with comments', () => {
		const names = readUserOpenCodeMcpNames({
			env: {},
			home: '/h',
			readFile: fakeFs({
				'/h/.opencode/opencode.jsonc': `{
					// a line comment
					"mcp": { "commented": {} } /* and a block one */
				}`
			})
		});
		expect(names).toEqual(['commented']);
	});

	it('does not strip a // inside a string value', () => {
		const names = readUserOpenCodeMcpNames({
			env: {},
			home: '/h',
			readFile: fakeFs({
				'/h/.opencode/opencode.json': JSON.stringify({
					mcp: { remote: { url: 'http://127.0.0.1:1/mcp' } }
				})
			})
		});
		expect(names).toEqual(['remote']);
	});

	it('returns an empty list rather than throwing on a missing or malformed config', () => {
		// Drafting must not break over a stray comma in a file this app does not
		// own; the `permission` deny is the second line of defence for that case.
		expect(
			readUserOpenCodeMcpNames({
				env: {},
				home: '/h',
				readFile: () => {
					throw new Error('ENOENT');
				}
			})
		).toEqual([]);
		expect(
			readUserOpenCodeMcpNames({
				env: {},
				home: '/h',
				readFile: fakeFs({ '/h/.opencode/opencode.json': '{ not json' })
			})
		).toEqual([]);
	});

	it('ignores a config with no mcp block', () => {
		expect(
			readUserOpenCodeMcpNames({
				env: {},
				home: '/h',
				readFile: fakeFs({ '/h/.opencode/opencode.json': JSON.stringify({ theme: 'dark' }) })
			})
		).toEqual([]);
	});
});

describe('disabledInheritedMcp', () => {
	it('maps names onto disable entries', () => {
		expect(disabledInheritedMcp(['a', 'b'])).toEqual({
			a: { enabled: false },
			b: { enabled: false }
		});
	});

	it('skips reserved names', () => {
		expect(disabledInheritedMcp(['a', 'whatsagent'], ['whatsagent'])).toEqual({
			a: { enabled: false }
		});
	});
});

describe('buildOpenCodeEmptyToolsConfig (drafting)', () => {
	it('has no mcp servers of its own and denies everything', () => {
		const config = buildOpenCodeEmptyToolsConfig({
			env: {},
			home: '/h',
			readFile: fakeFs({ '/h/.opencode/opencode.json': JSON.stringify({ mcp: { theirs: {} } }) })
		}) as {
			mcp: Record<string, unknown>;
			permission: Record<string, string>;
			tools: Record<string, boolean>;
		};
		// The inverse of the panel config: no allow rule, and the only `mcp` entries
		// are inherited servers being switched off.
		expect(config.permission).toEqual({ '*': 'deny' });
		expect(config.mcp).toEqual({ theirs: { enabled: false } });
		expect(config.tools).toEqual({ ...OPENCODE_BUILTIN_TOOLS_OFF });
	});

	it('no longer carries any hardcoded MCP server name', () => {
		// The four names that used to be baked in were owner-specific, shipped
		// publicly, and silently wrong on anyone else's machine.
		const serialised = JSON.stringify(
			buildOpenCodeEmptyToolsConfig({
				env: {},
				home: '/h',
				readFile: () => {
					throw new Error('ENOENT');
				}
			})
		);
		for (const leaked of ['computer-use', 'legalwork-ui', 'open-knowledge', 'pencil']) {
			expect(serialised).not.toContain(leaked);
		}
	});
});

describe('OPENCODE_BUILTIN_TOOLS_OFF', () => {
	it('is the verified thirteen-key shape, all false', () => {
		// Load-bearing: a five-key block can hang every run on opencode 1.18.9,
		// with no error and no timeout signal.
		expect(Object.keys(OPENCODE_BUILTIN_TOOLS_OFF)).toHaveLength(13);
		expect(Object.values(OPENCODE_BUILTIN_TOOLS_OFF).every((v) => v === false)).toBe(true);
		for (const key of ['bash', 'read', 'write', 'edit', 'webfetch', 'websearch']) {
			expect(OPENCODE_BUILTIN_TOOLS_OFF).toHaveProperty(key, false);
		}
	});
});
