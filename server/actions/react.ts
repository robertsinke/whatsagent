import { getMessage } from '../store/messages.js';
import { enqueueReactionOutbox, getOutbox } from '../store/outbox.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ReactInput = {
	messageId: string;
	emoji: string;
};

/**
 * Reaction → outbox pacer (Baileys sendMessage). FRONTEND ONLY — outbound: it
 * enqueues to the outbox and wakes the pacer. The agent's counterpart is
 * `propose-reaction` (PANEL-S6); do not open this one. Empty emoji removes a
 * reaction.
 */
export const reactAction: ActionDefinition<ReactInput> = {
	name: 'react',
	description:
		'Enqueue a reaction (messageId, emoji) through the paced outbox. Owner click only; agents use propose-reaction.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			messageId: { type: 'string' },
			emoji: { type: 'string' }
		},
		required: ['messageId', 'emoji'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { messageId?: unknown; emoji?: unknown } | undefined;
		if (typeof body?.messageId !== 'string' || !body.messageId) {
			return parseError(400, 'Expected { messageId, emoji }');
		}
		// An empty emoji string removes a reaction; a missing/non-string emoji is a 400.
		if (typeof body.emoji !== 'string') {
			return parseError(400, 'Expected { emoji }');
		}
		return {
			ok: true,
			input: { messageId: body.messageId, emoji: body.emoji.trim() }
		};
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const message = getMessage(db, input.messageId);
		if (!message) {
			return actionError(404, 'Message not found', { id: input.messageId });
		}
		const now = Date.now();
		const id = enqueueReactionOutbox(db, {
			chatJid: message.chat_jid,
			targetMsgId: input.messageId,
			emoji: input.emoji,
			now
		});
		const row = getOutbox(db, id)!;
		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		return actionJson(202, row);
	}
};
