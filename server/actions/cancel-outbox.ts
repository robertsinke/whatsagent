import { cancelOutbox, getOutbox } from '../store/outbox.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type CancelOutboxInput = { id: number };

/** Cancel a pending outbox row — only ever reduces sending. */
export const cancelOutboxAction: ActionDefinition<CancelOutboxInput> = {
	name: 'cancel-outbox',
	description: 'Cancel pending outbox row id. Only reduces sending; never enqueues.',
	callers: ['frontend', 'tool'],
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
		if (!cancelOutbox(db, input.id)) {
			return actionError(409, 'Outbox item is not cancellable');
		}
		const updated = getOutbox(db, input.id)!;
		ctx.deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: updated });
		return actionJson(200, updated);
	}
};
