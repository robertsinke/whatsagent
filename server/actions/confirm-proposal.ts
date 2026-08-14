import {
	approvalHashMatches,
	CONFLICT_STALE_INBOUND,
	CONFLICT_TEXT_CHANGED,
	hashApprovalText,
	proposalApprovalText
} from '../../shared/approval-hash.js';
import { getChat } from '../store/chats.js';
import { getLastInboundMessage, getMessage } from '../store/messages.js';
import { enqueueManualOutbox, enqueueReactionOutbox, getOutbox } from '../store/outbox.js';
import { attachProposalOutbox, decideProposal, getProposal } from '../store/proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ConfirmProposalInput = {
	id: number;
	base_hash: string;
	confirmed_latest_inbound_id?: string;
};

/**
 * FRONTEND ONLY — an agent confirming its own proposal defeats the entire
 * proposal mechanism. This is the action that creates the outbox row; the
 * agent's half is `propose-send` / `propose-reaction`, which cannot enqueue
 * anything.
 *
 * Outbound rule: every outbound WhatsApp effect the agent wants must arrive as
 * a proposal of some `kind`. Only this action may enqueue, and it stays
 * frontend-only. Decide-then-insert runs in one transaction so a double
 * confirmation cannot produce two outbox rows.
 *
 * `base_hash` is required. For send proposals it is the hash of the message
 * text; for reaction proposals it is the hash of `proposalApprovalText` (emoji
 * + target message id). Approval binding for reactions is the target message
 * id stored on the row — a proposal cannot silently retarget after review.
 *
 * Staleness (newer inbound) applies to send proposals only: a reaction is
 * bound to a specific message, not to "reply to the latest inbound".
 */
export const confirmProposalAction: ActionDefinition<ConfirmProposalInput> = {
	name: 'confirm-proposal',
	description:
		'Confirm proposal id (base_hash required) and enqueue the outbox send or reaction. Owner click only.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			id: { type: 'number' },
			base_hash: { type: 'string' },
			confirmed_latest_inbound_id: { type: 'string' }
		},
		required: ['id', 'base_hash'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as
			| { id?: unknown; base_hash?: unknown; confirmed_latest_inbound_id?: unknown }
			| undefined;
		const id = typeof body?.id === 'number' ? body.id : Number.NaN;
		if (!Number.isInteger(id) || id <= 0) {
			return parseError(400, 'Expected { id }');
		}
		if (typeof body?.base_hash !== 'string' || !body.base_hash) {
			return parseError(400, 'Expected { base_hash }');
		}
		return {
			ok: true,
			input: {
				id,
				base_hash: body.base_hash,
				...(typeof body.confirmed_latest_inbound_id === 'string'
					? { confirmed_latest_inbound_id: body.confirmed_latest_inbound_id }
					: {})
			}
		};
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const proposal = getProposal(db, input.id);
		if (!proposal) {
			return actionError(404, 'Proposal not found', { id: input.id });
		}
		if (proposal.status !== 'pending') {
			return actionError(409, 'Proposal is no longer pending', {
				id: proposal.id,
				status: proposal.status
			});
		}

		const approvalPayload = proposalApprovalText(proposal);
		if (!approvalHashMatches(approvalPayload, input.base_hash)) {
			return actionError(409, 'Proposal does not match what you reviewed', {
				conflict: CONFLICT_TEXT_CHANGED,
				id: proposal.id,
				current_text: approvalPayload,
				current_hash: hashApprovalText(approvalPayload)
			});
		}

		const chat = getChat(db, proposal.chat_jid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: proposal.chat_jid });
		}

		if (proposal.kind === 'reaction') {
			const targetId = proposal.reaction_target_msg_id;
			if (!targetId || proposal.reaction_emoji === null) {
				return actionError(500, 'Reaction proposal is missing its payload', {
					id: proposal.id
				});
			}
			const target = getMessage(db, targetId);
			if (!target) {
				return actionError(404, 'Reaction target message not found', { id: targetId });
			}
			if (target.chat_jid !== proposal.chat_jid) {
				return actionError(409, 'Reaction target is no longer in this chat', {
					id: proposal.id,
					target_msg_id: targetId
				});
			}

			const now = Date.now();
			const confirm = db.transaction(() => {
				if (!decideProposal(db, { id: proposal.id, status: 'confirmed', now })) return null;
				const outboxId = enqueueReactionOutbox(db, {
					chatJid: proposal.chat_jid,
					targetMsgId: targetId,
					emoji: proposal.reaction_emoji!,
					now
				});
				attachProposalOutbox(db, proposal.id, outboxId);
				return { row: getOutbox(db, outboxId)!, decided: getProposal(db, proposal.id)! };
			});
			const result = confirm();
			if (!result) {
				return actionError(409, 'Proposal is no longer pending', { id: proposal.id });
			}

			ctx.deps.wakeOutbox?.();
			events.emit({ type: 'outbox-updated', outbox: result.row });
			events.emit({ type: 'proposal-updated', proposal: result.decided });
			return actionJson(202, { outbox: result.row, proposal: result.decided });
		}

		const latestInbound = getLastInboundMessage(db, proposal.chat_jid);
		if (
			proposal.basis_msg_id &&
			latestInbound &&
			latestInbound.id !== proposal.basis_msg_id &&
			input.confirmed_latest_inbound_id !== latestInbound.id
		) {
			return actionError(409, 'Proposal is stale; newer inbound arrived', {
				conflict: CONFLICT_STALE_INBOUND,
				id: proposal.id,
				basis_msg_id: proposal.basis_msg_id,
				latest_inbound_id: latestInbound.id
			});
		}

		const now = Date.now();
		// `decideProposal` is conditional on the row still being pending, so a
		// double click (or a click racing a reject) enqueues once or not at all —
		// the outbox insert only happens on the branch that won.
		//
		// MANUAL-PACED BY OWNER DECISION (PL-U5 Decision 4), not an oversight.
		// A confirmed proposal enqueues through `enqueueManualOutbox`, so
		// `send_after` is now and `deferPendingDrafts` only defers source=draft
		// rows — several rapid confirmations are therefore not spaced by the
		// jittered gap. The owner left this as manual-paced on the grounds that
		// a confirmed proposal is equivalent to an owner-typed send and the
		// click is the rate limit. If this is revisited, switch to draft-source
		// enqueue carrying `basis_msg_id`: that brings both the jittered gap and
		// the pacer's send-time staleness re-check. Do not "fix" the manual
		// path without reopening that decision.
		const confirm = db.transaction(() => {
			if (!decideProposal(db, { id: proposal.id, status: 'confirmed', now })) return null;
			const outboxId = enqueueManualOutbox(db, {
				chatJid: proposal.chat_jid,
				text: proposal.text,
				now
			});
			attachProposalOutbox(db, proposal.id, outboxId);
			return { row: getOutbox(db, outboxId)!, decided: getProposal(db, proposal.id)! };
		});
		const result = confirm();
		if (!result) {
			return actionError(409, 'Proposal is no longer pending', { id: proposal.id });
		}

		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: result.row });
		events.emit({ type: 'proposal-updated', proposal: result.decided });
		return actionJson(202, { outbox: result.row, proposal: result.decided });
	}
};
