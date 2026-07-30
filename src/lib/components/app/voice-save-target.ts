/**
 * Decide what a Voice-tab Save should write.
 *
 * Milkdown's `getMarkdown()` is lossy on the ProseMirror ↔ GFM path (list
 * markers, table padding, blank lines, trailing newline). Emitting that
 * serialization on mount — or reading it on every Save — rewrote `voice/global.md`
 * with no owner keystrokes and armed the mirror guard (PANEL-S13).
 *
 * Rule: only the draft that already diverged from the loaded baseline is an
 * owner edit. Live editor serialization is consulted only then, so a zero-edit
 * Save leaves the on-disk bytes alone.
 */
export type VoiceSaveTargetInput = {
	/** Content as last loaded or successfully saved. */
	baseline: string;
	/** Draft bound to the editor / view — equals baseline until an owner edit. */
	draft: string;
	/**
	 * Live `getMarkdown()` when the WYSIWYG editor is mounted. Ignored unless
	 * `draft !== baseline` (an owner edit already marked the draft dirty).
	 */
	liveMarkdown?: string | null;
};

export type VoiceSaveTarget = {
	/** Bytes to persist if `write` is true; always the safe content for UI. */
	content: string;
	/** False → skip `writeOwnerEdit` / API entirely. */
	write: boolean;
};

export function resolveVoiceSaveTarget(input: VoiceSaveTargetInput): VoiceSaveTarget {
	// No owner edit: never promote lossy mount-time / live serialization into a write.
	if (input.draft === input.baseline) {
		return { content: input.baseline, write: false };
	}
	const content =
		typeof input.liveMarkdown === 'string' ? input.liveMarkdown : input.draft;
	return {
		content,
		write: content !== input.baseline
	};
}
