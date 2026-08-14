import { getOutbox, retryFailedOutbox } from '../store/outbox.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RetryOutboxInput = { id: number };

/**
 * OUTBOX-1 — the owner re-arms a row the outbox gave up on.
 *
 * FRONTEND-ONLY, deliberately, and this is the recorded reason: retrying is an
 * outbound effect. It puts an already-composed message back on the path to the
 * wire, so under the propose-and-confirm rule it belongs with
 * `confirm-proposal` — an owner click, never a tool call. There is no
 * `propose-retry` counterpart either: the agent already has `propose-send` for
 * "this text should go out", and a second tool that can re-arm a row the owner
 * has watched fail would be a new agent path to the wire, which is exactly what
 * the split exists to prevent.
 *
 * R9 is untouched: this enqueues nothing new and sends nothing. It flips one
 * existing owner-authored row from `failed` back to `pending` and wakes the
 * pacer, which remains the only sender.
 */
export const retryOutboxAction: ActionDefinition<RetryOutboxInput> = {
	name: 'retry-outbox',
	description:
		'Re-queue failed outbox row id after the owner has seen why it failed. Owner-only; resets the attempt budget and hands the row back to the pacer.',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: { id: { type: 'integer' } },
		required: ['id'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { id?: unknown } | undefined;
		if (typeof body?.id !== 'number' || !Number.isFinite(body.id)) {
			return parseError(400, 'Expected { id }');
		}
		return { ok: true, input: { id: body.id } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const existing = getOutbox(db, input.id);
		if (!existing) {
			return actionError(404, 'Outbox item not found');
		}
		if (!retryFailedOutbox(db, input.id, Date.now())) {
			return actionError(409, 'Outbox item is not retryable');
		}
		const updated = getOutbox(db, input.id)!;
		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: updated });
		return actionJson(200, updated);
	}
};
