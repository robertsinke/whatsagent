import { getChat } from '../store/chats.js';
import { getLastInboundMessage } from '../store/messages.js';
import { getProposal, insertProposal, listPendingProposals } from '../store/proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ProposeSendInput = { chatJid: string; text: string };

/**
 * How many un-acted-on proposals one chat may hold. A proposal is a claim on
 * the owner's attention, and an agent steered by attacker-controlled message
 * text would otherwise be free to manufacture an unbounded queue of them.
 */
const MAX_PENDING_PROPOSALS_PER_CHAT = 3;

/**
 * TOOL ONLY, and it is the agent's *only* route toward a send.
 *
 * `run` below inserts an inert row and returns. It does not call
 * `enqueueOutbox`, it does not call `wakeOutbox`, and there is deliberately no
 * branch in it that could: the outbox row is created by `confirm-proposal`,
 * which is frontend-only, so the owner's click is the sole thing that turns a
 * proposal into a queued send. R9 is therefore unchanged by this action — the
 * set of code paths that reach the outbox is still exactly {owner-composed,
 * owner-approved}, and a proposal is neither until the owner makes it one.
 *
 * The response says `pending_confirmation` rather than anything resembling
 * success on purpose. An agent that believes it has sent will not wait, and
 * will say so to the person it is talking to; the status name is what teaches
 * it that the send has not happened yet and may never happen.
 *
 * If a future task wants the agent to send without a click, that is not a
 * change to this file. It is a change to R9, and R9 is structural.
 */
export const proposeSendAction: ActionDefinition<ProposeSendInput> = {
	name: 'propose-send',
	description:
		'Propose sending text to chatJid (WhatsApp JID, e.g. alice@s.whatsapp.net). Writes an inert proposal the owner must confirm in the app; this tool never puts anything on the wire.',
	callers: ['tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			text: { type: 'string' }
		},
		required: ['chatJid', 'text'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown; text?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid, text }');
		}
		const text = typeof body.text === 'string' ? body.text.trim() : '';
		if (!text) {
			return parseError(400, 'Expected { text }');
		}
		return { ok: true, input: { chatJid: body.chatJid, text } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		// R8: the agent is structurally excluded from groups. The composer may
		// send into one; an agent proposal may not exist for one.
		if (chat.kind !== '1:1') {
			return actionError(400, 'Proposals are available for 1:1 chats only', {
				kind: chat.kind
			});
		}
		const pending = listPendingProposals(db, input.chatJid);
		if (pending.length >= MAX_PENDING_PROPOSALS_PER_CHAT) {
			return actionError(409, 'Too many proposals are already awaiting the owner', {
				pending: pending.length,
				max: MAX_PENDING_PROPOSALS_PER_CHAT
			});
		}
		const now = Date.now();
		const id = insertProposal(db, {
			chatJid: input.chatJid,
			text: input.text,
			basisMsgId: getLastInboundMessage(db, input.chatJid)?.id ?? null,
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
