import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import { looksLikeVoiceDocument } from '../../shared/voice-document.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

/**
 * Ceiling for a hand-saved voice document. Lifted verbatim from routes.ts.
 */
const MAX_VOICE_DOCUMENT_BYTES = 256 * 1024;

export type SaveVoiceInput = {
	stem: string;
	content: string;
	baseHash: string;
	note?: string;
};

/**
 * FRONTEND ONLY — owner decision: the agent's path is the append-only
 * `suggest-voice-note` (durable influence, not an R9 break).
 *
 * The voice document is prompt content for every future draft. A tool caller
 * that can rewrite it plants an instruction in a place the owner rarely
 * re-reads; every resulting draft still passes owner review, so R9 still holds,
 * but the agent has gained a durable channel into the owner's voice.
 *
 * Do NOT re-add `tool` here to "let the agent fix a typo": that undoes the
 * decision. Split work stays on the suggestion / promote-discard path.
 *
 * The fix is a caller-policy change rather than a guard inside `run`, because
 * this registry's contract is that `callers` is enforced by the dispatcher and
 * never re-litigated in a run function.
 */
export const saveVoiceAction: ActionDefinition<SaveVoiceInput> = {
	name: 'save-voice',
	description:
		'Save voice document content for stem with baseHash optimistic lock. Frontend only.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			stem: { type: 'string', enum: [...VOICE_STEMS] },
			content: { type: 'string' },
			baseHash: { type: 'string' },
			note: { type: 'string' }
		},
		required: ['stem', 'content', 'baseHash'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as
			| { stem?: unknown; content?: unknown; baseHash?: unknown; note?: unknown }
			| undefined;
		if (typeof body?.stem !== 'string' || !VOICE_STEMS.has(body.stem)) {
			// HTTP adapter maps unknown stem to 404 before dispatch; for direct
			// dispatch, mirror the route's whitelist miss as 404.
			return parseError(404, 'Not found');
		}
		if (typeof body.content !== 'string' || typeof body.baseHash !== 'string') {
			return parseError(400, 'Expected { content, baseHash }');
		}
		if (Buffer.byteLength(body.content, 'utf8') > MAX_VOICE_DOCUMENT_BYTES) {
			return parseError(400, 'Voice document too large', {
				maxBytes: MAX_VOICE_DOCUMENT_BYTES
			});
		}
		return {
			ok: true,
			input: {
				stem: body.stem,
				content: body.content,
				baseHash: body.baseHash,
				...(typeof body.note === 'string' ? { note: body.note } : {})
			}
		};
	},
	async run(input, ctx) {
		const dataDir = ctx.deps.dataDir;
		if (!dataDir) {
			return actionError(503, 'Voice storage unavailable');
		}
		const files = new VoiceFiles(dataDir);
		const current = files.inspect(input.stem);
		if (current.hash !== input.baseHash) {
			return actionJson(409, {
				stem: input.stem,
				conflict: true,
				content: current.content,
				hash: current.hash,
				byteLength: current.byteLength,
				modifiedAt:
					current.modifiedAt === null ? null : new Date(current.modifiedAt).toISOString(),
				mirrorGuard: current.mirrorGuard
			});
		}

		// Byte-identical Save: do not call writeOwnerEdit. Rewriting the same
		// bytes still arms the mirror guard (ownerHash sidecar) and freezes
		// Hindsight updates — the failure mode PANEL-S13 closes on the client.
		// Defense in depth if a caller bypasses the Voice-tab short-circuit.
		if (current.content !== null && input.content === current.content) {
			return actionJson(200, {
				stem: input.stem,
				hash: current.hash,
				byteLength: current.byteLength,
				modifiedAt:
					current.modifiedAt === null ? null : new Date(current.modifiedAt).toISOString(),
				mirrorGuard: current.mirrorGuard,
				looksLikeVoiceDocument: looksLikeVoiceDocument(input.content),
				directive: 'skipped'
			});
		}

		files.writeOwnerEdit(input.stem, input.content);

		let directive: 'recorded' | 'skipped' | 'failed' = 'skipped';
		if (typeof ctx.deps.memory?.recordVoiceCorrection === 'function') {
			const note = typeof input.note === 'string' ? input.note.trim() : '';
			try {
				await ctx.deps.memory.recordVoiceCorrection(
					`Owner voice correction (${input.stem})`,
					note ||
						'The owner hand-edited the voice document. Treat their edited version as ' +
							'authoritative about how they write, over anything inferred from message history.',
					undefined
				);
				directive = 'recorded';
			} catch {
				directive = 'failed';
			}
		}

		const saved = files.inspect(input.stem);
		return actionJson(200, {
			stem: input.stem,
			hash: saved.hash,
			byteLength: saved.byteLength,
			modifiedAt: saved.modifiedAt === null ? null : new Date(saved.modifiedAt).toISOString(),
			mirrorGuard: saved.mirrorGuard,
			looksLikeVoiceDocument: looksLikeVoiceDocument(input.content),
			directive
		});
	}
};
