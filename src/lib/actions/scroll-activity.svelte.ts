/**
 * Contextual-scrollbar state + `use:scrollActivity` action.
 *
 * The `scrollbar-contextual` utility (app.css) hides chrome at rest and reveals
 * on `:hover`, `:focus-within`, and `[data-active-scroll='true']`. Class alone
 * only buys hover/focus reveal — the idle-then-hide half needs this action,
 * which sets `data-active-scroll` while the reader is scrolling and clears it
 * ~900ms after the last scroll event.
 *
 * Known limitation — do not fight it: a styled/`thin` scrollbar in Chromium is
 * a classic non-overlay bar that occupies layout width. CSS cannot restore true
 * macOS overlay scrollbars. The utility reserves the gutter so revealing never
 * reflows. Author `scrollbar-color` does override macOS "Show scroll bars:
 * Always", so this holds regardless of the user's OS preference.
 */

export const SCROLLBAR_IDLE_MS = 900;

export type ScrollActivity = {
	readonly active: boolean;
	/** Report a scroll event; restarts the idle countdown. */
	poke: () => void;
	/** Clear the pending timer — required on unmount or the timer outlives the pane. */
	dispose: () => void;
};

/**
 * Reactive store used by the action (and tests). Prefer `use:scrollActivity` on
 * scrollers — do not wire `data-active-scroll` by hand.
 */
export function createScrollActivity(
	idleMs: number = SCROLLBAR_IDLE_MS,
	onChange?: (active: boolean) => void
): ScrollActivity {
	let active = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function setActive(next: boolean) {
		active = next;
		onChange?.(next);
	}

	return {
		get active() {
			return active;
		},
		poke() {
			setActive(true);
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				setActive(false);
				timer = null;
			}, idleMs);
		},
		dispose() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			setActive(false);
		}
	};
}

/**
 * Svelte action: one implementation for every scroller. Pair with the
 * `scrollbar-contextual` class on the same node.
 */
export function scrollActivity(node: HTMLElement, idleMs: number = SCROLLBAR_IDLE_MS) {
	const activity = createScrollActivity(idleMs, (active) => {
		node.dataset.activeScroll = active ? 'true' : 'false';
	});
	node.dataset.activeScroll = 'false';

	const onScroll = () => activity.poke();
	node.addEventListener('scroll', onScroll, { passive: true });

	return {
		destroy() {
			node.removeEventListener('scroll', onScroll);
			activity.dispose();
			delete node.dataset.activeScroll;
		}
	};
}
