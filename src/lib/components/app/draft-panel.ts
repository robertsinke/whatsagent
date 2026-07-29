import type { Draft, DraftStatus } from '$lib/client/types.js';
import { isVisibleDraftStatus } from '$lib/client/view.js';

/**
 * Which branch of the draft/composer extension to render.
 *
 * Terminal draft statuses (`sent`, `skipped`, `approved`) are intentionally
 * invisible via `isVisibleDraftStatus` — the card has finished its job. The
 * generate affordance must still appear for those chats: a draft row whose
 * status is terminal is not "something to show", so eligibility alone decides.
 * Requiring `!draft` here is the dead-state bug: once the owner has replied,
 * the Generate draft button vanishes permanently.
 */
export type DraftPanelBranch = 'stale' | 'visible' | 'generate' | 'hidden';

export function draftPanelBranch(options: {
	draft: Pick<Draft, 'status'> | null;
	stalePrompt: unknown;
	agentEligible: boolean;
}): DraftPanelBranch {
	if (options.stalePrompt) return 'stale';
	if (options.draft && isVisibleDraftStatus(options.draft.status as DraftStatus)) {
		return 'visible';
	}
	if (options.agentEligible) return 'generate';
	return 'hidden';
}
