import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type PromoteVoiceSuggestionInput = { stem: string; id: string };

/**
 * FRONTEND ONLY, and this is the one exception to the first-class-agent rule
 * that is about injection rather than about outbound sends.
 *
 * PANEL-S5 briefly opened this to `tool` and it was reverted the same day once
 * the full chain was traced. `promoteSuggestion` writes the voice body through
 * `VoiceFiles.writeOwnerEdit`, which records an `ownerHash` and therefore ARMS
 * THE MIRROR GUARD — the promoted text is then protected from being overwritten
 * by the memory system. And `drafter.ts` feeds that document into the system
 * prompt of every future draft.
 *
 * So with `tool` here the chain is: a contact's message text reaches the agent,
 * the agent calls `suggest-voice-note` (tool-only, append-only), then promotes
 * its own suggestion — and durable, guard-protected instructions land in the
 * owner's voice document with no owner click, shaping every draft afterwards.
 * One click from the owner is the whole defence, which is why the split into
 * suggest-then-promote exists at all.
 *
 * The agent keeps the other half: `suggest-voice-note` to propose, and
 * `discard-voice-suggestion` (both callers) to withdraw its own suggestion.
 * Direct rewrites of the body stay on `save-voice`, also frontend-only.
 */
export const promoteVoiceSuggestionAction: ActionDefinition<PromoteVoiceSuggestionInput> = {
	name: 'promote-voice-suggestion',
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
