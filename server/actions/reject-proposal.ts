import { decideProposal, getProposal } from '../store/proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RejectProposalInput = { id: number };

/**
 * FRONTEND ONLY. Declining is the owner's decision in the same way confirming
 * is; a tool caller that could reject its own proposals could also clear the
 * evidence of what it asked for before the owner ever saw it.
 *
 * No text hash: refusing to send is safe whatever the payload turns out to be.
 */
export const rejectProposalAction: ActionDefinition<RejectProposalInput> = {
	name: 'reject-proposal',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: { id: { type: 'number' } },
		required: ['id'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { id?: unknown } | undefined;
		const id = typeof body?.id === 'number' ? body.id : Number.NaN;
		if (!Number.isInteger(id) || id <= 0) {
			return parseError(400, 'Expected { id }');
		}
		return { ok: true, input: { id } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const proposal = getProposal(db, input.id);
		if (!proposal) {
			return actionError(404, 'Proposal not found', { id: input.id });
		}
		if (!decideProposal(db, { id: proposal.id, status: 'rejected', now: Date.now() })) {
			return actionError(409, 'Proposal is no longer pending', {
				id: proposal.id,
				status: getProposal(db, proposal.id)?.status ?? proposal.status
			});
		}
		const rejected = getProposal(db, proposal.id)!;
		events.emit({ type: 'proposal-updated', proposal: rejected });
		return actionJson(200, { proposal: rejected });
	}
};
