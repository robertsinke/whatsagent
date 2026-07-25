<script lang="ts">
	import { setContext } from 'svelte';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();

	let viewport: HTMLElement | null = null;
	let isAtBottom = $state(true);

	function scrollToBottom() {
		viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
	}

	setContext<ConversationContext>(CONVERSATION_CTX, {
		get isAtBottom() {
			return isAtBottom;
		},
		setIsAtBottom: (value) => {
			isAtBottom = value;
		},
		scrollToBottom,
		setViewport: (el) => {
			viewport = el;
		}
	});
</script>

<div class={cn('relative flex-1 overflow-y-hidden', className)} role="log" {...rest}>
	{@render children?.()}
</div>
