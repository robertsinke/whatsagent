/**
 * Viewport geometry helpers for the conversation scroller.
 *
 * Kept pure and DOM-free so the scroll rules are unit-testable: every decision
 * about "are we at the bottom" and "where must the scroller land after older
 * messages were prepended" is arithmetic on a geometry snapshot, never a timing
 * guess.
 */

export type ViewportGeometry = {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
};

/** Slack for sub-pixel scroll positions and the last bubble's bottom margin. */
export const AT_BOTTOM_EPSILON = 40;

export function isAtBottom(geometry: ViewportGeometry, epsilon = AT_BOTTOM_EPSILON): boolean {
	return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight < epsilon;
}

/**
 * Scroll offset that keeps the visible anchor still after a prepend.
 *
 * A prepend only grows the content *above* the viewport, so preserving the
 * distance from the bottom preserves every visible bubble's position exactly.
 * The short-thread case falls out of the same formula: an unscrollable thread
 * has `scrollTop === 0` and `scrollHeight === clientHeight`, so the distance
 * from the bottom is one viewport and the scroller stays pinned to the bottom
 * instead of landing mid-thread.
 */
export function preservedScrollTop(
	before: ViewportGeometry,
	afterScrollHeight: number
): number {
	const distanceFromBottom = before.scrollHeight - before.scrollTop;
	return Math.max(0, afterScrollHeight - distanceFromBottom);
}
