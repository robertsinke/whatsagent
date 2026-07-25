<script lang="ts">
	import { cn } from '$lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		from = 'assistant' as 'user' | 'assistant' | 'system',
		class: className = '',
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		from?: 'user' | 'assistant' | 'system';
		children?: Snippet;
	} = $props();
</script>

<div
	class={cn(
		'group flex w-full max-w-[95%] flex-col gap-2',
		from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
		className
	)}
	{...rest}
>
	{@render children?.()}
</div>
