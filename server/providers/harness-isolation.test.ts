import { describe, expect, it } from 'vitest';
import { CLAUDE_DRAFT_ISOLATION_FLAGS } from './claude.js';
import { MCP_SERVER_NAME } from '../agent/panel/harness.js';
import { OPENCODE_BUILTIN_TOOLS_OFF } from './opencode-config.js';
import { buildOpenCodeEmptyToolsConfig } from './opencode.js';
import { buildPanelOpenCodeConfig } from '../agent/panel/opencode-harness.js';
import {
	claudeDraftIsolationArgv,
	claudePanelIsolationArgv,
	claudePanelNeedsLivePort,
	draftingOpenCodeConfig,
	evaluateClaudeInitEvent,
	evaluateOpenCodeResolvedConfig,
	findClaudeInitEvent,
	mergeIsolationReport,
	OPENCODE_RUN_ISOLATION_FLAGS,
	OPENCODE_TIER1_ARGS,
	panelOpenCodeConfig,
	parseIsolationStore,
	verifyHarnessIsolation,
	type HarnessIsolationReport
} from './harness-isolation.js';
import type { SpawnProcess } from './provider.js';

describe('argv / config parity with shipped spawn paths', () => {
	it('drafting Claude argv includes every CLAUDE_DRAFT_ISOLATION_FLAGS entry', () => {
		const args = claudeDraftIsolationArgv();
		for (const flag of CLAUDE_DRAFT_ISOLATION_FLAGS) {
			expect(args).toContain(flag);
		}
		const toolsIdx = args.indexOf('--tools');
		expect(args[toolsIdx + 1]).toBe('');
	});

	it('panel Claude argv matches the harness isolation slice', () => {
		const args = claudePanelIsolationArgv('/tmp/mcp.json');
		expect(args).toContain('--tools');
		expect(args[args.indexOf('--tools') + 1]).toBe('');
		expect(args).toContain('--strict-mcp-config');
		expect(args).toContain('--mcp-config');
		expect(args).toContain('/tmp/mcp.json');
		expect(args).toContain('--no-session-persistence');
	});

	it('drafting OpenCode config is the same builder the provider uses', () => {
		const globals = {
			env: {},
			home: '/tmp/nobody',
			readFile: () => {
				throw new Error('missing');
			}
		};
		expect(draftingOpenCodeConfig(globals)).toEqual(buildOpenCodeEmptyToolsConfig(globals));
	});

	it('panel OpenCode config is the same builder the panel harness uses', () => {
		const options = {
			port: 4040,
			env: {},
			home: '/tmp/nobody',
			readFile: () => {
				throw new Error('missing');
			}
		};
		expect(panelOpenCodeConfig(options)).toEqual(buildPanelOpenCodeConfig(options));
	});

	it('OpenCode run flags match the shipped spawn prefix', () => {
		expect([...OPENCODE_RUN_ISOLATION_FLAGS]).toEqual([
			'run',
			'--auto',
			'--pure',
			'--format',
			'json'
		]);
		expect([...OPENCODE_TIER1_ARGS]).toEqual(['debug', 'config', '--pure']);
	});
});

describe('evaluateOpenCodeResolvedConfig', () => {
	const draftingPass = {
		tools: { ...OPENCODE_BUILTIN_TOOLS_OFF },
		mcp: { mail: { enabled: false as const } },
		permission: { '*': 'deny' as const }
	};

	const panelPass = {
		tools: { ...OPENCODE_BUILTIN_TOOLS_OFF },
		mcp: {
			mail: { enabled: false as const },
			[MCP_SERVER_NAME]: { enabled: true as const, type: 'remote', url: 'http://127.0.0.1:9/mcp' }
		},
		permission: { '*': 'deny' as const, [`${MCP_SERVER_NAME}*`]: 'allow' as const }
	};

	it('passes a clean drafting config', () => {
		expect(evaluateOpenCodeResolvedConfig(draftingPass, 'drafting').ok).toBe(true);
	});

	it('fails when a builtin is re-enabled', () => {
		const bad = {
			...draftingPass,
			tools: { ...OPENCODE_BUILTIN_TOOLS_OFF, read: true }
		};
		const result = evaluateOpenCodeResolvedConfig(bad, 'drafting');
		expect(result.ok).toBe(false);
		expect(result.findings.some((f) => f.code === 'builtin_enabled')).toBe(true);
	});

	it('fails when an inherited MCP server is still enabled', () => {
		const bad = {
			...draftingPass,
			mcp: { mail: { enabled: true } }
		};
		const result = evaluateOpenCodeResolvedConfig(bad, 'drafting');
		expect(result.ok).toBe(false);
		expect(result.findings.some((f) => f.code === 'mcp_enabled')).toBe(true);
	});

	it('panel expectation passes on panel config and fails on drafting config', () => {
		expect(evaluateOpenCodeResolvedConfig(panelPass, 'panel').ok).toBe(true);
		expect(evaluateOpenCodeResolvedConfig(draftingPass, 'panel').ok).toBe(false);
	});

	it('drafting expectation passes on drafting config and fails on panel config', () => {
		expect(evaluateOpenCodeResolvedConfig(draftingPass, 'drafting').ok).toBe(true);
		expect(evaluateOpenCodeResolvedConfig(panelPass, 'drafting').ok).toBe(false);
	});

	it('fails when permission default is not deny', () => {
		const bad = { ...draftingPass, permission: { '*': 'allow' } };
		expect(evaluateOpenCodeResolvedConfig(bad, 'drafting').ok).toBe(false);
	});
});

describe('evaluateClaudeInitEvent', () => {
	it('passes empty drafting surface', () => {
		expect(evaluateClaudeInitEvent({ tools: [], mcp_servers: [] }, 'drafting').ok).toBe(true);
	});

	it('fails drafting when tools are present', () => {
		const result = evaluateClaudeInitEvent({ tools: ['Read'], mcp_servers: [] }, 'drafting');
		expect(result.ok).toBe(false);
		expect(result.findings.some((f) => f.code === 'tools_present')).toBe(true);
	});

	it('fails drafting when mcp_servers are present', () => {
		const result = evaluateClaudeInitEvent(
			{ tools: [], mcp_servers: ['mail'] },
			'drafting'
		);
		expect(result.ok).toBe(false);
	});

	it('panel expects our server and rejects inherited MCP', () => {
		expect(
			evaluateClaudeInitEvent(
				{
					tools: [`mcp__${MCP_SERVER_NAME}__list-chats`],
					mcp_servers: [MCP_SERVER_NAME]
				},
				'panel'
			).ok
		).toBe(true);
		expect(
			evaluateClaudeInitEvent(
				{ tools: [], mcp_servers: ['mail', MCP_SERVER_NAME] },
				'panel'
			).ok
		).toBe(false);
	});
});

describe('isolation store helpers', () => {
	it('parses and merges reports', () => {
		expect(parseIsolationStore(undefined)).toEqual({});
		expect(parseIsolationStore('not-json')).toEqual({});
		const report: HarnessIsolationReport = {
			harness: 'claude',
			binary: 'claude',
			surface: 'drafting',
			tier: 1,
			tier1Strength: 'realized-surface',
			pinnedVersion: '2.1.220',
			detectedVersion: '2.1.220',
			verdict: 'pass',
			summary: 'ok',
			checkedAt: 1,
			findings: []
		};
		const merged = mergeIsolationReport({}, report);
		expect(merged.claude?.drafting?.verdict).toBe('pass');
	});
});

describe('Claude panel without a live port', () => {
	it('claudePanelNeedsLivePort is true only for panel + missing port', () => {
		expect(claudePanelNeedsLivePort('panel', undefined)).toBe(true);
		expect(claudePanelNeedsLivePort('panel', 8787)).toBe(false);
		expect(claudePanelNeedsLivePort('drafting', undefined)).toBe(false);
	});

	it('returns unavailable with panel_port_missing — never fail/panel_mcp_missing', async () => {
		let spawned = false;
		const spawn: SpawnProcess = ((..._args: unknown[]) => {
			spawned = true;
			throw new Error('spawn must not run when panel port is missing');
		}) as SpawnProcess;

		const report = await verifyHarnessIsolation({
			harness: 'claude',
			surface: 'panel',
			spawn,
			command: 'claude',
			now: () => 42
		});

		expect(spawned).toBe(false);
		expect(report.verdict).toBe('unavailable');
		expect(report.verdict).not.toBe('fail');
		expect(report.findings.some((f) => f.code === 'panel_port_missing')).toBe(true);
		expect(report.findings.some((f) => f.code === 'panel_mcp_missing')).toBe(false);
		expect(report.summary).toMatch(/cannot measure panel isolation/i);
		expect(report.checkedAt).toBe(42);
	});
});

describe('findClaudeInitEvent', () => {
	it('skips hook_started noise and returns subtype init', () => {
		const stdout = [
			JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }),
			JSON.stringify({
				type: 'system',
				subtype: 'init',
				tools: [`mcp__${MCP_SERVER_NAME}__list-chats`],
				mcp_servers: [{ name: MCP_SERVER_NAME, status: 'connected' }]
			}),
			JSON.stringify({ type: 'result', subtype: 'success' })
		].join('\n');
		const event = findClaudeInitEvent(stdout);
		expect(event?.subtype).toBe('init');
		expect(Array.isArray(event?.tools) && (event?.tools as unknown[]).length).toBe(1);
	});
});
