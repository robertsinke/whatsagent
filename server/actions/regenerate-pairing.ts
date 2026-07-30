import type { ActionDefinition } from './types.js';
import { actionError, actionJson } from './types.js';

export type RegeneratePairingInput = Record<string, never>;

/**
 * FRONTEND ONLY. Restarting the WhatsApp socket (and resetting auth when
 * already logged out) has no drafting reason for an agent, and the failure
 * mode is the app going offline until the owner scans a QR. The stated R9
 * rule does not reach this action — it removes an outbound path rather than
 * arming one — but the owner closed it anyway (PL-U5 Decision 2).
 */
export const regeneratePairingAction: ActionDefinition<RegeneratePairingInput> = {
	name: 'regenerate-pairing',
	callers: ['frontend'],
	jsonSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false
	},
	parse(_raw: unknown) {
		return { ok: true, input: {} };
	},
	async run(_input, ctx) {
		if (!ctx.deps.regeneratePairing) {
			return actionError(503, 'No channel attached');
		}
		await ctx.deps.regeneratePairing();
		return actionJson(202, { ok: true });
	}
};
