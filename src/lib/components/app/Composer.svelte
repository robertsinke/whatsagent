<script lang="ts">
	import PromptInput from '$lib/components/ai-elements/prompt-input.svelte';

	let {
		value = $bindable(''),
		disabled = false,
		placeholder = 'Write a reply…',
		onsend
	}: {
		value?: string;
		disabled?: boolean;
		placeholder?: string;
		onsend?: (text: string) => void | Promise<void>;
	} = $props();

	let busy = $state(false);

	/**
	 * R9: this hands text to the API, which enqueues an outbox row. There is no
	 * path from the UI to WhatsApp's send function — the pacer is the only sender.
	 */
	async function submit({ text }: { text: string }) {
		const trimmed = text.trim();
		if (!trimmed || disabled || busy) return;
		busy = true;
		try {
			await onsend?.(trimmed);
			value = '';
		} finally {
			busy = false;
		}
	}
</script>

<div class="composer neumorphic-raised">
	<PromptInput
		bind:value
		{placeholder}
		status={busy ? 'submitted' : 'ready'}
		onsubmit={submit}
		class="composer-input"
	/>
	<p class="hint">Sends queue through the outbox — nothing leaves without you.</p>
</div>

<style>
	.composer {
		border-radius: var(--radius-md);
		padding: 0.5rem 0.5rem 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	:global(.composer-input textarea) {
		font-size: 0.88rem;
	}
	.hint {
		margin: 0;
		font-size: 0.66rem;
		color: var(--ink-50);
		padding-left: 0.2rem;
	}
</style>
