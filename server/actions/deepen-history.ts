import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type DeepenHistoryInput = { chatJid: string; count: number };

export const deepenHistoryAction: ActionDefinition<DeepenHistoryInput> = {
	name: 'deepen-history',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			count: { type: 'integer' }
		},
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown; count?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		const requestedCount =
			typeof body.count === 'number' && Number.isFinite(body.count)
				? Math.trunc(body.count)
				: 50;
		const count = Math.min(Math.max(requestedCount, 1), 200);
		return { ok: true, input: { chatJid: body.chatJid, count } };
	},
	async run(input, ctx) {
		if (!ctx.deps.deepenHistory) {
			return actionError(503, 'History deepening unavailable');
		}
		return actionJson(202, await ctx.deps.deepenHistory(input.chatJid, input.count));
	}
};
