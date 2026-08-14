import { getMessage } from '../store/messages.js';
import { isMediaType, toMessageView } from '../api/message-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type LoadMediaInput = { messageId: string };

/** On-demand media fetch — never bulk-prefetched. */
export const loadMediaAction: ActionDefinition<LoadMediaInput> = {
	name: 'load-media',
	description: 'Fetch media for one messageId on demand. Not a bulk download.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: { messageId: { type: 'string' } },
		required: ['messageId'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { messageId?: unknown } | undefined;
		if (typeof body?.messageId !== 'string' || !body.messageId) {
			return parseError(400, 'Expected { messageId }');
		}
		return { ok: true, input: { messageId: body.messageId } };
	},
	async run(input, ctx) {
		const message = getMessage(ctx.deps.db, input.messageId);
		if (!message) {
			return actionError(404, 'Message not found', { id: input.messageId });
		}
		if (!isMediaType(message.type)) {
			return actionError(400, 'Message has no media', {
				id: input.messageId,
				type: message.type
			});
		}
		if (message.media_state === 'ready' && message.media_ref) {
			return actionJson(200, toMessageView(ctx.deps.db, message));
		}
		if (message.media_state === 'failed' && message.media_error === 'unavailable') {
			return actionError(410, 'Media is no longer available', { id: input.messageId });
		}
		if (!ctx.deps.downloadMedia) {
			return actionError(503, 'No channel attached');
		}
		try {
			await ctx.deps.downloadMedia(input.messageId);
		} catch {
			const updated = getMessage(ctx.deps.db, input.messageId);
			const reason = updated?.media_error ?? 'transient';
			return actionError(reason === 'unavailable' ? 410 : 502, 'Media download failed', {
				id: input.messageId,
				reason
			});
		}
		return actionJson(200, toMessageView(ctx.deps.db, getMessage(ctx.deps.db, input.messageId)!));
	}
};
