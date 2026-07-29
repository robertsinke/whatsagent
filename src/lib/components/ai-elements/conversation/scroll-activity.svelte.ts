/**
 * Re-export — canonical home is `$lib/actions/scroll-activity.svelte.ts` so
 * app scrollers and the conversation pane share one implementation.
 */
export {
	SCROLLBAR_IDLE_MS,
	createScrollActivity,
	scrollActivity,
	type ScrollActivity
} from '$lib/actions/scroll-activity.svelte.js';
