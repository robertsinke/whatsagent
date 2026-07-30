import { getChat } from '../store/chats.js';
import { getMessage } from '../store/messages.js';
import { getProposal, insertProposal, listPendingProposals } from '../store/proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ProposeReactionInput = { messageId: string; emoji: string };

/**
 * How many un-acted-on proposals one chat may hold (any kind). Shared with
 * `propose-send` — a proposal is a claim on the owner's attention.
 */
const MAX_PENDING_PROPOSALS_PER_CHAT = 3;

/**
 * TOOL ONLY — the agent's counterpart to frontend-only `react`.
 *
 * Mirrors `propose-send`: `run` inserts an inert proposal row and returns. It
 * does not call `enqueueReactionOutbox`, it does not call `wakeOutbox`, and
 * there is deliberately no branch that could. Only `confirm-proposal`
 * (frontend-only) turns the row into a queued reaction. R9 is unchanged.
 *
 * Approval binding: the target message id is stored as both
 * `reaction_target_msg_id` and `basis_msg_id`, so a proposal cannot silently
 * retarget after the owner reviews it. Confirm also hashes emoji+target.
 */
export const proposeReactionAction: ActionDefinition<ProposeReactionInput> = {
	name: 'propose-reaction',
	callers: ['tool'],
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
		// Empty emoji removes a reaction (same as `react`); missing/non-string is 400.
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
		const chat = getChat(db, message.chat_jid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: message.chat_jid });
		}
		// R8: the agent is structurally excluded from groups.
		if (chat.kind !== '1:1') {
			return actionError(400, 'Proposals are available for 1:1 chats only', {
				kind: chat.kind
			});
		}
		const pending = listPendingProposals(db, message.chat_jid);
		if (pending.length >= MAX_PENDING_PROPOSALS_PER_CHAT) {
			return actionError(409, 'Too many proposals are already awaiting the owner', {
				pending: pending.length,
				max: MAX_PENDING_PROPOSALS_PER_CHAT
			});
		}
		const now = Date.now();
		const id = insertProposal(db, {
			kind: 'reaction',
			chatJid: message.chat_jid,
			emoji: input.emoji,
			targetMsgId: input.messageId,
			now
		});
		const proposal = getProposal(db, id)!;
		events.emit({ type: 'proposal-updated', proposal });
		return actionJson(202, {
			status: 'pending_confirmation',
			proposal_id: proposal.id,
			proposal
		});
	}
};
