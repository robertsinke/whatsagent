import { describe, expect, it } from 'vitest';
import { upsertAgentPart, type AgentPart } from '../../../shared/agent-events.js';
import {
	buildPanelClaudeMcpConfig,
	translateClaudeEvent,
	type ClaudeCallIndex
} from './claude-harness.js';
import { buildPanelOpenCodeConfig, translateOpenCodeEvent } from './opencode-harness.js';
import type { PanelTurn } from './harness.js';

const turn: PanelTurn = { sessionId: 'panel-1', messageId: 'msg-1', text: 'hi', history: [] };

/**
 * The event literals below are trimmed copies of REAL captures — opencode 1.18.9
 * `run --auto --pure --format json` and Claude Code 2.1.220 `-p --output-format
 * stream-json` — against the app's own `/mcp`. They are the contract these
 * adapters exist to translate, so they are pinned rather than invented.
 */

describe('translateOpenCodeEvent', () => {
	it('translates a step-start into a step-start part carrying OUR ids', () => {
		const part = translateOpenCodeEvent(
			{
				type: 'step_start',
				sessionID: 'ses_opencode',
				part: {
					id: 'prt_a',
					messageID: 'msg_opencode',
					sessionID: 'ses_opencode',
					type: 'step-start'
				}
			},
			turn
		);
		// opencode's own session/message ids are deliberately discarded: the panel
		// groups by ours, and they must be stable across harnesses.
		expect(part).toEqual({
			kind: 'step-start',
			sessionId: 'panel-1',
			messageId: 'msg-1',
			partId: 'prt_a'
		});
	});

	it('translates text as a full snapshot with no delta', () => {
		const part = translateOpenCodeEvent(
			{
				type: 'text',
				part: { id: 'prt_t', type: 'text', text: 'hello', time: { start: 1, end: 2 } }
			},
			turn
		);
		// `part.text` is the whole accumulated string, so emitting a delta as well
		// would double the text through `mergeAgentText`.
		expect(part).toMatchObject({ kind: 'text', text: 'hello', partId: 'prt_t' });
	});

	it('translates a completed tool call, normalizing the name and parsing the body', () => {
		const part = translateOpenCodeEvent(
			{
				type: 'tool_use',
				part: {
					type: 'tool',
					tool: 'whatsagent_mark-read',
					callID: 'call_1',
					id: 'prt_tool',
					state: {
						status: 'completed',
						input: { chatJid: 'a@s.whatsapp.net' },
						output: '{"jid":"a@s.whatsapp.net","unread":0}'
					}
				}
			},
			turn
		);
		expect(part).toEqual({
			kind: 'tool',
			sessionId: 'panel-1',
			messageId: 'msg-1',
			partId: 'prt_tool',
			name: 'mark-read',
			input: { chatJid: 'a@s.whatsapp.net' },
			state: 'complete',
			output: { jid: 'a@s.whatsapp.net', unread: 0 }
		});
	});

	it('surfaces a dispatcher refusal as an error part with the message, not the envelope', () => {
		const part = translateOpenCodeEvent(
			{
				type: 'tool_use',
				part: {
					type: 'tool',
					tool: 'whatsagent_send',
					id: 'prt_err',
					state: {
						status: 'error',
						input: { chatJid: 'a@s.whatsapp.net', text: 'hi' },
						error: '{"error":"Caller not permitted","status":403,"action":"send","caller":"tool"}'
					}
				}
			},
			turn
		);
		expect(part).toMatchObject({
			kind: 'tool',
			name: 'send',
			state: 'error',
			error: 'Caller not permitted (403)'
		});
	});

	it('ignores events with no part and unknown part types', () => {
		expect(translateOpenCodeEvent({ type: 'unknown' }, turn)).toBeNull();
		expect(translateOpenCodeEvent({ part: { type: 'reasoning' } }, turn)).toBeNull();
		// Empty text is not a renderable part.
		expect(translateOpenCodeEvent({ part: { id: 'p', type: 'text', text: '' } }, turn)).toBeNull();
	});
});

describe('translateClaudeEvent', () => {
	it('emits a running tool part on the call and completes it on the result', () => {
		const calls: ClaudeCallIndex = new Map();
		const onCall = translateClaudeEvent(
			{
				type: 'assistant',
				message: {
					id: 'msg_claude',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_1',
							name: 'mcp__whatsagent__mark-read',
							input: { chatJid: 'a@s.whatsapp.net' }
						}
					]
				}
			},
			turn,
			calls
		);
		// Claude emits the call before the result, so it is genuinely in flight —
		// the panel shows it spinning rather than appearing already finished.
		expect(onCall).toEqual([
			{ kind: 'step-start', sessionId: 'panel-1', messageId: 'msg-1', partId: 'msg_claude-step' },
			{
				kind: 'tool',
				sessionId: 'panel-1',
				messageId: 'msg-1',
				partId: 'tool-toolu_1',
				name: 'mark-read',
				input: { chatJid: 'a@s.whatsapp.net' },
				state: 'running'
			}
		]);

		const onResult = translateClaudeEvent(
			{
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_1',
							content: [{ type: 'text', text: '{"jid":"a@s.whatsapp.net","unread":0}' }]
						}
					]
				}
			},
			turn,
			calls
		);
		expect(onResult[0]).toMatchObject({
			kind: 'tool',
			// Same partId, so `upsertAgentPart` updates the line in place instead of
			// appending a second one.
			partId: 'tool-toolu_1',
			name: 'mark-read',
			state: 'complete',
			output: { jid: 'a@s.whatsapp.net', unread: 0 }
		});
		expect(onResult[1]).toMatchObject({ kind: 'step-finish' });
	});

	it('marks an is_error tool_result as an error part', () => {
		const calls: ClaudeCallIndex = new Map([
			['toolu_2', { partId: 'tool-toolu_2', name: 'send', input: {} }]
		]);
		const parts = translateClaudeEvent(
			{
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'toolu_2',
							is_error: true,
							content: [
								{ type: 'text', text: '{"error":"Caller not permitted","status":403}' }
							]
						}
					]
				}
			},
			turn,
			calls
		);
		expect(parts[0]).toMatchObject({
			kind: 'tool',
			state: 'error',
			error: 'Caller not permitted (403)'
		});
		expect(parts[0]).not.toHaveProperty('output');
	});

	it('drops thinking blocks and keeps text', () => {
		const parts = translateClaudeEvent(
			{
				type: 'assistant',
				message: {
					id: 'msg_x',
					content: [
						{ type: 'thinking', thinking: 'secret', signature: 'sig' },
						{ type: 'text', text: 'Marked as read.' }
					]
				}
			},
			turn,
			new Map()
		);
		// `thinking` is not an AgentPart kind and the panel has nowhere to put it;
		// inventing a kind for it would change a shipped union for cosmetics.
		expect(parts.filter((p) => p.kind === 'text')).toHaveLength(1);
		expect(parts.some((p) => JSON.stringify(p).includes('secret'))).toBe(false);
	});

	it('ignores the noise events a real transcript is full of', () => {
		const calls: ClaudeCallIndex = new Map();
		for (const event of [
			{ type: 'system', subtype: 'hook_started' },
			{ type: 'system', subtype: 'hook_response' },
			{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
			{ type: 'result', subtype: 'success', is_error: false }
		]) {
			expect(translateClaudeEvent(event, turn, calls)).toEqual([]);
		}
	});

	it('ignores a tool_result whose call was never seen', () => {
		// Without the guard this would emit a tool part with an undefined name.
		expect(
			translateClaudeEvent(
				{
					type: 'user',
					message: {
						content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }]
					}
				},
				turn,
				new Map()
			)
		).toEqual([]);
	});
});

describe('the two adapters agree once merged', () => {
	// The panel renders whatever `upsertAgentPart` accumulated, so the real
	// requirement is that both harnesses reduce to the same shape for the same
	// work. This is what makes the provider-agnostic claim testable at all.
	it('produces one complete mark-read tool line either way', () => {
		const reduce = (parts: AgentPart[]) =>
			parts.reduce<AgentPart[]>((acc, part) => upsertAgentPart(acc, part), []);

		const fromOpenCode = reduce([
			translateOpenCodeEvent(
				{
					part: {
						type: 'tool',
						tool: 'whatsagent_mark-read',
						id: 'prt',
						state: { status: 'completed', input: { chatJid: 'a' }, output: '{"unread":0}' }
					}
				},
				turn
			)!
		]);

		const calls: ClaudeCallIndex = new Map();
		const fromClaude = reduce([
			...translateClaudeEvent(
				{
					type: 'assistant',
					message: {
						id: 'm',
						content: [
							{
								type: 'tool_use',
								id: 't1',
								name: 'mcp__whatsagent__mark-read',
								input: { chatJid: 'a' }
							}
						]
					}
				},
				turn,
				calls
			),
			...translateClaudeEvent(
				{
					type: 'user',
					message: {
						content: [
							{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"unread":0}' }] }
						]
					}
				},
				turn,
				calls
			)
		]);

		const tool = (parts: AgentPart[]) => parts.find((p) => p.kind === 'tool');
		expect(tool(fromOpenCode)).toMatchObject({
			name: 'mark-read',
			state: 'complete',
			input: { chatJid: 'a' },
			output: { unread: 0 }
		});
		expect(tool(fromClaude)).toMatchObject({
			name: 'mark-read',
			state: 'complete',
			input: { chatJid: 'a' },
			output: { unread: 0 }
		});
	});
});

describe('the panel configs are the inverse of the drafting one', () => {
	const read = (path: string): string => {
		if (path.endsWith('.config/opencode/opencode.json')) {
			return JSON.stringify({ mcp: { 'some-tool': { enabled: true } } });
		}
		throw new Error('ENOENT');
	};

	it('mounts whatsagent, denies everything else, and keeps every builtin off', () => {
		const config = buildPanelOpenCodeConfig({
			port: 9412,
			env: {},
			home: '/home/test',
			readFile: read
		}) as {
			mcp: Record<string, { enabled?: boolean; url?: string }>;
			permission: Record<string, string>;
			tools: Record<string, boolean>;
		};
		expect(config.mcp.whatsagent).toMatchObject({
			type: 'remote',
			url: 'http://127.0.0.1:9412/mcp',
			enabled: true
		});
		expect(config.permission).toEqual({ '*': 'deny', 'whatsagent*': 'allow' });
		// The panel needs OUR tools and STILL no builtins. All thirteen keys are
		// present — a hand-rolled shorter block can hang every run (PL-S3).
		expect(Object.keys(config.tools)).toHaveLength(13);
		expect(Object.values(config.tools).every((v) => v === false)).toBe(true);
	});

	it('disables MCP servers inherited from the user config', () => {
		const config = buildPanelOpenCodeConfig({
			port: 1,
			env: {},
			home: '/home/test',
			readFile: read
		}) as { mcp: Record<string, { enabled?: boolean }> };
		// Verified necessary, not defensive: under `--pure` with no disable block,
		// the owner's own global MCP tools appeared in the tool list.
		expect(config.mcp['some-tool']).toEqual({ enabled: false });
	});

	it('does not let a user-defined `whatsagent` server shadow ours', () => {
		const config = buildPanelOpenCodeConfig({
			port: 1,
			env: {},
			home: '/home/test',
			readFile: () => JSON.stringify({ mcp: { whatsagent: { enabled: true } } })
		}) as { mcp: Record<string, { enabled?: boolean; type?: string }> };
		expect(config.mcp.whatsagent).toMatchObject({ type: 'remote', enabled: true });
	});

	it('uses each harness own env-substitution syntax for the bearer token', () => {
		const opencode = buildPanelOpenCodeConfig({
			port: 1,
			env: {},
			home: '/h',
			readFile: () => {
				throw new Error('ENOENT');
			}
		}) as { mcp: { whatsagent: { headers: Record<string, string> } } };
		// Neither harness accepts the other's form; both of these were verified.
		expect(opencode.mcp.whatsagent.headers.Authorization).toBe(
			'Bearer {env:WHATSAGENT_MCP_TOKEN}'
		);
		const claude = buildPanelClaudeMcpConfig(1) as {
			mcpServers: { whatsagent: { headers: Record<string, string>; type: string } };
		};
		expect(claude.mcpServers.whatsagent.headers.Authorization).toBe(
			'Bearer ${WHATSAGENT_MCP_TOKEN}'
		);
		expect(claude.mcpServers.whatsagent.type).toBe('http');
	});

	it('never writes a literal token into either config file', () => {
		const secret = 'super-secret-token';
		const opencode = JSON.stringify(
			buildPanelOpenCodeConfig({
				port: 1,
				env: { WHATSAGENT_MCP_TOKEN: secret },
				home: '/h',
				readFile: () => {
					throw new Error('ENOENT');
				}
			})
		);
		expect(opencode).not.toContain(secret);
		expect(JSON.stringify(buildPanelClaudeMcpConfig(1))).not.toContain(secret);
	});
});
