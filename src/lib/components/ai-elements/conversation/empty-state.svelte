<script lang="ts">
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		title = 'No messages yet',
		description = 'Start a conversation to see messages here',
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		title?: string;
		description?: string;
		icon?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
		className
	)}
	{...rest}
>
	{#if children}
		{@render children()}
	{:else}
		<div class="space-y-1">
			<h3 class="font-medium text-sm">{title}</h3>
			{#if description}
				<p class="text-muted-foreground text-sm">{description}</p>
			{/if}
		</div>
	{/if}
</div>
