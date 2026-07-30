import {
	dismissCancellationNotice,
	getCancellationNotice
} from '../store/cancellation-notices.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type DismissCancellationNoticeInput = { id: number };

/**
 * FRONTEND ONLY. Acknowledging that the agent cancelled an approved send is
 * the owner's decision; a tool caller that could dismiss its own notices could
 * also clear the evidence before the owner ever saw it.
 */
export const dismissCancellationNoticeAction: ActionDefinition<DismissCancellationNoticeInput> =
	{
		name: 'dismiss-cancellation-notice',
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
			const notice = getCancellationNotice(db, input.id);
			if (!notice) {
				return actionError(404, 'Notice not found', { id: input.id });
			}
			if (!dismissCancellationNotice(db, { id: input.id, now: Date.now() })) {
				return actionError(409, 'Notice is already dismissed', { id: input.id });
			}
			const dismissed = getCancellationNotice(db, input.id)!;
			events.emit({ type: 'cancellation-notice', notice: dismissed });
			return actionJson(200, { notice: dismissed });
		}
	};
