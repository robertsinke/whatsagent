/**
 * Contextual-scrollbar state: the scroller reports activity, and the chrome
 * stays visible until the reader has been idle for `idleMs`. Hover and focus
 * reveal it too, but those are pure CSS — only the transient "is scrolling
 * right now" bit needs a timer.
 */

export const SCROLLBAR_IDLE_MS = 900;

export type ScrollActivity = {
	readonly active: boolean;
	/** Report a scroll event; restarts the idle countdown. */
	poke: () => void;
	/** Clear the pending timer — required on unmount or the timer outlives the pane. */
	dispose: () => void;
};

export function createScrollActivity(idleMs: number = SCROLLBAR_IDLE_MS): ScrollActivity {
	let active = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	return {
		get active() {
			return active;
		},
		poke() {
			active = true;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				active = false;
				timer = null;
			}, idleMs);
		},
		dispose() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			active = false;
		}
	};
}
