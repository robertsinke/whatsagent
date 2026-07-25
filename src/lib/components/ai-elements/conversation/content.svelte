<script lang="ts">
	import { getContext } from 'svelte';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
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
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		ctx.setIsAtBottom(atBottom);
	}
</script>

<div
	use:bindViewport
	class={cn('flex h-full flex-col gap-8 overflow-y-auto p-4', className)}
	onscroll={onScroll}
	{...rest}
>
	{@render children?.()}
</div>
