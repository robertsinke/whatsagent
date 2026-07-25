<script lang="ts">
	import { getContext } from 'svelte';
	import { ArrowDown } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils';
	import { CONVERSATION_CTX, type ConversationContext } from './context.js';
	import type { ComponentProps } from 'svelte';

	type ButtonProps = ComponentProps<typeof Button>;

	let {
		class: className = '',
		...rest
	}: ButtonProps = $props();

	const ctx = getContext<ConversationContext>(CONVERSATION_CTX);
</script>

{#if !ctx.isAtBottom}
	<Button
		class={cn(
			'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted',
			className
		)}
		onclick={() => ctx.scrollToBottom()}
		size="icon"
		type="button"
		variant="outline"
		{...rest}
	>
		<ArrowDown class="size-4" />
	</Button>
{/if}
