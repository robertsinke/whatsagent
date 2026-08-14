import { getChat, setChatAgentState } from '../store/chats.js';
import { deleteDraft, getDraft } from '../store/drafts.js';
import { recordDraftFeedback } from '../store/draft-feedback.js';
import {
	getCancellationNotice,
	insertCancellationNotice
} from '../store/cancellation-notices.js';
import { cancelPendingDraftOutbox } from '../store/outbox.js';
import { retainDraftLearning } from '../agent/voice.js';
import { chatNeedsReply, toChatView } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SkipDraftInput = { chatJid: string };

/**
 * Tool-permitted deliberately: the owner chose to keep the capability and add
 * a warning, not to close the door (PL-U5 Decision 3). When a TOOL caller
 * skips a draft whose outbox row was already approved and queued, that undoes
 * an owner yes — so we write a durable, attributed notice. An OWNER skip of
 * the same state does not: they cancelled their own send. Attribution comes
 * from `ctx.caller`, the same mechanism PL-U3 used for `drafts.text_source`.
 *
 * A skip with no cancelled outbox row raises no notice — the warning is about
 * undoing an owner decision, not about skipping a draft that was never queued.
 */
export const skipDraftAction: ActionDefinition<SkipDraftInput> = {
	name: 'skip-draft',
	description:
		'Skip the draft for chatJid. If an approved send is still queued, a tool call cancels it and notifies the owner.',
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
		let noticeId: number | null = null;
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
			// PL-U5: warn only when a tool caller undid an owner-approved queue.
			if (ctx.caller === 'tool' && cancelled.length > 0) {
				const cancelledText =
					cancelled[0]?.text || existing.text || existing.original_text;
				noticeId = insertCancellationNotice(db, {
					chatJid: input.chatJid,
					cancelledText,
					now: Date.now()
				});
			}
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
		if (noticeId !== null) {
			const notice = getCancellationNotice(db, noticeId)!;
			events.emit({ type: 'cancellation-notice', notice });
		}
		const updated = toChatView(db, getChat(db, input.chatJid)!, (c) => chatNeedsReply(db, c));
		events.emit({ type: 'draft-removed', chat_jid: input.chatJid });
		events.emit({ type: 'chat-updated', chat: updated });
		return actionJson(200, {
			ok: true,
			chat: updated,
			...(noticeId !== null
				? { cancellation_notice: getCancellationNotice(db, noticeId)! }
				: {})
		});
	}
};
