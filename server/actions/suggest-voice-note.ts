import {
	MAX_PENDING_VOICE_SUGGESTIONS,
	VoiceFiles,
	VOICE_STEMS
} from '../agent/memory/voice-files.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

/**
 * Ceiling for a single suggestion body. Kept well under the voice-document
 * ceiling so a flood of suggestions cannot approximate a full rewrite.
 */
const MAX_SUGGESTION_BYTES = 8 * 1024;

export type SuggestVoiceNoteInput = { stem: string; text: string };

/**
 * TOOL ONLY, and it is the agent's append-only route toward changing the voice
 * document. `run` below appends a suggestion to a sidecar and returns. It does
 * not call `writeOwnerEdit`, it does not touch the `.md` body, and there is
 * deliberately no branch in it that could. The document is updated by
 * `promote-voice-suggestion` (both callers as of PANEL-S5); direct body
 * rewrites stay on `save-voice` (frontend-only).
 *
 * Closing `save-voice` to tool callers without this action would leave the
 * agent with no honest way to surface a voice correction it noticed. Opening
 * `save-voice` to tool callers again would reopen the durable-influence channel
 * this pair exists to close. If a future task wants the agent to rewrite the
 * document directly, that is a change to the owner decision recorded in
 * `save-voice.ts`, not a change to this file.
 */
export const suggestVoiceNoteAction: ActionDefinition<SuggestVoiceNoteInput> = {
	name: 'suggest-voice-note',
	description:
		'File a voice-document suggestion for stem (currently global) with text. Owner must promote it; this does not rewrite voice.',
	callers: ['tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			stem: { type: 'string', enum: [...VOICE_STEMS] },
			text: { type: 'string' }
		},
		required: ['stem', 'text'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { stem?: unknown; text?: unknown } | undefined;
		if (typeof body?.stem !== 'string' || !VOICE_STEMS.has(body.stem)) {
			return parseError(404, 'Not found');
		}
		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (!text) {
			return parseError(400, 'Expected { text }');
		}
		if (Buffer.byteLength(text, 'utf8') > MAX_SUGGESTION_BYTES) {
			return parseError(400, 'Suggestion too large', { maxBytes: MAX_SUGGESTION_BYTES });
		}
		return { ok: true, input: { stem: body.stem, text } };
	},
	run(input, ctx) {
		const dataDir = ctx.deps.dataDir;
		if (!dataDir) {
			return actionError(503, 'Voice storage unavailable');
		}
		const files = new VoiceFiles(dataDir);
		const beforeHash = files.inspect(input.stem).hash;
		const suggestion = files.appendSuggestion(input.stem, input.text);
		if (!suggestion) {
			return actionError(409, 'Too many voice suggestions are already awaiting the owner', {
				pending: files.listSuggestions(input.stem).length,
				max: MAX_PENDING_VOICE_SUGGESTIONS
			});
		}
		// Byte-identity of the document is the structural claim this action makes.
		const after = files.inspect(input.stem);
		if (after.hash !== beforeHash) {
			return actionError(500, 'Suggestion path mutated the voice document');
		}
		return actionJson(202, {
			status: 'pending_promotion',
			suggestion,
			document_hash: after.hash
		});
	}
};
