import type { ActionDefinition } from './types.js';
import { actionError, actionJson } from './types.js';

export type RegeneratePairingInput = Record<string, never>;

/**
 * FRONTEND ONLY — owner decision, 2026-07-30 (also PL-U5 Decision 2).
 * Restarting the WhatsApp socket (and resetting auth when already logged out)
 * has no drafting reason for an agent; the failure mode is the app going
 * offline until the owner scans a QR.
 */
export const regeneratePairingAction: ActionDefinition<RegeneratePairingInput> = {
	name: 'regenerate-pairing',
	description: 'Restart WhatsApp pairing / auth. Frontend only; does not send messages.',
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
