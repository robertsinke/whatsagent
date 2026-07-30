import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type PromoteVoiceSuggestionInput = { stem: string; id: string };

/**
 * PANEL-S5 — both callers. Owner decision 2026-07-30: promoting a pending
 * suggestion is a voice-document write, not an outbound path. `run` only calls
 * `VoiceFiles.promoteSuggestion`; it does not enqueue an outbox row, wake the
 * pacer, or write `text_source: 'owner'`. R9 is untouched.
 *
 * Direct rewrites of the voice body stay on `save-voice` (frontend-only); the
 * agent's append-only half remains `suggest-voice-note`.
 */
export const promoteVoiceSuggestionAction: ActionDefinition<PromoteVoiceSuggestionInput> = {
	name: 'promote-voice-suggestion',
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
		const result = files.promoteSuggestion(input.stem, input.id);
		if (!result) {
			return actionError(404, 'Suggestion not found', { id: input.id });
		}
		return actionJson(200, {
			stem: input.stem,
			suggestion: result.suggestion,
			hash: result.view.hash,
			byteLength: result.view.byteLength,
			modifiedAt:
				result.view.modifiedAt === null
					? null
					: new Date(result.view.modifiedAt).toISOString(),
			mirrorGuard: result.view.mirrorGuard,
			content: result.view.content,
			suggestions: files.listSuggestions(input.stem)
		});
	}
};
