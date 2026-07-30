import { decideProposal, getProposal } from '../store/proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RejectProposalInput = { id: number };

/**
 * PANEL-S5 — both callers. The agent withdrawing its own proposal removes
 * noise from the owner's queue and cannot cause a send: `run` only flips the
 * proposal row to `rejected` and emits `proposal-updated`. It does not enqueue
 * an outbox row, wake the pacer, or write `text_source: 'owner'`.
 *
 * Confirming remains frontend-only (`confirm-proposal`); rejecting is the
 * opposite of arming a send.
 *
 * No text hash: refusing to send is safe whatever the payload turns out to be.
 */
export const rejectProposalAction: ActionDefinition<RejectProposalInput> = {
	name: 'reject-proposal',
	callers: ['frontend', 'tool'],
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
