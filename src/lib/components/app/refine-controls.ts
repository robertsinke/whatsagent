import type { Draft, RefinementIntent } from '$lib/client/types.js';
import { canRefine } from '$lib/client/view.js';

/**
 * The closed set of refinement intents the UI exposes, in display order.
 * These mirror the server's canonical wire values exactly — the client never
 * invents additional intents. Regenerate is listed first because it is the
 * primary secondary action; the rest are compact transforms.
 */
export const REFINE_INTENTS: readonly RefinementIntent[] = [
	'regenerate',
	'shorter',
	'longer',
	'more_formal',
	'less_formal'
];

export type RefineControlsState = {
	/** Whether the controls should render at all. */
	visible: boolean;
	/** Whether every control is disabled (a request is in flight or approving). */
	disabled: boolean;
	/** The text that would be sent to the provider if a control were clicked. */
	previewText: string | null;
};

/**
 * Pure derivation of the refinement control state from the active draft and
 * editor state. Kept here (not inside the component) so the rules are testable
 * without mounting:
 *
 * - Controls render only when the draft is in a refinable state (`ready` or
 *   `stale`) and the editor is not closed for an unrelated reason.
 * - The transformed input is the unsaved editor text when edit mode is open,
 *   otherwise the saved draft preview — matching the plan's "apply transforms
 *   to unsaved editor text when open" requirement.
 * - Controls disable while a refinement request is in flight or an approval is
 *   pending, so conflicting actions cannot race.
 */
export function refineControlsState(options: {
	draft: Draft | null;
	editing: boolean;
	editedText: string;
	refining: boolean;
	approving: boolean;
}): RefineControlsState {
	const { draft, editing, editedText, refining, approving } = options;
	const visible = Boolean(draft && canRefine(draft.status));
	const candidate = editing ? editedText : draft?.text ?? '';
	const previewText = candidate.trim() ? candidate.trim() : null;
	return {
		visible,
		disabled: refining || approving,
		previewText
	};
}

/**
 * Maps a UI control click to the intent the server expects. Today this is a
 * 1:1 passthrough, but centralizing it keeps the component free of wire-shape
 * knowledge and lets us rename a display label without touching the contract.
 */
export function intentForClick(intent: RefinementIntent): RefinementIntent {
	return intent;
}