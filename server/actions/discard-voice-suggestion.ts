import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type DiscardVoiceSuggestionInput = { stem: string; id: string };

/**
 * PANEL-S5 — both callers. Owner decision 2026-07-30: discarding a pending
 * suggestion clears a sidecar row only. `run` calls `VoiceFiles.removeSuggestion`;
 * it does not enqueue an outbox row, wake the pacer, write the voice `.md`
 * body, or write `text_source: 'owner'`.
 */
export const discardVoiceSuggestionAction: ActionDefinition<DiscardVoiceSuggestionInput> = {
	name: 'discard-voice-suggestion',
	callers: ['frontend', 'tool'],
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
