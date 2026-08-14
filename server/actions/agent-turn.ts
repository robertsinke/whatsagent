import { PanelTurnInFlightError } from '../agent/panel/session.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type AgentTurnInput = { text: string };

/**
 * How long an owner instruction may be. Not a safety boundary — the harness
 * would truncate anyway — but a panel composer is not a document editor, and an
 * unbounded field is a way to push a very large prompt through on every turn.
 */
const MAX_TURN_CHARS = 4_000;

/**
 * FRONTEND ONLY — unbounded recursion and unbounded spend.
 *
 * `run` below starts a harness process that is itself given this app's tool
 * surface. So permitting `tool` here would let an agent start an agent, which is
 * unbounded recursion in the same breath as unbounded spend: each nested turn
 * spawns another model process, and nothing in the chain has a depth counter to
 * stop it. One injected instruction in a message the agent reads is enough to
 * begin it.
 *
 * This is the same rule `set-setting.ts` states — an action that can arm a costly
 * or outbound path belongs behind the frontend-only policy, not only the ones
 * that send. The refusal is a caller-policy declaration rather than a depth
 * guard inside `run`, because this registry's contract is that `callers` is
 * enforced by the dispatcher and never re-litigated in a run function; a guard
 * inside `run` is one refactor away from being dropped.
 *
 * If a future task genuinely needs an agent to trigger agent work, do NOT add
 * `tool` here. The shape that would be safe is a separate action with an
 * explicit, persisted depth budget the dispatcher can see — and that is a
 * design, not a one-line edit.
 */
export const agentTurnAction: ActionDefinition<AgentTurnInput> = {
	name: 'agent-turn',
	description: 'Run one owner panel turn with text. Costs a model call; frontend only.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: { text: { type: 'string' } },
		required: ['text'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { text?: unknown } | undefined;
		const text = typeof body?.text === 'string' ? body.text.trim() : '';
		if (!text) return parseError(400, 'Expected { text }');
		if (text.length > MAX_TURN_CHARS) {
			return parseError(400, `Expected text to be at most ${MAX_TURN_CHARS} characters`, {
				length: text.length,
				max: MAX_TURN_CHARS
			});
		}
		return { ok: true, input: { text } };
	},
	run(input, ctx) {
		const panel = ctx.deps.panelSession;
		if (!panel) {
			// Honest refusal, never a silent no-op. The panel is unusable without the
			// MCP surface, and the runtime deliberately does not switch it on for the
			// owner — see `CreateAppOptions.panelHarness` for that decision.
			return actionError(503, 'The agent panel is not configured', {
				reason: 'panel_unavailable'
			});
		}
		try {
			const started = panel.start(input.text);
			// 202: the transcript arrives over the WebSocket as `agent-part-updated`
			// parts, so there is nothing to return here but the correlation ids.
			return actionJson(202, {
				status: 'running',
				session_id: started.sessionId,
				message_id: started.messageId,
				harness: started.harness
			});
		} catch (error) {
			if (error instanceof PanelTurnInFlightError) {
				// 409, not a queue. See `PanelSessionManager` for why.
				return actionError(409, 'A turn is already running', {
					session_id: error.running.sessionId,
					message_id: error.running.messageId
				});
			}
			throw error;
		}
	}
};
