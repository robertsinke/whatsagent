import {
	getSetting,
	OUTBOX_DRY_RUN_SETTING,
	PROVIDER_MODEL_SETTING,
	PROVIDER_SETTING,
	resolveOutboxDryRun,
	setSetting,
	validateSettingValue
} from '../store/settings.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SetSettingInput = { key: string; value: string };

export const setSettingAction: ActionDefinition<SetSettingInput> = {
	name: 'set-setting',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			key: { type: 'string' },
			value: { type: 'string' }
		},
		required: ['key', 'value'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { key?: string; value?: string } | undefined;
		if (!body?.key || typeof body.value !== 'string') {
			return parseError(400, 'Expected { key, value }');
		}
		return { ok: true, input: { key: body.key, value: body.value } };
	},
	run(input, ctx) {
		const { db } = ctx.deps;
		const result = validateSettingValue(input.key, input.value);
		if (!result.ok) {
			return actionError(400, result.message, { allowed: result.allowed });
		}
		setSetting(db, input.key, result.normalized);
		if (input.key === OUTBOX_DRY_RUN_SETTING && ctx.deps.setOutboxDryRun) {
			ctx.deps.setOutboxDryRun(resolveOutboxDryRun(result.normalized));
		}
		if (
			(input.key === PROVIDER_SETTING || input.key === PROVIDER_MODEL_SETTING) &&
			ctx.deps.providerDiscovery
		) {
			ctx.deps.providerDiscovery.invalidate();
		}
		return actionJson(200, { key: input.key, value: getSetting(db, input.key) });
	}
};
