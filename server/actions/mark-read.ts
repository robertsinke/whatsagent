import { getChat, markChatRead } from '../store/chats.js';
import { chatNeedsReply, toChatView } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type MarkReadInput = { chatJid: string };

/**
 * Advances the LOCAL read cursor only. WhatsApp read-receipt path is
 * deliberately unwired (routes seam comment) — safe for tool callers.
 */
export const markReadAction: ActionDefinition<MarkReadInput> = {
	name: 'mark-read',
	description:
		'Advance the local read cursor for chatJid. Does not send a WhatsApp read receipt.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: { chatJid: { type: 'string' } },
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		return { ok: true, input: { chatJid: body.chatJid } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		markChatRead(db, input.chatJid);
		const updated = toChatView(db, getChat(db, input.chatJid)!, (c) => chatNeedsReply(db, c));
		events.emit({ type: 'chat-updated', chat: updated });
		return actionJson(200, updated);
	}
};
