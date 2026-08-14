import {
	decideCalendarProposal,
	getCalendarProposal
} from '../store/calendar-proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RejectCalendarEventInput = { id: number };

/**
 * Both callers. The agent withdrawing its own calendar proposal removes noise
 * from the owner's queue and cannot cause a Google write: `run` only flips the
 * row to `rejected`. Confirming remains frontend-only (`confirm-calendar-event`).
 *
 * No approval hash: refusing to create is safe whatever the payload turns out
 * to be.
 */
export const rejectCalendarEventAction: ActionDefinition<RejectCalendarEventInput> = {
	name: 'reject-calendar-event',
	description: 'Reject pending calendar proposal id. Does not write to Google Calendar.',
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
		const proposal = getCalendarProposal(db, input.id);
		if (!proposal) {
			return actionError(404, 'Calendar proposal not found', { id: input.id });
		}
		if (
			!decideCalendarProposal(db, {
				id: proposal.id,
				status: 'rejected',
				now: Date.now()
			})
		) {
			return actionError(409, 'Calendar proposal is no longer pending', {
				id: proposal.id,
				status: getCalendarProposal(db, proposal.id)?.status ?? proposal.status
			});
		}
		const rejected = getCalendarProposal(db, proposal.id)!;
		events.emit({ type: 'calendar-proposal-updated', proposal: rejected });
		// CAL-5 — so the panel agent's next turn does not still say "pending".
		ctx.deps.panelSession?.recordCalendarOutcome?.({
			status: 'rejected',
			summary: rejected.summary,
			start: rejected.start
		});
		return actionJson(200, { proposal: rejected });
	}
};
