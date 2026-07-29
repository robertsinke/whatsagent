import { OUTBOX_DRY_RUN_SETTING, setSetting } from '../store/settings.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SetSendModeInput = {
	live: boolean;
};

/**
 * Flip dry-run ↔ live. Does not send, but arms every outbound path —
 * callers: frontend only.
 */
export const setSendModeAction: ActionDefinition<SetSendModeInput> = {
	name: 'set-send-mode',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {
			live: { type: 'boolean' }
		},
		required: ['live'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { live?: unknown } | undefined;
		if (typeof body?.live !== 'boolean') {
			return parseError(400, 'Expected { live: boolean }');
		}
		return { ok: true, input: { live: body.live } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const value = input.live ? 'false' : 'true';
		setSetting(db, OUTBOX_DRY_RUN_SETTING, value);
		if (ctx.deps.setOutboxDryRun) ctx.deps.setOutboxDryRun(!input.live);
		const resolved = { live: input.live, dry_run: !input.live };
		events.emit({ type: 'send-mode', ...resolved });
		return actionJson(200, resolved);
	}
};
