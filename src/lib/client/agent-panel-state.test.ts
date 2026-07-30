import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './state.svelte.js';
import type { AgentStatus } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

const AVAILABLE: AgentStatus = {
	available: true,
	running: false,
	sessionId: null,
	messageId: null,
	harness: 'opencode'
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('AppState agent panel', () => {
	it('defaults to unavailable so the composer never looks wired before it is', () => {
		const state = new AppState();
		// `available: false` is the shipped default, not an error path — the panel
		// needs the /mcp surface and that is off unless the owner turns it on.
		expect(state.agent.available).toBe(false);
		expect(state.agent.running).toBe(false);
	});

	it('locks the composer optimistically, before the server answers', async () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			if (!String(input).endsWith('/agent/turn')) throw new Error('unexpected');
			await gate;
			return jsonResponse(
				{ status: 'running', session_id: 's1', message_id: 'm1', harness: 'opencode' },
				202
			);
		});

		const pending = state.sendAgentTurn('do it');
		// A harness takes a second or two to spawn. Without the optimistic lock the
		// composer stays live over that window and a second Enter earns a 409 the
		// owner did nothing to deserve.
		expect(state.agent.running).toBe(true);
		release();
		expect(await pending).toBe(true);
		expect(state.agent.messageId).toBe('m1');
		expect(state.agent.harness).toBe('opencode');
	});

	it('releases the lock when the turn never started', async () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ error: 'The agent panel is not configured' }, 503)
		);
		expect(await state.sendAgentTurn('do it')).toBe(false);
		// A turn that never started must not leave the composer locked.
		expect(state.agent.running).toBe(false);
		expect(state.agentError).toContain('not configured');
	});

	it('keeps the lock on a 409, because the server is right', async () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ error: 'A turn is already running' }, 409)
		);
		expect(await state.sendAgentTurn('do it')).toBe(false);
		expect(state.agent.running).toBe(true);
		expect(state.agentError).toBe('A turn is already running.');
	});

	it('refuses to send when the panel is unavailable or the text is empty', async () => {
		const state = new AppState();
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		expect(await state.sendAgentTurn('x')).toBe(false);
		state.agent = AVAILABLE;
		expect(await state.sendAgentTurn('   ')).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('cancels a running turn then starts when the owner submits again (steering)', async () => {
		const state = new AppState();
		state.agent = { ...AVAILABLE, running: true, messageId: 'm-old', sessionId: 's1' };
		const calls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/agent/cancel')) {
				calls.push('cancel');
				return jsonResponse({
					cancelled: true,
					running: false,
					sessionId: null,
					messageId: null,
					harness: 'opencode'
				});
			}
			if (url.endsWith('/agent/turn')) {
				calls.push('turn');
				return jsonResponse(
					{ status: 'running', session_id: 's1', message_id: 'm-new', harness: 'opencode' },
					202
				);
			}
			throw new Error(`unexpected ${url}`);
		});

		expect(await state.sendAgentTurn('steer me')).toBe(true);
		expect(calls).toEqual(['cancel', 'turn']);
		expect(state.agent.messageId).toBe('m-new');
		expect(state.agentOwnerEchoes).toEqual([{ messageId: 'm-new', text: 'steer me' }]);
	});

	it('echoes the owner prompt keyed by the started message id', async () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse(
				{ status: 'running', session_id: 's1', message_id: 'm1', harness: 'opencode' },
				202
			)
		);
		expect(await state.sendAgentTurn('hello')).toBe(true);
		expect(state.agentOwnerEchoes).toEqual([{ messageId: 'm1', text: 'hello' }]);
	});

	it('ignores a finished event from a cancelled turn after a new one started', () => {
		const state = new AppState();
		state.agent = {
			...AVAILABLE,
			running: true,
			sessionId: 's1',
			messageId: 'm-new'
		};
		state.applyEvent({
			type: 'agent-turn',
			phase: 'finished',
			sessionId: 's1',
			messageId: 'm-old',
			harness: 'opencode',
			reason: 'Turn cancelled.'
		});
		expect(state.agent.running).toBe(true);
		expect(state.agent.messageId).toBe('m-new');
		expect(state.agentError).toBeNull();
	});

	it('clearAgentPanel empties sessions and owner echoes', async () => {
		const state = new AppState();
		state.agent = { ...AVAILABLE, running: true, sessionId: 's1', messageId: 'm1' };
		state.agentOwnerEchoes = [{ messageId: 'm1', text: 'hi' }];
		state.agentSessions = {
			s1: {
				sessionId: 's1',
				parts: [
					{
						kind: 'text',
						sessionId: 's1',
						messageId: 'm1',
						partId: 'p1',
						text: 'hello'
					}
				]
			}
		};
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({
				cleared: true,
				cancelled: true,
				nextSessionId: 'panel-new',
				running: false,
				sessionId: null,
				messageId: null,
				harness: 'opencode'
			})
		);
		expect(await state.clearAgentPanel()).toBe(true);
		expect(state.agentSessions).toEqual({});
		expect(state.agentOwnerEchoes).toEqual([]);
		expect(state.agent.running).toBe(false);
	});

	it('takes running state from the agent-turn lifecycle event, not from the parts', () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		state.applyEvent({
			type: 'agent-turn',
			phase: 'started',
			sessionId: 's1',
			messageId: 'm1',
			harness: 'opencode'
		});
		expect(state.agent.running).toBe(true);

		state.applyEvent({
			type: 'agent-turn',
			phase: 'finished',
			sessionId: 's1',
			messageId: 'm1',
			harness: 'opencode'
		});
		// The parts cannot answer this: a turn can end with no `step-finish` (a
		// cancel, a spawn failure), and its first part can arrive seconds after the
		// owner pressed Enter.
		expect(state.agent.running).toBe(false);
		expect(state.agentError).toBeNull();
	});

	it('surfaces a finish reason as the panel error', () => {
		const state = new AppState();
		state.agent = AVAILABLE;
		state.applyEvent({
			type: 'agent-turn',
			phase: 'finished',
			sessionId: 's1',
			messageId: 'm1',
			harness: 'opencode',
			reason: 'The harness timed out.'
		});
		expect(state.agentError).toBe('The harness timed out.');
	});

	it('never lets a lifecycle event flip availability', () => {
		const state = new AppState();
		// `available` is a boot-time configuration fact; a turn event must not
		// claim the panel became usable (or stopped being).
		state.applyEvent({
			type: 'agent-turn',
			phase: 'started',
			sessionId: 's1',
			messageId: 'm1',
			harness: 'opencode'
		});
		expect(state.agent.available).toBe(false);
	});

	it('cancel is a no-op when the panel is unavailable', async () => {
		const state = new AppState();
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await state.cancelAgentTurn();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('cancel applies the server status and keeps `available`', async () => {
		const state = new AppState();
		state.agent = { ...AVAILABLE, running: true };
		// PANEL-S1: this is the real shape of the cancel response — turn state
		// only. The cancel action cannot observe `available`, so a naive spread
		// would blank it.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({
				cancelled: true,
				running: false,
				sessionId: null,
				messageId: null,
				harness: null
			})
		);
		await state.cancelAgentTurn();
		expect(state.agent.running).toBe(false);
		expect(state.agent.available).toBe(true);
	});

	it('accumulates agent parts independently of the turn lifecycle', () => {
		const state = new AppState();
		state.applyEvent({
			type: 'agent-part-updated',
			part: {
				kind: 'tool',
				sessionId: 's1',
				messageId: 'm1',
				partId: 'p1',
				name: 'list-chats',
				input: {},
				state: 'running'
			}
		});
		state.applyEvent({
			type: 'agent-part-updated',
			part: {
				kind: 'tool',
				sessionId: 's1',
				messageId: 'm1',
				partId: 'p1',
				name: 'list-chats',
				input: {},
				state: 'complete',
				output: { total: 2 }
			}
		});
		// Same partId → the line updates in place rather than appearing twice, which
		// is what makes claude's call-then-result pair render as one tool line.
		const parts = state.agentSessions.s1!.parts;
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ name: 'list-chats', state: 'complete' });
	});
});
