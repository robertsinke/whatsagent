import type { ActionDefinition } from './types.js';
import { actionError, actionJson } from './types.js';

export type ClearAgentPanelInput = Record<string, never>;

/**
 * FRONTEND ONLY — wipe the panel transcript.
 *
 * An agent that could clear the conversation could hide what it just did from
 * the owner. The panel trace is part of the send-safety surface: approval
 * decisions are taken against what the panel says. Same rule as `agent-turn`
 * and `cancel-agent-turn`.
 *
 * Scope is deliberately clear-only: no session storage, no revisiting past
 * sessions. Clearing while a turn runs cancels that turn first so nothing
 * streams into an emptied transcript.
 */
export const clearAgentPanelAction: ActionDefinition<ClearAgentPanelInput> = {
	name: 'clear-agent-panel',
	description: 'Wipe the panel transcript. Frontend only.',
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
		if (!panel.clearHistory) {
			return actionError(503, 'The agent panel cannot clear history', {
				reason: 'panel_unavailable'
			});
		}
		const result = panel.clearHistory();
		return actionJson(200, {
			cleared: true,
			cancelled: result.cancelled,
			nextSessionId: result.sessionId,
			...panel.status()
		});
	}
};
