import { getChat } from '../store/chats.js';
import { getMessage } from '../store/messages.js';
import { enqueueManualOutbox, getOutbox } from '../store/outbox.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SendInput = {
	chatJid: string;
	text: string;
	reply_to_msg_id?: unknown;
};

/**
 * Composer send → outbox only. Never calls WhatsApp sendMessage (R9: only the
 * outbox pacer does). FRONTEND ONLY — R9. The agent's path is `propose-send`.
 */
export const sendAction: ActionDefinition<SendInput> = {
	name: 'send',
	description:
		'Enqueue composer text to chatJid through the paced outbox. Owner click only; agents use propose-send.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			text: { type: 'string' },
			reply_to_msg_id: { type: 'string' }
		},
		required: ['chatJid', 'text'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as
			| { chatJid?: unknown; text?: unknown; reply_to_msg_id?: unknown }
			| undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid, text }');
		}
		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (!text) {
			return parseError(400, 'Expected { text }');
		}
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				text,
				...(body.reply_to_msg_id !== undefined
					? { reply_to_msg_id: body.reply_to_msg_id }
					: {})
			}
		};
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		let replyToMsgId: string | undefined;
		if (input.reply_to_msg_id !== undefined) {
			if (typeof input.reply_to_msg_id !== 'string' || !input.reply_to_msg_id.trim()) {
				return actionError(400, 'Expected reply_to_msg_id to be a message id');
			}
			replyToMsgId = input.reply_to_msg_id.trim();
			const target = getMessage(db, replyToMsgId);
			if (!target) {
				return actionError(400, 'Reply target not found');
			}
			if (target.chat_jid !== input.chatJid) {
				return actionError(400, 'Reply target does not belong to this chat');
			}
		}
		const now = Date.now();
		const id = enqueueManualOutbox(db, {
			chatJid: input.chatJid,
			text: input.text,
			replyToMsgId,
			now
		});
		const row = getOutbox(db, id)!;
		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		return actionJson(202, row);
	}
};
