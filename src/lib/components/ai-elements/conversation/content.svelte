<script lang="ts">
	import { getContext } from 'svelte';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
	import { isAtBottom } from './scroll-anchor.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();

	const ctx = getContext<ConversationContext>(CONVERSATION_CTX);

	function bindViewport(el: HTMLDivElement) {
		ctx.setViewport(el);
		el.scrollTop = el.scrollHeight;
		ctx.setIsAtBottom(true);
		return {
			destroy() {
				ctx.setViewport(null);
			}
		};
	}

	function onScroll(e: Event) {
		const el = e.currentTarget as HTMLDivElement;
		ctx.setIsAtBottom(
			isAtBottom({
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight
			})
		);
		ctx.noteScroll();
	}
</script>

<div
	use:bindViewport
	class={cn('scrollbar-contextual flex h-full flex-col gap-8 overflow-y-auto p-4', className)}
	data-active-scroll={ctx.isScrolling ? 'true' : 'false'}
	onscroll={onScroll}
	{...rest}
>
	{@render children?.()}
</div>
