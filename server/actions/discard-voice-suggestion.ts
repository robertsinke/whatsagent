import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type DiscardVoiceSuggestionInput = { stem: string; id: string };

/**
 * FRONTEND ONLY. Declining a suggestion is the owner's decision in the same
 * way promoting is; a tool caller that could discard its own suggestions could
 * also clear the evidence of what it asked for before the owner ever saw it.
 */
export const discardVoiceSuggestionAction: ActionDefinition<DiscardVoiceSuggestionInput> = {
	name: 'discard-voice-suggestion',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			stem: { type: 'string', enum: [...VOICE_STEMS] },
			id: { type: 'string' }
		},
		required: ['stem', 'id'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { stem?: unknown; id?: unknown } | undefined;
		if (typeof body?.stem !== 'string' || !VOICE_STEMS.has(body.stem)) {
			return parseError(404, 'Not found');
		}
		if (typeof body.id !== 'string' || !body.id) {
			return parseError(400, 'Expected { id }');
		}
		return { ok: true, input: { stem: body.stem, id: body.id } };
	},
	run(input, ctx) {
		const dataDir = ctx.deps.dataDir;
		if (!dataDir) {
			return actionError(503, 'Voice storage unavailable');
		}
		const files = new VoiceFiles(dataDir);
		const removed = files.removeSuggestion(input.stem, input.id);
		if (!removed) {
			return actionError(404, 'Suggestion not found', { id: input.id });
		}
		return actionJson(200, {
			suggestion: removed,
			suggestions: files.listSuggestions(input.stem)
		});
	}
};
