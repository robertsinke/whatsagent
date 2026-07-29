import { getChat } from '../store/chats.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import { recordDraftFeedback } from '../store/draft-feedback.js';
import { getLastInboundMessage } from '../store/messages.js';
import { enqueueDraftOutbox, getOutbox } from '../store/outbox.js';
import { retainDraftLearning } from '../agent/voice.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ApproveDraftInput = {
	chatJid: string;
	text?: string;
	confirmed_latest_inbound_id?: string;
};

/**
 * Approve draft → outbox. Outbound effect — callers: frontend only.
 * Stale-confirm variant uses confirmed_latest_inbound_id (same action).
 */
export const approveDraftAction: ActionDefinition<ApproveDraftInput> = {
	name: 'approve-draft',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			text: { type: 'string' },
			confirmed_latest_inbound_id: { type: 'string' }
		},
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		// Lifted verbatim from the old handler cast — optional fields are not
		// re-validated beyond what the handler assumed.
		const body = raw as
			| {
					chatJid?: unknown;
					text?: string;
					confirmed_latest_inbound_id?: string;
			  }
			| undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				...(body.text !== undefined ? { text: body.text } : {}),
				...(body.confirmed_latest_inbound_id !== undefined
					? { confirmed_latest_inbound_id: body.confirmed_latest_inbound_id }
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
		const existing = getDraft(db, input.chatJid);
		if (!existing) {
			return actionError(404, 'Draft not found');
		}
		if (!['ready', 'stale', 'drafted'].includes(existing.status)) {
			return actionError(409, 'Draft is not approvable', { status: existing.status });
		}
		const latestInbound = getLastInboundMessage(db, input.chatJid);
		if (
			existing.basis_msg_id &&
			latestInbound &&
			latestInbound.id !== existing.basis_msg_id &&
			input.confirmed_latest_inbound_id !== latestInbound.id
		) {
			return actionError(409, 'Draft is stale; newer inbound arrived', {
				basis_msg_id: existing.basis_msg_id,
				latest_inbound_id: latestInbound.id
			});
		}
		const text = (input.text ?? existing.text).trim();
		if (!text) {
			return actionError(400, 'Empty draft text');
		}
		const now = Date.now();
		const approve = db.transaction(() => {
			const id = enqueueDraftOutbox(db, {
				chatJid: input.chatJid,
				text,
				draftText: existing.original_text,
				basisMsgId: existing.basis_msg_id,
				now,
				jitterMs: ctx.deps.nextDraftJitterMs?.() ?? 30_000
			});
			recordDraftFeedback(db, {
				chat_jid: input.chatJid,
				kind: 'approved',
				draft_text: existing.original_text,
				final_text: text,
				basis_msg_id: existing.basis_msg_id,
				created_at: now
			});
			upsertDraft(db, { ...existing, text, status: 'approved' });
			return { row: getOutbox(db, id)!, draft: getDraft(db, input.chatJid)! };
		});
		const { row, draft } = approve();
		if (ctx.deps.memory) {
			void retainDraftLearning(ctx.deps.memory, {
				chatJid: input.chatJid,
				draft: existing.original_text,
				final: text,
				skipped: false
			});
		}
		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		events.emit({ type: 'draft-updated', draft });
		return actionJson(202, { outbox: row, draft });
	}
};
