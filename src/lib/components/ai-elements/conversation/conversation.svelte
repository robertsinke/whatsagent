<script lang="ts">
	import { onDestroy, setContext } from 'svelte';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
	import { preservedScrollTop, type ViewportGeometry } from './scroll-anchor.js';
	import { createScrollActivity } from './scroll-activity.svelte.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();

	let viewport: HTMLElement | null = null;
	let isAtBottom = $state(true);
	const activity = createScrollActivity();

	onDestroy(() => activity.dispose());

	function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!viewport) return;
		viewport.scrollTo({ top: viewport.scrollHeight, behavior });
		// Optimistic: the scroll event lands a frame later and the scroll-down
		// affordance should not flash in between.
		isAtBottom = true;
	}

	/**
	 * Prepend anchoring is geometry, not timing: snapshot before the older page
	 * is inserted, compensate by the height delta once the DOM has reconciled.
	 */
	function captureAnchor(): () => void {
		const el = viewport;
		if (!el) return () => {};
		const before: ViewportGeometry = {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight
		};
		return () => {
			if (!viewport) return;
			viewport.scrollTop = preservedScrollTop(before, viewport.scrollHeight);
		};
	}

	setContext<ConversationContext>(CONVERSATION_CTX, {
		get isAtBottom() {
			return isAtBottom;
		},
		get isScrolling() {
			return activity.active;
		},
		setIsAtBottom: (value) => {
			isAtBottom = value;
		},
		scrollToBottom,
		setViewport: (el) => {
			viewport = el;
		},
		noteScroll: () => activity.poke(),
		captureAnchor
	});
</script>

<div class={cn('relative flex-1 overflow-y-hidden', className)} role="log" {...rest}>
	{@render children?.()}
</div>
