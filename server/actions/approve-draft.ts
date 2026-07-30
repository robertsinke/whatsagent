import {
	approvalHashMatches,
	CONFLICT_STALE_INBOUND,
	CONFLICT_TEXT_CHANGED,
	hashApprovalText
} from '../../shared/approval-hash.js';
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
	base_hash?: string;
};

/**
 * Approve draft → outbox. FRONTEND ONLY — approval IS the owner's authority;
 * there is no agent equivalent by design. Stale-confirm uses
 * confirmed_latest_inbound_id (same action).
 *
 * PL-U3 Half B — `base_hash` is what makes the click mean something.
 *
 * It hashes the draft the owner *reviewed*, not the text being sent: the owner
 * may retype the message entirely, and the question this guard answers is
 * "did the thing you were looking at change underneath you", exactly as
 * `save-voice`'s `baseHash` does for the voice document.
 * `basis_msg_id` detects that the *conversation* moved; it says nothing about
 * the draft itself moving. `edit-draft` and `refine-draft` are tool-permitted,
 * so an agent may rewrite a draft while the owner is reading it, the panel
 * re-renders on `draft-updated`, and the next click would queue text the owner
 * never saw. The hash of the rendered text closes that: a mismatch is a 409
 * carrying the current text, and nothing is written.
 *
 * It is optional only because callers predating PL-U3 omit it, and every such
 * caller is by definition a frontend one (the dispatcher refuses `tool` here
 * before parse). The shipped client always sends it — `state.svelte.ts` has a
 * test asserting that, because an optional guard that the real client silently
 * stopped sending would be no guard at all.
 */
export const approveDraftAction: ActionDefinition<ApproveDraftInput> = {
	name: 'approve-draft',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			text: { type: 'string' },
			confirmed_latest_inbound_id: { type: 'string' },
			base_hash: { type: 'string' }
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
					base_hash?: unknown;
			  }
			| undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		if (body.base_hash !== undefined && typeof body.base_hash !== 'string') {
			return parseError(400, 'Expected base_hash to be a string');
		}
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				...(body.text !== undefined ? { text: body.text } : {}),
				...(body.confirmed_latest_inbound_id !== undefined
					? { confirmed_latest_inbound_id: body.confirmed_latest_inbound_id }
					: {}),
				...(typeof body.base_hash === 'string' ? { base_hash: body.base_hash } : {})
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
				conflict: CONFLICT_STALE_INBOUND,
				basis_msg_id: existing.basis_msg_id,
				latest_inbound_id: latestInbound.id
			});
		}
		// Half B. Nothing is written on this branch — the response carries the
		// current text so the UI can show what changed and ask again. Re-hashing
		// and retrying automatically would reintroduce the exact bug, so the 409
		// names who changed it and the owner has to look.
		if (input.base_hash !== undefined && !approvalHashMatches(existing.text, input.base_hash)) {
			return actionError(409, 'Draft changed since you reviewed it', {
				conflict: CONFLICT_TEXT_CHANGED,
				chat_jid: input.chatJid,
				current_text: existing.text,
				current_hash: hashApprovalText(existing.text),
				text_source: existing.text_source
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
			// The approved text is by definition owner-reviewed, whether they typed
			// it or accepted what was there.
			upsertDraft(db, { ...existing, text, status: 'approved', text_source: 'owner' });
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
