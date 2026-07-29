<script lang="ts">
	import { setContext } from 'svelte';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
	import { preservedScrollTop, type ViewportGeometry } from './scroll-anchor.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();

	let viewport: HTMLElement | null = null;
	let isAtBottom = $state(true);

	function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
		if (!viewport) return;
		viewport.scrollTo({ top: viewport.scrollHeight, behavior });
		// Optimistic: the scroll event lands a frame later and the scroll-down
		// affordance should not flash in between.
		isAtBottom = true;
	}

	/**
	 * U5 — scroll a specific element into view. The viewport is the single
	 * scroll owner, so this routes through it rather than calling
	 * `element.scrollIntoView()` (which would scroll the nearest scrollable
	 * ancestor — usually the same viewport, but routing it explicitly keeps
	 * the contract honest and `isAtBottom` in sync).
	 */
	function scrollToElement(el: HTMLElement, behavior: ScrollBehavior = 'smooth') {
		if (!viewport) return;
		const viewportRect = viewport.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		// Center the target in the viewport when there is room; otherwise land it
		// at the top so it is at least visible. Centering makes the jump legible
		// and leaves room for the brief highlight to read as context, not error.
		const targetTop = elRect.top - viewportRect.top + viewport.scrollTop;
		const offset = Math.max(
			0,
			targetTop - (viewport.clientHeight - elRect.height) / 2
		);
		viewport.scrollTo({ top: offset, behavior });
		// The target is almost never at the very bottom after a jump; flagging
		// `isAtBottom` true would suppress the scroll-down affordance dishonestly.
		isAtBottom = false;
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
		setIsAtBottom: (value) => {
			isAtBottom = value;
		},
		scrollToBottom,
		scrollToElement,
		setViewport: (el) => {
			viewport = el;
		},
		captureAnchor
	});
</script>

<div class={cn('relative flex-1 overflow-y-hidden', className)} role="log" {...rest}>
	{@render children?.()}
</div>
