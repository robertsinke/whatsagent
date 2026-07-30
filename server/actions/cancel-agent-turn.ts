import type { ActionDefinition } from './types.js';
import { actionError, actionJson } from './types.js';

export type CancelAgentTurnInput = Record<string, never>;

/**
 * FRONTEND ONLY, for the mirror of `agent-turn`'s reason.
 *
 * A tool caller able to cancel is a tool caller able to stop the owner watching
 * it work: the panel's trace is the only place the owner sees what the agent did,
 * and a turn killed mid-way leaves a partial trace that is easy to misread as a
 * complete one. An agent that has just been told to do something it does not want
 * to do should not have a way to end the conversation about it.
 *
 * Same rule as `set-setting.ts` and `agent-demo.ts`: the panel trace is part of
 * the send-safety surface, because the owner's approval decisions are taken
 * against what the panel says — even though nothing here sends.
 *
 * Cancel is idempotent: with no turn running it is a 200 with
 * `cancelled: false`, not an error. The owner clicking stop twice, or clicking it
 * as the turn finishes on its own, is normal and must not paint a failure.
 */
export const cancelAgentTurnAction: ActionDefinition<CancelAgentTurnInput> = {
	name: 'cancel-agent-turn',
	callers: ['frontend'],
	jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
	parse() {
		return { ok: true, input: {} };
	},
	run(_input, ctx) {
		const panel = ctx.deps.panelSession;
		if (!panel) {
			return actionError(503, 'The agent panel is not configured', {
				reason: 'panel_unavailable'
			});
		}
		return actionJson(200, { cancelled: panel.cancel(), ...panel.status() });
	}
};
