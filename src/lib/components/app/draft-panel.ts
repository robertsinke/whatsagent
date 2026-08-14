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
export type DraftPanelBranch = 'text-changed' | 'stale' | 'visible' | 'generate' | 'hidden';

export function draftPanelBranch(options: {
	draft: Pick<Draft, 'status'> | null;
	stalePrompt: unknown;
	/** PL-U3 Half B — the draft is not the text the owner read. */
	textConflict?: unknown;
	agentEligible: boolean;
	/**
	 * NEWCHAT-2 — a 1:1 with no messages has nothing to draft from. Generate
	 * would 409; do not offer the button. Defaults to true so existing callers
	 * that already know there is history stay on the generate path.
	 */
	hasMessages?: boolean;
}): DraftPanelBranch {
	// Ranked above `stale` deliberately: both prompts can be live at once, and
	// the stale prompt's own button queues the current draft. If that branch
	// rendered first, re-confirming staleness would send text the owner never
	// reviewed — the precise bug PL-U3 exists to close.
	if (options.textConflict) return 'text-changed';
	if (options.stalePrompt) return 'stale';
	if (options.draft && isVisibleDraftStatus(options.draft.status as DraftStatus)) {
		return 'visible';
	}
	if (options.agentEligible && options.hasMessages !== false) return 'generate';
	return 'hidden';
}
