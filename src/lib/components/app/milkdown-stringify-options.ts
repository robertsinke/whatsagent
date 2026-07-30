/**
 * remark-stringify / GFM options applied to the Voice Milkdown editor.
 *
 * These do not make ProseMirror round-trips byte-identical — blank lines after
 * headings and between loose list items still reflow — but they stop the worst
 * cosmetic rewrites on a *real* owner edit: `*` bullets and padded table cells.
 * Zero-edit Saves must still short-circuit via {@link resolveVoiceSaveTarget};
 * options alone are not a substitute for that guard.
 */
export const VOICE_MILKDOWN_STRINGIFY_OPTIONS = {
	bullet: '-' as const,
	/** Prefer compact `|a|b|` over padded `| a | b |` when the source was compact. */
	tableCellPadding: false,
	/** Do not widen separator rows to align pipes with padded cells. */
	tablePipeAlign: false
};
