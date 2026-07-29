import { getChat, setChatAgentState } from '../store/chats.js';
import { deleteDraft, getDraft } from '../store/drafts.js';
import { recordDraftFeedback } from '../store/draft-feedback.js';
import { cancelPendingDraftOutbox } from '../store/outbox.js';
import { retainDraftLearning } from '../agent/voice.js';
import { chatNeedsReply, toChatView } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SkipDraftInput = { chatJid: string };

export const skipDraftAction: ActionDefinition<SkipDraftInput> = {
	name: 'skip-draft',
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
		const existing = getDraft(db, input.chatJid);
		if (!existing) {
			return actionError(404, 'Draft not found');
		}
		let cancelled: ReturnType<typeof cancelPendingDraftOutbox> = [];
		const skip = db.transaction(() => {
			if (existing.status === 'approved') {
				cancelled = cancelPendingDraftOutbox(db, input.chatJid, existing.basis_msg_id);
				if (cancelled.length === 0) return false;
			}
			recordDraftFeedback(db, {
				chat_jid: input.chatJid,
				kind: 'skipped',
				draft_text: existing.original_text,
				final_text: null,
				basis_msg_id: existing.basis_msg_id,
				created_at: Date.now()
			});
			deleteDraft(db, input.chatJid);
			setChatAgentState(db, input.chatJid, 'skipped');
			return true;
		});
		if (!skip()) {
			return actionError(409, 'Approved draft is already sending or sent');
		}
		if (ctx.deps.memory) {
			void retainDraftLearning(ctx.deps.memory, {
				chatJid: input.chatJid,
				draft: existing.original_text,
				final: null,
				skipped: true
			});
		}
		ctx.deps.wakeOutbox?.();
		for (const outbox of cancelled) events.emit({ type: 'outbox-updated', outbox });
		const updated = toChatView(db, getChat(db, input.chatJid)!, (c) => chatNeedsReply(db, c));
		events.emit({ type: 'draft-removed', chat_jid: input.chatJid });
		events.emit({ type: 'chat-updated', chat: updated });
		return actionJson(200, { ok: true, chat: updated });
	}
};
