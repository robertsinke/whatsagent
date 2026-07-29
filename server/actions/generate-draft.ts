import { getChat } from '../store/chats.js';
import { getDraft } from '../store/drafts.js';
import { getLastMessage } from '../store/messages.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type GenerateDraftInput = { chatJid: string };

export const generateDraftAction: ActionDefinition<GenerateDraftInput> = {
	name: 'generate-draft',
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
		const { db } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		// R8: groups are structurally excluded from drafting.
		if (chat.kind !== '1:1') {
			return actionError(400, 'Drafting is available for 1:1 chats only', {
				kind: chat.kind
			});
		}
		if (!ctx.deps.generateDraft) {
			return actionError(503, 'Draft generation unavailable');
		}
		if (!getLastMessage(db, input.chatJid)) {
			return actionError(409, 'No messages in this chat to draft from');
		}
		const existing = getDraft(db, input.chatJid);
		if (existing?.status === 'drafting') {
			return actionError(409, 'A draft is already being generated', {
				status: existing.status
			});
		}
		if (existing?.status === 'approved') {
			return actionError(409, 'Draft is already approved', { status: existing.status });
		}
		if (!ctx.deps.generateDraft(input.chatJid)) {
			return actionError(409, 'Draft generation was refused for this chat');
		}
		return actionJson(202, { ok: true, chat_jid: input.chatJid });
	}
};
