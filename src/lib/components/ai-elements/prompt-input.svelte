<script lang="ts">
	import { CornerDownLeft, Square, X } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	export type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'error';

	let {
		value = $bindable(''),
		status = 'ready' as PromptInputStatus,
		placeholder = 'What would you like to know?',
		class: className = '',
		onsubmit,
		onstop
	}: {
		value?: string;
		status?: PromptInputStatus;
		placeholder?: string;
		class?: string;
		onsubmit?: (message: { text: string }) => void | Promise<void>;
		onstop?: () => void;
	} = $props();

	const isGenerating = $derived(status === 'submitted' || status === 'streaming');

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		if (isGenerating) return;
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		await onsubmit?.({ text: value });
	}

	function handleSubmitClick(e: MouseEvent) {
		if (isGenerating && onstop) {
			e.preventDefault();
			onstop();
		}
	}
</script>

<form class={cn('w-full', className)} onsubmit={handleSubmit}>
	<InputGroup.Root class="overflow-hidden has-[>textarea]:h-auto">
		<div class="contents">
			<InputGroup.Textarea
				class="field-sizing-content max-h-48 min-h-16"
				name="message"
				{placeholder}
				bind:value
				onkeydown={handleKeydown}
			/>
		</div>
		<InputGroup.Addon align="block-end" class="justify-between gap-1">
			<div class="flex min-w-0 items-center gap-1"></div>
			<InputGroup.Button
				aria-label={isGenerating ? 'Stop' : 'Submit'}
				size="icon-sm"
				type={isGenerating && onstop ? 'button' : 'submit'}
				variant="default"
				onclick={handleSubmitClick}
			>
				{#if status === 'submitted'}
					<Spinner />
				{:else if status === 'streaming'}
					<Square class="size-4" />
				{:else if status === 'error'}
					<X class="size-4" />
				{:else}
					<CornerDownLeft class="size-4" />
				{/if}
			</InputGroup.Button>
		</InputGroup.Addon>
	</InputGroup.Root>
</form>
