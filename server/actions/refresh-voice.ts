import { VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RefreshVoiceInput = { stem: string };

export const refreshVoiceAction: ActionDefinition<RefreshVoiceInput> = {
	name: 'refresh-voice',
	description:
		'Rebuild voice models from recent chats for stem (currently global). Costs a model call.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			stem: { type: 'string', enum: [...VOICE_STEMS] }
		},
		required: ['stem'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { stem?: unknown } | undefined;
		if (typeof body?.stem !== 'string' || !VOICE_STEMS.has(body.stem)) {
			return parseError(404, 'Not found');
		}
		return { ok: true, input: { stem: body.stem } };
	},
	async run(_input, ctx) {
		if (typeof ctx.deps.memory?.refreshVoiceModels !== 'function') {
			return actionJson(200, { available: false, refreshed: [], error: null });
		}
		try {
			const refreshed = await ctx.deps.memory.refreshVoiceModels();
			return actionJson(200, { available: true, refreshed, error: null });
		} catch (err) {
			return actionJson(200, {
				available: true,
				refreshed: [],
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
};
