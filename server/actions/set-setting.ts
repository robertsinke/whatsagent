import {
	getSetting,
	OUTBOX_DRY_RUN_SETTING,
	PANEL_ENABLED_SETTING,
	PANEL_HARNESS_SETTING,
	PANEL_MODEL_SETTING,
	PROVIDER_MODEL_SETTING,
	PROVIDER_SETTING,
	resolveOutboxDryRun,
	setSetting,
	validateSettingValue
} from '../store/settings.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type SetSettingInput = { key: string; value: string };

/** PANEL-S2 — the rows whose write reconfigures the panel runtime in place. */
const PANEL_SETTINGS: ReadonlySet<string> = new Set([
	PANEL_ENABLED_SETTING,
	PANEL_HARNESS_SETTING,
	PANEL_MODEL_SETTING
]);

/**
 * FRONTEND ONLY, and the reason is R9 rather than caution about settings.
 *
 * `run` below deliberately reacts to `OUTBOX_DRY_RUN_SETTING` by calling
 * `setOutboxDryRun` — the same live/dry-run flip that `set-send-mode` performs.
 * So permitting `tool` here would be a second door onto the send mode and would
 * entirely defeat `set-send-mode` refusing tool callers: an agent blocked from
 * the front door could simply write the setting instead. (Found and flagged by
 * the PL-U1 worker, which correctly declined to close it unilaterally.)
 *
 * PANEL-S2 ADDED A SECOND RUNTIME EFFECT of the same kind: a `panel_*` write
 * calls `applyPanelSettings`, which arms or disarms the `/mcp` surface and the
 * panel runtime immediately. A `tool` caller here would therefore be an agent
 * able to arm its own tool surface — or to re-arm one the owner just switched
 * off. Same conclusion, one more reason.
 *
 * The fix is a caller-policy change rather than a key check inside `run`,
 * because this registry's contract is that `callers` is enforced by the
 * dispatcher and never re-litigated in a run function — a guard inside `run` is
 * one refactor away from being dropped.
 *
 * If an agent ever legitimately needs to change settings, do NOT re-add `tool`
 * here. Split off a separate action whose parse accepts only an allowlist of
 * keys that cannot arm an outbound path, and leave this one frontend-only.
 */
export const setSettingAction: ActionDefinition<SetSettingInput> = {
	name: 'set-setting',
	callers: ['frontend'],
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
		// PANEL-S2: the row IS the runtime. Reconciled after the write, so the
		// reconcile reads the value that is now on disk and a crash in between
		// lands on the persisted state rather than on a panel nothing saved.
		if (PANEL_SETTINGS.has(input.key)) ctx.deps.applyPanelSettings?.();
		return actionJson(200, { key: input.key, value: getSetting(db, input.key) });
	}
};
