import { isDevAgentEventsEnabled, startAgentDemoSequence } from '../api/dev-agent-events.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson } from './types.js';

export type AgentDemoInput = {
	openChatJid?: string;
	stepMs?: number;
};

/**
 * PL-A1 — gated by WHATSAGENT_DEV_EVENTS=1. Absent the flag this 404s.
 */
export const agentDemoAction: ActionDefinition<AgentDemoInput> = {
	name: 'agent-demo',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			openChatJid: { type: 'string' },
			stepMs: { type: 'number' }
		},
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { openChatJid?: unknown; stepMs?: unknown } | undefined;
		const input: AgentDemoInput = {};
		if (typeof body?.openChatJid === 'string') input.openChatJid = body.openChatJid;
		if (typeof body?.stepMs === 'number') input.stepMs = body.stepMs;
		return { ok: true, input };
	},
	run(input, ctx) {
		if (!isDevAgentEventsEnabled()) {
			return actionError(404, 'Not found');
		}
		startAgentDemoSequence(ctx.deps.events, {
			...(input.openChatJid ? { openChatJid: input.openChatJid } : {}),
			...(typeof input.stepMs === 'number' ? { stepMs: input.stepMs } : {})
		});
		return actionJson(202, { ok: true, gatedBy: 'WHATSAGENT_DEV_EVENTS=1' });
	}
};
